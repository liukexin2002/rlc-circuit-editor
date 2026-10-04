/**
 * Geometry helpers for the RLC editor: grid snapping and hit testing.
 *
 * Kept apart from the model so the model stays a pure document description while the
 * editor's interaction details (snap distance, hit radius) live in one place.
 */

import { bodyRect, pinPos, type Pt, type RlcComponent, type RlcDoc } from "./rlcModel";
import { GRID } from "./rlcConstants";

export interface GridPos {
  x: number;
  y: number;
}

export function snapToGrid(v: number): number {
  return Math.round(v / GRID) * GRID;
}

export function snapPoint(p: Pt): Pt {
  return { x: snapToGrid(p.x), y: snapToGrid(p.y) };
}

/** Distance from a point to an axis-aligned segment. */
export function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** World-space bounding box of the whole document, for fit-to-view. */
export function docBounds(doc: RlcDoc): { minX: number; minY: number; maxX: number; maxY: number } {
  if (doc.components.length === 0) {
    return { minX: -400, minY: -300, maxX: 400, maxY: 300 };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of doc.components) {
    for (const pin of ["p0", "p1"] as const) {
      const p = pinPos(c, pin);
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    const b = bodyRect(c);
    minX = Math.min(minX, b.left);
    minY = Math.min(minY, b.top);
    maxX = Math.max(maxX, b.right);
    maxY = Math.max(maxY, b.bottom);
  }
  return { minX, minY, maxX, maxY };
}

/** True when the point lies within the component's body rectangle (hit test for dragging). */
export function hitComponent(comp: RlcComponent, p: Pt, slack = 0): boolean {
  const b = bodyRect(comp);
  return (
    p.x >= b.left - slack && p.x <= b.right + slack && p.y >= b.top - slack && p.y <= b.bottom + slack
  );
}

/** Which pin (if any) the point is within grab radius of. */
export function hitPin(
  comp: RlcComponent,
  p: Pt,
  radius: number,
): "p0" | "p1" | null {
  const d0 = Math.hypot(p.x - pinPos(comp, "p0").x, p.y - pinPos(comp, "p0").y);
  const d1 = Math.hypot(p.x - pinPos(comp, "p1").x, p.y - pinPos(comp, "p1").y);
  if (d0 <= radius && d0 <= d1) return "p0";
  if (d1 <= radius) return "p1";
  return null;
}
