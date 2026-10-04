// CSV import accepts room PATHS in room columns — "Sanctuary > FOH" nests a
// subroom "FOH" inside "Sanctuary". This syntax is documented on the docs site
// (Files & Exports → CSV import), so these tests pin the behavior the docs
// promise: '>' as the separator, whitespace-insensitivity, arbitrary depth,
// and auto-creation of every ancestor room.

import { describe, it, expect } from "vitest";
import { buildImportResult, matchDevices, type ParsedConnection } from "../csvImport";
import type { SchematicNode } from "../types";

const conn = (
  sourceDevice: string,
  destDevice: string,
  sourceRoom = "",
  destRoom = "",
): ParsedConnection => ({
  sourceDevice,
  sourcePort: "Out 1",
  destDevice,
  destPort: "In 1",
  signalType: "",
  sourceRoom,
  destRoom,
});

function importRooms(connections: ParsedConnection[]) {
  const { nodes } = buildImportResult(connections, matchDevices(connections, []));
  const rooms = nodes.filter((n) => n.type === "room");
  const byLabel = new Map(rooms.map((r) => [(r.data as { label: string }).label, r]));
  return { nodes, rooms, byLabel };
}

const parentOf = (byLabel: Map<string, SchematicNode>, label: string) => {
  const parentId = byLabel.get(label)?.parentId;
  return parentId
    ? [...byLabel.values()].find((r) => r.id === parentId)
    : undefined;
};

describe("CSV import room paths", () => {
  it("nests 'Sanctuary > FOH' as a subroom of Sanctuary", () => {
    const { rooms, byLabel } = importRooms([
      conn("Console", "Amp", "Sanctuary > FOH", "Sanctuary"),
    ]);

    expect(rooms).toHaveLength(2);
    expect(byLabel.get("Sanctuary")?.parentId).toBeUndefined();
    expect(parentOf(byLabel, "FOH")).toBe(byLabel.get("Sanctuary"));
  });

  it("ignores whitespace around the separator", () => {
    const { nodes, rooms, byLabel } = importRooms([
      conn("Console", "Amp", "Sanctuary>FOH", "Sanctuary   >   FOH"),
    ]);

    // Both spellings collapse to one Sanctuary and one FOH subroom
    expect(rooms).toHaveLength(2);
    expect(parentOf(byLabel, "FOH")).toBe(byLabel.get("Sanctuary"));

    // ...and both devices land inside that FOH subroom
    const devices = nodes.filter((n) => n.type === "device");
    expect(devices).toHaveLength(2);
    for (const d of devices) expect(d.parentId).toBe(byLabel.get("FOH")?.id);
  });

  it("supports multi-level paths and creates every ancestor room", () => {
    const { rooms, byLabel } = importRooms([
      conn("Console", "Amp", "Campus > Sanctuary > FOH", ""),
    ]);

    // "Sanctuary" gets a room even though no device sits directly in it
    expect(rooms).toHaveLength(3);
    expect(byLabel.get("Campus")?.parentId).toBeUndefined();
    expect(parentOf(byLabel, "Sanctuary")).toBe(byLabel.get("Campus"));
    expect(parentOf(byLabel, "FOH")).toBe(byLabel.get("Sanctuary"));
  });

  it("keeps same-name subrooms under different parents distinct", () => {
    const { rooms, byLabel } = importRooms([
      conn("Console", "Amp", "Studio A > Booth", "Studio B > Booth"),
    ]);

    expect(rooms).toHaveLength(4);
    const booths = rooms.filter((r) => (r.data as { label: string }).label === "Booth");
    expect(booths).toHaveLength(2);
    expect(new Set(booths.map((b) => b.parentId))).toEqual(
      new Set([byLabel.get("Studio A")?.id, byLabel.get("Studio B")?.id]),
    );
  });

  it("places each device in the room at the end of its path", () => {
    const { nodes, byLabel } = importRooms([
      conn("Console", "Amp", "Sanctuary > FOH", "Sanctuary"),
    ]);

    const device = (label: string) =>
      nodes.find((n) => n.type === "device" && (n.data as { label: string }).label === label);
    expect(device("Console")?.parentId).toBe(byLabel.get("FOH")?.id);
    expect(device("Amp")?.parentId).toBe(byLabel.get("Sanctuary")?.id);
  });
});
