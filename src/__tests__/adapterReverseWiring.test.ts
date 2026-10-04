/**
 * A reversed adapter auto-insert must only create legs the canvas can draw (#310).
 *
 * React Flow resolves an edge's sourceHandle only against source-type handles (even
 * in ConnectionMode.Loose — only the target end falls back to source bounds), and
 * DeviceNode renders a strict `input` port as a target-only handle. A reversed bridge
 * is the same physical part used in its other orientation, so insertAdapterBetween
 * flips the inserted instance's port directions to match — every leg then draws from
 * a source-type handle, whichever way the template was declared.
 *
 * Three defects on the same Ethernet → USB drag are covered:
 *  1. onto a strict USB input: an adapter used to be inserted with one leg that never
 *     rendered — now the flipped instance wires drawably on both sides.
 *  2. onto a strict USB output: used to be a totally silent no-op — now the reversed
 *     adapter inserts (the hub's port hosts the dongle's USB plug).
 *  3. the drag preview's adaptable check, the picker dialog, and the auto-insert all
 *     share the same endpoint-filtered matcher, so they can no longer disagree.
 *
 * "Connect Anyway" (forceIncompatibleConnection) obeys the same canvas constraint:
 * it flips a connection whose drawn source is a strict input, and refuses an
 * input-to-input pair outright rather than committing an invisible connection.
 *
 * The store reads editor preferences from localStorage at import time, so a minimal
 * in-memory localStorage is installed before the store is imported.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  canWireAdapterBridge,
  findAdaptersForSignalBridge,
  resolveSignalBridgePorts,
} from "../connectorTypes";
import { DEVICE_TEMPLATES } from "../deviceLibrary";
import type { ConnectionEdge, DeviceData, Port, SchematicNode } from "../types";

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

/** The handle IDs DeviceNode renders with type="source" for these ports. Strict
 *  inputs render target-only; bidirectional ports render -in/-out both as source;
 *  passthrough ports render -rear/-front as source. Mirrors DeviceNode.handleProps. */
function sourceTypeHandles(ports: Port[]): Set<string> {
  const s = new Set<string>();
  for (const p of ports) {
    if (p.direction === "input") continue;
    if (p.direction === "bidirectional") { s.add(`${p.id}-in`); s.add(`${p.id}-out`); }
    else if (p.direction === "passthrough") { s.add(`${p.id}-rear`); s.add(`${p.id}-front`); }
    else s.add(p.id);
  }
  return s;
}

/** Success criterion for #310: every edge's sourceHandle must be a handle React Flow
 *  can resolve as an edge source, or the leg sits in the model but never renders. */
function expectAllEdgesDrawable(nodes: SchematicNode[], edges: ConnectionEdge[]) {
  for (const e of edges) {
    const src = nodes.find((n) => n.id === e.source)!;
    const handles = sourceTypeHandles((src.data as { ports: Port[] }).ports);
    expect(
      handles.has(e.sourceHandle ?? ""),
      `edge ${e.id}: sourceHandle ${e.sourceHandle} is not a source-type handle on ${e.source}`,
    ).toBe(true);
  }
}

const SWITCH_PORT: Port = { id: "sw-p3", label: "Port 3", signalType: "ethernet", direction: "bidirectional", connectorType: "rj45" };
const HUB_IN: Port = { id: "hub-in", label: "USB-A In", signalType: "usb", direction: "input", connectorType: "usb-a" };
const HUB_OUT: Port = { id: "hub-out", label: "USB-A Out", signalType: "usb", direction: "output", connectorType: "usb-a" };

function deviceNode(id: string, label: string, ports: Port[], x: number): SchematicNode {
  return {
    id,
    type: "device",
    position: { x, y: 0 },
    data: { label, deviceType: "generic", ports },
  } as SchematicNode;
}

const adapterTemplate = DEVICE_TEMPLATES.find((t) => t.label === USB_ETH_ADAPTER)!;

describe("reversed adapter auto-insert wiring (#310)", () => {
  beforeEach(() => {
    useSchematicStore.setState({
      nodes: [
        deviceNode("n1", "Core Switch", [SWITCH_PORT], 0),
        deviceNode("n2", "USB Hub", [HUB_IN, HUB_OUT], 600),
      ],
      edges: [],
      pendingIncompatibleConnection: null,
    });
  });

  it("inserts a flipped instance on the strict-input drop, both legs drawable", () => {
    // The defect-1 repro: previously two edges were created but the adapter's strict
    // USB In carried the second leg's sourceHandle, so the leg never rendered.
    useSchematicStore.getState().onConnect({
      source: "n1", sourceHandle: "sw-p3-out", target: "n2", targetHandle: "hub-in",
    });
    const { nodes, edges, pendingIncompatibleConnection } = useSchematicStore.getState();
    const adapter = nodes.find((n) => (n.data as { label?: string }).label === USB_ETH_ADAPTER);
    expect(adapter).toBeDefined();
    expect(edges).toHaveLength(2);
    expect(pendingIncompatibleConnection).toBeNull();

    // The instance is the part in its used orientation: Ethernet side receives from
    // the switch, USB side (the male plug, directAttach) feeds the hub.
    const aPorts = (adapter!.data as DeviceData).ports;
    const ethSide = aPorts.find((p) => p.signalType === "ethernet")!;
    const usbSide = aPorts.find((p) => p.signalType === "usb")!;
    expect(ethSide.direction).toBe("input");
    expect(usbSide.direction).toBe("output");
    expect(usbSide.directAttach).toBe(true);

    const inLeg = edges.find((e) => e.target === adapter!.id)!;
    expect(inLeg.source).toBe("n1");
    expect(inLeg.sourceHandle).toBe("sw-p3-out");
    const outLeg = edges.find((e) => e.source === adapter!.id)!;
    expect(outLeg.sourceHandle).toBe(usbSide.id);
    expect(outLeg.target).toBe("n2");
    expect(outLeg.targetHandle).toBe("hub-in");
    expect(outLeg.data?.directAttach).toBe(true);

    expectAllEdgesDrawable(nodes, edges);
  });

  it("the endpoint-filtered matcher still offers the reversed bridge for the strict-input drop", () => {
    // The filter must not strip a physically-correct reversed part (the dongle's USB
    // plug goes straight into the hub) — the preview, dialog, and auto-insert all see it.
    expect(findAdaptersForSignalBridge("ethernet", "usb", DEVICE_TEMPLATES, {
      sourcePort: SWITCH_PORT, targetPort: HUB_IN,
    })).toHaveLength(1);
  });

  it("inserts the reversed adapter when the drop lands on the strict USB output", () => {
    // Previously a totally silent no-op: 0 edges, no adapter, no dialog.
    useSchematicStore.getState().onConnect({
      source: "n1", sourceHandle: "sw-p3-out", target: "n2", targetHandle: "hub-out",
    });
    const { nodes, edges, pendingIncompatibleConnection } = useSchematicStore.getState();
    const adapter = nodes.find((n) => (n.data as { label?: string }).label === USB_ETH_ADAPTER);
    expect(adapter).toBeDefined();
    expect(edges).toHaveLength(2);
    expect(pendingIncompatibleConnection).toBeNull();

    // One inbound and one outbound leg — the shape the hide-adapters virtual-edge
    // builder can collapse, and every sourceHandle is drawable.
    expect(edges.filter((e) => e.target === adapter!.id)).toHaveLength(1);
    expect(edges.filter((e) => e.source === adapter!.id)).toHaveLength(1);
    expectAllEdgesDrawable(nodes, edges);
  });

  it("keeps the working bidirectional-target insert drawable end to end", () => {
    useSchematicStore.setState({
      nodes: [
        deviceNode("n1", "Core Switch", [SWITCH_PORT], 0),
        deviceNode("n2", "Laptop", [
          { id: "lt-usb", label: "USB-A", signalType: "usb", direction: "bidirectional", connectorType: "usb-a" },
        ], 600),
      ],
      edges: [],
      pendingIncompatibleConnection: null,
    });
    useSchematicStore.getState().onConnect({
      source: "n1", sourceHandle: "sw-p3-out", target: "n2", targetHandle: "lt-usb-in",
    });
    const { nodes, edges } = useSchematicStore.getState();
    expect(edges).toHaveLength(2);
    expectAllEdgesDrawable(nodes, edges);
  });

  it("insertAdapterBetween refuses when the drag source is a strict input (direct-call safety net)", () => {
    // Leg 1 always draws source device → adapter; a strict input has no source-type
    // handle, so no orientation could ever render that leg.
    useSchematicStore.setState({
      pendingIncompatibleConnection: {
        connection: { source: "n2", sourceHandle: "hub-in", target: "n1", targetHandle: "sw-p3-in" },
        sourcePort: HUB_IN,
        targetPort: SWITCH_PORT,
        reason: "signal-mismatch",
      },
    });
    const ok = useSchematicStore.getState().insertAdapterBetween(adapterTemplate);
    expect(ok).toBe(false);
    const { nodes, edges } = useSchematicStore.getState();
    expect(edges).toHaveLength(0);
    expect(nodes.filter((n) => n.type === "device")).toHaveLength(2);
  });
});

describe("forced incompatible connections stay drawable (#310)", () => {
  const CAM_OUT: Port = { id: "cam-out", label: "HDMI Out", signalType: "hdmi", direction: "output", connectorType: "hdmi" };
  const DISP_IN: Port = { id: "disp-in", label: "HDMI In", signalType: "hdmi", direction: "input", connectorType: "hdmi" };

  beforeEach(() => {
    useSchematicStore.setState({
      nodes: [
        deviceNode("n1", "Camera", [CAM_OUT], 0),
        deviceNode("n2", "USB Hub", [HUB_IN, HUB_OUT], 600),
      ],
      edges: [],
      pendingIncompatibleConnection: null,
    });
  });

  it("Connect Anyway flips a connection whose drawn source is a strict input", () => {
    // Dragging from the hub's strict USB input onto the camera's HDMI output makes
    // the input the drawn source. No adapter can bridge from a strict input, so the
    // dialog offers Connect Anyway — which must not commit an invisible connection.
    useSchematicStore.getState().onConnect({
      source: "n2", sourceHandle: "hub-in", target: "n1", targetHandle: "cam-out",
    });
    const staged = useSchematicStore.getState();
    expect(staged.edges).toHaveLength(0);
    expect(staged.pendingIncompatibleConnection?.reason).toBe("signal-mismatch");

    useSchematicStore.getState().forceIncompatibleConnection();
    const { nodes, edges, pendingIncompatibleConnection } = useSchematicStore.getState();
    expect(pendingIncompatibleConnection).toBeNull();
    expect(edges).toHaveLength(1);
    expect(edges[0].source).toBe("n1");
    expect(edges[0].sourceHandle).toBe("cam-out");
    expect(edges[0].target).toBe("n2");
    expect(edges[0].targetHandle).toBe("hub-in");
    expectAllEdgesDrawable(nodes, edges);
  });

  it("a signal-mismatch drop between two strict inputs stays out of the dialog entirely", () => {
    useSchematicStore.setState({
      nodes: [
        deviceNode("n1", "Display", [DISP_IN], 0),
        deviceNode("n2", "USB Hub", [HUB_IN], 600),
      ],
      edges: [],
      pendingIncompatibleConnection: null,
    });
    useSchematicStore.getState().onConnect({
      source: "n2", sourceHandle: "hub-in", target: "n1", targetHandle: "disp-in",
    });
    const { edges, pendingIncompatibleConnection } = useSchematicStore.getState();
    // Neither an adapter leg nor a forced connection could ever be drawn from a
    // strict input, so nothing is staged — same as before the branch was widened.
    expect(edges).toHaveLength(0);
    expect(pendingIncompatibleConnection).toBeNull();
  });

  it("forceIncompatibleConnection refuses an input-to-input pair outright", () => {
    // Safety net for callers other than onConnect: with two strict inputs no
    // orientation is drawable, so no connection may be committed.
    useSchematicStore.setState({
      nodes: [
        deviceNode("n1", "Display", [DISP_IN], 0),
        deviceNode("n2", "USB Hub", [HUB_IN], 600),
      ],
      edges: [],
      pendingIncompatibleConnection: {
        connection: { source: "n2", sourceHandle: "hub-in", target: "n1", targetHandle: "disp-in" },
        sourcePort: HUB_IN,
        targetPort: DISP_IN,
        reason: "signal-mismatch",
      },
    });
    useSchematicStore.getState().forceIncompatibleConnection();
    const { edges, pendingIncompatibleConnection } = useSchematicStore.getState();
    expect(edges).toHaveLength(0);
    expect(pendingIncompatibleConnection).toBeNull();
  });
});

describe("canWireAdapterBridge", () => {
  // The bundled dongle declares USB In / Ethernet Out, so Ethernet → USB resolves it
  // in reverse with the strict USB input on the target side.
  const reversed = resolveSignalBridgePorts(adapterTemplate, "ethernet", "usb")!;
  const forward = resolveSignalBridgePorts(adapterTemplate, "usb", "ethernet")!;

  it("resolves the fixture bridges in the orientations the cases below assume", () => {
    expect(reversed.reversed).toBe(true);
    expect(reversed.targetSidePort.direction).toBe("input");
    expect(forward.reversed).toBe(false);
  });

  it("accepts a reversed bridge whatever the device-side port direction", () => {
    // The insert flips the instance, so the outgoing leg is always drawable; the
    // adapter's male end plugs into an input, an output, or a bidirectional port.
    expect(canWireAdapterBridge(reversed, SWITCH_PORT, HUB_IN)).toBe(true);
    expect(canWireAdapterBridge(reversed, SWITCH_PORT, HUB_OUT)).toBe(true);
    expect(canWireAdapterBridge(reversed, SWITCH_PORT, { ...HUB_IN, direction: "bidirectional" })).toBe(true);
  });

  it("accepts a forward bridge only into a receiving device port", () => {
    const usbSrc: Port = { id: "s", label: "USB", signalType: "usb", direction: "output", connectorType: "usb-a" };
    expect(canWireAdapterBridge(forward, usbSrc, { ...SWITCH_PORT, direction: "input" })).toBe(true);
    expect(canWireAdapterBridge(forward, usbSrc, SWITCH_PORT)).toBe(true);
    // A forward converter feeding a strict output is a genuine user error…
    expect(canWireAdapterBridge(forward, usbSrc, { ...SWITCH_PORT, direction: "output" })).toBe(false);
  });

  it("lets network-to-network pairs ignore direction sense (traffic is bidirectional)", () => {
    const ethOut: Port = { id: "a", label: "Eth A", signalType: "ethernet", direction: "output", connectorType: "rj45" };
    const danteOut: Port = { id: "b", label: "Dante B", signalType: "dante", direction: "output", connectorType: "rj45" };
    const bridge = { sourceSidePort: ethOut, targetSidePort: danteOut, reversed: false };
    expect(canWireAdapterBridge(bridge, ethOut, danteOut)).toBe(true);
  });

  it("rejects any bridge whose drag source is a strict input — that leg could never render", () => {
    expect(canWireAdapterBridge(forward, { ...HUB_IN }, { ...SWITCH_PORT, direction: "input" })).toBe(false);
    expect(canWireAdapterBridge(reversed, { ...HUB_IN }, HUB_OUT)).toBe(false);
  });
});
