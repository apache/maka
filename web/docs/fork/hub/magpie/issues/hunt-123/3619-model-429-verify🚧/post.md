Verification of @skygunner's branch — I'm not proposing a patch here, the fix is theirs; I ran an independent check of `fix/3619-model-scoped-rate-limit` and can't endorse it as-is: the SophNet mechanism is right and locked by its tests, but the branch regresses an in-repo test that pins OpenRouter's account-wide free-model rate limit (#153). Evidence below.

**Mechanism, self-description vs. diff** (commit 0c5a9d458, cited in the comments above; 2 files, +88 lines, nothing out of scope):

| Claim | In the diff | Measured |
| --- | --- | --- |
| "Model tpm limit exceeded" is read as model-scoped | new `modelRateWords` word list, matched via `wordsOf` | yes — the test asserts it; ablation run prints `modelRate=true` |
| such a 429 rests by `restID()`, not `restKey()` | injection in `restAfterMarked` before `r.Key = id`, plus an `else if` in `rateRest` | yes |
| the key's other models keep serving | no key rest on model-scoped wording | yes — test asserts `restOf(restKey())` stays empty |
| a plain "Too Many Requests" still rests the key | no word-list match falls through to the key | yes — `TestKeyRateLimitRestsTheKey` |

**Verification** (tip = today's `main` e17b6cefc; the branch's base is a month old, 1517 commits behind):

| Check | Result |
| --- | --- |
| `TestModelRateLimitRestsTheModelAlone` on the fix's parent 20b35df55 (test + word list planted, no code change) | RED — `Key="sophnet"`, want `sophnet/DeepSeek-V4.1-Flash-1017` |
| same test, fix injections removed at tip (ablation) | RED — same signature, reported symptom verbatim |
| the branch's two tests on the branch head | ok |
| 3-way apply of the patch onto tip | one conflict in the regexp block (main added `modelCooling` there, #3039); keeping both word lists resolves it, then it lands; the new test file applies clean |
| full `go test -tags nogui ./internal/gateway/` on tip + 0c5a9d458 | **1 FAIL: `TestOpenRouterFreeAccountRateLimitKeepsProviderRest`** (602 s, no other failure) |
| `-race` over the Rest/Rate tests | fails on the same test; no race report — it is wording, not concurrency |
| gofmt / vet / build -tags nogui | routing.go clean, vet clean, build ok; **the branch head's `model_limit_rest_test.go` is missing the trailing newline** (gofmt flags it on the branch itself) |

**What blocks the endorsement.** `TestOpenRouterFreeAccountRateLimitKeepsProviderRest` (9e37a6929, 2026-09-28, present in the branch's own base) pins that OpenRouter's **account-wide** "Rate limit exceeded: free-models-per-min" keeps the **provider** rest key (`orf`). It passes on clean main and on the pristine base, and fails on the branch — at the branch's own base and at current tip alike:

| Tree | #153 test |
| --- | --- |
| clean tip | PASS |
| pristine branch base | PASS |
| base + branch head | FAIL — rest lands on `orf/x/a:free` instead of `orf` |
| tip + 0c5a9d458 | FAIL (the only red in the full gateway run) |
| tip + branch head | FAIL |

Instrumented run at the branch head shows why. The head is not the commit cited in the comments: a second commit, e9307596c07d3a513764d878199f13c3a08b83b8, narrows the reverse alternative to `(?:for|on) (?:the )?model` and adds a `freeModelsPerMin` exclusion — but two defects remain there:

1. the forward alternative `model.{0,40}(limit|quota|tpm|rpm|rate|throttl)` still matches, because the fuller JSON body bridges "model" (in "free-models-per-min") to "rate" (in `"type":"rate_limit_error"`) within the 40-char window across envelope fields — so the model-scoped injection fires anyway;
2. the new exclusion branch sets `id = provider.KeyAllowanceID(c.p)`, which is the **empty string** for a key whose windows magpie does not read — even when nothing overrides it, the rest would be keyed under `""`, not `orf`.

Net effect: a key-wide, account-level OpenRouter limit would rest one model only and leave its siblings asking — the exact grey-out shape #153 fixed, now for the account-wide wording instead of the pooled one.

**Not verified:** no real SophNet account was called (as the fix's author also stated — the reported JSON is the test fixture); provider wordings beyond the in-repo suite were not enumerated.

The direction itself is sound and matches the issue's ask (`restID` for model-scoped wording, same shape as the existing `otherModels`/`modelCooledDown` decisions in the same block); with the #153 collision above fixed — and the branch head SHA referenced in the comments, since both comments still cite 0c5a9d458 — this should be straightforward to re-issue.

Branch: skygunner/magpie `fix/3619-model-scoped-rate-limit`, head e9307596c07d3a513764d878199f13c3a08b83b8 (comments cite the earlier 0c5a9d458).

Thanks @zisen123 for the report and @skygunner for the fix branch.

AI use: verification performed with AI assistance; all commands and outputs above were run and read locally.
