/**
 * A shared Ajv factory — NOT a shared schema registry.
 *
 * Two different schemas run through this: the LLM extraction schema
 * (lib/normalize/llm-schema.ts, which describes our internal superset) and the
 * ACP feed schema (spec/acp/, which describes what agents consume). They are
 * deliberately separate documents compiled into separate instances. Sharing a
 * validator must not become sharing a schema — the projection between the two
 * is a real layer (lib/feed/project.ts) and stays explicit.
 */
import _Ajv2020 from "ajv/dist/2020.js";
import _addFormats from "ajv-formats";

// ajv ships CommonJS with `export =`. Node's interop resolves the callable at
// runtime, but TypeScript sees the namespace under nodenext + verbatim module
// syntax. This is ajv's own documented ESM workaround.
const Ajv2020 = _Ajv2020 as unknown as typeof _Ajv2020.default;
const addFormats = _addFormats as unknown as typeof _addFormats.default;

export function createAjv(): InstanceType<typeof Ajv2020> {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv;
}

export type ValidationError = { path: string; message: string };

export function formatErrors(
  errors: readonly { instancePath: string; message?: string }[] | null | undefined,
): ValidationError[] {
  return (errors ?? []).map((e) => ({
    path: e.instancePath === "" ? "/" : e.instancePath,
    message: e.message ?? "invalid",
  }));
}
