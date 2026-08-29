/**
 * `POST /checkout_sessions/{id}/complete`. DESIGN.md §2.
 *
 * NO CHARGE HAPPENS HERE, and that is not a shortcoming to apologise for. There
 * is no server-to-server card payment at Razorpay; what a server can create is
 * a Payment Link, and a human opens it. So `complete` means: the cart is final,
 * an order-bearing link exists at exactly this amount, and the session now
 * waits in `complete_in_progress` until the webhook or the deadline moves it.
 *
 * The decision — refuse, reuse the existing link, or create a new one — is a
 * PURE FUNCTION of stored facts and the clock (`planCompletion`). Everything
 * with a side effect is below it and does what it was told. Same shape as the
 * webhook, for the same reason: this is the money path, and a policy that needs
 * a PSP to exercise is a policy nobody exercises.
 */
import type { Sql } from "../db/sql.ts";
import type { CheckoutSession, SessionStatus } from "./session.ts";
import { RAZORPAY_LINK_HANDLER, priceCart } from "./session.ts";
import type { RequestedItem } from "./session.ts";
import { computeTotals, totalOf } from "./totals.ts";
import type { PaymentLinkClient } from "./razorpay.ts";
import { expiryFor, RAZORPAY_MIN_TTL_MINUTES } from "./razorpay.ts";
import { verifyMandate } from "../mandate/verify.ts";
import { verifyMandateSignature } from "../mandate/sign.ts";
import { consume, consumedByOther } from "../mandate/store.ts";
import type { Mandate } from "../mandate/schema.ts";
import { record } from "../audit/log.ts";
import { alternativesFor } from "../catalog/alternatives.ts";
import type { Alternative } from "../catalog/alternatives.ts";
import { isTerminal } from "./session.ts";
import { isCategory } from "../normalize/taxonomy.ts";
import type { Category } from "../normalize/taxonomy.ts";

/** What `complete` was given, after schema validation. */
export type CompleteRequest = {
  payment_data?: { handler_id?: string; instrument?: unknown; purchase_order_number?: string };
  buyer?: { first_name?: string; last_name?: string; email?: string; phone_number?: string };
  /**
   * Presented in the `Mandate` header, not the body — `additionalProperties:
   * false` on the ACP request leaves no conformant place for a field ACP does
   * not define. Parsed by the route, refused by the gate below.
   */
  mandate?: Mandate | null;
};

export type StoredLink = {
  payment_link_id: string | null;
  payment_link_url: string | null;
  link_amount_minor: number | null;
  link_expires_at: Date | null;
};

export type CompletionFacts = StoredLink & {
  status: SessionStatus;
  /** Freshly recomputed from the live catalogue, never the stored snapshot. */
  total_minor: number;
  payable: boolean;
};

export type Plan =
  | { action: "create" }
  | { action: "reuse"; link_id: string; link_url: string }
  | { action: "expire"; code: string; message: string }
  | { action: "refuse"; status: number; code: string; message: string };

/**
 * The whole policy. Ordered, first failure short-circuits — the same discipline
 * invariant 2 imposes on mandate checks, applied here because this is the call
 * that puts a payable amount in front of a human.
 */
export function planCompletion(
  facts: CompletionFacts,
  request: CompleteRequest,
  now: Date,
): Plan {
  if (facts.status === "completed") {
    return {
      action: "refuse",
      status: 409,
      code: "session_completed",
      message: "This session is already completed",
    };
  }
  if (facts.status === "canceled" || facts.status === "expired") {
    return {
      action: "refuse",
      status: 409,
      code: "session_terminal",
      message: `Session is ${facts.status} and cannot be completed`,
    };
  }

  // The handler is checked BEFORE anything is priced or called. An agent that
  // sent us a vault token means to charge a card; answering that with a link a
  // human must open would be a different transaction than the one it asked for.
  const handlerId = request.payment_data?.handler_id;
  if (handlerId !== RAZORPAY_LINK_HANDLER.id) {
    return {
      action: "refuse",
      status: 400,
      code: "unsupported_payment_handler",
      message:
        `This seller accepts payment_data.handler_id "${RAZORPAY_LINK_HANDLER.id}" ` +
        `(${RAZORPAY_LINK_HANDLER.name}), not "${handlerId ?? "none"}"`,
    };
  }

  if (!facts.payable) {
    // The repriced cart says no. The session's own messages carry the reason —
    // out of stock, unknown item, a price that moved — and this is Phase 5's
    // refusal arriving early, before any Razorpay call, as §5 requires.
    return {
      action: "refuse",
      status: 409,
      code: "session_not_ready_for_payment",
      message: "The cart is not payable as it stands; see messages for the reason",
    };
  }

  // An existing link is the interesting case, and getting it wrong means either
  // two live links for one cart or a link handed out at a price we have stopped
  // honouring.
  if (facts.payment_link_id && facts.payment_link_url) {
    if (facts.link_expires_at && facts.link_expires_at <= now) {
      // Derived on read, exactly as DESIGN.md §2 says: the deadline passing is
      // what makes the session expired, not a webhook and not a cron.
      return {
        action: "expire",
        code: "session_expired",
        message: "The payment link for this session expired; start a new session",
      };
    }
    if (facts.link_amount_minor !== facts.total_minor) {
      // Drift. The link is live and priced at something the catalogue no longer
      // says. Handing it back would charge the old price; replacing it silently
      // would leave two live links. Refuse and say both numbers.
      return {
        action: "refuse",
        status: 409,
        code: "price_changed",
        message:
          `A live payment link exists for ${facts.link_amount_minor}, but the cart now totals ` +
          `${facts.total_minor}. Cancel this session and start again at the current price.`,
      };
    }
    return {
      action: "reuse",
      link_id: facts.payment_link_id,
      link_url: facts.payment_link_url,
    };
  }

  return { action: "create" };
}

export type CompleteOutcome =
  | { ok: true; session: CheckoutSession & { order: OrderView }; reused: boolean }
  | {
      ok: false;
      status: number;
      code: string;
      message: string;
      session?: CheckoutSession;
      /**
       * In-mandate alternatives, where the refusal is one an alternative can
       * answer. Empty for refusals it cannot — an expired mandate is not fixed
       * by a cheaper product, and offering one would imply the purchase is
       * still possible.
       */
      alternatives?: Alternative[];
    };

export type OrderView = {
  id: string;
  checkout_session_id: string;
  permalink_url: string;
  status: string;
  totals: CheckoutSession["totals"];
};

type Row = StoredLink & {
  merchant_id: string;
  status: SessionStatus;
  requested: RequestedItem[];
};


/**
 * The link deadline, bounded by the mandate. DESIGN.md §3, decided before the
 * gate was written rather than at the intersection.
 *
 * Two independent deadlines over one purchase is a defect waiting for a
 * boundary. A mandate outliving its link is an authorised purchase nobody can
 * pay — annoying. A LINK outliving its MANDATE is a URL a person can still pay
 * after the authority to charge them lapsed — money moving without authority,
 * which is the whole thing invariant 2 exists to prevent.
 *
 * So the mandate is the ceiling and the link is derived from it. One stored
 * instant still answers every read; this only decides which instant that is.
 */
export function expiryForMandate(
  now: Date,
  mandate: Mandate | null,
): { at: Date; unix: number; tooSoon?: true } {
  const base = expiryFor(now);
  if (!mandate) return base;
  const mandateEnd = Date.parse(mandate.expires_at);
  if (!Number.isFinite(mandateEnd) || mandateEnd >= base.at.getTime()) return base;

  // BELOW RAZORPAY'S FLOOR, SAID OUT LOUD. Truncating the link to the mandate
  // is right, but Razorpay refuses any `expire_by` less than 15 minutes out —
  // so a mandate with 6 minutes left produced a 502 `payment_link_unavailable`
  // and a burnt idempotency key, which blames the PSP for our own arithmetic.
  // `RAZORPAY_MIN_TTL_MINUTES` was exported for exactly this and never read.
  //
  // Reported rather than clamped: clamping would issue a link outliving the
  // authority to charge, which is the one direction DESIGN.md §3 refuses to go.
  const minMs = RAZORPAY_MIN_TTL_MINUTES * 60_000;
  if (mandateEnd - now.getTime() < minMs) {
    return { at: new Date(mandateEnd), unix: Math.floor(mandateEnd / 1000), tooSoon: true };
  }

  const at = new Date(mandateEnd);
  // Razorpay takes SECONDS, and flooring keeps their clock firing no later than
  // ours — the ordering the expiry grace in session.ts depends on.
  return { at, unix: Math.floor(at.getTime() / 1000) };
}

export async function completeSession(
  sql: Sql,
  sessionId: string,
  request: CompleteRequest,
  client: PaymentLinkClient,
  now: Date = new Date(),
): Promise<CompleteOutcome | null> {
  const { rows } = await sql.query<Row>(
    `select merchant_id, status, requested,
            payment_link_id, payment_link_url, link_amount_minor, link_expires_at
       from checkout_session where id = $1`,
    [sessionId],
  );
  const row = rows[0];
  if (!row) return null;

  // Authoritative state, recomputed. `complete` is the last moment the price an
  // agent is about to put in front of a person can be checked against the
  // catalogue, so it is checked here and not taken from the snapshot.
  const { session, lines } = await priceCart(sql, row.merchant_id, row.requested);
  const total = totalOf(session.totals);

  // THE GATE RUNS BEFORE THE LINK PLAN, and the reason is a reason code.
  //
  // Because the link deadline is derived from the mandate, a mandate that
  // expires truncates its link to the same instant — so both checks fire at
  // once and whichever runs first names the cause. Running the link plan first
  // reported `session_expired`, which is true and useless: it says the link ran
  // out and hides that the AUTHORITY did. DESIGN.md §3 called this out in
  // advance as the audit consequence of making the mandate the ceiling.
  //
  // Skipped for a session that is already terminal. There the truthful answer
  // is about the session — it was cancelled, or it was already paid — and
  // talking about authority for a purchase that is over would be a second
  // false-reason-code.
  if (!isTerminal(row.status)) {
    // ───────────────────────────────────────────────────────────────────────
    // THE GATE. CLAUDE.md invariant 2: no payment call executes without a valid
    // mandate. It sits HERE — after the cart is authoritatively priced, before
    // any branch that can reach `client.create` — because the ceiling must be
    // compared against the final total including delivery and tax, and because a
    // refusal must cost zero Razorpay calls.
    //
    // It also gates `reuse`. A mandate that expired while a link was live must
    // not have that link handed out again: the authority to charge lapsed, and
    // the URL is exactly the thing that can still take money.
    // From the PRICED LINES, not the ACP projection: `LineItem` has no category
    // field, and the mapped category is what the gate matches on — never the
    // merchant's free text, and never a model call at payment time (invariant 1).
    // A category the DATABASE holds is a plain string, and casting it to the
    // taxonomy would let an unrecognised value satisfy a constraint by accident.
    // Anything not in the fixed list reads as `unmapped`, which is a member of no
    // list of real categories and therefore matches nothing when a constraint is
    // present — the safe direction, and the same rule the mapper uses.
    const cartCategories: Category[] = [
      ...new Set(lines.map((l) => (isCategory(l.variant.category) ? l.variant.category : "unmapped"))),
    ];
    const verdict = verifyMandate({
      mandate: request.mandate ?? null,
      // BY ANOTHER SESSION, not merely spent. This session presenting its own
      // spent mandate again is a retry after a dropped response, and refusing
      // that would break invariant 4 while protecting nothing.
      consumed: request.mandate
        ? await consumedByOther(sql, request.mandate.mandate_id, sessionId)
        : false,
      signatureValid: request.mandate ? verifyMandateSignature(request.mandate) : false,
      cart: {
        total_minor: total,
        currency: session.currency,
        categories: cartCategories,
        // Distinct products the buyer asked for, NOT expanded variants —
        // counting variants refuses a legal two-item cart as four.
        item_count: lines.length,
      },
      now,
    });

    if (!verdict.ok) {
      // AN IN-MANDATE ALTERNATIVE, WHERE ONE EXISTS. DESIGN.md §5 item 3.
      //
      // Offered only for refusals an alternative can actually answer. A cart
      // over the ceiling has a cheaper option; an EXPIRED mandate does not —
      // suggesting a different product to an agent whose authority has lapsed
      // is noise, and worse, it implies the purchase is still possible.
      const answerable =
        verdict.reason_code === "MANDATE_CEILING_EXCEEDED" ||
        verdict.reason_code === "MANDATE_CATEGORY_NOT_PERMITTED" ||
        verdict.reason_code === "MANDATE_ITEM_COUNT_EXCEEDED";

      // COMPUTED BEFORE THE AUDIT ROW IS WRITTEN, so the record of the
      // refusal carries what was offered instead. It used to run after, which
      // meant the alternatives existed for one HTTP response and never reached
      // the trail: the log said "we blocked it" and could not say "and we told
      // them what they could buy".
      //
      // GUARDED, because that reordering put a database query in front of
      // invariant 3. Enrichment must never be able to suppress the log of a
      // refusal, so a failure here yields no alternatives rather than an
      // exception — the refusal is still recorded, just without them.
      const alternatives = await (async () => {
        if (!(answerable && request.mandate && lines.length > 0)) return [];
        try {
          return await alternativesFor(sql, row.merchant_id, {
              mandate: request.mandate,
              // The WHOLE ceiling, because these refusals mean the current cart
              // is being abandoned rather than added to.
              budgetMinor: request.mandate.constraints.max_amount.value,
              nearCategories: cartCategories,
              excludeIds: lines.map((l) => l.variant.variant_id),
              // THE SAME FUNCTION THE GATE'S TOTALS COME FROM. Comparing the
              // ceiling against a bare item price offered things this very gate
              // then refused — on a real catalogue a 10000 paise item is a 15750
              // paise cart once delivery and tax land. Reusing computeTotals is
              // what stops the two drifting apart again; a parallel arithmetic
              // here would be correct exactly until one of them changed.
              totalFor: (itemPriceMinor) =>
                totalOf(
                  computeTotals([
                    {
                      variant: { ...lines[0]!.variant, price_minor: itemPriceMinor },
                      quantity: 1,
                      amount: itemPriceMinor,
                    },
                  ]),
                ),
          });
        } catch (error) {
          console.error(`[complete] alternatives lookup failed for ${sessionId}:`, error);
          return [];
        }
      })();

      await record(sql, {
        session_id: sessionId,
        mandate_id: request.mandate?.mandate_id ?? null,
        actor: "agent",
        action: "mandate.verify",
        outcome: "refused",
        session_status_at_event: row.status,
        reason_code: verdict.reason_code,
        reason_human: verdict.reason_human,
        gate_version: verdict.gate_version,
        evidence: {
          cart_total_minor: total,
          currency: session.currency,
          categories: cartCategories,
          // THE CEILING, which DESIGN.md §5 item 4 names explicitly alongside
          // the feed and live prices — and which was only ever present inside
          // the human string. A number a reader has to parse out of prose is a
          // number the dashboard cannot render and a query cannot filter on.
          mandate_ceiling_minor: request.mandate?.constraints.max_amount.value ?? null,
          mandate_expires_at: request.mandate?.expires_at ?? null,
          // EVERY PEER, PASSED AND FAILED. The response carries ONE code; the
          // record carries the whole evaluation, which is what removes
          // order-dependence from the trail. The passed set is evidence in a
          // dispute — "the ceiling, the category and the item count were
          // within bounds" is a statement, and silence is not.
          // THE DRIFT, NAMED. A refusal that says only "the total changed" is
          // an audit entry; one that says "you read 5700, it is 5900" is an
          // explanation, and it is what makes the failure path legible in a
          // dashboard rather than merely recorded.
          drift: row.requested
            .map((r) => {
              const line = lines.find((l) => l.variant.variant_id === r.id);
              if (!line || r.quoted_minor === undefined) return null;
              const live = line.variant.price_minor;
              if (live === r.quoted_minor) return null;
              // THE TITLE AS IT WAS AT REFUSAL TIME, recorded rather than
              // looked up later. `var_55c6777cef1151de` names the item to a
              // machine and to nobody else, and the page had no way to do
              // better. Resolving the id against the catalogue at render time
              // would be worse than the id: prices and names move — that is
              // what this row exists to report — so a later lookup can caption
              // a refusal with a name the refusal never saw.
              return {
                id: r.id,
                title: line.variant.title,
                quoted_minor: r.quoted_minor,
                live_minor: live,
              };
            })
            .filter((d) => d !== null),
          peers_evaluated: verdict.peers_evaluated,
          peers_failed: verdict.peers
            .filter((p) => p.reason_code)
            .map((p) => ({ check: p.check, reason_code: p.reason_code })),
          peers_passed: verdict.peers.filter((p) => !p.reason_code).map((p) => p.check),
          // WHAT WAS OFFERED INSTEAD. A refusal an agent can act on and a dead
          // end look identical in a log that records only the refusal, and the
          // difference is the whole argument for this gate being useful rather
          // than merely obstructive. An empty list is recorded too, and means
          // something specific: either the reason code is one no alternative
          // answers — an expired mandate is not fixed by a cheaper product —
          // or nothing in the catalogue fits the mandate.
          alternatives_offered: alternatives,
        },
      });

      const current: CheckoutSession = { id: sessionId, ...session, status: row.status };
      return {
        ok: false,
        status: 403,
        code: verdict.reason_code,
        message: verdict.reason_human,
        alternatives,
        session: current,
      };
    }

    await record(sql, {
      session_id: sessionId,
      mandate_id: request.mandate?.mandate_id ?? null,
      actor: "agent",
      action: "mandate.verify",
      outcome: "allowed",
      session_status_at_event: row.status,
      reason_code: null,
      reason_human: null,
      gate_version: verdict.gate_version,
      evidence: {
        cart_total_minor: total,
        // Recorded on the ALLOWED path too. An authorisation that says only
        // "allowed" cannot be audited: WHAT WAS CHECKED is the evidence that
        // it was checked at all, and a trail that only explains refusals
        // cannot answer the question a dispute actually asks.
        peers_evaluated: verdict.peers_evaluated,
        peers_passed: verdict.peers.filter((p) => !p.reason_code).map((p) => p.check),
      },
    });
  }

  const plan = planCompletion(
    {
      status: row.status,
      payment_link_id: row.payment_link_id,
      payment_link_url: row.payment_link_url,
      link_amount_minor: row.link_amount_minor,
      link_expires_at: row.link_expires_at,
      total_minor: total,
      payable: session.status === "ready_for_payment",
    },
    request,
    now,
  );

  if (plan.action === "expire") {
    const expired = await persistStatus(sql, sessionId, session, "expired");
    return { ok: false, status: 409, code: plan.code, message: plan.message, session: expired };
  }

  if (plan.action === "refuse") {
    const current: CheckoutSession = { id: sessionId, ...session, status: row.status };
    return { ok: false, status: plan.status, code: plan.code, message: plan.message, session: current };
  }

  // TWO CLOCKS, AND THE MANDATE IS THE CEILING. DESIGN.md §3.
  //
  // A link outliving its mandate is a URL a person can still pay after the
  // authority to charge them lapsed — strictly worse than the reverse, which is
  // merely an authorised purchase nobody can pay. So the link deadline is the
  // EARLIER of our thirty minutes and the mandate's own expiry, and there
  // remains exactly one stored instant a read can answer from.
  const expiry = expiryForMandate(now, request.mandate ?? null);

  // TOO LATE TO PRICE A LINK. Refused here, before the Razorpay call, because
  // the alternative is a 502 that names the PSP for a deadline we computed. A
  // refusal an agent can read beats an error it can only retry into — and this
  // one is not retryable: the mandate expires on its own schedule and waiting
  // makes it worse, so saying so is the whole service.
  if (expiry.tooSoon && plan.action === "create") {
    const message =
      `The mandate expires at ${request.mandate!.expires_at}, less than ` +
      `${RAZORPAY_MIN_TTL_MINUTES} minutes away — too soon to create a payment link a ` +
      `human could pay in time. Issue a mandate with a longer validity window.`;
    await record(sql, {
      session_id: sessionId,
      mandate_id: request.mandate?.mandate_id ?? null,
      actor: "system",
      action: "payment.link.refused",
      outcome: "refused",
      session_status_at_event: row.status,
      reason_code: "MANDATE_EXPIRES_TOO_SOON",
      reason_human: message,
      evidence: {
        mandate_expires_at: request.mandate?.expires_at ?? null,
        minimum_link_ttl_minutes: RAZORPAY_MIN_TTL_MINUTES,
        minutes_remaining: Math.max(
          0,
          Math.round((Date.parse(request.mandate!.expires_at) - now.getTime()) / 60_000),
        ),
      },
    });
    return {
      ok: false,
      status: 409,
      code: "MANDATE_EXPIRES_TOO_SOON",
      message,
      session: { id: sessionId, ...session, status: row.status },
    };
  }

  let linkId: string;
  let linkUrl: string;
  let expiresAt: Date;

  if (plan.action === "reuse") {
    linkId = plan.link_id;
    linkUrl = plan.link_url;
    // The existing deadline, not a fresh one. Extending it on every retry would
    // make a 30-minute link immortal under a polling agent.
    expiresAt = row.link_expires_at ?? expiry.at;
  } else {
    const link = await client.create({
      amount_minor: total,
      currency: session.currency,
      // The session id, which is what comes back on the webhook as the link's
      // reference_id and on the order as its receipt. This is the whole
      // reconciliation key between the two systems.
      reference_id: sessionId,
      description: `Order ${sessionId}`,
      expire_by: expiry.unix,
      customer: buyerToCustomer(request.buyer),
    });
    linkId = link.id;
    linkUrl = link.short_url;
    expiresAt = expiry.at;

    // The money event. Recorded AFTER the call returns, because an event
    // written before it would claim a link exists that the call may not have
    // created — the audit log records what happened, never what was intended.
    await record(sql, {
      session_id: sessionId,
      mandate_id: request.mandate?.mandate_id ?? null,
      actor: "system",
      action: "payment.link.created",
      outcome: "allowed",
      session_status_at_event: row.status,
      reason_code: null,
      reason_human: null,
      evidence: {
        payment_link_id: link.id,
        amount_minor: total,
        currency: session.currency,
        expires_at: expiry.at.toISOString(),
        // Which clock won, so a truncated deadline is legible later rather than
        // looking like an arbitrary short link.
        deadline_source:
          request.mandate && Date.parse(request.mandate.expires_at) < expiryFor(now).at.getTime()
            ? "mandate"
            : "link_ttl",
      },
    });

    await sql.query(
      `update checkout_session
          set payment_link_id = $2, payment_link_url = $3,
              link_amount_minor = $4, link_expires_at = $5
        where id = $1`,
      [sessionId, linkId, linkUrl, total, expiresAt],
    );

    // SPEND THE MANDATE. This call was missing entirely: `consume` was imported
    // and never invoked, so `mandate_consumption` was never written, every
    // `single_use` check read "not consumed", and one mandate could pay for
    // unlimited carts until it expired. Invariant 2 said otherwise and the
    // suite agreed with it — the gate's tests pass `consumed` in as an
    // argument, so all thirty-two combinations were green while nothing in
    // production ever set it. An untested path is an assumption, and this one
    // was the assumption that the caller existed.
    //
    // HERE, and not earlier: after `client.create` returned a link. Consuming
    // before the call would destroy a mandate on a transport failure that
    // charged nobody, and invariant 4 requires that retry to work. The record
    // carries the session id so the retry is distinguishable from a second
    // spend — `consumedByOther` is what the gate asks.
    if (request.mandate?.constraints.single_use) {
      const spent = await consume(sql, request.mandate.mandate_id, sessionId);
      await record(sql, {
        session_id: sessionId,
        mandate_id: request.mandate.mandate_id,
        actor: "system",
        action: "mandate.consumed",
        // `observed` rather than `allowed`: this records a mandate being spent,
        // which is a consequence of the decision above, not a second decision.
        outcome: "observed",
        session_status_at_event: row.status,
        reason_code: null,
        reason_human: null,
        evidence: {
          // False means another session got there first between the gate and
          // here. The link exists either way — refusing to record that would
          // hide a real double-spend rather than prevent one.
          first_spend: spent,
          payment_link_id: linkId,
        },
      });
    }
  }

  const withMessage: Omit<CheckoutSession, "id"> = {
    ...session,
    status: "complete_in_progress",
    messages: [
      ...session.messages,
      {
        type: "info",
        // `requires_buyer_review`: a person must open this and authorise. That
        // is the honest classification of a payment link, and it is the one
        // field in the response that tells an agent it cannot finish alone.
        severity: "high",
        resolution: "requires_buyer_review",
        content_type: "plain",
        content:
          `Payment is completed by a person at ${linkUrl}. ` +
          `The link expires at ${expiresAt.toISOString()} and no charge has occurred yet.`,
      },
    ],
  };

  const stored = await persistStatus(sql, sessionId, withMessage, "complete_in_progress");

  return {
    ok: true,
    reused: plan.action === "reuse",
    session: {
      ...stored,
      order: {
        // The Payment Link id, because it is the object that exists. Razorpay's
        // own order id is not returned at create time — a link creates its own
        // order and only names it on the webhook — and inventing an id here
        // that nothing else in either system holds would be worse than using
        // the real one we have.
        id: linkId,
        checkout_session_id: sessionId,
        // The URL where the buyer goes. `Link.type` is a closed enum of policy
        // pages (terms_of_use, privacy_policy, …) with no slot for a payment
        // URL and `additionalProperties: false`, so `links[]` cannot carry it.
        permalink_url: linkUrl,
        // Not `confirmed`: nothing is paid. `created` is the spec's own first
        // value and is exactly what has happened.
        status: "created",
        totals: session.totals,
      },
    },
  };
}

function buyerToCustomer(
  buyer: CompleteRequest["buyer"],
): { name?: string; email?: string; contact?: string } | undefined {
  if (!buyer) return undefined;
  const name = [buyer.first_name, buyer.last_name].filter(Boolean).join(" ");
  const customer = {
    ...(name ? { name } : {}),
    ...(buyer.email ? { email: buyer.email } : {}),
    ...(buyer.phone_number ? { contact: buyer.phone_number } : {}),
  };
  return Object.keys(customer).length > 0 ? customer : undefined;
}

async function persistStatus(
  sql: Sql,
  sessionId: string,
  session: Omit<CheckoutSession, "id">,
  status: SessionStatus,
): Promise<CheckoutSession> {
  const full: CheckoutSession = { id: sessionId, ...session, status };
  await sql.query(
    `update checkout_session
        set status = $2, snapshot = $3, updated_at = now()
      where id = $1`,
    [sessionId, status, JSON.stringify(full)],
  );
  return full;
}
