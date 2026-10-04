// #355 — resolving a handle id back to the port it names over-stripped.
//
// Bidirectional ports own "<id>-in"/"<id>-out" handles and passthrough ports own
// "<id>-rear"/"<id>-front", so a handle sometimes has to be stripped back to the port id.
// Every resolver did that strip UNCONDITIONALLY, which broke every port whose real id
// already ends in one of those tokens — and the seeded fixture is full of them
// ("mon-hdmi-in", "spk-iec-in", "combo-xlr-out", "laptop-hdmi-out"). The stripped id
// matched nothing, so stub tags, DXF and PDF pills printed the raw handle id, patch-panel
// rows lost their remote device, and PoE budgets under-counted their load.
//
// portHandles.findPortByHandle is now the one rule: exact id first, strip only as a
// fallback. These cases pin both branches of it and the report surfaces that read it.

import { describe, it, expect } from "vitest";
import { findPortByHandle, strippedHandleId } from "../portHandles";
import { resolvePortLabel, resolvePort } from "../packList";
import { computePatchPanelSchedule } from "../patchPanelSchedule";
import { computePoeBudget } from "../networkReport";
import type { ConnectionEdge, DeviceData, SchematicNode } from "../types";

function deviceNode(id: string, label: string, ports: object[], extra: object = {}): SchematicNode {
  return {
    id, type: "device", position: { x: 0, y: 0 },
    data: { label, deviceType: "generic", ports, ...extra },
  } as unknown as SchematicNode;
}

/** Ports named the way the seeded fixture names them — real ids ending in -in / -out. */
const suffixNamedDevice = deviceNode("d1", "Confidence Monitor", [
  { id: "mon-hdmi-in", label: "HDMI In", signalType: "hdmi", direction: "input" },
  { id: "spk-iec-in", label: "IEC AC In", signalType: "power", direction: "input" },
  { id: "combo-xlr-out", label: "XLR Out", signalType: "analog", direction: "output" },
  { id: "laptop-hdmi-out", label: "HDMI Out", signalType: "hdmi", direction: "output" },
]);

/** The convention the strip exists for: one port, two suffixed handles. */
const bidirectionalDevice = deviceNode("d2", "Switcher", [
  { id: "p1", label: "HDMI 1", signalType: "hdmi", direction: "bidirectional" },
  { id: "pp1", label: "Port 1", signalType: "custom", direction: "passthrough" },
]);

describe("findPortByHandle", () => {
  it("matches a real port id that ends in a face token instead of stripping it", () => {
    const data = suffixNamedDevice.data as DeviceData;
    expect(findPortByHandle(data, "mon-hdmi-in")?.label).toBe("HDMI In");
    expect(findPortByHandle(data, "spk-iec-in")?.label).toBe("IEC AC In");
    expect(findPortByHandle(data, "combo-xlr-out")?.label).toBe("XLR Out");
    expect(findPortByHandle(data, "laptop-hdmi-out")?.label).toBe("HDMI Out");
  });

  it("still strips when the exact id matches no port", () => {
    const data = bidirectionalDevice.data as DeviceData;
    expect(findPortByHandle(data, "p1-in")?.id).toBe("p1");
    expect(findPortByHandle(data, "p1-out")?.id).toBe("p1");
    expect(findPortByHandle(data, "pp1-rear")?.id).toBe("pp1");
    expect(findPortByHandle(data, "pp1-front")?.id).toBe("pp1");
  });

  it("returns nothing for a handle that names no port either way", () => {
    expect(findPortByHandle(bidirectionalDevice.data as DeviceData, "ghost")).toBeUndefined();
    expect(findPortByHandle(bidirectionalDevice.data as DeviceData, "ghost-in")).toBeUndefined();
  });

  it("reports only a handle that actually carries a face suffix as strippable", () => {
    expect(strippedHandleId("p1-in")).toBe("p1");
    expect(strippedHandleId("pp1-front")).toBe("pp1");
    expect(strippedHandleId("p1")).toBeUndefined();
    // A single strip only — "mon-hdmi-in" falls back to "mon-hdmi", never "mon".
    expect(strippedHandleId("mon-hdmi-in")).toBe("mon-hdmi");
  });
});

describe("resolvePortLabel / resolvePort (#355)", () => {
  it("labels a suffix-named port rather than echoing the raw handle id", () => {
    expect(resolvePortLabel(suffixNamedDevice, "mon-hdmi-in")).toBe("HDMI In");
    expect(resolvePortLabel(suffixNamedDevice, "spk-iec-in")).toBe("IEC AC In");
    expect(resolvePortLabel(suffixNamedDevice, "combo-xlr-out")).toBe("XLR Out");
    expect(resolvePort(suffixNamedDevice, "mon-hdmi-in")?.id).toBe("mon-hdmi-in");
    expect(resolvePort(suffixNamedDevice, "laptop-hdmi-out")?.id).toBe("laptop-hdmi-out");
  });

  it("keeps labelling bidirectional and passthrough handles through the strip", () => {
    expect(resolvePortLabel(bidirectionalDevice, "p1-in")).toBe("HDMI 1");
    expect(resolvePortLabel(bidirectionalDevice, "p1-out")).toBe("HDMI 1");
    expect(resolvePortLabel(bidirectionalDevice, "pp1-rear")).toBe("Port 1");
    expect(resolvePort(bidirectionalDevice, "p1-out")?.id).toBe("p1");
  });

  it("falls back to the raw handle id only when nothing matches", () => {
    expect(resolvePortLabel(suffixNamedDevice, "does-not-exist")).toBe("does-not-exist");
  });
});

// The patch panel schedule indexes connections by (device, port) and reads that index
// with the port's own id, so the key has to be the resolved port — not a blind strip.
describe("patch panel schedule rows for suffix-named panel ports (#355)", () => {
  // Legacy paired input/output panel: the convention literally names its ports "-in"/"-out".
  const panel = deviceNode("pp", "PP-01", [
    { id: "pp1-in", label: "Port 1 In", signalType: "ethernet", direction: "input", connectorType: "rj45" },
    { id: "pp1-out", label: "Port 1 Out", signalType: "ethernet", direction: "output", connectorType: "rj45" },
  ], { deviceType: "patch-panel" });
  const switchNode = deviceNode("sw", "Core Switch", [
    { id: "net-1", label: "NET 1", signalType: "ethernet", direction: "output", connectorType: "rj45" },
  ]);
  const nodes = [panel, switchNode];
  const edges = [
    { id: "e1", source: "sw", sourceHandle: "net-1", target: "pp", targetHandle: "pp1-in",
      data: { signalType: "ethernet", cableId: "E001" } } as unknown as ConnectionEdge,
  ];

  it("names the remote device and port on the connected panel port", () => {
    const rows = computePatchPanelSchedule(nodes, edges);
    const row = rows.find((r) => r.position === "Port 1 In")!;
    expect(row.remoteDevice).toBe("Core Switch");
    expect(row.remotePort).toBe("NET 1");
    expect(row.cableId).toBeTruthy();
  });

  it("leaves the unconnected half of the pair blank", () => {
    const rows = computePatchPanelSchedule(nodes, edges);
    const row = rows.find((r) => r.position === "Port 1 Out")!;
    expect(row.remoteDevice).toBe("—");
  });
});

// PoE load is summed off the port each connection lands on; a suffix-named PoE port
// resolved to undefined and quietly contributed 0 W.
describe("PoE budget over a suffix-named powered port (#355)", () => {
  it("counts the draw of a camera port whose real id ends in -in", () => {
    const nodes = [
      deviceNode("sw", "PoE Switch", [
        { id: "poe-1", label: "PoE 1", signalType: "ethernet", direction: "output" },
      ], { poeBudgetW: 130 }),
      deviceNode("cam", "PTZ Camera", [
        { id: "cam-poe-in", label: "PoE In", signalType: "ethernet", direction: "input", poeDrawW: 25.5 },
      ]),
    ];
    const edges = [
      { id: "e1", source: "sw", sourceHandle: "poe-1", target: "cam", targetHandle: "cam-poe-in",
        data: { signalType: "ethernet" } } as unknown as ConnectionEdge,
    ];
    const rows = computePoeBudget(nodes, edges);
    expect(rows).toHaveLength(1);
    expect(rows[0].loadW).toBe(25.5);
    expect(rows[0].remainingW).toBe(104.5);
  });
});
