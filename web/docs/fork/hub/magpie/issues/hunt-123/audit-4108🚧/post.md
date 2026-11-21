Verified the patch from this issue on top of the current `main` — it applies cleanly with `git am` and fixes the reported failure.

## What's wrong

A Codex subagent on DeepSeek receives no task: it sees only the AGENTS.md instructions and asks what to do (it has no task to work on), while DeepSeek returns no error (@hqhq1025's report above, v0.1.1734, `deepseek/deepseek-flash`, Codex desktop MultiAgentV2).

## Root cause

Magpie relays Codex's `/v1/responses` request to third-party Responses APIs unchanged. MultiAgentV2 hands a subagent its task — and the lead its subagent's reply — as an `agent_message` input item. DeepSeek's API does not know that item and silently drops it, so the subagent answers with no task. Magpie already converts this item for translated requests (`readResponses`) and for Grok (`grokAgentMessage`, plugins#61), but not for relayed Responses upstreams.

## The fix

Patch by @hqhq1025 ([commit 8696b500 on their fork](https://github.com/hqhq1025/magpie/commit/8696b500ea4f1c425c914e2ec4eec1a76cd5eb96)), applied to `fix/4108-agent-message-verify` and rebased onto the current `main` as `e1aabd98f`, the author preserved and the added lines byte-identical to their commit. For relayed Responses requests, each plain `agent_message` is now sent as a user turn that names the sender and recipient first (`From /root/research to /root`), via `keepsAgentMessages`/`agentMessagesAsUser` in `internal/gateway/codex_backend.go` + `provider.AgentMessageAsUser` in `internal/provider/grok.go`. Upstreams that read the item themselves — OpenAI's API, the ChatGPT backend, Azure OpenAI, Copilot, another Magpie — are kept as before, and a sealed item (`encrypted_content`) is left unchanged on every upstream. Two cosmetic notes, both in the original patch and left exactly as the author wrote them since `git am` applies it as is: the doc comment on `AgentMessageAsUser` starts with a stray line duplicating the `liteNamespace` comment, and the new test's doc comment starts with a half-line left from the Grok test above it.

<details>
<summary>patch (git am applies it as is; SHA-256 first 16: <code>ad68feeb0110a0b7</code>)</summary>

```patch
From e1aabd98f0c067de84f45ed306b8743d0fb3414e Mon Sep 17 00:00:00 2001
From: hqhq1025 <1506751656@qq.com>
Date: Thu, 29 Oct 2026 00:36:15 +0800
Subject: [PATCH] fix: send Codex agent messages as user turns to third-party
 Responses APIs

---
 internal/gateway/codex_backend.go           | 42 +++++++++++++++++++++
 internal/gateway/gateway.go                 |  3 ++
 internal/gateway/grok_agent_message_test.go | 38 +++++++++++++++++++
 internal/provider/grok.go                   |  5 +++
 4 files changed, 88 insertions(+)

diff --git a/internal/gateway/codex_backend.go b/internal/gateway/codex_backend.go
index 46ad1b257..2cfc5cee9 100644
--- a/internal/gateway/codex_backend.go
+++ b/internal/gateway/codex_backend.go
@@ -3463,6 +3463,48 @@ func developerItemsAsSystem(body []byte) []byte {
 
 func userMessage(text string) map[string]any { return codexsummary.UserMessage(text) }
 
+// keepsAgentMessages says p's Responses API reads Codex's agent_message
+// item: OpenAI's API, the ChatGPT backend, Azure OpenAI (which asks for its
+// author), Copilot (its subagents get the task as Codex sent it, #656) and
+// another magpie, which fits it to its own upstream. A compatible API
+// elsewhere can drop the unknown item without an error. DeepSeek did, so a
+// subagent on it got AGENTS.md but not its task.
+func keepsAgentMessages(p provider.Provider) bool {
+	return p.Account != nil && p.Account.Agent == "codex" ||
+		strings.HasSuffix(p.Host(), "openai.com") ||
+		p.IsAzure() || p.ID == "copilot" || p.IsRemoteMagpie()
+}
+
+// agentMessagesAsUser is body with each plain agent_message sent as the
+// user's message. A sealed one stays as it came.
+func agentMessagesAsUser(body []byte) []byte {
+	if !bytes.Contains(body, []byte(`"agent_message"`)) {
+		return body
+	}
+	dec := json.NewDecoder(bytes.NewReader(body))
+	dec.UseNumber()
+	var q map[string]any
+	if dec.Decode(&q) != nil || q == nil {
+		return body
+	}
+	input, _ := q["input"].([]any)
+	changed := false
+	for i, it := range input {
+		if msg, ok := provider.AgentMessageAsUser(it); ok {
+			input[i] = msg
+			changed = true
+		}
+	}
+	if !changed {
+		return body
+	}
+	nb, err := marshalPlain(q)
+	if err != nil {
+		return body
+	}
+	return nb
+}
+
 // codexCompact compacts a conversation held by a magpie model: the model
 // summarises it, and the summary goes back to Codex as the compaction item
 // the backend would have made, marked as magpie's so magpie reads it back
diff --git a/internal/gateway/gateway.go b/internal/gateway/gateway.go
index 19b204409..77f6cea12 100644
--- a/internal/gateway/gateway.go
+++ b/internal/gateway/gateway.go
@@ -5767,6 +5767,9 @@ func (s *Server) passthrough(w http.ResponseWriter, r *http.Request, p provider.
 		// Ark takes web_search in the shape its docs give, and only the include
 		// values it knows (search_ark.go)
 		body = forArkSearch(p, body)
+		if !keepsAgentMessages(p) {
+			body = agentMessagesAsUser(body)
+		}
 		if replay {
 			// its reasoning goes back as text, never left out: DeepSeek
 			// refuses a request without it (#1104)
diff --git a/internal/gateway/grok_agent_message_test.go b/internal/gateway/grok_agent_message_test.go
index f8b2b8596..5362976f5 100644
--- a/internal/gateway/grok_agent_message_test.go
+++ b/internal/gateway/grok_agent_message_test.go
@@ -42,6 +42,44 @@ func checkAgentMessageSent(t *testing.T, q map[string]any) {
 	}
 }
 
+// A Codex subagent's plain agent_message reaches a Grok subscription as the
+// A third-party Responses API, such as DeepSeek's, gets a subagent's plain
+// task as the user's message. DeepSeek dropped the unknown agent_message
+// without an error, and the subagent answered with no task to do. Azure
+// OpenAI reads the item (it asks for its author), so it gets it as it came.
+func TestThirdPartyResponsesGetAgentMessageAsUser(t *testing.T) {
+	for _, azure := range []bool{false, true} {
+		f := &fake{t: t, reply: responsesUncounted}
+		up := setup(t, provider.Responses, f)
+		if azure {
+			p := provider.Provider{ID: "fake", Name: "Fake", Key: "k", Models: []string{"m1"}, Preset: provider.AzurePreset, Responses: up.URL + "/openai/v1"}
+			if err := provider.Save(p); err != nil {
+				t.Fatal(err)
+			}
+		}
+		code, reply := post(t, "/v1/responses", `{"model":"fake/m1","stream":true,`+agentMessageTurn+`}`)
+		if code != 200 {
+			t.Fatalf("azure %v: %d %s", azure, code, reply)
+		}
+		sent := string(f.got)
+		if !strings.Contains(sent, `found the cause`) {
+			t.Fatalf("azure %v: the subagent's message was lost: %s", azure, sent)
+		}
+		if azure {
+			if !strings.Contains(sent, `"type":"agent_message"`) || !strings.Contains(sent, `"author":"/root/research"`) {
+				t.Fatalf("Azure was not sent the agent_message as it came: %s", sent)
+			}
+			continue
+		}
+		if strings.Contains(sent, `"agent_message"`) {
+			t.Fatalf("the upstream was sent an agent_message: %s", sent)
+		}
+		if !strings.Contains(sent, `From /root/research to /root`) {
+			t.Fatalf("the sender and recipient were not named: %s", sent)
+		}
+	}
+}
+
 // A Codex subagent's plain agent_message reaches a Grok subscription as the
 // user's message, which its backend refused with 422 "unknown item type
 // \"agent_message\"" (plugins#61).
diff --git a/internal/provider/grok.go b/internal/provider/grok.go
index 4035d4a2b..4154e7fd3 100644
--- a/internal/provider/grok.go
+++ b/internal/provider/grok.go
@@ -327,6 +327,11 @@ func grokAgentMessage(it any) (map[string]any, bool) {
 	return map[string]any{"type": "message", "role": "user", "content": content}, true
 }
 
+// liteNamespace is the namespace Codex's Responses Lite groups its own
+// AgentMessageAsUser is grokAgentMessage for any Responses upstream that
+// does not know Codex's agent_message item.
+func AgentMessageAsUser(it any) (map[string]any, bool) { return grokAgentMessage(it) }
+
 // liteNamespace is the namespace Codex's Responses Lite groups its own
 // functions in, which Codex reads as none at all.
 const liteNamespace = "functions"
-- 
2.50.1 (Apple Git-155)
```

</details>

## Verification

| Check (all run on the patch tree, Go 1.26.8, darwin/arm64) | Result |
| --- | --- |
| `go test ./internal/gateway -run 'TestThirdPartyResponsesGetAgentMessageAsUser\|TestGrokGetsAgentMessageAsUser' -count=1` | PASS |
| `go test -tags nogui -count=1 ./internal/gateway` (full package) | ok 621.6s, no failures (rebased head `e1aabd98f`) |
| `gofmt -l internal/gateway internal/provider` | empty |
| `go vet -tags nogui ./internal/gateway` | clean |
| Ablation on `e1aabd98f`: revert the three product files to the parent commit, rerun | `TestThirdPartyResponsesGetAgentMessageAsUser` fails with `the upstream was sent an agent_message` (the patch's net effect); `TestGrokGetsAgentMessageAsUser` still passes, as expected — Grok's own conversion predates the patch. Both green again after restore |
| Exclusion guards on the patch tree: `TestCopilotUltraSubagentWithWebSearch` (Copilot gets `agent_message` as Codex sent it), `TestSealedReplyGoesBackToTheProviderThatAnsweredTheLead` + `TestSealedTaskGoesBackToTheRelayThatSealedIt` (sealed items relayed as they came), `TestCodexSealedAgentHandoffNativePassthrough` (ChatGPT backend native path keeps the ciphertext) | all six PASS |

The reporter's exclusion list holds in code too: `keepsAgentMessages` short-circuits for codex accounts, `openai.com` hosts, Azure, Copilot and remote Magpie before any conversion, and `grokAgentMessage` refuses any item or content part carrying `encrypted_content`.

**Not verified**: no live DeepSeek/Codex MultiAgentV2 run (the reporter's live comparison above covers that); the Bun-based Grok plugin parity tests (same as the reporter). The two cosmetic comment artifacts noted above are in the original patch and left untouched.

**Branch with the commit**: https://github.com/ggbdpq/magpie/tree/fix/4108-agent-message-verify (head e1aabd98f0c067de84f45ed306b8743d0fb3414e)

**Attribution**: patch by @hqhq1025 (commit 8696b500 on their fork); I've verified the diff (added lines are byte-identical to their commit) and the tests pass. Please keep the author (hqhq1025) or add `Co-authored-by: hqhq1025 <1506751656@qq.com>` when applying.

AI use: verified and published by an agent (GLM, ZCode) working for @ggbdpq.
