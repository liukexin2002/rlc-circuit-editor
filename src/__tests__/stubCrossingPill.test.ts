// A stub leg that crosses a page boundary gets a continuation pill on BOTH surfaces (#361).
//
// The PDF export proxies a stub tag to the far device of its logical connection, so a
// stub leg leaving a sheet prints a pill naming that device. The editor overlay's
// lookup held devices only, so it silently skipped the same crossing — and because
// #357 spreads the pills sharing a page edge as a GROUP, the pill only the PDF had
// also shoved the pills the two surfaces DID share off the preview's positions.
//
// Both surfaces now build the lookup with buildCrossingLabelInfo, so their pill input
// sets match crossing for crossing.

import { afterEach, describe, expect, it } from "vitest";
import { computeCrossingLabels, buildCrossingLabelInfo } from "../crossingLabels";
import { computePdfCrossingLabels } from "../pdfExport";
import { useSchematicStore } from "../store";
import { computePageGrid } from "../printPageGrid";
import { getPaperSize, PAGE_MARGIN_IN } from "../printConfig";
import {
  layoutContinuationPills,
  continuationPillText,
  pillIsRotated,
  titleBlockBandPx,
  titleBlockBandInches,
  PILL_FONT_SIZE_PT,
  PILL_PAD_PT,
  PILL_GAP_PT,
} from "../continuationPill";
import { createDefaultLayout } from "../titleBlockLayout";
import { transformLabel } from "../labelCaseUtils";
import type { RoutedEdge } from "../edgeRouter";
import type { ConnectionEdge, SchematicNode } from "../types";

const LETTER = getPaperSize("letter");
const LAYOUT = createDefaultLayout();
const SCALE = 1;
const DPI = 96;

const asTyped = (label: string | null | undefined) => transformLabel(label, "as-typed");

function device(id: string, label: string, x: number, y: number, ports: unknown[] = []): SchematicNode {
  return {
    id,
    type: "device",
    position: { x, y },
    measured: { width: 144, height: 64 },
    data: { label, ports },
  } as unknown as SchematicNode;
}

function verticalRoute(x: number, y1: number, y2: number): RoutedEdge {
  return {
    segments: [{ x1: x, y1, x2: x, y2, axis: "v" }],
    waypoints: [{ x, y: y1 }, { x, y: y2 }],
    labelX: x,
    labelY: (y1 + y2) / 2,
  } as unknown as RoutedEdge;
}

const pagesFor = (nodes: SchematicNode[]) =>
  computePageGrid(LETTER, "portrait", SCALE, nodes, LAYOUT.heightIn, 0, 0);

// ─── The fixture: one stubbed run whose source leg is dragged onto the next sheet ───

const LINKED = "lnk-361";

/** A camera on the upper sheet, its stub tag dragged down onto the lower one, and the
 *  switcher the partner leg really reaches. Port ids carry the seeded -in/-out shape. */
const camera = device("dev-cam", "CAM-01", 100, 300, [
  { id: "sdi-out-1", label: "SDI Out 1", direction: "output", signalType: "sdi" },
]);
const switcher = device("dev-switcher", "SWITCHER", 100, 1400, [
  { id: "sdi-io-1", label: "SDI I/O 1", direction: "bidirectional", signalType: "sdi" },
]);
const stubSource = {
  id: "stub-src", type: "stub-label", position: { x: 150, y: 1250 },
  measured: { width: 96, height: 14 },
  data: { signalType: "sdi", linkedConnectionId: LINKED, side: "source", placed: true },
} as unknown as SchematicNode;
const stubTarget = {
  id: "stub-tgt", type: "stub-label", position: { x: 150, y: 1300 },
  measured: { width: 96, height: 14 },
  data: { signalType: "sdi", linkedConnectionId: LINKED, side: "target", placed: true },
} as unknown as SchematicNode;

const stubLegs = [
  {
    id: "e-leg-src", source: "dev-cam", target: "stub-src",
    sourceHandle: "sdi-out-1", targetHandle: "l",
    data: { signalType: "sdi", linkedConnectionId: LINKED },
  },
  {
    id: "e-leg-tgt", source: "stub-tgt", target: "dev-switcher",
    sourceHandle: "r", targetHandle: "sdi-io-1-in",
    data: { signalType: "sdi", linkedConnectionId: LINKED },
  },
] as unknown as ConnectionEdge[];

describe("the stub-tag proxy both surfaces share", () => {
  it("names the far device of the logical connection, not the tag", () => {
    const info = buildCrossingLabelInfo([camera, switcher, stubSource, stubTarget], stubLegs, asTyped);
    expect(info.get("stub-src")).toEqual({ label: "SWITCHER", room: undefined });
    expect(info.get("stub-tgt")).toEqual({ label: "CAM-01", room: undefined });
  });

  it("leaves a tag whose partner leg is gone unnamed", () => {
    const info = buildCrossingLabelInfo([camera, switcher, stubSource, stubTarget], [stubLegs[0]], asTyped);
    expect(info.has("stub-src")).toBe(false);
  });
});

describe("editor overlay pills for a stub leg crossing a page edge (#361)", () => {
  const nodes = [camera, switcher, stubSource, stubTarget];
  const pages = pagesFor(nodes);
  // The leg runs from the camera's port straight down onto the next sheet.
  const routed = { "e-leg-src": verticalRoute(158, 364, 1250) };

  it("stacks the run across two sheets", () => {
    expect(pages.map((p) => p.row)).toEqual([0, 1]);
  });

  it("draws a pill on each sheet the stub leg runs between", () => {
    const labels = computeCrossingLabels(pages, routed, stubLegs, nodes, undefined, asTyped);
    expect(labels.map((l) => [l.anchor, l.text, l.pageNum, l.sheet])).toEqual([
      ["up", "SWITCHER", 2, 1],
      ["down", "CAM-01", 1, 2],
    ]);
  });

  it("hands the same crossing to the PDF, on the same sheets", () => {
    const editor = computeCrossingLabels(pages, routed, stubLegs, nodes, undefined, asTyped);
    for (const page of pages) {
      const pdf = computePdfCrossingLabels(page, pages, routed, stubLegs, nodes, SCALE);
      const mine = editor.filter((l) => l.sheet === page.index + 1);
      expect(pdf.map((l) => [l.anchor, l.text, l.pageNum]))
        .toEqual(mine.map((l) => [l.anchor, l.text, l.pageNum]));
      // Same anchor point too, once the canvas pixels are put in sheet inches.
      pdf.forEach((l, i) => {
        expect(l.x).toBeCloseTo(PAGE_MARGIN_IN + (mine[i].x - page.contentX) * SCALE / DPI, 6);
        expect(l.y).toBeCloseTo(PAGE_MARGIN_IN + (mine[i].y - page.contentY) * SCALE / DPI, 6);
      });
    }
  });

  it("keeps the pill rotated onto its vertical wire, with no direction arrow (#357)", () => {
    const [upper] = computeCrossingLabels(pages, routed, stubLegs, nodes, undefined, asTyped);
    expect(pillIsRotated(upper.anchor)).toBe(true);
    expect(continuationPillText(upper.text, upper.pageNum)).toBe("SWITCHER Pg 2");
  });

  it("case-transforms the stub pill the way the PDF does (#294)", () => {
    const upper = computeCrossingLabels(
      pages, routed, stubLegs, nodes, undefined, (l) => transformLabel(l, "uppercase"),
    );
    useSchematicStore.setState({ labelCase: "uppercase" });
    const pdf = computePdfCrossingLabels(pages[0], pages, routed, stubLegs, nodes, SCALE);
    expect(pdf[0].text).toBe(upper[0].text);
  });

  afterEach(() => {
    useSchematicStore.setState({ labelCase: "as-typed" });
  });
});

// The pill the editor used to skip does not merely go missing: layoutContinuationPills
// spreads a page edge's pills as one group, so an extra pill in the PDF's set pushes
// the pills BOTH surfaces draw away from where the preview put them.
describe("a stub pill among the pills the two surfaces share", () => {
  // Four device-to-device runs leaving the bottom of the upper sheet within a pill
  // thickness of each other, plus the stub leg threaded between them.
  const wires = [
    { id: "e-a", x: 150, label: "Lobby Display" },
    { id: "e-b", x: 162, label: "Rack Switch" },
    { id: "e-c", x: 170, label: "Ceiling Speaker 3" },
    { id: "e-d", x: 182, label: "Wall Plate" },
  ];

  const nodes: SchematicNode[] = [camera, switcher, stubSource, stubTarget];
  const edges: ConnectionEdge[] = [...stubLegs];
  const routed: Record<string, RoutedEdge> = { "e-leg-src": verticalRoute(158, 364, 1250) };
  wires.forEach((w, i) => {
    const top = device(`dev-top-${i}`, `Head End ${i + 1}`, 300 + i * 40, 100);
    const bottom = device(`dev-bot-${i}`, w.label, 300 + i * 40, 1200);
    nodes.push(top, bottom);
    edges.push({
      id: w.id, source: top.id, target: bottom.id,
      sourceHandle: "hdmi-out-1", targetHandle: "hdmi-in-1",
      data: { signalType: "hdmi" },
    } as unknown as ConnectionEdge);
    routed[w.id] = verticalRoute(w.x, 164, 1200);
  });

  const pages = pagesFor(nodes);
  const upper = pages[0];
  const marginPx = upper.contentX - upper.x;
  const pxPerPt = marginPx / PAGE_MARGIN_IN / 72;
  const toPageX = (cx: number) => PAGE_MARGIN_IN + (cx - upper.contentX) * SCALE / DPI;
  const toPageY = (cy: number) => PAGE_MARGIN_IN + (cy - upper.contentY) * SCALE / DPI;

  // Neither text engine can be run from here (canvas measureText in the editor,
  // jsPDF's embedded Inter in the export), and they agree to a fraction of a point at
  // 6pt — so one stand-in metric feeds both paths and the placement is compared exactly.
  const measurePt = (text: string) => text.length * 2.6;
  const heightPt = PILL_FONT_SIZE_PT + 2 * PILL_PAD_PT;

  type Pill = { anchor: "left" | "right" | "up" | "down"; x: number; y: number; text: string; pageNum: number };

  const widthPt = (p: Pill) => measurePt(continuationPillText(p.text, p.pageNum)) + 2 * PILL_PAD_PT;

  function editorBoxes(pills: Pill[]) {
    return layoutContinuationPills(
      pills.map((p) => ({
        anchor: p.anchor, x: p.x, y: p.y,
        width: widthPt(p) * pxPerPt,
        height: heightPt * pxPerPt,
        sheet: upper.index + 1,
        limit: { min: upper.contentX, max: upper.contentX + upper.contentW },
      })),
      [titleBlockBandPx(upper, LAYOUT.widthIn, LAYOUT.heightIn)!],
      PILL_GAP_PT * pxPerPt,
    );
  }

  function pdfBoxes(pills: Pill[]) {
    return layoutContinuationPills(
      pills.map((p) => ({
        anchor: p.anchor, x: p.x, y: p.y,
        width: widthPt(p) / 72,
        height: heightPt / 72,
        limit: { min: PAGE_MARGIN_IN, max: LETTER.widthIn - PAGE_MARGIN_IN },
      })),
      [titleBlockBandInches(LETTER.widthIn, LETTER.heightIn, LAYOUT.widthIn, LAYOUT.heightIn)!],
      PILL_GAP_PT / 72,
    );
  }

  const editorPills = () =>
    computeCrossingLabels(pages, routed, edges, nodes, undefined, asTyped)
      .filter((l) => l.sheet === upper.index + 1)
      .map((l) => ({ anchor: l.anchor, x: l.x, y: l.y, text: l.text, pageNum: l.pageNum }));

  const pdfPills = () =>
    computePdfCrossingLabels(upper, pages, routed, edges, nodes, SCALE)
      .map((l) => ({ anchor: l.anchor, x: l.x, y: l.y, text: l.text, pageNum: l.pageNum }));

  it("puts the same five pills on the upper sheet's bottom edge", () => {
    const editor = editorPills();
    const pdf = pdfPills();
    const names = (ps: Pill[]) => ps.map((p) => p.text).sort();
    expect(names(editor)).toEqual(
      ["Ceiling Speaker 3", "Lobby Display", "Rack Switch", "SWITCHER", "Wall Plate"],
    );
    expect(names(pdf)).toEqual(names(editor));
  });

  it("spreads that crowd to the same places on both surfaces", () => {
    const editor = editorBoxes(editorPills());
    const pdf = pdfBoxes(pdfPills());
    // Both sets come out of the same scan, so index i is the same crossing.
    editor.forEach((box, i) => {
      expect(toPageX(box.x)).toBeCloseTo(pdf[i].x, 6);
      expect(toPageY(box.y)).toBeCloseTo(pdf[i].y, 6);
      expect(box.width * SCALE / DPI).toBeCloseTo(pdf[i].width, 6);
      expect(box.height * SCALE / DPI).toBeCloseTo(pdf[i].height, 6);
    });
  });

  // The regression this pins: dropping the stub pill from the editor's set — what the
  // device-only lookup did — moves the pills the two surfaces still share.
  it("would shift the shared pills if the stub pill were missing from one set", () => {
    const all = editorPills();
    const withoutStub = all.filter((p) => p.text !== "SWITCHER");
    const full = editorBoxes(all);
    const short = editorBoxes(withoutStub);
    const shifts = withoutStub.map((p, i) => {
      const j = all.findIndex((q) => q.text === p.text);
      return Math.abs(short[i].x - full[j].x);
    });
    expect(Math.max(...shifts)).toBeGreaterThan(0.05 * (marginPx / PAGE_MARGIN_IN));
  });
});
