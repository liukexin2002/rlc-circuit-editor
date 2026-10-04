/**
 * Fixture-independent report invariants.
 *
 * Golden snapshots only protect the committed fixtures; these checks run on
 * EVERY fixture (including gitignored real client exports), so structural
 * report bugs surface even on schematics whose outputs can't be committed.
 */

import type { ReportFixture } from "./fixtures";
import type { ReportsSnapshot, SnapshotTable } from "./snapshot";
import { defaultLayouts, patchPanelTabView } from "./snapshot";
import type { DeviceData, ConnectionEdge } from "../types";
import type { CableScheduleRow } from "../cableSchedule";
import type { PackListData } from "../packList";
import type { NetworkReportRow } from "../networkReport";
import type { PowerReportData } from "../powerReport";
import type { PatchPanelScheduleRow } from "../patchPanelSchedule";
import { createDefaultPatchPanelScheduleLayout, type ReportLayout } from "../reportLayout";

const BOM = "\uFEFF";

/** Quote-aware CSV line splitter. Returns null on unbalanced quotes. */
export function splitCsvLine(line: string): string[] | null {
  const cells: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      if (cur !== "") return null; // quote opening mid-cell
      inQuotes = true;
    } else if (ch === ",") {
      cells.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (inQuotes) return null;
  cells.push(cur);
  return cells;
}

const JUNK_CELLS = new Set(["undefined", "NaN", "null"]);

function checkCsv(
  problems: string[],
  label: string,
  csv: string,
  opts: { bom: boolean; headerLine?: number },
): void {
  if (opts.bom && !csv.startsWith(BOM)) {
    problems.push(`${label}: missing UTF-8 BOM (Excel mojibake risk)`);
  }
  if (!opts.bom && csv.startsWith(BOM)) {
    problems.push(`${label}: unexpected BOM in builder output (download wrapper adds it — would double up)`);
  }
  const lines = csv.replace(BOM, "").split("\n");
  let headerCells: number | undefined;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === "") continue;
    const cells = splitCsvLine(lines[i]);
    if (cells === null) {
      problems.push(`${label} line ${i + 1}: unbalanced quotes: ${lines[i].slice(0, 80)}`);
      continue;
    }
    for (const cell of cells) {
      if (JUNK_CELLS.has(cell) || cell.includes("[object Object]")) {
        problems.push(`${label} line ${i + 1}: junk cell value "${cell}"`);
      }
    }
    if (opts.headerLine !== undefined) {
      if (i === opts.headerLine) headerCells = cells.length;
      else if (i > opts.headerLine && headerCells !== undefined && cells.length !== headerCells) {
        problems.push(
          `${label} line ${i + 1}: ${cells.length} cells, header has ${headerCells}`,
        );
      }
    }
  }
}

/**
 * Every column key defined in the print layout must exist on every table-data row (and vice
 * versa for table ids) — catches "column added on-screen but not in the print report"
 * drift (#217).
 *
 * `visibleOnly` is for a report whose table data carries only the columns it is printing —
 * the Patch Panel Schedule projects the tab's visible set and nothing else (#362). There
 * the check runs both ways: every visible layout column must be a row key, and every row
 * key must be a visible layout column, so a row can't quietly gain or lose one.
 */
function checkPrintTables(
  problems: string[],
  reportLabel: string,
  tables: SnapshotTable[],
  layout: ReportLayout,
  visibleOnly = false,
): void {
  for (const tableDef of layout.tables) {
    const table = tables.find((t) => t.id === tableDef.id);
    if (!table) {
      problems.push(`${reportLabel}: layout table "${tableDef.id}" has no table data`);
      continue;
    }
    const wanted = visibleOnly ? tableDef.columns.filter((c) => c.visible) : tableDef.columns;
    for (const col of wanted) {
      for (const row of table.rows) {
        if (!(col.key in row)) {
          problems.push(
            `${reportLabel} table "${tableDef.id}": layout column "${col.key}" missing from row data`,
          );
          break; // one report per column is enough
        }
      }
    }
    if (!visibleOnly) continue;
    const printable = new Set(wanted.map((c) => c.key));
    const strays = new Set<string>();
    for (const row of table.rows) {
      // Keys starting with "_" are renderer hints (e.g. _isSubItem), not columns.
      for (const key of Object.keys(row)) {
        if (!key.startsWith("_") && !printable.has(key)) strays.add(key);
      }
    }
    for (const key of strays) {
      problems.push(
        `${reportLabel} table "${tableDef.id}": row data carries "${key}", which the layout is not printing`,
      );
    }
  }
}

export function checkInvariants(fx: ReportFixture, snap: ReportsSnapshot): string[] {
  const problems: string[] = [];

  // ── CSV well-formedness ──
  checkCsv(problems, "cableSchedule.csv", snap.cableSchedule.csv, { bom: true, headerLine: 3 });
  checkCsv(problems, "packList.csv", snap.packList.csv, { bom: true });
  checkCsv(problems, "powerReport.csv", snap.powerReport.csv, { bom: true });
  checkCsv(problems, "patchPanelSchedule.csv", snap.patchPanelSchedule.csv, { bom: true, headerLine: 3 });
  checkCsv(problems, "networkReport.csv", snap.networkReport.csv, { bom: false, headerLine: 0 });

  // ── Print layout ↔ table data drift ──
  const layouts = defaultLayouts();
  checkPrintTables(problems, "cableSchedule", snap.cableSchedule.printTables, layouts.cableSchedule);
  checkPrintTables(problems, "packList", snap.packList.printTables, layouts.packList);
  checkPrintTables(problems, "networkReport", snap.networkReport.printTables, layouts.networkReport);
  checkPrintTables(problems, "powerReport", snap.powerReport.printTables, layouts.powerReport);
  // The patch panel schedule prints through the tab's view, so rebuild that view from the
  // snapshot's own rows and check against the layout the app would have used (#362).
  checkPrintTables(
    problems,
    "patchPanelSchedule",
    snap.patchPanelSchedule.printTables,
    createDefaultPatchPanelScheduleLayout(
      patchPanelTabView(snap.patchPanelSchedule.rows as PatchPanelScheduleRow[]),
    ),
    true,
  );

  // ── Network report semantics ──
  for (const row of snap.networkReport.rows as NetworkReportRow[]) {
    if (row.dhcpCovered !== (row.dhcpServerLabel !== "")) {
      problems.push(
        `networkReport: ${row.deviceLabel}/${row.portLabel}: dhcpCovered=${row.dhcpCovered} but dhcpServerLabel="${row.dhcpServerLabel}"`,
      );
    }
  }

  // ── Power report totals (double entry) ──
  const power = snap.powerReport.data as PowerReportData;
  const summedPower = power.devices.reduce((s, d) => s + d.powerDrawW * d.count, 0);
  if (summedPower !== power.totalPowerW) {
    problems.push(`powerReport: totalPowerW=${power.totalPowerW} but device rows sum to ${summedPower}`);
  }

  // ── Pack list counts (double entry vs the raw schematic) ──
  const pack = snap.packList.data as PackListData;
  const deviceNodes = fx.nodes.filter((n) => {
    if (n.type !== "device") return false;
    const d = n.data as DeviceData;
    return !d.isVenueProvided && !d.isCableAccessory && d.deviceType !== "adapter";
  });
  const packDeviceCount = pack.devices.reduce((s, d) => s + d.count, 0);
  if (packDeviceCount !== deviceNodes.length) {
    problems.push(
      `packList: device rows sum to ${packDeviceCount}, schematic has ${deviceNodes.length} countable devices`,
    );
  }
  const rackNodes = fx.pages.flatMap((p) => (p.type === "rack-elevation" ? p.racks ?? [] : []));
  const packRackCount = pack.racks.reduce((s, r) => s + r.count, 0);
  if (packRackCount !== rackNodes.length) {
    problems.push(`packList: rack rows sum to ${packRackCount}, pages contain ${rackNodes.length} racks`);
  }
  const summaryCount = pack.summary.reduce((s, r) => s + r.count, 0);
  if (summaryCount !== pack.cables.length) {
    problems.push(
      `packList: cable summary counts sum to ${summaryCount}, cable list has ${pack.cables.length} cables`,
    );
  }

  // ── Cable schedule rows trace back to real edges, IDs unique + present ──
  const edgeIds = new Set(fx.edges.map((e: ConnectionEdge) => e.id));
  const seenCableIds = new Set<string>();
  for (const row of snap.cableSchedule.rows as CableScheduleRow[]) {
    if (!edgeIds.has(row.edgeId)) {
      problems.push(`cableSchedule: row cableId=${row.cableId} references unknown edge ${row.edgeId}`);
    }
    if (!row.cableId) {
      problems.push(`cableSchedule: edge ${row.edgeId} has an empty cable ID`);
    } else if (seenCableIds.has(row.cableId)) {
      problems.push(`cableSchedule: duplicate cable ID ${row.cableId}`);
    }
    seenCableIds.add(row.cableId);
  }

  return problems;
}
