## What the issue is

A routing group with a `compact: true` rule sends compaction requests to a cheaper model. When Alma compacts, `internal/gateway/compacting.go` does not recognise the request: its tables of agents' compaction prompts (`compactSystems`, `compactAsks`) cover Claude Code, Codex, OpenCode, Pi, Gemini CLI, Qwen Code, Minis and Kimi Code, but not Alma. The request therefore goes to the intent classifier and lands on another rule's model, so every compaction costs more than the group intended.

Reproduced on base `95ef45fda4b3978e94f12954a27d41e5ef1dca85`: a request whose last user message opens with Alma's compaction ask goes to the rule that matches on tokens, and `X-Magpie-Model` names that rule's member instead of the compact rule's.

Branch: [`hunt44-b-gw-alma-compact`](https://github.com/ggbdpq/magpie/tree/hunt44-b-gw-alma-compact), one commit on top of upstream `95ef45fda4b3978e94f12954a27d41e5ef1dca85`; the patch below applies with `git am`.

## What changed

One entry in `compactAsks`, mirroring the existing style:

```go
// Alma, which opens the user message of its compaction with this ask
// and sends the conversation behind it (#2833, as the report quotes it)
{ask: "Merge the previous summary with the new conversation."},
```

The ask is at byte 0 of the last user message, well inside `compactLead` (2048 bytes), so `leads()` recognises it with no change to the matching code.

I did **not** add a `compactSystems` entry. The opening of Alma's compaction system prompt is not in the repository (nothing under `internal/gateway`, `internal/sessions`, `docs` or `internal/agentplug` carries it) and the report does not quote it, so I did not invent one. The ask alone is sufficient for the case reported.

## Red before the fix

Base `95ef45fda4b3978e94f12954a27d41e5ef1dca85`, test `TestRuleCompactAlma`, product file as it is on base:

```
--- FAIL: TestRuleCompactAlma (0.13s)
    compacting_test.go:359: Alma compacting: 200 {"id":"x","choices":[{"index":0,"message":{"role":"assistant","content":"from kb"},"finish_reason":"stop"}],...} "b/big" &{N:2 Use:b/big When:[tokens ≥ 1] Held:false Waits:false Grown:false Turn:1 Tokens:62 Images:false Effort: Folder: Unready:false Then:[] Instead: Classified:<nil> Pick: Wanted: Compact:false Small:[] Bare:false UseEffort: members:[]}
FAIL
FAIL	github.com/yetone/magpie/internal/gateway	1.106s
```

The request was answered by `b/big` (`from kb`) and the route says `Compact:false`: the compact rule was not consulted. After the entry was added the same test passes and the route says `N:1 Use:a/small ... Compact:true`, with `X-Magpie-Model: a/small`.

Ablation: with the test kept and `compacting.go` restored from `upstream/main`, the same assertion fails; copying the fixed file back makes it pass again. Mutation: changing one word of the new entry (`with` → `into`) fails the test the same way; restoring it passes.

## Verification

| Check | Result |
| --- | --- |
| `go test -tags nogui -count=1 -run 'TestCompact\|TestCompacting\|TestRule' ./internal/gateway/` | exit 0, `ok 2.839s` |
| `go test -tags nogui -count=1 ./internal/gateway/` (full package) | exit 0, `ok 344.144s` |
| `go test -race -tags nogui -count=1 -run 'TestCompact\|TestCompacting' ./internal/gateway/` | exit 0, `ok 2.172s` |
| `gofmt -l internal/gateway/` | empty |
| `go vet -tags nogui ./internal/gateway/` | exit 0 |
| `GOOS=linux go vet -tags nogui ./internal/gateway/` | exit 0 |
| `GOOS=windows go vet -tags nogui ./internal/gateway/` | exit 0 |
| `go build -tags nogui ./...` | exit 0 |
| `GOOS=linux go build -tags nogui ./...` | exit 0 |
| `GOOS=windows go build -tags nogui -o /dev/null .` | exit 0 |

## Siblings and the boundary

The new entry uses the plain `ask` form, so `leads()` bounds it to the first 2048 bytes of a text part of the last user message. That bound is what keeps the entry from turning every note that mentions the phrase into a compaction, the precedent this file records from #1635 (a Minis memory holding Minis's compaction line sent every request of that conversation to the compaction rule's model).

The test asserts that boundary directly: the negative case is a long message (200 repeated conversation lines) with the **complete** Alma ask embedded past `compactLead`, followed by an ordinary question. It must route by the non-compact rule (`b/big`, `Compact:false`). Raising `compactLead` to `1 << 20` makes that negative assertion fail (`a/small`, `Compact:true`), which confirms the test is exercising the bound and not merely a wording mismatch. Restoring the constant makes it pass.

## Not verified

- No real Alma client was run. The wording is quoted from the report on this issue; I did not observe Alma's request myself, and the system-prompt opening was not available to check.
- The match relies on the ask starting within 2048 bytes of the user message. The report says it is at byte 0; a request that places it later would not match.

<details><summary>patch: gateway: a compaction rule sees Alma's compaction ask (#2833)</summary>

```diff
From 3d8ed8560fa3365aaa9ddbc7403ca902a5e6a417 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Mon, 19 Oct 2026 01:22:26 +0800
Subject: [PATCH] gateway: a compaction rule sees Alma's compaction ask (#2833)

What changed: compactAsks in internal/gateway/compacting.go gains Alma's
compaction ask, "Merge the previous summary with the new conversation.",
which opens the last user message of Alma's compaction request. A group's
compact rule now matches it. No compactSystems entry was added: neither the
repository nor the report carries the opening of Alma's compaction system
prompt, so none is invented.

Why: compacting.go matched the compaction prompts of Claude Code, Codex,
OpenCode, Pi, Gemini CLI, Qwen Code, Minis and Kimi Code literally. Alma was
not in the table, so its compaction fell through to the intent classifier and
was routed by another rule's model, making every compaction cost more than
the group's compact rule intended. The ask sits at byte 0 of the user message,
well inside compactLead (2048), so one table entry recognises it.

Test: TestRuleCompactAlma drives a group whose rule 1 is compact and rule 2 is
tokens >= 1 through the gateway. With the fix the Alma request is answered by
rule 1's member and X-Magpie-Model says a/small; without it the request goes
to b/big. The same test asserts a long message that only quotes the ask past
compactLead is not a compaction; raising compactLead makes that assertion
fail, so the bound is what keeps notes from matching.

Run: go test -tags nogui -count=1 -run 'TestCompact|TestCompacting|TestRule'
./internal/gateway/ (ok, 2.839s); go test -tags nogui -count=1
./internal/gateway/ (ok, 344.144s); go test -race -tags nogui -count=1 -run
'TestCompact|TestCompacting' ./internal/gateway/ (ok, 2.172s); gofmt -l
internal/gateway/ (empty); go vet -tags nogui ./internal/gateway/ and with
GOOS=linux and GOOS=windows (all ok); go build -tags nogui ./..., GOOS=linux
go build -tags nogui ./..., and GOOS=windows go build -tags nogui -o /dev/null .
(all ok). Not tried against a real Alma client: the wording is quoted from
the report.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/compacting.go      |  3 +++
 internal/gateway/compacting_test.go | 38 +++++++++++++++++++++++++++++
 2 files changed, 41 insertions(+)

diff --git a/internal/gateway/compacting.go b/internal/gateway/compacting.go
index 3a7c5574..f6a2bc3a 100644
--- a/internal/gateway/compacting.go
+++ b/internal/gateway/compacting.go
@@ -54,6 +54,9 @@ var compactAsks = []compactAsk{
 	{ask: "You are now given a task to compact this conversation context"},
 	// Minis, around the conversation it sends as one user message
 	{ask: "END OF CONVERSATION TO COMPACT.", opens: "Compact this conversation into a context summary:"},
+	// Alma, which opens the user message of its compaction with this ask
+	// and sends the conversation behind it (#2833, as the report quotes it)
+	{ask: "Merge the previous summary with the new conversation."},
 }
 
 // leads reports whether p begins within compactLead bytes of text's start.
diff --git a/internal/gateway/compacting_test.go b/internal/gateway/compacting_test.go
index 48cb6ad9..5407a833 100644
--- a/internal/gateway/compacting_test.go
+++ b/internal/gateway/compacting_test.go
@@ -330,3 +330,41 @@ func TestCompactingAsksWhereTheAgentPutsThem(t *testing.T) {
 		}
 	}
 }
+
+// Alma's compaction ask, as the report on #2833 quotes it: the first bytes
+// of the last user message, the conversation behind it.
+const almaCompactAsk = "Merge the previous summary with the new conversation. Produce the <analysis>, then the merged structured summary exactly as instructed. The conversation continues after your summary — do not conclude it."
+
+// Alma compacting is recognised by its ask, at the start of the last user
+// message (#2833): a group's compact rule sends it to its model and says so
+// in X-Magpie-Model, while a note that only quotes the ask further into a
+// long message goes by the rule that matches it, as compactLead bounds it.
+func TestRuleCompactAlma(t *testing.T) {
+	s, _, _ := ruled(t, provider.Rule{Use: "a/small", Compact: true}, provider.Rule{Use: "b/big", Tokens: 1})
+	post := func(body string) (*httptest.ResponseRecorder, Route) {
+		t.Helper()
+		rec := httptest.NewRecorder()
+		req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(body))
+		req.Header.Set("x-session-id", "alma")
+		s.Handler().ServeHTTP(rec, req)
+		return rec, lastRoute(s)
+	}
+	alma := func(text string) string {
+		return `{"model":"group/r","messages":[{"role":"user","content":` + quote(text) + `}]}`
+	}
+
+	rec, r := post(alma(almaCompactAsk + "\n\n[user]: tidy up my desktop\n[assistant]: done"))
+	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "from ka") ||
+		rec.Header().Get(modelHeader) != "a/small" || r.Rule == nil || !r.Rule.Compact || r.Rule.N != 1 {
+		t.Fatalf("Alma compacting: %d %s %q %+v", rec.Code, rec.Body.String(), rec.Header().Get(modelHeader), r.Rule)
+	}
+
+	// a long message that quotes the ask deep in is no compaction: only
+	// compactLead keeps it from being one, as it does the agents' own asks
+	history := strings.Repeat("[user]: tidy up my desktop\n[assistant]: done\n", 200)
+	rec, r = post(alma(history + "\n" + almaCompactAsk + "\nWhat does this line in my log mean?"))
+	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "from kb") ||
+		rec.Header().Get(modelHeader) != "b/big" || r.Rule == nil || r.Rule.Compact || r.Rule.N != 2 {
+		t.Fatalf("a quoted Alma ask: %d %s %q %+v", rec.Code, rec.Body.String(), rec.Header().Get(modelHeader), r.Rule)
+	}
+}
-- 
2.50.1 (Apple Git-155)
```

</details>

**AI**: written with an AI coding agent; I've read the whole diff and can answer questions on it myself (the model name is in the commit's trailer below).

**Attribution**: If you apply the patch, please keep its author (ggbdpq) or add a `Co-authored-by: ggbdpq <ggbdpq@gmail.com>` line.
