/**
 * RLC → routing bridge.
 *
 * The upstream editor ships a battle-tested orthogonal A* router (src/pathfinding.ts +
 * src/edgeRouter.ts): direction-aware state, turn penalties, overlap penalties, a
 * deterministic work budget, grid-snapped endpoints. That engine was written for an AV
 * editor whose ports only ever face left/right — its goal test accepts horizontal
 * arrivals only. This bridge reuses the same engine in a four-way world (a rotated RLC
 * part's pin can face any of up/down/left/right) via the explicit start/end direction
 * parameters added to `astarOrthogonal` for exactly this purpose.
 *
 * Routing a wire is a sequence of ATTEMPTS from strictest to most permissive, and the
 * first attempt that produces a path wins. The attempt that succeeded is reported as the
 * wire's `quality`, so the UI can warn honestly instead of pretending everything is fine:
 *
 *   clean   — comfort clearance around every part (2 cells).
 *   tight   — calibrated clearance (1 cell): the engine's tuned operating point.
 *   crowded — every part BODY avoided, but pads could not be honoured.
 *   escape  — not even all bodies could be avoided (a pin walled in by other parts, or the
 *             search budget exhausted). Always orthogonal, always anchored on the pins,
 *             always leaving each pin along its facing.
 *
 * Wires already routed in the same pass are NOT hard obstacles — they are penalty zones.
 * Hard-blocking them makes two wires that share a corridor mutually exclusive, which forces
 * the later one into `escape` and then lets an even later wire collide with the first.
 * Penalty zones instead make a wire PREFER another corridor while still allowing a shared
 * one when geometry leaves no alternative, which is how a schematic reads.
 *
 * Correctness is MEASURED, never assumed: `crossedObstacles`, `isOrthogonalPolyline`,
 * `endStubLengths` and `parallelOverlapCells` re-derive the rules from the router's own
 * output, and `routeOneWire` refuses an attempt whose result fails its own body check. The
 * unit tests gate on those same measurements.
 */

import {
  astarOrthogonal,
  anchorRouteEndpoints,
  buildGlobalGrid,
  cellSize,
  g2px,
  pixelRectsToGrid,
  px2g,
  simplifyWaypoints,
  tuckSubgridSteps,
  waypointsToSvgPath,
  type IntGrid,
  type PenaltyZone,
  type Point,
  type Rect as RouteRect,
} from "../pathfinding";
import {
  obstacleRect,
  pinPos,
  pinSide,
  isPinEndpoint,
  type PinSide,
  type Pt,
  type RlcDoc,
  type RlcEdge,
  type RlcEdgeEndpoint,
  type RlcPinEndpoint,
  type RlcWireGeometry,
} from "./rlcModel";
import {
  COMFORT_PAD,
  OBSTACLE_PAD,
  STUB_CELLS,
  TAP_ENDPOINT_INSET,
  TAP_MAX_CANDIDATES,
  WIRE_CORNER_RADIUS,
} from "./rlcConstants";

// Direction indices used by astarOrthogonal: 0=right, 1=down, 2=left, 3=up.
const SIDE_TO_DIR: Record<PinSide, number> = { right: 0, down: 1, left: 2, up: 3 };
const OPPOSITE_DIR = [2, 3, 0, 1];
const SIDE_TO_VEC: Record<PinSide, Point> = {
  right: { x: 1, y: 0 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  up: { x: 0, y: -1 },
};

const isHorizontalSide = (s: PinSide) => s === "left" || s === "right";

/** How faithfully a wire honours the obstacle set. */
export type RlcWireQuality = "clean" | "tight" | "crowded" | "escape";

export interface RlcRoutedWire {
  edgeId: string;
  /** Full orthogonal polyline, pin to pin, exactly anchored on both pins. */
  waypoints: Point[];
  /** SVG path with rounded corners. */
  svgPath: string;
  quality: RlcWireQuality;
  /** Convenience flag: any quality other than `clean` gets a warning colour. */
  degraded: boolean;
  /** Number of 90° turns, for objective comparison and reporting. */
  turns: number;
}

export interface RlcRouteResult {
  wires: Record<string, RlcRoutedWire>;
  /** Wires that did not route fully clear — surfaced in the UI as a warning badge. */
  degradedCount: number;
}

export interface RlcEndpointGeometry {
  pos: Point;
  side: PinSide;
  componentId: string;
}

/** Resolve one edge endpoint to a pin position + facing, or null if the part is gone. */
export function endpointGeometry(
  doc: RlcDoc,
  componentId: string,
  pinId: "p0" | "p1",
): RlcEndpointGeometry | null {
  const comp = doc.components.find((c) => c.id === componentId);
  if (!comp) return null;
  return { pos: pinPos(comp, pinId), side: pinSide(comp, pinId), componentId };
}

/**
 * The component an endpoint belongs to, or null for a tap (which belongs to a wire, not a
 * part). Keeps callers that only know about parts working after taps were introduced.
 */
export function endpointComponentId(e: RlcEdgeEndpoint): string | null {
  return isPinEndpoint(e) ? e.componentId : null;
}

// ── Tap geometry (Steiner points on an existing wire) ───────────────────────

/** Axis of the polyline segment that contains `p`; "h" if p sits on a horizontal run. */
export function segmentAxisAt(pts: readonly Point[], p: Point): "h" | "v" {
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (a.y === b.y && p.y === a.y && p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x)) return "h";
    if (a.x === b.x && p.x === a.x && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y)) return "v";
  }
  // Off the polyline (should not happen after projection): fall back to the dominant axis.
  return Math.abs(pts[pts.length - 1].y - pts[0].y) > Math.abs(pts[pts.length - 1].x - pts[0].x) ? "v" : "h";
}

/** The sides from which a wire may APPROACH a point on a host wire: perpendicular to it. */
export function tapApproachSides(hostPts: readonly Point[], junction: Point): PinSide[] {
  return segmentAxisAt(hostPts, junction) === "h" ? ["up", "down"] : ["left", "right"];
}

/**
 * Every lattice point ON a polyline, in path order, excluding `insetCells` cells at each end.
 *
 * This is the candidate set for a tap junction: a junction must lie on the host wire, and it
 * must sit on the routing lattice or the stub geometry would be off-grid.
 */
export function polylineLatticePoints(pts: readonly Point[], insetCells = TAP_ENDPOINT_INSET): Point[] {
  const cs = cellSize();
  const out: Point[] = [];
  const seen = new Set<string>();
  // Total number of cells along the path, so `insetCells` can be applied from both ends.
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    total += Math.abs(Math.round((pts[i].x - pts[i - 1].x) / cs)) + Math.abs(Math.round((pts[i].y - pts[i - 1].y) / cs));
  }
  if (total <= insetCells * 2) return [];
  let walked = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const ax = Math.round(a.x / cs);
    const ay = Math.round(a.y / cs);
    const bx = Math.round(b.x / cs);
    const by = Math.round(b.y / cs);
    const sx = Math.sign(bx - ax);
    const sy = Math.sign(by - ay);
    let cx = ax;
    let cy = ay;
    while (cx !== bx || cy !== by) {
      const inRange = walked >= insetCells && walked < total - insetCells;
      if (inRange) {
        const key = `${cx},${cy}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push({ x: cx * cs, y: cy * cs });
        }
      }
      cx += sx;
      cy += sy;
      walked++;
    }
  }
  return out;
}

/**
 * Snap an arbitrary stored tap point onto the host polyline (nearest lattice point on it).
 *
 * Taps are stored as absolute coordinates so a saved file reproduces exactly. When the host
 * wire is later re-routed its polyline changes, and this projection is what keeps the
 * junction ON the host instead of leaving it floating where the wire used to be.
 */
export function projectTapOntoHost(hostPts: readonly Point[], p: Point): Point | null {
  const cands = polylineLatticePoints(hostPts, TAP_ENDPOINT_INSET);
  if (cands.length === 0) return null;
  let best = cands[0];
  let bestD = Math.abs(best.x - p.x) + Math.abs(best.y - p.y);
  for (const c of cands) {
    const d = Math.abs(c.x - p.x) + Math.abs(c.y - p.y);
    if (d < bestD) {
      best = c;
      bestD = d;
    }
  }
  return best;
}

/** Obstacle rects (world px) for every component, minus the excluded ids, grown by `padPx`. */
export function rlcObstacles(
  doc: RlcDoc,
  excludeIds: readonly string[] = [],
  padPx: number = OBSTACLE_PAD,
): RouteRect[] {
  const exclude = new Set(excludeIds);
  return doc.components
    .filter((c) => !exclude.has(c.id))
    .map((c) => {
      const r = obstacleRect(c, padPx);
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, nodeId: c.id };
    });
}

/** Body-only obstacle rects (no pad) — the hard rule a wire may never break. */
export function rlcBodyRects(doc: RlcDoc, excludeIds: readonly string[] = []): RouteRect[] {
  return rlcObstacles(doc, excludeIds, 0);
}

// ── Measurement helpers (verify, don't trust) ───────────────────────────────

export function isOrthogonalPolyline(pts: readonly Point[], eps = 0.001): boolean {
  for (let i = 1; i < pts.length; i++) {
    const dx = Math.abs(pts[i].x - pts[i - 1].x);
    const dy = Math.abs(pts[i].y - pts[i - 1].y);
    if (dx > eps && dy > eps) return false;
  }
  return true;
}

/** Axis-aligned segment vs rect intersection, touching edges included. */
export function segmentIntersectsRect(a: Point, b: Point, r: RouteRect): boolean {
  const lox = Math.min(a.x, b.x);
  const hix = Math.max(a.x, b.x);
  const loy = Math.min(a.y, b.y);
  const hiy = Math.max(a.y, b.y);
  return lox <= r.right && hix >= r.left && loy <= r.bottom && hiy >= r.top;
}

/**
 * Which obstacles this polyline crosses.
 *
 * A wire legitimately occupies the pad band of the two components it connects — its pin
 * stubs live there. Those exemptions are SEGMENT-SCOPED: only the first segment is exempt
 * from the source component and only the last segment from the target component, so a
 * wire that doubles back over its own body is still caught.
 */
export function crossedObstacles(
  doc: RlcDoc,
  edge: RlcEdge,
  waypoints: readonly Point[],
  opts: { padPx?: number } = {},
): { componentId: string; segmentIndex: number }[] {
  const padPx = opts.padPx ?? OBSTACLE_PAD;
  const hits: { componentId: string; segmentIndex: number }[] = [];
  const last = waypoints.length - 1;
  // Only a PIN endpoint owns a component whose pad band the stub may legitimately occupy.
  // A tap endpoint owns no component (it sits on a wire), so it exempts nothing.
  const fromComp = isPinEndpoint(edge.from) ? edge.from.componentId : null;
  const toComp = isPinEndpoint(edge.to) ? edge.to.componentId : null;
  for (const c of doc.components) {
    const r = obstacleRect(c, padPx);
    const rect: RouteRect = { left: r.left, top: r.top, right: r.right, bottom: r.bottom, nodeId: c.id };
    for (let i = 1; i <= last; i++) {
      if (i === 1 && c.id === fromComp) continue;
      if (i === last && c.id === toComp) continue;
      if (segmentIntersectsRect(waypoints[i - 1], waypoints[i], rect)) {
        hits.push({ componentId: c.id, segmentIndex: i });
        break;
      }
    }
  }
  return hits;
}

/** True when the polyline crosses any component body (the hard rule). */
function crossesAnyBody(doc: RlcDoc, edge: RlcEdge, waypoints: readonly Point[]): boolean {
  return crossedObstacles(doc, edge, waypoints, { padPx: 0 }).length > 0;
}

/** Count 90° turns in an orthogonal polyline. */
export function countTurns(pts: readonly Point[]): number {
  let turns = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const inDx = Math.sign(pts[i].x - pts[i - 1].x);
    const inDy = Math.sign(pts[i].y - pts[i - 1].y);
    const outDx = Math.sign(pts[i + 1].x - pts[i].x);
    const outDy = Math.sign(pts[i + 1].y - pts[i].y);
    if (inDx !== outDx || inDy !== outDy) turns++;
  }
  return turns;
}

/** Length of the straight run leaving/entering a pin, in px. */
export function endStubLengths(pts: readonly Point[]): { start: number; end: number } {
  if (pts.length < 2) return { start: 0, end: 0 };
  const d = (a: Point, b: Point) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  return {
    start: d(pts[0], pts[1]),
    end: d(pts[pts.length - 2], pts[pts.length - 1]),
  };
}

/** Grid cells visited by a polyline, plus the axis used to enter each one. */
export function occupiedCells(pts: readonly Point[]): Map<string, "h" | "v"> {
  const cells = new Map<string, "h" | "v">();
  const cs = cellSize();
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const ax = Math.round(a.x / cs);
    const ay = Math.round(a.y / cs);
    const bx = Math.round(b.x / cs);
    const by = Math.round(b.y / cs);
    const axis: "h" | "v" = ay === by ? "h" : "v";
    const sx = Math.sign(bx - ax);
    const sy = Math.sign(by - ay);
    let cx = ax;
    let cy = ay;
    cells.set(`${cx},${cy}`, axis);
    while (cx !== bx || cy !== by) {
      cx += sx;
      cy += sy;
      cells.set(`${cx},${cy}`, axis);
    }
  }
  return cells;
}

/**
 * Cells where two wires travel side by side on the SAME axis, EXCLUDING each wire's own
 * stub cells.
 *
 * Two exemptions matter here, and both are geometry rather than policy:
 *
 *   - Perpendicular crossings are normal schematic geometry: a horizontal run meeting a
 *     vertical run is how wires reach their destinations.
 *   - The single cell immediately at each pin is shared whenever two wires leave pins that
 *     sit on the same lattice row or column — unavoidable, since that cell IS the pin's
 *     own corridor. The rule only becomes meaningful from the second cell outward, which
 *     is exactly where the router starts making choices.
 */
export function parallelOverlapCells(a: readonly Point[], b: readonly Point[]): string[] {
  const ca = occupiedCells(a);
  const cb = occupiedCells(b);
  const exempt = new Set<string>();
  const cs = cellSize();

  /** Cells within `radius` of an endpoint cell, as a square neighbourhood. */
  const exemptNear = (p: Point) => {
    const cx = Math.round(p.x / cs);
    const cy = Math.round(p.y / cs);
    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = -2; dy <= 2; dy++) exempt.add(`${cx + dx},${cy + dy}`);
    }
  };
  for (const pts of [a, b]) {
    if (pts.length === 0) continue;
    // The pin itself and its immediate stub, plus the matching cell one step in.
    exemptNear(pts[0]);
    exemptNear(pts[pts.length - 1]);
  }

  const out: string[] = [];
  for (const [cell, axis] of ca) {
    if (exempt.has(cell)) continue;
    const other = cb.get(cell);
    if (other !== undefined && other === axis) out.push(cell);
  }
  return out;
}

// ── Attempt 4: escape-line fallback ─────────────────────────────────────────

/** Row/column clear of every obstacle, for the both-stubs-parallel fallback. */
function escapeLine(doc: RlcDoc, axis: "y" | "x"): number {
  const cs = cellSize();
  let lo = Infinity;
  for (const c of doc.components) {
    const r = obstacleRect(c, OBSTACLE_PAD);
    lo = Math.min(lo, axis === "y" ? r.top : r.left);
  }
  if (!Number.isFinite(lo)) return 0;
  // Two clear cells before the topmost/leftmost obstacle, on the lattice.
  return Math.round(lo / cs) * cs - 2 * cs;
}

/**
 * Last-resort orthogonal path that honours both pin facings.
 *
 * Construction invariant: the segment immediately AFTER the source clearance point and
 * the segment immediately BEFORE the target clearance point are both PERPENDICULAR to
 * their pin's facing. That is what guarantees `simplifyWaypoints` can never eat the two
 * end stubs — the property the unit tests check for all 16 facing pairs.
 *
 * It may cross foreign components: it is the never-fail path, reported as `escape`, and
 * the canvas paints it as a warning.
 */
export function fallbackZPath(
  doc: RlcDoc,
  startPos: Pt,
  startSide: PinSide,
  endPos: Pt,
  endSide: PinSide,
): Point[] {
  const cs = cellSize();
  const startVec = SIDE_TO_VEC[startSide];
  const endVec = SIDE_TO_VEC[endSide];
  const s1: Point = { x: startPos.x + startVec.x * cs, y: startPos.y + startVec.y * cs };
  const cs1: Point = {
    x: startPos.x + startVec.x * STUB_CELLS * cs,
    y: startPos.y + startVec.y * STUB_CELLS * cs,
  };
  const e1: Point = { x: endPos.x + endVec.x * cs, y: endPos.y + endVec.y * cs };
  const ce1: Point = {
    x: endPos.x + endVec.x * STUB_CELLS * cs,
    y: endPos.y + endVec.y * STUB_CELLS * cs,
  };

  const startH = isHorizontalSide(startSide);
  const endH = isHorizontalSide(endSide);

  let mids: Point[];
  if (startH && endH) {
    // Both stubs horizontal → leave vertically, travel on a clear row, arrive vertically.
    const escY = escapeLine(doc, "y");
    const y = Math.abs(s1.y - escY) < cs ? escY - cs : escY;
    mids = [{ x: cs1.x, y }, { x: ce1.x, y }];
  } else if (!startH && !endH) {
    // Both stubs vertical → leave horizontally, travel in a clear column, arrive horizontally.
    const escX = escapeLine(doc, "x");
    const x = Math.abs(s1.x - escX) < cs ? escX - cs : escX;
    mids = [{ x, y: cs1.y }, { x, y: ce1.y }];
  } else if (startH) {
    // Source horizontal, target vertical → leave vertically, arrive horizontally.
    mids = [{ x: cs1.x, y: ce1.y }];
  } else {
    // Source vertical, target horizontal → leave horizontally, arrive vertically.
    mids = [{ x: ce1.x, y: cs1.y }];
  }

  const pts: Point[] = [
    { x: startPos.x, y: startPos.y },
    s1,
    cs1,
    ...mids,
    ce1,
    e1,
    { x: endPos.x, y: endPos.y },
  ];
  return simplifyWaypoints(pts);
}

// ── Grid plumbing ───────────────────────────────────────────────────────────

function gridFor(rects: RouteRect[], endpoints: Point[]): IntGrid {
  return buildGlobalGrid(
    pixelRectsToGrid(rects),
    endpoints.map((p) => px2g(p.x)),
    endpoints.map((p) => px2g(p.y)),
  );
}

/** Force a single cell open (mirrors the upstream editor's stub-end treatment). */
function openCell(grid: IntGrid, p: Point): void {
  const cx = Math.round(p.x / cellSize()) - grid.originX;
  const cy = Math.round(p.y / cellSize()) - grid.originY;
  if (cx < 0 || cx >= grid.cols || cy < 0 || cy >= grid.rows) return;
  grid.blocked[cx * grid.rows + cy] = 0;
}

// ── Single-wire routing ─────────────────────────────────────────────────────

interface AttemptInput {
  grid: IntGrid;
  s1: Point;
  cs1: Point;
  e1: Point;
  ce1: Point;
  startDir: number;
  endDir: number;
  fromPin: Pt;
  toPin: Pt;
  penalties?: PenaltyZone[];
}

/** Run one A* attempt between the two clearance points. */
function tryAttempt(inp: AttemptInput): Point[] | null {
  openCell(inp.grid, inp.cs1);
  openCell(inp.grid, inp.ce1);
  const astar = astarOrthogonal(
    inp.grid,
    px2g(inp.cs1.x), px2g(inp.cs1.y),
    px2g(inp.ce1.x), px2g(inp.ce1.y),
    inp.penalties,
    false,
    false,
    undefined,
    undefined,
    undefined,
    undefined,
    inp.startDir,
    inp.endDir,
  );
  if (!astar) return null;
  const interior = astar.path.map((p) => ({ x: g2px(p.gx), y: g2px(p.gy) }));
  const joined: Point[] = [
    { x: inp.fromPin.x, y: inp.fromPin.y },
    inp.s1,
    ...interior,
    inp.e1,
    { x: inp.toPin.x, y: inp.toPin.y },
  ];
  return tuckSubgridSteps(
    anchorRouteEndpoints(
      simplifyWaypoints(joined),
      { x: inp.fromPin.x, y: inp.fromPin.y },
      { x: inp.toPin.x, y: inp.toPin.y },
    ),
  );
}

/**
 * Resolve one edge endpoint into everything the router needs: where the wire anchors, which
 * way it leaves that anchor, which component (if any) owns the anchor, and whether the
 * anchor is a tap on another wire.
 *
 * A pin anchor is fixed by the part. A TAP anchor is projected onto its host wire's CURRENT
 * polyline, so the junction stays on the wire even after the host is re-routed — the stored
 * coordinates are a starting hint, never a floating point in space.
 */
interface ResolvedAnchor {
  pos: Point;
  side: PinSide;
  /** Component that owns the anchor, or null for a tap. */
  componentId: string | null;
  /** Host edge id when this anchor is a tap. */
  tapOfEdgeId: string | null;
  /** Every perpendicular side to try; a pin has exactly one legal facing. */
  altSides?: PinSide[];
}

function resolveAnchor(
  doc: RlcDoc,
  end: RlcEdgeEndpoint,
  geometry: Record<string, RlcWireGeometry> | undefined,
  selfEdgeId: string,
): ResolvedAnchor | null {
  if (isPinEndpoint(end)) {
    const g = endpointGeometry(doc, end.componentId, end.pinId);
    if (!g) return null;
    return { pos: g.pos, side: g.side, componentId: g.componentId, tapOfEdgeId: null };
  }
  if (end.edgeId === selfEdgeId) return null;
  const hostPts = geometry?.[end.edgeId]?.waypoints;
  if (!hostPts || hostPts.length < 2) return null;
  const junction = projectTapOntoHost(hostPts, { x: end.x, y: end.y });
  if (!junction) return null;
  // The first perpendicular side is only a DEFAULT. `routeOneWire` tries every perpendicular
  // side and keeps the best, so the choice is made on measured length, not on ordering.
  const sides = tapApproachSides(hostPts, junction);
  return { pos: junction, side: sides[0], componentId: null, tapOfEdgeId: end.edgeId, altSides: sides };
}

/**
 * Route one wire, honouring a tap anchor when present.
 *
 * `penalties` carries the zones of wires already routed this pass ("avoid other wires").
 * `geometry` is the solved polyline of every wire so far, which a tap anchor needs in order
 * to project itself onto its host. Both are supplied by `routeDocument`; callers routing a
 * single wire may omit them, in which case a tap anchor cannot be resolved and the wire is
 * reported as unroutable rather than silently guessed.
 */
export function routeOneWire(
  doc: RlcDoc,
  edge: RlcEdge,
  penalties: PenaltyZone[] = [],
  geometry?: Record<string, RlcWireGeometry>,
  opts: { approachOverride?: PinSide } = {},
): RlcRoutedWire | null {
  const from = resolveAnchor(doc, edge.from, geometry, edge.id);
  const to = resolveAnchor(doc, edge.to, geometry, edge.id);
  if (!from || !to) return null;

  // A tap has TWO legal ways in (either perpendicular side of the host segment). A pin has
  // exactly one (its facing). Both the preview and the commit go through this same loop, so
  // the branch you see while hovering IS the branch that gets stored — no second opinion.
  const sides: PinSide[] = opts.approachOverride
    ? [opts.approachOverride]
    : to.altSides && to.altSides.length > 0
      ? to.altSides
      : [to.side];

  let best: RlcRoutedWire | null = null;
  let bestLength = Infinity;
  for (const side of sides) {
    const routed = routeWithApproach(doc, edge, from, to, side, penalties);
    if (!routed) continue;
    const len = polylineLength(routed.waypoints);
    // Ties break on the side order, which is itself deterministic — so the result is stable.
    if (len < bestLength) {
      best = routed;
      bestLength = len;
    }
  }
  return best;
}

/** One routing attempt with the target arriving from a specific side. */
function routeWithApproach(
  doc: RlcDoc,
  edge: RlcEdge,
  from: ResolvedAnchor,
  to: ResolvedAnchor,
  toSide: PinSide,
  penalties: PenaltyZone[],
): RlcRoutedWire | null {
  const cs = cellSize();
  const startDir = SIDE_TO_DIR[from.side];
  // A wire ARRIVES travelling opposite to the anchor's outward facing (a left-side anchor is
  // entered from its left, moving rightward).
  const endDir = OPPOSITE_DIR[SIDE_TO_DIR[toSide]];

  const s1: Point = { x: from.pos.x + SIDE_TO_VEC[from.side].x * cs, y: from.pos.y + SIDE_TO_VEC[from.side].y * cs };
  const cs1: Point = {
    x: from.pos.x + SIDE_TO_VEC[from.side].x * STUB_CELLS * cs,
    y: from.pos.y + SIDE_TO_VEC[from.side].y * STUB_CELLS * cs,
  };
  const e1: Point = { x: to.pos.x + SIDE_TO_VEC[toSide].x * cs, y: to.pos.y + SIDE_TO_VEC[toSide].y * cs };
  const ce1: Point = {
    x: to.pos.x + SIDE_TO_VEC[toSide].x * STUB_CELLS * cs,
    y: to.pos.y + SIDE_TO_VEC[toSide].y * STUB_CELLS * cs,
  };

  const base: Omit<AttemptInput, "grid"> = {
    s1, cs1, e1, ce1, startDir, endDir,
    fromPin: from.pos,
    toPin: to.pos,
  };
  const endpoints = [s1, cs1, e1, ce1];

  // A tap anchor sits ON another wire, so that wire must not be treated as an obstacle for
  // this one — otherwise every tap would be reported as blocked by its own host.
  const excludeHostIds = [from.tapOfEdgeId, to.tapOfEdgeId].filter((v): v is string => !!v);
  const ownIds = [from.componentId, to.componentId].filter((v): v is string => !!v);
  const ownOnly = rlcObstacles(doc, [], OBSTACLE_PAD).filter((r) => r.nodeId && ownIds.includes(r.nodeId));

  // Strictest first. Each attempt must pass its own measurement before being accepted:
  // an attempt that claims to respect bodies but crosses one is discarded rather than
  // shipped (the A* grid rounds, and this is the cheap way to be certain).
  const attempts: { rects: RouteRect[]; quality: RlcWireQuality; checkBodies: boolean }[] = [
    // 1. Comfort clearance around every part.
    { rects: rlcObstacles(doc, [], COMFORT_PAD), quality: "clean", checkBodies: true },
    // 2. Calibrated clearance (1 cell) — what the engine is tuned for.
    { rects: rlcObstacles(doc), quality: "tight", checkBodies: true },
    // 3. Bodies only: keeps parts off the wire when pads cannot be honoured.
    { rects: rlcBodyRects(doc), quality: "crowded", checkBodies: true },
    // 4. The wire's own parts only: a pin walled in by foreign parts still gets a route.
    { rects: ownOnly, quality: "escape", checkBodies: false },
  ];

  for (const attempt of attempts) {
    // A tap's host wire must not block the tap itself.
    const rects = excludeHostIds.length === 0
      ? attempt.rects
      : attempt.rects.filter((r) => !excludeHostIds.some((h) => r.nodeId === h));
    const pts = tryAttempt({
      ...base,
      grid: gridFor(rects, endpoints),
      penalties: penalties.length > 0 ? penalties : undefined,
    });
    if (!pts) continue;
    if (attempt.checkBodies && crossesAnyBody(doc, edge, pts)) continue;
    return {
      edgeId: edge.id,
      waypoints: pts,
      svgPath: waypointsToSvgPath(pts, WIRE_CORNER_RADIUS),
      quality: attempt.quality,
      degraded: attempt.quality !== "clean",
      turns: countTurns(pts),
    };
  }

  // Never-fail path.
  const z = fallbackZPath(doc, from.pos, from.side, to.pos, toSide);
  return {
    edgeId: edge.id,
    waypoints: z,
    svgPath: waypointsToSvgPath(z, WIRE_CORNER_RADIUS),
    quality: "escape",
    degraded: true,
    turns: countTurns(z),
  };
}

// ── Whole-document routing pass ─────────────────────────────────────────────

/**
 * Monotonic ordering key for an id of the form `e<number>` (or any prefix + digits).
 *
 * Sorting ids as STRINGS is wrong for this router: "e10" < "e9", so the tenth wire would be
 * routed BEFORE the ninth, and its penalty zones would then change the ninth wire's geometry.
 * That breaks the property this editor depends on for editing: every existing wire must keep
 * its exact geometry when a new wire is added. Numeric ordering restores it — a newly created
 * wire always has the largest id, is routed last, and can therefore never influence an older
 * wire's path.
 *
 * Ids that do not carry a number fall back to string comparison, and ties break on the raw id
 * so the order is total (and therefore deterministic).
 */
export function routeOrderKey(id: string): [number, string] {
  const m = /^(.*?)(\d+)$/.exec(id);
  if (!m) return [Number.MAX_SAFE_INTEGER, id];
  return [Number(m[2]), m[1]];
}

/** Total, deterministic ordering of edges by id (numeric when possible). */
function compareRouteOrder(a: { id: string }, b: { id: string }): number {
  const [an, ap] = routeOrderKey(a.id);
  const [bn, bp] = routeOrderKey(b.id);
  if (an !== bn) return an - bn;
  return ap < bp ? -1 : ap > bp ? 1 : 0;
}

/**
 * Convert a routed wire into penalty zones for the wires routed after it.
 *
 * Each segment becomes an axis-aligned zone sitting on the segment's own row/column with a
 * 1-cell width. A later wire pays a cost for entering it, so it prefers to shift to a
 * neighbouring row/column — which is what separates parallel runs — but it may still
 * cross the zone when a crossing is genuinely the only way through (a perpendicular
 * crossing is normal schematic geometry, not a defect).
 */
function wirePenalties(wire: RlcRoutedWire): PenaltyZone[] {
  const zones: PenaltyZone[] = [];
  const pts = wire.waypoints;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (a.y === b.y) {
      zones.push({
        axis: "h",
        coordinate: px2g(a.y),
        rangeMin: Math.min(px2g(a.x), px2g(b.x)),
        rangeMax: Math.max(px2g(a.x), px2g(b.x)),
      });
    } else if (a.x === b.x) {
      zones.push({
        axis: "v",
        coordinate: px2g(a.x),
        rangeMin: Math.min(px2g(a.y), px2g(b.y)),
        rangeMax: Math.max(px2g(a.y), px2g(b.y)),
      });
    }
  }
  return zones;
}

/**
 * Route every wire in the document.
 *
 * Ordering: numeric edge id (creation order). Numeric, not string — "e10" must sort AFTER "e9",
 * otherwise a newly created wire could be routed before an older one and its penalty zones
 * would move the older wire. With numeric ordering a new wire is always routed last, which is
 * what makes "adding a wire never changes an existing wire" a theorem rather than a hope.
 *
 * `avoidWires` toggles wire-vs-wire separation. With it off every wire sees only the
 * component bodies (faster on large documents, and the user-facing "off" switch).
 */
export function routeDocument(doc: RlcDoc, opts: { avoidWires?: boolean } = {}): RlcRouteResult {
  const avoidWires = opts.avoidWires ?? true;
  const wires: Record<string, RlcRoutedWire> = {};
  let degradedCount = 0;

  const ordered = [...doc.edges].sort(compareRouteOrder);
  const penalties: PenaltyZone[] = [];
  // Solved geometry of every wire so far — a tap anchor projects itself onto its host, so the
  // host must already be solved. Numeric id ordering guarantees it is.
  const geometry: Record<string, RlcWireGeometry> = {};

  for (const edge of ordered) {
    const routed = routeOneWire(doc, edge, avoidWires ? penalties : [], geometry);
    if (!routed) continue;
    wires[edge.id] = routed;
    geometry[edge.id] = { waypoints: routed.waypoints, quality: routed.quality };
    if (routed.degraded) degradedCount++;
    if (avoidWires) penalties.push(...wirePenalties(routed));
  }

  return { wires, degradedCount };
}

// ── Tap solver: the OARSMT incremental-growth step ──────────────────────────

export interface RlcTapSolution {
  /** Junction on the host wire, on the routing lattice. */
  junction: Point;
  /** Solved polyline of the new branch, from the source pin to `junction`. */
  waypoints: Point[];
  svgPath: string;
  quality: RlcWireQuality;
  degraded: boolean;
  turns: number;
  /** Manhattan length of the branch — the value the search minimises. */
  length: number;
  /** Candidate junctions actually evaluated (for honest reporting of the bound). */
  evaluated: number;
  /** True when the search stopped early because no remaining candidate could improve. */
  optimal: boolean;
}

/** Manhattan length of a polyline. */
export function polylineLength(pts: readonly Point[]): number {
  let n = 0;
  for (let i = 1; i < pts.length; i++) n += Math.abs(pts[i].x - pts[i - 1].x) + Math.abs(pts[i].y - pts[i - 1].y);
  return n;
}

/**
 * Penalty zones for every wire in a geometry map, in numeric id order.
 *
 * This is what `routeDocument` accumulates as it routes. Exposing it lets the tap solver feed
 * a new branch the SAME soft costs the committed route will see, which is what makes the
 * previewed branch identical to the branch that gets stored — the preview is a real solve, not
 * an approximation.
 */
export function penaltiesForGeometry(
  doc: RlcDoc,
  geometry: Record<string, RlcWireGeometry> | undefined,
): PenaltyZone[] {
  if (!geometry) return [];
  const out: PenaltyZone[] = [];
  const ordered = [...doc.edges].sort(compareRouteOrder);
  for (const e of ordered) {
    const g = geometry[e.id];
    if (!g || !Array.isArray(g.waypoints) || g.waypoints.length < 2) continue;
    out.push(...wirePenalties({ edgeId: e.id, waypoints: g.waypoints } as RlcRoutedWire));
  }
  return out;
}

/**
 * Solve the BEST junction for a new branch from `source` onto `hostEdgeId`.
 *
 * This is the incremental-growth step of an obstacle-avoiding rectilinear Steiner tree
 * (OARSMT): an existing tree, one unconnected terminal, and the point where the new branch
 * meets the tree is the Steiner point being added. The objective is the length of the NEW
 * branch only — optimising the total tree length would require moving existing wires, which
 * this editor guarantees never happens.
 *
 * Optimality argument, not just a search: candidates are visited in increasing Manhattan
 * distance from the source, and Manhattan distance is a LOWER BOUND on the length of any
 * obstacle-avoiding rectilinear path between those two points. So once the best solved
 * branch is no longer than the next candidate's lower bound, no remaining candidate can beat
 * it and the search stops — the result is optimal over the candidate set. `optimal` reports
 * whether that argument actually fired (a budget-bounded search reports false, honestly).
 *
 * Obstacles and the four-tier attempt ladder are the SAME ones `routeOneWire` uses, so a tap
 * branch is held to exactly the avoidance contract a normal wire is.
 */
export function solveTap(
  doc: RlcDoc,
  source: RlcPinEndpoint,
  hostEdgeId: string,
  opts: { baseGeometry?: Record<string, RlcWireGeometry> } = {},
): RlcTapSolution | null {
  const src = endpointGeometry(doc, source.componentId, source.pinId);
  if (!src) return null;
  const hostPts = opts.baseGeometry?.[hostEdgeId]?.waypoints;
  if (!hostPts || hostPts.length < 2) return null;

  const candidates = polylineLatticePoints(hostPts, TAP_ENDPOINT_INSET);
  if (candidates.length === 0) return null;
  const ranked = candidates
    .map((c) => ({ c, d: Math.abs(c.x - src.pos.x) + Math.abs(c.y - src.pos.y) }))
    .sort((a, b) => (a.d !== b.d ? a.d - b.d : a.c.x !== b.c.x ? a.c.x - b.c.x : a.c.y - b.c.y));

  // The new branch is always routed LAST (its id is the largest), so every existing wire is
  // already placed by the time it routes. Feeding those soft costs to the probe is what makes
  // the previewed branch the same branch the commit will store.
  const penalties = penaltiesForGeometry(doc, opts.baseGeometry);

  let best: RlcTapSolution | null = null;
  let evaluated = 0;
  let optimal = false;

  for (const { c, d } of ranked) {
    if (best && best.length <= d) {
      // No unseen candidate can be closer than d, and the best branch is already <= d.
      optimal = true;
      break;
    }
    if (evaluated >= TAP_MAX_CANDIDATES) break;
    evaluated++;

    // `routeOneWire` itself tries every perpendicular approach for a tap and keeps the
    // shorter, so one call per candidate is enough — and it is the same call the commit makes.
    const probe: RlcEdge = { id: "__probe__", from: source, to: { kind: "tap", edgeId: hostEdgeId, x: c.x, y: c.y } };
    const routed = routeOneWire(doc, probe, penalties, opts.baseGeometry);
    if (!routed) continue;
    const length = polylineLength(routed.waypoints);
    if (!best || length < best.length) {
      best = {
        junction: c,
        waypoints: routed.waypoints,
        svgPath: routed.svgPath,
        quality: routed.quality,
        degraded: routed.degraded,
        turns: routed.turns,
        length,
        evaluated: 0,
        optimal: false,
      };
    }
  }

  if (!best) return null;
  best.evaluated = evaluated;
  best.optimal = optimal;
  return best;
}
