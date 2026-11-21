Refresh of my patch above, not a redesign: the same commit rebased onto current `upstream/main` (`0d0a1a567`) and the verification re-run. The note-writing face is still only the one call site (`notesPlaceholders` at the masked attempt, `gateway.go`), and `withNoteAnthropic` still appends at the end of the earliest placeholder message's content array on main — the adjacency break stands as reported.

Unchanged, as delivered: when the earliest placeholder message ends with a `tool_use`, the note goes before its first `tool_use` (`beforeToolUse` + an `inserted` helper beside `appended`/`prepended`); a message that doesn't end with a `tool_use` is told exactly as before. The in-message placement is the reporter's own suggestion and keeps the note on the earliest placeholder message, so it stays put on later turns and the cached prefix holds.

<details><summary>patch: gateway: masking's note doesn't come between a tool_use and its tool_result (#5447) — git am applies it as is; SHA-256 first 16: 25c2619ba9ca617e</summary>

```text
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Sat, 7 Nov 2026 23:54:18 +0800
Subject: [PATCH] gateway: masking's note doesn't come between a tool_use and
 its tool_result (#5447)

The note went to the end of the earliest message holding a placeholder,
whatever that message ends with. A message that ends with a tool_use got
the note after the call, where its tool_result must come immediately
after, and a strict Anthropic-protocol upstream (DeepSeek) turns the
request away: "tool_use ids were found without tool_result blocks
immediately after" (30 of 30 masked requests, aabbccgg). The note goes
before the message's first tool_use instead; a message that doesn't end
with a tool_use is told as it was.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/placeholder_note.go      | 38 ++++++++++++++++++++++-
 internal/gateway/placeholder_note_test.go |  3 ++
 2 files changed, 40 insertions(+), 1 deletion(-)
```

</details>

**Branch with the commit**: [`hunt-20261111-rf-5447`](https://github.com/ggbdpq/magpie/tree/hunt-20261111-rf-5447) (head `86e6989c2def9a4b608657cd60280fec205702ab`), rebased onto current `upstream/main` (`0d0a1a567`); on a fresh checkout at that tip `git am` applies it as is (replayed on a detached worktree, resulting tree identical to the branch head, checked by tree hash).

Verification this round (on `0d0a1a567` + this commit, `GOCACHE` pinned):

| Check | Result |
| --- | --- |
| `TestPlaceholderNotePlaces` + `TestPlaceholderNoteIsNeutral` + the placeholder family | ok |
| Ablation: the `beforeToolUse` branch made dead (build intact), note falls back to `appended` | red on the three tool_use placements: the note lands after the trailing `tool_use` (`messages.1.content` ends with the note where the `tool_result` must follow) — the shape DeepSeek refuses; restored: green |
| `gofmt -l` on the two touched files | prints nothing |
| `go test -tags nogui -timeout 40m -count=1 ./internal/gateway/` (whole package) | ok (925.7s), zero failures |
| `go vet -tags nogui ./internal/gateway/` | clean |
| `go build -tags nogui ./...` darwin / `GOOS=linux` | clean |

**Siblings** (re-checked on the current tip): `rg withNote` — four forms behind `notesPlaceholders`: Anthropic (this patch's face), Chat (an assistant turn's tool calls ride in the `tool_calls` field beside `content`, so an appended note can't come between a call and its result — unchanged), Responses (already steps past a call's run of outputs for this same adjacency — unchanged), Gemini (`parts`, no evidenced adjacency rule — unchanged). One call site (`gateway.go`, the masked attempt).

**Not verified**: a real DeepSeek key taking masked Claude Code traffic end to end (the report's environment; the tests shape the refusal as reported); the GUI masking alert's rendering.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.
