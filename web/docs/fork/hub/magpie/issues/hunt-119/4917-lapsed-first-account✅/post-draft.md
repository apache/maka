A provider's row said its list had fallen back whenever its **first account's** list had, even when another account of the same provider told the list fine.

## Symptom

As reported: a Kiro oauth the vendor turned away (lapsed, hidden) sits under the provider's own key in `plugin-auth.json`, the API key in use beside it. The provider's models are the accounts' union, so the list itself is told (on current `main`; on the build this was filed against, the row also shrank to the plugin's default) — but the row kept saying `fellBack: true` with the lapsed account's list error, and with that row:

- `keepListed` took the provider for fallen back and put the last list told over the fresh one: a model the vendor added never showed up and one it dropped stayed listed, for as long as the lapsed account stood first (the workaround of removing it un-freezes this, as the reporter found);
- the hourly relist treated the provider as if its list had never been read, so the picks of models the vendor no longer lists were never set aside;
- `magpie plugin list` said the provider fell back.

## Root cause

`internal/plugin/host.js` asks the provider's own list of its first account (`info(id, undefined)` → `accountsOf(readAuth(), id)[0]`), and `rowOf` took the provider-level `fellBack`/`listError` from that one listing. Since the accounts' lists are unioned into the provider's (`566ae09db`), the provider's list falls back only when **no** account tells a list of its own — the first account alone failing doesn't say the provider fell back.

## Fix

`rowOf`: `fellBack` is now `p.fellBack && own.every(q => !q || q.fellBack || q.failed)` — the provider fell back only when every account's listing fell back or failed; `listError` follows it. Each account's own entry keeps its honest `fellBack`/`listError`. The Go side (`keepListed`, `pluginListedIDs`, `keptListed`) reads only these provider-level fields and needs no change: keep-last-good still applies where every account fell back.

## Verification

| Check | Result |
|-------|--------|
| `TestLapsedFirstAccountKeepsTheProvidersList` (internal/plugin, new) | fails on the parent (`a lapsed first account said the provider fell back`), passes here; with the vendor's list changed while the first account stays lapsed, the provider's list follows (`fake-newer` in, `fake-extra` out) |
| `TestFallenBackListSaysWhy`, `TestFallenBackListKeepsTheLastOne` (keep-last-good family) | pass — a provider whose every account falls back still keeps the last list told |
| plugin-related suites of internal/provider (`-run 'TestPlugin\|TestRelist\|TestDropGone\|TestFallenBack\|TestKiro'`), fetchedCount of internal/gui | pass |
| `go test -tags nogui -count=1 ./internal/plugin` | passes except the pre-existing `TestHostToldTheGatewayAddress` (fails on the parent too: `after the port moved … MAGPIE_ADDR=127.0.0.1:<old>`) |
| `go test -tags nogui -count=1 ./...` | 82 packages pass; 5 failures, all pre-existing on the parent or known full-run flakes, each re-run alone on a clean parent worktree: `TestMothX` (agent), `TestEveryRouteHasACommandOrIsNamed` (cli), `TestProxyCheckSaysAProxyPassedBy` (gui), `TestHostToldTheGatewayAddress` (plugin) fail there too; `TestCodexPoolSaysTheClientsVersion` (gateway) passes alone |
| `gofmt -l`, `go vet ./...`, `GOOS=linux go vet -tags nogui ./...`, `GOOS=windows go vet ./...` | clean (two pre-existing cgo `-Wenum-conversion` warnings in internal/gui, untouched) |
| `go build` darwin, linux (`-tags nogui`), windows | pass |
| ablation: the `rowOf` change reverted by hand, test kept | the new test fails again; passes once restored |

## Not verified

- Not tried with the real Kiro plugin and real accounts: the repo's fake test plugin stands in, shaped as the report's `plugin-auth.json` — a lapsed oauth under the provider's own key whose models hook throws (`HTTP 400` in the report, a thrown refusal in the test), a live API key beside it whose hook lists the vendor's models.
- The reporter's first two expectations are met on current `main` by the union itself (the list and the "Fetch models again" count follow the accounts that list fine); this patch stops the first account's failure from masking that — the row, `keepListed` and the relist. `magpie plugin list` still names the first account (`accountId` stays "the one kept under its own id", as the accounts' list documents); the accounts page and the provider's serving list follow the account in use.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

<details><summary>patch: plugin: a lapsed account kept first doesn't say the provider fell back (#4917) — git am applies it as is; SHA-256 first 16: 080fbc3f462f20c3</summary>

```
(patch 正文回填)
```

</details>

Branch with the commit: [fix/4917-lapsed-first-account](https://github.com/ggbdpq/magpie/tree/fix/4917-lapsed-first-account) (head `812d1aa15`).
