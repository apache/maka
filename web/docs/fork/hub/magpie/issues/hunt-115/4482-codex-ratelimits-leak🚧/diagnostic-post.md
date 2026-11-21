Triage note — I picked this up to work it and am yielding to @crayonlu's branch (`codex-lead-events`, commit `1f6c5e21`, three files): it is correct, minimal, and cherry-picks onto today's `main` with no conflicts. What follows is an independent check of the report and of that branch, so it can be merged or ported with confidence.

**The report, on current main (`9d08993c`)**

- `passthrough` hands the client what the ChatGPT backend sent: `codexLimitsTap` (`internal/gateway/codex_limits.go`) reads `codex.rate_limits` out of the tapped body for the account's windows, and the reply goes on as it came — nothing on the way out drops the backend's own events for a client that isn't Codex.
- The events reach the client's stream by two transports, and both land in the same write chain. A plain HTTP reply carries them as leading SSE events; the backend-socket transport (`internal/gateway/codex_socket.go`) re-inserts the same two frames at the head of the body it hands the relay. Either way they leave through `passthrough`, where failover has long classified a `codex.` event as `eventLead` (`internal/gateway/fallback.go:3535`) — failover can ignore them; a typed client cannot.
- A Responses client with a typed event enum has no name for `codex.rate_limits` / `codex.response.metadata`, so the turn dies at the first one — the report's `unknown variant codex.rate_limits` from `async_openai`'s `ResponseStreamEvent`. The backend sends them intermittently, which is why the loss looks like a flaky upstream.

**Review of the branch**

- Cherry-picking `1f6c5e21` onto `9d08993c` is clean: its base (`0fcb3acb3`) is 515 commits behind now, auto-merge, zero conflicts, the same 172 insertions.
- The guard is the exact pair `codex_own_v1.go` already uses to tell Codex's own request apart (`internal/gateway/codex_own_v1.go:39`, `!fromCodex(r.Header) && agentOf(r) != "codex"`): a Codex `User-Agent`/`originator` and a gateway key minted for the codex agent keep every event, everyone else gets the reply without them.
- It sits last in `passthrough`'s write chain, after `sniff.write`, so the quota tap and failover's classification still see the upstream bytes — only the client's copy loses the events.
- The drop rule is the whole `codex.` namespace (by the `event:` name, or the data's `type` where the stream names none), not just the two events known today, so a future backend-side `codex.*` event is covered too.

**Sibling sweep**

- The WebSocket route (`GET /v1/responses` + upgrade, `internal/gateway/responses_ws.go`) is a remaining exposure this fix doesn't reach: `socketTurnWriter.headerFrames()` synthesizes `codex.response.metadata` and `codex.rate_limits` from the reply's own headers and sends them to whoever is on the socket, with no client guard — ahead of a streamed turn and in `finish()` for a whole-reply turn. The relayed upstream events themselves are covered by the branch (each socket turn is served through the gateway's POST path with the client's own headers, so the new filter applies), but the synthesized frames would end a foreign typed WS client's turn the same way. Nothing in this report rides that route (Grok Build reads the SSE), so it reads as latent rather than urgent; noting it here so it isn't lost.
- Nothing else hands the backend's `codex.*` namespace to a client: the other tidies in the chain never emit `codex.`-named events, and the reply's `x-codex-*` headers are plain headers a typed client ignores.

**What I ran** (on `9d08993c`, macOS arm64, Go 1.25.5, tests under a temp `HOME`)
Command | Result
--- | ---
cherry-pick of `1f6c5e21` onto `9d08993c` | applies clean, no conflicts
`go test -tags nogui ./internal/gateway/ -run TestCodexLeadEventsStayWithCodex -count=1` | ok
same with `-race` | ok
ablation: `gateway.go` back to upstream, the branch's test kept | red on both foreign clients — `event codex.rate_limits there=true, want false`, same for `codex.response.metadata`; the Codex CLI case stays green
`gofmt -l` on the three touched files | clean
`go vet -tags nogui ./internal/gateway/` | clean
`go test -tags nogui ./internal/gateway/ -count=1` (whole package) | ok (546s) — every test in the package passes with the branch at this base

**Not verified**: against a real ChatGPT account (a second sign-in can rotate the live refresh token, as the reporter said), cross-platform vet and builds, and suites outside `internal/gateway`.
