-- Phase 2: the live catalogue, and checkout sessions.
--
-- WHY A CATALOGUE TABLE SEPARATE FROM THE PUBLISHED FEED.
--
-- `rfc.product_feeds.md` §3.3 is explicit that feed data is a SIGNAL and the
-- checkout response is AUTHORITATIVE. That distinction is meaningless if both
-- read the same bytes: pricing a cart from the published feed would make the
-- feed authoritative by construction, and the Phase 5 drift scenario — agent
-- quotes ₹2,799, checkout says ₹2,999 — would be unreproducible because there
-- would be nothing for the two to disagree about.
--
-- So `catalog_variant` is the live truth, checkout reads it at request time,
-- and the feed artifacts are a snapshot taken at publish. Drift is then a real
-- state of the system rather than a scenario we have to fake.

create table if not exists catalog_variant (
  merchant_id   text        not null,
  variant_id    text        not null,
  product_id    text        not null,
  title         text        not null,

  -- Integer minor units, always. CLAUDE.md invariant 6. Enforced here because
  -- the database is the one place every writer has to pass through.
  price_minor   integer     not null check (price_minor >= 0),
  currency      text        not null check (currency ~ '^[A-Z]{3}$'),

  availability  text        not null
                check (availability in ('in_stock', 'out_of_stock', 'unknown')),
  category      text        not null,

  updated_at    timestamptz not null default now(),

  primary key (merchant_id, variant_id)
);

create table if not exists checkout_session (
  id            text primary key,
  merchant_id   text        not null,

  -- ACP CheckoutSessionBase.status. The full enum is carried even where we
  -- cannot yet reach a state, so a stored row is always a legal ACP value.
  status        text        not null check (status in (
                  'incomplete', 'not_ready_for_payment', 'requires_escalation',
                  'authentication_required', 'ready_for_payment',
                  'pending_approval', 'complete_in_progress', 'completed',
                  'canceled', 'in_progress', 'expired')),

  currency      text        not null check (currency ~ '^[A-Z]{3}$'),

  -- Requested items: variant id -> quantity, as the agent asked for them.
  -- Deliberately NOT the priced cart: prices are recomputed from
  -- catalog_variant on every read, because the alternative is serving a total
  -- we cached before the price changed.
  requested     jsonb       not null,

  buyer             jsonb,
  fulfillment_details jsonb,

  -- The authoritative response as last computed, kept for retrieval and for
  -- the audit trail. Recomputed on every mutation.
  snapshot      jsonb       not null,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists checkout_session_merchant
  on checkout_session (merchant_id, created_at desc);

-- Idempotency we enforce ourselves, because Razorpay does not.
--
-- ACP requires an Idempotency-Key on every mutating call; Razorpay supports
-- them on Payout APIs only (DESIGN.md §2). A retried create must therefore
-- return the FIRST session rather than opening a second one, and later a
-- retried complete must not create a second order.
--
-- Scoped to key + endpoint, per rfc.delegate_payment.md §5.1's rule that keys
-- are scoped to the authenticated identity and endpoint path.
create table if not exists idempotency_record (
  key           text        not null,
  endpoint      text        not null,
  merchant_id   text        not null,

  -- Hash of the request body. A key reused with a DIFFERENT body is a client
  -- bug and must be refused, not silently answered with the old response.
  request_sha256 text       not null,

  response_status integer   not null,
  response_body jsonb       not null,

  created_at    timestamptz not null default now(),

  primary key (key, endpoint)
);
