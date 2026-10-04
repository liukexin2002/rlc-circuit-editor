/**
 * The Patch Panel Schedule's column list, in the order the on-screen table renders them,
 * plus the shape the tab uses to publish what it is currently showing.
 *
 * The on-screen table, the print layout and the PDF table data are all built from this one
 * list so the PDF can't drift from the screen in content or order (#362). The CSV is
 * deliberately not built from it — see `buildPatchPanelScheduleCsv`.
 *
 * Kept in its own module (no imports) so `reportLayout` and `patchPanelSchedule` can both
 * read it without an import cycle.
 */

/** Section the column picker files a column under. */
export type PatchPanelColumnGroup = "port" | "singleFace" | "passthrough";

export const PATCH_PANEL_COLUMN_GROUP_LABELS: Record<PatchPanelColumnGroup, string> = {
  port: "Port Columns",
  singleFace: "Single-Face Columns",
  passthrough: "Passthrough Columns",
};

export interface PatchPanelColumnDef {
  /** Row field the cell reads. */
  key: string;
  /** Heading, on screen and in the PDF. */
  header: string;
  /** Column width in the print layout. */
  widthMm: number;
  /** Which section of the tab's column picker the column sits in. */
  group: PatchPanelColumnGroup;
  /** Header tooltip on screen. */
  title?: string;
  /** Estimated-length columns render in the muted colour on screen. */
  muted?: boolean;
  /** False for the columns whose header isn't a sort handle. */
  sortable?: boolean;
}

const EST_LENGTH_TITLE = "Estimated length from room-to-room distance + slack";

export const PATCH_PANEL_SCHEDULE_COLUMNS: PatchPanelColumnDef[] = [
  { key: "panel",              header: "Panel",               widthMm: 30, group: "port" },
  { key: "panelRoom",          header: "Panel Room",          widthMm: 24, group: "port" },
  { key: "face",               header: "Face",                widthMm: 14, group: "port" },
  { key: "position",           header: "Position",            widthMm: 20, group: "port" },
  { key: "signalType",         header: "Signal",              widthMm: 20, group: "port" },

  // Single-face (legacy paired input/output) columns — auto-hidden when no such row is in
  // view; see PATCH_PANEL_LEGACY_COLUMN_IDS / resolvePatchPanelHiddenColumns (#311).
  { key: "connector",          header: "Connector",           widthMm: 18, group: "singleFace" },
  { key: "gender",             header: "M/F",                 widthMm: 10, group: "singleFace" },
  { key: "remoteDevice",       header: "Remote Device",       widthMm: 30, group: "singleFace" },
  { key: "remotePort",         header: "Remote Port",         widthMm: 22, group: "singleFace" },
  { key: "remoteRoom",         header: "Remote Room",         widthMm: 24, group: "singleFace" },
  { key: "cableId",            header: "Cable ID",            widthMm: 18, group: "singleFace" },
  { key: "cableType",          header: "Cable Type",          widthMm: 22, group: "singleFace" },
  { key: "cableLength",        header: "Length",              widthMm: 16, group: "singleFace" },
  { key: "computedLength",     header: "Est. Length",         widthMm: 18, group: "singleFace", title: EST_LENGTH_TITLE, muted: true },
  { key: "multicableLabel",    header: "Snake",               widthMm: 20, group: "singleFace" },

  // Passthrough circuits report per face instead.
  { key: "rearConnector",      header: "Rear Connector",      widthMm: 20, group: "passthrough" },
  { key: "rearGender",         header: "Rear M/F",            widthMm: 12, group: "passthrough" },
  { key: "rearRemoteDevice",   header: "Rear Remote Device",  widthMm: 30, group: "passthrough" },
  { key: "rearRemotePort",     header: "Rear Remote Port",    widthMm: 24, group: "passthrough" },
  { key: "rearRemoteRoom",     header: "Rear Remote Room",    widthMm: 24, group: "passthrough", title: "Room of the rear-face remote device", sortable: false },
  { key: "rearCableId",        header: "Rear Cable ID",       widthMm: 20, group: "passthrough" },
  { key: "rearCableType",      header: "Rear Cable Type",     widthMm: 24, group: "passthrough" },
  { key: "rearCableLength",    header: "Rear Length",         widthMm: 18, group: "passthrough" },
  { key: "rearComputedLength", header: "Rear Est. Length",    widthMm: 20, group: "passthrough", title: EST_LENGTH_TITLE, muted: true, sortable: false },
  { key: "frontConnector",     header: "Front Connector",     widthMm: 20, group: "passthrough" },
  { key: "frontGender",        header: "Front M/F",           widthMm: 12, group: "passthrough" },
  { key: "frontRemoteDevice",  header: "Front Remote Device", widthMm: 30, group: "passthrough" },
  { key: "frontRemotePort",    header: "Front Remote Port",   widthMm: 24, group: "passthrough" },
  { key: "frontRemoteRoom",    header: "Front Remote Room",   widthMm: 24, group: "passthrough", title: "Room of the front-face remote device", sortable: false },
  { key: "frontCableId",       header: "Front Cable ID",      widthMm: 20, group: "passthrough" },
  { key: "frontCableType",     header: "Front Cable Type",    widthMm: 24, group: "passthrough" },
  { key: "frontCableLength",   header: "Front Length",        widthMm: 18, group: "passthrough" },
  { key: "frontComputedLength",header: "Front Est. Length",   widthMm: 20, group: "passthrough", title: EST_LENGTH_TITLE, muted: true, sortable: false },
  { key: "normalling",         header: "Normalling",          widthMm: 18, group: "passthrough" },
];

/**
 * What the Patch Panels tab is currently showing. The tab publishes this so the PDF
 * preview can be seeded from it — columns, filter, sort and grouping all mirrored (#362).
 */
export interface PatchPanelTableView {
  /** Free-text filter box. */
  filter: string;
  /** "Hide empty" checkbox — drops rows with no connection. */
  hideUnconnected: boolean;
  /** Column keys the table is not rendering (resolved, including the #311 auto-hidden set). */
  hiddenColumns: string[];
  /** Column key the rows are sorted by; "position" means the natural rear-then-front order. */
  sortBy: string;
  sortDir: "asc" | "desc";
  /** Group-by column key, or null for no grouping. */
  groupBy: string | null;
}

/** The view of an untouched tab: nothing filtered, nothing hidden, grouped by panel. */
export function defaultPatchPanelTableView(): PatchPanelTableView {
  return {
    filter: "",
    hideUnconnected: false,
    hiddenColumns: [],
    sortBy: "panel",
    sortDir: "asc",
    groupBy: "panel",
  };
}
