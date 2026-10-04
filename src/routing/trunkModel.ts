/**
 * Direction-agnostic skeleton for one edge's orthogonal route, in GRID coordinates.
 *
 * An edge is modeled as a vertical TRUNK at some track-X spanning [yMin,yMax], with a
 * horizontal lead from the source handle to the trunk and from the trunk to the target
 * handle. `side` records which side of the TARGET the trunk approaches from (the entry
 * side), so forward, backward, and same-side edges share one representation — the basis
 * for the constraint-graph + track-assignment engine.
 *
 * Pure module: no React/edgeRouter deps.
 */

export interface TrunkInput {
  id: string;
  srcGX: number;
  srcGY: number;
  tgtGX: number;
  tgtGY: number;
  targetEntersLeft: boolean;
  signalType: string;
}

export interface TrunkEdge {
  id: string;
  srcX: number;
  srcY: number;
  tgtX: number;
  tgtY: number;
  yMin: number;
  yMax: number;
  side: "L" | "R"; // trunk sits left ('L') or right ('R') of the target (= entry side)
  bandLo: number; // inclusive grid-cell band for the trunk X (leftmost candidate)
  bandHi: number; // inclusive grid-cell band for the trunk X (rightmost candidate)
  signalType: string;
}

const TRACK_WINDOW = 80; // grid cells of search room to the entry side of the target

/** Build a trunk skeleton from grid-space endpoints. The trunk approaches the target from
 *  its entry side; the placement band is the open lane on that side of the target. */
export function buildTrunkEdge(e: TrunkInput): TrunkEdge {
  const side: "L" | "R" = e.targetEntersLeft ? "L" : "R";
  const yMin = Math.min(e.srcGY, e.tgtGY);
  const yMax = Math.max(e.srcGY, e.tgtGY);
  // Entry-side band: just inside the target handle, searching away from it.
  const bandLo = side === "L" ? e.tgtGX - 2 - TRACK_WINDOW : e.tgtGX + 2;
  const bandHi = side === "L" ? e.tgtGX - 2 : e.tgtGX + 2 + TRACK_WINDOW;
  return {
    id: e.id,
    srcX: e.srcGX,
    srcY: e.srcGY,
    tgtX: e.tgtGX,
    tgtY: e.tgtGY,
    yMin,
    yMax,
    side,
    bandLo,
    bandHi,
    signalType: e.signalType,
  };
}
