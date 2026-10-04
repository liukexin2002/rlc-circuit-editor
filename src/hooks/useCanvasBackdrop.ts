import { useSyncExternalStore } from "react";

const FALLBACK = "#ffffff";

function readBackdrop(): string {
  if (typeof document === "undefined" || !document.documentElement) return FALLBACK;
  try {
    return (
      getComputedStyle(document.documentElement).getPropertyValue("--color-bg").trim() || FALLBACK
    );
  } catch {
    return FALLBACK;
  }
}

// One observer for all subscribers — the value is a document-level fact, and
// getComputedStyle on every render of every annotation would not be free.
let cached: string | null = null;
let observer: MutationObserver | null = null;
const listeners = new Set<() => void>();

function getSnapshot(): string {
  if (cached === null) cached = readBackdrop();
  return cached;
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  if (!observer && typeof MutationObserver !== "undefined" && typeof document !== "undefined" && document.documentElement) {
    observer = new MutationObserver(() => {
      const next = readBackdrop();
      if (next === cached) return;
      cached = next;
      for (const listener of listeners) listener();
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-export-capturing"],
    });
  }
  // The theme class is applied from an effect in App, so it may already have flipped
  // between this module's first read and this subscription.
  const current = readBackdrop();
  if (current !== cached) {
    cached = current;
    onChange();
  }
  return () => {
    listeners.delete(onChange);
    if (listeners.size === 0) {
      observer?.disconnect();
      observer = null;
      cached = null;
    }
  };
}

/**
 * The color currently painted behind canvas content, as a concrete value.
 *
 * Anything translucent on the canvas (annotation fills) has to be judged against
 * this before its text color can be chosen. Two things move it, neither of which
 * flows through the store:
 *
 *  - the theme toggle, which adds/removes `.dark` on <html> (see `useTheme`)
 *  - image/PDF export, which stamps `data-export-capturing` on <html> to force
 *    light-mode colors for the capture (see `[data-export-capturing]` in index.css)
 *
 * So watch those two attributes directly. Export waits two animation frames after
 * setting its attribute, which is ample for this to re-render before the capture
 * reads the DOM — without it a dark-mode export would bake white label text onto
 * the forced-light background.
 */
export function useCanvasBackdrop(): string {
  return useSyncExternalStore(subscribe, getSnapshot, () => FALLBACK);
}
