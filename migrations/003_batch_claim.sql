-- Batch claiming, so two runners cannot both work the same batch.
--
-- The exactly-once guarantee in 001 held for SEQUENTIAL resume: a batch marked
-- `done` is never re-run. It did NOT hold for concurrent runners. Both would
-- see the batch as `pending`, both would call the provider, and both would
-- write — atomically, so the data stayed consistent, but the second API call
-- was already spent. Under a five-requests-per-minute budget that is the
-- expensive kind of harmless.
--
-- This stopped being theoretical the moment `POST /api/ingest` existed: the
-- endpoint is idempotent by job id and starts the run in the background, so a
-- double-click or a retried request starts a second runner on the same job.
--
-- A claim is a conditional UPDATE — `set status='running' where status='pending'`
-- returning the row. Exactly one runner gets the row back; the other sees zero
-- rows and moves on. No lock table, no advisory lock, no queue.
--
-- `claimed_at` exists because a crashed runner would otherwise leave a batch
-- `running` forever and unreclaimable. A claim older than the reclaim window is
-- treated as abandoned.

alter table ingest_batch drop constraint if exists ingest_batch_status_check;
alter table ingest_batch add constraint ingest_batch_status_check
  check (status in ('pending', 'running', 'done', 'failed'));

alter table ingest_batch add column if not exists claimed_at timestamptz;

-- A running batch has a claim time; that is what makes staleness detectable.
alter table ingest_batch drop constraint if exists running_has_claimed_at;
alter table ingest_batch add constraint running_has_claimed_at
  check (status <> 'running' or claimed_at is not null);
