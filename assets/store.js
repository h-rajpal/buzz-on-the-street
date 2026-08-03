/* ═══════════════════════════════════════════════════════════════════════
   Local draft store — shared by the submit app and the site.

   Every submission lands here first, so a photo appears on the map the moment
   you submit it, long before any of it touches GitHub. Publishing drains the
   queue.

   Two hard-won details:

   1. Images are stored as ArrayBuffers, NOT Blobs. WebKit on iOS has
      long-standing bugs writing Blobs into IndexedDB — the transaction fails
      where the identical code works in macOS Safari. ArrayBuffer support is
      universal and much better tested, so Blobs are unwrapped on write and
      rebuilt on read. Callers still hand over and receive Blobs.

   2. Nothing here ever rejects with a bare `request.error` or
      `transaction.error`. Both are legitimately null in some failure modes,
      and rejecting with null makes any `catch (e) { e.name }` throw a second
      error that buries the first.
   ═══════════════════════════════════════════════════════════════════ */

const DB_NAME = 'buzz-on-the-street';
const DB_VERSION = 1;
const STORE = 'queue';

let _db;

/**
 * Always an Error, never null, always says which step failed.
 *
 * Builds a fresh Error rather than annotating the caught one: DOMException is
 * an instance of Error but its `message` is getter-only, so assigning to it
 * throws — which would bury the original failure behind a TypeError, the exact
 * bug this function exists to prevent.
 */
const idbError = (where, native) => {
  const detail = (native && (native.message || native.name)) ||
                 'no error detail from the browser';
  const e = new Error(`${where}: ${detail}`);
  e.name = (native && native.name) || 'IndexedDBError';
  if (native) e.cause = native;
  return e;
};

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(DB_NAME, DB_VERSION); }
    catch (e) { return reject(idbError('could not open the database', e)); }

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(idbError('could not open the database', req.error));
    req.onblocked = () => reject(idbError('database blocked', null));
  });
}

function tx(mode, fn) {
  return openDB().then(db => new Promise((resolve, reject) => {
    let t;
    try { t = db.transaction(STORE, mode); }
    catch (e) { return reject(idbError('could not start a transaction', e)); }

    const store = t.objectStore(STORE);
    let out;
    let inner = null;
    try {
      Promise.resolve(fn(store)).then(v => { out = v; }, e => { inner = e; });
    } catch (e) { inner = e; }

    t.oncomplete = () => inner ? reject(inner) : resolve(out);
    t.onerror = () => reject(inner || idbError('write failed', t.error));
    t.onabort = () => reject(inner || idbError('write was aborted', t.error));
  }));
}

const wrap = (where, r) => new Promise((res, rej) => {
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(idbError(where, r.error));
});

// ────────────────────────────────────────────────── blob <-> arraybuffer

const toStored = async blob => ({
  buf: await blob.arrayBuffer(),
  type: blob.type || 'image/jpeg',
  size: blob.size,
});

/** Rows written before this change hold real Blobs; keep reading those. */
const fromStored = v =>
  (v instanceof Blob) ? v : new Blob([v.buf], { type: v.type || 'image/jpeg' });

// ───────────────────────────────────────────────────────────────── api

/** draft = { id, meta, full: Blob, thumb: Blob } */
export async function putDraft(draft) {
  const [full, thumb] = await Promise.all([toStored(draft.full), toStored(draft.thumb)]);
  return tx('readwrite', s => wrap('saving the sighting',
    s.put({ id: draft.id, meta: draft.meta, full, thumb })));
}

export async function allDrafts() {
  const rows = await tx('readonly', s => wrap('reading the queue', s.getAll()));
  return (rows || [])
    .map(d => ({ ...d, full: fromStored(d.full), thumb: fromStored(d.thumb) }))
    .sort((a, b) => new Date(b.meta.spottedAt) - new Date(a.meta.spottedAt));
}

export const deleteDraft = id =>
  tx('readwrite', s => wrap('deleting the sighting', s.delete(id)));

export const countDrafts = () =>
  tx('readonly', s => wrap('counting the queue', s.count()));

/**
 * Drafts as photo records the site can render, with blob: URLs standing in for
 * file paths. `draft: true` marks them as not-yet-published.
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
