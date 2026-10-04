/**
 * The device name follows the new device on a swap — unless the user renamed it (#333).
 *
 * `baseLabel` is the app's marker for "this device is still auto-named": renumberNodes
 * owns the label while it is set, and a rename clears it. swapDevice reads it to decide
 * whether the old name was the user's. updateDevice used to clear baseLabel on *every*
 * save, so any device that had ever been through the device editor was mistaken for
 * renamed and kept its stale name through a swap.
 *
 * The store reads editor preferences from localStorage at import time, so a minimal
 * in-memory localStorage is installed before the store is imported.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { planDeviceSwap } from "../deviceSwap";
import fixture from "../testSchematic/schematic.json";
import type { DeviceData, DeviceNode, DeviceTemplate, Port } from "../types";

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
let isAutoNamedDevice: typeof import("../store")["isAutoNamedDevice"];

beforeAll(async () => {
  (globalThis as { localStorage?: unknown }).localStorage = new MemStorage();
  if (!globalThis.crypto?.randomUUID) {
    (globalThis as { crypto?: unknown }).crypto = {
      randomUUID: () => "test-" + Math.random().toString(36).slice(2),
    };
  }
  ({ useSchematicStore, isAutoNamedDevice } = await import("../store"));
});

function port(id: string, overrides: Partial<Port> = {}): Port {
  return { id, label: id, signalType: "analog-audio", direction: "input", connectorType: "xlr-3", ...overrides };
}

/** A powered speaker as the library places it: auto-named, with baseLabel set. */
function speakerNode(id: string, label: string, x = 0, overrides: Partial<DeviceData> = {}): DeviceNode {
  return {
    id,
    type: "device",
    position: { x, y: 0 },
    data: {
      label,
      baseLabel: "Powered Speaker (IEC)",
      model: "Powered Speaker (IEC)",
      deviceType: "speaker",
      manufacturer: "QSC",
      modelNumber: "K12.2",
      templateId: "spk-iec",
      ports: [port("spk-xlr-in", { templatePortId: "xlr-in" }), port("spk-iec-in", { signalType: "power", connectorType: "iec", templatePortId: "iec-in" })],
      ...overrides,
    } as DeviceData,
  } as DeviceNode;
}

const REPLACEMENT: DeviceTemplate = {
  id: "spk-powercon",
  deviceType: "speaker",
  label: "Powered Speaker (powerCON)",
  manufacturer: "RCF",
  modelNumber: "ART 912-A",
  ports: [
    port("xlr-in", { templatePortId: undefined }),
    port("pcon-in", { signalType: "power", connectorType: "powercon-true1" }),
  ],
};

function swapTo(nodeId: string, template: DeviceTemplate) {
  const state = useSchematicStore.getState();
  const node = state.nodes.find((n) => n.id === nodeId) as DeviceNode;
  const plan = planDeviceSwap(node.data, nodeId, template, state.edges);
  useSchematicStore.getState().swapDevice(nodeId, plan);
}

const labelOf = (nodeId: string) =>
  (useSchematicStore.getState().nodes.find((n) => n.id === nodeId)!.data as DeviceData).label;
const baseLabelOf = (nodeId: string) =>
  (useSchematicStore.getState().nodes.find((n) => n.id === nodeId)!.data as DeviceData).baseLabel;

describe("device name on swap (#333)", () => {
  beforeEach(() => {
    useSchematicStore.setState({ nodes: [], edges: [], pendingPortEditConflicts: null, toasts: [] });
  });

  it("takes the new device's name when the device is still auto-named", () => {
    useSchematicStore.setState({ nodes: [speakerNode("spk-1", "Powered Speaker (IEC)")] });
    swapTo("spk-1", REPLACEMENT);
    expect(labelOf("spk-1")).toBe("Powered Speaker (powerCON)");
    expect(baseLabelOf("spk-1")).toBe("Powered Speaker (powerCON)");
  });

  it("keeps a name the user typed", () => {
    useSchematicStore.setState({ nodes: [speakerNode("spk-1", "Powered Speaker (IEC)")] });
    useSchematicStore.getState().updateDeviceLabel("spk-1", "House Left");
    swapTo("spk-1", REPLACEMENT);
    expect(labelOf("spk-1")).toBe("House Left");
    expect(baseLabelOf("spk-1")).toBeUndefined();
  });

  it("still takes the new name after an unrelated device-editor save", () => {
    // The regression: saving any other field through the editor dropped baseLabel,
    // and the swap then read the device as user-renamed.
    useSchematicStore.setState({ nodes: [speakerNode("spk-1", "Powered Speaker (IEC)")] });
    const before = useSchematicStore.getState().nodes[0].data as DeviceData;
    useSchematicStore.getState().updateDevice("spk-1", { ...before, note: "flown, stage left" });
    expect(baseLabelOf("spk-1")).toBe("Powered Speaker (IEC)");

    swapTo("spk-1", REPLACEMENT);
    expect(labelOf("spk-1")).toBe("Powered Speaker (powerCON)");
  });

  it("treats a name changed in the device editor as a rename", () => {
    useSchematicStore.setState({ nodes: [speakerNode("spk-1", "Powered Speaker (IEC)")] });
    const before = useSchematicStore.getState().nodes[0].data as DeviceData;
    useSchematicStore.getState().updateDevice("spk-1", { ...before, label: "House Left" });
    expect(baseLabelOf("spk-1")).toBeUndefined();

    swapTo("spk-1", REPLACEMENT);
    expect(labelOf("spk-1")).toBe("House Left");
  });

  it("leaves auto-numbering intact when one of a numbered pair is edited", () => {
    useSchematicStore.setState({
      nodes: [
        speakerNode("spk-1", "Powered Speaker (IEC) 1"),
        speakerNode("spk-2", "Powered Speaker (IEC) 2", 400),
      ],
    });
    const first = useSchematicStore.getState().nodes[0].data as DeviceData;
    useSchematicStore.getState().updateDevice("spk-1", { ...first, note: "flown, stage left" });
    expect(labelOf("spk-1")).toBe("Powered Speaker (IEC) 1");
    expect(labelOf("spk-2")).toBe("Powered Speaker (IEC) 2");

    // Swapping one out leaves the other as the only IEC speaker, so it drops its number.
    swapTo("spk-1", REPLACEMENT);
    expect(labelOf("spk-1")).toBe("Powered Speaker (powerCON)");
    expect(labelOf("spk-2")).toBe("Powered Speaker (IEC)");
  });
});

/** A power amplifier as the fixture (and every pre-#333 save) stores it: `model` records
 *  the template it came from, but `baseLabel` was dropped long ago. */
const FIXTURE_AMP = (fixture.nodes as unknown as DeviceNode[]).find((n) => n.id === "device-6")!;

const AMP_REPLACEMENT: DeviceTemplate = {
  id: "qsc-pld4-5",
  deviceType: "amplifier",
  label: "QSC PLD 4.5",
  manufacturer: "QSC",
  modelNumber: "PLD4.5",
  ports: [
    port("xlr-in-1", { label: "Input A" }),
    port("xlr-in-2", { label: "Input B" }),
    port("spk-out-1", { label: "Output 1", signalType: "speaker-level", direction: "output", connectorType: "speakon" }),
    port("ac-in", { label: "AC In", signalType: "power", connectorType: "iec" }),
  ],
};

function ampNode(label: string, overrides: Partial<DeviceData> = {}): DeviceNode {
  return {
    ...FIXTURE_AMP,
    id: "amp-1",
    position: { x: 0, y: 0 },
    data: { ...structuredClone(FIXTURE_AMP.data), label, ...overrides },
  } as DeviceNode;
}

describe("device name on swap, devices that never carried baseLabel (#333)", () => {
  beforeEach(() => {
    useSchematicStore.setState({ nodes: [], edges: [], pendingPortEditConflicts: null, toasts: [] });
  });

  it("renames a device whose label is still its model name", () => {
    // The seeded fixture's `Amp` — and everything ckgentry had already saved through the
    // device editor. `baseLabel` is gone for good on this data, so the swap has to fall
    // back to `model` or the reported symptom survives on every existing schematic.
    expect(FIXTURE_AMP.data.baseLabel).toBeUndefined();
    expect(FIXTURE_AMP.data.model).toBe("Amp");

    useSchematicStore.setState({ nodes: [ampNode("Amp")] });
    swapTo("amp-1", AMP_REPLACEMENT);
    expect(labelOf("amp-1")).toBe("QSC PLD 4.5");
    expect(baseLabelOf("amp-1")).toBe("QSC PLD 4.5");
  });

  it("renames a device still wearing an auto-number suffix", () => {
    useSchematicStore.setState({ nodes: [ampNode("Amp 2")] });
    swapTo("amp-1", AMP_REPLACEMENT);
    expect(labelOf("amp-1")).toBe("QSC PLD 4.5");
  });

  it("keeps a user-typed name even with baseLabel gone", () => {
    useSchematicStore.setState({ nodes: [ampNode("Amp Rack B")] });
    swapTo("amp-1", AMP_REPLACEMENT);
    expect(labelOf("amp-1")).toBe("Amp Rack B");
    expect(baseLabelOf("amp-1")).toBeUndefined();
  });

  it("keeps the name when there is no model to compare against", () => {
    useSchematicStore.setState({ nodes: [ampNode("Amp", { model: undefined })] });
    swapTo("amp-1", AMP_REPLACEMENT);
    expect(labelOf("amp-1")).toBe("Amp");
  });

  it("reads baseLabel first, then the model fallback", () => {
    expect(isAutoNamedDevice({ label: "House Left", baseLabel: "Amp", model: "Amp" })).toBe(true);
    expect(isAutoNamedDevice({ label: "Amp", model: "Amp" })).toBe(true);
    expect(isAutoNamedDevice({ label: "Amp 12", model: "Amp" })).toBe(true);
    // Not renumberNodes' handiwork: it only ever appends " <digits>".
    expect(isAutoNamedDevice({ label: "Amp 2 Spare", model: "Amp" })).toBe(false);
    expect(isAutoNamedDevice({ label: "Amp Rack B", model: "Amp" })).toBe(false);
    expect(isAutoNamedDevice({ label: "Amp", model: undefined })).toBe(false);
  });
});
