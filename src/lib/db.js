import { openDB } from 'idb';

const DB_NAME = 'masthead';
const DB_VERSION = 1;

let dbPromise;

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        // Saved articles (favorites)
        if (!db.objectStoreNames.contains('articles')) {
          const articleStore = db.createObjectStore('articles', { keyPath: 'id' });
          articleStore.createIndex('savedAt', 'savedAt');
          articleStore.createIndex('isFavorite', 'isFavorite');
          articleStore.createIndex('sourceId', 'sourceId');
        }

        // Reading history
        if (!db.objectStoreNames.contains('history')) {
          const historyStore = db.createObjectStore('history', { keyPath: 'id' });
          historyStore.createIndex('readAt', 'readAt');
        }

        // Pending URLs from Siri Shortcut
        if (!db.objectStoreNames.contains('pending')) {
          db.createObjectStore('pending', { keyPath: 'url' });
        }
      },
    });
  }
  return dbPromise;
}

// === Favorites ===

export async function saveFavorite(article) {
  const db = await getDB();
  const saved = {
    ...article,
    savedAt: new Date().toISOString(),
    isFavorite: true,
    isRead: true,
  };
  await db.put('articles', saved);
  return saved;
}

export async function removeFavorite(id) {
  const db = await getDB();
  await db.delete('articles', id);
}

export async function getFavorite(id) {
  const db = await getDB();
  return db.get('articles', id);
}

export async function getAllFavorites() {
  const db = await getDB();
  const all = await db.getAll('articles');
  // Sort by savedAt descending
  return all
    .filter((a) => a.isFavorite)
    .sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));
}

export async function isFavorited(id) {
  const db = await getDB();
  const article = await db.get('articles', id);
  return !!article?.isFavorite;
}

// === History ===

export async function addToHistory(headline) {
  const db = await getDB();
  const entry = {
    id: headline.id,
    title: headline.title,
    url: headline.url,
    sourceId: headline.sourceId,
    sourceName: headline.sourceName,
    sourceShortName: headline.sourceShortName,
    sourceColor: headline.sourceColor,
    category: headline.category,
    thumbnail: headline.thumbnail,
    isPaywall: headline.isPaywall,
    readAt: new Date().toISOString(),
  };
  await db.put('history', entry);
  return entry;
}

export async function getAllHistory() {
  const db = await getDB();
  const all = await db.getAll('history');
  return all.sort((a, b) => new Date(b.readAt) - new Date(a.readAt));
}

export async function clearHistory() {
  const db = await getDB();
  await db.clear('history');
}

// === Pending URLs ===

export async function addPendingUrl(url) {
  const db = await getDB();
  await db.put('pending', { url, addedAt: new Date().toISOString() });
}

export async function getPendingUrls() {
  const db = await getDB();
  return db.getAll('pending');
}

export async function removePendingUrl(url) {
  const db = await getDB();
  await db.delete('pending', url);
}

// === Storage info ===

export async function getStorageEstimate() {
  if (navigator.storage && navigator.storage.estimate) {
    const { usage, quota } = await navigator.storage.estimate();
    return { usage, quota };
  }
  return null;
}
