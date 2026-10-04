/**
 * RLC document model tests.
 *
 * The model is the single source of truth for both rendering and routing, so its
 * invariants get asserted exhaustively where the domain is small enough to enumerate:
 * every kind × every rotation × both pins.
 */

import { describe, expect, it } from "vitest";
import {
  bodyRect,
  emptyRlcDoc,
  gridAligned,
  KIND_DEFAULT_VALUE,
  KIND_PREFIX,
  makeComponent,
  nextLabel,
  normalizeRotation,
  obstacleRect,
  otherPin,
  pinPos,
  pinSide,
  rotateLocalVec,
  type RlcKind,
  type RlcRotation,
} from "../../rlc/rlcModel";
import { GRID, OBSTACLE_PAD, SYMBOL_BODY_H, SYMBOL_SPAN } from "../../rlc/rlcConstants";

const KINDS: RlcKind[] = ["resistor", "inductor", "capacitor"];
const ROTATIONS: RlcRotation[] = [0, 90, 180, 270];

describe("RLC model — component creation", () => {
  it("auto-numbers reference designators per kind, never reusing a number", () => {
    let doc = emptyRlcDoc();
    const r1 = makeComponent(doc, "resistor", 0, 0);
    doc = r1.doc;
    const r2 = makeComponent(doc, "resistor", 0, 0);
    doc = r2.doc;
    const c1 = makeComponent(doc, "capacitor", 0, 0);
    doc = c1.doc;
    expect([r1.component.label, r2.component.label, c1.component.label]).toEqual(["R1", "R2", "C1"]);
    expect(nextLabel(doc, "resistor")).toBe("R3");
    expect(nextLabel(doc, "inductor")).toBe("L1");
  });

  it("gives every kind a sensible default value and unique ids", () => {
    let doc = emptyRlcDoc();
    const seen = new Set<string>();
    for (const kind of KINDS) {
      const res = makeComponent(doc, kind, 0, 0);
      doc = res.doc;
      expect(res.component.value).toBe(KIND_DEFAULT_VALUE[kind]);
      expect(res.component.label.startsWith(KIND_PREFIX[kind])).toBe(true);
      expect(seen.has(res.component.id)).toBe(false);
      seen.add(res.component.id);
    }
  });
});

describe("RLC model — pin geometry across all kinds and rotations", () => {
  it("P0 always faces opposite to P1", () => {
    const opposite = { left: "right", right: "left", up: "down", down: "up" } as const;
    for (const kind of KINDS) {
      for (const rotation of ROTATIONS) {
        const doc = emptyRlcDoc();
        const comp = makeComponent(doc, kind, 320, 320, rotation).component;
        expect(pinSide(comp, "p1")).toBe(opposite[pinSide(comp, "p0")]);
      }
    }
  });

  it("pins are always on the GRID lattice, and 4 cells apart", () => {
    for (const kind of KINDS) {
      for (const rotation of ROTATIONS) {
        const doc = emptyRlcDoc();
        const comp = makeComponent(doc, kind, 320, 320, rotation).component;
        const a = pinPos(comp, "p0");
        const b = pinPos(comp, "p1");
        expect(gridAligned(a.x), `pin x on grid (${kind} @${rotation})`).toBe(true);
        expect(gridAligned(a.y), `pin y on grid (${kind} @${rotation})`).toBe(true);
        expect(Math.abs(b.x - a.x) + Math.abs(b.y - a.y)).toBe(SYMBOL_SPAN);
      }
    }
  });

  it("rotation moves pins the way screen-space clockwise rotation does", () => {
    const doc = emptyRlcDoc();
    const base = makeComponent(doc, "resistor", 320, 320, 0).component;
    const expectP0: Record<RlcRotation, { x: number; y: number }> = {
      0: { x: 320 - SYMBOL_SPAN / 2, y: 320 },
      90: { x: 320, y: 320 - SYMBOL_SPAN / 2 },
      180: { x: 320 + SYMBOL_SPAN / 2, y: 320 },
      270: { x: 320, y: 320 + SYMBOL_SPAN / 2 },
    };
    for (const rotation of ROTATIONS) {
      const comp = { ...base, rotation };
      expect(pinPos(comp, "p0"), `p0 @${rotation}`).toEqual(expectP0[rotation]);
    }
  });

  it("body rect never contains its own pins", () => {
    for (const kind of KINDS) {
      for (const rotation of ROTATIONS) {
        const doc = emptyRlcDoc();
        const comp = makeComponent(doc, kind, 320, 320, rotation).component;
        const b = bodyRect(comp);
        for (const pin of ["p0", "p1"] as const) {
          const p = pinPos(comp, pin);
          const inside = p.x > b.left && p.x < b.right && p.y > b.top && p.y < b.bottom;
          expect(inside, `${kind}@${rotation} ${pin} must sit outside the body`).toBe(false);
        }
      }
    }
  });

  it("obstacle rect grows the body by exactly the pad on all four sides", () => {
    for (const rotation of ROTATIONS) {
      const doc = emptyRlcDoc();
      const comp = makeComponent(doc, "capacitor", 320, 320, rotation).component;
      const b = bodyRect(comp);
      const o = obstacleRect(comp, OBSTACLE_PAD);
      expect(o.left).toBe(b.left - OBSTACLE_PAD);
      expect(o.right).toBe(b.right + OBSTACLE_PAD);
      expect(o.top).toBe(b.top - OBSTACLE_PAD);
      expect(o.bottom).toBe(b.bottom + OBSTACLE_PAD);
    }
  });

  it("a rotated symbol is tall, not wide (axes swap)", () => {
    const doc = emptyRlcDoc();
    const flat = makeComponent(doc, "resistor", 320, 320, 0).component;
    const upright = makeComponent(doc, "resistor", 320, 320, 90).component;
    const f = bodyRect(flat);
    const u = bodyRect(upright);
    expect(f.right - f.left).toBeGreaterThan(f.bottom - f.top);
    expect(u.bottom - u.top).toBeGreaterThan(u.right - u.left);
    expect(u.bottom - u.top).toBe(f.right - f.left);
    expect(f.bottom - f.top).toBe(SYMBOL_BODY_H);
  });
});

describe("RLC model — rotation primitives", () => {
  it("normalizeRotation folds any angle into the four legal steps", () => {
    expect(normalizeRotation(0)).toBe(0);
    expect(normalizeRotation(90)).toBe(90);
    expect(normalizeRotation(180)).toBe(180);
    expect(normalizeRotation(270)).toBe(270);
    expect(normalizeRotation(360)).toBe(0);
    expect(normalizeRotation(-90)).toBe(270);
    expect(normalizeRotation(450)).toBe(90);
    expect(normalizeRotation(37)).toBe(0);
  });

  it("four quarter turns return a vector to itself", () => {
    for (const v of [{ x: 5, y: 0 }, { x: 0, y: -3 }, { x: 7, y: 2 }]) {
      let p = { x: v.x, y: v.y };
      for (let i = 0; i < 4; i++) p = rotateLocalVec(p.x, p.y, 90);
      expect(p).toEqual(v);
    }
  });

  it("otherPin is an involution", () => {
    expect(otherPin("p0")).toBe("p1");
    expect(otherPin("p1")).toBe("p0");
    expect(otherPin(otherPin("p0"))).toBe("p0");
  });
});

describe("RLC model — grid discipline", () => {
  it("gridAligned accepts GRID multiples and rejects everything else", () => {
    expect(gridAligned(0)).toBe(true);
    expect(gridAligned(GRID)).toBe(true);
    expect(gridAligned(-3 * GRID)).toBe(true);
    expect(gridAligned(GRID / 2)).toBe(false);
    expect(gridAligned(1)).toBe(false);
  });
});
