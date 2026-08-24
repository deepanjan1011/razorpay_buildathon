/**
 * Workbook -> raw rows. PHASE-1.md §3, the first two pipeline stages.
 *
 * This layer finds structure and preserves values. It never interprets one: no
 * category is decided here, no title is decomposed, no price is chosen from a
 * range. Where the sheet is unreadable, the row is skipped WITH A REASON so the
 * merchant can see it in review — the one thing this layer must never do is
 * drop a product silently.
 */
import ExcelJS from "exceljs";

export type SkipReason = "preamble" | "blank" | "junk";

export type RawRow = {
  sheet: string;
  /** 1-based sheet row. Provenance: PHASE-1.md §1 `source_row`. */
  row: number;
  /** header -> raw trimmed value. Columns past the header get `col_N`. */
  cells: Record<string, string>;
  /** Positional raw values, so nothing in the row is lost to header mapping. */
  values: string[];
  /**
   * For values inherited from a merged cell, the row the value actually came
   * from. Absent for values read from the row's own cell.
   */
  inherited: Record<string, number>;
};

export type ParsedSheet = {
  name: string;
  /** null when no header row could be found. Never invented. */
  headerRow: number | null;
  headers: string[];
  /** 0-1: how many headers are recognisable field names. 0 when absent. */
  headerScore: number;
  rows: RawRow[];
  skipped: Array<{ row: number; reason: SkipReason }>;
};

/** Field names seen on real small-merchant sheets. Only scores confidence. */
const KNOWN_HEADERS = new Set([
  "item", "item name", "itemname", "product", "product name", "name", "title",
  "description", "particulars", "goods",
  "category", "type", "group", "section",
  "price", "rate", "mrp", "amount", "cost", "sale price", "selling price",
  "offer price", "net", "value",
  "stock", "qty", "quantity", "available", "availability", "in stock", "pcs",
  "size", "colour", "color", "shade", "variant",
  "code", "sku", "item code", "brand", "unit", "hsn",
]);

/** A junk row announces itself in its first cell. Checked there only, so a */
/** product legitimately priced "Call for price" is not mistaken for a note.  */
const JUNK_TOTAL = /^(?:grand\s+)?(?:sub\s*)?total\b/i;
const JUNK_TEXT =
  /^\*+|^-{3,}|^note\b|^n\.?b\.?\b|\bcontact\b|^call\b|\bgst\b|subject\s+to\s+change|^terms\b|^conditions\b|\bwhatsapp\b|^address\b/i;
const JUNK_PHONE = /(?:\+?91[-\s]?)?\b\d{5}\s?\d{5}\b|\b\d{10}\b/;

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    // Rich text, hyperlinks and formula results all wrap the value we want.
    if ("richText" in value && Array.isArray(value.richText)) {
      return value.richText.map((r) => r.text).join("").trim();
    }
    if ("text" in value && typeof value.text === "string") return value.text.trim();
    if ("result" in value) return cellText(value.result as ExcelJS.CellValue);
    if ("error" in value) return "";
  }
  return String(value).trim();
}

type Grid = {
  /** [row][col], both 1-based; index 0 unused. */
  text: string[][];
  masterRow: number[][];
  width: number;
  height: number;
};

function readGrid(ws: ExcelJS.Worksheet): Grid {
  const height = ws.rowCount;
  const width = ws.columnCount;
  const text: string[][] = [[]];
  const masterRow: number[][] = [[]];

  for (let r = 1; r <= height; r++) {
    const t: string[] = [""];
    const m: number[] = [0];
    for (let c = 1; c <= width; c++) {
      const cell = ws.getCell(r, c);
      t.push(cellText(cell.value));
      // exceljs already reflects the master's value on merged slave cells; we
      // only need to record where it came from.
      m.push(cell.isMerged && cell.master ? Number(cell.master.row) : r);
    }
    text.push(t);
    masterRow.push(m);
  }

  return { text, masterRow, width, height };
}

const rowCells = (grid: Grid, r: number): string[] =>
  (grid.text[r] ?? []).slice(1, grid.width + 1);

const nonEmptyCount = (grid: Grid, r: number): number =>
  rowCells(grid, r).filter((v) => v !== "").length;

/**
 * Digits in the TEXT, not the cell's type.
 *
 * This used to be `typeof cell.value === "number"`, which is wrong on its own
 * terms: a merchant formatting a price column as text is completely ordinary,
 * and `₹ 57/Pack` is as numeric a price as `57` is. On a sheet where every
 * cell is text — no numeric cell anywhere — the header test below could never
 * pass, so the header row was read as data and every column came back as
 * `col_N`. Found by the first real merchant sheet; every `messy-*` fixture
 * carries typed numeric prices and so none of them could express it.
 */
const hasDigits = (grid: Grid, r: number): boolean =>
  rowCells(grid, r).some((v) => /\d/.test(v));

function trimTrailingEmpty(values: string[]): string[] {
  let end = values.length;
  while (end > 0 && values[end - 1] === "") end--;
  return values.slice(0, end);
}

/**
 * A header row carries no digits, has at least two filled cells, and is followed
 * by a row that does carry digits.
 *
 * That structural test is what lets a Tamil header row be recognised without a
 * dictionary of Tamil field names — the alternative, scoring against known
 * English names, silently fails on every non-English sheet. Recognised names
 * still matter, so they are reported as `headerScore` for the review queue
 * rather than used as the gate.
 */
function detectHeader(grid: Grid): number | null {
  const limit = Math.min(grid.height, 15);

  for (let r = 1; r <= limit; r++) {
    if (nonEmptyCount(grid, r) < 2) continue;
    if (hasDigits(grid, r)) continue;

    let next = r + 1;
    while (next <= grid.height && nonEmptyCount(grid, next) === 0) next++;
    if (next > grid.height) continue;
    if (!hasDigits(grid, next)) continue;

    return r;
  }
  return null;
}

function scoreHeaders(headers: string[]): number {
  const filled = headers.filter((h) => h !== "");
  if (filled.length === 0) return 0;
  const known = filled.filter((h) => KNOWN_HEADERS.has(h.toLowerCase())).length;
  return known / filled.length;
}

function classify(grid: Grid, r: number): SkipReason | null {
  if (nonEmptyCount(grid, r) === 0) return "blank";
  const first = rowCells(grid, r).find((v) => v !== "") ?? "";
  if (JUNK_TOTAL.test(first) || JUNK_TEXT.test(first) || JUNK_PHONE.test(first)) {
    return "junk";
  }
  return null;
}

function parseSheet(ws: ExcelJS.Worksheet): ParsedSheet {
  const grid = readGrid(ws);
  const headerRow = detectHeader(grid);
  const skipped: Array<{ row: number; reason: SkipReason }> = [];

  let headers: string[];
  let headerScore: number;

  if (headerRow === null) {
    // No header. Synthesise obviously-positional names so nothing downstream
    // can mistake them for something the merchant wrote.
    let width = 0;
    for (let r = 1; r <= grid.height; r++) {
      width = Math.max(width, trimTrailingEmpty(rowCells(grid, r)).length);
    }
    headers = Array.from({ length: width }, (_, i) => `col_${i + 1}`);
    headerScore = 0;
  } else {
    headers = trimTrailingEmpty(rowCells(grid, headerRow));
    headerScore = scoreHeaders(headers);
    for (let r = 1; r < headerRow; r++) skipped.push({ row: r, reason: "preamble" });
  }

  const rows: RawRow[] = [];
  const firstDataRow = headerRow === null ? 1 : headerRow + 1;

  for (let r = firstDataRow; r <= grid.height; r++) {
    const reason = classify(grid, r);
    if (reason !== null) {
      skipped.push({ row: r, reason });
      continue;
    }

    const values = trimTrailingEmpty(rowCells(grid, r));
    const cells: Record<string, string> = {};
    const inherited: Record<string, number> = {};

    for (let c = 0; c < Math.max(values.length, headers.length); c++) {
      const header = headers[c];
      const key = header === undefined || header === "" ? `col_${c + 1}` : header;
      const value = values[c] ?? "";
      if (value === "") continue;
      cells[key] = value;

      const master = grid.masterRow[r]?.[c + 1] ?? r;
      if (master !== r) inherited[key] = master;
    }

    rows.push({ sheet: ws.name, row: r, cells, values, inherited });
  }

  return { name: ws.name, headerRow, headers, headerScore, rows, skipped };
}

export async function parseWorkbook(path: string): Promise<ParsedSheet[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  return parseSheets(wb);
}

/** Split out so an upload can be parsed from bytes without touching disk. */
export function parseSheets(wb: ExcelJS.Workbook): ParsedSheet[] {
  return wb.worksheets.map(parseSheet);
}

// ---------------------------------------------------------------------------

/**
 * Case, padding and inner-whitespace insensitive. Deliberately nothing more —
 * stripping punctuation or stemming would collide genuinely different products,
 * and a false merge is worse than a missed one: it hides a product the merchant
 * meant to sell.
 */
export function dedupeKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export type DupGroup = {
  key: string;
  rows: RawRow[];
  /** Fields on which the duplicates disagree. Empty means a clean duplicate. */
  conflicting: string[];
};

export function findDuplicates(rows: RawRow[], keyField: string): DupGroup[] {
  const groups = new Map<string, RawRow[]>();

  for (const row of rows) {
    const value = row.cells[keyField];
    if (value === undefined || value === "") continue;
    const key = dedupeKey(value);
    const existing = groups.get(key);
    if (existing) existing.push(row);
    else groups.set(key, [row]);
  }

  const out: DupGroup[] = [];
  for (const [key, members] of groups) {
    if (members.length < 2) continue;

    const fields = new Set<string>();
    for (const row of members) {
      for (const field of Object.keys(row.cells)) {
        if (field !== keyField) fields.add(field);
      }
    }

    const conflicting: string[] = [];
    for (const field of fields) {
      const seen = new Set(
        members.map((r) => r.cells[field]).filter((v) => v !== undefined && v !== ""),
      );
      // A conflict is two different stated values, not one row leaving it blank.
      if (seen.size > 1) conflicting.push(field);
    }

    out.push({ key, rows: members, conflicting });
  }

  return out;
}
