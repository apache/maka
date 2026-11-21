Patch attached below (branch [fix/5030-maxtokens-field](https://github.com/ggbdpq/magpie/tree/fix/5030-maxtokens-field)), AI-written, author ggbdpq.

## Summary

The real defect in this report is confirmed and fixed: `deepseekTokenField` (`internal/gateway/deepseek_schema.go`) renamed a chat request's reply length to `max_tokens` for the DeepSeek preset or `api.deepseek.com` alone, so a custom provider on its own domain serving a DeepSeek model — your `api.aiflashapi.com` case — got `max_completion_tokens` as it came, DeepSeek behind the relay ignored it and answered with its default (8K without thinking), while magpie's self-heal (`provider.TokenFieldWanted`) only fires on a 400 that names the other field, which a silently-ignoring relay never sends. This is the same too-narrow gate as the tool-schema normalization's (#4852, ethanfly), and the same family as #2355, which fixed the preset-recognized case.

## Fix

The gate now also reads the model named in the body, the way Grok's schema quirk already tells (`grokModel`, #2317): a model a relay names `deepseek-whatever` (any vendor prefix — `deepseek/…`, a bare id) gets the field DeepSeek's API reads, whoever serves it; another vendor's model through the same relay goes as it came, as does a request that names `max_tokens` too (DeepSeek reads that one). No new configuration field for now — the model's name carries the decision, and the preset/host checks keep their place ahead of it. If you'd rather have an explicit override, that's the maintainer's call to make; the explicit-field design in the issue body is a reasonable shape for it.

## Verification

| Check | Result |
| --- | --- |
| New test `TestDeepSeekRelayChatGetsMaxTokens` (relay + `deepseek-flash`/`deepseek-v4.1-flash` bodies): RED on parent commit df7c94bdf, GREEN with the fix | pass |
| Non-DeepSeek model through the same relay untouched; both-fields and `max_tokens`-only bodies pass through; message text keeps its bytes | pass |
| Sibling tests (`TestDeepSeekChatGetsMaxTokens`, `TestOpenAIChatGetsMaxCompletionTokens`, `TestChatTokenFieldRetriedWhenNamed`, `TestDeepSeekToolPatterns*`, `TestUnicodeNullEscape`) | pass |
| `go test -tags nogui ./internal/gateway/...` (full suite, 643s) | pass |
| `go test -race` (targeted), `gofmt -l`, `go vet`, `go build ./...` | pass |

## Attribution

Patch written by GLM-5.3-Flash (ZCode), author ggbdpq. Credit to NOMOAX for the full defect chain (the URL-guessing client, the gate, the silent-relay blind spot of the 400 self-heal) and to ethanfly's #4852 for the same-family gate analysis.

## Patch

<details>
<summary>5030-maxtokens-field.patch — SHA-256 (first 16): 37ca0d25f95b82fa</summary>

```
Apply with: git am 5030-maxtokens-field.patch
```

SHA-256 (first 16): `37ca0d25f95b82fa`

Branch: https://github.com/ggbdpq/magpie/tree/fix/5030-maxtokens-field (head c00bbc01537c07eef41e324487bca44943d4726f)
</details>
