// Shared by the NJORD pages: reading the workbook and drawing the route.
// Needs Leaflet, SheetJS and njord.css loaded first.
const WORKBOOK_URL = '../data/NJORD_Planning_repartition_equipiers_2027.xlsx';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);
}

// Excel stores a date as a day count from 1899-12-30.
function excelDate(value) {
  return new Date(Date.UTC(1899, 11, 30) + value * 86_400_000);
}

function formatDate(value) {
  if (typeof value !== 'number') return String(value ?? '');
  return excelDate(value).toLocaleDateString('fr-CH', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function formatDistance(value) {
  const text = String(value ?? '');
  return text.includes('NM') ? text : `${text} NM`;
}

async function fetchWorkbook() {
  const response = await fetch(WORKBOOK_URL, { cache: 'no-store' });
  if (!response.ok) throw new Error(`${WORKBOOK_URL} : HTTP ${response.status}`);
  return XLSX.read(await response.arrayBuffer());
}

function readTable(workbook, sheetName, firstColumn) {
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) throw new Error(`Onglet « ${sheetName} » introuvable dans le fichier Excel.`);
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
  const headerIndex = rows.findIndex(row => row[0] === firstColumn);
  if (headerIndex < 0) throw new Error(`Ligne d'en-tête « ${firstColumn} » introuvable dans l'onglet « ${sheetName} ».`);
  const header = rows[headerIndex];
  return rows.slice(headerIndex + 1)
    .filter(row => row.some(cell => cell != null && cell !== ''))
    .map(row => Object.fromEntries(header.map((name, i) => [name, row[i]])));
}

function readPosition(row, sheetName) {
  const at = [row.Latitude, row.Longitude];
  if (!at.every(Number.isFinite)) {
    throw new Error(`Latitude ou longitude invalide dans l'onglet « ${sheetName} » : ${row.Nom || '(sans nom)'}.`);
  }
  return at;
}

function readVoyage(workbook) {
  const legs = readTable(workbook, 'Planning équipiers', 'Étape').filter(leg => leg['Étape'] != null && leg['Étape'] !== '');
  const ports = Object.fromEntries(readTable(workbook, 'Ports', 'Nom').map(row => [row.Nom, {
    at: readPosition(row, 'Ports'),
    approximate: row['Position approximative'] === 'oui',
  }]));
  const waypoints = readTable(workbook, 'Points de passage', 'Étape')
    .map(row => ({ leg: Number(row['Étape']), name: row.Nom, at: readPosition(row, 'Points de passage') }));
  // Each leg starts where the previous one ended, so only the first departure comes from « Embarquement ».
  const stops = [legs[0]['Embarquement hypothétique'], ...legs.map(leg => leg['Débarquement hypothétique'])];
  const unknown = stops.filter(name => !ports[name]);
  if (unknown.length) throw new Error(`Port absent de l'onglet « Ports » : ${unknown.join(' ; ')}.`);
  return { title: workbook.Sheets['Planning équipiers'].A1?.v, legs, ports, waypoints, stops };
}

function routeColor() {
  return getComputedStyle(document.documentElement).getPropertyValue('--route').trim();
}

function addBaseMap(map) {
  // Keyless and served without a Referer, so it also works when the page is opened from file://.
  return L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 16,
    attribution: 'Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ',
  }).addTo(map);
}

function drawLeg(map, { legs, ports, waypoints, stops }, index) {
  const from = ports[stops[index]];
  const to = ports[stops[index + 1]];
  const via = waypoints.filter(point => point.leg === Number(legs[index]['Étape'])).map(point => point.at);
  return L.polyline([from.at, ...via, to.at], {
    color: routeColor(),
    weight: 3,
    dashArray: from.approximate || to.approximate ? '6 6' : null,
  }).addTo(map);
}

function drawPort(map, name, port, labelSide = 'right') {
  return L.circleMarker(port.at, {
    radius: 6,
    color: routeColor(),
    weight: 2,
    fillColor: port.approximate ? '#fff' : routeColor(),
    fillOpacity: 1,
    dashArray: port.approximate ? '2 3' : null,
  })
    .bindTooltip(escapeHtml(name), { permanent: true, direction: labelSide, className: 'port-label' })
    .addTo(map);
}
