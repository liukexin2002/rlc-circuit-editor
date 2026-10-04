import { useSyncExternalStore } from "react";
import { subscribeUpdate, getUpdateAvailable, triggerUpdate } from "../sw-register";

/**
 * Small toast shown when a new service worker is waiting. Clicking it activates
 * the new SW and reloads. If the user ignores it, it just sits there — the old
 * cached app keeps working until they reload. Mirrors the main app's pattern.
 */
export default function UpdatePill() {
  const updateAvailable = useSyncExternalStore(subscribeUpdate, getUpdateAvailable);
  if (!updateAvailable) return null;

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50">
      <button
        onClick={triggerUpdate}
        className="flex items-center gap-2 px-4 py-2 rounded-full shadow-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 transition-colors"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
        Update available — reload
      </button>
    </div>
  );
}
