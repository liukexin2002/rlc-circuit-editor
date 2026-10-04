// Shared geometry for the off-page continuation pills (#183, #317, #337, #357).
//
// The editor overlay draws these on the canvas and the PDF exporter redraws them on
// the sheet. Each surface used to carry its own copy of the box placement, so a fix
// applied to one could silently disagree with the other. Both now go through
// layoutContinuationPills, which places the boxes, slides the ones sharing a page
// edge apart, AND keeps them clear of the title block.
//
// A pill runs PARALLEL to its wire at the crossing (#357). A wire leaving through the
// top or bottom of a sheet is vertical there, so its pill is rotated 90° and reads
// bottom-to-top along the wire; a wire leaving through a side is horizontal, so its
// pill stays horizontal. Sitting on its own wire is what tells the reader which
// connection a pill belongs to — which is why the pills may not slide away from their
// crossings into a row, the first #357 attempt.

import { PAGE_MARGIN_IN } from "./printConfig";
import type { PageRect } from "./printPageGrid";

/** Which way the pill grows from its crossing point. */
export type PillAnchor = "left" | "right" | "up" | "down";

export interface PillRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The rectangle the title block occupies, in the same units as the pill. */
export type TitleBlockBand = PillRect;

export interface ContinuationPill {
  anchor: PillAnchor;
  /** Anchor point — the box edge that faces the page boundary. */
  x: number;
  y: number;
  /**
   * Length of the pill ALONG its text run (arrow, name, page reference) — measured
   * text plus padding. For a rotated pill this is the box's on-page HEIGHT.
   */
  width: number;
  /** Thickness across the text run — type size plus padding. */
  height: number;
}

/**
 * A pill on a top or bottom page edge is rotated 90°: its wire is vertical at the
 * crossing, and the pill lies along the wire. Both surfaces ask this one question,
 * so neither can rotate a pill the other draws flat.
 */
export function pillIsRotated(anchor: PillAnchor): boolean {
  return anchor === "up" || anchor === "down";
}

/** How far a pill may travel along the page edge it sits on, in the pill's units. */
export interface PillLimit {
  min: number;
  max: number;
}

export interface ContinuationPillPlacement extends ContinuationPill {
  /**
   * Which sheet the pill is drawn on. Pills only shift against the ones sharing
   * both their sheet and their anchor, and that pairing is exactly one page edge:
   * a sheet's "up" pills all come from the boundary along its bottom, its "down"
   * pills from the boundary along its top, and so on. Pills with no sheet group by
   * anchor alone, so a caller whose pills can land on NO sheet has to give each of
   * those its own key — they share no edge and must not shift against each other.
   */
  sheet?: string | number;
  /**
   * The sheet's drawing border along the shift axis. Unbounded when omitted. Every
   * pill sharing an anchor and a sheet must pass the same limit — they are on one
   * page edge, so they have one border; the group's first pill supplies it.
   */
  limit?: PillLimit | null;
}

/**
 * Pill type size and padding, in points. Shared so the editor overlay measures the
 * same box the PDF prints: the spread in deoverlapAlongAxis is driven by the pill's
 * footprint on its page edge — its measured length for a flat pill, its thickness
 * for a rotated one — and the title-block clamp by the whole box, so a preview that
 * sized its pills differently would push them to different places than the export
 * does and stop showing what prints (#357).
 */
export const PILL_FONT_SIZE_PT = 6;
export const PILL_PAD_PT = 1.44; // 0.02in, the padding the PDF has always used
/** Breathing room left between two pills the de-overlap had to split, in points. */
export const PILL_GAP_PT = 1;

/**
 * The pill's text: arrow, the device (and room) on the far side, and the page the
 * connection carries on to. `pageNum` of 0 means the far side is off the grid
 * altogether, and the reference is left off.
 */
export function continuationPillText(text: string, pageNum = 0): string {
  return `${text}${pageNum > 0 ? ` Pg ${pageNum}` : ""}`;
}

/**
 * The title-block band in page-local inches, measured from the sheet's top-left
 * corner: full margin-to-margin width capped to the configured width, flush with
 * the right-hand drawing border, sitting on the bottom margin.
 */
export function titleBlockBandInches(
  pageWIn: number,
  pageHIn: number,
  widthIn: number,
  heightIn: number,
): TitleBlockBand | null {
  const fullWidth = pageWIn - 2 * PAGE_MARGIN_IN;
  if (heightIn <= 0 || fullWidth <= 0) return null;
  const width = Math.min(widthIn, fullWidth);
  return {
    x: PAGE_MARGIN_IN + fullWidth - width,
    y: pageHIn - PAGE_MARGIN_IN - heightIn,
    width,
    height: heightIn,
  };
}

/** The same band in canvas pixels, for a page the print grid has laid out. */
export function titleBlockBandPx(
  page: PageRect,
  widthIn: number,
  heightIn: number,
): TitleBlockBand | null {
  const marginPx = page.contentX - page.x;
  if (marginPx <= 0) return null;
  const pxPerIn = marginPx / PAGE_MARGIN_IN;
  const band = titleBlockBandInches(page.widthPx / pxPerIn, page.heightPx / pxPerIn, widthIn, heightIn);
  if (!band) return null;
  return {
    x: page.x + band.x * pxPerIn,
    y: page.y + band.y * pxPerIn,
    width: band.width * pxPerIn,
    height: band.height * pxPerIn,
  };
}

/**
 * Top-left corner of the pill's box: it grows inward, away from the boundary, along
 * its own wire. Side-exit pills lie flat, centred on their horizontal wire; top- and
 * bottom-exit pills are rotated 90° onto their vertical wire, so their on-page box
 * swaps the pill's length and thickness — the box is narrow across the page edge and
 * long up the wire, into the content area rather than off the sheet.
 */
function placePill(pill: ContinuationPill): PillRect {
  const { anchor, x, y, width, height } = pill;
  switch (anchor) {
    case "left":
      return { x: x - width, y: y - height / 2, width, height };
    case "right":
      return { x, y: y - height / 2, width, height };
    case "up":
      return { x: x - height / 2, y: y - width, width: height, height: width };
    case "down":
      return { x: x - height / 2, y, width: height, height: width };
  }
}

/**
 * Lift a pill clear of a title-block band. The pill is opaque, so one that lands on
 * the band whites out the drawing's own titling. A pill sharing no horizontal span
 * with the band — the block is right-aligned and usually narrower than the sheet —
 * is left exactly where it is; one that overlaps rides up until its bottom edge
 * rests on the band's top edge, the closest it can stay to its crossing point. A
 * pill merely touching an edge of the band does not overlap and is left alone.
 */
export function clampPillAboveBand(box: PillRect, band: TitleBlockBand | null): PillRect {
  if (!band || band.width <= 0 || band.height <= 0) return box;
  if (box.x >= band.x + band.width || box.x + box.width <= band.x) return box;
  if (box.y >= band.y + band.height || box.y + box.height <= band.y) return box;
  return { ...box, y: band.y - box.height };
}

/** One pill reduced to the interval it occupies on its page edge. */
export interface AxisSpan {
  /** Where the pill wants to sit — its crossing point on the edge. */
  center: number;
  /** How much of the edge it needs. */
  size: number;
}

/**
 * Slide a row of pills apart until none overlaps its neighbour, moving them as
 * little as possible in total (#357).
 *
 * Connections that cross a page edge close together used to stack their pills on
 * top of each other, and the topmost one hid the rest. Stacking the pills in rows
 * instead would cost the reader the pill-to-connection association, so they stay on
 * the edge and shift ALONG it: sorted by crossing point, then spread just far enough
 * to clear each other, with the whole run kept inside `limit` — the sheet's drawing
 * border — so a crowded cluster is pushed back onto the page rather than off it.
 *
 * The spread is the least-squares fit under those constraints (pool adjacent
 * violators): a cluster of coincident pills opens symmetrically about its crossings
 * rather than sliding off in one direction, and pills far enough apart already do
 * not move at all. Returns the settled centers in the caller's order.
 *
 * A single pill is still clamped to `limit`, so a neighbour turning up on the same
 * edge later cannot make it jump: it was already inside the border. And when the edge
 * genuinely cannot hold the run — eight or more crossings on one page break is routine
 * — the spacing is squeezed to fit instead of overrunning the border, because a pill
 * pushed off the sheet is not drawn at all, which is worse than two that overlap.
 */
export function deoverlapAlongAxis(
  spans: readonly AxisSpan[],
  limit: PillLimit | null = null,
  gap = 0,
): number[] {
  const n = spans.length;
  if (n === 0) return [];

  // Edge order, ties broken by input order so the result is deterministic.
  const order = spans.map((_, i) => i).sort((a, b) => spans[a].center - spans[b].center || a - b);

  // `offsets[k]` is the room every earlier pill in the row needs. Subtracting it
  // turns "keep the pills apart" into "keep the values non-decreasing", which is
  // what the pooling below solves.
  const offsets: number[] = [0];
  for (let k = 1; k < n; k++) {
    const prev = spans[order[k - 1]];
    const cur = spans[order[k]];
    offsets.push(offsets[k - 1] + (prev.size + cur.size) / 2 + gap);
  }

  const headSize = spans[order[0]].size;
  const tailSize = spans[order[n - 1]].size;

  if (limit) {
    // Edge-to-edge, the untouched row needs this much of the border, and a row that
    // fits leaves every sub-run of it room too — so this one test decides whether the
    // constrained fit below has any solution at all.
    const needed = offsets[n - 1] + (headSize + tailSize) / 2;
    const available = limit.max - limit.min;
    if (needed > available) {
      // It does not fit. Overflowing the far end would carry the last pills clean off
      // the sheet — the PDF drops what falls outside the media box and the editor
      // paints it over the neighbouring page — so squeeze the spacing instead: the
      // run is scaled to the border, each pill keeping its share of what room there
      // is. The pills overlap again, but every one of them is on the page beside its
      // own crossing, which is where the reader looks for it.
      const squeeze = offsets[n - 1] > 0
        ? Math.max(0, available - (headSize + tailSize) / 2) / offsets[n - 1]
        : 0;
      // Scaling alone still hangs a pill wider than its neighbours over the border, so
      // each one is held inside it. A pill's own two bounds are not monotone in k once
      // the widths differ — but the running highest floor and the running lowest
      // ceiling are, and clamping an ordered run to monotone bounds leaves it ordered.
      const floors = new Array<number>(n);
      const ceilings = new Array<number>(n);
      let floor = -Infinity;
      for (let k = 0; k < n; k++) {
        floor = Math.max(floor, limit.min + spans[order[k]].size / 2);
        floors[k] = floor;
      }
      let ceiling = Infinity;
      for (let k = n - 1; k >= 0; k--) {
        ceiling = Math.min(ceiling, limit.max - spans[order[k]].size / 2);
        ceilings[k] = ceiling;
      }
      const squeezed = new Array<number>(n);
      for (let k = 0; k < n; k++) {
        const target = limit.min + headSize / 2 + offsets[k] * squeeze;
        // Floor last, so a single pill too wide for the whole border keeps its head —
        // the arrow and the start of the device name — on the sheet.
        squeezed[order[k]] = Math.max(Math.min(target, ceilings[k]), floors[k]);
      }
      return squeezed;
    }
  }

  // A pill's own limit becomes a limit on the pooled value. Both bounds shrink as
  // k grows, so a pool's tightest pair is its first element's floor and its last
  // element's ceiling — and the feasibility test above guarantees the floor is never
  // above the ceiling.
  const floorAt = (k: number) => (limit ? limit.min + spans[order[k]].size / 2 - offsets[k] : -Infinity);
  const ceilAt = (k: number) => (limit ? limit.max - spans[order[k]].size / 2 - offsets[k] : Infinity);

  interface Pool {
    first: number;
    last: number;
    sum: number;
    count: number;
    value: number;
  }
  const settle = (p: Pool): number => {
    const lo = floorAt(p.first);
    const hi = ceilAt(p.last);
    const mean = p.sum / p.count;
    if (mean < lo) return lo;
    if (mean > hi) return hi;
    return mean;
  };

  const pools: Pool[] = [];
  for (let k = 0; k < n; k++) {
    const pool: Pool = {
      first: k,
      last: k,
      sum: spans[order[k]].center - offsets[k],
      count: 1,
      value: 0,
    };
    pool.value = settle(pool);
    while (pools.length > 0 && pools[pools.length - 1].value > pool.value) {
      const prev = pools.pop()!;
      pool.first = prev.first;
      pool.sum += prev.sum;
      pool.count += prev.count;
      pool.value = settle(pool);
    }
    pools.push(pool);
  }

  const centers = new Array<number>(n);
  for (const pool of pools) {
    for (let k = pool.first; k <= pool.last; k++) {
      centers[order[k]] = pool.value + offsets[k];
    }
  }
  return centers;
}

/**
 * Place a run of continuation pills: each box grows inward from its boundary along
 * its own wire, pills sharing a page edge shift along it until they clear each
 * other, and any pill still covering a title-block band rides up off it. Both the
 * editor overlay and the PDF export call this on their full set of pills for a
 * sheet, so the two surfaces cannot drift apart.
 *
 * Top- and bottom-edge pills are rotated onto their vertical wires, so their
 * footprint on the edge axis is the pill's THICKNESS: the spread only has work to do
 * when two wires cross within a few points of each other, and each pill otherwise
 * sits exactly on its own crossing.
 *
 * `gap` is the breathing room left between neighbours, in the caller's units.
 */
export function layoutContinuationPills(
  pills: readonly ContinuationPillPlacement[],
  bands: readonly TitleBlockBand[],
  gap = 0,
): PillRect[] {
  const boxes = pills.map(placePill);

  const byPageEdge = new Map<string, number[]>();
  for (let i = 0; i < pills.length; i++) {
    const key = `${pills[i].anchor}|${pills[i].sheet ?? ""}`;
    const group = byPageEdge.get(key);
    if (group) group.push(i);
    else byPageEdge.set(key, [i]);
  }

  for (const group of byPageEdge.values()) {
    // Pills leaving through a horizontal boundary line up across the sheet, so they
    // shift on x; the ones leaving through a vertical boundary shift on y.
    const anchor = pills[group[0]].anchor;
    const alongX = anchor === "up" || anchor === "down";
    const spans = group.map((i) =>
      alongX
        ? { center: boxes[i].x + boxes[i].width / 2, size: boxes[i].width }
        : { center: boxes[i].y + boxes[i].height / 2, size: boxes[i].height },
    );
    const centers = deoverlapAlongAxis(spans, pills[group[0]].limit ?? null, gap);
    group.forEach((i, k) => {
      boxes[i] = alongX
        ? { ...boxes[i], x: centers[k] - boxes[i].width / 2 }
        : { ...boxes[i], y: centers[k] - boxes[i].height / 2 };
    });
  }

  // The band clamp runs last: it reads the settled position, and for the bottom and
  // top edges it only moves the pill on the axis the spread did not touch.
  return boxes.map((box) => {
    let out = box;
    for (const band of bands) {
      out = clampPillAboveBand(out, band);
    }
    return out;
  });
}

/**
 * Place a single continuation pill and keep it out of every title-block band it
 * would otherwise cover. Callers drawing a whole sheet should use
 * layoutContinuationPills so the pills also clear each other.
 */
export function layoutContinuationPill(
  pill: ContinuationPill,
  bands: readonly TitleBlockBand[],
): PillRect {
  return layoutContinuationPills([pill], bands)[0];
}
