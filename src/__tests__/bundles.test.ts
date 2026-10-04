import { describe, it, expect } from "vitest";
import {
  gcBundles,
  bundleMembers,
  newBundleId,
  reconcileBundleJunctions,
  estimateBundleJunctionPositions,
  junctionNodeId,
  bundleJunctionsFor,
  splitMemberWaypoints,
  BUNDLE_JUNCTION_TYPE,
} from "../bundles";
import type { ConnectionEdge, SchematicNode } from "../types";

const edge = (id: string, bundleId?: string) =>
  ({ id, source: "a", target: "b", data: { signalType: "sdi", ...(bundleId ? { bundleId } : {}) } }) as unknown as ConnectionEdge;

// Member edge wired between two specific device nodes (for geometry-based heal tests).
const memberEdge = (id: string, source: string, target: string, bundleId: string) =>
  ({ id, source, target, data: { signalType: "sdi", bundleId } }) as unknown as ConnectionEdge;

// Device node with explicit measured size at a position.
const device = (id: string, x: number, y: number, w = 180, h = 60) =>
  ({ id, type: "device", position: { x, y }, measured: { width: w, height: h }, data: {} }) as unknown as SchematicNode;

describe("gcBundles", () => {
  it("keeps bundles with >=2 members, dissolves the rest", () => {
    const edges = [edge("e1", "b1"), edge("e2", "b1"), edge("e3", "b2")];
    const { edges: out, bundles } = gcBundles(edges, { b1: { id: "b1" }, b2: { id: "b2" } });
    expect(Object.keys(bundles)).toEqual(["b1"]);
    expect(bundleMembers(out, "b1").length).toBe(2);
    expect(out.find((e) => e.id === "e3")!.data?.bundleId).toBeUndefined();
  });
  it("drops bundleId referencing a bundle with no meta", () => {
    const edges = [edge("e1", "ghost"), edge("e2", "ghost")];
    const { edges: out, bundles } = gcBundles(edges, {});
    expect(bundles).toEqual({});
    expect(out.every((e) => e.data?.bundleId === undefined)).toBe(true);
  });
  it("newBundleId is unique", () => expect(newBundleId()).not.toBe(newBundleId()));
});

describe("estimateBundleJunctionPositions", () => {
  it("places in right of the source cluster and out left of the target cluster, at median Y", () => {
    // Two sources on the left (right edges 180 and 200), two targets on the right (left edges 500, 540).
    const nodes = [
      device("s1", 0, 0),      // right = 180, centerY = 30
      device("s2", 20, 100),   // right = 200, centerY = 130
      device("t1", 500, 0),    // left = 500, centerY = 30
      device("t2", 540, 100),  // left = 540, centerY = 130
    ];
    const members = [memberEdge("e1", "s1", "t1", "b1"), memberEdge("e2", "s2", "t2", "b1")];
    const pos = estimateBundleJunctionPositions(members, nodes)!;
    expect(pos.in.x).toBe(240);  // snapGrid(max source right 200 + 32 gap)
    expect(pos.out.x).toBe(464); // snapGrid(min target left 500 - 32 gap)
    // Ys = [30,30,130,130] → median of 4 = round((30+130)/2) = 80 (a 16-multiple)
    expect(pos.in.y).toBe(80);
    expect(pos.out.y).toBe(80);
  });

  it("returns null when fewer than 2 members resolve to both endpoints", () => {
    const nodes = [device("s1", 0, 0), device("t1", 500, 0)];
    const members = [
      memberEdge("e1", "s1", "t1", "b1"),
      memberEdge("e2", "missing", "t1", "b1"), // source node absent
    ];
    expect(estimateBundleJunctionPositions(members, nodes)).toBeNull();
  });

  it("uses resolved endpoint Ys over device centerY (tall-device bundle sits on its cables)", () => {
    // Esther regression: a 1400px-tall console whose bundle leaves 8 ports near the TOP.
    // Device centerY (700) would park the junction hundreds of px below every cable.
    const nodes = [
      device("console", 0, 0, 180, 1400), // centerY = 700
      device("t1", 500, 80, 180, 240),    // centerY = 200
    ];
    const members = [
      memberEdge("e1", "console", "t1", "b1"),
      memberEdge("e2", "console", "t1", "b1"),
    ];
    const portY: Record<string, { source: number; target: number }> = {
      e1: { source: 100, target: 120 },
      e2: { source: 140, target: 160 },
    };
    const pos = estimateBundleJunctionPositions(
      members, nodes, (e, end) => portY[e.id]?.[end] ?? null,
    )!;
    // Median of [100,120,140,160] = 130 → grid-snapped: within the cable band, not at y≈700.
    expect(pos.in.y).toBeGreaterThanOrEqual(100);
    expect(pos.in.y).toBeLessThanOrEqual(160);
    expect(pos.out.y).toBe(pos.in.y);
  });

  it("falls back to device centerY for members the resolver can't resolve", () => {
    const nodes = [device("s1", 0, 0), device("t1", 500, 0)]; // centerY = 30 both
    const members = [
      memberEdge("e1", "s1", "t1", "b1"),
      memberEdge("e2", "s1", "t1", "b1"),
    ];
    const pos = estimateBundleJunctionPositions(members, nodes, () => null)!;
    expect(pos.in.y).toBe(32); // snapGrid(30) — same as the no-resolver estimate
  });
});

describe("splitMemberWaypoints", () => {
  const entry = { x: 200, y: 100 };
  const exit = { x: 800, y: 100 };

  it("returns empty runs for no waypoints", () => {
    expect(splitMemberWaypoints(undefined, entry, exit)).toEqual({ gather: [], fan: [] });
    expect(splitMemberWaypoints([], entry, exit)).toEqual({ gather: [], fan: [] });
  });

  it("assigns waypoints to gather/fan by junction proximity, preserving order", () => {
    const wps = [
      { x: 150, y: 40 },  // near entry → gather
      { x: 180, y: 160 }, // near entry → gather
      { x: 760, y: 30 },  // near exit → fan
      { x: 850, y: 180 }, // near exit → fan
    ];
    const { gather, fan } = splitMemberWaypoints(wps, entry, exit);
    expect(gather).toEqual(wps.slice(0, 2));
    expect(fan).toEqual(wps.slice(2));
  });

  it("keeps everything after the first fan-side waypoint in the fan run (order wins over distance)", () => {
    // The 3rd point is geometrically nearer the entry, but it follows a fan-side point —
    // re-sorting would scramble a deliberate detour.
    const wps = [
      { x: 700, y: 100 }, // fan side
      { x: 300, y: 100 }, // entry side, but AFTER a fan point
    ];
    const { gather, fan } = splitMemberWaypoints(wps, entry, exit);
    expect(gather).toEqual([]);
    expect(fan).toEqual(wps);
  });
});

describe("reconcileBundleJunctions", () => {
  const liveBundleNodes = () => [
    device("s1", 0, 0),
    device("s2", 0, 100),
    device("t1", 500, 0),
    device("t2", 500, 100),
  ];
  const liveBundleEdges = () => [
    memberEdge("e1", "s1", "t1", "b1"),
    memberEdge("e2", "s2", "t2", "b1"),
  ];

  it("spawns break-in and break-out anchors for a live (>=2 member) bundle", () => {
    const out = reconcileBundleJunctions(liveBundleNodes(), liveBundleEdges());
    const junctions = out.filter((n) => n.type === BUNDLE_JUNCTION_TYPE);
    expect(junctions).toHaveLength(2);
    const { in: jin, out: jout } = bundleJunctionsFor(out, "b1");
    expect(jin?.id).toBe(junctionNodeId("b1", "in"));
    expect(jout?.id).toBe(junctionNodeId("b1", "out"));
    expect(jin?.data.role).toBe("in");
    expect(jout?.data.role).toBe("out");
    expect(jin?.data.placed).toBe(false);
  });

  it("is idempotent — re-running returns the same reference", () => {
    const once = reconcileBundleJunctions(liveBundleNodes(), liveBundleEdges());
    const twice = reconcileBundleJunctions(once, liveBundleEdges());
    expect(twice).toBe(once);
  });

  it("leaves an existing (user-dragged) junction position untouched", () => {
    const nodes = liveBundleNodes();
    const dragged = {
      id: junctionNodeId("b1", "in"),
      type: BUNDLE_JUNCTION_TYPE,
      position: { x: 999, y: 999 },
      data: { bundleId: "b1", role: "in", placed: true },
    } as unknown as SchematicNode;
    const out = reconcileBundleJunctions([...nodes, dragged], liveBundleEdges());
    const { in: jin } = bundleJunctionsFor(out, "b1");
    expect(jin?.position).toEqual({ x: 999, y: 999 }); // not repositioned
    expect(jin?.data.placed).toBe(true);
    // The missing "out" anchor is still spawned alongside.
    expect(out.filter((n) => n.type === BUNDLE_JUNCTION_TYPE)).toHaveLength(2);
  });

  it("removes orphan anchors when a bundle drops below 2 members", () => {
    const withJunctions = reconcileBundleJunctions(liveBundleNodes(), liveBundleEdges());
    // Drop a member so b1 has only 1 left → no longer live.
    const out = reconcileBundleJunctions(withJunctions, [memberEdge("e1", "s1", "t1", "b1")]);
    expect(out.filter((n) => n.type === BUNDLE_JUNCTION_TYPE)).toHaveLength(0);
  });

  it("returns the same reference when there is nothing to heal", () => {
    const nodes = liveBundleNodes();
    expect(reconcileBundleJunctions(nodes, [])).toBe(nodes);
  });

  it("skips spawning (no crash) when member geometry can't be resolved", () => {
    const edges = [
      memberEdge("e1", "ghostA", "ghostB", "b1"),
      memberEdge("e2", "ghostC", "ghostD", "b1"),
    ];
    const nodes = [device("unrelated", 0, 0)];
    const out = reconcileBundleJunctions(nodes, edges);
    expect(out).toBe(nodes); // live bundle, but unresolvable → no junctions spawned
  });
});
