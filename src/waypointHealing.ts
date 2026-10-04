/**
 * Manual-waypoint healing.
 *
 * `edge.data.manualWaypoints` are stored as ABSOLUTE canvas coordinates. Nothing
 * translates them when a device or room moves, so after a move the intermediate
 * waypoints stay put while the endpoints follow the device — the edge detours back
 * to the stale positions, sometimes routing straight through a device. (This is the
 * "WeirdRoomReroute" failure: auto-routing the same topology from scratch is clean.)
 *
 * Two defenses:
 *   1. PROACTIVE — translateWaypointsForMovedGroup: when a set of nodes move together
 *      by a common delta (room drag, multi-select drag), rigidly shift the waypoints of
 *      edges whose BOTH endpoints are in the moved set. Preserves the routing exactly.
 *   2. REACTIVE — healStaleWaypoints: conservatively drop manual waypoints that are
 *      *obviously* stale (a waypoint inside a non-endpoint device body, or far outside
 *      the endpoints' bounding box) so the edge re-auto-routes. Self-heals saved files.
 *      Deliberately conservative — does not touch plausibly-intentional routing.
 */

import type { SchematicNode, ConnectionEdge } from "./types";
import { parentOffsetFromMap } from "./snapUtils";

/** Waypoints more than this far outside the endpoints' bounding box are stranded. */
const STRAND_MARGIN_PX = 250;

function buildAbsPos(nodes: SchematicNode[]) {
  const map = new Map<string, SchematicNode>();
  for (const n of nodes) map.set(n.id, n);
  return (id: string): { x: number; y: number } | null => {
    const node = map.get(id);
    if (!node) return null;
    const { dx, dy } = parentOffsetFromMap(node, map);
    return { x: node.position.x + dx, y: node.position.y + dy };
  };
}

interface DeviceRect {
  id: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function deviceRects(nodes: SchematicNode[], absPos: (id: string) => { x: number; y: number } | null): DeviceRect[] {
  const rects: DeviceRect[] = [];
  for (const n of nodes) {
    if (n.type !== "device") continue;
    const p = absPos(n.id);
    if (!p) continue;
    const w = n.measured?.width ?? 180;
    const h = n.measured?.height ?? 60;
    rects.push({ id: n.id, left: p.x, top: p.y, right: p.x + w, bottom: p.y + h });
  }
  return rects;
}

/**
 * Identify edges whose manual waypoints are obviously stale (conservative):
 *   - a waypoint sits strictly inside a device body that isn't the edge's own endpoint, or
 *   - a waypoint lies more than STRAND_MARGIN_PX outside the endpoints' bounding box.
 */
export function findStaleWaypointEdges(
  nodes: SchematicNode[],
  edges: ConnectionEdge[],
): Set<string> {
  const absPos = buildAbsPos(nodes);
  const rects = deviceRects(nodes, absPos);
  const stale = new Set<string>();

  for (const edge of edges) {
    const wps = edge.data?.manualWaypoints;
    if (!Array.isArray(wps) || wps.length === 0) continue;

    const src = absPos(edge.source);
    const tgt = absPos(edge.target);
    // Endpoint bounding box (device top-lefts are a good-enough proxy for staleness).
    let boxOk = false;
    let bxMin = 0, byMin = 0, bxMax = 0, byMax = 0;
    if (src && tgt) {
      const srcRect = rects.find((r) => r.id === edge.source);
      const tgtRect = rects.find((r) => r.id === edge.target);
      bxMin = Math.min(srcRect?.left ?? src.x, tgtRect?.left ?? tgt.x) - STRAND_MARGIN_PX;
      byMin = Math.min(srcRect?.top ?? src.y, tgtRect?.top ?? tgt.y) - STRAND_MARGIN_PX;
      bxMax = Math.max(srcRect?.right ?? src.x, tgtRect?.right ?? tgt.x) + STRAND_MARGIN_PX;
      byMax = Math.max(srcRect?.bottom ?? src.y, tgtRect?.bottom ?? tgt.y) + STRAND_MARGIN_PX;
      boxOk = true;
    }

    let bad = false;
    for (const wp of wps) {
      // (a) inside a non-endpoint device body
      for (const r of rects) {
        if (r.id === edge.source || r.id === edge.target) continue;
        if (wp.x > r.left && wp.x < r.right && wp.y > r.top && wp.y < r.bottom) {
          bad = true;
          break;
        }
      }
      if (bad) break;
      // (b) far outside the endpoints' bounding box
      if (boxOk && (wp.x < bxMin || wp.x > bxMax || wp.y < byMin || wp.y > byMax)) {
        bad = true;
        break;
      }
    }
    if (bad) stale.add(edge.id);
  }

  return stale;
}

/** Strip manual waypoints from an edge so it re-auto-routes. */
function clearWaypoints(edge: ConnectionEdge): ConnectionEdge {
  if (!edge.data) return edge;
  const { manualWaypoints: _mw, autoRouteWaypoints: _ar, ...rest } = edge.data;
  return { ...edge, data: rest as ConnectionEdge["data"] };
}

/**
 * Conservatively drop obviously-stale manual waypoints. Returns the updated edges
 * and the ids that were healed (empty array → returns the same `edges` reference).
 */
export function healStaleWaypoints(
  nodes: SchematicNode[],
  edges: ConnectionEdge[],
): { edges: ConnectionEdge[]; healed: string[] } {
  const stale = findStaleWaypointEdges(nodes, edges);
  if (stale.size === 0) return { edges, healed: [] };
  const healed: string[] = [];
  const next = edges.map((e) => {
    if (!stale.has(e.id)) return e;
    healed.push(e.id);
    return clearWaypoints(e);
  });
  return { edges: next, healed };
}

/**
 * Rigidly translate the manual waypoints of edges whose BOTH endpoints are in the
 * moved set, by (dx, dy). Used when a room or multi-selection moves as a unit so the
 * routing keeps its shape. Returns the same `edges` reference when nothing changes.
 */
export function translateWaypointsForMovedGroup(
  edges: ConnectionEdge[],
  movedNodeIds: Set<string>,
  dx: number,
  dy: number,
): ConnectionEdge[] {
  if ((dx === 0 && dy === 0) || movedNodeIds.size === 0) return edges;
  let changed = false;
  const next = edges.map((edge) => {
    const wps = edge.data?.manualWaypoints;
    if (!Array.isArray(wps) || wps.length === 0) return edge;
    if (!movedNodeIds.has(edge.source) || !movedNodeIds.has(edge.target)) return edge;
    changed = true;
    return {
      ...edge,
      data: {
        ...edge.data!,
        manualWaypoints: wps.map((p) => ({ x: p.x + dx, y: p.y + dy })),
      },
    };
  });
  return changed ? next : edges;
}
