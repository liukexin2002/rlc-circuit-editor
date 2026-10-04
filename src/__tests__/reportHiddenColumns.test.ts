/**
 * `reportHiddenColumns` is the per-table column preference persisted with the document.
 * A table distinguishes "no preference" (the key is absent — use whatever default the
 * table computes, e.g. the Patch Panel Schedule's automatic single-face columns) from an
 * explicit choice, including the empty "hide nothing" array. Passing `undefined` is how a
 * table's "Back to automatic" affordance gets back to the first state (#311).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { useSchematicStore } from "../store";

describe("setReportHiddenColumns", () => {
  beforeEach(() => {
    useSchematicStore.setState({ reportHiddenColumns: {} });
  });

  it("stores an explicit hidden set per table", () => {
    useSchematicStore.getState().setReportHiddenColumns("patchPanel", ["gender", "remoteRoom"]);
    expect(useSchematicStore.getState().reportHiddenColumns).toEqual({
      patchPanel: ["gender", "remoteRoom"],
    });
  });

  it("keeps an empty array — 'show everything' is a preference, not the absence of one", () => {
    useSchematicStore.getState().setReportHiddenColumns("patchPanel", []);
    expect(useSchematicStore.getState().reportHiddenColumns.patchPanel).toEqual([]);
    expect("patchPanel" in useSchematicStore.getState().reportHiddenColumns).toBe(true);
  });

  it("undefined forgets the preference without disturbing other tables", () => {
    const set = useSchematicStore.getState().setReportHiddenColumns;
    set("patchPanel", []);
    set("cableSchedule", ["gaugeAwg"]);
    set("patchPanel", undefined);
    expect(useSchematicStore.getState().reportHiddenColumns).toEqual({ cableSchedule: ["gaugeAwg"] });
    expect(useSchematicStore.getState().reportHiddenColumns.patchPanel).toBeUndefined();
  });
});
