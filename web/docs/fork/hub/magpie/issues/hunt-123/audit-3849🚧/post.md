Yielding to @skygunner's fix branch — I verified it independently instead of opening my own.

**Mechanism, ring by ring** (checked against upstream/main `e17b6cefc`)

| Ring | Finding |
| --- | --- |
| Compaction rewrites the request | `codexInputAs` (internal/gateway/codex_backend.go) replaces a `compaction_trigger` with the summary prompt and sets `"tools": []` for a magpie model without native compaction; history items pass through its `default` branch untouched, so `custom_tool_call` / `custom_tool_call_output` items stay in the input |
| Refusal not recognized | The relay's 400 check (`customToolRefusal.Match && hasCustomTool`, internal/gateway/gateway.go) fails twice: the regex only knows tools-array wordings (`unknown variant \`custom\``, `unsupported tool type \`custom\``), not vLLM's `Unsupported input item type: custom_tool_call`; and `hasCustomTool` early-returns unless the body contains the quoted literal `"custom"`, which a `custom_tool_call` type never is |
| Stuck forever | Nothing gets marked unfit, so no translation retry — every compaction gets the same 400, as reported |
| The fix | The regex gains an `(unsupported|invalid|unknown) (input )?item type … custom_tool_call` alternative (a quoted `custom_tool_call_output` is covered by the prefix); `hasCustomTool` returns true for input items typed `custom_tool_call` / `custom_tool_call_output`, and its early-return literal drops the quotes; after the 400 the model is marked and the retry translates the calls to `function_call` / `function_call_output` on the same API |

**Verification** (my own runs, on a clean `git am -3` of the branch onto upstream/main `e17b6cefc`; applied cleanly, no conflicts — the branch is based on `8abdf53a8`, 186 commits behind tip, with zero drift on the touched files, and the ammed files are byte-identical to the branch):

| Check | Result |
| --- | --- |
| `TestCodexCompactionOverCustomToolCalls` + `TestCustomToolRefusalWordings_VLLM` on clean tip, test file only (no fix) | RED — both fail with the report's exact 400 body (`Unsupported input item type: custom_tool_call (parameter=input)`) |
| Same tests with the fix | GREEN — stream false and true; the refusing upstream is asked exactly twice, the second ask carries `function_call` and no `custom_tool_call` items, the fallback provider is never asked |
| Neighbors (`-run 'TestCustomTool|TestCodexCompact'`) | ok |
| Full `go test -tags nogui -count=1 -timeout 25m ./internal/gateway/...` | ok 636.7s, 0 failures |
| gofmt (after `tr -d '\r'`) and `go vet -tags nogui ./internal/gateway` | clean |
| #3392's `unknown variant` alternative kept beside the new alternative after the rebase | confirmed present in the regex |
| Freshness | upstream/main still at `e17b6cefc`, touched surfaces unchanged, no fix for #3849 landed upstream |

Branch: [skygunner/magpie `fix/3849-codex-compaction-custom-tool-call`](https://github.com/skygunner/magpie/tree/fix/3849-codex-compaction-custom-tool-call) (head `3befa94eeffc46bff09726d98105feba9b505247`)

Not verified: no end-to-end run against a real vLLM server (the tests replay the report's exact 400 from a scripted upstream), and `-race` was not run.

AI use: verification performed with AI assistance; all commands and outputs above were run and read locally.

Thanks @yorhaha for the report and @skygunner for the fix branch.
