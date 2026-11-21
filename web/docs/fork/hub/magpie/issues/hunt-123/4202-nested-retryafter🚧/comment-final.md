**Verdict: already fixed on current main — by three mechanisms that landed after 0.1.1290, the last of them (c37b8b659, the `Rest.there` marking) being exactly the nested case this report describes. I could not reproduce the stall on main; what I could do is pin the 429 face of it in the package, since the tests that came with c37b8b659 only pinned the 402 form. No product change needed; one test added.**

## Reading the report against the code

The rest your downstream saved at 14:48 — `{"why":"quota","status":429,"until":"15:48:26","by":"retry-after"}` on `group/claude-sonnet-5.5` — is 60 minutes flat, which is `longestWait` (routing.go): the most a Retry-After is trusted. It reads that way because the remote magpie passed its own `Retry-After: 3600` on with the refusal (`keepRetry`), and the 429's words ("You've hit your session limit · resets 3pm") name a plan used up (`plannedWords` → `failQuota`) but no machine-readable reset time, so `restAfter` fell to the header. An hour it was out, then.

On 0.1.1290 that rest had no way to end but the clock:

- `quotaHeld` (fallback.go, at that version) held every candidate resting out of quota and replayed the first one's refusal — with no re-check trigger of any kind. Your 15:24 log line — `… not asked again before 15:48 UTC+8`, answered in 45 ms with no upstream call — is that replay verbatim.
- The remote magpie's rest landed on the model alone (`remoteModelRest`, in 0.1.1290 already), but nothing read that as "this is another computer's hold": it was held to `Until` like any key's.

And the 15:28 self-healing is the ordinary path: the one request that went through (3.08 s, `message_stop`) called `servedCandidate` → `clearRest`, which deletes the rest on any answer. Nothing mystical — one request happened to be sent at 15:28 (or the remote's own hold ended and it answered), and the success lifted the stale rest.

## What current main does instead

Three commits, each fixing one half of the stall, all after 0.1.1290:

| Mechanism | Commit | In release | What it does for this report |
| --- | --- | --- | --- |
| `Rest.first`/`askAt` (`asksAt`) | be7f17467 | v0.1.1492 | a quota rest whose length magpie only guessed is re-asked after one refusal and a minute on, so a wrong hour-long guess can't freeze the seat |
| background `restProbe` | 0daf36332 | v0.1.1961 | a key resting after an outage that names no time is asked (its vendor's model list) a minute into the rest, then 2/5/10-minute steps, and the rest lifts when it answers |
| `Rest.there` (`quotaHeld` passes it by) | c37b8b659 | v0.1.2151 | a remote magpie's out-of-quota refusal is **never replayed here without asking it** — that magpie holds its own rests, and what it serves under a name can change at any moment (its own member's quota comes back, or its group moves to another vendor) |

The third is the one your scenario needs: on main, the downstream asks the remote at 15:24 (it doesn't replay), the remote — whose own hold respects the official reset — answers, and the client goes through. c37b8b659 is also what issue #4317 was closed by; this report is the 429-with-Retry-After face of the same rest.

## The test

`internal/gateway/remote_magpie_held_test.go` gains `TestRemoteMagpie429IsAskedNotReplayed`: a remote magpie provider whose group's lone member answers 429 `Retry-After: 3600` with your report's words ("Magpie: Claude Code: You've hit your session limit · resets 3pm (Asia/Singapore)"); two requests take the refusal, then the remote recovers (the official reset came), and the next request must be **asked** (exactly once) and answered, not replayed the stale 429. The model is named `group/claude-sonnet-5.5` and answers on Anthropic's Messages, as the report's chain does.

- Ablation (the `r.there` term lifted from `quotaHeld`'s guard): the test fails with the reporter's symptom word for word — `429 … You've hit your session limit · resets 3pm (Asia/Singapore) (out of its allowance: not asked again before 08:29 UTC+8)`, the remote asked 0 times.
- As committed: green.

## Verification (magpie 667317159, darwin/arm64)

- `go test -tags nogui -count=1 -run '^TestRemoteMagpie429IsAskedNotReplayed$' ./internal/gateway` — ok; `-race` ok.
- `go test -tags nogui -timeout 25m ./internal/gateway/...` — ok, 644.9 s, no failures (the pre-existing reds named in the tracker did not fire in this run).
- `gofmt -l` on the touched file: clean; `go vet -tags nogui ./internal/gateway/`: clean; `go build ./...`: builds (46 pre-existing CGo `-Wenum-conversion` warnings in `internal/gui/dockflap_darwin.go`, unchanged by this patch).

Honest caveats, matching the report's own: no reproduction on 0.1.1290 was attempted (building that old tree to confirm the original stall seemed not worth it — the mechanism is fully explained by the diff between the versions, and the report's own timeline is self-consistent with it); the "resets 3pm" wording is only read as a reset time by `resetsWritten`'s strict forms (a vendor writing "resets at 2026-10-29 15:00:00 +0800"), so Claude's prose "· resets 3pm" is not — it falls to the Retry-After, which is exactly what the report's saved rest shows.

## Patch

Single test-only commit, author `ggbdpq`, AI-written (GLM-5.3-Flash via ZCode):

```diff
⇢ attached as git am patch (see issue attachments / branch below)
```

- SHA-256 (first 16): `1db634d526d64332`
- Branch: https://github.com/ggbdpq/magpie/tree/fix/4202-nested-retryafter (head 336926e944d854fb98a29ce764c29caf41e85498)
