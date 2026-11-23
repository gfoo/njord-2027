// The wind along a route in past years comes from Open-Meteo's archives: free, keyless, CC BY 4.0.
// Speeds in knots, directions in degrees the wind comes from. Also the drawing of a wind rose.
const ARCHIVE_URL = 'https://archive-api.open-meteo.com/v1/archive';
// ink: the text colour that stays readable on the band's colour.
const SPEED_BANDS = [
  { max: 11, force: 'F0–3', label: 'moins de 11 nd (force 0–3)', color: '#b8cde0', ink: '#1d2b3a' },
  { max: 17, force: 'F4', label: '11–16 nd (force 4)', color: '#4f9a58', ink: '#fff' },
  { max: 28, force: 'F5–6', label: '17–27 nd (force 5–6)', color: '#e09a2b', ink: '#1d2b3a' },
  { max: Infinity, force: 'F7+', label: '28 nd et plus (force 7+)', color: '#c0392b', ink: '#fff' },
];
// Where the colour bar ends; stronger winds fall in its last band.
const SCALE_MAX_KNOTS = 40;

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
  try {
    localStorage.setItem(STORE_PREFIX + key, JSON.stringify(value));
  } catch {
    // Storage full or refused: the result stays in memory for this visit only.
  }
}

// Forecasts and point roses kept by earlier versions of the page: their room goes to the routes' wind.
storeDrop(key => key.startsWith('wind|') || key.startsWith('rose|'));

const sectorShares = ({ counts, total }) => counts.map(sector => sector.reduce((a, b) => a + b, 0) / total);

const ROSE_CENTER = 120, ROSE_RADIUS = 92;

function rosePoint(r, angle) {
  const rad = angle * Math.PI / 180;
  return `${(ROSE_CENTER + r * Math.sin(rad)).toFixed(1)},${(ROSE_CENTER - r * Math.cos(rad)).toFixed(1)}`;
}

// The petals of a tally, stacked by force, on the scale of its largest sector unless roses drawn
// side by side share a scale.
function roseWedges(tally, peak = Math.max(...sectorShares(tally))) {
  const shares = tally.counts.map(sector => sector.map(n => n / tally.total));
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
  return { peak, wedges };
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

// The address Windy itself shows for a route in boat mode, not a documented API: if Windy changes
// it, the link opens an empty planner. The boat's speed and the distance unit are not part of it:
// Windy keeps them as settings in the viewer's browser.
function windyRouteLink(path) {
  return `https://www.windy.com/route-planner/boat/${path.map(([lat, lon]) => `${lat.toFixed(4)},${lon.toFixed(4)}`).join(';')}`;
}
