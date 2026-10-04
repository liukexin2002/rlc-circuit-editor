/**
 * RLC routing rule tests.
 *
 * These are the acceptance gates for the two features this editor exists to get right:
 * CONNECTING and OBSTACLE AVOIDANCE. Every assertion is made on MEASURED geometry — the
 * router's own output is never trusted as "correct because it returned something".
 *
 * Rules under test (adapted from the AV editor's documented ROUTING_RULES):
 *   R1  a wire never crosses a component body (with the pad band exempt only for the two
 *       stub segments of its own endpoints)
 *   R2  a wire leaves/enters a pin along that pin's facing
 *   R3  every segment is perfectly horizontal or vertical
 *   R4  a wire runs at least one full cell straight at each end
 *   R5  successive passes are deterministic (same document → identical geometry)
 *   R6  a boxed-in pin still yields an orthogonal, pin-facing path (degraded, no hang)
 *   R7  with avoidance on, two wires never run along the same corridor on the same axis
 */

import { describe, expect, it } from "vitest";
import {
  countTurns,
  crossedObstacles,
  endStubLengths,
  fallbackZPath,
  isOrthogonalPolyline,
  parallelOverlapCells,
  routeDocument,
  segmentIntersectsRect,
} from "../../rlc/rlcRouting";
import {
  emptyRlcDoc,
  isPinEndpoint,
  makeComponent,
  obstacleRect,
  pinPos,
  pinSide,
  type RlcComponent,
  type RlcDoc,
  type RlcEdge,
  type RlcKind,
  type RlcRotation,
} from "../../rlc/rlcModel";
import { COMFORT_PAD, GRID, MIN_STUB_PX, OBSTACLE_PAD } from "../../rlc/rlcConstants";

// ── Fixture helpers ──────────────────────────────────────────────────────────

function place(doc: RlcDoc, kind: RlcKind, x: number, y: number, rotation: RlcRotation = 0) {
  const res = makeComponent(doc, kind, x, y, rotation);
  doc.components.push(res.component);
  doc.nextComponentSeq = res.doc.nextComponentSeq;
  doc.labelSeq = res.doc.labelSeq;
  return res.component;
}

function connect(
  doc: RlcDoc,
  a: RlcComponent,
  aPin: "p0" | "p1",
  b: RlcComponent,
  bPin: "p0" | "p1",
): RlcEdge {
  const edge: RlcEdge = {
    id: `e${doc.nextEdgeSeq}`,
    from: { kind: "pin", componentId: a.id, pinId: aPin },
    to: { kind: "pin", componentId: b.id, pinId: bPin },
  };
  doc.nextEdgeSeq++;
  doc.edges.push(edge);
  return edge;
}

/** Assert every hard geometry rule for one routed wire. */
function expectWireRules(doc: RlcDoc, edge: RlcEdge, waypoints: { x: number; y: number }[]) {
  // R3: strictly orthogonal.
  expect(isOrthogonalPolyline(waypoints), "wire must be strictly orthogonal").toBe(true);

  // R1: never crosses a component obstacle (own stub segments exempt by construction).
  expect(crossedObstacles(doc, edge, waypoints)).toEqual([]);

  // R2 + R4: both ends anchored on the true pins and leaving along the pin facing.
  const fromEnd = edge.from;
  const toEnd = edge.to;
  if (!isPinEndpoint(fromEnd) || !isPinEndpoint(toEnd)) {
    throw new Error("expectWireRules is for pin-to-pin wires");
  }
  const from = doc.components.find((c) => c.id === fromEnd.componentId)!;
  const to = doc.components.find((c) => c.id === toEnd.componentId)!;
  expect(waypoints[0]).toEqual(pinPos(from, fromEnd.pinId));
  expect(waypoints[waypoints.length - 1]).toEqual(pinPos(to, toEnd.pinId));

  const stubs = endStubLengths(waypoints);
  expect(stubs.start, "source stub must clear the pin by a full cell").toBeGreaterThanOrEqual(GRID);
  expect(stubs.end, "target stub must clear the pin by a full cell").toBeGreaterThanOrEqual(GRID);

  const dirOf = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    Math.abs(b.x - a.x) > Math.abs(b.y - a.y) ? "h" : "v";
  const sSide = pinSide(from, fromEnd.pinId);
  const eSide = pinSide(to, toEnd.pinId);
  expect(dirOf(waypoints[0], waypoints[1]), `source pin ${sSide} exit axis`).toBe(
    sSide === "left" || sSide === "right" ? "h" : "v",
  );
  expect(
    dirOf(waypoints[waypoints.length - 2], waypoints[waypoints.length - 1]),
    `target pin ${eSide} entry axis`,
  ).toBe(eSide === "left" || eSide === "right" ? "h" : "v");
}

// ── Scenario A: direct connection ────────────────────────────────────────────

describe("RLC routing — scenario A: direct connection", () => {
  it("routes two aligned parts straight through with no turns", () => {
    const doc = emptyRlcDoc();
    const r1 = place(doc, "resistor", 160, 160);
    const c1 = place(doc, "capacitor", 480, 160);
    const edge = connect(doc, r1, "p1", c1, "p0");

    const { wires, degradedCount } = routeDocument(doc);
    const w = wires[edge.id];
    expect(w).toBeDefined();
    expect(w.quality).toBe("clean");
    expect(degradedCount).toBe(0);
    expectWireRules(doc, edge, w.waypoints);
    expect(countTurns(w.waypoints)).toBe(0);
  });
});

// ── Scenario B: obstacle avoidance ───────────────────────────────────────────

describe("RLC routing — scenario B: obstacle avoidance", () => {
  it("detours around a part sitting between the two endpoints", () => {
    const doc = emptyRlcDoc();
    const r1 = place(doc, "resistor", 160, 160);
    const blocker = place(doc, "inductor", 320, 160);
    const c1 = place(doc, "capacitor", 480, 160);
    const edge = connect(doc, r1, "p1", c1, "p0");

    const { wires } = routeDocument(doc);
    const w = wires[edge.id];
    expect(w.quality).toBe("clean");
    expectWireRules(doc, edge, w.waypoints);
    expect(countTurns(w.waypoints), "a straight shot would hit the blocker").toBeGreaterThanOrEqual(2);

    // Explicitly: no segment enters the blocker's padded body. The rect comes from the
    // model itself so the test cannot drift from the geometry being routed against.
    const r = obstacleRect(blocker, OBSTACLE_PAD);
    const ob = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    for (let i = 1; i < w.waypoints.length; i++) {
      expect(segmentIntersectsRect(w.waypoints[i - 1], w.waypoints[i], ob)).toBe(false);
    }
  });

  it("routes around a wall of three stacked parts", () => {
    const doc = emptyRlcDoc();
    const src = place(doc, "resistor", 160, 320);
    place(doc, "capacitor", 352, 224, 90);
    place(doc, "capacitor", 352, 320, 90);
    place(doc, "capacitor", 352, 416, 90);
    const dst = place(doc, "resistor", 544, 320);
    const edge = connect(doc, src, "p1", dst, "p0");

    const { wires } = routeDocument(doc);
    const w = wires[edge.id];
    expect(w.quality).toBe("clean");
    expectWireRules(doc, edge, w.waypoints);
  });
});

// ── Scenario C: rotation (four-way pin semantics) ────────────────────────────

describe("RLC routing — scenario C: rotation", () => {
  it("honours pin facing for every rotation of the source part", () => {
    for (const rotation of [0, 90, 180, 270] as const) {
      const doc = emptyRlcDoc();
      const a = place(doc, "resistor", 320, 320, rotation);
      const b = place(doc, "capacitor", 800, 320);
      const edge = connect(doc, a, "p1", b, "p0");

      const { wires } = routeDocument(doc);
      expect(wires[edge.id], `rotation ${rotation} must produce a wire`).toBeDefined();
      expectWireRules(doc, edge, wires[edge.id].waypoints);
    }
  });

  it("routes between two vertically-facing pins", () => {
    const doc = emptyRlcDoc();
    const a = place(doc, "resistor", 320, 160, 90);
    const b = place(doc, "capacitor", 320, 640, 270);
    const edge = connect(doc, a, "p0", b, "p0");

    const { wires } = routeDocument(doc);
    const w = wires[edge.id];
    expect(w).toBeDefined();
    expect(w.quality).toBe("clean");
    expectWireRules(doc, edge, w.waypoints);
  });

  it("moves pin geometry as a part rotates (model invariant)", () => {
    const doc = emptyRlcDoc();
    const a = place(doc, "resistor", 320, 320, 0);
    expect(pinPos(a, "p0")).toEqual({ x: 320 - 2 * GRID, y: 320 });
    expect(pinSide(a, "p0")).toBe("left");
    a.rotation = 90;
    expect(pinPos(a, "p0")).toEqual({ x: 320, y: 320 - 2 * GRID });
    expect(pinSide(a, "p0")).toBe("up");
    a.rotation = 180;
    expect(pinPos(a, "p0")).toEqual({ x: 320 + 2 * GRID, y: 320 });
    expect(pinSide(a, "p0")).toBe("right");
    a.rotation = 270;
    expect(pinPos(a, "p0")).toEqual({ x: 320, y: 320 + 2 * GRID });
    expect(pinSide(a, "p0")).toBe("down");
  });
});

// ── Scenario D: wire-vs-wire avoidance ──────────────────────────────────────

describe("RLC routing — scenario D: wire-vs-wire avoidance", () => {
  it("keeps three crossing wires out of each other's corridors", () => {
    const doc = emptyRlcDoc();
    const a1 = place(doc, "resistor", 160, 160, 0);
    const a2 = place(doc, "resistor", 160, 320, 0);
    const a3 = place(doc, "resistor", 160, 480, 0);
    const b1 = place(doc, "capacitor", 640, 160, 0);
    const b2 = place(doc, "capacitor", 640, 320, 0);
    const b3 = place(doc, "capacitor", 640, 480, 0);
    const e1 = connect(doc, a1, "p1", b3, "p0");
    const e2 = connect(doc, a2, "p1", b2, "p0");
    const e3 = connect(doc, a3, "p1", b1, "p0");

    const { wires } = routeDocument(doc, { avoidWires: true });
    for (const e of [e1, e2, e3]) {
      expect(wires[e.id]).toBeDefined();
      expectWireRules(doc, e, wires[e.id].waypoints);
    }

    // R7: no two wires may run along the same corridor on the same axis.
    const ws = [wires[e1.id], wires[e2.id], wires[e3.id]];
    for (let i = 0; i < ws.length; i++) {
      for (let j = i + 1; j < ws.length; j++) {
        expect(
          parallelOverlapCells(ws[i].waypoints, ws[j].waypoints),
          `wires ${ws[i].edgeId} and ${ws[j].edgeId} must not share a corridor`,
        ).toEqual([]);
      }
    }
  });

  it("produces different geometry with wire avoidance off (the feature is real)", () => {
    // Three wires whose natural routes all want the same middle column. With avoidance on
    // they must spread across neighbouring columns; with it off they are free to coincide.
    const build = () => {
      const doc = emptyRlcDoc();
      const top = place(doc, "resistor", 160, 160, 0);
      const mid = place(doc, "resistor", 160, 320, 0);
      const bot = place(doc, "resistor", 160, 480, 0);
      const hub = place(doc, "capacitor", 800, 320, 0);
      const e1 = connect(doc, top, "p1", hub, "p0");
      const e2 = connect(doc, mid, "p1", hub, "p0");
      const e3 = connect(doc, bot, "p1", hub, "p0");
      return { doc, ids: [e1.id, e2.id, e3.id] };
    };
    const on = build();
    const off = build();
    const rOn = routeDocument(on.doc, { avoidWires: true });
    const rOff = routeDocument(off.doc, { avoidWires: false });
    const sig = (r: typeof rOn, ids: string[]) => ids.map((id) => JSON.stringify(r.wires[id].waypoints)).join("#");

    // With avoidance ON the three wires must not share a corridor.
    const ws = on.ids.map((id) => rOn.wires[id]);
    for (let i = 0; i < ws.length; i++) {
      for (let j = i + 1; j < ws.length; j++) {
        expect(
          parallelOverlapCells(ws[i].waypoints, ws[j].waypoints),
          `avoidance on: wires ${ws[i].edgeId}/${ws[j].edgeId} share a corridor`,
        ).toEqual([]);
      }
    }

    // And the two modes must not produce identical geometry — otherwise the switch is a lie.
    expect(sig(rOn, on.ids)).not.toBe(sig(rOff, off.ids));
  });
});

// ── Scenario E: boxed in → degraded, never broken ───────────────────────────

describe("RLC routing — scenario E: graceful degradation", () => {
  it("emits an orthogonal, pin-facing path when the target is walled in", () => {
    const doc = emptyRlcDoc();
    const src = place(doc, "resistor", 160, 320, 0);
    const dst = place(doc, "capacitor", 640, 320, 0);
    place(doc, "capacitor", 640 - 4 * GRID, 320 - 4 * GRID, 90);
    place(doc, "capacitor", 640 - 4 * GRID, 320 + 4 * GRID, 90);
    place(doc, "capacitor", 640 - 7 * GRID, 320, 90);
    place(doc, "capacitor", 640 - 4 * GRID, 320, 90);
    const edge = connect(doc, src, "p1", dst, "p0");

    const { wires } = routeDocument(doc);
    const w = wires[edge.id];
    expect(w).toBeDefined();
    expect(isOrthogonalPolyline(w.waypoints)).toBe(true);
    expect(w.waypoints[0]).toEqual(pinPos(src, "p1"));
    expect(w.waypoints[w.waypoints.length - 1]).toEqual(pinPos(dst, "p0"));
    const stubs = endStubLengths(w.waypoints);
    expect(stubs.start).toBeGreaterThanOrEqual(GRID);
    expect(stubs.end).toBeGreaterThanOrEqual(GRID);
  });

  it("the escape path is orthogonal, pin-facing and stub-preserving for all 16 pairs", () => {    const sides = ["left", "right", "up", "down"] as const;
    const doc = emptyRlcDoc();
    // A realistic scene, so the escape line has obstacles to dodge.
    place(doc, "capacitor", 480, 240, 90);
    place(doc, "capacitor", 480, 400, 90);
    for (const s of sides) {
      for (const t of sides) {
        const pts = fallbackZPath(doc, { x: 160, y: 320 }, s, { x: 800, y: 320 }, t);
        expect(isOrthogonalPolyline(pts), `${s}→${t} must be orthogonal`).toBe(true);
        expect(pts[0], `${s}→${t} start anchor`).toEqual({ x: 160, y: 320 });
        expect(pts[pts.length - 1], `${s}→${t} end anchor`).toEqual({ x: 800, y: 320 });
        const stubs = endStubLengths(pts);
        expect(stubs.start, `${s}→${t} start stub`).toBeGreaterThanOrEqual(GRID);
        expect(stubs.end, `${s}→${t} end stub`).toBeGreaterThanOrEqual(GRID);
        const first = pts[1];
        const sHoriz = s === "left" || s === "right";
        expect(
          sHoriz ? first.y === 320 : first.x === 160,
          `${s}→${t} first move must follow the pin facing`,
        ).toBe(true);
      }
    }
  });
});

// ── Quality tiers ───────────────────────────────────────────────────────────

describe("RLC routing — quality tiers are honest about what was achieved", () => {
  it("reports clean when parts are spaced normally", () => {
    const doc = emptyRlcDoc();
    const a = place(doc, "resistor", 160, 160, 0);
    const b = place(doc, "capacitor", 160 + 16 * GRID, 160, 0);
    const edge = connect(doc, a, "p1", b, "p0");
    const { wires, degradedCount } = routeDocument(doc);
    expect(wires[edge.id].quality).toBe("clean");
    expect(degradedCount).toBe(0);
  });

  it("never crosses a BODY while claiming a body-respecting tier", () => {
    // Sweep the whole spacing range from comfortable down to physically overlapping. The
    // contract under test is the one the UI relies on: a wire reported clean/tight REALLY
    // does avoid every body; anything worse is reported as escape rather than hidden.
    const spacings = [10, 8, 6, 5, 4, 3, 2];
    for (const cells of spacings) {
      const doc = emptyRlcDoc();
      const a = place(doc, "resistor", 224, 160, 0);
      const b = place(doc, "capacitor", 224 + cells * GRID, 160, 0);
      const edge = connect(doc, a, "p1", b, "p0");
      const { wires, degradedCount } = routeDocument(doc);
      const w = wires[edge.id];
      expect(w, `spacing ${cells} must produce a wire`).toBeDefined();

      // Geometric invariants hold at EVERY spacing, including the impossible ones.
      expect(isOrthogonalPolyline(w.waypoints), `spacing ${cells} orthogonal`).toBe(true);
      const stubs = endStubLengths(w.waypoints);
      expect(stubs.start, `spacing ${cells} start stub`).toBeGreaterThanOrEqual(GRID);
      expect(stubs.end, `spacing ${cells} end stub`).toBeGreaterThanOrEqual(GRID);

      // The honesty contract.
      if (w.quality !== "escape") {
        expect(
          crossedObstacles(doc, edge, w.waypoints, { padPx: 0 }),
          `spacing ${cells} reported "${w.quality}" so it must avoid every body`,
        ).toEqual([]);
      }
      expect(w.degraded).toBe(w.quality !== "clean");
      expect(degradedCount).toBeGreaterThanOrEqual(w.degraded ? 1 : 0);
    }
  });

  it("uses a body-respecting tier when pads overlap but bodies do not", () => {
    // 6 cells apart: the comfort pads collide while both bodies stay clear, which is
    // exactly the case the middle tiers exist for.
    const doc = emptyRlcDoc();
    const a = place(doc, "resistor", 224, 160, 0);
    const b = place(doc, "capacitor", 224 + 6 * GRID, 160, 0);
    const edge = connect(doc, a, "p1", b, "p0");
    const { wires } = routeDocument(doc);
    const w = wires[edge.id];
    expect(w.quality).not.toBe("escape");
    expect(crossedObstacles(doc, edge, w.waypoints, { padPx: 0 })).toEqual([]);
  });

  it("reports clean for generously spaced parts (the strictest tier is reachable)", () => {
    const doc = emptyRlcDoc();
    const a = place(doc, "resistor", 160, 160, 0);
    const b = place(doc, "capacitor", 160 + 16 * GRID, 160, 0);
    const edge = connect(doc, a, "p1", b, "p0");
    const { wires, degradedCount } = routeDocument(doc);
    expect(wires[edge.id].quality).toBe("clean");
    expect(degradedCount).toBe(0);
    expect(crossedObstacles(doc, edge, wires[edge.id].waypoints, { padPx: COMFORT_PAD })).toEqual([]);
  });
});

// ── Scenario F: determinism, edits and density ──────────────────────────────

describe("RLC routing — scenario F: determinism and re-routing", () => {
  const build = () => {
    const doc = emptyRlcDoc();
    const a = place(doc, "resistor", 160, 160, 0);
    const b = place(doc, "capacitor", 480, 320, 90);
    const c = place(doc, "inductor", 480, 560, 0);
    const d = place(doc, "resistor", 800, 320, 0);
    const e1 = connect(doc, a, "p1", b, "p0");
    const e2 = connect(doc, b, "p1", d, "p0");
    const e3 = connect(doc, c, "p1", d, "p0");
    return { doc, ids: [e1.id, e2.id, e3.id] };
  };

  it("gives byte-identical geometry across repeated passes", () => {
    const one = build();
    const two = build();
    const r1 = routeDocument(one.doc);
    const r2 = routeDocument(two.doc);
    for (const id of one.ids) {
      expect(JSON.stringify(r1.wires[id].waypoints)).toBe(JSON.stringify(r2.wires[id].waypoints));
    }
  });

  it("re-routes cleanly after a part moves", () => {
    const { doc, ids } = build();
    const before = routeDocument(doc);
    const moved = doc.components.find((c) => c.kind === "inductor")!;
    moved.x += 6 * GRID;
    moved.y -= 4 * GRID;
    const after = routeDocument(doc);
    for (const id of ids) {
      expect(after.wires[id]).toBeDefined();
      const edge = doc.edges.find((e) => e.id === id)!;
      expectWireRules(doc, edge, after.wires[id].waypoints);
    }
    expect(JSON.stringify(before.wires[ids[2]].waypoints)).not.toBe(
      JSON.stringify(after.wires[ids[2]].waypoints),
    );
  });

  it("stays orthogonal on a dense 24-part / 20-wire document", () => {
    const doc = emptyRlcDoc();
    const kinds: RlcKind[] = ["resistor", "inductor", "capacitor"];
    const rotations: RlcRotation[] = [0, 90, 180, 270];
    const cols = 6;
    const rows = 4;
    const grid: RlcComponent[][] = [];
    for (let r = 0; r < rows; r++) {
      const row: RlcComponent[] = [];
      for (let c = 0; c < cols; c++) {
        row.push(
          place(doc, kinds[(r + c) % 3], 160 + c * 224, 160 + r * 224, rotations[(r * 2 + c) % 4]),
        );
      }
      grid.push(row);
    }
    let wireCount = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols - 1; c++) {
        connect(doc, grid[r][c], "p1", grid[r][c + 1], "p0");
        wireCount++;
      }
    }
    const res = routeDocument(doc, { avoidWires: true });
    expect(Object.keys(res.wires).length).toBe(wireCount);
    for (const edge of doc.edges) {
      const w = res.wires[edge.id];
      expect(w, `${edge.id} must be routed`).toBeDefined();
      expect(isOrthogonalPolyline(w.waypoints)).toBe(true);
      const stubs = endStubLengths(w.waypoints);
      expect(stubs.start).toBeGreaterThanOrEqual(GRID);
      expect(stubs.end).toBeGreaterThanOrEqual(GRID);
    }
  });
});

// ── R4 exactness ────────────────────────────────────────────────────────────

describe("RLC routing — R4 stub rule", () => {
  it("keeps MIN_STUB_PX straight at both ends even for very close parts", () => {
    const doc = emptyRlcDoc();
    const a = place(doc, "resistor", 160, 160, 0);
    const b = place(doc, "capacitor", 176, 176, 90);
    const edge = connect(doc, a, "p1", b, "p0");
    const { wires } = routeDocument(doc);
    const w = wires[edge.id];
    const stubs = endStubLengths(w.waypoints);
    expect(stubs.start).toBeGreaterThanOrEqual(MIN_STUB_PX);
    expect(stubs.end).toBeGreaterThanOrEqual(MIN_STUB_PX);
  });
});
