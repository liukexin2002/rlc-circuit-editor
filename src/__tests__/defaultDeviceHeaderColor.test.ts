/**
 * The default device header color (#354).
 *
 * Four levels feed one value, in this order: the project preset's saved color, the
 * template's own saved color, the per-project override that travels inside the schematic
 * file, and the app-level preference in localStorage (every project on this machine). With
 * none of them set a new device carries no `headerColor` at all so DeviceNode keeps painting
 * `--color-surface`. A color saved onto a template or a preset is a statement about that
 * device, so it outranks both defaults, which only speak for unopinionated devices.
 *
 * The color is stamped at placement, never resolved at paint time, so the tests below also
 * pin the thing users would notice most if it broke: changing either setting must leave
 * devices already on the canvas exactly as they are.
 *
 * Driven through the store's real `addDevice` / `insertAdapter` over the seeded test
 * fixture (#307), whose port ids end in -in/-out the way the app's really do.
 *
 * The store reads editor preferences from localStorage at import time, so a minimal
 * in-memory localStorage is installed before the store is imported.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import fixture from "../testSchematic/schematic.json";
import { buildImportResult, matchDevices, type ParsedConnection } from "../csvImport";
import { planDeviceSwap } from "../deviceSwap";
import { parseJsonImport } from "../import/parseJson";
import {
  DEFAULT_DEVICE_HEADER_COLOR_KEY,
  normalizeHeaderColor,
  resolveDefaultDeviceHeaderColor,
  resolveDeviceHeaderColor,
  type HeaderColorCapture,
} from "../deviceHeaderColor";
import {
  buildDeviceTemplate,
  buildTemplatePreset,
  type PortDraft,
  type PresetFormValues,
  type TemplateFormValues,
} from "../deviceTemplateBuild";
import type { DeviceData, DeviceNode, DeviceTemplate, SchematicFile, TemplatePreset } from "../types";

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

const file = fixture as unknown as SchematicFile;

/** A minimal library template — one input, one output, in the -in/-out id shape the
 *  seeded fixture and the real device library both use. */
const TEMPLATE: DeviceTemplate = {
  id: "test-scaler",
  deviceType: "converter",
  label: "Test Scaler",
  color: "#1d4ed8",
  ports: [
    { id: "scaler-hdmi-in", label: "HDMI In", signalType: "hdmi", direction: "input", connectorType: "hdmi" },
    { id: "scaler-hdmi-out", label: "HDMI Out", signalType: "hdmi", direction: "output", connectorType: "hdmi" },
  ],
};

/** A different model to swap the placed device for — same port shape, its own body color. */
const SWAP_TARGET: DeviceTemplate = {
  id: "test-scaler-mk2",
  deviceType: "converter",
  label: "Test Scaler mk2",
  color: "#15803d",
  ports: [
    { id: "mk2-hdmi-in", label: "HDMI In", signalType: "hdmi", direction: "input", connectorType: "hdmi" },
    { id: "mk2-hdmi-out", label: "HDMI Out", signalType: "hdmi", direction: "output", connectorType: "hdmi" },
  ],
};

/** The adapter offered for the fixture's TS-out → XLR-in mismatch. */
const TS_TO_XLR: DeviceTemplate = {
  id: "test-ts-xlr",
  deviceType: "cable-accessory",
  label: "TS → XLR Adapter",
  ports: [
    { id: "adapter-ts-in", label: "TS In", signalType: "analog-audio", direction: "input", connectorType: "ts-quarter" },
    { id: "adapter-xlr-out", label: "XLR Out", signalType: "analog-audio", direction: "output", connectorType: "xlr-3" },
  ],
};

beforeEach(() => {
  localStorage.removeItem(DEFAULT_DEVICE_HEADER_COLOR_KEY);
  // Loaded through the store's real open-a-file path rather than by assigning nodes
  // straight into state, so the node id counter is synced past the fixture's own
  // device-1…device-N and a freshly placed device gets an id nothing else is using.
  useSchematicStore.getState().importFromJSON(structuredClone(file));
  useSchematicStore.getState().clearAllCustomTemplates();
  useSchematicStore.setState({
    appDefaultDeviceHeaderColor: undefined,
    defaultDeviceHeaderColor: undefined,
    templatePresets: {},
    pendingIncompatibleConnection: null,
  });
});

/** The device `addDevice` just appended. */
function lastDevice(): DeviceData {
  const nodes = useSchematicStore.getState().nodes;
  return (nodes[nodes.length - 1] as DeviceNode).data;
}

function place(): DeviceData {
  useSchematicStore.getState().addDevice(TEMPLATE, { x: 0, y: 0 });
  return lastDevice();
}

describe("default device header color — precedence (#354)", () => {
  it("leaves a new device without a header color when neither setting is set", () => {
    expect(place().headerColor).toBeUndefined();
  });

  it("stamps the app preference when only it is set", () => {
    useSchematicStore.getState().setAppDefaultDeviceHeaderColor("#8b1a1a");
    expect(place().headerColor).toBe("#8b1a1a");
  });

  it("stamps the project override when only it is set", () => {
    useSchematicStore.getState().setDefaultDeviceHeaderColor("#0f766e");
    expect(place().headerColor).toBe("#0f766e");
  });

  it("lets the project override win over the app preference", () => {
    useSchematicStore.getState().setAppDefaultDeviceHeaderColor("#8b1a1a");
    useSchematicStore.getState().setDefaultDeviceHeaderColor("#0f766e");
    expect(place().headerColor).toBe("#0f766e");
  });

  it("falls back to the app preference when the project override is cleared", () => {
    useSchematicStore.getState().setAppDefaultDeviceHeaderColor("#8b1a1a");
    useSchematicStore.getState().setDefaultDeviceHeaderColor("#0f766e");
    useSchematicStore.getState().setDefaultDeviceHeaderColor(undefined);
    expect(place().headerColor).toBe("#8b1a1a");
  });

  it("leaves the device colorless again once both are cleared", () => {
    useSchematicStore.getState().setAppDefaultDeviceHeaderColor("#8b1a1a");
    useSchematicStore.getState().setAppDefaultDeviceHeaderColor(undefined);
    expect(place().headerColor).toBeUndefined();
  });

  it("keeps the device's own body color independent of the header color", () => {
    useSchematicStore.getState().setDefaultDeviceHeaderColor("#0f766e");
    const data = place();
    expect(data.color).toBe("#1d4ed8");
    expect(data.headerColor).toBe("#0f766e");
  });

  it("resolves the same way outside the store", () => {
    expect(resolveDefaultDeviceHeaderColor("#0f766e", "#8b1a1a")).toBe("#0f766e");
    expect(resolveDefaultDeviceHeaderColor(undefined, "#8b1a1a")).toBe("#8b1a1a");
    expect(resolveDefaultDeviceHeaderColor(undefined, undefined)).toBeUndefined();
  });
});

describe("default device header color — creation paths (#354)", () => {
  it("stamps a device created for editing (the custom-device path)", () => {
    useSchematicStore.getState().setDefaultDeviceHeaderColor("#0f766e");
    useSchematicStore.getState().createAndEditDevice(TEMPLATE, { x: 0, y: 0 });
    expect(lastDevice().headerColor).toBe("#0f766e");
  });

  it("stamps an off-canvas patch panel", () => {
    useSchematicStore.getState().setDefaultDeviceHeaderColor("#0f766e");
    const id = useSchematicStore.getState().addOffCanvasPanel(TEMPLATE);
    const node = useSchematicStore.getState().nodes.find((n) => n.id === id) as DeviceNode;
    expect(node.data.headerColor).toBe("#0f766e");
  });

  it("stamps an auto-inserted adapter", () => {
    useSchematicStore.getState().setDefaultDeviceHeaderColor("#0f766e");

    // Combo Jack Box ▸ TS Out → Amp ▸ XLR In 2: one analog-audio signal, mismatched
    // connectors, which is the shape that offers an adapter instead of wiring straight
    // through. onConnect parks it as a pending incompatible connection first.
    const before = new Set(useSchematicStore.getState().nodes.map((n) => n.id));
    useSchematicStore.getState().onConnect({
      source: "device-16",
      sourceHandle: "combo-ts-out",
      target: "device-6",
      targetHandle: "amp-xlr-in-2",
    });
    expect(useSchematicStore.getState().pendingIncompatibleConnection).toBeTruthy();

    expect(useSchematicStore.getState().insertAdapterBetween(TS_TO_XLR)).not.toBe(false);

    const adapter = useSchematicStore
      .getState()
      .nodes.find((n) => !before.has(n.id) && n.type === "device") as DeviceNode | undefined;
    expect(adapter).toBeTruthy();
    expect(adapter!.data.headerColor).toBe("#0f766e");
  });

  it("stamps every device a CSV import creates", () => {
    const connections: ParsedConnection[] = [
      {
        sourceDevice: "Wireless Mic RX",
        sourcePort: "XLR Out",
        destDevice: "Mixer",
        destPort: "In 1",
        signalType: "analog-audio",
        sourceRoom: "Sanctuary",
        destRoom: "Sanctuary",
      },
    ];
    const { nodes } = buildImportResult(connections, matchDevices(connections, []), {
      defaultHeaderColor: "#0f766e",
    });

    const devices = nodes.filter((n) => n.type === "device") as DeviceNode[];
    expect(devices.length).toBe(2);
    for (const d of devices) expect(d.data.headerColor).toBe("#0f766e");
  });

  it("leaves imported devices colorless when no default is resolved", () => {
    const connections: ParsedConnection[] = [
      {
        sourceDevice: "Wireless Mic RX",
        sourcePort: "XLR Out",
        destDevice: "Mixer",
        destPort: "In 1",
        signalType: "analog-audio",
        sourceRoom: "",
        destRoom: "",
      },
    ];
    const { nodes } = buildImportResult(connections, matchDevices(connections, []));

    const devices = nodes.filter((n) => n.type === "device") as DeviceNode[];
    expect(devices.length).toBe(2);
    for (const d of devices) expect(d.data.headerColor).toBeUndefined();
  });
});

describe("default device header color — survives a device swap (#354)", () => {
  it("keeps the stamped color when the device is swapped for another model", () => {
    useSchematicStore.getState().setAppDefaultDeviceHeaderColor("#8b1a1a");
    useSchematicStore.getState().addDevice(TEMPLATE, { x: 0, y: 0 });
    const nodeId = useSchematicStore.getState().nodes.at(-1)!.id;
    expect(lastDevice().headerColor).toBe("#8b1a1a");

    const state = useSchematicStore.getState();
    const node = state.nodes.find((n) => n.id === nodeId) as DeviceNode;
    useSchematicStore
      .getState()
      .swapDevice(nodeId, planDeviceSwap(node.data, nodeId, SWAP_TARGET, state.edges));

    const swapped = useSchematicStore.getState().nodes.find((n) => n.id === nodeId) as DeviceNode;
    // The model and its body color come from the new template; the header color is the
    // device's own and stays put.
    expect(swapped.data.model).toBe("Test Scaler mk2");
    expect(swapped.data.color).toBe("#15803d");
    expect(swapped.data.headerColor).toBe("#8b1a1a");
  });

  it("does not invent a header color for a device that never had one", () => {
    useSchematicStore.getState().addDevice(TEMPLATE, { x: 0, y: 0 });
    const nodeId = useSchematicStore.getState().nodes.at(-1)!.id;
    expect(lastDevice().headerColor).toBeUndefined();

    // The setting changes after placement — a swap must not retroactively stamp it.
    useSchematicStore.getState().setAppDefaultDeviceHeaderColor("#8b1a1a");

    const state = useSchematicStore.getState();
    const node = state.nodes.find((n) => n.id === nodeId) as DeviceNode;
    useSchematicStore
      .getState()
      .swapDevice(nodeId, planDeviceSwap(node.data, nodeId, SWAP_TARGET, state.edges));

    const swapped = useSchematicStore.getState().nodes.find((n) => n.id === nodeId) as DeviceNode;
    expect(swapped.data.headerColor).toBeUndefined();
  });
});

describe("default device header color — no retroactive recolor (#354)", () => {
  it("leaves devices already on the canvas alone when either setting changes", () => {
    const before = JSON.stringify(useSchematicStore.getState().nodes);

    useSchematicStore.getState().setAppDefaultDeviceHeaderColor("#8b1a1a");
    useSchematicStore.getState().setDefaultDeviceHeaderColor("#0f766e");

    expect(JSON.stringify(useSchematicStore.getState().nodes)).toBe(before);
  });

  it("leaves an already-placed device alone when the setting changes afterwards", () => {
    useSchematicStore.getState().setDefaultDeviceHeaderColor("#0f766e");
    useSchematicStore.getState().addDevice(TEMPLATE, { x: 0, y: 0 });
    const placedId = useSchematicStore.getState().nodes.at(-1)!.id;

    useSchematicStore.getState().setDefaultDeviceHeaderColor("#8b1a1a");
    useSchematicStore.getState().addDevice(TEMPLATE, { x: 200, y: 0 });

    const placed = useSchematicStore.getState().nodes.find((n) => n.id === placedId) as DeviceNode;
    expect(placed.data.headerColor).toBe("#0f766e");
    expect(lastDevice().headerColor).toBe("#8b1a1a");
  });
});

describe("default device header color — persistence (#354)", () => {
  it("writes the project override into the exported schematic file", () => {
    useSchematicStore.getState().setDefaultDeviceHeaderColor("#0f766e");
    expect(useSchematicStore.getState().exportToJSON().defaultDeviceHeaderColor).toBe("#0f766e");
  });

  it("omits the project override from the file when it isn't set", () => {
    expect(useSchematicStore.getState().exportToJSON().defaultDeviceHeaderColor).toBeUndefined();
  });

  it("round-trips the project override through export and import", () => {
    useSchematicStore.getState().setDefaultDeviceHeaderColor("#0f766e");
    const exported = JSON.parse(JSON.stringify(useSchematicStore.getState().exportToJSON())) as SchematicFile;

    useSchematicStore.getState().setDefaultDeviceHeaderColor(undefined);
    useSchematicStore.getState().importFromJSON(exported);

    expect(useSchematicStore.getState().defaultDeviceHeaderColor).toBe("#0f766e");
    expect(place().headerColor).toBe("#0f766e");
  });

  it("defaults to unset when an older file has no such field", () => {
    useSchematicStore.getState().setDefaultDeviceHeaderColor("#0f766e");

    // A file written before #354 — the key simply isn't there.
    const legacy = JSON.parse(JSON.stringify(file)) as SchematicFile;
    delete legacy.defaultDeviceHeaderColor;
    useSchematicStore.getState().importFromJSON(legacy);

    expect(useSchematicStore.getState().defaultDeviceHeaderColor).toBeUndefined();
    expect(place().headerColor).toBeUndefined();
  });

  it("ignores a junk color in a loaded file rather than stamping it onto devices", () => {
    const tampered = JSON.parse(JSON.stringify(file)) as SchematicFile;
    (tampered as unknown as Record<string, unknown>).defaultDeviceHeaderColor = "javascript:alert(1)";
    useSchematicStore.getState().importFromJSON(tampered);

    expect(useSchematicStore.getState().defaultDeviceHeaderColor).toBeUndefined();
    expect(place().headerColor).toBeUndefined();
  });

  it("keeps the app preference out of the schematic file", () => {
    useSchematicStore.getState().setAppDefaultDeviceHeaderColor("#8b1a1a");
    expect(useSchematicStore.getState().exportToJSON().defaultDeviceHeaderColor).toBeUndefined();
  });

  it("persists the app preference to localStorage and clears it on reset", () => {
    useSchematicStore.getState().setAppDefaultDeviceHeaderColor("#8b1a1a");
    expect(localStorage.getItem(DEFAULT_DEVICE_HEADER_COLOR_KEY)).toBe("#8b1a1a");

    useSchematicStore.getState().setAppDefaultDeviceHeaderColor(undefined);
    expect(localStorage.getItem(DEFAULT_DEVICE_HEADER_COLOR_KEY)).toBeNull();
  });

  it("drops the project override on New Schematic but keeps the app preference", () => {
    useSchematicStore.getState().setAppDefaultDeviceHeaderColor("#8b1a1a");
    useSchematicStore.getState().setDefaultDeviceHeaderColor("#0f766e");

    useSchematicStore.getState().newSchematic();

    expect(useSchematicStore.getState().defaultDeviceHeaderColor).toBeUndefined();
    expect(useSchematicStore.getState().appDefaultDeviceHeaderColor).toBe("#8b1a1a");
    expect(place().headerColor).toBe("#8b1a1a");
  });
});

describe("default device header color — app preference reload (#354)", () => {
  // Reloading the store re-reads the ~1.3MB device library, so allow a generous ceiling.
  const RELOAD_TIMEOUT = 30000;

  it("reads the stored app preference back on the next session", async () => {
    const storage = new MemStorage();
    storage.setItem(DEFAULT_DEVICE_HEADER_COLOR_KEY, "#8b1a1a");
    (globalThis as { localStorage?: unknown }).localStorage = storage;
    vi.resetModules();

    const reloaded = (await import("../store")).useSchematicStore;
    expect(reloaded.getState().appDefaultDeviceHeaderColor).toBe("#8b1a1a");
  }, RELOAD_TIMEOUT);

  it("ignores a junk stored value instead of stamping it onto devices", async () => {
    const storage = new MemStorage();
    storage.setItem(DEFAULT_DEVICE_HEADER_COLOR_KEY, "chartreuse");
    (globalThis as { localStorage?: unknown }).localStorage = storage;
    vi.resetModules();

    const reloaded = (await import("../store")).useSchematicStore;
    expect(reloaded.getState().appDefaultDeviceHeaderColor).toBeUndefined();
  }, RELOAD_TIMEOUT);
});

describe("header color normalization (#354)", () => {
  it("accepts hex colors and lowercases them", () => {
    expect(normalizeHeaderColor("#0F766E")).toBe("#0f766e");
  });

  it("expands the 3-digit shorthand, which a color picker cannot show", () => {
    expect(normalizeHeaderColor("  #abc  ")).toBe("#aabbcc");
    expect(normalizeHeaderColor("#F00")).toBe("#ff0000");
  });

  it("stamps the expanded form onto devices, so the picker and the header agree", () => {
    useSchematicStore.getState().setDefaultDeviceHeaderColor("#abc");
    expect(useSchematicStore.getState().defaultDeviceHeaderColor).toBe("#aabbcc");
    expect(place().headerColor).toBe("#aabbcc");
  });

  it("rejects anything that isn't a hex color", () => {
    for (const junk of ["teal", "rgb(1,2,3)", "var(--color-surface)", "#12345", "", 42, null, undefined]) {
      expect(normalizeHeaderColor(junk)).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// A header color saved onto a template or a preset (#354, gate item 354-4)
// ---------------------------------------------------------------------------

/** The preset the "Save as Preset" flow writes for TEMPLATE: the same two ports under the
 *  stable preset- ids the editor assigns, plus whatever colors it captured. */
function presetFor(extra: { color?: string; headerColor?: string } = {}): TemplatePreset {
  return {
    ports: [
      { id: "preset-0", label: "HDMI In", signalType: "hdmi", direction: "input", connectorType: "hdmi" },
      { id: "preset-1", label: "HDMI Out", signalType: "hdmi", direction: "output", connectorType: "hdmi" },
    ],
    ...extra,
  };
}

/** Place the template the store has stored under TEMPLATE.id, the way the device library
 *  does — so a user template's saved fields are read back out of the store rather than
 *  handed straight to `addDevice` by the test. */
function placeStoredTemplate(): DeviceData {
  const stored = useSchematicStore.getState().customTemplates.find((t) => t.id === TEMPLATE.id);
  expect(stored).toBeTruthy();
  useSchematicStore.getState().addDevice(stored!, { x: 0, y: 0 });
  return lastDevice();
}

/** The editor's port rows for a device placed from TEMPLATE, in the draft shape the port
 *  table holds them in before a save normalizes the ids. */
function portDrafts(): PortDraft[] {
  return TEMPLATE.ports.map((p) => ({
    id: `${p.id}-instance`,
    label: p.label,
    signalType: p.signalType,
    direction: p.direction,
    connectorType: p.connectorType,
  }));
}

/** How the header-color picker stands when the editor opens a device: showing whatever color
 *  the device carries, untouched, over whatever the two settings say. */
function capture(over: Partial<HeaderColorCapture> = {}): HeaderColorCapture {
  return {
    deviceHeaderColor: undefined,
    edited: false,
    savedHeaderColor: undefined,
    projectDefault: undefined,
    appDefault: undefined,
    ...over,
  };
}

/** The form state DeviceEditor hands `buildDeviceTemplate` for a device placed from
 *  TEMPLATE — the same fields, in the same shapes, its own useState holds. */
function templateForm(headerColor: HeaderColorCapture): TemplateFormValues {
  return {
    ports: portDrafts(),
    label: "Test Scaler",
    shortName: "",
    deviceType: "converter",
    color: "#1d4ed8",
    headerColor,
    category: "",
    manufacturer: "Test Co",
    modelNumber: "TS-1",
    referenceUrl: "",
    hostname: "",
    powerDrawW: 12,
    powerCapacityW: undefined,
    voltage: undefined,
    thermalBtuh: undefined,
    poeBudgetW: undefined,
    poeDrawW: undefined,
    unitCost: undefined,
    heightMm: undefined,
    widthMm: undefined,
    depthMm: undefined,
    weightKg: undefined,
    rackForm: undefined,
    isVenueProvided: false,
    auxiliaryData: [],
    searchTermsRaw: "",
    existing: undefined,
  };
}

/** The form state DeviceEditor hands `buildTemplatePreset` for the same device. */
function presetForm(headerColor: HeaderColorCapture, hiddenPorts: string[] = []): PresetFormValues {
  return { ports: portDrafts(), hiddenPorts, color: "#1d4ed8", headerColor };
}

const savedTemplate = (headerColor: HeaderColorCapture): DeviceTemplate =>
  buildDeviceTemplate(templateForm(headerColor), { id: TEMPLATE.id!, version: 2 });

describe("saved header color — capture on save (#354)", () => {
  // The template the editor builds is what Save as User Template, Update User Template and
  // Update as Custom all write, and the preset is what Save as Preset writes, so asserting on
  // these two builders covers every template-family save path.

  it("carries a header color the user picked onto the template it saves", () => {
    const tpl = savedTemplate(capture({ deviceHeaderColor: "#0f766e", edited: true }));
    expect(tpl.headerColor).toBe("#0f766e");
  });

  it("carries it onto the preset Save as Preset writes", () => {
    const preset = buildTemplatePreset(presetForm(capture({ deviceHeaderColor: "#0f766e", edited: true })));
    expect(preset.headerColor).toBe("#0f766e");
  });

  it("canonicalizes what it captures, so the saved value is always #rrggbb", () => {
    expect(savedTemplate(capture({ deviceHeaderColor: "#0F766E", edited: true })).headerColor).toBe("#0f766e");
    expect(savedTemplate(capture({ deviceHeaderColor: "#abc", edited: true })).headerColor).toBe("#aabbcc");
  });

  it("leaves the field off entirely for a device with no header color", () => {
    const tpl = savedTemplate(capture());
    expect(tpl.headerColor).toBeUndefined();
    expect("headerColor" in tpl).toBe(false);
    expect("headerColor" in buildTemplatePreset(presetForm(capture()))).toBe(false);
  });

  it("leaves the field off rather than saving a value a picker could not show", () => {
    for (const junk of ["teal", "rgb(1,2,3)", "var(--color-surface)", "#12345", ""]) {
      expect(savedTemplate(capture({ deviceHeaderColor: junk, edited: true })).headerColor).toBeUndefined();
      expect(buildTemplatePreset(presetForm(capture({ deviceHeaderColor: junk, edited: true }))).headerColor).toBeUndefined();
    }
  });

  it("stamps a user template's saved color onto every device placed from it", () => {
    // Save as User Template with a color the user picked, then place the stored template
    // again — the new device comes out that color with no default set anywhere.
    useSchematicStore.getState().addCustomTemplate(
      savedTemplate(capture({ deviceHeaderColor: "#7c2d12", edited: true })),
    );
    expect(placeStoredTemplate().headerColor).toBe("#7c2d12");
  });

  it("stamps a preset's saved color onto every device placed from that template", () => {
    useSchematicStore.getState().setTemplatePreset(
      TEMPLATE.id!,
      buildTemplatePreset(presetForm(capture({ deviceHeaderColor: "#7c2d12", edited: true }))),
    );
    expect(place().headerColor).toBe("#7c2d12");
  });
});

describe("saved header color — only a color the user actually picked is captured (#354)", () => {
  const APP = "#8b1a1a";
  const PROJECT = "#0f766e";

  it("does not bake into a template a color the device only inherited from a default", () => {
    // Every device is stamped with the resolved default at placement, so a device wearing the
    // app preference is not evidence anyone chose that color for it.
    const inherited = capture({ deviceHeaderColor: APP, appDefault: APP });
    expect(savedTemplate(inherited).headerColor).toBeUndefined();
    expect(buildTemplatePreset(presetForm(inherited)).headerColor).toBeUndefined();
  });

  it("does not bake an inherited project override in either", () => {
    const inherited = capture({ deviceHeaderColor: PROJECT, projectDefault: PROJECT, appDefault: APP });
    expect(savedTemplate(inherited).headerColor).toBeUndefined();
  });

  it("leaves the project override in charge after a Save as Preset made only to pin ports", () => {
    // Dylan's scenario: app preference on, place a device (stamped with it), open the editor
    // and Save as Preset purely to pin port visibility. The project override set later must
    // still reach devices placed from that template.
    useSchematicStore.getState().setAppDefaultDeviceHeaderColor(APP);
    const placed = place();
    expect(placed.headerColor).toBe(APP);

    useSchematicStore.getState().setTemplatePreset(
      TEMPLATE.id!,
      buildTemplatePreset(presetForm(capture({ deviceHeaderColor: placed.headerColor, appDefault: APP }), ["scaler-hdmi-out-instance"])),
    );
    useSchematicStore.getState().setDefaultDeviceHeaderColor(PROJECT);

    expect(place().headerColor).toBe(PROJECT);
    // …and the preset still did the job it was saved for.
    expect(useSchematicStore.getState().templatePresets[TEMPLATE.id!].hiddenPorts).toEqual(["preset-1"]);
  });

  it("captures a color the user picked even when it matches the default in force", () => {
    const chosen = capture({ deviceHeaderColor: APP, edited: true, appDefault: APP });
    expect(savedTemplate(chosen).headerColor).toBe(APP);
  });

  it("keeps the color a template already carried when the user edits something else", () => {
    // Update User Template on a device showing its template's own saved color: the color is
    // the template's, not an inherited default, so the update must not drop it.
    const untouched = capture({ deviceHeaderColor: "#7c2d12", savedHeaderColor: "#7c2d12", appDefault: APP });
    expect(savedTemplate(untouched).headerColor).toBe("#7c2d12");
  });

  it("keeps a preset's own color when the device is showing it", () => {
    const untouched = capture({ deviceHeaderColor: "#7c2d12", savedHeaderColor: "#7c2d12", projectDefault: PROJECT });
    expect(buildTemplatePreset(presetForm(untouched)).headerColor).toBe("#7c2d12");
  });

  it("keeps a saved color the editor never showed rather than erasing it", () => {
    const untouched = capture({ deviceHeaderColor: undefined, savedHeaderColor: "#7c2d12" });
    expect(savedTemplate(untouched).headerColor).toBe("#7c2d12");
  });

  it("clears the saved color when the user resets the picker", () => {
    // Reset beside the picker is an edit like any other, so it takes the color back off.
    const reset = capture({ deviceHeaderColor: undefined, edited: true, savedHeaderColor: "#7c2d12" });
    expect(savedTemplate(reset).headerColor).toBeUndefined();
    expect(buildTemplatePreset(presetForm(reset)).headerColor).toBeUndefined();
  });

  it("captures a color no default accounts for even when the picker was not touched", () => {
    // A hand-picked color from an earlier session, saved on the device and reopened.
    const carried = capture({ deviceHeaderColor: "#7c2d12", projectDefault: PROJECT, appDefault: APP });
    expect(savedTemplate(carried).headerColor).toBe("#7c2d12");
  });
});

describe("the template and preset builders (#354)", () => {
  // These builders were lifted out of DeviceEditor so the header-color rule above is testable;
  // the rest of what they write has to come out unchanged.
  it("normalizes ports onto stable template ids and drops unlabeled rows", () => {
    const form = templateForm(capture());
    form.ports = [...portDrafts(), { id: "blank", label: "   ", signalType: "hdmi", direction: "input" }];
    const tpl = buildDeviceTemplate(form, { id: "custom-1" });
    expect(tpl.ports.map((p) => p.id)).toEqual(["tpl-0", "tpl-1"]);
    expect(tpl.ports.map((p) => p.label)).toEqual(["HDMI In", "HDMI Out"]);
  });

  it("carries the rest of the form onto the template and lets overrides win", () => {
    const tpl = buildDeviceTemplate(templateForm(capture()), { id: "custom-1", version: 3, label: "Test Scaler (Custom)" });
    expect(tpl).toMatchObject({
      id: "custom-1",
      version: 3,
      label: "Test Scaler (Custom)",
      deviceType: "converter",
      color: "#1d4ed8",
      manufacturer: "Test Co",
      modelNumber: "TS-1",
      powerDrawW: 12,
    });
    expect("shortName" in tpl).toBe(false);
  });

  it("remaps hidden ports onto the preset ids", () => {
    const preset = buildTemplatePreset(presetForm(capture(), ["scaler-hdmi-out-instance", "gone"]));
    expect(preset.ports.map((p) => p.id)).toEqual(["preset-0", "preset-1"]);
    expect(preset.hiddenPorts).toEqual(["preset-1"]);
    expect(preset.color).toBe("#1d4ed8");
  });
});

describe("saved header color — precedence at placement (#354)", () => {
  const PRESET = "#b91c1c";
  const TEMPLATE_COLOR = "#7c2d12";
  const PROJECT = "#0f766e";
  const APP = "#8b1a1a";

  const withTemplateColor = (): DeviceTemplate => ({ ...TEMPLATE, headerColor: TEMPLATE_COLOR });

  it("puts the preset's saved color above everything else", () => {
    useSchematicStore.getState().setAppDefaultDeviceHeaderColor(APP);
    useSchematicStore.getState().setDefaultDeviceHeaderColor(PROJECT);
    useSchematicStore.getState().setTemplatePreset(TEMPLATE.id!, presetFor({ headerColor: PRESET }));

    useSchematicStore.getState().addDevice(withTemplateColor(), { x: 0, y: 0 });
    expect(lastDevice().headerColor).toBe(PRESET);
  });

  it("falls to the template's saved color when the preset has none", () => {
    useSchematicStore.getState().setAppDefaultDeviceHeaderColor(APP);
    useSchematicStore.getState().setDefaultDeviceHeaderColor(PROJECT);
    // A preset saved before this change, or from a device with no header color.
    useSchematicStore.getState().setTemplatePreset(TEMPLATE.id!, presetFor());

    useSchematicStore.getState().addDevice(withTemplateColor(), { x: 0, y: 0 });
    expect(lastDevice().headerColor).toBe(TEMPLATE_COLOR);
  });

  it("falls to the project override when neither the preset nor the template has one", () => {
    useSchematicStore.getState().setAppDefaultDeviceHeaderColor(APP);
    useSchematicStore.getState().setDefaultDeviceHeaderColor(PROJECT);
    useSchematicStore.getState().setTemplatePreset(TEMPLATE.id!, presetFor());

    expect(place().headerColor).toBe(PROJECT);
  });

  it("falls all the way to the app preference, then to no color at all", () => {
    useSchematicStore.getState().setAppDefaultDeviceHeaderColor(APP);
    expect(place().headerColor).toBe(APP);

    useSchematicStore.getState().setAppDefaultDeviceHeaderColor(undefined);
    expect(place().headerColor).toBeUndefined();
  });

  it("walks the whole ladder down as each rung is removed", () => {
    useSchematicStore.getState().setAppDefaultDeviceHeaderColor(APP);
    useSchematicStore.getState().setDefaultDeviceHeaderColor(PROJECT);
    useSchematicStore.getState().setTemplatePreset(TEMPLATE.id!, presetFor({ headerColor: PRESET }));

    useSchematicStore.getState().addDevice(withTemplateColor(), { x: 0, y: 0 });
    expect(lastDevice().headerColor).toBe(PRESET);

    useSchematicStore.getState().setTemplatePreset(TEMPLATE.id!, null);
    useSchematicStore.getState().addDevice(withTemplateColor(), { x: 0, y: 0 });
    expect(lastDevice().headerColor).toBe(TEMPLATE_COLOR);

    useSchematicStore.getState().addDevice(TEMPLATE, { x: 0, y: 0 });
    expect(lastDevice().headerColor).toBe(PROJECT);

    useSchematicStore.getState().setDefaultDeviceHeaderColor(undefined);
    expect(place().headerColor).toBe(APP);

    useSchematicStore.getState().setAppDefaultDeviceHeaderColor(undefined);
    expect(place().headerColor).toBeUndefined();
  });

  it("keeps the body color and the header color on separate ladders", () => {
    // preset.color decides the body, preset.headerColor the header — one must not stand in
    // for the other.
    useSchematicStore.getState().setTemplatePreset(TEMPLATE.id!, presetFor({ color: "#15803d" }));
    useSchematicStore.getState().setDefaultDeviceHeaderColor(PROJECT);

    const data = place();
    expect(data.color).toBe("#15803d");
    expect(data.headerColor).toBe(PROJECT);
  });

  it("resolves the same way outside the store", () => {
    expect(resolveDeviceHeaderColor(PRESET, TEMPLATE_COLOR, PROJECT, APP)).toBe(PRESET);
    expect(resolveDeviceHeaderColor(undefined, TEMPLATE_COLOR, PROJECT, APP)).toBe(TEMPLATE_COLOR);
    expect(resolveDeviceHeaderColor(undefined, undefined, PROJECT, APP)).toBe(PROJECT);
    expect(resolveDeviceHeaderColor(undefined, undefined, undefined, APP)).toBe(APP);
    expect(resolveDeviceHeaderColor(undefined, undefined, undefined, undefined)).toBeUndefined();
  });
});

describe("saved header color — the other placement paths (#354)", () => {
  it("gives an auto-inserted adapter the color saved on its own template", () => {
    useSchematicStore.getState().setDefaultDeviceHeaderColor("#0f766e");

    const before = new Set(useSchematicStore.getState().nodes.map((n) => n.id));
    useSchematicStore.getState().onConnect({
      source: "device-16",
      sourceHandle: "combo-ts-out",
      target: "device-6",
      targetHandle: "amp-xlr-in-2",
    });
    expect(useSchematicStore.getState().pendingIncompatibleConnection).toBeTruthy();

    expect(
      useSchematicStore.getState().insertAdapterBetween({ ...TS_TO_XLR, headerColor: "#7c2d12" }),
    ).not.toBe(false);

    const adapter = useSchematicStore
      .getState()
      .nodes.find((n) => !before.has(n.id) && n.type === "device") as DeviceNode | undefined;
    expect(adapter).toBeTruthy();
    expect(adapter!.data.headerColor).toBe("#7c2d12");
  });

  it("gives a CSV-imported device the color saved on the template it matched", () => {
    const connections: ParsedConnection[] = [
      {
        sourceDevice: "Test Scaler",
        sourcePort: "HDMI Out",
        destDevice: "Some Display",
        destPort: "HDMI In",
        signalType: "hdmi",
        sourceRoom: "",
        destRoom: "",
      },
    ];
    const withColor: DeviceTemplate = { ...TEMPLATE, headerColor: "#7c2d12" };
    const { nodes } = buildImportResult(connections, matchDevices(connections, [withColor]), {
      defaultHeaderColor: "#0f766e",
    });

    const devices = nodes.filter((n) => n.type === "device") as DeviceNode[];
    const matched = devices.find((d) => d.data.label === "Test Scaler");
    const unmatched = devices.find((d) => d.data.label === "Some Display");
    expect(matched!.data.headerColor).toBe("#7c2d12");
    // A row that matched no template still takes the resolved default.
    expect(unmatched!.data.headerColor).toBe("#0f766e");
  });

  it("puts a project preset's color above the template's for a CSV import too", () => {
    // Otherwise the same model comes out one color from the library and another from a CSV.
    const connections: ParsedConnection[] = [
      {
        sourceDevice: "Test Scaler",
        sourcePort: "HDMI Out",
        destDevice: "Some Display",
        destPort: "HDMI In",
        signalType: "hdmi",
        sourceRoom: "",
        destRoom: "",
      },
    ];
    const withColor: DeviceTemplate = { ...TEMPLATE, headerColor: "#7c2d12" };
    const { nodes } = buildImportResult(connections, matchDevices(connections, [withColor]), {
      defaultHeaderColor: "#0f766e",
      templatePresets: { [TEMPLATE.id!]: { headerColor: "#B91C1C" } },
    });

    const matched = (nodes.filter((n) => n.type === "device") as DeviceNode[])
      .find((d) => d.data.label === "Test Scaler");
    expect(matched!.data.headerColor).toBe("#b91c1c");

    // …the same order the library placement path resolves.
    useSchematicStore.getState().setDefaultDeviceHeaderColor("#0f766e");
    useSchematicStore.getState().setTemplatePreset(TEMPLATE.id!, presetFor({ headerColor: "#b91c1c" }));
    useSchematicStore.getState().addDevice(withColor, { x: 0, y: 0 });
    expect(lastDevice().headerColor).toBe("#b91c1c");
  });

  it("keeps a swapped device's own header color ahead of the new template's", () => {
    useSchematicStore.getState().setAppDefaultDeviceHeaderColor("#8b1a1a");
    useSchematicStore.getState().addDevice(TEMPLATE, { x: 0, y: 0 });
    const nodeId = useSchematicStore.getState().nodes.at(-1)!.id;

    const state = useSchematicStore.getState();
    const node = state.nodes.find((n) => n.id === nodeId) as DeviceNode;
    const target: DeviceTemplate = { ...SWAP_TARGET, headerColor: "#7c2d12" };
    useSchematicStore.getState().swapDevice(nodeId, planDeviceSwap(node.data, nodeId, target, state.edges));

    const swapped = useSchematicStore.getState().nodes.find((n) => n.id === nodeId) as DeviceNode;
    expect(swapped.data.headerColor).toBe("#8b1a1a");
  });

  it("gives a swapped device the new template's saved color when it had none of its own", () => {
    useSchematicStore.getState().addDevice(TEMPLATE, { x: 0, y: 0 });
    const nodeId = useSchematicStore.getState().nodes.at(-1)!.id;
    expect(lastDevice().headerColor).toBeUndefined();

    const state = useSchematicStore.getState();
    const node = state.nodes.find((n) => n.id === nodeId) as DeviceNode;
    const target: DeviceTemplate = { ...SWAP_TARGET, headerColor: "#7c2d12" };
    useSchematicStore.getState().swapDevice(nodeId, planDeviceSwap(node.data, nodeId, target, state.edges));

    const swapped = useSchematicStore.getState().nodes.find((n) => n.id === nodeId) as DeviceNode;
    expect(swapped.data.headerColor).toBe("#7c2d12");
  });
});

describe("saved header color — back-compat and junk (#354)", () => {
  it("leaves a template and preset saved before this change behaving exactly as before", () => {
    useSchematicStore.getState().addCustomTemplate({ ...TEMPLATE });
    useSchematicStore.getState().setTemplatePreset(TEMPLATE.id!, presetFor({ color: "#15803d" }));

    // No default set anywhere: no header color, the way a pre-#354 file has always placed.
    expect(placeStoredTemplate().headerColor).toBeUndefined();

    // With a default set, the defaults still decide — nothing outranks them.
    useSchematicStore.getState().setDefaultDeviceHeaderColor("#0f766e");
    expect(placeStoredTemplate().headerColor).toBe("#0f766e");
  });

  it("ignores a junk color on a preset instead of stamping it onto devices", () => {
    useSchematicStore.getState().setDefaultDeviceHeaderColor("#0f766e");
    useSchematicStore.getState().setTemplatePreset(TEMPLATE.id!, {
      ...presetFor(),
      headerColor: "javascript:alert(1)",
    });

    expect(place().headerColor).toBe("#0f766e");
  });

  it("ignores a junk color on a template instead of stamping it onto devices", () => {
    useSchematicStore.getState().setDefaultDeviceHeaderColor("#0f766e");
    useSchematicStore.getState().addDevice({ ...TEMPLATE, headerColor: "chartreuse" }, { x: 0, y: 0 });
    expect(lastDevice().headerColor).toBe("#0f766e");
  });

  it("falls from a junk preset color to the template's real one", () => {
    useSchematicStore.getState().setTemplatePreset(TEMPLATE.id!, { ...presetFor(), headerColor: "#12345" });

    useSchematicStore.getState().addDevice({ ...TEMPLATE, headerColor: "#7c2d12" }, { x: 0, y: 0 });
    expect(lastDevice().headerColor).toBe("#7c2d12");
  });

  it("expands a shorthand saved on a template so the picker and the header agree", () => {
    useSchematicStore.getState().addDevice({ ...TEMPLATE, headerColor: "#abc" }, { x: 0, y: 0 });
    expect(lastDevice().headerColor).toBe("#aabbcc");
  });
});

describe("saved header color — persistence (#354)", () => {
  it("round-trips a preset's header color through the schematic file", () => {
    useSchematicStore.getState().setTemplatePreset(TEMPLATE.id!, presetFor({ headerColor: "#7c2d12" }));
    const exported = JSON.parse(JSON.stringify(useSchematicStore.getState().exportToJSON())) as SchematicFile;
    expect(exported.templatePresets?.[TEMPLATE.id!].headerColor).toBe("#7c2d12");

    useSchematicStore.getState().setTemplatePreset(TEMPLATE.id!, null);
    useSchematicStore.getState().importFromJSON(exported);

    expect(useSchematicStore.getState().templatePresets[TEMPLATE.id!].headerColor).toBe("#7c2d12");
    expect(place().headerColor).toBe("#7c2d12");
  });

  it("loads a pre-#354 preset in the file as one with no header color", () => {
    useSchematicStore.getState().setTemplatePreset(TEMPLATE.id!, presetFor({ headerColor: "#7c2d12" }));
    const exported = JSON.parse(JSON.stringify(useSchematicStore.getState().exportToJSON())) as SchematicFile;
    delete exported.templatePresets![TEMPLATE.id!].headerColor;

    useSchematicStore.getState().importFromJSON(exported);
    expect(useSchematicStore.getState().templatePresets[TEMPLATE.id!].headerColor).toBeUndefined();
    expect(place().headerColor).toBeUndefined();
  });

  it("writes a user template's header color to localStorage and reads it back", () => {
    useSchematicStore.getState().addCustomTemplate(
      savedTemplate(capture({ deviceHeaderColor: "#7c2d12", edited: true })),
    );

    const stored = JSON.parse(
      localStorage.getItem("easyschematic-custom-templates") ?? "[]",
    ) as DeviceTemplate[];
    expect(stored.find((t) => t.id === TEMPLATE.id)?.headerColor).toBe("#7c2d12");

    // The export/import pair the template-library file uses.
    const exported = JSON.parse(
      JSON.stringify(useSchematicStore.getState().exportCustomTemplates()),
    ) as DeviceTemplate[];
    useSchematicStore.getState().clearAllCustomTemplates();
    useSchematicStore.getState().importCustomTemplates(exported);

    expect(placeStoredTemplate().headerColor).toBe("#7c2d12");
  });

  it("carries a header color through the Device Library → Import parser", () => {
    const json = JSON.stringify({
      label: "Test Scaler",
      manufacturer: "Generic",
      deviceType: "converter",
      headerColor: "#7C2D12",
      ports: [{ label: "HDMI In", signalType: "hdmi", direction: "input", connectorType: "hdmi" }],
    });

    const parsed = parseJsonImport(json);
    expect(parsed.fatalErrors).toEqual([]);
    expect(parsed.templates[0].validation.errors).toEqual([]);
    expect(parsed.templates[0].template.headerColor).toBe("#7C2D12");

    useSchematicStore.getState().importCustomTemplates([
      { ...parsed.templates[0].template, id: TEMPLATE.id },
    ]);
    // Canonicalized at placement, wherever the template came from.
    expect(placeStoredTemplate().headerColor).toBe("#7c2d12");
  });

  it("reports a junk header color on import the way a junk body color is reported", () => {
    const json = JSON.stringify({
      label: "Test Scaler",
      manufacturer: "Generic",
      deviceType: "converter",
      headerColor: "chartreuse",
      ports: [{ label: "HDMI In", signalType: "hdmi", direction: "input", connectorType: "hdmi" }],
    });

    const parsed = parseJsonImport(json);
    expect(parsed.templates[0].validation.errors).toContain("headerColor must be a valid hex (e.g. #3b82f6)");
  });

  it("survives an Update User Template that changes the color", () => {
    useSchematicStore.getState().addCustomTemplate(
      savedTemplate(capture({ deviceHeaderColor: "#7c2d12", edited: true })),
    );
    // Reopened on a device wearing the template's color, repainted, updated.
    useSchematicStore.getState().updateCustomTemplate(
      TEMPLATE.id!,
      savedTemplate(capture({ deviceHeaderColor: "#15803d", edited: true, savedHeaderColor: "#7c2d12" })),
    );

    expect(placeStoredTemplate().headerColor).toBe("#15803d");
  });
});
