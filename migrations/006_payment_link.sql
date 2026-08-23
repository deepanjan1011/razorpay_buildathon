-- Phase 2: the pending-human state.
--
-- `complete` returns a payment link a person opens, and the session then waits.
-- DESIGN.md §2 "The pending-human state, named" decides what that state is;
-- these columns are what makes it a stored fact rather than something inferred
-- from the presence of a URL in a response nobody kept.

alter table checkout_session
  -- The Razorpay Payment Link. `plink_...`, and the URL a human opens.
  add column if not exists payment_link_id   text,
  add column if not exists payment_link_url  text,

  -- The amount the LINK was created for. Not a duplicate of the snapshot total:
  -- the snapshot is recomputed and this is frozen at creation, and the whole
  -- point is to be able to notice they have diverged. A live link priced at an
  -- amount the catalogue no longer agrees with must not be handed out again.
  add column if not exists link_amount_minor integer
    check (link_amount_minor is null or link_amount_minor >= 0),

  -- The single expiry instant, ours, also pushed to Razorpay as `expire_by`.
  -- Two clocks would disagree; this is the one that answers a read without a
  -- network call, and `expired` is derived from it rather than written by a job.
  add column if not exists link_expires_at   timestamptz,

  -- Arrives with the webhook, not at creation: a Payment Link creates its own
  -- order, and the create response does not carry its id. Null until paid.
  add column if not exists razorpay_order_id text;

-- Reconciliation runs from the link id (webhooks) and from the reference_id we
-- set on the link, which is the session id and therefore already the key.
create index if not exists checkout_session_payment_link
  on checkout_session (payment_link_id);
