Verified https://github.com/skygunner/magpie/commit/b7726551109dae0bc6b406cb2dddd62abd9d4e2f by cherry-picking it onto upstream/main `63be4771` and ablating the product change on Windows (Go with pinned GOPATH/GOMODCACHE/GOCACHE).

The discard surface matches the diagnosis: the drop lives only in the resume path `saidWithResults` (its single caller is the `continueWith` results handoff in `internal/gateway/claude_subscription.go`), where the system/developer skip and the `agentNotice` gate — whose injected leads hold `<task-notification>` — both removed the notification. The fix turns exactly those gates into deliverers and touches nothing else: fresh prompts and requests without results keep their ordinary path (a new protective test pins that a notification without results is not requeued), hook notices and token counts stay filtered, incomplete blocks stay filtered, and plain user text still passes. Compared to the proposed patch (a contains-and-forward branch that would also have carried hook notices when a notification shared a system message with them, and left notice-inside-a-mid-turn-envelope misattributed as user words), this version extracts complete `<task-notification>…</task-notification>` blocks — multiple blocks, both envelope orders, hooks around them — which is strictly closer to the #2060 contract; its `hooks`, `user then notice` and `notice then user` rows fail against the proposal's code.

Ablation, `go test -tags nogui -count=1 -run 'TestClaudeTaskNotificationGoesOnWithTheResults|TestClaudeTaskNoticeWithoutResultsIsNotRequeued' ./internal/gateway`, with `claude_subscription.go` reverted to `63be4771` and the tests kept:

```
--- FAIL: TestClaudeTaskNotificationGoesOnWithTheResults (0.16s)
    --- FAIL: TestClaudeTaskNotificationGoesOnWithTheResults/system (0.00s)
        claude_hook_notice_test.go:138: run was told "", want "<task-notification>\n<task-id>a964b3e6d1a85579a</task-id>\n<tool-use-id>toolu_01DHwj5uLApARZnKU3EZjxyC</tool-use-id>\n<output-file>/private/tmp/claude-501/tasks/a964b3e6d1a85579a.output</output-file>\n<status>completed</status>..."
```

8 of the 11 rows fail on base (`system`, `with results`, `user`, `developer`, `hooks`, `two notices`, `user then notice`, `notice then user`); `incomplete`, `ordinary user` and `ordinary system` stay green on base by design, pinning the preserved filters. With the fix restored, the two tests plus the neighboring hook-notice, mid-turn-user and turn-reading families (`TestClaudeHookNoticesAreNotTheUsersMessage`, `TestClaudeUsersMessageAmongHookNoticesGoesOnAlone`, `TestClaudePromptToldHookNoticesNotAsTheUsers`, `TestAgentNoticeLeavesTheUsersWords`, `TestTurnInSkipsWhatTheAgentPutIn`, `TestIntentHoldsPastWhatTheAgentPutIn`):

```
ok  	github.com/yetone/magpie/internal/gateway	3.542s
```

Attribution, checked in the commit itself: Author `vincent <webmaster@palmit.com.au>`, and the message carries exactly `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

Drift and landing: the commit's parent (`8f931a28`) is 485 commits ahead of `63be4771`; 5 of them touch `claude_subscription.go`/`prompt.go` and shift the file by ~450 lines, but not the `saidWithResults` region — the cherry-pick applied cleanly in all three files. One landing note if both this and the earlier proposal (`d0a9ef61`) were ever applied together: both add a test named `TestClaudeTaskNotificationGoesOnWithTheResults` to `claude_hook_notice_test.go`, so one of the two has to be dropped or renamed; behaviorally this commit supersedes the proposal. Today's main (`e00fbdbb`) still lacks the fix and takes the commit's whole diff clean (`apply --3way --check`).

On reproducibility, restating what is and is not established: the reporter's A/B (2/2 `SEEN` direct, 3/3 `NOT_SEEN` through magpie, the client's own stream-json emitting the notification on both sides) stands as reported and was not re-run here or by the author, who states plainly: no live Claude subscription or real Claude Code 2.1.303 A/B was performed, the local CLI is 2.1.306, and "the original end-to-end reproduction still needs that confirmation". The tests use the captured notification fixture from #2060 plus synthetic envelopes; 2.1.303's exact bytes are inferred, not captured.

Ran here: the RED/GREEN above; `gofmt -l` clean on both files; `go vet -tags nogui ./internal/gateway` clean. Not run here: `-race` (author ran `-race -count=5` on Linux; this box has no C compiler for cgo), the 69-package acceptance sweep, and anything needing a real subscription or CLI.

Thanks for the fix, the block-extraction hardening, and the co-author credit.

Verified with AI assistance (GLM-5.3-Flash via ZCode); I've read the diff and re-ran the checks above.
