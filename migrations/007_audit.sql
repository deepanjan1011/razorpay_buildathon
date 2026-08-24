-- The audit log. DESIGN.md §4.
--
-- APPEND-ONLY, AND DELIBERATELY UNCONSTRAINED ABOUT SESSION STATE.
--
-- The naive schema for this forbids the one thing most worth recording. Razorpay
-- documents late authorisation: a payment can be authorised AFTER we refused,
-- cancelled or expired a session, and the webhook arrives against a session that
-- is already terminal. Any rule of the form "events must be consistent with
-- session state", or "no events after a terminal event", makes the log unable to
-- record money moving against a session we had refused.
--
-- So: no foreign key to a status, no ordering by lifecycle, no uniqueness on
-- "one terminal event per session". Out-of-order delivery is normal and the log
-- accepts anything, in any order. Session state lives in checkout_session; an
-- audit event transitions nothing, so a post-terminal event contradicts nothing.
--
-- There is deliberately no foreign key to checkout_session either: an event
-- naming a session we do not have is an OBSERVATION worth keeping, not an error
-- to reject. The webhook already produces exactly that (SESSION_UNKNOWN).

create table if not exists audit_event (
  event_id    text        primary key,
  ts          timestamptz not null default now(),

  session_id  text,
  mandate_id  text,

  actor       text        not null check (actor in ('agent', 'system', 'merchant', 'psp')),
  action      text        not null,

  -- `observed` is not a euphemism for `allowed`. A late authorisation against a
  -- session we refused is recorded as an observation, because calling it
  -- `allowed` would assert we permitted a charge we in fact refused — the
  -- false-reason-code failure this project has already made once.
  outcome     text        not null check (outcome in ('allowed', 'refused', 'error', 'observed')),

  -- The session's status AS SEEN when this event happened. What makes a late
  -- authorisation legible later: "the session was canceled when this arrived",
  -- rather than a reader inferring it from timestamps.
  session_status_at_event text,

  -- Invariant 3: every refusal carries BOTH. Enforced here rather than trusted,
  -- because the database is the one place every writer passes through.
  reason_code   text,
  reason_human  text,

  evidence    jsonb       not null default '{}'::jsonb,

  constraint audit_refusal_is_explained check (
    outcome <> 'refused'
    or (reason_code is not null and reason_human is not null
        and length(reason_code) > 0 and length(reason_human) > 0)
  )
);

-- The dashboard renders one session's timeline; that is the only read shape.
create index if not exists audit_event_session_ts on audit_event (session_id, ts);
