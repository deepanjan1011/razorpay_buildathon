-- Which policy was in force when this row was written.
--
-- Without it, rows written before and after a change to the check set or the
-- check order mean different things about identical situations, and nothing in
-- the trail says so. A reader two years from now cannot tell whether a mandate
-- passed because it was compliant or because the rule did not exist yet.
--
-- Not null with a default, because a row that does not say which policy decided
-- it is a row that cannot be interpreted — and the default names the policy in
-- force at the time this column was added rather than pretending to know.
alter table audit_event
  add column if not exists gate_version text not null default '2026-08-24.1';
