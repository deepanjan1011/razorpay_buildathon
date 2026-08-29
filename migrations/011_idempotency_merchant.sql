-- Idempotency records are scoped to the merchant that sent them.
--
-- The key was `(key, endpoint)`. `merchant_id` was stored on every row and
-- ignored by the uniqueness, so two merchants shared one namespace of keys:
--
--   same key, same body      -> the second merchant is REPLAYED the first
--                               merchant's stored response, session id and
--                               totals included. A cross-tenant read.
--   same key, different body -> 409 idempotency_conflict, so one merchant can
--                               squat another's keys and block them.
--
-- An idempotency key is a client's private token for "this is the same request
-- I already sent". Two clients cannot mean the same thing by it, and nothing
-- makes them coordinate — Razorpay's own keys are per-account for this reason.
--
-- Reachable rather than theoretical: this database holds live credentials for
-- two merchants (OBSTACLES.md, 2026-08-29).
--
-- No data is rewritten. `merchant_id` is already `not null` on every row, and
-- no (key, endpoint) pair is currently shared across merchants — checked before
-- writing this — so the new key applies to the existing 204 rows as they are.
alter table idempotency_record
  drop constraint if exists idempotency_record_pkey;

alter table idempotency_record
  add primary key (merchant_id, key, endpoint);
