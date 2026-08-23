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
import { totalOf } from "./totals.ts";
import type { PaymentLinkClient } from "./razorpay.ts";
import { expiryFor } from "./razorpay.ts";

/** What `complete` was given, after schema validation. */
export type CompleteRequest = {
  payment_data?: { handler_id?: string; instrument?: unknown; purchase_order_number?: string };
  buyer?: { first_name?: string; last_name?: string; email?: string; phone_number?: string };
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
  | { ok: false; status: number; code: string; message: string; session?: CheckoutSession };

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
  const { session } = await priceCart(sql, row.merchant_id, row.requested);
  const total = totalOf(session.totals);

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

  const expiry = expiryFor(now);

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

    await sql.query(
      `update checkout_session
          set payment_link_id = $2, payment_link_url = $3,
              link_amount_minor = $4, link_expires_at = $5
        where id = $1`,
      [sessionId, linkId, linkUrl, total, expiresAt],
    );
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
