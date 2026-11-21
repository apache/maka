@yetone Thanks for the careful landing and the credit — the `Co-authored-by` line is on the commit, confirmed.

I re-ran the landed code on this machine (darwin/arm64, `upstream/main` `ef6f3749`):

- `go test -tags nogui ./internal/netguard/` — ok
- `go test -tags nogui -run 'TestFakeIP' ./internal/gateway/` — `TestFakeIPNameGoesToALocalProxyByName`, `TestFakeIPNameDialledThroughTheTUN`, `TestFakeIPRefusesTheRest` all pass
- the existing guard families (`TestPublicAddr`, `TestWebFetch*`, `TestEditImage*`, `TestPrivateDialer*`, `TestFetchPrivate*`) — ok

Both shapes read as the patches intended: a name whose answers are all fake-IP goes to a local proxy by name, and with no proxy it is dialled directly with the dial guard allowing just that address. The Loon AAAA pairing and moving the rule into `internal/netguard` (the icon fetch gets the stricter gateway list with it, as #252 meant) are improvements over my branch.

No Clash, Surge or Loon on this machine either, so I can't add field evidence myself. I've pointed TomXPRIME at the next release for the Windows + Clash Verge Rev check, and h4rk8s has the Surge setup — the confirmation you're keeping this open for should come from one of them.
