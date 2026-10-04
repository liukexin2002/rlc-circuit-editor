/**
 * Where an auto-inserted adapter lands when the midpoint of the cable it serves is
 * already occupied (#363).
 *
 * The old nudge was a single pass that only moved along X: it walked the device list
 * once and, on the first overlap, shoved the adapter to whichever side of that one
 * neighbour sat closer to the midpoint. Two things went wrong. Devices already
 * checked were never re-checked, so pushing clear of one neighbour could drop the
 * adapter squarely onto another; and with only X in play a row of devices had no
 * clear slot to offer at all.
 *
 * This searches instead of nudging. Candidate slots are the ideal midpoint plus the
 * "just clear" edges of the nearest neighbours on both axes, every combination is
 * tested against *every* neighbour, and the closest free one to the midpoint wins —
 * which keeps the adapter on the cable path it serves. Two backstop lines — a column
 * past every neighbour's right edge and a row below every neighbour's bottom edge —
 * are always in the candidate set, so the search cannot come up empty however crowded
 * the canvas is.
 *
 * When the adapter is parented to a room, `bounds` carries that room's rectangle and
 * slots that keep the adapter inside it are preferred over ones that don't. That is
 * not only cosmetic: room membership in the store is geometric, so an adapter parked
 * outside the room it claims gets detached by the next reparent pass, which silently
 * moves it between the room-grouped reports.
 */
import { GRID_SIZE } from "./gridConstants";

export interface PlacementBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PlacementGap {
  x: number;
  y: number;
}

/** Clearance an inserted adapter keeps from its neighbours. 80px across — the legs
 *  leave the adapter sideways and stub tags sit in that space — but only 32px above
 *  and below, because devices legitimately stack closer than they sit side by side
 *  and an 80px vertical shove reads as the adapter drifting off its own cable. */
export const ADAPTER_GAP: PlacementGap = { x: GRID_SIZE * 5, y: GRID_SIZE * 2 };

/** Device width to assume before React Flow has measured the DOM — the adapter being
 *  placed always, and any neighbour still waiting on its first render. Matches the
 *  144px `fallbackWidth` the snapping and routing estimates use. */
export const DEVICE_W_EST = 144;

/** Only the nearest neighbours contribute candidate slots — a device on the far side
 *  of the page can't define a slot near the cable, and the cross product of every
 *  edge in a large schematic isn't worth walking. Collision testing still uses the
 *  full list, so a distant device can never be placed on top of. */
const CANDIDATE_NEIGHBOURS = 24;

const snapDown = (v: number) => Math.floor(v / GRID_SIZE) * GRID_SIZE;
const snapUp = (v: number) => Math.ceil(v / GRID_SIZE) * GRID_SIZE;

/** AABB overlap of a would-be adapter box against one neighbour, each axis widened
 *  by that axis' clearance. */
function collides(
  x: number,
  y: number,
  size: { w: number; h: number },
  other: PlacementBox,
  gap: PlacementGap,
): boolean {
  const overlapX = x - gap.x < other.x + other.w && x + size.w + gap.x > other.x;
  const overlapY = y - gap.y < other.y + other.h && y + size.h + gap.y > other.y;
  return overlapX && overlapY;
}

/** How well a candidate respects the parent room: 0 the whole adapter sits inside it,
 *  1 only its centre does — which is all the store's geometric room membership asks
 *  for — 2 it has left the room altogether. Unparented adapters have no room to
 *  respect, so every candidate ranks 0. */
function containmentRank(
  x: number,
  y: number,
  size: { w: number; h: number },
  bounds: PlacementBox | undefined,
): number {
  if (!bounds) return 0;
  const inside =
    x >= bounds.x && y >= bounds.y &&
    x + size.w <= bounds.x + bounds.w && y + size.h <= bounds.y + bounds.h;
  if (inside) return 0;
  const cx = x + size.w / 2;
  const cy = y + size.h / 2;
  const centred =
    cx >= bounds.x && cx <= bounds.x + bounds.w &&
    cy >= bounds.y && cy <= bounds.y + bounds.h;
  return centred ? 1 : 2;
}

/**
 * Nearest grid-snapped position to `ideal` at which an adapter of `size` clears every
 * box in `obstacles` by `gap`. All coordinates are in one frame — the caller resolves
 * every device to the adapter's own parent frame before calling, so devices in other
 * rooms are obstacles too rather than being invisible.
 *
 * `bounds` is the parent room's rectangle in that same frame, when the adapter has a
 * parent. Slots inside it are taken ahead of slots outside it; the search only leaves
 * the room when nothing free is left in it.
 */
export function findFreeAdapterSlot(
  ideal: { x: number; y: number },
  size: { w: number; h: number },
  obstacles: PlacementBox[],
  gap: PlacementGap = ADAPTER_GAP,
  bounds?: PlacementBox,
): { x: number; y: number } {
  const free = (x: number, y: number) => !obstacles.some((o) => collides(x, y, size, o, gap));
  // The midpoint of the cable is where the adapter belongs; if nothing is sitting on
  // it, it stays there even if the room edge clips it — that is the position the two
  // endpoints themselves dictated.
  if (free(ideal.x, ideal.y)) return { x: ideal.x, y: ideal.y };

  const centerDist2 = (o: PlacementBox) => {
    const dx = o.x + o.w / 2 - (ideal.x + size.w / 2);
    const dy = o.y + o.h / 2 - (ideal.y + size.h / 2);
    return dx * dx + dy * dy;
  };
  const near = [...obstacles].sort((a, b) => centerDist2(a) - centerDist2(b)).slice(0, CANDIDATE_NEIGHBOURS);

  // Snap away from the neighbour that generated each coordinate: rounding to nearest
  // could give back up to half a grid step and re-open the overlap the slot exists to
  // avoid.
  const xs = new Set<number>([ideal.x]);
  const ys = new Set<number>([ideal.y]);
  for (const o of near) {
    xs.add(snapUp(o.x + o.w + gap.x));
    xs.add(snapDown(o.x - size.w - gap.x));
    ys.add(snapUp(o.y + o.h + gap.y));
    ys.add(snapDown(o.y - size.h - gap.y));
  }

  // Past every neighbour's right edge nothing can overlap on X whatever Y holds, and
  // below every bottom edge nothing can overlap on Y whatever X holds. Either line is
  // free by construction, so the search below always terminates with a real answer
  // rather than the ideal position it already rejected. Having both matters when the
  // candidate cap above leaves a crowded neighbourhood short of escapes: the row
  // below the pack is usually far nearer the cable than the column past it.
  const backstopX = snapUp(obstacles.reduce((m, o) => Math.max(m, o.x + o.w), ideal.x) + gap.x);
  const backstopY = snapUp(obstacles.reduce((m, o) => Math.max(m, o.y + o.h), ideal.y) + gap.y);
  xs.add(backstopX);
  ys.add(backstopY);

  const candidates: { x: number; y: number }[] = [];
  for (const x of xs) for (const y of ys) candidates.push({ x, y });
  const rank = new Map<{ x: number; y: number }, number>();
  for (const c of candidates) rank.set(c, containmentRank(c.x, c.y, size, bounds));
  candidates.sort((a, b) => {
    const ra = rank.get(a)!;
    const rb = rank.get(b)!;
    if (ra !== rb) return ra - rb;
    const da = (a.x - ideal.x) ** 2 + (a.y - ideal.y) ** 2;
    const db = (b.x - ideal.x) ** 2 + (b.y - ideal.y) ** 2;
    // Ties broken by coordinate so the same schematic always places the same way.
    return da - db || a.x - b.x || a.y - b.y;
  });

  for (const c of candidates) {
    if (free(c.x, c.y)) return c;
  }
  // Unreachable: (backstopX, ideal.y) is in the cross product and always free.
  return { x: backstopX, y: ideal.y };
}
