import { describe, it, expect } from "vitest";
import { findStaleWaypointEdges, healStaleWaypoints, translateWaypointsForMovedGroup } from "../waypointHealing";
import { makeDevice, makeEdge, makePort } from "../routingHarness/fixtures";
import type { ConnectionEdge } from "../types";

// Two devices ~700px apart, an edge between them.
function scene() {
  const o = makePort("Out", "sdi", "output");
  const i = makePort("In", "sdi", "input");
  const src = makeDevice({ id: "src", x: 0, y: 100, ports: [o] });
  const tgt = makeDevice({ id: "tgt", x: 700, y: 100, ports: [i] });
  // A third device sitting between them, off to the side.
  const blocker = makeDevice({ id: "blk", x: 300, y: 600, ports: [makePort("p", "sdi", "input")] });
  return { src, tgt, blocker, o, i };
}

function edgeWith(wps: { x: number; y: number }[]): ConnectionEdge {
  return makeEdge({ id: "e", source: "src", sourceHandle: "x", target: "tgt", targetHandle: "y", signalType: "sdi", data: { manualWaypoints: wps } });
}

describe("findStaleWaypointEdges", () => {
  it("flags a waypoint stranded far outside the endpoints' bounding box", () => {
    const { src, tgt, blocker } = scene();
    const edge = edgeWith([{ x: 350, y: 4000 }]); // way below everything
    const stale = findStaleWaypointEdges([src, tgt, blocker], [edge]);
    expect(stale.has("e")).toBe(true);
  });

  it("flags a waypoint sitting inside a non-endpoint device body", () => {
    const { src, tgt, blocker } = scene();
    // blocker is at (300,600) size ~180xN — put a waypoint inside it.
    const edge = edgeWith([{ x: 360, y: 620 }]);
    const stale = findStaleWaypointEdges([src, tgt, blocker], [edge]);
    expect(stale.has("e")).toBe(true);
  });

  it("preserves a plausible waypoint within the endpoints' bounding box", () => {
    const { src, tgt, blocker } = scene();
    const edge = edgeWith([{ x: 350, y: 140 }]); // between the two devices, on-level
    const stale = findStaleWaypointEdges([src, tgt, blocker], [edge]);
    expect(stale.has("e")).toBe(false);
  });

  it("ignores edges with no manual waypoints", () => {
    const { src, tgt, blocker } = scene();
    const edge = makeEdge({ id: "e", source: "src", sourceHandle: "x", target: "tgt", targetHandle: "y", signalType: "sdi" });
    expect(findStaleWaypointEdges([src, tgt, blocker], [edge]).size).toBe(0);
  });
});

describe("healStaleWaypoints", () => {
  it("clears stale waypoints and reports healed ids; returns same ref when nothing stale", () => {
    const { src, tgt, blocker } = scene();
    const staleEdge = edgeWith([{ x: 350, y: 4000 }]);
    const r1 = healStaleWaypoints([src, tgt, blocker], [staleEdge]);
    expect(r1.healed).toEqual(["e"]);
    expect(r1.edges[0].data?.manualWaypoints).toBeUndefined();
    expect(r1.edges[0].data?.signalType).toBe("sdi"); // other data preserved

    const okInput = [edgeWith([{ x: 350, y: 140 }])];
    const r2 = healStaleWaypoints([src, tgt, blocker], okInput);
    expect(r2.healed).toHaveLength(0);
    expect(r2.edges).toBe(okInput); // unchanged → same reference
  });
});

describe("translateWaypointsForMovedGroup", () => {
  it("rigidly shifts waypoints when both endpoints are in the moved set", () => {
    const edge = edgeWith([{ x: 350, y: 140 }, { x: 350, y: 200 }]);
    const moved = new Set(["src", "tgt"]);
    const out = translateWaypointsForMovedGroup([edge], moved, 100, -50);
    expect(out[0].data?.manualWaypoints).toEqual([{ x: 450, y: 90 }, { x: 450, y: 150 }]);
  });

  it("leaves waypoints alone when only one endpoint moved", () => {
    const input = [edgeWith([{ x: 350, y: 140 }])];
    const out = translateWaypointsForMovedGroup(input, new Set(["src"]), 100, 0);
    expect(out).toBe(input); // unchanged → same reference
    expect(out[0].data?.manualWaypoints).toEqual([{ x: 350, y: 140 }]);
  });

  it("no-ops on zero delta", () => {
    const input = [edgeWith([{ x: 350, y: 140 }])];
    expect(translateWaypointsForMovedGroup(input, new Set(["src", "tgt"]), 0, 0)).toBe(input);
  });
});
