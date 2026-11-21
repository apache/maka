Pi's cache warming never starts for a routing group, and the group's cache is paid for at full price every turn — while the cache itself is there.

**Symptom**: on Pi, a session via `auto/claude-opus-5-5` (an anthropic-plugin member) logs `cache_read 0 / cache_write 230,276`, then `7,468 / 227,020`, then `7,468 / 244,220` across idle gaps of 23–82 minutes — the first minutes of every turn are re-billed, and there is no `cache_warm` entry for the session. Sessions on Pi's own `anthropic/claude-opus-5-5` have cache-warm entries.

**Root cause**: Pi's `cacheWarming` weighs a model entry by its `promptCache` and stops with "cache lifetime unavailable" without one. magpie declares that field only where `piPromptCache` sees the entry's own `api` — `anthropic-messages` (Claude) or `openai-responses` (GPT). A routing group has no `api` of its own (a Messages-only group stays on Chat, allResponses), so `auto/claude-*` went out with none. The cache itself exists: on the Chat path the gateway marks its translation to a Claude member ephemeral for five minutes.

**Fix**: the group now derives the field from its members — if any member would get `promptCache` on its own (`anthropic-messages` or `openai-responses`), the group's Pi entry carries `promptCache` too (with the five-minute lifetime the gateway actually applies), so Pi warms the group's cache instead of re-billing it.

**Verification** (base `c3593dc49`, head `d48290c92`):

| Check | Result |
| --- | --- |
| Red without the fix (`TestPiGroupPromptCache`, product file reverted, tests kept) | `--- FAIL: TestPiGroupPromptCache` |
| Green with the fix | `ok` 1.18s |
| `gofmt -l` internal/agent, `go vet -tags nogui`, `GOOS=linux/windows go build -tags nogui` | clean / clean / ok |

**Not verified**: a real Pi client end to end — the write-side is asserted directly and the reporter's own routing-log numbers back the symptom.

---
**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

**Patch**: <details><summary>patch: agent: a routing group with a Claude member tells Pi its cache keeps five minutes (#5037) — git am applies it as is; SHA-256 first 16: d0c1d2e6ea841af2</summary>

```patch
From d48290c92015520c1bab463f90a4cec16009fc27 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Tue, 3 Nov 2026 18:30:38 +0800
Subject: [PATCH] agent: a routing group with a Claude member tells Pi its
 cache keeps five minutes (#5037)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

Pi's cacheWarming weighs a model by its promptCache and stops with
"cache lifetime unavailable" without one. magpie declared it only where
piPromptCache saw the entry's own api — anthropic-messages for a Claude,
openai-responses for a GPT — and a routing group has no api of its own
(a Messages-only group stays on Chat, allResponses), so auto/claude-*
went out with none and Pi never warmed the group's cache, while the
cache itself was there: on the Chat path the gateway marks its own
translation to a Claude member ephemeral for five minutes (addedMark).

So the group now derives the field from its members: one asked on
Anthropic's Messages by its own provider, and the entry declares the
five minutes the gateway's own marks keep. long stays out — the gateway
marks an hour only where a session's turns are often far apart, so it
isn't always true — and a subscription's Claude (asked through Claude
Code, which caches on its own) still declares none, as before. An
all-Responses group keeps what it had: its entry's own api answers.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/agent/agents.go               | 17 +++++++++
 internal/agent/pi_group_effort_test.go | 52 ++++++++++++++++++++++++++
 2 files changed, 69 insertions(+)

diff --git a/internal/agent/agents.go b/internal/agent/agents.go
index 2ea834d14..e5ab54ed0 100644
--- a/internal/agent/agents.go
+++ b/internal/agent/agents.go
@@ -797,6 +797,23 @@ func piModelJSON(m catalog.Model, gw string, native bool) map[string]any {
 	}
 	if c := piPromptCache(e["api"], m.ID); c != nil {
 		e["promptCache"] = c
+	} else if native && e["api"] == nil {
+		// a routing group has no api of its own (a Messages-only group stays
+		// on Chat, allResponses), and went out with no promptCache, which
+		// stops Pi's cacheWarming with "cache lifetime unavailable" (#5037)
+		// — while whatever Claude member it picks has the gateway's own
+		// translation marking the request ephemeral for five minutes
+		// (addedMark). That short lifetime the group declares; long stays
+		// out, the gateway marks an hour only where a session's turns are
+		// often far apart, so it isn't always true.
+		if _, ms, ok := provider.GroupFinder()(m.ID); ok {
+			for _, g := range ms {
+				if g.Provider.Native(g.Model) == provider.Anthropic {
+					e["promptCache"] = map[string]any{"short": 300}
+					break
+				}
+			}
+		}
 	}
 	return e
 }
diff --git a/internal/agent/pi_group_effort_test.go b/internal/agent/pi_group_effort_test.go
index dbc868a65..c751b24bb 100644
--- a/internal/agent/pi_group_effort_test.go
+++ b/internal/agent/pi_group_effort_test.go
@@ -97,6 +97,58 @@ func TestPiGroupThinkingIsWhatPiRuns(t *testing.T) {
 	}
 }
 
+// #5037: a routing group has no api of its own — a Messages-only group
+// stays on Chat (allResponses) — so its entry went out with no promptCache
+// and Pi's cacheWarming stopped with "cache lifetime unavailable". Whatever
+// Claude member the group picks, the gateway's own translation marks the
+// request ephemeral for five minutes, so the group declares that short
+// lifetime; long stays out, the gateway marks an hour only where a
+// session's turns are often far apart (addedMark), so it is not always true.
+func TestPiGroupPromptCache(t *testing.T) {
+	syncHome(t)
+	if err := os.WriteFile(catalog.CachePath(), []byte(`{
+	  "ap": {"models": {"claude-opus-5-5": {"id":"claude-opus-5-5","name":"Claude Opus 5.5","limit":{"context":200000}}}},
+	  "zai": {"models": {"glm-4.6":{"id":"glm-4.6","name":"GLM-4.6","limit":{"context":204800}}}}
+	}`), 0o644); err != nil {
+		t.Fatal(err)
+	}
+	catalog.Reset()
+	if err := provider.Save(provider.Provider{ID: "ap", Name: "Anthropic Plugin", Key: "k", Anthropic: "http://127.0.0.1:2", Models: []string{"claude-opus-5-5"}}); err != nil {
+		t.Fatal(err)
+	}
+	if err := provider.SaveGroup(provider.Group{ID: "auto", Name: "Auto", Members: []string{"ap/claude-opus-5-5", "relay/glm-4.6"}}); err != nil {
+		t.Fatal(err)
+	}
+	ms := magpieProviderJSON("pi").(map[string]any)["models"].([]map[string]any)
+	var group bool
+	for _, e := range ms {
+		switch e["id"] {
+		case "group/auto":
+			group = true
+			if _, set := e["api"]; set {
+				t.Errorf("group api %v, want none (Chat)", e["api"])
+			}
+			if !reflect.DeepEqual(e["promptCache"], map[string]any{"short": 300}) {
+				t.Errorf("group/auto: promptCache %v, want {short: 300}", e["promptCache"])
+			}
+		case "ap/claude-opus-5-5":
+			if e["api"] != "anthropic-messages" {
+				t.Fatalf("member on %v, want anthropic-messages", e["api"])
+			}
+			if !reflect.DeepEqual(e["promptCache"], map[string]any{"short": 300, "long": 3600}) {
+				t.Errorf("member: promptCache %v, want short and long", e["promptCache"])
+			}
+		case "relay/glm-4.6":
+			if _, set := e["promptCache"]; set {
+				t.Errorf("relay/glm-4.6: promptCache %v, want none", e["promptCache"])
+			}
+		}
+	}
+	if !group {
+		t.Fatalf("no group/auto entry among %d", len(ms))
+	}
+}
+
 // Pi's clamp: the level itself, else the nearest above, else below.
 func TestPiClamp(t *testing.T) {
 	for _, c := range []struct {
-- 
2.50.1 (Apple Git-155)
</details>

**Branch with the commit**: [fix/5037-pi-promptcache](https://github.com/ggbdpq/magpie/tree/fix/5037-pi-promptcache) (head `d48290c92015520c1bab463f90a4cec16009fc27 Mon Sep 17 00:00:00 2001`).
