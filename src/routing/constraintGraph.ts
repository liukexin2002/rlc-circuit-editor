/**
 * Vertical Constraint Graph (VCG) ordering for trunks sharing a corridor.
 *
 * Classic channel routing (Hashimoto/Stevens, Deutsch) formalizes "which trunk must sit
 * inner of which" as a directed graph; a topological order of it places trunks so their
 * source/target leads don't cross. Cycles in the graph are configurations no single
 * left-to-right order can satisfy (e.g. two same-side trunks whose source order and target
 * order disagree) — those are reported for dogleg insertion.
 *
 * This generalizes the ad-hoc "concentric by target Y" heuristic the router used for
 * forward fans. Pure module: no React/edgeRouter deps.
 */

import type { TrunkEdge } from "./trunkModel";

/** Build pairwise "inner-of" constraints + the set of unsatisfiable (cyclic) pairs.
 *  Constraint {a,b} means trunk a should be placed nearer the target (inner) than b. */
export function buildConstraints(trunks: TrunkEdge[]): {
  constraints: { a: string; b: string }[];
  conflicts: [string, string][];
} {
  const constraints: { a: string; b: string }[] = [];
  const conflicts: [string, string][] = [];
  for (let i = 0; i < trunks.length; i++) {
    for (let j = i + 1; j < trunks.length; j++) {
      const p = trunks[i];
      const q = trunks[j];
      const byTgt = Math.sign(p.tgtY - q.tgtY); // <0: p's target is above q's
      const bySrc = Math.sign(p.srcY - q.srcY); // <0: p's source is above q's
      if (byTgt === 0 && bySrc === 0) continue;
      if (byTgt !== 0 && bySrc !== 0 && byTgt !== bySrc) {
        // Source order and target order disagree: no crossing-free linear order exists
        // for this pair. Flag as a cycle candidate (resolved by a dogleg downstream).
        conflicts.push([p.id, q.id]);
        continue;
      }
      const dir = byTgt !== 0 ? byTgt : bySrc;
      // The trunk reaching the higher (smaller-Y) endpoint is the OUTER one; the lower-Y
      // (nearer the source band) is inner. Encode "inner-of":
      if (dir < 0) constraints.push({ a: q.id, b: p.id });
      else constraints.push({ a: p.id, b: q.id });
    }
  }
  return { constraints, conflicts };
}

/** Topologically order trunks inner→outer by the constraints (Kahn's algorithm, with a
 *  deterministic tie-break). Trunks left unordered by a constraint cycle are appended in
 *  deterministic order and their conflicting pairs returned for dogleg handling. */
export function orderTrunks(trunks: TrunkEdge[]): {
  order: TrunkEdge[];
  cycles: [string, string][];
} {
  const { constraints, conflicts } = buildConstraints(trunks);
  const indeg = new Map<string, number>(trunks.map((t) => [t.id, 0]));
  const adj = new Map<string, string[]>(trunks.map((t) => [t.id, []]));
  for (const c of constraints) {
    adj.get(c.a)!.push(c.b);
    indeg.set(c.b, (indeg.get(c.b) ?? 0) + 1);
  }
  const tiebreak = (x: TrunkEdge, y: TrunkEdge) =>
    x.tgtY - y.tgtY || x.srcY - y.srcY || x.id.localeCompare(y.id);
  // Use a re-sorted "ready" list each pop for determinism (small N per channel).
  const seen = new Set<string>();
  const order: TrunkEdge[] = [];
  const ready = () =>
    trunks
      .filter((t) => !seen.has(t.id) && (indeg.get(t.id) ?? 0) <= 0)
      .sort(tiebreak);
  let frontier = ready();
  while (frontier.length) {
    const t = frontier[0];
    seen.add(t.id);
    order.push(t);
    for (const nxt of adj.get(t.id) ?? []) indeg.set(nxt, (indeg.get(nxt) ?? 0) - 1);
    frontier = ready();
  }
  // Any trunk not emitted is in a constraint cycle; append deterministically so packing
  // still succeeds, and surface the conflicting pairs for dogleg insertion.
  const leftover = trunks.filter((t) => !seen.has(t.id)).sort(tiebreak);
  order.push(...leftover);
  const cycles = [...conflicts];
  for (let i = 0; i + 1 < leftover.length; i++) cycles.push([leftover[i].id, leftover[i + 1].id]);
  return { order, cycles };
}
