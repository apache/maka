I came to this with a fix of my own and found @ump45nose's patch here from yesterday — it stands as the candidate; this is an independent confirmation of the cause and a review adding what neither patch post covers, all verified on `cb05dc2d`.

**Cause, independently confirmed**: `codexBackend` consults the compaction policy only for provider-qualified models (`codexInputAs(body, true, s.nativeCompactionFor(model))`). One of Codex's own models goes bare (the picker exposes `gpt-6.1-sol`, not `codex/gpt-6.1-sol`), its trigger is kept for "their backend to handle", and when `codexAccounts` hands the request to magpie's account pool the trigger rides along: the backend compacts natively, `wroteCheckpoint` records whoever answered, and the conversation is bound with the toggle off. `/responses/compact` has the same hole one branch earlier.

**The decision this patch needs that no post has surfaced**: honoring the toggle on Codex's own models reverses behavior five tests pin deliberately. `d6a68918` applies cleanly onto `cb05dc2d`; with it, these fail, each green on main today:

- `TestProtectionRefusalAskedOnceNobodyRests` — a bare-model trigger through the pool relays natively, and a protection refusal reaches Codex as the upstream sent it, asked once
- `TestCodexPausedOwnAccountNotCompactedOn` — `/responses/compact` relays natively while the sign-in is paused, signed by the account that is on (#263)
- `TestGatewayKeyAccountsHoldCodexCompact` — the held-key gate and relay on the compact endpoint (#905/#967)
- `TestRevokedSignInNotCompactedOnAgain` — a revoked sign-in is asked last on that relay (#1793)
- `TestCodexCompactAndAPIKeyStayPlain` — a single sign-in's compact relays plain, as it came (this one through the patch's single-account face, which reaches further than the pool — the docs keep that relay for "their backend to handle")

The patch's own test and the compaction sentinels (`TestNativeCompactionPassesTheTrigger`, `TestCodexOwnModelMovesToNextAccount`, `TestCodexOwnModelPassesThrough`, `TestCodexCompactsMagpieModel`, `TestCodexThirdPartyCompactEndpointRejected`) stay green on it — the collisions are exactly those five. My equivalent change (pool branch only, the no-pool relay untouched) collides with the same faces minus the last, and a full gateway-suite run of it shows nothing beyond these and four Windows-environment failures that are already on base. So this is the design question stated in the issue title, not a mechanical slip: should the toggle govern Codex's own models, and the five tests be rewritten with it — or does the binding stand as designed?

**One mechanical gap, demonstrated**: the `/responses/compact` toggle-off face feeds `codexCompact` a body that never got its summary instruction — `codexInputAs(body, true, false)` returns a compaction_trigger-less body unchanged (the trigger is what it turns into the "CONTEXT CHECKPOINT COMPACTION" prompt with `tools: []`), so upstream receives the raw conversation without the instruction, and the endpoint answers 502 "compaction: the model wrote no summary" (run on `cb05dc2d` + `d6a68918`). Converting the body as the trigger path does, or refusing the endpoint as a magpie model's is refused, would both be shapes that work.

**For the design call**: chestnutLeeeee's canary above — a direct upstream accepted account A's native compaction when account B continued — bears directly on the premise the pinning rests on ("another would refuse it"). If the real backend reads another account's seal, the honest options are wider than refuse-or-bind, and the five pinned behaviors could keep standing while the harm goes away differently.

I have a verified variant with the pool branch converting the trigger through two passes (the first `codexInput(body, false)` left untouched for everyone, so today's shapes are kept byte for byte where the toggle is on) and the compact endpoint refused as a magpie model's is; happy to post it if a second shape helps the review.

---
**Source**: reported in #2582; every check above run locally on `cb05dc2d`, not against a real ChatGPT account.

**Not verified**: a real ChatGPT account (three accounts, toggle off, compaction mid-conversation); the GUI toggle row; Codex Desktop's `/compact` against a refused endpoint.

**AI**: written with GLM-5.3-Flash (ZCode); I've read both diffs (the patch above and my equivalent) and can answer questions on them.
