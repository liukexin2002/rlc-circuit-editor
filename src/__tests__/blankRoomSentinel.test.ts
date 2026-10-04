// A device (or rack) that sits in no room reports a BLANK room, not the literal
// "Unassigned". Two sites emit the no-room value and they have to agree: getRoomLabel,
// and the rack rollup in computePackList which writes the value directly without going
// through it. If they ever diverge, one report group splits into two rows — which is
// exactly what these tests exist to catch.

import { describe, it, expect } from "vitest";
import {
  computePackList,
  getRoomLabel,
  getPackListTableData,
  routeRoomKey,
  buildPackListCsv,
  groupBy,
} from "../packList";
import { createDefaultPackListLayout } from "../reportLayout";
import type {
  ConnectionEdge,
  ConnectorType,
  Port,
  SchematicNode,
  SchematicPage,
  SignalType,
} from "../types";

const port = (id: string, signalType: SignalType, connectorType: ConnectorType): Port =>
  ({ id, label: id, signalType, direction: "bidirectional", connectorType }) as Port;

const device = (id: string, model: string, ports: Port[], parentId?: string): SchematicNode =>
  ({
    id,
    type: "device",
    position: { x: 0, y: 0 },
    parentId,
    data: { label: model, model, deviceType: "custom", ports },
  }) as unknown as SchematicNode;

const room = (id: string, label: string): SchematicNode =>
  ({ id, type: "room", position: { x: 0, y: 0 }, data: { label } }) as unknown as SchematicNode;

const edge = (id: string, source: string, target: string, signalType: SignalType): ConnectionEdge =>
  ({
    id,
    source,
    sourceHandle: "p",
    target,
    targetHandle: "p",
    data: { signalType },
  }) as unknown as ConnectionEdge;

/** Two roomless devices wired together, one roomless device wired into a real room. */
const nodes: SchematicNode[] = [
  room("r-booth", "Booth"),
  device("d-free-1", "Free A", [port("p", "sdi", "bnc")]),
  device("d-free-2", "Free B", [port("p", "sdi", "bnc")]),
  device("d-booth", "In Booth", [port("p", "sdi", "bnc")], "r-booth"),
];
const edges: ConnectionEdge[] = [
  edge("e1", "d-free-1", "d-free-2", "sdi"),
  edge("e2", "d-free-2", "d-booth", "sdi"),
];

/** One rack linked to a room, one rack with no room — the rollup that bypasses getRoomLabel. */
const pages: SchematicPage[] = [
  {
    id: "pg-racks",
    type: "rack-elevation",
    name: "Racks",
    racks: [
      { id: "rk-1", label: "Rack A", rackType: "standard", heightU: 12, linkedRoomId: "r-booth" },
      { id: "rk-2", label: "Rack B", rackType: "standard", heightU: 12 },
    ],
  } as unknown as SchematicPage,
];

describe("no room renders as blank", () => {
  it("returns an empty string from getRoomLabel for a device with no parent", () => {
    expect(getRoomLabel(nodes, undefined)).toBe("");
  });

  it("returns an empty string when the parent chain holds no room node", () => {
    // e.g. a device parented to something that is not a room — no path, so no label.
    expect(getRoomLabel(nodes, "d-booth")).toBe("");
  });

  it("puts a blank room on roomless device rows and keeps real rooms intact", () => {
    const pack = computePackList(nodes, edges, pages);
    const byModel = Object.fromEntries(pack.devices.map((d) => [d.model, d.room]));
    expect(byModel["Free A"]).toBe("");
    expect(byModel["Free B"]).toBe("");
    expect(byModel["In Booth"]).toBe("Booth");
  });

  it("puts a blank room on cable endpoints outside any room", () => {
    const pack = computePackList(nodes, edges, pages);
    const withinFree = pack.cables.find((c) => c.sourceDevice === "Free A")!;
    expect(withinFree.sourceRoom).toBe("");
    expect(withinFree.targetRoom).toBe("");
    const crossing = pack.cables.find((c) => c.sourceDevice === "Free B")!;
    expect(crossing.sourceRoom).toBe("");
    expect(crossing.targetRoom).toBe("Booth");
  });

  it("emits no 'Unassigned' anywhere in the pack list or its CSV", () => {
    const pack = computePackList(nodes, edges, pages);
    expect(JSON.stringify(pack)).not.toContain("Unassigned");
    expect(buildPackListCsv(pack, "Test", undefined, undefined, "2026-01-01")).not.toContain(
      "Unassigned",
    );
  });
});

describe("the rack rollup agrees with getRoomLabel", () => {
  it("gives an unlinked rack the same blank room a roomless device gets", () => {
    const pack = computePackList(nodes, edges, pages);
    const byLabel = Object.fromEntries(pack.racks.map((r) => [r.label, r.room]));
    expect(byLabel["Rack B"]).toBe(getRoomLabel(nodes, undefined));
    expect(byLabel["Rack A"]).toBe("Booth");
  });

  it("groups an unlinked rack together with roomless devices, not into a second bucket", () => {
    // The rollup writes the no-room value directly. If it emitted "Unassigned" while
    // getRoomLabel emitted "", grouping by room would produce two buckets for one idea.
    const pack = computePackList(nodes, edges, pages);
    const roomKeys = new Set([
      ...pack.devices.map((d) => d.room),
      ...pack.racks.map((r) => r.room),
      ...pack.cables.flatMap((c) => [c.sourceRoom, c.targetRoom]),
    ]);
    expect([...roomKeys].sort()).toEqual(["", "Booth"]);
  });

  it("keeps one grouped-by-room bucket for everything with no room", () => {
    const layout = createDefaultPackListLayout();
    const racksTable = layout.tables.find((t) => t.id === "racks")!;
    racksTable.groupBy = "room";
    const devicesTable = layout.tables.find((t) => t.id === "devices")!;
    devicesTable.groupBy = "room";

    const tables = getPackListTableData(computePackList(nodes, edges, pages), layout);
    for (const id of ["devices", "racks"]) {
      const keys = [...(tables.find((t) => t.id === id)!.groupedRows?.keys() ?? [])];
      expect(keys, id).toContain("");
      expect(keys, id).not.toContain("Unassigned");
    }
  });
});

describe("the four route forms", () => {
  // "Within " (a dangling sentinel remnant) is the one form that must never appear.
  // " > Booth" deliberately survives: it still carries that the run leaves an
  // unassigned area for Booth, which a blank route would throw away.
  const routeOf = (
    src: SchematicNode[],
    e: ConnectionEdge[],
    sourceDevice: string,
  ): string => {
    const pack = computePackList(src, e, []);
    const cable = pack.cables.find((c) => c.sourceDevice === sourceDevice)!;
    const row = pack.summary.find(
      (s) => s.cableType === cable.cableType && s.signalType === cable.signalType,
    );
    return row!.route;
  };

  const twoRooms: SchematicNode[] = [
    room("r-booth", "Booth"),
    room("r-hall", "Main Hall"),
    device("d-a", "A", [port("p", "sdi", "bnc")], "r-booth"),
    device("d-b", "B", [port("p", "hdmi", "hdmi")], "r-booth"),
    device("d-c", "C", [port("p", "vga", "vga")], "r-hall"),
    device("d-free", "Free", [port("p", "usb", "usb-a")]),
    device("d-free2", "Free 2", [port("p", "dvi", "dvi")]),
  ];

  it("names the room for a run that stays inside one", () => {
    expect(
      routeOf(twoRooms, [edge("e", "d-a", "d-b", "sdi")], "A"),
    ).toBe("Within Booth");
  });

  it("is blank for a run that stays outside every room", () => {
    // Was "Within Unassigned", then briefly "Within " — a dangling sentinel remnant.
    expect(
      routeOf(twoRooms, [edge("e", "d-free", "d-free2", "usb")], "Free"),
    ).toBe("");
  });

  it("names both rooms for a run that crosses between them", () => {
    expect(
      routeOf(twoRooms, [edge("e", "d-b", "d-c", "hdmi")], "B"),
    ).toBe("Booth > Main Hall");
  });

  it("keeps the arrow when a run enters a room from outside it", () => {
    expect(
      routeOf(twoRooms, [edge("e", "d-free", "d-a", "usb")], "Free"),
    ).toBe(" > Booth");
  });

  it("keeps the arrow when a run leaves a room for outside it", () => {
    expect(
      routeOf(twoRooms, [edge("e", "d-a", "d-free", "sdi")], "A"),
    ).toBe("Booth > ");
  });

  it("never emits a route that dangles after 'Within'", () => {
    const pack = computePackList(nodes, edges, pages);
    for (const s of pack.summary) {
      expect(s.route, JSON.stringify(s)).not.toBe("Within ");
      expect(s.route.startsWith("Within ") ? s.route.length > "Within ".length : true).toBe(true);
    }
  });
});

describe("cables-by-path grouping", () => {
  it("keys a route on its originating room", () => {
    expect(routeRoomKey("Within Booth")).toBe("Booth");
    expect(routeRoomKey("Booth > Stage")).toBe("Booth");
  });

  it("keys an unparseable no-room route blank rather than 'Unassigned'", () => {
    // "Within " and " > Booth" are what a blank room produces; neither parses.
    expect(routeRoomKey("Within ")).toBe("");
    expect(routeRoomKey(" > Booth")).toBe("");
    expect(routeRoomKey("")).toBe("");
    // A run OUT of a real room still keys on that room even when the far end is blank.
    expect(routeRoomKey("Booth > ")).toBe("Booth");
  });

  it("does not label a path group 'Unassigned' in the report tables", () => {
    const layout = createDefaultPackListLayout();
    const cablesTable = layout.tables.find((t) => t.id === "cables")!;
    cablesTable.groupBy = "path";
    const tables = getPackListTableData(computePackList(nodes, edges, pages), layout);
    const keys = [...(tables.find((t) => t.id === "cables")!.groupedRows?.keys() ?? [])];
    expect(keys).not.toContain("Unassigned");
    expect(keys).toContain("");
  });

  it("buckets every summary row under exactly one key", () => {
    const pack = computePackList(nodes, edges, pages);
    const groups = groupBy(pack.summary, (s) => routeRoomKey(s.route));
    const bucketed = [...groups.values()].reduce((n, rows) => n + rows.length, 0);
    expect(bucketed).toBe(pack.summary.length);
  });
});
