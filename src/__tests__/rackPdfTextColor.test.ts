import { describe, it, expect } from "vitest";
import { contrastingTextRgb } from "../rackPdf";

// #301 — rack PDFs hardcoded white device names, unreadable on light header
// colors. contrastingTextRgb must track the fill setFillHex produces: same
// hex parsing, same fallback when the color doesn't parse.
describe("contrastingTextRgb", () => {
  const DEVICE_BLUE: [number, number, number] = [74, 144, 217];

  it("keeps white text on dark headers", () => {
    expect(contrastingTextRgb("#000000", DEVICE_BLUE)).toEqual([255, 255, 255]);
    expect(contrastingTextRgb("#1d4ed8", DEVICE_BLUE)).toEqual([255, 255, 255]);
  });

  it("picks black text on light headers", () => {
    expect(contrastingTextRgb("#ffffff", DEVICE_BLUE)).toEqual([0, 0, 0]);
    expect(contrastingTextRgb("#fde047", DEVICE_BLUE)).toEqual([0, 0, 0]); // pale yellow
    expect(contrastingTextRgb("#e5e7eb", DEVICE_BLUE)).toEqual([0, 0, 0]); // pale grey
    // The default device blue reads better with black by WCAG ratio — same
    // choice contrastingTextColor makes for canvas headers since #295.
    expect(contrastingTextRgb("#4a90d9", DEVICE_BLUE)).toEqual([0, 0, 0]);
  });

  it("judges against the fallback fill when the color is missing or unparsable", () => {
    // setFillHex falls back to the given fill for these, so the text color
    // must be judged against that fallback, not against the raw input.
    expect(contrastingTextRgb(undefined, [29, 78, 216])).toEqual([255, 255, 255]);
    expect(contrastingTextRgb("not-a-color", [29, 78, 216])).toEqual([255, 255, 255]);
    expect(contrastingTextRgb("#abc", [29, 78, 216])).toEqual([255, 255, 255]); // setFillHex only parses #rrggbb
    // A light fallback fill flips the choice.
    expect(contrastingTextRgb(undefined, [253, 224, 71])).toEqual([0, 0, 0]);
  });
});
