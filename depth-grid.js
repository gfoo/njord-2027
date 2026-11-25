// EMODnet's depth grid, read from its WCS service, and the depth contours drawn on it: the finer
// ones its own contour layer lacks (it stops at 50 m), for whether a passage stays deep enough.
// The grid is the one EMODnet publishes, a cell of 1/16 of a minute of arc (about 90 m by 115 m
// here): a rock smaller than a cell is not in it.

const DEPTH_CELL_DEG = 1 / 960;
// The service writes its TIFF in blocks of 240 cells: a tile of 239, plus the cell it shares with
// the next one, fits in a single block; 240 plus one came back as four, padded, four times the bytes.
const DEPTH_TILE_CELLS = 239;
const DEPTH_TILE_DEG = DEPTH_TILE_CELLS * DEPTH_CELL_DEG;
// Beyond any sea depth: a value the grid uses where it has none.
const DEPTH_NO_DATA = 12000;

function depthTilesIn(bounds) {
  const tiles = [];
  for (let x = Math.floor(bounds.getWest() / DEPTH_TILE_DEG); x * DEPTH_TILE_DEG < bounds.getEast(); x++) {
    for (let y = Math.floor(bounds.getSouth() / DEPTH_TILE_DEG); y * DEPTH_TILE_DEG < bounds.getNorth(); y++) {
      tiles.push([x, y]);
    }
  }
  return tiles;
}

// A tile one cell larger than its step, so that its contours meet those of the next tile.
async function fetchDepthTile(x, y) {
  const size = DEPTH_TILE_CELLS + 1;
  const west = x * DEPTH_TILE_DEG;
  const south = y * DEPTH_TILE_DEG;
  const north = south + size * DEPTH_CELL_DEG;
  const url = 'https://ows.emodnet-bathymetry.eu/wcs?service=wcs&version=1.0.0&request=getcoverage' +
    `&coverage=emodnet:mean&crs=EPSG:4326&bbox=${west},${south},${west + size * DEPTH_CELL_DEG},${north}` +
    `&width=${size}&height=${size}&format=image/tiff&interpolation=nearest`;
  const response = await fetch(url);
  // A refusal comes back as an XML report, often with a 200.
  if (!response.ok || !response.headers.get('content-type')?.startsWith('image/tiff')) {
    throw new Error(`HTTP ${response.status}`);
  }
  return { ...readFloatTiff(await response.arrayBuffer()), west, north, step: DEPTH_CELL_DEG };
}

// The TIFF the service writes: one band of 32-bit floats, uncompressed, in strips or in tiles.
function readFloatTiff(buffer) {
  const view = new DataView(buffer);
  const little = view.getUint16(0) === 0x4949;
  if (view.getUint16(2, little) !== 42) throw new Error('pas un fichier TIFF');
  const readers = {
    1: [1, at => view.getUint8(at)],
    3: [2, at => view.getUint16(at, little)],
    4: [4, at => view.getUint32(at, little)],
  };
  const tags = {};
  const ifd = view.getUint32(4, little);
  for (let k = 0; k < view.getUint16(ifd, little); k++) {
    const at = ifd + 2 + k * 12;
    const reader = readers[view.getUint16(at + 2, little)];
    if (!reader) continue;
    const [size, read] = reader;
    const count = view.getUint32(at + 4, little);
    const start = size * count > 4 ? view.getUint32(at + 8, little) : at + 8;
    tags[view.getUint16(at, little)] = Array.from({ length: count }, (_, i) => read(start + i * size));
  }
  if (tags[259]?.[0] !== 1 || tags[258]?.[0] !== 32 || tags[339]?.[0] !== 3 || (tags[277]?.[0] ?? 1) !== 1) {
    throw new Error('TIFF compressé, ou pas une seule bande de flottants');
  }
  const [width] = tags[256];
  const [height] = tags[257];
  const tiled = 322 in tags;
  const blockWidth = tiled ? tags[322][0] : width;
  const blockHeight = tiled ? tags[323][0] : (tags[278]?.[0] ?? height);
  const across = Math.ceil(width / blockWidth);
  const values = new Float32Array(width * height);
  // A tile is stored whole, padded beyond the image's edge; a strip is as wide as the image.
  (tiled ? tags[324] : tags[273]).forEach((offset, block) => {
    const left = (block % across) * blockWidth;
    const top = Math.floor(block / across) * blockHeight;
    for (let row = 0; row < blockHeight && top + row < height; row++) {
      for (let col = 0; col < blockWidth && left + col < width; col++) {
        values[(top + row) * width + left + col] = view.getFloat32(offset + (row * blockWidth + col) * 4, little);
      }
    }
  });
  return { width, height, values };
}

// Marching squares between the cells' centres, each crossing placed by linear interpolation; the
// pieces are chained into lines through the cell edges they share, a closed contour into a ring.
function isobaths({ width, height, values, west, north, step }, depth) {
  const depthAt = (i, j) => {
    const value = values[j * width + i];
    return Number.isFinite(value) && Math.abs(value) < DEPTH_NO_DATA ? -value : NaN;
  };
  const centre = (i, j) => [north - (j + 0.5) * step, west + (i + 0.5) * step];
  const points = new Map();
  const links = new Map();
  const cross = (key, from, to, a, b) => {
    if (!points.has(key)) {
      const t = (depth - a) / (b - a);
      points.set(key, [from[0] + t * (to[0] - from[0]), from[1] + t * (to[1] - from[1])]);
    }
    return key;
  };
  const link = (one, other) => [[one, other], [other, one]].forEach(([a, b]) => {
    if (!links.has(a)) links.set(a, []);
    links.get(a).push(b);
  });
  for (let j = 0; j + 1 < height; j++) {
    for (let i = 0; i + 1 < width; i++) {
      const a = depthAt(i, j);
      const b = depthAt(i + 1, j);
      const c = depthAt(i + 1, j + 1);
      const e = depthAt(i, j + 1);
      if ([a, b, c, e].some(Number.isNaN)) continue;
      const deep = (a >= depth) * 8 + (b >= depth) * 4 + (c >= depth) * 2 + (e >= depth);
      if (deep === 0 || deep === 15) continue;
      const edge = {
        T: () => cross(`h${i},${j}`, centre(i, j), centre(i + 1, j), a, b),
        R: () => cross(`v${i + 1},${j}`, centre(i + 1, j), centre(i + 1, j + 1), b, c),
        B: () => cross(`h${i},${j + 1}`, centre(i, j + 1), centre(i + 1, j + 1), e, c),
        L: () => cross(`v${i},${j}`, centre(i, j), centre(i, j + 1), a, e),
      };
      // Two opposite corners deep and two shallow: the cell's mean says which pair is joined.
      const centreDeep = (a + b + c + e) / 4 >= depth;
      const pieces = {
        1: ['LB'], 2: ['BR'], 3: ['LR'], 4: ['TR'], 6: ['TB'], 7: ['TL'], 8: ['TL'], 9: ['TB'],
        11: ['TR'], 12: ['LR'], 13: ['BR'], 14: ['LB'],
        5: centreDeep ? ['TL', 'BR'] : ['TR', 'LB'],
        10: centreDeep ? ['TR', 'LB'] : ['TL', 'BR'],
      }[deep];
      pieces.forEach(([one, other]) => link(edge[one](), edge[other]()));
    }
  }
  const seen = new Set();
  const follow = start => {
    const line = [points.get(start)];
    seen.add(start);
    for (let key = start, next; (next = links.get(key).find(other => !seen.has(other))); key = next) {
      seen.add(next);
      line.push(points.get(next));
    }
    return line;
  };
  const lines = [];
  links.forEach((ends, key) => ends.length === 1 && !seen.has(key) && lines.push(follow(key)));
  links.forEach((_, key) => {
    if (seen.has(key)) return;
    const ring = follow(key);
    lines.push([...ring, ring[0]]);
  });
  return lines;
}
