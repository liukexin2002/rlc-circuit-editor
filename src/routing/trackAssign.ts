/**
 * Track assignment for orthogonal corridor routing.
 *
 * The foundational primitive is the Left-Edge Algorithm (Hashimoto & Stevens, 1971):
 * assigning vertical "trunks" to corridor columns is exactly interval-graph coloring on
 * the trunks' Y-spans. Trunks whose Y-spans are disjoint can share one column (one color);
 * overlapping ones need distinct columns. The number of colors used equals the channel
 * density (the max number of trunks overlapping any horizontal cut) — provably the minimum.
 *
 * This module is pure (no React/edgeRouter deps) so it is unit-testable and callable from
 * the headless harness.
 */

export interface YSpan {
  id: string;
  yMin: number;
  yMax: number;
}

/**
 * Left-Edge interval coloring on Y-spans. Returns a `color` (0-based lane index) per id
 * such that any two ids whose Y-spans overlap (within `gap`) receive distinct colors, and
 * disjoint spans reuse the lowest-numbered free color.
 *
 * Processing order matters for which color an id lands on: items are colored in the order
 * given, and color 0 is assigned first — so passing items in nesting order (e.g. innermost
 * target first) makes color 0 the innermost lane. First-fit in a caller-chosen order can
 * use slightly more than the theoretical minimum colors for pathological orders; the
 * constraint-graph phase supplies an order that keeps it at/near density.
 */
export function colorByYSpan(items: YSpan[], gap = 2): Map<string, number> {
  const colorLastMax: number[] = []; // colorLastMax[c] = largest yMax currently in color c
  const out = new Map<string, number>();
  for (const it of items) {
    let c = -1;
    for (let k = 0; k < colorLastMax.length; k++) {
      // Reuse color k if its current occupant's span has cleared (disjoint by `gap`).
      if (colorLastMax[k] < it.yMin - gap) { c = k; break; }
    }
    if (c < 0) { c = colorLastMax.length; colorLastMax.push(-Infinity); }
    colorLastMax[c] = Math.max(colorLastMax[c], it.yMax);
    out.set(it.id, c);
  }
  return out;
}

/** Number of distinct colors used by a coloring (= lanes/columns needed). */
export function laneCount(coloring: Map<string, number>): number {
  let max = -1;
  for (const c of coloring.values()) max = Math.max(max, c);
  return max + 1;
}

/**
 * Order-PRESERVING track packing. Unlike raw Left-Edge coloring (which packs by
 * Y-disjointness alone and can collapse non-adjacent trunks, scrambling a crossing-
 * minimizing order), this assigns columns that are MONOTONIC in the input order: a trunk
 * shares the current column only if it is Y-disjoint from every trunk already on it AND
 * those are consecutive in the order; otherwise it advances to the next column. The result
 * keeps the nesting order intact (no new crossings) while still merging consecutive
 * disjoint trunks (fewer columns than one-per-trunk).
 *
 * Input MUST be in the desired left-to-right (inner→outer) order — typically the VCG order.
 * Returns a 0-based column index per id; column 0 is the first/innermost.
 */
export function packOrdered(items: YSpan[], gap = 2): Map<string, number> {
  const out = new Map<string, number>();
  if (items.length === 0) return out;
  let col = 0;
  let colMaxY = -Infinity; // largest yMax currently on `col`
  let colMinY = Infinity;  // smallest yMin currently on `col`
  for (const it of items) {
    // Disjoint from everything on the current column? (span sits fully above or below it)
    const disjoint = it.yMin - gap > colMaxY || it.yMax + gap < colMinY;
    if (out.size > 0 && !disjoint) {
      col++;
      colMaxY = -Infinity;
      colMinY = Infinity;
    }
    out.set(it.id, col);
    colMaxY = Math.max(colMaxY, it.yMax);
    colMinY = Math.min(colMinY, it.yMin);
  }
  return out;
}
