# Getting a real merchant sheet

Phase 1's gate is *a real merchant spreadsheet parses end to end*, and §5's
accuracy number needs ~50 hand-labelled products from one. Neither can be
satisfied by anything we generate — the pipeline's entire job is handling mess
nobody cleaned, so mess we authored measures our own imagination.

`npm run eval` refuses to run on `fixtures/messy-*` for that reason.

---

## Why no public dataset works

Everything findable online is one of three things:

- **Transaction data** — bill ids, customer names, totals. Not a catalogue.
- **Business directories** — shop names and phone numbers. Not a catalogue.
- **Scraped e-commerce data** — already normalised. One vendor advertises
  "deduplication of SKUs, consistent category mapping, handling of missing
  values" *as features*.

That last one is the whole problem. Anything published as a dataset has been
cleaned by whoever published it. Feeding pre-cleaned data to a cleaning pipeline
measures nothing.

---

## Route A — photograph a price board (best)

Any shop with a printed list: textile, provision store, bakery, hardware,
pharmacy. Photograph it.

**A Chennai board is the only source that gives Tamil script**, which is the
case this pipeline is distinctive at handling and which no online source
provides. `messy-07` exists precisely because of it.

Then either transcribe it yourself, or **put the photo in the repo and ask
Claude to transcribe it** — reading the image and typing out the rows is exactly
the sort of work it can do, and it removes the tedious half.

Two or three shops beats one: different trades are messy in different ways.

## Route B — transcribe public listings

Where merchants write their own words publicly:

- **IndiaMART** — small sellers authoring their own titles, transliterated,
  specs jammed into the name.
- **Instagram sellers** — a saree or snacks account; prices in captions.
- **Facebook Marketplace** and local seller groups.

Same half hour of typing. Provenance is stated as *transcribed from public
listings by these sellers on this date*.

---

## Transcribe it EXACTLY

The mess is the data. Every instinct to tidy destroys the thing being measured.

- **Do not** standardise prices. `Rs. 1,299/-`, `2.8k` and `2799 (MRP 3499)` all
  go in as written.
- **Do not** translate. Tamil stays Tamil.
- **Do not** split a column. If size and colour are welded into the title, leave
  them welded.
- **Do not** fill blanks, drop the shop's header rows, or remove the phone
  number at the bottom.
- **Do** keep merged cells merged if the board groups items under one heading.

Save as `fixtures/real-<name>.xlsx`. Already gitignored — real merchant data is
not committed (`DESIGN.md` §9).

---

## Then

```bash
npm run label:init -- fixtures/real-<name>.xlsx   # skeleton, raw cells prefilled
# fill in `source` provenance and the answer fields
npm run eval -- fixtures/real-<name>.xlsx         # writes docs/NORMALIZATION-EVAL.md
```

`label:init` prefills the raw cells so the only work left is judgement: looking
at `Blk RunShoe M-9` and saying what it is.

`eval` refuses to run without provenance filled in, refuses synthetic fixtures,
lists **every** failure with its source row, and records the provider, model and
prompt hash — because an accuracy number belongs to the run that produced it.

**Label what is true, not what the pipeline produced.** A label written from the
output measures agreement with ourselves, which is the failure this whole
project keeps rediscovering.
