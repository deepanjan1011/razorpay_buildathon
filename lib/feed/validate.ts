/**
 * Validates feed payloads against the vendored ACP JSON Schema.
 *
 * DESIGN.md §2: validating against the repo's published schemas doubles as the
 * conformance suite. The schema is vendored at spec/acp/2026-04-17/ and pinned
 * — it is never fetched at runtime, so a change upstream cannot silently change
 * what "conformant" means here.
 *
 * KNOWN HOLE, do not paper over: `UpsertProductsResponse` is referenced by
 * openapi.feed.yaml at 2026-04-17 but absent from schema.feed.json at the same
 * version. Nothing here asserts that shape, because the pinned schema does not
 * define it. See OBSTACLES.md.
 */
import _Ajv2020 from "ajv/dist/2020.js";
import _addFormats from "ajv-formats";

import { ACP_API_VERSION } from "./acp.ts";

/**
 * The pinned schema is IMPORTED, not read from disk.
 *
 * It was `readFileSync(join(import.meta.dirname, …))`, which works under Node
 * and breaks the moment a bundler touches it: `import.meta.dirname` is
 * undefined inside a Next route bundle, and the build failed with "path must be
 * of type string". Nothing in the test suite could have caught that — the
 * validator is exercised constantly, but only ever under plain Node.
 *
 * An import is also a stronger pin. The schema is part of the module graph
 * rather than a file that has to still exist, at the right relative path, at
 * runtime.
 */
import schemaBundle from "../../spec/acp/2026-04-17/schema.feed.json" with { type: "json" };

// ajv ships CommonJS with `export =`. Node's interop resolves the callable at
// runtime, but TypeScript sees the namespace under nodenext + verbatim module
// syntax. This is ajv's own documented ESM workaround.
const Ajv2020 = _Ajv2020 as unknown as typeof _Ajv2020.default;
const addFormats = _addFormats as unknown as typeof _addFormats.default;

const bundle = schemaBundle as unknown as { $id: string };

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
// `example` is an OpenAPI annotation, not a JSON Schema keyword. Declaring it
// as a no-op keeps strict mode on for everything that does matter.
ajv.addKeyword({ keyword: "example" });
ajv.addSchema(bundle);

export type ValidationError = { path: string; message: string };

function validator(definition: string) {
  return ajv.compile({ $ref: `${bundle.$id}#/$defs/${definition}` });
}

const validators = {
  Product: validator("Product"),
  Variant: validator("Variant"),
  FeedMetadata: validator("FeedMetadata"),
  ProductsResponse: validator("ProductsResponse"),
} as const;

export type Definition = keyof typeof validators;

export function validate(definition: Definition, value: unknown): ValidationError[] {
  const check = validators[definition];
  if (check(value)) return [];
  return (check.errors ?? []).map((e) => ({
    path: e.instancePath === "" ? "/" : e.instancePath,
    message: `${e.message ?? "invalid"}${
      e.keyword === "additionalProperties"
        ? ` (${JSON.stringify(e.params)})`
        : ""
    }`,
  }));
}

/** Throws with every error at once, so one run reports the whole problem. */
export function assertValid(definition: Definition, value: unknown): void {
  const errors = validate(definition, value);
  if (errors.length === 0) return;
  throw new Error(
    `${definition} failed ACP ${ACP_API_VERSION} validation:\n` +
      errors.map((e) => `  ${e.path}: ${e.message}`).join("\n"),
  );
}
