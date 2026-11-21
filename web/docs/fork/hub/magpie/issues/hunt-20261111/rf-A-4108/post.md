Refresh of my verification above, not a redesign: @hqhq1025's same commit (`8696b500` on their fork, applied here with the author preserved and the added lines byte-identical) rebased onto current `upstream/main` (`12610cf2f`) and the whole verification re-run — the branch had drifted ~1250 commits since November 4. Upstream still has no conversion for plain `agent_message` on the relayed Responses path (`keepsAgentMessages`/`agentMessagesAsUser` exist nowhere on main), and no upstream commit touches the four files this patch changes in the meantime, so the fix remains as needed.

@icining's protocol probing above (November 5) corroborates the shape this patch converts to: the task reaches the model only when the item is a plain `message(role=user)` with `input_text` parts, and the probe keeps real sealed content out of scope, which this patch matches — a sealed item (`encrypted_content`) is left exactly as it came on every upstream.

**What the patch does**: for relayed Responses requests, each plain `agent_message` goes as a user turn naming sender and recipient (`From /root/research to /root`), via `keepsAgentMessages`/`agentMessagesAsUser` in `internal/gateway/codex_backend.go` + `provider.AgentMessageAsUser` in `internal/provider/grok.go`, wired at the one passthrough site (`internal/gateway/gateway.go`). Upstreams that read the item themselves — OpenAI's API, the ChatGPT backend, Azure OpenAI, Copilot, another Magpie — are kept as before, and a sealed item is left unchanged on every upstream.

<details><summary>patch: fix: send Codex agent messages as user turns to third-party Responses APIs — git am applies it as is; SHA-256 first 16: b35a902ae268efbe</summary>

```text
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
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
index bdab12dbf..be18aed30 100644
--- a/internal/gateway/codex_backend.go
+++ b/internal/gateway/codex_backend.go
@@ -3724,6 +3724,48 @@ func userMessage(text string) map[string]any { return codexsummary.UserMessage(t
 // it, as agentQuietMost.
 var compactWithin = 4 * time.Minute
 
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
index 64a4efdbd..41543e8ff 100644
--- a/internal/gateway/gateway.go
+++ b/internal/gateway/gateway.go
@@ -6491,6 +6491,9 @@ func (s *Server) passthrough(w http.ResponseWriter, r *http.Request, p provider.
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
index 85946d30c..1a64fb505 100644
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

**Branch with the commit**: [`hunt-20261111-rf-4108`](https://github.com/ggbdpq/magpie/tree/hunt-20261111-rf-4108) (head `d3a35ed177268fed1f750d55a5e7b521db647d47`), rebased onto current `upstream/main` (`12610cf2f`); on a fresh checkout `git am` applies it as is (replayed on a detached `12610cf2f` worktree, resulting tree identical to the branch head, checked by tree hash). Author kept as `hqhq1025`; please keep them, or add `Co-authored-by: hqhq1025 <1506751656@qq.com>` alongside.

Verification this round (all on `12610cf2f` + this commit, `GOCACHE` pinned):

| Check | Result |
| --- | --- |
| `TestThirdPartyResponsesGetAgentMessageAsUser` + `TestGrokGetsAgentMessageAsUser` + `TestGrokPluginGetsAgentMessageAsUser` | ok (1.2s) |
| Ablation: the passthrough call (`if !keepsAgentMessages(p) { body = agentMessagesAsUser(body) }`) lifted, test kept | red: the third-party upstream receives `"type":"agent_message","author":"/root/research"` verbatim — DeepSeek's silent drop, the report's failure; restored: green |
| `go test -race -run '^TestThirdPartyResponsesGetAgentMessageAsUser$'` | ok (2.6s) |
| `go test -tags nogui -timeout 12m -count=1 ./internal/provider/` | ok (198s), zero failures |
| `gofmt -l` on the four touched files | prints nothing |
| `go vet -tags nogui ./internal/gateway/ ./internal/provider/` | clean |
| `go build -tags nogui ./...` darwin / `GOOS=linux` / `GOOS=windows` | clean |

**Siblings**: `rg "agent_message"` on the tip — the translated Responses path converts already (`responses.go`, held by `TestGrokGetsAgentMessageAsUser`), the plugin parity face is held by `TestGrokPluginGetsAgentMessageAsUser`, the Codex backend's own paths read the item where it is understood (`codex_backend.go`), traces carry it for display only (`sessions/traces.go`, `carry_convert.go`). The relayed passthrough has exactly one call site (`gateway.go`), which is the only place this patch wires. `keepsAgentMessages`' allowlist names each upstream family that reads the item itself; every other Responses upstream gets the user-turn form.

**Not verified**: a real DeepSeek key through Codex desktop's MultiAgentV2 end to end (the reporter's environment; the package tests use fake Responses upstreams); Azure in production (held by the fake-preset test only).

**Attribution**: the fix is @hqhq1025's, verified and carried by me; AI-assisted verification (GLM-5.3-Flash via ZCode). I've read the whole diff and can answer questions on it.
