/**
 * R / L / C symbol geometry, in LOCAL coordinates (symbol centered on the origin,
 * long axis along X). The canvas rotates the group for display, so every path here is
 * written once, unrotated — the same way a schematic symbol library is authored.
 *
 * Symbols are drawn from the standard shapes:
 *   resistor  — IEC rectangle body between two leads
 *   inductor  — IEC rectangle body (a coil drawn as arcs at this size reads as noise)
 *   capacitor — two plates perpendicular to the wire axis
 *
 * LOCAL convention: pins sit at x = ±SYMBOL_SPAN/2, y = 0. The lead stubs run from the
 * pin inwards to the body edge, so the rendered wire visually continues into the part.
 */

import { SYMBOL_BODY_H, SYMBOL_SPAN, PIN_STUB } from "./rlcConstants";
import type { RlcKind } from "./rlcModel";

const HALF_SPAN = SYMBOL_SPAN / 2;
const BODY_HALF = SYMBOL_SPAN / 2 - PIN_STUB;
const HALF_H = SYMBOL_BODY_H / 2;

export interface SymbolGeometry {
  /** Lead line from pin 0 to the body edge. */
  leadIn: string;
  /** Lead line from the body edge to pin 1. */
  leadOut: string;
  /** The device body — a path drawn with the symbol's stroke. */
  body: string;
  /** Extra paths drawn thin (capacitor plates are filled rectangles in many styles). */
  extras: string[];
  /** Local-space bounding box, for selection outlines and labels. */
  bbox: { left: number; top: number; right: number; bottom: number };
}

function resistorGeometry(): SymbolGeometry {
  const body = `M ${-BODY_HALF} ${-HALF_H} H ${BODY_HALF} V ${HALF_H} H ${-BODY_HALF} Z`;
  return {
    leadIn: `M ${-HALF_SPAN} 0 H ${-BODY_HALF}`,
    leadOut: `M ${BODY_HALF} 0 H ${HALF_SPAN}`,
    body,
    extras: [],
    bbox: { left: -HALF_SPAN, top: -HALF_H, right: HALF_SPAN, bottom: HALF_H },
  };
}

function inductorGeometry(): SymbolGeometry {
  // Body rectangle plus three coil arcs, so the part reads as an inductor at a glance
  // without turning into visual noise at small zoom.
  const body = `M ${-BODY_HALF} ${-HALF_H} H ${BODY_HALF} V ${HALF_H} H ${-BODY_HALF} Z`;
  const r = (BODY_HALF * 2) / 6;
  const extras: string[] = [];
  for (let i = 0; i < 3; i++) {
    const x0 = -BODY_HALF + i * r * 2;
    const x1 = x0 + r * 2;
    const mx = (x0 + x1) / 2;
    extras.push(`M ${x0} 0 Q ${mx} ${-HALF_H * 1.4} ${x1} 0`);
  }
  return {
    leadIn: `M ${-HALF_SPAN} 0 H ${-BODY_HALF}`,
    leadOut: `M ${BODY_HALF} 0 H ${HALF_SPAN}`,
    body,
    extras,
    bbox: { left: -HALF_SPAN, top: -HALF_H, right: HALF_SPAN, bottom: HALF_H },
  };
}

function capacitorGeometry(): SymbolGeometry {
  // Two plates crossing the axis; the wire visually stops at each plate.
  const gap = PIN_STUB / 2;
  const plateH = HALF_H * 1.6;
  const pl = `M ${-gap} ${-plateH} V ${plateH}`;
  const pr = `M ${gap} ${-plateH} V ${plateH}`;
  return {
    leadIn: `M ${-HALF_SPAN} 0 H ${-gap}`,
    leadOut: `M ${gap} 0 H ${HALF_SPAN}`,
    body: pl,
    extras: [pr],
    bbox: { left: -HALF_SPAN, top: -plateH, right: HALF_SPAN, bottom: plateH },
  };
}

export function symbolGeometry(kind: RlcKind): SymbolGeometry {
  switch (kind) {
    case "resistor":
      return resistorGeometry();
    case "inductor":
      return inductorGeometry();
    case "capacitor":
      return capacitorGeometry();
  }
}

/** Where the reference designator / value text sits in LOCAL space, below the body. */
export function labelAnchor(kind: RlcKind): { label: { x: number; y: number }; value: { x: number; y: number } } {
  const g = symbolGeometry(kind);
  const below = g.bbox.bottom + HALF_H * 1.6;
  return {
    label: { x: 0, y: below },
    value: { x: 0, y: below + HALF_H * 1.6 },
  };
}
