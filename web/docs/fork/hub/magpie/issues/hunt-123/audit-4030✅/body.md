A patch for option 3, following the reporter's own analysis — the `restLast` partition is what moves a resting account no matter what the routing ordered, and `Rest.Why` already tells the transient rests (`rate`, `other`) from the spent ones (`quota`, `credit`). Credit to @wssz527 for reading that out of the code; this only puts their proposal in.

## Summary

- `provider.Provider.KeepThroughRest` (JSON `keepThroughRest`), off by default: a provider — a pool's accounts, or its keys — may say a transient rest is no reason to move what its conversations answer.
- `restLast` asks a new `candidate.keepsThrough(r)`: with the setting on, a candidate resting out of a **rate limit or a failure that says nothing of why** keeps the place the routing gave it. A rest out of **quota or credit**, a restricted account, and one asked to verify itself still move it, as does every rest of a provider without the setting — none of the current behavior changes for anyone who has not set it.
- The trace row still says the kept candidate rests, so a new conversation still goes to a ready one (`readyForNew`), the Routing page still shows the rest, and `stays` modes are untouched. `probeOne`'s at-most-one-resting-per-request policy and the sink strategies are untouched.
- Set it with `magpie provider pool <id> --keep on` (the pool command's lines say what keep does), or by the JSON field. A save from the GUI's provider editor preserves the value, as it does `capStop` and `capCareful`, so a CLI-set flag is not lost to an edit. The GUI has no toggle of its own in this patch — that and its translations seemed like the maintainer's call to make; the pool-ends box in `app.js` is where it would go.

## Verification

| Check | Result |
| --- | --- |
| `TestPoolKeepsThroughARateRest` (new) | pass — a keeping pool's account resting out of a rate limit or a failure is asked where the routing put it; the trace still says it rests; nothing promotes it past a ready one either |
| `TestPoolStillMovesOnQuotaAndWithoutTheSetting` (new) | pass — quota and credit still move it; so does a rate rest without the setting |
| `TestPoolKeepSaysItsPoolKeepsThroughARest` (new) | pass — `--keep on`, `--keep off`, `--keep maybe` refused |
| `TestAccountSettingsKept` (extended) | pass — kept and cleared on a signed-in account, like the rests' settings (`accountSettings` copies it, the #4738 list) |
| restLast neighbors (`TestRateBackoff…`, `TestBusyModel…`, sink, weighted keys, try-now) | pass, before and after the rebase |
| `go test ./internal/gateway/` full suite (`-tags nogui`) | pass, 825s |
| `go test ./internal/cli/ ./internal/provider/` | pass |
| `go test ./internal/gui/` | one failure, `TestProxyCheckSaysAProxyPassedBy` — fails the same way on a clean checkout of `main` (HTTP 502 from the fixture's proxy, "the proxy asked 0 times"), so it is pre-existing and untouched by this patch |
| `gofmt -l`, `go vet`, `go build` | clean |
| Ablation | reverting `fallback.go` alone turns `TestPoolKeepsThroughARateRest` red ("the resting one moved behind"); reverting `pool_cli.go` alone turns the CLI test red (unknown flag); reverting the `provider` field breaks the build — the tests hold exactly the new behavior |
| Applies to current `main` | `git am -3` on a clean tree at `f24829636` applies and the new tests pass |

## How to try it

```
magpie provider pool <id> --keep on
```

A 1-minute "overloaded" rest then leaves the order alone (the request still falls back within itself if the account refuses again); an 8-hour quota rest still moves it. With two Kimi accounts this should keep the conversation — and its cache — on its account through the seconds-long 429s. @wssz527 you offered to test against your two-account setup; the branch and patch below are ready for it.

## Patch

- Branch: [`fix/4030-keep-through-rest2`](https://github.com/ggbdpq/magpie/tree/fix/4030-keep-through-rest2) on my fork, based on current `main`.
- Head: `c233b744cc3eacd85bef4fa5159d39552e22a743`
- Patch (`git am` format): [0001-gateway-a-pool-can-keep-its-order-through-a-short-re.patch](https://github.com/ggbdpq/magpie/commit/c233b744cc3eacd85bef4fa5159d39552e22a743.patch) — sha256 `5881e052733dc138` (first 16 hex)

## Attribution

Written by GLM-5.3-Flash (ZCode), an AI agent working for ggbdpq. The problem analysis, the `restLast` reading and the choice of option 3 are wssz527's, from this issue.
