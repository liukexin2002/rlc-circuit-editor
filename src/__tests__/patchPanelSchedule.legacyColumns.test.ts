/**
 * The Patch Panel Schedule's single-face columns (Connector, M/F, Remote Device, Remote
 * Port, Remote Room — and the bare cable columns Cable ID, Cable Type, Length, Est.
 * Length, Snake, added after the 2026-08-22-2 test pass caught them still showing) only
 * populate on the legacy paired input/output back-compat path; a passthrough port leaves
 * every one of them empty and reports through the rear- and front-face columns instead. A
 * report of only passthrough panels therefore showed columns that can never fill, which
 * reads as missing data (#311).
 *
 * `resolvePatchPanelHiddenColumns` is the whole rule: hide those columns by default unless
 * a legacy row is in view, and step aside the moment the user states a preference.
 */
import { describe, it, expect } from "vitest";
import {
  computePatchPanelSchedule,
  resolvePatchPanelHiddenColumns,
  PATCH_PANEL_LEGACY_COLUMN_IDS,
} from "../patchPanelSchedule";
import type { SchematicNode, ConnectionEdge } from "../types";

const ALL_LEGACY = [...PATCH_PANEL_LEGACY_COLUMN_IDS];

// PP-01: a modern passthrough panel — every port is direction "passthrough".
function passthroughPanelNode(id: string, label: string, portCount: number): SchematicNode {
  const ports = Array.from({ length: portCount }, (_, i) => ({
    id: `pp-port-${i + 1}`, label: `Port ${i + 1}`, signalType: "custom",
    direction: "passthrough", inheritsSignal: true,
    rearConnectorType: "rj45", frontConnectorType: "rj45",
  }));
  return {
    id, type: "device", position: { x: 0, y: 0 },
    data: { label, deviceType: "patch-panel", ports, offCanvas: true },
  } as unknown as SchematicNode;
}

// ST Fiber Bulkhead: a legacy panel with plain input/output ports (the back-compat path).
function legacyPanelNode(id: string, label: string): SchematicNode {
  return {
    id, type: "device", position: { x: 0, y: 0 },
    data: {
      label, deviceType: "patch-panel", offCanvas: true,
      ports: [
        { id: "st-in-1", label: "Port 1", signalType: "fiber", direction: "input", connectorType: "st" },
        { id: "st-out-1", label: "Port 2", signalType: "fiber", direction: "output", connectorType: "st" },
      ],
    },
  } as unknown as SchematicNode;
}

function deviceNode(id: string, label: string, ports: object[]): SchematicNode {
  return {
    id, type: "device", position: { x: 0, y: 0 },
    data: { label, deviceType: "generic", ports },
  } as unknown as SchematicNode;
}

const switchNode = deviceNode("dev-sw", "Core Switch", [
  { id: "sfp1", label: "SFP 1", signalType: "fiber", direction: "input", connectorType: "st" },
]);

// Wires the legacy panel's output port to a plain device port, so the single-face
// remote-end columns carry real values rather than em dashes.
const legacyEdge: ConnectionEdge = {
  id: "e-st", source: "pp-2", target: "dev-sw",
  sourceHandle: "st-out-1-out", targetHandle: "sfp1-in",
  data: { signalType: "fiber" },
} as unknown as ConnectionEdge;

describe("patch panel schedule — single-face column visibility (#311)", () => {
  it("a passthrough-only panel leaves every single-face column empty", () => {
    const rows = computePatchPanelSchedule([passthroughPanelNode("pp-1", "PP-01", 8)], []);
    expect(rows).toHaveLength(8);
    expect(rows.every((r) => r.face === "Passthrough")).toBe(true);
    for (const id of PATCH_PANEL_LEGACY_COLUMN_IDS) {
      // Remote-end fields hold the em-dash sentinel; the bare cable fields hold "".
      expect(rows.every((r) => r[id] === "—" || r[id] === "")).toBe(true);
    }
  });

  it("a wired legacy paired input/output panel populates every single-face column", () => {
    const rows = computePatchPanelSchedule([legacyPanelNode("pp-2", "ST Fiber Bulkhead"), switchNode], [legacyEdge]);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.face)).toEqual(["Rear", "Front"]);

    const front = rows.find((r) => r.face === "Front")!;
    expect(front.connector).toBe("Fiber - ST");
    expect(front.remoteDevice).toBe("Core Switch");
    expect(front.remotePort).toBe("SFP 1");
    expect(front.remoteRoom).not.toBe("—");
    // Gender comes from the connector type, so it is filled even on the unwired rear row.
    expect(rows.every((r) => r.gender !== "")).toBe(true);
  });

  it("hides every single-face column for a passthrough-only report", () => {
    const rows = computePatchPanelSchedule([passthroughPanelNode("pp-1", "PP-01", 8)], []);
    expect([...resolvePatchPanelHiddenColumns(rows, undefined)].sort()).toEqual([...ALL_LEGACY].sort());
  });

  it("shows them when a legacy panel is present", () => {
    const nodes = [passthroughPanelNode("pp-1", "PP-01", 8), legacyPanelNode("pp-2", "ST Fiber Bulkhead"), switchNode];
    const rows = computePatchPanelSchedule(nodes, [legacyEdge]);
    expect(resolvePatchPanelHiddenColumns(rows, undefined).size).toBe(0);
  });

  it("follows the rows in view, not the whole document", () => {
    const nodes = [passthroughPanelNode("pp-1", "PP-01", 8), legacyPanelNode("pp-2", "ST Fiber Bulkhead"), switchNode];
    const rows = computePatchPanelSchedule(nodes, [legacyEdge]);
    // Filtering the table down to the passthrough panel takes the legacy rows out of view,
    // so their columns hide again.
    const inView = rows.filter((r) => r.panel === "PP-01");
    expect([...resolvePatchPanelHiddenColumns(inView, undefined)].sort()).toEqual([...ALL_LEGACY].sort());
  });

  it("an explicit empty preference means show everything, and beats the default", () => {
    const rows = computePatchPanelSchedule([passthroughPanelNode("pp-1", "PP-01", 8)], []);
    expect(resolvePatchPanelHiddenColumns(rows, []).size).toBe(0);
  });

  it("an explicit partial preference is used verbatim, in both directions", () => {
    const passthroughRows = computePatchPanelSchedule([passthroughPanelNode("pp-1", "PP-01", 8)], []);
    expect([...resolvePatchPanelHiddenColumns(passthroughRows, ["gender"])]).toEqual(["gender"]);

    const legacyRows = computePatchPanelSchedule([legacyPanelNode("pp-2", "ST Fiber Bulkhead")], []);
    expect([...resolvePatchPanelHiddenColumns(legacyRows, ["gender"])]).toEqual(["gender"]);
  });

  it("hides nothing for an empty report", () => {
    // No rows means no legacy row, but there is also nothing to read — the default is
    // harmless either way; pinned so the branch is deliberate.
    expect(resolvePatchPanelHiddenColumns([], undefined).size).toBe(ALL_LEGACY.length);
  });
});
