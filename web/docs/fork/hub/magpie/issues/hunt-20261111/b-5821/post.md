**Nothing left to fix here** — your follow-up found the switch that already exists, measured it working, and the docs already carry it; the only open item is the nicer pool you marked "would still be nice", which is a feature to ask for on its own if an HTTP/1.1-only provider ever isn't an option for someone.

## Where the option is documented

`docs/subsystems/providers-accounts.md` ("A provider the user added may be held to HTTP/1.1"): the provider editor's **"HTTP version" row under Advanced** (shown while the address is `https://`), the same providers `InsecureTLS` takes, the per-host scoping (`Provider.Via` → `netproxy.WithHTTP1`, so only that provider's own hosts go HTTP/1.1), and what happens without it — a TLS record error on an HTTP/2 reply moves that host to HTTP/1.1 for 6 hours. Introduced in `ee91d86ea`, which was in your v0.1.3332, as you found. The same page's HTTP/2 section (:370) lists every exception to the shared-transport rule.

So the report's ask "it might be worth mentioning the option in the docs" is already met where a provider's settings are documented; nothing to add there.

## On option 2 (an HTTP/2 pool that opens a second connection when streams starve)

Worth keeping as its own feature request if you ever hit a provider that must speak HTTP/2: the measurement you took (shared conn p90 174.5 s vs 5.0 s) is exactly the evidence such a change would need, and `x/net/http2`'s `MaxConcurrentStreams`-only dialing is the shared root cause. Until then, `"http1": true` is the answer, as you concluded.

## Verification

| Check | Result |
| --- | --- |
| Option exists at the reporter's version | `ee91d86ea` predates v0.1.3332 (reporter's own follow-up) |
| Documented | `docs/subsystems/providers-accounts.md`:374 — editor row, scoping, tests (`TestHTTP1AskedOnlyItsHost`, `TestHTTP1OwnProviderOnly`, `TestProviderSaveHTTP1`) |
| Reporter's own A/B | 16×1.1 MB workers: TTFT p90 174.5 s → 5.0 s, probes 7.6 s → 0.7 s, zero errors |
| Upstream regression risk | none from this issue — no code change made or needed |

**Source**: docs/subsystems/providers-accounts.md (:370, :374), internal/provider/provider.go (`HTTP1` field) at upstream/main `036b69154`.
**Not verified**: nothing beyond the reporter's own measurements — this issue needs no code change to close.
**Attribution**: AI-written analysis; I can answer questions on it myself.
