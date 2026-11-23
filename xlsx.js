// Reading and writing .xlsx files in the browser without a library: an .xlsx is a zip of XML parts,
// and the browser inflates and deflates zip entries itself (DecompressionStream). Only what the
// routes file needs: a sheet's cells, values and styles, and a sheet's cells written again, the rest
// of the file (column widths, frozen rows, styles, other sheets) left as it was.

const XLSX_RELATIONS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
// Excel counts days from 1899-12-30.
const XLSX_EPOCH = Date.UTC(1899, 11, 30);

const XLSX_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = XLSX_CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function throughStream(bytes, stream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}

async function unzip(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0) throw new Error("ce n'est pas un fichier .xlsx");
  const count = view.getUint16(end + 10, true);
  const decoder = new TextDecoder();
  const files = new Map();
  for (let i = 0, at = view.getUint32(end + 16, true); i < count; i++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error('fichier .xlsx abîmé');
    const method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const local = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + size);
    files.set(name, method === 8 ? await throughStream(data, new DecompressionStream('deflate-raw')) : data.slice());
    at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  return files;
}

function zipHeader(size, fields) {
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  for (const [at, value, width] of fields) {
    if (width === 4) view.setUint32(at, value, true);
    else view.setUint16(at, value, true);
  }
  return bytes;
}

async function zip(files) {
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data] of files) {
    const nameBytes = new TextEncoder().encode(name);
    const packed = await throughStream(data, new CompressionStream('deflate-raw'));
    // Version 2.0, UTF-8 names, deflated.
    const common = [[4, 20], [6, 0x0800], [8, 8], [10, time], [12, date], [14, crc32(data), 4],
      [18, packed.length, 4], [22, data.length, 4], [26, nameBytes.length]];
    const local = zipHeader(30, [[0, 0x04034b50, 4], ...common]);
    const central = zipHeader(46, [[0, 0x02014b50, 4], [4, 20],
      ...common.map(([at, value, width]) => [at + 2, value, width]), [42, offset, 4]]);
    locals.push(local, nameBytes, packed);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + packed.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = zipHeader(22, [[0, 0x06054b50, 4], [8, files.size], [10, files.size], [12, centralSize, 4], [16, offset, 4]]);
  return new Uint8Array(await new Blob([...locals, ...centrals, end]).arrayBuffer());
}

const xmlDocument = bytes => new DOMParser().parseFromString(new TextDecoder().decode(bytes), 'application/xml');

function columnIndex(reference) {
  return [...reference.match(/^[A-Z]+/)[0]].reduce((index, letter) => index * 26 + letter.charCodeAt(0) - 64, 0) - 1;
}

function columnName(index) {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

async function openXlsx(buffer) {
  const files = await unzip(buffer);
  if (!files.has('xl/workbook.xml')) throw new Error("ce n'est pas un classeur Excel");
  const targets = Object.fromEntries([...xmlDocument(files.get('xl/_rels/workbook.xml.rels')).getElementsByTagName('Relationship')]
    .map(relation => [relation.getAttribute('Id'), relation.getAttribute('Target')]));
  const sheets = new Map([...xmlDocument(files.get('xl/workbook.xml')).getElementsByTagName('sheet')].map(sheet => {
    const target = targets[sheet.getAttributeNS(XLSX_RELATIONS, 'id')];
    return [sheet.getAttribute('name'), target.startsWith('/') ? target.slice(1) : `xl/${target}`];
  }));
  const shared = files.has('xl/sharedStrings.xml')
    ? [...xmlDocument(files.get('xl/sharedStrings.xml')).getElementsByTagName('si')]
      .map(item => [...item.getElementsByTagName('t')].map(text => text.textContent).join(''))
    : [];
  return { files, sheets, shared };
}

function cellValue(cell, shared) {
  const type = cell.getAttribute('t');
  if (type === 'inlineStr') return [...cell.getElementsByTagName('t')].map(text => text.textContent).join('');
  const raw = cell.getElementsByTagName('v')[0]?.textContent;
  if (raw == null) return null;
  if (type === 's') return shared[Number(raw)];
  if (type === 'str' || type === 'e') return raw;
  if (type === 'b') return raw === '1';
  return Number(raw);
}

// Every row of a sheet, each a list of cells { value, style } by column, or null when it is absent.
function readSheet(book, name) {
  const path = book.sheets.get(name);
  if (!path) return null;
  const rows = [];
  for (const row of xmlDocument(book.files.get(path)).getElementsByTagName('row')) {
    const cells = [];
    for (const cell of row.getElementsByTagName('c')) {
      cells[columnIndex(cell.getAttribute('r'))] = { value: cellValue(cell, book.shared), style: cell.getAttribute('s') };
    }
    rows[Number(row.getAttribute('r')) - 1] = Array.from(cells, cell => cell ?? { value: null, style: null });
  }
  return Array.from(rows, row => row ?? []);
}

// The rows under the header as objects keyed by the header's names; empty rows left out.
function sheetRecords(rows) {
  const [header = [], ...body] = rows ?? [];
  return body
    .filter(row => row.some(cell => cell.value != null && cell.value !== ''))
    .map(row => ({
      values: Object.fromEntries(header.map((cell, i) => [cell.value, row[i]?.value ?? null])),
      cells: row,
    }));
}

function escapeXml(text) {
  return String(text).replace(/[&<>"]/g, char => `&#${char.charCodeAt(0)};`)
    // XML 1.0 has no place for most control characters.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

function cellXml(reference, { value, style }) {
  const styled = style != null ? ` s="${style}"` : '';
  if (value == null || value === '') return style != null ? `<c r="${reference}"${styled}/>` : '';
  if (typeof value === 'number') return `<c r="${reference}"${styled}><v>${value}</v></c>`;
  if (typeof value === 'boolean') return `<c r="${reference}"${styled} t="b"><v>${value ? 1 : 0}</v></c>`;
  return `<c r="${reference}"${styled} t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
}

// The sheet's cells replaced by these rows, header included; strings go inline, so that the
// shared strings stay as they were.
function writeSheet(book, name, rows) {
  const path = book.sheets.get(name);
  const width = Math.max(1, ...rows.map(row => row.length));
  const data = rows.map((row, r) =>
    `<row r="${r + 1}">${row.map((cell, c) => (cell ? cellXml(`${columnName(c)}${r + 1}`, cell) : '')).join('')}</row>`).join('');
  const text = new TextDecoder().decode(book.files.get(path))
    .replace(/<sheetData\s*\/>|<sheetData>[\s\S]*<\/sheetData>/, `<sheetData>${data}</sheetData>`)
    .replace(/<dimension ref="[^"]*"\s*\/>/, `<dimension ref="A1:${columnName(width - 1)}${Math.max(1, rows.length)}"/>`);
  book.files.set(path, new TextEncoder().encode(text));
}

const excelDate = isoDate => (Date.parse(`${isoDate}T00:00:00Z`) - XLSX_EPOCH) / 86_400_000;
const isoFromExcel = days => new Date(XLSX_EPOCH + Math.round(days) * 86_400_000).toISOString().slice(0, 10);

const saveXlsx = book => zip(book.files);
