# Razorpay webhook fixtures

Transcribed **verbatim** from Razorpay's published webhook payload samples
(`https://razorpay.com/docs/webhooks/payloads/payment-links/`, read 2026-08-23),
before the parser that reads them existed — `CLAUDE.md` working style.

Nothing is tidied. Fields we do not use stay in, `notes` keeps whichever of its
three real shapes the sample had, and the zero-valued timestamps stay zero. The
whole reason to transcribe rather than author is that the parser must meet shapes
we did not think of; a fixture we cleaned up teaches it only our own assumptions.

**These are documentation samples, not captures from a live account.** That is a
real limitation and is stated rather than hidden: they are the observed shape of
the payload, but no traffic has yet hit this endpoint from Razorpay itself. Live
webhook delivery is untested until a test-mode payment is actually made
(`OBSTACLES.md`).

The signature is not part of these files. It is computed over the raw bytes with
a test secret in `tests/webhook.test.ts`, because a signature pasted from a
sample would be a signature over *their* bytes, not ours.
