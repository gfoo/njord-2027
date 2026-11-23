// What the map keeps in the browser across visits: the routes file being worked on, and the hours of
// wind already asked from Open-Meteo, whose quota is counted per connection and per day. IndexedDB,
// since the hours outgrow the few megabytes of localStorage. A browser that refuses storage (a
// private window, say) keeps them for the visit only.
const STORE_DATABASE = 'njord';
const STORE_TABLE = 'kept';
const storeMemory = new Map();
let storeOpening;

function storeDatabase() {
  storeOpening ??= new Promise(resolve => {
    try {
      const request = indexedDB.open(STORE_DATABASE, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE_TABLE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return storeOpening;
}

async function storeRequest(mode, act) {
  const database = await storeDatabase();
  if (!database) return undefined;
  return new Promise(resolve => {
    try {
      const request = act(database.transaction(STORE_TABLE, mode).objectStore(STORE_TABLE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

async function storeGet(key) {
  if (storeMemory.has(key)) return storeMemory.get(key);
  return (await storeRequest('readonly', table => table.get(key))) ?? null;
}

async function storeSet(key, value) {
  storeMemory.set(key, value);
  await storeRequest('readwrite', table => table.put(value, key));
}

async function storeDelete(key) {
  storeMemory.delete(key);
  await storeRequest('readwrite', table => table.delete(key));
}

// Earlier versions of the page kept the hours, and each leg's manual passages, in localStorage
// under `njord.`: the hours move here, the passages are handed to the page, the rest goes.
const legacyPassages = (async () => {
  const passages = {};
  let keys = [];
  try {
    keys = Object.keys(localStorage).filter(key => key.startsWith('njord.'));
  } catch {
    // Storage refused: nothing was kept.
  }
  for (const key of keys) {
    const name = key.slice('njord.'.length);
    try {
      const value = JSON.parse(localStorage.getItem(key));
      if (name.startsWith('hours|') && typeof value === 'string') await storeSet(name, value);
      if (name.startsWith('trial|') && Array.isArray(value)) passages[name.slice('trial|'.length)] = value;
    } catch {
      // An entry that no longer reads is dropped with the others.
    }
    localStorage.removeItem(key);
  }
  return passages;
})();
