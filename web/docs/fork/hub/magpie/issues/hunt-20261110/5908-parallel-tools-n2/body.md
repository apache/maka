This post and its patch are written by an AI (GLM-5.3-Flash via ZCode), took no code from anyone, and were authored by ggbdpq.

**What's wrong**

With magpie's default `wireProtocol: "openai"` written into the app's gateway config, three parallel calls from gemini-4-argon (through a custom Gemini-compatible provider) reach the app folded into one call — ids, names and arguments without their correspondence — and the app retries the turn for good, every upstream request coming back fine (#5908). Hand-setting `genai` and restarting the app makes the same chain answer right, which is the report's expected (b): a user-set `wireProtocol` that stays.

**What magpie does today — measured on v`ca7a39291` (main), no real device (NOT-RUNNABLE here)**

A fake Gemini-compatible upstream answering three functionCall parts was asked through magpie on both wires, in every shape the chain streams them (all in one chunk, one call a chunk, upstream-issued ids, thought signatures riding the calls, thinking between them, and a reply asked whole):

- openai wire (`/v1/chat/completions`, streamed): the reply carries three `tool_calls` at indexes 0, 1, 2, an id of their own each, arguments whole per index, `finish_reason: "tool_calls"`; the follow-up turn's replayed history reaches the upstream with all three functionCalls and all three functionResponses, paired by id.
- genai wire (`/v1beta/models/{model}:streamGenerateContent`): the reply carries three whole functionCall parts; the replay keeps every call and every answer.

The frames magpie streams are the shape OpenAI itself streams for parallel calls, so the fold lives in the app's own openai-wire accumulator, not in the translation — nothing in magpie's decode→encode path keys fragments to a shared index (the chat encoder numbers each call with its own `index`; a Gemini-compatible relay that reused indexes is mended separately in chatTidy). A whole-call-per-fragment reply is the one lever left for an accumulator magpie's frames don't reach, but with no device to check it against and every standard client reading the current frames, that is a call for the maintainer, not a blind change.

**The magpie-side defect in the report, fixed here**

`antigravityGateway()` wrote `wireProtocol: "openai"` on every connect and sync, and `mergeTheirs` keeps only keys magpie doesn't write — `wireProtocol` is one it does, so the reporter's hand-set `genai` was written back at the next sync (their workaround held only until then; the app reads the file at start-up). A wired file's wireProtocol now stays what the file holds; a block magpie starts, and a file naming none, still say `openai`. magpie serves both wires on the same address, so nothing else reads the value: on genai the app asks `/v1beta/models/{model}:streamGenerateContent` and reads the calls whole, which is exactly the report's working shape.

**The fix** — `agent: Antigravity's wire protocol stays what the file holds (#5908)`, branch [`fix-5908-wire-protocol`](https://github.com/ggbdpq/magpie/commit/f7cd9a02cc14923d53a981bf192628d8c50dae85):

```sh
git am https://github.com/ggbdpq/magpie/commit/f7cd9a02cc14923d53a981bf192628d8c50dae85.patch
```

sha256[:16] = `fefee443ba64dab6` · `git am` into a clean tree at `ca7a39291`: zero conflict.

**Verification**

| Check | Result |
| --- | --- |
| `TestAntigravityWireProtocolKept` (new) | red before (genai written back to openai — the report's workaround, undone at the next sync), green after: fresh block still openai, hand-set genai survives re-connect and sync with magpie's url/key intact |
| `TestAntigravityGateway`, `TestAntigravitySyncWiresConfigJSON`, the 2.30-file/legacy/admin/env batches | green (stash-and-replace of the user's own gateway unchanged) |
| parallel-call fixtures, both wires (new, named above) | all green on this base — the fold is not in magpie's translation |
| `go test -tags nogui ./internal/agent` (whole package) | green but `TestMothX` — red on the parent commit too on this machine (pre-existing) |
| named tests with `-race` | green |
| ablation | the keep branch made a no-op → `TestAntigravityWireProtocolKept` red; restored → green |
| sibling scan | `wireProtocol` written nowhere else, read nowhere else (magpie acts on no value); avibe/miniq/fx/qoder name a protocol for apps with a single wire against magpie, no user choice or defect on record — left; `theirsKept`/`mergeTheirs` untouched |
| gofmt, real device | gofmt clean; Antigravity 2.29/2.30 on Ubuntu NOT-RUNNABLE here — the frames above are pinned by the fixtures |

Expected (a) of the report — keep the calls apart on the openai wire — is the app's accumulator; magpie's side of it (a configurable, kept `wireProtocol`, the report's (b)) is in this patch. If the maintainer wants magpie to also try whole-call-per-fragment frames for this agent's openai wire, say the word and it comes as its own change against a real device's evidence.

Generated-by: GLM-5.3-Flash (ZCode)
