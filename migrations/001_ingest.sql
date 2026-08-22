-- Ingest jobs. PHASE-1.md §4a.
--
-- THE DURABLE UNIT OF WORK IS THE EXTRACTION, NOT THE PRODUCT.
--
-- That is the whole design, and it is not obvious, so: normalization is
-- non-deterministic. Re-running extraction on the same row can return a
-- different `variant_group`, which changes the derived product and variant ids
-- — and `Variant.id` is the ACP checkout `items[].id`, so a shifted id breaks an
-- agent's saved reference and, in Phase 3, a mandate issued against it.
--
-- Persisting products and re-extracting on resume would therefore produce
-- duplicates with new ids. Persisting the EXTRACTION makes everything
-- downstream a pure function of stored data: product assembly and feed
-- projection can be re-run freely, and a resumed job never re-spends an API
-- call for a row it has already read. Under a 5 requests/minute cap, requests
-- are the only currency there is.
--
-- AUDIT FOLD PATH (Phase 3). There is deliberately no ingest_event table. A
-- second history that has to be reconciled with the audit log is worse than no
-- history. Instead every terminal transition here carries the columns
-- DESIGN.md §4 already specifies for an audit event — reason_code,
-- reason_human, a timestamp, and enough evidence to reconstruct what happened.
-- When the audit log lands, each transition becomes one row with
-- action = 'ingest.job.*' / 'ingest.batch.*' and actor = 'merchant' / 'system';
-- these tables become current-state, not history.

create table if not exists ingest_job (
  id            text primary key,
  merchant_id   text        not null,
  source_file   text        not null,
  status        text        not null
                check (status in ('pending', 'running', 'complete', 'failed')),
  rows_total    integer     not null check (rows_total >= 0),
  batch_size    integer     not null check (batch_size >= 1),

  -- Run fingerprint. NORMALIZATION-EVAL.md: an accuracy number belongs to the
  -- provider, model and prompt that produced it, so a job records all three.
  provider          text,
  model_requested   text,
  model_served      text,
  prompt_sha256     text,

  -- Audit vocabulary (CLAUDE.md invariant 3): a machine code AND a human string.
  reason_code   text,
  reason_human  text,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- One row per spreadsheet row. `extraction` is null until the model has read it.
create table if not exists ingest_row (
  job_id        text        not null references ingest_job(id) on delete cascade,
  source_row    integer     not null,
  sheet         text        not null,
  batch_index   integer     not null check (batch_index >= 0),

  -- What the model is allowed to see: price and stock columns already removed
  -- (CLAUDE.md invariant 1). Stored as sent, so the request is reconstructable.
  semantic_cells jsonb      not null,
  -- The whole row, for provenance. PHASE-1.md §1 source_cells.
  raw_cells      jsonb      not null,

  extraction     jsonb,

  primary key (job_id, source_row)
);

create index if not exists ingest_row_batch
  on ingest_row (job_id, batch_index);

create table if not exists ingest_batch (
  job_id        text        not null references ingest_job(id) on delete cascade,
  batch_index   integer     not null check (batch_index >= 0),
  status        text        not null
                check (status in ('pending', 'done', 'failed')),
  -- Retries are capped by the caller; this records what actually happened.
  attempts      integer     not null default 0 check (attempts >= 0),

  reason_code   text,
  reason_human  text,

  completed_at  timestamptz,

  primary key (job_id, batch_index),

  -- A done batch must have a completion time, and only a failed batch may carry
  -- a reason. Enforced here rather than in application code because this is the
  -- invariant resume correctness rests on.
  constraint done_has_completed_at
    check (status <> 'done' or completed_at is not null),
  constraint only_failed_has_reason
    check (status = 'failed' or reason_code is null)
);
