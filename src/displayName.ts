import type { DeviceData, DeviceTemplate, SchematicFile } from "./types";
import { estimateTextWidthPx } from "./textWidth";

export interface SchematicDisplayDefaults {
  useShortNames?: boolean;
  wrapDeviceLabels?: boolean;
}

export function getSchematicDisplayDefaults(file: Pick<SchematicFile, "useShortNames" | "wrapDeviceLabels">): SchematicDisplayDefaults {
  return {
    useShortNames: file.useShortNames,
    wrapDeviceLabels: file.wrapDeviceLabels,
  };
}

export interface ResolvedDeviceLabel {
  text: string;
  /** Is multi-line rendering permitted for this device? Rack views use it as a
   *  max-lines gate against their own (variable) label box. */
  wrap: boolean;
  /** Does the canvas device header actually need its second line — i.e. `wrap` is on
   *  AND `text` overflows the 144-px device box? The header reserves a fixed 16-px
   *  band for line two, so this must be a "needs it", not a "wrapping is on" (#249). */
  wrapsInHeader: boolean;
  /** True when a compact name is available for this device — explicit shortName or
   *  modelNumber. Drives whether the "Use short name" toggle is enabled in the editor. */
  hasShortName: boolean;
  /** Source of the compact name when one is available; "label" when nothing else exists. */
  shortSource: "shortName" | "modelNumber" | "label";
}

/** Pick the most compact identifier we have for a device. Preference order:
 *  curated `shortName` → `modelNumber` → fall back to the full `label`. */
function compactName(device: Pick<DeviceData, "label" | "shortName" | "modelNumber">): { text: string; source: "shortName" | "modelNumber" | "label" } {
  const shortName = device.shortName?.trim();
  if (shortName) return { text: shortName, source: "shortName" };
  const modelNumber = device.modelNumber?.trim();
  if (modelNumber) return { text: modelNumber, source: "modelNumber" };
  return { text: device.label, source: "label" };
}

/** Auto-number suffix preserved when collapsing a long label to its short form.
 *
 *  `renumberNodes` writes labels as exactly `baseLabel` (single instance) or
 *  `${baseLabel} ${N}` (multiple instances), and clears `baseLabel` when the user
 *  manually renames. So a non-empty baseLabel is a precise signal of
 *  "this device is participating in auto-numbering" — anything trailing baseLabel
 *  in the current label is the auto-number suffix and should ride along when we
 *  swap in shortName / modelNumber.
 *
 *  Example: baseLabel="Sony HDC-5500", label="Sony HDC-5500 3" → suffix=" 3".
 *  Resolved with shortName "HDC-5500" → "HDC-5500 3". */
function autoNumberSuffix(label: string, baseLabel: string | undefined): string {
  if (!baseLabel) return "";
  if (label === baseLabel) return "";
  if (label.startsWith(baseLabel)) return label.slice(baseLabel.length);
  return "";
}

/** Width available to the device name inside the header band: the 144-px device
 *  box, less its 1-px left/right border, less the header's `px-3` padding. */
export const DEVICE_LABEL_AVAIL_PX = 144 - 2 - 24;
/** `text-xs font-semibold` on the header label — and only Inter 400/700 are loaded,
 *  so CSS weight matching renders 600 as Bold. */
const DEVICE_LABEL_FONT_PX = 12;
/** A couple of percent of slack for kerning and sub-pixel rounding: wrapping a name
 *  that would just barely have fit costs 16 px of header, but NOT wrapping one that
 *  doesn't fit silently truncates it, so lean toward the second line at the margin. */
const FIT_TOLERANCE = 0.98;
/** Widest a header line may be before it has to break — the single budget behind both
 *  "does this name need a second line?" and "where does line one end?", so the two can
 *  never disagree. */
const DEVICE_LABEL_BUDGET_PX = DEVICE_LABEL_AVAIL_PX * FIT_TOLERANCE;

function deviceLabelWidthPx(text: string): number {
  return estimateTextWidthPx(text, DEVICE_LABEL_FONT_PX, "bold");
}

/** Does this device name actually need a second line inside the header?
 *
 *  The single source of truth for the question, so the canvas, the snap/height
 *  estimates, the routing harness and every export agree on how tall a device is
 *  (#249 — wrapping used to reserve line two unconditionally).
 *
 *  Measured against the name as stored: the auto-case preference is applied later,
 *  at render time, so an uppercase override can push a borderline name past the
 *  box. FIT_TOLERANCE absorbs a few percent of that. */
export function deviceLabelNeedsWrap(text: string): boolean {
  return deviceLabelWidthPx(text) > DEVICE_LABEL_BUDGET_PX;
}

/** Line box the canvas gives each line of a wrapped header label (`lineHeight: "14px"`
 *  on DeviceNode's clamped label span). */
export const DEVICE_LABEL_LINE_PX = 14;
/** Lines the header shows before clipping — DeviceNode's `-webkit-line-clamp: 2`, and
 *  what HEADER_LABEL_ZONE_2_PX reserves room for. */
export const DEVICE_LABEL_MAX_LINES = 2;

export interface WrapDeviceLabelOptions {
  /** Lines to keep; the last one absorbs the ellipsis. Defaults to DEVICE_LABEL_MAX_LINES. */
  maxLines?: number;
  /** Marker appended when the name outruns `maxLines`. Defaults to the "…" the canvas's
   *  line-clamp draws; the DXF exporter passes "..." because several CAD readers
   *  substitute three periods for the single glyph and then mis-measure the line. */
  ellipsis?: string;
}

/**
 * Break a device name into the header lines the canvas shows.
 *
 * Greedy word wrap against the header's own width, measured with the shared estimate —
 * so an exporter that has no line wrapping of its own (DXF: one TEXT entity per line)
 * splits at exactly the point the browser does, instead of ellipsising the tail of a
 * name that the canvas shows in full (#299).
 *
 * Whitespace is collapsed the way HTML collapses it, and a word too long for a line of
 * its own is broken mid-word, matching the span's `word-break: break-word`.
 */
export function wrapDeviceLabelLines(
  text: string,
  { maxLines = DEVICE_LABEL_MAX_LINES, ellipsis = "…" }: WrapDeviceLabelOptions = {},
): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (deviceLabelWidthPx(candidate) <= DEVICE_LABEL_BUDGET_PX) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    let rest = word;
    while (deviceLabelWidthPx(rest) > DEVICE_LABEL_BUDGET_PX) {
      let cut = 1;
      while (cut < rest.length && deviceLabelWidthPx(rest.slice(0, cut + 1)) <= DEVICE_LABEL_BUDGET_PX) cut++;
      lines.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    line = rest;
  }
  if (line) lines.push(line);

  const keep = Math.max(1, maxLines);
  if (lines.length <= keep) return lines;
  const clamped = lines.slice(0, keep);
  let last = clamped[keep - 1];
  while (last && deviceLabelWidthPx(last + ellipsis) > DEVICE_LABEL_BUDGET_PX) {
    last = last.slice(0, -1).trimEnd();
  }
  clamped[keep - 1] = last + ellipsis;
  return clamped;
}

export function resolveDeviceLabel(
  device: Pick<DeviceData, "label" | "shortName" | "useShortName" | "wrapLabel" | "modelNumber" | "baseLabel">,
  defaults: SchematicDisplayDefaults,
): ResolvedDeviceLabel {
  const compact = compactName(device);
  const hasShortName = compact.source !== "label";
  const useShort = device.useShortName ?? defaults.useShortNames ?? false;
  const text = useShort && hasShortName
    ? compact.text + autoNumberSuffix(device.label, device.baseLabel)
    : device.label;
  // Wrapping being *enabled* only permits a second line. In the device header, where
  // the space for line two is reserved up front, the name has to actually overflow to
  // get one — otherwise every short-named device carries dead space (#249).
  const wrap = device.wrapLabel ?? defaults.wrapDeviceLabels ?? false;
  const wrapsInHeader = wrap && deviceLabelNeedsWrap(text);
  return { text, wrap, wrapsInHeader, hasShortName, shortSource: compact.source };
}

/** What to show in the device library / sidebar for a template entry — same fallback
 *  chain as device instances: shortName → modelNumber → label. */
export function templateDisplayLabel(t: Pick<DeviceTemplate, "label" | "shortName" | "modelNumber">): string {
  return t.shortName?.trim() || t.modelNumber?.trim() || t.label;
}
