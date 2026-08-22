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

The normalizer runs on **Gemini**, chosen by the provider bake-off in
`OBSTACLES.md` — not by preference, and not on Claude, for which no key is
available. The provider sits behind the `createExtractor` seam, so this can
change; if it does, the number below is void and must be re-run.

Gemini reports no immutable dated snapshot either. This eval is therefore made
*auditable* rather than reproducible: every run records what the API actually
reported, so if the model shifts underneath, the fingerprint changes and the
number is visibly stale rather than silently wrong. Detection, not prevention —
the honest description of what is available.

Record the values the provider **actually returns**. Do not map them onto some
other vendor's field names.

| Field | Source | Why it is recorded |
|---|---|---|
| `provider` | `fingerprint.provider` | which seam implementation ran |
| `conformance` | `fingerprint.conformance` | `constrained` or `best_effort` — changes how much the schema guarantees |
| `model_requested` | the string sent | what we asked for |
| `model_served` | `modelVersion` from the response | what the API says actually ran — the drift signal |
| `prompt_sha256` | hash of system prompt + canonical schema | a prompt edit invalidates the number as surely as a model change |
| `promptTokenCount` | `usageMetadata` | |
| `candidatesTokenCount` | `usageMetadata` | |
| `thoughtsTokenCount` | `usageMetadata` | non-zero on this model; part of cost |
| `totalTokenCount` | `usageMetadata` | |
| `latency_ms` | measured around the call | |
| `run_date` | run timestamp | |
| `source_file` | the sheet evaluated | which catalogue this measures |
| `n_labelled` | count of hand-labelled products | §5 requires 50 |

If `model_served` differs from a previous run's, the number is not comparable to
that run. Say so here rather than quietly overwriting it.

**Do not paste the bake-off table into this file.** That table (`OBSTACLES.md`)
compares providers on ten synthetic rows we wrote ourselves. It is a comparison,
not a measurement, and the two must not be confused.

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
