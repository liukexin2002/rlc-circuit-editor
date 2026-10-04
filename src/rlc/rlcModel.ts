/**
 * RLC schematic document model.
 *
 * A deliberately small, self-contained model for a resistor / inductor / capacitor
 * schematic editor. Everything here is a pure function over plain data:
 *
 *   1. It is the single source of truth the editor renders and the router routes.
 *   2. Being pure, it is trivially testable in Node (no DOM, no React Flow).
 *   3. Being small, the four-way (up/down/left/right) pin semantics that the
 *      upstream AV editor does not need are exact rather than approximated.
 *
 * Coordinate system: world pixels, y grows downward (SVG convention).
 * All component origins and all pin positions land on the GRID lattice.
 */

import { GRID, SYMBOL_SPAN, SYMBOL_BODY_H, PIN_STUB } from "./rlcConstants";

export type RlcKind = "resistor" | "inductor" | "capacitor";

/** Clockwise screen-space rotation in 90° steps. */
export type RlcRotation = 0 | 90 | 180 | 270;

/** Axis-aligned pin direction in world space. */
export type PinSide = "left" | "right" | "up" | "down";

export interface Pt {
  x: number;
  y: number;
}

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface RlcPin {
  /** Pin id as stored in an edge endpoint (React Flow handle id). */
  id: "p0" | "p1";
  /** Which end of the symbol body this pin belongs to, in LOCAL space (pre-rotation). */
  localEnd: -1 | 1;
}

export interface RlcComponent {
  id: string;
  kind: RlcKind;
  /** Symbol origin (body center) in world pixels; always on the GRID lattice. */
  x: number;
  y: number;
  rotation: RlcRotation;
  /** Reference designator, e.g. R1 / L2 / C3. */
  label: string;
  /** Value text, e.g. 10k / 100uH / 100nF. */
  value: string;
}

export interface RlcEdgeEndpoint {
  componentId: string;
  pinId: RlcPin["id"];
}

export interface RlcEdge {
  id: string;
  from: RlcEdgeEndpoint;
  to: RlcEdgeEndpoint;
}

export interface RlcDoc {
  version: 1;
  components: RlcComponent[];
  edges: RlcEdge[];
  /** Monotonic counters — never reused, so undo/redo cannot alias ids. */
  nextComponentSeq: number;
  nextEdgeSeq: number;
  /** Per-kind reference designator counters. */
  labelSeq: Record<RlcKind, number>;
}

export function emptyRlcDoc(): RlcDoc {
  return {
    version: 1,
    components: [],
    edges: [],
    nextComponentSeq: 1,
    nextEdgeSeq: 1,
    labelSeq: { resistor: 0, inductor: 0, capacitor: 0 },
  };
}

export const KIND_PREFIX: Record<RlcKind, string> = {
  resistor: "R",
  inductor: "L",
  capacitor: "C",
};

export const KIND_DEFAULT_VALUE: Record<RlcKind, string> = {
  resistor: "10k",
  inductor: "100uH",
  capacitor: "100nF",
};

export const KIND_LABEL: Record<RlcKind, string> = {
  resistor: "电阻 Resistor",
  inductor: "电感 Inductor",
  capacitor: "电容 Capacitor",
};

/** The two pins of every RLC part, in local (unrotated) space. */
export const RLC_PINS: readonly RlcPin[] = [
  { id: "p0", localEnd: -1 },
  { id: "p1", localEnd: 1 },
] as const;

// ── Rotation primitives (screen space, y down) ────────────────────────────────

/**
 * Rotate a LOCAL offset by `rotation` degrees clockwise in screen space.
 * Local +X is the symbol's long axis; local -X is the opposite end.
 */
export function rotateLocalVec(x: number, y: number, rotation: RlcRotation): Pt {
  switch (rotation) {
    case 0:
      return { x, y };
    case 90:
      // +X → +Y (screen-space clockwise)
      return { x: -y, y: x };
    case 180:
      return { x: -x, y: -y };
    case 270:
      return { x: y, y: -x };
  }
}

export function normalizeRotation(deg: number): RlcRotation {
  const m = ((deg % 360) + 360) % 360;
  return (m === 90 ? 90 : m === 180 ? 180 : m === 270 ? 270 : 0) as RlcRotation;
}

// ── Derived geometry ─────────────────────────────────────────────────────────

/** Pin position in world pixels (on the GRID lattice by construction). */
export function pinPos(comp: RlcComponent, pinId: RlcPin["id"]): Pt {
  const end = pinId === "p0" ? -1 : 1;
  const v = rotateLocalVec(end * (SYMBOL_SPAN / 2), 0, comp.rotation);
  return { x: comp.x + v.x, y: comp.y + v.y };
}

/** Direction a wire leaves this pin, i.e. the outward-facing side of the symbol. */
export function pinSide(comp: RlcComponent, pinId: RlcPin["id"]): PinSide {
  const end = pinId === "p0" ? -1 : 1;
  const v = rotateLocalVec(end, 0, comp.rotation);
  if (v.x > 0) return "right";
  if (v.x < 0) return "left";
  return v.y > 0 ? "down" : "up";
}

/** The other pin of the same component. */
export function otherPin(pinId: RlcPin["id"]): RlcPin["id"] {
  return pinId === "p0" ? "p1" : "p0";
}

/**
 * Symbol body rectangle (world pixels), NOT including the lead stubs.
 * Rotated 90/270 swaps the long and short axes — a vertical resistor is tall.
 */
export function bodyRect(comp: RlcComponent): Rect {
  const long = SYMBOL_SPAN - 2 * PIN_STUB; // body is the span minus both lead stubs
  const short = SYMBOL_BODY_H;
  const w = comp.rotation === 90 || comp.rotation === 270 ? short : long;
  const h = comp.rotation === 90 || comp.rotation === 270 ? long : short;
  return {
    left: comp.x - w / 2,
    top: comp.y - h / 2,
    right: comp.x + w / 2,
    bottom: comp.y + h / 2,
  };
}

/**
 * Routing obstacle rectangle: the body grown by `padPx` on every side.
 * Pins sit OUTSIDE this rect (that is what makes routing to them legal), but the
 * lead stub passes through it in the pad band — the router is told to ignore the
 * obstacle that belongs to the wire's own endpoints, exactly like the upstream
 * editor does for its devices.
 */
export function obstacleRect(comp: RlcComponent, padPx: number): Rect {
  const b = bodyRect(comp);
  return {
    left: b.left - padPx,
    top: b.top - padPx,
    right: b.right + padPx,
    bottom: b.bottom + padPx,
  };
}

/** Reference designator with the next free number for this kind, without mutating. */
export function nextLabel(doc: RlcDoc, kind: RlcKind): string {
  return `${KIND_PREFIX[kind]}${doc.labelSeq[kind] + 1}`;
}

export function makeComponent(
  doc: RlcDoc,
  kind: RlcKind,
  x: number,
  y: number,
  rotation: RlcRotation = 0,
): { component: RlcComponent; doc: RlcDoc } {
  const n = doc.labelSeq[kind] + 1;
  const component: RlcComponent = {
    id: `n${doc.nextComponentSeq}`,
    kind,
    x,
    y,
    rotation,
    label: `${KIND_PREFIX[kind]}${n}`,
    value: KIND_DEFAULT_VALUE[kind],
  };
  return {
    component,
    doc: {
      ...doc,
      nextComponentSeq: doc.nextComponentSeq + 1,
      labelSeq: { ...doc.labelSeq, [kind]: n },
    },
  };
}

/** Angular difference that keeps the lattice invariant: GRID multiples stay multiples. */
export function gridAligned(v: number): boolean {
  return Number.isInteger(v / GRID);
}
