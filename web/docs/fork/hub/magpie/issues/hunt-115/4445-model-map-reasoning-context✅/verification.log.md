# hunt115-b4-4445 verification log

Issue: https://github.com/yetone/magpie/issues/4445
Branch: hunt115-b4-4445 (base 1fac66c06d11de9e4232270862da0fa0a3ad90f6 = upstream/main at start)
Commit: 9acf8d7bae937cc608187e615262cc610e39edc7
Patch: 0001-gateway-a-remote-magpies-codex-model-gets-codex-s-r.patch (SHA-256 first 16: 2bc171eb01238f28)
Posted: https://github.com/yetone/magpie/issues/4445#issuecomment-6556787106 (GET read back ok)

## RED (before fix, tests only)

```
--- FAIL: TestRemoteMagpieCodexModelKeepsLite (0.13s)
    additional_tools_test.go:152: status 400: {"error":{"code":"unsupported_value","message":"Office: X-OpenAI-Internal-Codex-Responses-Lite requires `reasoning.context` to be `all_turns`.","param":"reasoning.context","type":"invalid_request_error"}}
FAIL
FAIL	github.com/yetone/magpie/internal/gateway	1.125s
FAIL
```

## GREEN (after fix, targeted)

```
=== RUN   TestAdditionalToolsRelayed
--- PASS: TestAdditionalToolsRelayed (0.38s)
=== RUN   TestAdditionalToolsTranslated
--- PASS: TestAdditionalToolsTranslated (0.00s)
=== RUN   TestRemoteMagpieCodexModelKeepsLite
--- PASS: TestRemoteMagpieCodexModelKeepsLite (0.02s)
=== RUN   TestRemoteMagpieOtherModelLeavesLite
--- PASS: TestRemoteMagpieOtherModelLeavesLite (0.02s)
=== RUN   TestAdditionalToolsMerged
--- PASS: TestAdditionalToolsMerged (0.00s)
PASS
ok  	github.com/yetone/magpie/internal/gateway	1.236s
```

## Ablation (product files reverted to HEAD~1, tests kept)

```
--- FAIL: TestRemoteMagpieCodexModelKeepsLite (0.18s)
    additional_tools_test.go:152: status 400: ... requires `reasoning.context` to be `all_turns` ...
FAIL
```
Restored: same test ok.

## Matrix

- go test -tags nogui -count=1 ./internal/gateway/ : ok (532.459s)
- gofmt -l internal/gateway/ : clean
- go vet -tags nogui ./internal/gateway/ : clean (darwin)
- GOOS=linux GOARCH=amd64 go vet : clean
- GOOS=windows GOARCH=amd64 go vet : clean
- go build -tags nogui . : darwin ok (pre-existing cgo -Wenum-conversion warning in internal/gui, on main too), linux ok, windows ok

## Watched checks

1. Break-by-hand (ablation above): red same-signature, green on restore.
2. Sibling surfaces (rg): liteHeader/all_turns writers and readers all in additional_tools.go, gateway.go (2 sites), responses_ws.go (inbound rebuild), codex_socket.go (outbound marker), codex_backend.go:974 + codex_relay.go:68 (DeclareSearch, CodexPath only), decide.go (retry note), provider/codex_request.go (Lite heuristic for DeclareSearch). Not changed, why: the first two are this fix's sites; the rest key off the CodexPath inbound or the account path, which the mapped chain never touches; the remote's account path already keeps Lite (liteKept true), so nothing there needs to change.
3. Failure-read semantics: a remote that still refuses comes back prefixed ("Remote magpie: Codex: ...") exactly as the issue shows — the vendor's own reason, no local mutation; the keep decision is declarative from the catalog (codex/ prefix = the remote's ChatGPT account namespace).
4. Hot-path cost: modelOf(body) at the two sites is the repo's single-field fast reader (fastjson.go, #1532/#1654); codexModel is a strings.Cut on the model name. No extra body parse.
