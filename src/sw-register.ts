import { registerSW } from "virtual:pwa-register";
import { useSWStore } from "./swStore";

const POLL_MS = 10 * 60_000;

let updateSW: ((reload?: boolean) => Promise<void>) | null = null;

export function initServiceWorkerUpdates(): void {
  if (typeof window === "undefined") return;

  updateSW = registerSW({
    onRegisteredSW(_url, reg) {
      if (!reg) return;
      const check = () => { reg.update().catch(() => { /* offline / transient */ }); };
      setInterval(check, POLL_MS);
      // Tab returning from background should check immediately, not wait for
      // the next 10-min interval.
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") check();
      });
    },
    onNeedRefresh() {
      // Hidden tab → user can't see a pill anyway, just reload silently so
      // their next focus lands on fresh code. Visible tab → show the pill and
      // let the user decide; if they ignore it forever, that's fine, it sits
      // there until they reload manually or click it.
      if (document.visibilityState === "hidden") {
        void updateSW?.(true);
      } else {
        useSWStore.getState().setUpdateAvailable(true);
      }
    },
  });
}

export function triggerUpdate(): void {
  if (updateSW) void updateSW(true);
  else location.reload();
}

/** Nuclear option: unregister all SWs + clear the Cache API, then reload.
 *  Does NOT touch localStorage or IndexedDB — schematic data lives there. */
export async function forceFullReset(): Promise<void> {
  try {
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } finally {
    location.reload();
  }
}
