// The wind along a route over a leg's dates in past years, from the viewer's browser: what
// tools/wind_stats.py computes for the auto routes, here for a manual one. The settings (years,
// margin, spacing, thresholds) are those of the routes file, so that the two compare.
// Each point's hours are kept in the browser (store.js, `hours|…`), two bytes an hour.

// Open-Meteo refuses a browser more than a few requests at once (« Too many concurrent requests »).
const ROUTE_WIND_WORKERS = 3;
const ROUTE_WIND_RETRIES = 5;
// The page's rose bands (weather.js, SPEED_BANDS), so that the rose around the boat reads like the others.
const ROUTE_WIND_BANDS_KN = [11, 17, 28];
const EARTH_RADIUS_NM = 3440.065;

const toRadians = degrees => degrees * Math.PI / 180;

function greatCircleNm([lat1, lon1], [lat2, lon2]) {
  const h = Math.sin(toRadians(lat2 - lat1) / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(toRadians(lon2 - lon1) / 2) ** 2;
  return 2 * EARTH_RADIUS_NM * Math.asin(Math.sqrt(h));
}

function initialBearing([lat1, lon1], [lat2, lon2]) {
  const y = Math.sin(toRadians(lon2 - lon1)) * Math.cos(toRadians(lat2));
  const x = Math.cos(toRadians(lat1)) * Math.sin(toRadians(lat2)) -
    Math.sin(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.cos(toRadians(lon2 - lon1));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

// The middle of every spacing of route, with the course there, the miles it stands for and its
// distance from the start, rounded to 0.1° like the archives' grid unless told otherwise.
function routeSamples(path, spacingNm, decimals = 1) {
  const stretches = path.slice(1).map((to, i) => ({ from: path[i], to, length: greatCircleNm(path[i], to) }));
  const total = stretches.reduce((sum, { length }) => sum + length, 0);
  const count = Math.max(1, Math.round(total / spacingNm));
  const step = total / count;
  return Array.from({ length: count }, (_, i) => {
    let target = (i + 0.5) * step;
    let k = 0;
    while (k < stretches.length - 1 && target > stretches[k].length) target -= stretches[k++].length;
    const stretch = stretches[k];
    const t = stretch.length ? Math.min(target / stretch.length, 1) : 0;
    const scale = 10 ** decimals;
    const at = [0, 1].map(k => Math.round((stretch.from[k] + (stretch.to[k] - stretch.from[k]) * t) * scale) / scale);
    return { at, course: initialBearing(stretch.from, stretch.to), weight: step, along: (i + 0.5) * step };
  });
}

function shiftedDate(isoDate, year, days) {
  const date = new Date(`${year}${isoDate.slice(4)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// Speed in quarter knots and direction in half degrees, one byte each; 255 marks a missing hour.
function packHours(speeds, directions) {
  const bytes = new Uint8Array(speeds.length * 2);
  speeds.forEach((speed, i) => {
    const direction = directions[i];
    const missing = speed == null || direction == null;
    bytes[2 * i] = missing ? 255 : Math.min(254, Math.round(speed * 4));
    bytes[2 * i + 1] = missing ? 255 : Math.round(direction / 2) % 180;
  });
  return btoa(String.fromCharCode(...bytes));
}

function unpackHours(text) {
  const bytes = Uint8Array.from(atob(text), char => char.charCodeAt(0));
  const hours = [];
  for (let i = 0; i < bytes.length; i += 2) {
    if (bytes[i] !== 255) hours.push([bytes[i] / 4, bytes[i + 1] * 2]);
  }
  return hours;
}

async function windowHours(at, start, end, pacing) {
  const key = `hours|${at[0].toFixed(1)},${at[1].toFixed(1)}|${start}|${end}`;
  const kept = await storeGet(key);
  if (typeof kept === 'string') return unpackHours(kept);
  const days = (Date.parse(end) - Date.parse(start)) / 86_400_000 + 1;
  const params = new URLSearchParams({
    latitude: at[0].toFixed(1),
    longitude: at[1].toFixed(1),
    start_date: start,
    end_date: end,
    hourly: 'wind_speed_10m,wind_direction_10m',
    wind_speed_unit: 'kn',
    timezone: 'UTC',
  });
  let hourly;
  for (let attempt = 1; !hourly; attempt++) {
    try {
      ({ hourly } = await fetchJson(`${ARCHIVE_URL}?${params}`, Math.ceil(days / 14), pacing));
    } catch (error) {
      // Too many requests at once is a moment's crowding, not the quota: wait and ask again.
      if (!(error.status === 429 && /concurrent/i.test(error.reason)) || attempt === ROUTE_WIND_RETRIES) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    }
  }
  const packed = packHours(hourly.wind_speed_10m, hourly.wind_direction_10m);
  await storeSet(key, packed);
  return unpackHours(packed);
}

// onProgress(done, total, pause) follows the requests; pacing.cancelled stops them.
async function routeWindStats(path, leg, settings, { onProgress, cancelled } = {}) {
  const { years: [first, last], marginDays, spacingNm, thresholds: t } = settings;
  const points = routeSamples(path, spacingNm);
  const years = Array.from({ length: last - first + 1 }, (_, i) => first + i);
  const jobs = years.flatMap(year => points.map(point => ({
    year,
    point,
    start: shiftedDate(leg['Départ prévu'], year, -marginDays),
    end: shiftedDate(leg['Arrivée prévue'], year, marginDays),
  })));
  let done = 0;
  const pacing = { cancelled, onWait: pause => onProgress?.(done, jobs.length, pause) };
  onProgress?.(0, jobs.length);
  const results = new Array(jobs.length);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const index = next++;
      const { point, start, end } = jobs[index];
      results[index] = await windowHours(point.at, start, end, pacing);
      onProgress?.(++done, jobs.length);
    }
  };
  await Promise.all(Array.from({ length: ROUTE_WIND_WORKERS }, worker));

  const empty = () => ({ light: 0, close: 0, reach: 0, run: 0, strong: 0, gale: 0, all: 0 });
  const totals = empty();
  const byYear = Object.fromEntries(years.map(year => [year, empty()]));
  const aroundBoat = Array.from({ length: 16 }, () => ROUTE_WIND_BANDS_KN.map(() => 0).concat(0));
  // The share of the time the wind blows from each degree off the bow, with enough wind to sail.
  const offBow = new Array(90).fill(0);
  jobs.forEach(({ year, point }, index) => {
    const hours = results[index];
    const share = point.weight / hours.length;
    for (const [speed, direction] of hours) {
      const angle = Math.abs((direction - point.course + 540) % 360 - 180);
      const kind = speed < t.lightKn ? 'light' : angle < t.closeHauledDeg ? 'close' : angle < t.runningDeg ? 'reach' : 'run';
      for (const counts of [totals, byYear[year]]) {
        counts[kind] += share;
        counts.all += share;
        if (speed >= t.strongKn) counts.strong += share;
        if (speed >= t.galeKn) counts.gale += share;
      }
      const sector = Math.round((((direction - point.course) % 360 + 360) % 360) / 22.5) % 16;
      aroundBoat[sector][ROUTE_WIND_BANDS_KN.filter(limit => speed >= limit).length] += share;
      if (speed >= t.lightKn && angle < 90) offBow[Math.floor(angle)] += share;
    }
  });
  const shares = counts => Object.fromEntries(['light', 'close', 'reach', 'run', 'strong', 'gale']
    .map(key => [key, counts[key] / counts.all]));
  return {
    points: points.map(({ at, course }) => [...at, Math.round(course)]),
    shares: shares(totals),
    aroundBoat: aroundBoat.map(sector => sector.map(value => value / totals.all)),
    offBow: offBow.map(value => value / totals.all),
    byYear: Object.fromEntries(years.map(year => [year, shares(byYear[year])])),
  };
}
