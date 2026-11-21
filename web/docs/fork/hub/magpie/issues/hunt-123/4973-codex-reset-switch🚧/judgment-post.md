**Verdict: working as designed — one account, two routing paths.** Thank you @xiaofei-lee for an exceptionally precise report (the timeline cross-checking app.log against the rollout JSONL is exactly what settled the causality question). Everything you saw follows from one fact: at ~16:54 magpie started serving your `gpt-6.1-sol` turns **through its account pool instead of relaying them as Codex sent them**. All three display dimensions changed at once because each of them records *which path a turn took*, and the served model stayed the same because both paths end at the same ChatGPT backend with the same account. Verified at current `main` (69eb93e0a); the relevant code is identical in 0.1.2693, the version running at 16:54.

## What triggered the switch

Your weekly window filled up. A reading where ChatGPT says `rate_limit.allowed: false` with no credits to fall back on (Plus has none) marks the account held (`codexHeld`, `internal/provider/subscription_usage.go:1169`), and once that reading is known, `codexAccounts` (`internal/gateway/codex_backend.go:796`, added in 34b2dd9b7, shipped in 0.1.2693) serves an own-model turn through routing as `codex/<model>` **without waiting for a Codex restart** — before that fix, a used-up sign-in greyed Codex's Send until the app was restarted. Independently, the agent-wiring takeover (#540, `internal/agent/codex.go:1728`) can rewrite the Codex config's model to `codex/<model>` for the same reason. Either way: same account, now reached through magpie's account pool rather than relayed as-is.

## Why the reset log followed 4 seconds later (your timeline was right)

You correctly noted the first `codex/…` request (16:54:19) *precedes* the reset log (16:54:23) — the reset did not cause the switch. It's the other way around: the switch routed the turn into routing, routing saw its only candidate's week used up, and the auto-reset you enabled spent one of the account's resets and asked again ("2 windows started again" = both usage windows restarted; `AutoUseCodexReset` re-reads the week before spending, one per week). The reset and the switch are both effects of the same cause: the week window was used up.

## Why each display changed

| Dimension | 16:08 (relay as it came) | 16:54 (through the pool) |
|---|---|---|
| requested model | `gpt-6.1-sol`, the id Codex itself sent | `codex/gpt-6.1-sol` — the pool model id the gateway (or the rewritten Codex config) names; it's the real, different route the request went down, not a relabel |
| seat | `OpenAI · Codex's own sign-in` — the fixed label for a turn relayed with the sign-in's token as Codex sent it (`codex_backend.go:1041`) | `Codex · <email>` — a routed turn's seat is the pool account that answered (`trace.go:533`) |
| upstream host | `Codex · chatgpt.com` (bare host of the relayed base URL) | `Codex · chatgpt.com as <email>` (`Provider.Where()` = `host + " as " + account`) |

The Usage grouping splits the same way because rows are grouped by provider + answering account, and per #2297's semantics existing rows are never rewritten — so the pre-16:54 history stays under its old key and new rows start a new one. That is why you see two `gpt-6.1-sol` rows and both entries under Accounts & Keys while only one ChatGPT login exists. Your whole-window estimates: each row's group sums correctly on its own, but any estimate spanning 16:08→16:54 must add the two groups together — the ledger does not merge them retroactively.

## Your question 4 — reasoning summaries

The two paths send equivalent requests upstream (same account, same token, same chatgpt.com backend; the body is only re-addressed with the pool model id), so the appearance of readable `summary_text` (bold headings only) is upstream-side variation, matching the upstream issues you already found (openai/codex#58548, #38160). Nothing in magpie's routing path alters or strips reasoning summaries — but you're right that without captured raw HTTP this can't be proven from either side alone; the timing correlation with the switch is coincidence of the same underlying event (the week refilling at the reset), not evidence of causation.

## On your suggestion (explicit "native sign-in" vs "via Magpie account" labels)

Reasonable — the information exists in the data (seat kind and provider account), it's the labeling that doesn't distinguish "same account, different path" for a single-account setup. Leaving it to the maintainer as a UX suggestion; nothing here needs a code fix.

No defect: same account, same served model, two accounting paths for two genuinely different routes, plus the auto-reset doing what you asked it to.

AI use: analysis performed with AI assistance; all code reads above were run locally at 69eb93e0a.
