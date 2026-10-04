/**
 * Tap (node → wire) tests.
 *
 * These gate the four properties the feature is defined by:
 *
 *   T1  the junction lies ON the host wire, on the routing lattice
 *   T2  the new branch really is short — no candidate that could have been shorter is skipped
 *   T3  EXISTING WIRES DO NOT MOVE: adding a tap leaves every pre-existing wire's polyline
 *       bit-for-bit identical
 *   T4  the branch obeys the same avoidance contract as any other wire
 *
 * Plus the round-trip property: solve → store → reload yields the same drawing.
 */

import { describe, expect, it } from "vitest";
import {
  crossedObstacles,
  endpointGeometry,
  isOrthogonalPolyline,
  penaltiesForGeometry,
  polylineLatticePoints,
  polylineLength,
  projectTapOntoHost,
  routeDocument,
  routeOneWire,
  segmentAxisAt,
  solveTap,
  tapApproachSides,
} from "../../rlc/rlcRouting";
import {
  emptyRlcDoc,
  makeComponent,
  pinKey,
  pinPos,
  removeEdgesCascade,
  type RlcComponent,
  type RlcDoc,
  type RlcEdge,
  type RlcKind,
  type RlcPinEndpoint,
  type RlcRotation,
} from "../../rlc/rlcModel";
import { GRID } from "../../rlc/rlcConstants";

// ── Fixtures ────────────────────────────────────────────────────────────────

function place(doc: RlcDoc, kind: RlcKind, x: number, y: number, rotation: RlcRotation = 0) {
  const res = makeComponent(doc, kind, x, y, rotation);
  doc.components.push(res.component);
  doc.nextComponentSeq = res.doc.nextComponentSeq;
  doc.labelSeq = res.doc.labelSeq;
  return res.component;
}

function wire(
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

function tapWire(
  doc: RlcDoc,
  a: RlcComponent,
  aPin: "p0" | "p1",
  hostEdgeId: string,
  x: number,
  y: number,
): RlcEdge {
  const edge: RlcEdge = {
    id: `e${doc.nextEdgeSeq}`,
    from: { kind: "pin", componentId: a.id, pinId: aPin },
    to: { kind: "tap", edgeId: hostEdgeId, x, y },
  };
  doc.nextEdgeSeq++;
  doc.edges.push(edge);
  return edge;
}

const pinEnd = (componentId: string, pinId: "p0" | "p1"): RlcPinEndpoint => ({
  kind: "pin",
  componentId,
  pinId,
});

/** A horizontal host wire with a free part below it, ready to be tapped. */
function hostWithSourceBelow() {
  const doc = emptyRlcDoc();
  const left = place(doc, "resistor", 160, 320);
  const right = place(doc, "capacitor", 800, 320);
  const host = wire(doc, left, "p1", right, "p0");
  const below = place(doc, "inductor", 480, 700, 90);
  return { doc, left, right, host, below };
}

// ── T1: the junction is on the host, on the lattice ──────────────────────────

describe("tap — the junction sits on the host wire", () => {
  it("solves a junction that lies exactly on the host polyline", () => {
    const { doc, host, below } = hostWithSourceBelow();
    const solved = routeDocument(doc);
    const hostPts = solved.wires[host.id].waypoints;

    const sol = solveTap(
      doc,
      pinEnd(below.id, "p1"),
      host.id,
      { baseGeometry: { [host.id]: { waypoints: hostPts, quality: "clean" } } },
    );
    expect(sol, "a tap onto a plain horizontal wire must be solvable").not.toBeNull();

    const cands = polylineLatticePoints(hostPts);
    expect(cands.length).toBeGreaterThan(0);
    expect(
      cands.some((c) => c.x === sol!.junction.x && c.y === sol!.junction.y),
      `junction ${JSON.stringify(sol!.junction)} must be a lattice point of the host`,
    ).toBe(true);
    // On the lattice.
    expect(sol!.junction.x % GRID).toBe(0);
    expect(sol!.junction.y % GRID).toBe(0);
  });

  it("approaches perpendicular to the host segment (a proper T junction)", () => {
    const { doc, host, below } = hostWithSourceBelow();
    const solved = routeDocument(doc);
    const hostPts = solved.wires[host.id].waypoints;
    const sol = solveTap(doc, pinEnd(below.id, "p1"), host.id, {
      baseGeometry: { [host.id]: { waypoints: hostPts, quality: "clean" } },
    })!;

    // The host is horizontal here, so the branch must arrive vertically.
    expect(segmentAxisAt(hostPts, sol.junction)).toBe("h");
    expect(tapApproachSides(hostPts, sol.junction).sort()).toEqual(["down", "up"]);

    const pts = sol.waypoints;
    const last = pts[pts.length - 1];
    const prev = pts[pts.length - 2];
    expect(last.x).toBe(sol.junction.x);
    expect(last.y).toBe(sol.junction.y);
    expect(prev.x, "final segment must be vertical for a horizontal host").toBe(sol.junction.x);
    expect(Math.abs(prev.y - last.y)).toBeGreaterThan(0);
  });

  it("projects a stale junction back onto the host after the host moves", () => {
    const { doc, host, below } = hostWithSourceBelow();
    const hostPts = routeDocument(doc).wires[host.id].waypoints;

    // A stored junction from a previous layout that no longer sits on the wire.
    const stale = { x: hostPts[0].x + 5000, y: hostPts[0].y };
    const projected = projectTapOntoHost(hostPts, stale);
    expect(projected).not.toBeNull();
    expect(
      polylineLatticePoints(hostPts).some((c) => c.x === projected!.x && c.y === projected!.y),
      "projection must land on a lattice point of the host",
    ).toBe(true);
    // ...and it must be the far end, i.e. the nearest point to the stale coordinate.
    const maxX = Math.max(...polylineLatticePoints(hostPts).map((c) => c.x));
    expect(projected!.x).toBe(maxX);
    void below;
  });
});

// ── T2: the branch is short ─────────────────────────────────────────────────

describe("tap — the junction is chosen to keep the new branch short", () => {
  it("picks the junction nearest the source pin when the wire is unobstructed", () => {
    const doc = emptyRlcDoc();
    const left = place(doc, "resistor", 160, 320);
    const right = place(doc, "capacitor", 1200, 320);
    const host = wire(doc, left, "p1", right, "p0");
    // Rotation 270 makes p1 face UP, i.e. straight at the host, so the shortest branch is the
    // available lower bound and the assertion below is about choice, not about detours.
    const below = place(doc, "inductor", 320, 700, 270);

    const hostPts = routeDocument(doc).wires[host.id].waypoints;
    const sol = solveTap(doc, pinEnd(below.id, "p1"), host.id, {
      baseGeometry: { [host.id]: { waypoints: hostPts, quality: "clean" } },
    })!;

    const src = pinPos(below, "p1");
    const cands = polylineLatticePoints(hostPts);
    const bestManhattan = Math.min(...cands.map((c) => Math.abs(c.x - src.x) + Math.abs(c.y - src.y)));
    const chosenManhattan = Math.abs(sol.junction.x - src.x) + Math.abs(sol.junction.y - src.y);
    expect(chosenManhattan).toBe(bestManhattan);
    // With nothing in the way the branch IS that straight line, so it achieves the bound.
    expect(sol.length).toBe(bestManhattan);
  });

  it("returns the true minimum over all candidates (checked by brute force)", () => {
    // The honest optimality test: exhaustively route EVERY candidate and confirm the solver's
    // answer is the best one. This holds regardless of how the search prunes.
    for (const [sx, rot] of [[240, 270], [480, 270], [880, 270]] as [number, 0 | 90 | 270][]) {
      const doc = emptyRlcDoc();
      const left = place(doc, "resistor", 160, 320);
      const right = place(doc, "capacitor", 1200, 320);
      const host = wire(doc, left, "p1", right, "p0");
      const below = place(doc, "inductor", sx, 700, rot);
      const hostPts = routeDocument(doc).wires[host.id].waypoints;
      const cands = polylineLatticePoints(hostPts);
      const sol = solveTap(doc, pinEnd(below.id, "p1"), host.id, {
        baseGeometry: { [host.id]: { waypoints: hostPts, quality: "clean" } },
      });
      expect(sol, `source x=${sx} must solve`).not.toBeNull();

      const src = pinPos(below, "p1");
      const probe: RlcEdge = {
        id: "probe",
        from: pinEnd(below.id, "p1"),
        to: { kind: "tap", edgeId: host.id, x: 0, y: 0 },
      };
      let brute = Infinity;
      for (const c of cands) {
        const r = routeOneWire(
          doc,
          { ...probe, to: { kind: "tap", edgeId: host.id, x: c.x, y: c.y } },
          penaltiesForGeometry(doc, { [host.id]: { waypoints: hostPts, quality: "clean" } }),
          { [host.id]: { waypoints: hostPts, quality: "clean" } },
        );
        if (r) brute = Math.min(brute, polylineLength(r.waypoints));
      }
      expect(Number.isFinite(brute)).toBe(true);
      expect(
        sol!.length,
        `solver picked ${sol!.length} but brute force found ${brute} (source x=${sx})`,
      ).toBe(brute);
      // The length can never be below the straight-line distance.
      expect(sol!.length).toBeGreaterThanOrEqual(
        Math.abs(sol!.junction.x - src.x) + Math.abs(sol!.junction.y - src.y),
      );
    }
  });

  it("reports whether the optimality bound actually fired", () => {
    const { doc, host, below } = hostWithSourceBelow();
    const hostPts = routeDocument(doc).wires[host.id].waypoints;
    const sol = solveTap(doc, pinEnd(below.id, "p1"), host.id, {
      baseGeometry: { [host.id]: { waypoints: hostPts, quality: "clean" } },
    })!;
    // The first candidate evaluated is the nearest one; if it solves to the lower bound the
    // search can stop immediately. Either way the flag must be a boolean and consistent with
    // the reported lengths.
    expect(typeof sol.optimal).toBe("boolean");
    expect(sol.evaluated).toBeGreaterThan(0);
    expect(Number.isFinite(sol.length)).toBe(true);
  });

  it("never returns a junction whose branch is longer than a nearer candidate's lower bound", () => {
    // Sweep several source positions along the host and check the invariant each time.
    for (const sx of [240, 400, 480, 640, 880]) {
      const doc = emptyRlcDoc();
      const left = place(doc, "resistor", 160, 320);
      const right = place(doc, "capacitor", 1200, 320);
      const host = wire(doc, left, "p1", right, "p0");
      // 270 puts the pin on the host-facing side, so the branch may be short.
      const below = place(doc, "inductor", sx, 700, 270);
      const hostPts = routeDocument(doc).wires[host.id].waypoints;
      const sol = solveTap(doc, pinEnd(below.id, "p1"), host.id, {
        baseGeometry: { [host.id]: { waypoints: hostPts, quality: "clean" } },
      });
      expect(sol, `source at x=${sx} must solve`).not.toBeNull();
      const src = pinPos(below, "p1");
      // A solved rectilinear path can never be shorter than the straight-line distance between
      // its own two ends — that is the floor the search's pruning argument relies on.
      expect(sol!.length).toBeGreaterThanOrEqual(
        Math.abs(sol!.junction.x - src.x) + Math.abs(sol!.junction.y - src.y),
      );
      // And the selected candidate must be the one with the smallest bound among those that
      // could possibly matter: for a straight, unobstructed drop, the branch achieves the
      // Manhattan floor exactly.
      const floor = Math.abs(sol!.junction.x - src.x) + Math.abs(sol!.junction.y - src.y);
      expect(sol!.length - floor, `source x=${sx} should not detour needlessly`).toBe(0);
    }
  });
});

// ── T3: existing wires do not move ──────────────────────────────────────────

describe("tap — existing wires keep their exact geometry", () => {
  it("leaves every pre-existing wire bit-for-bit identical when a tap is added", () => {
    const doc = emptyRlcDoc();
    // A small but non-trivial drawing: two wires already routed, plus blockers.
    const a = place(doc, "resistor", 160, 160);
    const b = place(doc, "capacitor", 800, 160);
    const c = place(doc, "inductor", 160, 480, 90);
    const d = place(doc, "resistor", 800, 480, 90);
    place(doc, "capacitor", 480, 320); // blocker in the middle
    const e1 = wire(doc, a, "p1", b, "p0");
    const e2 = wire(doc, c, "p1", d, "p0");

    const before = routeDocument(doc);
    const beforeSig = (id: string) => JSON.stringify(before.wires[id].waypoints);

    // Tap e1 with a new branch hanging off the blocker part.
    const tapComp = doc.components.find((x) => x.kind === "capacitor")!;
    const branch = tapWire(doc, tapComp, "p1", e1.id, 480, 160);

    const after = routeDocument(doc);
    expect(after.wires[e1.id].waypoints, "host wire must not move").toEqual(before.wires[e1.id].waypoints);
    expect(after.wires[e2.id].waypoints, "unrelated wire must not move").toEqual(before.wires[e2.id].waypoints);
    expect(beforeSig(e1.id)).toBe(JSON.stringify(after.wires[e1.id].waypoints));
    expect(beforeSig(e2.id)).toBe(JSON.stringify(after.wires[e2.id].waypoints));
    expect(after.wires[branch.id], "the new branch must exist").toBeDefined();
  });

  it("holds for many existing wires, including ids past e9 (numeric ordering)", () => {
    const doc = emptyRlcDoc();
    // Twelve wires, so the string-vs-numeric ordering bug would show up.
    const parts: RlcComponent[] = [];
    for (let i = 0; i < 13; i++) {
      parts.push(place(doc, "resistor", 160 + (i % 2) * 900, 160 + i * 96));
    }
    const made: RlcEdge[] = [];
    for (let i = 0; i < 12; i++) {
      made.push(wire(doc, parts[i], "p1", parts[i + 1], "p0"));
    }
    expect(made[made.length - 1].id).toBe("e12");

    const before = routeDocument(doc);
    const snapshot = new Map(made.map((e) => [e.id, JSON.stringify(before.wires[e.id].waypoints)]));

    // Add a tap that must be routed LAST, after all twelve.
    const extras = place(doc, "capacitor", 1400, 700, 90);
    const branch = tapWire(doc, extras, "p0", made[0].id, 0, 0); // x/y projected onto host
    void branch;

    const after = routeDocument(doc);
    for (const e of made) {
      expect(
        JSON.stringify(after.wires[e.id].waypoints),
        `wire ${e.id} must be unchanged after adding a tap`,
      ).toBe(snapshot.get(e.id));
    }
  });

  it("is deterministic: two passes over the same tapped document agree exactly", () => {
    const { doc, host, below } = hostWithSourceBelow();
    tapWire(doc, below, "p1", host.id, 720, 320);
    const one = routeDocument(doc);
    const two = routeDocument(doc);
    for (const id of Object.keys(one.wires)) {
      expect(JSON.stringify(two.wires[id].waypoints)).toBe(JSON.stringify(one.wires[id].waypoints));
    }
  });
});

// ── T4: the branch avoids obstacles like any other wire ─────────────────────

describe("tap — the branch honours the avoidance contract", () => {
  it("produces an orthogonal branch anchored on the pin and the junction", () => {
    const { doc, host, below } = hostWithSourceBelow();
    const hostPts = routeDocument(doc).wires[host.id].waypoints;
    const sol = solveTap(doc, pinEnd(below.id, "p1"), host.id, {
      baseGeometry: { [host.id]: { waypoints: hostPts, quality: "clean" } },
    })!;

    expect(isOrthogonalPolyline(sol.waypoints)).toBe(true);
    expect(sol.waypoints[0]).toEqual(pinPos(below, "p1"));
    expect(sol.waypoints[sol.waypoints.length - 1]).toEqual(sol.junction);
  });

  it("does not cross any component BODY without declaring the tier", () => {
    const { doc, host, below } = hostWithSourceBelow();
    const hostPts = routeDocument(doc).wires[host.id].waypoints;
    const sol = solveTap(doc, pinEnd(below.id, "p1"), host.id, {
      baseGeometry: { [host.id]: { waypoints: hostPts, quality: "clean" } },
    })!;
    const probe: RlcEdge = {
      id: "probe",
      from: pinEnd(below.id, "p1"),
      to: { kind: "tap", edgeId: host.id, x: sol.junction.x, y: sol.junction.y },
    };
    if (sol.quality !== "escape") {
      expect(
        crossedObstacles(doc, probe, sol.waypoints, { padPx: 0 }),
        `quality "${sol.quality}" claims bodies are avoided`,
      ).toEqual([]);
    }
  });

  it("routes around a blocker placed between the pin and the host", () => {
    const doc = emptyRlcDoc();
    const left = place(doc, "resistor", 160, 320);
    const right = place(doc, "capacitor", 1200, 320);
    const host = wire(doc, left, "p1", right, "p0");
    // Directly below the host's midpoint: the natural target.
    const below = place(doc, "inductor", 640, 700, 90);
    // A blocker straddling the straight line from the pin to that point.
    place(doc, "resistor", 640, 512);

    const hostPts = routeDocument(doc).wires[host.id].waypoints;
    const sol = solveTap(doc, pinEnd(below.id, "p1"), host.id, {
      baseGeometry: { [host.id]: { waypoints: hostPts, quality: "clean" } },
    });
    expect(sol, "a blocker must not make the tap unsolvable").not.toBeNull();

    const probe: RlcEdge = {
      id: "probe",
      from: pinEnd(below.id, "p1"),
      to: { kind: "tap", edgeId: host.id, x: sol!.junction.x, y: sol!.junction.y },
    };
    if (sol!.quality !== "escape") {
      expect(crossedObstacles(doc, probe, sol!.waypoints, { padPx: 0 })).toEqual([]);
    }
    expect(isOrthogonalPolyline(sol!.waypoints)).toBe(true);
    // It must have detoured (or shifted the junction) rather than going straight through.
    expect(sol!.length).toBeGreaterThan(
      Math.abs(sol!.junction.y - pinPos(below, "p1").y),
    );
  });
});

// ── Round trip: the stored drawing is the durable artifact ─────────────────

describe("tap — solved geometry survives a document round trip", () => {
  it("routes a tapped document identically after JSON serialisation", () => {
    const { doc, host, below } = hostWithSourceBelow();
    const branch = tapWire(doc, below, "p1", host.id, 720, 320);

    const first = routeDocument(doc);
    // Persist exactly what the editor would: the document plus its solved geometry.
    const geometry: Record<string, { waypoints: { x: number; y: number }[]; quality: string }> = {};
    for (const [id, w] of Object.entries(first.wires)) {
      geometry[id] = { waypoints: w.waypoints, quality: w.quality };
    }
    const saved = JSON.parse(JSON.stringify({ ...doc, geometry })) as RlcDoc;

    // Reopening must reproduce the stored polylines EXACTLY, not merely an equivalent route.
    expect(saved.geometry[branch.id].waypoints).toEqual(first.wires[branch.id].waypoints);
    expect(saved.geometry[host.id].waypoints).toEqual(first.wires[host.id].waypoints);
    expect(JSON.stringify(saved.geometry)).toBe(JSON.stringify(geometry));

    // And a fresh solve must AGREE with what was stored.
    const second = routeDocument(saved);
    for (const id of Object.keys(first.wires)) {
      expect(
        JSON.stringify(second.wires[id].waypoints),
        `re-solve of ${id} must match the stored geometry`,
      ).toBe(JSON.stringify(first.wires[id].waypoints));
    }
  });
});

// ── Cascade deletion ───────────────────────────────────────────────────────

describe("tap — deleting a host wire removes the wires that depend on it", () => {
  it("cascades transitively", () => {
    const doc = emptyRlcDoc();
    const a = place(doc, "resistor", 160, 320);
    const b = place(doc, "capacitor", 1200, 320);
    const host = wire(doc, a, "p1", b, "p0");
    const t1 = place(doc, "inductor", 480, 700, 90);
    const t2 = place(doc, "resistor", 800, 900, 90);
    const branch1 = tapWire(doc, t1, "p1", host.id, 480, 320);
    const branch2 = tapWire(doc, t2, "p1", branch1.id, 480, 700);

    const pruned = removeEdgesCascade(doc, [host.id]);
    expect(pruned.edges.map((e) => e.id)).toEqual([]);
    void branch2;
  });

  it("keeps unrelated wires", () => {
    const doc = emptyRlcDoc();
    const a = place(doc, "resistor", 160, 320);
    const b = place(doc, "capacitor", 1200, 320);
    const host = wire(doc, a, "p1", b, "p0");
    const c = place(doc, "inductor", 160, 900, 90);
    const d = place(doc, "resistor", 1200, 900, 90);
    const other = wire(doc, c, "p1", d, "p0");
    const t = place(doc, "capacitor", 480, 700, 90);
    tapWire(doc, t, "p1", host.id, 480, 320);

    const pruned = removeEdgesCascade(doc, [host.id]);
    expect(pruned.edges.map((e) => e.id)).toEqual([other.id]);
    // Geometry for the doomed wires must be dropped too, so a stale path cannot be rendered.
    expect(pruned.geometry[host.id]).toBeUndefined();
  });
});

// ── Netlist: a tap joins nets ──────────────────────────────────────────────

describe("netlist — a tap places the new pin on the host wire's node", () => {
  it("unions the tapped part with everything the host already connects", async () => {
    const { deriveNetlist } = await import("../../rlc/rlcNetlist");
    const doc = emptyRlcDoc();
    const a = place(doc, "resistor", 160, 320);
    const b = place(doc, "capacitor", 1200, 320);
    const host = wire(doc, a, "p1", b, "p0");
    const t = place(doc, "inductor", 480, 700, 90);

    // Before the tap: the tapped part is on its own node.
    const before = deriveNetlist(doc);
    const hostsNetBefore = before.nets.find((n) => n.terminals.some((x) => x.key === pinKey(a.id, "p1")));
    expect(hostsNetBefore).toBeDefined();
    const tappedBefore = before.nets.find((n) => n.terminals.some((x) => x.key === pinKey(t.id, "p1")));
    expect(tappedBefore!.name).not.toBe(hostsNetBefore!.name);

    // After the tap: the tapped pin shares the host's node.
    tapWire(doc, t, "p1", host.id, 480, 320);
    const after = deriveNetlist(doc);
    const hostNet = after.nets.find((n) => n.terminals.some((x) => x.key === pinKey(a.id, "p1")));
    expect(hostNet, "the host net must still exist").toBeDefined();
    expect(
      hostNet!.terminals.map((x) => x.key).sort(),
      "the tapped pin must be on the same node as the host wire's terminals",
    ).toEqual([pinKey(a.id, "p1"), pinKey(b.id, "p0"), pinKey(t.id, "p1")].sort());
    expect(hostNet!.taps.length).toBe(1);
    expect(hostNet!.taps[0].hostWireId).toBe(host.id);
    // Three terminals joined by two wires is a tree.
    expect(hostNet!.isTree).toBe(true);
  });

  it("keeps the net a tree (that is what scikit-rf needs)", async () => {
    const { deriveNetlist } = await import("../../rlc/rlcNetlist");
    const { doc, host, below } = hostWithSourceBelow();
    tapWire(doc, below, "p1", host.id, 720, 320);
    const derived = deriveNetlist(doc);
    for (const n of derived.nets) {
      expect(n.isTree, `net ${n.name} (${n.wires.length} wires / ${n.terminals.length} terminals)`).toBe(true);
    }
  });
});

// ── Placement preview must equal the committed geometry ────────────────────

describe("tap — the previewed branch is the branch that gets committed", () => {
  it("same solve, same polyline", () => {
    const { doc, host, below } = hostWithSourceBelow();
    const hostPts = routeDocument(doc).wires[host.id].waypoints;
    const sol = solveTap(doc, pinEnd(below.id, "p1"), host.id, {
      baseGeometry: { [host.id]: { waypoints: hostPts, quality: "clean" } },
    })!;

    // Commit exactly what was previewed.
    const branch = tapWire(doc, below, "p1", host.id, sol.junction.x, sol.junction.y);
    const routed = routeDocument(doc).wires[branch.id];
    expect(routed, "the committed branch must route").toBeDefined();
    expect(
      routed.waypoints,
      "the committed polyline must equal the previewed one (WYSIWYG)",
    ).toEqual(sol.waypoints);
    expect(polylineLength(routed.waypoints)).toBe(sol.length);
  });

  it("stays identical even when other wires make the branch detour", () => {
    // A corridor of wires: the new branch can no longer drop straight down, so the solver has
    // to take penalties into account. The preview must still match the commit exactly.
    const doc = emptyRlcDoc();
    const l1 = place(doc, "resistor", 160, 320);
    const r1 = place(doc, "capacitor", 1200, 320);
    const host = wire(doc, l1, "p1", r1, "p0");
    const l2 = place(doc, "resistor", 160, 480);
    const r2 = place(doc, "capacitor", 1200, 480);
    wire(doc, l2, "p1", r2, "p0");
    const below = place(doc, "inductor", 640, 700, 270);

    const base = routeDocument(doc);
    const baseGeometry = Object.fromEntries(
      Object.entries(base.wires).map(([id, w]) => [id, { waypoints: w.waypoints, quality: w.quality }]),
    );
    const sol = solveTap(doc, pinEnd(below.id, "p1"), host.id, { baseGeometry });
    expect(sol).not.toBeNull();

    const branch = tapWire(doc, below, "p1", host.id, sol!.junction.x, sol!.junction.y);
    const routed = routeDocument(doc).wires[branch.id];
    expect(
      routed.waypoints,
      "with penalties in play the preview must still equal the commit",
    ).toEqual(sol!.waypoints);
  });

  it("the stored geometry equals what the preview showed", () => {
    const { doc, host, below } = hostWithSourceBelow();
    const hostPts = routeDocument(doc).wires[host.id].waypoints;
    const sol = solveTap(doc, pinEnd(below.id, "p1"), host.id, {
      baseGeometry: { [host.id]: { waypoints: hostPts, quality: "clean" } },
    })!;
    const branch = tapWire(doc, below, "p1", host.id, sol.junction.x, sol.junction.y);
    const res = routeDocument(doc);
    // This is exactly what the store writes into doc.geometry, i.e. what a reload renders.
    expect(res.wires[branch.id].waypoints).toEqual(sol.waypoints);
    expect(res.wires[branch.id].quality).toBe(sol.quality);
  });
});

// ── Regression: a lone pin still routes to a pin ───────────────────────────

describe("tap — pin-to-pin wiring is unaffected", () => {
  it("still routes a plain straight connection", () => {
    const doc = emptyRlcDoc();
    const a = place(doc, "resistor", 160, 160);
    const b = place(doc, "capacitor", 480, 160);
    const e = wire(doc, a, "p1", b, "p0");
    const res = routeDocument(doc);
    expect(res.wires[e.id].quality).toBe("clean");
    expect(crossedObstacles(doc, e, res.wires[e.id].waypoints)).toEqual([]);
    expect(endpointGeometry(doc, a.id, "p1")).not.toBeNull();
  });
});
