Re-based onto `62a1df80` after upstream reshaped the routing doc and the reasoning paths around it (`59289946`, `a3ebed20`); the fix is unchanged. `a3ebed20` was read closely for overlap, since it is also about another vendor's reasoning text: it shapes what magpie sends *upstream* (`codexInput(body, false)` on Codex's own-model turn and compaction routes — the #1411 direction, so OpenAI is never refused over a `content` it takes only empty), not what magpie hands the client. The item still reaches Codex's rollout as the upstream wrote it there — that commit's own doc bullet says "relayed to Codex as it came" — so the planting this fix stops is still live on `62a1df80`, and the two changes compose: upstream-bound strips (a3ebed20, #1411) and client-bound remake (this), each at its own seam. The mechanics are byte-identical to the previously posted patch: `reasoning_content.go`, its tests and `responses.go` apply here exactly as they were; only the doc bullet moved (line 141 to 146, with `a3ebed20`'s new bullet kept right after it) and the `passthrough` wiring re-landed past `d155ab16`'s `idTidy`, where `reasoningTidy` sits before it in the chain (a made item keeps the upstream's id, and `idTidy` still has the last word on ids).

## Source

#2855, the reporter's rollout forensics: 25 `type: "reasoning"` items a DeepSeek phase handed Codex, each with its text in `content` parts and a 38-character `encrypted_content` of the vendor's own (not the `gAAAA` the thread's own GPT-phase items carry, which have no content). OpenAI takes a reasoning item sent back only with its content empty (the same refusal #1411 was) and cannot open another vendor's seal, so every later turn and the remote compact fail 400 until such items are gone — with magpie disconnected, out of any retry's reach. What magpie hands a client has to be re-sendable in the first place.

## Red without the fix (base `62a1df80`)

With only the test file at `62a1df80` (it compiles there as is):

- `TestForeignSealedReasoningGivenCodexCarriesNoContent` (translated serving) and `TestForeignSealedReasoningRelayedCarriesNoContent` (byte-relayed serving) **fail with the issue's item handed over whole**, in both `output_item.done` and `response.completed`'s output: `reasoning item carries its text: map[content:[map[text:counting the lines type:reasoning_text]] encrypted_content:dskseal…0000000 id:rs_dsk1 summary:[] type:reasoning]`, `carries a seal that is nobody's here`, `carries no summary`.
- `TestTranslatedChatReasoningCarriesNoContent` is protective and green there: the Chat translation already writes the summary-only shape.

## Ablation and mutation

- Restoring `gateway.go` and `responses.go` alone to `62a1df80` (tests kept, tree compiles) fails the two again; restoring them passes 3/3.
- Attaching `content` to the made item fails both again — `carries its text` — and restoring passes.

## Verification

| Check | Command | Result |
| --- | --- | --- |
| The three tests, fixed tree | `go test -tags nogui -count=1 -run 'TestTranslatedChatReasoningCarriesNoContent\|TestForeignSealedReasoningGivenCodexCarriesNoContent\|TestForeignSealedReasoningRelayedCarriesNoContent' ./internal/gateway/` | ok, 3/3 pass |
| The same tests on the base, test file alone | same command at `62a1df80` + the test file | 2 FAIL (translated, relayed), chat-path test passes |
| Ablation: the two wired files alone at the base | same command | 2 FAIL; restored, 3/3 pass |
| Mutation: content attached to the made item | `go test -tags nogui -count=1 -run 'TestForeignSealedReasoning' ./internal/gateway/` | both FAIL, "carries its text"; restored, ok |
| Targeted suites | `go test -tags nogui -count=1 -run 'TestTranslated\|TestReasoning\|TestSealed' ./internal/gateway/` | ok, 7.8s |
| Race | `go test -race -tags nogui -count=1 -run 'TestTranslated\|TestReasoning' ./internal/gateway/` | ok, 9.2s |
| Full package | `go test -tags nogui -count=1 -p 1 -timeout 30m ./internal/gateway/` | ok, 310.1s |
| Format | `gofmt -l internal/gateway/` | empty |
| Vet | `go vet -tags nogui ./internal/gateway/`, then `GOOS=linux`, `GOOS=windows` | pass on all three |
| Builds | `go build -tags nogui -o /dev/null .` on darwin/arm64, linux/amd64, windows/amd64 | pass on all three (the pre-existing cgo `-Wenum-conversion` warning in `internal/gui/trayimage_darwin.go` on darwin, untouched by this) |
| Applies as is | `git am` of the patch below on a pristine `62a1df80` worktree | applies clean |

## Siblings

Whose else's reasoning reaches Codex as a reasoning item on `62a1df80`, and what each now emits — unchanged from the previous posting, re-checked against the new paths `59289946` and `a3ebed20` added:

- **DeepSeek on its own Chat API** (the issue's vendor): the stream encoder turns its `reasoning_content` deltas into an item magpie makes — `rs_` id, summary, no content, nothing sealed. Unchanged by this fix; pinned by the protective test.
- **Any other Chat-wire thinker served translated** (Qwen/DashScope, GLM, Kimi's thinking, Mistral as the thinking part #494 takes, OpenRouter-fronted thinkers): the same path, the same shape.
- **Claude (Anthropic)**: `thinking` and `redacted_thinking` seal as Anthropic's (`sealAnthropic`), and the Responses encoder writes only its own API's seal to a Responses client. No foreign item; unchanged.
- **Gemini**: thought parts are reasoning like any other's — `rs_` id and summary; its `thoughtSignature` rides call and text ids, never a reasoning item. `59289946` changed only when a last-candidate Gemini stream is held (holdWriter/emptyRetries, translated path), nothing about the item's shape; unchanged here.
- **Other Responses wires** (xAI, Copilot, Azure, relays in front of OpenAI): their items that carry content are remade the same way, by the encoder and by the passthrough tidy. Seal-only items (`encrypted_content`, empty content) still go to Codex as they came; replaying one to a strict upstream is the separate foreign-seal territory (#1044's re-ask, the ChatGPT backend path's drops — now including `a3ebed20`'s compaction-route drop — and the invalid_encrypted_content retry), untouched here.

## When the read fails

Unchanged from the patch as posted: a reasoning item that decodes badly, or carries no `content` parts (OpenAI's own summary-only and seal-only shapes), goes as it came — `reasoningWithText` is false of it and `magpieMadeReasoningRaw` returns the raw bytes; an event that fails to decode or re-marshal passes through untouched; an item whose text parts are empty is made into an item with an empty summary, still no content and no seal, so still re-sendable. `reasoning_content.go` in this commit is byte-identical to the previously posted one.

## Not verified

- No real OpenAI or DeepSeek account was used; the reporter's rollout reading is quoted from the issue, not re-derived from a live thread — and the reporter themselves note there is no independent minimal repro yet.
- magpie cannot retroactively clean a rollout it has already written: a thread holding the 25 items keeps failing against OpenAI with magpie disconnected until Codex's remote compact succeeds or the items are removed (the reporter's own cleanup proves the diagnosis). With this change magpie stops planting them.
- A made item (`rs_` id, summary, nothing sealed) replayed straight to OpenAI with `store:false` is the #1008 class; through magpie it never gets there (`withoutBareReasoning`, the ChatGPT backend's input drops, now also `a3ebed20`'s compaction-route drop), and a DeepSeek upstream is sent its text back out of the summary (`withReasoningText`).
- A rewritten event is re-marshalled from the parsed JSON, so its key order can differ from the vendor's bytes (the `nsTidy` precedent re-marshalls the same way; clients read JSON, not key order).

Branch with the commit: [hunt46-b-reasoning-content-openai](https://github.com/ggbdpq/magpie/tree/hunt46-b-reasoning-content-openai) (head `e854e2852`).

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>.`

**Patch**: <details><summary>patch: gateway: a reasoning item magpie hands Codex with its text in it becomes one of its own, a summary and nothing sealed (#2855) — git am applies it as is; SHA-256 first 16: aa86abd4d33a83dc</summary>

```patch
From e854e2852adf8a43a0f19e45456c71dd6a3bc96b Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Mon, 19 Oct 2026 07:32:51 +0800
Subject: [PATCH] gateway: a reasoning item magpie hands Codex with its text in
 it becomes one of its own, a summary and nothing sealed (#2855)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

What changed

A Responses reasoning item that carries the model's reasoning as content
parts (reasoning_text) — another vendor's shape; OpenAI's own items carry
summaries — no longer reaches a client of magpie's as the upstream wrote
it. It is made over into the item magpie makes of any other upstream's
reasoning: its text (and its summaries) as one summary, an rs_ id, no
content and no seal — in a reply translated for the client
(magpieMadeReasoningRaw at the encoder's sealed item and the whole reply's
renderer) and in one relayed as it came (reasoningTidy, a passthrough
filter on Responses streams and whole replies, the item in
output_item.added/done and in response.completed's output). The
subsystems doc's rule is amended to say so.

Why

A Codex conversation that used OpenAI, went through magpie to DeepSeek,
then had magpie disconnected again, was stuck: every later turn, the
remote compact too, answered 400 "Invalid 'input[43].content': array too
long. Expected an array with maximum length 0, but got an array with
length 1 instead." The reporter's rollout forensics narrow it: the
DeepSeek phase had left 25 reasoning items, each with its text in content
parts and a 38-character encrypted_content of the vendor's own (not the
gAAAA the thread's own GPT-phase items carry, which have no content),
which Codex stores and replays to OpenAI. OpenAI takes a reasoning item
sent back only with its content empty (#1411) and cannot open another
vendor's seal, so such an item poisons the thread for OpenAI wherever it
was planted — and once Codex holds it, no retry of magpie's can strip it:
client keeps, and #2855 came with magpie out of the path entirely. A
Chat-API upstream's turn has always translated to an item of magpie's own
(an rs_ id and a summary, TestTranslatedChatReasoningCarriesNoContent
pins it); the items the reporter held are a Responses wire's own, which
both the translated and the relayed reply handed over as they came. What
magpie hands a client must be re-sendable to a strict Responses upstream:
the text is kept in the summary, so an upstream that wants its reasoning
back still gets it (withReasoningText), and magpie's own OpenAI
destinations keep the item out as they did (#1008, #1044, #1411).

Run

- TestForeignSealedReasoningGivenCodexCarriesNoContent (translated) and
  TestForeignSealedReasoningRelayedCarriesNoContent (relayed) fail on
  upstream/main with the issue's item handed over whole — content, empty
  summary and the vendor's seal in both output_item.done and
  response.completed — and pass with the change;
  TestTranslatedChatReasoningCarriesNoContent (a Chat upstream's
  reasoning, translated) is green without and with the change.
- Restoring the three product files alone to upstream/main (tests kept)
  fails the two again; restoring them back passes.
- Attaching content to the made item fails both again ("carries its
  text"), and dropping the made summary fails both ("carries no
  summary").
- go test -tags nogui -count=1 ./internal/gateway: ok 312.4s;
  -run 'TestTranslated|TestReasoning|TestSealed': ok 7.9s;
  go test -race -tags nogui -count=1 -run 'TestTranslated|TestReasoning':
  ok 9.4s. gofmt -l internal/gateway empty. go vet -tags nogui and
  go build -tags nogui -o /dev/null . on darwin, GOOS=linux and
  GOOS=windows: pass (a pre-existing cgo -Wenum-conversion warning in
  internal/gui/trayimage_darwin.go on darwin, untouched).

Not tried against real OpenAI or DeepSeek accounts; the reporter's
rollout reading is taken from the issue, not re-derived from a live
thread.

Fixes #2855

Generated-by: GLM-5.3-Flash (ZCode)
---
 docs/subsystems/gateway-routing.md         |   2 +-
 internal/gateway/gateway.go                |  14 ++
 internal/gateway/reasoning_content.go      | 201 ++++++++++++++++++++
 internal/gateway/reasoning_content_test.go | 207 +++++++++++++++++++++
 internal/gateway/responses.go              |  16 +-
 5 files changed, 434 insertions(+), 6 deletions(-)
 create mode 100644 internal/gateway/reasoning_content.go
 create mode 100644 internal/gateway/reasoning_content_test.go

diff --git a/docs/subsystems/gateway-routing.md b/docs/subsystems/gateway-routing.md
index 93cba585..becae19c 100644
--- a/docs/subsystems/gateway-routing.md
+++ b/docs/subsystems/gateway-routing.md
@@ -143,7 +143,7 @@ recorded as a prediction failure (`noPrediction`).
 - A Chat request has every tool call that came with no id (`""`, null or none) given one in `attempt`, before it is relayed or translated, plugins included (`chatCallIDs` in [`chat_call_ids.go`](../../internal/gateway/chat_call_ids.go), #2611, RunMintOn). An upstream that sometimes streams a call without an id (OpenCode Zen's free DeepSeek) has the agent keep it as `""`, which that upstream takes back, while WorkBuddy AI turns a streamed request carrying one away (400, code 11133) and Anthropic takes no empty `tool_use` id. The id is made from the call's place in the request, its name and its arguments, never at random, so the next turn's history goes byte for byte and the upstream's prompt cache holds; the tool messages after the call that answer with no `tool_call_id` take the made ids in the calls' order. A body whose calls all have ids goes as it came. On the reply side, a relayed Chat stream's call whose first fragment has no id is given one, and a later fragment's empty id is left out (`chatTidy`); a whole reply's call is given one too (`chatWhole`). `TestEmptyCallIDRelayedWithOne`, `TestEmptyCallIDReachesPluginWithOne`, `TestEmptyCallIDTranslatedWithOne`, `TestStreamedCallGivenAnID` in [`chat_call_ids_test.go`](../../internal/gateway/chat_call_ids_test.go).
 - Codex's model list from the backend path (`codexModels`) is the ChatGPT backend's for its sign-in and then magpie's (`provider.CodexListed`), its ETag and every reply's `X-Models-Etag` tagged with `provider.CodexListTag` so a change has Codex ask again. A Codex there only for account failover, not connected (`CodexOwnOnly`, `agent.CodexOwnOnly`; #1385), gets the backend's alone, tagged with `provider.CodexOwnListTag`; neither tag contains the other, so connecting or disconnecting has Codex fetch the list again. The user's picks on the codex provider (`provider.CodexNativePicked`) narrow the backend's listed models. They keep its hidden ones (`visibility: "hide"`), which no picker shows. One of those is `codex-auto-review`: when the list lacks it and no reviewer is set, Codex's auto-review runs on the conversation's model at low effort (#1460, `TestCodexModelListPicksKeepHidden`). The account's own models kept out of agents' lists for routing groups (`provider.CodexNativeUnlisted`) are dropped from it too, hidden ones kept: every one when the codex provider is "Only through routing groups" (`Provider.Unlisted`), and those a group that unlists its members names (`Group.Unlists`). A Codex there only for failover keeps them, as it is handed no groups; `spawnChoices` drops the same ones (#1602, `TestCodexModelListUnlistedForGroups`).
 - Reasoning state goes through magpie's translation as the vendor wrote it when the agent and the upstream speak the same API (#1445, XYenon): a non-streaming Messages request to a stream-only account, web search on the agent's own API, a plugin, failover. The IR carries it sealed (`Part.Sealed`, `SealedBy`; events `KThinkStart`, `KSealed`, `KTextSig` in [`ir.go`](../../internal/gateway/ir.go)), so each thinking block or reasoning item stays apart, whole or streamed, and a seal is written only for its own API (`sealedBy`). Anthropic's `redacted_thinking` goes back raw (to DeepSeek as a thinking block, below), and a thinking block signed with no text keeps its signature (`aBlock` still writes `"thinking": ""`, #1447), on Claude's subscription too. A Responses reasoning item keeps its id, summary and `encrypted_content`, and goes back to a Responses upstream as it came when it has no reasoning text (`sealedReasoning`; text, another vendor's, is still left out for OpenAI, #1411). Gemini's `thoughtSignature` stays on the call it signed and on text; a later call of a signed step goes without one, and only an unsigned step or Claude on Antigravity gets `skip_thought_signature_validator`. Another API's agent gets the call's signature in its id, as on chat (#687), with its length in the mark (`__ts<n>__`), so an id a client shortened carries no signature and the call goes as unsigned (#1536); it gets no one else's seal. The signature itself is kept in magpie's folder, `gemini-signatures/<key>`, named by its hash (`keepSignature` in [`gemini_sigstore.go`](../../internal/gateway/gemini_sigstore.go)), and the id carries only the key (`__tsk16__<key>`), so an id stays under 64 characters however long the step's signature (#2411: LobeHub's PostgreSQL index turned away a 3KB id). A key magpie no longer has, or whose file doesn't hash to it, reads as no signature; one not read for 90 days is removed. Where the folder can't be written, the id carries the signature as before. Carrying reasoning across APIs (an envelope) isn't done.
-- A translated Responses reply gives Codex the reasoning items a Responses upstream sent, as it sent them; any other upstream's reasoning becomes items magpie made: an `rs_` id and a summary, nothing sealed. Codex hands them back on every turn. A request relayed as is to OpenAI's API or Azure OpenAI goes without them (`withoutBareReasoning`) unless `store` is true, because both look the id up among stored items and answer 400 "Item with id 'rs_…' not found" (#1008). Any other Responses upstream gets them, because a DeepSeek model wants its reasoning back (#388). When one answers 400 naming the input (`refusesInput`: `param` is `input`, or the error names an item by id), as a relay in front of OpenAI does with a message of its own, `passthrough` asks once more without them and, once that works, leaves them out for that provider and model from then on (`bareReasoningRefused`, #1044). Codex's compaction offers no tools, so it is relayed even when its turns were translated. When a provider answers its summary request 404, or 400 for an item it didn't find (`itemNotFound`, a relay in front of either), `codexCompact` asks once more with the conversation as text (`plainCompact`), then compacts locally (#866, #1008). So does the ChatGPT backend's 502 "response protection is unavailable" (`protectionRefused`): a long history refused so was answered as text. Codex also compacts remotely, a `compaction_trigger` on `/responses` that wants exactly one compaction item back, on any provider table named "OpenAI", as CC Switch names its relay tables. magpie points those at `/v1` while a magpie model is on, so `handle` makes the summary there too (`codexInput`, `codexCompact`), and magpie's summaries go back to the model as text (#1301). A summary is wanted only whole (`askWhole`, `holdWriter.wantWhole`): its stream is held to its end, not let through at its first words, so a reply cut short (`errEndedShort`), failed halfway (a 429 "Individual quota reached" after some of it) or ended `incomplete` (`endedIncomplete`, `incompleteReply`) fails over to the next candidate like a failure before any of it, and rests the account as that failure would; one that reached its output limit rests nobody. With nobody left, `codexCompact` answers 502 and never hands Codex the words before the cut as the summary (#2274, huangzuomin: Antigravity cutting each summary short). Codex with context_management's experimental mode compacts in the background at every step while the conversation is over its threshold and drops a failed compaction without a word, so a conversation whose summaries keep failing is asked again every few seconds, each paying for the whole history (1169 compactions in 6 hours there). After `compactFailsMost` (3) failed summaries in a row of one conversation (`prompt_cache_key`) on one model, each within `compactHeldFor` (5 minutes) of the last, the next is answered at once with a 400 naming the last failure, which Codex doesn't ask again, and no model is asked until 5 minutes have passed (`compactFails` in [`codex_compact_guard.go`](../../internal/gateway/codex_compact_guard.go)); a summary that comes clears the count, and a sign-in's 401 or 403 isn't counted. `TestCodexCompactCutSummaryFailsOver`, `TestCodexCompactCutSummaryIsNoSummary`, `TestCodexCompactKeepsFailingIsHeld`.
+- A translated Responses reply gives Codex the reasoning items a Responses upstream sent, as it sent them — one that carries its text in it (content parts, another vendor's shape) made over into one magpie could have, its text a summary and nothing sealed, in a reply translated or relayed as it came, for the client to store and replay where OpenAI's rules hold even with magpie disconnected (#2855, the reporter's rollout: 25 reasoning items a DeepSeek phase had left, each with its text in it and a seal of the vendor's own, stuck every later turn on OpenAI with a 400 `array too long` nothing of magpie's could strip then); any other upstream's reasoning becomes items magpie made: an `rs_` id and a summary, nothing sealed. Codex hands them back on every turn. A request relayed as is to OpenAI's API or Azure OpenAI goes without them (`withoutBareReasoning`) unless `store` is true, because both look the id up among stored items and answer 400 "Item with id 'rs_…' not found" (#1008). Any other Responses upstream gets them, because a DeepSeek model wants its reasoning back (#388). When one answers 400 naming the input (`refusesInput`: `param` is `input`, or the error names an item by id), as a relay in front of OpenAI does with a message of its own, `passthrough` asks once more without them and, once that works, leaves them out for that provider and model from then on (`bareReasoningRefused`, #1044). Codex's compaction offers no tools, so it is relayed even when its turns were translated. When a provider answers its summary request 404, or 400 for an item it didn't find (`itemNotFound`, a relay in front of either), `codexCompact` asks once more with the conversation as text (`plainCompact`), then compacts locally (#866, #1008). So does the ChatGPT backend's 502 "response protection is unavailable" (`protectionRefused`): a long history refused so was answered as text. Codex also compacts remotely, a `compaction_trigger` on `/responses` that wants exactly one compaction item back, on any provider table named "OpenAI", as CC Switch names its relay tables. magpie points those at `/v1` while a magpie model is on, so `handle` makes the summary there too (`codexInput`, `codexCompact`), and magpie's summaries go back to the model as text (#1301). A summary is wanted only whole (`askWhole`, `holdWriter.wantWhole`): its stream is held to its end, not let through at its first words, so a reply cut short (`errEndedShort`), failed halfway (a 429 "Individual quota reached" after some of it) or ended `incomplete` (`endedIncomplete`, `incompleteReply`) fails over to the next candidate like a failure before any of it, and rests the account as that failure would; one that reached its output limit rests nobody. With nobody left, `codexCompact` answers 502 and never hands Codex the words before the cut as the summary (#2274, huangzuomin: Antigravity cutting each summary short). Codex with context_management's experimental mode compacts in the background at every step while the conversation is over its threshold and drops a failed compaction without a word, so a conversation whose summaries keep failing is asked again every few seconds, each paying for the whole history (1169 compactions in 6 hours there). After `compactFailsMost` (3) failed summaries in a row of one conversation (`prompt_cache_key`) on one model, each within `compactHeldFor` (5 minutes) of the last, the next is answered at once with a 400 naming the last failure, which Codex doesn't ask again, and no model is asked until 5 minutes have passed (`compactFails` in [`codex_compact_guard.go`](../../internal/gateway/codex_compact_guard.go)); a summary that comes clears the count, and a sign-in's 401 or 403 isn't counted. `TestCodexCompactCutSummaryFailsOver`, `TestCodexCompactCutSummaryIsNoSummary`, `TestCodexCompactKeepsFailingIsHeld`.
 - A reasoning item with its text in it (`content` parts: DeepSeek's Responses API writes `reasoning_text`, relayed to Codex as it came) is another vendor's. OpenAI's API and the ChatGPT backend take a reasoning item's `content` only empty, and refuse the whole request over one with 400 "Invalid 'input[n].content': array too long. Expected an array with maximum length 0" (`array_above_max_length`). Codex hands the item back on every later turn, so it never goes to them: for one of Codex's own models, `codexInput(body, false)` leaves it out (and a reasoning item with nothing sealed in it) on `/backend-api/codex`'s `/responses` and on `/responses/compact`, before Codex's own sign-in, its API key or a magpie Codex account (`compactOn`) is asked. Codex compacts a thread before its first turn back on its own model, and a refused compaction shows as that turn's error (jue on Discord). `passthrough` leaves it out for OpenAI, Azure OpenAI and a Codex account (`withoutReasoningText`), and for any other upstream once it has refused one (`refusesReasoningText`, `reasoningTextRefused`, #1411). OpenAI's own sealed reasoning (`encrypted_content`, no text) stays, and a DeepSeek model (`replaysReasoning`) still gets the text. `TestForeignReasoningNeverReachesOpenAI`, `TestReasoningTextLeftOutWhereRefused`, `TestReasoningTextNotSentToCodexAccount`.
 - Native compaction (#1099, off by default): a provider with `nativeCompaction` on (`provider.Provider.CompactsOn`; the editor's Compaction row, `magpie provider set <id> compaction=native`) is asked Codex's `compaction_trigger` as Codex sent it, and the compaction item it seals goes back to Codex unchanged, not as a `magpie1:` summary. Only a wire that carries it can be set so (`CarriesCompaction`): a Responses API, a ChatGPT account, GitHub Copilot (its models asked on Responses; its Claude models keep magpie's summary). The decision is made where `handle` and `codexBackend` read the input (`nativeCompactionFor`, `codexInputAs`): a group compacts natively only when every member does. Such a request, and a later one carrying a sealed compaction to a provider set so or to the provider recorded as its writer, is relayed, never translated, which would drop the item (`keepsCompaction` in `attempt`); a provider that can't be asked it on Responses answers a 400 saying so. The key or account that answered is recorded, whoever it is: a fallback or another member that answered the trigger sealed it whatever its own setting, and only it can read the seal (#2271, JasonBuildAI: a fallback's seal went unrecorded, and the next turn was answered 200 without the compacted history; `TestNativeCompactionFallbackSealStaysWithItsWriter`). It is recorded by the hash of what it sealed (`wroteCheckpoint`, `compactions.json` beside `affinity.json`, 0600, at most 1024 for 30 days). A later request carrying it goes only to that writer (`checkpointReaders`); a writer whose own list has since dropped the model is tried still, as the last resort an account whose list lacks the model is — it sealed the model's compaction, and no other can read it (`planned.unlisted`, `TestNativeCompactionWriterWhoseListLacksTheModel`, #2642: it was refused as "switched off, removed, or no longer serves" though it was on, and switching it on changed nothing). With the writer gone from the candidates, magpie answers 400 `checkpointError` with the reason its settings give (`checkpointGone`: the provider removed, the account signed out, its sign-in lapsed, paused while others are on, switched off, kept from the model in Names & levels, the key off or gone, the model disabled, or the model or group asked for not going to it), what lets the conversation go on, and whether native compaction is on for the writer's provider now, and never sends it to another key, drops it, or summarises it in its place (`TestNativeCompactionWriterGoneSaysWhy`). One of Codex's own models asked on the backend path is decided as a magpie model is when magpie's Codex accounts serve it (`codexAccounts`): the trigger is kept only with the codex provider's native compaction on, else `codexCompact` gives magpie's summary, which any account reads, and no writer is recorded (#2582, ump45nose; before, every such compaction was sealed natively whatever the setting, and the conversation was held to its account; `TestCodexOwnModelCompactionHonoursTheToggle`). Codex's own sign-in alone, relayed as it came, still compacts natively, unrecorded, as does `/responses/compact`; but a request carrying a compaction magpie recorded the writer of goes through routing even then (`codexSealedFor`), so with the writer switched off the one account left isn't sent it. A legacy `/responses/compact` carrying one is judged at its passthrough (`sealedCompact`): the writer on in magpie answers it signed as the writer — its own seal while the sign-in can be asked, a key's seal, a request signing with its own `chatgpt-account-id`, or an unreadable sign-in state relays as it came — and a writer gone is refused with `checkpointError`'s reason, the same words as on `/responses` (`TestNativeCompactionCompactJudgesItsWriter`, #2727). The writer matched is the account user the record holds, so two Team seats of one email read as one and such a compact relays as it came. A gateway key held to some accounts (#905) is asked of the account the compact goes to (`compactSigninHeld`): the writer when it answers it, so a writer the key may not use is refused 403 (`sealedCompactHeldError`) with nothing asked, and one it may use answers though the sign-in isn't the key's (`TestNativeCompactionCompactKeepsTheKeysAccounts`). With the writer held at its usage cap or for credits it may not spend, the answer is 429 `checkpointCappedError` (record `checkpointCappedRecord`, "native compaction's account at its usage cap"), naming that account, that the others serving the model weren't tried for the compaction, and that neither the routing mode nor how conversations stay changes that: wait for the window, raise or lift its cap, or start a new conversation (#2517, lm0711; before, it read "every account at its usage cap" though another had room; `TestNativeCompactionWriterAtItsCap`). `withoutCompaction` (the drop after a refused reasoning item) isn't used for such a request. A route carrying a compaction names its sealer (`Route.Compaction`), and Routing says that is why no other account was asked, not that it is "the only account on" for the model (#2639; `TestNativeCompactionRouteNamesItsWriter`, `routing-compaction.test.cjs`). A refusal of the trigger reaches Codex as the upstream sent it. Not tried against a real upstream; Copilot may refuse a history that holds Codex's `web_search` items. [`native_compaction.go`](../../internal/gateway/native_compaction.go), `TestNativeCompaction*`.
 - A compaction magpie answers itself (`codexCompact`: a magpie model, Codex's own models through magpie's Codex accounts, a CC Switch table) goes to Codex as a `compaction` item whose `encrypted_content` is `magpie1:` and the summary in base64 (`codexsummary.Encrypted`), and `codexInputAs` sends Codex's own summary message in its place (`codexsummary.Message`: Codex's summary prefix, a newline and the summary, as a user message). Codex keeps the item in its rollout and replays it, and OpenAI refuses it once Codex talks to OpenAI itself (`invalid_encrypted_content`, LukeMa on X). So `sessions.PortCodexRollouts` writes that same message into the rollouts in its place ([`codex_portable.go`](../../internal/sessions/codex_portable.go)). It changes only magpie's items, keeps every other line's bytes and the file's line count, mode and time, and drops an unreadable item together with its `replacement_history_metadata` entry. It publishes as Codex publishes a compressed rollout: under `thread-writer-locks/.coordination.lock`, only with the thread's lock free, through a temp file and a rename. A thread a Codex has open is left for a later pass, and a Codex home without writer locks is left alone. It runs 2 minutes after the GUI or `magpie serve` starts and every 10 minutes after, on Codex Disconnect (3s), and as the GUI quits (3s). Each pass reads what changed since the last whole pass, plus what was held (`codex-portable.json`). A ported thread was resumed by Codex 0.162.1 against an upstream that refuses `magpie1:` as OpenAI does. Not tried: a Codex in a WSL distro, whose locks this machine can't take, so it is skipped. `TestPortCodexRollouts*`, `TestPortedCompactionReadsTheSame`.
diff --git a/internal/gateway/gateway.go b/internal/gateway/gateway.go
index 2a731146..41ffc394 100644
--- a/internal/gateway/gateway.go
+++ b/internal/gateway/gateway.go
@@ -4694,6 +4694,14 @@ func (s *Server) passthrough(w http.ResponseWriter, r *http.Request, p provider.
 	if named != nil {
 		spaces = &nsTidy{named: named, sse: sse}
 	}
+	// a reasoning item another vendor wrote with its text in it, in a reply
+	// relayed as it came, made into one magpie could have (#2855): the
+	// client stores what it is handed and replays it where OpenAI's rules
+	// hold, on magpie or off it
+	var made *reasoningTidy
+	if proto == provider.Responses {
+		made = &reasoningTidy{sse: sse}
+	}
 	// a Grok model's 2500.0 in a call's arguments, which Codex turns away
 	// (grok_integral.go, #1431); any other model's reply goes as it came
 	var ints *intTidy
@@ -4765,6 +4773,9 @@ func (s *Server) passthrough(w http.ResponseWriter, r *http.Request, p provider.
 			if spaces != nil {
 				out = spaces.write(out)
 			}
+			if made != nil {
+				out = made.write(out)
+			}
 			if ints != nil {
 				out = ints.write(out)
 			}
@@ -4826,6 +4837,9 @@ func (s *Server) passthrough(w http.ResponseWriter, r *http.Request, p provider.
 	if spaces != nil {
 		write(sign(spaces.flush()))
 	}
+	if made != nil {
+		write(sign(made.flush()))
+	}
 	if ints != nil {
 		b := ints.flush()
 		if sigs != nil {
diff --git a/internal/gateway/reasoning_content.go b/internal/gateway/reasoning_content.go
new file mode 100644
index 00000000..974fe40f
--- /dev/null
+++ b/internal/gateway/reasoning_content.go
@@ -0,0 +1,201 @@
+package gateway
+
+import (
+	"bytes"
+	"encoding/json"
+	"strings"
+)
+
+// OpenAI takes a reasoning item sent back to it only with its content
+// empty ("Invalid 'input[n].content': array too long", #1411) and cannot
+// open a seal that is not its own. A client stores what magpie hands it
+// and replays it when the conversation goes back to OpenAI, on magpie or
+// off it: an item another vendor wrote with its text in it would stick the
+// conversation there (#2855, the reporter's rollout: 25 reasoning items a
+// DeepSeek phase had left, each with its text in content parts and a
+// 38-character encrypted_content of the vendor's own, against the
+// thread's own GPT-phase items, which carry none). So an item that carries
+// its text goes to the client as one magpie makes: the text a summary,
+// nothing sealed.
+
+// reasoningWithText is whether a Responses reasoning item carries its
+// reasoning as content parts (reasoning_text), another vendor's shape:
+// OpenAI's own carry summaries.
+func reasoningWithText(item map[string]any) bool {
+	if t, _ := item["type"].(string); t != "reasoning" {
+		return false
+	}
+	parts, _ := item["content"].([]any)
+	return len(parts) > 0
+}
+
+// magpieMadeReasoning is the reasoning item magpie makes of one a
+// Responses upstream wrote with its text in it, nil of one that carries no
+// content, which goes as it came. The item's summaries and its text become
+// one summary of magpie's; its content and its seal go, the text kept, so
+// an upstream that wants its reasoning back is sent it (withReasoningText).
+// Its own id is kept, the events of a stream naming the item by it.
+func magpieMadeReasoning(item map[string]any) map[string]any {
+	if !reasoningWithText(item) {
+		return nil
+	}
+	var b strings.Builder
+	for _, p := range item["summary"].([]any) {
+		pm, _ := p.(map[string]any)
+		if pm == nil {
+			continue
+		}
+		s, _ := pm["text"].(string)
+		b.WriteString(s)
+	}
+	for _, p := range item["content"].([]any) {
+		pm, _ := p.(map[string]any)
+		if pm == nil {
+			continue
+		}
+		if t, _ := pm["type"].(string); t == "reasoning_text" {
+			s, _ := pm["text"].(string)
+			b.WriteString(s)
+		}
+	}
+	id, _ := item["id"].(string)
+	if id == "" {
+		id = "rs_" + newID()
+	}
+	return map[string]any{"id": id, "type": "reasoning", "status": "completed",
+		"summary": []map[string]any{{"type": "summary_text", "text": b.String()}}}
+}
+
+// magpieMadeReasoningRaw is the item's bytes, made over when the item
+// carries its text; id, when not empty, is the id the item's events have
+// already carried, which its done event must keep.
+func magpieMadeReasoningRaw(raw json.RawMessage, id string) json.RawMessage {
+	var it map[string]any
+	if decodeJSON(raw, &it) != nil {
+		return raw
+	}
+	made := magpieMadeReasoning(it)
+	if made == nil {
+		return raw
+	}
+	if id != "" {
+		made["id"] = id
+	}
+	b, err := json.Marshal(made)
+	if err != nil {
+		return raw
+	}
+	return b
+}
+
+// reasoningTidy makes a Responses upstream's reasoning items that carry
+// their text in it into the items magpie makes, in a reply relayed as it
+// came, its events' sequence numbers and every other line kept as the
+// upstream wrote them. A reply that isn't a stream is gone through whole.
+type reasoningTidy struct {
+	sse bool
+	buf []byte
+}
+
+func (t *reasoningTidy) write(b []byte) []byte {
+	t.buf = append(t.buf, b...)
+	if !t.sse {
+		return nil
+	}
+	i := bytes.LastIndexByte(t.buf, '\n')
+	if i < 0 {
+		return nil
+	}
+	out := t.lines(t.buf[:i+1])
+	t.buf = append(t.buf[:0], t.buf[i+1:]...)
+	return out
+}
+
+func (t *reasoningTidy) flush() []byte {
+	b := t.buf
+	t.buf = nil
+	if !t.sse {
+		if out, ok := t.event(b); ok {
+			return out
+		}
+		return b
+	}
+	return t.lines(b)
+}
+
+func (t *reasoningTidy) lines(b []byte) []byte {
+	if !bytes.Contains(b, []byte(`"reasoning"`)) {
+		return append([]byte(nil), b...)
+	}
+	var out []byte
+	for len(b) > 0 {
+		line := b
+		if i := bytes.IndexByte(b, '\n'); i >= 0 {
+			line, b = b[:i+1], b[i+1:]
+		} else {
+			b = nil
+		}
+		body := bytes.TrimRight(line, "\r\n")
+		data, ok := bytes.CutPrefix(body, []byte("data:"))
+		if !ok || !bytes.Contains(data, []byte(`"reasoning"`)) {
+			out = append(out, line...)
+			continue
+		}
+		nb, ok := t.event(data)
+		if !ok {
+			out = append(out, line...)
+			continue
+		}
+		out = append(append(append(out, "data: "...), nb...), line[len(body):]...)
+	}
+	return out
+}
+
+// event is an SSE event's data, or a whole reply, with its reasoning items
+// that carry their text made into magpie's, and whether one was.
+func (t *reasoningTidy) event(data []byte) ([]byte, bool) {
+	dec := json.NewDecoder(bytes.NewReader(data))
+	dec.UseNumber()
+	var ev map[string]any
+	if dec.Decode(&ev) != nil || ev == nil {
+		return nil, false
+	}
+	changed := madeOver(ev["item"])
+	res, _ := ev["response"].(map[string]any)
+	if res == nil && ev["object"] == "response" {
+		res = ev
+	}
+	if res != nil {
+		out, _ := res["output"].([]any)
+		for _, it := range out {
+			if madeOver(it) {
+				changed = true
+			}
+		}
+	}
+	if !changed {
+		return nil, false
+	}
+	nb, err := marshalPlain(ev)
+	if err != nil {
+		return nil, false
+	}
+	return nb, true
+}
+
+// madeOver makes item, a reasoning item with its text in it, one of
+// magpie's, in place, and reports whether it was.
+func madeOver(item any) bool {
+	im, _ := item.(map[string]any)
+	made := magpieMadeReasoning(im)
+	if made == nil {
+		return false
+	}
+	for k := range im {
+		delete(im, k)
+	}
+	for k, v := range made {
+		im[k] = v
+	}
+	return true
+}
diff --git a/internal/gateway/reasoning_content_test.go b/internal/gateway/reasoning_content_test.go
new file mode 100644
index 00000000..2062322d
--- /dev/null
+++ b/internal/gateway/reasoning_content_test.go
@@ -0,0 +1,207 @@
+package gateway
+
+import (
+	"encoding/json"
+	"io"
+	"net/http"
+	"net/http/httptest"
+	"strings"
+	"testing"
+
+	"github.com/yetone/magpie/internal/provider"
+)
+
+// #2855: a Codex conversation that used OpenAI, then went through magpie to
+// DeepSeek, then had magpie disconnected again, was stuck on HTTP 400
+// "Invalid 'input[43].content': array too long. Expected an array with
+// maximum length 0, but got an array with length 1 instead." — the remote
+// compact with it. The reporter's rollout holds the poison: 25 reasoning
+// items the DeepSeek phase handed Codex, each with its text in content
+// parts and a 38-character encrypted_content of the vendor's own (not the
+// gAAAA its GPT-phase items carry), which Codex stores and replays to
+// OpenAI when the thread goes back there. OpenAI takes a reasoning item
+// sent back only with its content empty (#1411) and cannot open another
+// vendor's seal. So what magpie hands a client must be re-sendable to a
+// strict Responses upstream: a reasoning item magpie makes, its text a
+// summary, nothing sealed — the shape its own translations have always
+// given, which the first test pins.
+
+// dskItem is such an item, as the reporter's rollout holds it: the text
+// where OpenAI wants none, a summary empty, and a seal of the vendor's own.
+const dskItem = `{"type":"reasoning","id":"rs_dsk1","summary":[],"content":[{"type":"reasoning_text","text":"counting the lines"}],"encrypted_content":"dskseal0000000000000000000000000000000"}`
+
+// dskRelay is a Responses upstream serving a DeepSeek model as a relay in
+// front of one does: its reasoning item carries the model's text in it and
+// a seal of its own, beside an answer.
+type dskRelay struct{}
+
+func (u *dskRelay) ServeHTTP(w http.ResponseWriter, r *http.Request) {
+	if strings.HasSuffix(r.URL.Path, "/models") {
+		io.WriteString(w, `{"models":[{"slug":"deepseek-flash","visibility":"list"}]}`)
+		return
+	}
+	w.Header().Set("Content-Type", "text/event-stream")
+	io.WriteString(w, sse(
+		`data: {"type":"response.created","response":{"id":"resp_dsk","model":"deepseek-flash","status":"in_progress"}}`,
+		`data: {"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning","id":"rs_dsk1","summary":[]}}`,
+		`data: {"type":"response.output_item.done","output_index":0,"item":`+dskItem+`}`,
+		`data: {"type":"response.output_item.added","output_index":1,"item":{"type":"message","id":"msg1","role":"assistant","content":[]}}`,
+		`data: {"type":"response.output_text.delta","item_id":"msg1","output_index":1,"delta":"42 lines"}`,
+		`data: {"type":"response.output_item.done","output_index":1,"item":{"type":"message","id":"msg1","role":"assistant","status":"completed","content":[{"type":"output_text","text":"42 lines"}]}}`,
+		`data: {"type":"response.completed","response":{"id":"resp_dsk","status":"completed","output":[`+dskItem+`,{"type":"message","id":"msg1","role":"assistant","status":"completed","content":[{"type":"output_text","text":"42 lines"}]}],"usage":{"input_tokens":5,"output_tokens":2}}}`))
+}
+
+func saveDSK(t *testing.T, u http.Handler) {
+	t.Helper()
+	srv := httptest.NewServer(u)
+	t.Cleanup(srv.Close)
+	if err := provider.Save(provider.Provider{ID: "dsk", Name: "DSK", Key: "k", Models: []string{"deepseek-flash"}, Responses: srv.URL + "/v1"}); err != nil {
+		t.Fatal(err)
+	}
+}
+
+// clientReasoning reads a client-side stream back: every reasoning item of
+// an output_item.done, and every one response.completed's output carries.
+func clientReasoning(t *testing.T, body string) (done, completed []map[string]any) {
+	t.Helper()
+	for _, ln := range strings.Split(body, "\n") {
+		data, ok := strings.CutPrefix(strings.TrimSpace(ln), "data: ")
+		if !ok || !strings.Contains(data, `"reasoning"`) {
+			continue
+		}
+		var ev struct {
+			Type     string         `json:"type"`
+			Item     map[string]any `json:"item"`
+			Response struct {
+				Output []map[string]any `json:"output"`
+			} `json:"response"`
+		}
+		if json.Unmarshal([]byte(data), &ev) != nil {
+			continue
+		}
+		switch ev.Type {
+		case "response.output_item.done":
+			if ev.Item["type"] == "reasoning" {
+				done = append(done, ev.Item)
+			}
+		case "response.completed", "response.incomplete":
+			for _, it := range ev.Response.Output {
+				if it["type"] == "reasoning" {
+					completed = append(completed, it)
+				}
+			}
+		}
+	}
+	return done, completed
+}
+
+// assertResendable is a reasoning item a client may store and replay where
+// OpenAI's rules hold: no content, no seal but OpenAI's own — none here —
+// and its reasoning as a summary.
+func assertResendable(t *testing.T, it map[string]any, text string) {
+	t.Helper()
+	if c, ok := it["content"]; ok {
+		if parts, _ := c.([]any); len(parts) > 0 {
+			t.Errorf("reasoning item carries its text: %v", it)
+		}
+	}
+	if enc, _ := it["encrypted_content"].(string); enc != "" {
+		t.Errorf("reasoning item carries a seal that is nobody's here: %q", enc)
+	}
+	sum, _ := it["summary"].([]any)
+	if len(sum) == 0 {
+		t.Errorf("reasoning item carries no summary: %v", it)
+		return
+	}
+	p0, _ := sum[0].(map[string]any)
+	if s, _ := p0["text"].(string); s != text {
+		t.Errorf("summary text %q, want the item's reasoning %q", s, text)
+	}
+}
+
+// A Chat upstream's reasoning, translated for Codex, is an item magpie
+// makes: an rs_ id and a summary, no content, nothing sealed. It has been
+// so on main; this pins the contract #2855 turns on.
+func TestTranslatedChatReasoningCarriesNoContent(t *testing.T) {
+	fresh(t)
+	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+		if strings.HasSuffix(r.URL.Path, "/models") {
+			io.WriteString(w, `{"models":[{"slug":"deepseek-v4.1-flash","visibility":"list"}]}`)
+			return
+		}
+		w.Header().Set("Content-Type", "text/event-stream")
+		io.WriteString(w, sse(
+			`data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"","reasoning_content":"weighing the options"}}]}`,
+			`data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"42 lines"}}]}`,
+			`data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`,
+			`data: [DONE]`))
+	}))
+	t.Cleanup(up.Close)
+	if err := provider.Save(provider.Provider{ID: "dsh", Name: "DSH", Key: "k", Chat: up.URL + "/v1", Models: []string{"deepseek-v4.1-flash"}}); err != nil {
+		t.Fatal(err)
+	}
+	body := `{"model":"dsh/deepseek-v4.1-flash","stream":true,"store":false,"input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"count the lines"}]}]}`
+	rec := codexPostTo(New(), body)
+	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "42 lines") {
+		t.Fatalf("%d %s", rec.Code, rec.Body)
+	}
+	done, completed := clientReasoning(t, rec.Body.String())
+	if len(done) != 1 || len(completed) != 1 {
+		t.Fatalf("%d reasoning items done, %d in the completed reply: %s", len(done), len(completed), rec.Body)
+	}
+	for _, it := range append(done, completed...) {
+		if id, _ := it["id"].(string); !strings.HasPrefix(id, "rs_") {
+			t.Errorf("reasoning id %q, want one of magpie's own", id)
+		}
+		assertResendable(t, it, "weighing the options")
+	}
+}
+
+// A Responses upstream's reasoning item with its text in it, served
+// translated (Codex asked a search the model doesn't run itself), goes to
+// Codex as the upstream wrote it today: stored, and poison when the thread
+// replays to OpenAI, on magpie or off it (#2855). It goes as an item
+// magpie makes, its text a summary, nothing sealed.
+func TestForeignSealedReasoningGivenCodexCarriesNoContent(t *testing.T) {
+	fresh(t)
+	saveDSK(t, &dskRelay{})
+	body := `{"model":"dsk/deepseek-flash","stream":true,"store":false,"tools":[{"type":"web_search"}],"input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"count the lines"}]}]}`
+	rec := codexPostTo(New(), body)
+	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "42 lines") {
+		t.Fatalf("%d %s", rec.Code, rec.Body)
+	}
+	done, completed := clientReasoning(t, rec.Body.String())
+	if len(done) != 1 || len(completed) != 1 {
+		t.Fatalf("%d reasoning items done, %d in the completed reply: %s", len(done), len(completed), rec.Body)
+	}
+	for _, it := range append(done, completed...) {
+		if id, _ := it["id"].(string); id != "rs_dsk1" {
+			t.Errorf("reasoning id %q, want the item's own, its events named by it", id)
+		}
+		assertResendable(t, it, "counting the lines")
+	}
+}
+
+// The same item in a reply relayed as it came — a plain turn to a provider
+// serving the model on Responses — which is how a DeepSeek phase usually
+// reaches Codex: the bytes alone would leave the poison in Codex's rollout.
+// They go through the tidy the translated reply's items do.
+func TestForeignSealedReasoningRelayedCarriesNoContent(t *testing.T) {
+	fresh(t)
+	saveDSK(t, &dskRelay{})
+	body := `{"model":"dsk/deepseek-flash","stream":true,"store":false,"input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"count the lines"}]}]}`
+	rec := codexPostTo(New(), body)
+	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "42 lines") {
+		t.Fatalf("%d %s", rec.Code, rec.Body)
+	}
+	if strings.Contains(rec.Body.String(), "sequence_number") {
+		t.Fatalf("the reply was translated, not relayed: %s", rec.Body)
+	}
+	done, completed := clientReasoning(t, rec.Body.String())
+	if len(done) != 1 || len(completed) != 1 {
+		t.Fatalf("%d reasoning items done, %d in the completed reply: %s", len(done), len(completed), rec.Body)
+	}
+	for _, it := range append(done, completed...) {
+		assertResendable(t, it, "counting the lines")
+	}
+}
diff --git a/internal/gateway/responses.go b/internal/gateway/responses.go
index fe494c91..bf4df9ca 100644
--- a/internal/gateway/responses.go
+++ b/internal/gateway/responses.go
@@ -1854,11 +1854,15 @@ func (e *responsesEncoder) event(ev Event) {
 		}
 		raw := json.RawMessage(ev.Text)
 		if e.open == Thinking && !e.thinkNew && (ev.ID == "" || ev.ID == e.itemID) {
-			// the item streamed so far, done as the upstream wrote it
-			e.closeAs(raw)
+			// the item streamed so far, done as the upstream wrote it,
+			// made over when it carries its text (another vendor's,
+			// #2855); its events name it by the id they already carried
+			e.closeAs(magpieMadeReasoningRaw(raw, e.itemID))
 			break
 		}
-		// none of it streamed (no summary): added and done whole
+		// none of it streamed (no summary): added and done whole, made
+		// over when the item carries its text (#2855)
+		raw = magpieMadeReasoningRaw(raw, "")
 		e.closeItem()
 		e.item++
 		e.thinkNew, e.thinkID = false, ""
@@ -1980,8 +1984,10 @@ func renderResponses(res Result, model string, named map[string]nsTool) []byte {
 				"content": []map[string]any{{"type": "output_text", "text": p.Text, "annotations": []any{}}}})
 		case Thinking:
 			if p.sealedBy(sealResponses) {
-				// as the upstream wrote it: id, summary, encrypted_content
-				output = append(output, p.Sealed)
+				// as the upstream wrote it: id, summary, encrypted_content;
+				// made over when it carries its text (another vendor's,
+				// #2855)
+				output = append(output, magpieMadeReasoningRaw(p.Sealed, ""))
 				continue
 			}
 			if p.Text == "" {
-- 
2.50.1 (Apple Git-155)
```

</details>
