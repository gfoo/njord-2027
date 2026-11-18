// Wind data from Open-Meteo: free, keyless, CC BY 4.0. Speeds in knots, directions in degrees
// the wind comes from.
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const ARCHIVE_URL = 'https://archive-api.open-meteo.com/v1/archive';
const ROSE_DEFAULT_YEARS = 5;
// A year of archives counts as 27 calls against the quota: 20 years is about what a minute allows.
const ROSE_MAX_YEARS = 20;
// Weather models Open-Meteo serves for free, by its identifiers.
const WIND_MODELS = {
  best_match: 'Automatique (le meilleur disponible)',
  ecmwf_ifs025: 'ECMWF IFS (centre européen)',
  icon_seamless: 'ICON (DWD, Allemagne)',
  gfs_seamless: 'GFS (NOAA, États-Unis)',
  meteofrance_seamless: 'ARPEGE / AROME (Météo-France)',
};
const WIND_HOURS = 72;
const SECTORS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSO', 'SO', 'OSO', 'O', 'ONO', 'NO', 'NNO'];
// ink: the text colour that stays readable on the band's colour.
const SPEED_BANDS = [
  { max: 11, force: 'F0–3', label: 'moins de 11 nd (force 0–3)', color: '#b8cde0', ink: '#1d2b3a' },
  { max: 17, force: 'F4', label: '11–16 nd (force 4)', color: '#4f9a58', ink: '#fff' },
  { max: 28, force: 'F5–6', label: '17–27 nd (force 5–6)', color: '#e09a2b', ink: '#1d2b3a' },
  { max: Infinity, force: 'F7+', label: '28 nd et plus (force 7+)', color: '#c0392b', ink: '#fff' },
];
// Where the colour bar ends; stronger winds fall in its last band.
const SCALE_MAX_KNOTS = 40;
// Spring and autumn are the pair a deuteranope confuses once the outlines overlap: their dashes
// tell them apart.
const SEASONS = [
  { label: 'Printemps', months: 'mars–mai', color: '#1baf7a', dash: '7 4' },
  { label: 'Été', months: 'juin–août', color: '#eda100', dash: '' },
  { label: 'Automne', months: 'sept.–nov.', color: '#e34948', dash: '2 3' },
  { label: 'Hiver', months: 'déc.–févr.', color: '#2a78d6', dash: '' },
];

const HOUR = 3_600_000;
const sectorOf = direction => Math.round(direction / 22.5) % 16;
const bandOf = speed => SPEED_BANDS.findIndex(band => speed < band.max);
// Month 0–11 to season 0–3, March opening spring.
const seasonOf = month => Math.floor(((month + 10) % 12) / 3);
const percent = value => `${Math.round(value * 100)} %`;

// Open-Meteo's free tier allows 600 calls a minute. Requests wait their turn here rather than be
// refused; the margin covers what a previous load of the page may still have counted.
const QUOTA_PER_MINUTE = 540;
const MINUTE = 60_000;
const quotaSpent = [];

async function withinQuota(cost, { onWait, cancelled } = {}) {
  for (;;) {
    if (cancelled?.()) throw new Error('requête abandonnée');
    const now = Date.now();
    while (quotaSpent.length && quotaSpent[0].at <= now - MINUTE) quotaSpent.shift();
    let excess = quotaSpent.reduce((sum, entry) => sum + entry.cost, 0) + cost - QUOTA_PER_MINUTE;
    if (excess <= 0) {
      quotaSpent.push({ at: now, cost });
      return;
    }
    const freedAt = quotaSpent.find(entry => (excess -= entry.cost) <= 0).at + MINUTE;
    onWait?.(Math.ceil((freedAt - now) / 1000));
    await new Promise(resolve => setTimeout(resolve, Math.min(freedAt - now, 1000)));
  }
}

async function fetchJson(url, cost, pacing) {
  await withinQuota(cost, pacing);
  const response = await fetch(url);
  if (!response.ok) {
    // Open-Meteo's body names the limit reached: minute, hour or day.
    const reason = await response.json().then(body => body.reason ?? '', () => '');
    throw Object.assign(new Error(`Open-Meteo : HTTP ${response.status} ${reason}`), { status: response.status, reason });
  }
  return response.json();
}

// What to tell the viewer when Open-Meteo refuses: its free quota is the usual cause.
function weatherErrorMessage(error, fallback) {
  if (error.status !== 429) return fallback;
  const retry = /daily/i.test(error.reason) ? 'réessaie demain'
    : /hourly/i.test(error.reason) ? "réessaie dans l'heure"
    : /minutely/i.test(error.reason) || !error.reason ? 'réessaie dans une minute'
    : error.reason;
  return `Limite de requêtes Open-Meteo atteinte : ${retry}.`;
}

// One request for every point. Open-Meteo answers with an array when given several points.
async function currentWind(points) {
  const params = new URLSearchParams({
    latitude: points.map(([lat]) => lat.toFixed(3)).join(','),
    longitude: points.map(([, lon]) => lon.toFixed(3)).join(','),
    current: 'wind_speed_10m,wind_direction_10m,wind_gusts_10m',
    wind_speed_unit: 'kn',
    timezone: 'UTC',
  });
  const data = await fetchJson(`${FORECAST_URL}?${params}`, points.length);
  return [data].flat().map(location => location.current);
}

// Kept in the browser across page loads: Open-Meteo's quota is counted per connection and per day,
// and much of what the page asks for has been asked before. A private window may refuse storage;
// the page then works without it.
const STORE_PREFIX = 'njord.';

function storeGet(key) {
  try {
    return JSON.parse(localStorage.getItem(STORE_PREFIX + key));
  } catch {
    return null;
  }
}

function storeDrop(test) {
  try {
    Object.keys(localStorage)
      .filter(key => key.startsWith(STORE_PREFIX) && test(key.slice(STORE_PREFIX.length)))
      .forEach(key => localStorage.removeItem(key));
  } catch {
    // Storage refused: nothing was kept, nothing to drop.
  }
}

function storeSet(key, value) {
  const text = JSON.stringify(value);
  try {
    localStorage.setItem(STORE_PREFIX + key, text);
  } catch {
    // Storage full: the forecasts go first, as they expire within hours anyway.
    storeDrop(stored => stored.startsWith('wind|'));
    try {
      localStorage.setItem(STORE_PREFIX + key, text);
    } catch {
      // Still refused: the result stays in memory for this visit only.
    }
  }
}

// The archives' grid is about 0.1°: clicks closer than that get the same rose, and share it.
const roseCell = ([lat, lon]) => [Number(lat.toFixed(1)), Number(lon.toFixed(1))];

// Open-Meteo counts one call per 14 days of data asked for one point: 27 for a year.
const ARCHIVE_YEAR_COST = 27;

function fetchArchive(at, year, pacing) {
  const url = `${ARCHIVE_URL}?${new URLSearchParams({
    latitude: at[0].toFixed(1),
    longitude: at[1].toFixed(1),
    start_date: `${year}-01-01`,
    end_date: `${year}-12-31`,
    hourly: 'wind_speed_10m,wind_direction_10m',
    wind_speed_unit: 'kn',
    timezone: 'UTC',
  })}`;
  return fetchJson(url, ARCHIVE_YEAR_COST, pacing);
}

// Hourly forecast at every point, in one request: one series per point, from today 00:00 UTC.
async function windForecast(points, model, pacing) {
  const params = new URLSearchParams({
    latitude: points.map(([lat]) => lat.toFixed(2)).join(','),
    longitude: points.map(([, lon]) => lon.toFixed(2)).join(','),
    hourly: 'wind_speed_10m,wind_direction_10m',
    wind_speed_unit: 'kn',
    timezone: 'UTC',
    forecast_days: '4',
    models: model,
  });
  const data = await fetchJson(`${FORECAST_URL}?${params}`, points.length, pacing);
  const fetched = Date.now();
  return [data].flat().map(({ hourly }) => ({
    start: Date.parse(`${hourly.time[0]}Z`),
    speed: hourly.wind_speed_10m,
    direction: hourly.wind_direction_10m,
    fetched,
  }));
}

// A forecast is kept three hours, and only while it starts at today's midnight (UTC): later, the
// models have moved on and the +72 h slider would reach past the kept series.
const FORECAST_KEEP = 3 * HOUR;
const forecasts = new Map();
const forecastKey = (model, [lat, lon]) => `wind|${model}|${lat},${lon}`;

function isFresh(series) {
  const now = new Date();
  return now - series.fetched < FORECAST_KEEP &&
    series.start === Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

function cachedForecast(model, point) {
  const key = forecastKey(model, point);
  const series = forecasts.get(key) ?? storeGet(key);
  if (!series || !isFresh(series)) return null;
  forecasts.set(key, series);
  return series;
}

function keepForecast(model, point, series) {
  forecasts.set(forecastKey(model, point), series);
  storeSet(forecastKey(model, point), series);
}

function dropForecasts() {
  forecasts.clear();
  storeDrop(key => key.startsWith('wind|'));
}

storeDrop(key => key.startsWith('wind|') && !isFresh(storeGet(key) ?? {}));

const emptyTally = () => ({ counts: SECTORS.map(() => SPEED_BANDS.map(() => 0)), total: 0, speedSum: 0 });

function addTally(sum, { counts, total, speedSum }) {
  counts.forEach((sector, s) => sector.forEach((n, band) => { sum.counts[s][band] += n; }));
  sum.total += total;
  sum.speedSum += speedSum;
  return sum;
}

// One year of hourly wind, tallied by season, direction and force.
function seasonTallies({ hourly }) {
  const seasons = SEASONS.map(emptyTally);
  hourly.time.forEach((time, i) => {
    const speed = hourly.wind_speed_10m[i];
    const direction = hourly.wind_direction_10m[i];
    if (speed == null || direction == null) return;
    const tally = seasons[seasonOf(Number(time.slice(5, 7)) - 1)];
    tally.counts[sectorOf(direction)][bandOf(speed)] += 1;
    tally.total += 1;
    tally.speedSum += speed;
  });
  return seasons;
}

// A past year's tallies never change: they are kept for good, per grid cell and year. A request
// still under way is shared, so that two clicks in one cell ask once.
const yearTallies = new Map();

function yearTally(cell, year, pacing) {
  const key = `rose|${cell}|${year}`;
  if (!yearTallies.has(key)) {
    const stored = storeGet(key);
    yearTallies.set(key, stored ? Promise.resolve(stored) : fetchArchive(cell, year, pacing)
      .then(response => {
        const seasons = seasonTallies(response);
        storeSet(key, seasons);
        return seasons;
      })
      .catch(error => {
        yearTallies.delete(key);
        throw error;
      }));
  }
  return yearTallies.get(key);
}

// The wind of the last full calendar years in the clicked spot's grid cell, by season and over the
// whole year.
async function windClimate(at, years, onProgress, pacing) {
  const cell = roseCell(at);
  const lastYear = new Date().getUTCFullYear() - 1;
  const firstYear = lastYear - years + 1;
  let done = 0;
  const perYear = await Promise.all(Array.from({ length: years }, (_, i) =>
    yearTally(cell, firstYear + i, pacing).then(seasons => {
      onProgress?.(++done, years);
      return seasons;
    })));
  const seasons = SEASONS.map((_, s) => perYear.reduce((sum, yearSeasons) => addTally(sum, yearSeasons[s]), emptyTally()));
  const year = seasons.reduce(addTally, emptyTally());
  if (!year.total) throw new Error('aucune donnée pour ce point');
  return { cell, seasons, year, span: years === 1 ? `en ${lastYear}` : `de ${firstYear} à ${lastYear} (${years} ans)` };
}

const sectorShares = ({ counts, total }) => counts.map(sector => sector.reduce((a, b) => a + b, 0) / total);

function windFigures(tally) {
  const shares = sectorShares(tally);
  const dominant = shares.indexOf(Math.max(...shares));
  const shareFrom = band =>
    tally.counts.reduce((sum, sector) => sum + sector.slice(band).reduce((a, b) => a + b, 0), 0) / tally.total;
  return {
    dominant: SECTORS[dominant],
    dominantShare: shares[dominant],
    mean: tally.speedSum / tally.total,
    force5: shareFrom(2),
    force7: shareFrom(3),
  };
}

function roseSummary(tally) {
  const { dominant, dominantShare, mean, force5, force7 } = windFigures(tally);
  return `Vent le plus fréquent : de ${dominant} (${percent(dominantShare)} du temps). Vitesse moyenne : ${Math.round(mean)} nd. ` +
    `Force 5 ou plus : ${percent(force5)} du temps, force 7 ou plus : ${percent(force7)}.`;
}

const ROSE_SIZE = 240, ROSE_CENTER = 120, ROSE_RADIUS = 92;

function rosePoint(r, angle) {
  const rad = angle * Math.PI / 180;
  return `${(ROSE_CENTER + r * Math.sin(rad)).toFixed(1)},${(ROSE_CENTER - r * Math.cos(rad)).toFixed(1)}`;
}

// Rings labelled in share of the time, scaled on the largest sector, and the cardinal points.
function roseFrame(peak, marks, label) {
  const [size, center, radius] = [ROSE_SIZE, ROSE_CENTER, ROSE_RADIUS];
  const rings = [0.25, 0.5, 0.75, 1].map(k =>
    `<circle cx="${center}" cy="${center}" r="${radius * k}" class="ring"/>` +
    `<text x="${center + 3}" y="${center - radius * k - 2}" class="ring-label">${Math.round(peak * k * 100)} %</text>`).join('');
  const cardinals = [['N', center, 14], ['E', size - 8, center + 4], ['S', center, size - 4], ['O', 8, center + 4]]
    .map(([text, x, y]) => `<text x="${x}" y="${y}" class="cardinal">${text}</text>`).join('');
  return `<svg viewBox="0 0 ${size} ${size}" class="rose" role="img" aria-label="${label}">${rings}${marks}${cardinals}</svg>`;
}

function roseSvg(tally) {
  const shares = tally.counts.map(sector => sector.map(n => n / tally.total));
  const peak = Math.max(...sectorShares(tally));
  const wedge = (r0, r1, a0, a1) =>
    `M${rosePoint(r0, a0)} L${rosePoint(r1, a0)} A${r1},${r1} 0 0 1 ${rosePoint(r1, a1)} L${rosePoint(r0, a1)} A${r0},${r0} 0 0 0 ${rosePoint(r0, a0)}Z`;
  const half = 22.5 / 2 * 0.82;
  const wedges = shares.map((sector, s) => {
    let inner = 0;
    return sector.map((value, band) => {
      const outer = inner + value;
      const path = value
        ? `<path d="${wedge(ROSE_RADIUS * inner / peak, ROSE_RADIUS * outer / peak, s * 22.5 - half, s * 22.5 + half)}" fill="${SPEED_BANDS[band].color}"/>`
        : '';
      inner = outer;
      return path;
    }).join('');
  }).join('');
  return roseFrame(peak, wedges, 'Rose des vents');
}

// One outline per season on a common scale; the highlighted season is drawn last, in bold.
// Each vertex carries its figure as a tooltip.
function seasonRoseSvg(seasons, highlight) {
  const shares = seasons.map(sectorShares);
  const peak = Math.max(...shares.flat());
  const order = SEASONS.map((_, s) => s).sort((a, b) => (a === highlight) - (b === highlight));
  const outlines = order.map(s => {
    const { label, color, dash } = SEASONS[s];
    const width = s === highlight ? 3.5 : 2;
    const points = shares[s].map((share, i) => rosePoint(ROSE_RADIUS * share / peak, i * 22.5)).join(' ');
    const vertices = shares[s].map((share, i) =>
      `<circle cx="${rosePoint(ROSE_RADIUS * share / peak, i * 22.5).replace(',', '" cy="')}" r="6" class="vertex">` +
      `<title>${label}, vent de ${SECTORS[i]} : ${percent(share)} du temps</title></circle>`).join('');
    return `<g data-season="${s}">` +
      `<polygon points="${points}" fill="${color}" fill-opacity="0.07" stroke="#fff" stroke-width="${width + 2}" stroke-linejoin="round"/>` +
      `<polygon points="${points}" fill="none" stroke="${color}" stroke-width="${width}" stroke-dasharray="${dash}" stroke-linejoin="round"/>` +
      `${vertices}</g>`;
  }).join('');
  return roseFrame(peak, outlines, 'Rose des vents par saison');
}

function seasonSwatch(s, highlight) {
  const { color, dash } = SEASONS[s];
  return `<svg class="swatch" viewBox="0 0 22 8" aria-hidden="true"><line x1="1" y1="4" x2="21" y2="4" stroke="${color}" ` +
    `stroke-width="${s === highlight ? 3.5 : 2}" stroke-dasharray="${dash}"/></svg>`;
}

// Buttons that hide or show a season's outline.
function seasonLegend(highlight) {
  return '<div class="season-legend">' + SEASONS.map((season, s) =>
    `<button type="button" data-season="${s}" aria-pressed="true">${seasonSwatch(s, highlight)}${season.label}</button>`).join('') +
    '</div>';
}

function seasonTable(seasons, highlight) {
  const rows = seasons.map((tally, s) => {
    const { dominant, dominantShare, mean, force5, force7 } = windFigures(tally);
    return `<tr${s === highlight ? ' class="current"' : ''}><td>${seasonSwatch(s, highlight)}${SEASONS[s].label}` +
      `<div class="small">${SEASONS[s].months}</div></td><td>${dominant} (${percent(dominantShare)})</td>` +
      `<td>${Math.round(mean)} nd</td><td>${percent(force5)}</td><td>${percent(force7)}</td></tr>`;
  }).join('');
  return '<table class="season-table"><thead><tr><th></th><th>Dominant</th><th>Moyen</th>' +
    '<th title="Force 5 ou plus : 17 nd et plus">F5+</th><th title="Force 7 ou plus : 28 nd et plus">F7+</th></tr></thead>' +
    `<tbody>${rows}</tbody></table>`;
}

// A bar graduated in knots, each band as long as the speeds it covers.
function speedScale() {
  let from = 0;
  const segments = SPEED_BANDS.map(band => {
    const to = Math.min(band.max, SCALE_MAX_KNOTS);
    const segment = `<span style="flex: ${to - from}; background: ${band.color}; color: ${band.ink}" title="${band.label}">${band.force}</span>`;
    from = to;
    return segment;
  }).join('');
  const ticks = [0, ...SPEED_BANDS.slice(0, -1).map(band => band.max)]
    .map(knots => `<span style="left: ${knots / SCALE_MAX_KNOTS * 100}%">${knots}</span>`).join('');
  return `<div class="scale"><div class="scale-bar">${segments}</div><div class="scale-ticks">${ticks}<span class="unit">nd</span></div></div>`;
}

// The arrow points where the wind goes, like on a weather chart.
function windArrow(direction) {
  return `<svg class="arrow" viewBox="-10 -10 20 20" style="transform: rotate(${direction + 180}deg)" aria-hidden="true"><path d="M0,-8 L5,5 L0,2 L-5,5 Z"/></svg>`;
}

// Windy's embeddable map takes the marker and the forecast spot as parameters, which its main
// site does not: there, the forecast box shows the visitor's own location instead.
function windyLink([lat, lon]) {
  const [y, x] = [lat.toFixed(3), lon.toFixed(3)];
  return `https://embed.windy.com/embed2.html?${new URLSearchParams({
    lat: y, lon: x, detailLat: y, detailLon: x, zoom: '7',
    level: 'surface', overlay: 'wind', product: 'ecmwf', calendar: 'now',
    marker: 'true', detail: 'true', metricWind: 'kt', metricTemp: '°C',
    type: 'map', location: 'coordinates',
  })}`;
}

// The address Windy itself shows for a route in boat mode, not a documented API: if Windy changes
// it, the link opens an empty planner. The boat's speed and the distance unit are not part of it:
// Windy keeps them as settings in the viewer's browser.
function windyRouteLink(path) {
  return `https://www.windy.com/route-planner/boat/${path.map(([lat, lon]) => `${lat.toFixed(4)},${lon.toFixed(4)}`).join(';')}`;
}

// Map symbols, drawn in a 48 px box centred on their point. A dark halo under the coloured
// stroke keeps the pale band readable on the light map.
const WIND_SYMBOLS = {
  arrow: 'Flèches (longueur selon la force)',
  barb: 'Barbules (cartes météo marines)',
};
const ARROW_BASE = 8;
const ARROW_PER_KNOT = 1;
const ARROW_MAX = 44;
const BARB_STAFF = 22;

function haloed(path, color, fill = 'none') {
  const common = `d="${path}" stroke-linecap="round" stroke-linejoin="round"`;
  return `<path ${common} stroke="#1d2b3a" stroke-opacity="0.55" stroke-width="3.6" fill="${fill === 'none' ? 'none' : '#1d2b3a'}"/>` +
    `<path ${common} stroke="${color}" stroke-width="2" fill="${fill}"/>`;
}

// Points where the wind goes; its length grows with the speed.
function windVector(direction, speed) {
  const half = Math.min(ARROW_MAX, ARROW_BASE + speed * ARROW_PER_KNOT) / 2;
  const path = `M0,${half} L0,${-half} M-3.5,${5 - half} L0,${-half} L3.5,${5 - half}`;
  return `<svg viewBox="-24 -24 48 48" style="transform: rotate(${direction + 180}deg)" aria-hidden="true">` +
    `${haloed(path, SPEED_BANDS[bandOf(speed)].color)}</svg>`;
}

// The staff points where the wind comes from. From its end inwards: a pennant per 50 kn, a full
// barb per 10 kn, a half barb for 5 kn, on the clockwise side as drawn in the northern hemisphere.
// Below 2.5 kn, calm: a circle.
function windBarb(direction, speed) {
  const color = SPEED_BANDS[bandOf(speed)].color;
  let units = Math.round(speed / 5);
  if (!units) return `<svg viewBox="-24 -24 48 48" aria-hidden="true">${haloed('M-4,0 A4,4 0 1,0 4,0 A4,4 0 1,0 -4,0', color)}</svg>`;
  const pennants = Math.floor(units / 10);
  units %= 10;
  const full = Math.floor(units / 2);
  const half = units % 2;
  let y = -BARB_STAFF;
  let flags = '';
  for (let i = 0; i < pennants; i++, y += 7) flags += `M0,${y} L9,${y - 3} L0,${y + 6} Z `;
  if (pennants) y += 1;
  let barbs = `M0,0 L0,${-BARB_STAFF} `;
  for (let i = 0; i < full; i++, y += 4) barbs += `M0,${y} L9,${y - 4} `;
  // A lone half barb sits a little in from the end, so that it is not read as a full one.
  if (half) barbs += `M0,${y + (pennants || full ? 0 : 4)} L5,${y + (pennants || full ? 0 : 4) - 2}`;
  return `<svg viewBox="-24 -24 48 48" style="transform: rotate(${direction}deg)" aria-hidden="true">` +
    `${haloed(barbs, color)}${flags ? haloed(flags, color, color) : ''}</svg>`;
}

function describeWind({ wind_speed_10m: speed, wind_direction_10m: direction, wind_gusts_10m: gusts }) {
  return `${windArrow(direction)} de ${SECTORS[sectorOf(direction)]}, ${Math.round(speed)} nd` +
    (gusts == null ? '' : ` <span class="gusts">(rafales ${Math.round(gusts)})</span>`);
}
