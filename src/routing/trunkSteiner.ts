/**
 * Single-trunk Steiner tree (RST-T) for a multi-terminal net — the primitive behind
 * both auto fan-out nesting and user-initiated bundling.
 *
 * For one source fanning to N targets (or N members sharing a declared trunk), the
 * length-minimizing shared topology is a single spine plus perpendicular branches. The
 * spine anchor that minimizes total branch length is the MEDIAN of the terminal
 * coordinates (median minimizes sum of absolute deviations). Branches are ordered by
 * position so they never cross each other. This is the exactly-solvable degenerate case
 * of the (NP-hard) rectilinear Steiner minimal tree — no FLUTE table needed because the
 * trunk topology is fixed by intent.
 *
 * Pure module: no React/edgeRouter deps. Coordinates are caller-defined (grid or px).
 */

export interface TrunkTerminal {
  id: string;
  x: number;
  y: number;
}

export interface TrunkSpec {
  sourceX: number;
  sourceY: number;
  targets: TrunkTerminal[];
  /** Chosen spine X (e.g. from track assignment). The spine is the vertical line here. */
  trunkX: number;
}

export interface TrunkPlan {
  trunkX: number;
  /** Y where the source feeder meets the spine (median of target Ys — balances branches). */
  trunkY: number;
  /** Branches ordered by Y (so they never cross), each tapping the spine to its target. */
  branches: { id: string; x: number; y: number }[];
}

/** Median of a numeric list (even count → mean of the two middle values, rounded). */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : Math.round((s[n / 2 - 1] + s[n / 2]) / 2);
}

/** Build a single-trunk Steiner plan: spine at trunkX anchored at the median target Y,
 *  branches ordered by Y. */
export function buildTrunk(spec: TrunkSpec): TrunkPlan {
  const trunkY = median(spec.targets.map((t) => t.y));
  const branches = [...spec.targets]
    .sort((a, b) => a.y - b.y || a.id.localeCompare(b.id))
    .map((t) => ({ id: t.id, x: t.x, y: t.y }));
  return { trunkX: spec.trunkX, trunkY, branches };
}
