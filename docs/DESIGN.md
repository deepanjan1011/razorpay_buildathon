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
- Idempotency keys on all mutating calls
- Input validation, safe retries, per-request authentication
- Order webhooks with HMAC signature

### Explicitly not implemented — state in README

- Tax configuration (flat rate stub)
- Returns / exchanges workflows (out of ACP scope anyway)
- Real delegated payment tokens — **Razorpay is not a Delegated Payment
  Spec–compatible PSP.** The delegated payment *interface* is implemented
  against an own payment handler that settles to Razorpay test-mode orders.
  This is the single largest deviation from spec and must be stated plainly.
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
confidence become `unmapped` and are held for merchant review rather than
force-fit. See `docs/PHASE-1.md` §2.

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
  "actor": "agent" | "system" | "merchant",
  "action": "session.create" | "mandate.verify" | "payment.attempt" | ...,
  "outcome": "allowed" | "refused" | "error",
  "reason_code": "MANDATE_CEILING_EXCEEDED",
  "reason_human": "Cart total 299900 exceeds mandate ceiling 280000",
  "evidence": { }
}
```

Every refusal carries a reason code *and* a human string. The dashboard renders
this timeline — that is what makes "explainable" visible rather than claimed.

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
- **Postgres (Supabase)** — catalog, sessions, mandates, audit log
- **Razorpay Node SDK** — test mode only
- **MCP TypeScript SDK** — agent-facing server
- **LLM** — one structured-output call for normalization; no orchestration
  framework (a graph around a single call is overhead, not architecture)

---

## 7. Known gaps — write these down now, not on Sept 4

- Delegated payment is interface-only; Razorpay is not a compatible PSP
- MCP layer is own contribution; ACP lists MCP support as future
- UPI agent mandates do not exist as a regulated product; test mode only
- Catalog normalization is LLM-based and therefore non-deterministic —
  measure it, report an accuracy number, list the failures
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
