/**
 * ACP checkout sessions. DESIGN.md §2, no payment in this file.
 *
 * THE ONE RULE: the cart is RECOMPUTED FROM THE LIVE CATALOGUE on every read
 * and every mutation. Nothing priced is ever cached and replayed.
 *
 * `rfc.product_feeds.md` §3.3 makes the checkout response authoritative over
 * feed data, and §7 forbids agents treating feed price or availability as
 * guaranteed. That is only true if we actually re-read. Storing a priced cart
 * and returning it later would make our response a second stale snapshot
 * wearing the word "authoritative" — and in Phase 3 the mandate ceiling is
 * checked against this total, so a stale number there is a wrong charge.
 *
 * The stored `snapshot` is a record of what we last told the agent, for
 * retrieval and audit. It is never the source of a price.
 */
import { createHash, randomUUID } from "node:crypto";

import type { Sql } from "../db/sql.ts";
import { record } from "../audit/log.ts";
import { lookupVariants } from "../catalog/store.ts";
import type { CatalogVariant } from "../catalog/store.ts";
import { computeTotals, lineTotals, totalOf } from "./totals.ts";
import type { CartLine, Total } from "./totals.ts";
import type { PaymentLinkClient } from "./razorpay.ts";
import { ACP_API_VERSION } from "./validate.ts";

/**
 * The states this system can actually reach, which is a SUBSET of the ACP enum
 * the database accepts (migrations/005_checkout.sql carries the whole enum so a
 * stored row is always a legal ACP value).
 *
 * `complete_in_progress` and `expired` are the pending-human state and its
 * deadline, named in DESIGN.md §2 before `complete` was written. They are here
 * rather than added later on purpose: leaving them out made `status ===
 * "expired"` a type error in three files, which is exactly the check that stops
 * a state being invented at the point of use.
 */
export type SessionStatus =
  | "incomplete"
  | "not_ready_for_payment"
  | "ready_for_payment"
  | "complete_in_progress"
  | "completed"
  | "expired"
  | "canceled";

export type RequestedItem = {
  id: string;
  quantity: number;
  /**
   * The unit price the AGENT quoted, from ACP's `Item.unit_amount`.
   *
   * Never used to price anything — checkout is authoritative and a price the
   * buyer supplies is a price the buyer chose. It exists so a refusal can name
   * the drift that caused it: "you read 5700, it is now 5900" rather than "the
   * total changed".
   */
  quoted_minor?: number;
};

export type AcpMessage = {
  type: "error" | "info";
  code?: string;
  severity?: string;
  resolution?: string;
  param?: string;
  content_type: "plain";
  content: string;
};

/**
 * Shaped by `CheckoutSessionBase`, whose required set is wider than it looks:
 * `id, status, currency, line_items, totals, fulfillment_options, messages,
 * links, capabilities`. `LineItem` additionally requires its OWN `totals`, and
 * both it and `Item` set `additionalProperties: false` — so a convenient extra
 * field like `total_amount` on a line is a validation failure, not a nicety.
 *
 * All six of those were caught by validating a real session against the pinned
 * schema rather than by reading the spec carefully enough.
 */
export type CheckoutSession = {
  id: string;
  status: SessionStatus;
  currency: string;
  line_items: Array<{
    id: string;
    item: { id: string; name: string; unit_amount: number };
    quantity: number;
    name: string;
    unit_amount: number;
    totals: Total[];
  }>;
  totals: Total[];
  fulfillment_options: unknown[];
  messages: AcpMessage[];
  links: Array<{ type: string; title?: string; url: string }>;
  capabilities: { payment: { handlers: PaymentHandler[] } };
  fulfillment_details?: unknown;
  buyer?: unknown;
};

/**
 * The handler we declare, per DESIGN.md §2.
 *
 * Non-registered, under our own reverse-DNS name. `requires_delegate_payment`
 * is false because we do not implement that endpoint — accepting raw PANs is
 * PCI DSS scope — and `requires_pci_compliance` is false because no credential
 * ever reaches us or the agent.
 */
export type PaymentHandler = {
  id: string;
  name: string;
  display_name: string;
  version: string;
  spec: string;
  psp: string;
  requires_delegate_payment: boolean;
  requires_pci_compliance: boolean;
  config_schema: string;
  instrument_schemas: string[];
  config: Record<string, unknown>;
};

/**
 * Where the handler documents itself.
 *
 * KNOWN GAP, stated rather than hidden: these URIs are required by the schema
 * and are not yet resolvable — the project has no published domain. They must
 * point at the real specification before submission. A required `format: uri`
 * field cannot be omitted, so the choice is between a placeholder that is
 * declared as one and a plausible-looking URL that quietly 404s.
 */
const HANDLER_BASE = "https://agentready.example/handlers/razorpay_payment_link";

export const RAZORPAY_LINK_HANDLER: PaymentHandler = {
  id: "razorpay_link",
  name: "in.agentready.razorpay_payment_link",
  display_name: "Razorpay payment link",
  version: "2026-08-22",
  spec: HANDLER_BASE,
  psp: "razorpay",
  requires_delegate_payment: false,
  requires_pci_compliance: false,
  config_schema: `${HANDLER_BASE}/config.json`,
  instrument_schemas: [`${HANDLER_BASE}/instrument.json`],
  config: {
    // The agent gets a URL a person opens; no credential is transferred in
    // either direction. This is the whole shape of the handler.
    credential_type: "payment_link_url",
    settlement: "razorpay_order",
    mode: "test",
  },
};

export const MAX_QUANTITY = 99;

function sessionId(): string {
  return `cs_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

/**
 * Builds authoritative state from the CURRENT catalogue.
 *
 * Every reason a cart cannot be paid for produces a message with a code, and
 * drops the item rather than pricing something unbuyable. A session whose items
 * are all unavailable is `not_ready_for_payment`, never `ready_for_payment`
 * with a zero total — a zero-total payable cart is how you charge nothing for
 * something, or charge for nothing.
 */
export async function priceCart(
  sql: Sql,
  merchantId: string,
  requested: RequestedItem[],
): Promise<{ session: Omit<CheckoutSession, "id">; lines: CartLine[] }> {
  const catalog = await lookupVariants(
    sql,
    merchantId,
    requested.map((r) => r.id),
  );

  const lines: CartLine[] = [];
  const messages: AcpMessage[] = [];

  for (const [index, item] of requested.entries()) {
    const variant: CatalogVariant | undefined = catalog.get(item.id);

    if (!variant) {
      messages.push({
        type: "error",
        code: "invalid",
        content_type: "plain",
        param: `$.line_items[${index}].id`,
        content: `No such item: ${item.id}`,
      });
      continue;
    }
    if (variant.availability === "out_of_stock") {
      messages.push({
        type: "error",
        code: "out_of_stock",
        content_type: "plain",
        param: `$.line_items[${index}].id`,
        content: `${variant.title} is out of stock`,
      });
      continue;
    }
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > MAX_QUANTITY) {
      messages.push({
        type: "error",
        code: "invalid",
        content_type: "plain",
        param: `$.line_items[${index}].quantity`,
        content: `Quantity must be a whole number between 1 and ${MAX_QUANTITY}`,
      });
      continue;
    }

    lines.push({
      variant,
      quantity: item.quantity,
      // Integers only, and the multiplication happens once, here.
      amount: variant.price_minor * item.quantity,
    });
  }

  const totals = computeTotals(lines);
  const payable = lines.length > 0 && !messages.some((m) => m.type === "error");

  return {
    session: {
      status: payable ? "ready_for_payment" : "not_ready_for_payment",
      currency: lines[0]?.variant.currency ?? "INR",
      line_items: lines.map((line, i) => ({
        id: `li_${i}`,
        item: {
          id: line.variant.variant_id,
          name: line.variant.title,
          unit_amount: line.variant.price_minor,
        },
        quantity: line.quantity,
        name: line.variant.title,
        unit_amount: line.variant.price_minor,
        totals: lineTotals(line.amount),
      })),
      totals,
      // No shipping options are offered: a spreadsheet merchant has given us no
      // couriers, rates or zones. An empty list is honest; inventing a "Standard
      // Delivery" option would be a promise nobody made. Delivery is priced as
      // a flat cart-level total instead, declared as a stub in DESIGN.md §2.
      fulfillment_options: [],
      messages,
      links: [],
      capabilities: { payment: { handlers: [RAZORPAY_LINK_HANDLER] } },
    },
    lines,
  };
}

async function persist(
  sql: Sql,
  id: string,
  merchantId: string,
  requested: RequestedItem[],
  session: Omit<CheckoutSession, "id">,
  status: SessionStatus,
  isNew: boolean,
): Promise<CheckoutSession> {
  const full: CheckoutSession = { id, ...session, status };
  if (isNew) {
    await sql.query(
      `insert into checkout_session
         (id, merchant_id, status, currency, requested, snapshot)
       values ($1, $2, $3, $4, $5, $6)`,
      [id, merchantId, status, full.currency, JSON.stringify(requested), JSON.stringify(full)],
    );
  } else {
    await sql.query(
      `update checkout_session
          set status = $2, currency = $3, requested = $4, snapshot = $5,
              updated_at = now()
        where id = $1`,
      [id, status, full.currency, JSON.stringify(requested), JSON.stringify(full)],
    );
  }
  return full;
}

export async function createSession(
  sql: Sql,
  merchantId: string,
  requested: RequestedItem[],
): Promise<CheckoutSession> {
  const id = sessionId();
  const { session } = await priceCart(sql, merchantId, requested);
  const stored = await persist(sql, id, merchantId, requested, session, session.status, true);

  // The first row of the timeline. Not a money decision, but without it the
  // trail starts mid-story — a refusal with no visible request in front of it
  // reads as an accusation rather than an outcome, and the timeline is the
  // artifact that has to be legible to someone who was not here.
  await record(sql, {
    session_id: id,
    mandate_id: null,
    actor: "agent",
    action: "session.create",
    outcome: session.status === "ready_for_payment" ? "allowed" : "refused",
    session_status_at_event: session.status,
    // A cart that is not payable at creation is a refusal, and invariant 3 says
    // a refusal names its cause. The cause is already in the session's own
    // messages, so it is carried across rather than restated differently in two
    // places and allowed to drift.
    reason_code: session.status === "ready_for_payment" ? null : "CART_NOT_PAYABLE",
    reason_human:
      session.status === "ready_for_payment"
        ? null
        : session.messages.map((m) => m.content).join("; ") || "The cart is not payable as it stands",
    evidence: { item_count: requested.length, status: session.status },
  });

  return stored;
}

type StoredRow = {
  merchant_id: string;
  status: SessionStatus;
  requested: RequestedItem[];
  link_expires_at: Date | null;
  /** Loaded so `cancelSession` can stop a live link being payable. */
  payment_link_id: string | null;
};

async function load(sql: Sql, id: string): Promise<StoredRow | null> {
  const { rows } = await sql.query<StoredRow>(
    `select merchant_id, status, requested, link_expires_at, payment_link_id
       from checkout_session where id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/**
 * OUR DEADLINE CANNOT BE TIGHTER THAN THE PSP'S ENFORCEMENT OF IT.
 *
 * `expire_by` and `link_expires_at` are set from the same instant, so the
 * nominal deadlines agree. The ENFORCED one does not: a probe against a real
 * link measured Razorpay flipping it to "expired" within 30 seconds of
 * `expire_by`, not at it — the resolution of that measurement was 30s, so the
 * true lag is somewhere in (0s, 30s].
 *
 * Declaring the session expired at the nominal deadline therefore opened a
 * window where WE said expired and the link was still payable. A payment
 * landing in it produced a captured payment against a session whose status
 * refuses the transition: money taken, no order. That is the cancel defect's
 * sibling, and it is silent.
 *
 * The grace makes the safe ordering true rather than assumed: the link is
 * certainly dead before we call the session expired, and a payment made inside
 * Razorpay's real window still finds a `complete_in_progress` session and
 * completes it — which is the correct outcome, because the buyer paid while the
 * link was genuinely payable.
 *
 * 120s is four times the measured worst case. It is a margin over another
 * system's clock, not a number with meaning of its own; re-measure before
 * trusting a smaller one. `complete` still refuses to hand out or reuse a link
 * past the NOMINAL deadline — that is a different question (what we are willing
 * to stand behind) and is correctly stricter.
 */
const EXPIRY_ENFORCEMENT_GRACE_MS = 120_000;

/**
 * Expiry is DERIVED FROM THE DEADLINE, not written by a job.
 *
 * A sweeper that exists only to set a status computable from a timestamp is a
 * moving part with an outage mode: while it is down, expired sessions read as
 * payable. This runs on the read that asks the question, so there is no window
 * in which the answer is stale. `payment_link.expired` from Razorpay confirms
 * it later; it is not what causes it (DESIGN.md §2).
 *
 * Conditional on the status we expect, so a session completed between the read
 * and this write is not stamped expired over the top of a real payment.
 */
async function expireIfDue(sql: Sql, id: string, row: StoredRow, now: Date): Promise<boolean> {
  if (row.status !== "complete_in_progress") return false;
  if (!row.link_expires_at) return false;
  if (row.link_expires_at.getTime() + EXPIRY_ENFORCEMENT_GRACE_MS > now.getTime()) return false;

  const { rows } = await sql.query<{ id: string }>(
    `update checkout_session
        set status = 'expired', updated_at = $2,
            snapshot = jsonb_set(snapshot, '{status}', '"expired"')
      where id = $1 and status = 'complete_in_progress'
      returning id`,
    [id, now],
  );
  return rows.length > 0;
}

/**
 * Retrieval re-prices too.
 *
 * A GET that replayed the stored snapshot would let an agent read a price we
 * no longer honour, which is the exact thing "checkout is authoritative" is
 * supposed to rule out. Terminal sessions are the exception: a completed or
 * cancelled session is a historical record and must not change under a reader.
 */
export async function getSession(
  sql: Sql,
  id: string,
  now: Date = new Date(),
): Promise<CheckoutSession | null> {
  const row = await load(sql, id);
  if (!row) return null;

  const expired = await expireIfDue(sql, id, row, now);
  if (expired) row.status = "expired";

  if (isTerminal(row.status)) {
    const { rows } = await sql.query<{ snapshot: CheckoutSession }>(
      `select snapshot from checkout_session where id = $1`,
      [id],
    );
    return rows[0]?.snapshot ?? null;
  }

  const { session } = await priceCart(sql, row.merchant_id, row.requested);

  // A READ MUST NOT UNDO `complete`. `priceCart` computes a status from the
  // catalogue alone, and for a session with a live payment link that status is
  // `ready_for_payment` — so a plain GET would quietly reset a session that is
  // waiting for a human, and a second `complete` would then be allowed against
  // it. Prices refresh; the lifecycle status is not the catalogue's to set.
  //
  // Found by a test asserting a GET during the pending window, not by reading
  // this function.
  const status = row.status === "complete_in_progress" ? row.status : session.status;
  return persist(sql, id, row.merchant_id, row.requested, session, status, false);
}

/**
 * `expired` is terminal, and is terminal for the same reason `completed` is: an
 * expired session's total was computed against a catalogue we have stopped
 * honouring, so reviving it would serve a stale price. DESIGN.md §2 "The
 * pending-human state, named".
 */
export function isTerminal(status: SessionStatus): boolean {
  return status === "completed" || status === "canceled" || status === "expired";
}

export type UpdateResult =
  | { ok: true; session: CheckoutSession }
  | { ok: false; code: string; message: string };

export async function updateSession(
  sql: Sql,
  id: string,
  patch: { line_items?: RequestedItem[]; buyer?: unknown; fulfillment_details?: unknown },
  now: Date = new Date(),
): Promise<UpdateResult | null> {
  const row = await load(sql, id);
  if (!row) return null;

  // A passed deadline makes the session terminal here too. Otherwise an agent
  // could edit the cart behind a live-but-dead link and be told it worked.
  if (await expireIfDue(sql, id, row, now)) row.status = "expired";

  // A live payment link is a price quoted to a person. Editing the cart under
  // it would leave the link payable at an amount the cart no longer says, which
  // is the drift this design exists to refuse. Cancel and start again.
  if (row.status === "complete_in_progress") {
    return {
      ok: false,
      code: "session_pending_payment",
      message:
        "A payment link is live for this session; cancel it before changing the cart",
    };
  }

  // A terminal session is a record, not a workspace. Mutating one would rewrite
  // history that the audit log has already referenced.
  if (isTerminal(row.status)) {
    return {
      ok: false,
      code: "session_terminal",
      message: `Session is ${row.status} and cannot be modified`,
    };
  }

  const requested = patch.line_items ?? row.requested;
  const { session } = await priceCart(sql, row.merchant_id, requested);
  return {
    ok: true,
    session: await persist(sql, id, row.merchant_id, requested, session, session.status, false),
  };
}

export async function cancelSession(
  sql: Sql,
  id: string,
  now: Date = new Date(),
  client?: PaymentLinkClient,
): Promise<UpdateResult | null> {
  const row = await load(sql, id);
  if (!row) return null;

  if (await expireIfDue(sql, id, row, now)) row.status = "expired";

  if (row.status === "completed") {
    // Cancelling a completed session would mean money moved against a session
    // we then claimed was cancelled. Refunds are a different operation.
    return {
      ok: false,
      code: "session_completed",
      message: "A completed session cannot be canceled; refund the order instead",
    };
  }
  if (row.status === "expired") {
    // Overwriting `expired` with `canceled` would destroy the fact that decides
    // how a late authorisation is read (DESIGN.md §2). The outcomes differ.
    return {
      ok: false,
      code: "session_expired",
      message: "An expired session cannot be canceled; it is already terminal",
    };
  }
  // THE LINK IS CANCELLED BEFORE THE SESSION, AND THE ORDER IS THE POINT.
  //
  // Cancelling a session used to mark it `canceled` and leave the Razorpay link
  // untouched. Verified live: the session read `canceled` while the link read
  // `created` and https://rzp.io/... still accepted ₹2,570.40 for the rest of
  // its thirty minutes. Anyone holding that URL could pay an order the agent
  // had already called off, and the webhook would then report a payment for a
  // session that says it was cancelled.
  //
  // If Razorpay refuses because the link is already paid, the session MUST NOT
  // become `canceled` — money has moved, and that is a refund, not a
  // cancellation. Same shape as invariant 2: check first, act second, first
  // failure short-circuits.
  if (row.payment_link_id && client) {
    try {
      await client.cancel(row.payment_link_id);
    } catch (error) {
      return {
        ok: false,
        code: "payment_link_not_cancellable",
        message:
          "The payment link could not be cancelled, so the session is left as it " +
          "stands rather than claiming a cancellation that is not true: " +
          (error instanceof Error ? error.message : String(error)),
      };
    }
  }

  // Cancelling an already-cancelled session is a no-op, not an error: the agent
  // may be retrying, and the outcome it wants is already true.
  const { session } = await priceCart(sql, row.merchant_id, row.requested);
  const canceled = await persist(sql, id, row.merchant_id, row.requested, session, "canceled", false);

  await record(sql, {
    session_id: id,
    mandate_id: null,
    actor: "agent",
    action: "session.cancel",
    outcome: "allowed",
    session_status_at_event: row.status,
    reason_code: null,
    reason_human: null,
    evidence: { payment_link_cancelled: row.payment_link_id },
  });

  return { ok: true, session: canceled };
}

/** For the idempotency record: a stable hash of the request body. */
export function bodyHash(body: unknown): string {
  return createHash("sha256").update(JSON.stringify(body ?? null)).digest("hex");
}

export { ACP_API_VERSION, totalOf };
