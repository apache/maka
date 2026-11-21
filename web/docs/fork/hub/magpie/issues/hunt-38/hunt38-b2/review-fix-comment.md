Both points are addressed — new commit `bdcbae59`, force-pushed to [`hunt38-b-gw-proxy-shared-outage`](https://github.com/ggbdpq/magpie/tree/hunt38-b-gw-proxy-shared-outage), rebased on current main (`717b69f7`).

**The key is now the exit, not the choice.** `proxyFailed` is keyed by what `netproxy.Resolve` names for the member's own base URL and proxy choice — the same resolution the request's transport makes, which is now one decision in one place: `Func` and `Dispatch`'s per-proxy transports both delegate to it, so the key the sharing uses and the dial a request makes cannot drift. A member whose request resolves to no proxy — loopback (Ollama, LM Studio), a host on the user's own network, one `NO_PROXY` names, or a `direct` setting — resolves to `""` and is never in the map, whatever its `ProxyChoice` says.

**Tests added**, as asked:

| Check | Result |
| --- | --- |
| `TestProxyDownGlobalLeavesALoopbackMemberDirect` — global proxy down, proxied member first, loopback member second | red on the first draft (the loopback member was skipped through the `""` key, the agent given the 502), green now: a's try fails with `proxyconnect … refused`, b is asked and answers 200 |
| `TestProxyDownAsksAMemberOnItsOwnProxy` — global proxy down, next member's own proxy is another exit | asked: its dial fails on its own listener, `Again: 0` |
| `TestProxyDownSkipsSharedProxy` / `TestProxyDownLastNotRetried` / `TestProxyDownDistinctProxiesLastNotRetried` (from the first patch) | still green, `-race -count=3` |
| `TestResolveNamesTheRealProxy` (netproxy) | pins the resolution: loopback direct even with a proxy of its own, the user's own network direct under the global one, a provider's own proxy taken as named; fails with the loopback guard taken out |
| Ablation: `gateway.go` + `fallback.go` restored to `upstream/main`, tests kept | four of the five fail again; restored, green |
| Targeted regression (proxy, account-proxy, plugin-proxy, agent-gone, patience, replan, retry, sink, lane, fallback, first-token) | green; full `internal/gateway` (325.8s), `internal/provider` (89.2s) and `internal/netproxy` suites green |
| `gofmt -l`, `go vet ./...`, `GOOS=linux go vet -tags nogui ./...`, `GOOS=windows go vet ./...`, darwin/linux/windows builds | clean (the known `trayimage` cgo warning aside) |

On the smaller points, as you framed them:

- **The skipped member's `Try`**: left as is for now. The routing contract is that a try enters `Tries` only as it is asked (#2281), and a skipped member isn't asked; it is named in the final error text the agent gets. If you'd rather the Routing page spell it out per member, that's a small follow-up on the trace side.
- **Plugin providers**: untouched, as agreed — a follow-up.
- A resolution error reads as `""` too: the member is asked rather than skipped, so a read that fails fails open.

---
**Source**: reported in #2682; the first draft reviewed by yetone in this thread.

**Red without the fix** (base `717b69f7`): with `internal/gateway/gateway.go` and `internal/gateway/fallback.go` restored and the tests kept, `go test -tags nogui -run TestProxyDown ./internal/gateway` fails:
```
--- FAIL: TestProxyDownSkipsSharedProxy (0.05s)
--- FAIL: TestProxyDownLastNotRetried (0.04s)
--- FAIL: TestProxyDownDistinctProxiesLastNotRetried (0.04s)
--- FAIL: TestProxyDownAsksAMemberOnItsOwnProxy (0.04s)
```
With the fix: `ok`. `TestProxyDownGlobalLeavesALoopbackMemberDirect` was red on the first draft specifically — that failure is what the key change removes.

**Siblings**: `rg -n "forChoice|Proxy = " internal/netproxy` → the decision lived in three places (Func, Dispatch's own-proxy transport, and the new key). All three now go through `netproxy.Resolve`; `EnvWith`/`Describe` untouched (they build env and settings text, not requests).

**When the read fails**: a proxy choice that doesn't parse resolves to `""` — the member is asked, never skipped (fails open); `netproxy.Resolve`'s error path is covered by `TestResolveNamesTheRealProxy`.

**Not verified**: a real proxy outage end to end (the reporter's incident), the plugin host path, Windows GUI.

**AI**: written with GLM-5.3-Flash (ZCode); I've read the whole diff and can answer questions on it myself.
