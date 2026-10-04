// Shared placement + title-block clamp for the off-page continuation pills (#337).
//
// The pill is an opaque white chip. When a connection leaves the BOTTOM of a page the
// pill lands a print-margin inside the sheet edge — which is inside the strip the title
// block occupies — and whites the block out. The editor overlay and the PDF exporter
// both draw the pill, so the clamp lives in one place and both call it; these tests pin
// the geometry and the parity between the two surfaces' idea of where the block is.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  clampPillAboveBand,
  continuationPillText,
  deoverlapAlongAxis,
  layoutContinuationPill,
  layoutContinuationPills,
  titleBlockBandInches,
  titleBlockBandPx,
  PILL_FONT_SIZE_PT,
  PILL_GAP_PT,
  PILL_PAD_PT,
  type TitleBlockBand,
} from "../continuationPill";
import { computeCrossingLabels } from "../crossingLabels";
import { computePageGrid } from "../printPageGrid";
import { getPaperSize, PAGE_MARGIN_IN } from "../printConfig";
import { createDefaultLayout } from "../titleBlockLayout";
import type { SchematicNode } from "../types";

const LETTER = getPaperSize("letter");
const SCALE = 1;
const DPI = 96;
const LAYOUT = createDefaultLayout();

/** Two devices a page apart vertically — forces a 1-column × 2-row page grid. */
const upperDevice = {
  id: "dev-rack-switch",
  type: "device",
  position: { x: 550, y: 100 },
  measured: { width: 144, height: 64 },
  data: { label: "Rack Switch", ports: [] },
} as unknown as SchematicNode;

const lowerDevice = {
  id: "dev-lobby-display",
  type: "device",
  position: { x: 550, y: 1200 },
  measured: { width: 144, height: 64 },
  data: { label: "Lobby Display", ports: [] },
} as unknown as SchematicNode;

const pages = computePageGrid(LETTER, "portrait", SCALE, [upperDevice, lowerDevice], LAYOUT.heightIn, 0, 0);

describe("title-block band", () => {
  it("puts the band on the bottom margin, flush with the right-hand drawing border", () => {
    const band = titleBlockBandInches(LETTER.widthIn, LETTER.heightIn, LAYOUT.widthIn, LAYOUT.heightIn)!;
    expect(band.width).toBeCloseTo(3.0, 6);
    expect(band.height).toBeCloseTo(1.0, 6);
    expect(band.x + band.width).toBeCloseTo(LETTER.widthIn - PAGE_MARGIN_IN, 6);
    expect(band.y + band.height).toBeCloseTo(LETTER.heightIn - PAGE_MARGIN_IN, 6);
  });

  it("caps the band at the drawing width when the layout is wider than the sheet", () => {
    const band = titleBlockBandInches(LETTER.widthIn, LETTER.heightIn, 99, 1.0)!;
    expect(band.width).toBeCloseTo(LETTER.widthIn - 2 * PAGE_MARGIN_IN, 6);
    expect(band.x).toBeCloseTo(PAGE_MARGIN_IN, 6);
  });

  it("reports no band when the title block has no height", () => {
    expect(titleBlockBandInches(LETTER.widthIn, LETTER.heightIn, 3.0, 0)).toBeNull();
    expect(titleBlockBandPx(pages[0], 3.0, 0)).toBeNull();
  });

  it("lands the canvas-pixel band exactly where the overlay draws the block", () => {
    const page = pages[0];
    const band = titleBlockBandPx(page, LAYOUT.widthIn, LAYOUT.heightIn)!;
    // The overlay's own derivation: block top is the bottom of the printable content
    // area, and it is right-aligned inside the drawing border.
    expect(band.y).toBeCloseTo(page.contentY + page.contentH, 6);
    expect(band.y + band.height).toBeCloseTo(page.y + page.heightPx - (page.contentX - page.x), 6);
    expect(band.x + band.width).toBeCloseTo(page.contentX + page.contentW, 6);
  });

  it("agrees between the editor's canvas pixels and the exporter's page inches", () => {
    const page = pages[0];
    const px = titleBlockBandPx(page, LAYOUT.widthIn, LAYOUT.heightIn)!;
    const inches = titleBlockBandInches(LETTER.widthIn, LETTER.heightIn, LAYOUT.widthIn, LAYOUT.heightIn)!;
    // Same transform the PDF path uses to move a canvas point onto the sheet
    const toPageX = (cx: number) => PAGE_MARGIN_IN + (cx - page.contentX) * SCALE / DPI;
    const toPageY = (cy: number) => PAGE_MARGIN_IN + (cy - page.contentY) * SCALE / DPI;
    expect(toPageX(px.x)).toBeCloseTo(inches.x, 6);
    expect(toPageY(px.y)).toBeCloseTo(inches.y, 6);
    expect(px.width * SCALE / DPI).toBeCloseTo(inches.width, 6);
    expect(px.height * SCALE / DPI).toBeCloseTo(inches.height, 6);
  });
});

describe("clamping a continuation pill off the title block", () => {
  const band: TitleBlockBand = { x: 5.1, y: 9.6, width: 3.0, height: 1.0 };

  it("lifts a pill that has landed on the band up onto its top edge", () => {
    const box = clampPillAboveBand({ x: 6.0, y: 10.3, width: 1.2, height: 0.12 }, band);
    expect(box.y).toBeCloseTo(band.y - 0.12, 6);
    expect(box.y + box.height).toBeCloseTo(band.y, 6);
    expect(box.x).toBeCloseTo(6.0, 6); // horizontal placement is untouched
  });

  it("leaves a pill that clears the band vertically alone", () => {
    const box = clampPillAboveBand({ x: 6.0, y: 4.0, width: 1.2, height: 0.12 }, band);
    expect(box.y).toBeCloseTo(4.0, 6);
  });

  it("leaves a pill alone when the band spans only part of the sheet width", () => {
    // Same vertical position, but out at the left-hand side where no block is drawn
    const box = clampPillAboveBand({ x: 0.5, y: 10.3, width: 1.2, height: 0.12 }, band);
    expect(box.y).toBeCloseTo(10.3, 6);
  });

  it("leaves a pill resting exactly on the band's top edge alone", () => {
    const box = clampPillAboveBand({ x: 6.0, y: band.y - 0.12, width: 1.2, height: 0.12 }, band);
    expect(box.y).toBeCloseTo(band.y - 0.12, 6);
  });

  it("leaves a pill touching the band's left edge alone", () => {
    const box = clampPillAboveBand({ x: band.x - 1.2, y: 10.3, width: 1.2, height: 0.12 }, band);
    expect(box.y).toBeCloseTo(10.3, 6);
  });

  it("leaves a pill starting at the band's right edge alone", () => {
    const box = clampPillAboveBand({ x: band.x + band.width, y: 10.3, width: 1.2, height: 0.12 }, band);
    expect(box.y).toBeCloseTo(10.3, 6);
  });

  it("does nothing when the sheet has no title block", () => {
    const box = clampPillAboveBand({ x: 6.0, y: 10.3, width: 1.2, height: 0.12 }, null);
    expect(box.y).toBeCloseTo(10.3, 6);
  });
});

describe("placing a continuation pill", () => {
  const noBands: TitleBlockBand[] = [];

  it("grows the box inward from the boundary, along the wire, for each anchor", () => {
    const size = { width: 1.0, height: 0.2 };
    // Side exits: the wire is horizontal, the pill lies flat along it.
    expect(layoutContinuationPill({ anchor: "left", x: 4, y: 3, ...size }, noBands))
      .toEqual({ x: 3, y: 2.9, width: 1.0, height: 0.2 });
    expect(layoutContinuationPill({ anchor: "right", x: 4, y: 3, ...size }, noBands))
      .toEqual({ x: 4, y: 2.9, width: 1.0, height: 0.2 });
    // Top and bottom exits: the wire is vertical, the pill is rotated onto it — the
    // box is a pill-thickness wide, a text-length tall, and grows INTO the page.
    expect(layoutContinuationPill({ anchor: "up", x: 4, y: 3, ...size }, noBands))
      .toEqual({ x: 3.9, y: 2, width: 0.2, height: 1.0 });
    expect(layoutContinuationPill({ anchor: "down", x: 4, y: 3, ...size }, noBands))
      .toEqual({ x: 3.9, y: 3, width: 0.2, height: 1.0 });
  });

  it("keeps a bottom-exit pill off the block it would otherwise white out", () => {
    const page = pages[0];
    const band = titleBlockBandPx(page, LAYOUT.widthIn, LAYOUT.heightIn)!;
    const marginPx = page.contentX - page.x;
    // Where the overlay anchors an "up" pill: an inset inside the page's bottom margin,
    // on a connection running down the right-hand side of the sheet.
    const anchorY = page.y + page.heightPx - marginPx - marginPx * 0.15;
    const anchorX = band.x + band.width / 2;
    const boxH = 12;

    // Rotated, the pill's lower end still reaches down into the title-block strip.
    const unclamped = layoutContinuationPill({ anchor: "up", x: anchorX, y: anchorY, width: 90, height: boxH }, []);
    expect(unclamped.y + unclamped.height).toBeCloseTo(anchorY, 6);
    expect(unclamped.y + unclamped.height).toBeGreaterThan(band.y);

    const box = layoutContinuationPill({ anchor: "up", x: anchorX, y: anchorY, width: 90, height: boxH }, [band]);
    expect(box.y + box.height).toBeCloseTo(band.y, 6); // lower end rests on the band's top
    expect(box.x).toBeCloseTo(anchorX - boxH / 2, 6); // and it stays on its own wire
    expect(box.y).toBeGreaterThan(page.contentY); // still inside the drawing border
  });
});

// Several connections crossing the same page edge close together used to drop their
// pills on top of each other, and the last one drawn hid the rest (#357). Pills that
// still collide — which, with top/bottom pills rotated onto their wires, now means
// crossings within a pill THICKNESS of each other — slide ALONG the edge: sorted by
// crossing point, spread just far enough to clear each other, and kept inside the
// sheet's drawing border.
describe("spreading pills along a page edge", () => {
  it("leaves pills that already clear each other exactly where they are", () => {
    const spans = [
      { center: 0, size: 2 },
      { center: 5, size: 2 },
      { center: 10, size: 2 },
    ];
    expect(deoverlapAlongAxis(spans)).toEqual([0, 5, 10]);
  });

  it("opens a cluster of three symmetrically about its crossings", () => {
    const spans = [
      { center: 10, size: 2 },
      { center: 10.5, size: 2 },
      { center: 11, size: 2 },
    ];
    const centers = deoverlapAlongAxis(spans);
    expect(centers).toEqual([8.5, 10.5, 12.5]);
    // Minimal displacement: the run's midpoint stays on the crossings' midpoint
    // instead of the whole cluster sliding off in one direction.
    expect((centers[0] + centers[2]) / 2).toBeCloseTo(10.5, 6);
  });

  it("orders pills by crossing point regardless of the order they arrived in", () => {
    const spans = [
      { center: 11, size: 2 },
      { center: 10, size: 2 },
      { center: 10.5, size: 2 },
    ];
    // The same three pills, shuffled: each still gets its own slot, reported back in
    // the caller's order.
    expect(deoverlapAlongAxis(spans)).toEqual([12.5, 8.5, 10.5]);
  });

  it("splits neighbours by half of each width, so mixed widths touch and no more", () => {
    const centers = deoverlapAlongAxis([
      { center: 10, size: 4 },
      { center: 11, size: 2 },
    ]);
    expect(centers).toEqual([9, 12]);
    expect(centers[0] + 4 / 2).toBeCloseTo(centers[1] - 2 / 2, 6); // right edge meets left edge
  });

  it("leaves the requested gap between the pills it had to split", () => {
    const centers = deoverlapAlongAxis(
      [{ center: 10, size: 2 }, { center: 10, size: 2 }],
      null,
      0.5,
    );
    expect(centers).toEqual([8.75, 11.25]);
  });

  it("pushes a cluster crowding the RIGHT end of the band back inward", () => {
    // Three 2-wide pills bunched at the band's right edge: unbounded they would land
    // at 17.5 / 19.5 / 21.5, with the last two hanging off the far end of the band.
    const centers = deoverlapAlongAxis(
      [{ center: 19, size: 2 }, { center: 19.5, size: 2 }, { center: 20, size: 2 }],
      { min: 0, max: 20 },
    );
    expect(centers).toEqual([15, 17, 19]);
    expect(centers[2] + 2 / 2).toBeCloseTo(20, 6); // last pill's RIGHT edge on the limit
    expect(centers[0] - 2 / 2).toBeGreaterThan(0); // and the run still clears the left
  });

  it("pushes a cluster crowding the LEFT end of the band back inward", () => {
    const centers = deoverlapAlongAxis(
      [{ center: 1, size: 2 }, { center: 0.5, size: 2 }, { center: 0, size: 2 }],
      { min: 0, max: 20 },
    );
    // Reported in input order: the pill crossing at 0 is the leftmost of the run.
    expect(centers).toEqual([5, 3, 1]);
    expect(centers[2] - 2 / 2).toBeCloseTo(0, 6); // that pill's LEFT edge on the limit
    expect(centers[0] + 2 / 2).toBeLessThan(20);
  });

  it("squeezes a run too long for the band instead of running it off the page", () => {
    const centers = deoverlapAlongAxis(
      [{ center: 5, size: 10 }, { center: 10, size: 10 }, { center: 15, size: 10 }],
      { min: 0, max: 20 },
    );
    // 30 of pill in 20 of band. Overrunning the far end would put the last pill outside
    // the sheet, where the PDF clips it away and the editor paints it over the next
    // page — so the spacing shrinks and the pills overlap again, but all three stay on
    // the page beside their own crossings.
    expect(centers).toEqual([5, 10, 15]);
    expect(centers[0] - 10 / 2).toBeCloseTo(0, 6); // first pill flush with the band
    expect(centers[2] + 10 / 2).toBeCloseTo(20, 6); // last pill flush with the far end
  });

  // The overflow case is not exotic: a page break between a rack sheet and a room sheet
  // routinely carries eight or more connections across one edge.
  it("keeps a realistic crowd of bottom-exit pills on the sheet", () => {
    const SIZE = 1.2; // inches — about what "Lobby Display (Conference Room) Pg 2" measures
    const band = { min: PAGE_MARGIN_IN, max: LETTER.widthIn - PAGE_MARGIN_IN };
    const gap = 1 / 72;
    const crossings = [2.6, 2.9, 3.1, 3.4, 3.8, 4.2, 4.4, 4.9];
    const centers = deoverlapAlongAxis(crossings.map((c) => ({ center: c, size: SIZE })), band, gap);

    // Every pill inside the drawing border — none of them off the 8.5in sheet.
    for (const c of centers) {
      expect(c - SIZE / 2).toBeGreaterThanOrEqual(band.min - 1e-9);
      expect(c + SIZE / 2).toBeLessThanOrEqual(band.max + 1e-9);
    }
    // Order preserved and the run spread edge to edge across the border.
    expect(centers).toEqual([...centers].sort((a, b) => a - b));
    expect(centers[0] - SIZE / 2).toBeCloseTo(band.min, 6);
    expect(centers[7] + SIZE / 2).toBeCloseTo(band.max, 6);
    // Evenly shared out: 6.5in of centre-to-centre room split seven ways.
    expect(centers[1] - centers[0]).toBeCloseTo(6.5 / 7, 6);
  });

  it("holds a squeezed run inside the band even when the widths are lopsided", () => {
    // Two wide pills and two narrow ones, together far longer than the band. Scaling the
    // spacing alone would leave a wide one hanging over the border, so each pill is held
    // inside it — and the run still reads left to right.
    const sizes = [0.5, 3, 0.5, 3];
    const centers = deoverlapAlongAxis(
      sizes.map((size, i) => ({ center: 2 + i * 0.1, size })),
      { min: 0, max: 5 },
    );
    centers.forEach((c, i) => {
      expect(c - sizes[i] / 2).toBeGreaterThanOrEqual(-1e-9);
      expect(c + sizes[i] / 2).toBeLessThanOrEqual(5 + 1e-9);
    });
    expect(centers).toEqual([...centers].sort((a, b) => a - b));
    expect(centers[0]).toBeCloseTo(0.25, 6);
    expect(centers[3]).toBeCloseTo(3.5, 6);
  });

  // The spread is a constrained least-squares fit, and the two properties that matter to
  // the reader are easy to lose in a corner: nothing may leave the drawing border, and
  // pills must stay in crossing order so a pill can be traced back to its connection.
  it("keeps every pill in order and inside the band across a spread of random rows", () => {
    let seed = 20250822;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let trial = 0; trial < 2000; trial++) {
      const n = 1 + Math.floor(rnd() * 8);
      const min = rnd() * 5;
      const max = min + 0.5 + rnd() * 12;
      const gap = rnd() * 0.1;
      const spans = Array.from({ length: n }, () => ({
        center: min - 2 + rnd() * (max - min + 4),
        size: 0.05 + rnd() * 3,
      }));
      const centers = deoverlapAlongAxis(spans, { min, max }, gap);
      const byCrossing = spans
        .map((_, i) => i)
        .sort((a, b) => spans[a].center - spans[b].center || a - b);

      for (let k = 1; k < n; k++) {
        expect(centers[byCrossing[k]]).toBeGreaterThanOrEqual(centers[byCrossing[k - 1]] - 1e-9);
      }
      // Containment holds for every row whose widest pill fits the band at all.
      if (Math.max(...spans.map((s) => s.size)) <= max - min) {
        for (let i = 0; i < n; i++) {
          expect(centers[i] - spans[i].size / 2).toBeGreaterThanOrEqual(min - 1e-9);
          expect(centers[i] + spans[i].size / 2).toBeLessThanOrEqual(max + 1e-9);
        }
      }
      // And a row that fits keeps its full gap: no pill is squeezed that need not be.
      if (spans.reduce((a, sp) => a + sp.size, 0) + gap * (n - 1) <= max - min) {
        for (let k = 1; k < n; k++) {
          const prev = spans[byCrossing[k - 1]];
          const cur = spans[byCrossing[k]];
          expect(centers[byCrossing[k]] - cur.size / 2).toBeGreaterThanOrEqual(
            centers[byCrossing[k - 1]] + prev.size / 2 + gap - 1e-9,
          );
        }
      }
    }
  });

  it("pulls a lone pill inside the band so a later neighbour cannot make it jump", () => {
    // Hanging half off the left-hand border on its own…
    expect(deoverlapAlongAxis([{ center: 0.5, size: 2 }], { min: 0, max: 20 })).toEqual([1]);
    // …and it lands in exactly the same place once an unrelated pill joins the edge.
    const withNeighbour = deoverlapAlongAxis(
      [{ center: 0.5, size: 2 }, { center: 15, size: 2 }],
      { min: 0, max: 20 },
    );
    expect(withNeighbour).toEqual([1, 15]);
  });

  it("leaves a lone pill already inside the band alone", () => {
    expect(deoverlapAlongAxis([{ center: 3, size: 2 }], { min: 0, max: 20 })).toEqual([3]);
    expect(deoverlapAlongAxis([{ center: 3, size: 2 }])).toEqual([3]);
    expect(deoverlapAlongAxis([])).toEqual([]);
  });
});

describe("spreading a sheet's continuation pills", () => {
  const noBands: TitleBlockBand[] = [];

  it("still slides near-coincident bottom-exit pills apart, on the narrow rotated footprint", () => {
    // Three vertical wires 5px apart — closer than the 12px pill thickness, so even
    // the rotated pills collide and the shared de-overlap has to open the cluster.
    const pills = [100, 105, 110].map((x) => ({
      anchor: "up" as const, x, y: 500, width: 60, height: 12, sheet: 1,
    }));
    const boxes = layoutContinuationPills(pills, noBands);
    expect(boxes.map((b) => b.x)).toEqual([87, 99, 111]);
    // All three keep the same y: the fix is a shift along the edge, not a stack.
    expect(boxes.map((b) => b.y)).toEqual([440, 440, 440]);
    expect(boxes.map((b) => b.width)).toEqual([12, 12, 12]);
  });

  it("leaves bottom-exit pills on their own wires once the wires clear a pill thickness", () => {
    // The same three wires 15px apart. Flat pills 60 wide would have slid apart;
    // rotated ones occupy only their 12px thickness on the edge and stay put.
    const pills = [100, 115, 130].map((x) => ({
      anchor: "up" as const, x, y: 500, width: 60, height: 12, sheet: 1,
    }));
    const boxes = layoutContinuationPills(pills, noBands);
    expect(boxes.map((b) => b.x)).toEqual([94, 109, 124]);
    expect(boxes.map((b) => b.y)).toEqual([440, 440, 440]);
  });

  it("slides side-exit pills apart down the sheet", () => {
    const pills = [500, 504, 508].map((y) => ({
      anchor: "left" as const, x: 700, y, width: 60, height: 12, sheet: 1,
    }));
    const boxes = layoutContinuationPills(pills, noBands);
    expect(boxes.map((b) => b.y)).toEqual([486, 498, 510]);
    expect(boxes.map((b) => b.x)).toEqual([640, 640, 640]);
  });

  it("never shifts a pill against one on another sheet or another edge", () => {
    const boxes = layoutContinuationPills(
      [
        { anchor: "up", x: 100, y: 500, width: 60, height: 12, sheet: 1 },
        { anchor: "up", x: 100, y: 500, width: 60, height: 12, sheet: 2 },
        { anchor: "down", x: 100, y: 500, width: 60, height: 12, sheet: 1 },
      ],
      noBands,
    );
    expect(boxes.map((b) => b.x)).toEqual([94, 94, 94]);
  });

  it("holds the spread inside the sheet's drawing border", () => {
    const limit = { min: 0, max: 300 };
    const pills = [280, 285, 290].map((x) => ({
      anchor: "up" as const, x, y: 500, width: 60, height: 12, sheet: 1, limit,
    }));
    const boxes = layoutContinuationPills(pills, noBands);
    expect(boxes.map((b) => b.x)).toEqual([264, 276, 288]);
    expect(boxes[2].x + boxes[2].width).toBeCloseTo(300, 6);
  });

  it("still lifts a spread pill off the title block it landed on", () => {
    const band: TitleBlockBand = { x: 0, y: 494, width: 400, height: 40 };
    const boxes = layoutContinuationPills(
      [
        { anchor: "up", x: 100, y: 500, width: 60, height: 12, sheet: 1 },
        { anchor: "up", x: 105, y: 500, width: 60, height: 12, sheet: 1 },
      ],
      [band],
    );
    expect(boxes.map((b) => b.x)).toEqual([90.5, 102.5]);
    expect(boxes.map((b) => b.y + b.height)).toEqual([band.y, band.y]);
  });

  it("places a single pill exactly as the one-pill helper does", () => {
    const pill = { anchor: "up" as const, x: 100, y: 500, width: 60, height: 12 };
    expect(layoutContinuationPills([pill], noBands)[0]).toEqual(layoutContinuationPill(pill, noBands));
  });
});


// A pill says which way the connection carries on and onto which sheet. Both surfaces
// build that string here, so the printed sheet and the preview read the same and — far
// more easily broken — measure the same width, which is what the spread runs on.
describe("the pill's text", () => {
  it("carries no direction arrow — the pill sits on its wire, which says it all (2026-08-23 pass)", () => {
    expect(continuationPillText("Rack Switch", 2)).toBe("Rack Switch Pg 2");
  });

  it("leaves the page reference off when the far side is on no sheet at all", () => {
    expect(continuationPillText("Rack Switch", 0)).toBe("Rack Switch");
    expect(continuationPillText("Rack Switch")).toBe("Rack Switch");
  });
});

// The two surfaces draw the same pills in different units — canvas pixels in the
// editor overlay, sheet inches in the PDF export. #337 put the title-block clamp in
// one place to stop them drifting; the rotated placement has to hold the same parity:
// the measured text length sets how far a rotated pill reaches up its wire, the
// thickness sets its footprint on the edge and so how a crowded cluster opens — two
// surfaces sizing their pills differently no longer merely draw different boxes, they
// draw them in different places.
describe("editor and PDF agree on where the spread pills land", () => {
  const page = pages[0];
  const marginPx = page.contentX - page.x;
  const pxPerPt = marginPx / PAGE_MARGIN_IN / 72;
  const toPageX = (cx: number) => PAGE_MARGIN_IN + (cx - page.contentX) * SCALE / DPI;
  const toPageY = (cy: number) => PAGE_MARGIN_IN + (cy - page.contentY) * SCALE / DPI;

  // Both surfaces build the string with continuationPillText and size it from
  // PILL_FONT_SIZE_PT / PILL_PAD_PT, so the one thing left that can move a pill is the
  // text measurement itself — canvas measureText on the editor's Inter, jsPDF's
  // embedded Inter metrics on the export. Those agree to a fraction of a point at 6pt,
  // and neither engine can be run from here, so one stand-in metric feeds both paths
  // and the placement is then compared exactly.
  const measurePt = (text: string) => text.length * 2.6;
  const heightPt = PILL_FONT_SIZE_PT + 2 * PILL_PAD_PT;
  const anchorYPx = page.y + page.heightPx - marginPx - marginPx * 0.15;

  /** Place the same crossings twice: once in the overlay's units, once in the PDF's. */
  function bothSurfaces(crossings: { xPx: number; text: string; pageNum: number }[]) {
    const widthsPt = crossings.map(
      (c) => measurePt(continuationPillText(c.text, c.pageNum)) + 2 * PILL_PAD_PT,
    );
    const editor = layoutContinuationPills(
      crossings.map((c, i) => ({
        anchor: "up" as const,
        x: c.xPx,
        y: anchorYPx,
        width: widthsPt[i] * pxPerPt,
        height: heightPt * pxPerPt,
        sheet: page.index + 1,
        limit: { min: page.contentX, max: page.contentX + page.contentW },
      })),
      [titleBlockBandPx(page, LAYOUT.widthIn, LAYOUT.heightIn)!],
      PILL_GAP_PT * pxPerPt,
    );
    const pdf = layoutContinuationPills(
      crossings.map((c, i) => ({
        anchor: "up" as const,
        x: toPageX(c.xPx),
        y: toPageY(anchorYPx),
        width: widthsPt[i] / 72,
        height: heightPt / 72,
        limit: { min: PAGE_MARGIN_IN, max: LETTER.widthIn - PAGE_MARGIN_IN },
      })),
      [titleBlockBandInches(LETTER.widthIn, LETTER.heightIn, LAYOUT.widthIn, LAYOUT.heightIn)!],
      PILL_GAP_PT / 72,
    );
    return { editor, pdf };
  }

  /** Four bottom exits, two of them within a pill THICKNESS of each other. */
  const crowd = [
    { xPx: 470, text: "Lobby Display (Conference Room)", pageNum: 2 },
    { xPx: 500, text: "Rack Switch (MDF)", pageNum: 2 },
    { xPx: 506, text: "Ceiling Speaker 3 (Atrium)", pageNum: 2 },
    { xPx: 560, text: "Wall Plate (Huddle 2)", pageNum: 2 },
  ];

  it("lands every pill on the same spot on the sheet", () => {
    const { editor, pdf } = bothSurfaces(crowd);
    editor.forEach((box, i) => {
      expect(toPageX(box.x)).toBeCloseTo(pdf[i].x, 6);
      expect(toPageY(box.y)).toBeCloseTo(pdf[i].y, 6);
      expect(box.width * SCALE / DPI).toBeCloseTo(pdf[i].width, 6);
      expect(box.height * SCALE / DPI).toBeCloseTo(pdf[i].height, 6);
    });
  });

  it("actually separated the pills it was handed", () => {
    const { editor } = bothSurfaces(crowd);
    const sorted = [...editor].sort((a, b) => a.x - b.x);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i].x).toBeGreaterThanOrEqual(sorted[i - 1].x + sorted[i - 1].width);
    }
    expect(sorted[0].x).toBeGreaterThanOrEqual(page.contentX - 1e-9);
    const last = sorted[sorted.length - 1];
    expect(last.x + last.width).toBeLessThanOrEqual(page.contentX + page.contentW + 1e-9);
  });

  // Nine near-coincident crossings force the whole cluster to open on the rotated
  // pills' thickness. Both surfaces have to open it identically, or the preview
  // shows a spread the print does not have. (With the narrow rotated footprint an
  // edge that genuinely cannot hold its run takes dozens of crossings, but the
  // squeeze still guards it — deoverlapAlongAxis pins that path directly above.)
  it("agrees on how a dense cluster of vertical wires opens", () => {
    const dense = Array.from({ length: 9 }, (_, i) => ({
      xPx: 300 + i * 3,
      text: `Ceiling Speaker ${i + 1} (Atrium)`,
      pageNum: 2,
    }));
    const { editor, pdf } = bothSurfaces(dense);
    editor.forEach((box, i) => {
      expect(toPageX(box.x)).toBeCloseTo(pdf[i].x, 6);
    });
    // And nothing walked off the sheet on either surface.
    for (const box of pdf) {
      expect(box.x).toBeGreaterThanOrEqual(PAGE_MARGIN_IN - 1e-9);
      expect(box.x + box.width).toBeLessThanOrEqual(LETTER.widthIn - PAGE_MARGIN_IN + 1e-9);
    }
  });
});

// computeCrossingLabels decides, per pill, which sheet it is drawn on and which of that
// sheet's borders bounds its slide. Getting one of those backwards would group pills
// across the wrong page edge and clamp them to the wrong border, so both pairings are
// pinned here — on a 2×2 grid, where every sheet has a boundary on two of its sides.
describe("the overlay's per-pill sheet and border wiring", () => {
  const overlaySrc = readFileSync(
    fileURLToPath(new URL("../components/PageBoundaryOverlay.tsx", import.meta.url)),
    "utf8",
  );

  /** Four devices, one per cell of a 2×2 page grid. */
  const grid = [
    { id: "dev-tl", x: 100, y: 100, label: "Top Left" },
    { id: "dev-tr", x: 1000, y: 100, label: "Top Right" },
    { id: "dev-bl", x: 100, y: 1200, label: "Bottom Left" },
    { id: "dev-br", x: 1000, y: 1200, label: "Bottom Right" },
  ].map((d) => ({
    id: d.id, type: "device", position: { x: d.x, y: d.y },
    measured: { width: 144, height: 64 },
    data: { label: d.label, ports: [] },
  })) as unknown as SchematicNode[];

  const gridPages = computePageGrid(LETTER, "portrait", SCALE, grid, LAYOUT.heightIn, 0, 0);
  const sheetOf = (col: number, row: number) =>
    gridPages.find((p) => p.col === col && p.row === row)!.index + 1;
  const asTyped = (l: string | null | undefined) => l ?? "";

  const route = (axis: "h" | "v", x1: number, y1: number, x2: number, y2: number) =>
    ({ e1: { segments: [{ x1, y1, x2, y2, axis }], waypoints: [], labelX: x1, labelY: y1 } }) as never;
  const conn = [{ id: "e1", source: "dev-tl", target: "dev-br", data: {} }] as never;

  /** The two pills a crossing produces, keyed by the side each sits on. */
  const pillsFor = (routed: never) =>
    Object.fromEntries(
      computeCrossingLabels(gridPages, routed, conn, grid, undefined, asTyped)
        .map((l) => [l.anchor, l]),
    );

  it("gives each pill the sheet it is drawn on, not the one it points at", () => {
    // A run left-to-right across the TOP row, crossing the column boundary.
    const sideways = pillsFor(route("h", 244, 130, 1000, 130));
    expect(sideways.left.sheet).toBe(sheetOf(0, 0));
    expect(sideways.left.pageNum).toBe(sheetOf(1, 0));
    expect(sideways.right.sheet).toBe(sheetOf(1, 0));
    expect(sideways.right.pageNum).toBe(sheetOf(0, 0));

    // A run top-to-bottom down the LEFT column, crossing the row boundary.
    const vertical = pillsFor(route("v", 150, 164, 150, 1200));
    expect(vertical.up.sheet).toBe(sheetOf(0, 0));
    expect(vertical.up.pageNum).toBe(sheetOf(0, 1));
    expect(vertical.down.sheet).toBe(sheetOf(0, 1));
    expect(vertical.down.pageNum).toBe(sheetOf(0, 0));
  });

  it("bounds each pill by the border of the sheet it is drawn on", () => {
    const marginPx = gridPages[0].contentX - gridPages[0].x;
    const borderOf = (sheet: number) => {
      const p = gridPages.find((q) => q.index + 1 === sheet)!;
      return {
        acrossSheet: { min: p.contentX, max: p.contentX + p.contentW },
        // Down to the bottom margin, not to contentH, which stops a title-block short.
        downSheet: { min: p.contentY, max: p.y + p.heightPx - marginPx },
      };
    };

    // Side exits slide DOWN the sheet they are drawn on...
    const sideways = pillsFor(route("h", 244, 130, 1000, 130));
    expect(sideways.left.limit).toEqual(borderOf(sheetOf(0, 0)).downSheet);
    expect(sideways.right.limit).toEqual(borderOf(sheetOf(1, 0)).downSheet);
    // ...and bottom/top exits slide ACROSS it.
    const vertical = pillsFor(route("v", 150, 164, 150, 1200));
    expect(vertical.up.limit).toEqual(borderOf(sheetOf(0, 0)).acrossSheet);
    expect(vertical.down.limit).toEqual(borderOf(sheetOf(0, 1)).acrossSheet);
  });

  it("builds its pill text and metrics from the shared module", () => {
    const pdfSrc = readFileSync(fileURLToPath(new URL("../pdfExport.ts", import.meta.url)), "utf8");
    for (const src of [overlaySrc, pdfSrc]) {
      expect(src).toContain("continuationPillText(");
      expect(src).toContain("PILL_FONT_SIZE_PT");
      expect(src).toContain("PILL_PAD_PT");
      expect(src).toContain("PILL_GAP_PT");
      // No private arrow table left behind to drift from the shared one.
      expect(src).not.toMatch(/\\u219[0-3]/);
    }
  });
});
