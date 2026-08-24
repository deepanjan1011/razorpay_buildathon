-- Single-use consumption. DESIGN.md §3.
--
-- ONLY consumption is stored, not the mandate. The mandate is a bearer
-- credential the agent holds and presents; its constraints are covered by its
-- signature, so a stored copy would be a second source of truth for the same
-- facts and the two could disagree. What the seller must remember is the one
-- thing the mandate cannot carry about itself: whether it has already been
-- spent.
--
-- The primary key IS the exactly-once mechanism. Consumption is an INSERT that
-- either succeeds or violates the key, which is atomic in a way that
-- "select then update" is not — two concurrent completions of the same mandate
-- race in the gap, and the Phase 1 ingest layer already learned that lesson
-- with batch claims (OBSTACLES.md).
create table if not exists mandate_consumption (
  mandate_id  text        primary key,
  session_id  text        not null,
  consumed_at timestamptz not null default now()
);
