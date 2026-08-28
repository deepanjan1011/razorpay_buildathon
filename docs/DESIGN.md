# DESIGN.md

**Working name:** `agentready` *(placeholder — rename before first commit)*

**Thesis:** Small merchants without a commerce stack — whose catalog is a
spreadsheet, a WhatsApp list, or a Razorpay payment page — cannot be
transacted with by AI buyers. Existing agent-commerce tooling assumes a
website, a product feed, or a platform install. This project is the on-ramp
for merchants who have none of those.

**Boundary (hold this):** Merchants already on a commerce platform are solved.
Shopify merchants get agent-readiness for free via UCP and ACP, including
Catalog API and MCP servers. This project does **not** compete there. It
targets the merchant who is on no platform at all and never will be. Any drift
toward "make online stores agent-ready" is rebuilding Shopify's product and
must be rejected in review.

**Track:** Razorpay Buildathon, Track 1 — merchant side
("make a merchant transactable by an AI buyer end to end").

---

## 1. Scope

### In

| Component | What it does |
|---|---|
| Catalog ingest | Spreadsheet (CSV/XLSX) → normalized product records via LLM |
| Product feed | Agent-discoverable feed, ACP Product Feed Spec–aligned |
| Checkout API | Stateful ACP checkout sessions on the merchant side |
| Payment handler | Delegated-payment interface → Razorpay test-mode orders |
| Mandate layer | Signed, bounded, single-use purchase authorization |
| Audit log | Append-only, reason on every entry |
| MCP server | Lets a real third-party agent transact (own layer, not spec) |
| Failure path | Price/stock drift vs mandate ceiling |
| Dashboard | Session timeline, mandate state, audit trail |
| Conformance tests | Assert responses against ACP JSON Schemas |

### Out — and why

- **x402** — settles onchain; Razorpay is not in the flow. Designed for
  machine-to-service micropayments (APIs, data, inference), not retail goods:
  no cart, shipping, returns, or merchant-of-record. Stablecoin settlement for
  an Indian merchant is also regulatorily unsettled. *Right protocol, wrong
  project.*
- **UCP (Universal Commerce Protocol)** — Shopify/Google, broader coalition,
  covers discovery through post-purchase. Rejected on two grounds: far larger
  surface area than a solo build can conform to honestly, and Razorpay's track
  text names ACP, AP2 and x402 — not UCP — indicating the frame they are
  reasoning in. Note that UCP already ships Catalog API, MCP servers and a CLI
  for Shopify merchants; this project deliberately targets merchants who are
  on **no** commerce platform at all, where neither UCP nor ACP tooling reaches.
- **NPCI UAP** — no public specification, not launched, pending RBI approval.
  Cited as market context in the pitch; nothing to build against.
- **AP2 full credential model** — the mandate concept is borrowed; the full
  verifiable-credential stack is disproportionate at this scope. Own
  signed-mandate implementation instead, documented as a subset.
- **Real ChatGPT Instant Checkout onboarding** — requires OpenAI certification.
  Out of reach in the window. MCP client used as the third-party agent instead.

---

## 2. Spec alignment

Target: **ACP (Agentic Commerce Protocol)**, Apache 2.0, OpenAPI specs and JSON
Schemas published in the `agentic-commerce-protocol` GitHub repo.

Pin one dated API version (`API-Version`, `YYYY-MM-DD` format) and state it in
the README. Validate every response against the repo's published schemas —
this doubles as the conformance test suite.

### Endpoints implemented

- `POST /checkout_sessions` — create
- `POST /checkout_sessions/{id}` — update
- `GET  /checkout_sessions/{id}` — retrieve
- `POST /checkout_sessions/{id}/complete` — complete, creates order
- `POST /checkout_sessions/{id}/cancel` — cancel if not completed

Every response returns full authoritative cart state: items, pricing, tax,
fulfillment, totals, status, messages, errors.

### Cross-cutting requirements

- Request signing (`Signature` + RFC 3339 `Timestamp` over canonical JSON)
- Input validation, safe retries, per-request authentication
- Order webhooks with HMAC signature — `X-Razorpay-Signature` is HMAC-SHA256
  over the **raw request body**, keyed by the webhook secret (which is not the
  API key secret). The body must be read as text; parsing and re-serialising
  breaks the signature.

#### Idempotency is ours to enforce, not the PSP's

ACP requires an `Idempotency-Key` on every mutating call. **Razorpay supports
idempotency keys on Payout APIs only** — Orders and Payments have no such
header, so a retried order creation silently creates a *second order*. That is
exactly the path invariant 4 opens by allowing capped retries on transport
failure.

So we own it: a table keyed on the incoming ACP `Idempotency-Key`, storing the
resulting response, consulted before any call is made.

Reconciliation between the two systems runs on the **session id**, which
`complete` sets as the Payment Link's `reference_id` (unique per link, ≤40
chars; `cs_` + 24 hex fits). It surfaces on the order as its `receipt` and comes
back on every webhook. Razorpay enforces that uniqueness itself, which is a
second line of defence worth naming: if we ever retried a link creation for a
session that already has one, Razorpay refuses the duplicate rather than
minting a second payable URL. Same shape as the ingest batch claim — a
conditional insert, not a lock.

Verified against Razorpay's live documentation, `docs/OBSTACLES.md`.

### Payment: a declared handler, not a delegated token

This replaces an earlier claim that "Razorpay is not a Delegated Payment
Spec–compatible PSP", which was wrong about where the endpoint lives and
therefore wrong about why we are not implementing it.

**`POST /agentic_commerce/delegate_payment` is implemented by the MERCHANT.**
`openapi.delegate_payment.yaml` declares `servers: https://merchant.example.com`,
and the request body carries a raw card credential — `number` is documented as
"FPAN/DPAN/network token/virtual PAN". The endpoint's job is to accept a card and
return a vault token the merchant's own PSP can charge within an `Allowance`.

**We do not implement it because that puts raw card numbers in our
infrastructure, which is PCI DSS scope.** That is a decision, not a vendor
limitation, and it is the sentence that belongs in the README.

**What we do instead is what the spec has a slot for.** At `2026-04-17`,
`PaymentData` is no longer a bare token:

```
PaymentData  { handler_id, instrument: { type, credential: { type, token } } }
Capabilities.payment.handlers[] -> PaymentHandler {
  name (reverse-DNS), psp, requires_delegate_payment, requires_pci_compliance }
```

We declare one handler:

```json
{
  "id": "razorpay_link",
  "name": "in.agentready.razorpay_payment_link",
  "psp": "razorpay",
  "requires_delegate_payment": false,
  "requires_pci_compliance": false
}
```

Stated honestly in the README: a **non-registered** handler under our own
reverse-DNS name. `dev.acp.seller_backed` was considered and does not fit — it
sets `requires_delegate_payment: true`, so it routes through the endpoint we are
declining to implement.

This shrinks the largest deviation from *"the payment spec is interface-only"* to
*"we declare a handler and decline `delegate_payment` for PCI reasons"*.

### The payment link is the real flow, not a workaround

**There is no server-to-server card payment at Razorpay.** The standard flow
collects card details in a browser Checkout widget; the server only creates the
Order beforehand and verifies afterwards. S2S exists but is Third-Party
Validation for the BFSI sector, not a general card API. Any design in which
`POST /checkout_sessions/{id}/complete` charges a card directly is fiction.

What a server *can* create is a **Payment Link** (`short_url`) or a QR code —
both yielding a URL a person opens. So the flow is:

1. Agent drives the session to `ready_for_payment` against authoritative cart
   state.
2. `complete` creates a Razorpay **Payment Link** and returns its URL. **No
   charge has occurred.**

   Corrected after building it: this is ONE call, not two. A Payment Link
   creates its own order and the create request takes no `order_id`, so
   "create an order, then a link for it" would produce a second, unrelated
   order that nothing ever pays. The order id is not in the create response
   either — it arrives with the webhook, which is why `razorpay_order_id` is
   nullable (`migrations/006_payment_link.sql`).

   The URL is returned as `order.permalink_url`, NOT in `links[]`. `Link.type`
   is a closed enum of policy pages — `terms_of_use`, `privacy_policy`, … —
   with `additionalProperties: false`, so the session's `links` array has no
   slot for a payment URL and cannot be given one. The response is a
   `CheckoutSessionWithOrder`, and `order.id` is the Payment Link id, because
   that is the object that actually exists at this point in the flow.
3. A human completes payment at that link.
4. The webhook moves our order to paid, HMAC-verified, idempotent per event id.

This is not a degraded substitute for agentic payment — it is the honest shape
of it under Indian rails today, and it is the project's own premise: the
merchant's payments are *already* a Razorpay link. The agent's contribution is
everything up to and including a correct, mandate-checked, authoritative cart.

The limitation to state plainly: the final authorisation step is human, so this
is not unattended agentic payment. UPI agent mandates, which would remove that
step, do not exist as a regulated product (§7).

### The pending-human state, named — decided BEFORE `complete` is written

A returned payment link creates a state the session sits in for as long as a
human takes to pay. That state must be **named, stored and expirable**, not
inferred from the presence of a link in a response. Inferred states are how
"we'll handle that case later" becomes "nobody knows what this row means".

**The state is `complete_in_progress`.**

Chosen from `CheckoutSessionBase.status`, whose enum the schema gives without
per-value descriptions, so the choice is ours to justify:

- `complete_in_progress` — `complete` was called, an order exists, the outcome
  is not yet known. That is exactly true of a session awaiting a human payment.
- `pending_approval` was rejected: it reads as *someone must approve this
  purchase*, which is a mandate/authorisation concept. Phase 3 may genuinely
  need it, and spending it here would leave nothing to say then.
- `ready_for_payment` must **not** persist after `complete`. It means "you may
  now call complete", and leaving it there invites a second `complete`.

`complete_in_progress` is **not terminal**. `isTerminal()` stays `completed ||
canceled` — plus `expired`, below.

#### Expiry is set at `complete`, and is a real deadline

`complete` sets Razorpay's `expire_by` on the payment link, and stores the same
instant on the session. **30 minutes**, for one reason: the cart is repriced
from the live catalogue on every read, and a payment link is the one artifact in
this system that carries a price we can no longer recompute. Its lifetime is
therefore the length of time we are willing to honour a stale price. A link good
for 24 hours is a 24-hour price guarantee nobody agreed to, on a catalogue a
merchant edits in a spreadsheet.

Two clocks would disagree, so there is one instant, ours, pushed to Razorpay:

- `expire_by` on the link, so Razorpay itself stops accepting payment
- `link_expires_at` on the session, so a read can answer without a network call

**A session read after `link_expires_at` reports `expired`, whether or not the
webhook has arrived.** Derived on read, not by a sweeper job — a cron that
exists only to write a status that can be computed from a timestamp is a moving
part with an outage mode. `payment_link.expired` confirms it; it is not what
causes it.

`expired` is **terminal**, and joins `isTerminal()`. An expired session is not
resumable: reviving it would serve the old total, which is the drift this whole
design refuses.

#### A late authorisation after expiry NEVER completes the session

This is the case the user of a payment link actually hits, and it is decided
here rather than discovered: a payment authorised just inside the window whose
webhook lands outside it, or a slow issuer.

**Rule: money arriving against an `expired` (or `canceled`) session does not
change the session. It is recorded as an observation and raised as an operator
action item.** §4 already forbids the audit log from refusing post-terminal
events; this is the session-side half of the same decision.

```json
{
  "action": "payment.late_authorized",
  "outcome": "observed",
  "session_status_at_event": "expired",
  "reason_code": "LATE_AUTH_AFTER_EXPIRY",
  "reason_human": "Payment captured 4m after link expiry; fulfil or refund — operator decision",
  "evidence": { "razorpay_payment_id": "pay_...", "expired_at": "...", "captured_at": "..." }
}
```

Why not just complete it, given the buyer really did pay? Because completing
asserts *we sold this cart at this price*, and after expiry we no longer know
that: the catalogue may have moved, and the session's own total is recomputed
from a catalogue that no longer says what the link said. Fulfil-or-refund is a
merchant's judgement about a real customer, and the honest system hands them the
fact rather than guessing. Silently completing would also make `expired` a lie
the dashboard tells.

The money is not lost and nothing is retried (invariant 4) — a fact is recorded.

#### Webhook facts, from the real payloads

Transcribed from Razorpay's published samples (`OBSTACLES.md`), not invented:

- **The event id is a HEADER**, `x-razorpay-event-id`. The body carries no
  event id, so per-event idempotency keys on the header or on nothing.
- Signature is HMAC-SHA256 over the **raw body**, keyed by the webhook secret —
  a different secret from the API key secret. Parsing and re-serialising breaks
  it.
- `payment_link.entity.order_id` is `order_XXXX` while `payload.order.entity.id`
  is the same string **without the prefix**. Comparing them naively never
  matches.
- `expire_by` and `expired_at` are `0` when unset, not null.
- `notes` is variously `[]`, `null` and an object across real payloads, so it
  cannot be relied on to carry our session id. **`reference_id` on the link
  carries it** (and surfaces as the order's `receipt`), which is the field
  DESIGN §2 already reconciles idempotency through.

### Declared deviations from the spec — state in README

- **`payment_data` carries `handler_id` alone.** ACP's `PaymentData` is
  `anyOf: [{handler_id, instrument}, {purchase_order_number}]`; both branches
  assume the agent hands the seller a credential. Ours declares
  `requires_delegate_payment: false` — the artifact is a URL travelling the
  other way — so neither describes it. The extension mechanism does not rescue
  it: `ExtensionDeclaration.extends` names `$.<SchemaName>.<fieldName>` as the
  way to add fields, and `PaymentData.additionalProperties: false` rejects
  exactly that (verified, `OBSTACLES.md`). The two shapes that do validate were
  rejected as fabrications — `credential.token: "n/a"` invents a credential,
  and `purchase_order_number` means a buyer-issued PO for an invoiced purchase,
  not a slot for a session id. An honest deviation beats a field misused to
  look conformant.

### Explicitly not implemented — state in README

- Tax configuration (flat rate stub)
- Returns / exchanges workflows (out of ACP scope anyway)
- `POST /agentic_commerce/delegate_payment` — PCI DSS scope, see above
- Registered/interoperable payment handler — ours is under our own namespace
- OpenAI conformance certification

---

## 3. Mandate model

The bounded + gated half of the track bar. No payment call executes without a
valid mandate.

```json
{
  "mandate_id": "mnd_...",
  "issued_at": "2026-08-21T10:00:00Z",
  "expires_at": "2026-08-21T11:00:00Z",
  "constraints": {
    "max_amount": { "value": 300000, "currency": "INR" },
    "categories": ["footwear"],
    "max_items": 1,
    "single_use": true
  },
  "intent_text": "black running shoes under 3000",
  "signature": "<Ed25519 over canonical JSON of all fields above>"
}
```

Amounts in minor units (paise). Verification gate runs before *every* payment
call and checks, in order: signature validity, expiry, single-use consumption,
amount ceiling against final cart total, category match, item count. First
failure short-circuits with a machine-readable reason code.

**Category decision:** mandate category matching operates on a fixed, coarse
taxonomy that products are mapped into at ingest — not on merchant free-text.
Rationale: matching at payment time must be deterministic, and pushing fuzzy
category resolution into the payment path would put a model in the charge
decision, violating the invariant below. Products the mapper cannot place with
confidence become `unmapped` and are queued for merchant review rather than
force-fit. Queued, *not* withheld from the feed: an `unmapped` product cannot
satisfy a category-constrained mandate, so it is refused at the payment gate by
construction, and hiding it from discovery as well would cost catalogue coverage
for no added safety. This requires the mandate category check to treat
`unmapped` as matching nothing — if that ever changes, unmapped products must be
withheld. See `docs/PLAN.md` §1 and §2.

### Two clocks over one purchase — decide this before writing Phase 3

Phase 2 set a clock: a payment link lives 30 minutes, and `expired` is derived
from it on read. Phase 3 will set a second one: a mandate has an expiry, and
invariant 2 checks it.

**Two independent deadlines over a single purchase is a defect waiting for an
intersection.** A mandate valid for an hour against a link valid for thirty
minutes is a purchase that is authorised and unpayable. The reverse — a link
outliving its mandate — is worse: a URL a human can still pay after the
authority to charge them has lapsed.

Decide which clock dominates rather than discovering it at the boundary. The
likely answer is that **the mandate is the ceiling and the link is derived from
it** (`expire_by = min(now + 30m, mandate.expires_at)`), because the mandate is
the thing that carries authority and the link is an artifact we mint. But it is
a decision with an audit consequence — a link truncated by a mandate expiry has
a different reason code from one that simply ran out — so it is written here to
be settled deliberately.

Whatever is chosen, there must remain exactly ONE stored instant that a read can
answer from, as there is now.

### Refusals must be SPECIFIC, not loose — read before writing Phase 3

Phase 1 hit the same bug three times: a withholding rule whose trigger was
ubiquitous in real data emptied the feed, and looked like rigour while doing it
(`OBSTACLES.md`). Mandate verification is that failure mode with the stakes
raised: **every check here is a withholding rule**, and a mandate that refuses
too readily makes agentic purchase impossible — which will also look like
rigour.

**The Phase 1 fix does not transfer.** There, the cautious default was wrong and
relaxing it was correct. Here the cautious default is *right*: this is the money
path, and `CLAUDE.md` invariant 2 is not negotiable. So the answer is not
looseness. It is **specificity** — each check's trigger condition must be
exactly the unsafe case, never a proxy that happens to be broader.

Concretely, the difference between a specific check and a loose one:

| Check | Specific (correct) | Loose (refuses valid purchases) |
|---|---|---|
| category | refuse only if `constraints.categories` is present AND the product's mapped category is not a member | refuse any `unmapped` product, even when the mandate carries no category constraint |
| amount ceiling | compare `max_amount` against the FINAL authoritative cart total | compare against an estimate, or per-item, or a pre-tax subtotal |
| expiry | evaluate at the moment of the payment call | evaluate at session create, refusing mandates still valid when charged |
| item count | count what the mandate defines as an item | count expanded variants, refusing a legal two-item cart as four |
| single use | refuse only a mandate already *consumed* | refuse one merely *seen* before, killing legitimate retries |

**Rule for every gate:** state, next to the check, the condition it refuses and
why that condition is exactly unsafe. A check that cannot be justified that
precisely is a proxy, and a proxy on the payment path refuses real purchases.

The audit log is what makes this visible: a refusal reason that names a
non-cause (`OBSTACLES.md`, the false-reason-code entry) will be believed, and a
loose check produces exactly that.

**Non-negotiable:** the LLM never decides to charge. It may normalize, enrich,
and reason about intent match. Mandate verification and payment execution are
deterministic code.

---

## 4. Audit event shape

Append-only. One row per decision, not per request.

```json
{
  "event_id": "evt_...",
  "ts": "2026-08-21T10:04:12Z",
  "session_id": "cs_...",
  "mandate_id": "mnd_...",
  "actor": "agent" | "system" | "merchant" | "psp",
  "action": "session.create" | "mandate.verify" | "payment.attempt" | ...,
  "outcome": "allowed" | "refused" | "error" | "observed",
  "session_status_at_event": "ready_for_payment" | "canceled" | ...,
  "reason_code": "MANDATE_CEILING_EXCEEDED",
  "reason_human": "Cart total 299900 exceeds mandate ceiling 280000",
  "evidence": { }
}
```

Every refusal carries a reason code *and* a human string. The dashboard renders
this timeline — that is what makes "explainable" visible rather than claimed.

### The log must accept events AFTER a session is terminal

This is a schema constraint on the audit log, decided now rather than
discovered in Phase 5.

**Razorpay documents late authorisation.** A payment can be authorised *after*
we have refused, cancelled or failed a session — the buyer completes a payment
link we had given up on, or an issuer authorises slowly. The webhook arrives
against a session that is already terminal.

The naive schema forbids exactly this. Anything of the form "a session's events
must be consistent with its state" or "no events after a terminal event" makes
the log unable to record the one thing most worth recording: **money moved
against a session we had refused.**

Three rules follow:

1. **The audit log is a record of observations and decisions, never a state
   machine.** Session state lives in the sessions table. An audit event does not
   transition anything, so a post-terminal event contradicts nothing — it is an
   observation about a session whose state is what it is.
2. **No constraint may reference session state.** No foreign key to a status, no
   check that orders events by lifecycle, no uniqueness on "terminal event per
   session". The log is append-only and accepts anything, in any order.
   Out-of-order webhooks are normal (Razorpay's own docs warn about ordering).
3. **Each event records the session status observed AT THE TIME**
   (`session_status_at_event`) alongside the event itself. That is what makes a
   late authorisation legible later: *the session was `canceled` when this
   arrived*, rather than a reader having to infer it from timestamps.

**A late authorisation is not an `allowed` outcome.** Recording it as `allowed`
would assert we permitted a charge we in fact refused — the false-reason-code
problem again, in the place it does the most damage. The `outcome` set therefore
gains `observed`: something happened that we did not decide.

```json
{
  "action": "payment.late_authorized",
  "outcome": "observed",
  "session_status_at_event": "canceled",
  "reason_code": "LATE_AUTH_AFTER_TERMINAL",
  "reason_human": "Payment authorized 41m after session was canceled; refund required",
  "evidence": { "razorpay_payment_id": "pay_...", "canceled_at": "...", "authorized_at": "..." }
}
```

Such an event is an **operator action item**, not a completed purchase. The
refund that follows is itself an audited event. Invariant 4 still holds: nothing
is retried, and no payment call is made — we are recording a fact, not reacting
to one.

**Terminal means terminal for us. It does not mean nothing further can be
observed.**

---

## 5. Failure path (the one, done properly)

**Scenario:** price or stock drift between feed and checkout.

Agent reads ₹2,799 from the feed. At `complete`, the item is ₹2,999 or out of
stock. Mandate ceiling is ₹2,800.

**Required behaviour:**

1. Refuse before any Razorpay call. No payment is attempted.
2. Return a machine-readable error with reason code and human message.
3. Offer an in-mandate alternative from the catalog, if one exists.
4. Log the refusal with full evidence: feed price, live price, ceiling.
5. **No blind retry.** Retry only on transport-level failure, capped,
   idempotency-keyed. A mandate refusal is never retried.
6. Session stays retrievable in a terminal, explained state.

This one path demonstrates all five bar items — explainable, bounded, gated,
audited, gracefully failed — in roughly ninety seconds of video.

---

## 6. Stack

Single TypeScript repo.

- **Next.js (App Router)** — merchant upload UI, dashboard, ACP route handlers
- **Postgres** — catalog, sessions, mandates, audit log. Provider-agnostic: a
  `DATABASE_URL` and plain SQL, no vendor SDK. Currently Neon.
- **Razorpay Node SDK** — test mode only
- **MCP TypeScript SDK** — agent-facing server
- **LLM** — one structured-output call for normalization; no orchestration
  framework (a graph around a single call is overhead, not architecture).
  **The provider is swappable, not fixed**: it sits behind the
  `createExtractor` seam (`lib/normalize/providers/`), and nothing outside
  that directory names a vendor. Selected by measurement — see the bake-off
  in `docs/OBSTACLES.md`, which also records why this is not Claude.

---

## 7. Known gaps — write these down now, not on Sept 4

- Delegated payment is interface-only; Razorpay is not a compatible PSP
- MCP layer is own contribution; ACP lists MCP support as future
- UPI agent mandates do not exist as a regulated product; test mode only
- Catalog normalization is LLM-based and therefore non-deterministic —
  measure it, report an accuracy number, list the failures. The provider is
  chosen by bake-off, not preference, and the accuracy number belongs to the
  provider that produced it
- Product feed is served, not submitted to any agent platform's ingestion

---

## 8. Phases

| Phase | Output | Gate |
|---|---|---|
| 0 | This document | Committed before any code |
| 1 | Ingest → normalize → feed published | A real merchant spreadsheet parses |
| 2 | ACP checkout sessions + Razorpay test payment | Session completes, order created |
| 3 | Signed mandates + audit log | No payment possible without valid mandate |
| 4 | MCP server | **A real agent completes a purchase** |
| 5 | Failure path | Drift refused, logged, alternative offered |
| 6 | Dashboard, conformance tests, README, video | Submission |

Phase 4 is the checkpoint that matters. If a third-party agent has not bought
something by then, cut scope rather than extend.

Merchant outreach runs in parallel from day one — it is not a blocking step.

---

## 9. Honest dataset statement (for README)

Catalogs are real spreadsheets contributed by small sellers with permission.
Payments are Razorpay **test mode**. No real money moves. Where data is
synthetic, it is labelled synthetic and the generating assumptions are stated.
