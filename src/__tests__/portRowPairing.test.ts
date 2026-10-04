/**
 * Port-row pairing and handle coverage for lopsided devices (#344).
 *
 * #344 reported the fixture's BMD SDI→Audio 12G rendering 7 of its 8 ports and
 * blamed the row pairing, on the theory that 6 outputs against 2 inputs walks off
 * the end of the shorter column. It does not — the pairing takes the longer column
 * (DeviceNode.tsx:548, mirrored in deviceHandleLayout.ts:138) — and the real reason
 * that one port is absent is that the fixture hides it on purpose (#332, see the
 * last test here). These cases pin the pairing invariant so the theory stays ruled
 * out: every visible port gets a handle, and the row count is the longer column's
 * length, whichever side that is.
 */
import { describe, it, expect } from "vitest";
import { computeDeviceHandles, firstHandleCenterY } from "../routingHarness/deviceHandleLayout";
import { buildTestSchematic } from "../testSchematic/build";
import type { DeviceData, Port, PortDirection, SchematicNode } from "../types";

const ROW_H = 16;

function port(id: string, direction: PortDirection, extra: Partial<Port> = {}): Port {
  return { id, label: id, signalType: "sdi", direction, ...extra };
}

function device(ports: Port[]): { data: DeviceData; measured: { width: number; height: number } } {
  return {
    data: { label: "Test Device", deviceType: "converter", ports },
    measured: { width: 176, height: 128 },
  };
}

/** Row index of each handle, derived from its Y against the first row's center. */
function rowsUsed(node: { data: DeviceData; measured: { width: number; height: number } }): number {
  const first = firstHandleCenterY(node.data);
  const handles = computeDeviceHandles(node);
  if (handles.length === 0) return 0;
  const maxRow = Math.max(...handles.map((h) => (h.relY - first) / ROW_H));
  return maxRow + 1;
}

function ins(n: number): Port[] {
  return Array.from({ length: n }, (_, i) => port(`in-${i}`, "input"));
}

function outs(n: number): Port[] {
  return Array.from({ length: n }, (_, i) => port(`out-${i}`, "output"));
}

describe("port-row pairing — every visible port keeps a handle", () => {
  it("gives all 8 ports a handle on 2 inputs / 6 outputs (#344's shape)", () => {
    // The exact split of the BMD SDI→Audio 12G: SDI In + AC Power against
    // SDI Loop, Analog Out L/R, AES Out 1-2, AES Out 3-4, S/PDIF Out.
    const node = device([...ins(2), ...outs(6)]);
    const handleIds = computeDeviceHandles(node).map((h) => h.id).sort();
    expect(handleIds).toEqual([...ins(2), ...outs(6)].map((p) => p.id).sort());
    expect(rowsUsed(node)).toBe(6);
  });

  it("keeps every port across the whole 1..6 output-over-input spread", () => {
    for (let extra = 1; extra <= 6; extra++) {
      const ports = [...ins(2), ...outs(2 + extra)];
      const node = device(ports);
      const handleIds = new Set(computeDeviceHandles(node).map((h) => h.id));
      for (const p of ports) {
        expect(handleIds.has(p.id), `${p.id} lost its handle at +${extra} outputs`).toBe(true);
      }
      expect(rowsUsed(node), `row count at +${extra} outputs`).toBe(2 + extra);
    }
  });

  it("keeps every port when inputs outnumber outputs instead", () => {
    const ports = [...ins(6), ...outs(2)];
    const node = device(ports);
    const handleIds = new Set(computeDeviceHandles(node).map((h) => h.id));
    for (const p of ports) expect(handleIds.has(p.id), `${p.id} lost its handle`).toBe(true);
    expect(rowsUsed(node)).toBe(6);
  });

  it("handles an all-output device (zero inputs)", () => {
    const node = device(outs(4));
    expect(computeDeviceHandles(node).map((h) => h.id).sort()).toEqual(outs(4).map((p) => p.id).sort());
    expect(rowsUsed(node)).toBe(4);
  });

  it("handles an all-input device (zero outputs)", () => {
    const node = device(ins(4));
    expect(computeDeviceHandles(node).map((h) => h.id).sort()).toEqual(ins(4).map((p) => p.id).sort());
    expect(rowsUsed(node)).toBe(4);
  });

  it("has no handles and no rows when the device has no ports", () => {
    const node = device([]);
    expect(computeDeviceHandles(node)).toEqual([]);
  });

  it("pairs by rendered side, so flipped ports rebalance the columns", () => {
    // A flipped output renders on the left, which shortens the right column —
    // the pairing must follow the rendered side, not the semantic direction.
    const ports = [...ins(1), ...outs(4).map((p, i) => (i < 3 ? { ...p, flipped: true } : p))];
    const node = device(ports);
    const handleIds = new Set(computeDeviceHandles(node).map((h) => h.id));
    for (const p of ports) expect(handleIds.has(p.id), `${p.id} lost its handle`).toBe(true);
    // Left column: 1 input + 3 flipped outputs = 4. Right column: 1 output.
    expect(rowsUsed(node)).toBe(4);
  });
});

describe("fixture BMD SDI→Audio 12G — the missing port is a deliberate hide (#344)", () => {
  const fixture = buildTestSchematic();
  const bmd = fixture.nodes.find((n) => n.id === "device-21") as SchematicNode & { data: DeviceData };

  it("carries all 8 ports, with S/PDIF Out hidden per-device", () => {
    // #332 places this device from a bundled template and hides one port so it opens
    // dirty, which is what makes Revert to Template reachable in a manual pass. The
    // hidden port is still in data.ports — nothing dropped it.
    expect(bmd.data.ports).toHaveLength(8);
    const spdif = bmd.data.ports.find((p) => p.label === "S/PDIF Out");
    expect(spdif, "fixture no longer has an S/PDIF Out port").toBeDefined();
    expect(bmd.data.hiddenPorts).toEqual([spdif!.id]);
  });

  it("renders a handle for every port that is not hidden, and one more once unhidden", () => {
    const hidden = new Set(bmd.data.hiddenPorts ?? []);
    const shown = computeDeviceHandles(bmd as never).map((h) => h.id).sort();
    expect(shown).toEqual(bmd.data.ports.filter((p) => !hidden.has(p.id)).map((p) => p.id).sort());

    const unhidden = { ...bmd, data: { ...bmd.data, hiddenPorts: undefined } };
    const all = computeDeviceHandles(unhidden as never).map((h) => h.id).sort();
    expect(all).toEqual(bmd.data.ports.map((p) => p.id).sort());
    // 2 inputs against 6 outputs: unhiding costs exactly one extra row.
    expect(rowsUsed(unhidden as never)).toBe(rowsUsed(bmd as never) + 1);
  });
});
