# NORMALIZATION-EVAL

**There is no accuracy number yet, and this file will stay empty until there is
a real one.**

`PHASE-1.md` §5 requires the number to come from hand-labelling 50 products from
a **real** merchant spreadsheet. No real sheet has been contributed yet. The
pipeline runs against synthetic fixtures, and a synthetic number would measure
how well the parser handles mess that was written to be handled — a mirror, not
a measurement.

No placeholder is recorded here on purpose. A provisional figure has a way of
surviving into a README and then into a video, at which point nobody remembers
it was provisional.

---

## What gets filled in, and how

Regenerated whenever the pipeline changes. Never hand-tuned to look better —
`CLAUDE.md` working style, and `PHASE-1.md` §5.

### Required: the run fingerprint

`claude-opus-5` has **no dated model ID**. Unlike `claude-opus-4-5-20251101` or
`claude-haiku-4-5-20251001`, the current Opus has no immutable snapshot to pin —
`claude-opus-5` is the complete and exact model string, and appending a date
produces an invalid ID.

That means this eval cannot be made reproducible by pinning. It is made
*auditable* instead: every run records the fingerprint below, so if the model
shifts underneath, the recorded fingerprint changes and the number is visibly
stale rather than silently wrong. Detection, not prevention — the honest
description of what is actually available.

| Field | Source | Why it is recorded |
|---|---|---|
| `model_requested` | the string sent | what we asked for |
| `model_served` | `response.model` | what the API says actually ran — the drift signal |
| `effort` | `output_config.effort` | materially changes output quality |
| `prompt_sha256` | hash of system prompt + output schema | a prompt edit invalidates the number as surely as a model change |
| `sdk_version` | `@anthropic-ai/sdk` from `package-lock.json` | client-side behaviour changes too |
| `run_date` | run timestamp | |
| `source_file` | the sheet evaluated | which catalogue this measures |
| `n_labelled` | count of hand-labelled products | §5 requires 50 |

If `model_served` differs from any previous run's, the number is not comparable
to the previous one. Say so here rather than quietly overwriting it.

### Required: the results

- Field-level accuracy per field — title, price, category, attributes
- Count of `needs_review` products, by flag
- **Every failure, listed**, with its source row and what went wrong

The failure list is not optional and is not a summary. It is the part that makes
the number honest, and it is the part a reader checks first.

---

## Status

- [ ] A real merchant spreadsheet has been contributed
- [ ] 50 products hand-labelled from it
- [ ] Pipeline run, fingerprint recorded
- [ ] Failures listed individually

Blocked on the first item. Outreach is a parallel track, not a code task —
`DESIGN.md` §8.
