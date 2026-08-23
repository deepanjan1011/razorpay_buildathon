# CLAUDE.md

Persistent context for this repo. Read `docs/DESIGN.md` before any task.

---

## What this is

An on-ramp that makes small merchants **without a commerce stack** transactable
by AI buyers. Their catalog is a spreadsheet, their storefront is Instagram,
their payments are a Razorpay link.

Built for the Razorpay Buildathon, Track 1 (merchant side).

---

## Hard boundary — enforce this in every review

Merchants already on a commerce platform are **solved**. Shopify merchants get
agent-readiness free via UCP and ACP, including Catalog API and MCP servers.

This project does not compete there. It targets merchants on **no platform at
all**.

If a proposed feature only makes sense for a merchant who already has a
website, product feed, or store install — **reject it and say why.** That drift
rebuilds Shopify's product with none of Shopify's resources.

---

## Invariants — never violate, never "temporarily" bypass

1. **The LLM never decides to charge.** It may normalize catalogs, enrich
   attributes, and reason about intent match. Mandate verification and payment
   execution are deterministic code with no model in the path.
2. **No payment call executes without a valid mandate.** Signature, expiry,
   single-use consumption, amount ceiling, category, item count — all checked,
   in that order, first failure short-circuits.
3. **Every refusal is logged** with a machine reason code and a human string.
4. **No blind retry.** Transport failures retry with capped attempts and
   idempotency keys. A mandate refusal is *never* retried.
5. **Test mode only.** No live Razorpay keys in this repo, ever. No real money.
6. **Amounts are integers in minor units** (paise). Never floats. Never rupees.
7. **Every normalized product traces to its source row.** Provenance is not
   optional — it powers the accuracy measurement and the audit trail.

---

## Stack — decided, do not relitigate

- Single TypeScript repo, Next.js App Router
- Postgres — catalog, sessions, mandates, audit log. **Any provider**: the code
  takes a `DATABASE_URL` and uses no provider-specific feature. Currently Neon,
  chosen because its free tier auto-resumes from idle rather than pausing until
  manually restored — see `docs/OBSTACLES.md`.
- Razorpay Node SDK, test mode
- MCP TypeScript SDK for the agent-facing server
- One structured-output LLM call for normalization. **No orchestration
  framework.** A graph around a single call is overhead, not architecture.
  The **provider is swappable behind the `createExtractor` seam** — do not
  name a vendor outside `lib/normalize/providers/`. Currently Gemini,
  chosen by bake-off (`docs/OBSTACLES.md`); no Anthropic key is available
  for this project.

---

## Spec

ACP (Agentic Commerce Protocol). Pin one dated `API-Version`. Validate every
response against the published JSON Schemas — that doubles as the conformance
suite.

Not implemented, and stated plainly in the README:
- Real delegated payment tokens (Razorpay is not a Delegated Payment
  Spec–compatible PSP — see `docs/DESIGN.md` §2)
- Tax configuration beyond a flat stub
- OpenAI conformance certification

---

## Working style

- **Small commits with real messages.** Commit history is a judged artifact.
- **Write down obstacles as you hit them** in `docs/OBSTACLES.md` — what broke,
  what you tried, what worked. Do not reconstruct this from memory later.
- **Fixtures are written from observed real-world data, before the code that
  parses them — never derived from what the parser already handles.** A fixture
  written after the fact is a mirror of the implementation: it asserts whatever
  the code happens to do and stops finding anything. `parsePrice("Rs. 1,299/-")`
  returning ₹0.13 was caught only because that string was in a fixture before
  the parser existed.
- **Extract, do not subtract.** Never clean a value by removing what you do not
  want and trusting the remainder — anything you failed to anticipate survives
  into the result. Match the thing you *do* want. Subtraction fails silently and
  yields a plausible wrong value; extraction fails loudly. This applies to every
  coercion, not just prices.
- **Tests derived from a rule cannot falsify the rule.** A unit test written
  from an assumption agrees with the assumption. Every rule needs at least one
  end-to-end assertion against a fixture built from real-world shape, not from
  the rule. The "any flag means `needs_review`" rule had a passing unit test and
  still left the feed permanently empty; what caught it was running the whole
  pipeline against a sheet with a plain-number price.
- **A suite that runs in one environment says nothing about a second one.** A
  green suite proves the code is consistent with itself, not that it works
  where it ships. Every test runs under plain Node; the product also runs inside
  a bundler and behind a server, and `import.meta.dirname` is undefined in one of
  those. Anything that ships to a different host needs at least one check *in
  that host* — `npm run build` and one real HTTP request are worth more here
  than any number of extra unit tests. Ask what every test holds constant, and
  vary that.
- **An untested path is an assumption, not code.** If something has never
  actually run — a request shape, an integration, a response parse — say so
  plainly rather than letting a green suite imply otherwise. Full coverage of
  the half you faked is not coverage.
- **A rule that withholds is only safe if it withholds a MINORITY of real
  rows.** Any withholding rule whose trigger condition is ubiquitous in real
  sheets is a denial-of-service on the merchant — and the review queue makes it
  look like caution. For every blocking flag, state its expected trigger rate on
  real-world sheets. **If it is not clearly a minority, it is advisory.** Three
  separate rules failed this test (`CURRENCY_ASSUMED`, `CATEGORY_UNMAPPED`,
  unknown stock), each emptying the feed while passing a green suite. Ask what a
  flag *asserts*, not whether it *sounds* risky.
- **Prefer honest gaps over hidden ones.** A documented limitation is a
  strength; a silently broken path is disqualifying.
- Do not add dependencies without saying why in the commit message.
- Do not scaffold ahead of the current phase.

---

## Phases

| Phase | Output | Gate |
|---|---|---|
| 1 | Ingest → normalize → feed | A real merchant spreadsheet parses |
| 2 | ACP checkout sessions + Razorpay test payment | Session completes, order created |
| 3 | Signed mandates + audit log | No payment possible without valid mandate |
| 4 | MCP server | **A real agent completes a purchase** — and see the gate below |
| 5 | Failure path | Drift refused, logged, alternative offered |
| 6 | Dashboard, conformance tests, README, video | Submission |

Current phase: **2**. Do not build ahead of it.

Phase 1's *code* is done — ingest, normalize, feed. Its **gate is not met**: the
accuracy number needs a real merchant sheet, which is an outreach task, not a
coding one (`docs/TRANSCRIBING.md`). Phase 2 proceeds in parallel because
blocking code on outreach stalls both. `NORMALIZATION-EVAL.md` stays empty until
the sheet exists — that emptiness is the honest status, not an oversight.

---

## Blocking gates on specific phases

**Phase 4 — re-derive exactly-once before the MCP server ships.**

The ingest job layer guarantees exactly-once extraction at batch granularity.
That guarantee is a property of **the whole system**, not of `runJob`: it was
true, and then `POST /api/ingest` was added and it silently became false,
because a second entry point meant two runners could claim the same batch. It
was restored with a conditional-UPDATE claim (`OBSTACLES.md`).

The MCP server is **a third entry point into the same job layer**, and it is
already planned. Before Phase 4 ships, actively re-derive the guarantee against
every caller that can now start or resume work — do not assume it carried over.
Concretely: can two callers claim the same batch; can a caller start a run while
another holds a claim; does a crashed caller's claim still expire.

This is a gate, not a suggestion. The failure is silent — duplicate API calls
against a five-per-minute budget, and duplicate products under shifting ids.

**Phase 3 — refusals must be specific, not loose.** See `docs/DESIGN.md` §3.
Every mandate check is a withholding rule, and the Phase 1 lesson does not
transfer: on the money path the cautious default is correct, so the answer is
precision rather than relaxation.
