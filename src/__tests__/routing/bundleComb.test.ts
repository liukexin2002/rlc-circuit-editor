import { describe, it, expect } from "vitest";
import { makeDevice, makeEdge, makePort, makeFixture } from "../../routingHarness/fixtures";
import { routeFixture } from "../../routingHarness/route";
import { extractSegments, segmentsCross } from "../../edgeRouter";
import type { SchematicNode } from "../../types";

/**
 * Bundle members must GATHER as a comb: horizontal at each port row, one shared vertical at the
 * break-in column (mirrored at break-out). When each gather leg picked its own turn column via
 * A* tie-breaks, members could weave each other near the junction (Esther Musical A001 bundle —
 * the source-end weave complaint). The comb makes member-member crossings impossible.
 */
describe("bundle comb gather/fan", () => {
  // 8 ports stacked on one source device → 8 ports on one target device, all bundled.
  // Port rows span ~160px so the junction (median) sits BETWEEN rows — both above- and
  // below-trunk gather legs exist, the weave-prone arrangement.
  function fixture() {
    const outs = Array.from({ length: 8 }, (_, i) => makePort(`Out ${i + 1}`, "analog-audio", "output"));
    const ins = Array.from({ length: 8 }, (_, i) => makePort(`In ${i + 1}`, "analog-audio", "input"));
    const src = makeDevice({ id: "src", label: "Console", x: 0, y: 80, ports: outs });
    const tgt = makeDevice({ id: "tgt", label: "Stage Box", x: 720, y: 80, ports: ins });
    const nodes: SchematicNode[] = [src, tgt];
    const edges = outs.map((p, i) =>
      makeEdge({
        id: `m${i}`, source: "src", sourceHandle: p.id, target: "tgt", targetHandle: ins[i].id,
        signalType: "analog-audio", data: { bundleId: "b1" },
      }),
    );
    return makeFixture("bundle-comb", nodes, edges, { b1: { id: "b1" } });
  }

  it("members never cross each other", () => {
    const fx = fixture();
    const { routes } = routeFixture(fx.nodes, fx.edges, { bundles: fx.bundles });
    const geoms = fx.edges.map((e) => {
      expect(routes[e.id]?.waypoints?.length, `${e.id} unrouted`).toBeGreaterThanOrEqual(2);
      return { id: e.id, segs: extractSegments(routes[e.id].waypoints) };
    });
    for (let i = 0; i < geoms.length; i++) {
      for (let j = i + 1; j < geoms.length; j++) {
        for (const sa of geoms[i].segs) {
          for (const sb of geoms[j].segs) {
            expect(segmentsCross(sa, sb), `${geoms[i].id} crosses ${geoms[j].id}`).toBe(false);
          }
        }
      }
    }
  });

  it("honors a member's manual waypoint on its fan leg (trunk stays shared)", () => {
    const fx = fixture();
    const jin = fx.nodes.find((n) => n.id === "bj-b1-in")!;
    const jout = fx.nodes.find((n) => n.id === "bj-b1-out")!;
    // Detour m0's fan leg through a point well below the trunk, between break-out and target.
    const detour = { x: jout.position.x + 100, y: jout.position.y + 200 };
    const m0 = fx.edges.find((e) => e.id === "m0")!;
    m0.data = { ...m0.data!, manualWaypoints: [detour] };
    const { routes } = routeFixture(fx.nodes, fx.edges, { bundles: fx.bundles });
    const wps = routes.m0.waypoints;
    // The route passes through (or orthogonally adjacent to) the detour point...
    const near = wps.some((p) => Math.abs(p.x - detour.x) < 30 || Math.abs(p.y - detour.y) < 30)
      && wps.some((p) => p.y >= detour.y - 30);
    expect(near, `m0 ignores its waypoint: ${wps.map((p) => `${p.x},${p.y}`).join(" ")}`).toBe(true);
    // ...and still travels the shared trunk (both junction points on the path).
    const onPath = (pt: { x: number; y: number }) =>
      wps.some((p) => Math.abs(p.x - pt.x) < 2 && Math.abs(p.y - pt.y) < 2);
    expect(onPath(jin.position), "m0 left the trunk: missing break-in").toBe(true);
    expect(onPath(jout.position), "m0 left the trunk: missing break-out").toBe(true);
    // Other members keep the plain comb.
    const m1segs = routes.m1.waypoints;
    expect(m1segs.every((p) => p.y < detour.y - 50)).toBe(true);
  });

  it("gather verticals share the break-in column; fan verticals the break-out column", () => {
    const fx = fixture();
    const jin = fx.nodes.find((n) => n.id === "bj-b1-in")!;
    const jout = fx.nodes.find((n) => n.id === "bj-b1-out")!;
    const { routes } = routeFixture(fx.nodes, fx.edges, { bundles: fx.bundles });
    for (const e of fx.edges) {
      const segs = extractSegments(routes[e.id].waypoints);
      const verticals = segs.filter((s) => s.axis === "v");
      // Every vertical a member needs sits on a junction column (members whose port row equals
      // the trunk row route straight and have none).
      for (const v of verticals) {
        expect([jin.position.x, jout.position.x], `${e.id} vertical at x=${v.x1}`).toContain(v.x1);
      }
    }
  });
});
