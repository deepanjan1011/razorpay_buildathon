-- A job may only carry a reason while it is failed.
--
-- Same shape as the bug `only_failed_has_reason` caught on ingest_batch, found
-- by auditing for it deliberately rather than by hitting it: `runJob` sets
-- `status = 'running'` at the start without clearing `reason_code`, so a job
-- that failed and is now being retried was RUNNING while still carrying
-- "INGEST_BATCHES_FAILED — 1 of 3 batches failed".
--
-- That is a record asserting a live failure that is no longer true. Nothing
-- read it yet, but `GET /api/ingest/{jobId}` exposes it, and Phase 3's audit log
-- makes reason codes load-bearing (CLAUDE.md invariant 3). A reason code that
-- names a non-cause will be believed.
--
-- The general shape, now seen three times: a STATE field and an EXPLANATION
-- field encode one fact between them and can be updated independently. The
-- database is the right place to forbid the disagreement, because every writer
-- has to go through it.

update ingest_job set reason_code = null, reason_human = null
 where status <> 'failed';

alter table ingest_job drop constraint if exists job_only_failed_has_reason;
alter table ingest_job add constraint job_only_failed_has_reason
  check (status = 'failed' or reason_code is null);
