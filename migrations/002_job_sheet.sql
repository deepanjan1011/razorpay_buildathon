-- Make a job self-contained.
--
-- `assembleProducts` needs the sheet's headers: `findField` uses them to locate
-- the price and stock columns, and those are read from the raw cells at
-- assembly time, not at extraction time. Without them stored, assembly only
-- worked while the original ParsedSheet was still in memory — so a job could
-- survive a restart in the database and still be impossible to finish.
--
-- That defeats the point of resumability. Everything needed to go from stored
-- extractions to a published feed now lives in Postgres.

alter table ingest_job add column if not exists sheet_name text;
alter table ingest_job add column if not exists headers    jsonb;
