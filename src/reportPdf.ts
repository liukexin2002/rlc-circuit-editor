import { jsPDF } from "jspdf";
import type { TitleBlock } from "./types";
import type { ReportLayout, ReportTableDef } from "./reportLayout";
import {
  getVisibleColumns,
  getTableColumnGapMm,
  getPageDimensions,
  REPORT_MARGIN_MM,
} from "./reportLayout";
import { normalizeSizes, getFieldValue, getFieldLabel } from "./titleBlockLayout";

// ─── Constants ───

const ROW_HEIGHT = 6;
const HEADER_HEIGHT = 7;
export const FONT_SIZE = 8;
export const HEADER_FONT_SIZE = 9;

// ─── Inter font embedding ───

let interRegularB64: string | null = null;
let interBoldB64: string | null = null;

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

async function loadInterFont(doc: jsPDF) {
  if (!interRegularB64) {
    const [regularRes, boldRes] = await Promise.all([
      fetch("/fonts/Inter-Regular.ttf"),
      fetch("/fonts/Inter-Bold.ttf"),
    ]);
    if (!regularRes.ok || !boldRes.ok) {
      throw new Error(`Font fetch failed: regular=${regularRes.status} bold=${boldRes.status}`);
    }
    const [regular, bold] = await Promise.all([
      regularRes.arrayBuffer(),
      boldRes.arrayBuffer(),
    ]);
    interRegularB64 = arrayBufferToBase64(regular);
    interBoldB64 = arrayBufferToBase64(bold);
  }
  doc.addFileToVFS("Inter-Regular.ttf", interRegularB64);
  doc.addFileToVFS("Inter-Bold.ttf", interBoldB64!);
  doc.addFont("Inter-Regular.ttf", "Inter", "normal");
  doc.addFont("Inter-Bold.ttf", "Inter", "bold");
}

// ─── Text fitting ───

/**
 * The longest head of `text` that fits in `widthMm`, tail-trimmed with an ellipsis.
 *
 * Cells and headers must never be handed to jsPDF with a `maxWidth`, because jsPDF's answer
 * to an over-wide string is to WRAP it — and the row height here is a fixed 6mm, so the
 * second line lands on top of the row beneath. Clipping is what the on-screen preview does
 * and what the table on the Patch Panels tab does, so it is also what prints (#362).
 */
export function fitText(doc: jsPDF, text: string, widthMm: number): string {
  if (!text || widthMm <= 0) return "";
  if (doc.getTextWidth(text) <= widthMm) return text;
  const ellipsis = "…";
  const ellipsisW = doc.getTextWidth(ellipsis);
  if (ellipsisW > widthMm) return "";
  // Longest prefix that still leaves room for the ellipsis.
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (doc.getTextWidth(text.slice(0, mid)) + ellipsisW <= widthMm) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + ellipsis;
}

// ─── Table data types ───

export interface ReportTableData {
  id: string;
  rows: Record<string, string>[];
  groupedRows?: Map<string, Record<string, string>[]>;
}

// ─── Grid Block Renderer (shared by header + footer) ───

function drawGridBlock(
  doc: jsPDF,
  layout: ReportLayout,
  titleBlock: TitleBlock,
  block: "header" | "footer",
  pageWidthMm: number,
  pageNum: number,
  totalPages: number,
) {
  const bl = block === "header" ? layout.headerLayout : layout.footerLayout;
  const blockH = block === "header" ? layout.headerHeightMm : layout.footerHeightMm;
  const contentW = pageWidthMm - 2 * REPORT_MARGIN_MM;
  const pageHeight = doc.internal.pageSize.getHeight();
  const blockY = block === "header" ? REPORT_MARGIN_MM : pageHeight - REPORT_MARGIN_MM - blockH;

  const cols = normalizeSizes(bl.columns);
  const rows = normalizeSizes(bl.rows);

  const colStarts: number[] = [0];
  for (let i = 0; i < cols.length; i++) colStarts.push(colStarts[i] + cols[i]);
  const rowStarts: number[] = [0];
  for (let i = 0; i < rows.length; i++) rowStarts.push(rowStarts[i] + rows[i]);

  const FONT_MAP: Record<string, string> = {
    "sans-serif": "Inter",
    serif: "times",
    monospace: "courier",
  };

  for (const cell of bl.cells) {
    const x = REPORT_MARGIN_MM + colStarts[cell.col] * contentW;
    const y = blockY + rowStarts[cell.row] * blockH;
    let w = 0;
    for (let c = cell.col; c < cell.col + cell.colSpan && c < cols.length; c++) w += cols[c];
    w *= contentW;
    let h = 0;
    for (let r = cell.row; r < cell.row + cell.rowSpan && r < rows.length; r++) h += rows[r];
    h *= blockH;

    const fontName = FONT_MAP[cell.fontFamily] ?? "Inter";
    doc.setFont(fontName, cell.fontWeight === "bold" ? "bold" : "normal");
    doc.setFontSize(cell.fontSize);

    const colorMatch = cell.color.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
    if (colorMatch) {
      doc.setTextColor(parseInt(colorMatch[1], 16), parseInt(colorMatch[2], 16), parseInt(colorMatch[3], 16));
    } else {
      doc.setTextColor(0);
    }

    let text = "";
    switch (cell.content.type) {
      case "field": {
        const val = getFieldValue(titleBlock, cell.content.field);
        if (val) {
          const label = getFieldLabel(titleBlock, cell.content.field);
          text = `${label}: ${val}`;
        }
        break;
      }
      case "static":
        text = cell.content.text;
        break;
      case "pageNumber":
        text = `Page ${pageNum} of ${totalPages}`;
        break;
      case "logo":
        if (titleBlock.logo) {
          try {
            // Get actual image dimensions from jsPDF
            const imgProps = doc.getImageProperties(titleBlock.logo);
            const imgAspect = imgProps.width / imgProps.height;
            const pad = 1;
            const maxW = w - 2 * pad;
            const maxH = h - 2 * pad;
            let lw = maxH * imgAspect;
            let lh = maxH;
            if (lw > maxW) { lw = maxW; lh = lw / imgAspect; }
            const lx = cell.align === "right" ? x + w - lw - pad : cell.align === "center" ? x + (w - lw) / 2 : x + pad;
            const ly = y + (h - lh) / 2;
            doc.addImage(titleBlock.logo, lx, ly, lw, lh);
          } catch { /* skip logo */ }
        }
        break;
    }

    if (text && cell.content.type !== "logo") {
      const textY = y + h / 2 + cell.fontSize * 0.15;
      if (cell.align === "center") {
        doc.text(text, x + w / 2, textY, { align: "center", maxWidth: w - 2 });
      } else if (cell.align === "right") {
        doc.text(text, x + w - 1, textY, { align: "right", maxWidth: w - 2 });
      } else {
        doc.text(text, x + 1, textY, { maxWidth: w - 2 });
      }
    }
  }

  doc.setTextColor(0);
}

// ─── Table Renderer ───

function drawTableSection(
  doc: jsPDF,
  tableDef: ReportTableDef,
  tableData: ReportTableData,
  startY: number,
  bottomLimit: number,
  contentWidthMm: number,
): number {
  const colGap = getTableColumnGapMm(tableDef, contentWidthMm);
  const visCols = getVisibleColumns(tableDef, contentWidthMm, colGap);
  if (visCols.length === 0) return startY;

  const borders = tableDef.borderStyle ?? "none";
  const totalW = visCols.reduce((s, c) => s + c.widthMm + colGap, -colGap);
  const tableLeft = REPORT_MARGIN_MM - 1;
  const tableWidth = totalW + 2; // 1mm padding on each side
  const tableRight = tableLeft + tableWidth;

  // Track the top of the table section on the current page (for outer border)
  let sectionTopY = 0;

  const setupBorderStyle = () => {
    doc.setDrawColor(200, 200, 200); // #ccc
    doc.setLineWidth(0.2);
  };

  // Draw a horizontal line across the full table width
  const hLine = (atY: number) => {
    setupBorderStyle();
    doc.line(tableLeft, atY, tableRight, atY);
  };

  // Draw vertical column dividers between two Y positions
  const vColLines = (fromY: number, toY: number) => {
    setupBorderStyle();
    let x = tableLeft;
    for (let ci = 0; ci < visCols.length - 1; ci++) {
      x += visCols[ci].widthMm + colGap;
      doc.line(x - colGap / 2, fromY, x - colGap / 2, toY);
    }
  };

  // Draw left and right vertical edges between two Y positions
  const vEdges = (fromY: number, toY: number) => {
    setupBorderStyle();
    doc.line(tableLeft, fromY, tableLeft, toY);
    doc.line(tableRight, fromY, tableRight, toY);
  };

  // Close borders at the bottom of a page section before a page break
  const closeBordersAtY = (atY: number) => {
    if (borders === "outer") {
      vEdges(sectionTopY, atY);
      hLine(atY);
    } else if (borders === "grid") {
      vEdges(sectionTopY, atY);
      vColLines(sectionTopY, atY);
      hLine(atY);
    }
  };

  let y = startY;

  const drawSectionTitle = (label: string) => {
    doc.setFontSize(11);
    doc.setFont("Inter", "bold");
    doc.setTextColor(0);
    doc.text(fitText(doc, label, contentWidthMm), REPORT_MARGIN_MM, y);
    y += HEADER_HEIGHT;
    doc.setFont("Inter", "normal");
  };

  drawSectionTitle(tableDef.label);

  const drawHeaders = () => {
    const headerTop = y - HEADER_HEIGHT + 2;
    sectionTopY = headerTop;

    doc.setFontSize(HEADER_FONT_SIZE);
    doc.setFont("Inter", "bold");
    doc.setFillColor(240, 240, 240);
    doc.rect(tableLeft, headerTop, tableWidth, HEADER_HEIGHT, "F");
    doc.setTextColor(0);
    let x = REPORT_MARGIN_MM;
    for (const col of visCols) {
      doc.text(fitText(doc, col.header, col.widthMm), x, y);
      x += col.widthMm + colGap;
    }
    doc.setFont("Inter", "normal");
    doc.setFontSize(FONT_SIZE);
    y += 2;

    // Border under header
    if (borders !== "none") {
      hLine(y);
    }
    // Top border of table
    if (borders === "outer" || borders === "grid") {
      hLine(headerTop);
    }
  };

  const repeatOnNewPage = () => {
    // Close borders on the current page before breaking
    closeBordersAtY(y);
    doc.addPage();
    y = REPORT_MARGIN_MM;
    drawSectionTitle(`${tableDef.label} (Cont'd)`);
    drawHeaders();
  };

  const drawRow = (row: Record<string, string>, rowIndex: number) => {
    y += ROW_HEIGHT;
    if (y > bottomLimit) {
      repeatOnNewPage();
      y += ROW_HEIGHT;
    }

    const rowTop = y - ROW_HEIGHT + 2;

    if (rowIndex % 2 === 1) {
      doc.setFillColor(248, 248, 248);
      doc.rect(tableLeft, rowTop, tableWidth, ROW_HEIGHT, "F");
    }

    const isSubItem = row._isSubItem === "true";
    doc.setTextColor(isSubItem ? 120 : 0);
    let x = REPORT_MARGIN_MM;
    for (const col of visCols) {
      const text = row[col.key] ?? "";
      const indent = isSubItem && col.key !== "count" ? 4 : 0;
      doc.text(fitText(doc, text, col.widthMm - indent), x + indent, y);
      x += col.widthMm + colGap;
    }

    // Horizontal line under this row
    if (borders === "horizontal" || borders === "grid") {
      hLine(rowTop + ROW_HEIGHT);
    }
  };

  const drawGroupHeader = (label: string) => {
    y += ROW_HEIGHT + 2;
    if (y > bottomLimit) {
      repeatOnNewPage();
      y += ROW_HEIGHT + 2;
    }
    const ghTop = y - ROW_HEIGHT + 2;
    doc.setFontSize(FONT_SIZE);
    doc.setFont("Inter", "bold");
    doc.setFillColor(230, 235, 245);
    doc.rect(tableLeft, ghTop - 2, tableWidth, ROW_HEIGHT, "F");
    doc.setTextColor(0);
    doc.text(fitText(doc, label, contentWidthMm), REPORT_MARGIN_MM, y);
    doc.setFont("Inter", "normal");

    // Border under group header
    if (borders === "horizontal" || borders === "grid") {
      hLine(ghTop + ROW_HEIGHT - 2);
    }
  };

  if (tableData.groupedRows && tableDef.groupBy) {
    drawHeaders();
    for (const [groupLabel, rows] of tableData.groupedRows) {
      drawGroupHeader(groupLabel);
      rows.forEach((row, i) => drawRow(row, i));
    }
  } else {
    drawHeaders();
    tableData.rows.forEach((row, i) => drawRow(row, i));
  }

  // Final borders at the end of the table
  const finalY = y + 2; // bottom of last row area
  if (borders === "outer") {
    vEdges(sectionTopY, finalY);
    hLine(finalY);
  } else if (borders === "grid") {
    vEdges(sectionTopY, finalY);
    vColLines(sectionTopY, finalY);
    // Bottom line already drawn by last row's horizontal line
  }

  return y + ROW_HEIGHT;
}

// ─── Main Export ───

export async function renderReportPdf(
  layout: ReportLayout,
  titleBlock: TitleBlock,
  tableData: ReportTableData[],
  filename: string,
): Promise<void> {
  const { widthMm, heightMm } = getPageDimensions(layout.paperSize, layout.orientation);
  const doc = new jsPDF({
    orientation: layout.orientation,
    unit: "mm",
    format: layout.paperSize,
  });

  // Load Inter font into jsPDF
  await loadInterFont(doc);

  // Footer reserve: content must stop before the footer
  const bottomLimit = heightMm - REPORT_MARGIN_MM - layout.footerHeightMm - 2;

  // Header
  drawGridBlock(doc, layout, titleBlock, "header", widthMm, 1, 1);

  let y = REPORT_MARGIN_MM + layout.headerHeightMm + 4;

  // Tables
  for (const td of tableData) {
    const tableDef = layout.tables.find((t) => t.id === td.id);
    if (!tableDef) continue;

    if (y > bottomLimit - 20) {
      doc.addPage();
      y = REPORT_MARGIN_MM + 6;
    }

    y = drawTableSection(doc, tableDef, td, y, bottomLimit, widthMm - 2 * REPORT_MARGIN_MM);
    y += 6;
  }

  // Draw footer on every page, and update page numbers
  const totalPages = doc.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);
    drawGridBlock(doc, layout, titleBlock, "footer", widthMm, p, totalPages);
  }

  doc.save(filename);
}

