**Symptom** — as reported: a request carrying `web_search_20250305` to a ZCode plugin model (`zcode/GLM-5.3`) answers 200 with `server_tool_use: 0`, the model saying it has no search tool, while a custom GLM provider with `search=yes` searches on the same machine. `magpie provider set zcode search=yes` was taken by the CLI and had no effect.

**Minimal repro** — offline, on `de7953e3b`: the repo's fake plugin as a ZCode-shaped provider (GLM-5.3 on Anthropic's API, no `searches` in its config hook — the plugin's own word is empty, as the report's plugin metadata shows), a vendor recording what it is offered, `search=yes` saved by hand as the CLI saves it, then a non-streaming `/v1/messages` request declaring the tool. The vendor is asked with no tools at all; `Find` no longer knows `searches` either.

**Root cause** — `accountSettings` in `internal/provider/provider.go`, the one list a signed-in account's settings go through both ways (the #4738 list), copied none of `Searches`: `Save` wrote providers.json without it and `withPicks` read none back, so the built provider kept only what its plugin declared (`pp.Searches`, #2027). On a plugin that declares nothing, `searchesItself`'s `saidTo` stays false on the Anthropic API, so the translated request was built without the web search tool — "only a provider that searches by itself is asked to". The upstream runs the tool itself (bigmodel's Anthropic API, as the working `glm` provider proves); only magpie was never told.

**Fix** — `accountSettings` carries `Searches` as a one-way merge (`a.Searches || pk.Searches`): the user's `search=yes` is kept, a `search=no` takes back only the user's yes, and a plugin's own `searches` is never read as false for one saying nothing. Plus `internal/gateway/zcode_search_test.go`: the repro above as a test, asserting the vendor is offered the client's web search.

**Verification**

| Test | Without the fix | With the fix |
| --- | --- | --- |
| `TestZCodePluginSearchYesKeepsTheTool` | FAIL: `search=yes was not kept on the plugin's provider`; `the vendor was offered null` | PASS |

`go test -tags nogui -count=1 ./internal/provider/` (102s) and `./internal/gateway/` on darwin/arm64 at `4073c3652` — the gateway run failed only the pre-documented `TestCodexPoolSaysTheClientsVersion` flake, green on re-run, my test green within the same run; the new test also passes with `-race`; `gofmt -l` clean; `go vet -tags nogui ./...` clean (the `internal/gui` cgo warning on darwin is pre-existing on the untouched gui package), `GOOS=linux` / `GOOS=windows` vet clean for both touched packages; `go build -tags nogui .` on darwin, linux and windows. Ablating the one line on its own turns the test red again — `search=yes was not kept`, the vendor offered no tools.

Who else reads `Searches`, checked and left as is: `searchRank` still forces it off before ranking (a relay said to search is spent only when named, #359); `namedSearcherRank` and `RelaysSaidToSearch` list a `search=yes` provider for hand-naming only; `searchesItself`'s account branch reads `saidTo` for a plugin provider only (`IsPlugin`), so built-in Claude, Codex and Copilot sign-ins behave as before; the GUI's provider editor saves through the same `Save`, so its tick is kept now too (it was dropped the same way before); backups and dav sync pass `searches` through unchanged.

**Not verified**: no real ZCode account against bigmodel's production endpoint — the reproduction is the package's stand-in plugin with a fake vendor, offline. The report's response shape (200, no `server_tool_use`) is matched by the test's before-fix state, not by a live call.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

<details><summary>patch: provider: keep a signed-in account's search=yes (#4402) — git am applies it as is; SHA-256 first 16: 4d7f0cd75ffac113</summary>

```
PATCH_PLACEHOLDER
```
</details>

Branch with the commit: [fix/4402-zcode-websearch-path](https://github.com/ggbdpq/magpie/tree/fix/4402-zcode-websearch-path) (head `4073c365287fd463f32d02ec597e092cb6b14882`).
