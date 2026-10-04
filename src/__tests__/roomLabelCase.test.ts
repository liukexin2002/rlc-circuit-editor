// Room names follow the display-case preference (#294) and nothing else — the same as
// device and port names. Rooms used to carry a decorative all-caps of their own (a CSS
// `uppercase` class on canvas, a hardcoded `.toUpperCase()` in the DXF); both are gone, so
// "As-typed" now means as-typed for rooms too.
//
// Two paths carry a room name to the reader and both are pinned here:
//   canvas  — RoomNode renders displayLabel(data.label) with no styling on top.
//   reports — getRoomLabel builds the room path fed to the pack list, cable schedule,
//             network/power reports, and the patch-panel schedule.
// The DXF side of the same rule lives in dxfExport.test.ts.

import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { transformLabel } from "../labelCaseUtils";
import { getRoomLabel } from "../packList";
import { useSchematicStore } from "../store";
import type { LabelCaseMode, SchematicNode } from "../types";

const MODES: LabelCaseMode[] = ["as-typed", "uppercase", "lowercase", "capitalize"];

const room = (id: string, label: string, parentId?: string): SchematicNode =>
  ({ id, type: "room", position: { x: 0, y: 0 }, parentId, data: { label } }) as unknown as SchematicNode;

/** Main Hall > Booth, plus a device parented into the sub-room. */
const nodes: SchematicNode[] = [
  room("r1", "Main Hall"),
  room("r2", "Booth", "r1"),
  room("r3", "", "r1"),
];

afterEach(() => {
  useSchematicStore.setState({ labelCase: "as-typed" });
});

describe("room labels on the canvas (#294)", () => {
  it("transforms the room header text in every mode", () => {
    const out = MODES.map((m) => transformLabel("main Hall", m));
    expect(out).toEqual(["main Hall", "MAIN HALL", "main hall", "Main Hall"]);
  });

  it("as-typed returns the room name verbatim, mixed case and all", () => {
    // The whole point of dropping the decorative caps: As-typed has to mean as-typed.
    for (const label of ["main Hall", "Booth", "FOH", "rack room 2", "iMac Bay"]) {
      expect(transformLabel(label, "as-typed")).toBe(label);
    }
  });

  it("no decorative uppercase styling remains on the room header", () => {
    // Vitest runs in a node environment here, so there's no DOM to assert computed styles
    // against — and CSS `text-transform` is exactly what would silently override the
    // transformed text. Reading the class list back is the only way to catch a reinstated
    // `uppercase`, and this test exists specifically to fail if someone adds one.
    const src = readFileSync(
      fileURLToPath(new URL("../components/RoomNode.tsx", import.meta.url)),
      "utf8",
    );
    // The room header span is the one the user double-clicks to rename.
    const header = src
      .split("\n")
      .find((l) => l.includes("className") && l.includes("cursor-text"));
    expect(header, "room header span not found — did the class list move?").toBeDefined();
    expect(header).not.toContain("uppercase");
    expect(src).not.toContain("toUpperCase");
  });
});

describe("getRoomLabel casing in reports (#294)", () => {
  it("leaves the room path as-typed by default", () => {
    useSchematicStore.setState({ labelCase: "as-typed" });
    expect(getRoomLabel(nodes, "r1")).toBe("Main Hall");
    expect(getRoomLabel(nodes, "r2")).toBe("Main Hall - Booth");
  });

  it("uppercases every segment of a nested room path", () => {
    useSchematicStore.setState({ labelCase: "uppercase" });
    expect(getRoomLabel(nodes, "r2")).toBe("MAIN HALL - BOOTH");
  });

  it("lowercases every segment of a nested room path", () => {
    useSchematicStore.setState({ labelCase: "lowercase" });
    expect(getRoomLabel(nodes, "r2")).toBe("main hall - booth");
  });

  it("capitalizes every segment of a nested room path", () => {
    useSchematicStore.setState({ labelCase: "capitalize" });
    expect(getRoomLabel(nodes, "r2")).toBe("Main Hall - Booth");
  });

  it("never transforms the separator", () => {
    for (const mode of MODES) {
      useSchematicStore.setState({ labelCase: mode });
      expect(getRoomLabel(nodes, "r2").split(" - ")).toHaveLength(2);
    }
  });

  it("reports no room as blank, in every mode", () => {
    // Was the literal "Unassigned"; the maintainer asked for a blank instead. Case mode
    // must not reintroduce a sentinel — the rack rollup in computePackList emits the
    // no-room value directly instead of calling getRoomLabel, and if the two ever
    // disagreed a single report group would split into two rows.
    for (const mode of MODES) {
      useSchematicStore.setState({ labelCase: mode });
      expect(getRoomLabel(nodes, undefined)).toBe("");
    }
  });

  it("leaves the Unnamed placeholder for a blank room alone in every mode", () => {
    for (const mode of MODES) {
      useSchematicStore.setState({ labelCase: mode });
      expect(getRoomLabel(nodes, "r3").endsWith("Unnamed")).toBe(true);
    }
  });

  it("is display-only — the stored room labels are never mutated", () => {
    useSchematicStore.setState({ labelCase: "uppercase" });
    getRoomLabel(nodes, "r2");
    expect((nodes[0].data as { label: string }).label).toBe("Main Hall");
    expect((nodes[1].data as { label: string }).label).toBe("Booth");
  });
});
