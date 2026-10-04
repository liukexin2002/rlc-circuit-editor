import type { TitleBlockLayout, TitleBlockCell } from "./types";
import { nextCellId, normalizeSizes } from "./titleBlockLayout";
import {
  PATCH_PANEL_SCHEDULE_COLUMNS,
  defaultPatchPanelTableView,
  type PatchPanelTableView,
} from "./patchPanelColumns";
import { getFieldValue as tbGetFieldValue, getFieldLabel as tbGetFieldLabel } from "./titleBlockLayout";

// ─── Types ───

export interface ReportColumnDef {
  key: string;
  header: string;
  widthMm: number;
  visible: boolean;
}

export type TableBorderStyle = "none" | "horizontal" | "grid" | "outer";

export interface ReportTableDef {
  id: string;
  label: string;
  columns: ReportColumnDef[];
  groupBy: string | null;
  groupByOptions: { key: string; label: string }[];
  sortBy: string | null;
  sortDir: "asc" | "desc";
  borderStyle?: TableBorderStyle;
}

export type PaperSize = "letter" | "legal" | "a4" | "tabloid";

export interface ReportLayout {
  headerLayout: TitleBlockLayout;
  headerHeightMm: number;
  footerLayout: TitleBlockLayout;
  footerHeightMm: number;
  tables: ReportTableDef[];
  orientation: "landscape" | "portrait";
  paperSize: PaperSize;
  useGlobalHeader?: boolean;
  useGlobalFooter?: boolean;
}

// ─── Paper Sizes ───

const PAPER_DIMENSIONS: Record<PaperSize, { widthMm: number; heightMm: number }> = {
  letter: { widthMm: 215.9, heightMm: 279.4 },
  legal: { widthMm: 215.9, heightMm: 355.6 },
  a4: { widthMm: 210, heightMm: 297 },
  tabloid: { widthMm: 279.4, heightMm: 431.8 },
};

export const PAPER_LABELS: Record<PaperSize, string> = {
  letter: "Letter",
  legal: "Legal",
  a4: "A4",
  tabloid: "Tabloid",
};

export function getPageDimensions(
  paperSize: PaperSize,
  orientation: "landscape" | "portrait",
): { widthMm: number; heightMm: number } {
  const { widthMm, heightMm } = PAPER_DIMENSIONS[paperSize];
  return orientation === "landscape"
    ? { widthMm: heightMm, heightMm: widthMm }
    : { widthMm, heightMm };
}

export const REPORT_MARGIN_MM = 14;

// ─── Layout Cell Helper ───

function layoutCell(
  row: number,
  col: number,
  content: TitleBlockCell["content"],
  opts: Partial<Pick<TitleBlockCell, "colSpan" | "rowSpan" | "fontSize" | "fontWeight" | "fontFamily" | "align" | "color">> = {},
): TitleBlockCell {
  return {
    id: nextCellId(),
    row,
    col,
    rowSpan: opts.rowSpan ?? 1,
    colSpan: opts.colSpan ?? 1,
    content,
    fontSize: opts.fontSize ?? 7,
    fontWeight: opts.fontWeight ?? "normal",
    fontFamily: opts.fontFamily ?? "sans-serif",
    align: opts.align ?? "left",
    color: opts.color ?? "#1e293b",
  };
}

// ─── Default Header ───

export function createDefaultPackListHeaderLayout(): TitleBlockLayout {
  return {
    columns: normalizeSizes([0.6, 0.4]),
    rows: normalizeSizes([0.55, 0.45]),
    widthIn: 8,
    heightIn: 0.8,
    cells: [
      layoutCell(0, 0, { type: "static", text: "Pack List" }, { fontSize: 14, fontWeight: "bold" }),
      layoutCell(0, 1, { type: "logo" }, { align: "right" }),
      layoutCell(1, 0, { type: "field", field: "showName" }, { fontSize: 8 }),
      layoutCell(1, 1, { type: "field", field: "date" }, { fontSize: 8, align: "right", color: "#666666" }),
    ],
  };
}

// ─── Default Footer ───

export function createDefaultPackListFooterLayout(): TitleBlockLayout {
  return {
    columns: normalizeSizes([0.6, 0.4]),
    rows: [1],
    widthIn: 8,
    heightIn: 0.3,
    cells: [
      layoutCell(0, 0, { type: "static", text: "" }, { fontSize: 7, color: "#888888" }),
      layoutCell(0, 1, { type: "pageNumber" }, { fontSize: 7, align: "right", color: "#888888" }),
    ],
  };
}

// ─── Network Report Defaults ───

export function createDefaultNetworkReportHeaderLayout(): TitleBlockLayout {
  return {
    columns: normalizeSizes([0.6, 0.4]),
    rows: normalizeSizes([0.55, 0.45]),
    widthIn: 8,
    heightIn: 0.8,
    cells: [
      layoutCell(0, 0, { type: "static", text: "Network Report" }, { fontSize: 14, fontWeight: "bold" }),
      layoutCell(0, 1, { type: "logo" }, { align: "right" }),
      layoutCell(1, 0, { type: "field", field: "showName" }, { fontSize: 8 }),
      layoutCell(1, 1, { type: "field", field: "date" }, { fontSize: 8, align: "right", color: "#666666" }),
    ],
  };
}

export function createDefaultNetworkReportLayout(): ReportLayout {
  return {
    headerLayout: createDefaultNetworkReportHeaderLayout(),
    headerHeightMm: 22,
    footerLayout: createDefaultPackListFooterLayout(),
    footerHeightMm: 8,
    tables: [
      {
        id: "network",
        label: "Network Addresses",
        columns: [
          { key: "deviceLabel", header: "Device",   widthMm: 36, visible: true },
          { key: "portLabel",   header: "Port",     widthMm: 26, visible: true },
          { key: "room",        header: "Room",     widthMm: 26, visible: true },
          { key: "signalType",  header: "Signal",   widthMm: 22, visible: true },
          { key: "hostname",    header: "Hostname", widthMm: 30, visible: true },
          { key: "ip",          header: "IP",       widthMm: 30, visible: true },
          { key: "subnetMask",  header: "Subnet",   widthMm: 30, visible: true },
          { key: "gateway",     header: "Gateway",  widthMm: 30, visible: true },
          { key: "vlan",        header: "VLAN",     widthMm: 14, visible: true },
          { key: "linkSpeed",   header: "Speed",    widthMm: 14, visible: false },
          { key: "poeDrawW",    header: "PoE (W)",  widthMm: 16, visible: false },
          { key: "dhcp",        header: "DHCP",     widthMm: 14, visible: true },
          { key: "notes",       header: "Notes",    widthMm: 30, visible: false },
        ],
        groupBy: null,
        groupByOptions: [
          { key: "",           label: "None" },
          { key: "room",       label: "Room" },
          { key: "signalType", label: "Signal Type" },
        ],
        sortBy: null,
        sortDir: "asc",
      },
    ],
    orientation: "landscape",
    paperSize: "letter",
  };
}

// ─── Pack List Defaults ───

export function createDefaultPackListLayout(): ReportLayout {
  return {
    headerLayout: createDefaultPackListHeaderLayout(),
    headerHeightMm: 22,
    footerLayout: createDefaultPackListFooterLayout(),
    footerHeightMm: 8,
    tables: [
      {
        id: "devices",
        label: "Devices",
        columns: [
          { key: "count", header: "Qty", widthMm: 12, visible: true },
          { key: "model", header: "Device", widthMm: 60, visible: true },
          { key: "manufacturer", header: "Manufacturer", widthMm: 30, visible: false },
          { key: "modelNumber", header: "Model #", widthMm: 30, visible: false },
          { key: "deviceType", header: "Type", widthMm: 40, visible: true },
          { key: "room", header: "Room", widthMm: 50, visible: true },
          { key: "powerDrawW", header: "Power (W)", widthMm: 22, visible: false },
          { key: "unitCost", header: "Unit Cost", widthMm: 22, visible: false },
          { key: "extCost", header: "Ext. Cost", widthMm: 22, visible: false },
          { key: "serialNumber", header: "Serial #", widthMm: 32, visible: false },
          { key: "spare", header: "Spare", widthMm: 14, visible: false },
          { key: "note", header: "Note", widthMm: 50, visible: false },
        ],
        groupBy: null,
        groupByOptions: [
          { key: "", label: "None" },
          { key: "room", label: "Room" },
          { key: "deviceType", label: "Device Category" },
        ],
        sortBy: null,
        sortDir: "asc",
      },
      {
        id: "cables",
        label: "Cables",
        columns: [
          { key: "count", header: "Qty", widthMm: 12, visible: true },
          { key: "cableType", header: "Cable Type", widthMm: 30, visible: true },
          { key: "signalType", header: "Signal", widthMm: 28, visible: true },
          { key: "cableLength", header: "Length", widthMm: 18, visible: true },
          { key: "route", header: "Route", widthMm: 52, visible: true },
          { key: "unitCost", header: "Unit Cost", widthMm: 22, visible: false },
          { key: "extCost", header: "Ext. Cost", widthMm: 22, visible: false },
        ],
        groupBy: null,
        groupByOptions: [
          { key: "", label: "None" },
          { key: "path", label: "Path" },
          { key: "category", label: "Category" },
        ],
        sortBy: null,
        sortDir: "asc",
      },
      {
        id: "accessories",
        label: "Cable Accessories",
        columns: [
          { key: "count", header: "Qty", widthMm: 12, visible: true },
          { key: "model", header: "Accessory", widthMm: 60, visible: true },
          { key: "accessoryType", header: "Type", widthMm: 40, visible: true },
          { key: "room", header: "Room", widthMm: 50, visible: true },
        ],
        groupBy: null,
        groupByOptions: [
          { key: "", label: "None" },
          { key: "room", label: "Room" },
        ],
        sortBy: null,
        sortDir: "asc",
      },
      {
        id: "racks",
        label: "Racks",
        columns: [
          { key: "count", header: "Qty", widthMm: 12, visible: true },
          { key: "label", header: "Rack", widthMm: 50, visible: true },
          { key: "rackType", header: "Type", widthMm: 40, visible: true },
          { key: "heightU", header: "Height", widthMm: 18, visible: true },
          { key: "room", header: "Room", widthMm: 40, visible: true },
          { key: "unitCost", header: "Unit Cost", widthMm: 22, visible: false },
          { key: "extCost", header: "Ext. Cost", widthMm: 22, visible: false },
        ],
        groupBy: null,
        groupByOptions: [
          { key: "", label: "None" },
          { key: "room", label: "Room" },
        ],
        sortBy: null,
        sortDir: "asc",
      },
    ],
    orientation: "portrait",
    paperSize: "letter",
  };
}

// ─── Cable Schedule Defaults ───

export function createDefaultCableScheduleHeaderLayout(): TitleBlockLayout {
  return {
    columns: normalizeSizes([0.6, 0.4]),
    rows: normalizeSizes([0.55, 0.45]),
    widthIn: 8,
    heightIn: 0.8,
    cells: [
      layoutCell(0, 0, { type: "static", text: "Cable Schedule" }, { fontSize: 14, fontWeight: "bold" }),
      layoutCell(0, 1, { type: "logo" }, { align: "right" }),
      layoutCell(1, 0, { type: "field", field: "showName" }, { fontSize: 8 }),
      layoutCell(1, 1, { type: "field", field: "date" }, { fontSize: 8, align: "right", color: "#666666" }),
    ],
  };
}

export function createDefaultCableScheduleLayout(): ReportLayout {
  return {
    headerLayout: createDefaultCableScheduleHeaderLayout(),
    headerHeightMm: 22,
    footerLayout: createDefaultPackListFooterLayout(),
    footerHeightMm: 8,
    tables: [
      {
        id: "cableSchedule",
        label: "Cable Schedule",
        columns: [
          { key: "cableId",         header: "Cable ID",   widthMm: 18, visible: true },
          { key: "sourceDevice",    header: "Source",      widthMm: 30, visible: true },
          { key: "sourcePort",      header: "Src Port",    widthMm: 22, visible: true },
          { key: "sourceConnector", header: "Src Conn",    widthMm: 18, visible: true },
          { key: "targetDevice",    header: "Target",      widthMm: 30, visible: true },
          { key: "targetPort",      header: "Tgt Port",    widthMm: 22, visible: true },
          { key: "targetConnector", header: "Tgt Conn",    widthMm: 18, visible: true },
          { key: "cableType",       header: "Cable Type",  widthMm: 22, visible: true },
          { key: "signalType",      header: "Signal",      widthMm: 20, visible: true },
          { key: "cableLength",     header: "Length",      widthMm: 16, visible: true },
          { key: "computedLength",  header: "Est. Length", widthMm: 18, visible: true },
          { key: "gaugeAwg",        header: "Gauge",       widthMm: 16, visible: false },
          { key: "cableAlias",      header: "Alias",       widthMm: 28, visible: false },
          { key: "tested",          header: "Tested",      widthMm: 22, visible: false },
          { key: "cableUse",        header: "Use",         widthMm: 16, visible: false },
          { key: "sourceRoom",      header: "Src Room",    widthMm: 24, visible: true },
          { key: "targetRoom",      header: "Tgt Room",    widthMm: 24, visible: true },
          { key: "multicableLabel", header: "Snake",       widthMm: 24, visible: true },
          { key: "bundle",          header: "Bundle",      widthMm: 22, visible: false },
        ],
        groupBy: null,
        groupByOptions: [
          { key: "",           label: "None" },
          { key: "sourceRoom", label: "Source Room" },
          { key: "signalType", label: "Signal Type" },
          { key: "cableType",  label: "Cable Type" },
          { key: "multicableLabel", label: "Snake" },
          { key: "bundle",     label: "Bundle" },
        ],
        sortBy: "cableId",
        sortDir: "asc",
      },
    ],
    orientation: "landscape",
    paperSize: "letter",
  };
}

// ─── Patch Panel Schedule Defaults ───

export function createDefaultPatchPanelScheduleHeaderLayout(): TitleBlockLayout {
  return {
    columns: normalizeSizes([0.6, 0.4]),
    rows: normalizeSizes([0.55, 0.45]),
    widthIn: 8,
    heightIn: 0.8,
    cells: [
      layoutCell(0, 0, { type: "static", text: "Patch Panel Schedule" }, { fontSize: 14, fontWeight: "bold" }),
      layoutCell(0, 1, { type: "logo" }, { align: "right" }),
      layoutCell(1, 0, { type: "field", field: "showName" }, { fontSize: 8 }),
      layoutCell(1, 1, { type: "field", field: "date" }, { fontSize: 8, align: "right", color: "#666666" }),
    ],
  };
}

/** How the section title says the table was narrowed, so a printed schedule that shows 3
 *  of 40 ports says so on the page instead of looking like the whole panel (#362). */
function patchPanelScheduleLabel(view: PatchPanelTableView): string {
  const notes: string[] = [];
  if (view.hideUnconnected) notes.push("connected ports only");
  if (view.filter.trim()) notes.push(`filtered: "${view.filter.trim()}"`);
  return notes.length > 0 ? `Patch Panel Schedule (${notes.join("; ")})` : "Patch Panel Schedule";
}

/**
 * The Patch Panel Schedule print layout mirrors the on-screen table (#362): the columns,
 * their order, which ones are hidden, the sort and the grouping all come from the tab's
 * published view.
 *
 * The no-argument form is a bare skeleton — every column visible, no filtering — not a
 * picture of an untouched tab, which auto-hides the single-face columns whenever no legacy
 * paired-port row is in view (#311). Callers that want what the tab would actually show
 * must pass a view with `hiddenColumns` resolved off the rows.
 */
export function createDefaultPatchPanelScheduleLayout(
  view: PatchPanelTableView = defaultPatchPanelTableView(),
): ReportLayout {
  const hidden = new Set(view.hiddenColumns);
  return {
    headerLayout: createDefaultPatchPanelScheduleHeaderLayout(),
    headerHeightMm: 22,
    footerLayout: createDefaultPackListFooterLayout(),
    footerHeightMm: 8,
    tables: [
      {
        id: "patchPanelSchedule",
        label: patchPanelScheduleLabel(view),
        columns: PATCH_PANEL_SCHEDULE_COLUMNS.map((c) => ({
          key: c.key,
          header: c.header,
          widthMm: c.widthMm,
          visible: !hidden.has(c.key),
        })),
        groupBy: view.groupBy,
        groupByOptions: [
          { key: "",           label: "None" },
          { key: "panel",      label: "Panel" },
          { key: "panelRoom",  label: "Panel Room" },
          { key: "signalType", label: "Signal Type" },
          { key: "face",       label: "Face" },
        ],
        sortBy: view.sortBy,
        sortDir: view.sortDir,
      },
    ],
    orientation: "landscape",
    // Tabloid, not Letter: mirroring the table means a passthrough project prints 24
    // columns and a mixed one all 34, which Letter squeezes past legibility (#362). A
    // saved paper size still wins, and the preview's Paper control changes it per report.
    paperSize: "tabloid",
  };
}

// ─── Power Report Defaults ───

export function createDefaultPowerReportHeaderLayout(): TitleBlockLayout {
  return {
    columns: normalizeSizes([0.6, 0.4]),
    rows: normalizeSizes([0.55, 0.45]),
    widthIn: 8,
    heightIn: 0.8,
    cells: [
      layoutCell(0, 0, { type: "static", text: "Power Report" }, { fontSize: 14, fontWeight: "bold" }),
      layoutCell(0, 1, { type: "logo" }, { align: "right" }),
      layoutCell(1, 0, { type: "field", field: "showName" }, { fontSize: 8 }),
      layoutCell(1, 1, { type: "field", field: "date" }, { fontSize: 8, align: "right", color: "#666666" }),
    ],
  };
}

export function createDefaultPowerReportLayout(): ReportLayout {
  return {
    headerLayout: createDefaultPowerReportHeaderLayout(),
    headerHeightMm: 22,
    footerLayout: createDefaultPackListFooterLayout(),
    footerHeightMm: 8,
    tables: [
      {
        id: "powerDevices",
        label: "Device Power Draw",
        columns: [
          { key: "count", header: "Qty", widthMm: 12, visible: true },
          { key: "model", header: "Device", widthMm: 42, visible: true },
          { key: "deviceType", header: "Type", widthMm: 30, visible: true },
          { key: "room", header: "Room", widthMm: 30, visible: true },
          { key: "powerDrawW", header: "Power (W)", widthMm: 20, visible: true },
          { key: "totalPowerW", header: "Total (W)", widthMm: 20, visible: true },
          { key: "thermalBtuh", header: "Thermal (BTU/h)", widthMm: 22, visible: true },
          { key: "totalThermalBtuh", header: "Total (BTU/h)", widthMm: 22, visible: true },
          { key: "voltage", header: "Voltage", widthMm: 22, visible: true },
        ],
        groupBy: null,
        groupByOptions: [
          { key: "", label: "None" },
          { key: "room", label: "Room" },
        ],
        sortBy: null,
        sortDir: "asc",
      },
      {
        id: "powerDistros",
        label: "Distribution Loading",
        columns: [
          { key: "label", header: "Distro", widthMm: 45, visible: true },
          { key: "room", header: "Room", widthMm: 35, visible: true },
          { key: "capacityW", header: "Capacity (W)", widthMm: 28, visible: true },
          { key: "loadW", header: "Load (W)", widthMm: 24, visible: true },
          { key: "loadPercent", header: "Load %", widthMm: 20, visible: true },
          { key: "status", header: "Status", widthMm: 20, visible: true },
        ],
        groupBy: null,
        groupByOptions: [
          { key: "", label: "None" },
          { key: "room", label: "Room" },
        ],
        sortBy: null,
        sortDir: "asc",
      },
    ],
    orientation: "portrait",
    paperSize: "letter",
  };
}

// ─── Saved-preference resolution ───

/**
 * Resolve a layout by combining hardcoded defaults with saved user preferences.
 * Column definitions, headers, and groupByOptions always come from code.
 * Only user selections (visibility, widths, groupBy, sort) are restored from saved data.
 *
 * `mirrorScreen` reports (the Patch Panel Schedule) hand in a layout already built from
 * what their tab is showing, so which columns show and how the rows are sorted and grouped
 * is the tab's business, not a saved print preference — only widths and page furniture are
 * restored for them (#362). Nothing is lost by that: the tab's own Columns menu covers
 * every column and persists with the document, so it is the durable way to narrow the
 * print. Changes made in this dialog's column list apply to the export in hand.
 */
export function resolveLayout(
  defaults: ReportLayout,
  saved: ReportLayout | null,
  mirrorScreen = false,
): ReportLayout {
  if (!saved) return defaults;
  return {
    ...defaults,
    // Restore user's page/header/footer preferences
    headerLayout: saved.headerLayout ?? defaults.headerLayout,
    headerHeightMm: saved.headerHeightMm ?? defaults.headerHeightMm,
    footerLayout: saved.footerLayout ?? defaults.footerLayout,
    footerHeightMm: saved.footerHeightMm ?? defaults.footerHeightMm,
    orientation: saved.orientation ?? defaults.orientation,
    paperSize: saved.paperSize ?? defaults.paperSize,
    tables: defaults.tables.map((defaultTable) => {
      const savedTable = saved.tables.find((t) => t.id === defaultTable.id);
      if (!savedTable) return defaultTable;
      // Apply saved visibility and widths onto hardcoded column definitions
      const savedVis = new Map(savedTable.columns.map((c) => [c.key, c.visible]));
      const savedWidths = new Map(savedTable.columns.map((c) => [c.key, c.widthMm]));
      return {
        ...defaultTable, // id, label, columns (definitions), groupByOptions from code
        columns: defaultTable.columns.map((col) => ({
          ...col,
          visible: !mirrorScreen && savedVis.has(col.key) ? savedVis.get(col.key)! : col.visible,
          widthMm: savedWidths.has(col.key) ? savedWidths.get(col.key)! : col.widthMm,
        })),
        groupBy: mirrorScreen ? defaultTable.groupBy : savedTable.groupBy,
        sortBy: mirrorScreen ? defaultTable.sortBy : savedTable.sortBy,
        sortDir: mirrorScreen ? defaultTable.sortDir : savedTable.sortDir,
        borderStyle: savedTable.borderStyle,
      };
    }),
  };
}

// ─── Helpers ───

/** The gutter a table with no crowding problem uses between columns. */
export const REPORT_COL_GAP_MM = 4;

/**
 * Gap to put between printed columns.
 *
 * A flat 4mm is fine for a dozen columns but ruinous for a wide table: the Patch Panel
 * Schedule mirroring a mixed project prints 34 columns, whose 33 gaps would eat 132mm of a
 * 251mm content width before a single character is drawn (#362). Cap the gutters at a
 * quarter of the width and let the columns have the rest.
 */
export function getColumnGapMm(columnCount: number, availableWidthMm: number): number {
  if (columnCount < 2 || availableWidthMm <= 0) return REPORT_COL_GAP_MM;
  return Math.min(REPORT_COL_GAP_MM, (availableWidthMm * 0.25) / (columnCount - 1));
}

/** The gap the renderers will use for this table — visible column count decides it. */
export function getTableColumnGapMm(table: ReportTableDef, availableWidthMm: number): number {
  return getColumnGapMm(table.columns.filter((c) => c.visible).length, availableWidthMm);
}

/**
 * Get visible columns, optionally scaled to fill the available page width.
 * When availableWidthMm is provided, column widths are proportionally scaled
 * so they fill the space — hiding a column lets others expand automatically.
 */
export function getVisibleColumns(table: ReportTableDef, availableWidthMm?: number, colGap = 0): ReportColumnDef[] {
  const visible = table.columns.filter((c) => c.visible);
  if (!availableWidthMm || visible.length === 0) return visible;
  const totalW = visible.reduce((s, c) => s + c.widthMm, 0);
  if (totalW <= 0) return visible;
  // Subtract inter-column gaps from available space so columns + gaps fit exactly
  const usableW = availableWidthMm - colGap * Math.max(0, visible.length - 1);
  const scale = usableW / totalW;
  if (Math.abs(scale - 1) < 0.001) return visible; // already fills
  return visible.map((c) => ({ ...c, widthMm: c.widthMm * scale }));
}

// Re-export titleBlockLayout helpers for convenience
export { tbGetFieldValue as getFieldValue, tbGetFieldLabel as getFieldLabel };

