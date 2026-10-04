/**
 * Portfolio search candidate set + winner selection.
 *
 * The router has no single best configuration — the optimum is per-schematic (measured: icdc/video
 * want crossing-penalty 12, ARKEMA wants 30; the dense-optimal sort/turn settings regress the
 * backward-edges case). So instead of re-tuning one global default, we route a small DIVERSIFIED set
 * of candidates and keep the cleanest by the objective (src/routing/objective.ts).
 *
 * A candidate is just a `__routingParams` override object (the live-tuning hook ROUTER_PARAMS /
 * ROUTING_PARAMS already read). That makes a candidate trivially serializable to a worker (the
 * routing worker already re-applies `req.routingParams`), so the same set drives the offline harness
 * and the in-browser worker pool.
 *
 * INVARIANT: the first candidate is the current shipped DEFAULT (empty override). Because the search
 * keeps the best and ties resolve to the earliest candidate, best-of-portfolio is NEVER worse than
 * today on any schematic, and an unchanged schematic stays on the default — the zero-regression /
 * stability guarantee.
 */

export interface RoutingCandidate {
  /** Stable identifier (shown in reports; used as the tie-break order). */
  label: string;
  /** `__routingParams` override for this candidate. Empty = the shipped default. */
  params: Record<string, number>;
}

/**
 * Diversified candidate set, derived from the parameter sweep (debug/orderingExp.ts) that showed
 * 35–57% weave reductions are available per-schematic. Order matters: DEFAULT is first so ties
 * favor the status quo. Kept small (research: most gain in the first 4–8 well-diversified members).
 *
 * Diversity axes: edge order (SORT_STRATEGY 0/1/2), turn penalty (the shipped 7 over-penalizes
 * bends — sweep winners used 4), crossing penalty (12 favours icdc/video, 30 favours ARKEMA),
 * overlap penalty.
 */
export const ROUTING_CANDIDATES: RoutingCandidate[] = [
  { label: "default", params: {} },
  { label: "sort0", params: { SORT_STRATEGY: 0 } },
  { label: "sort0-tn4", params: { SORT_STRATEGY: 0, TURN_PENALTY: 4 } },
  { label: "sort0-tn4-cx30", params: { SORT_STRATEGY: 0, TURN_PENALTY: 4, CROSSING_PENALTY: 30 } },
  // High crossing penalty (PathFinder-ish strong congestion avoidance) — best on dense backward-heavy
  // schematics (ARKEMA weave 35→28). Zero-risk: best-of-K only improves or ties.
  { label: "sort0-tn4-cx80-m6", params: { SORT_STRATEGY: 0, TURN_PENALTY: 4, CROSSING_PENALTY: 80, ESCAPE_MARGIN: 6 } },
  { label: "sort0-tn4-ov40", params: { SORT_STRATEGY: 0, TURN_PENALTY: 4, OVERLAP_PENALTY: 40 } },
  // Wider escape margin gives A* more room to route around the obstacle field — measurably fewer
  // weaves/crossings on dense schematics (icdc weave 36→22, cross 223→194). Adding candidates is
  // zero-risk: best-of-K with more options can only improve or tie.
  { label: "sort0-tn4-m6", params: { SORT_STRATEGY: 0, TURN_PENALTY: 4, ESCAPE_MARGIN: 6 } },
  { label: "sort0-tn4-cx30-m6", params: { SORT_STRATEGY: 0, TURN_PENALTY: 4, CROSSING_PENALTY: 30, ESCAPE_MARGIN: 6 } },
  { label: "sort1-tn4", params: { SORT_STRATEGY: 1, TURN_PENALTY: 4 } },
  { label: "sort2", params: { SORT_STRATEGY: 2 } },
  // NOTE: a finer-grid trio (CELL_SIZE 10) was tried and reverted. It won the objective on dense
  // fixtures (icdc weave 55→9, etc.) but the objective is blind to lane DENSITY (scoreRoutes
  // SHARED_PX=8), so a 10px grid packs verticals ~10px apart — a bundled smear the eye reads as
  // WORSE, not better. It was also ~2.4× slower (the wait-for-all client made it the latency floor)
  // and fragile (endpoint-body crossings spike at 16px). Most of the real weave win lives in the
  // params above (sort0-tn4-m6 / -cx80-m6) at the normal 20px grid. See plan
  // ~/.claude/plans/wobbly-skipping-pike.md and [[project_edge_routing]].
];

export interface ScoredCandidate {
  label: string;
  score: number;
}

/**
 * Pick the winning candidate: lowest score wins; ties resolve to the EARLIEST candidate in the
 * input order (so a tie with `default` — which callers list first — keeps the default, for
 * stability). Pure. Returns null for an empty list.
 */
export function pickBest(scored: ScoredCandidate[]): ScoredCandidate | null {
  let best: ScoredCandidate | null = null;
  for (const c of scored) {
    if (best === null || c.score < best.score) best = c;
  }
  return best;
}
