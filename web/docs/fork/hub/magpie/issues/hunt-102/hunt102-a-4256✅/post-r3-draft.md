<!-- 本地待发布稿。发布形态：分支链接（patch 63KB 超评论区 64KB 上限）。
     发布动作（须用户授权后执行）：
     1. git -C /tmp/magpie-6 push -f origin hunt102-a-4256-cr-toolargs（force-with-lease）
     2. push 后 ls-remote 复核远端 tip == 83a8958febb95a00c142dfa3e1591f2b1161a395
     3. gh issue comment 4256 --repo yetone/magpie --body-file 本文件（去本注释块）
     4. GET 回读核验 -->

Third round on this, on your review's terms:

**Scope.** The cure runs only on the routes the defect was seen on. `glmFlash` reads magpie's model id or the name the request is sent upstream under (the way `grokModel` scopes its rule), a relay installs `crTidy` for those models alone, and on the translated side `Request.CR` is set the way `Request.Grok` is — `crEncoder` (streaming) and `crResult` (whole reply) hang off that flag. Another model's reply goes as it came, healthy or not: a stream carrying the defect's very shape on `m1` reads back byte for byte (`TestForeignModelStitchedStreamGoesAsItCame`).

**The healthy split is a healthy reply again.** The relay's mends wait per call — Chat's `tool_calls[].index`, Messages' block `index`, Responses' `item_id` — the way the encoders already hold a cut escape, so a `\r\n` cut across two fragments arrives as the pair it is. Your probe's stream (`partial_json` split as `{"content":"line1\r` | `\nline2\r\n"}`, relayed through `/v1/messages`) reads back whole. A healthy split case stands for each protocol's relay, red on the round-2 branch: Messages, Chat, Responses, and Codex's `custom_tool_call_input.delta` — apply_patch's input is raw text, read as bytes, so its CRLF line ending survives a cut too.

**The hot path.** `crTidy` looks for a line's end in the new bytes of a read alone, and a region without the escape is said from where it lies. Your 24MB line in 32KB reads took 2.45s through the round-2 filter on this machine; it takes 23ms now, and 65ms when the line carries a call to mend. The test clocks both (`TestCRTidyTwentyFourMBLine`). Lines are still framed on `\n`, the way `intTidy` frames them — an upstream framing SSE on bare CR alone would wait for the stream's end; none seen, said for completeness.

**A text delta stands.** Which events carry arguments is read from the event's own type or shape, never from a line's words: a text delta that only mentions the arguments' event names keeps its `\r` (`TestRelayedTextDeltaMentioningArgumentsStands`, red on round 2).

**The call's end is said.** The encoders' dropper is flushed when a call ends (`crEncoder.say`): a `\r` that turned out alone goes, a bare `\` is said as it came.

The defect is cured where it was: fragments stitched with the escape lose it across any fragment boundary (`TestRelayedSplitDefectStillCured`), a line ending, a `\n` and a `\\r` stand.

**Verification**

| Check | Result |
|---|---|
| The family's 24 tests, `-count=1`, on main `62a1dcdd7` | all pass |
| Healthy split-CRLF relays (Messages / Chat / Responses / custom input), the text delta's and the scope's tests | red on the round-2 branch (`b7d83ba8d` cherry-picked onto `62a1dcdd7`), pass here |
| The round-2 branch's own tests, their models pointed at `glm-5.3-flash` | all pass |
| Ablation: the flag unwired (`gateway.go`, `ir.go` back at upstream), tests kept | the 13 cure tests red; the 6 not-touched tests green |
| `go test -tags nogui ./internal/gateway/...` | ok |
| `gofmt -l` on the touched files; `go vet ./...`; `GOOS=linux` and `GOOS=windows go vet` on the touched packages | clean |
| `go build -tags nogui -o /dev/null ./...`, darwin / linux / windows | all pass (the gui package's cgo warnings are pre-existing) |
| `go test -race` on the family | ok |

**Not verified**

- Against a real defective upstream — still no access to a replica that stitches CRs; the repro replays the wire shapes the transcript implies.
- The relay pass covers the three protocols the defect's routes speak (Messages, Chat, Responses); a Gemini-protocol *upstream* relayed to a Gemini client is not covered. A Gemini *client* on one of those routes is, encoder and render.

The branch replaces `hunt102-a-4256-cr-toolargs` — one commit on main `62a1dcdd7`, head `83a8958fe`:
[hunt102-a-4256-cr-toolargs](https://github.com/ggbdpq/magpie/tree/hunt102-a-4256-cr-toolargs)

Patch by ggbdpq (Discord gua2100). Written with GLM-5.3-Flash (ZCode); I have read the whole diff and the tests above are its run. If anything here is unclear or wrong, say the word and I will fix or take it back.
