/**
 * IndexedDB cache for the device library, so the site works offline after one
 * online visit. Stores three things:
 *   - the summary list (what Browse renders + filters over),
 *   - full template records keyed by id (what each detail page needs),
 *   - savedAt timestamps so the UI can say "library as of <date>" and so the
 *     background prefetch knows when the full library is stale.
 *
 * Distinct DB name from the main app's `easyschematic-template-cache` — different
 * origin anyway, but kept clear on purpose.
 */

import type { DeviceTemplate } from "../../src/types";
import type { TemplateSummary } from "./api";

const DB_NAME = "es-devices-library";
const DB_VERSION = 1;
const META_STORE = "meta";
const TEMPLATE_STORE = "templates";

const SUMMARIES_KEY = "summaries";
const SUMMARIES_SAVED_AT_KEY = "summariesSavedAt";
const LIBRARY_SAVED_AT_KEY = "librarySavedAt";
const LIBRARY_COUNT_KEY = "libraryCount";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE);
      if (!db.objectStoreNames.contains(TEMPLATE_STORE)) db.createObjectStore(TEMPLATE_STORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

/**
 * Resolve/reject when a write transaction settles. Crucially handles `onabort` —
 * a commit-time failure (e.g. QuotaExceededError) fires abort, not error, and
 * without this the caller's promise would hang forever.
 */
function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

function metaGet<T>(key: string): Promise<T | undefined> {
  return openDb().then(
    (db) =>
      new Promise<T | undefined>((resolve, reject) => {
        const tx = db.transaction(META_STORE, "readonly");
        const req = tx.objectStore(META_STORE).get(key);
        req.onsuccess = () => resolve(req.result as T | undefined);
        req.onerror = () => reject(req.error);
      }),
  );
}

/** Persist the summary list + timestamp. Best-effort; never throws. */
export async function saveSummaries(summaries: TemplateSummary[]): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction(META_STORE, "readwrite");
    const store = tx.objectStore(META_STORE);
    store.put(summaries, SUMMARIES_KEY);
    store.put(Date.now(), SUMMARIES_SAVED_AT_KEY);
    await txDone(tx);
  } catch {
    // IndexedDB unavailable / quota — caching is optional, ignore.
  }
}

/** Load the last-good summary list + when it was saved, or null. */
export async function loadSummaries(): Promise<{ summaries: TemplateSummary[]; savedAt: number } | null> {
  try {
    const summaries = await metaGet<TemplateSummary[]>(SUMMARIES_KEY);
    if (!summaries?.length) return null;
    const savedAt = (await metaGet<number>(SUMMARIES_SAVED_AT_KEY)) ?? 0;
    return { summaries, savedAt };
  } catch {
    return null;
  }
}

/** Persist the full library (bulk) + count/timestamp. Best-effort; never throws. */
export async function saveFullLibrary(templates: DeviceTemplate[]): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction([TEMPLATE_STORE, META_STORE], "readwrite");
    const store = tx.objectStore(TEMPLATE_STORE);
    store.clear();
    for (const t of templates) store.put(t);
    const meta = tx.objectStore(META_STORE);
    meta.put(Date.now(), LIBRARY_SAVED_AT_KEY);
    meta.put(templates.length, LIBRARY_COUNT_KEY);
    await txDone(tx);
  } catch {
    // ignore
  }
}

/** Persist a single fetched template (keeps the cache warm on detail visits). */
export async function saveTemplate(template: DeviceTemplate): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction(TEMPLATE_STORE, "readwrite");
    tx.objectStore(TEMPLATE_STORE).put(template);
    await txDone(tx);
  } catch {
    // ignore
  }
}

/** Remove a single template from the cache (e.g. it 404s now — deleted upstream). */
export async function deleteCachedTemplate(id: string): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction(TEMPLATE_STORE, "readwrite");
    tx.objectStore(TEMPLATE_STORE).delete(id);
    await txDone(tx);
  } catch {
    // ignore
  }
}

/** Load a single cached full template by id, or null. */
export async function loadTemplate(id: string): Promise<DeviceTemplate | null> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(TEMPLATE_STORE, "readonly");
      const req = tx.objectStore(TEMPLATE_STORE).get(id);
      req.onsuccess = () => resolve((req.result as DeviceTemplate | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

/** Load every cached full template, or null if nothing cached / IDB unavailable. */
export async function loadFullLibrary(): Promise<DeviceTemplate[] | null> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(TEMPLATE_STORE, "readonly");
      const req = tx.objectStore(TEMPLATE_STORE).getAll();
      req.onsuccess = () => {
        const all = (req.result as DeviceTemplate[] | undefined) ?? [];
        resolve(all.length ? all : null);
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

/** Metadata about the cached full library, used to decide if a prefetch is stale. */
export async function getFullLibraryMeta(): Promise<{ savedAt: number; count: number } | null> {
  try {
    const savedAt = await metaGet<number>(LIBRARY_SAVED_AT_KEY);
    if (savedAt == null) return null;
    const count = (await metaGet<number>(LIBRARY_COUNT_KEY)) ?? 0;
    return { savedAt, count };
  } catch {
    return null;
  }
}
