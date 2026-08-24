/**
 * ONE real Payment Link create, against Razorpay test mode.
 *
 * Not a test — it needs keys and the network, so it stays out of `npm test`.
 * Its whole job is to exercise the one request body every checkout test fakes.
 *
 * THE FAKE CANNOT EXPRESS THIS BUG AND NEVER WILL. `fakeClient` receives a
 * `PaymentLinkRequest`; the defect was in translating that into the body
 * Razorpay is sent, which happens inside `razorpayClient()` and which no
 * substitute for `razorpayClient()` can observe. Twenty-six unit tests were
 * green while `customer: {}` made every live create a 400.
 *
 * A link created here is real (test mode, no money) and expires in 30 minutes.
 *
 *   npm run smoke:link
 */
import { expiryFor, razorpayClient } from "../lib/checkout/razorpay.ts";

process.loadEnvFile();

if (!process.env["RAZORPAY_KEY_ID"]) {
  console.error("RAZORPAY_KEY_ID is not set — see .env.example");
  process.exit(1);
}

// No customer. This is the case `complete` takes on every request today, and
// the case that was broken: ACP gives us no buyer contact details, so the field
// must be ABSENT rather than empty. Sending `{}` is a 400.
const link = await razorpayClient().create({
  amount_minor: 73500,
  currency: "INR",
  reference_id: `smoke_${Date.now()}`,
  description: "AgentReady smoke — not a real order",
  expire_by: expiryFor(new Date()).unix,
});

console.log(link);

if (link.status !== "created" || !link.short_url.startsWith("https://")) {
  console.error("Link came back in a shape complete() does not expect");
  process.exit(1);
}
