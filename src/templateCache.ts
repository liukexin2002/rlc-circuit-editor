/**
 * IndexedDB cache for the community device-template library.
 *
 * Lets the app fall back to the last-good FULL library (not just the thin
 * bundled subset) when GET /api/templates is unreachable on a later visit, so a
 * flaky/slow/firewalled fetch doesn't silently drop a user's community devices. (#181)
 */

import type { DeviceTemplate } from "./types";

const DB_NAME = "easyschematic-template-cache";
const DB_VERSION = 1;
const STORE = "templates";
const KEY = "library";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

/** Persist the last successfully-fetched library. Best-effort; never throws. */
export async function saveCachedTemplates(templates: DeviceTemplate[]): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(templates, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // IndexedDB unavailable / quota — caching is optional, ignore.
  }
}

/** Load the last-good library, or null if nothing cached / IDB unavailable. */
export async function loadCachedTemplates(): Promise<DeviceTemplate[] | null> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve((req.result as DeviceTemplate[] | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}
