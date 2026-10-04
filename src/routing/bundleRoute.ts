/**
 * Geometry for a user-initiated connection bundle: a set of member connections that
 * share one physical trunk. Each member gathers from its source handle into the trunk's
 * near end (`entry`), runs along the shared trunk, then fans out from the far end (`exit`)
 * to its target handle. This module only computes the default trunk anchor/extent; the
 * actual gather/trunk/fan legs are routed (A* in edgeRouter, straight L's in
 * computeSimpleRoutes) by the caller. Pure: coordinates are caller-defined px.
 */

export interface BundleEndpoint {
  edgeId: string;
  srcX: number;
  srcY: number;
  tgtX: number;
  tgtY: number;
  /** User-placed waypoints on this member, honored on its gather/fan legs
   *  (split by splitMemberWaypoints in bundles.ts). */
  manualWaypoints?: { x: number; y: number }[];
}

export interface BundleTrunk {
  /** Trunk polyline (px). Default: a horizontal run at the median endpoint Y, spanning
   *  from just right of the source cluster to just left of the target cluster. */
  trunk: { x: number; y: number }[];
  /** Where members enter the trunk (source side) and exit (target side). */
  entry: { x: number; y: number };
  exit: { x: number; y: number };
}

/** Compute the default trunk for a set of member endpoints. Horizontal trunk at the
 *  median of all endpoint Ys, spanning from just right of the source cluster to just
 *  left of the target cluster. Members whose X interleaves still gather to entry/exit. */
export function computeBundleTrunk(members: BundleEndpoint[], gap = 40): BundleTrunk {
  const srcXs = members.map((m) => m.srcX);
  const tgtXs = members.map((m) => m.tgtX);
  const allYs = members.flatMap((m) => [m.srcY, m.tgtY]).sort((a, b) => a - b);
  const trunkY = allYs.length % 2
    ? allYs[(allYs.length - 1) / 2]
    : Math.round((allYs[allYs.length / 2 - 1] + allYs[allYs.length / 2]) / 2);
  const entryX = Math.round(Math.max(...srcXs) + gap);
  const exitX = Math.round(Math.min(...tgtXs) - gap);
  const entry = { x: entryX, y: trunkY };
  const exit = { x: exitX, y: trunkY };
  return { trunk: [entry, exit], entry, exit };
}
