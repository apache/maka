**Analysis — the empty 400 is Copilot refusing an input item id that lost its kind prefix when magpie bounded it**

The path is Codex (Responses) → magpie → Copilot's `/responses`, relayed with the shims magpie applies to a vendor that isn't OpenAI's. The first request of a fresh conversation goes; the turn after a tool call carries the previous turn's items back, their ids with them, and that is where it dies.

Root cause:

- Copilot hands its items ids hundreds of characters long — 420 and 444 recorded in #4525 and #4527 — and for the sessions isnine reproduced, opaque Base64: `+` and `/` in them, no `msg_`/`rs_`/`fc_` prefix. That shape presumably splits this report's models: gpt-6-luna's ids of it, gpt-6.1-sol's not.
- magpie bounds every input item id to the 64 characters such an upstream takes (`boundItemID`, landed as dd809ea60 for #4525/#4527). The length comes out right, but an id's own prefix is kept only when the id carries one; an opaque id goes out as a bare 64-hex digest. Confirmed still the case at today's tip (7785c4278).
- Copilot's `/responses` checks the kind prefix too, not just length and charset. isnine's follow-up on #4525 (2026-11-02) proved it live against Copilot's `gpt-6.1-terra`: id omitted → 200; bare 64-hex digest → 400, empty message, `invalid_request_body`; `msg_` + hash → 200. That bare 400 is word for word this issue's error, and it explains why no validation detail ever appears anywhere.

Nothing recovers it afterwards: the refusal names no field (no `Invalid 'input[N].id'` words for the learned rewrites to match), so magpie has nothing to retry on and passes the 400 to Codex as it came.

For the record, the hypotheses this report suggests, ordered: (1) the bound id's missing kind prefix — above; (2) model-specific reasoning-history validation — Copilot's own sealed reasoning goes back as it came, Sol works on the same path, and a seal complaint has words, so unlikely; (3) `function_call_output`/`call_id` pairing — a mispair names the call; (4) unsupported request members forwarded on continuation — those are already left out for a non-OpenAI vendor, and the first request carries them too.

The fix direction: when the id carries no prefix of its own, derive one from the item's type (`msg_` for a message, `rs_` for reasoning, `fc_`/`ctc_`/`tsc_` for the call kinds) before the digest — the digest alone already keeps it deterministic and collision-free. isnine's candidate on #4525 (commit 9008406) does this and was verified through a real account; the same rule covers this issue's Luna shape. I'll take this and deliver it with tests that encode the empty-400 refusal.
