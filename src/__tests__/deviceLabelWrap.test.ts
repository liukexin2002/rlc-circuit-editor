import { describe, it, expect } from "vitest";
import {
  DEVICE_LABEL_AVAIL_PX,
  DEVICE_LABEL_MAX_LINES,
  deviceLabelNeedsWrap,
  resolveDeviceLabel,
  wrapDeviceLabelLines,
} from "../displayName";
import { estimateTextWidthPx } from "../textWidth";
import { HEADER_LABEL_ZONE_PX, HEADER_LABEL_ZONE_2_PX, headerBandHeight } from "../auxiliaryData";
import type { DeviceData } from "../types";

type LabelInput = Parameters<typeof resolveDeviceLabel>[0];

const device = (over: Partial<DeviceData> = {}): LabelInput =>
  ({ label: "Camera", ...over }) as LabelInput;

describe("estimateTextWidthPx", () => {
  it("is zero for empty text and grows with length", () => {
    expect(estimateTextWidthPx("", 12)).toBe(0);
    expect(estimateTextWidthPx("MM", 12)).toBeGreaterThan(estimateTextWidthPx("M", 12));
  });

  it("scales linearly with font size", () => {
    expect(estimateTextWidthPx("Camera", 24)).toBeCloseTo(estimateTextWidthPx("Camera", 12) * 2, 6);
  });

  it("charges wide glyphs more than narrow ones", () => {
    expect(estimateTextWidthPx("WWWW", 12)).toBeGreaterThan(estimateTextWidthPx("llll", 12));
  });

  it("makes bold wider than regular", () => {
    expect(estimateTextWidthPx("Camera", 12, "bold")).toBeGreaterThan(
      estimateTextWidthPx("Camera", 12),
    );
  });

  it("matches Inter's real advance widths", () => {
    // "M" is 0.932 em in Inter Bold, 0.903 in Regular.
    expect(estimateTextWidthPx("M", 100, "bold")).toBeCloseTo(93.2, 6);
    expect(estimateTextWidthPx("M", 100)).toBeCloseTo(90.3, 6);
  });

  it("charges an unlisted glyph the table average rather than nothing", () => {
    expect(estimateTextWidthPx("é", 12)).toBeGreaterThan(0);
  });

  it("is deterministic — the same input measures the same in any environment", () => {
    expect(estimateTextWidthPx("Sony HDC-5500", 12, "bold")).toBe(
      estimateTextWidthPx("Sony HDC-5500", 12, "bold"),
    );
  });
});

describe("deviceLabelNeedsWrap", () => {
  it("says no for names that comfortably fit the 144-px device box", () => {
    expect(deviceLabelNeedsWrap("Camera")).toBe(false);
    expect(deviceLabelNeedsWrap("Camera 1")).toBe(false);
    expect(deviceLabelNeedsWrap("Sony HDC-5500")).toBe(false);
    expect(deviceLabelNeedsWrap("")).toBe(false);
  });

  it("says yes for names that overflow it", () => {
    expect(deviceLabelNeedsWrap("Extron DTP CrossPoint 84 4K IPCP SA")).toBe(true);
    expect(deviceLabelNeedsWrap("Main Hall Ceiling Microphone Array")).toBe(true);
  });

  it("measures against the header's usable width, not the full device width", () => {
    expect(DEVICE_LABEL_AVAIL_PX).toBe(118);
  });
});

// Where the header actually breaks a long name. Exports with no wrapping of their own
// (DXF emits one TEXT entity per line) ask this instead of guessing, so a name the canvas
// shows over two lines is not exported as one ellipsised line (#299).
describe("wrapDeviceLabelLines (#299)", () => {
  /** Same budget deviceLabelNeedsWrap answers against — every produced line must fit it. */
  const fits = (line: string) =>
    estimateTextWidthPx(line, 12, "bold") <= DEVICE_LABEL_AVAIL_PX * 0.98;

  it("leaves a name that fits the header on one line", () => {
    expect(wrapDeviceLabelLines("Camera")).toEqual(["Camera"]);
    expect(wrapDeviceLabelLines("Sony HDC-5500")).toEqual(["Sony HDC-5500"]);
  });

  it("returns nothing for an empty or whitespace-only name", () => {
    expect(wrapDeviceLabelLines("")).toEqual([]);
    expect(wrapDeviceLabelLines("   ")).toEqual([]);
  });

  it("agrees with deviceLabelNeedsWrap on which names take a second line", () => {
    for (const name of [
      "Camera",
      "Camera 1",
      "Sony HDC-5500",
      "USB-A (M) → RJ45 (F) Adapter",
      "Main Hall Ceiling Microphone Array",
    ]) {
      expect(wrapDeviceLabelLines(name).length > 1).toBe(deviceLabelNeedsWrap(name));
    }
  });

  it("breaks at a word boundary and keeps the whole name — the #299 adapter", () => {
    const lines = wrapDeviceLabelLines("USB-A (M) → RJ45 (F) Adapter");
    expect(lines).toEqual(["USB-A (M) → RJ45", "(F) Adapter"]);
    // Nothing is dropped: the DXF used to export this as one truncated line.
    expect(lines.join(" ")).toBe("USB-A (M) → RJ45 (F) Adapter");
    expect(lines.every(fits)).toBe(true);
  });

  it("clamps past two lines with an ellipsis, like the canvas line-clamp", () => {
    const lines = wrapDeviceLabelLines("Extron DTP CrossPoint 84 4K IPCP SA");
    expect(lines.length).toBe(DEVICE_LABEL_MAX_LINES);
    expect(lines[1].endsWith("…")).toBe(true);
    expect(lines.every(fits)).toBe(true);
  });

  it("takes the caller's ellipsis — CAD readers need three literal periods", () => {
    const lines = wrapDeviceLabelLines("Extron DTP CrossPoint 84 4K IPCP SA", { ellipsis: "..." });
    expect(lines[1].endsWith("...")).toBe(true);
    expect(lines.every(fits)).toBe(true);
  });

  it("breaks a single over-long word mid-word, matching `word-break: break-word`", () => {
    const word = "Supercalifragilisticexpialidociousaurus";
    const lines = wrapDeviceLabelLines(word);
    expect(lines.length).toBe(2);
    expect(word.startsWith(lines[0])).toBe(true);
    expect(word.slice(lines[0].length).startsWith(lines[1].replace("…", ""))).toBe(true);
    expect(lines.every(fits)).toBe(true);
  });

  it("collapses runs of whitespace the way HTML does", () => {
    expect(wrapDeviceLabelLines("Sony   HDC-5500")).toEqual(["Sony HDC-5500"]);
  });

  it("honours a one-line request — the whole name on one ellipsised line", () => {
    const lines = wrapDeviceLabelLines("Main Hall Ceiling Microphone Array", { maxLines: 1 });
    expect(lines.length).toBe(1);
    expect(lines[0].endsWith("…")).toBe(true);
    expect(fits(lines[0])).toBe(true);
  });
});

describe("resolveDeviceLabel wrap resolution (#249)", () => {
  it("keeps `wrap` meaning 'multi-line allowed' for the rack views that gate on it", () => {
    // Rack faces size their own label box, so they still want the raw preference —
    // only the fixed-width device header narrows it down to wrapsInHeader.
    const short = resolveDeviceLabel(device({ label: "Camera" }), { wrapDeviceLabels: true });
    expect(short.wrap).toBe(true);
    expect(short.wrapsInHeader).toBe(false);
    expect(resolveDeviceLabel(device({ label: "Camera" }), {}).wrap).toBe(false);
  });

  it("does not wrap a short name even when wrapping is enabled", () => {
    expect(resolveDeviceLabel(device({ label: "Camera" }), { wrapDeviceLabels: true }).wrapsInHeader).toBe(false);
    expect(resolveDeviceLabel(device({ label: "Camera", wrapLabel: true }), {}).wrapsInHeader).toBe(false);
  });

  it("wraps a long name when wrapping is enabled", () => {
    const long = "Extron DTP CrossPoint 84 4K IPCP SA";
    expect(resolveDeviceLabel(device({ label: long }), { wrapDeviceLabels: true }).wrapsInHeader).toBe(true);
    expect(resolveDeviceLabel(device({ label: long, wrapLabel: true }), {}).wrapsInHeader).toBe(true);
  });

  it("never wraps when wrapping is off, however long the name", () => {
    const long = "Extron DTP CrossPoint 84 4K IPCP SA";
    expect(resolveDeviceLabel(device({ label: long }), {}).wrapsInHeader).toBe(false);
    expect(resolveDeviceLabel(device({ label: long, wrapLabel: false }), { wrapDeviceLabels: true }).wrapsInHeader)
      .toBe(false);
  });

  it("measures the resolved short name, not the full label", () => {
    const d = device({
      label: "Extron DTP CrossPoint 84 4K IPCP SA",
      shortName: "DTP CP84",
      useShortName: true,
      wrapLabel: true,
    });
    const resolved = resolveDeviceLabel(d, {});
    expect(resolved.text).toBe("DTP CP84");
    expect(resolved.wrapsInHeader).toBe(false);
  });

  it("reserves no second line of header height for a short wrapped-enabled name", () => {
    const zone = (wrap: boolean) => (wrap ? HEADER_LABEL_ZONE_2_PX : HEADER_LABEL_ZONE_PX);
    const band = (label: string) =>
      headerBandHeight(
        [{ text: "{{modelNumber}}", position: "header" }],
        zone(resolveDeviceLabel(device({ label }), { wrapDeviceLabels: true }).wrapsInHeader),
      );
    // One header aux row: the short name now stays in the 32-px band instead of
    // pushing the header to 48 for a second line it never uses (#249).
    expect(band("Camera")).toBe(32);
    expect(band("Extron DTP CrossPoint 84 4K IPCP SA")).toBe(48);
  });
});
