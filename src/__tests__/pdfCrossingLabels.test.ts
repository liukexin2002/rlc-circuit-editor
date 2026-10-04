// Off-page continuation labels in the PDF export (#183 feature, #317 bug).
//
// The PDF path re-derives the pills the editor's PageBoundaryOverlay draws, and has to
// decide which of the two pills at a boundary belongs on THIS sheet. It bounded that
// decision against PageRect.contentH, which subtracts the title-block strip — but the
// page raster spans the full sheet inside the print margins and the pills are drawn on
// top of the title block, exactly as in the editor. The mismatch silently dropped every
// pill for a connection leaving the bottom of a page.

import { afterEach, describe, expect, it } from "vitest";
import { computePdfCrossingLabels } from "../pdfExport";
import { useSchematicStore } from "../store";
import { computePageGrid } from "../printPageGrid";
import { getPaperSize, PAGE_MARGIN_IN } from "../printConfig";
import { layoutContinuationPill, titleBlockBandInches } from "../continuationPill";
import { createDefaultLayout } from "../titleBlockLayout";
import type { RoutedEdge } from "../edgeRouter";
import type { ConnectionEdge, SchematicNode } from "../types";

const LETTER = getPaperSize("letter");
const LAYOUT = createDefaultLayout();
const SCALE = 1;
const DPI = 96;

/** Two devices a page apart vertically — forces a 1-column × 2-row page grid. */
const topDevice = {
  id: "dev-rack-switch",
  type: "device",
  position: { x: 100, y: 100 },
  measured: { width: 144, height: 64 },
  data: { label: "Rack Switch", ports: [] },
} as unknown as SchematicNode;

const bottomDevice = {
  id: "dev-lobby-display",
  type: "device",
  position: { x: 100, y: 1200 },
  measured: { width: 144, height: 64 },
  data: { label: "Lobby Display", ports: [] },
} as unknown as SchematicNode;

/** Two devices side by side a page apart horizontally. */
const leftDevice = {
  id: "dev-left",
  type: "device",
  position: { x: 100, y: 100 },
  measured: { width: 144, height: 64 },
  data: { label: "Left Device", ports: [] },
} as unknown as SchematicNode;

const rightDevice = {
  id: "dev-right",
  type: "device",
  position: { x: 1000, y: 100 },
  measured: { width: 144, height: 64 },
  data: { label: "Right Device", ports: [] },
} as unknown as SchematicNode;

function edge(source: string, target: string): ConnectionEdge {
  return {
    id: "e1",
    source,
    target,
    data: { signalType: "ethernet" },
  } as unknown as ConnectionEdge;
}

function verticalRoute(x: number, y1: number, y2: number): RoutedEdge {
  return {
    segments: [{ x1: x, y1, x2: x, y2, axis: "v" }],
    waypoints: [{ x, y: y1 }, { x, y: y2 }],
    labelX: x,
    labelY: (y1 + y2) / 2,
  } as unknown as RoutedEdge;
}

function horizontalRoute(y: number, x1: number, x2: number): RoutedEdge {
  return {
    segments: [{ x1, y1: y, x2, y2: y, axis: "h" }],
    waypoints: [{ x: x1, y }, { x: x2, y }],
    labelX: (x1 + x2) / 2,
    labelY: y,
  } as unknown as RoutedEdge;
}

const pagesFor = (nodes: SchematicNode[]) =>
  computePageGrid(LETTER, "portrait", SCALE, nodes, 1.0, 0, 0);

describe("PDF off-page continuation labels — downward crossings (#317)", () => {
  const nodes = [topDevice, bottomDevice];
  const pages = pagesFor(nodes);
  const edges = [edge(topDevice.id, bottomDevice.id)];
  const routed = { e1: verticalRoute(150, 164, 1200) };

  it("splits the schematic across two stacked pages", () => {
    expect(pages.map((p) => p.row)).toEqual([0, 1]);
  });

  it("labels the wire leaving the BOTTOM of the upper page", () => {
    const labels = computePdfCrossingLabels(pages[0], pages, routed, edges, nodes, SCALE);
    expect(labels).toHaveLength(1);
    expect(labels[0].anchor).toBe("up"); // pill sits above the boundary, arrow points down
    expect(labels[0].text).toBe("Lobby Display");
  });

  it("still labels the wire entering the TOP of the lower page", () => {
    const labels = computePdfCrossingLabels(pages[1], pages, routed, edges, nodes, SCALE);
    expect(labels).toHaveLength(1);
    expect(labels[0].anchor).toBe("down");
    expect(labels[0].text).toBe("Rack Switch");
  });

  // The pill for a bottom exit lands in the strip the title block occupies. That strip is
  // still part of the rasterised page and the pill is drawn after the title block, so it
  // stays inside the sheet — this pins that it is on-page rather than clipped away.
  it("keeps the bottom pill inside the printed sheet", () => {
    const labels = computePdfCrossingLabels(pages[0], pages, routed, edges, nodes, SCALE);
    const pageHIn = LETTER.heightIn;
    expect(labels[0].y).toBeGreaterThan(PAGE_MARGIN_IN);
    expect(labels[0].y).toBeLessThan(pageHIn - PAGE_MARGIN_IN);
    // Below the top of the title block — the case the old contentH bound rejected.
    const titleBlockTopIn = pageHIn - PAGE_MARGIN_IN - 1.0;
    expect(labels[0].y).toBeGreaterThan(titleBlockTopIn);
  });

  it("places the pill an inset inside the page's bottom margin", () => {
    const labels = computePdfCrossingLabels(pages[0], pages, routed, edges, nodes, SCALE);
    const marginPx = pages[0].contentX - pages[0].x;
    const expectedPx = pages[0].y + pages[0].heightPx - marginPx - marginPx * 0.15;
    const expectedIn = PAGE_MARGIN_IN + (expectedPx - pages[0].contentY) * SCALE / DPI;
    expect(labels[0].y).toBeCloseTo(expectedIn, 6);
  });
});

describe("PDF off-page continuation labels — sideways crossings stay put", () => {
  const nodes = [leftDevice, rightDevice];
  const pages = pagesFor(nodes);
  const edges = [edge(leftDevice.id, rightDevice.id)];
  const routed = { e1: horizontalRoute(130, 244, 1000) };

  it("splits the schematic across two side-by-side pages", () => {
    expect(pages.map((p) => p.col)).toEqual([0, 1]);
  });

  it("labels both sides of a left/right boundary", () => {
    const first = computePdfCrossingLabels(pages[0], pages, routed, edges, nodes, SCALE);
    expect(first).toHaveLength(1);
    expect(first[0].anchor).toBe("left");
    expect(first[0].text).toBe("Right Device");

    const second = computePdfCrossingLabels(pages[1], pages, routed, edges, nodes, SCALE);
    expect(second).toHaveLength(1);
    expect(second[0].anchor).toBe("right");
    expect(second[0].text).toBe("Left Device");
  });
});

// Restoring the bottom pill (#317) put it back where the title block is drawn: an
// inset inside the page's bottom margin, which is inside the block's strip. The pill
// is opaque white, so on a connection running down the right-hand side of the sheet it
// wiped the block out. drawCrossingLabels now runs every pill through the shared
// clamp before drawing it.
describe("PDF off-page continuation labels — clear of the title block (#337)", () => {
  const BAND = titleBlockBandInches(LETTER.widthIn, LETTER.heightIn, LAYOUT.widthIn, LAYOUT.heightIn)!;
  // What drawCrossingLabels measures for a pill: 6pt text plus 0.02in padding a side.
  const PILL_H = 6 / 72 + 0.04;
  const PILL_W = 1.1;

  /** A device column that lands under the title block, and its partner a page below. */
  const rightTop = { ...topDevice, position: { x: 540, y: 100 } } as SchematicNode;
  const rightBottom = { ...bottomDevice, position: { x: 540, y: 1200 } } as SchematicNode;

  const nodes = [rightTop, rightBottom];
  const pages = pagesFor(nodes);
  const edges = [edge(rightTop.id, rightBottom.id)];
  const routed = { e1: verticalRoute(590, 164, 1200) };

  it("anchors the bottom pill inside the title-block strip", () => {
    const labels = computePdfCrossingLabels(pages[0], pages, routed, edges, nodes, SCALE);
    expect(labels).toHaveLength(1);
    expect(labels[0].anchor).toBe("up");
    expect(labels[0].x).toBeGreaterThan(BAND.x);
    expect(labels[0].y).toBeGreaterThan(BAND.y);
  });

  it("lifts that pill onto the top edge of the block instead of covering it", () => {
    const [label] = computePdfCrossingLabels(pages[0], pages, routed, edges, nodes, SCALE);
    const box = layoutContinuationPill(
      { anchor: label.anchor, x: label.x, y: label.y, width: PILL_W, height: PILL_H },
      [BAND],
    );
    // Rotated onto its vertical wire: a pill-thickness wide, a text-length tall,
    // its lower end resting on the top of the title block.
    expect(box.width).toBeCloseTo(PILL_H, 6);
    expect(box.height).toBeCloseTo(PILL_W, 6);
    expect(box.x).toBeCloseTo(label.x - PILL_H / 2, 6); // still centred on the wire
    expect(box.y + box.height).toBeCloseTo(BAND.y, 6);
    expect(box.y).toBeGreaterThan(PAGE_MARGIN_IN);
  });

  it("leaves a bottom pill out at the left-hand side of the sheet where it is", () => {
    const leftNodes = [topDevice, bottomDevice];
    const leftPages = pagesFor(leftNodes);
    const leftEdges = [edge(topDevice.id, bottomDevice.id)];
    const [label] = computePdfCrossingLabels(
      leftPages[0], leftPages, { e1: verticalRoute(150, 164, 1200) }, leftEdges, leftNodes, SCALE,
    );
    const box = layoutContinuationPill(
      { anchor: label.anchor, x: label.x, y: label.y, width: PILL_W, height: PILL_H },
      [BAND],
    );
    // The rotated pill runs a PILL_W up the wire from its unmoved anchor: it shares
    // no width with the right-aligned block, so the clamp leaves it alone.
    expect(box.y).toBeCloseTo(label.y - PILL_W, 6);
    expect(box.x + box.width).toBeLessThan(BAND.x);
  });
});

// The pill on a stub leg proxies to the far device of the logical connection, so it has
// to make the same hop the stub tag beside it makes: past a hidden inline adapter to the
// device the run really reaches. Otherwise one printed sheet carries two names for the
// same connection, one of them a device the sheet never draws (#348).
describe("PDF off-page continuation labels — past a hidden inline adapter (#348)", () => {
  const LINKED = "lnk-348b";

  const nodes = [
    {
      id: "dev-cam", type: "device", position: { x: 100, y: 100 },
      measured: { width: 144, height: 64 },
      data: { label: "CAM-01", ports: [{ id: "sdi-out-1", label: "SDI Out 1", direction: "output", signalType: "sdi" }] },
    },
    {
      id: "stub-src", type: "stub-label", position: { x: 130, y: 1200 },
      measured: { width: 96, height: 14 },
      data: { signalType: "sdi", linkedConnectionId: LINKED, side: "source", placed: true },
    },
    {
      id: "stub-tgt", type: "stub-label", position: { x: 130, y: 1240 },
      measured: { width: 96, height: 14 },
      data: { signalType: "sdi", linkedConnectionId: LINKED, side: "target", placed: true },
    },
    {
      id: "dev-adapter", type: "device", position: { x: 130, y: 1290 },
      measured: { width: 1, height: 1 },
      data: {
        label: "BNC Barrel", deviceType: "adapter",
        ports: [
          { id: "bnc-f-1", label: "BNC (F)", direction: "input", signalType: "sdi" },
          { id: "bnc-m-1", label: "BNC (M)", direction: "output", signalType: "sdi" },
        ],
      },
    },
    {
      id: "dev-switcher", type: "device", position: { x: 100, y: 1340 },
      measured: { width: 144, height: 64 },
      data: { label: "SWITCHER", ports: [{ id: "sdi-io-1", label: "SDI I/O 1", direction: "bidirectional", signalType: "sdi" }] },
    },
  ] as unknown as SchematicNode[];

  const edges = [
    { id: "e-leg-src", source: "dev-cam", target: "stub-src", sourceHandle: "sdi-out-1", targetHandle: "l", data: { signalType: "sdi", linkedConnectionId: LINKED } },
    { id: "e-leg-tgt", source: "stub-tgt", target: "dev-adapter", sourceHandle: "r", targetHandle: "bnc-f-1", data: { signalType: "sdi", linkedConnectionId: LINKED } },
    { id: "e-adapter-switcher", source: "dev-adapter", target: "dev-switcher", sourceHandle: "bnc-m-1", targetHandle: "sdi-io-1-in", data: { signalType: "sdi" } },
  ] as unknown as ConnectionEdge[];

  const pages = pagesFor(nodes);
  const routed = { "e-leg-src": verticalRoute(150, 164, 1200) };

  function labelsOnFirstPage(hidden: string[]) {
    useSchematicStore.setState({ hiddenAdapterNodeIds: new Set(hidden) });
    return computePdfCrossingLabels(pages[0], pages, routed, edges, nodes, SCALE);
  }

  afterEach(() => {
    useSchematicStore.setState({ hiddenAdapterNodeIds: new Set() });
  });

  it("splits the adapted run across two stacked pages", () => {
    expect(pages.map((p) => p.row)).toEqual([0, 1]);
  });

  it("names the switcher once the adapter is hidden", () => {
    const labels = labelsOnFirstPage(["dev-adapter"]);
    expect(labels).toHaveLength(1);
    expect(labels[0].anchor).toBe("up");
    expect(labels[0].text).toBe("SWITCHER");
  });

  it("names the adapter while the adapter is drawn", () => {
    const labels = labelsOnFirstPage([]);
    expect(labels).toHaveLength(1);
    expect(labels[0].text).toBe("BNC Barrel");
  });
});

// A boundary line is shared by every page along it: the vertical line between two
// columns runs down all their rows. A crossing on one row was emitting a pill for the
// pages on the OTHER rows too, drawn off the sheet where it was invisible — harmless
// until the spread started sliding pills against each other, at which point a phantom
// pill could shove the real ones about (#357).
describe("PDF off-page continuation labels — crossings on another sheet", () => {
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

  const pages = pagesFor(grid);
  const edges = [edge("dev-bl", "dev-br")];
  // Runs left to right across the BOTTOM row, crossing the column boundary there.
  const routed = { e1: horizontalRoute(1230, 244, 1000) };

  const pageAt = (col: number, row: number) => pages.find((p) => p.col === col && p.row === row)!;

  it("tiles the schematic over four sheets", () => {
    expect(pages).toHaveLength(4);
  });

  it("labels the sheets the crossing actually runs across", () => {
    const left = computePdfCrossingLabels(pageAt(0, 1), pages, routed, edges, grid, SCALE);
    expect(left.map((l) => [l.anchor, l.text])).toEqual([["left", "Bottom Right"]]);
    const right = computePdfCrossingLabels(pageAt(1, 1), pages, routed, edges, grid, SCALE);
    expect(right.map((l) => [l.anchor, l.text])).toEqual([["right", "Bottom Left"]]);
  });

  it("leaves the sheets above it alone", () => {
    expect(computePdfCrossingLabels(pageAt(0, 0), pages, routed, edges, grid, SCALE)).toEqual([]);
    expect(computePdfCrossingLabels(pageAt(1, 0), pages, routed, edges, grid, SCALE)).toEqual([]);
  });
});

// The pill names the sheet the connection carries on to, so the printed page can be
// followed without the editor open. It is the far side of the boundary, never the
// sheet the pill is drawn on (#357).
describe("PDF off-page continuation labels — the sheet the run carries on to", () => {
  const nodes = [topDevice, bottomDevice];
  const pages = pagesFor(nodes);
  const edges = [edge(topDevice.id, bottomDevice.id)];
  const routed = { e1: verticalRoute(150, 164, 1200) };

  it("points the upper sheet's pill at the lower sheet and back", () => {
    const [upper] = computePdfCrossingLabels(pages[0], pages, routed, edges, nodes, SCALE);
    expect(upper.pageNum).toBe(2);
    const [lower] = computePdfCrossingLabels(pages[1], pages, routed, edges, nodes, SCALE);
    expect(lower.pageNum).toBe(1);
  });
});

// Adjacent sheets' print bands do not touch: there is a margin strip either side of
// every boundary that no band claims. Handing each crossing to the sheet whose PAGE it
// falls on — the test the editor overlay uses — keeps the strip covered, where bounding
// against the bands would have dropped these pills from the print while the editor went
// on drawing them (#357).
describe("PDF off-page continuation labels — a crossing in the margin strip", () => {
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

  const pages = pagesFor(grid);
  const pageAt = (col: number, row: number) => pages.find((p) => p.col === col && p.row === row)!;
  const topLeft = pageAt(0, 0);
  const marginPx = topLeft.contentX - topLeft.x;
  // Half a margin above the row boundary: inside the top row's sheet, but below the
  // bottom of the strip it rasterises.
  const stripY = topLeft.y + topLeft.heightPx - marginPx * 0.5;

  const edges = [edge("dev-tl", "dev-tr")];
  const routed = { e1: horizontalRoute(stripY, 244, 1000) };

  it("still labels both sheets the crossing runs between", () => {
    const left = computePdfCrossingLabels(topLeft, pages, routed, edges, grid, SCALE);
    expect(left.map((l) => [l.anchor, l.text])).toEqual([["left", "Top Right"]]);
    const right = computePdfCrossingLabels(pageAt(1, 0), pages, routed, edges, grid, SCALE);
    expect(right.map((l) => [l.anchor, l.text])).toEqual([["right", "Top Left"]]);
  });

  it("leaves the row below it alone", () => {
    expect(computePdfCrossingLabels(pageAt(0, 1), pages, routed, edges, grid, SCALE)).toEqual([]);
    expect(computePdfCrossingLabels(pageAt(1, 1), pages, routed, edges, grid, SCALE)).toEqual([]);
  });
});
