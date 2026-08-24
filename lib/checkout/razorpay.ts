/**
 * The Razorpay seam. One call: create a Payment Link.
 *
 * WHY ONE CALL AND NOT TWO. DESIGN.md §2 said `complete` "creates a Razorpay
 * order and a payment link". That is not how the API works: a Payment Link
 * creates its OWN order, and the create request takes no `order_id`. Creating
 * an order first would produce a second, unrelated order that nothing ever
 * pays. The order id arrives later, in the webhook payload
 * (`payload.order.entity`), and until then we do not have one — which is why
 * `razorpay_order_id` is nullable in migration 006.
 *
 * An interface with a single implementation, deliberately. The money path must
 * be exercisable without a PSP, a key or a network, and the fake is the whole
 * reason `complete`'s refusals are testable at all. It is not speculative
 * generality; it is the test seam for the one call that spends money.
 */
export type PaymentLinkRequest = {
  /** Integer minor units. CLAUDE.md invariant 6. */
  amount_minor: number;
  currency: string;
  /** Our checkout session id. Comes back on the webhook as the link's reference_id. */
  reference_id: string;
  description: string;
  /** Unix SECONDS, as Razorpay wants them — not milliseconds. */
  expire_by: number;
  customer?: { name?: string; email?: string; contact?: string };
};

export type PaymentLinkResult = {
  id: string;
  short_url: string;
  status: string;
};

export type PaymentLinkClient = {
  create(request: PaymentLinkRequest): Promise<PaymentLinkResult>;
};

/**
 * Razorpay's minimum is 15 minutes from now; anything sooner is rejected at
 * create time. Our 30 clears it with room, and the choice of 30 is argued in
 * DESIGN.md §2 — it is how long we are willing to honour a price we can no
 * longer recompute, not a round number.
 */
export const LINK_TTL_MINUTES = 30;
export const RAZORPAY_MIN_TTL_MINUTES = 15;

export function expiryFor(now: Date): { at: Date; unix: number } {
  const at = new Date(now.getTime() + LINK_TTL_MINUTES * 60_000);
  // Razorpay takes seconds. Passing milliseconds would set an expiry in the
  // year 57000 and silently disable the deadline the whole design rests on.
  return { at, unix: Math.floor(at.getTime() / 1000) };
}

/**
 * The real client. TEST MODE ONLY — CLAUDE.md invariant 5.
 *
 * The key prefix is asserted rather than trusted. A live key in this repo is a
 * mistake that spends real money, and the cheapest place to catch it is before
 * the first request rather than in a dashboard afterwards.
 */
export function razorpayClient(): PaymentLinkClient {
  return {
    async create(request: PaymentLinkRequest): Promise<PaymentLinkResult> {
      // CONFIGURATION IS CHECKED HERE, NOT IN THE FACTORY. Constructing the
      // client used to validate the keys, which meant a missing key threw
      // before any policy ran — so on a server with no Razorpay credentials
      // EVERY refusal came back 502 instead of its own 4xx. A wrong handler_id
      // reported "could not create a payment link", which is both wrong and
      // exactly backwards about whose fault it is.
      //
      // The unit tests could not see it: their fake client never throws, and
      // the throw was in the argument, not the call. One real request found it.
      const keyId = process.env["RAZORPAY_KEY_ID"];
      const keySecret = process.env["RAZORPAY_KEY_SECRET"];

      if (!keyId || !keySecret) {
        throw new Error(
          "RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are required to create payment links",
        );
      }
      if (!keyId.startsWith("rzp_test_")) {
        throw new Error(
          `Refusing to use key ${keyId.slice(0, 12)}…: this project is test mode only ` +
            "(CLAUDE.md invariant 5)",
        );
      }

      const { default: Razorpay } = await import("razorpay");
      const client = new Razorpay({ key_id: keyId, key_secret: keySecret });

      // THE SDK'S TYPE IS WRONG, and wrong in the direction that caused the
      // bug below: `customer` is declared REQUIRED in paymentLink.d.ts, while
      // the API rejects it unless it has content. Satisfying the type is what
      // produced `customer: {}` and a 400 on every live create. The cast keeps
      // the correct body; the type is the thing that is mistaken here.
      const link = (await client.paymentLink.create({
        amount: request.amount_minor,
        currency: request.currency,
        reference_id: request.reference_id,
        description: request.description,
        expire_by: request.expire_by,
        // Razorpay may notify the buyer directly; we do not want it to. The
        // agent hands the URL to its user, and a merchant's SMS credits are not
        // ours to spend.
        notify: { email: false, sms: false, whatsapp: false },
        reminder_enable: false,
        accept_partial: false,
        // OMITTED, not defaulted to `{}`. An empty customer object is a 400
        // from Razorpay — "faulty key: customer" — and `?? {}` sent one on
        // every request that had no customer, which is all of them. Twenty-six
        // unit tests could not see it: the fake accepts any body. The first
        // real request found it immediately.
        ...(request.customer ? { customer: request.customer } : {}),
      } as Parameters<typeof client.paymentLink.create>[0])) as {
        id: string;
        short_url: string;
        status: string;
      };

      return {
        id: String(link.id),
        short_url: String(link.short_url),
        status: String(link.status),
      };
    },
  };
}
