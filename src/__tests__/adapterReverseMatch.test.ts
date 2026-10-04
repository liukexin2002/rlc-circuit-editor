/**
 * Adapter matching works in both drag directions.
 *
 * `USB-A (M) → RJ45 (F) Adapter` declares a USB input and an Ethernet output, so it
 * was only ever found when dragging USB→Ethernet. Bidirectional ports connect to
 * inputs and outputs alike, so the same template is now matched in reverse rather
 * than the library carrying a mirrored copy of every adapter.
 *
 * The store reads editor preferences from localStorage at import time, so a minimal
 * in-memory localStorage is installed before the store is imported.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  findAdaptersForConnectorBridge,
  findAdaptersForSignalBridge,
  resolveConnectorBridgePorts,
  resolveSignalBridgePorts,
} from "../connectorTypes";
import { DEVICE_TEMPLATES } from "../deviceLibrary";
import type { ConnectionEdge, ConnectorType, DeviceTemplate, Port, SchematicNode, SignalType } from "../types";

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

beforeAll(async () => {
  (globalThis as { localStorage?: unknown }).localStorage = new MemStorage();
  if (!globalThis.crypto?.randomUUID) {
    (globalThis as { crypto?: unknown }).crypto = {
      randomUUID: () => "test-" + Math.random().toString(36).slice(2),
    };
  }
  ({ useSchematicStore } = await import("../store"));
});

const USB_ETH_ADAPTER = "USB-A (M) → RJ45 (F) Adapter";

function template(label: string, ports: Port[]): DeviceTemplate {
  return { label, deviceType: "adapter", ports } as DeviceTemplate;
}

const usbToEth = template("USB→ETH", [
  { id: "p1", label: "USB In", signalType: "usb", direction: "input", connectorType: "usb-a", directAttach: true },
  { id: "p2", label: "Eth Out", signalType: "ethernet", direction: "output", connectorType: "rj45" },
]);

describe("findAdaptersForSignalBridge — reverse matching", () => {
  it("still matches in the declared direction", () => {
    const found = findAdaptersForSignalBridge("usb", "ethernet", [usbToEth]);
    expect(found.map((t) => t.label)).toEqual(["USB→ETH"]);
  });

  it("matches the same template dragged the other way", () => {
    const found = findAdaptersForSignalBridge("ethernet", "usb", [usbToEth]);
    expect(found.map((t) => t.label)).toEqual(["USB→ETH"]);
  });

  it("does not match signals the adapter has no port for", () => {
    expect(findAdaptersForSignalBridge("hdmi", "usb", [usbToEth])).toEqual([]);
    expect(findAdaptersForSignalBridge("ethernet", "sdi", [usbToEth])).toEqual([]);
  });

  it("still ignores templates that are not adapters", () => {
    const notAnAdapter = { ...usbToEth, deviceType: "converter" } as DeviceTemplate;
    expect(findAdaptersForSignalBridge("ethernet", "usb", [notAnAdapter])).toEqual([]);
  });

  it("finds the bundled USB-A → RJ45 dongle when dragging Ethernet → USB", () => {
    const found = findAdaptersForSignalBridge("ethernet", "usb", DEVICE_TEMPLATES);
    expect(found.map((t) => t.label)).toContain(USB_ETH_ADAPTER);
  });

  it("leaves Ethernet → USB at exactly one match, so it still auto-inserts", () => {
    // store.onConnect only auto-inserts when exactly one adapter matches; more than
    // one silently downgrades the pairing to the picker dialog.
    expect(findAdaptersForSignalBridge("ethernet", "usb", DEVICE_TEMPLATES)).toHaveLength(1);
    expect(findAdaptersForSignalBridge("usb", "ethernet", DEVICE_TEMPLATES)).toHaveLength(1);
  });

  it("does not turn any bundled one-match pairing into a multi-match one", () => {
    const adapters = DEVICE_TEMPLATES.filter((t) => t.deviceType === "adapter");
    const signals = new Set<Port["signalType"]>();
    for (const a of adapters) for (const p of a.ports) signals.add(p.signalType);

    const forwardOnly = (t: DeviceTemplate, s: Port["signalType"], g: Port["signalType"]) =>
      t.ports.some((p) => (p.direction === "input" || p.direction === "bidirectional") && p.signalType === s) &&
      t.ports.some((p) => (p.direction === "output" || p.direction === "bidirectional") && p.signalType === g);

    const downgraded: string[] = [];
    for (const s of signals) {
      for (const g of signals) {
        if (s === g) continue;
        const before = adapters.filter((t) => forwardOnly(t, s, g)).length;
        const after = findAdaptersForSignalBridge(s, g, DEVICE_TEMPLATES).length;
        if (before === 1 && after !== 1) downgraded.push(`${s} → ${g}`);
      }
    }
    expect(downgraded).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Connector bridge — same one-way limitation, same fix
// ─────────────────────────────────────────────────────────────────────────────

const USB_C_TO_A_ADAPTER = "USB-C (M) → USB-A (F) Adapter";

const usbcToUsba = template("USB-C→USB-A", [
  { id: "c1", label: "USB-C In", signalType: "usb", direction: "input", connectorType: "usb-c", directAttach: true },
  { id: "c2", label: "USB-A Out", signalType: "usb", direction: "output", connectorType: "usb-a" },
]);

describe("findAdaptersForConnectorBridge — reverse matching", () => {
  it("still matches in the declared direction", () => {
    const found = findAdaptersForConnectorBridge("usb-c", "usb-a", "usb", [usbcToUsba]);
    expect(found.map((t) => t.label)).toEqual(["USB-C→USB-A"]);
  });

  it("matches the same template dragged the other way", () => {
    const found = findAdaptersForConnectorBridge("usb-a", "usb-c", "usb", [usbcToUsba]);
    expect(found.map((t) => t.label)).toEqual(["USB-C→USB-A"]);
  });

  it("still requires the signal type to match, not just the connectors", () => {
    expect(findAdaptersForConnectorBridge("usb-a", "usb-c", "thunderbolt", [usbcToUsba])).toEqual([]);
  });

  it("does not match connectors the adapter has no port for", () => {
    expect(findAdaptersForConnectorBridge("usb-a", "usb-b", "usb", [usbcToUsba])).toEqual([]);
  });

  it("still ignores templates that are not adapters", () => {
    const notAnAdapter = { ...usbcToUsba, deviceType: "converter" } as DeviceTemplate;
    expect(findAdaptersForConnectorBridge("usb-a", "usb-c", "usb", [notAnAdapter])).toEqual([]);
  });

  it("finds the bundled USB-C → USB-A adapter when dragging USB-A → USB-C", () => {
    const found = findAdaptersForConnectorBridge("usb-a", "usb-c", "usb", DEVICE_TEMPLATES);
    expect(found.map((t) => t.label)).toEqual([USB_C_TO_A_ADAPTER]);
  });
});

describe("reverse matches are a fallback, never an addition", () => {
  // The library deliberately ships mirrored connector adapters. Offering a reverse match
  // alongside a forward one would put two templates where one used to be, and store.onConnect
  // only auto-inserts on exactly one match — so 28 pairings would have quietly dropped to
  // the picker dialog. Forward matches must shadow reverse ones entirely.
  it("offers only the correctly-oriented adapter when a mirrored pair exists", () => {
    const forward = template("A→B", [
      { id: "f1", label: "A In", signalType: "analog-audio", direction: "input", connectorType: "xlr-3" },
      { id: "f2", label: "B Out", signalType: "analog-audio", direction: "output", connectorType: "trs-quarter" },
    ]);
    const mirrored = template("B→A", [
      { id: "m1", label: "B In", signalType: "analog-audio", direction: "input", connectorType: "trs-quarter" },
      { id: "m2", label: "A Out", signalType: "analog-audio", direction: "output", connectorType: "xlr-3" },
    ]);
    const both = [forward, mirrored];
    expect(findAdaptersForConnectorBridge("xlr-3", "trs-quarter", "analog-audio", both).map((t) => t.label))
      .toEqual(["A→B"]);
    expect(findAdaptersForConnectorBridge("trs-quarter", "xlr-3", "analog-audio", both).map((t) => t.label))
      .toEqual(["B→A"]);
  });

  it("keeps every bundled XLR/TRS/RCA and power pairing on exactly one match", () => {
    // Spot-check the mirrored families the scan flagged, in both directions.
    const pairs: Array<[ConnectorType, ConnectorType, SignalType]> = [
      ["xlr-3", "trs-quarter", "analog-audio"], ["trs-quarter", "xlr-3", "analog-audio"],
      ["xlr-3", "rca", "analog-audio"], ["rca", "xlr-3", "analog-audio"],
      ["trs-quarter", "trs-eighth", "analog-audio"], ["trs-eighth", "trs-quarter", "analog-audio"],
      ["hdmi", "dvi", "hdmi"], ["dvi", "hdmi", "hdmi"],
      ["iec", "edison", "power"], ["edison", "iec", "power"],
      ["powercon", "l6-30", "power"], ["l6-30", "powercon", "power"],
    ];
    for (const [sc, tc, signal] of pairs) {
      expect(
        findAdaptersForConnectorBridge(sc, tc, signal, DEVICE_TEMPLATES),
        `${signal}: ${sc} → ${tc}`,
      ).toHaveLength(1);
    }
  });

  it("does not turn any bundled one-match connector pairing into a multi-match one", () => {
    const adapters = DEVICE_TEMPLATES.filter((t) => t.deviceType === "adapter");
    const bySignal = new Map<SignalType, Set<ConnectorType>>();
    for (const a of adapters) {
      for (const p of a.ports) {
        if (!p.connectorType) continue;
        if (!bySignal.has(p.signalType)) bySignal.set(p.signalType, new Set());
        bySignal.get(p.signalType)!.add(p.connectorType);
      }
    }

    const forwardOnly = (t: DeviceTemplate, sc: ConnectorType, tc: ConnectorType, s: SignalType) =>
      t.ports.some((p) => (p.direction === "input" || p.direction === "bidirectional") && p.signalType === s && p.connectorType === sc) &&
      t.ports.some((p) => (p.direction === "output" || p.direction === "bidirectional") && p.signalType === s && p.connectorType === tc);

    const downgraded: string[] = [];
    for (const [signal, conns] of bySignal) {
      for (const sc of conns) {
        for (const tc of conns) {
          if (sc === tc) continue;
          const before = adapters.filter((t) => forwardOnly(t, sc, tc, signal)).length;
          const after = findAdaptersForConnectorBridge(sc, tc, signal, DEVICE_TEMPLATES).length;
          if (before === 1 && after !== 1) downgraded.push(`${signal}: ${sc} → ${tc}`);
        }
      }
    }
    expect(downgraded).toEqual([]);
  });

  it("leaves every forward-matching connector pairing byte-identical", () => {
    // Stronger than the downgrade check: wherever a forward match existed at all, the
    // result list must be exactly what forward-only matching produced, same order.
    const adapters = DEVICE_TEMPLATES.filter((t) => t.deviceType === "adapter");
    const bySignal = new Map<SignalType, Set<ConnectorType>>();
    for (const a of adapters) {
      for (const p of a.ports) {
        if (!p.connectorType) continue;
        if (!bySignal.has(p.signalType)) bySignal.set(p.signalType, new Set());
        bySignal.get(p.signalType)!.add(p.connectorType);
      }
    }

    const forwardOnly = (t: DeviceTemplate, sc: ConnectorType, tc: ConnectorType, s: SignalType) =>
      t.ports.some((p) => (p.direction === "input" || p.direction === "bidirectional") && p.signalType === s && p.connectorType === sc) &&
      t.ports.some((p) => (p.direction === "output" || p.direction === "bidirectional") && p.signalType === s && p.connectorType === tc);

    const differing: string[] = [];
    for (const [signal, conns] of bySignal) {
      for (const sc of conns) {
        for (const tc of conns) {
          if (sc === tc) continue;
          const before = adapters.filter((t) => forwardOnly(t, sc, tc, signal));
          if (before.length === 0) continue; // reverse fallback territory — expected to differ
          const after = findAdaptersForConnectorBridge(sc, tc, signal, DEVICE_TEMPLATES);
          if (before.length !== after.length) differing.push(`${signal}: ${sc} → ${tc}`);
        }
      }
    }
    expect(differing).toEqual([]);
  });
});

describe("resolveConnectorBridgePorts", () => {
  it("reports the declared orientation and its ports", () => {
    const bridge = resolveConnectorBridgePorts(usbcToUsba, "usb-c", "usb-a", "usb");
    expect(bridge).not.toBeNull();
    expect(bridge!.reversed).toBe(false);
    expect(bridge!.sourceSidePort.id).toBe("c1");
    expect(bridge!.targetSidePort.id).toBe("c2");
  });

  it("swaps the port roles and flags the reverse orientation", () => {
    const bridge = resolveConnectorBridgePorts(usbcToUsba, "usb-a", "usb-c", "usb");
    expect(bridge).not.toBeNull();
    expect(bridge!.reversed).toBe(true);
    expect(bridge!.sourceSidePort.id).toBe("c2");
    expect(bridge!.targetSidePort.id).toBe("c1");
  });

  it("returns null when neither orientation bridges the pair", () => {
    expect(resolveConnectorBridgePorts(usbcToUsba, "usb-a", "usb-b", "usb")).toBeNull();
    expect(resolveConnectorBridgePorts(usbcToUsba, "usb-c", "usb-a", "thunderbolt")).toBeNull();
  });
});

describe("resolveSignalBridgePorts", () => {
  it("reports the declared orientation and its ports", () => {
    const bridge = resolveSignalBridgePorts(usbToEth, "usb", "ethernet");
    expect(bridge).not.toBeNull();
    expect(bridge!.reversed).toBe(false);
    expect(bridge!.sourceSidePort.id).toBe("p1");
    expect(bridge!.targetSidePort.id).toBe("p2");
  });

  it("swaps the port roles and flags the reverse orientation", () => {
    const bridge = resolveSignalBridgePorts(usbToEth, "ethernet", "usb");
    expect(bridge).not.toBeNull();
    expect(bridge!.reversed).toBe(true);
    expect(bridge!.sourceSidePort.id).toBe("p2");
    expect(bridge!.targetSidePort.id).toBe("p1");
  });

  it("prefers the declared orientation when both would match", () => {
    const bidi = template("BIDI", [
      { id: "a", label: "A", signalType: "usb", direction: "bidirectional" },
      { id: "b", label: "B", signalType: "ethernet", direction: "bidirectional" },
    ]);
    expect(resolveSignalBridgePorts(bidi, "usb", "ethernet")!.reversed).toBe(false);
    expect(resolveSignalBridgePorts(bidi, "ethernet", "usb")!.reversed).toBe(false);
  });

  it("returns null when neither orientation bridges the pair", () => {
    expect(resolveSignalBridgePorts(usbToEth, "hdmi", "sdi")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// insertAdapterBetween must wire the reversed case up, not just find the template
// ─────────────────────────────────────────────────────────────────────────────

function deviceNode(id: string, label: string, ports: Port[], x: number): SchematicNode {
  return {
    id,
    type: "device",
    position: { x, y: 0 },
    data: { label, deviceType: "generic", ports },
  } as SchematicNode;
}

/** Every handle an edge starts from must be a source handle: DeviceNode renders a
 *  strict `input` port as target-only, and React Flow resolves a sourceHandle against
 *  source handles alone (a targetHandle resolves against both in ConnectionMode.Loose). */
function assertEdgesResolvable(edges: ConnectionEdge[], nodes: SchematicNode[]) {
  for (const e of edges) {
    const node = nodes.find((n) => n.id === e.source)!;
    const ports = (node.data as { ports: Port[] }).ports;
    const port = ports.find((p) => e.sourceHandle === p.id || e.sourceHandle?.startsWith(`${p.id}-`));
    expect(port, `no port for sourceHandle ${e.sourceHandle} on ${e.source}`).toBeDefined();
    expect(port!.direction, `edge ${e.id} starts at a target-only handle`).not.toBe("input");
  }
}

describe("insertAdapterBetween — reversed adapter is wired up", () => {
  const switchNode = deviceNode("n1", "Switch", [
    { id: "sw-eth", label: "Port 1", signalType: "ethernet", direction: "output", connectorType: "rj45" },
  ], 0);
  const laptopNode = deviceNode("n2", "Laptop", [
    { id: "lt-usb", label: "USB-A", signalType: "usb", direction: "bidirectional", connectorType: "usb-a" },
  ], 600);

  const adapterTemplate = DEVICE_TEMPLATES.find((t) => t.label === USB_ETH_ADAPTER)!;

  beforeEach(() => {
    useSchematicStore.setState({
      nodes: [switchNode, laptopNode],
      edges: [],
      pendingIncompatibleConnection: null,
    });
  });

  it("connects the source device through the adapter and on to the target", () => {
    const connection = { source: "n1", sourceHandle: "sw-eth", target: "n2", targetHandle: "lt-usb-in" };
    useSchematicStore.setState({
      pendingIncompatibleConnection: {
        connection,
        sourcePort: (switchNode.data as { ports: Port[] }).ports[0],
        targetPort: (laptopNode.data as { ports: Port[] }).ports[0],
        reason: "signal-mismatch",
      },
    });
    useSchematicStore.getState().insertAdapterBetween(adapterTemplate);

    const { nodes, edges } = useSchematicStore.getState();
    const adapter = nodes.find((n) => (n.data as { label?: string }).label === USB_ETH_ADAPTER)!;
    expect(adapter).toBeDefined();
    expect(edges).toHaveLength(2);

    const adapterPorts = (adapter.data as { ports: Port[] }).ports;
    const ethPort = adapterPorts.find((p) => p.signalType === "ethernet")!;
    const usbPort = adapterPorts.find((p) => p.signalType === "usb")!;

    // Ethernet leg: switch → adapter's Ethernet port
    const ethLeg = edges.find((e) => e.data?.signalType === "ethernet")!;
    expect(ethLeg.source).toBe("n1");
    expect(ethLeg.sourceHandle).toBe("sw-eth");
    expect(ethLeg.target).toBe(adapter.id);
    expect(ethLeg.targetHandle).toBe(ethPort.id);

    // USB leg: the reversed instance's USB end is flipped to an output — the dongle's
    // male plug feeds the laptop — so the cable is drawn adapter → laptop from a
    // source-type handle (#310).
    const usbLeg = edges.find((e) => e.data?.signalType === "usb")!;
    expect(usbPort.direction).toBe("output");
    expect(usbLeg.source).toBe(adapter.id);
    expect(usbLeg.sourceHandle).toBe(usbPort.id);
    expect(usbLeg.target).toBe("n2");
    expect(usbLeg.targetHandle).toBe("lt-usb-in");

    // The run is continuous: no direct n1 ↔ n2 edge, both legs touch the adapter.
    expect(edges.every((e) => e.source === adapter.id || e.target === adapter.id)).toBe(true);
    assertEdgesResolvable(edges, nodes);
  });

  it("still wires the declared direction adapter → target device", () => {
    const connection = { source: "n2", sourceHandle: "lt-usb-out", target: "n1", targetHandle: "sw-eth" };
    useSchematicStore.setState({
      pendingIncompatibleConnection: {
        connection,
        sourcePort: (laptopNode.data as { ports: Port[] }).ports[0],
        targetPort: (switchNode.data as { ports: Port[] }).ports[0],
        reason: "signal-mismatch",
      },
    });
    useSchematicStore.getState().insertAdapterBetween(adapterTemplate);

    const { nodes, edges } = useSchematicStore.getState();
    const adapter = nodes.find((n) => (n.data as { label?: string }).label === USB_ETH_ADAPTER)!;
    expect(edges).toHaveLength(2);

    const usbLeg = edges.find((e) => e.data?.signalType === "usb")!;
    expect(usbLeg.source).toBe("n2");
    expect(usbLeg.target).toBe(adapter.id);

    const ethLeg = edges.find((e) => e.data?.signalType === "ethernet")!;
    expect(ethLeg.source).toBe(adapter.id);
    expect(ethLeg.target).toBe("n1");
    expect(ethLeg.targetHandle).toBe("sw-eth");

    assertEdgesResolvable(edges, nodes);
  });
});

describe("insertAdapterBetween — reversed connector-swap adapter is wired up", () => {
  // Dragging USB-A → USB-C onto the USB-C (M) → USB-A (F) adapter. Resolving by signal
  // type alone would pick the adapter's USB-C end for the USB-A source and leave both
  // legs connector-mismatched, so this also pins the connector-aware resolution.
  const dockNode = deviceNode("n1", "Dock", [
    { id: "dk-usba", label: "USB-A", signalType: "usb", direction: "output", connectorType: "usb-a" },
  ], 0);
  const laptopNode = deviceNode("n2", "Laptop", [
    { id: "lt-usbc", label: "USB-C", signalType: "usb", direction: "bidirectional", connectorType: "usb-c" },
  ], 600);

  const adapterTemplate = DEVICE_TEMPLATES.find((t) => t.label === USB_C_TO_A_ADAPTER)!;

  beforeEach(() => {
    useSchematicStore.setState({
      nodes: [dockNode, laptopNode],
      edges: [],
      pendingIncompatibleConnection: null,
    });
  });

  it("matches each end to the port with the right connector, not just the right signal", () => {
    useSchematicStore.setState({
      pendingIncompatibleConnection: {
        connection: { source: "n1", sourceHandle: "dk-usba", target: "n2", targetHandle: "lt-usbc-in" },
        sourcePort: (dockNode.data as { ports: Port[] }).ports[0],
        targetPort: (laptopNode.data as { ports: Port[] }).ports[0],
        reason: "connector-mismatch",
      },
    });
    useSchematicStore.getState().insertAdapterBetween(adapterTemplate);

    const { nodes, edges } = useSchematicStore.getState();
    const adapter = nodes.find((n) => (n.data as { label?: string }).label === USB_C_TO_A_ADAPTER)!;
    expect(adapter).toBeDefined();
    expect(edges).toHaveLength(2);

    const adapterPorts = (adapter.data as { ports: Port[] }).ports;
    const usbaPort = adapterPorts.find((p) => p.connectorType === "usb-a")!;
    const usbcPort = adapterPorts.find((p) => p.connectorType === "usb-c")!;

    // Dock's USB-A meets the adapter's USB-A end, not its USB-C end.
    const dockLeg = edges.find((e) => e.source === "n1")!;
    expect(dockLeg.sourceHandle).toBe("dk-usba");
    expect(dockLeg.target).toBe(adapter.id);
    expect(dockLeg.targetHandle).toBe(usbaPort.id);

    // The reversed instance's USB-C end is flipped to an output — the physical truth:
    // the USB-C male plug goes into the laptop — so the leg draws adapter → laptop (#310).
    const laptopLeg = edges.find((e) => e.target === "n2")!;
    expect(usbcPort.direction).toBe("output");
    expect(laptopLeg.source).toBe(adapter.id);
    expect(laptopLeg.sourceHandle).toBe(usbcPort.id);
    expect(laptopLeg.targetHandle).toBe("lt-usbc-in");

    // Neither leg is flagged as a connector mismatch — the adapter genuinely bridges them.
    expect(edges.some((e) => e.data?.connectorMismatch)).toBe(false);

    expect(edges.every((e) => e.source === adapter.id || e.target === adapter.id)).toBe(true);
    assertEdgesResolvable(edges, nodes);
  });

  it("still wires the declared direction adapter → target device", () => {
    useSchematicStore.setState({
      pendingIncompatibleConnection: {
        connection: { source: "n2", sourceHandle: "lt-usbc-out", target: "n1", targetHandle: "dk-usba" },
        sourcePort: (laptopNode.data as { ports: Port[] }).ports[0],
        targetPort: (dockNode.data as { ports: Port[] }).ports[0],
        reason: "connector-mismatch",
      },
    });
    useSchematicStore.getState().insertAdapterBetween(adapterTemplate);

    const { nodes, edges } = useSchematicStore.getState();
    const adapter = nodes.find((n) => (n.data as { label?: string }).label === USB_C_TO_A_ADAPTER)!;
    expect(edges).toHaveLength(2);

    const adapterPorts = (adapter.data as { ports: Port[] }).ports;
    const usbaPort = adapterPorts.find((p) => p.connectorType === "usb-a")!;
    const usbcPort = adapterPorts.find((p) => p.connectorType === "usb-c")!;

    const laptopLeg = edges.find((e) => e.source === "n2")!;
    expect(laptopLeg.target).toBe(adapter.id);
    expect(laptopLeg.targetHandle).toBe(usbcPort.id);

    const dockLeg = edges.find((e) => e.target === "n1")!;
    expect(dockLeg.source).toBe(adapter.id);
    expect(dockLeg.sourceHandle).toBe(usbaPort.id);

    expect(edges.some((e) => e.data?.connectorMismatch)).toBe(false);
    assertEdgesResolvable(edges, nodes);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #339 — the five adapters that were shadowed by an id collision
// ─────────────────────────────────────────────────────────────────────────────

/** How a template id resolves for a device on the canvas: seed.ts writes the
 *  bundled library to D1 in array order with INSERT OR REPLACE, so the *last*
 *  template on an id is the row D1 keeps, and templateApi's effectiveTemplates()
 *  lets that row shadow the bundle. Before #339 five adapters shared an id with a
 *  later projector or control device, so an auto-inserted adapter carried a
 *  templateId that resolved to something that is not an adapter at all. */
function resolveAsD1Would(id: string): DeviceTemplate | undefined {
  let winner: DeviceTemplate | undefined;
  for (const t of DEVICE_TEMPLATES) if (t.id === id) winner = t;
  return winner;
}

describe("#339 — freed connector adapters", () => {
  const FREED: Array<[string, ConnectorType, ConnectorType, SignalType]> = [
    ["USB-C (M) → USB-A (F) Adapter", "usb-c", "usb-a", "usb"],
    ["USB-C (M) → USB-B (F) Adapter", "usb-c", "usb-b", "usb"],
    ["mini-XLR (M) → XLR-3 (F) Adapter", "mini-xlr", "xlr-3", "analog-audio"],
    ["IEC (M) → Edison (F) Adapter", "iec", "edison", "power"],
    ["IEC (M) → powerCON (F) Adapter", "iec", "powercon", "power"],
  ];

  it.each(FREED)("%s is offered for its connector pairing", (label, source, target, signal) => {
    const found = findAdaptersForConnectorBridge(source, target, signal, DEVICE_TEMPLATES);
    expect(found.map((t) => t.label)).toContain(label);
  });

  it.each(FREED)("%s keeps its own id once inserted", (label) => {
    const adapter = DEVICE_TEMPLATES.find((t) => t.label === label)!;
    expect(adapter.id).toBeTruthy();
    const resolved = resolveAsD1Would(adapter.id!);
    expect(resolved?.label).toBe(label);
    expect(resolved?.deviceType).toBe("adapter");
  });

  it("leaves no bundled adapter resolving to a different device", () => {
    const stolen = DEVICE_TEMPLATES.filter((t) => t.deviceType === "adapter" && t.id)
      .filter((t) => resolveAsD1Would(t.id!)?.label !== t.label)
      .map((t) => `${t.label} → ${resolveAsD1Would(t.id!)?.label}`);
    expect(stolen).toEqual([]);
  });

  it("stamps the freed adapter's own template id on the inserted device", () => {
    const adapterTemplate = DEVICE_TEMPLATES.find((t) => t.label === "IEC (M) → powerCON (F) Adapter")!;
    const rackNode = deviceNode("n1", "Rack Gear", [
      { id: "rk-iec", label: "AC In", signalType: "power", direction: "input", connectorType: "iec" },
    ], 0);
    const distroNode = deviceNode("n2", "Distro", [
      { id: "ds-pc", label: "powerCON Out", signalType: "power", direction: "output", connectorType: "powercon" },
    ], 600);
    useSchematicStore.setState({
      nodes: [rackNode, distroNode],
      edges: [],
      pendingIncompatibleConnection: {
        connection: { source: "n2", sourceHandle: "ds-pc", target: "n1", targetHandle: "rk-iec" },
        sourcePort: (distroNode.data as { ports: Port[] }).ports[0],
        targetPort: (rackNode.data as { ports: Port[] }).ports[0],
        reason: "connector-mismatch",
      },
    });
    useSchematicStore.getState().insertAdapterBetween(adapterTemplate);

    const inserted = useSchematicStore
      .getState()
      .nodes.find((n) => (n.data as { label?: string }).label === adapterTemplate.label)!;
    const templateId = (inserted.data as { templateId?: string }).templateId!;
    expect(templateId).toBe(adapterTemplate.id);
    expect(resolveAsD1Would(templateId)?.label).toBe(adapterTemplate.label);
  });
});
