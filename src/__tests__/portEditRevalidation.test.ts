/**
 * Editing a connected port's connector/signal type revalidates its connections (#306).
 *
 * Validity was only checked when a connection was made (isValidConnection / onConnect),
 * so editing a connected port into an incompatible state left the cable silently wrong.
 * findInvalidatedConnections re-runs the connect-time rules for every connection the
 * edit touched, and updateDevice stages the failures as pendingPortEditConflicts for
 * the user to disconnect, adapt, or knowingly keep.
 *
 * The store reads editor preferences from localStorage at import time, so a minimal
 * in-memory localStorage is installed before the store is imported.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { findAdaptersForConnectorBridge } from "../connectorTypes";
import { DEVICE_TEMPLATES } from "../deviceLibrary";
import type { PortEditConflict } from "../store";
import type { ConnectionEdge, ConnectorType, DeviceData, DeviceNode, DeviceTemplate, Port, SchematicNode } from "../types";

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
  key() { return null; }
  get length() { return this.m.size; }
}

let useSchematicStore: typeof import("../store")["useSchematicStore"];
let findInvalidatedConnections: typeof import("../store")["findInvalidatedConnections"];

beforeAll(async () => {
  (globalThis as { localStorage?: unknown }).localStorage = new MemStorage();
  if (!globalThis.crypto?.randomUUID) {
    (globalThis as { crypto?: unknown }).crypto = {
      randomUUID: () => "test-" + Math.random().toString(36).slice(2),
    };
  }
  ({ useSchematicStore, findInvalidatedConnections } = await import("../store"));
});

function port(id: string, overrides: Partial<Port> = {}): Port {
  return { id, label: id, signalType: "hdmi", direction: "output", connectorType: "hdmi", ...overrides };
}

function device(id: string, ports: Port[], x = 0): DeviceNode {
  return {
    id,
    type: "device",
    position: { x, y: 0 },
    data: { label: id, deviceType: "source", ports },
  } as DeviceNode;
}

function edge(id: string, source: string, sourceHandle: string, target: string, targetHandle: string, data: ConnectionEdge["data"] = { signalType: "hdmi" }): ConnectionEdge {
  return { id, source, target, sourceHandle, targetHandle, data } as ConnectionEdge;
}

/** One-jack patch panel: a passthrough port whose faces carry the given connectors. */
function panel(id: string, front: ConnectorType, rear: ConnectorType = front): DeviceNode {
  return {
    id,
    type: "device",
    position: { x: 0, y: 0 },
    data: {
      label: id,
      deviceType: "patch-panel",
      ports: [{ id: "p1", label: "1", signalType: "hdmi", direction: "passthrough", frontConnectorType: front, rearConnectorType: rear }],
    },
  } as DeviceNode;
}

/** Player HDMI out → Display HDMI in, connected. */
function baseSchematic(): { nodes: SchematicNode[]; edges: ConnectionEdge[] } {
  const player = device("n1", [port("out1", { direction: "output" })]);
  const display = device("n2", [port("in1", { direction: "input" })], 400);
  return { nodes: [player, display], edges: [edge("e1", "n1", "out1", "n2", "in1")] };
}

function withEditedPort(nodes: SchematicNode[], nodeId: string, portId: string, patch: Partial<Port>): SchematicNode[] {
  return nodes.map((n) => {
    if (n.id !== nodeId) return n;
    const data = n.data as DeviceData;
    return {
      ...n,
      data: { ...data, ports: data.ports.map((p) => (p.id === portId ? { ...p, ...patch } : p)) },
    } as DeviceNode;
  });
}

describe("findInvalidatedConnections", () => {
  it("reports nothing when the edit keeps the connection valid", () => {
    // ethercon natively accepts rj45 — a compatible connector swap stays quiet
    const src = device("n1", [port("out1", { signalType: "ethernet", connectorType: "rj45" })]);
    const tgt = device("n2", [port("in1", { direction: "input", signalType: "ethernet", connectorType: "rj45" })], 400);
    const edges = [edge("e1", "n1", "out1", "n2", "in1", { signalType: "ethernet" })];
    const oldPorts = tgt.data.ports;
    const edited = withEditedPort([src, tgt], "n2", "in1", { connectorType: "ethercon" });
    expect(findInvalidatedConnections(edited, edges, "n2", oldPorts)).toEqual([]);
  });

  it("reports nothing when no connector or signal actually changed", () => {
    const { nodes, edges } = baseSchematic();
    const oldPorts = (nodes[1] as DeviceNode).data.ports;
    const edited = withEditedPort(nodes, "n2", "in1", { label: "Renamed" });
    expect(findInvalidatedConnections(edited, edges, "n2", oldPorts)).toEqual([]);
  });

  it("detects a signal edit that makes the connection invalid", () => {
    const { nodes, edges } = baseSchematic();
    const oldPorts = (nodes[1] as DeviceNode).data.ports;
    const edited = withEditedPort(nodes, "n2", "in1", { signalType: "analog-audio", connectorType: "xlr-3" });
    const conflicts = findInvalidatedConnections(edited, edges, "n2", oldPorts);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].edgeId).toBe("e1");
    expect(conflicts[0].reason).toBe("signal-mismatch");
    expect(conflicts[0].sourcePort.id).toBe("out1");
    expect(conflicts[0].targetPort.id).toBe("in1");
  });

  it("detects a connector-only edit as a connector mismatch", () => {
    const { nodes, edges } = baseSchematic();
    const oldPorts = (nodes[1] as DeviceNode).data.ports;
    const edited = withEditedPort(nodes, "n2", "in1", { connectorType: "bnc" });
    const conflicts = findInvalidatedConnections(edited, edges, "n2", oldPorts);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].reason).toBe("connector-mismatch");
  });

  it("only flags connections touching the edited port", () => {
    const player = device("n1", [port("out1"), port("out2")]);
    const display = device("n2", [port("in1", { direction: "input" }), port("in2", { direction: "input" })], 400);
    const edges = [
      edge("e1", "n1", "out1", "n2", "in1"),
      edge("e2", "n1", "out2", "n2", "in2"),
    ];
    const oldPorts = display.data.ports;
    const edited = withEditedPort([player, display], "n2", "in1", { signalType: "sdi", connectorType: "bnc" });
    const conflicts = findInvalidatedConnections(edited, edges, "n2", oldPorts);
    expect(conflicts.map((c) => c.edgeId)).toEqual(["e1"]);
  });

  it("skips connections already accepted as mismatched", () => {
    const { nodes } = baseSchematic();
    const oldPorts = (nodes[1] as DeviceNode).data.ports;
    const flagged = [edge("e1", "n1", "out1", "n2", "in1", { signalType: "hdmi", connectorMismatch: true })];
    const forced = [edge("e1", "n1", "out1", "n2", "in1", { signalType: "hdmi", allowIncompatible: true })];
    const edited = withEditedPort(nodes, "n2", "in1", { signalType: "analog-audio", connectorType: "xlr-3" });
    expect(findInvalidatedConnections(edited, flagged, "n2", oldPorts)).toEqual([]);
    expect(findInvalidatedConnections(edited, forced, "n2", oldPorts)).toEqual([]);
  });

  it("finds an adapter for a conflicted connector pair via the existing matcher", () => {
    const src = device("n1", [port("out1", { signalType: "analog-audio", connectorType: "xlr-3" })]);
    const tgt = device("n2", [port("in1", { direction: "input", signalType: "analog-audio", connectorType: "xlr-3" })], 400);
    const edges = [edge("e1", "n1", "out1", "n2", "in1", { signalType: "analog-audio" })];
    const oldPorts = tgt.data.ports;
    const edited = withEditedPort([src, tgt], "n2", "in1", { connectorType: "trs-quarter" });
    const conflicts = findInvalidatedConnections(edited, edges, "n2", oldPorts);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].reason).toBe("connector-mismatch");
    const adapters = findAdaptersForConnectorBridge(
      conflicts[0].sourcePort.connectorType!,
      conflicts[0].targetPort.connectorType!,
      conflicts[0].sourcePort.signalType,
      DEVICE_TEMPLATES,
    );
    expect(adapters).toHaveLength(1);
  });

  it("classifies a passthrough face-connector edit by the face the cable uses", () => {
    // Patch-panel front jack (front=hdmi) cabled to an HDMI display; front edited to BNC.
    // The conflict must carry the effective face connectors, not the passthrough port's
    // (undefined) connectorType — otherwise it reads as an HDMI→HDMI signal mismatch.
    const pp = panel("pp", "hdmi");
    const display = device("n2", [port("in1", { direction: "input" })], 400);
    const edges = [edge("e1", "pp", "p1-front", "n2", "in1")];
    const oldPorts = pp.data.ports;
    const edited = withEditedPort([pp, display], "pp", "p1", { frontConnectorType: "bnc" });
    const conflicts = findInvalidatedConnections(edited, edges, "pp", oldPorts);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].reason).toBe("connector-mismatch");
    expect(conflicts[0].sourceConnector).toBe("bnc");
    expect(conflicts[0].targetConnector).toBe("hdmi");
    expect(conflicts[0].sourceSignal).toBe("hdmi");
    expect(conflicts[0].targetSignal).toBe("hdmi");
  });

  it("ignores a rear-face edit when the cable is on the front face", () => {
    const pp = panel("pp", "hdmi");
    const display = device("n2", [port("in1", { direction: "input" })], 400);
    const edges = [edge("e1", "pp", "p1-front", "n2", "in1")];
    const oldPorts = pp.data.ports;
    const edited = withEditedPort([pp, display], "pp", "p1", { rearConnectorType: "bnc" });
    expect(findInvalidatedConnections(edited, edges, "pp", oldPorts)).toEqual([]);
  });

  it("detects a direction flip and reports it as incompatible, not a signal mismatch", () => {
    // Dragging a connected input port into the Outputs section leaves output→output —
    // connect time would refuse it, so the edit must surface a conflict too.
    const { nodes, edges } = baseSchematic();
    const oldPorts = (nodes[1] as DeviceNode).data.ports;
    const edited = withEditedPort(nodes, "n2", "in1", { direction: "output" });
    const conflicts = findInvalidatedConnections(edited, edges, "n2", oldPorts);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].edgeId).toBe("e1");
    expect(conflicts[0].reason).toBe("incompatible");
  });

  it("detects revoking multi-connect on a port carrying two cables", () => {
    const player = device("n1", [port("out1"), port("out2")]);
    const hub = device("n2", [port("in1", { direction: "input", multiConnect: true })], 400);
    const edges = [
      edge("e1", "n1", "out1", "n2", "in1"),
      edge("e2", "n1", "out2", "n2", "in1"),
    ];
    const oldPorts = hub.data.ports;
    const edited = withEditedPort([player, hub], "n2", "in1", { multiConnect: false });
    const conflicts = findInvalidatedConnections(edited, edges, "n2", oldPorts);
    expect(conflicts.map((c) => c.edgeId)).toEqual(["e1", "e2"]);
    expect(conflicts.every((c) => c.reason === "incompatible")).toBe(true);
  });

  it("reports nothing when multi-connect is revoked on a port with a single cable", () => {
    const player = device("n1", [port("out1")]);
    const hub = device("n2", [port("in1", { direction: "input", multiConnect: true })], 400);
    const edges = [edge("e1", "n1", "out1", "n2", "in1")];
    const oldPorts = hub.data.ports;
    const edited = withEditedPort([player, hub], "n2", "in1", { multiConnect: false });
    expect(findInvalidatedConnections(edited, edges, "n2", oldPorts)).toEqual([]);
  });

  it("detects a multicore toggle on one end", () => {
    const { nodes, edges } = baseSchematic();
    const oldPorts = (nodes[1] as DeviceNode).data.ports;
    const edited = withEditedPort(nodes, "n2", "in1", { isMulticable: true });
    const conflicts = findInvalidatedConnections(edited, edges, "n2", oldPorts);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].reason).toBe("incompatible");
  });
});

describe("updateDevice port-edit revalidation flow", () => {
  beforeEach(() => {
    useSchematicStore.setState({
      nodes: [],
      edges: [],
      pendingPortEditConflicts: null,
      pendingIncompatibleConnection: null,
      templatePresets: {},
    });
  });

  function loadBase() {
    const { nodes, edges } = baseSchematic();
    useSchematicStore.setState({ nodes, edges });
  }

  function editDisplayPort(patch: Partial<Port>) {
    const state = useSchematicStore.getState();
    const display = state.nodes.find((n) => n.id === "n2") as DeviceNode;
    const data: DeviceData = {
      ...display.data,
      ports: display.data.ports.map((p) => (p.id === "in1" ? { ...p, ...patch } : p)),
    };
    state.updateDevice("n2", data);
  }

  it("stages conflicts when an edit invalidates a connection", () => {
    loadBase();
    editDisplayPort({ signalType: "analog-audio", connectorType: "xlr-3" });
    const conflicts = useSchematicStore.getState().pendingPortEditConflicts;
    expect(conflicts).toHaveLength(1);
    expect(conflicts![0].edgeId).toBe("e1");
  });

  it("stages nothing for a compatible edit", () => {
    loadBase();
    editDisplayPort({ label: "Renamed" });
    expect(useSchematicStore.getState().pendingPortEditConflicts).toBeNull();
  });

  it("disconnect removes the invalid connection", () => {
    loadBase();
    editDisplayPort({ signalType: "analog-audio", connectorType: "xlr-3" });
    useSchematicStore.getState().resolvePortEditConflict("e1", "disconnect");
    const state = useSchematicStore.getState();
    expect(state.edges.find((e) => e.id === "e1")).toBeUndefined();
    expect(state.pendingPortEditConflicts).toBeNull();
  });

  it("keep flags the connection as a known mismatch", () => {
    loadBase();
    editDisplayPort({ signalType: "analog-audio", connectorType: "xlr-3" });
    useSchematicStore.getState().resolvePortEditConflict("e1", "keep");
    const state = useSchematicStore.getState();
    const kept = state.edges.find((e) => e.id === "e1");
    expect(kept?.data?.connectorMismatch).toBe(true);
    expect(state.pendingPortEditConflicts).toBeNull();
    // A later unrelated edit must not re-prompt for the accepted mismatch
    editDisplayPort({ connectorType: "trs-quarter" });
    expect(useSchematicStore.getState().pendingPortEditConflicts).toBeNull();
  });

  it("insert adapter replaces the invalid cable with two adapter legs", () => {
    const src = device("n1", [port("out1", { signalType: "usb", connectorType: "usb-a" })]);
    const tgt = device("n2", [port("in1", { direction: "input", signalType: "usb", connectorType: "usb-a" })], 400);
    useSchematicStore.setState({
      nodes: [src, tgt],
      edges: [edge("e1", "n1", "out1", "n2", "in1", { signalType: "usb" })],
    });
    const state = useSchematicStore.getState();
    const display = state.nodes.find((n) => n.id === "n2") as DeviceNode;
    state.updateDevice("n2", {
      ...display.data,
      ports: display.data.ports.map((p) => (p.id === "in1" ? { ...p, connectorType: "usb-c" } : p)),
    });

    const conflicts = useSchematicStore.getState().pendingPortEditConflicts;
    expect(conflicts).toHaveLength(1);
    const adapters = findAdaptersForConnectorBridge("usb-a", "usb-c", "usb", DEVICE_TEMPLATES);
    expect(adapters.length).toBeGreaterThan(0);

    useSchematicStore.getState().resolvePortEditConflict("e1", "adapter", adapters[0]);
    const after = useSchematicStore.getState();
    expect(after.pendingPortEditConflicts).toBeNull();
    expect(after.pendingIncompatibleConnection).toBeNull();
    expect(after.edges.find((e) => e.id === "e1")).toBeUndefined();
    const adapterNode = after.nodes.find(
      (n) => n.type === "device" && n.id !== "n1" && n.id !== "n2",
    );
    expect(adapterNode).toBeDefined();
    const legs = after.edges.filter((e) => e.source === adapterNode!.id || e.target === adapterNode!.id);
    expect(legs).toHaveLength(2);

    // The bundled adapter (USB-C (M) → USB-A (F)) only matches this pair in reverse,
    // so the inserted instance is flipped to its used orientation (#310): the USB-C
    // male end becomes the output feeding the display, giving the display-side leg a
    // source-type handle on the adapter — previously that leg's sourceHandle sat on
    // the adapter's strict USB-C input and the canvas never drew it.
    const aPorts = (adapterNode!.data as DeviceData).ports;
    const usbCSide = aPorts.find((p) => p.connectorType === "usb-c")!;
    expect(usbCSide.direction).toBe("output");
    const outLeg = after.edges.find((e) => e.source === adapterNode!.id)!;
    expect(outLeg.sourceHandle).toBe(usbCSide.id);
    expect(outLeg.target).toBe("n2");
  });

  it("adapter insertion on a passthrough conflict bridges the face connectors", () => {
    // Front jack edited hdmi→bnc against an HDMI display; the adapter's BNC end must
    // land on the panel side and both legs must come out genuinely compatible.
    const pp = panel("pp", "hdmi");
    const display = device("n2", [port("in1", { direction: "input" })], 400);
    useSchematicStore.setState({
      nodes: [pp, display],
      edges: [edge("e1", "pp", "p1-front", "n2", "in1")],
    });
    const state = useSchematicStore.getState();
    state.updateDevice("pp", {
      ...pp.data,
      ports: pp.data.ports.map((p) => (p.id === "p1" ? { ...p, frontConnectorType: "bnc" as const } : p)),
    });
    expect(useSchematicStore.getState().pendingPortEditConflicts).toHaveLength(1);

    const bridging: DeviceTemplate = {
      deviceType: "adapter",
      label: "BNC to HDMI Bridge",
      ports: [
        { id: "a1", label: "In", signalType: "hdmi", direction: "input", connectorType: "bnc" },
        { id: "a-out", label: "Out", signalType: "hdmi", direction: "output", connectorType: "hdmi" },
      ],
    };
    useSchematicStore.getState().resolvePortEditConflict("e1", "adapter", bridging);
    const after = useSchematicStore.getState();
    expect(after.pendingIncompatibleConnection).toBeNull();
    expect(after.edges.find((e) => e.id === "e1")).toBeUndefined();
    const legs = after.edges;
    expect(legs).toHaveLength(2);
    // Neither leg is a mismatch: bnc front → bnc in, hdmi out → hdmi in
    expect(legs.every((e) => !e.data?.connectorMismatch)).toBe(true);
    expect(legs.find((e) => e.source === "pp")?.sourceHandle).toBe("p1-front");
  });

  it("adapter legs that do not mate with the face connector are flagged", () => {
    // Same conflict, but the chosen adapter is HDMI on both ends — the panel-side leg
    // still meets a BNC jack, so it must render as a known mismatch, not clean.
    const pp = panel("pp", "hdmi");
    const display = device("n2", [port("in1", { direction: "input" })], 400);
    useSchematicStore.setState({
      nodes: [pp, display],
      edges: [edge("e1", "pp", "p1-front", "n2", "in1")],
    });
    const state = useSchematicStore.getState();
    state.updateDevice("pp", {
      ...pp.data,
      ports: pp.data.ports.map((p) => (p.id === "p1" ? { ...p, frontConnectorType: "bnc" as const } : p)),
    });
    const repeater: DeviceTemplate = {
      deviceType: "adapter",
      label: "HDMI Repeater",
      ports: [
        { id: "r-in", label: "In", signalType: "hdmi", direction: "input", connectorType: "hdmi" },
        { id: "r-out", label: "Out", signalType: "hdmi", direction: "output", connectorType: "hdmi" },
      ],
    };
    useSchematicStore.getState().resolvePortEditConflict("e1", "adapter", repeater);
    const after = useSchematicStore.getState();
    const panelLeg = after.edges.find((e) => e.source === "pp");
    const displayLeg = after.edges.find((e) => e.target === "n2");
    expect(panelLeg?.data?.connectorMismatch).toBe(true);
    expect(displayLeg?.data?.connectorMismatch).toBeUndefined();
  });

  it("stages an incompatible conflict when a port's direction flips", () => {
    loadBase();
    editDisplayPort({ direction: "output" });
    const conflicts = useSchematicStore.getState().pendingPortEditConflicts;
    expect(conflicts).toHaveLength(1);
    expect(conflicts![0].reason).toBe("incompatible");
  });

  it("keeps the cable and the conflict when the chosen adapter cannot bridge it", () => {
    // A project preset can reshape an adapter's ports out from under the template the
    // dialog matched against — the replace must then be a no-op, not a deleted cable.
    const src = device("n1", [port("out1", { signalType: "usb", connectorType: "usb-a" })]);
    const tgt = device("n2", [port("in1", { direction: "input", signalType: "usb", connectorType: "usb-a" })], 400);
    useSchematicStore.setState({
      nodes: [src, tgt],
      edges: [edge("e1", "n1", "out1", "n2", "in1", { signalType: "usb" })],
    });
    const state = useSchematicStore.getState();
    const display = state.nodes.find((n) => n.id === "n2") as DeviceNode;
    state.updateDevice("n2", {
      ...display.data,
      ports: display.data.ports.map((p) => (p.id === "in1" ? { ...p, connectorType: "usb-c" as const } : p)),
    });
    expect(useSchematicStore.getState().pendingPortEditConflicts).toHaveLength(1);

    const adapter: DeviceTemplate = {
      id: "adp-x",
      deviceType: "adapter",
      label: "USB-A to USB-C",
      ports: [
        { id: "a1", label: "In", signalType: "usb", direction: "input", connectorType: "usb-a" },
        { id: "a-out", label: "Out", signalType: "usb", direction: "output", connectorType: "usb-c" },
      ],
    };
    useSchematicStore.setState({
      templatePresets: {
        "adp-x": { ports: [{ id: "p1", label: "P1", signalType: "analog-audio", direction: "input", connectorType: "xlr-3" }] },
      },
    });

    useSchematicStore.getState().resolvePortEditConflict("e1", "adapter", adapter);
    const after = useSchematicStore.getState();
    expect(after.edges.find((e) => e.id === "e1")).toBeDefined();
    expect(after.edges).toHaveLength(1);
    expect(after.nodes).toHaveLength(2);
    expect(after.pendingIncompatibleConnection).toBeNull();
    expect(after.pendingPortEditConflicts).toHaveLength(1);
    expect(after.pendingPortEditConflicts![0].edgeId).toBe("e1");
    expect(after.pendingPortEditConflicts![0].adapterFailed).toBe(true);
  });

  it("undo clears staged conflicts so they cannot act on restored cables", () => {
    loadBase();
    editDisplayPort({ signalType: "analog-audio", connectorType: "xlr-3" });
    expect(useSchematicStore.getState().pendingPortEditConflicts).toHaveLength(1);

    useSchematicStore.getState().undo();
    const undone = useSchematicStore.getState();
    expect(undone.pendingPortEditConflicts).toBeNull();
    // The restored cable is intact and its port is back to HDMI.
    expect(undone.edges.find((e) => e.id === "e1")).toBeDefined();
    const restored = undone.nodes.find((n) => n.id === "n2") as DeviceNode;
    expect(restored.data.ports[0].signalType).toBe("hdmi");
  });

  it("redo re-stages the conflicts of the port edit it re-applies", () => {
    loadBase();
    editDisplayPort({ signalType: "analog-audio", connectorType: "xlr-3" });
    useSchematicStore.getState().undo();
    expect(useSchematicStore.getState().pendingPortEditConflicts).toBeNull();

    useSchematicStore.getState().redo();
    const after = useSchematicStore.getState();
    // The incompatible edit is back, so the dialog must be back with it (#326) —
    // otherwise the cable sits silently invalid on this one path.
    expect(after.pendingPortEditConflicts).toHaveLength(1);
    expect(after.pendingPortEditConflicts![0].edgeId).toBe("e1");
    expect(after.pendingPortEditConflicts![0].reason).toBe("signal-mismatch");
    const redone = after.nodes.find((n) => n.id === "n2") as DeviceNode;
    expect(redone.data.ports[0].signalType).toBe("analog-audio");
  });

  it("redo re-stages a conflict on a port whose id ends in -in", () => {
    // Fixture-shaped ids (spk-xlr-in, laptop-hdmi-out) collide with the handle
    // suffixes, the gap #306 shipped a fix for — redo's revalidation must clear it too.
    const laptop = device("laptop", [
      port("laptop-hdmi-out", { direction: "output", signalType: "hdmi", connectorType: "hdmi" }),
    ]);
    const speaker = device("spk", [
      port("spk-xlr-in", { direction: "input", signalType: "hdmi", connectorType: "hdmi" }),
    ], 400);
    useSchematicStore.setState({
      nodes: [laptop, speaker],
      edges: [edge("e-spk", "laptop", "laptop-hdmi-out", "spk", "spk-xlr-in")],
    });

    const state = useSchematicStore.getState();
    const spk = state.nodes.find((n) => n.id === "spk") as DeviceNode;
    state.updateDevice("spk", {
      ...spk.data,
      ports: spk.data.ports.map((p) => ({ ...p, signalType: "analog-audio" as const, connectorType: "xlr-3" as const })),
    });
    expect(useSchematicStore.getState().pendingPortEditConflicts).toHaveLength(1);

    useSchematicStore.getState().undo();
    expect(useSchematicStore.getState().pendingPortEditConflicts).toBeNull();

    useSchematicStore.getState().redo();
    const after = useSchematicStore.getState();
    expect(after.pendingPortEditConflicts?.map((c) => c.edgeId)).toEqual(["e-spk"]);
  });

  it("redo of an unrelated action stages nothing", () => {
    loadBase();
    editDisplayPort({ label: "Renamed" });
    useSchematicStore.getState().undo();
    useSchematicStore.getState().redo();
    expect(useSchematicStore.getState().pendingPortEditConflicts).toBeNull();
  });

  it("redo of a resolved conflict does not re-prompt for the accepted mismatch", () => {
    loadBase();
    editDisplayPort({ signalType: "analog-audio", connectorType: "xlr-3" });
    useSchematicStore.getState().resolvePortEditConflict("e1", "keep");
    expect(useSchematicStore.getState().pendingPortEditConflicts).toBeNull();

    useSchematicStore.getState().undo();
    useSchematicStore.getState().redo();
    const after = useSchematicStore.getState();
    expect(after.edges.find((e) => e.id === "e1")?.data?.connectorMismatch).toBe(true);
    expect(after.pendingPortEditConflicts).toBeNull();
  });

  it("resolveAll keep flags every conflicted connection at once", () => {
    const player = device("n1", [port("out1"), port("out2")]);
    const display = device("n2", [port("in1", { direction: "input" }), port("in2", { direction: "input" })], 400);
    useSchematicStore.setState({
      nodes: [player, display],
      edges: [
        edge("e1", "n1", "out1", "n2", "in1"),
        edge("e2", "n1", "out2", "n2", "in2"),
      ],
    });
    const state = useSchematicStore.getState();
    state.updateDevice("n2", {
      ...display.data,
      ports: display.data.ports.map((p) => ({ ...p, signalType: "analog-audio" as const, connectorType: "xlr-3" as const })),
    });
    expect(useSchematicStore.getState().pendingPortEditConflicts).toHaveLength(2);

    useSchematicStore.getState().resolveAllPortEditConflicts("keep");
    const after = useSchematicStore.getState();
    expect(after.pendingPortEditConflicts).toBeNull();
    expect(after.edges.every((e) => e.data?.connectorMismatch === true)).toBe(true);
  });
});

describe("findInvalidatedConnections with suffix-shaped port ids", () => {
  // Port ids can themselves end in -in/-out (the seeded fixture's spk-xlr-in,
  // probe-lan-in, ...), and plain ports use the bare id as the edge handle.
  // Stripping the suffix unconditionally made those cables invisible to
  // revalidation — the exact miss the 2026-08-18 test pass caught (#306).
  it("flags a cable on a port whose id literally ends in -in", () => {
    const src = device("s1", [port("s1-audio-out", { direction: "output", signalType: "analog-audio", connectorType: "xlr-3" })]);
    const spk = device("spk", [port("spk-xlr-in", { direction: "input", signalType: "analog-audio", connectorType: "xlr-3" })]);
    const e = edge("e1", "s1", "s1-audio-out", "spk", "spk-xlr-in", { signalType: "analog-audio" });

    const oldPorts = (spk.data as DeviceData).ports;
    const editedSpk = {
      ...spk,
      data: {
        ...spk.data,
        ports: [port("spk-xlr-in", { direction: "input", signalType: "analog-audio", connectorType: "hdmi" })],
      },
    } as DeviceNode;

    const conflicts = findInvalidatedConnections([src, editedSpk], [e], "spk", oldPorts);
    expect(conflicts.map((c) => c.edgeId)).toEqual(["e1"]);
  });

  it("still resolves genuine bidirectional -in/-out handles to their base port", () => {
    const a = device("a", [port("a1", { direction: "bidirectional", signalType: "analog-audio", connectorType: "xlr-3" })]);
    const b = device("b", [port("b1", { direction: "input", signalType: "analog-audio", connectorType: "xlr-3" })]);
    const e = edge("e1", "a", "a1-out", "b", "b1", { signalType: "analog-audio" });

    const oldPorts = (a.data as DeviceData).ports;
    const editedA = {
      ...a,
      data: { ...a.data, ports: [port("a1", { direction: "bidirectional", signalType: "analog-audio", connectorType: "hdmi" })] },
    } as DeviceNode;

    const conflicts = findInvalidatedConnections([editedA, b], [e], "a", oldPorts);
    expect(conflicts.map((c) => c.edgeId)).toEqual(["e1"]);
  });
});

describe("propagateTemplateToInstances revalidation", () => {
  beforeEach(() => {
    useSchematicStore.setState({
      nodes: [],
      edges: [],
      pendingPortEditConflicts: null,
      pendingIncompatibleConnection: null,
      templatePresets: {},
    });
  });

  /** Instance of user template "tpl": one HDMI input linked to template port t-in. */
  function instance(id: string, portId: string): DeviceNode {
    return {
      id,
      type: "device",
      position: { x: 0, y: 0 },
      data: {
        label: id,
        deviceType: "source",
        templateId: "tpl",
        templateVersion: 1,
        ports: [{ id: portId, label: "In", signalType: "hdmi", direction: "input", connectorType: "hdmi", templatePortId: "t-in" }],
      },
    } as DeviceNode;
  }

  /** Template "tpl" v2 whose t-in port carries the given patch over the HDMI baseline. */
  function editedTemplate(patch: Partial<Port>): DeviceTemplate {
    return {
      id: "tpl",
      deviceType: "source",
      label: "Tpl",
      version: 2,
      ports: [{ id: "t-in", label: "In", signalType: "hdmi", direction: "input", connectorType: "hdmi", ...patch }],
    };
  }

  it("stages conflicts for the other instances' cables the propagated edit invalidates", () => {
    const src = device("s1", [port("out1"), port("out2")]);
    useSchematicStore.setState({
      nodes: [src, instance("A", "a1"), instance("B", "b1"), instance("C", "c1")],
      edges: [
        edge("e-b", "s1", "out1", "B", "b1"),
        edge("e-c", "s1", "out2", "C", "c1"),
      ],
    });

    // The editor updates A itself, then propagates to B and C.
    const result = useSchematicStore.getState().propagateTemplateToInstances(
      "tpl",
      editedTemplate({ signalType: "analog-audio", connectorType: "xlr-3" }),
      "A",
    );
    expect(result.updated).toBe(2);

    const conflicts = useSchematicStore.getState().pendingPortEditConflicts;
    expect(conflicts?.map((c) => c.edgeId).sort()).toEqual(["e-b", "e-c"]);
    expect(conflicts?.every((c) => c.reason === "signal-mismatch")).toBe(true);
  });

  it("folds propagated conflicts into ones the edited instance already staged", () => {
    const src = device("s1", [port("out1"), port("out2")]);
    useSchematicStore.setState({
      nodes: [src, instance("A", "a1"), instance("B", "b1")],
      edges: [
        edge("e-a", "s1", "out1", "A", "a1"),
        edge("e-b", "s1", "out2", "B", "b1"),
      ],
    });

    // Mirror the editor's flow: updateDevice on A stages its conflict first...
    const state = useSchematicStore.getState();
    const a = state.nodes.find((n) => n.id === "A") as DeviceNode;
    state.updateDevice("A", {
      ...a.data,
      templateVersion: 2,
      ports: a.data.ports.map((p) => ({ ...p, signalType: "analog-audio" as const, connectorType: "xlr-3" as const })),
    });
    expect(useSchematicStore.getState().pendingPortEditConflicts?.map((c) => c.edgeId)).toEqual(["e-a"]);

    // ...then propagation adds B's, and one dialog covers both.
    useSchematicStore.getState().propagateTemplateToInstances(
      "tpl",
      editedTemplate({ signalType: "analog-audio", connectorType: "xlr-3" }),
      "A",
    );
    const conflicts = useSchematicStore.getState().pendingPortEditConflicts;
    expect(conflicts?.map((c) => c.edgeId).sort()).toEqual(["e-a", "e-b"]);
    const staged: PortEditConflict = conflicts![1];
    expect(staged.sourceSignal).toBe("hdmi");
    expect(staged.targetSignal).toBe("analog-audio");
  });

  it("stages one conflict for a cable daisy-chained between two updated instances", () => {
    // The cable touches a changed port on each end, so B's revalidation and C's both
    // find it — it must still surface as a single conflict.
    const chain = (id: string): DeviceNode =>
      ({
        id,
        type: "device",
        position: { x: 0, y: 0 },
        data: {
          label: id,
          deviceType: "source",
          templateId: "tpl",
          templateVersion: 1,
          ports: [
            { id: `${id}o`, label: "Out", signalType: "hdmi", direction: "output", connectorType: "hdmi", templatePortId: "t-out" },
            { id: `${id}i`, label: "In", signalType: "hdmi", direction: "input", connectorType: "hdmi", templatePortId: "t-in" },
          ],
        },
      }) as DeviceNode;
    useSchematicStore.setState({
      nodes: [chain("A"), chain("B"), chain("C")],
      edges: [edge("e-bc", "B", "Bo", "C", "Ci")],
    });

    const result = useSchematicStore.getState().propagateTemplateToInstances(
      "tpl",
      {
        id: "tpl",
        deviceType: "source",
        label: "Tpl",
        version: 2,
        ports: [
          { id: "t-out", label: "Out", signalType: "sdi", direction: "output", connectorType: "bnc" },
          { id: "t-in", label: "In", signalType: "analog-audio", direction: "input", connectorType: "xlr-3" },
        ],
      },
      "A",
    );
    expect(result.updated).toBe(2);
    expect(useSchematicStore.getState().pendingPortEditConflicts?.map((c) => c.edgeId)).toEqual(["e-bc"]);
  });

  it("stages nothing when the propagated edit keeps every cable valid", () => {
    const src = device("s1", [port("out1")]);
    useSchematicStore.setState({
      nodes: [src, instance("A", "a1"), instance("B", "b1")],
      edges: [edge("e-b", "s1", "out1", "B", "b1")],
    });
    useSchematicStore.getState().propagateTemplateToInstances(
      "tpl",
      editedTemplate({ label: "Renamed In" }),
      "A",
    );
    expect(useSchematicStore.getState().pendingPortEditConflicts).toBeNull();
  });
});

describe("syncDeviceFromTemplate revalidation", () => {
  beforeEach(() => {
    useSchematicStore.setState({
      nodes: [],
      edges: [],
      pendingPortEditConflicts: null,
      pendingIncompatibleConnection: null,
      customTemplates: [],
    });
  });

  /** A drifted instance of user template "tpl": the device is still HDMI, the template
   *  has moved to XLR. Syncing keeps the device-side port id, so a live cable survives
   *  the sync in an invalid state unless the sync stages a conflict. */
  function drifted(templatePort: Partial<Port>, devicePortId = "amp-xlr-in-1") {
    const src = device("s1", [port("out1")]);
    const inst = {
      id: "amp",
      type: "device",
      position: { x: 400, y: 0 },
      data: {
        label: "Amp",
        deviceType: "amplifier",
        templateId: "tpl",
        templateVersion: 1,
        ports: [{ id: devicePortId, label: "XLR In 1", signalType: "hdmi", direction: "input", connectorType: "hdmi", templatePortId: "t-in" }],
      },
    } as DeviceNode;
    useSchematicStore.setState({
      nodes: [src, inst],
      edges: [edge("e-amp", "s1", "out1", "amp", devicePortId)],
      customTemplates: [{
        id: "tpl",
        deviceType: "amplifier",
        label: "Amp",
        version: 2,
        ports: [{ id: "t-in", label: "XLR In 1", signalType: "hdmi", direction: "input", connectorType: "hdmi", ...templatePort }],
      } as DeviceTemplate],
    });
  }

  it("stages the conflicts a template sync strands, at the moment of the sync", () => {
    drifted({ signalType: "analog-audio", connectorType: "xlr-3" });
    expect(useSchematicStore.getState().syncDeviceFromTemplate("amp")).not.toBeNull();
    const conflicts = useSchematicStore.getState().pendingPortEditConflicts;
    expect(conflicts?.map((c) => c.edgeId)).toEqual(["e-amp"]);
    expect(conflicts![0].reason).toBe("signal-mismatch");
  });

  it("redoing a sync stages the same one conflict, not a second", () => {
    // Redo revalidates whatever the restore changed (#326), and a sync keeps port ids
    // stable — so without staging at the action the dialog appeared only on redo.
    drifted({ signalType: "analog-audio", connectorType: "xlr-3" });
    useSchematicStore.getState().syncDeviceFromTemplate("amp");
    useSchematicStore.getState().dismissPortEditConflicts();

    useSchematicStore.getState().undo();
    expect(useSchematicStore.getState().pendingPortEditConflicts).toBeNull();

    useSchematicStore.getState().redo();
    expect(useSchematicStore.getState().pendingPortEditConflicts?.map((c) => c.edgeId)).toEqual(["e-amp"]);
  });

  it("stages nothing when the sync leaves every cable valid", () => {
    drifted({ label: "Program In" }, "amp-hdmi-in");
    useSchematicStore.getState().syncDeviceFromTemplate("amp");
    expect(useSchematicStore.getState().pendingPortEditConflicts).toBeNull();
    useSchematicStore.getState().undo();
    useSchematicStore.getState().redo();
    expect(useSchematicStore.getState().pendingPortEditConflicts).toBeNull();
  });
});
