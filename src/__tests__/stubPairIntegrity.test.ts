/**
 * #318 — "Rerouting a stub leaves '?' on both ends of the link".
 *
 * A stubbed connection is two legs sharing a linkedConnectionId, each terminating at a
 * stub-label tag. Removing ONE leg (a fumbled reconnect drag, or Delete on a single
 * selected leg) used to leave the partner leg and both tags behind. StubLabelNode renders
 * "?" whenever it can't find its own leg OR its partner leg, so a half-removed link showed
 * "?" at BOTH ends — exactly the reported symptom. These tests drive the real store paths.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { resolveStubLabelParts } from "../stubLabelResolve";
import type { Connection } from "@xyflow/react";
import type { ConnectionEdge, SchematicNode, StubLabelData } from "../types";

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
let setReconnectingEdgeId: typeof import("../store").setReconnectingEdgeId;

beforeAll(async () => {
  installLocalStorageStub();
  ({ useSchematicStore, setReconnectingEdgeId } = await import("../store"));
});
afterAll(() => { vi.unstubAllGlobals(); });
beforeEach(() => {
  useSchematicStore.getState().newSchematic();
  useSchematicStore.setState({ toasts: [] }); // newSchematic leaves them standing
});

const LINK = "link-7c31e0a2";

/** dev-cam ──▶ [tag-src]   [tag-tgt] ──▶ dev-switcher */
function seedStubbedConnection() {
  const nodes: SchematicNode[] = [
    { id: "dev-cam", type: "device", position: { x: 0, y: 100 },
      data: { label: "CAM-01", deviceType: "camera",
        ports: [{ id: "p1", label: "SDI OUT", signalType: "sdi", direction: "output" }] } } as unknown as SchematicNode,
    { id: "dev-switcher", type: "device", position: { x: 900, y: 100 },
      data: { label: "SWITCHER", deviceType: "misc",
        ports: [{ id: "p1", label: "SDI IN 1", signalType: "sdi", direction: "input" }] } } as unknown as SchematicNode,
    { id: "stub-e1-src", type: "stub-label", position: { x: 208, y: 141 }, zIndex: 100,
      measured: { width: 137, height: 14 },
      data: { signalType: "sdi", linkedConnectionId: LINK, side: "source", placed: true } } as unknown as SchematicNode,
    { id: "stub-e1-tgt", type: "stub-label", position: { x: 699, y: 141 }, zIndex: 100,
      measured: { width: 137, height: 14 },
      data: { signalType: "sdi", linkedConnectionId: LINK, side: "target", placed: true } } as unknown as SchematicNode,
  ];
  const edges: ConnectionEdge[] = [
    { id: "e1-src", source: "dev-cam", sourceHandle: "p1", target: "stub-e1-src", targetHandle: "l",
      data: { signalType: "sdi", linkedConnectionId: LINK, cableId: "SDI-001" } } as unknown as ConnectionEdge,
    { id: "e1-tgt", source: "stub-e1-tgt", sourceHandle: "r", target: "dev-switcher", targetHandle: "p1",
      data: { signalType: "sdi", linkedConnectionId: LINK } } as unknown as ConnectionEdge,
  ];
  useSchematicStore.setState({ nodes, edges });
}

/** Give the target half a user-dragged path handle, with its waypoint node in place. */
function addPathHandleToTargetLeg() {
  const s = useSchematicStore.getState();
  useSchematicStore.setState({
    edges: s.edges.map((e) =>
      e.id === "e1-tgt" ? { ...e, data: { ...e.data!, manualWaypoints: [{ x: 800, y: 300 }] } } : e,
    ),
    nodes: [
      ...s.nodes,
      { id: "wp-e1-tgt-0", type: "waypoint", position: { x: 800, y: 300 }, zIndex: 100,
        data: { edgeId: "e1-tgt", index: 0 } } as unknown as SchematicNode,
    ],
  });
}

/** Mirrors StubLabelNode's label selector: "" (rendered as "?") when either leg is missing. */
function tagResolves(tagId: string): boolean {
  const s = useSchematicStore.getState();
  const tag = s.nodes.find((n) => n.id === tagId);
  if (!tag) return false;
  const data = tag.data as StubLabelData;
  const ownEdge = s.edges.find((e) => (data.side === "source" ? e.target : e.source) === tagId);
  if (!ownEdge) return false;
  return s.edges.some((e) => e.data?.linkedConnectionId === data.linkedConnectionId && e.id !== ownEdge.id);
}

describe("stubbed connections survive or vanish as a pair (#318)", () => {
  it("both tags resolve while the link is whole", () => {
    seedStubbedConnection();
    expect(tagResolves("stub-e1-src")).toBe(true);
    expect(tagResolves("stub-e1-tgt")).toBe(true);
  });

  it("deleting one leg removes the whole link instead of stranding two '?' tags", () => {
    seedStubbedConnection();
    useSchematicStore.getState().deleteConnection("e1-tgt");

    const s = useSchematicStore.getState();
    expect(s.edges.filter((e) => e.data?.linkedConnectionId === LINK)).toEqual([]);
    expect(s.nodes.filter((n) => n.type === "stub-label")).toEqual([]);
    // The devices themselves are untouched.
    expect(s.nodes.map((n) => n.id).sort()).toEqual(["dev-cam", "dev-switcher"]);
  });

  it("deleting a stub tag takes its partner leg and tag with it", () => {
    seedStubbedConnection();
    useSchematicStore.getState().deleteNode("stub-e1-src");

    const s = useSchematicStore.getState();
    expect(s.edges.filter((e) => e.data?.linkedConnectionId === LINK)).toEqual([]);
    expect(s.nodes.filter((n) => n.type === "stub-label")).toEqual([]);
  });

  it("React Flow's own remove change also cascades the pair", () => {
    seedStubbedConnection();
    useSchematicStore.getState().onEdgesChange([{ id: "e1-src", type: "remove" }]);

    const s = useSchematicStore.getState();
    expect(s.edges).toEqual([]);
    expect(s.nodes.filter((n) => n.type === "stub-label")).toEqual([]);
  });

  it("deleting one device drops the stubbed connection it carried, not just its own leg", () => {
    seedStubbedConnection();
    useSchematicStore.getState().deleteNode("dev-switcher");

    const s = useSchematicStore.getState();
    expect(s.edges).toEqual([]);
    expect(s.nodes.map((n) => n.id)).toEqual(["dev-cam"]);
  });

  it("takes the cascaded half's path handles with it, via deleteConnection", () => {
    seedStubbedConnection();
    addPathHandleToTargetLeg();
    useSchematicStore.getState().deleteConnection("e1-src");

    const s = useSchematicStore.getState();
    expect(s.edges).toEqual([]);
    // The path handle belonged to the OTHER half — the one the cascade removed. It must
    // not survive as a draggable node (and be saved) just because the pair reconcile ran
    // after the waypoint reconcile.
    expect(s.nodes.map((n) => n.id).sort()).toEqual(["dev-cam", "dev-switcher"]);
  });

  it("takes the cascaded half's path handles with it, via onEdgesChange", () => {
    seedStubbedConnection();
    addPathHandleToTargetLeg();
    useSchematicStore.getState().onEdgesChange([{ id: "e1-src", type: "remove" }]);

    const s = useSchematicStore.getState();
    expect(s.edges).toEqual([]);
    expect(s.nodes.map((n) => n.id).sort()).toEqual(["dev-cam", "dev-switcher"]);
  });

  it("removes both legs and both tags when the whole stubbed connection was selected", () => {
    seedStubbedConnection();
    useSchematicStore.setState({
      edges: useSchematicStore.getState().edges.map((e) => ({ ...e, selected: true })),
    });
    useSchematicStore.getState().removeSelected();

    const s = useSchematicStore.getState();
    expect(s.edges).toEqual([]);
    expect(s.nodes.filter((n) => n.type === "stub-label")).toEqual([]);
  });

  it("says nothing about the cascade — the whole connection dying is the obvious result", () => {
    // 318-3: the cascade toast was removed. Deleting one leg still takes the pair, quietly.
    seedStubbedConnection();
    useSchematicStore.getState().deleteConnection("e1-tgt");
    expect(useSchematicStore.getState().toasts).toEqual([]);
  });

  it("reports the cascade count on its return value, not just the toast", () => {
    // The MCP bridge's delete_connection has no toast to read — it needs deleteConnection's
    // own return value to tell an agent it removed more than the id it was asked for.
    seedStubbedConnection();
    const result = useSchematicStore.getState().deleteConnection("e1-tgt");
    expect(result).toEqual({ removedStubLinks: 1 });
  });

  it("returns zero cascaded links for a plain connection or an unknown id", () => {
    seedStubbedConnection();
    useSchematicStore.setState({
      edges: [...useSchematicStore.getState().edges,
        { id: "plain", source: "dev-cam", sourceHandle: "p1",
          target: "dev-switcher", targetHandle: "p1", data: { signalType: "sdi" } } as unknown as ConnectionEdge],
    });
    expect(useSchematicStore.getState().deleteConnection("plain")).toEqual({ removedStubLinks: 0 });
    expect(useSchematicStore.getState().deleteConnection("no-such-edge")).toEqual({ removedStubLinks: 0 });
  });

  it("leaves an untouched stubbed connection completely alone", () => {
    seedStubbedConnection();
    const before = useSchematicStore.getState();
    const nodesBefore = before.nodes;
    const edgesBefore = before.edges;
    // Deleting an unrelated plain connection must not disturb the pair.
    useSchematicStore.setState({
      edges: [...edgesBefore, { id: "plain", source: "dev-cam", sourceHandle: "p1",
        target: "dev-switcher", targetHandle: "p1", data: { signalType: "sdi" } } as unknown as ConnectionEdge],
    });
    useSchematicStore.getState().deleteConnection("plain");

    const s = useSchematicStore.getState();
    expect(s.edges.map((e) => e.id).sort()).toEqual(["e1-src", "e1-tgt"]);
    expect(s.nodes.length).toBe(nodesBefore.length);
    expect(tagResolves("stub-e1-src")).toBe(true);
    expect(tagResolves("stub-e1-tgt")).toBe(true);
  });
});

/**
 * 318-2 follow-up. Cancelling a fumbled re-route taught users a workflow that exists
 * nowhere else in the app. A stub leg's DEVICE end is a true source/target, so it now
 * behaves like any other connection end: dropped on a compatible port it re-routes,
 * dropped in empty space it disconnects (taking the partner leg and both tags, since
 * half a stubbed connection is not a thing that can exist). Only the TAG end — not a
 * port, and not connectable — still refuses the drag.
 */
describe("a stub leg's device end re-routes and disconnects like any other end", () => {
  /** A third device to re-route onto: a bidirectional port, so its handles carry the
   *  -in/-out suffixes a real drop target has. */
  function addMonitor() {
    useSchematicStore.setState({
      nodes: [
        ...useSchematicStore.getState().nodes,
        { id: "dev-monitor", type: "device", position: { x: 900, y: 400 },
          data: { label: "MON-01", deviceType: "monitor",
            ports: [{ id: "p-mon-sdi", label: "SDI 1", signalType: "sdi", direction: "bidirectional" }] },
        } as unknown as SchematicNode,
      ],
    });
  }

  /** A recorder to test the drop rules against: an SDI input the leg may land on, an SDI
   *  output it may not (two sources on one cable), and an analog-audio input it may not. */
  function addRecorder() {
    useSchematicStore.setState({
      nodes: [
        ...useSchematicStore.getState().nodes,
        { id: "dev-recorder", type: "device", position: { x: 900, y: 700 },
          data: { label: "REC-01", deviceType: "misc", ports: [
            { id: "p-rec-sdi-in", label: "SDI IN", signalType: "sdi", direction: "input" },
            { id: "p-rec-sdi-out", label: "SDI OUT", signalType: "sdi", direction: "output" },
            { id: "p-rec-aud-in", label: "ANALOG IN", signalType: "analog-audio", direction: "input" },
          ] },
        } as unknown as SchematicNode,
      ],
    });
  }

  const edge = (id: string) => useSchematicStore.getState().edges.find((e) => e.id === id)!;

  /** The gate React Flow applies before it will ever call onReconnect: a drop that fails
   *  isValidConnection never reaches the store's re-route path, it falls through to the
   *  empty-space disconnect. Mirrors onReconnectStart by marking the dragged leg so the
   *  duplicate-handle guards ignore it. */
  const dropIsAccepted = (draggedEdgeId: string, drop: Connection): boolean => {
    setReconnectingEdgeId(draggedEdgeId);
    try {
      return useSchematicStore.getState().isValidConnection(drop);
    } finally {
      setReconnectingEdgeId(null);
    }
  };

  /** The parts the tag would render, resolved out of live state exactly as the canvas does. */
  const tagParts = (tagId: string) => {
    const s = useSchematicStore.getState();
    const tag = s.nodes.find((n) => n.id === tagId)!;
    return resolveStubLabelParts(tagId, tag.data as StubLabelData, { nodes: s.nodes, edges: s.edges });
  };

  it("re-routes the device end onto a new port, leaving the pair whole", () => {
    seedStubbedConnection();
    addMonitor();
    const drop: Connection = {
      source: "stub-e1-tgt", sourceHandle: "r", target: "dev-monitor", targetHandle: "p-mon-sdi-in",
    };
    // Without this the gesture never gets as far as the store: React Flow would refuse the
    // drop and the release would be read as empty space, silently deleting the pair.
    expect(dropIsAccepted("e1-tgt", drop)).toBe(true);
    const outcome = useSchematicStore.getState().reconnectConnectionEnd(edge("e1-tgt"), drop);

    expect(outcome).toBe("reconnected");
    const s = useSchematicStore.getState();
    const leg = s.edges.find((e) => e.id === "e1-tgt")!;
    expect(leg.target).toBe("dev-monitor");
    expect(leg.targetHandle).toBe("p-mon-sdi-in");
    // Same connection id — cable IDs, path handles and patch hops are keyed by it.
    expect(s.edges.map((e) => e.id).sort()).toEqual(["e1-src", "e1-tgt"]);
    expect(leg.data?.linkedConnectionId).toBe(LINK);
    expect(s.nodes.filter((n) => n.type === "stub-label").map((n) => n.id).sort())
      .toEqual(["stub-e1-src", "stub-e1-tgt"]);
    expect(tagResolves("stub-e1-src")).toBe(true);
    expect(tagResolves("stub-e1-tgt")).toBe(true);
  });

  it("judges the drop against the device at the far end of the pair, not the tag", () => {
    seedStubbedConnection();
    addRecorder();
    // e1-tgt is the sink half of CAM-01's SDI OUT, so only a port that could take that
    // cable is a legal drop.
    const onto = (handle: string): boolean =>
      dropIsAccepted("e1-tgt", {
        source: "stub-e1-tgt", sourceHandle: "r", target: "dev-recorder", targetHandle: handle,
      });
    expect(onto("p-rec-sdi-in")).toBe(true);
    expect(onto("p-rec-sdi-out")).toBe(false);  // two outputs on one cable
    expect(onto("p-rec-aud-in")).toBe(false);   // wrong signal for the far port

    // Dropped back on the port it is already plugged into: the pair's own two legs never
    // count against the occupancy guard, or a leg could never be put back where it was.
    expect(dropIsAccepted("e1-tgt", {
      source: "stub-e1-tgt", sourceHandle: "r", target: "dev-switcher", targetHandle: "p1",
    })).toBe(true);

    // Once another cable holds that SDI input, it is occupied like any other port.
    addMonitor();
    useSchematicStore.setState({
      edges: [...useSchematicStore.getState().edges,
        { id: "plain", source: "dev-monitor", sourceHandle: "p-mon-sdi-out",
          target: "dev-recorder", targetHandle: "p-rec-sdi-in", data: { signalType: "sdi" } } as unknown as ConnectionEdge],
    });
    expect(onto("p-rec-sdi-in")).toBe(false);
  });

  it("re-points both tags at the new endpoint", () => {
    seedStubbedConnection();
    addMonitor();
    expect(tagParts("stub-e1-src")).toMatchObject({ farLabel: "SWITCHER", farPort: "SDI IN 1" });

    const drop: Connection = {
      source: "stub-e1-tgt", sourceHandle: "r", target: "dev-monitor", targetHandle: "p-mon-sdi-in",
    };
    expect(dropIsAccepted("e1-tgt", drop)).toBe(true);
    useSchematicStore.getState().reconnectConnectionEnd(edge("e1-tgt"), drop);

    // The far tag names the device at the OTHER end of the pair — now the monitor.
    expect(tagParts("stub-e1-src")).toMatchObject({ farLabel: "MON-01", farPort: "SDI 1" });
    // The near tag still names the camera it was always pointing at.
    expect(tagParts("stub-e1-tgt")).toMatchObject({ farLabel: "CAM-01", farPort: "SDI OUT" });
  });

  it("lets the re-routed leg's tag follow its port, unless the user placed it", () => {
    seedStubbedConnection();
    addMonitor();
    const drop: Connection = { source: "stub-e1-tgt", sourceHandle: "r", target: "dev-monitor", targetHandle: "p-mon-sdi-in" };
    expect(dropIsAccepted("e1-tgt", drop)).toBe(true);
    useSchematicStore.getState().reconnectConnectionEnd(edge("e1-tgt"), drop);
    // placed:false re-runs the one-shot auto-place, which re-anchors the box beside the
    // new port (the same thing a device move does, #182).
    const tag = () => useSchematicStore.getState().nodes.find((n) => n.id === "stub-e1-tgt")!.data as StubLabelData;
    expect(tag().placed).toBe(false);

    // A hand-placed tag stays exactly where the user put it.
    useSchematicStore.getState().undo();
    useSchematicStore.setState({
      nodes: useSchematicStore.getState().nodes.map((n) =>
        n.id === "stub-e1-tgt" ? { ...n, data: { ...n.data, userMoved: true } } : n,
      ) as SchematicNode[],
    });
    useSchematicStore.getState().reconnectConnectionEnd(edge("e1-tgt"), drop);
    expect(tag().placed).toBe(true);
  });

  it("costs exactly one undo step to put the re-routed end back", () => {
    seedStubbedConnection();
    addMonitor();
    const drop: Connection = {
      source: "stub-e1-tgt", sourceHandle: "r", target: "dev-monitor", targetHandle: "p-mon-sdi-in",
    };
    expect(dropIsAccepted("e1-tgt", drop)).toBe(true);
    useSchematicStore.getState().reconnectConnectionEnd(edge("e1-tgt"), drop);
    expect(useSchematicStore.getState().undoSize).toBe(1);

    useSchematicStore.getState().undo();
    const leg = edge("e1-tgt");
    expect(leg.target).toBe("dev-switcher");
    expect(leg.targetHandle).toBe("p1");
    expect(useSchematicStore.getState().undoSize).toBe(0);
  });

  it("deletes the whole stubbed connection when the device end is dropped in empty space", () => {
    seedStubbedConnection();
    const outcome = useSchematicStore.getState().disconnectConnectionEnd("e1-tgt", "dev-switcher");

    expect(outcome).toBe("deleted");
    const s = useSchematicStore.getState();
    expect(s.edges).toEqual([]);
    expect(s.nodes.filter((n) => n.type === "stub-label")).toEqual([]);
    expect(s.nodes.map((n) => n.id).sort()).toEqual(["dev-cam", "dev-switcher"]);
  });

  it("costs exactly one undo step to bring the deleted pair and its route back", () => {
    seedStubbedConnection();
    addPathHandleToTargetLeg();
    useSchematicStore.getState().disconnectConnectionEnd("e1-src", "dev-cam");
    expect(useSchematicStore.getState().undoSize).toBe(1);

    useSchematicStore.getState().undo();
    const s = useSchematicStore.getState();
    expect(s.edges.map((e) => e.id).sort()).toEqual(["e1-src", "e1-tgt"]);
    expect(s.nodes.filter((n) => n.type === "stub-label").map((n) => n.id).sort())
      .toEqual(["stub-e1-src", "stub-e1-tgt"]);
    expect(edge("e1-src").source).toBe("dev-cam");
    // The hand-routed partner leg comes back with its path handle, not straightened.
    expect(edge("e1-tgt").data?.manualWaypoints).toEqual([{ x: 800, y: 300 }]);
    expect(s.nodes.some((n) => n.id === "wp-e1-tgt-0")).toBe(true);
    expect(tagResolves("stub-e1-src")).toBe(true);
    expect(tagResolves("stub-e1-tgt")).toBe(true);
    expect(useSchematicStore.getState().undoSize).toBe(0);
  });

  it("undoes an empty-space disconnect without hijacking the selection", () => {
    seedStubbedConnection();
    // The user had a device picked out before the drag; the disconnect isolates the leg
    // internally to reuse the Delete path, and undo must not hand that back as the state
    // to restore — the pair would come back selected and the next Delete would wipe it.
    useSchematicStore.setState({
      nodes: useSchematicStore.getState().nodes.map((n) =>
        n.id === "dev-cam" ? { ...n, selected: true } : n,
      ) as SchematicNode[],
    });
    useSchematicStore.getState().disconnectConnectionEnd("e1-tgt", "dev-switcher");
    useSchematicStore.getState().undo();

    const s = useSchematicStore.getState();
    expect(s.nodes.filter((n) => n.selected).map((n) => n.id)).toEqual(["dev-cam"]);
    expect(s.edges.filter((e) => e.selected)).toEqual([]);
  });

  it("refuses a drag holding the TAG end, changing nothing and costing no undo step", () => {
    seedStubbedConnection();
    addMonitor();
    const before = useSchematicStore.getState();

    // Released over empty space.
    expect(useSchematicStore.getState().disconnectConnectionEnd("e1-tgt", "stub-e1-tgt"))
      .toBe("stub-label-end");
    // Released on a port — the tag would be left with no leg and "?" at both ends (#318).
    // React Flow is happy with the drop (both ends are real ports), so the refusal has to
    // come from the store.
    const drop: Connection = {
      source: "dev-monitor", sourceHandle: "p-mon-sdi-out", target: "dev-switcher", targetHandle: "p1",
    };
    expect(dropIsAccepted("e1-tgt", drop)).toBe(true);
    expect(useSchematicStore.getState().reconnectConnectionEnd(edge("e1-tgt"), drop)).toBe("stub-label-end");

    const s = useSchematicStore.getState();
    expect(s.edges).toEqual(before.edges);
    expect(s.nodes).toEqual(before.nodes);
    expect(s.undoSize).toBe(0);
  });

  it("disconnects a plain connection the same way, in one undo step", () => {
    seedStubbedConnection();
    useSchematicStore.setState({
      edges: [...useSchematicStore.getState().edges,
        { id: "plain", source: "dev-cam", sourceHandle: "p1",
          target: "dev-switcher", targetHandle: "p1", data: { signalType: "sdi" } } as unknown as ConnectionEdge],
    });
    expect(useSchematicStore.getState().disconnectConnectionEnd("plain", "dev-switcher")).toBe("deleted");

    const s = useSchematicStore.getState();
    expect(s.edges.map((e) => e.id).sort()).toEqual(["e1-src", "e1-tgt"]);
    expect(s.undoSize).toBe(1);
  });

  it("does nothing for a connection that is already gone", () => {
    seedStubbedConnection();
    addMonitor();
    expect(useSchematicStore.getState().disconnectConnectionEnd("no-such-edge", "dev-cam")).toBe("none");
    expect(useSchematicStore.getState().reconnectConnectionEnd(
      { id: "no-such-edge", source: "dev-cam", target: "dev-switcher" },
      { source: "dev-cam", sourceHandle: "p1", target: "dev-monitor", targetHandle: "p-mon-sdi-in" },
    )).toBe("none");
    expect(useSchematicStore.getState().undoSize).toBe(0);
  });
});
