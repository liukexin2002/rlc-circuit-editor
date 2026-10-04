import type { ConnectionEdge, BundleMeta, SchematicNode, BundleJunctionNode } from "./types";
import { GRID_SIZE } from "./gridConstants";

/** React Flow node type for a bundle's break-in / break-out anchor. */
export const BUNDLE_JUNCTION_TYPE = "bundle-junction" as const;

let bundleCounter = 0;
/** Fresh bundle id (mirrors the linked-connection id scheme). */
export function newBundleId(): string {
  bundleCounter += 1;
  return `bundle-${Date.now().toString(36)}-${bundleCounter}`;
}

/** Edges belonging to a bundle. */
export function bundleMembers(edges: ConnectionEdge[], id: string): ConnectionEdge[] {
  return edges.filter((e) => e.data?.bundleId === id);
}

/** The break-in / break-out anchor nodes for a bundle (either may be missing until the
 *  heal pass spawns it — see reconcileBundleJunctions). Pure; callers read positions off
 *  the returned nodes. */
export function bundleJunctionsFor(
  nodes: SchematicNode[],
  id: string,
): { in?: BundleJunctionNode; out?: BundleJunctionNode } {
  let inNode: BundleJunctionNode | undefined;
  let outNode: BundleJunctionNode | undefined;
  for (const n of nodes) {
    if (n.type !== BUNDLE_JUNCTION_TYPE) continue;
    const jn = n as BundleJunctionNode;
    if (jn.data.bundleId !== id) continue;
    if (jn.data.role === "in") inNode = jn;
    else if (jn.data.role === "out") outNode = jn;
  }
  return { in: inNode, out: outNode };
}

/** Deterministic id for a bundle's break-in / break-out anchor node. Deterministic so the
 *  heal pass is idempotent (existence check by id) and paste can derive the new id from the
 *  remapped bundle id. */
export function junctionNodeId(bundleId: string, role: "in" | "out"): string {
  return `bj-${bundleId}-${role}`;
}

/** Gap (px) between a member device cluster and its break-in/out anchor — mirrors
 *  computeBundleTrunk's default. Two routing cells. */
const JUNCTION_GAP = 2 * GRID_SIZE;
/** Match the waypoint-node z so junctions sit above (elevated) edges and stay clickable. */
const JUNCTION_Z_INDEX = 100;
/** Routing grid (px). Junction anchors are snapped to it so the drawn trunk — which the
 *  router A*-snaps to this grid — passes exactly through the handle (no few-px float). */
const snapGrid = (v: number) => Math.round(v / GRID_SIZE) * GRID_SIZE;

/** Absolute bounding box (left/right edge + vertical center) of a node, walking the parent
 *  chain so devices nested in rooms resolve correctly. measured size supersedes the 180×60
 *  device fallback once React Flow has measured. */
function absNodeBox(
  n: SchematicNode,
  nodeMap: Map<string, SchematicNode>,
): { left: number; right: number; centerY: number } {
  let x = n.position.x;
  let y = n.position.y;
  let pid = n.parentId;
  while (pid) {
    const p = nodeMap.get(pid);
    if (!p) break;
    x += p.position.x;
    y += p.position.y;
    pid = p.parentId;
  }
  const w = (n.measured?.width as number | undefined) ?? (n.width as number | undefined) ?? 144;
  const h = (n.measured?.height as number | undefined) ?? (n.height as number | undefined) ?? 48;
  return { left: x, right: x + w, centerY: y + h / 2 };
}

/** Resolves a member edge's actual connection-point Y at one end (e.g. from the live routed
 *  waypoints, whose first/last points are the exact pins). Return null when unknown. */
export type MemberEndpointY = (edge: ConnectionEdge, end: "source" | "target") => number | null;

/** Estimate a bundle's break-in (source side) / break-out (target side) anchor positions.
 *
 *  Trunk Y comes from the median of member CONNECTION-POINT Ys when the caller can resolve
 *  them (`endpointY` — the store passes routed-waypoint pins); otherwise from device-box
 *  centerY. The port-level Y matters: a bundle leaving 8 ports near the top of a 1400px-tall
 *  console must sit at those ports, not at the console's center — device centerY put the
 *  junction hundreds of px below every member cable (Esther Musical A001 bundle). X always
 *  comes from device boxes (cluster edge + gap). Returns null when fewer than 2 members
 *  resolve to both a source and target node (can't place a meaningful trunk). */
export function estimateBundleJunctionPositions(
  members: ConnectionEdge[],
  nodes: SchematicNode[],
  endpointY?: MemberEndpointY,
): { in: { x: number; y: number }; out: { x: number; y: number } } | null {
  const nodeMap = new Map(nodes.map((n) => [n.id, n] as const));
  const srcRights: number[] = [];
  const tgtLefts: number[] = [];
  const ys: number[] = [];
  for (const m of members) {
    const s = nodeMap.get(m.source);
    const t = nodeMap.get(m.target);
    if (!s || !t) continue;
    const sb = absNodeBox(s, nodeMap);
    const tb = absNodeBox(t, nodeMap);
    srcRights.push(sb.right);
    tgtLefts.push(tb.left);
    const sy = endpointY?.(m, "source");
    const ty = endpointY?.(m, "target");
    ys.push(sy ?? sb.centerY, ty ?? tb.centerY);
  }
  if (srcRights.length < 2) return null;
  ys.sort((a, b) => a - b);
  const medY = ys.length % 2
    ? ys[(ys.length - 1) / 2]
    : Math.round((ys[ys.length / 2 - 1] + ys[ys.length / 2]) / 2);
  const trunkY = snapGrid(medY);
  return {
    in: { x: snapGrid(Math.max(...srcRights) + JUNCTION_GAP), y: trunkY },
    out: { x: snapGrid(Math.min(...tgtLefts) - JUNCTION_GAP), y: trunkY },
  };
}

/** Heal a node set so every live bundle (≥2 member connections — matches gcBundles liveness)
 *  owns exactly its break-in and break-out anchors, and no orphan junctions (bundle dissolved
 *  or dropped below 2 members) linger.
 *
 *  Idempotent. Unlike fully-derived waypoint nodes, existing junctions are LEFT IN PLACE —
 *  their positions are user-owned (draggable, sticky). This pass only SPAWNS the missing
 *  anchors (from member device geometry) and REMOVES orphans; it never repositions a junction
 *  that already exists. Returns the same `nodes` reference when nothing changes. */
export function reconcileBundleJunctions(
  nodes: SchematicNode[],
  edges: ConnectionEdge[],
  endpointY?: MemberEndpointY,
): SchematicNode[] {
  const counts = new Map<string, number>();
  for (const e of edges) {
    const id = e.data?.bundleId;
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const live = new Set<string>();
  for (const [id, c] of counts) if (c >= 2) live.add(id);

  // Survey existing junctions: count orphans (bundle no longer live) and record which roles
  // each live bundle already has.
  const presentRoles = new Map<string, Set<"in" | "out">>();
  let orphanCount = 0;
  for (const n of nodes) {
    if (n.type !== BUNDLE_JUNCTION_TYPE) continue;
    const jn = n as BundleJunctionNode;
    if (!live.has(jn.data.bundleId)) {
      orphanCount++;
      continue;
    }
    let roles = presentRoles.get(jn.data.bundleId);
    if (!roles) {
      roles = new Set();
      presentRoles.set(jn.data.bundleId, roles);
    }
    roles.add(jn.data.role);
  }

  const missing: { bundleId: string; role: "in" | "out" }[] = [];
  for (const id of live) {
    const roles = presentRoles.get(id);
    if (!roles || !roles.has("in")) missing.push({ bundleId: id, role: "in" });
    if (!roles || !roles.has("out")) missing.push({ bundleId: id, role: "out" });
  }

  if (orphanCount === 0 && missing.length === 0) return nodes;

  const kept = orphanCount === 0
    ? nodes
    : nodes.filter(
        (n) => n.type !== BUNDLE_JUNCTION_TYPE || live.has((n as BundleJunctionNode).data.bundleId),
      );

  if (missing.length === 0) return kept;

  // Spawn missing anchors at estimated positions. A bundle whose geometry can't be resolved
  // (members reference missing nodes) is skipped — the router falls back to computeBundleTrunk.
  const posCache = new Map<string, ReturnType<typeof estimateBundleJunctionPositions>>();
  const spawned: BundleJunctionNode[] = [];
  for (const { bundleId, role } of missing) {
    let pos = posCache.get(bundleId);
    if (pos === undefined) {
      pos = estimateBundleJunctionPositions(bundleMembers(edges, bundleId), nodes, endpointY);
      posCache.set(bundleId, pos);
    }
    if (!pos) continue;
    const node: BundleJunctionNode = {
      id: junctionNodeId(bundleId, role),
      type: BUNDLE_JUNCTION_TYPE,
      position: { ...(role === "in" ? pos.in : pos.out) },
      data: { bundleId, role, placed: false },
      zIndex: JUNCTION_Z_INDEX,
    };
    spawned.push(node);
  }

  if (spawned.length === 0) return kept;
  return [...kept, ...spawned];
}

/** Split a bundled member's manual waypoints into the run that shapes its GATHER leg
 *  (source → break-in) and the run that shapes its FAN leg (break-out → target). A member
 *  always travels break-in → trunk → break-out; user waypoints customize the legs on either
 *  side. Order-preserving: the fan run starts at the first waypoint that sits closer
 *  (Manhattan) to the break-out than to the break-in — waypoints are an ordered path
 *  source→target, so re-sorting them would scramble a deliberate detour. Pure. */
export function splitMemberWaypoints(
  wps: { x: number; y: number }[] | undefined,
  entry: { x: number; y: number },
  exit: { x: number; y: number },
): { gather: { x: number; y: number }[]; fan: { x: number; y: number }[] } {
  if (!wps?.length) return { gather: [], fan: [] };
  const d = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  const k = wps.findIndex((w) => d(w, exit) < d(w, entry));
  if (k === -1) return { gather: [...wps], fan: [] };
  return { gather: wps.slice(0, k), fan: wps.slice(k) };
}

/** Drop bundleId from edges whose bundle has <2 members or no meta, and delete those
 *  bundles. Returns the cleaned edges + bundles (pure; callers set()). */
export function gcBundles(
  edges: ConnectionEdge[],
  bundles: Record<string, BundleMeta>,
): { edges: ConnectionEdge[]; bundles: Record<string, BundleMeta> } {
  const counts = new Map<string, number>();
  for (const e of edges) {
    const id = e.data?.bundleId;
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const liveBundles: Record<string, BundleMeta> = {};
  for (const [id, meta] of Object.entries(bundles)) {
    if ((counts.get(id) ?? 0) >= 2) liveBundles[id] = meta;
  }
  const cleanedEdges = edges.map((e) => {
    const id = e.data?.bundleId;
    if (id && !liveBundles[id]) {
      const { bundleId: _b, ...rest } = e.data!;
      return { ...e, data: rest as ConnectionEdge["data"] };
    }
    return e;
  });
  return { edges: cleanedEdges, bundles: liveBundles };
}
