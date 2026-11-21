A first try on Antigravity through a local proxy stalls ~20.5s and fails `502 unexpected EOF`, then magpie's own retry serves at once on a new connection — the report reads that as the connection pool reusing a connection the proxy's tunnel had already dropped, meeting the 20s health-check ping. A local reproduction says the stall is real but the reuse window is not what it rides on, and the 20s is.

## Measured, on a real HTTP/2 stand-in

The feedback loop: a real HTTP/2 vendor, a raw byte-pump in front of it (the tunnel), a client transport with magpie's exact settings (`HTTP2: {SendPingTimeout: 20s, PingTimeout: 10s}`, `IdleConnTimeout: 90s`), and a switch that makes the tunnel drop the far side silently the way a NAT or a relay session does — bytes in, nothing out, no FIN. With `GODEBUG=http2debug=1`:

- The health check does fire with no request in flight: `sending health check` 20s into an idle connection, whatever the stream count — the report's reading that Go's http2 client sends no PING while it holds no active streams does not hold on Go 1.26.8.
- A connection whose path dies while it is idle is therefore pinged within the idle itself and dropped at PingAfter+PingTimeout (30s), removed from the pool; the next request dials a new connection and answers at once. There is no 50–90s zombie-reuse window under these settings: a tunnel dead throughout an idle never survives to be reused.
- What reproduces the report is the death arriving around the write: a turn written onto a connection whose path dies under it gets no frame back, and its failure comes only from the next health check — the ping reaches the dead tunnel and the tunnel's own end closes (`unexpected EOF`, the report's error, at ~PingAfter), or the ping goes unanswered and the connection is closed for a lost ping at PingAfter+PingTimeout. Either way the turn rides out the whole interval to the next scheduled probe, then magpie's 1s retry dials fresh and serves: the report's 21,499–21,899ms `retried_ms` is PingAfter + the write + the poke + the retry wait, and the code the report quotes is the right code — only the story around it differs.

One honest gap: with idle health checks cycling at a ~20s cadence, the probe that finds the death should land a phase-dependent 0–20s after the write, yet the report's six samples sit in a 400ms window at ~20.5s. The reconciliation I could not verify locally (no Antigravity account): magpie talks to the same host beside the agent's turns — quota and model traffic — and a reply from it just before the turn resets the last-frame clock, putting the next ping ~20s after the turn's write every time.

## Fix

The stall is the discovery latency of a dead path, and the read-idle ping is its only probe, so `netproxy.PingAfter` goes 20s → 10s: a turn in flight on a path that died now rides out at most ~10.5s instead of ~20.5s. The budget `PingAfter+PingWait` stays ≥20s, which is the margin a body under `uploadBytes` needs on a slow uplink — a ping queued behind the body is answered only after its last byte (#3909): 64KB at about 3KB/s still fits. `PingWait` is untouched.

The report's other two suggestions I did not take, with the measurements above as the reason: an `IdleConnTimeout` of 30–45s under a proxy evicts connections whose staleness the ping already settles within 30s of idle, and does nothing for a death that arrives after the write; a health check before reusing an idle connection has no hook in the stdlib transport, and the reused connection was ping-alive shortly before the write anyway. magpie's retry after 1s is already as instant as its own machinery makes it; the 20s dominated.

## Verification

| Check | Result |
|---|---|
| `go test -tags nogui -count=1 -run 'TestRequestOnAHoledConnectionFailsAtThePing\|TestPingAfterSizesTheDeadPathDiscovery' ./internal/netproxy` | ok (mechanism: a turn on a holed connection fails within PingAfter+PingWait at scaled timings and a retry dials its own connection; sizing: `PingAfter 20s; want 10s` red before, green after) |
| RED before the fix | `TestPingAfterSizesTheDeadPathDiscovery` fails with `PingAfter 20s; want 10s` |
| Ablation: `netproxy.go` from the parent db7c57670, tests kept | the sizing test red again with the same line; green with the commit restored |
| `go test -tags nogui -count=1 ./internal/netproxy`, new tests at `-race` and `-count=3` | ok |
| `go test -tags nogui -count=1 ./internal/...` | ok apart from four reds that are red alone on the parent commit too (`TestMothX`, `TestProxyCheckSaysAProxyPassedBy`, `TestHostToldTheGatewayAddress`) or green alone (`TestCodexPoolSaysTheClientsVersion`, a known full-suite flake) |
| `go test -tags nogui -count=1 -run 'TestSilentHTTP2ConnectionIsDropped\|TestUploadStillUnderwayIsNotCutByHealthPing' ./internal/gateway` | ok (the #2843 and #3909 behaviors over the new value) |
| `gofmt -l`, `go vet -tags nogui ./internal/netproxy ./internal/gateway` | clean |
| `go build -tags nogui` darwin / GOOS=linux / GOOS=windows | ok |

Not verified: no Antigravity account, no Mihomo, no SS/IEPL line here — the stand-in's tunnel dies silently, but the report's exact phasing (the constant ~21.5s) rests on the same-host-traffic hypothesis above, and the poke-EOF the report saw (the tunnel answering the ping with a close) is only inferred from its numbers, my shim being the silent kind that takes PingAfter+PingTimeout instead. The 10s value is a trade, not a derivation: lower still would eat #3909's budget for bodies under `uploadBytes` on slow uplinks, and the maintainer may prefer another split.

---

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

<details><summary>patch: netproxy: the health check pings a silent connection after 10s, not 20 (#4936) — git am applies it as is; SHA-256 first 16: e4f83f9791b2f9c8</summary>

```
PENDING_PATCH
```

</details>

Branch with the commit: [fix/4936-proxy-idle-h2-eof](https://github.com/ggbdpq/magpie/tree/fix/4936-proxy-idle-h2-eof) (head `7c3aec7dfce18c623f9e7fc7e7c313331bfcff41`).
