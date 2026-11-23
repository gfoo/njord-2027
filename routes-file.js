// The routes file, NJORD_2027_parcours_vXX.xlsx, as tools/routes_file.py writes it: read into what
// the map draws, and written again, as the next version, with the routes drawn in the browser.
// Its sheets, columns and texts are those of tools/routes_file.py: the two must agree.

const ROUTE_NAMES = { auto: 'auto', manual: 'manuel' };
const ROUTE_MODES = { sea: 'mer', straight: 'ligne droite' };
const ROUTES_FILE_NAME = /^NJORD_2027_parcours_v(\d{2})\.xlsx$/;
const WIND_SHARES = ['close', 'reach', 'run', 'light', 'strong', 'gale'];
const SETTING_ROWS = { speed: 'Vitesse moyenne (nd)', pointing: 'Angle de remontée au vent (°)' };

const routesFileName = version => `NJORD_2027_parcours_v${String(version).padStart(2, '0')}.xlsx`;
const formatPoints = points => points.map(([lat, lon]) => `${lat.toFixed(4)}, ${lon.toFixed(4)}`).join('; ');

// « lat, lon; lat, lon », as the map writes it; anything else is refused, naming the text.
function parsePoints(text) {
  return String(text ?? '').split(';').filter(part => part.trim()).map(part => {
    const match = part.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (!match) throw new Error(`« ${part.trim()} » n'est pas « latitude, longitude »`);
    const [lat, lon] = [Number(match[1]), Number(match[2])];
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new Error(`« ${part.trim()} » est hors du globe`);
    return [lat, lon];
  });
}

// What a route's wind was computed for: a change to any of it calls for computing it again.
function routeFingerprint(leg, mode, passages) {
  return `${leg['Départ prévu']} → ${leg['Arrivée prévue']} · ` +
    `${formatPoints([leg['Position embarquement']])} → ${formatPoints([leg['Position débarquement']])} · ` +
    `${mode} · passages : ${formatPoints(passages) || 'aucun'}`;
}

// Excel turns « 09 » typed in a new row into the number 9.
const legNumber = value => (typeof value === 'number' ? String(value).padStart(2, '0') : String(value ?? '').trim());

function isoDay(value) {
  if (typeof value === 'number') return isoFromExcel(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? '').trim())) return String(value).trim();
  throw new Error(`« ${value ?? ''} » n'est pas une date`);
}

function windStatsFrom(detail, shares) {
  const numbers = text => String(text ?? '').split(';').filter(part => part.trim()).map(Number);
  const rose = numbers(detail['Rose vue du bateau']);
  const bands = rose.length / 16;
  return {
    fingerprint: detail['Calculé pour'],
    points: String(detail['Points (lat, lon, cap)'] ?? '').split(';').filter(part => part.trim())
      .map(point => point.split(',').map(Number)),
    shares: Object.fromEntries(Object.entries({ close: 'Près', reach: 'Travers', run: 'Portant', light: 'Petit temps',
      strong: 'Force 6 et plus', gale: 'Force 7 et plus' }).map(([key, column]) => [key, Number(shares[column])])),
    aroundBoat: Array.from({ length: 16 }, (_, sector) => rose.slice(sector * bands, (sector + 1) * bands)),
    offBow: numbers(detail['Angle au vent']),
    // Rebuilt from years and numbers only: a file opened from anywhere reaches the page's HTML.
    byYear: Object.fromEntries(Object.entries(JSON.parse(detail['Par année']))
      .filter(([year]) => /^\d{4}$/.test(year))
      .map(([year, yearShares]) => [year, Object.fromEntries(WIND_SHARES.map(key => [key, Number(yearShares?.[key])]))])),
  };
}

// The file as the map draws it, or an Error naming what is unreadable. The workbook object is
// kept to write the next version from.
async function readRoutesFile(buffer) {
  const book = await openXlsx(buffer);
  const missing = ['Étapes', 'Parcours', 'Réglages'].filter(name => !book.sheets.has(name));
  if (missing.length) {
    throw new Error(`ce n'est pas un fichier de parcours NJORD (onglet${missing.length > 1 ? 's' : ''} absent${missing.length > 1 ? 's' : ''} : ${missing.join(', ')})`);
  }
  const records = name => sheetRecords(readSheet(book, name));
  const errors = [];

  const settings = Object.fromEntries(records('Réglages').map(({ values }) => [values['Réglage'], values['Valeur']]));
  const number = label => {
    const value = Number(settings[label]);
    if (settings[label] == null || !Number.isFinite(value)) errors.push(`Réglages, « ${label} » : « ${settings[label] ?? ''} » n'est pas un nombre`);
    return value;
  };
  const years = String(settings['Vent : années'] ?? '').split(/[–-]/).map(Number);
  if (years.length !== 2 || !years.every(Number.isInteger)) errors.push(`Réglages, « Vent : années » : « ${settings['Vent : années'] ?? ''} »`);

  const legs = records('Étapes').map(({ values }) => {
    const leg = { ...values, 'Étape': legNumber(values['Étape']) };
    for (const name of ['Départ prévu', 'Arrivée prévue']) {
      try {
        leg[name] = isoDay(values[name]);
      } catch (error) {
        errors.push(`Étapes, étape ${leg['Étape']}, ${name} : ${error.message}`);
      }
    }
    for (const name of ['Position embarquement', 'Position débarquement']) {
      try {
        [leg[name]] = parsePoints(values[name]);
        if (!leg[name]) throw new Error('vide');
      } catch (error) {
        errors.push(`Étapes, étape ${leg['Étape']}, ${name} : ${error.message}`);
      }
    }
    return leg;
  });
  const legByNumber = new Map(legs.map(leg => [leg['Étape'], leg]));

  const routes = [];
  for (const { values } of records('Parcours')) {
    const leg = legByNumber.get(legNumber(values['Étape']));
    const name = String(values['Parcours'] ?? '').trim();
    const mode = String(values['Mode'] ?? '').trim() || ROUTE_MODES.sea;
    const where = `Parcours, étape ${legNumber(values['Étape'])}, parcours ${name}`;
    if (!leg) continue;
    if (!Object.values(ROUTE_NAMES).includes(name)) {
      errors.push(`${where} : attendu « ${ROUTE_NAMES.auto} » ou « ${ROUTE_NAMES.manual} »`);
      continue;
    }
    if (!Object.values(ROUTE_MODES).includes(mode)) {
      errors.push(`${where} : mode « ${mode} », attendu « ${ROUTE_MODES.sea} » ou « ${ROUTE_MODES.straight} »`);
      continue;
    }
    try {
      const passages = name === ROUTE_NAMES.manual ? parsePoints(values['Passages']) : [];
      const drawn = parsePoints(values['Tracé']);
      routes.push({ leg, name, mode, passages, path: drawn.length ? drawn : null, nm: Number(values['Distance (NM)']) || null, stats: null });
    } catch (error) {
      errors.push(`${where} : ${error.message}`);
    }
  }
  if (errors.length) throw new Error(errors.join(' ; '));

  // A wind computed for other dates, ends or passages than the route's own is left out: it would
  // mislead. Its rows are kept, so that a version written again carries them unchanged.
  const shares = new Map(records('Vent').map(({ values, cells }) => [`${legNumber(values['Étape'])}|${values['Parcours']}`, { values, cells }]));
  for (const { values, cells } of records('Vent détail')) {
    const key = `${legNumber(values['Étape'])}|${values['Parcours']}`;
    const route = routes.find(one => `${one.leg['Étape']}|${one.name}` === key);
    if (!route || !shares.has(key) || values['Calculé pour'] !== routeFingerprint(route.leg, route.mode, route.passages)) continue;
    route.stats = { ...windStatsFrom(values, shares.get(key).values), rows: { wind: shares.get(key).cells, detail: cells } };
  }

  const name = String(settings['Fichier'] ?? '');
  return {
    book,
    name,
    version: Number(name.match(ROUTES_FILE_NAME)?.[1] ?? 0),
    title: settings['Titre'] ?? 'NJORD',
    workbook: settings['Tableur source'] ?? '',
    legs,
    routes,
    speed: Number(settings[SETTING_ROWS.speed]) || 5,
    pointing: Number(settings[SETTING_ROWS.pointing]) || 45,
    wind: {
      source: settings['Vent : source'],
      years,
      marginDays: number('Vent : marge (jours)'),
      spacingNm: number('Vent : espacement des points (NM)'),
      thresholds: {
        lightKn: number('Petit temps sous (nd)'),
        closeHauledDeg: number('Près sous (°)'),
        runningDeg: number('Portant au-delà de (°)'),
        strongKn: number('Force 6 dès (nd)'),
        galeKn: number('Force 7 dès (nd)'),
      },
    },
    coast: { coastline: settings['Côtes'], coastDistanceNm: number('Distance à la côte (NM)') },
    mask: {
      file: settings['Masque des côtes : fichier'],
      north: number('Masque des côtes : nord (°)'),
      west: number('Masque des côtes : ouest (°)'),
      dlat: number('Masque des côtes : pas en latitude (°)'),
      dlon: number('Masque des côtes : pas en longitude (°)'),
    },
  };
}

// The rows of a sheet's first data row give each column its style: font, yellow fill, number format.
function columnStyles(rows) {
  return (rows[1] ?? rows[0] ?? []).map(cell => cell?.style ?? null);
}

function windRows(file, route, styles) {
  const { stats, leg } = route;
  const [first, last] = file.wind.years;
  const day = (iso, shift) => {
    const date = new Date(`${iso}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + shift);
    return excelDate(date.toISOString().slice(0, 10));
  };
  const years = Object.entries(stats.byYear).sort(([, a], [, b]) => a.close - b.close);
  const yearText = ([year, shares]) => `${Math.round(shares.close * 100)}% (${year})`;
  const cells = (values, rowStyles) => values.map((value, i) => ({ value, style: rowStyles[i] ?? null }));
  const precise = value => String(Number(value.toPrecision(6)));
  return {
    wind: cells([leg['Étape'], route.name, day(leg['Départ prévu'], -file.wind.marginDays),
      day(leg['Arrivée prévue'], file.wind.marginDays), `${first}–${last}`, stats.points.length,
      ...WIND_SHARES.map(key => stats.shares[key]), yearText(years[0]), yearText(years.at(-1))], styles.wind),
    detail: cells([leg['Étape'], route.name, routeFingerprint(leg, route.mode, route.passages),
      stats.points.map(point => point.join(', ')).join('; '),
      stats.aroundBoat.flat().map(precise).join(';'),
      stats.offBow.map(precise).join(';'),
      JSON.stringify(stats.byYear)], styles.detail),
  };
}

// The next version: the file as it was, its routes, their wind and the settings replaced. routes:
// { leg, name, mode, passages, path, nm, stats } in the legs' order, auto before manual.
async function writeRoutesFile(file, { routes, speed, pointing }) {
  // A copy of the parts: the file stays as it was read if anything below fails.
  const book = { ...file.book, files: new Map(file.book.files) };
  const name = routesFileName(file.version + 1);
  const parcours = readSheet(book, 'Parcours');
  const wind = readSheet(book, 'Vent');
  const detail = readSheet(book, 'Vent détail');
  const styles = { routes: columnStyles(parcours), wind: columnStyles(wind), detail: columnStyles(detail) };
  // Mode and passages of a manual route are typed by hand: yellow, like the mode of every route.
  const typed = styles.routes[2];
  writeSheet(book, 'Parcours', [parcours[0], ...routes.map(route =>
    [route.leg['Étape'], route.name, route.mode, formatPoints(route.passages), formatPoints(route.path), Math.round(route.nm)]
      .map((value, i) => ({ value, style: i === 3 && route.name === ROUTE_NAMES.manual ? typed : styles.routes[i] })))]);
  const sailed = routes.filter(route => route.stats).map(route => route.stats.rows ?? windRows(file, route, styles));
  writeSheet(book, 'Vent', [wind[0], ...sailed.map(rows => rows.wind)]);
  writeSheet(book, 'Vent détail', [detail[0], ...sailed.map(rows => rows.detail)]);
  const now = new Date();
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ` +
    `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const changes = { Fichier: name, 'Généré le': stamp, [SETTING_ROWS.speed]: speed, [SETTING_ROWS.pointing]: pointing };
  writeSheet(book, 'Réglages', readSheet(book, 'Réglages').map(row =>
    (row[0]?.value in changes ? [row[0], { ...row[1], value: changes[row[0].value] }, ...row.slice(2)] : row)));
  return { name, bytes: await saveXlsx(book) };
}
