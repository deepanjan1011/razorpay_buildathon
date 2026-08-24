-- Agent credentials. Replaces the `X-Merchant-Id` stub.
--
-- THE HOLE THE STUB LEFT was not that `Authorization` went unchecked. It was
-- that the CLIENT chose which merchant's catalogue it was transacting against,
-- by sending a header. Any caller could name any merchant. The merchant now
-- comes from the credential, and there is no header that can override it.
--
-- Only a HASH is stored. A credential table readable by anyone with database
-- access — a backup, a log, a support query — is a table of live bearer tokens.
-- SHA-256 is right here and bcrypt is not: these are high-entropy random tokens
-- we generate, not human-chosen passwords, so there is nothing to brute-force
-- and no reason to pay a work factor on every request.
create table if not exists agent_credential (
  token_sha256 text        primary key,
  agent_id     text        not null,

  -- The merchant this credential may act for. One agent, one merchant, which is
  -- all this project needs; a real deployment wants many-to-many and scopes.
  merchant_id  text        not null,

  label        text,
  created_at   timestamptz not null default now(),

  -- Revocation is a timestamp, not a delete. A deleted credential leaves an
  -- audit trail naming an agent_id that no longer resolves to anything.
  revoked_at   timestamptz
);

create index if not exists agent_credential_agent on agent_credential (agent_id);
