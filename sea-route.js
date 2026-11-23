// Shortest path by sea through the coast mask tools/export_voyage.py writes, with the rules of
// tools/sea_route.py: a mile closer to the coast than the export's distance costs ten, land is
// closed, and the grid path is pulled taut into a few segments. It runs on the mask's grid rather
// than on one of its own, so it may differ from the exported path by a mile or two.

const SEA_NEAR_COAST_COST = 10;
const SEA_MARGIN = 1.5;
const SEA_MAX_MARGIN = 6;
const SEA_TOLERANCE = 1.02;
// How far, in cells, a harbour lying on land in the mask may sit from the nearest water.
const SEA_SNAP_CELLS = 20;
// Each move lists the cells its segment crosses, so that a move never jumps over land; an opposite
// move crosses the mirror image.
const SEA_MOVES = [
  [0, 1, [[0, 0], [0, 1]]],
  [1, 0, [[0, 0], [1, 0]]],
  [1, 1, [[0, 0], [0, 1], [1, 0], [1, 1]]],
  [1, -1, [[0, 0], [0, -1], [1, 0], [1, -1]]],
  [1, 2, [[0, 0], [0, 1], [1, 1], [1, 2]]],
  [2, 1, [[0, 0], [1, 0], [1, 1], [2, 1]]],
  [1, -2, [[0, 0], [0, -1], [1, -1], [1, -2]]],
  [2, -1, [[0, 0], [1, 0], [1, -1], [2, -1]]],
].flatMap(([dr, dc, crossed]) => [
  { dr, dc, crossed },
  { dr: -dr, dc: -dc, crossed: crossed.map(([r, c]) => [-r, -c]) },
]);

class SeaHeap {
  nodes = [];
  keys = [];

  get size() {
    return this.nodes.length;
  }

  push(node, key) {
    const { nodes, keys } = this;
    let i = nodes.length;
    nodes.push(node);
    keys.push(key);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (keys[parent] <= key) break;
      nodes[i] = nodes[parent];
      keys[i] = keys[parent];
      i = parent;
    }
    nodes[i] = node;
    keys[i] = key;
  }

  pop() {
    const { nodes, keys } = this;
    const top = nodes[0];
    const node = nodes.pop();
    const key = keys.pop();
    if (nodes.length) {
      let i = 0;
      for (let child = 1; child < nodes.length; child = 2 * i + 1) {
        if (child + 1 < nodes.length && keys[child + 1] < keys[child]) child++;
        if (keys[child] >= key) break;
        nodes[i] = nodes[child];
        keys[i] = keys[child];
        i = child;
      }
      nodes[i] = node;
      keys[i] = key;
    }
    return top;
  }
}

// The part of the mask around two points, as costs per mile: 1 at sea, more near the coast,
// Infinity on land.
function seaWindow(mask, from, to, margin) {
  const rowOf = lat => Math.floor((mask.north - lat) / mask.dlat);
  const colOf = lon => Math.floor((lon - mask.west) / mask.dlon);
  const top = rowOf(Math.max(from[0], to[0]) + margin);
  const bottom = rowOf(Math.min(from[0], to[0]) - margin);
  const left = colOf(Math.min(from[1], to[1]) - margin);
  const right = colOf(Math.max(from[1], to[1]) + margin);
  const rows = bottom - top + 1;
  const cols = right - left + 1;
  const weight = new Float32Array(rows * cols);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const [row, col] = [top + r, left + c];
      // The mask reaches 4° around every route: beyond it, a passage far offshore is in open sea.
      const outside = row < 0 || col < 0 || row >= mask.height || col >= mask.width;
      const level = outside ? 0 : mask.data[4 * (row * mask.width + col)];
      weight[r * cols + c] = level < 64 ? 1 : level < 192 ? SEA_NEAR_COAST_COST : Infinity;
    }
  }
  const latitude = r => mask.north - (top + r + 0.5) * mask.dlat;
  return {
    rows,
    cols,
    weight,
    dy: mask.dlat * 60,
    dx: Float64Array.from({ length: rows }, (_, r) => mask.dlon * 60 * Math.cos(latitude(r) * Math.PI / 180)),
    cell: ([lat, lon]) => [rowOf(lat) - top, colOf(lon) - left],
    position: ([r, c]) => [Number(latitude(r).toFixed(4)), Number((mask.west + (left + c + 0.5) * mask.dlon).toFixed(4))],
  };
}

// A harbour narrower than the coastline's resolution lies on land: start from the nearest water.
function seaSnap(win, at) {
  const [row, col] = win.cell(at);
  let best = -1;
  let bestDistance = Infinity;
  for (let r = Math.max(0, row - SEA_SNAP_CELLS); r <= Math.min(win.rows - 1, row + SEA_SNAP_CELLS); r++) {
    for (let c = Math.max(0, col - SEA_SNAP_CELLS); c <= Math.min(win.cols - 1, col + SEA_SNAP_CELLS); c++) {
      if (win.weight[r * win.cols + c] === Infinity) continue;
      const distance = Math.hypot((r - row) * win.dy, (c - col) * win.dx[r]);
      if (distance < bestDistance) [best, bestDistance] = [r * win.cols + c, distance];
    }
  }
  return best;
}

// A*, guided by the straight distance with the narrower of the two columns, which never overstates
// what is left to sail.
function seaSearch(win, start, goal) {
  const { rows, cols, weight, dy, dx } = win;
  const cost = new Float64Array(rows * cols).fill(Infinity);
  const previous = new Int32Array(rows * cols).fill(-1);
  const closed = new Uint8Array(rows * cols);
  const goalRow = Math.floor(goal / cols);
  const goalCol = goal % cols;
  const estimate = (r, c) => Math.hypot((r - goalRow) * dy, (c - goalCol) * Math.min(dx[r], dx[goalRow]));
  const heap = new SeaHeap();
  cost[start] = 0;
  heap.push(start, 0);
  while (heap.size) {
    const node = heap.pop();
    if (node === goal) break;
    if (closed[node]) continue;
    closed[node] = 1;
    const r = Math.floor(node / cols);
    const c = node % cols;
    for (const { dr, dc, crossed } of SEA_MOVES) {
      const nr = r + dr;
      const nc = c + dc;
      if (nr < 0 || nc < 0 || nr >= rows || nc >= cols || closed[nr * cols + nc]) continue;
      let sum = 0;
      for (const [cr, cc] of crossed) sum += weight[(r + cr) * cols + c + cc];
      if (sum === Infinity) continue;
      const total = cost[node] + Math.hypot(dr * dy, dc * dx[r]) * sum / crossed.length;
      const next = nr * cols + nc;
      if (total < cost[next]) {
        cost[next] = total;
        previous[next] = node;
        heap.push(next, total + estimate(nr, nc));
      }
    }
  }
  if (cost[goal] === Infinity) return null;
  const nodes = [goal];
  while (nodes.at(-1) !== start) nodes.push(previous[nodes.at(-1)]);
  return nodes.reverse();
}

// From each kept cell, jump to the farthest cell of the path that a straight segment reaches for no
// more than the stretch it replaces; reach is taken to shrink with distance, for a binary search.
function seaStraighten(win, cells, costs) {
  const { cols, weight, dy, dx } = win;
  const sample = ([r0, c0], [r1, c1], perCell) => {
    const steps = Math.max(Math.abs(r1 - r0), Math.abs(c1 - c0)) * perCell;
    return Array.from({ length: steps + 1 }, (_, i) =>
      weight[Math.round(r0 + (r1 - r0) * i / steps) * cols + Math.round(c0 + (c1 - c0) * i / steps)]);
  };
  const segmentCost = (a, b) => {
    if (sample(a, b, 4).includes(Infinity)) return Infinity;
    const length = Math.hypot((b[0] - a[0]) * dy, (b[1] - a[1]) * dx[Math.floor((a[0] + b[0]) / 2)]);
    const weights = sample(a, b, 1);
    let sum = 0;
    for (let i = 1; i < weights.length; i++) sum += (weights[i] + weights[i - 1]) / 2;
    return length * sum / (weights.length - 1);
  };
  const reaches = (i, j) => segmentCost(cells[i], cells[j]) <= (costs[j] - costs[i]) * SEA_TOLERANCE;
  const kept = [0];
  const last = cells.length - 1;
  while (kept.at(-1) < last) {
    const i = kept.at(-1);
    let step = 1;
    while (i + step < last && reaches(i, i + step)) step *= 2;
    let low = i + Math.max(step >> 1, 1);
    let high = Math.min(i + step, last);
    if (reaches(i, high)) low = high;
    while (high - low > 1) {
      const middle = (low + high) >> 1;
      if (reaches(i, middle)) low = middle;
      else high = middle;
    }
    kept.push(low);
  }
  return kept.map(i => cells[i]);
}

// [lat, lon] to [lat, lon], through the sea; throws when the sea does not join them.
function seaRoute(mask, from, to) {
  for (let margin = SEA_MARGIN; ; margin *= 2) {
    const win = seaWindow(mask, from, to, margin);
    const start = seaSnap(win, from);
    const goal = seaSnap(win, to);
    if (start < 0 || goal < 0) throw new Error('trop loin de la mer');
    const nodes = start === goal ? [start] : seaSearch(win, start, goal);
    const cells = nodes?.map(node => [Math.floor(node / win.cols), node % win.cols]);
    const touchesEdge = cells?.some(([r, c]) => r < 2 || c < 2 || r >= win.rows - 2 || c >= win.cols - 2);
    if ((cells && !touchesEdge) || margin * 2 > SEA_MAX_MARGIN) {
      if (!cells) throw new Error('aucun chemin par la mer');
      const costs = [0];
      for (let i = 1; i < cells.length; i++) {
        const [r0, c0] = cells[i - 1];
        const [r1, c1] = cells[i];
        const move = SEA_MOVES.find(({ dr, dc }) => dr === r1 - r0 && dc === c1 - c0);
        let sum = 0;
        for (const [cr, cc] of move.crossed) sum += win.weight[(r0 + cr) * win.cols + c0 + cc];
        costs.push(costs[i - 1] + Math.hypot(move.dr * win.dy, move.dc * win.dx[r0]) * sum / move.crossed.length);
      }
      // A point inside its own end cell joins the path directly, without a detour by the cell's centre.
      const kept = seaStraighten(win, cells, costs);
      const [startRow, startCol] = win.cell(from);
      const [goalRow, goalCol] = win.cell(to);
      if (kept.length && kept[0][0] === startRow && kept[0][1] === startCol) kept.shift();
      if (kept.length && kept.at(-1)[0] === goalRow && kept.at(-1)[1] === goalCol) kept.pop();
      return [from, ...kept.map(win.position), to];
    }
  }
}
