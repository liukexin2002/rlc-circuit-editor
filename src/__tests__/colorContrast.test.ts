import { describe, it, expect } from "vitest";
import {
  CONTRAST_BLACK,
  CONTRAST_WHITE,
  compositeOver,
  contrastRatio,
  contrastingTextColor,
  parseColor,
  relativeLuminance,
} from "../colorContrast";

/** Stand-in for the document's custom properties (vitest runs without a DOM). */
const vars: Record<string, string> = {
  "--color-bg": "#0f172a",
  "--color-surface": "#1e293b",
  "--color-indirect": "var(--color-bg)",
};
const resolveVar = (name: string) => vars[name] ?? "";

describe("parseColor", () => {
  it("parses 6- and 3-digit hex", () => {
    expect(parseColor("#ff0000")).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    expect(parseColor("#0f0")).toEqual({ r: 0, g: 255, b: 0, a: 1 });
  });

  it("parses hex with an alpha channel", () => {
    expect(parseColor("#00000080")?.a).toBeCloseTo(0.502, 2);
    expect(parseColor("#0000")).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  });

  it("parses rgb() and rgba() in comma syntax", () => {
    expect(parseColor("rgb(59, 130, 246)")).toEqual({ r: 59, g: 130, b: 246, a: 1 });
    expect(parseColor("rgba(59, 130, 246, 0.1)")).toEqual({ r: 59, g: 130, b: 246, a: 0.1 });
  });

  it("parses modern space/slash rgb() syntax and percentages", () => {
    expect(parseColor("rgb(59 130 246 / 50%)")?.a).toBeCloseTo(0.5, 5);
    expect(parseColor("rgb(100% 0% 0%)")).toEqual({ r: 255, g: 0, b: 0, a: 1 });
  });

  it("resolves var() tokens through the supplied lookup", () => {
    expect(parseColor("var(--color-bg)", resolveVar)).toEqual({ r: 15, g: 23, b: 42, a: 1 });
  });

  it("follows a var() that points at another var()", () => {
    expect(parseColor("var(--color-indirect)", resolveVar)).toEqual({ r: 15, g: 23, b: 42, a: 1 });
  });

  it("falls back to the var()'s own fallback when the token is unset", () => {
    expect(parseColor("var(--nope, #ffffff)", resolveVar)).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor("var(--nope)", resolveVar)).toBeNull();
  });

  it("handles the keywords that reach these call sites", () => {
    expect(parseColor("white")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor("transparent")?.a).toBe(0);
  });

  it("returns null for junk", () => {
    expect(parseColor("")).toBeNull();
    expect(parseColor(undefined)).toBeNull();
    expect(parseColor("chartreuse")).toBeNull();
    expect(parseColor("#12345")).toBeNull();
    expect(parseColor("rgb(1, 2)")).toBeNull();
  });
});

describe("relativeLuminance", () => {
  it("anchors at the WCAG endpoints", () => {
    expect(relativeLuminance({ r: 0, g: 0, b: 0 })).toBeCloseTo(0, 6);
    expect(relativeLuminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(1, 6);
  });

  it("weights green above red above blue", () => {
    const red = relativeLuminance({ r: 255, g: 0, b: 0 });
    const green = relativeLuminance({ r: 0, g: 255, b: 0 });
    const blue = relativeLuminance({ r: 0, g: 0, b: 255 });
    expect(green).toBeGreaterThan(red);
    expect(red).toBeGreaterThan(blue);
  });
});

describe("contrastRatio", () => {
  it("gives 21:1 for black on white", () => {
    expect(contrastRatio(0, 1)).toBeCloseTo(21, 5);
  });
});

describe("compositeOver", () => {
  it("blends a translucent fill onto its backdrop", () => {
    const out = compositeOver({ r: 0, g: 0, b: 0, a: 0.5 }, { r: 255, g: 255, b: 255, a: 1 });
    expect(out).toEqual({ r: 127.5, g: 127.5, b: 127.5, a: 1 });
  });
});

describe("contrastingTextColor", () => {
  it("returns white on a black device header and black on a white one (#295)", () => {
    expect(contrastingTextColor("#000000")).toBe(CONTRAST_WHITE);
    expect(contrastingTextColor("#ffffff")).toBe(CONTRAST_BLACK);
  });

  it("handles the saturated header colors a user is likely to pick", () => {
    expect(contrastingTextColor("#4b5563")).toBe(CONTRAST_WHITE); // the editor's default
    expect(contrastingTextColor("#1d4ed8")).toBe(CONTRAST_WHITE); // deep blue
    expect(contrastingTextColor("#fde047")).toBe(CONTRAST_BLACK); // yellow
    expect(contrastingTextColor("#22c55e")).toBe(CONTRAST_BLACK); // mid green
  });

  it("flips with the canvas behind the default translucent annotation fill (#258)", () => {
    const fill = "rgba(59, 130, 246, 0.1)";
    expect(contrastingTextColor(fill, { backdrop: "#ffffff" })).toBe(CONTRAST_BLACK);
    expect(contrastingTextColor(fill, { backdrop: "#0f172a" })).toBe(CONTRAST_WHITE);
  });

  it("resolves a var() backdrop", () => {
    expect(
      contrastingTextColor("rgba(59, 130, 246, 0.1)", {
        backdrop: "var(--color-bg)",
        resolveVar,
      }),
    ).toBe(CONTRAST_WHITE);
  });

  it("ignores the backdrop when the color is opaque", () => {
    expect(contrastingTextColor("#ffffff", { backdrop: "#0f172a" })).toBe(CONTRAST_BLACK);
  });

  it("never returns a color it can't justify — unparseable input takes the fallback", () => {
    expect(contrastingTextColor("not-a-color")).toBe(CONTRAST_BLACK);
    expect(contrastingTextColor(undefined, { fallback: CONTRAST_WHITE })).toBe(CONTRAST_WHITE);
  });

  it("always picks the higher-contrast option", () => {
    for (const bg of ["#000000", "#333333", "#767676", "#999999", "#cccccc", "#ffffff"]) {
      const chosen = contrastingTextColor(bg);
      const lum = relativeLuminance(parseColor(bg)!);
      const black = contrastRatio(lum, 0);
      const white = contrastRatio(lum, 1);
      expect(chosen).toBe(black >= white ? CONTRAST_BLACK : CONTRAST_WHITE);
      expect(Math.max(black, white)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
