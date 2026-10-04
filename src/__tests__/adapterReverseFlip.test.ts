/**
 * An adapter inserted in reverse gets its ports mirrored so the run reads straight.
 *
 * When `resolveSignalBridgePorts` / `resolveConnectorBridgePorts` match a template in
 * its reversed orientation, the part is being used the other way round: signal enters
 * the declared output side and leaves the declared input side. `insertAdapterBetween`
 * swaps the created instance's strict port directions to match — which both mirrors
 * their rendered side (the run reads straight instead of crossed) and gives the
 * outgoing leg a source-type handle the canvas can draw from (#310) — and toggles
 * `flipped` on bidirectional and passthrough ports, whose direction the swap leaves
 * alone (`flipped` is the same thing "Flip all ports" does from the port context menu).
 *
 * Handle IDs never change: strict ports use the bare port ID whichever direction they
 * face, so the edges reference the same handles either way.
 *
 * The store reads editor preferences from localStorage at import time, so a minimal
 * in-memory localStorage is installed before the store is imported.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { DEVICE_TEMPLATES } from "../deviceLibrary";
import { portSide } from "../types";
import type { Port, SchematicNode } from "../types";

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

function deviceNode(id: string, label: string, ports: Port[], x: number): SchematicNode {
  return {
    id,
    type: "device",
    position: { x, y: 0 },
    data: { label, deviceType: "generic", ports },
  } as SchematicNode;
}

describe("insertAdapterBetween — reversed adapter is mirrored", () => {
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

  /** Drag Ethernet → USB. The template declares USB in / Ethernet out, so it only
   *  bridges this pair in reverse. */
  function insertReversed() {
    useSchematicStore.setState({
      pendingIncompatibleConnection: {
        connection: { source: "n1", sourceHandle: "sw-eth", target: "n2", targetHandle: "lt-usb-in" },
        sourcePort: (switchNode.data as { ports: Port[] }).ports[0],
        targetPort: (laptopNode.data as { ports: Port[] }).ports[0],
        reason: "signal-mismatch",
      },
    });
    useSchematicStore.getState().insertAdapterBetween(adapterTemplate);
    const { nodes, edges } = useSchematicStore.getState();
    const adapter = nodes.find((n) => (n.data as { label?: string }).label === USB_ETH_ADAPTER)!;
    return { adapter, edges, ports: (adapter.data as { ports: Port[] }).ports };
  }

  /** Drag USB → Ethernet, the template's declared orientation. */
  function insertForward() {
    useSchematicStore.setState({
      pendingIncompatibleConnection: {
        connection: { source: "n2", sourceHandle: "lt-usb-out", target: "n1", targetHandle: "sw-eth" },
        sourcePort: (laptopNode.data as { ports: Port[] }).ports[0],
        targetPort: (switchNode.data as { ports: Port[] }).ports[0],
        reason: "signal-mismatch",
      },
    });
    useSchematicStore.getState().insertAdapterBetween(adapterTemplate);
    const { nodes, edges } = useSchematicStore.getState();
    const adapter = nodes.find((n) => (n.data as { label?: string }).label === USB_ETH_ADAPTER)!;
    return { adapter, edges, ports: (adapter.data as { ports: Port[] }).ports };
  }

  it("puts the source-side port on the left and the target-side port on the right", () => {
    const { ports } = insertReversed();
    // Ethernet comes from the switch on the left, USB carries on to the laptop on the right.
    const eth = ports.find((p) => p.signalType === "ethernet")!;
    const usb = ports.find((p) => p.signalType === "usb")!;
    expect(portSide(eth)).toBe("left");
    expect(portSide(usb)).toBe("right");
    // Which is the mirror of how the template declares them.
    const declaredEth = adapterTemplate.ports.find((p) => p.signalType === "ethernet")!;
    const declaredUsb = adapterTemplate.ports.find((p) => p.signalType === "usb")!;
    expect(portSide(declaredEth)).toBe("right");
    expect(portSide(declaredUsb)).toBe("left");
  });

  it("flips every port, not just the two the bridge matched", () => {
    const { ports } = insertReversed();
    expect(ports).not.toHaveLength(0);
    for (const p of ports) {
      const declared = adapterTemplate.ports.find((d) => d.label === p.label)!;
      expect(portSide(p), `port ${p.label} was not mirrored`).not.toBe(portSide(declared));
    }
  });

  it("leaves port sides alone in the declared direction", () => {
    const { ports } = insertForward();
    for (const p of ports) {
      expect(p.flipped).toBeUndefined();
      const declared = adapterTemplate.ports.find((d) => d.label === p.label)!;
      expect(portSide(p)).toBe(portSide(declared));
    }
  });

  it("keeps every wired handle naming a real port — the flip never touches handle IDs", () => {
    const { adapter, edges } = insertReversed();
    expect(edges).toHaveLength(2);
    const ports = (adapter.data as { ports: Port[] }).ports;
    // Every handle still names a real port on the adapter.
    for (const e of edges) {
      const handle = e.source === adapter.id ? e.sourceHandle : e.targetHandle;
      const base = (handle ?? "").replace(/-(in|out|rear|front)$/, "");
      expect(ports.some((p) => p.id === base), `no port for handle ${handle}`).toBe(true);
    }
  });
});
