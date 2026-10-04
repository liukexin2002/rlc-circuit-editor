import { formatDateTime } from "../format";

/**
 * Shown on Browse/Detail when the current view was served from the offline
 * IndexedDB cache instead of the network.
 */
export default function OfflineBanner({ savedAt }: { savedAt?: number | null }) {
  const when = savedAt ? formatDateTime(savedAt) : null;
  return (
    <div className="mb-4 flex items-start gap-2 border border-amber-300 dark:border-amber-700 rounded-lg p-3 bg-amber-50 dark:bg-amber-900/30 text-sm text-amber-800 dark:text-amber-200">
      <svg className="w-4 h-4 mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 5.636a9 9 0 010 12.728m0 0l-2.829-2.829m2.829 2.829L21 21M15.536 8.464a5 5 0 010 7.072m0 0l-2.829-2.829m-4.243 2.829a4.978 4.978 0 01-1.414-2.83m-1.414 5.658a9 9 0 01-2.167-9.238m7.824 2.167a1 1 0 111.414 1.414m-1.414-1.414L3 3m8.293 8.293l1.414 1.414" />
      </svg>
      <span>
        You're offline — showing the device library{when ? <> saved <strong>{when}</strong></> : null}. Reconnect to see the latest.
      </span>
    </div>
  );
}
