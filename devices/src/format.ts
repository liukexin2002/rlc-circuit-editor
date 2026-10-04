/**
 * Format a timestamp for display. Accepts either an epoch (ms) or an ISO string;
 * bare ISO strings from the API are treated as UTC (a trailing "Z" is added when
 * missing). Returns the raw input for unparseable strings, "" for bad numbers.
 */
export function formatDateTime(value: number | string): string {
  const d =
    typeof value === "number"
      ? new Date(value)
      : new Date(value.endsWith("Z") ? value : value + "Z");
  if (isNaN(d.getTime())) return typeof value === "string" ? value : "";
  return d.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
