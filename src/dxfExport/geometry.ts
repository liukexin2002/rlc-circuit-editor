import { ARC_R, GAP_HALF } from "../pathfinding";
import type { RoutedEdge } from "../edgeRouter";
import type { ConnectionEdge, LineStyle, SignalType } from "../types";
import type { DxfWriter, EntityStyle } from "./writer";
import { ACI_WHITE, cssFontPxToDxfHeight, pxToIn } from "./units";
import { CANONICAL_LAYERS } from "./layers";

/** Corner-fillet radius on waypoint turns (matches canvas CORNER_RADIUS=8). */
const CORNER_RADIUS_PX = 8;

interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  axis: "h" | "v";
}

interface Point { x: number; y: number }

/**
 * Resolve the effective line style for an edge — per-edge override takes
 * precedence, then per-signal default, then solid.
 */
export function resolveLineStyle(
  edge: ConnectionEdge,
  signalLineStyles: Partial<Record<SignalType, LineStyle>> | undefined,
): LineStyle {
  const dataStyle = edge.data?.lineStyle;
  if (dataStyle) return dataStyle;
  const sig = edge.data?.signalType;
  if (sig && signalLineStyles?.[sig]) return signalLineStyles[sig]!;
  return "solid";
}

/**
 * Return the set of (x, y) screen-px points where other edges' arcs fall
 * on THIS edge's vertical segments. These become gap cuts in the output.
 */
function computeGapCrossings(
  edge: RoutedEdge,
  allArcCrossings: { x: number; y: number }[],
): { x: number; y: number }[] {
  const gaps: { x: number; y: number }[] = [];
  const myArcKeys = new Set(
    (edge.crossingPoints ?? []).map((p) => `${Math.round(p.x)},${Math.round(p.y)}`),
  );
  for (const seg of edge.segments) {
    if (seg.axis !== "v") continue;
    const x = seg.x1;
    const ymin = Math.min(seg.y1, seg.y2);
    const ymax = Math.max(seg.y1, seg.y2);
    for (const cp of allArcCrossings) {
      if (Math.abs(cp.x - x) > 0.5) continue;
      if (cp.y < ymin + 0.5 || cp.y > ymax - 0.5) continue;
      // Skip if this location is also an arc point on this same edge
      const key = `${Math.round(cp.x)},${Math.round(cp.y)}`;
      if (myArcKeys.has(key)) continue;
      gaps.push({ x: cp.x, y: cp.y });
    }
  }
  return gaps;
}

/**
 * Collect every arc crossing point across every routed edge. This is the
 * union used to derive gap cuts for each individual edge.
 */
export function collectAllArcCrossings(
  routedEdges: Record<string, RoutedEdge>,
): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (const r of Object.values(routedEdges)) {
    for (const cp of r.crossingPoints ?? []) out.push(cp);
  }
  return out;
}

/**
 * Emit the geometry of a single routed edge:
 *  - Orthogonal waypoint path as LINE entities with fillet ARC corners
 *  - Arc hops on horizontal segments where other edges cross
 *  - Gap cuts on vertical segments where another edge hops over
 */
export function emitEdgeGeometry(
  writer: DxfWriter,
  routed: RoutedEdge,
  layer: string,
  style: EntityStyle,
  allArcCrossings: { x: number; y: number }[],
) {
  const arcPts = routed.crossingPoints ?? [];
  const gapPts = computeGapCrossings(routed, allArcCrossings);
  emitRoundedWaypointPath(writer, routed.waypoints, arcPts, gapPts, layer, style);
}

/**
 * Walk a waypoint list and emit it as a rounded path:
 *  - Each straight segment is emitted with its ends trimmed by CORNER_RADIUS_PX
 *    at every interior corner (first/last segment endpoints are never trimmed).
 *  - A fillet ARC is drawn at every interior waypoint connecting the trimmed
 *    endpoints of its two adjacent segments.
 *  - Arc hops and gap cuts are applied to the trimmed straight runs.
 *
 * All inputs are in screen-pixel coordinates. This function handles the Y-flip
 * and inch conversion for DXF output.
 */
export function emitRoundedWaypointPath(
  writer: DxfWriter,
  waypoints: Point[],
  arcHops: Point[],
  gaps: Point[],
  layer: string,
  style: EntityStyle,
) {
  const n = waypoints.length;
  if (n < 2) return;
  const r = CORNER_RADIUS_PX;

  // Compute direction + axis for every consecutive pair
  interface SegInfo { a: Point; b: Point; dir: Point; axis: "h" | "v"; len: number }
  const segs: SegInfo[] = [];
  for (let i = 0; i < n - 1; i++) {
    const a = waypoints[i], b = waypoints[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 0.5) continue;
    const dir = { x: dx / len, y: dy / len };
    const axis: "h" | "v" = Math.abs(dir.y) < Math.abs(dir.x) ? "h" : "v";
    segs.push({ a, b, dir, axis, len });
  }
  if (segs.length === 0) return;

  // Emit trimmed straight segments with hops/gaps
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const trimStart = i > 0;
    const trimEnd = i < segs.length - 1;
    // Clamp trim so a short segment doesn't reverse direction
    const maxTrim = s.len / 2 - 0.001;
    const startTrim = trimStart ? Math.min(r, maxTrim) : 0;
    const endTrim = trimEnd ? Math.min(r, maxTrim) : 0;
    const sx = s.a.x + startTrim * s.dir.x;
    const sy = s.a.y + startTrim * s.dir.y;
    const ex = s.b.x - endTrim * s.dir.x;
    const ey = s.b.y - endTrim * s.dir.y;
    if (s.axis === "h") {
      emitHorizontalRun(writer, sx, ex, sy, arcHops, layer, style);
    } else {
      emitVerticalRun(writer, sy, ey, sx, gaps, layer, style);
    }
  }

  // Emit fillet arcs at interior waypoints (between adjacent segments)
  for (let i = 0; i < segs.length - 1; i++) {
    const dIn = segs[i].dir;
    const dOut = segs[i + 1].dir;
    // Skip if segments are colinear (no real turn)
    if (Math.abs(dIn.x * dOut.y - dIn.y * dOut.x) < 0.01) continue;
    emitCornerArc(writer, segs[i].b, dIn, dOut, r, layer, style);
  }
}

function emitHorizontalRun(
  writer: DxfWriter,
  x1: number, x2: number, y: number,
  hops: Point[],
  layer: string,
  style: EntityStyle,
) {
  const arcR = ARC_R;
  const goingRight = x2 > x1;
  const minX = Math.min(x1, x2);
  const maxX = Math.max(x1, x2);
  const onSeg = hops
    .filter((p) => Math.abs(p.y - y) < 0.5 && p.x > minX + arcR && p.x < maxX - arcR)
    .map((p) => p.x)
    .sort((a, b) => a - b);
  if (onSeg.length === 0) {
    emitLinePx(writer, x1, y, x2, y, layer, style);
    return;
  }
  const ordered = goingRight ? onSeg : onSeg.slice().reverse();
  let cursor = x1;
  for (const hx of ordered) {
    const preX = goingRight ? hx - arcR : hx + arcR;
    emitLinePx(writer, cursor, y, preX, y, layer, style);
    emitHopArcPx(writer, hx, y, arcR, layer, style);
    cursor = goingRight ? hx + arcR : hx - arcR;
  }
  emitLinePx(writer, cursor, y, x2, y, layer, style);
}

function emitVerticalRun(
  writer: DxfWriter,
  y1: number, y2: number, x: number,
  gaps: Point[],
  layer: string,
  style: EntityStyle,
) {
  const gapHalf = GAP_HALF;
  const goingDown = y2 > y1;
  const minY = Math.min(y1, y2);
  const maxY = Math.max(y1, y2);
  const onSeg = gaps
    .filter((p) => Math.abs(p.x - x) < 0.5 && p.y > minY + gapHalf && p.y < maxY - gapHalf)
    .map((p) => p.y)
    .sort((a, b) => a - b);
  if (onSeg.length === 0) {
    emitLinePx(writer, x, y1, x, y2, layer, style);
    return;
  }
  const ordered = goingDown ? onSeg : onSeg.slice().reverse();
  let cursor = y1;
  for (const gy of ordered) {
    const preY = goingDown ? gy - gapHalf : gy + gapHalf;
    emitLinePx(writer, x, cursor, x, preY, layer, style);
    cursor = goingDown ? gy + gapHalf : gy - gapHalf;
  }
  emitLinePx(writer, x, cursor, x, y2, layer, style);
}

/** LINE entity from screen-px coords (converts to DXF inches with Y flip). */
function emitLinePx(
  writer: DxfWriter,
  x1: number, y1: number,
  x2: number, y2: number,
  layer: string,
  style: EntityStyle,
) {
  writer.addLine(layer, pxToIn(x1), -pxToIn(y1), pxToIn(x2), -pxToIn(y2), style);
}

/**
 * Semicircle hop arc centered at (cxPx, cyPx) bulging "up" (toward smaller
 * screen-Y, i.e. larger DXF-Y). In DXF coords the arc spans 0°→180° CCW
 * (upper half-circle around the center), identical regardless of traversal
 * direction — the arc is a shape, not a directed path.
 */
function emitHopArcPx(
  writer: DxfWriter,
  cxPx: number, cyPx: number, rPx: number,
  layer: string,
  style: EntityStyle,
) {
  writer.addArc(layer, pxToIn(cxPx), -pxToIn(cyPx), pxToIn(rPx), 0, 180, style);
}

/**
 * Fillet arc at a waypoint corner. `w` is the corner point, `dIn` is the
 * (screen-px) unit direction entering the corner, `dOut` is the unit
 * direction leaving it. Both are orthogonal for router paths.
 *
 * We compute the arc centre (offset r from the corner along the bisector),
 * the tangent points on each adjacent segment, and the start/end angles
 * such that DXF's always-CCW rendering produces the short arc fillet.
 */
function emitCornerArc(
  writer: DxfWriter,
  w: Point, dIn: Point, dOut: Point, rPx: number,
  layer: string,
  style: EntityStyle,
) {
  // Screen-space centre + tangent points
  const cx = w.x - rPx * dIn.x + rPx * dOut.x;
  const cy = w.y - rPx * dIn.y + rPx * dOut.y;
  const pInX = w.x - rPx * dIn.x, pInY = w.y - rPx * dIn.y;
  const pOutX = w.x + rPx * dOut.x, pOutY = w.y + rPx * dOut.y;

  // DXF conversion
  const cxIn = pxToIn(cx), cyIn = -pxToIn(cy);
  const rIn = pxToIn(rPx);
  const angIn = (Math.atan2(-pxToIn(pInY) - cyIn, pxToIn(pInX) - cxIn) * 180) / Math.PI;
  const angOut = (Math.atan2(-pxToIn(pOutY) - cyIn, pxToIn(pOutX) - cxIn) * 180) / Math.PI;

  // Turn direction — cross product in DXF coords (Y-flip negates screen cross)
  const crossScreen = dIn.x * dOut.y - dIn.y * dOut.x;
  const ccwInDxf = -crossScreen > 0;

  let startDeg = ccwInDxf ? angIn : angOut;
  let endDeg = ccwInDxf ? angOut : angIn;
  startDeg = ((startDeg % 360) + 360) % 360;
  endDeg = ((endDeg % 360) + 360) % 360;
  writer.addArc(layer, cxIn, cyIn, rIn, startDeg, endDeg, style);
}

// ─── Label emission (cable ID, custom, stub) ─────────────────────────────

/**
 * Position a label along a route by either finding the midpoint of the
 * longest segment ("midpoint" mode) or offsetting from the route endpoint
 * ("endpoint" mode).
 */
export function findMidpointLabelPos(routed: RoutedEdge, offsetPx = 0): { x: number; y: number; rotationDeg: number } {
  // Find the longest segment (prefer horizontal if tied)
  let best: Segment | undefined;
  let bestLen = -Infinity;
  for (const s of routed.segments) {
    const len = s.axis === "h" ? Math.abs(s.x2 - s.x1) : Math.abs(s.y2 - s.y1);
    const score = len + (s.axis === "h" ? 0.1 : 0);
    if (score > bestLen) { bestLen = score; best = s; }
  }
  if (!best) return { x: routed.labelX, y: routed.labelY, rotationDeg: 0 };
  const mx = (best.x1 + best.x2) / 2;
  const my = (best.y1 + best.y2) / 2 + (best.axis === "h" ? offsetPx : 0);
  return { x: mx, y: my, rotationDeg: 0 };
}

export function findEndpointLabelPos(
  routed: RoutedEdge,
  nearStart: boolean,
  gapPx: number,
): { x: number; y: number; rotationDeg: number } {
  const pts = routed.waypoints;
  if (pts.length < 2) return { x: routed.labelX, y: routed.labelY, rotationDeg: 0 };

  if (nearStart) {
    const a = pts[0], b = pts[1];
    const t = gapPx / Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
    return {
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      rotationDeg: 0,
    };
  } else {
    const a = pts[pts.length - 2], b = pts[pts.length - 1];
    const t = gapPx / Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
    return {
      x: b.x - (b.x - a.x) * t,
      y: b.y - (b.y - a.y) * t,
      rotationDeg: 0,
    };
  }
}

// Canvas connection-label chip (OffsetEdge `cableIdLabelStyle` / `customLabelStyle`):
// opaque white ground, `padding: 0 3px`, 1px signal-colored border, 2px radius.
const CHIP_PAD_X_PX = 3;
/** Half the leading a 9px label gets at the browser's default line-height. */
const CHIP_PAD_Y_PX = 1.6;
/** Per-character advance as a fraction of CSS font size — matches OffsetEdge's
 *  `estimateBadgeWidth`, which sizes the same chips on the canvas. */
const CHIP_CHAR_ASPECT = 0.58;
const CHIP_BORDER_PX = 1;
const CHIP_RADIUS_IN = 2 / 96;

/**
 * Emit a connection label the way the canvas draws it: an opaque white chip with a
 * signal-colored border, then the text over it. `cxPx`/`cyPx` is the chip centre in
 * screen px.
 *
 * The chip is what actually fixes #298. Ordering the labels after the geometry keeps
 * OTHER connections off the text, but a cable ID sits ON its own routed line by
 * construction — "endpoint" mode anchors it middle-centre on the polyline, and
 * "midpoint" mode only offsets when the longest segment is horizontal — and DXF text
 * has no fill area, so glyphs never occlude what is under them however late they are
 * written. MTEXT background fill would mask it in AutoCAD/TrueView but LibreCAD
 * ignores that group, which is why the issue asks for a real mask entity.
 *
 * The ground is a SOLID, not a HATCH: it goes under every cable ID in every export,
 * so it has to be an entity no consumer can refuse (#333).
 *
 * The MTEXT then carries a background fill as well, so the label is masked twice. The
 * two mechanisms cover different readers and neither one covers both: LibreCAD fills
 * SOLID but cannot even parse the background-fill groups (libdxfrw drops 90/63/45/441
 * before the renderer ever sees them), while readers that decline SOLID have the
 * background fill to fall back on. Illustrator is the reason this matters and is
 * undocumented on both counts, so the chip carries both rather than betting on one.
 * Drawing order is unaffected: the background belongs to the MTEXT itself, so it can
 * never land under its own glyphs or over a later-emitted connection.
 *
 * Both grounds use ACI 255, not 7. ACI 7 is the adaptive white/black pseudo-colour —
 * an opaque "white" chip written as 7 prints solid BLACK over its own text on white
 * paper in AutoCAD.
 *
 * The SOLID is sized from `estimateBadgeWidth`'s character-advance estimate, the same
 * one the canvas uses, while the MTEXT background is sized by the reader from the real
 * glyph metrics. In a reader that honours both, the wider of the two wins and can
 * overpaint the border by a hair. Cosmetic, and the alternative — dropping one ground —
 * costs a reader its only mask.
 */
function emitLabelChip(
  writer: DxfWriter,
  cxPx: number, cyPx: number,
  text: string,
  fontPx: number,
  trueColor: number,
) {
  const wPx = text.length * fontPx * CHIP_CHAR_ASPECT + 2 * CHIP_PAD_X_PX + 2 * CHIP_BORDER_PX;
  const hPx = fontPx + 2 * CHIP_PAD_Y_PX + 2 * CHIP_BORDER_PX;
  const x = pxToIn(cxPx - wPx / 2);
  const y = -pxToIn(cyPx + hPx / 2);
  const w = pxToIn(wPx);
  const h = pxToIn(hPx);

  writer.addSolidFillRect(
    CANONICAL_LAYERS.LABELS, x, y, w, h,
    { trueColor: 0xffffff, aci: ACI_WHITE },
  );
  writer.addRoundedRect(
    CANONICAL_LAYERS.LABELS, x, y, w, h, CHIP_RADIUS_IN,
    { trueColor, linetype: "CONTINUOUS" },
  );
  writer.addMText(
    CANONICAL_LAYERS.LABELS,
    pxToIn(cxPx), -pxToIn(cyPx),
    text,
    {
      height: cssFontPxToDxfHeight(fontPx),
      attachment: 5,
      style: { trueColor, linetype: "CONTINUOUS" },
      backgroundAci: ACI_WHITE,
      backgroundScale: 1.2,
    },
  );
}

/**
 * Emit cable ID label(s) for an edge.
 *
 * `stubEnd` names the endpoint terminating at a stub-label box, if any. The endpoint
 * cable ID is suppressed there, matching the canvas: the stub box already identifies
 * the connection, and printing the ID at both the device port AND the stub label would
 * put four IDs on one logical cable instead of two.
 */
export function emitCableIdLabels(
  writer: DxfWriter,
  edge: ConnectionEdge,
  routed: RoutedEdge,
  mode: "endpoint" | "midpoint",
  globalGap: number,
  globalMidOffset: number,
  trueColor: number,
  stubEnd: "source" | "target" | null = null,
) {
  if (!edge.data?.cableId) return;
  if (edge.data?.hideCableId) return;

  const gap = edge.data?.cableIdGap ?? globalGap;
  const midOffset = edge.data?.cableIdMidOffset ?? globalMidOffset;
  const effectiveMode = edge.data?.cableIdLabelMode ?? mode;

  if (effectiveMode === "midpoint") {
    const pos = findMidpointLabelPos(routed, midOffset);
    emitLabelChip(writer, pos.x, pos.y, edge.data.cableId, 9, trueColor);
  } else {
    // Emit at both ends, minus any end that terminates at a stub label.
    for (const nearStart of [true, false]) {
      if (nearStart && stubEnd === "source") continue;
      if (!nearStart && stubEnd === "target") continue;
      const pos = findEndpointLabelPos(routed, nearStart, gap);
      emitLabelChip(writer, pos.x, pos.y, edge.data.cableId, 9, trueColor);
    }
  }
}

/** Emit custom labels for an edge. Three independent slots: sourceLabel at
 *  the source endpoint, label at the midpoint, targetLabel at the target
 *  endpoint. Each slot renders iff its text is non-empty (#114).
 *
 *  On a stub leg, `stubEnd` names the endpoint that terminates at the stub-label
 *  box; the middle label is then anchored just inside that end so it reads
 *  between the cable ID and the stub label, matching the canvas (#201).
 *
 *  Custom labels are free text, so their chips lean hardest on the character-advance
 *  width estimate — see `emitLabelChip` for why a reader honouring both grounds can
 *  paint the MTEXT background a hair wider than the SOLID and its border. */
export function emitCustomLabel(
  writer: DxfWriter,
  edge: ConnectionEdge,
  routed: RoutedEdge,
  trueColor: number,
  stubEnd: "source" | "target" | null = null,
) {
  const sourceLabel = edge.data?.sourceLabel as string | undefined;
  const midLabel = edge.data?.label as string | undefined;
  const targetLabel = edge.data?.targetLabel as string | undefined;
  if (!sourceLabel && !midLabel && !targetLabel) return;

  const fontPx = 9; // matches canvas customLabelStyle, sized to the cable ID chip (#209)
  const gap = 4; // matches canvas CUSTOM_LABEL_GAP

  if (sourceLabel) {
    const pos = findEndpointLabelPos(routed, true, gap);
    emitLabelChip(writer, pos.x, pos.y, sourceLabel, fontPx, trueColor);
  }
  if (midLabel) {
    const pos = stubEnd
      ? findEndpointLabelPos(routed, stubEnd === "source", gap)
      : findMidpointLabelPos(routed, 0);
    emitLabelChip(writer, pos.x, pos.y, midLabel, fontPx, trueColor);
  }
  if (targetLabel) {
    const pos = findEndpointLabelPos(routed, false, gap);
    emitLabelChip(writer, pos.x, pos.y, targetLabel, fontPx, trueColor);
  }
}

/** Emit a stub end marker (arrow + device name + room + page).
 *
 *  Currently unreferenced — stub ends became first-class `stub-label` nodes and are
 *  emitted by `emitStubLabel` instead. Kept, but its background fill uses ACI 255 like
 *  every other ground here, so wiring it back up can't reintroduce the adaptive 7. */
export function emitStubEnd(
  writer: DxfWriter,
  endPt: { x: number; y: number },
  towardPt: { x: number; y: number },
  text: string,
  trueColor: number,
) {
  const dx = endPt.x - towardPt.x;
  const dy = endPt.y - towardPt.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const arrowLen = 8;
  const arrowWidth = 4;

  // Arrowhead: two short lines forming a ">"
  const tipX = endPt.x, tipY = endPt.y;
  const baseX = tipX - ux * arrowLen;
  const baseY = tipY - uy * arrowLen;
  const perpX = -uy * arrowWidth;
  const perpY = ux * arrowWidth;

  const style: EntityStyle = { trueColor };
  writer.addLine(
    CANONICAL_LAYERS.LABELS,
    pxToIn(tipX), -pxToIn(tipY),
    pxToIn(baseX + perpX), -pxToIn(baseY + perpY),
    style,
  );
  writer.addLine(
    CANONICAL_LAYERS.LABELS,
    pxToIn(tipX), -pxToIn(tipY),
    pxToIn(baseX - perpX), -pxToIn(baseY - perpY),
    style,
  );

  // Label text beyond the arrow tip in the outward direction
  const labelX = tipX + ux * 4;
  const labelY = tipY + uy * 4;
  writer.addMText(
    CANONICAL_LAYERS.LABELS,
    pxToIn(labelX), -pxToIn(labelY),
    text,
    {
      height: cssFontPxToDxfHeight(9), // matches canvas 9pt stub label
      attachment: 5,
      style: { trueColor },
      backgroundAci: ACI_WHITE,
      backgroundScale: 1.2,
    },
  );
}
