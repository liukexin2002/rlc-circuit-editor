/**
 * Where a stub connection's cable meets its stub label.
 *
 * Written while chasing #321 ("connection line stops short of the target-side stub
 * label"). The reported gap was NOT reproduced in the auto-route geometry — half 1 below
 * is a sweep that pins the correct behaviour so a future router change can't introduce
 * one. Half 2 covers two real auto-route-OFF defects found on the way, neither of which
 * is the reported symptom; #321 stays open.
 *
 *  1. The auto-route invariant. A stub half's route must terminate exactly on the stub
 *     label's connecting handle — the centre of the box edge FACING the device. Swept
 *     across realistic label widths (the rendered "→ SWITCHER [SDI IN 1]" box is 130-240px,
 *     not the 80px STUB_W_EST estimate used when the label is first placed), device
 *     positions and user-dragged label offsets.
 *
 *  2. The auto-route-OFF path. computeSimpleRoutes resolved handles by raw id only, so it
 *     agreed with the A* router on nothing: a stale bare↔directional port ref dropped the
 *     connection entirely (no route → OffsetEdge paints it at zero stroke width), and a
 *     stale l/r ref on a label sent the wire to the far side of the box.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { makeDevice, makeFixture, makePort, makeStubPair } from "../routingHarness/fixtures";
import { computeDeviceHandles } from "../routingHarness/deviceHandleLayout";
import { routeFixture } from "../routingHarness/route";
import { STUB_GAP, STUB_H_EST } from "../stubPlacement";
import type { ConnectionEdge, DeviceData, SchematicNode } from "../types";
import type { ReactFlowInstance } from "@xyflow/react";

// ---------------------------------------------------------------- auto-route invariant

/** One stubbed connection between two devices, with the tags anchored where the app's
 *  auto-place lands them for a box of `tagWidth`, then nudged by (dragDx, dragDy). */
function stubbedPair(tagWidth: number, tgtX: number, tgtY: number, dragDx: number, dragDy: number) {
  const src = makeDevice({ id: "dev-cam", label: "CAM-01", x: 0, y: 0, ports: [makePort("SDI OUT", "sdi", "output")] });
  const tgt = makeDevice({ id: "dev-switcher", label: "SWITCHER", x: tgtX, y: tgtY, ports: [makePort("SDI IN 1", "sdi", "input")] });
  const srcPortId = (src.data as DeviceData).ports[0].id;
  const tgtPortId = (tgt.data as DeviceData).ports[0].id;
  const asDevice = (n: SchematicNode) => n as { data: DeviceData; measured?: { width?: number; height?: number } };
  const sh = computeDeviceHandles(asDevice(src)).find((h) => h.id === srcPortId)!;
  const th = computeDeviceHandles(asDevice(tgt)).find((h) => h.id === tgtPortId)!;
  const srcPort = { x: src.position.x + sh.relX, y: src.position.y + sh.relY };
  const tgtPort = { x: tgt.position.x + th.relX, y: tgt.position.y + th.relY };

  const pair = makeStubPair({
    linkId: "lc1", signalType: "sdi",
    source: src.id, sourceHandle: srcPortId, srcHandlePos: srcPort, srcPortSide: "right",
    target: tgt.id, targetHandle: tgtPortId, tgtHandlePos: tgtPort, tgtPortSide: "left",
  });

  // StubLabelNode.tryPlace re-anchors X against the REAL measured width once React Flow
  // has measured the box; makeStubPair still uses the STUB_W_EST estimate.
  const anchoredX: Record<string, number> = {
    "stub-lc1-src": srcPort.x + STUB_GAP,
    "stub-lc1-tgt": tgtPort.x - STUB_GAP - tagWidth,
  };
  const nodes: SchematicNode[] = [src, tgt, ...pair.nodes].map((n) => {
    if (n.type !== "stub-label") return n;
    const isTgt = n.id.endsWith("-tgt");
    return {
      ...n,
      position: {
        x: anchoredX[n.id] + (isTgt ? dragDx : 0),
        y: n.position.y + (isTgt ? dragDy : 0),
      },
      measured: { width: tagWidth, height: STUB_H_EST },
    } as SchematicNode;
  });
  return makeFixture(`stub-w${tagWidth}-${tgtX}x${tgtY}-d${dragDx}_${dragDy}`, nodes, pair.edges);
}

describe("auto-routed stub halves terminate on the label edge facing their device", () => {
  const widths = [80, 137, 214];
  const places: [number, number][] = [[500, 0], [700, 200], [1100, -160]];
  const drags: [number, number][] = [[0, 0], [-120, 0], [0, 37]];

  for (const w of widths) {
    for (const [tx, ty] of places) {
      for (const [dx, dy] of drags) {
        it(`tag ${w}px wide, device at ${tx},${ty}, dragged ${dx},${dy}`, () => {
          const fx = stubbedPair(w, tx, ty, dx, dy);
          const { routes } = routeFixture(fx.nodes, fx.edges);
          for (const e of fx.edges) {
            const tag = fx.nodes.find((n) => n.type === "stub-label" && (n.id === e.source || n.id === e.target))!;
            const width = tag.measured!.width!;
            const route = routes[e.id];
            expect(route, `${e.id} was not routed`).toBeTruthy();
            // The stub end of the leg: waypoint[0] when the tag is the source.
            const tagIsSource = tag.id === e.source;
            const end = tagIsSource ? route.waypoints[0] : route.waypoints[route.waypoints.length - 1];
            // The side is not a free choice: the source label is placed to the RIGHT of
            // its device (it must be entered on its left edge), the target label to the
            // LEFT of its device (entered on its right edge). Landing on the far edge
            // means the wire crossed the opaque box to get there — under the #178 z-index
            // fix that tail is hidden beneath the label, not visibly wrong.
            const expectedX = tag.id.endsWith("-src") ? tag.position.x : tag.position.x + width;
            expect(
              Math.abs(end.x - expectedX),
              `${e.id} ends at x=${end.x}, expected ${expectedX} (label spans ${tag.position.x}..${tag.position.x + width})`,
            ).toBeLessThan(0.51);
            expect(Math.abs(end.y - (tag.position.y + STUB_H_EST / 2))).toBeLessThan(0.51);
          }
        });
      }
    }
  }
});

// ------------------------------------------------------- auto-route-off (simple routes)

function installLocalStorageStub() {
  const map = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() { return map.size; },
  });
}

let useSchematicStore: typeof import("../store").useSchematicStore;
beforeAll(async () => {
  installLocalStorageStub();
  ({ useSchematicStore } = await import("../store"));
});
afterAll(() => { vi.unstubAllGlobals(); });

const H = 10; // synthetic handle box size

interface Bound { id: string; x: number; y: number; width: number; height: number }
/** Minimal ReactFlowInstance stand-in — computeSimpleRoutes only calls getInternalNode. */
function rfWith(entries: Record<string, {
  type: string; abs: { x: number; y: number }; measured: { width: number; height: number };
  source?: Bound[]; target?: Bound[];
}>): ReactFlowInstance {
  return {
    getInternalNode: (id: string) => {
      const e = entries[id];
      if (!e) return undefined;
      return {
        id, type: e.type, measured: e.measured,
        internals: {
          positionAbsolute: e.abs,
          handleBounds: { source: e.source ?? [], target: e.target ?? [] },
        },
      };
    },
  } as unknown as ReactFlowInstance;
}

const bound = (id: string, cx: number, cy: number): Bound =>
  ({ id, x: cx - H / 2, y: cy - H / 2, width: H, height: H });

describe("auto-route-off routes resolve stub endpoints like the A* router", () => {
  // Tag at 500..637 (137 wide, 14 tall, centre row 207), device port at 700,200.
  const TAG_X = 500, TAG_Y = 200, TAG_W = 137;
  const DEV_X = 700, DEV_PORT_Y = 207;

  const nodes: SchematicNode[] = [
    { id: "dev-switcher", type: "device", position: { x: DEV_X, y: 180 },
      data: { label: "SWITCHER", deviceType: "misc",
        ports: [{ id: "p1", label: "SDI 1", signalType: "sdi", direction: "bidirectional" }] } } as unknown as SchematicNode,
    { id: "stub-tgt", type: "stub-label", position: { x: TAG_X, y: TAG_Y },
      measured: { width: TAG_W, height: STUB_H_EST },
      data: { signalType: "sdi", linkedConnectionId: "lc1", side: "target", placed: true } } as unknown as SchematicNode,
  ];

  const rf = rfWith({
    "dev-switcher": {
      type: "device", abs: { x: DEV_X, y: 180 }, measured: { width: 144, height: 68 },
      // Bidirectional port renders directional handles; a leg authored before the port
      // went bidirectional still stores the bare id.
      target: [bound("p1-in", 0, DEV_PORT_Y - 180)],
      source: [bound("p1-out", 144, DEV_PORT_Y - 180)],
    },
    "stub-tgt": {
      type: "stub-label", abs: { x: TAG_X, y: TAG_Y }, measured: { width: TAG_W, height: STUB_H_EST },
      // The DOM reports the tag's l/r handles a hair off centre; the box's true centre row
      // is TAG_Y + 7, which is what the router must use.
      source: [bound("l", 0, STUB_H_EST / 2 + 0.6), bound("r", TAG_W, STUB_H_EST / 2 + 0.6)],
    },
  });

  const seed = (targetHandle: string, sourceHandle: string, manualWaypoints?: { x: number; y: number }[]) => {
    const edges: ConnectionEdge[] = [
      { id: "e1-tgt", source: "stub-tgt", sourceHandle, target: "dev-switcher", targetHandle,
        data: { signalType: "sdi", linkedConnectionId: "lc1", ...(manualWaypoints ? { manualWaypoints } : {}) } } as unknown as ConnectionEdge,
    ];
    useSchematicStore.setState({ nodes, edges, routedEdges: {} });
    useSchematicStore.getState().computeSimpleRoutes(rf);
    return useSchematicStore.getState().routedEdges["e1-tgt"];
  };

  it("routes a leg whose port ref predates the port going bidirectional", () => {
    const route = seed("p1", "r");
    expect(route, "bare handle ref left the connection unrouted (invisible)").toBeTruthy();
    expect(route.waypoints[route.waypoints.length - 1].x).toBe(DEV_X);
  });

  it("leaves the tag from the side facing the device, not the stale stored side", () => {
    // Stored handle "l" is the creation-time guess; the device sits to the RIGHT, so the
    // wire has to leave the box's right edge or it crosses back under the tag.
    const route = seed("p1-in", "l");
    expect(route.waypoints[0].x).toBe(TAG_X + TAG_W);
  });

  it("anchors the label end on the box's true centre row", () => {
    const route = seed("p1-in", "r");
    expect(route.waypoints[0].y).toBe(TAG_Y + STUB_H_EST / 2);
  });

  it("takes the side facing the first path handle when the connection is hand-routed", () => {
    // A path handle dragged left of the label: the wire leaves the LEFT edge even though
    // the device is to the right. edgeRouter.nearestStubHandle uses the same point, so
    // toggling auto-route must not flip the side out from under the user.
    const route = seed("p1-in", "r", [{ x: TAG_X - 200, y: TAG_Y + 120 }]);
    expect(route.waypoints[0].x).toBe(TAG_X);
  });
});
