import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { CURRENT_SCHEMA_VERSION } from "../migrations";
import { GRID_SIZE } from "../gridConstants";
import { computeSnap, enforceMinSpacing, getPortAbsolutePositions, settleTagsAfterMove, snapGroupRestPositions, snapParentedRestPosition } from "../snapUtils";
import { STUB_GAP, STUB_H_EST } from "../stubPlacement";
import type { ConnectionEdge, SchematicFile, SchematicNode } from "../types";

/**
 * Regression tests for #322 — devices inside a room ("section") must land on the
 * same ABSOLUTE snapping grid as top-level devices. A parented device stores
 * room-relative coords; when the room origin sits off-grid (edge-aligned resize,
 * older saves), snapping in relative space leaves the device's ports off the
 * grid and cables to outside devices kink.
 */

// The store reads/writes localStorage at module init; vitest runs in the node
// environment where it is absent, so install an in-memory stub before import.
function installLocalStorageStub() {
  const map = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
  });
}

let useSchematicStore: typeof import("../store").useSchematicStore;

beforeAll(async () => {
  installLocalStorageStub();
  ({ useSchematicStore } = await import("../store"));
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  useSchematicStore.getState().newSchematic();
});

function room(id: string, x: number, y: number, parentId?: string): SchematicNode {
  return {
    id,
    type: "room",
    position: { x, y },
    parentId,
    style: { width: 400, height: 300 },
    data: { label: id },
  } as SchematicNode;
}

function device(id: string, x: number, y: number, parentId?: string): SchematicNode {
  return {
    id,
    type: "device",
    position: { x, y },
    parentId,
    measured: { width: 144, height: 96 },
    data: { label: id, deviceType: "misc", ports: [] },
  } as SchematicNode;
}

/** Absolute position by walking the parent chain of the CURRENT store nodes. */
function absPos(nodes: SchematicNode[], id: string): { x: number; y: number } {
  const map = new Map(nodes.map((n) => [n.id, n]));
  const n = map.get(id)!;
  let x = n.position.x;
  let y = n.position.y;
  let pid = n.parentId;
  while (pid) {
    const p = map.get(pid);
    if (!p) break;
    x += p.position.x;
    y += p.position.y;
    pid = p.parentId;
  }
  return { x, y };
}

function expectOnGrid(pos: { x: number; y: number }) {
  // Math.abs so a negative coordinate's -0 remainder still compares equal to 0.
  expect(Math.abs(pos.x % GRID_SIZE)).toBe(0);
  expect(Math.abs(pos.y % GRID_SIZE)).toBe(0);
}

describe("load-time grid snap (#322)", () => {
  it("puts a sectioned device on the absolute grid even when the room origin is off-grid", () => {
    const file: SchematicFile = {
      version: CURRENT_SCHEMA_VERSION,
      name: "off-grid room",
      nodes: [room("room-1", 103, 57), device("dev-1", 61, 39, "room-1")],
      edges: [],
    };
    useSchematicStore.getState().importFromJSON(file);

    const nodes = useSchematicStore.getState().nodes;
    expectOnGrid(absPos(nodes, "room-1"));
    expectOnGrid(absPos(nodes, "dev-1"));
  });

  it("handles nested parents (rack inside a room) in absolute space", () => {
    const rack = room("rack-1", 37, 21, "room-1");
    (rack.data as { isEquipmentRack?: boolean }).isEquipmentRack = true;
    const file: SchematicFile = {
      version: CURRENT_SCHEMA_VERSION,
      name: "nested off-grid",
      nodes: [room("room-1", 103, 57), rack, device("dev-1", 13, 9, "rack-1")],
      edges: [],
    };
    useSchematicStore.getState().importFromJSON(file);

    const nodes = useSchematicStore.getState().nodes;
    expectOnGrid(absPos(nodes, "rack-1"));
    expectOnGrid(absPos(nodes, "dev-1"));
  });
});

describe("snapRoomChildrenToGrid (#322)", () => {
  it("re-snaps children in absolute space after a room's origin moved off-grid", () => {
    // Post-resize state: room origin off-grid, child relative coords still
    // grid-multiples — so the child's ABSOLUTE position is off-grid.
    useSchematicStore.setState({
      nodes: [room("room-1", 100, 50), device("dev-1", 64, 32, "room-1")],
    });
    useSchematicStore.getState().snapRoomChildrenToGrid("room-1");

    const nodes = useSchematicStore.getState().nodes;
    // The room itself is left alone (its off-grid origin can be deliberate,
    // e.g. edge-aligned to another room)...
    expect(absPos(nodes, "room-1")).toEqual({ x: 100, y: 50 });
    // ...but the device lands on the absolute grid regardless.
    expectOnGrid(absPos(nodes, "dev-1"));
  });

  it("snaps nested children against the snapped position of their parent", () => {
    useSchematicStore.setState({
      nodes: [
        room("room-1", 100, 50),
        room("rack-1", 30, 30, "room-1"),
        device("dev-1", 10, 10, "rack-1"),
      ],
    });
    useSchematicStore.getState().snapRoomChildrenToGrid("room-1");

    const nodes = useSchematicStore.getState().nodes;
    expectOnGrid(absPos(nodes, "rack-1"));
    expectOnGrid(absPos(nodes, "dev-1"));
  });

  it("is a no-op when children already sit on the absolute grid", () => {
    const before = [room("room-1", 100, 48), device("dev-1", 60, 32, "room-1")];
    useSchematicStore.setState({ nodes: before });
    useSchematicStore.getState().snapRoomChildrenToGrid("room-1");
    // dev-1 abs = (160, 80) — already grid-aligned, so the node array is untouched.
    expect(useSchematicStore.getState().nodes).toBe(before);
  });
});

describe("onRoomResizeEnd (#322)", () => {
  it("snaps a device the resize pushed OUT of the room, not just remaining children", () => {
    // Post-resize state after dragging the left edge right by an unsnapped 105px:
    // origin (105, 0), width shrunk to 295. Both children kept their relative
    // coords, so their absolute x shifted off-grid by the same 105px. dev-out's
    // center now falls outside the bounds — reparentAllDevices detaches it at
    // that off-grid absolute position, and it must STILL be pulled onto the grid.
    const shrunk = room("room-1", 105, 0);
    shrunk.style = { width: 295, height: 300 };
    useSchematicStore.setState({
      nodes: [
        shrunk,
        device("dev-in", 32, 32, "room-1"), // abs (137, 32), center inside
        device("dev-out", 352, 32, "room-1"), // abs (457, 32), center outside
      ],
    });
    useSchematicStore.getState().onRoomResizeEnd("room-1");

    const nodes = useSchematicStore.getState().nodes;
    const map = new Map(nodes.map((n) => [n.id, n]));
    expect(map.get("dev-out")!.parentId).toBeUndefined();
    expectOnGrid(absPos(nodes, "dev-out"));
    expect(map.get("dev-in")!.parentId).toBe("room-1");
    expectOnGrid(absPos(nodes, "dev-in"));
  });
});

describe("enforceMinSpacing rounds in absolute space (#322)", () => {
  it("returns a position whose ABSOLUTE coords are grid-aligned for a sectioned device", () => {
    const roomNode = room("room-1", 103, 57);
    const dragged = device("dev-1", 32, 32, "room-1");
    const neighbor = device("dev-2", 40, 40, "room-1"); // overlaps → forces a correction
    const corrected = enforceMinSpacing(dragged, [roomNode, dragged, neighbor]);

    expect(corrected).not.toBeNull();
    expectOnGrid({ x: corrected!.x + 103, y: corrected!.y + 57 });
  });

  it("still rounds plain top-level devices to the grid", () => {
    const dragged = device("dev-1", 32, 32);
    const neighbor = device("dev-2", 40, 40);
    const corrected = enforceMinSpacing(dragged, [dragged, neighbor]);

    expect(corrected).not.toBeNull();
    expectOnGrid(corrected!);
  });
});

describe("drag-stop rest position inside an off-grid room (#322)", () => {
  it("rounds a plain drag with no alignment and no neighbor onto the ABSOLUTE grid", () => {
    // The scenario computeSnap/enforceMinSpacing both pass through untouched:
    // React Flow's snapGrid grid-rounded the RELATIVE coords, the room origin is
    // off-grid, and there is nothing nearby to align with or push against.
    const roomNode = room("room-1", 103, 57);
    const dev = device("dev-1", 64, 32, "room-1");
    const all = [roomNode, dev];

    const snap = computeSnap(dev, all);
    expect({ x: snap.x, y: snap.y }).toEqual({ x: 64, y: 32 }); // identity
    expect(enforceMinSpacing(dev, all, undefined, snap)).toBeNull(); // no overlap

    const nodeMap = new Map(all.map((n) => [n.id, n]));
    const rest = snapParentedRestPosition(dev, { x: snap.x, y: snap.y }, nodeMap);
    expectOnGrid({ x: rest.x + 103, y: rest.y + 57 });
  });

  it("leaves an axis the snap engine moved alone — alignment can be deliberately off-grid", () => {
    const roomNode = room("room-1", 103, 57);
    const dev = device("dev-1", 64, 32, "room-1");
    const nodeMap = new Map([roomNode, dev].map((n) => [n.id as string, n]));

    // x differs from the rest position (an alignment snap fired), y did not.
    const rest = snapParentedRestPosition(dev, { x: 61, y: 32 }, nodeMap);
    expect(rest.x).toBe(61);
    expect(Math.abs((rest.y + 57) % GRID_SIZE)).toBe(0);
  });

  it("is a no-op for top-level devices and stubs", () => {
    const dev = device("dev-1", 61, 39);
    const nodeMap = new Map<string, SchematicNode>([[dev.id, dev]]);
    expect(snapParentedRestPosition(dev, { x: 61, y: 39 }, nodeMap)).toEqual({ x: 61, y: 39 });

    const roomNode = room("room-1", 103, 57);
    const stub = {
      ...device("stub-1", 64, 30.5, "room-1"),
      type: "stub-label",
    } as SchematicNode;
    const map2 = new Map([roomNode, stub].map((n) => [n.id as string, n]));
    expect(snapParentedRestPosition(stub, { x: 64, y: 30.5 }, map2)).toEqual({ x: 64, y: 30.5 });
  });
});

describe("cyclic parentId chains (corrupt saves) terminate (#322)", () => {
  function cyclicNodes(): SchematicNode[] {
    return [
      room("room-a", 103, 57, "room-b"),
      room("room-b", 50, 50, "room-a"),
      device("dev-1", 61, 39, "room-a"),
    ];
  }

  it("loads a file whose rooms parent each other without hanging", () => {
    const file: SchematicFile = {
      version: CURRENT_SCHEMA_VERSION,
      name: "cyclic",
      nodes: cyclicNodes(),
      edges: [],
    };
    useSchematicStore.getState().importFromJSON(file);
    const nodes = useSchematicStore.getState().nodes;
    expect(nodes).toHaveLength(3);
    // Import must BREAK the cycle, not just survive it — React Flow's own
    // parent resolution and the edge router walk parentId unguarded, so a
    // cycle that reaches the canvas still hangs the tab at first render.
    const byId = new Map(nodes.map((n) => [n.id, n]));
    for (const n of nodes) {
      const seen = new Set<string>();
      let cur = n as SchematicNode | undefined;
      while (cur?.parentId) {
        expect(seen.has(cur.id)).toBe(false);
        seen.add(cur.id);
        cur = byId.get(cur.parentId);
      }
    }
  });

  it("snapRoomChildrenToGrid terminates and still snaps the child", () => {
    useSchematicStore.setState({ nodes: cyclicNodes() });
    useSchematicStore.getState().snapRoomChildrenToGrid("room-a");
    const dev = useSchematicStore.getState().nodes.find((n) => n.id === "dev-1")!;
    expect(Number.isFinite(dev.position.x)).toBe(true);
    expect(Number.isFinite(dev.position.y)).toBe(true);
  });

  it("onRoomResizeEnd terminates on a cycle", () => {
    useSchematicStore.setState({ nodes: cyclicNodes() });
    useSchematicStore.getState().onRoomResizeEnd("room-a");
    expect(useSchematicStore.getState().nodes).toHaveLength(3);
  });

  it("enforceMinSpacing terminates when the dragged node's chain is cyclic", () => {
    const [roomA, roomB] = cyclicNodes();
    const dragged = device("dev-1", 32, 32, "room-a");
    const neighbor = device("dev-2", 40, 40, "room-a");
    const corrected = enforceMinSpacing(dragged, [roomA, roomB, dragged, neighbor]);
    expect(corrected).not.toBeNull();
  });
});

describe("group-drag rest positions inside an off-grid room (#327)", () => {
  // Room origin off the 16px grid (legacy save), holding two devices at
  // grid-multiple RELATIVE coords — so both sit off the ABSOLUTE grid — plus two
  // top-level devices, one on the grid and one carrying the reference node's
  // residue. React Flow lands a multi-selection by rounding one reference node
  // and shifting the rest by that same offset, so whichever residue the
  // reference had is imposed on every member.
  function offGridRoomScene(): SchematicNode[] {
    return [
      room("room-1", 103, 57), // children land at abs x ≡ 7, y ≡ 9 (mod 16)
      device("dev-1", 64, 32, "room-1"),
      device("dev-2", 128, 32, "room-1"),
      device("dev-3", 400, 96),
      device("dev-off", 407, 405),
    ];
  }

  const draggedIds = new Set(["dev-1", "dev-2", "dev-3", "dev-off"]);

  function applyMoves(
    nodes: SchematicNode[],
    moves: Map<string, { x: number; y: number }>,
  ): SchematicNode[] {
    return nodes.map((n) => {
      const pos = moves.get(n.id);
      return pos ? ({ ...n, position: pos } as SchematicNode) : n;
    });
  }

  it("rounds every dragged device onto the ABSOLUTE grid when the anchor aligned nothing", () => {
    const nodes = offGridRoomScene();
    // Without the correction the group rests exactly where React Flow left it.
    expect(Math.abs(absPos(nodes, "dev-1").x % GRID_SIZE)).not.toBe(0);

    const moves = snapGroupRestPositions(nodes, draggedIds, { dx: 0, dy: 0 }, "dev-3");
    const rested = applyMoves(nodes, moves);
    expectOnGrid(absPos(rested, "dev-1"));
    expectOnGrid(absPos(rested, "dev-2"));
    expectOnGrid(absPos(rested, "dev-3"));
    // A top-level member carrying the reference node's residue is pulled back
    // too — unparented, so #322's correction never looked at it.
    expect(moves.get("dev-off")).toEqual({ x: 400, y: 400 });
  });

  it("lands parented members on the grid even when the anchor's alignment moved both axes", () => {
    // Gating the correction on "this axis did not move" disables it for the
    // WHOLE group the moment the anchor aligns to something — and the anchor's
    // alignment says nothing about where the other members rest.
    const nodes = [
      room("room-1", 103, 57),
      device("dev-1", 64, 32, "room-1"), // abs (167, 89)
      device("dev-3", 697, 603),
      device("peer", 704, 608), // not selected; the anchor aligns onto it
    ];
    const moves = snapGroupRestPositions(nodes, new Set(["dev-1", "dev-3"]), { dx: 7, dy: 5 }, "dev-3");
    const rested = applyMoves(nodes, moves);

    expect(absPos(rested, "dev-3")).toEqual({ x: 704, y: 608 }); // alignment lands exactly
    expectOnGrid(absPos(rested, "dev-1"));
  });

  it("keeps the anchor's off-grid alignment and the group's spacing around it", () => {
    const nodes = offGridRoomScene();
    // x moved by the anchor's alignment snap — flush to an off-grid edge — and
    // y merely rode along.
    const moves = snapGroupRestPositions(nodes, draggedIds, { dx: -7, dy: 0 }, "dev-3");
    const rested = applyMoves(nodes, moves);

    expect(absPos(rested, "dev-3")).toEqual({ x: 393, y: 96 }); // alignment survives
    // Same-room members keep their exact spacing and stay a grid multiple from
    // the anchor, so its residue is the only one left in the group.
    expect(absPos(rested, "dev-2").x - absPos(rested, "dev-1").x).toBe(64);
    expect(Math.abs((absPos(rested, "dev-1").x - 393) % GRID_SIZE)).toBe(0);
    expectOnGrid({ x: 0, y: absPos(rested, "dev-1").y });
  });

  it("shifts a mixed-residue group by up to half a cell — that residue IS the bug", () => {
    // Members whose absolute offset was never a grid multiple cannot all land
    // on the grid AND keep their exact spacing; #134's spacing guarantee yields
    // here, bounded by half a grid cell.
    const nodes = offGridRoomScene();
    const gap = (ns: SchematicNode[]) => ({
      x: absPos(ns, "dev-1").x - absPos(ns, "dev-off").x,
      y: absPos(ns, "dev-1").y - absPos(ns, "dev-off").y,
    });
    const before = gap(nodes);

    const moves = snapGroupRestPositions(nodes, new Set(["dev-1", "dev-off"]), { dx: 0, dy: 0 }, "dev-off");
    const rested = applyMoves(nodes, moves);
    expectOnGrid(absPos(rested, "dev-1"));
    expectOnGrid(absPos(rested, "dev-off"));

    const after = gap(rested);
    expect(after.y).not.toBe(before.y);
    expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(GRID_SIZE / 2);
    expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(GRID_SIZE / 2);
  });

  it("skips children of a dragged room — they ride along in relative coords", () => {
    const nodes = offGridRoomScene();
    const withRoom = new Set(["room-1", "dev-1", "dev-2"]);
    const moves = snapGroupRestPositions(nodes, withRoom, { dx: 0, dy: 0 }, "room-1");
    expect(moves.has("dev-1")).toBe(false);
    expect(moves.has("dev-2")).toBe(false);
    expect(moves.size).toBe(0);
  });

  it("leaves a dragged room's own off-grid origin alone (#322)", () => {
    // A room origin can be deliberately off-grid — edge-aligned to another room
    // — and snapRoomChildrenToGrid re-snaps its devices after the move.
    const nodes = offGridRoomScene();
    const moves = snapGroupRestPositions(nodes, new Set(["room-1", "dev-off"]), { dx: 0, dy: 0 }, "dev-off");
    expect(moves.has("room-1")).toBe(false);
    expect(moves.get("dev-off")).toEqual({ x: 400, y: 400 });
  });

  it("leaves a tag with no leg on its port-centred sub-grid position", () => {
    // No leg means no device to ride with (#334), so the tag stays exempt from the
    // absolute-grid correction and rests exactly where the raw delta put it.
    const stub = {
      ...device("stub-1", 64, 30.5, "room-1"),
      type: "stub-label",
    } as SchematicNode;
    const nodes = [...offGridRoomScene(), stub];
    const moves = snapGroupRestPositions(nodes, new Set(["dev-1", "stub-1"]), { dx: 0, dy: 0 }, "dev-1");
    expect(moves.has("stub-1")).toBe(false);
  });

  it("reports no moves when the whole group already rests on the absolute grid", () => {
    const nodes = [room("room-2", 96, 48), device("dev-4", 64, 32, "room-2"), device("dev-5", 400, 96)];
    const moves = snapGroupRestPositions(nodes, new Set(["dev-4", "dev-5"]), { dx: 0, dy: 0 }, "dev-5");
    expect(moves.size).toBe(0);
  });

  it("still applies the alignment delta when the anchor is not in the node list", () => {
    const nodes = offGridRoomScene();
    const moves = snapGroupRestPositions(nodes, new Set(["dev-3"]), { dx: GRID_SIZE, dy: 0 }, "gone");
    expect(moves.get("dev-3")).toEqual({ x: 400 + GRID_SIZE, y: 96 });
  });
});

describe("co-dragged stub tags ride with their device (#334)", () => {
  // Room origin at an exact HALF-CELL residue on both axes — what centre-alignment
  // produces, and the setup #327's verification used. Its device is therefore corrected
  // by exactly GRID_SIZE/2 = 8px, the one value healStubPortAlignment refuses to heal
  // (its band is 0.75px ≤ |dy| < 8, strictly exclusive at 8), so a tag left behind by
  // the correction sits 8px off its port row for good.
  const HALF = GRID_SIZE / 2;

  function ported(id: string, x: number, y: number, parentId?: string): SchematicNode {
    return {
      id,
      type: "device",
      position: { x, y },
      parentId,
      measured: { width: 144, height: 96 },
      data: {
        label: id,
        deviceType: "misc",
        ports: [
          { id: "p1", label: "SDI OUT 1", signalType: "sdi", direction: "output" },
          { id: "p2", label: "SDI OUT 2", signalType: "sdi", direction: "output" },
        ],
      },
    } as SchematicNode;
  }

  function tag(id: string, x: number, y: number): SchematicNode {
    return {
      id,
      type: "stub-label",
      position: { x, y },
      data: { signalType: "sdi", linkedConnectionId: "link-1", side: "target", placed: true },
      measured: { width: 137, height: STUB_H_EST },
    } as unknown as SchematicNode;
  }

  const leg: ConnectionEdge = {
    id: "e1-tgt",
    source: "stub-1",
    sourceHandle: "l",
    target: "dev-1",
    targetHandle: "p1",
    data: { signalType: "sdi", linkedConnectionId: "link-1" },
  } as unknown as ConnectionEdge;

  /** Absolute Y of the device's p1 row, for the current node positions. */
  function portRowY(nodes: SchematicNode[]): number {
    const map = new Map(nodes.map((n) => [n.id, n] as const));
    const p = getPortAbsolutePositions(map.get("dev-1")!, map).find((q) => q.handleId === "p1")!;
    return p.absY;
  }

  /** Device + its tag, the tag centred on the p1 row exactly as placement leaves it. */
  function scene(): { nodes: SchematicNode[]; rowY: number } {
    const base = [room("room-1", HALF, HALF), ported("dev-1", 64, 32, "room-1")];
    const map = new Map(base.map((n) => [n.id, n] as const));
    const p = getPortAbsolutePositions(map.get("dev-1")!, map).find((q) => q.handleId === "p1")!;
    const nodes = [...base, tag("stub-1", p.absX + STUB_GAP, p.absY - STUB_H_EST / 2)];
    return { nodes, rowY: p.absY };
  }

  function applyMoves(
    nodes: SchematicNode[],
    moves: Map<string, { x: number; y: number }>,
  ): SchematicNode[] {
    return nodes.map((n) => {
      const pos = moves.get(n.id);
      return pos ? ({ ...n, position: pos } as SchematicNode) : n;
    });
  }

  it("keeps the tag on its port row when the device is corrected by exactly half a cell", () => {
    const { nodes, rowY } = scene();
    const moves = snapGroupRestPositions(
      nodes, new Set(["dev-1", "stub-1"]), { dx: 0, dy: 0 }, "dev-1", [leg],
    );

    // The correction really is the boundary value the heal band excludes.
    expect(moves.get("dev-1")!.y - 32).toBe(HALF);
    expect(moves.get("dev-1")!.x - 64).toBe(HALF);

    const rested = applyMoves(nodes, moves);
    expectOnGrid(absPos(rested, "dev-1"));
    expect(portRowY(rested)).toBe(rowY + HALF);
    // Tag centre is still exactly on the row — no 8px orphan gap to heal.
    expect(absPos(rested, "stub-1").y + STUB_H_EST / 2).toBe(portRowY(rested));
    expect(absPos(rested, "stub-1").x).toBe(nodes[2].position.x + HALF);
  });

  it("leaves the tag behind without the pairing — the #334 failure mode", () => {
    // Same drag with no connections supplied: the tag falls back to the raw delta and
    // strands itself exactly half a cell off the row.
    const { nodes } = scene();
    const moves = snapGroupRestPositions(nodes, new Set(["dev-1", "stub-1"]), { dx: 0, dy: 0 }, "dev-1");
    const rested = applyMoves(nodes, moves);
    expect(portRowY(rested) - (absPos(rested, "stub-1").y + STUB_H_EST / 2)).toBe(HALF);
  });

  it("moves the tag by the raw delta when its device is not in the drag", () => {
    const { nodes, rowY } = scene();
    const moves = snapGroupRestPositions(
      nodes, new Set(["stub-1", "dev-other"]), { dx: 0, dy: GRID_SIZE }, "dev-other", [leg],
    );
    const rested = applyMoves(nodes, moves);
    // Deliberate hand placement: the device stayed put, so the tag leaves the row.
    expect(portRowY(rested)).toBe(rowY);
    expect(absPos(rested, "stub-1").y + STUB_H_EST / 2).toBe(rowY + GRID_SIZE);
  });

  it("rides a text stub with the device named by its anchorNodeId", () => {
    const { nodes } = scene();
    const note = {
      id: "text-stub-1",
      type: "text-stub",
      position: { x: 900, y: 300.5 },
      data: { text: "Client LAN", signalType: "network", anchorNodeId: "dev-1", anchorPortId: "p2", side: "l" },
    } as unknown as SchematicNode;
    const moves = snapGroupRestPositions(
      [...nodes, note], new Set(["dev-1", "text-stub-1"]), { dx: 0, dy: 0 }, "dev-1", [leg],
    );
    expect(moves.get("text-stub-1")).toEqual({ x: 900 + HALF, y: 300.5 + HALF });
  });

  it("keeps the pair rigid when the tag itself is the drag anchor", () => {
    // Grabbing the tag makes it the frame — and computeStubSnap rests a tag centred on
    // its port row, which is deliberately SUB-GRID, so the anchor's alignment delta is
    // essentially never zero. Framing the group on that rest would hand every co-dragged
    // device the tag's residue. The nonzero delta is the whole point of this case: with
    // {0, 0} the frame takes the grid-rounding branch that ANY anchor gets, and the test
    // asserts coverage it does not have.
    const { nodes } = scene();
    const moves = snapGroupRestPositions(
      nodes, new Set(["dev-1", "stub-1"]), { dx: 5, dy: 3 }, "stub-1", [leg],
    );
    const rested = applyMoves(nodes, moves);
    expectOnGrid(absPos(rested, "dev-1"));
    expect(absPos(rested, "stub-1").y + STUB_H_EST / 2).toBe(portRowY(rested));
    // Rigid: the tag rode the device's corrected shift, not the raw 5/3 nudge.
    const devShift = {
      dx: moves.get("dev-1")!.x - 64,
      dy: moves.get("dev-1")!.y - 32,
    };
    expect(moves.get("stub-1")).toEqual({
      x: nodes[2].position.x + devShift.dx,
      y: nodes[2].position.y + devShift.dy,
    });
  });

  it("rides the visible device when the leg ends on a hidden inline adapter", () => {
    // Stubbing the device→adapter half of an adapted connection leaves the tag's leg
    // pointing at the ADAPTER. Hidden, that adapter is a 1x1 placeholder no selection
    // can contain, and the leg is drawn through to the device on its far side — so the
    // pairing has to hop or it silently no-ops for this tag.
    const { nodes } = scene();
    const adapter = {
      ...ported("adapter-1", 400, 32),
      data: { label: "adapter-1", deviceType: "adapter", ports: [] },
    } as SchematicNode;
    const legToAdapter = { ...leg, target: "adapter-1" } as ConnectionEdge;
    const onward = {
      id: "e2", source: "adapter-1", sourceHandle: "p1", target: "dev-1", targetHandle: "p1",
      data: { signalType: "sdi" },
    } as unknown as ConnectionEdge;
    const scene2 = [...nodes, adapter];

    const moves = snapGroupRestPositions(
      scene2, new Set(["dev-1", "stub-1"]), { dx: 0, dy: 0 }, "dev-1",
      [legToAdapter, onward], new Set(["adapter-1"]),
    );
    expect(moves.get("stub-1")).toEqual({
      x: nodes[2].position.x + HALF,
      y: nodes[2].position.y + HALF,
    });

    // A VISIBLE adapter is a real device the user can select, so no hop: the tag hangs
    // off the adapter, which is not in this drag, and keeps the raw delta.
    const visible = snapGroupRestPositions(
      scene2, new Set(["dev-1", "stub-1"]), { dx: 0, dy: 0 }, "dev-1", [legToAdapter, onward],
    );
    expect(visible.has("stub-1")).toBe(false);
  });
});

describe("room re-snap carries stub tags with their device (#334)", () => {
  // snapRoomChildrenToGrid pulls a room's devices back onto the ABSOLUTE grid by up to
  // half a cell whenever the room rests off-grid, and used to skip stub tags entirely.
  // It writes nodes directly, so the reanchor pass never runs, and half a cell is exactly
  // the correction healStubPortAlignment refuses to heal — the tag was stranded off its
  // port row for good. Every caller is covered here: group drag (the #334 fix in
  // snapGroupRestPositions no-ops when the device's room is in the drag too), plain room
  // drag, and a left/top-edge resize.
  function ported(id: string, x: number, y: number, parentId?: string): SchematicNode {
    return {
      id,
      type: "device",
      position: { x, y },
      parentId,
      measured: { width: 144, height: 96 },
      data: {
        label: id,
        deviceType: "misc",
        ports: [{ id: "p1", label: "SDI OUT 1", signalType: "sdi", direction: "output" }],
      },
    } as SchematicNode;
  }

  function tag(id: string, x: number, y: number, parentId?: string): SchematicNode {
    return {
      id,
      type: "stub-label",
      position: { x, y },
      parentId,
      data: { signalType: "sdi", linkedConnectionId: "link-1", side: "target", placed: true },
      measured: { width: 137, height: STUB_H_EST },
    } as unknown as SchematicNode;
  }

  const leg = {
    id: "e1-tgt", source: "stub-1", sourceHandle: "l", target: "dev-1", targetHandle: "p1",
    data: { signalType: "sdi", linkedConnectionId: "link-1" },
  } as unknown as ConnectionEdge;

  function portRowY(nodes: SchematicNode[]): number {
    const map = new Map(nodes.map((n) => [n.id, n] as const));
    return getPortAbsolutePositions(map.get("dev-1")!, map).find((q) => q.handleId === "p1")!.absY;
  }

  /** Room at `origin`, one device inside it, its tag centred on the p1 row. The tag is
   *  parented to the room or left top-level, as both occur in the wild. */
  function scene(origin: { x: number; y: number }, tagInRoom: boolean): SchematicNode[] {
    const base = [room("room-1", origin.x, origin.y), ported("dev-1", 64, 32, "room-1")];
    const rowY = portRowY(base);
    const map = new Map(base.map((n) => [n.id, n] as const));
    const p = getPortAbsolutePositions(map.get("dev-1")!, map).find((q) => q.handleId === "p1")!;
    const absX = p.absX + STUB_GAP;
    const absY = rowY - STUB_H_EST / 2;
    return [
      ...base,
      tagInRoom
        ? tag("stub-1", absX - origin.x, absY - origin.y, "room-1")
        : tag("stub-1", absX, absY),
    ];
  }

  function expectStillOnRow(nodes: SchematicNode[]) {
    expect(absPos(nodes, "stub-1").y + STUB_H_EST / 2).toBe(portRowY(nodes));
  }

  it("keeps the pair on its row when a room+device+tag group drag lands off-grid", () => {
    // Half-cell room origin — what centre-alignment produces. The group-drag pass skips a
    // device whose room is in the drag, so the tag finds no host shift there and the
    // stranding has to be prevented by the room pass App.tsx runs next.
    const nodes = scene({ x: 8, y: 8 }, true);
    const groupMoves = snapGroupRestPositions(
      nodes, new Set(["room-1", "dev-1", "stub-1"]), { dx: 0, dy: 0 }, "room-1", [leg],
    );
    expect(groupMoves.size).toBe(0); // nothing corrected yet — the gap the room pass fills

    useSchematicStore.setState({ nodes, edges: [leg] });
    useSchematicStore.getState().snapRoomChildrenToGrid("room-1");

    const rested = useSchematicStore.getState().nodes;
    expectOnGrid(absPos(rested, "dev-1"));
    expect(portRowY(rested) - portRowY(nodes)).toBe(GRID_SIZE / 2); // the unhealable shift
    expectStillOnRow(rested);
  });

  it("carries a top-level tag when its room is dragged to an off-grid rest", () => {
    const nodes = scene({ x: 103, y: 57 }, false);
    useSchematicStore.setState({ nodes, edges: [leg] });
    useSchematicStore.getState().snapRoomChildrenToGrid("room-1");

    const rested = useSchematicStore.getState().nodes;
    expectOnGrid(absPos(rested, "dev-1"));
    expectStillOnRow(rested);
  });

  it("carries the tag through a left/top-edge room resize", () => {
    // Dragging the left edge right by an unsnapped 105px moves the origin, so every
    // child travels with it and lands off the absolute grid.
    const nodes = scene({ x: 105, y: 3 }, true);
    (nodes[0] as SchematicNode).style = { width: 400, height: 300 };
    useSchematicStore.setState({ nodes, edges: [leg] });
    useSchematicStore.getState().onRoomResizeEnd("room-1");

    const rested = useSchematicStore.getState().nodes;
    expectOnGrid(absPos(rested, "dev-1"));
    expectStillOnRow(rested);
  });

  it("leaves a tag alone when its own device did not move", () => {
    const nodes = scene({ x: 96, y: 48 }, false); // room already on-grid
    useSchematicStore.setState({ nodes, edges: [leg] });
    useSchematicStore.getState().snapRoomChildrenToGrid("room-1");
    expect(useSchematicStore.getState().nodes).toBe(nodes);
  });
});

describe("a group drag settles the tags it left out (#346)", () => {
  // The tags are NOT in the selection — the case #334 does not cover. Nothing the group
  // drag-stop path used to run stood in for #182's re-anchor (reparentNode early-returns
  // on an unchanged parent, so the store's copy never fired either), so the tag stayed at
  // its old coordinates for the whole drag distance.
  const DRAG = 10 * GRID_SIZE;

  function ported(id: string, x: number, y: number, parentId?: string): SchematicNode {
    return {
      id,
      type: "device",
      position: { x, y },
      parentId,
      measured: { width: 144, height: 96 },
      data: {
        label: id,
        deviceType: "misc",
        ports: [
          { id: "sdi-out-1", label: "SDI OUT 1", signalType: "sdi", direction: "output" },
          { id: "sdi-out-2", label: "SDI OUT 2", signalType: "sdi", direction: "output" },
        ],
      },
    } as SchematicNode;
  }

  function tag(id: string, linkId: string, x: number, y: number): SchematicNode {
    return {
      id,
      type: "stub-label",
      position: { x, y },
      data: { signalType: "sdi", linkedConnectionId: linkId, side: "target", placed: true },
      measured: { width: 137, height: STUB_H_EST },
    } as unknown as SchematicNode;
  }

  function legTo(deviceId: string, tagId: string, linkId: string): ConnectionEdge {
    return {
      id: `${linkId}-tgt`,
      source: tagId,
      sourceHandle: "l",
      target: deviceId,
      targetHandle: "sdi-out-1",
      data: { signalType: "sdi", linkedConnectionId: linkId },
    } as unknown as ConnectionEdge;
  }

  function portRowY(nodes: SchematicNode[], deviceId: string): number {
    const map = new Map(nodes.map((n) => [n.id, n] as const));
    return getPortAbsolutePositions(map.get(deviceId)!, map)
      .find((q) => q.handleId === "sdi-out-1")!.absY;
  }

  /** A tag hung where defaultStubPlacement would put it: STUB_GAP out from SDI OUT 1,
   *  centred on that port row. */
  function hangTag(nodes: SchematicNode[], deviceId: string, id: string, linkId: string) {
    const map = new Map(nodes.map((n) => [n.id, n] as const));
    const p = getPortAbsolutePositions(map.get(deviceId)!, map)
      .find((q) => q.handleId === "sdi-out-1")!;
    return tag(id, linkId, p.absX + STUB_GAP, p.absY - STUB_H_EST / 2);
  }

  /** Two devices, each with its own auto-placed tag. */
  function scene(): { nodes: SchematicNode[]; edges: ConnectionEdge[] } {
    const devices = [ported("dev-1", 96, 96), ported("dev-2", 96, 320)];
    return {
      nodes: [
        ...devices,
        hangTag(devices, "dev-1", "stub-1", "link-1"),
        hangTag(devices, "dev-2", "stub-2", "link-2"),
      ],
      edges: [legTo("dev-1", "stub-1", "link-1"), legTo("dev-2", "stub-2", "link-2")],
    };
  }

  /** What React Flow has already committed by drag-stop: every dragged node shifted. */
  function dragBy(nodes: SchematicNode[], draggedIds: ReadonlySet<string>, dx: number, dy: number) {
    return nodes.map((n) =>
      draggedIds.has(n.id)
        ? ({ ...n, position: { x: n.position.x + dx, y: n.position.y + dy } } as SchematicNode)
        : n,
    );
  }

  function dataOf(nodes: SchematicNode[], id: string): { placed?: boolean; userMoved?: boolean } {
    return nodes.find((n) => n.id === id)!.data as { placed?: boolean; userMoved?: boolean };
  }

  function applyMoves(
    nodes: SchematicNode[],
    moves: Map<string, { x: number; y: number }>,
  ): SchematicNode[] {
    return nodes.map((n) => {
      const pos = moves.get(n.id);
      return pos ? ({ ...n, position: pos } as SchematicNode) : n;
    });
  }

  it("re-arms placement on both tags when two devices are dragged without them", () => {
    const { nodes, edges } = scene();
    const draggedIds = new Set(["dev-1", "dev-2"]);
    const dragged = dragBy(nodes, draggedIds, DRAG, 2 * GRID_SIZE);

    // The dogleg this is about. The tag started STUB_GAP from its port and centred on
    // the port row; after the drag it is the whole drag distance out on both axes —
    // orders past the sub-cell drift healStubPortAlignment will close.
    const gap = (ns: SchematicNode[]) => absPos(ns, "stub-1").x - absPos(ns, "dev-1").x;
    expect(gap(nodes) - gap(dragged)).toBe(DRAG);
    expect(absPos(dragged, "stub-1").y + STUB_H_EST / 2 - portRowY(dragged, "dev-1"))
      .toBe(-2 * GRID_SIZE);

    const settled = settleTagsAfterMove(dragged, edges, draggedIds);
    expect(settled).not.toBeNull();
    expect(dataOf(settled!, "stub-1").placed).toBe(false);
    expect(dataOf(settled!, "stub-2").placed).toBe(false);
    // Re-arming only hands the tag back to the placer; it must not move anything itself.
    expect(absPos(settled!, "stub-1")).toEqual(absPos(dragged, "stub-1"));
  });

  it("leaves a co-dragged tag placed — it already rode with its device (#334)", () => {
    const { nodes, edges } = scene();
    const draggedIds = new Set(["dev-1", "stub-1", "dev-2"]);
    const dragged = dragBy(nodes, draggedIds, DRAG, 0);
    const rested = applyMoves(
      dragged,
      snapGroupRestPositions(dragged, draggedIds, { dx: 0, dy: 0 }, "dev-1", edges),
    );
    // It really did ride: the same delta as its device, still centred on the port row.
    expect(absPos(rested, "stub-1").x - absPos(nodes, "stub-1").x)
      .toBe(absPos(rested, "dev-1").x - absPos(nodes, "dev-1").x);
    expect(absPos(rested, "stub-1").y + STUB_H_EST / 2).toBe(portRowY(rested, "dev-1"));

    const settled = settleTagsAfterMove(rested, edges, draggedIds);
    expect(dataOf(settled!, "stub-1").placed).toBe(true);
    expect(dataOf(settled!, "stub-1").userMoved).toBeUndefined();
    expect(dataOf(settled!, "stub-2").placed).toBe(false);
  });

  it("marks a tag dragged clear of its stationary device as hand-placed, and honours it later", () => {
    // Marquee-select two tags on their own and pull them off a cable crossing. The group
    // path never stamped `userMoved`, so re-arming placement on a later device drag would
    // have yanked both back to the port anchor.
    const { nodes, edges } = scene();
    const tagsOnly = new Set(["stub-1", "stub-2"]);
    const pulled = settleTagsAfterMove(dragBy(nodes, tagsOnly, 0, 6 * GRID_SIZE), edges, tagsOnly);
    expect(dataOf(pulled!, "stub-1")).toMatchObject({ userMoved: true, placed: true });
    expect(dataOf(pulled!, "stub-2")).toMatchObject({ userMoved: true, placed: true });

    const devicesOnly = new Set(["dev-1", "dev-2"]);
    expect(settleTagsAfterMove(dragBy(pulled!, devicesOnly, DRAG, 0), edges, devicesOnly)).toBeNull();
  });

  it("leaves a hand-placed tag where the user put it", () => {
    const { nodes, edges } = scene();
    const handPlaced = nodes.map((n) =>
      n.id === "stub-1" ? ({ ...n, data: { ...n.data, userMoved: true } } as SchematicNode) : n,
    );
    const draggedIds = new Set(["dev-1", "dev-2"]);
    const settled = settleTagsAfterMove(dragBy(handPlaced, draggedIds, DRAG, 0), edges, draggedIds);
    expect(dataOf(settled!, "stub-1").placed).toBe(true);
    expect(dataOf(settled!, "stub-2").placed).toBe(false);
  });

  it("leaves a tag whose own device stayed put alone, and reports no change", () => {
    const { nodes, edges } = scene();
    const draggedIds = new Set(["dev-1"]);
    const settled = settleTagsAfterMove(dragBy(nodes, draggedIds, DRAG, 0), edges, draggedIds);
    expect(dataOf(settled!, "stub-2").placed).toBe(true);
    expect(settleTagsAfterMove(nodes, edges, new Set(["dev-9"]))).toBeNull();
    expect(settleTagsAfterMove(nodes, edges, new Set())).toBeNull();
  });

  it("follows a device carried along by a dragged room", () => {
    // Only the room is in the selection; its devices ride in relative coords and
    // snapRoomChildrenToGrid nudges them again afterwards, so their tags moved too.
    const { edges } = scene();
    const nodes: SchematicNode[] = [
      room("room-1", 96, 96),
      ported("dev-1", 64, 32, "room-1"),
      ported("dev-2", 96, 320),
      tag("stub-1", "link-1", 800, 140),
      tag("stub-2", "link-2", 800, 364),
    ];
    const draggedIds = new Set(["room-1"]);
    const settled = settleTagsAfterMove(dragBy(nodes, draggedIds, DRAG, 0), edges, draggedIds);
    expect(dataOf(settled!, "stub-1").placed).toBe(false);
    expect(dataOf(settled!, "stub-2").placed).toBe(true);
  });

  /** scene() with stub-1's leg re-pointed at an inline adapter sitting between the tag and
   *  dev-1 — what stubbing the device→adapter half of an adapted connection leaves (#348). */
  function adaptedScene(): { nodes: SchematicNode[]; edges: ConnectionEdge[] } {
    const { nodes, edges } = scene();
    const adapter = {
      ...ported("adapter-1", 500, 96),
      data: { label: "adapter-1", deviceType: "adapter", ports: [] },
    } as SchematicNode;
    const onward = {
      id: "e-onward", source: "adapter-1", sourceHandle: "sdi-out-1",
      target: "dev-1", targetHandle: "sdi-out-1", data: { signalType: "sdi" },
    } as unknown as ConnectionEdge;
    return {
      nodes: [...nodes, adapter],
      edges: [{ ...edges[0], target: "adapter-1" } as ConnectionEdge, onward, edges[1]],
    };
  }

  it("does not re-arm a tag whose leg ends on a hidden inline adapter", () => {
    // StubLabelNode.tryPlace resolves its anchor as the literal far end of the leg, with
    // no adapter hop — re-arming here would re-pin the tag to the stationary adapter,
    // away from the device that moved. snapGroupRestPositions can hop because it rides
    // the tag by a shift it already knows instead of handing it back to the placer.
    const { nodes, edges } = adaptedScene();
    const draggedIds = new Set(["dev-1"]);
    const dragged = dragBy(nodes, draggedIds, DRAG, 0);

    expect(settleTagsAfterMove(dragged, edges, draggedIds)).toBeNull();
    // Handing over the hidden set does not buy the re-anchor a hop (#356 reads it only
    // for a tag that was itself in the move).
    expect(settleTagsAfterMove(dragged, edges, draggedIds, new Set(["adapter-1"]))).toBeNull();
  });

  it("leaves a tag co-dragged with the device past a hidden adapter unstamped (#356)", () => {
    // Marquee the adapter-side tag together with the device on the far side of the hidden
    // adapter. snapGroupRestPositions rides the tag with that device (#348), but the
    // no-hop host lookup here sees only the stationary adapter, reads "tag moved, device
    // did not", and stamps the ride as a hand placement.
    const { nodes, edges } = adaptedScene();
    const hidden = new Set(["adapter-1"]);
    const draggedIds = new Set(["dev-1", "stub-1"]);
    // The 5px is what makes the ride visible: the group rest correction pulls dev-1 back
    // onto the grid, and only the hop carries the tag along with it.
    const dragged = dragBy(nodes, draggedIds, DRAG + 5, 0);
    const rested = applyMoves(
      dragged,
      snapGroupRestPositions(dragged, draggedIds, { dx: 0, dy: 0 }, "dev-1", edges, hidden),
    );
    expect(absPos(rested, "stub-1").x - absPos(nodes, "stub-1").x).toBe(DRAG);
    expect(absPos(rested, "dev-1").x - absPos(nodes, "dev-1").x).toBe(DRAG);

    expect(settleTagsAfterMove(rested, edges, draggedIds, hidden)).toBeNull();

    // The cost of the stamp, and the payoff for withholding it: Show Adapter and drag the
    // now-visible adapter. Unstamped, the tag re-arms and follows; stamped, it is opted
    // out of every future re-anchor and holds the dogleg until the stub is re-created.
    const shown = new Set(["adapter-1"]);
    const followed = settleTagsAfterMove(dragBy(rested, shown, 0, DRAG), edges, shown);
    expect(dataOf(followed!, "stub-1").placed).toBe(false);

    const stamped = settleTagsAfterMove(rested, edges, draggedIds);
    expect(dataOf(stamped!, "stub-1")).toMatchObject({ userMoved: true, placed: true });
    expect(settleTagsAfterMove(dragBy(stamped!, shown, 0, DRAG), edges, shown)).toBeNull();
  });

  it("still marks a tag hand-dragged alone past a hidden adapter (#356)", () => {
    // Same scene, tag pulled off on its own: nothing rode it, so the stamp is exactly
    // right and the hop host being stationary is what says so.
    const { nodes, edges } = adaptedScene();
    const tagOnly = new Set(["stub-1"]);
    const pulled = settleTagsAfterMove(
      dragBy(nodes, tagOnly, 0, 6 * GRID_SIZE), edges, tagOnly, new Set(["adapter-1"]),
    );
    expect(dataOf(pulled!, "stub-1")).toMatchObject({ userMoved: true, placed: true });
  });

  it("is the settle moveDevice runs too, text stubs (#196) included", () => {
    // Both drag-stop paths and the store's own move share one rule now — the two
    // divergent copies are what let the group path miss the re-anchor in the first place.
    const { nodes, edges } = scene();
    const note = {
      id: "text-stub-1",
      type: "text-stub",
      position: { x: 900, y: 140 },
      data: {
        text: "Client LAN", signalType: "network", anchorNodeId: "dev-1",
        anchorPortId: "sdi-out-2", side: "l", placed: true,
      },
    } as unknown as SchematicNode;
    useSchematicStore.setState({ nodes: [...nodes, note], edges });
    useSchematicStore.getState().moveDevice("dev-1", { x: 96 + DRAG, y: 96 });

    const rested = useSchematicStore.getState().nodes;
    expect(dataOf(rested, "text-stub-1").placed).toBe(false);
    expect(dataOf(rested, "stub-1").placed).toBe(false);
    expect(dataOf(rested, "stub-2").placed).toBe(true); // dev-2 never moved
  });

  it("runs last in the group drag-stop sequence, so the room re-snap's carry survives", () => {
    // The order App.tsx's group branch runs: snapGroupRestPositions, the reparent pass,
    // snapRoomChildrenToGrid, then the settle. A room at a half-cell origin makes the
    // room pass do real work, and the settle must re-arm the tags without undoing it.
    const base = [
      room("room-1", 103, 57),
      ported("dev-1", 64, 32, "room-1"),
      ported("dev-2", 96, 520),
    ];
    const nodes = [
      ...base,
      hangTag(base, "dev-1", "stub-1", "link-1"),
      hangTag(base, "dev-2", "stub-2", "link-2"),
    ];
    const edges = [legTo("dev-1", "stub-1", "link-1"), legTo("dev-2", "stub-2", "link-2")];
    const draggedIds = new Set(["room-1", "dev-2"]);

    const dragged = dragBy(nodes, draggedIds, DRAG, 0);
    const rested = applyMoves(
      dragged,
      snapGroupRestPositions(dragged, draggedIds, { dx: 0, dy: 0 }, "room-1", edges),
    );
    useSchematicStore.setState({ nodes: rested, edges });
    useSchematicStore.getState().snapRoomChildrenToGrid("room-1");
    const carried = useSchematicStore.getState().nodes;
    expectOnGrid(absPos(carried, "dev-1"));
    expect(absPos(carried, "stub-1").y + STUB_H_EST / 2).toBe(portRowY(carried, "dev-1"));

    const settled = settleTagsAfterMove(carried, useSchematicStore.getState().edges, draggedIds);
    expect(dataOf(settled!, "stub-1").placed).toBe(false);
    expect(dataOf(settled!, "stub-2").placed).toBe(false);
    // The #334 carry is intact — the settle re-arms placement, it does not reposition.
    expect(absPos(settled!, "stub-1")).toEqual(absPos(carried, "stub-1"));
    expect(absPos(settled!, "dev-1")).toEqual(absPos(carried, "dev-1"));
  });
});
