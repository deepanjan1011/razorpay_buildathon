/**
 * Generates the synthetic messy spreadsheets for the PHASE-1.md §4 mess cases.
 *
 * The .xlsx files are committed, but this generator is the reviewable source of
 * truth for what is in them — a binary fixture nobody can read is a fixture
 * nobody can check. `npm run fixtures` regenerates.
 *
 * Content is synthetic and labelled synthetic (DESIGN.md §9). Names, prices and
 * the phone number are invented; they are shaped like a real south-Indian
 * small-merchant price list, but no real merchant's data is here.
 */
import ExcelJS from "exceljs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const DIR = dirname(fileURLToPath(import.meta.url));

type Cell = string | number | null;
type SheetSpec = {
  name: string;
  rows: Cell[][];
  /** Merge ranges in A1 notation, e.g. "A2:A13". */
  merges?: string[];
};

async function write(file: string, sheets: SheetSpec[]): Promise<void> {
  const wb = new ExcelJS.Workbook();
  for (const spec of sheets) {
    const ws = wb.addWorksheet(spec.name);
    for (const row of spec.rows) {
      ws.addRow(row.map((c) => (c === null ? undefined : c)));
    }
    for (const range of spec.merges ?? []) ws.mergeCells(range);
  }
  const path = join(DIR, file);
  await wb.xlsx.writeFile(path);
  console.log("wrote", file);
}

// ---------------------------------------------------------------------------
// §4 case 1 — title rows, blank rows and notes above the real header
// ---------------------------------------------------------------------------
const case01: SheetSpec[] = [
  {
    name: "Price List",
    rows: [
      ["SRI LAKSHMI FOOTWEAR", null, null, null],
      [null, null, null, null],
      ["Price list updated 12/08/2026", null, null, null],
      ["Contact: 98765 43210", null, null, null],
      [null, null, null, null],
      ["Item Name", "Category", "Price", "Stock"],
      ["Canvas Shoe White", "Footwear", 899, "yes"],
      ["Canvas Shoe Black", "Footwear", 899, "yes"],
      ["Leather Sandal Brown", "Footwear", 1450, "no"],
      ["Kolhapuri Chappal", "Footwear", 650, "yes"],
    ],
  },
];

// ---------------------------------------------------------------------------
// §4 case 2 — header on row 3, spanning two rows, or absent entirely
// ---------------------------------------------------------------------------
const case02: SheetSpec[] = [
  {
    name: "header-row-3",
    rows: [
      ["Stock Register 2026", null, null, null],
      [null, null, null, null],
      ["Product", "Type", "Rate", "Qty"],
      ["Cotton Kurta Blue", "Apparel", 1250, 14],
      ["Cotton Kurta Green", "Apparel", 1250, 6],
      ["Silk Dupatta", "Apparel", 2100, 3],
    ],
  },
  {
    // Row 1 spans two columns per group; row 2 carries the real field names.
    name: "two-row-header",
    rows: [
      ["Product Details", null, "Pricing", null, "Stock"],
      ["Name", "Code", "MRP", "Sale Price", "Available"],
      ["Running Shoe Grey", "RS-GRY", 3499, 2799, "yes"],
      ["Running Shoe Navy", "RS-NVY", 3499, 2799, "yes"],
      ["Trekking Boot", "TB-BRN", 5200, 4680, "no"],
    ],
    merges: ["A1:B1", "C1:D1"],
  },
  {
    name: "no-header",
    rows: [
      ["Steel Tiffin Box 3 Tier", "Kitchen", 540, "yes"],
      ["Steel Tumbler Set of 6", "Kitchen", 380, "yes"],
      ["Copper Water Bottle", "Kitchen", 720, "no"],
    ],
  },
];

// ---------------------------------------------------------------------------
// §4 case 3 — merged cells: one category cell covering twelve product rows
// ---------------------------------------------------------------------------
const case03: SheetSpec[] = [
  {
    name: "Catalog",
    rows: [
      ["Category", "Item", "Price"],
      ["Footwear", "Canvas Shoe White", 899],
      [null, "Canvas Shoe Black", 899],
      [null, "Leather Sandal Brown", 1450],
      [null, "Kolhapuri Chappal", 650],
      [null, "Running Shoe Grey", 2799],
      [null, "Running Shoe Navy", 2799],
      [null, "Trekking Boot Brown", 4680],
      [null, "Rubber Slipper", 199],
      [null, "Formal Oxford Black", 3200],
      [null, "Formal Derby Tan", 3400],
      [null, "School Shoe Black", 749],
      [null, "Sports Sandal", 1100],
      ["Accessories", "Leather Belt Black", 550],
      [null, "Shoe Polish Kit", 180],
    ],
    // One category cell covering twelve product rows (rows 2..13).
    merges: ["A2:A13", "A14:A15"],
  },
];

// ---------------------------------------------------------------------------
// §4 case 4 — price formats
// ---------------------------------------------------------------------------
const case04: SheetSpec[] = [
  {
    name: "Rates",
    rows: [
      ["Item", "Price"],
      ["Plain number", 2799],
      ["Thousands separator", "2,799"],
      ["Rupee symbol", "₹2799"],
      ["Rupee symbol spaced", "₹ 2,799"],
      ["Rs prefix", "Rs. 1,299/-"],
      ["Trailing dash", "2799/-"],
      ["Thousand shorthand", "2.8k"],
      ["Thousand shorthand caps", "1.5K"],
      ["Sale with MRP", "2799 (MRP 3499)"],
      ["Decimal paise", "899.50"],
      ["Range", "500-700"],
      ["Words", "Call for price"],
      ["Empty", null],
    ],
  },
];

// ---------------------------------------------------------------------------
// §4 case 5 — size and colour embedded in the title
// ---------------------------------------------------------------------------
const case05: SheetSpec[] = [
  {
    name: "Shoes",
    rows: [
      ["Item", "Price", "Stock"],
      ["Blk RunShoe M-9", 2799, "yes"],
      ["Blk RunShoe M-10", 2799, "yes"],
      ["Wht RunShoe M-9", 2799, "no"],
      ["Rd Snkr W-7", 2450, "yes"],
      ["Brn LthrSandal M-8", 1450, "yes"],
    ],
  },
];

// ---------------------------------------------------------------------------
// §4 case 6 — one row describing several variants
// ---------------------------------------------------------------------------
const case06: SheetSpec[] = [
  {
    name: "Apparel",
    rows: [
      ["Item", "Size", "Colour", "Price", "Stock"],
      ["Cotton Kurta", "S/M/L", "Blue", 1250, "yes"],
      ["Cotton Shirt", "M/L/XL", "Red, Blue, Black", 950, "yes"],
      ["Silk Saree", null, "Green, Maroon", 4500, "yes"],
      ["Linen Trouser", "30 / 32 / 34", "Beige", 1800, "no"],
      ["Plain Tee", "Free Size", "White", 399, "yes"],
      // Grocery sellers size by measure. `1/2 kg` is ONE size, not two — the
      // slash is a fraction. Splitting it invents two products that do not
      // exist and are individually purchasable.
      ["Ghee Tin", "1/2 kg", "Plain", 450, "yes"],
      ["Rice Bag", "5 kg / 10 kg", "Sona Masoori", 320, "yes"],
      ["Sleeve Style Shirt", "Half Sleeve / Full Sleeve", "White", 890, "yes"],
    ],
  },
];

// ---------------------------------------------------------------------------
// §4 case 7 — mixed Tamil/English and transliterated Tamil in Latin script
// ---------------------------------------------------------------------------
const case07: SheetSpec[] = [
  {
    name: "பொருட்கள்",
    rows: [
      ["பொருள்", "விலை", "Stock"],
      ["பருத்தி சேலை", 2400, "yes"],
      ["பட்டு சேலை", 6500, "no"],
      ["Paruthi Sattai (Cotton Shirt)", 950, "yes"],
      ["Vetti - Cotton", 780, "yes"],
      ["Cotton Towel / துண்டு", 220, "yes"],
    ],
  },
];

// ---------------------------------------------------------------------------
// §4 case 8 — trailing junk rows: totals, notes, contact numbers
// ---------------------------------------------------------------------------
const case08: SheetSpec[] = [
  {
    name: "Sheet1",
    rows: [
      ["Item", "Price", "Qty"],
      ["Steel Tiffin Box", 540, 12],
      ["Steel Tumbler Set", 380, 30],
      ["Copper Bottle", 720, 8],
      [null, null, null],
      ["TOTAL", 1640, 50],
      ["Note: prices exclusive of GST", null, null],
      ["Call 98765 43210 for bulk orders", null, null],
      ["** subject to change **", null, null],
    ],
  },
];

// ---------------------------------------------------------------------------
// §4 case 9 — duplicate products across sheets
// ---------------------------------------------------------------------------
const case09: SheetSpec[] = [
  {
    name: "Main Stock",
    rows: [
      ["Item", "Category", "Price"],
      ["Canvas Shoe White", "Footwear", 899],
      ["Leather Belt Black", "Accessories", 550],
      ["Kolhapuri Chappal", "Footwear", 650],
    ],
  },
  {
    name: "Godown",
    rows: [
      ["Item", "Category", "Price"],
      // Exact duplicate of a Main Stock row.
      ["Canvas Shoe White", "Footwear", 899],
      // Same product, different price — a conflict, not a clean duplicate.
      ["Kolhapuri Chappal", "Footwear", 675],
      // Same product, whitespace and casing differ.
      ["  canvas shoe white ", "Footwear", 899],
      ["Rubber Slipper", "Footwear", 199],
    ],
  },
];

// ---------------------------------------------------------------------------
// §4 case 10 — stock as yes/no/✓/blank/10 pcs
// ---------------------------------------------------------------------------
const case10: SheetSpec[] = [
  {
    name: "Stock",
    rows: [
      ["Item", "Price", "Stock"],
      ["Yes word", 100, "yes"],
      ["No word", 100, "no"],
      ["Tick mark", 100, "✓"],
      ["Cross mark", 100, "✗"],
      ["Y letter", 100, "Y"],
      ["N letter", 100, "N"],
      ["Blank", 100, null],
      ["Count with unit", 100, "10 pcs"],
      ["Zero count", 100, 0],
      ["Plain count", 100, 24],
      ["In stock phrase", 100, "In Stock"],
      ["Out of stock phrase", 100, "Out of stock"],
      ["Dash", 100, "-"],
      ["Available", 100, "available"],
      ["Sold out", 100, "SOLD OUT"],
    ],
  },
];

const FIXTURES: Array<[string, SheetSpec[]]> = [
  ["messy-01-preamble.xlsx", case01],
  ["messy-02-headers.xlsx", case02],
  ["messy-03-merged-category.xlsx", case03],
  ["messy-04-prices.xlsx", case04],
  ["messy-05-title-attributes.xlsx", case05],
  ["messy-06-variants-in-row.xlsx", case06],
  ["messy-07-multilingual.xlsx", case07],
  ["messy-08-trailing-junk.xlsx", case08],
  ["messy-09-duplicates.xlsx", case09],
  ["messy-10-stock.xlsx", case10],
];

for (const [file, sheets] of FIXTURES) await write(file, sheets);
