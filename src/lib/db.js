import { openDB } from 'idb';
import { articleId } from '../../lib/articleId.js';

const DB_NAME = 'masthead';
const DB_VERSION = 2;

let dbPromise;

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      async upgrade(db, oldVersion, newVersion, tx) {
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

        // v2: one-time re-key of device-local records to the shared articleId
        // (2B spec D4) — without this, pre-2B favourites orphan when list ids
        // change scheme. Records whose url yields no id keep their old key.
        // Only IDB requests on the open versionchange tx may be awaited here.
        if (oldVersion >= 1 && oldVersion < 2) {
          for (const name of ['articles', 'history']) {
            const store = tx.objectStore(name);
            const records = await store.getAll();
            for (const record of records) {
              const newId = articleId(record.url);
              if (!newId || newId === record.id) continue;
              await store.delete(record.id);
              await store.put({ ...record, id: newId });
            }
          }
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

export async function patchSavedArticle(id, patch) {
  const db = await getDB();
  const existing = await db.get('articles', id);
  if (!existing) return null;
  const updated = { ...existing, ...patch, updatedAtLocal: new Date().toISOString() };
  await db.put('articles', updated);
  return updated;
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

export async function putHistoryEntry(entry) {
  const db = await getDB();
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

// === Clear all local data (sign-out) ===

export async function clearAllLocalData() {
  const db = await getDB();
  await Promise.all([db.clear('articles'), db.clear('history'), db.clear('pending')]);
}

// === Storage info ===

export async function getStorageEstimate() {
  if (navigator.storage && navigator.storage.estimate) {
    const { usage, quota } = await navigator.storage.estimate();
    return { usage, quota };
  }
  return null;
}
