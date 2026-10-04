import { registerSW } from "virtual:pwa-register";

const POLL_MS = 10 * 60_000;

let updateSW: ((reload?: boolean) => Promise<void>) | null = null;

// Tiny external store for the "update available" flag so components can subscribe
// via useSyncExternalStore without pulling in a state library (the devices site
// doesn't use zustand). Mirrors the main app's swStore behaviour.
let updateAvailable = false;
const listeners = new Set<() => void>();

export function subscribeUpdate(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getUpdateAvailable(): boolean {
  return updateAvailable;
}

function setUpdateAvailable(v: boolean): void {
  if (updateAvailable === v) return;
  updateAvailable = v;
  listeners.forEach((l) => l());
}

// Routes whose React state holds unsaved form input (the device editor). A
// silent reload here would wipe what the user typed — show the pill and let
// them choose instead. Browse/detail hold nothing, so silent reload is fine.
function routeHoldsUnsavedState(): boolean {
  const p = window.location.pathname;
  return p.startsWith("/submit") || p.startsWith("/admin/edit") || p.startsWith("/review/");
}

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
      // their next focus lands on fresh code — UNLESS they're mid-edit on a
      // form route, where a reload would discard unsaved input. Visible tab →
      // show the pill and let the user decide.
      if (document.visibilityState === "hidden" && !routeHoldsUnsavedState()) {
        void updateSW?.(true);
      } else {
        setUpdateAvailable(true);
      }
    },
  });
}

export function triggerUpdate(): void {
  if (updateSW) void updateSW(true);
  else location.reload();
}
