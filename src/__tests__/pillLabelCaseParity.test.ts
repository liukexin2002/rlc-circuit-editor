// Continuation pills must read the same text on screen and in the PDF (#294),
// and since #357 spreads pills by their measured width, differing text would
// also move them — a placement divergence, not just a cosmetic one. Both
// surfaces now build their nodeId → label lookup from one shared function
// (#361); this pins that neither side quietly grows its own again, and that the
// shared one case-transforms both the device label and the room beside it.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildCrossingLabelInfo } from "../crossingLabels";
import type { ConnectionEdge, SchematicNode } from "../types";

function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const room = {
  id: "room-mdf", type: "room", position: { x: 0, y: 0 },
  data: { label: "mdf closet" },
} as unknown as SchematicNode;

const switchNode = {
  id: "dev-switch", type: "device", parentId: "room-mdf",
  position: { x: 20, y: 20 }, measured: { width: 144, height: 64 },
  data: { label: "rack switch", ports: [{ id: "eth-out-1", label: "Eth 1", direction: "output", signalType: "ethernet" }] },
} as unknown as SchematicNode;

describe("continuation pill label case parity (#294/#357/#361)", () => {
  it("case-transforms both the device label and its room", () => {
    const info = buildCrossingLabelInfo([room, switchNode], [] as ConnectionEdge[], (l) => (l ?? "").toUpperCase());
    expect(info.get("dev-switch")).toEqual({ label: "RACK SWITCH", room: "MDF CLOSET" });
  });

  it("has the editor overlay hand its display-case transform to the shared lookup", () => {
    const src = read("../components/PageBoundaryOverlay.tsx");
    expect(src).toMatch(/computeCrossingLabels\(/);
    expect(src).toMatch(/\(label\) => transformLabel\(label, labelCase\)/);
  });

  it("has the PDF export hand the same transform to the same lookup", () => {
    const src = read("../pdfExport.ts");
    expect(src).toMatch(/buildCrossingLabelInfo\(/);
    expect(src).toMatch(/transformLabelNow,/);
  });
});
