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
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    /**
     * `strictRequired` off — and this is NOT laxity.
     *
     * It is an ajv lint, not a JSON Schema rule, and it rejects a legitimate
     * and common idiom the published ACP checkout schema uses:
     *
     *   PaymentData.anyOf: [ {required: ["handler_id","instrument"]},
     *                        {required: ["purchase_order_number"]} ]
     *
     * A branch that lists `required` without re-declaring `properties` is valid
     * — it means "this key must be present", with the shape defined on the
     * parent. ajv's lint assumes every `required` sits beside its own
     * `properties`, which is simply a different style.
     *
     * Turning this off makes the validator accept the SCHEMA. Everything about
     * how strictly it validates DATA is unchanged; `strict: true` still catches
     * unknown keywords and typos, which is what it is there for.
     */
    strictRequired: false,
  });
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
