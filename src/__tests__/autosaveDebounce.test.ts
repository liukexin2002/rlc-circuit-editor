import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";
import type { NodeChange } from "@xyflow/react";
import type { DeviceTemplate, Port, SchematicNode } from "../types";

// Adapted from PR #373 (@Drummerms) to master's trailing-debounce autosave (#384):
// onNodesChange/onEdgesChange never save synchronously — every gesture frame goes through
// scheduleAutosave() and the write lands once, AUTOSAVE_DEBOUNCE_MS after the last frame.
// Count writes to the autosave slot to pin that down. Vitest runs this suite in the node
// environment where localStorage is absent, so install a minimal in-memory stub before
// importing the store.
const AUTOSAVE_KEY = "easyschematic-autosave";
const AUTOSAVE_DEBOUNCE_MS = 250;
let autosaveWrites = 0;

function installLocalStorageStub() {
  const map = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => {
      if (k === AUTOSAVE_KEY) autosaveWrites++;
      map.set(k, String(v));
    },
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
  });
}

let useSchematicStore: typeof import("../store").useSchematicStore;
let flushAutosave: typeof import("../store").flushAutosave;

beforeAll(async () => {
  installLocalStorageStub();
  // Autosave no-ops until the store is hydrated (a data-loss guard). Seed a minimal valid
  // autosave blob and load it so the synchronous hydration path runs and sets the flag.
  const { CURRENT_SCHEMA_VERSION } = await import("../migrations");
  localStorage.setItem(
    AUTOSAVE_KEY,
    JSON.stringify({ version: CURRENT_SCHEMA_VERSION, name: "test", nodes: [], edges: [] }),
  );
  ({ useSchematicStore, flushAutosave } = await import("../store"));
  useSchematicStore.getState().loadFromLocalStorage();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.useFakeTimers();
  useSchematicStore.getState().newSchematic();
  vi.runAllTimers(); // settle anything setup scheduled
  autosaveWrites = 0;
});

afterEach(() => {
  vi.runAllTimers(); // no pending timer may leak into the next test
  vi.useRealTimers();
});

function port(id: string): Port {
  return { id, label: id, signalType: "custom" as Port["signalType"], direction: "input" };
}

function template(id: string, ports: Port[]): DeviceTemplate {
  return { id, deviceType: "misc", label: id, ports };
}

function addOneDevice(id: string): SchematicNode {
  useSchematicStore.getState().addDevice(template(id, [port("p")]), { x: 0, y: 0 });
  const node = useSchematicStore.getState().nodes.find((n) => n.type === "device")!;
  vi.runAllTimers();
  autosaveWrites = 0;
  return node;
}

function dragTick(node: SchematicNode, x: number, y: number): NodeChange<SchematicNode>[] {
  return [{ id: node.id, type: "position", position: { x, y }, dragging: true }];
}

describe("debounced autosave on canvas changes (store.ts scheduleAutosave, #384)", () => {
  it("does not write on a mid-drag frame; the debounce persists the dragged position after the last frame", () => {
    const node = addOneDevice("drag-dev");

    useSchematicStore.getState().onNodesChange(dragTick(node, 40, 40));
    expect(autosaveWrites).toBe(0);

    vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS);
    expect(autosaveWrites).toBe(1);

    // The dragged position — not a stale pre-drag one — is what got serialized.
    const saved = JSON.parse(localStorage.getItem(AUTOSAVE_KEY)!);
    const savedNode = saved.nodes.find((n: { id: string }) => n.id === node.id) as {
      position: { x: number; y: number };
    };
    expect(savedNode.position).toEqual({ x: 40, y: 40 });
  });

  it("coalesces a whole drag into one write, re-arming on every frame", () => {
    const node = addOneDevice("coalesce-dev");

    for (let i = 1; i <= 10; i++) {
      useSchematicStore.getState().onNodesChange(dragTick(node, i * 8, i * 8));
      vi.advanceTimersByTime(16); // ~60fps — never long enough for the debounce to fire
    }
    expect(autosaveWrites).toBe(0);

    vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS);
    expect(autosaveWrites).toBe(1);
  });

  it("persists an aborted drag — no dragging:false batch ever arrives, the debounce still fires", () => {
    // React Flow aborts a drag (skipping both the dragging:false batch and onNodeDragStop)
    // when a second touch starts or the dragged node is deleted mid-drag. A trailing
    // debounce needs no end-of-gesture signal, so the resting position persists anyway.
    const node = addOneDevice("abort-dev");

    useSchematicStore.getState().onNodesChange(dragTick(node, 40, 40));
    vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS);

    const saved = JSON.parse(localStorage.getItem(AUTOSAVE_KEY)!);
    const savedNode = saved.nodes.find((n: { id: string }) => n.id === node.id) as {
      position: { x: number; y: number };
    };
    expect(savedNode.position).toEqual({ x: 40, y: 40 });
  });

  it("flushAutosave persists synchronously and clears the timer (the pagehide/page-hidden path)", () => {
    const node = addOneDevice("flush-dev");

    useSchematicStore.getState().onNodesChange(dragTick(node, 40, 40));
    expect(autosaveWrites).toBe(0);

    flushAutosave(); // what the pagehide / page-hidden listeners invoke
    expect(autosaveWrites).toBe(1);
    const saved = JSON.parse(localStorage.getItem(AUTOSAVE_KEY)!);
    const savedNode = saved.nodes.find((n: { id: string }) => n.id === node.id) as {
      position: { x: number; y: number };
    };
    expect(savedNode.position).toEqual({ x: 40, y: 40 });

    vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS * 4);
    expect(autosaveWrites).toBe(1); // the flush also cleared the timer
  });

  it("flushAutosave is a no-op when nothing is pending", () => {
    flushAutosave();
    expect(autosaveWrites).toBe(0);
  });

  it("a direct save supersedes the pending debounce — no redundant write 250ms later", () => {
    const node = addOneDevice("direct-save-dev");

    useSchematicStore.getState().onNodesChange(dragTick(node, 40, 40));
    // Any store action that persists directly (a delete, a rename, …) lands here eventually.
    useSchematicStore.getState().saveToLocalStorage();
    expect(autosaveWrites).toBe(1);

    vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS * 4);
    expect(autosaveWrites).toBe(1); // the direct save cancelled the timer
  });

  it("edge changes are debounced through the same path", () => {
    addOneDevice("edge-dev");

    useSchematicStore.getState().onEdgesChange([]);
    expect(autosaveWrites).toBe(0);
    vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS);
    expect(autosaveWrites).toBe(1);
  });
});
