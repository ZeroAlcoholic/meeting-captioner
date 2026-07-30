/**
 * Tiny promise-based IndexedDB wrapper for the caption store's PRIMARY durable
 * snapshot. One database, one object store, one record (key `current`) holding
 * the full session history.
 *
 * Why IndexedDB and not just localStorage:
 *   - capacity: localStorage tops out around 5 MB; a long meeting's full
 *     transcript can exceed that. IDB has multi-MB-to-GB headroom.
 *   - non-blocking: writes are async, off the synchronous main-thread path.
 *
 * Why localStorage is STILL used alongside (in caption-store.ts): IndexedDB
 * cannot be written synchronously on `pagehide`, so the crash-safety net (the
 * newest-N segment tail + in-flight line) goes to localStorage. IDB holds the
 * full history; the two are merged on the next load.
 *
 * No external deps. Every call degrades to a no-op / null when IndexedDB is
 * unavailable (private-mode quirks, the node test env, blocked storage).
 */

const DB_NAME = 'meeting-audio';
const STORE = 'captions';
const RECORD_KEY = 'current';
const DB_VERSION = 1;

function available(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    // Accessing `indexedDB` can throw in sandboxed iframes / disabled storage.
    return false;
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
    // A blocked event means another tab holds an older-version connection that
    // can't be upgraded. Rather than hang forever waiting for onsuccess, reject
    // so callers fall back cleanly (idbLoad → null, idbSave/idbClear → no-op).
    // Harmless today (DB_VERSION never bumped) but prevents a future version
    // bump from wedging hydration with a multi-tab session.
    req.onblocked = () =>
      reject(new Error('indexedDB open blocked (another tab holds an older version)'));
  });
}

/** Read the persisted snapshot record, or null if absent / IDB unavailable. */
export async function idbLoad<T>(): Promise<T | null> {
  if (!available()) return null;
  try {
    const db = await openDb();
    try {
      return await new Promise<T | null>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).get(RECORD_KEY);
        req.onsuccess = () => resolve((req.result as T | undefined) ?? null);
        req.onerror = () => reject(req.error);
      });
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** Write the full snapshot record. No-op on failure (localStorage tier covers durability). */
export async function idbSave(value: unknown): Promise<void> {
  if (!available()) return;
  try {
    const db = await openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(value, RECORD_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  } catch {
    /* quota / unavailable — in-memory + localStorage tail keep working */
  }
}

/** Delete the persisted snapshot record (called on clear()). */
export async function idbClear(): Promise<void> {
  if (!available()) return;
  try {
    const db = await openDb();
    try {
      await new Promise<void>((resolve) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(RECORD_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      });
    } finally {
      db.close();
    }
  } catch {
    /* noop */
  }
}
