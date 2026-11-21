This one is a design decision rather than a bug I can fix on my own say-so, so here is the analysis and the evidence for whoever makes the call.

**What MAGPIE_TRUST_PROXY means today.** It is not a forwarding-header flag; it is the "a proxy here does the entry checks itself" flag. `proxied(r)` (internal/gateway/lan.go:977) treats a request carrying a forwarding header as *someone else's* — answered only while magpie is shared, with an enabled key — and `MAGPIE_TRUST_PROXY=1` says "a proxy here signs its clients in itself, and keeps what it forwards local, as before", so those requests count as local for who may call. `mtls.go` uses the same flag for a proxy that checks client certificates itself, and `oneport.go` pins that the flag doesn't change the page port's rule. Nothing in it today says "the proxy's forwarded headers are true".

**Why clientIP never reads the headers.** The usage row's Source IP is `clientIP` (internal/gateway/client_ip.go): "the connection's own (peerAddr), never a forwarding header, which anyone can write". That is a recorded anti-spoofing decision, and the reporter's diagnosis of the mechanics is right — behind a proxy every row shows the proxy's address — but the reason is that the ledger's address is the one thing a client cannot lie about, because it isn't asked.

**The reporter's patch, verified.** `KamijoToma:feat/trusted-proxy-client-ip` (head `ae23da3d9548`, 2 files; the commit link in the issue names an older head of the same branch) makes `clientIP` read `X-Real-IP`, `Cf-Connecting-IP`, `True-Client-IP`, then `X-Forwarded-For` (leftmost valid entry), only when `trustProxy()` is set, falling back to the peer address. I built the branch: `go build ./internal/gateway/` passes, `gofmt`/`go vet` clean, its `TestUsageRowsKeepTheClientsAddress` passes. The opt-in shape is right — nothing changes for anyone who hasn't set the flag.

**The trade the maintainer is being asked to make.** The trust behind `MAGPIE_TRUST_PROXY` for authorization is "only my proxy reaches this port". The trust the patch needs for attribution is "my proxy gives me forwarding headers no client of mine wrote" — a different shape: a proxy that passes an inbound `X-Forwarded-For` through without scrubbing lets any client with a gateway key write its own Source IP on the Usage page (leftmost is the client-claimed origin; a scrubbing Caddy/nginx that overwrites `X-Real-IP` makes the patch read the proxy's value, which is what the reporter wants). Whether forgeable attribution under an opt-in flag is acceptable — or wants the rightmost entry, a fixed header list, or a separate variable — is the operator-facing call, and it is the maintainer's to make, not mine.

**Verification.**

| Check | Result |
| --- | --- |
| `go build ./internal/gateway/` (branch) | pass |
| `gofmt -l` / `go vet ./internal/gateway/` | clean |
| `TestUsageRowsKeepTheClientsAddress` (branch) | PASS |
| Same build on current `main` | the flag's three uses are `lan.go`, `mtls.go`, `oneport.go`; none touches `client_ip.go` |

**Source**: branch https://github.com/KamijoToma/magpie/tree/feat/trusted-proxy-client-ip (head `ae23da3d9548`); flag semantics read at `upstream/main` `025123431` (lan.go:975-988, mtls.go:95, oneport.go:64, client_ip.go:6-11).
**Siblings**: `proxied()` is the only other reader of the flag's meaning; `withoutClientIPs` strips these rows from the remote usage API, so the forgeable value stays on the operator's own machine — that bounds the blast radius of accepting the patch.
**When the read fails**: with the flag unset the patch falls back to the peer address; with it set and no valid header, likewise — nothing about the ledger empties out.
**Not verified**: behind a real Caddy/nginx/Docker bridge with the flag set — I have no such deployment here; the reporter's own environment showed the symptom.
**Attribution**: the patch is KamijoToma's; I verified it compiles and its test passes, and wrote this analysis. AI-written; I've read the whole diff and can answer questions on it myself. Please keep the author (`KamijoToma`) or add `Co-authored-by: KamijoToma <KamijoToma@users.noreply.github.com>` if it lands.
