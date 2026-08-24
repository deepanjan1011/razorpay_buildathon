/**
 * Maps sheet headers to the roles the deterministic layer needs.
 *
 * Only the roles whose values are parsed WITHOUT the model live here: price,
 * list price and stock. Title and category are semantic and are read from the
 * model's output instead, so they are deliberately absent.
 *
 * Each role's synonyms are ordered by preference, not alphabetically: a sheet
 * with both `MRP` and `Sale Price` must price at the sale price, so `sale price`
 * is ahead of `mrp`. Matching is exact on the lowercased header, never a
 * substring — `price` as a substring would match `MRP` and quietly pick the
 * wrong column.
 */
export type FieldRole = "price" | "list_price" | "stock" | "pack_size";

const SYNONYMS: Record<FieldRole, string[]> = {
  price: [
    "sale price",
    "selling price",
    "offer price",
    "our price",
    "price",
    "rate",
    "amount",
    "cost",
    "net",
    "விலை",
  ],
  list_price: ["mrp", "m.r.p", "m.r.p.", "list price", "retail price", "compare at"],
  // Narrow on purpose. A bare "size" is an apparel size, not a pack quantity,
  // and reading one as the other would compare a shoe size against a kilo.
  pack_size: [
    "pack size",
    "packaging size",
    "net quantity",
    "net weight",
    "pack weight",
    "weight",
    "packing",
  ],
  stock: [
    "stock",
    "in stock",
    "availability",
    "available",
    "qty",
    "quantity",
    "pcs",
    "balance",
  ],
};

export function findField(headers: string[], role: FieldRole): string | null {
  const lowered = headers.map((h) => h.toLowerCase().trim());
  for (const synonym of SYNONYMS[role]) {
    const index = lowered.indexOf(synonym);
    if (index !== -1) return headers[index] ?? null;
  }
  return null;
}

/**
 * The headers a row's semantic reading should be based on — everything except
 * the columns the deterministic layer has already consumed.
 *
 * Keeping price and stock out of what the model sees is what makes CLAUDE.md
 * invariant 1 structural: the model cannot influence an amount it is never
 * shown. It is cheap to do here and impossible to forget later.
 */
export function semanticCells(
  cells: Record<string, string>,
  headers: string[],
): Record<string, string> {
  const consumed = new Set(
    (["price", "list_price", "stock"] as FieldRole[])
      .map((role) => findField(headers, role))
      .filter((h): h is string => h !== null),
  );

  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(cells)) {
    if (!consumed.has(key)) out[key] = value;
  }
  return out;
}
