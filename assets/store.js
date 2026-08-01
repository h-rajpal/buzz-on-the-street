/* ═══════════════════════════════════════════════════════════════════════
   Local draft store — shared by the submit app and the site.

   Every submission lands here first, as real Blobs in IndexedDB (not base64
   in localStorage, which caps out around 5MB — about fifteen photos).

   The site reads this store and merges drafts in with data/photos.json, so a
   photo appears on the map the moment you submit it, long before any of it
   touches GitHub. Publishing later just drains the queue.
   ═══════════════════════════════════════════════════════════════════ */

const DB_NAME = 'buzz-on-the-street';
const DB_VERSION = 1;
const STORE = 'queue';

let _db;

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function tx(mode, fn) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let out;
    Promise.resolve(fn(store)).then(v => { out = v; });
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

const req2promise = r => new Promise((res, rej) => {
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});

/** Draft = { id, meta, full: Blob, thumb: Blob } */
export const putDraft = draft => tx('readwrite', s => req2promise(s.put(draft)));

export const allDrafts = () => tx('readonly', s => req2promise(s.getAll()))
  .then(rows => (rows || []).sort(
    (a, b) => new Date(b.meta.spottedAt) - new Date(a.meta.spottedAt)));

export const deleteDraft = id => tx('readwrite', s => req2promise(s.delete(id)));

export const countDrafts = () => tx('readonly', s => req2promise(s.count()));

/**
 * Drafts as photo records the site can render, with blob: URLs standing in
 * for the file paths. `draft: true` marks them as not-yet-published.
 */
export async function draftsAsPhotos() {
  if (!('indexedDB' in window)) return [];
  try {
    const rows = await allDrafts();
    return rows.map(d => ({
      ...d.meta,
      file: URL.createObjectURL(d.full),
      thumb: URL.createObjectURL(d.thumb),
      draft: true,
    }));
  } catch {
    return [];        // never let a storage problem break the page
  }
}
