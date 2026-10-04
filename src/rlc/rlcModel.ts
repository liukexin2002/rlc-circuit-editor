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
 *
 * ── DOCUMENT VERSION 2 ───────────────────────────────────────────────────────
 * v2 adds two things v1 could not express:
 *
 *   a) WIRE-TO-WIRE TAPS. A wire endpoint is now either a component pin or a point on
 *      another wire (`kind: "tap"`). That point is a Steiner point of the resulting
 *      rectilinear tree: it is where a newly grown branch meets the existing wire, so the
 *      new wire is as short as the geometry allows.
 *
 *   b) STORED GEOMETRY. Every wire's solved polyline is kept in `geometry`. This is what
 *      makes reopening a saved file pixel-identical instead of a re-route that merely
 *      "should" look the same: the canvas renders the stored polyline, and a re-route is
 *      only ever used to CHECK it (a mismatch is reported, never silently redrawn).
 *
 * Migration from v1 is total and lossless for everything v1 could express: v1 endpoints
 * become `kind: "pin"`, and a v1 document carries no `geometry`, so the editor solves each
 * wire once on open and records it. Nothing about a v1 document's appearance changes.
 */

import { GRID, SYMBOL_SPAN, SYMBOL_BODY_H, PIN_STUB, DOC_VERSION } from "./rlcConstants";

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
  /** Pin id as stored in an edge endpoint. */
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
  /** Reference designator, e.g. R1 / L2 / C3. Doubles as the network name in the netlist. */
  label: string;
  /** Value text, e.g. 10k / 100uH / 100nF. */
  value: string;
}

/** A wire end anchored on a component pin. */
export interface RlcPinEndpoint {
  kind: "pin";
  componentId: string;
  pinId: RlcPin["id"];
}

/**
 * A wire end anchored on another wire — the Steiner point of an incremental branch.
 *
 * `x`/`y` is the solved junction. It is a real stored coordinate (not a fraction along the
 * host) because that is what makes reopening a file reproducible; the router still PROJECTS
 * it onto the host's current polyline whenever it routes, so if the host later moves the
 * junction follows it rather than floating in space.
 */
export interface RlcTapEndpoint {
  kind: "tap";
  /** The wire this endpoint taps. */
  edgeId: string;
  x: number;
  y: number;
}

export type RlcEdgeEndpoint = RlcPinEndpoint | RlcTapEndpoint;

export interface RlcEdge {
  id: string;
  from: RlcEdgeEndpoint;
  to: RlcEdgeEndpoint;
}

/** Solved geometry for one wire, keyed by edge id. */
export interface RlcWireGeometry {
  waypoints: Pt[];
  /** Quality tier the solve achieved, so a reopened file reports the same badge as when saved. */
  quality: string;
}

export interface RlcDoc {
  version: typeof DOC_VERSION;
  components: RlcComponent[];
  edges: RlcEdge[];
  /** Monotonic counters — never reused, so undo/redo cannot alias ids. */
  nextComponentSeq: number;
  nextEdgeSeq: number;
  /** Per-kind reference designator counters. */
  labelSeq: Record<RlcKind, number>;
  /**
   * Solved polylines, keyed by edge id. Present so a reopened document renders EXACTLY what
   * was saved. Absent/partial geometry is legal (hand-written documents): those wires get
   * solved once on open, and the caller is told that a solve happened.
   */
  geometry: Record<string, RlcWireGeometry>;
  /**
   * Ports and grounds are declarations about the CIRCUIT, not about the drawing, so they are
   * anchored to stable pin ids rather than to derived net names — net ids can be renumbered
   * by unrelated edits, which would silently move a port to a different node.
   */
  ports: string[];
  grounds: string[];
  /** Whether wire-vs-wire separation was on when the document was saved. */
  avoidWires: boolean;
}

/** Stable key for a pin, used by the port/ground declarations. */
export function pinKey(componentId: string, pinId: RlcPin["id"]): string {
  return `${componentId}.${pinId}`;
}

export function emptyRlcDoc(): RlcDoc {
  return {
    version: DOC_VERSION,
    components: [],
    edges: [],
    nextComponentSeq: 1,
    nextEdgeSeq: 1,
    labelSeq: { resistor: 0, inductor: 0, capacitor: 0 },
    geometry: {},
    ports: [],
    grounds: [],
    avoidWires: true,
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

// ── Endpoint helpers ─────────────────────────────────────────────────────────

export function isPinEndpoint(e: RlcEdgeEndpoint): e is RlcPinEndpoint {
  return e.kind === "pin";
}

export function isTapEndpoint(e: RlcEdgeEndpoint): e is RlcTapEndpoint {
  return e.kind === "tap";
}

/** The other end of an edge. */
export function otherEndpoint(edge: RlcEdge, end: RlcEdgeEndpoint): RlcEdgeEndpoint {
  return edge.from === end || (isPinEndpoint(edge.from) && isPinEndpoint(end) &&
    edge.from.componentId === end.componentId && edge.from.pinId === end.pinId)
    ? edge.to
    : edge.from;
}

/**
 * Delete an edge, cascading to every wire that taps it.
 *
 * A tap without its host would be a junction pointing at nothing, so the cascade is
 * transitive: removing e1 removes e2 (taps e1), which removes e3 (taps e2), and so on.
 * Pure, so the cascade is unit-testable without touching a store.
 */
export function removeEdgesCascade(doc: RlcDoc, edgeIds: readonly string[]): RlcDoc {
  const doomed = new Set(edgeIds);
  // Fixpoint: keep absorbing wires that tap something already doomed.
  for (;;) {
    let grew = false;
    for (const e of doc.edges) {
      if (doomed.has(e.id)) continue;
      for (const end of [e.from, e.to]) {
        if (isTapEndpoint(end) && doomed.has(end.edgeId)) {
          doomed.add(e.id);
          grew = true;
          break;
        }
      }
    }
    if (!grew) break;
  }
  const geometry: Record<string, RlcWireGeometry> = {};
  for (const [id, g] of Object.entries(doc.geometry)) {
    if (!doomed.has(id)) geometry[id] = g;
  }
  return {
    ...doc,
    edges: doc.edges.filter((e) => !doomed.has(e.id)),
    geometry,
  };
}

/** Delete a component and every wire attached to it (directly or through a tap cascade). */
export function removeComponentsCascade(doc: RlcDoc, componentIds: readonly string[]): RlcDoc {
  const doomedComponents = new Set(componentIds);
  const doomedEdges = doc.edges
    .filter(
      (e) =>
        (isPinEndpoint(e.from) && doomedComponents.has(e.from.componentId)) ||
        (isPinEndpoint(e.to) && doomedComponents.has(e.to.componentId)),
    )
    .map((e) => e.id);
  const pruned = removeEdgesCascade(doc, doomedEdges);
  const dead = new Set(componentIds);
  const ports = doc.ports.filter((p) => !dead.has(p.split(".")[0]));
  const grounds = doc.grounds.filter((p) => !dead.has(p.split(".")[0]));
  return {
    ...pruned,
    components: pruned.components.filter((c) => !dead.has(c.id)),
    ports,
    grounds,
  };
}

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
