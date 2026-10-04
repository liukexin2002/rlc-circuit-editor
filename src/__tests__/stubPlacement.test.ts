import { describe, it, expect } from "vitest";
import {
  healStubPortAlignment,
  midCustomLabelPlacement,
  nearestStubHandleSide,
  reconcileStubPairs,
  snapStubHandleY,
  STUB_H_EST,
} from "../stubPlacement";
import type { SchematicNode, ConnectionEdge } from "../types";
import type { HandleSnapshot } from "../routing/handleSnapshot";

const device = (id: string, x: number, y: number): SchematicNode =>
  ({ id, type: "device", position: { x, y }, data: {} } as unknown as SchematicNode);
const stub = (id: string, x: number, y: number): SchematicNode =>
  ({ id, type: "stub-label", position: { x, y }, data: {}, measured: { width: 80, height: STUB_H_EST } } as unknown as SchematicNode);
const leg = (id: string, source: string, sourceHandle: string, target: string, targetHandle: string): ConnectionEdge =>
  ({ id, source, sourceHandle, target, targetHandle, data: { signalType: "sdi" } } as unknown as ConnectionEdge);

/** Snapshot with one device (port handle at deviceY+portRelY) and one stub. */
function snapshot(devY: number, portRelY: number, portHandleId: string, stubY: number): HandleSnapshot {
  return {
    dev: {
      type: "device",
      positionAbsolute: { x: 400, y: devY },
      source: [{ id: portHandleId, x: 175, y: portRelY - 3, width: 6, height: 6 }],
      target: [],
    },
    s1: {
      type: "stub-label",
      positionAbsolute: { x: 600, y: stubY },
      measuredHeight: STUB_H_EST,
      source: [],
      target: [{ id: "l", x: 0, y: STUB_H_EST / 2 - 3, width: 6, height: 6 }],
    },
  };
}

describe("snapStubHandleY", () => {
  it("lands the handle (top + h/2) on the nearest grid line", () => {
    expect(snapStubHandleY(100, 14) + 7).toBe(112); // handle 107 → nearest line 112
    expect(snapStubHandleY(89, 14)).toBe(89);  // handle already at 96
    expect(snapStubHandleY(96, 14)).toBe(89);  // grid-aligned top → handle re-centered
  });
});

describe("healStubPortAlignment", () => {
  const nodes = (stubY: number) => [device("dev", 400, 100), stub("s1", 600, stubY)];
  const edges = [leg("e1", "dev", "p1", "s1", "l")];

  it("corrects sub-grid drift to the partner port row", () => {
    // Port at absolute y 100+60=160; aligned stub top = 153. Stub drifted to 160 (handle 167).
    const healed = healStubPortAlignment(nodes(160), edges, snapshot(100, 60, "p1", 160));
    expect(healed).not.toBeNull();
    expect(healed!.find((n) => n.id === "s1")!.position.y).toBe(153);
  });

  it("aligns to the REAL port even when the port is off-grid", () => {
    // Port at 100+63=163 (off-grid). Stub handle at 160 → expect top 163-7=156.
    const healed = healStubPortAlignment(nodes(153), edges, snapshot(100, 63, "p1", 153));
    expect(healed).not.toBeNull();
    expect(healed!.find((n) => n.id === "s1")!.position.y).toBe(156);
  });

  it("leaves aligned stubs alone", () => {
    expect(healStubPortAlignment(nodes(153), edges, snapshot(100, 60, "p1", 153))).toBeNull();
  });

  it("leaves deliberate (>= half-cell) offsets alone", () => {
    expect(healStubPortAlignment(nodes(253), edges, snapshot(100, 60, "p1", 253))).toBeNull();
  });

  it("resolves directional handle variants (bare ref to -out handle)", () => {
    const healed = healStubPortAlignment(nodes(160), edges, snapshot(100, 60, "p1-out", 160));
    expect(healed).not.toBeNull();
    expect(healed!.find((n) => n.id === "s1")!.position.y).toBe(153);
  });
});

describe("nearestStubHandleSide", () => {
  it("picks the box side facing the far end", () => {
    // Box spans 500..580 (centre 540).
    expect(nearestStubHandleSide(500, 80, 700)).toBe("r"); // device to the right
    expect(nearestStubHandleSide(500, 80, 300)).toBe("l"); // device to the left
  });

  it("resolves a far end exactly at the centre to the right side", () => {
    expect(nearestStubHandleSide(500, 80, 540)).toBe("r");
  });
});

describe("reconcileStubPairs (#318)", () => {
  // A stubbed connection as convertEdgeToStubs builds it: dev-a -> tag-src, tag-tgt -> dev-b.
  const LINK = "link-2f8a";
  const tag = (id: string, side: "source" | "target"): SchematicNode =>
    ({
      id, type: "stub-label", position: { x: 400, y: 100 },
      data: { signalType: "sdi", linkedConnectionId: LINK, side, placed: true },
      measured: { width: 137, height: STUB_H_EST },
    } as unknown as SchematicNode);
  const stubLeg = (id: string, source: string, sourceHandle: string, target: string, targetHandle: string): ConnectionEdge =>
    ({
      id, source, sourceHandle, target, targetHandle,
      data: { signalType: "sdi", linkedConnectionId: LINK },
    } as unknown as ConnectionEdge);

  const nodes = (): SchematicNode[] => [
    device("dev-a", 0, 80),
    device("dev-b", 900, 80),
    tag("stub-e12-src", "source"),
    tag("stub-e12-tgt", "target"),
  ];
  const edges = (): ConnectionEdge[] => [
    stubLeg("e12-src", "dev-a", "p3-out", "stub-e12-src", "l"),
    stubLeg("e12-tgt", "stub-e12-tgt", "r", "dev-b", "p7-in"),
  ];

  it("leaves an intact pair alone (same array refs)", () => {
    const n = nodes();
    const e = edges();
    const out = reconcileStubPairs(n, e);
    expect(out.nodes).toBe(n);
    expect(out.edges).toBe(e);
    expect(out.removedLinks).toBe(0);
  });

  it("drops the surviving leg and both tags when one leg is removed", () => {
    // What a fumbled reconnect drag / Delete on one leg used to leave behind: both ends
    // then rendered "?" because neither tag could find a partner edge.
    const survivors = edges().filter((e) => e.id !== "e12-tgt");
    const out = reconcileStubPairs(nodes(), survivors);
    expect(out.edges).toEqual([]);
    expect(out.nodes.map((n) => n.id)).toEqual(["dev-a", "dev-b"]);
    expect(out.removedLinks).toBe(1);
  });

  it("drops a tag left with no leg at all", () => {
    // Deleting the tag's own leg directly (e.g. its device was removed).
    const out = reconcileStubPairs(nodes(), []);
    expect(out.nodes.map((n) => n.id)).toEqual(["dev-a", "dev-b"]);
  });

  it("only touches the broken link when several are present", () => {
    const otherLink = "link-99cc";
    const otherTags: SchematicNode[] = [
      { id: "stub-e40-src", type: "stub-label", position: { x: 200, y: 300 },
        data: { signalType: "hdmi", linkedConnectionId: otherLink, side: "source" } } as unknown as SchematicNode,
      { id: "stub-e40-tgt", type: "stub-label", position: { x: 700, y: 300 },
        data: { signalType: "hdmi", linkedConnectionId: otherLink, side: "target" } } as unknown as SchematicNode,
    ];
    const otherEdges: ConnectionEdge[] = [
      { id: "e40-src", source: "dev-a", sourceHandle: "p4-out", target: "stub-e40-src", targetHandle: "l",
        data: { signalType: "hdmi", linkedConnectionId: otherLink } } as unknown as ConnectionEdge,
      { id: "e40-tgt", source: "stub-e40-tgt", sourceHandle: "r", target: "dev-b", targetHandle: "p8-in",
        data: { signalType: "hdmi", linkedConnectionId: otherLink } } as unknown as ConnectionEdge,
    ];
    const out = reconcileStubPairs(
      [...nodes(), ...otherTags],
      [...edges().filter((e) => e.id !== "e12-src"), ...otherEdges],
    );
    expect(out.edges.map((e) => e.id)).toEqual(["e40-src", "e40-tgt"]);
    expect(out.nodes.map((n) => n.id)).toEqual(["dev-a", "dev-b", "stub-e40-src", "stub-e40-tgt"]);
  });

  it("does not touch plain (unstubbed) connections", () => {
    const plain: ConnectionEdge[] = [
      { id: "e50", source: "dev-a", sourceHandle: "p1-out", target: "dev-b", targetHandle: "p1-in",
        data: { signalType: "sdi" } } as unknown as ConnectionEdge,
    ];
    const out = reconcileStubPairs([device("dev-a", 0, 0), device("dev-b", 400, 0)], plain);
    expect(out.edges).toBe(plain);
  });
});

describe("midCustomLabelPlacement", () => {
  it("keeps the label at the midpoint on a normal edge (no stub ends)", () => {
    expect(midCustomLabelPlacement(false, false)).toEqual({ mode: "midpoint" });
  });

  it("anchors to the source end when the source is the stub (target-side leg)", () => {
    // stub → device leg: the stub is the SOURCE, so the label offsets in from source.
    expect(midCustomLabelPlacement(true, false)).toEqual({ mode: "stub-end", fromSource: true });
  });

  it("anchors to the target end when the target is the stub (source-side leg)", () => {
    // device → stub leg: the stub is the TARGET, so the label offsets in from target.
    expect(midCustomLabelPlacement(false, true)).toEqual({ mode: "stub-end", fromSource: false });
  });

  it("falls back to midpoint if somehow both ends are stubs", () => {
    expect(midCustomLabelPlacement(true, true)).toEqual({ mode: "midpoint" });
  });
});
