// Where the current runs strong along a route, from the viewer's browser: Open-Meteo's marine
// archive (Météo-France's SMOC model for Copernicus Marine, cells of 0.08°, about 8 km, hourly,
// tide included), over the leg's dates in one past year. A zone says that the passage must be timed
// with the tide tables, not when: the model misses races and headlands narrower than its cells, so
// a stretch without a zone is not a stretch without current.

const MARINE_URL = 'https://marine-api.open-meteo.com/v1/marine';
// One year is enough: the tides repeat, and a week on each side of the leg holds a spring tide.
const CURRENTS_YEAR = 2025;
const CURRENTS_MARGIN_DAYS = 7;
const CURRENTS_SPACING_NM = 5;
// Strong: the current exceeds it in at least 2 % of the hours, the peaks of the spring tides. At
// 2 kn nearly the whole Channel and the southern North Sea came out strong (test of 26.11.2026); at
// 2.5 kn the strait of Gibraltar, Portland to the Isle of Wight, Beachy Head and the Dover strait
// stand out, and the Alboran Sea's 2.2 kn does not.
const STRONG_CURRENT_KN = 2.5;
const STRONG_SHARE = 0.02;
// The hours whose direction counts: the strongest tenth, those that make a passage hard.
const STRONG_HOURS_SHARE = 0.1;
// A current that runs the other way in at least this share of the strong hours alternates with the tide.
const ALTERNATING_SHARE = 0.25;
const CURRENTS_BATCH = 10;
const CURRENTS_WORKERS = 2;
const KMH_PER_KN = 1.852;
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSO', 'SO', 'OSO', 'O', 'ONO', 'NO', 'NNO'];

const compassName = degrees => COMPASS[Math.round(degrees / 22.5) % 16];

// The hours of several points, those the browser keeps first, the others asked a batch at a time.
async function currentHours(points, start, end, pacing, onDone) {
  const keyOf = at => `currents|${at[0].toFixed(3)},${at[1].toFixed(3)}|${start}|${end}`;
  const hours = await Promise.all(points.map(async at => {
    const kept = await storeGet(keyOf(at));
    return typeof kept === 'string' ? unpackHours(kept) : null;
  }));
  const missing = points.map((_, i) => i).filter(i => !hours[i]);
  points.forEach((_, i) => hours[i] && onDone());
  const batches = [];
  for (let i = 0; i < missing.length; i += CURRENTS_BATCH) batches.push(missing.slice(i, i + CURRENTS_BATCH));
  const days = (Date.parse(end) - Date.parse(start)) / 86_400_000 + 1;
  let next = 0;
  // Once a batch has failed the route has no zones: the other worker asks for no more.
  let failed = false;
  const worker = async () => {
    while (next < batches.length && !failed) {
      const batch = batches[next++];
      const params = new URLSearchParams({
        latitude: batch.map(i => points[i][0]).join(','),
        longitude: batch.map(i => points[i][1]).join(','),
        hourly: 'ocean_current_velocity,ocean_current_direction',
        start_date: start,
        end_date: end,
        timezone: 'UTC',
      });
      let answer;
      for (let attempt = 1; !answer; attempt++) {
        try {
          answer = await fetchJson(`${MARINE_URL}?${params}`, batch.length * Math.ceil(days / 14), pacing);
        } catch (error) {
          // Too many requests at once is a moment's crowding, not the quota: wait and ask again.
          if (!(error.status === 429 && /concurrent/i.test(error.reason)) || attempt === ROUTE_WIND_RETRIES) {
            failed = true;
            throw error;
          }
          await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        }
      }
      // One point comes back as an object, several as a list.
      const located = Array.isArray(answer) ? answer : [answer];
      await Promise.all(batch.map(async (i, k) => {
        const { ocean_current_velocity: speeds, ocean_current_direction: directions } = located[k].hourly;
        const packed = packHours(speeds.map(speed => (speed == null ? null : speed / KMH_PER_KN)), directions);
        await storeSet(keyOf(points[i]), packed);
        hours[i] = unpackHours(packed);
        onDone();
      }));
    }
  };
  await Promise.all(Array.from({ length: CURRENTS_WORKERS }, worker));
  return hours;
}

function pointCurrent(hours) {
  const speeds = hours.map(([speed]) => speed).sort((a, b) => a - b);
  const strongHour = speeds[Math.floor(speeds.length * (1 - STRONG_HOURS_SHARE))];
  const sectors = new Array(16).fill(0);
  for (const [speed, direction] of hours) {
    if (speed >= strongHour) sectors[Math.round(direction / 22.5) % 16]++;
  }
  return { peakKn: speeds[Math.floor(speeds.length * (1 - STRONG_SHARE))], maxKn: speeds.at(-1), sectors };
}

// The strong hours within 45° of a direction, as a share of all of them.
function sectorsAround(sectors, centre) {
  const total = sectors.reduce((a, b) => a + b, 0);
  return [-2, -1, 0, 1, 2].reduce((sum, k) => sum + sectors[(centre + k + 16) % 16], 0) / (total || 1);
}

// How the current runs against the boat's course: with it, against it, or across.
function currentRelation(direction, course) {
  const off = Math.abs((direction - course + 540) % 360 - 180);
  return off < 60 ? 'avec' : off > 120 ? 'contre' : 'travers';
}

// Runs of strong points, one weak point between two strong ones bridged: a zone each.
function currentZones(samples, stats) {
  const runs = [];
  let gap = Infinity;
  stats.forEach((stat, i) => {
    if (stat && stat.peakKn >= STRONG_CURRENT_KN) {
      if (gap <= 1) runs.at(-1).to = i;
      else runs.push({ from: i, to: i });
      gap = 0;
    } else {
      gap++;
    }
  });
  return runs.map(({ from, to }) => {
    const inside = stats.slice(from, to + 1).map((stat, k) => ({ stat, sample: samples[from + k] })).filter(({ stat }) => stat);
    const peak = inside.reduce((best, one) => (one.stat.peakKn > best.stat.peakKn ? one : best));
    const sectors = new Array(16).fill(0);
    inside.forEach(({ stat }) => stat.sectors.forEach((count, k) => { sectors[k] += count; }));
    const main = sectors.indexOf(Math.max(...sectors));
    const opposite = [6, 7, 8, 9, 10].map(k => (main + k) % 16).reduce((best, k) => (sectors[k] > sectors[best] ? k : best), (main + 8) % 16);
    const alternating = sectorsAround(sectors, (main + 8) % 16) >= ALTERNATING_SHARE;
    const directions = (alternating ? [main, opposite] : [main]).map(sector => ({
      degrees: sector * 22.5,
      share: sectorsAround(sectors, sector),
      relation: currentRelation(sector * 22.5, peak.sample.course),
    }));
    const halfStep = samples[0].weight / 2;
    return {
      fromNm: Math.max(0, samples[from].along - halfStep),
      toNm: samples[to].along + halfStep,
      at: peak.sample.at,
      maxKn: Math.max(...inside.map(({ stat }) => stat.maxKn)),
      alternating,
      directions,
    };
  });
}

// onProgress(done, total, pause) follows the points; cancelled() stops the requests.
async function routeCurrents(path, leg, { onProgress, cancelled } = {}) {
  const samples = routeSamples(path, CURRENTS_SPACING_NM, 3);
  const start = shiftedDate(leg['Départ prévu'], CURRENTS_YEAR, -CURRENTS_MARGIN_DAYS);
  const end = shiftedDate(leg['Arrivée prévue'], CURRENTS_YEAR, CURRENTS_MARGIN_DAYS);
  let done = 0;
  const pacing = { cancelled, onWait: pause => onProgress?.(done, samples.length, pause) };
  onProgress?.(0, samples.length);
  const hours = await currentHours(samples.map(({ at }) => at), start, end, pacing, () => onProgress?.(++done, samples.length));
  const stats = hours.map(list => (list.length ? pointCurrent(list) : null));
  return { start, end, zones: currentZones(samples, stats), points: stats.filter(Boolean).length };
}
