Verified the adaptation: [cf95652a](https://github.com/skygunner/magpie/commit/cf95652a876bb475a95c5769dbb09e8c743e3bc1) carries the fix from my [patch above](#issuecomment-6291803000) (895240da) onto `main`. Re-ran the whole cycle myself on `main` @ 63be4771 (Windows, go 1.26.5), with the commit cherry-picked as 2348450e on top of it.

**Fidelity** — the product change in `internal/gateway/codex_backend.go` is byte-for-byte the one from 895240da: same comment, same `unreadableItem` regexp adding the `referenced reasoning item` alternative beside OpenAI's own wordings (`git diff 895240da cf95652a -- internal/gateway/codex_backend.go` shows no other introduced change in the fix's hunk). The tests are mine kept intact, plus one new sibling-path regression the author added (`TestRelayUnreadableItemKeepsOtherInput`: named-item removal removes only the named item, and a 429 must not read as an input-item refusal) and a one-line `docs/subsystems/gateway-routing.md` update. The matcher's stable phrase and the test bodies quote the reporter's relay sample word for word (`OpenCode Go: Referenced reasoning item 'rs_…' was not found or has expired.`, the `rs_18e02568274e11f100000242` id included), so the wording is the real one, not a paraphrase.

**Ablation on 63be4771 + the commit, new tests kept, `codex_backend.go` reverted to 63be4771** (`go test ./internal/gateway/ -run 'TestRelayRefusedReasoningItemReadAsUnreadable|TestRefusesInput|TestRelayUnreadableItemKeepsOtherInput|TestBareReasoning|TestCodexCompactItemNotFoundAsksAgainAsText|TestForeignSeal|TestForeignReasoningIsLeftOut' -count=1 -v`), exit 1:

```
--- FAIL: TestRelayRefusedReasoningItemReadAsUnreadable (0.43s)
    bare_reasoning_test.go:199: 400 {"error":{"code":null,"message":"Relay: OpenCode Go: Referenced reasoning item 'rs_18dbe693b3dce4800000003c' was not found or has expired.","param":null,"type":"invalid_request_error"}}
    bare_reasoning_test.go:287: 400 {"error":{"message":"OpenCode Go: Referenced reasoning item 'rs_18e02568274e11f100000242' was not found or has expired.","type":"invalid_request_error"}}: false
--- FAIL: TestRefusesInput (0.00s)
    bare_reasoning_test.go:298: named unreadable item not removed alone: , false
--- FAIL: TestRelayUnreadableItemKeepsOtherInput (0.00s)
```

The old wordings' tests beside them all stayed green (the #1044, foreign-seal, compaction families). With `codex_backend.go` restored: same command, exit 0, `ok github.com/yetone/magpie/internal/gateway`, 10/10 test blocks.

**Shared matcher, all three readers** — at 63be4771 `rg unreadableItem internal/` gives exactly the matcher plus three readers, and all three take the relay's wording with the one-line change: `refusesInput` (read at `gateway.go:4225`, the passthrough re-ask without bare reasoning), `withoutUnreadable` (`codex_backend.go:1035`, named-item removal), `itemNotFound` (`codex_backend.go:2121`, compaction's text fallback). No fourth reader was left behind.

**Attribution** — checked in the commit itself: author is `vincent <webmaster@palmit.com.au>`, and the message carries the trailer verbatim:

```
Co-authored-by: ggbdpq <ggbdpq@gmail.com>
```

Thank you.

**Drift / landing** — the commit's parent (4671590d) is the author's own stacked batch branch, 483 commits past 63be4771 with 63be4771 as the merge-base, so nothing upstream is missing under it. Landing: on `63be4771` the doc line needed a hand drop; on today's main (`e00fbdbb`, checked 2026-10-23) the commit's whole diff — doc line included — passes `git apply --3way --check` clean, and the fix is still absent from it.

**Not verified here**: `-race` (this Windows host has no C compiler, so cgo can't build; the author reports the family green with `-race -count=5` on Linux, and my original verification ran it on darwin), and no real opencode.ai relay was called — the stub replays the reported body, as before.

Verified with AI assistance (GLM-5.3-Flash via ZCode); I've read the diff and re-ran the checks above.
