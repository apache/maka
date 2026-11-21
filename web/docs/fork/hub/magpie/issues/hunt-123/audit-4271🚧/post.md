Thanks for the sharp report, @unisong — the proposal was followed as written, and the middleware-codex-history example was exactly the case that read wrong.

## Summary

`State` gains `Changed` (`changed`): the calls whose hook changed something, counted where the call's outcome is already told. The Plugins row now says it when it differs from `calls` — "12,345 calls, 12,340 changed, 0.9 µs each" — so a middleware that passes some requests through unread no longer reads as if it had acted on all of them.

A change is: a returned body (`onRequest`, `onProvider`, `onEvent`, `onResponse`), a dropped event (`onEvent` returning `null`), a turned-away request (`ctx.reject` in `onRequest`) and a passed-over account (`{skip: true}` in `onAccount` — your list didn't name it, but it acts the same way, so it counts). A call whose hook returned `undefined` and one that failed (thrown, timed out, invalid return, or a `null` where dropping isn't allowed) are calls, not changes, as you proposed. `avgMicros` still counts the whole call. The count sits in the same branches that already switch on the hook's return (`Request`, `Tried`, `Account`, `writer.event`, `writer.finish`), so the hot path adds one atomic add on a change and nothing on a pass-through.

The row keeps the old string when every call changed something, in all five languages of `i18n.js`; `docs/subsystems/gateway-middleware.md` says what `Changed` counts. `magpie plugin` shows hooks and load errors only (the stats live in the gateway process), so the CLI row needed nothing.

## Verification

| Check | Result |
| --- | --- |
| `go test -tags nogui -count=1 ./internal/middleware/` (full package, incl. new `TestChangedCounts`) | ok |
| `node --test internal/gui/tests/plugin-middleware.test.cjs` on chromium (en + zh, row text asserted) | 12 of 12 ok |
| `gofmt -l`, `go vet -tags nogui ./internal/middleware/`, `go build -tags nogui .` | clean / ok |
| Ablation: the seven `m.changed.Add(1)` lines taken out | `TestChangedCounts` and `TestOnProvider` red (`Changed:0`), restored: ok |
| Ablation: `mwLine` taken back to the one-line stats | the row text test red in en and zh, restored: 12 of 12 ok |

`TestChangedCounts` walks one middleware with all five hooks: a pass-through is a call and no change; a returned body, a reject, a `{skip: true}` account, a dropped event and a whole-reply rewrite are one change each; a thrown call is a failure and no change.

## AI use

Written by GLM-5.3-Flash (ZCode), an AI agent, at ggbdpq's direction; ggbdpq reviewed and is accountable for it.

## Branch

- Branch: [`fix/4271-plugin-count`](https://github.com/ggbdpq/magpie/tree/fix/4271-plugin-count) on [ggbdpq/magpie](https://github.com/ggbdpq/magpie) (patch attached as `git am` format, per the no-PR policy)
- Head: `68caecbbafb2eebb6ff116492515a378e9e3aa4a` (rebased on `upstream/main` `775630dac`), verified on the remote with `git ls-remote`
- Patch applies clean with `git am -3` (tested); sha256 head `a56ab6ca22422dc3`

Fixes #4271
