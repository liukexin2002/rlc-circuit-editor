/**
 * The Patch Panel Schedule PDF is WYSIWYG with the on-screen table (#362).
 *
 * The two surfaces used to diverge on everything: the PDF printed the five unfillable
 * single-face columns the screen had just auto-hidden (#311), omitted all 19 passthrough
 * columns, ordered Signal twelfth instead of fifth, ignored the tab's filter, "Hide empty",
 * grouping and clicked sort, and printed "" where the table printed an em dash.
 *
 * The fix is one shared column list plus shared filter/sort/group helpers. The tab renders
 * `PATCH_PANEL_SCHEDULE_COLUMNS` minus its hidden set — exactly what `onScreenColumns()`
 * below computes — and hands that same view to the print layout, so these assertions are
 * assertions about both surfaces at once.
 *
 * The CSV deliberately does NOT follow: it stays the maximal 34-column export, pinned at
 * the bottom of this file.
 */
import { describe, it, expect } from "vitest";
import {
  computePatchPanelSchedule,
  getPatchPanelScheduleTableData,
  resolvePatchPanelHiddenColumns,
  filterPatchPanelScheduleRows,
  buildPatchPanelScheduleCsv,
  PATCH_PANEL_LEGACY_COLUMN_IDS,
  type PatchPanelScheduleRow,
} from "../patchPanelSchedule";
import {
  PATCH_PANEL_SCHEDULE_COLUMNS,
  PATCH_PANEL_COLUMN_GROUP_LABELS,
  defaultPatchPanelTableView,
  type PatchPanelColumnGroup,
  type PatchPanelTableView,
} from "../patchPanelColumns";
import {
  createDefaultPatchPanelScheduleLayout,
  createDefaultCableScheduleLayout,
  getVisibleColumns,
  getTableColumnGapMm,
  getPageDimensions,
  resolveLayout,
  REPORT_MARGIN_MM,
  type ReportLayout,
} from "../reportLayout";
import { fitText, FONT_SIZE, HEADER_FONT_SIZE } from "../reportPdf";
import { jsPDF } from "jspdf";
import { splitCsvLine } from "../reportsHarness/invariants";
import type { SchematicNode, ConnectionEdge } from "../types";

// ─── Fixture: one modern passthrough panel + one legacy paired-port panel ──────

function deviceNode(id: string, label: string, ports: object[], extra: object = {}): SchematicNode {
  return {
    id, type: "device", position: { x: 0, y: 0 },
    data: { label, deviceType: "generic", ports, ...extra },
  } as unknown as SchematicNode;
}

// PP-01: four passthrough circuits. Ports 1–2 are wired, 3–4 are spare.
const passthroughPanel = deviceNode(
  "pp-01",
  "PP-01",
  [1, 2, 3, 4].map((n) => ({
    id: `pp-p${n}-in`, label: `Port ${n}`, signalType: "hdmi",
    direction: "passthrough", inheritsSignal: true,
    rearConnectorType: "hdmi", frontConnectorType: "hdmi",
  })),
  { deviceType: "patch-panel", offCanvas: true },
);

// A legacy panel whose ports are plain input/output — the back-compat path that is the
// only thing able to fill the single-face columns.
const legacyPanel = deviceNode(
  "pp-02",
  "ST Fiber Bulkhead",
  [
    { id: "st-in-1", label: "Port 1", signalType: "fiber", direction: "input", connectorType: "st" },
    { id: "st-out-1", label: "Port 2", signalType: "fiber", direction: "output", connectorType: "st" },
  ],
  { deviceType: "patch-panel", offCanvas: true },
);

const switcher = deviceNode("switcher", "Vision Switcher", [
  { id: "sw-hdmi-out", label: "PGM Out", signalType: "hdmi", direction: "output", connectorType: "hdmi" },
]);
const camera = deviceNode("cam-1", "Camera 1", [
  { id: "cam1-hdmi-out", label: "HDMI Out", signalType: "hdmi", direction: "output", connectorType: "hdmi" },
]);
const display = deviceNode("display", "Stage Display", [
  { id: "disp-hdmi-in", label: "HDMI In", signalType: "hdmi", direction: "input", connectorType: "hdmi" },
]);
const coreSwitch = deviceNode("dev-sw", "Core Switch", [
  { id: "sfp1", label: "SFP 1", signalType: "fiber", direction: "input", connectorType: "st" },
]);

function edge(id: string, source: string, sourceHandle: string, target: string, targetHandle: string, signalType: string): ConnectionEdge {
  return { id, source, sourceHandle, target, targetHandle, data: { signalType } } as unknown as ConnectionEdge;
}

const PASSTHROUGH_NODES = [passthroughPanel, switcher, camera, display];
const PASSTHROUGH_EDGES = [
  edge("e-sw-pp", "switcher", "sw-hdmi-out", "pp-01", "pp-p1-in-rear", "hdmi"),
  edge("e-pp-disp", "pp-01", "pp-p1-in-front", "display", "disp-hdmi-in", "hdmi"),
  edge("e-cam-pp", "cam-1", "cam1-hdmi-out", "pp-01", "pp-p2-in-rear", "hdmi"),
];

const ALL_NODES = [...PASSTHROUGH_NODES, legacyPanel, coreSwitch];
const ALL_EDGES = [
  ...PASSTHROUGH_EDGES,
  edge("e-st", "pp-02", "st-out-1-out", "dev-sw", "sfp1-in", "fiber"),
];

// ─── The two surfaces ─────────────────────────────────────────────────────────

/** The column keys the table renders: the shared list minus the hidden set. */
function onScreenColumns(hidden: Set<string>): string[] {
  return PATCH_PANEL_SCHEDULE_COLUMNS.filter((c) => !hidden.has(c.key)).map((c) => c.key);
}

/** The view the tab publishes, with the single-face columns resolved off the rows in view. */
function tabView(
  rows: PatchPanelScheduleRow[],
  overrides: Partial<PatchPanelTableView> = {},
  storedHiddenColumns?: string[],
): PatchPanelTableView {
  const base = { ...defaultPatchPanelTableView(), ...overrides };
  const inView = filterPatchPanelScheduleRows(rows, base);
  return { ...base, hiddenColumns: [...resolvePatchPanelHiddenColumns(inView, storedHiddenColumns)] };
}

/** The column keys the PDF prints, in print order. */
function pdfColumns(view: PatchPanelTableView): string[] {
  const layout = createDefaultPatchPanelScheduleLayout(view);
  return getVisibleColumns(layout.tables[0]).map((c) => c.key);
}

function pdfTable(rows: PatchPanelScheduleRow[], view: PatchPanelTableView) {
  return getPatchPanelScheduleTableData(rows, createDefaultPatchPanelScheduleLayout(view), view)[0];
}

describe("patch panel schedule — PDF/table parity (#362)", () => {
  it("prints exactly the columns the table shows, in the table's order", () => {
    const rows = computePatchPanelSchedule(ALL_NODES, ALL_EDGES);
    const view = tabView(rows);
    // A legacy row is in view, so nothing is auto-hidden: all 34 columns, both surfaces.
    expect(view.hiddenColumns).toEqual([]);
    expect(pdfColumns(view)).toEqual(onScreenColumns(new Set()));
    expect(pdfColumns(view)).toHaveLength(34);
    expect(Object.keys(pdfTable(rows, view).rows[0])).toEqual(onScreenColumns(new Set()));
  });

  it("drops the auto-hidden single-face columns from the PDF, not just the screen (#311)", () => {
    const rows = computePatchPanelSchedule(PASSTHROUGH_NODES, PASSTHROUGH_EDGES);
    const view = tabView(rows);
    expect([...view.hiddenColumns].sort()).toEqual([...PATCH_PANEL_LEGACY_COLUMN_IDS].sort());

    const printed = pdfColumns(view);
    expect(printed).toEqual(onScreenColumns(new Set(view.hiddenColumns)));
    expect(printed).toHaveLength(24);
    for (const id of PATCH_PANEL_LEGACY_COLUMN_IDS) expect(printed).not.toContain(id);
    // …and the rows carry no data for them either.
    expect(Object.keys(pdfTable(rows, view).rows[0])).toEqual(printed);
  });

  it("prints all 19 passthrough columns", () => {
    const rows = computePatchPanelSchedule(PASSTHROUGH_NODES, PASSTHROUGH_EDGES);
    const printed = pdfColumns(tabView(rows));
    expect(printed.filter((k) => k.startsWith("rear"))).toHaveLength(9);
    expect(printed.filter((k) => k.startsWith("front"))).toHaveLength(9);
    expect(printed).toContain("normalling");
  });

  it("keeps Signal the fifth column on both surfaces", () => {
    const rows = computePatchPanelSchedule(ALL_NODES, ALL_EDGES);
    const view = tabView(rows);
    expect(onScreenColumns(new Set()).indexOf("signalType")).toBe(4);
    expect(pdfColumns(view).indexOf("signalType")).toBe(4);
  });

  it("honours a column the user hid by hand", () => {
    const rows = computePatchPanelSchedule(ALL_NODES, ALL_EDGES);
    const view = tabView(rows, {}, ["gender", "multicableLabel"]);
    const printed = pdfColumns(view);
    expect(printed).not.toContain("gender");
    expect(printed).not.toContain("multicableLabel");
    expect(printed).toEqual(onScreenColumns(new Set(["gender", "multicableLabel"])));
  });

  it("lets the tab's Columns menu narrow the PDF to any 8 columns, and remember it", () => {
    const rows = computePatchPanelSchedule(PASSTHROUGH_NODES, PASSTHROUGH_EDGES);
    // Every column is offered in the tab's picker, in exactly one section.
    const offered = (Object.keys(PATCH_PANEL_COLUMN_GROUP_LABELS) as PatchPanelColumnGroup[])
      .flatMap((g) => PATCH_PANEL_SCHEDULE_COLUMNS.filter((c) => c.group === g).map((c) => c.key));
    expect([...offered].sort()).toEqual(PATCH_PANEL_SCHEDULE_COLUMNS.map((c) => c.key).sort());
    expect(offered).toHaveLength(34);

    // The user unchecks passthrough columns until 8 are left. The tab stores the resolved
    // set, so the ten auto-hidden single-face columns stay in it rather than springing back.
    const keep = ["panel", "panelRoom", "face", "position", "signalType", "rearRemoteDevice", "frontRemoteDevice", "normalling"];
    let stored = [...resolvePatchPanelHiddenColumns(rows, undefined)];
    for (const col of PATCH_PANEL_SCHEDULE_COLUMNS) {
      if (!keep.includes(col.key) && !stored.includes(col.key)) stored = [...stored, col.key];
    }
    expect(stored).toHaveLength(26);
    for (const id of PATCH_PANEL_LEGACY_COLUMN_IDS) expect(stored).toContain(id);

    // That preference lives on the document, so the next export gets the same 8 columns
    // without the user redoing anything in the preview.
    const view = tabView(rows, {}, stored);
    expect(pdfColumns(view)).toEqual(keep);
    expect(Object.keys(pdfTable(rows, view).rows[0])).toEqual(keep);
  });

  it("prints the filtered rows, not the whole schedule", () => {
    const rows = computePatchPanelSchedule(ALL_NODES, ALL_EDGES);
    const view = tabView(rows, { filter: "stage display" });
    const onScreen = filterPatchPanelScheduleRows(rows, view);
    expect(onScreen).toHaveLength(1);
    expect(onScreen[0].frontRemoteDevice).toBe("Stage Display");

    const table = pdfTable(rows, view);
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0].position).toBe("Port 1");
    // Filtering down to the passthrough panel takes the legacy rows out of view, so the
    // single-face columns hide on both surfaces.
    expect(Object.keys(table.rows[0])).not.toContain("connector");
  });

  it("honours the tab's Hide empty checkbox", () => {
    const rows = computePatchPanelSchedule(PASSTHROUGH_NODES, PASSTHROUGH_EDGES);
    expect(rows).toHaveLength(4);
    const view = tabView(rows, { hideUnconnected: true });
    // Ports 3 and 4 are spare — they drop out of the print too.
    expect(pdfTable(rows, view).rows.map((r) => r.position)).toEqual(["Port 1", "Port 2"]);
  });

  it("prints the rows in the tab's clicked sort order", () => {
    const rows = computePatchPanelSchedule(PASSTHROUGH_NODES, PASSTHROUGH_EDGES);
    const asc = pdfTable(rows, tabView(rows, { sortBy: "rearRemoteDevice", sortDir: "asc" }));
    const desc = pdfTable(rows, tabView(rows, { sortBy: "rearRemoteDevice", sortDir: "desc" }));
    // The spare ports hold the em-dash sentinel, which sorts ahead of a device name —
    // same comparison the table runs, so the two orders match cell for cell.
    expect(asc.rows.map((r) => r.rearRemoteDevice)).toEqual(["—", "—", "Camera 1", "Vision Switcher"]);
    expect(desc.rows.map((r) => r.rearRemoteDevice)).toEqual([...asc.rows.map((r) => r.rearRemoteDevice)].reverse());
  });

  it("groups the way the tab groups", () => {
    const rows = computePatchPanelSchedule(ALL_NODES, ALL_EDGES);
    const byFace = pdfTable(rows, tabView(rows, { groupBy: "face" }));
    expect([...byFace.groupedRows!.keys()].sort()).toEqual(["Front", "Passthrough", "Rear"]);

    const byPanel = pdfTable(rows, tabView(rows, { groupBy: "panel" }));
    expect([...byPanel.groupedRows!.keys()]).toEqual(["PP-01", "ST Fiber Bulkhead"]);

    const ungrouped = pdfTable(rows, tabView(rows, { groupBy: null }));
    expect(ungrouped.groupedRows).toBeUndefined();
  });

  it("prints the same em dash the table shows for an empty cell", () => {
    const rows = computePatchPanelSchedule(PASSTHROUGH_NODES, PASSTHROUGH_EDGES);
    const table = pdfTable(rows, tabView(rows));
    const spare = table.rows.find((r) => r.position === "Port 4")!;
    for (const key of ["rearRemoteDevice", "rearCableId", "frontRemoteDevice", "frontCableLength"]) {
      expect(spare[key]).toBe("—");
    }
  });
});

describe("patch panel schedule — the CSV stays maximal (#362)", () => {
  it("exports all 34 columns and every row, whatever the tab is showing", () => {
    const rows = computePatchPanelSchedule(ALL_NODES, ALL_EDGES);
    // A tab filtered to one row with 10 columns hidden…
    const view = tabView(rows, { filter: "stage display", hideUnconnected: true });
    expect(pdfColumns(view).length).toBeLessThan(34);

    // …still exports the whole schedule. The CSV is the machine-readable copy.
    const csv = buildPatchPanelScheduleCsv(rows, "Parity Test", "2026-01-01");
    const lines = csv.replace("﻿", "").split("\n");
    expect(splitCsvLine(lines[3])).toHaveLength(34);
    expect(lines).toHaveLength(4 + rows.length);
    expect(splitCsvLine(lines[3])!.slice(0, 5)).toEqual(["Panel", "Panel Room", "Face", "Position", "Signal"]);
  });
});

// ─── Density: mirroring must not smear the page ───────────────────────────────

/**
 * Mirroring took the printed table from 14 columns to 24 (passthrough project) or 34
 * (mixed), which is where the ink starts overlapping: jsPDF's `maxWidth` WRAPS, and the row
 * height is a fixed 6mm, so a wrapped device name lands on the row below, and an unbounded
 * header runs straight through the next two headings. These pin the three mitigations —
 * ellipsis instead of wrap, a gutter that shrinks with the column count, and Tabloid paper.
 */
function pdfGeometry(view: PatchPanelTableView) {
  const layout = createDefaultPatchPanelScheduleLayout(view);
  const { widthMm } = getPageDimensions(layout.paperSize, layout.orientation);
  const contentWidthMm = widthMm - 2 * REPORT_MARGIN_MM;
  const gapMm = getTableColumnGapMm(layout.tables[0], contentWidthMm);
  return { cols: getVisibleColumns(layout.tables[0], contentWidthMm, gapMm), gapMm, contentWidthMm };
}

describe("patch panel schedule — the printed page stays legible (#362)", () => {
  it("fits the columns and their gutters inside the page, at 24 columns and at 34", () => {
    const passthrough = computePatchPanelSchedule(PASSTHROUGH_NODES, PASSTHROUGH_EDGES);
    const mixed = computePatchPanelSchedule(ALL_NODES, ALL_EDGES);

    for (const [label, view, count] of [
      ["passthrough-only", tabView(passthrough), 24],
      ["mixed", tabView(mixed), 34],
    ] as const) {
      const { cols, gapMm, contentWidthMm } = pdfGeometry(view);
      expect(cols).toHaveLength(count);
      const used = cols.reduce((s, c) => s + c.widthMm, 0) + gapMm * (cols.length - 1);
      expect(used, label).toBeCloseTo(contentWidthMm, 6);
      // The gutters must not be the thing eating the page: at 4mm flat, 33 gaps took 132mm
      // of a 251mm Letter width. Keep them under a quarter of it.
      expect(gapMm * (cols.length - 1), label).toBeLessThanOrEqual(contentWidthMm * 0.25);
    }
  });

  it("gives the mixed 34-column print more than twice the column width Letter did", () => {
    const mixed = computePatchPanelSchedule(ALL_NODES, ALL_EDGES);
    const view = tabView(mixed);
    const panel = pdfGeometry(view).cols.find((c) => c.key === "panel")!;
    // Landscape Letter with a flat 4mm gutter scaled the 30mm Panel column to 5.1mm — one
    // word at 8pt. Tabloid plus the tightened gutter is what buys it back.
    expect(panel.widthMm).toBeGreaterThan(11);
  });

  it("clips an over-wide header or cell instead of wrapping it into the next row", () => {
    const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "tabloid" });
    const mixed = computePatchPanelSchedule(ALL_NODES, ALL_EDGES);
    const { cols } = pdfGeometry(tabView(mixed));

    doc.setFontSize(HEADER_FONT_SIZE);
    for (const col of cols) {
      const drawn = fitText(doc, col.header, col.widthMm);
      expect(doc.getTextWidth(drawn), `header ${col.key}`).toBeLessThanOrEqual(col.widthMm);
      expect(drawn.split("\n"), `header ${col.key}`).toHaveLength(1);
    }
    // "Rear Remote Device" is the header that used to overprint its neighbours.
    const rearRemote = cols.find((c) => c.key === "rearRemoteDevice")!;
    expect(doc.getTextWidth("Rear Remote Device")).toBeGreaterThan(rearRemote.widthMm);
    expect(fitText(doc, "Rear Remote Device", rearRemote.widthMm).endsWith("…")).toBe(true);

    doc.setFontSize(FONT_SIZE);
    const panel = cols.find((c) => c.key === "panel")!;
    // …and the device name that used to wrap to three lines inside a 6mm row.
    expect(doc.getTextWidth(fitText(doc, "Vision Switcher", panel.widthMm)))
      .toBeLessThanOrEqual(panel.widthMm);
    expect(fitText(doc, "PP-01", panel.widthMm)).toBe("PP-01"); // short text is untouched
  });

  it("says on the page when the printed schedule is only part of the schematic", () => {
    const mixed = computePatchPanelSchedule(ALL_NODES, ALL_EDGES);
    const plain = createDefaultPatchPanelScheduleLayout(tabView(mixed));
    expect(plain.tables[0].label).toBe("Patch Panel Schedule");

    const narrowed = createDefaultPatchPanelScheduleLayout(
      tabView(mixed, { filter: "stage display", hideUnconnected: true }),
    );
    expect(narrowed.tables[0].label).toBe(
      'Patch Panel Schedule (connected ports only; filtered: "stage display")',
    );
  });
});

// ─── The mirror flag must not touch the other four reports ────────────────────

describe("resolveLayout — mirrorScreen (#362)", () => {
  /** A saved print preference: one column hidden and dragged wider, hand-set sort,
   *  grouping, borders and paper size. */
  function savedFrom(base: ReportLayout, hideKey: string, sortBy: string): ReportLayout {
    return {
      ...base,
      paperSize: "legal",
      tables: base.tables.map((t) => ({
        ...t,
        columns: t.columns.map((c) =>
          c.key === hideKey ? { ...c, visible: false, widthMm: 60 } : c,
        ),
        groupBy: "signalType",
        sortBy,
        sortDir: "desc" as const,
        borderStyle: "grid" as const,
      })),
    };
  }

  it("lets the tab's columns, sort and grouping win, keeping widths and page furniture", () => {
    const rows = computePatchPanelSchedule(PASSTHROUGH_NODES, PASSTHROUGH_EDGES);
    const defaults = createDefaultPatchPanelScheduleLayout(
      tabView(rows, { sortBy: "rearCableId", sortDir: "asc", groupBy: "panel" }),
    );
    const resolved = resolveLayout(defaults, savedFrom(defaults, "panel", "face"), true);
    const table = resolved.tables[0];

    // The saved layout hid Panel, sorted by Face descending and grouped by signal type.
    // None of that survives: the tab is what the print mirrors.
    expect(table.columns.find((c) => c.key === "panel")!.visible).toBe(true);
    expect(table.sortBy).toBe("rearCableId");
    expect(table.sortDir).toBe("asc");
    expect(table.groupBy).toBe("panel");
    // The tab's auto-hidden single-face columns stay hidden — a stale saved "visible"
    // can't resurrect them either.
    expect(getVisibleColumns(table).map((c) => c.key)).toEqual(
      onScreenColumns(new Set(PATCH_PANEL_LEGACY_COLUMN_IDS)),
    );
    // Page furniture, widths and borders are still the user's.
    expect(resolved.paperSize).toBe("legal");
    expect(table.columns.find((c) => c.key === "panel")!.widthMm).toBe(60);
    expect(table.borderStyle).toBe("grid");
  });

  it("leaves the other four reports' saved preferences authoritative", () => {
    const defaults = createDefaultCableScheduleLayout();
    const saved = savedFrom(defaults, "sourceDevice", "cableType");
    const table = resolveLayout(defaults, saved, false).tables[0];

    expect(table.columns.find((c) => c.key === "sourceDevice")!.visible).toBe(false);
    expect(table.columns.find((c) => c.key === "sourceDevice")!.widthMm).toBe(60);
    expect(table.sortBy).toBe("cableType");
    expect(table.sortDir).toBe("desc");
    expect(table.groupBy).toBe("signalType");
    // …and the same layout read with the flag on would have thrown all three away.
    const mirrored = resolveLayout(defaults, saved, true).tables[0];
    expect(mirrored.columns.find((c) => c.key === "sourceDevice")!.visible).toBe(true);
    expect(mirrored.sortBy).toBe(defaults.tables[0].sortBy);
    expect(mirrored.groupBy).toBe(defaults.tables[0].groupBy);
  });
});
