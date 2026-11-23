// Spring and neap tides from the Moon alone: no tide data, only where the Moon stands from the Sun.
// The longitudes are the low-precision series of Meeus (Astronomical Algorithms, ch. 47, main terms):
// enough to place a new or full moon within the hour, far more than a day's planning needs.
const MOON_DAY_MS = 86_400_000;
const J2000_MS = Date.UTC(2000, 0, 1, 12);
// In European Atlantic waters the strongest tides follow new and full moon by about a day and a
// half (the age of the tide); it varies from place to place, which the page says.
const TIDE_AGE_DAYS = 1.5;
// Strength 1 at springs, 0 at neaps: within about two days of either, the tide is called so.
const SPRINGS_FROM = 0.9;
const NEAPS_UNDER = 0.4;

const moonRadians = degrees => degrees * Math.PI / 180;

// Degrees from the Sun to the Moon along the ecliptic, 0 at new moon, 180 at full moon.
function moonElongation(time) {
  const d = (time - J2000_MS) / MOON_DAY_MS;
  const sin = degrees => Math.sin(moonRadians(degrees));
  const D = 297.850 + 12.190749 * d;
  const Mm = 134.963 + 13.064993 * d;
  const F = 93.272 + 13.229350 * d;
  const M = 357.529 + 0.98560028 * d;
  const moon = 218.316 + 13.176396 * d + 6.289 * sin(Mm) + 1.274 * sin(2 * D - Mm) + 0.658 * sin(2 * D) +
    0.214 * sin(2 * Mm) - 0.186 * sin(M) - 0.114 * sin(2 * F);
  const sun = 280.460 + 0.98564736 * d + 1.915 * sin(M) + 0.020 * sin(2 * M);
  return ((moon - sun) % 360 + 360) % 360;
}

const tideStrength = time => Math.abs(Math.cos(moonRadians(moonElongation(time - TIDE_AGE_DAYS * MOON_DAY_MS))));

function tideKind(strength) {
  return strength >= SPRINGS_FROM ? 'springs' : strength < NEAPS_UNDER ? 'neaps' : 'between';
}

// New moon, first quarter, full moon and last quarter between two times, each within the hour.
function moonPhases(from, to) {
  const phases = [];
  const quarter = time => Math.floor(moonElongation(time) / 90);
  for (let time = from; time < to; time += 3_600_000) {
    const [before, after] = [quarter(time), quarter(time + 3_600_000)];
    if (before !== after) phases.push({ time: time + 3_600_000, kind: ['new', 'first', 'full', 'last'][after] });
  }
  return phases;
}
