// Shared constants + helper for placing stub-label nodes. Used by:
//   - convertEdgeToStubs (store.ts) for newly stubbed connections
//   - migrateStubsToNodes (migrations.ts) for legacy schematics with no stub-end coords
//   - onNodeDrag/onNodeDragStop (App.tsx) to center-snap the box on the 20px grid
//   - StubLabelNode.tsx re-exports the constants for cohesion

import { GRID_SIZE } from "./gridConstants";
import type { SchematicNode, ConnectionEdge, StubLabelData } from "./types";
import type { HandleSnapshot } from "./routing/handleSnapshot";

export const STUB_GAP = 64;       // gap between device port and the stub box edge facing it
                                  // (large enough for a midpoint cable-ID badge to fit between)
export const STUB_W_EST = 80;     // estimated box width before React Flow has measured the DOM
export const STUB_H_EST = 14;     // estimated box height (9px line-height + 1.5×2 padding + 1×2 border)

/**
 * Snap a stub box top so its connecting HANDLE (vertical center of the box) lands on the
 * nearest grid line. The box is 14px tall with the handle at top+7, so a grid-aligned box
 * TOP puts the handle 7px off-grid — the source of the ~7px endpoint jogs (the paired
 * device port is on-grid in the layout model). Used by the routing-harness normalize,
 * where mock ports ARE the model. The app heals against the REAL port instead (below) —
 * DOM-measured ports can sit a few px off the model grid, and grid-snapping a stub whose
 * port is off-grid breaks colinearity (visible kink at the label).
 */
export function snapStubHandleY(top: number, height: number = STUB_H_EST): number {
  const half = height / 2;
  return Math.round((top + half) / GRID_SIZE) * GRID_SIZE - half;
}

/**
 * Align every stub-label's connecting handle with its partner device port's TRUE
 * (DOM-measured) row. Only sub-grid drift is corrected (0.75px ≤ |dy| < half a cell):
 * smaller is already colinear, larger is a deliberate user offset. Returns the corrected
 * nodes array, or null when nothing needed fixing. Idempotent — corrected stubs measure
 * within the dead-band on the next pass.
 */
export function healStubPortAlignment(
  nodes: SchematicNode[],
  edges: ConnectionEdge[],
  handles: HandleSnapshot,
): SchematicNode[] | null {
  const stubIds = stubLabelIds(nodes);
  if (stubIds.size === 0) return null;

  const fixes = new Map<string, number>(); // stub node id → absolute dy to apply
  for (const e of edges) {
    if (!isStubLeg(e, stubIds)) continue;
    const srcIsStub = stubIds.has(e.source);
    const stubId = srcIsStub ? e.source : e.target;
    if (fixes.has(stubId)) continue;
    const devId = srcIsStub ? e.target : e.source;
    const devHandleId = (srcIsStub ? e.targetHandle : e.sourceHandle) ?? "";
    const stubSnap = handles[stubId];
    const devSnap = handles[devId];
    if (!stubSnap || !devSnap) continue;
    // Same bare↔directional healing the router's resolveHandle does.
    const all = [...devSnap.source, ...devSnap.target];
    const dh =
      all.find((h) => h.id === devHandleId) ??
      all.find((h) => h.id === `${devHandleId}-out`) ??
      all.find((h) => h.id === `${devHandleId}-in`) ??
      (devHandleId.endsWith("-in") || devHandleId.endsWith("-out")
        ? all.find((h) => h.id === devHandleId.replace(/-(in|out)$/, ""))
        : undefined);
    if (!dh) continue;
    const portY = devSnap.positionAbsolute.y + dh.y + dh.height / 2;
    const stubHandleY = stubSnap.positionAbsolute.y + (stubSnap.measuredHeight ?? STUB_H_EST) / 2;
    const dy = portY - stubHandleY;
    if (Math.abs(dy) >= 0.75 && Math.abs(dy) < GRID_SIZE / 2) fixes.set(stubId, dy);
  }
  if (fixes.size === 0) return null;

  return nodes.map((n) => {
    const dy = fixes.get(n.id);
    if (dy === undefined) return n;
    return { ...n, position: { x: n.position.x, y: Math.round(n.position.y + dy) } };
  });
}

/**
 * Decide where the middle custom label sits on an edge (#201).
 *
 * A normal connection keeps the label at the geometric midpoint of the route.
 * A stub LEG has exactly one endpoint that is a stub-label node; there the label
 * is anchored to the STUB end so it reads between the cable ID (near the device /
 * leg midpoint) and the stub-label box — matching the request to expose custom
 * labels "in between the Cable ID and Stub Label". `fromSource` reports which end
 * carries the stub, so the caller can offset inward from it.
 */
export function midCustomLabelPlacement(
  sourceIsStub: boolean,
  targetIsStub: boolean,
): { mode: "midpoint" } | { mode: "stub-end"; fromSource: boolean } {
  // Exactly one end is a stub → this is a stub leg. (A well-formed edge never
  // has both ends on stub nodes; guard by treating that as "not a stub leg".)
  if (sourceIsStub === targetIsStub) return { mode: "midpoint" };
  return { mode: "stub-end", fromSource: sourceIsStub };
}

/**
 * Which side of a stub box faces `towardX` — the side the wire has to enter.
 *
 * The l/r handle stored on a stub leg is only the creation-time guess; dragging the tag
 * (or its device) to the other side leaves it stale, so both route builders re-derive the
 * side from live geometry and MUST agree: `nearestStubHandle` in edgeRouter (auto-route)
 * and `computeSimpleRoutes` in store (auto-route off). Ties (`towardX` exactly at the box
 * centre) resolve to "r", matching the original inequality.
 */
export function nearestStubHandleSide(
  boxLeft: number,
  boxWidth: number,
  towardX: number,
): "l" | "r" {
  return towardX < boxLeft + boxWidth / 2 ? "l" : "r";
}

/** Exactly one end of the edge is a stub-label node → it is one leg of a stubbed connection. */
function isStubLeg(edge: { source: string; target: string }, stubIds: Set<string>): boolean {
  return stubIds.has(edge.source) !== stubIds.has(edge.target);
}

/** Ids of every stub-label node, for the whole-graph passes below. */
function stubLabelIds(nodes: SchematicNode[]): Set<string> {
  return new Set(nodes.filter((n) => n.type === "stub-label").map((n) => n.id));
}

/**
 * The stub tag this connection terminates at, or null when it is not one leg of a stubbed
 * connection. The OTHER end is the leg's true end — the device port — and re-routes or
 * disconnects like any ordinary connection end; the tag end does neither (a tag is not a
 * port, and its handles are not connectable).
 *
 * Called per pointer-move while a connection is being dragged, so it looks up only the two
 * endpoints rather than sweeping every node the way the whole-graph passes do.
 */
export function stubTagEndOf(
  edge: { source: string; target: string },
  nodes: SchematicNode[],
): string | null {
  const isTag = (id: string) => nodes.find((n) => n.id === id)?.type === "stub-label";
  const srcIsStub = isTag(edge.source);
  if (srcIsStub === isTag(edge.target)) return null;
  return srcIsStub ? edge.source : edge.target;
}

/**
 * Drop the wreckage of a half-removed stubbed connection (#318).
 *
 * A stubbed connection is TWO legs sharing a linkedConnectionId plus the two stub-label
 * tags they terminate at. Removing one leg on its own — dragging its reconnect handle into
 * empty space, or Delete on a single selected leg — left the partner leg and both tags in
 * place: the surviving tag can no longer find a partner edge, the orphaned tag has no edge
 * at all, and StubLabelNode renders "?" at BOTH ends. Run the survivors through here after
 * any edge removal so a link is either whole or gone.
 *
 * Removes: legs of a link that no longer has both halves, and stub tags left with no leg.
 * Pure; returns the same array refs when nothing needed removing.
 */
export function reconcileStubPairs(
  nodes: SchematicNode[],
  edges: ConnectionEdge[],
): { nodes: SchematicNode[]; edges: ConnectionEdge[]; removedLinks: number } {
  const stubIds = stubLabelIds(nodes);
  if (stubIds.size === 0) return { nodes, edges, removedLinks: 0 };

  // Which stub tags each link still has a leg for. A link keyed off the EDGE's
  // linkedConnectionId; a leg missing that id can only be matched by its tag, so fall
  // back to the tag's own copy (they are written together and never diverge).
  const linkOf = (edge: ConnectionEdge, stubId: string): string | undefined =>
    edge.data?.linkedConnectionId ??
    (nodes.find((n) => n.id === stubId)?.data as StubLabelData | undefined)?.linkedConnectionId;

  const tagsWithLeg = new Set<string>();
  const legStubsByLink = new Map<string, Set<string>>();
  for (const e of edges) {
    if (!isStubLeg(e, stubIds)) continue;
    const stubId = stubIds.has(e.source) ? e.source : e.target;
    tagsWithLeg.add(stubId);
    const link = linkOf(e, stubId);
    if (!link) continue;
    let set = legStubsByLink.get(link);
    if (!set) { set = new Set(); legStubsByLink.set(link, set); }
    set.add(stubId);
  }

  // A link is whole only when both of its legs are present, each on its own tag.
  const brokenLinks = new Set<string>();
  for (const [link, tags] of legStubsByLink) {
    if (tags.size < 2) brokenLinks.add(link);
  }

  const linkOfNode = (n: SchematicNode): string | undefined =>
    n.type === "stub-label" ? (n.data as StubLabelData).linkedConnectionId : undefined;

  const dropTag = (n: SchematicNode): boolean => {
    if (n.type !== "stub-label") return false;
    const link = linkOfNode(n);
    return (link !== undefined && brokenLinks.has(link)) || !tagsWithLeg.has(n.id);
  };
  const dropEdge = (e: ConnectionEdge): boolean => {
    if (!isStubLeg(e, stubIds)) return false;
    const link = linkOf(e, stubIds.has(e.source) ? e.source : e.target);
    return link !== undefined && brokenLinks.has(link);
  };

  const nextNodes = nodes.filter((n) => !dropTag(n));
  const nextEdges = edges.filter((e) => !dropEdge(e));
  if (nextNodes.length === nodes.length && nextEdges.length === edges.length) {
    return { nodes, edges, removedLinks: 0 };
  }
  return { nodes: nextNodes, edges: nextEdges, removedLinks: brokenLinks.size };
}

/**
 * Place the stub box so the BOX EDGE facing the device is `STUB_GAP` from the
 * device port, and the box CENTER aligns with the port's Y. Returns the absolute
 * top-left position plus which side ("l"|"r") of the box is the connecting handle.
 */
export function defaultStubPlacement(
  handlePos: { x: number; y: number },
  portSide: "left" | "right",
): { pos: { x: number; y: number }; handle: "l" | "r" } {
  if (portSide === "right") {
    // Stub sits to the right of device; connecting handle is on the stub's LEFT side.
    return {
      pos: { x: handlePos.x + STUB_GAP, y: handlePos.y - STUB_H_EST / 2 },
      handle: "l",
    };
  }
  // Stub sits to the left of device; connecting handle is on the stub's RIGHT side.
  return {
    pos: { x: handlePos.x - STUB_GAP - STUB_W_EST, y: handlePos.y - STUB_H_EST / 2 },
    handle: "r",
  };
}
