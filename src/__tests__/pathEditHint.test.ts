import { describe, it, expect } from "vitest";
import { showPathEditHint, soleSelectedCableId } from "../pathEditHint";
import type { ConnectionEdge, SchematicNode } from "../types";

const nodes = (...selected: boolean[]) =>
  selected.map((sel, i) => ({ id: `dev-${i}`, selected: sel })) as SchematicNode[];
const edges = (...selected: boolean[]) =>
  selected.map((sel, i) => ({ id: `cable-${i}`, selected: sel })) as ConnectionEdge[];

const base = {
  soleSelected: true,
  hasRoute: true,
  hasOwnWaypoints: false,
  directAttach: false,
};

describe("showPathEditHint", () => {
  it("shows for a single selected, routed cable with no handles", () => {
    expect(showPathEditHint(base)).toBe(true);
  });

  it("hides when the cable is not the sole selection", () => {
    expect(showPathEditHint({ ...base, soleSelected: false })).toBe(false);
  });

  it("hides before a route exists (nowhere to anchor the hint)", () => {
    expect(showPathEditHint({ ...base, hasRoute: false })).toBe(false);
  });

  it("hides once the cable already carries user-placed handles", () => {
    expect(showPathEditHint({ ...base, hasOwnWaypoints: true })).toBe(false);
  });

  it("hides on direct-attach edges (no cable run to shape)", () => {
    expect(showPathEditHint({ ...base, directAttach: true })).toBe(false);
  });
});

describe("soleSelectedCableId", () => {
  it("returns the id of the single selected cable", () => {
    expect(soleSelectedCableId(nodes(false, false), edges(false, true, false))).toBe("cable-1");
  });

  it("returns null when nothing is selected", () => {
    expect(soleSelectedCableId(nodes(false), edges(false, false))).toBe(null);
  });

  it("returns null when more than one cable is selected", () => {
    expect(soleSelectedCableId(nodes(false), edges(true, true))).toBe(null);
  });

  it("returns null when any device is selected alongside a lone cable (marquee bulk move)", () => {
    expect(soleSelectedCableId(nodes(true, false), edges(true))).toBe(null);
  });

  it("returns null for a devices-only selection", () => {
    expect(soleSelectedCableId(nodes(true, true), edges(false))).toBe(null);
  });
});
