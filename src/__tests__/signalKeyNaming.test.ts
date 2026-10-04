// #358 — the print-view toggle said "Color Key" while every legend it produces is
// headed "SIGNAL KEY". "Signal Key" is the standardized user-facing term; the
// colorKey* state and helper names are internal and deliberately unchanged.
//
// Node environment, no DOM — the strings are read back from source the same way
// roomLabelCase.test.ts reads RoomNode's class list.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const SURFACES: [string, string][] = [
  ["editor overlay", "../components/PageBoundaryOverlay.tsx"],
  ["PDF export", "../pdfExport.ts"],
  ["DXF legend", "../dxfExport/legend.ts"],
];

describe("signal key legend heading (#358)", () => {
  it.each(SURFACES)("%s heads the legend SIGNAL KEY", (_name, path) => {
    expect(read(path)).toContain("SIGNAL KEY");
  });
});

describe("print view bar toggle (#358)", () => {
  const src = read("../components/PrintViewBar.tsx");

  it("labels the toggle Signal Key, matching the legend it draws", () => {
    expect(src).toContain("Signal Key");
  });

  it("says Signal Key in the toggle and settings tooltips too", () => {
    expect(src).toContain('title="Toggle the signal key"');
    expect(src).toContain('title="Signal key settings"');
  });

  it("has no user-facing 'Color Key' text left", () => {
    // Internal identifiers (colorKeyEnabled, setColorKeyCorner, …) are exempt:
    // only the spaced, capitalized display term is banned.
    expect(src).not.toMatch(/Colou?r Key/);
  });
});
