/**
 * Centralized iterative edge routing engine.
 * Routes all edges with awareness of each other to avoid shared segments.
 *
 * Pure algorithm — no React dependencies.
 */

import type { SchematicNode, ConnectionEdge, BundleMeta } from "./types";
import { computeBundleTrunk } from "./routing/bundleRoute";
import { bundleJunctionsFor, splitMemberWaypoints } from "./bundles";
import type { HandleSnapshot, SnapshotHandle } from "./routing/handleSnapshot";
import {
  buildGlobalGrid,
  buildObstacles,
  cellSize,
  computeEdgePath,
  createPenaltySpatialIndex,
  g2px,
  growPenaltyIndex,
  pixelRectsToGrid,
  px2g,
  simplifyWaypoints,
  tuckSubgridSteps,
  waypointsToSvgPath,
  waypointsToSvgPathWithHops,
  beginRoutingBudget,
  routingBudgetExceeded,
  ROUTING_PARAMS,
  type PenaltyZone,
  type Rect,
} from "./pathfinding";
import { computePageGrid } from "./printPageGrid";
import { packOrdered, laneCount } from "./routing";
import { STUB_W_EST, nearestStubHandleSide } from "./stubPlacement";
import {
  type Orientation,
  getPaperSize,
  PAGE_MARGIN_IN,
  TITLE_BLOCK_HEIGHT_IN,
} from "./printConfig";

// ---------- Types ----------

export interface CrossingPoint {
  x: number;
  y: number;
}

export interface RoutedEdge {
  edgeId: string;
  svgPath: string;
  /** SVG path with arc hops on horizontal segments and gap cuts on vertical segments at crossings */
  svgPathWithHops?: string;
  waypoints: Point[];
  segments: Segment[];
  labelX: number;
  labelY: number;
  turns: string;
  crossingPoints?: CrossingPoint[];
}

interface Point {
  x: number;
  y: number;
}

interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  axis: "h" | "v";
}

interface HandlePos {
  id: string;
  absX: number;
  absY: number;
}

// ---------- Orthogonalize ----------

/**
 * Insert intermediate waypoints between consecutive non-aligned points
 * so the path stays strictly orthogonal (horizontal/vertical segments only).
 * For each pair where both X and Y differ, inserts a bend point going
 * horizontal-first from the source side then vertical into the next point.
 */
export function orthogonalize(points: Point[]): Point[] {
  if (points.length < 2) return points;
  const result: Point[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const prev = result[result.length - 1];
    const cur = points[i];
    if (prev.x !== cur.x && prev.y !== cur.y) {
      // Insert a bend: go horizontal first, then vertical
      result.push({ x: cur.x, y: prev.y });
    }
    result.push(cur);
  }
  return result;
}

/** Optional print-view configuration for title block obstacle avoidance. */
export interface PrintConfig {
  paperId: string;
  orientation: Orientation;
  scale: number;
  customWidthIn?: number;
  customHeightIn?: number;
  originOffsetX?: number;
  originOffsetY?: number;
}

// ---------- Constants ----------

const DPI = 96;

/** Default routing orchestration parameters. */
export const ROUTER_DEFAULTS = {
  MAX_ITERATIONS: 5,
  SEPARATION_THRESHOLD: 8,
  CX_THRESHOLD: 15,
  EDGE_GAP: 0,          // no parallel edge offset — start simple
  Y_GAP_THRESHOLD: 50,
  STUB_GAP: 0,          // no stub spread — start simple
  /** Edge sort strategy: 0=default(signal-type→shortest→position), 1=longest-first, 2=most-connected-first */
  SORT_STRATEGY: 1 as number,
  /** Half-pitch comb ribbons (same-signal lanes compressed to 10px when a band overflows).
   *  OFF by default: at sub-100% zoom a 10px pair reads as a shared lane, and the portfolio
   *  objective can't see ribbon density (smearPairs isn't weighted) — same trap as the
   *  CELL_SIZE=10 experiment. Re-enable only with a density-aware objective. */
  HALF_PITCH_LANES: 0 as number,
  /** Phase-3 rip-up-and-reroute: re-run free-A* strays caught weaving once the full
   *  picture exists. Max reroute attempts per pass; 0 disables the phase. */
  RIPUP_TRIALS: 8 as number,
};

/** Live-overridable via window.__routingParams for debug tuning. */
export const ROUTER_PARAMS: typeof ROUTER_DEFAULTS = new Proxy(ROUTER_DEFAULTS, {
  get(target, prop) {
    const overrides = (globalThis as unknown as Record<string, unknown>).__routingParams as Record<string, number> | undefined;
    if (overrides && prop in overrides) return overrides[prop as string];
    return target[prop as keyof typeof target];
  },
}) as typeof ROUTER_DEFAULTS;

// ---------- Handle resolution ----------

function getHandlePositions(
  nodeId: string,
  handles: HandleSnapshot,
): HandlePos[] {
  const internal = handles[nodeId];
  if (!internal) return [];

  const absX = internal.positionAbsolute.x;
  const absY = internal.positionAbsolute.y;
  const result: HandlePos[] = [];

  // For stub-label nodes, the connecting handles (l/r) are vertically centered
  // by design (top: 50% of a 14-px box). Computing from `node.measured.height`
  // is exact; trusting DOM-measured handle bounds isn't — `getBoundingClientRect`
  // can return sub-pixel values when CSS percentages mix with odd-pixel sizes
  // or a parent transform isn't pixel-aligned, and rounding the port side and
  // stub side independently to adjacent integers produces a 1-px jog at the
  // edge endpoint. The device side keeps the DOM path so port reorders, ports
  // with non-standard positioning, etc. still re-measure correctly.
  const isStubLabel = internal.type === "stub-label";
  const stubCenterY = isStubLabel
    ? absY + (internal.measuredHeight ?? 14) / 2
    : 0;

  const push = (handle: SnapshotHandle) => {
    const useStubCenter = isStubLabel && (handle.id === "l" || handle.id === "r");
    const cy = useStubCenter ? stubCenterY : absY + handle.y + handle.height / 2;
    result.push({
      id: handle.id,
      absX: Math.round(absX + handle.x + handle.width / 2),
      absY: Math.round(cy),
    });
  };

  for (const handle of internal.source) push(handle);
  for (const handle of internal.target) push(handle);
  return result;
}

function getAbsPos(node: SchematicNode, nodeMap: Map<string, SchematicNode>) {
  let x = node.position.x;
  let y = node.position.y;
  let parentId = node.parentId;
  while (parentId) {
    const parent = nodeMap.get(parentId);
    if (!parent) break;
    x += parent.position.x;
    y += parent.position.y;
    parentId = parent.parentId;
  }
  return { x, y };
}

// ---------- Stub spread (moved from OffsetEdge) ----------

function computeStubSpread(
  edgeId: string,
  sourceNodeId: string,
  edges: ConnectionEdge[],
  nodeMap: Map<string, SchematicNode>,
): number {
  const allFromSource: { edgeId: string; handleY: number }[] = [];
  for (const e of edges) {
    if (e.source !== sourceNodeId) continue;
    const tgt = nodeMap.get(e.target);
    if (!tgt) continue;
    const tgtPos = getAbsPos(tgt, nodeMap);
    const tgtH = tgt.measured?.height ?? 80;
    allFromSource.push({ edgeId: e.id, handleY: tgtPos.y + tgtH / 2 });
  }

  if (allFromSource.length <= 1) return 0;

  allFromSource.sort(
    (a, b) => a.handleY - b.handleY || a.edgeId.localeCompare(b.edgeId),
  );
  const index = allFromSource.findIndex((e) => e.edgeId === edgeId);
  const mid = (allFromSource.length - 1) / 2;
  return (index - mid) * ROUTER_PARAMS.STUB_GAP;
}

// ---------- Segment extraction ----------

export function extractSegments(waypoints: Point[]): Segment[] {
  const segs: Segment[] = [];
  for (let i = 0; i < waypoints.length - 1; i++) {
    const a = waypoints[i];
    const b = waypoints[i + 1];
    if (a.x === b.x && a.y === b.y) continue;
    const axis: "h" | "v" = a.y === b.y ? "h" : "v";
    segs.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, axis });
  }
  return segs;
}

// ---------- Violation detection ----------

/** Do two perpendicular segments actually cross? */
export function segmentsCross(a: Segment, b: Segment): boolean {
  if (a.axis === b.axis) return false;
  // Ensure h is horizontal, v is vertical
  const h = a.axis === "h" ? a : b;
  const v = a.axis === "v" ? a : b;
  const hY = h.y1;
  const hMinX = Math.min(h.x1, h.x2);
  const hMaxX = Math.max(h.x1, h.x2);
  const vX = v.x1;
  const vMinY = Math.min(v.y1, v.y2);
  const vMaxY = Math.max(v.y1, v.y2);
  return vX > hMinX && vX < hMaxX && hY > vMinY && hY < vMaxY;
}

function segmentsOverlap(a: Segment, b: Segment): boolean {
  if (a.axis !== b.axis) return false;

  if (a.axis === "v") {
    // Vertical segments: close in X, overlapping Y range
    if (Math.abs(a.x1 - b.x1) >= ROUTER_PARAMS.SEPARATION_THRESHOLD) return false;
    const aMinY = Math.min(a.y1, a.y2);
    const aMaxY = Math.max(a.y1, a.y2);
    const bMinY = Math.min(b.y1, b.y2);
    const bMaxY = Math.max(b.y1, b.y2);
    const overlapLen = Math.min(aMaxY, bMaxY) - Math.max(aMinY, bMinY);
    return overlapLen > ROUTER_PARAMS.SEPARATION_THRESHOLD;
  } else {
    // Horizontal segments: close in Y, overlapping X range
    if (Math.abs(a.y1 - b.y1) >= ROUTER_PARAMS.SEPARATION_THRESHOLD) return false;
    const aMinX = Math.min(a.x1, a.x2);
    const aMaxX = Math.max(a.x1, a.x2);
    const bMinX = Math.min(b.x1, b.x2);
    const bMaxX = Math.max(b.x1, b.x2);
    const overlapLen = Math.min(aMaxX, bMaxX) - Math.max(aMinX, bMinX);
    return overlapLen > ROUTER_PARAMS.SEPARATION_THRESHOLD;
  }
}

export function findViolations(
  allEdges: { edgeId: string; segments: Segment[]; signalType?: string }[],
): Set<string> {
  const bad = new Set<string>();
  // Track per-edge crossing counts: how many times each edge crosses
  // the SAME other edge. Weaving through one edge (2+ crossings) is
  // much worse than crossing two different edges once each.
  const pairCrossings = new Map<string, Map<string, number>>();
  for (const e of allEdges) {
    pairCrossings.set(e.edgeId, new Map());
  }

  for (let i = 0; i < allEdges.length; i++) {
    for (let j = i + 1; j < allEdges.length; j++) {
      const a = allEdges[i];
      const b = allEdges[j];
      let hasOverlap = false;
      let crossCount = 0;
      for (const sa of a.segments) {
        for (const sb of b.segments) {
          if (segmentsOverlap(sa, sb)) hasOverlap = true;
          if (segmentsCross(sa, sb)) crossCount++;
        }
      }

      if (hasOverlap) {
        bad.add(a.edgeId);
        bad.add(b.edgeId);
      }

      if (crossCount > 0) {
        pairCrossings.get(a.edgeId)!.set(b.edgeId, crossCount);
        pairCrossings.get(b.edgeId)!.set(a.edgeId, crossCount);

        // Crossing the same edge 2+ times is always a violation (weaving)
        if (crossCount >= 2) {
          bad.add(a.edgeId);
          bad.add(b.edgeId);
        }

        // Even a single crossing between same-signal edges looks wrong
        // (identical colors make crossings very visible)
        if (crossCount >= 1 && a.signalType && a.signalType === b.signalType) {
          bad.add(a.edgeId);
          bad.add(b.edgeId);
        }
      }
    }
  }

  // An edge that crosses 3+ distinct other edges is also flagged —
  // likely has a cleaner route available
  for (const e of allEdges) {
    const crosses = pairCrossings.get(e.edgeId)!;
    if (crosses.size >= 3) {
      bad.add(e.edgeId);
    }
  }

  return bad;
}

// ---------- Penalty zone construction ----------

export function buildPenaltyZones(
  goodEdges: { segments: Segment[]; signalType?: string }[],
): PenaltyZone[] {
  const zones: PenaltyZone[] = [];
  for (const edge of goodEdges) {
    for (const seg of edge.segments) {
      if (seg.axis === "v") {
        zones.push({
          axis: "v",
          coordinate: px2g(seg.x1),
          rangeMin: px2g(Math.min(seg.y1, seg.y2)),
          rangeMax: px2g(Math.max(seg.y1, seg.y2)),
          signalType: edge.signalType,
        });
      } else {
        zones.push({
          axis: "h",
          coordinate: px2g(seg.y1),
          rangeMin: px2g(Math.min(seg.x1, seg.x2)),
          rangeMax: px2g(Math.max(seg.x1, seg.x2)),
          signalType: edge.signalType,
        });
      }
    }
  }
  return zones;
}

// ---------- Debug reporting ----------

interface EdgeEndpoints {
  edge: ConnectionEdge;
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  stubSpread: number;
  /** True if source handle exits to the right (normal), false if to the left (flipped) */
  sourceExitsRight: boolean;
  /** True if target handle enters from the left (normal), false if from the right (flipped) */
  targetEntersLeft: boolean;
}

interface RouteState {
  edgeId: string;
  waypoints: Point[];
  segments: Segment[];
  svgPath: string;
  labelX: number;
  labelY: number;
  turns: string;
  status: "good" | "bad";
  signalType?: string;
  /** Eligible for the Phase-3 rip-up pass: free-A* strays only. Coordinated shapes
   *  (corridor combs, loop-U brackets, bundles, manual routes) must never be ripped —
   *  a lone reroute breaks the group's visual order. */
  ripupOk?: boolean;
}

function logRoutingReport(
  routeStates: RouteState[],
  edgeEndpoints: EdgeEndpoints[],
) {
  // All coordinates in GRID units (1 unit = 20px cell)
  const g = px2g;

  // --- Build edge info with corridor X ---
  type EdgeInfo = {
    id: string;
    srcX: number; srcY: number;
    tgtX: number; tgtY: number;
    corridorX: number | null; // primary vertical corridor, null if straight
    dir: "down" | "up" | "flat";
    vSpan: number; // absolute vertical span in grid cells
    crossings: number;
  };
  const edgeInfos: EdgeInfo[] = [];
  for (const rs of routeStates) {
    const ep = edgeEndpoints.find((e) => e.edge.id === rs.edgeId);
    if (!ep) continue;
    const srcX = g(ep.sourceX), srcY = g(ep.sourceY);
    const tgtX = g(ep.targetX), tgtY = g(ep.targetY);
    // Primary corridor = longest vertical segment
    const vSegs = rs.segments.filter((s) => s.axis === "v");
    let corridorX: number | null = null;
    if (vSegs.length > 0) {
      const longest = vSegs.reduce((a, b) =>
        Math.abs(a.y2 - a.y1) > Math.abs(b.y2 - b.y1) ? a : b
      );
      corridorX = g(longest.x1);
    }
    const dir = tgtY > srcY ? "down" : tgtY < srcY ? "up" : "flat";
    edgeInfos.push({ id: rs.edgeId, srcX, srcY, tgtX, tgtY, corridorX, dir, vSpan: Math.abs(tgtY - srcY), crossings: 0 });
  }

  // --- Crossing detection ---
  const weaves: { a: string; b: string; count: number }[] = [];
  const allSegments = routeStates.map((rs) => ({ id: rs.edgeId, segments: rs.segments }));
  let totalCrossings = 0;
  let totalWeaves = 0;
  for (let i = 0; i < allSegments.length; i++) {
    for (let j = i + 1; j < allSegments.length; j++) {
      let count = 0;
      for (const sa of allSegments[i].segments) {
        for (const sb of allSegments[j].segments) {
          if (segmentsCross(sa, sb)) count++;
        }
      }
      if (count > 0) {
        totalCrossings += count;
        const ai = edgeInfos.find((e) => e.id === allSegments[i].id);
        const bi = edgeInfos.find((e) => e.id === allSegments[j].id);
        if (ai) ai.crossings += count;
        if (bi) bi.crossings += count;
        if (count >= 2) {
          totalWeaves += count;
          weaves.push({ a: allSegments[i].id, b: allSegments[j].id, count });
        }
      }
    }
  }

  // --- Fan group detection ---
  // Group edges by (srcX, tgtX) proximity — edges within 5 grid cells of each other's src/tgt X
  type FanGroup = { srcXRange: [number, number]; tgtXRange: [number, number]; edges: EdgeInfo[] };
  const fanGroups: FanGroup[] = [];
  for (const ei of edgeInfos) {
    if (ei.corridorX === null) continue; // skip straight lines
    let placed = false;
    for (const fg of fanGroups) {
      if (Math.abs(ei.srcX - fg.srcXRange[0]) <= 15 && Math.abs(ei.tgtX - fg.tgtXRange[0]) <= 5) {
        fg.edges.push(ei);
        fg.srcXRange[0] = Math.min(fg.srcXRange[0], ei.srcX);
        fg.srcXRange[1] = Math.max(fg.srcXRange[1], ei.srcX);
        fg.tgtXRange[0] = Math.min(fg.tgtXRange[0], ei.tgtX);
        fg.tgtXRange[1] = Math.max(fg.tgtXRange[1], ei.tgtX);
        placed = true;
        break;
      }
    }
    if (!placed) {
      fanGroups.push({ srcXRange: [ei.srcX, ei.srcX], tgtXRange: [ei.tgtX, ei.tgtX], edges: [ei] });
    }
  }

  // --- Console output ---
  console.group(`%c🔀 Routing Report — ${routeStates.length} edges`, "font-weight:bold; font-size:14px; color:#4fc3f7");

  for (const fg of fanGroups) {
    if (fg.edges.length < 2) continue;
    const srcDesc = fg.srcXRange[0] === fg.srcXRange[1] ? `x=${fg.srcXRange[0]}` : `x=${fg.srcXRange[0]}..${fg.srcXRange[1]}`;
    const tgtDesc = fg.tgtXRange[0] === fg.tgtXRange[1] ? `x=${fg.tgtXRange[0]}` : `x=${fg.tgtXRange[0]}..${fg.tgtXRange[1]}`;
    console.log(`%cFan: ${srcDesc} → ${tgtDesc} (${fg.edges.length} edges)`, "font-weight:bold; color:#81c784");
    // Sort by target Y for display
    const sorted = [...fg.edges].sort((a, b) => a.tgtY - b.tgtY);
    for (const e of sorted) {
      const cx = e.crossings > 0 ? ` ✗ ${e.crossings}cx` : " ✓";
      console.log(`  src=(${e.srcX},${e.srcY}) tgt=(${e.tgtX},${e.tgtY}) corridor=x${e.corridorX} ${e.dir} span=${e.vSpan}${cx}`);
    }
  }

  if (weaves.length > 0) {
    console.log(`%cWeaves: ${weaves.length} pairs`, "font-weight:bold; color:#ef5350");
    for (const w of weaves) {
      console.log(`  ${w.a} ↔ ${w.b}: ${w.count}x`);
    }
  }

  console.log(
    `%cSummary: ${totalCrossings} crossings, ${totalWeaves} weave crossings`,
    `font-weight:bold; color:${totalWeaves > 0 ? "#ef5350" : totalCrossings > 0 ? "#ffb74d" : "#66bb6a"}`,
  );
  console.groupEnd();

  // --- Clipboard report (compact, fan-group focused) ---
  const report = {
    edgeCount: routeStates.length,
    grid: "1 unit = 20px",
    summary: { crossings: totalCrossings, weaves: totalWeaves },
    fanGroups: fanGroups.filter((fg) => fg.edges.length >= 2).map((fg) => ({
      src: fg.srcXRange[0] === fg.srcXRange[1] ? fg.srcXRange[0] : fg.srcXRange,
      tgt: fg.tgtXRange[0] === fg.tgtXRange[1] ? fg.tgtXRange[0] : fg.tgtXRange,
      edges: [...fg.edges].sort((a, b) => a.tgtY - b.tgtY).map((e) => ({
        id: e.id,
        srcY: e.srcY,
        tgtY: e.tgtY,
        corridor: e.corridorX,
        dir: e.dir,
        span: e.vSpan,
        crossings: e.crossings,
      })),
    })),
    weaves: weaves.map((w) => ({ edges: [w.a, w.b], count: w.count })),
    soloEdges: edgeInfos.filter((e) => e.corridorX !== null && !fanGroups.some((fg) => fg.edges.length >= 2 && fg.edges.includes(e))).map((e) => ({
      id: e.id,
      src: { x: e.srcX, y: e.srcY },
      tgt: { x: e.tgtX, y: e.tgtY },
      corridor: e.corridorX,
      crossings: e.crossings,
    })),
  };
  // globalThis (not window) so this is safe inside the routing Web Worker too;
  // the worker ferries it back and the main thread re-publishes it on window.
  (globalThis as unknown as Record<string, unknown>).__routingReport = report;
}

// ---------- Title block obstacles ----------

/**
 * Compute obstacle rects for the title block area on each print page.
 * The title block occupies the bottom of each page's content area.
 */
function buildTitleBlockObstacles(
  nodes: SchematicNode[],
  printConfig: PrintConfig,
): Rect[] {
  const paper = getPaperSize(printConfig.paperId, printConfig.customWidthIn, printConfig.customHeightIn);

  const pages = computePageGrid(
    paper,
    printConfig.orientation,
    printConfig.scale,
    nodes,
    undefined,
    printConfig.originOffsetX ?? 0,
    printConfig.originOffsetY ?? 0,
  );

  const marginPx = (PAGE_MARGIN_IN * DPI) / printConfig.scale;
  const titleBlockPx = (TITLE_BLOCK_HEIGHT_IN * DPI) / printConfig.scale;

  const rects: Rect[] = [];
  for (const page of pages) {
    // Title block sits below the content area, above the bottom margin
    const top = page.y + page.heightPx - marginPx - titleBlockPx;
    const bottom = top + titleBlockPx;
    const left = page.contentX;
    const right = page.contentX + page.contentW;
    rects.push({ left, top, right, bottom });
  }
  return rects;
}


// ---------- Main routing function ----------

export interface RouteAllResult {
  routes: Record<string, RoutedEdge>;
  overBudget: boolean;
}

// Deterministic work budget: max cumulative A* node expansions for one routeAllEdges run. Replaces
// the old 3000ms wall-clock budget (which made routing nondeterministic under load). Calibrated well
// above what the densest real fixtures consume (~10× headroom) so normal schematics never hit it and
// route identically; it only bounds pathological inputs. See pathfinding beginRoutingBudget.
const DEFAULT_OPS_BUDGET = 20_000_000;

export function routeAllEdges(
  nodes: SchematicNode[],
  edges: ConnectionEdge[],
  handles: HandleSnapshot,
  debug?: boolean,
  printConfig?: PrintConfig,
  _opsBudget: number = DEFAULT_OPS_BUDGET,
  bundles: Record<string, BundleMeta> = {},
): RouteAllResult {
  let overBudget = false;
  beginRoutingBudget(_opsBudget);

  // Build node map for O(1) lookups
  const nodeMap = new Map<string, SchematicNode>();
  for (const n of nodes) {
    nodeMap.set(n.id, n);
  }

  // Build handle position map
  const handleMap = new Map<string, HandlePos>();
  for (const node of nodes) {
    for (const hp of getHandlePositions(node.id, handles)) {
      handleMap.set(`${node.id}:${hp.id}`, hp);
    }
  }

  // Build obstacles once (all devices)
  const getAbsPosAdapter = (n: { id: string; position: { x: number; y: number }; parentId?: string }) =>
    getAbsPos(n as SchematicNode, nodeMap);
  const obs = buildObstacles(nodes, [], getAbsPosAdapter);
  // Pre-convert obstacles to grid rects once — avoids per-edge re-conversion
  const precomputedGridRects = pixelRectsToGrid(obs.rects);

  // Add title block obstacles in print view
  if (printConfig) {
    const tbRects = buildTitleBlockObstacles(nodes, printConfig);
    obs.rects.push(...tbRects);
  }

  // Resolve an edge's handle to a HandlePos, healing stale bare↔directional
  // references. A port that is (or became) bidirectional renders `-in` (left) and
  // `-out` (right) handles, but an edge authored against the bare port id stores
  // `pXXX-N` with no suffix → exact lookup misses and the edge would be silently
  // dropped (rendering as a straight line through everything in-app). Conversely a
  // directional ref can outlive a port reverting to a single bare handle. Resolve by
  // role: a source prefers the `-out` side, a target the `-in` side; fall back to the
  // other side, then to stripping/adding the suffix. Exact-keyed (no prefix matching)
  // so `pXXX-1` never collides with `pXXX-14`.
  const resolveHandle = (
    nodeId: string,
    handleId: string | null | undefined,
    role: "source" | "target",
  ): HandlePos | undefined => {
    if (handleId == null) return undefined;
    const exact = handleMap.get(`${nodeId}:${handleId}`);
    if (exact) return exact;
    const preferred = role === "source" ? "-out" : "-in";
    const other = role === "source" ? "-in" : "-out";
    // bare → directional
    return (
      handleMap.get(`${nodeId}:${handleId}${preferred}`) ??
      handleMap.get(`${nodeId}:${handleId}${other}`) ??
      // directional → bare (port reverted to a single handle)
      (handleId.endsWith("-in") || handleId.endsWith("-out")
        ? handleMap.get(`${nodeId}:${handleId.replace(/-(in|out)$/, "")}`)
        : undefined)
    );
  };

  // Stub-label endpoints: the stored l/r handle is only the creation-time guess — dragging
  // the stub (or its device) to the other side leaves it stale, and the wire then crosses
  // over the label box or loops around it to reach the far handle. The wire must always
  // enter the side facing it, so re-pick the handle nearest the adjacent route point.
  const nearestStubHandle = (
    node: SchematicNode,
    towardX: number,
    fallback: HandlePos,
  ): HandlePos => {
    const pos = getAbsPos(node, nodeMap);
    const side = nearestStubHandleSide(pos.x, node.measured?.width ?? STUB_W_EST, towardX);
    return handleMap.get(`${node.id}:${side}`) ?? fallback;
  };

  // Resolve edge endpoints
  const edgeEndpoints: EdgeEndpoints[] = [];
  for (const edge of edges) {
    let srcHandle = resolveHandle(edge.source, edge.sourceHandle, "source");
    let tgtHandle = resolveHandle(edge.target, edge.targetHandle, "target");

    if (!srcHandle || !tgtHandle) continue; // node not measured yet

    const stubSpread = computeStubSpread(edge.id, edge.source, edges, nodeMap);

    // Determine handle exit directions by comparing handle X to node center X.
    // Handles on the right half of their device exit rightward, left half exit leftward.
    const srcNode = nodeMap.get(edge.source);
    const tgtNode = nodeMap.get(edge.target);
    const mw = edge.data?.manualWaypoints;
    if (srcNode?.type === "stub-label") {
      srcHandle = nearestStubHandle(srcNode, mw?.length ? mw[0].x : tgtHandle.absX, srcHandle);
    }
    if (tgtNode?.type === "stub-label") {
      tgtHandle = nearestStubHandle(tgtNode, mw?.length ? mw[mw.length - 1].x : srcHandle.absX, tgtHandle);
    }
    const srcPos = srcNode ? getAbsPos(srcNode, nodeMap) : { x: 0, y: 0 };
    const tgtPos = tgtNode ? getAbsPos(tgtNode, nodeMap) : { x: 0, y: 0 };
    const srcFallbackW = srcNode?.type === "stub-label" ? STUB_W_EST : 144;
    const tgtFallbackW = tgtNode?.type === "stub-label" ? STUB_W_EST : 144;
    const srcCenterX = srcPos.x + (srcNode?.measured?.width ?? srcFallbackW) / 2;
    const tgtCenterX = tgtPos.x + (tgtNode?.measured?.width ?? tgtFallbackW) / 2;

    edgeEndpoints.push({
      edge,
      sourceX: srcHandle.absX,
      sourceY: srcHandle.absY,
      targetX: tgtHandle.absX,
      targetY: tgtHandle.absY,
      stubSpread,
      sourceExitsRight: srcHandle.absX >= srcCenterX,
      targetEntersLeft: tgtHandle.absX <= tgtCenterX,
    });
  }

  // Build one global grid covering all obstacles + endpoints — shared across all A* calls.
  // Eliminates per-edge grid construction (allocation + obstacle marking).
  const epGXs: number[] = [];
  const epGYs: number[] = [];
  for (const ep of edgeEndpoints) {
    epGXs.push(px2g(ep.sourceX), px2g(ep.targetX));
    epGYs.push(px2g(ep.sourceY), px2g(ep.targetY));
  }
  const globalGrid = epGXs.length > 0
    ? buildGlobalGrid(precomputedGridRects, epGXs, epGYs)
    : undefined;

  // Sort order determines corridor priority — edges routed first claim corridors,
  // later edges route around them via penalty zones.
  // Strategy 0 (default): signal-type grouping → shortest Manhattan distance → position
  // Strategy 1: longest Manhattan distance first
  // Strategy 2: most-connected device first
  const signalTypeCounts = new Map<string, number>();
  for (const ep of edgeEndpoints) {
    const sig = ep.edge.data?.signalType ?? "";
    signalTypeCounts.set(sig, (signalTypeCounts.get(sig) ?? 0) + 1);
  }

  // Strategy 2 pre-computation: count edges per device
  let deviceEdgeCounts: Map<string, number> | undefined;
  if (ROUTER_PARAMS.SORT_STRATEGY === 2) {
    deviceEdgeCounts = new Map<string, number>();
    for (const ep of edgeEndpoints) {
      deviceEdgeCounts.set(ep.edge.source, (deviceEdgeCounts.get(ep.edge.source) ?? 0) + 1);
      deviceEdgeCounts.set(ep.edge.target, (deviceEdgeCounts.get(ep.edge.target) ?? 0) + 1);
    }
  }

  edgeEndpoints.sort((a, b) => {
    // Manual edges always route first regardless of strategy
    const aManual = a.edge.data?.manualWaypoints?.length ? 1 : 0;
    const bManual = b.edge.data?.manualWaypoints?.length ? 1 : 0;
    if (aManual !== bManual) return bManual - aManual; // manual first

    if (ROUTER_PARAMS.SORT_STRATEGY === 1) {
      // Strategy 1: longest Manhattan distance first
      const aDist = Math.abs(a.targetX - a.sourceX) + Math.abs(a.targetY - a.sourceY);
      const bDist = Math.abs(b.targetX - b.sourceX) + Math.abs(b.targetY - b.sourceY);
      if (aDist !== bDist) return bDist - aDist; // longest first
    } else if (ROUTER_PARAMS.SORT_STRATEGY === 2) {
      // Strategy 2: most-connected device first
      const aMax = Math.max(deviceEdgeCounts!.get(a.edge.source) ?? 0, deviceEdgeCounts!.get(a.edge.target) ?? 0);
      const bMax = Math.max(deviceEdgeCounts!.get(b.edge.source) ?? 0, deviceEdgeCounts!.get(b.edge.target) ?? 0);
      if (aMax !== bMax) return bMax - aMax; // most connections first
    } else {
      // Strategy 0 (default): signal-type grouping → shortest distance → position
      // Group by signal type — most common type routes first to establish
      // primary corridors. Same-signal edges route consecutively for clustering.
      const aSig = a.edge.data?.signalType ?? "";
      const bSig = b.edge.data?.signalType ?? "";
      if (aSig !== bSig) {
        const aCount = signalTypeCounts.get(aSig) ?? 0;
        const bCount = signalTypeCounts.get(bSig) ?? 0;
        if (aCount !== bCount) return bCount - aCount; // more edges first
        return aSig < bSig ? -1 : 1; // alphabetical tiebreaker
      }
      // Shortest connection length routes first — short connections need
      // direct corridors, longer ones can afford detours. Manhattan distance
      // captures both X and Y span, improving dense-layout convergence (#14).
      const aDist = Math.abs(a.targetX - a.sourceX) + Math.abs(a.targetY - a.sourceY);
      const bDist = Math.abs(b.targetX - b.sourceX) + Math.abs(b.targetY - b.sourceY);
      if (aDist !== bDist) return aDist - bDist;
    }

    // Position tiebreaker (shared by all strategies)
    const aY = Math.min(a.sourceY, a.targetY);
    const bY = Math.min(b.sourceY, b.targetY);
    if (aY !== bY) return aY - bY;
    const aX = Math.min(a.sourceX, a.targetX);
    const bX = Math.min(b.sourceX, b.targetX);
    return aX - bX;
  });

  const results: Record<string, RoutedEdge> = {};
  const routeStates: RouteState[] = [];

  // Incremental penalty zones — append after each edge instead of rebuilding from scratch
  const runningPenalties: PenaltyZone[] = [];
  const penaltySpatialIdx = createPenaltySpatialIndex();

  /** Append penalty zones for a newly routed edge and grow the spatial index.
   *  NOTE if HALF_PITCH_LANES is ever re-enabled: v-zone coordinates here quantize to
   *  whole cells, which displaces a half-pitch ribbon trunk's zone 10px to one side and
   *  leaves its other flank unguarded — quantize to half cells (with extra weight) then. */
  const appendPenalties = (rs: RouteState) => {
    for (const seg of rs.segments) {
      if (seg.axis === "v") {
        runningPenalties.push({
          axis: "v",
          coordinate: px2g(seg.x1),
          rangeMin: px2g(Math.min(seg.y1, seg.y2)),
          rangeMax: px2g(Math.max(seg.y1, seg.y2)),
          signalType: rs.signalType,
        });
      } else {
        runningPenalties.push({
          axis: "h",
          coordinate: px2g(seg.y1),
          rangeMin: px2g(Math.min(seg.x1, seg.x2)),
          rangeMax: px2g(Math.max(seg.x1, seg.x2)),
          signalType: rs.signalType,
        });
      }
    }
    growPenaltyIndex(penaltySpatialIdx, runningPenalties);
  };

  /** Check the deterministic work budget and latch the overBudget flag. */
  const checkBudget = () => {
    if (!overBudget && routingBudgetExceeded()) {
      overBudget = true;
    }
    return overBudget;
  };

  // ---------- Bundle membership ----------
  // A connection is a bundle member only if its bundleId group has ≥2 members actually
  // present in this routing pass. Members bypass the normal manual/auto split entirely —
  // they route along one shared trunk (Phase 0.5 below). A member's manualWaypoints are
  // honored on its gather/fan legs (split around the junctions); the trunk stays shared.
  const bundlePresentCounts = new Map<string, number>();
  for (const ep of edgeEndpoints) {
    const bid = ep.edge.data?.bundleId;
    if (bid) bundlePresentCounts.set(bid, (bundlePresentCounts.get(bid) ?? 0) + 1);
  }
  const bundleGroups = new Map<string, EdgeEndpoints[]>();
  // Per-bundle trunk endpoints, resolved during the spine-reservation pass (below) so the
  // column allocator can route ordinary edges around the reserved spines.
  const bundleSpines = new Map<string, { entry: Point; exit: Point; overrideTrunk: Point[] | null }>();

  // ---------- Route manual edges first (unchanged — they get a clean slate) ----------
  const manualEndpoints: EdgeEndpoints[] = [];
  const autoEndpoints: EdgeEndpoints[] = [];
  for (const ep of edgeEndpoints) {
    const bid = ep.edge.data?.bundleId;
    if (bid && (bundlePresentCounts.get(bid) ?? 0) >= 2) {
      let group = bundleGroups.get(bid);
      if (!group) { group = []; bundleGroups.set(bid, group); }
      group.push(ep);
    } else if (ep.edge.data?.manualWaypoints?.length) {
      manualEndpoints.push(ep);
    } else {
      autoEndpoints.push(ep);
    }
  }

  for (const ep of manualEndpoints) {
    const sigType = ep.edge.data?.signalType;
    const penalties = runningPenalties;
    const manualWps = ep.edge.data!.manualWaypoints!;

    const allPoints = [
      { x: ep.sourceX, y: ep.sourceY },
      ...manualWps,
      { x: ep.targetX, y: ep.targetY },
    ];

    const allWaypoints: Point[] = [];
    let allFailed = false;
    let prevArrivalDir: number | undefined;

    const reservedExitDir: (number | undefined)[] = new Array(allPoints.length).fill(undefined);
    for (let i = 1; i < allPoints.length - 1; i++) {
      const handle = allPoints[i];
      const next = allPoints[i + 1];
      const dx = next.x - handle.x;
      const dy = next.y - handle.y;
      if (Math.abs(dx) >= Math.abs(dy)) {
        reservedExitDir[i] = dx >= 0 ? 0 : 2;
      } else {
        reservedExitDir[i] = dy >= 0 ? 1 : 3;
      }
    }

    const lastLeg = allPoints.length - 2;
    for (let leg = 0; leg < allPoints.length - 1; leg++) {
      const from = allPoints[leg];
      const to = allPoints[leg + 1];
      const isFirstLeg = leg === 0;
      const isLastLeg = leg === lastLeg;
      const spread = isFirstLeg ? ep.stubSpread : 0;
      const noSourceStub = !isFirstLeg;
      const noTargetStub = !isLastLeg;

      const excludeDir = prevArrivalDir !== undefined ? (prevArrivalDir + 2) % 4 : undefined;
      const reserved = reservedExitDir[leg + 1];
      const reservedAtTarget = reserved !== undefined ? (reserved + 2) % 4 : undefined;

      // Pass exit/entry directions for first and last legs
      const legSrcExitsRight = isFirstLeg ? ep.sourceExitsRight : undefined;
      const legTgtEntersLeft = isLastLeg ? ep.targetEntersLeft : undefined;

      let legResult = computeEdgePath(
        from.x, from.y, to.x, to.y,
        obs.rects, 0, spread,
        penalties.length > 0 ? penalties : undefined,
        sigType, noSourceStub, noTargetStub, excludeDir, reservedAtTarget,
        undefined, legSrcExitsRight, legTgtEntersLeft,
        precomputedGridRects, penaltySpatialIdx, globalGrid,
      );

      if (!legResult) {
        const excludeSet = new Set([ep.edge.source, ep.edge.target]);
        const relaxedRects = obs.rects.filter((r) => !r.nodeId || !excludeSet.has(r.nodeId));
        legResult = computeEdgePath(
          from.x, from.y, to.x, to.y,
          relaxedRects, 0, spread,
          penalties.length > 0 ? penalties : undefined,
          sigType, noSourceStub, noTargetStub, excludeDir, reservedAtTarget,
          undefined, legSrcExitsRight, legTgtEntersLeft,
          undefined, penaltySpatialIdx,
        );
      }

      if (legResult) {
        prevArrivalDir = legResult.arrivalDir;
        if (allWaypoints.length > 0) {
          allWaypoints.push(...legResult.waypoints.slice(1));
        } else {
          allWaypoints.push(...legResult.waypoints);
        }
      } else {
        allFailed = true;
        break;
      }
    }

    if (!allFailed && allWaypoints.length >= 2) {
      const svgPath = waypointsToSvgPath(allWaypoints);
      const segments = extractSegments(allWaypoints);
      const midIdx = Math.floor(allWaypoints.length / 2);
      const rs: RouteState = {
        edgeId: ep.edge.id, waypoints: allWaypoints, segments, svgPath,
        labelX: allWaypoints[midIdx]?.x ?? ep.sourceX,
        labelY: allWaypoints[midIdx]?.y ?? ep.sourceY,
        turns: "manual", status: "good", signalType: sigType,
      };
      routeStates.push(rs);
      appendPenalties(rs);
      continue;
    }

    const fallbackWp = simplifyWaypoints(orthogonalize(allPoints));
    const fbSvg = waypointsToSvgPath(fallbackWp);
    const fbSegs = extractSegments(fallbackWp);
    const fbMid = Math.floor(fallbackWp.length / 2);
    const rs: RouteState = {
      edgeId: ep.edge.id, waypoints: fallbackWp, segments: fbSegs, svgPath: fbSvg,
      labelX: fallbackWp[fbMid]?.x ?? ep.sourceX,
      labelY: fallbackWp[fbMid]?.y ?? ep.sourceY,
      turns: "manual-fallback", status: "good", signalType: sigType,
    };
    routeStates.push(rs);
    appendPenalties(rs);
  }

  // ---------- PHASE 0: Column-First Allocation ----------
  // Instead of sequential A* where each edge fights for space, assign vertical
  // corridor columns globally so no two edges share the same X. This guarantees
  // no shared verticals and produces consistent, evenly-spaced lanes.
  //
  // Key insight: fan groups (edges sharing source/target devices) must be allocated
  // as contiguous blocks in a single channel. Otherwise they scatter across channels
  // and weave with each other.

  const gridRects = pixelRectsToGrid(obs.rects);

  // Stub-label boxes (grid coords, floor-truncated so a box grazing 2px into the next
  // cell doesn't eat it). Not obstacles for A* — their own wire must reach the handle on
  // the box edge — but corridor verticals must not be allocated THROUGH the label text.
  const stubGridRects: { nodeId: string; left: number; right: number; top: number; bottom: number }[] = [];
  {
    const cs = cellSize();
    for (const n of nodes) {
      if (n.type !== "stub-label") continue;
      const pos = getAbsPos(n, nodeMap);
      const w = n.measured?.width ?? STUB_W_EST;
      const h = n.measured?.height ?? 14;
      stubGridRects.push({
        nodeId: n.id,
        left: Math.floor(pos.x / cs),
        right: Math.floor((pos.x + w) / cs),
        top: Math.floor(pos.y / cs),
        bottom: Math.floor((pos.y + h) / cs),
      });
    }
  }

  // Check if a vertical column is clear of device obstacles over a Y range.
  // excludeNodeIds: the edge's own endpoint devices — only their PAD RIM is fair game
  // (a trunk may turn one cell before its own device), never the body interior. Treating
  // the whole rect as clear let allocator overflow place corridors INSIDE the target
  // device, which the A* retry then honored by routing straight through the body.
  const pad = ROUTING_PARAMS.PAD;
  const isColumnClear = (gx: number, gyMin: number, gyMax: number, excludeNodeIds?: Set<string>): boolean => {
    for (const r of gridRects) {
      const ownDevice = excludeNodeIds && r.nodeId && excludeNodeIds.has(r.nodeId);
      const left = ownDevice ? r.left + pad : r.left;
      const right = ownDevice ? r.right - pad : r.right;
      if (gx >= left && gx <= right && gyMax >= r.top && gyMin <= r.bottom) {
        return false;
      }
    }
    for (const s of stubGridRects) {
      if (excludeNodeIds && excludeNodeIds.has(s.nodeId)) continue;
      if (gx >= s.left && gx <= s.right && gyMax >= s.top && gyMin <= s.bottom) {
        return false;
      }
    }
    return true;
  };

  // Check if a horizontal segment is clear of device obstacles.
  // excludeNodeIds: skip the edge's own source/target devices — a horizontal
  // segment naturally exits through the source device's obstacle rect.
  const isHSegmentClear = (gy: number, gxMin: number, gxMax: number, excludeNodeIds?: Set<string>): boolean => {
    for (const r of gridRects) {
      if (excludeNodeIds && r.nodeId && excludeNodeIds.has(r.nodeId)) continue;
      if (gy >= r.top && gy <= r.bottom && gxMax >= r.left && gxMin <= r.right) {
        return false;
      }
    }
    return true;
  };

  // Build edge info in grid coordinates for column allocation
  type ColumnEdge = {
    ep: EdgeEndpoints;
    srcGX: number; srcGY: number;
    tgtGX: number; tgtGY: number;
    signalType: string;
    assignedCol: number | null;
    isBackward: boolean; // target is left of source
    fanGroupId: number;  // -1 = solo edge
    /** Coordinated loop-back U lanes (grid coords): exit column right of the source,
     *  return row, entry column left of the target. Constructed directly in Phase 2. */
    loopU: { x1: number; y: number; x2: number } | null;
  };
  const columnEdges: ColumnEdge[] = [];
  for (const ep of autoEndpoints) {
    const srcGX = px2g(ep.sourceX);
    const srcGY = px2g(ep.sourceY);
    const tgtGX = px2g(ep.targetX);
    const tgtGY = px2g(ep.targetY);
    // Column routing assumes left-to-right flow (source exits right → corridor → target enters left).
    // Same-side connections (both handles on right or both on left) and reversed edges bypass this.
    const needsUnconstrained = tgtGX <= srcGX || !(ep.sourceExitsRight && ep.targetEntersLeft);
    columnEdges.push({
      ep,
      srcGX, srcGY, tgtGX, tgtGY,
      signalType: ep.edge.data?.signalType ?? "",
      assignedCol: null,
      isBackward: needsUnconstrained,
      fanGroupId: -1,
      loopU: null,
    });
  }

  // ---------- Fan group detection ----------
  // Group forward edges by source/target device proximity (X AND Y).
  // Edges in the same fan group get allocated as a contiguous block.
  // Y proximity prevents independent device groups (e.g., stacked copies of a
  // schematic) from competing for the same column block.
  type FanGroup = {
    id: number;
    srcXMin: number; srcXMax: number;
    tgtXMin: number; tgtXMax: number;
    yMin: number; yMax: number;
    edges: ColumnEdge[];
  };
  const fanGroups: FanGroup[] = [];
  let nextFanId = 0;
  const FAN_Y_MARGIN = 5; // grid cells (~100px) of slack for Y-range overlap

  for (const ce of columnEdges) {
    if (ce.isBackward) continue;
    const ceYMin = Math.min(ce.srcGY, ce.tgtGY);
    const ceYMax = Math.max(ce.srcGY, ce.tgtGY);
    let placed = false;
    for (const fg of fanGroups) {
      // Y-range overlap: the edge's Y extent must overlap the group's Y extent
      // (with a small margin). This prevents stacked copies from merging.
      const overlapsY = ceYMax >= fg.yMin - FAN_Y_MARGIN && ceYMin <= fg.yMax + FAN_Y_MARGIN;
      if (Math.abs(ce.tgtGX - fg.tgtXMin) <= 5
        && Math.abs(ce.srcGX - fg.srcXMin) <= 15
        && overlapsY) {
        fg.edges.push(ce);
        fg.srcXMin = Math.min(fg.srcXMin, ce.srcGX);
        fg.srcXMax = Math.max(fg.srcXMax, ce.srcGX);
        fg.tgtXMin = Math.min(fg.tgtXMin, ce.tgtGX);
        fg.tgtXMax = Math.max(fg.tgtXMax, ce.tgtGX);
        fg.yMin = Math.min(fg.yMin, ceYMin);
        fg.yMax = Math.max(fg.yMax, ceYMax);
        ce.fanGroupId = fg.id;
        placed = true;
        break;
      }
    }
    if (!placed) {
      const id = nextFanId++;
      ce.fanGroupId = id;
      fanGroups.push({
        id,
        srcXMin: ce.srcGX, srcXMax: ce.srcGX,
        tgtXMin: ce.tgtGX, tgtXMax: ce.tgtGX,
        yMin: ceYMin, yMax: ceYMax,
        edges: [ce],
      });
    }
  }

  // ---------- Find the best corridor region for each fan group ----------
  // For each fan group, split into direction subgroups (DOWN vs UP), sort each
  // subgroup with the geometrically correct order, then allocate contiguous columns.
  //
  // Why direction splitting is necessary (not a patch — it's geometry):
  //   DOWN edges (tgtY > srcY): second horizontal passes through higher corridors.
  //     → Sort by tgtY ascending → highest corridor. Zero second-horizontal crossings.
  //   UP edges (srcY > tgtY): first horizontal passes through higher corridors.
  //     → Sort by srcY descending → highest corridor. Zero first-horizontal crossings.
  //   These are OPPOSITE orderings. No single sort works for both.

  // Y-range-aware column tracking — a column is only "taken" for the Y span of the
  // edge that claimed it. Edges at different Y positions can share the same X column.
  // Keys are multiples of 0.5 grid cells: half-pitch comb lanes claim at X.5 keys.
  const takenColumns = new Map<number, { yMin: number; yMax: number }[]>();
  const COL_GAP = 2; // grid cells of vertical gap between claimed ranges before two trunks
                     // may share a column. NOT 1: claims cover endpoint rows only, but real
                     // routed verticals wander past them — 1 cell of slack yields actual
                     // shared verticals (icdc/video sharedParallel +7 when probed 2026-06).

  /** Check if a column X is available for a given Y range. Any claim within half a
   *  cell (10px) conflicts — strangers never end up half-pitch from each other; only
   *  a half-pitch block's own lanes (claimed together after checking) sit that close. */
  const isColumnAvailable = (gx: number, yMin: number, yMax: number): boolean => {
    for (const key of [gx - 0.5, gx, gx + 0.5]) {
      const ranges = takenColumns.get(key);
      if (!ranges) continue;
      for (const r of ranges) {
        if (yMax + COL_GAP >= r.yMin && yMin - COL_GAP <= r.yMax) return false;
      }
    }
    return true;
  };

  /** Claim a column X for a given Y range. */
  const claimColumn = (gx: number, yMin: number, yMax: number): void => {
    let ranges = takenColumns.get(gx);
    if (!ranges) { ranges = []; takenColumns.set(gx, ranges); }
    ranges.push({ yMin, yMax });
  };

  /** Release one claim previously made with claimColumn (for post-allocation moves). */
  const unclaimColumn = (gx: number, yMin: number, yMax: number): void => {
    const ranges = takenColumns.get(gx);
    if (!ranges) return;
    const i = ranges.findIndex((r) => r.yMin === yMin && r.yMax === yMax);
    if (i >= 0) ranges.splice(i, 1);
  };

  // X-range-aware ROW tracking — the horizontal mirror of takenColumns, used by the
  // loop-back U allocator for its shared return rows.
  const takenRows = new Map<number, { xMin: number; xMax: number }[]>();
  const isRowAvailable = (gy: number, xMin: number, xMax: number): boolean => {
    const ranges = takenRows.get(gy);
    if (!ranges) return true;
    for (const r of ranges) {
      if (xMax + COL_GAP >= r.xMin && xMin - COL_GAP <= r.xMax) return false;
    }
    return true;
  };
  const claimRow = (gy: number, xMin: number, xMax: number): void => {
    let ranges = takenRows.get(gy);
    if (!ranges) { ranges = []; takenRows.set(gy, ranges); }
    ranges.push({ xMin, xMax });
  };

  // ---------- Bundle spine reservation (BEFORE column allocation) ----------
  // A bundle gathers its members onto a vertical spine just past the source cluster, runs one
  // horizontal trunk, then fans onto a spine just before the target cluster. Reserve those two
  // spine columns NOW so the allocator routes ordinary forward edges AROUND the bundle — it's a
  // user-declared shared trunk and gets corridor priority. The comb itself is routed in Phase 0.5,
  // through the columns reserved here, so the bundle's verticals never share a corridor with other
  // connections. (User-overridden trunk polylines are used as-is and skip reservation.)
  for (const [bid, members] of bundleGroups) {
    if (members.length < 2) continue;
    const meta = bundles[bid];
    if (meta?.trunkWaypoints && meta.trunkWaypoints.length >= 2) {
      const wp = meta.trunkWaypoints.map((p) => ({ x: p.x, y: p.y }));
      bundleSpines.set(bid, { entry: wp[0], exit: wp[wp.length - 1], overrideTrunk: wp });
      continue;
    }
    // Authoritative entry/exit = the bundle's break-in / break-out junction nodes (Phase 3).
    // They're POSITION ANCHORS (no edges attach). computeBundleTrunk is the fallback for any
    // anchor that's missing (heal not yet run, or member geometry unresolved). Break-in and
    // break-out can sit at different Ys (independently dragged) — the comb's trunk leg routes
    // entry→exit, so we span each spine column by its own anchor Y.
    const { in: jin, out: jout } = bundleJunctionsFor(nodes, bid);
    const bt = computeBundleTrunk(members.map((ep) => ({
      edgeId: ep.edge.id, srcX: ep.sourceX, srcY: ep.sourceY, tgtX: ep.targetX, tgtY: ep.targetY,
    })));
    const entryPt = jin ? getAbsPos(jin, nodeMap) : bt.entry;
    const exitPt = jout ? getAbsPos(jout, nodeMap) : bt.exit;
    // Gather spine column, just right of the sources, spanning every source Y plus the break-in Y.
    const gYs = members.flatMap((ep) => [ep.sourceY, entryPt.y]);
    const gYMin = px2g(Math.min(...gYs)), gYMax = px2g(Math.max(...gYs));
    let entryGX = px2g(entryPt.x);
    for (let i = 0; i < 24 && !isColumnAvailable(entryGX, gYMin, gYMax); i++) entryGX += 1;
    claimColumn(entryGX, gYMin, gYMax);
    // Fan spine column, just left of the targets, spanning every target Y plus the break-out Y.
    const fYs = members.flatMap((ep) => [ep.targetY, exitPt.y]);
    const fYMin = px2g(Math.min(...fYs)), fYMax = px2g(Math.max(...fYs));
    let exitGX = px2g(exitPt.x);
    for (let i = 0; i < 24 && !isColumnAvailable(exitGX, fYMin, fYMax); i++) exitGX -= 1;
    claimColumn(exitGX, fYMin, fYMax);
    bundleSpines.set(bid, {
      entry: { x: g2px(entryGX), y: entryPt.y },
      exit: { x: g2px(exitGX), y: exitPt.y },
      overrideTrunk: null,
    });
  }

  /** Can this edge's comb leg be built as a clean DIRECT L-shape via colX (no A*)?
   *  Mirrors Phase 2's direct-construction conditions exactly — the allocator must never
   *  promise a half-pitch (off-grid) lane that Phase 2 can only reach through A*. */
  const cleanCombLegOk = (ce: ColumnEdge, colX: number): boolean => {
    const ep = ce.ep;
    const corridorPx = g2px(colX);
    const ownIds = new Set([ep.edge.source, ep.edge.target]);
    const srcOk = ep.sourceExitsRight ? corridorPx >= ep.sourceX : corridorPx <= ep.sourceX;
    const tgtOk = ep.targetEntersLeft ? corridorPx <= ep.targetX : corridorPx >= ep.targetX;
    return srcOk && tgtOk &&
      isHSegmentClear(ce.srcGY, Math.min(ce.srcGX, colX), Math.max(ce.srcGX, colX), ownIds) &&
      isHSegmentClear(ce.tgtGY, Math.min(colX, ce.tgtGX), Math.max(colX, ce.tgtGX), ownIds);
  };

  /** Allocate a contiguous block of columns for a sorted list of edges.
   *  excludeNodeIds: endpoint device IDs to skip in obstacle checks (an edge's
   *  corridor can overlap its own source/target device's obstacle rect). */
  const allocateBlock = (
    edges: ColumnEdge[],
    searchStart: number,
    searchEnd: number,
    excludeNodeIds: Set<string>,
  ) => {
    const n = edges.length;
    if (n === 0) return;

    // Order-preserving Left-Edge packing: trunks arrive in nesting order; consecutive
    // Y-disjoint trunks share a column (column index stays monotonic in the order, so
    // nesting — and thus crossing count — is preserved). The block needs `numLanes`
    // (<= n) columns instead of one per edge. laneOf gives each edge its column offset.
    const lane = packOrdered(
      edges.map((ce) => ({
        id: ce.ep.edge.id,
        yMin: Math.min(ce.srcGY, ce.tgtGY),
        yMax: Math.max(ce.srcGY, ce.tgtGY),
      })),
      COL_GAP,
    );
    const laneOf = (ce: ColumnEdge) => lane.get(ce.ep.edge.id) ?? 0;
    const numLanes = laneCount(lane);

    // Try to find a contiguous block of `numLanes` clear columns; lane L → blockStart - L.
    let blockStart = -1;
    for (let baseX = searchStart; baseX - (numLanes - 1) >= searchEnd; baseX--) {
      let allClear = true;
      for (const ce of edges) {
        const candidateX = baseX - laneOf(ce);
        const yMin = Math.min(ce.srcGY, ce.tgtGY);
        const yMax = Math.max(ce.srcGY, ce.tgtGY);
        if (!isColumnAvailable(candidateX, yMin, yMax)) { allClear = false; break; }
        if (!isColumnClear(candidateX, yMin, yMax, excludeNodeIds)) { allClear = false; break; }
      }
      if (allClear) {
        blockStart = baseX;
        break;
      }
    }

    if (blockStart >= 0) {
      for (const ce of edges) {
        const colX = blockStart - laneOf(ce);
        ce.assignedCol = colX;
        claimColumn(colX, Math.min(ce.srcGY, ce.tgtGY), Math.max(ce.srcGY, ce.tgtGY));
      }
      return;
    }

    // Variable-pitch retry: the band can't fit numLanes at full (20px) pitch. A nested
    // comb whose legs are ALL clean direct L-shapes can pack at variable pitch instead:
    // same-signal neighbor lanes compress to half pitch (10px — a family ribbon reads as
    // a deliberate bus), different-signal neighbors keep the full cell (R11 breathing
    // room). isColumnAvailable's ±half-cell conflict radius keeps strangers a full cell
    // away from every lane. Off-grid trunk x can't serve as an A* via point, so any edge
    // needing A* disqualifies the block (it falls to the per-edge full-pitch scan below).
    if (numLanes > 1 && ROUTER_PARAMS.HALF_PITCH_LANES) {
      // Lane signal uniformity (a lane can hold several Y-disjoint edges; mixed = null).
      const laneSignals: (string | null | undefined)[] = [];
      for (const ce of edges) {
        const L = laneOf(ce);
        if (laneSignals[L] === undefined) laneSignals[L] = ce.signalType;
        else if (laneSignals[L] !== ce.signalType) laneSignals[L] = null;
      }
      const laneOffset: number[] = [0];
      for (let L = 1; L < numLanes; L++) {
        const tight = laneSignals[L] != null && laneSignals[L] === laneSignals[L - 1];
        laneOffset[L] = laneOffset[L - 1] + (tight ? 0.5 : 1);
      }
      const span = laneOffset[numLanes - 1];
      // span === numLanes-1 means nothing compressed — identical to the search that
      // already failed, skip the redundant scan.
      if (span < numLanes - 1) {
        for (let baseX = searchStart; baseX - span >= searchEnd; baseX--) {
          let allClear = true;
          for (const ce of edges) {
            const cx = baseX - laneOffset[laneOf(ce)];
            const yMin = Math.min(ce.srcGY, ce.tgtGY);
            const yMax = Math.max(ce.srcGY, ce.tgtGY);
            if (
              !isColumnAvailable(cx, yMin, yMax) ||
              !isColumnClear(cx, yMin, yMax, excludeNodeIds) ||
              !cleanCombLegOk(ce, cx)
            ) { allClear = false; break; }
          }
          if (!allClear) continue;
          for (const ce of edges) {
            const cx = baseX - laneOffset[laneOf(ce)];
            ce.assignedCol = cx;
            claimColumn(cx, Math.min(ce.srcGY, ce.tgtGY), Math.max(ce.srcGY, ce.tgtGY));
          }
          return;
        }
      }
    }

    // Fallback: per-edge scan (non-contiguous but still unique columns). No overflow
    // past searchStart — for a left-entering co-target block, columns right of the band
    // sit on/behind the target device, forcing a loop around (or through) it. Edges that
    // don't fit stay unassigned and take the free-A* path, which respects obstacles.
    let nextX = searchStart;
    for (const ce of edges) {
      const yMin = Math.min(ce.srcGY, ce.tgtGY);
      const yMax = Math.max(ce.srcGY, ce.tgtGY);
      for (let gx = nextX; gx >= searchEnd; gx--) {
        if (!isColumnAvailable(gx, yMin, yMax)) continue;
        if (isColumnClear(gx, yMin, yMax, excludeNodeIds)) {
          ce.assignedCol = gx;
          claimColumn(gx, yMin, yMax);
          nextX = gx - 1;
          break;
        }
      }
    }
  };

  // ---------- Co-target clustering ----------
  // Fan groups arriving at the same stacked target column must share ONE concentric
  // corridor ordering. Allocating each fan group independently lets a fan reaching LOWER
  // targets grab inner columns (closer to the stack) while a fan reaching HIGHER targets
  // gets outer columns — the two then weave: each low fan's near-source horizontal cuts
  // across the high fan's verticals, and each high fan's target horizontal cuts back
  // across the low fan's verticals. (This is the root cause of the WeirdRoom Stage-fan
  // weave: the ethernet fan to PTZOptics/Panasonic — below the BMD stack — was getting
  // corridors INNER to the SDI fan.) Merging co-target fan groups and ordering the combined
  // edges by target Y nests the whole stack concentrically (highest target = innermost/
  // rightmost column, lowest = outermost/leftmost).
  //
  // Merge criterion mirrors the fan detector: target X ranges within CO_TARGET_X of a
  // contiguous target band, AND Y ranges overlapping (with FAN_Y_MARGIN slack). The Y
  // guard is essential — without it, two stacked copies of a layout (identical target X,
  // disjoint Y) would merge and demand 2×N distinct columns instead of sharing N, the same
  // failure the fan detector's overlapsY check exists to prevent.
  const CO_TARGET_X = 5; // grid cells — reuses the fan detector's tolerance as a range margin
  type Cluster = { tgtXMin: number; tgtXMax: number; srcXMax: number; yMin: number; yMax: number; groups: FanGroup[] };
  const clusters: Cluster[] = [];
  for (const fg of [...fanGroups].sort((a, b) => a.tgtXMin - b.tgtXMin)) {
    const c = clusters.find(
      (cl) =>
        fg.tgtXMin <= cl.tgtXMax + CO_TARGET_X &&
        fg.tgtXMax >= cl.tgtXMin - CO_TARGET_X &&
        fg.yMax >= cl.yMin - FAN_Y_MARGIN &&
        fg.yMin <= cl.yMax + FAN_Y_MARGIN,
    );
    if (c) {
      c.tgtXMin = Math.min(c.tgtXMin, fg.tgtXMin);
      c.tgtXMax = Math.max(c.tgtXMax, fg.tgtXMax);
      c.srcXMax = Math.max(c.srcXMax, fg.srcXMax);
      c.yMin = Math.min(c.yMin, fg.yMin);
      c.yMax = Math.max(c.yMax, fg.yMax);
      c.groups.push(fg);
    } else {
      clusters.push({ tgtXMin: fg.tgtXMin, tgtXMax: fg.tgtXMax, srcXMax: fg.srcXMax, yMin: fg.yMin, yMax: fg.yMax, groups: [fg] });
    }
  }

  /** Split a set of edges into DOWN/UP subgroups, order each concentrically (innermost
   *  = nearest the targets), and allocate contiguous corridor columns in [searchEnd,
   *  searchStart]. The DOWN/UP subgroups are allocated separately and the Y-aware column
   *  tracker keeps them apart, so same-column cross-direction overlap can't happen; a DOWN
   *  horizontal can still cross an UP vertical, but those crossings are minimized, not
   *  eliminated. */
  const allocateForEdges = (edges: ColumnEdge[], searchStart: number, searchEnd: number) => {
    const endpointIds = new Set<string>();
    for (const ce of edges) {
      endpointIds.add(ce.ep.edge.source);
      endpointIds.add(ce.ep.edge.target);
    }
    const downEdges = edges.filter((ce) => ce.tgtGY >= ce.srcGY);
    const upEdges = edges.filter((ce) => ce.tgtGY < ce.srcGY);
    // DOWN: highest target = innermost (block's first/rightmost column = top target),
    // srcY ascending as a stable tiebreaker. UP: mirror — lowest source = innermost.
    downEdges.sort((a, b) => a.tgtGY - b.tgtGY || a.srcGY - b.srcGY);
    upEdges.sort((a, b) => b.srcGY - a.srcGY || b.tgtGY - a.tgtGY);
    allocateBlock(downEdges, searchStart, searchEnd, endpointIds);
    allocateBlock(upEdges, searchStart, searchEnd, endpointIds);

    // Cross-direction row collisions. A DOWN edge's source-row run can sit on the EXACT
    // grid row of an UP edge's target-row approach (srcGY == tgtGY); when the DOWN
    // corridor is also INSIDE (right of) the UP corridor, that run rides through the UP
    // edge's corner and overlaps its final approach — an invisible shared segment, worse
    // than any crossing. (Mirror case: UP source rows vs DOWN target rows.) No column
    // order avoids the single crossing — source and target orders disagree (a VCG
    // cycle) — but the OVERLAP is avoidable: move the riding edge just OUTSIDE the
    // ridden one's column, so it leaves the shared row early and crosses once, cleanly.
    const moveOutside = (rider: ColumnEdge, limitCol: number): void => {
      const yMin = Math.min(rider.srcGY, rider.tgtGY);
      const yMax = Math.max(rider.srcGY, rider.tgtGY);
      for (let gx = limitCol - 1; gx >= searchEnd; gx--) {
        if (!isColumnAvailable(gx, yMin, yMax)) continue;
        if (!isColumnClear(gx, yMin, yMax, endpointIds)) continue;
        unclaimColumn(rider.assignedCol as number, yMin, yMax);
        rider.assignedCol = gx;
        claimColumn(gx, yMin, yMax);
        return;
      }
      // No room outside: keep the assignment (status-quo overlap beats unassigning).
    };
    const ridesThrough = (rider: ColumnEdge, ridden: ColumnEdge): boolean =>
      rider.srcGY === ridden.tgtGY &&
      rider.assignedCol !== null && ridden.assignedCol !== null &&
      rider.assignedCol >= ridden.assignedCol &&
      Math.max(rider.srcGX, ridden.assignedCol) <= Math.min(rider.assignedCol, ridden.tgtGX);
    // Mutual riders (each one's source row IS the other's target row) are a true VCG
    // cycle: whatever the column order, one of the two shared rows keeps the overlap —
    // moving columns just leapfrogs it between rows. Only a dogleg (split trunk) fixes
    // those; skip them and move one-directional riders only.
    const mutual = (a: ColumnEdge, b: ColumnEdge): boolean =>
      a.srcGY === b.tgtGY && b.srcGY === a.tgtGY;
    for (let moved = true, guard = 0; moved && guard < 8; guard++) {
      moved = false;
      for (const d of downEdges) {
        for (const u of upEdges) {
          if (mutual(d, u)) continue;
          if (ridesThrough(d, u)) { moveOutside(d, u.assignedCol as number); moved = true; }
          else if (ridesThrough(u, d)) { moveOutside(u, d.assignedCol as number); moved = true; }
        }
      }
    }

    if ((globalThis as Record<string, unknown>).__dumpColumnAlloc) {
      console.log(`[alloc] band ${searchEnd}..${searchStart} down=${downEdges.length} up=${upEdges.length}`);
      for (const ce of [...downEdges, ...upEdges]) {
        console.log(`  ${ce.ep.edge.id}: src(${ce.srcGX},${ce.srcGY}) tgt(${ce.tgtGX},${ce.tgtGY}) -> col ${ce.assignedCol}`);
      }
    }
  };

  // Process clusters largest-first (most edges = most constrained = allocate first).
  const clusterEdgeCount = (cl: Cluster) => cl.groups.reduce((n, g) => n + g.edges.length, 0);
  const sortedClusters = [...clusters].sort((a, b) => clusterEdgeCount(b) - clusterEdgeCount(a));

  for (const cl of sortedClusters) {
    // Co-target nesting only applies when there's a real corridor band between the
    // cluster's sources and its shared target column (searchStart > searchEnd). When
    // transitive merging drags in short edges whose target X ≈ source X, the band
    // inverts and allocateBlock's fallback would place forward edges in columns BEHIND
    // their own source (the multi-leg A* then knots back to reach them). In that case,
    // fall back to allocating each member fan group on its own band (the per-group shape
    // the router used before co-target clustering), so only genuinely-stacked targets get
    // merged nesting.
    // Band margins are 1 cell: the column right before the targets is the port-stub /
    // pad-rim cell of the edges' OWN target device (usable now that isColumnClear only
    // forbids the body), and the column right after the sources is the source port-stub
    // tip (turning at the tip is the comb minimum the bundle router already uses).
    const bandValid = cl.tgtXMin - 1 > cl.srcXMax + 1;
    if (bandValid && cl.groups.length > 1) {
      allocateForEdges(cl.groups.flatMap((g) => g.edges), cl.tgtXMin - 1, cl.srcXMax + 1);
    } else {
      for (const g of cl.groups) {
        allocateForEdges(g.edges, g.tgtXMin - 1, g.srcXMax + 1);
      }
    }
  }

  // ---------- Loop-back U allocation ----------
  // A loop-back edge (exits RIGHT, enters LEFT, target at/behind its source) must wrap:
  // out to a column right of the source, back along a return row clearing both devices,
  // down/up a column left of the target, and in. Uncoordinated, a group of these (e.g.
  // several returns from one device stack to another) each free-A* their own wrap and
  // weave each other. Coordinate them like the forward comb: group co-located loop-backs,
  // pick the over/under side per group, and hand out nested X1 / return-row / X2 lanes in
  // consistent bracket order. Edges that can't get clean lanes keep the free-A* path.
  {
    type LoopGroup = {
      srcXMin: number; srcXMax: number;
      tgtXMin: number; tgtXMax: number;
      yMin: number; yMax: number;
      edges: ColumnEdge[];
    };
    // Bucket by exact endpoint pair first — a feedback bank between one device pair is
    // ONE bracket family even when its port rows spread beyond any Y-overlap margin —
    // then merge buckets that share regions (proximity + Y overlap, like fan groups).
    const pairBuckets = new Map<string, ColumnEdge[]>();
    for (const ce of columnEdges) {
      if (!ce.isBackward) continue;
      if (!(ce.ep.sourceExitsRight && ce.ep.targetEntersLeft && ce.tgtGX <= ce.srcGX)) continue;
      const key = `${ce.ep.edge.source}|${ce.ep.edge.target}`;
      let bucket = pairBuckets.get(key);
      if (!bucket) { bucket = []; pairBuckets.set(key, bucket); }
      bucket.push(ce);
    }
    const loopGroups: LoopGroup[] = [];
    for (const bucket of [...pairBuckets.values()].sort((a, b) => a[0].ep.edge.id.localeCompare(b[0].ep.edge.id))) {
      const bSrcMin = Math.min(...bucket.map((c) => c.srcGX));
      const bSrcMax = Math.max(...bucket.map((c) => c.srcGX));
      const bTgtMin = Math.min(...bucket.map((c) => c.tgtGX));
      const bTgtMax = Math.max(...bucket.map((c) => c.tgtGX));
      const bYMin = Math.min(...bucket.map((c) => Math.min(c.srcGY, c.tgtGY)));
      const bYMax = Math.max(...bucket.map((c) => Math.max(c.srcGY, c.tgtGY)));
      let placed = false;
      for (const g of loopGroups) {
        if (
          bSrcMax >= g.srcXMin - 8 && bSrcMin <= g.srcXMax + 8 &&
          bTgtMax >= g.tgtXMin - 8 && bTgtMin <= g.tgtXMax + 8 &&
          bYMax >= g.yMin - FAN_Y_MARGIN && bYMin <= g.yMax + FAN_Y_MARGIN
        ) {
          g.edges.push(...bucket);
          g.srcXMin = Math.min(g.srcXMin, bSrcMin);
          g.srcXMax = Math.max(g.srcXMax, bSrcMax);
          g.tgtXMin = Math.min(g.tgtXMin, bTgtMin);
          g.tgtXMax = Math.max(g.tgtXMax, bTgtMax);
          g.yMin = Math.min(g.yMin, bYMin);
          g.yMax = Math.max(g.yMax, bYMax);
          placed = true;
          break;
        }
      }
      if (!placed) {
        loopGroups.push({
          srcXMin: bSrcMin, srcXMax: bSrcMax,
          tgtXMin: bTgtMin, tgtXMax: bTgtMax,
          yMin: bYMin, yMax: bYMax, edges: [...bucket],
        });
      }
    }

    const gridRectById = new Map(
      gridRects.filter((r) => r.nodeId).map((r) => [r.nodeId as string, r]),
    );
    const stubRectById = new Map(stubGridRects.map((r) => [r.nodeId, r]));

    const SCAN = 20; // max cells to scan outward for each lane
    for (const g of loopGroups.sort((a, b) => b.edges.length - a.edges.length || a.edges[0].ep.edge.id.localeCompare(b.edges[0].ep.edge.id))) {
      // Singletons go through the allocator too: in dense regions a lone free-A* wrap
      // rides the cumulative penalty field to the layout perimeter (a roller-coaster
      // sharing the same far corridor as every other stray); the viability guard below
      // already rejects brackets that would wrap too much content.

      // Return row must clear every member's endpoint devices (padded) plus port rows.
      let topMost = g.yMin;
      let botMost = g.yMax;
      for (const ce of g.edges) {
        for (const id of [ce.ep.edge.source, ce.ep.edge.target]) {
          const r = gridRectById.get(id) ?? stubRectById.get(id);
          if (r) {
            topMost = Math.min(topMost, r.top);
            botMost = Math.max(botMost, r.bottom);
          }
        }
      }
      const overBase = topMost - 1;
      const underBase = botMost + 1;
      const sumDist = (row: number) =>
        g.edges.reduce((s, ce) => s + Math.abs(ce.srcGY - row) + Math.abs(ce.tgtGY - row), 0);
      const preferOver = sumDist(overBase) <= sumDist(underBase);

      const dbg = (globalThis as Record<string, unknown>).__dumpColumnAlloc
        ? (msg: string) => console.log(`[loopU] ${msg}`)
        : null;

      // Try the closer side first; if NOTHING allocates there (a device stack walls it
      // off), retry the whole group on the far side. Never split a bracket family
      // across sides — partial success on the preferred side commits the group.
      const allocateSide = (over: boolean): number => {
      const base = over ? overBase : underBase;
      const step = over ? -1 : 1;

      // Bracket order: innermost (closest to the content) first. Over the top, the
      // highest endpoint pair nests innermost; under, the lowest.
      const order = [...g.edges].sort((a, b) => {
        const ka = a.srcGY + a.tgtGY;
        const kb = b.srcGY + b.tgtGY;
        return (over ? ka - kb : kb - ka) || a.ep.edge.id.localeCompare(b.ep.edge.id);
      });

      dbg?.(`group n=${g.edges.length} side=${over ? "over" : "under"} base=${base} src=[${g.srcXMin},${g.srcXMax}] tgt=[${g.tgtXMin},${g.tgtXMax}]`);
      let allocated = 0;
      let nextX1 = g.srcXMax + 1;
      let nextY = base;
      let nextX2 = g.tgtXMin - 1;
      for (const ce of order) {
        const ownSrc = new Set([ce.ep.edge.source]);
        const ownTgt = new Set([ce.ep.edge.target]);

        // Joint row+column search: for each candidate return row (outward scan from
        // the group base), pick this row's lanes FIRST, then validate the row over
        // only the span the U actually occupies [x2..x1]. Pre-scanning the row over a
        // SCAN-padded window rejected rows for devices far outside the bracket and
        // starved dense groups into free A*. (Null sentinels throughout — grid
        // coordinates are routinely negative, so -1 is a real lane.)
        let y: number | null = null;
        let x1: number | null = null;
        let x2: number | null = null;
        for (let r = nextY; Math.abs(r - base) <= SCAN; r += step) {
          // Exit column right of the source.
          let cx1: number | null = null;
          const rx1Lo = Math.min(ce.srcGY, r), rx1Hi = Math.max(ce.srcGY, r);
          for (let c = nextX1; c <= nextX1 + SCAN; c++) {
            if (isColumnAvailable(c, rx1Lo, rx1Hi) && isColumnClear(c, rx1Lo, rx1Hi, ownSrc)) { cx1 = c; break; }
          }
          if (cx1 === null) continue;

          // Entry column left of the target.
          let cx2: number | null = null;
          const rx2Lo = Math.min(r, ce.tgtGY), rx2Hi = Math.max(r, ce.tgtGY);
          for (let c = nextX2; c >= nextX2 - SCAN; c--) {
            if (isColumnAvailable(c, rx2Lo, rx2Hi) && isColumnClear(c, rx2Lo, rx2Hi, ownTgt)) { cx2 = c; break; }
          }
          if (cx2 === null) continue;

          if (!isRowAvailable(r, cx2, cx1) || !isHSegmentClear(r, cx2, cx1)) continue;
          y = r; x1 = cx1; x2 = cx2;
          break;
        }
        if (y === null || x1 === null || x2 === null) { dbg?.(`${ce.ep.edge.id}: NO LANES (from ${nextY})`); continue; } // stays free-A*
        const x1Lo = Math.min(ce.srcGY, y), x1Hi = Math.max(ce.srcGY, y);
        const x2Lo = Math.min(y, ce.tgtGY), x2Hi = Math.max(y, ce.tgtGY);

        // Port-row horizontals must reach the lanes.
        if (!isHSegmentClear(ce.srcGY, ce.srcGX, x1, ownSrc)) { dbg?.(`${ce.ep.edge.id}: SRC ROW BLOCKED`); continue; }
        if (!isHSegmentClear(ce.tgtGY, x2, ce.tgtGX, ownTgt)) { dbg?.(`${ce.ep.edge.id}: TGT ROW BLOCKED`); continue; }

        // Viability: a U whose return row landed far out wraps (and double-crosses) a
        // lot of content — free A* threads gaps better there. Commit only sane detours.
        const uLen = (x1 - ce.srcGX) + Math.abs(y - ce.srcGY) + (x1 - x2) + Math.abs(y - ce.tgtGY) + (ce.tgtGX - x2);
        const manhattan = Math.max((ce.srcGX - ce.tgtGX) + Math.abs(ce.srcGY - ce.tgtGY), 6);
        if (uLen > 3 * manhattan) { dbg?.(`${ce.ep.edge.id}: U TOO LONG (${uLen} vs ${manhattan})`); continue; }
        dbg?.(`${ce.ep.edge.id}: x1=${x1} y=${y} x2=${x2}`);

        ce.loopU = { x1, y, x2 };
        claimColumn(x1, x1Lo, x1Hi);
        claimRow(y, x2, x1);
        claimColumn(x2, x2Lo, x2Hi);
        allocated++;
        nextX1 = x1 + 1;
        nextY = y + step;
        nextX2 = x2 - 1;
      }
      return allocated;
      };
      if (allocateSide(preferOver) === 0) allocateSide(!preferOver);
    }
  }

  // Allocator claims as penalty zones for edges that route OUTSIDE the column system
  // (unassigned overflow + backward edges). Those route by free A* — often BEFORE the
  // claiming edges (longest-first sort) — and can't see the claims otherwise, so they'd
  // park a trunk on a claimed column (shared vertical with the comb routed later) or
  // slice through the comb's not-yet-routed horizontals at the source/target rows. Seed
  // the whole predicted L-shape: source horizontal, trunk vertical, target horizontal.
  // Loop-back U lanes are seeded the same way (two verticals + the return run).
  const corridorClaimZones: PenaltyZone[] = [];
  for (const ce of columnEdges) {
    if (ce.loopU) {
      const { x1, y, x2 } = ce.loopU;
      corridorClaimZones.push(
        { axis: "v", coordinate: x1, rangeMin: Math.min(ce.srcGY, y), rangeMax: Math.max(ce.srcGY, y), signalType: ce.signalType },
        { axis: "h", coordinate: y, rangeMin: x2, rangeMax: x1, signalType: ce.signalType },
        { axis: "v", coordinate: x2, rangeMin: Math.min(y, ce.tgtGY), rangeMax: Math.max(y, ce.tgtGY), signalType: ce.signalType },
        { axis: "h", coordinate: ce.srcGY, rangeMin: ce.srcGX, rangeMax: x1, signalType: ce.signalType },
        { axis: "h", coordinate: ce.tgtGY, rangeMin: x2, rangeMax: ce.tgtGX, signalType: ce.signalType },
      );
      continue;
    }
    if (ce.assignedCol === null) continue;
    corridorClaimZones.push(
      {
        axis: "v",
        coordinate: ce.assignedCol,
        rangeMin: Math.min(ce.srcGY, ce.tgtGY),
        rangeMax: Math.max(ce.srcGY, ce.tgtGY),
        signalType: ce.signalType,
        // Half-pitch ribbon lanes: a stranger half a cell away is as bad as overlap.
        weight: ce.assignedCol % 1 !== 0 ? 4 : undefined,
      },
      {
        axis: "h",
        coordinate: ce.srcGY,
        rangeMin: Math.min(ce.srcGX, ce.assignedCol),
        rangeMax: Math.max(ce.srcGX, ce.assignedCol),
        signalType: ce.signalType,
      },
      {
        axis: "h",
        coordinate: ce.tgtGY,
        rangeMin: Math.min(ce.assignedCol, ce.tgtGX),
        rangeMax: Math.max(ce.assignedCol, ce.tgtGX),
        signalType: ce.signalType,
      },
    );
  }

  // Stub-label boxes as HARD obstacles for the free-A* branch. Stub labels are not global
  // obstacles (their own wire must reach the handle on the box edge), and soft crossing
  // penalties proved too cheap — backward edges paid them and ran trunks straight through
  // a label stack's text. Foreign labels are simply not routable territory; boxes that
  // contain the leg's endpoints are skipped per-edge so approaches still work.
  const stubPixelRects: Rect[] = [];
  for (const n of nodes) {
    if (n.type !== "stub-label") continue;
    const pos = getAbsPos(n, nodeMap);
    stubPixelRects.push({
      left: pos.x,
      top: pos.y,
      right: pos.x + (n.measured?.width ?? STUB_W_EST),
      bottom: pos.y + (n.measured?.height ?? 14),
      nodeId: n.id,
    });
  }

  // ---------- PHASE 2: Path Construction ----------
  // Build paths from column assignments. For edges with assigned corridors,
  // route via the corridor as a mandatory waypoint using multi-leg A*.
  // This ensures the path uses the assigned column even when intermediate
  // devices block a simple L-shape.

  /** Route a single A* leg, retrying with relaxed obstacles on failure.
   *  localContext: pass true when the caller augments `penalties` and/or `rects` beyond
   *  the shared running state — forces building the penalty index from the array and the
   *  obstacle grid from the supplied rects (instead of the precomputed shared versions). */
  const routeLeg = (
    fromX: number, fromY: number, toX: number, toY: number,
    rects: Rect[], spread: number, penalties: PenaltyZone[] | undefined,
    sigType: string | undefined,
    noSrcStub: boolean, noTgtStub: boolean,
    excludeStartDir?: number, excludeEndDir?: number,
    srcNodeId?: string, tgtNodeId?: string,
    srcExitsRight?: boolean, tgtEntersLeft?: boolean,
    localContext?: boolean,
    relaxOwnRims?: boolean,
  ) => {
    const spatialIdx = localContext ? undefined : penaltySpatialIdx;
    const sharedGridRects = localContext ? undefined : precomputedGridRects;
    const pathLen = (wp: Point[]) => {
      let len = 0;
      for (let i = 1; i < wp.length; i++) len += Math.abs(wp[i].x - wp[i - 1].x) + Math.abs(wp[i].y - wp[i - 1].y);
      return len;
    };
    const padPx = ROUTING_PARAMS.PAD * cellSize();
    const shrinkRect = (r: Rect) =>
      ({ ...r, left: r.left + padPx, top: r.top + padPx, right: r.right - padPx, bottom: r.bottom - padPx });
    // Rim-relax mode (rip-up trials): the edge's OWN endpoint devices keep their body blocked
    // but give up the pad rim, matching the allocator's "rim usable / body never" rule — the
    // rim is the natural entry lane when every other lane at a crowded face is claimed, and
    // hard-blocking it forces A* outside the whole entry field (the S005 braid). Foreign
    // devices keep their full rim.
    let baseRects = rects;
    if (relaxOwnRims && (srcNodeId || tgtNodeId)) {
      baseRects = rects.map((r) =>
        r.nodeId && (r.nodeId === srcNodeId || r.nodeId === tgtNodeId) ? shrinkRect(r) : r);
    }
    const manhattan = Math.abs(toX - fromX) + Math.abs(toY - fromY);
    let result = computeEdgePath(
      fromX, fromY, toX, toY, baseRects, 0, spread,
      penalties, sigType, noSrcStub, noTgtStub,
      excludeStartDir, excludeEndDir,
      undefined, srcExitsRight, tgtEntersLeft,
      sharedGridRects, spatialIdx,
    );
    // A "successful" route that detours wildly is usually one whose sane path runs along
    // the edge's OWN device pad rim (blocked on the shared grid) — e.g. a stub label
    // tucked against its device. Try the rim-relaxed route and keep the shorter one.
    const badDetour = result && manhattan > 0 && pathLen(result.waypoints) > 3 * manhattan;
    if (!result || badDetour) {
      const excludeSet = new Set<string>();
      if (srcNodeId) excludeSet.add(srcNodeId);
      if (tgtNodeId) excludeSet.add(tgtNodeId);
      if (excludeSet.size > 0) {
        // Relax the edge's OWN endpoint devices by stripping their pad rim only — the
        // wire may hug its own device but never cross the body. Removing the rects
        // entirely let failed corridor legs route straight through the device.
        const relaxed = rects.map((r) =>
          r.nodeId && excludeSet.has(r.nodeId) ? shrinkRect(r) : r,
        );
        const rimResult = computeEdgePath(
          fromX, fromY, toX, toY, relaxed, 0, spread,
          penalties, sigType, noSrcStub, noTgtStub,
          excludeStartDir, excludeEndDir,
          undefined, srcExitsRight, tgtEntersLeft,
          undefined, spatialIdx,
        );
        if (rimResult && (!result || pathLen(rimResult.waypoints) < pathLen(result.waypoints))) {
          result = rimResult;
        }
        if (!result) {
          // Still stuck: if an endpoint sits INSIDE an own device's body (e.g. a stub
          // label tucked under the device), reaching the pin requires entering the body.
          // Remove exactly those rects — full removal stays reserved for this case.
          const inside = (r: Rect, x: number, y: number) =>
            x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
          const unreachable = rects.filter((r) =>
            r.nodeId && excludeSet.has(r.nodeId) &&
            (inside(shrinkRect(r), fromX, fromY) || inside(shrinkRect(r), toX, toY)));
          if (unreachable.length > 0) {
            const removedIds = new Set(unreachable.map((r) => r.nodeId));
            const opened = relaxed.filter((r) => !r.nodeId || !removedIds.has(r.nodeId));
            result = computeEdgePath(
              fromX, fromY, toX, toY, opened, 0, spread,
              penalties, sigType, noSrcStub, noTgtStub,
              excludeStartDir, excludeEndDir,
              undefined, srcExitsRight, tgtEntersLeft,
              undefined, spatialIdx,
            );
          }
        }
      }
    }
    return result;
  };

  // ---------- PHASE 0.5: bundles ----------
  // Route each bundle so its members CONVERGE on the shared break-in / break-out points: every
  // member gathers from its source straight to the break-in point, one trunk runs to the break-out
  // point, then each member fans out to its target. Routed AFTER manual edges (so legs dodge
  // already-placed routes) and BEFORE the column-edge loop. The whole comb is contributed as
  // penalty zones AFTER all of a bundle's members route — so ordinary edges and later bundles avoid
  // it, but members do NOT avoid EACH OTHER (their gather/fan legs are free to overlap as they
  // converge on the node). The trunk is also emitted as a synthetic `bundle:<id>` route.
  for (const [bid, members] of bundleGroups) {
    if (members.length < 2) continue;
    const spine = bundleSpines.get(bid);
    if (!spine) continue;
    const { entry, exit } = spine;

    // Freeze the penalty set for this bundle: members route against non-member routes (and earlier
    // bundles), but a snapshot means none of this bundle's own legs penalize each other.
    const bundlePenalties = runningPenalties.length > 0 ? [...runningPenalties] : undefined;

    // Trunk: user override polyline, or A*-route break-in→break-out dodging devices + routes.
    let trunkPath: Point[];
    if (spine.overrideTrunk) {
      trunkPath = spine.overrideTrunk;
    } else {
      const routedTrunk = checkBudget() ? null : routeLeg(
        entry.x, entry.y, exit.x, exit.y, obs.rects, 0, bundlePenalties,
        undefined, true, true, undefined, undefined, undefined, undefined, undefined, undefined,
      );
      trunkPath = routedTrunk ? routedTrunk.waypoints : [entry, exit];
    }

    // Route a polyline of via-points as chained A* legs (port stubs only at the true
    // endpoint). Used for a member's gather/fan leg when the user has placed waypoints on
    // it. Returns null when any leg fails or the budget is spent — caller falls back to a
    // straight orthogonalized chain so the waypoints still take effect.
    const routeChain = (
      pts: Point[],
      sigType: string | undefined,
      opts: {
        srcStub?: { nodeId: string; exitsRight: boolean };
        tgtStub?: { nodeId: string; entersLeft: boolean };
      },
    ): Point[] | null => {
      const out: Point[] = [];
      let prevArrival: number | undefined;
      for (let i = 0; i < pts.length - 1; i++) {
        const first = i === 0;
        const last = i === pts.length - 2;
        if (checkBudget()) return null;
        const leg = routeLeg(
          pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y,
          obs.rects, 0, bundlePenalties, sigType,
          !(first && opts.srcStub), !(last && opts.tgtStub),
          prevArrival !== undefined ? (prevArrival + 2) % 4 : undefined, undefined,
          first ? opts.srcStub?.nodeId : undefined,
          last ? opts.tgtStub?.nodeId : undefined,
          first ? opts.srcStub?.exitsRight : undefined,
          last ? opts.tgtStub?.entersLeft : undefined,
        );
        if (!leg) return null;
        prevArrival = leg.arrivalDir;
        out.push(...(out.length ? leg.waypoints.slice(1) : leg.waypoints));
      }
      return out;
    };

    const memberStates: RouteState[] = [];
    for (const ep of members) {
      const sigType = ep.edge.data?.signalType;
      // User waypoints on a member shape its gather/fan legs (the trunk section stays
      // shared — membership wins over a fully manual route).
      const { gather, fan } = splitMemberWaypoints(ep.edge.data?.manualWaypoints, entry, exit);
      // Gather leg: source → the break-in POINT. All members converge there (the bundle visibly
      // comes together at the draggable node), then share the trunk.
      //
      // Prefer the canonical COMB shape — horizontal at the port row, then one shared vertical
      // AT the junction column. Independent A* legs pick their turn columns by tie-break, so
      // two members could turn at different columns and weave each other (frozen penalty
      // snapshot = members can't see each other); on the shared column they merge instead.
      // Falls back to A* when a device blocks the L or the junction sits against the port's
      // exit direction.
      const srcRowG = px2g(ep.sourceY);
      const entryColG = px2g(entry.x);
      const gatherCombOk =
        gather.length === 0 &&
        (ep.sourceExitsRight ? entry.x >= ep.sourceX + cellSize() : entry.x <= ep.sourceX - cellSize()) &&
        isHSegmentClear(srcRowG, Math.min(px2g(ep.sourceX), entryColG), Math.max(px2g(ep.sourceX), entryColG), new Set([ep.edge.source])) &&
        isColumnClear(entryColG, Math.min(srcRowG, px2g(entry.y)), Math.max(srcRowG, px2g(entry.y)));
      const gatherPts = [{ x: ep.sourceX, y: ep.sourceY }, ...gather, entry];
      const branchIn = gatherCombOk
        ? { waypoints: [{ x: ep.sourceX, y: ep.sourceY }, { x: entry.x, y: ep.sourceY }, entry] }
        : gather.length > 0
          ? { waypoints:
              routeChain(gatherPts, sigType, { srcStub: { nodeId: ep.edge.source, exitsRight: ep.sourceExitsRight } })
              ?? simplifyWaypoints(orthogonalize(gatherPts)) }
          : checkBudget() ? null : routeLeg(
              ep.sourceX, ep.sourceY, entry.x, entry.y, obs.rects, 0, bundlePenalties,
              sigType, false, true, undefined, undefined, ep.edge.source, undefined,
              ep.sourceExitsRight, undefined,
            );
      // Fan leg: the break-out POINT → target. Same comb preference, mirrored.
      const tgtRowG = px2g(ep.targetY);
      const exitColG = px2g(exit.x);
      const fanCombOk =
        fan.length === 0 &&
        (ep.targetEntersLeft ? exit.x <= ep.targetX - cellSize() : exit.x >= ep.targetX + cellSize()) &&
        isHSegmentClear(tgtRowG, Math.min(exitColG, px2g(ep.targetX)), Math.max(exitColG, px2g(ep.targetX)), new Set([ep.edge.target])) &&
        isColumnClear(exitColG, Math.min(px2g(exit.y), tgtRowG), Math.max(px2g(exit.y), tgtRowG));
      const fanPts = [exit, ...fan, { x: ep.targetX, y: ep.targetY }];
      const branchOut = fanCombOk
        ? { waypoints: [exit, { x: exit.x, y: ep.targetY }, { x: ep.targetX, y: ep.targetY }] }
        : fan.length > 0
          ? { waypoints:
              routeChain(fanPts, sigType, { tgtStub: { nodeId: ep.edge.target, entersLeft: ep.targetEntersLeft } })
              ?? simplifyWaypoints(orthogonalize(fanPts)) }
          : checkBudget() ? null : routeLeg(
              exit.x, exit.y, ep.targetX, ep.targetY, obs.rects, 0, bundlePenalties,
              sigType, true, false, undefined, undefined, undefined, ep.edge.target,
              undefined, ep.targetEntersLeft,
            );
      const wp: Point[] = [
        { x: ep.sourceX, y: ep.sourceY },
        ...(branchIn ? branchIn.waypoints.slice(1, -1) : []),
        ...trunkPath,                  // break-in … break-out (supplies both node points)
        ...(branchOut ? branchOut.waypoints.slice(1, -1) : []),
        { x: ep.targetX, y: ep.targetY },
      ];
      const cleaned = simplifyWaypoints(orthogonalize(wp));
      const rs: RouteState = {
        edgeId: ep.edge.id, waypoints: cleaned, segments: extractSegments(cleaned),
        svgPath: waypointsToSvgPath(cleaned), labelX: entry.x, labelY: entry.y,
        turns: "bundle", status: "good", signalType: sigType,
      };
      routeStates.push(rs);
      memberStates.push(rs);
    }
    // Contribute the whole comb as penalty zones now (after all members) so ordinary edges and
    // later bundles route around it.
    for (const rs of memberStates) appendPenalties(rs);

    // Synthetic trunk route for the overlay layer (drawn once, thick, neutral).
    const trunkWp = simplifyWaypoints(orthogonalize(trunkPath));
    const mid = trunkWp[Math.floor(trunkWp.length / 2)] ?? entry;
    results[`bundle:${bid}`] = {
      edgeId: `bundle:${bid}`, svgPath: waypointsToSvgPath(trunkWp), waypoints: trunkWp,
      segments: extractSegments(trunkWp), labelX: mid.x, labelY: mid.y, turns: "trunk",
    };
  }

  for (const ce of columnEdges) {
    const ep = ce.ep;
    const sigType = ep.edge.data?.signalType;

    // Coordinated loop-back: construct the allocated U directly (the lanes were
    // verified clear and claimed at allocation time).
    if (ce.loopU) {
      const { x1, y, x2 } = ce.loopU;
      const cleaned = simplifyWaypoints([
        { x: ep.sourceX, y: ep.sourceY },
        { x: g2px(x1), y: ep.sourceY },
        { x: g2px(x1), y: g2px(y) },
        { x: g2px(x2), y: g2px(y) },
        { x: g2px(x2), y: ep.targetY },
        { x: ep.targetX, y: ep.targetY },
      ]);
      const rs: RouteState = {
        edgeId: ep.edge.id, waypoints: cleaned,
        segments: extractSegments(cleaned), svgPath: waypointsToSvgPath(cleaned),
        labelX: g2px(x1), labelY: (ep.sourceY + g2px(y)) / 2,
        turns: "loop-u", status: "good", signalType: sigType,
      };
      routeStates.push(rs);
      appendPenalties(rs);
      continue;
    }

    // A half-pitch lane (fractional column) is only constructible as a direct L-shape —
    // its x can't be an A* via point. The allocator pre-verified the same static
    // conditions, so this demotion should never fire; it's the safety net.
    if (ce.assignedCol !== null && ce.assignedCol % 1 !== 0 && !cleanCombLegOk(ce, ce.assignedCol)) {
      ce.assignedCol = null;
    }

    // Backward edges or edges without column assignment → unconstrained A* fallback.
    // Combined penalties (routed edges + allocator claims) force a local penalty index.
    if (ce.isBackward || ce.assignedCol === null) {
      const pens = runningPenalties.length > 0 || corridorClaimZones.length > 0
        ? [...runningPenalties, ...corridorClaimZones]
        : undefined;
      // Foreign stub labels are hard obstacles for free routing; skip the edge's own
      // stubs and any box an endpoint sits in (approaches must stay routable).
      const contains = (r: Rect, x: number, y: number) =>
        x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
      const foreignStubRects = stubPixelRects.filter((r) =>
        r.nodeId !== ep.edge.source && r.nodeId !== ep.edge.target &&
        !contains(r, ep.sourceX, ep.sourceY) && !contains(r, ep.targetX, ep.targetY));
      const rectsWithStubs = foreignStubRects.length > 0 ? [...obs.rects, ...foreignStubRects] : obs.rects;
      // If over time budget, skip A* and use fallback directly. If the label obstacles
      // leave no route at all, retry without them — a wire over a label beats the
      // obstacle-blind L-shape fallback.
      let result = checkBudget() ? null : routeLeg(
        ep.sourceX, ep.sourceY, ep.targetX, ep.targetY,
        rectsWithStubs, ep.stubSpread, pens,
        sigType, false, false, undefined, undefined,
        ep.edge.source, ep.edge.target,
        ep.sourceExitsRight, ep.targetEntersLeft,
        true,
      );
      if (!result && rectsWithStubs !== obs.rects && !checkBudget()) {
        result = routeLeg(
          ep.sourceX, ep.sourceY, ep.targetX, ep.targetY,
          obs.rects, ep.stubSpread, pens,
          sigType, false, false, undefined, undefined,
          ep.edge.source, ep.edge.target,
          ep.sourceExitsRight, ep.targetEntersLeft,
          true,
        );
      }
      if (result) {
        const rs: RouteState = {
          edgeId: ep.edge.id, waypoints: result.waypoints,
          segments: extractSegments(result.waypoints), svgPath: result.path,
          labelX: result.labelX, labelY: result.labelY,
          turns: result.turns, status: "good", signalType: sigType,
          ripupOk: true,
        };
        routeStates.push(rs);
        appendPenalties(rs);
      } else {
        // Fallback: route around the outside based on exit/entry directions
        const midX = ep.sourceExitsRight
          ? Math.max(ep.sourceX, ep.targetX) + 40
          : Math.min(ep.sourceX, ep.targetX) - 40;
        const wp: Point[] = [
          { x: ep.sourceX, y: ep.sourceY },
          { x: midX, y: ep.sourceY },
          { x: midX, y: ep.targetY },
          { x: ep.targetX, y: ep.targetY },
        ];
        const rs: RouteState = {
          edgeId: ep.edge.id, waypoints: wp,
          segments: extractSegments(wp),
          svgPath: wp.map((p, i) => i === 0 ? `M ${p.x} ${p.y}` : `L ${p.x} ${p.y}`).join(" "),
          labelX: midX, labelY: (ep.sourceY + ep.targetY) / 2,
          turns: "fallback", status: "bad", signalType: sigType,
          ripupOk: true,
        };
        routeStates.push(rs);
        appendPenalties(rs);
      }
      continue;
    }

    // Forward edge with assigned column → route via corridor as waypoint
    const corridorPx = g2px(ce.assignedCol);

    // Check if a clean L-shape works (no INTERMEDIATE obstacles on horizontal segments).
    // Exclude the edge's own source/target devices — the horizontal naturally exits/enters them.
    // Also verify the corridor is in the correct direction relative to exit/entry sides —
    // if the source exits left but the corridor is right (or vice versa), L-shape goes through device.
    const endpointIds = new Set([ep.edge.source, ep.edge.target]);
    const srcCorridorOk = ep.sourceExitsRight ? corridorPx >= ep.sourceX : corridorPx <= ep.sourceX;
    const tgtCorridorOk = ep.targetEntersLeft ? corridorPx <= ep.targetX : corridorPx >= ep.targetX;
    const hSeg1Clear = isHSegmentClear(ce.srcGY, Math.min(ce.srcGX, ce.assignedCol), Math.max(ce.srcGX, ce.assignedCol), endpointIds);
    const hSeg2Clear = isHSegmentClear(ce.tgtGY, Math.min(ce.tgtGX, ce.assignedCol), Math.max(ce.tgtGX, ce.assignedCol), endpointIds);

    if (srcCorridorOk && tgtCorridorOk && hSeg1Clear && hSeg2Clear) {
      // Clean L-shape: source → corridor → target
      const wp: Point[] = [
        { x: ep.sourceX, y: ep.sourceY },
        { x: corridorPx, y: ep.sourceY },
        { x: corridorPx, y: ep.targetY },
        { x: ep.targetX, y: ep.targetY },
      ];
      const cleaned = simplifyWaypoints(wp);
      const svgPath = waypointsToSvgPath(cleaned);
      const rs: RouteState = {
        edgeId: ep.edge.id, waypoints: cleaned,
        segments: extractSegments(cleaned), svgPath,
        labelX: corridorPx, labelY: (ep.sourceY + ep.targetY) / 2,
        turns: cleaned.length > 2
          ? cleaned.slice(1, -1).map((p) => `${Math.round(p.x)},${Math.round(p.y)}`).join(" → ")
          : "straight",
        status: "good", signalType: sigType,
      };
      routeStates.push(rs);
      appendPenalties(rs);
      continue;
    }

    // L-shape obstructed by intermediate devices → route via corridor as mandatory waypoint.
    // Split into legs: source → (corridor, srcY) → (corridor, tgtY) → target.
    // Each leg uses A* to navigate around obstacles while respecting the corridor.
    const pens = runningPenalties.length > 0 ? runningPenalties : undefined;

    // Corridor waypoints (the vertical segment endpoints)
    const cwp1 = { x: corridorPx, y: ep.sourceY }; // top of vertical
    const cwp2 = { x: corridorPx, y: ep.targetY }; // bottom of vertical

    // If over budget, skip A* legs
    const leg1 = checkBudget() ? null : routeLeg(
      ep.sourceX, ep.sourceY, cwp1.x, cwp1.y,
      obs.rects, ep.stubSpread, pens, sigType,
      false, true, // has source stub, no target stub (it's a waypoint)
      undefined, undefined, ep.edge.source, undefined,
      ep.sourceExitsRight, undefined,
    );

    // Leg 3: corridor bottom → target (horizontal-ish, navigates around intermediate devices)
    const leg3 = (leg1 && !checkBudget()) ? routeLeg(
      cwp2.x, cwp2.y, ep.targetX, ep.targetY,
      obs.rects, 0, pens, sigType,
      true, false, // no source stub (waypoint), has target stub
      undefined, undefined, undefined, ep.edge.target,
      undefined, ep.targetEntersLeft,
    ) : null;

    if (leg1 && leg3) {
      // Assemble: leg1 waypoints + vertical segment + leg3 waypoints
      let cleaned = simplifyWaypoints([
        ...leg1.waypoints,
        cwp2, // bottom of vertical (leg1 ends at cwp1, add cwp2 for vertical segment)
        ...leg3.waypoints.slice(1), // skip first point (it's cwp2)
      ]);

      // The corner waypoints pin the path to the source/target ROWS at the corridor x.
      // When a device forces a leg to detour, that pin can produce a HAIRPIN: dodge
      // under the device, climb back to the source row just to touch the corner, then
      // descend again — the vertical direction reverses twice. A single dodge-and-
      // continue (one reversal) is normal and keeps corridor discipline; only the
      // double reversal warrants abandoning the pinned corner. Try the decompositions
      // that skip it — source straight to the corridor BOTTOM, or corridor TOP straight
      // to the target — and keep the cheapest (length + A*'s own turn weight).
      let vFlips = 0;
      let lastVDir = 0;
      for (let i = 1; i < cleaned.length; i++) {
        const dy = cleaned[i].y - cleaned[i - 1].y;
        if (dy === 0) continue;
        const dir = Math.sign(dy);
        if (lastVDir !== 0 && dir !== lastVDir) vFlips++;
        lastVDir = dir;
      }
      if (vFlips >= 2) {
        const lenOf = (wp: Point[]) => {
          let len = 0;
          for (let i = 1; i < wp.length; i++) len += Math.abs(wp[i].x - wp[i - 1].x) + Math.abs(wp[i].y - wp[i - 1].y);
          return len;
        };
        const score = (wp: Point[]) => lenOf(wp) + (wp.length - 2) * ROUTING_PARAMS.TURN_PENALTY * cellSize();
        const consider = (wp: Point[] | null) => {
          if (wp && score(wp) < score(cleaned)) cleaned = wp;
        };
        if (!checkBudget()) {
          const legB = routeLeg(
            ep.sourceX, ep.sourceY, cwp2.x, cwp2.y,
            obs.rects, ep.stubSpread, pens, sigType,
            false, true, undefined, undefined, ep.edge.source, undefined,
            ep.sourceExitsRight, undefined,
          );
          consider(legB ? simplifyWaypoints([...legB.waypoints, ...leg3.waypoints.slice(1)]) : null);
        }
        if (!checkBudget()) {
          const legC = routeLeg(
            cwp1.x, cwp1.y, ep.targetX, ep.targetY,
            obs.rects, 0, pens, sigType,
            true, false, undefined, undefined, undefined, ep.edge.target,
            undefined, ep.targetEntersLeft,
          );
          consider(legC ? simplifyWaypoints([...leg1.waypoints, ...legC.waypoints.slice(1)]) : null);
        }
      }
      const svgPath = waypointsToSvgPath(cleaned);
      const rs: RouteState = {
        edgeId: ep.edge.id, waypoints: cleaned,
        segments: extractSegments(cleaned), svgPath,
        labelX: corridorPx, labelY: (ep.sourceY + ep.targetY) / 2,
        turns: cleaned.length > 2
          ? cleaned.slice(1, -1).map((p) => `${Math.round(p.x)},${Math.round(p.y)}`).join(" → ")
          : "straight",
        status: "good", signalType: sigType,
      };
      routeStates.push(rs);
      appendPenalties(rs);
    } else {
      // Multi-leg failed → force L-shape at corridor (may cross obstacles visually,
      // but at least uses the assigned corridor for consistent nesting)
      const wp: Point[] = [
        { x: ep.sourceX, y: ep.sourceY },
        { x: corridorPx, y: ep.sourceY },
        { x: corridorPx, y: ep.targetY },
        { x: ep.targetX, y: ep.targetY },
      ];
      const cleaned = simplifyWaypoints(wp);
      const rs: RouteState = {
        edgeId: ep.edge.id, waypoints: cleaned,
        segments: extractSegments(cleaned), svgPath: waypointsToSvgPath(cleaned),
        labelX: corridorPx, labelY: (ep.sourceY + ep.targetY) / 2,
        turns: "corridor-forced", status: "bad", signalType: sigType,
      };
      routeStates.push(rs);
      appendPenalties(rs);
    }
  }

  // ---------- PHASE 3: rip-up-and-reroute (weave repair) ----------
  // Sequential routing means every edge dodges only the edges routed BEFORE it; a pair that
  // ends up weaving (crossing back and forth, 2+ crossings) usually just needs ONE member
  // re-run now that the full picture exists. Only free-A* strays (ripupOk: backward edges,
  // allocator overflow) are eligible — corridor combs, loop-U brackets, bundles and manual
  // routes are coordinated shapes a lone reroute would break. A ripped edge re-routes
  // against penalty zones rebuilt from EVERYONE ELSE's final segments, and the new route is
  // kept only when it strictly reduces the edge's crossings against the whole set AND
  // lowers its A*-style cost (length + turns + crossings + shared-parallel).
  const RIPUP_MAX_TRIALS = ROUTER_PARAMS.RIPUP_TRIALS;
  if (RIPUP_MAX_TRIALS > 0 && !checkBudget() && routeStates.length > 1) {
    const epById = new Map(edgeEndpoints.map((e) => [e.edge.id, e] as const));

    const segLen = (segs: Segment[]) =>
      segs.reduce((sum, s) => sum + Math.abs(s.x2 - s.x1) + Math.abs(s.y2 - s.y1), 0);
    // Same-axis segments within 8px running together for >minOverlap px — the scorer's
    // "shared" shape.
    const sharedish = (a: Segment, b: Segment, minOverlap = 8) => {
      if (a.axis !== b.axis) return false;
      const coordGap = a.axis === "v" ? Math.abs(a.x1 - b.x1) : Math.abs(a.y1 - b.y1);
      if (coordGap >= 8) return false;
      const [a1, a2, b1, b2] = a.axis === "v"
        ? [a.y1, a.y2, b.y1, b.y2]
        : [a.x1, a.x2, b.x1, b.x2];
      return Math.min(Math.max(a1, a2), Math.max(b1, b2)) -
        Math.max(Math.min(a1, a2), Math.min(b1, b2)) > minOverlap;
    };
    /** Crossing + shared-parallel counts of a candidate geometry against every OTHER route. */
    const fieldStats = (segs: Segment[], self: RouteState) => {
      let cross = 0;
      let shared = 0;
      for (const o of routeStates) {
        if (o === self) continue;
        for (const so of o.segments) {
          for (const s of segs) {
            if (segmentsCross(s, so)) cross++;
            else if (sharedish(s, so)) shared++;
          }
        }
      }
      return { cross, shared };
    };
    const ripCost = (segs: Segment[], st: { cross: number; shared: number }) =>
      segLen(segs) / cellSize() +
      (segs.length - 1) * ROUTING_PARAMS.TURN_PENALTY +
      st.cross * ROUTING_PARAMS.CROSSING_PENALTY +
      st.shared * ROUTING_PARAMS.OVERLAP_PENALTY;
    const pairCrossings = (a: RouteState, b: RouteState) => {
      let count = 0;
      for (const sa of a.segments) {
        for (const sb of b.segments) if (segmentsCross(sa, sb)) count++;
      }
      return count;
    };
    // Substantial colinear lane-sharing between two routes (>24px = 1.5 cells, so a pair of
    // stacked-port approaches a full cell apart never qualifies).
    const pairShared = (a: RouteState, b: RouteState) => {
      let count = 0;
      for (const sa of a.segments) {
        for (const sb of b.segments) if (sharedish(sa, sb, 24)) count++;
      }
      return count;
    };

    // Collect repair pairs with at least one rip-eligible member. Two defect classes, both
    // born the same way (the earlier-routed member never saw the later one): WEAVES (2+
    // mutual crossings) and SHARED-PARALLEL runs (a stray squatting on a lane another edge
    // later claimed — e.g. an early free-A* edge riding what becomes a comb trunk column).
    // Shared lanes are the worst defect in the aesthetic hierarchy, so they repair FIRST.
    type RepairPair = { a: RouteState; b: RouteState; severity: number; kind: "weave" | "shared" };
    const repairPairs: RepairPair[] = [];
    for (let i = 0; i < routeStates.length; i++) {
      for (let j = i + 1; j < routeStates.length; j++) {
        if (!routeStates[i].ripupOk && !routeStates[j].ripupOk) continue;
        const a = routeStates[i], b = routeStates[j];
        const shared = pairShared(a, b);
        if (shared >= 1) { repairPairs.push({ a, b, severity: 1000 + shared, kind: "shared" }); continue; }
        const count = pairCrossings(a, b);
        if (count >= 2) repairPairs.push({ a, b, severity: count, kind: "weave" });
      }
    }
    repairPairs.sort((p, q) => q.severity - p.severity);

    const ripDbg = (globalThis as Record<string, unknown>).__dumpRipup
      ? (msg: string) => console.log(`[ripup] ${msg}`)
      : null;
    // Debug capture: when a Map is installed at __ripupCapture, store each trial's exact
    // penalty field + endpoints so headless probes can replay A*'s cost model offline.
    const ripCapture = (globalThis as Record<string, unknown>).__ripupCapture as
      | Map<string, { pens: PenaltyZone[]; ep: EdgeEndpoints; rects: Rect[] }>
      | undefined;
    ripDbg?.(
      `${repairPairs.filter((p) => p.kind === "shared").length} shared + ` +
      `${repairPairs.filter((p) => p.kind === "weave").length} weave pair(s), budget ${RIPUP_MAX_TRIALS}`);

    let trials = 0;
    // One accepted rip per (edge, defect kind): a shared-lane repair must not lock the edge
    // out of a later weave repair (each rip rebuilds the penalty field from everyone's
    // CURRENT segments, so a second rip is coherent), but same-kind re-rips would thrash.
    const ripped = new Map<RouteState, Set<"weave" | "shared">>();
    const contains = (r: Rect, x: number, y: number) =>
      x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    for (const pair of repairPairs) {
      if (trials >= RIPUP_MAX_TRIALS || checkBudget()) break;
      // Earlier accepted reroutes may have already cleaned this pair up.
      if (pair.kind === "weave"
        ? pairCrossings(pair.a, pair.b) < 2
        : pairShared(pair.a, pair.b) < 1) continue;
      for (const rs of [pair.a, pair.b]) {
        if (!rs.ripupOk || ripped.get(rs)?.has(pair.kind) || !epById.has(rs.edgeId)) continue;
        if (trials >= RIPUP_MAX_TRIALS || checkBudget()) break;
        trials++;
        const ep = epById.get(rs.edgeId)!;
        // Everyone else's final geometry as penalty zones (the incremental runningPenalties
        // can't subtract one edge's contribution), plus the allocator claims.
        const pens: PenaltyZone[] = [...corridorClaimZones];
        for (const o of routeStates) {
          if (o === rs) continue;
          for (const seg of o.segments) {
            pens.push(seg.axis === "v"
              ? { axis: "v", coordinate: px2g(seg.x1), rangeMin: px2g(Math.min(seg.y1, seg.y2)), rangeMax: px2g(Math.max(seg.y1, seg.y2)), signalType: o.signalType }
              : { axis: "h", coordinate: px2g(seg.y1), rangeMin: px2g(Math.min(seg.x1, seg.x2)), rangeMax: px2g(Math.max(seg.x1, seg.x2)), signalType: o.signalType });
          }
        }
        const foreignStubRects = stubPixelRects.filter((r) =>
          r.nodeId !== ep.edge.source && r.nodeId !== ep.edge.target &&
          !contains(r, ep.sourceX, ep.sourceY) && !contains(r, ep.targetX, ep.targetY));
        const ripRects = foreignStubRects.length > 0 ? [...obs.rects, ...foreignStubRects] : obs.rects;
        ripCapture?.set(rs.edgeId, { pens: [...pens], ep, rects: [...ripRects] });
        const result = routeLeg(
          ep.sourceX, ep.sourceY, ep.targetX, ep.targetY,
          ripRects,
          ep.stubSpread, pens, rs.signalType, false, false,
          undefined, undefined, ep.edge.source, ep.edge.target,
          ep.sourceExitsRight, ep.targetEntersLeft, true, true,
        );
        if (!result) { ripDbg?.(`${rs.edgeId}: A* null`); continue; }
        const segs = extractSegments(result.waypoints);
        // Shape guards the cost function can't express: a repair that turns the edge into
        // a snake (many extra turns) or adds a backward jog reads WORSE than the weave it
        // removes, whatever the weighted sum says.
        if (segs.length > rs.segments.length + 2) { ripDbg?.(`${rs.edgeId}: snake (${segs.length} vs ${rs.segments.length})`); continue; }
        const backCount = (ss: Segment[]) =>
          ep.targetX > ep.sourceX ? ss.filter((s) => s.axis === "h" && s.x2 < s.x1).length : 0;
        if (backCount(segs) > backCount(rs.segments)) { ripDbg?.(`${rs.edgeId}: backward jog`); continue; }
        const before = fieldStats(rs.segments, rs);
        const after = fieldStats(segs, rs);
        if (pair.kind === "weave") {
          if (after.cross >= before.cross) { ripDbg?.(`${rs.edgeId}: cross ${before.cross}->${after.cross} not better`); continue; }
          // Shared verticals outrank crossings in the aesthetic hierarchy — a repair that
          // converts a weave into a parallel overlap is a downgrade the weighted cost can
          // happily accept (2 crossings cost more than 1 shared). Never trade into shared.
          if (after.shared > before.shared) { ripDbg?.(`${rs.edgeId}: shared ${before.shared}->${after.shared} worse`); continue; }
          if (ripCost(segs, after) >= ripCost(rs.segments, before)) { ripDbg?.(`${rs.edgeId}: cost not better`); continue; }
        } else {
          // Shared-lane repair: removing the overlap is worth a couple of NEW crossings
          // (shared is the worse defect), so the candidate-param ripCost gate doesn't get a
          // vote — under a crossing-heavy candidate (e.g. cx30) the model PREFERS the squat
          // it chose, which is exactly the defect being repaired. Explicit guards instead.
          if (after.shared >= before.shared) { ripDbg?.(`${rs.edgeId}: shared ${before.shared}->${after.shared} not better`); continue; }
          if (after.cross > before.cross + 2) { ripDbg?.(`${rs.edgeId}: shared fix costs ${after.cross - before.cross} crossings`); continue; }
          if (segLen(segs) > segLen(rs.segments) + 8 * cellSize()) { ripDbg?.(`${rs.edgeId}: shared fix detours`); continue; }
        }
        ripDbg?.(`${rs.edgeId}: ACCEPT [${pair.kind}] cross ${before.cross}->${after.cross} shared ${before.shared}->${after.shared}`);
        rs.waypoints = result.waypoints;
        rs.segments = segs;
        rs.svgPath = result.path;
        rs.labelX = result.labelX;
        rs.labelY = result.labelY;
        rs.turns = "rip-up";
        rs.status = "good";
        const kinds = ripped.get(rs) ?? new Set<"weave" | "shared">();
        kinds.add(pair.kind);
        ripped.set(rs, kinds);
        break; // pair handled — move to the next repair pair
      }
    }
  }

  // Park unavoidable sub-grid steps against the pins (pins a few px apart vertically force a
  // sub-cell step somewhere; mid-span it reads as a routing mistake, at the port it reads as a
  // port entry). Cosmetic relocation only — same turns and length. Runs BEFORE crossing
  // detection so hop arcs match the drawn geometry.
  for (const rs of routeStates) {
    const tucked = tuckSubgridSteps(rs.waypoints);
    if (tucked !== rs.waypoints) {
      rs.waypoints = tucked;
      rs.segments = extractSegments(tucked);
      rs.svgPath = waypointsToSvgPath(tucked);
    }
  }

  // Detect crossing points between all edge pairs (skip if over budget — cosmetic only).
  // Horizontal edge at a crossing gets an arc (hop over);
  // vertical edge at the same crossing gets a gap (moveTo cut).
  const arcCrossingMap = new Map<string, CrossingPoint[]>();
  const gapCrossingMap = new Map<string, CrossingPoint[]>();
  if (!overBudget) {
    for (const rs of routeStates) {
      arcCrossingMap.set(rs.edgeId, []);
      gapCrossingMap.set(rs.edgeId, []);
    }
    for (let i = 0; i < routeStates.length; i++) {
      for (let j = i + 1; j < routeStates.length; j++) {
        const a = routeStates[i];
        const b = routeStates[j];
        for (const sa of a.segments) {
          for (const sb of b.segments) {
            if (segmentsCross(sa, sb)) {
              const h = sa.axis === "h" ? sa : sb;
              const v = sa.axis === "v" ? sa : sb;
              const pt: CrossingPoint = { x: v.x1, y: h.y1 };
              if (sa.axis === "h") {
                arcCrossingMap.get(a.edgeId)!.push(pt);
                gapCrossingMap.get(b.edgeId)!.push(pt);
              } else {
                arcCrossingMap.get(b.edgeId)!.push(pt);
                gapCrossingMap.get(a.edgeId)!.push(pt);
              }
            }
          }
        }
      }
    }
  }

  // Build final results
  for (const rs of routeStates) {
    const arcPts = arcCrossingMap.get(rs.edgeId) ?? [];
    const gapPts = gapCrossingMap.get(rs.edgeId) ?? [];
    const hopPath = (arcPts.length > 0 || gapPts.length > 0)
      ? waypointsToSvgPathWithHops(rs.waypoints, arcPts, gapPts)
      : undefined;
    results[rs.edgeId] = {
      edgeId: rs.edgeId,
      svgPath: rs.svgPath,
      svgPathWithHops: hopPath,
      waypoints: rs.waypoints,
      segments: rs.segments,
      labelX: rs.labelX,
      labelY: rs.labelY,
      turns: rs.turns,
      crossingPoints: arcPts,
    };
  }

  if (debug) {
    logRoutingReport(routeStates, edgeEndpoints);
  }

  // Export debug data for overlay and Claude analysis
  const finalPenalties = runningPenalties;

  const w = globalThis as unknown as Record<string, unknown>;
  w.__routingDebug = {
    obstacles: obs.rects,
    penaltyZones: finalPenalties,
    edges: Object.fromEntries(edgeEndpoints.map((ep) => {
      const rs = routeStates.find((r) => r.edgeId === ep.edge.id);
      return [ep.edge.id, {
        source: { x: ep.sourceX, y: ep.sourceY, exitsRight: ep.sourceExitsRight },
        target: { x: ep.targetX, y: ep.targetY, entersLeft: ep.targetEntersLeft },
        signalType: ep.edge.data?.signalType,
        path: rs?.waypoints ?? [],
        turns: rs?.turns ?? "",
        status: rs?.status ?? "unknown",
      }];
    })),
  };

  return { routes: results, overBudget };
}
