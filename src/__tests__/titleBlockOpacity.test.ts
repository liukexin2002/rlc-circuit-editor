// #359 — connections routed under the title block used to draw straight through it.
// The block has to read as a solid sheet of paper laid over the drawing on every
// surface that puts it on top of schematic content.
//
// The surfaces, and what each one has to do:
//   editor overlay  — PageBoundaryOverlay sits above the cable layer already (its
//                     wrapper is z-index 999, well above React Flow's renderer at 4),
//                     so the band only needed a fill. Vitest runs in node here, so
//                     the rect's attributes are read back from source the way
//                     roomLabelCase.test.ts reads RoomNode's class list.
//   schematic PDF   — the block is drawn after the captured drawing raster, but a
//                     stroke-only jsPDF rect let the raster show through it.
//   print sheets    — the on-screen renderer was already opaque; its PDF was not.
//   DXF             — the block is emitted below the drawing extents, so there is
//                     nothing under it to hide. Asserted, not assumed.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { emitTitleBlock } from "../dxfExport/titleBlock";
import { createDefaultLayout } from "../titleBlockLayout";
import type { DxfWriter } from "../dxfExport/writer";
import type { TitleBlock } from "../types";

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/** The source slice from a marker up to the next one, so assertions can't drift
 *  onto some other rect elsewhere in the file. */
function slice(src: string, from: string, to: string): string {
  const start = src.indexOf(from);
  expect(start, `marker not found: ${from}`).toBeGreaterThan(-1);
  const end = src.indexOf(to, start);
  expect(end, `marker not found: ${to}`).toBeGreaterThan(-1);
  return src.slice(start, end);
}

describe("editor print-view overlay (#359)", () => {
  const src = read("../components/PageBoundaryOverlay.tsx");

  it("fills the title block band so cables under it are hidden", () => {
    const band = slice(src, "{/* Title block */}", "Horizontal grid lines");
    expect(band).toContain('fill="white"');
    expect(band).not.toContain('fill="none"');
  });

  it("leaves the drawing border unfilled — only the band is opaque", () => {
    // Filling the margin border would white out the whole sheet.
    const border = slice(src, "Drawing border at print margin", "{/* Title block */}");
    expect(border).toContain('fill="none"');
  });

  it("keeps the overlay transparent to pointer events", () => {
    // An opaque band must still not swallow clicks meant for devices beneath it.
    const wrapper = slice(src, 'className="page-boundary-overlay"', "<svg");
    expect(wrapper).toContain('pointerEvents: "none"');
  });
});

describe("schematic PDF title block (#359)", () => {
  const src = read("../pdfExport.ts");

  it("draws the outer rect filled white, not stroke-only", () => {
    const block = slice(src, "async function drawTitleBlock", "Cumulative positions");
    expect(block).toContain("doc.setFillColor(255, 255, 255)");
    expect(block).toMatch(/doc\.rect\(tbLeft, tbTop, tbWidth, tbHeight, "FD"\)/);
  });
});

describe("print sheets title block (#359)", () => {
  it("is opaque on screen", () => {
    const src = read("../components/PrintSheetRenderer.tsx");
    const block = slice(src, "function TitleBlockSVG", "// ── Main renderer");
    expect(block).toMatch(/<rect x=\{0\} y=\{0\}[^/]*fill="white"/);
  });

  it("is opaque in the sheets PDF too, so the export matches the screen", () => {
    const src = read("../printSheetPdf.ts");
    const block = slice(src, "async function drawTitleBlockMm", "export async function exportPrintSheetPdf");
    expect(block).toContain("doc.setFillColor(255, 255, 255)");
    expect(block).toMatch(/doc\.rect\(tbLeft, tbTop, tbWidthMm, tbHeightMm, "FD"\)/);
  });
});

describe("DXF title block (#359)", () => {
  it("sits clear of the drawing extents, so it has nothing to occlude", () => {
    const rects: { x: number; y: number; w: number; h: number }[] = [];
    const writer = {
      addRect: (_layer: string, x: number, y: number, w: number, h: number) => {
        rects.push({ x, y, w, h });
      },
      addLine: () => {},
      addText: () => {},
      addImage: () => {},
    } as unknown as DxfWriter;

    const tb = { drawingTitle: "Test", showName: "Show" } as TitleBlock;
    const extMin = { x: 0, y: 0 };
    const extMax = { x: 40, y: 30 };
    emitTitleBlock(writer, tb, createDefaultLayout(), extMin, extMax);

    expect(rects.length).toBeGreaterThan(0);
    // Every emitted box ends below the bottom of the drawing.
    for (const r of rects) {
      expect(r.y + r.h).toBeLessThanOrEqual(extMin.y);
    }
  });
});
