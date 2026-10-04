import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CURRENT_SCHEMA_VERSION } from "../migrations";
import type { SchematicFile } from "../types";

/**
 * Regression test for the stub-label display settings across File ▸ Open.
 *
 * Bug: importFromJSON restored stubLabelShowArrow / ShowPort / PageMode from
 * the file (falling back to the default when absent) but omitted
 * stubLabelShowRoom entirely, so the previous document's setting leaked into
 * the opened file: turn "Show room name" off in schematic A, open schematic B
 * that carries no stubLabelShowRoom, and B's stub tags silently drop their
 * (Room) suffix. The localStorage load and share-link paths already handled
 * the field; only the import reset block was missing it.
 */

function makeLocalStorage() {
  const backing: Record<string, string> = {};
  return {
    getItem: (k: string) => (k in backing ? backing[k] : null),
    setItem: (k: string, v: string) => { backing[k] = v; },
    removeItem: (k: string) => { delete backing[k]; },
    clear: () => { for (const k of Object.keys(backing)) delete backing[k]; },
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("localStorage", makeLocalStorage());
  if (!globalThis.crypto?.randomUUID) {
    vi.stubGlobal("crypto", { randomUUID: () => "test-" + Math.random().toString(36).slice(2) });
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function doc(extra: Partial<SchematicFile> = {}): SchematicFile {
  return { version: CURRENT_SCHEMA_VERSION, name: "Opened", nodes: [], edges: [], ...extra };
}

describe("importFromJSON — stub label settings", () => {
  it("resets stubLabelShowRoom to the default when the opened file carries none", async () => {
    const { useSchematicStore } = await import("../store");
    useSchematicStore.getState().setStubLabelShowRoom(false);
    expect(useSchematicStore.getState().stubLabelShowRoom).toBe(false);

    useSchematicStore.getState().importFromJSON(doc());
    expect(useSchematicStore.getState().stubLabelShowRoom).toBe(true);
  });

  it("applies stubLabelShowRoom from the opened file when present", async () => {
    const { useSchematicStore } = await import("../store");
    useSchematicStore.getState().importFromJSON(doc({ stubLabelShowRoom: false }));
    expect(useSchematicStore.getState().stubLabelShowRoom).toBe(false);
  });

  it("resets its sibling stub-label settings the same way", async () => {
    const { useSchematicStore } = await import("../store");
    const s = useSchematicStore.getState();
    s.setStubLabelShowArrow(true);
    s.setStubLabelShowPort(false);

    useSchematicStore.getState().importFromJSON(doc());
    const after = useSchematicStore.getState();
    expect(after.stubLabelShowArrow).toBe(false);
    expect(after.stubLabelShowPort).toBe(true);
  });
});
