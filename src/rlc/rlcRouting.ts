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
 * Ordering matters for EDITING, not just for determinism: edges are routed by NUMERIC id, so a
 * newly created wire (the largest id) is always routed last and can never influence an older
 * wire's geometry. That is what makes "adding a wire never moves an existing wire" provable
 * rather than hopeful, and the tests assert it point for point.
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
  type PinSide,
  type Pt,
  type RlcDoc,
  type RlcEdge,
  type RlcEdgeEndpoint,
  type RlcWireGeometry,
} from "./rlcModel";
import {
  COMFORT_PAD,
  OBSTACLE_PAD,
  STUB_CELLS,
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
  // A wire legitimately occupies the pad band of the two components it connects — its pin
  // stubs live there — so the first and last segments are exempt from their own components.
  // The exemption is SEGMENT-SCOPED, so a wire that doubles back over its own body is caught.
  const fromComp = edge.from.componentId;
  const toComp = edge.to.componentId;
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
 * Resolve one edge endpoint into what the router needs: where the wire anchors and which way
 * it leaves that anchor.
 */
interface ResolvedAnchor {
  pos: Point;
  side: PinSide;
  componentId: string;
}

function resolveAnchor(doc: RlcDoc, end: RlcEdgeEndpoint): ResolvedAnchor | null {
  const g = endpointGeometry(doc, end.componentId, end.pinId);
  if (!g) return null;
  return { pos: g.pos, side: g.side, componentId: g.componentId };
}

/**
 * Route one wire across the wires already placed in this pass.
 *
 * `penalties` carries the soft-cost zones of the wires routed before it (the "avoid other
 * wires" half of obstacle avoidance). The pass order is deterministic, so the geometry is
 * reproducible.
 */
export function routeOneWire(
  doc: RlcDoc,
  edge: RlcEdge,
  penalties: PenaltyZone[] = [],
  _geometry?: Record<string, RlcWireGeometry>,
  opts: { approachOverride?: PinSide } = {},
): RlcRoutedWire | null {
  const from = resolveAnchor(doc, edge.from);
  const to = resolveAnchor(doc, edge.to);
  if (!from || !to) return null;

  // `approachOverride` is retained for callers that want to force the target's arrival side;
  // a pin's facing is the only legal one in normal use.
  const toSide = opts.approachOverride ?? to.side;

  const cs = cellSize();
  const startDir = SIDE_TO_DIR[from.side];
  // A wire ARRIVES travelling opposite to the pin's outward facing (a left-side pin is entered
  // from its left, moving rightward).
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

  const ownIds = [from.componentId, to.componentId];
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
    const pts = tryAttempt({
      ...base,
      grid: gridFor(attempt.rects, endpoints),
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
