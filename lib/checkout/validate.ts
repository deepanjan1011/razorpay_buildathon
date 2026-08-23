/**
 * Validates checkout payloads against the pinned ACP checkout schema.
 *
 * A SEPARATE ajv instance and a separate schema document from the feed
 * validator. They share the factory in lib/schema/ajv.ts and nothing else —
 * sharing a validator must not become sharing a schema, and these two describe
 * genuinely different things.
 *
 * The schema is imported rather than read from disk: `import.meta.dirname` is
 * undefined inside a Next route bundle, which broke the feed validator's build
 * after 184 green tests. See OBSTACLES.md.
 */
import { createAjv, formatErrors } from "../schema/ajv.ts";
import type { ValidationError } from "../schema/ajv.ts";
import schemaBundle from "../../spec/acp/2026-04-17/schema.agentic_checkout.json" with { type: "json" };

export const ACP_API_VERSION = "2026-04-17";

const bundle = schemaBundle as unknown as { $id: string };

const ajv = createAjv();
// `example` is an OpenAPI annotation, not a JSON Schema keyword.
ajv.addKeyword({ keyword: "example" });
ajv.addSchema(bundle);

const validators = {
  CheckoutSession: ajv.compile({ $ref: `${bundle.$id}#/$defs/CheckoutSession` }),
  CheckoutSessionCreateRequest: ajv.compile({
    $ref: `${bundle.$id}#/$defs/CheckoutSessionCreateRequest`,
  }),
  CheckoutSessionUpdateRequest: ajv.compile({
    $ref: `${bundle.$id}#/$defs/CheckoutSessionUpdateRequest`,
  }),
  CheckoutSessionCompleteRequest: ajv.compile({
    $ref: `${bundle.$id}#/$defs/CheckoutSessionCompleteRequest`,
  }),
  // `complete` returns the session WITH an order, which is a different
  // definition and a wider required set — not CheckoutSession with a field
  // added. Validating it as CheckoutSession would pass while omitting `order`.
  CheckoutSessionWithOrder: ajv.compile({
    $ref: `${bundle.$id}#/$defs/CheckoutSessionWithOrder`,
  }),
  Error: ajv.compile({ $ref: `${bundle.$id}#/$defs/Error` }),
} as const;

export type Definition = keyof typeof validators;

export function validate(definition: Definition, value: unknown): ValidationError[] {
  const check = validators[definition];
  return check(value) ? [] : formatErrors(check.errors);
}

export function assertValid(definition: Definition, value: unknown): void {
  const errors = validate(definition, value);
  if (errors.length === 0) return;
  throw new Error(
    `${definition} failed ACP ${ACP_API_VERSION} validation:\n` +
      errors.map((e) => `  ${e.path}: ${e.message}`).join("\n"),
  );
}
