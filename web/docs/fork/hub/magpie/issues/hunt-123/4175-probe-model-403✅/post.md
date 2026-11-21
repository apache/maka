**What's wrong**

Confirmed — reproduced with plain curl against `main` (df7c94bdf), exactly as @KamijoToma located it. Thank you for the precise chain: it made the root cause one line.

For `agent=claude-desktop`, magpie stands a request on another model **before** the key-model check: the gateway probe (`max_tokens: 1`, a single `.` user message) is served on `desktopDefault` — the first entry of the claude-desktop list — and any small tool-less or unserved-model request is likewise moved to the session's pick, else the first listed. When that first entry is a routing group (`auto/glm-5-turbo`, members `prov-a/glm-5-turbo` + `prov-b/glm-5-turbo`) and the key is held to models that don't cover **every** member, the check refuses — but the 403 names the model the client **sent**:

```
The gateway key "mykey" may not use claude-opus-4-6; it may use prov-a/*.
```

— a model the key explicitly allows (the same model on any non-desktop agent returns 200), while the group the check actually judged is never named.

**Root cause**

The check at `internal/gateway/gateway.go` judges the rewritten model:

```go
if keyHeld && (isGroup && !groupAllowed(keyWho, g, ms) || !isGroup && !modelAllowed(keyWho, p, model)) {
    ...
    writeError(w, from, 403, keyModelError(keyWho, call.Model))  // ← what the client sent
```

`asked` is what `desktopMove`/stand-ins rewrote to and what `FindGroup(asked)`/`Resolve(asked)` resolved; `call.Model` is the raw model of the wire. `keyModelError` printed the latter, so the refusal was attributed to a model the key was never asked about.

**The fix**

The 403 now names what was judged: the routing group as the key's lists spell it (its ref, `auto/glm-5-turbo` / `group/<id>`), else the checked model (`asked`):

```go
// the model the key was checked against is named, not the one the
// client sent: an agent that stands a request on another model
// (Desktop's check on its list's first, a stand-in, a tier) was
// refused for that one, and the sent one the key may well hold
// (#4175); a group as the key's lists name it (its ref)
checked := asked
if isGroup {
    checked = g.Ref()
}
writeError(w, from, 403, keyModelError(keyWho, checked))
```

After the fix the same probe reads:

```
The gateway key "mykey" may not use auto/glm-5-turbo; it may use prov-a/*. …
```

— and the suggestion "use a model it has" now points at a change that actually clears the refusal.

Every other `keyModelError` call site already named the checked model (`embeddings.go`, `decide.go`, `decide_group.go`, `count_tokens`' `countHeld`, `video.go`, `draw.go`); this chat-path site was the one printing the wire model.

**Verification**

| Check | Result |
| --- | --- |
| New tests, on the fix | `TestClaudeDesktopProbeRefusalNamesTheModelChecked`, `TestClaudeDesktopProbeRefusalNamesTheModelNotTheProbe` — green |
| Ablation, same tests on the parent (`df7c94bdf`) | red — the 403 says "may not use claude-opus-4-6", the issue's self-contradiction exactly |
| Targeted (`-run 'TestClaudeDesktopProbeRefusalNamesTheModel\|TestKey\|TestDesktop\|TestClaudeDesktop'`) | green |
| `go test -tags nogui -timeout 25m ./internal/gateway/...` | green (638s) |
| `go test -race` on the targeted set | green |
| `gofmt -l` on touched files / `go vet ./internal/gateway/` | clean |
| `go build ./...` | clean (the two cgo `-Wenum-conversion` warnings in `internal/gui` are pre-existing, untouched) |

Both new tests exercise the whole chain over HTTP (probe with `max_tokens: 1` on `.` → claude-desktop agent → desktopMove to the list's first entry → key-model check → 403): the group case asserts the message names `auto/glm-5-turbo` and not the sent model, that the key's own model still goes through on another agent, and that an unrestricted key is served; the plain-model case asserts `solo/m1` is named.

**Attribution**

Patch written by GLM-5.3-Flash (ZCode), authored by ggbdpq.

**Patch**

<details>
<summary>0001-gateway-a-key-s-403-names-the-model-it-was-checked-o.patch — SHA-256 a51eda167c9f0d84</summary>

`````
From bc1488718e58256f6e4303879d70f9f8f31ae29c Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Wed, 4 Nov 2026 08:34:23 +0800
Subject: [PATCH] gateway: a key's 403 names the model it was checked on, not
 the one sent
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

A gateway key held to some models (#882) was refused in the name of the
model the client sent, not the one the request was served on: an agent
that stands a request on another model before the check — Claude
Desktop's probe on its list's first entry (a routing group among them),
a stand-in, a tier — was told "may not use <the model it sent>", one the
key was never asked about, and the same model on any other agent went on
(#4175). The check judges `asked` (a group as its ref); the message now
names what was judged.

Generated-by: GLM-5.3-Flash (ZCode)
---
 .../gateway/desktop_probe_key_models_test.go  | 114 ++++++++++++++++++
 internal/gateway/gateway.go                   |  11 +-
 2 files changed, 124 insertions(+), 1 deletion(-)
 create mode 100644 internal/gateway/desktop_probe_key_models_test.go

diff --git a/internal/gateway/desktop_probe_key_models_test.go b/internal/gateway/desktop_probe_key_models_test.go
new file mode 100644
index 000000000..83369dbb1
--- /dev/null
+++ b/internal/gateway/desktop_probe_key_models_test.go
@@ -0,0 +1,114 @@
+package gateway
+
+import (
+	"net/http/httptest"
+	"strings"
+	"testing"
+
+	"github.com/yetone/magpie/internal/access"
+	"github.com/yetone/magpie/internal/provider"
+)
+
+// A gateway key held to some models (#882) is refused a Claude Desktop
+// check on the model or group the check was served on — its default, the
+// first entry of its list, a group among them — not the Claude model the
+// probe named: the 403 said "may not use <that model>", one the key was
+// never asked about, and the same model on any other agent went on
+// (#4175).
+func TestClaudeDesktopProbeRefusalNamesTheModelChecked(t *testing.T) {
+	fresh(t)
+	a := &fake{t: t, reply: deepseekReply}
+	b := &fake{t: t, reply: deepseekReply}
+	pa := httptest.NewServer(a)
+	t.Cleanup(pa.Close)
+	pb := httptest.NewServer(b)
+	t.Cleanup(pb.Close)
+	for _, p := range []provider.Provider{
+		{ID: "prova", Name: "Prova", Key: "k", Chat: pa.URL + "/v1", Models: []string{"glm-5-turbo"}},
+		{ID: "provb", Name: "Provb", Key: "k", Chat: pb.URL + "/v1", Models: []string{"glm-5-turbo"}},
+	} {
+		if err := provider.Save(p); err != nil {
+			t.Fatal(err)
+		}
+	}
+	shown, _ := provider.CatalogFor("claude-desktop")
+	if len(shown) == 0 || shown[0].Group == "" {
+		t.Fatalf("want the found group first on Desktop's list, got %v", shown)
+	}
+	first := shown[0].ID
+	if err := provider.SetModelOrder("claude-desktop", []string{first}); err != nil {
+		t.Fatal(err)
+	}
+	keys, secrets := newCaller(t, "Held", "Free")
+	if _, err := access.Update("models-key", access.Change{Key: keys[0].ID, Models: []string{"prova/*"}}); err != nil {
+		t.Fatal(err)
+	}
+	srv := New()
+	send := func(secret, model string) *httptest.ResponseRecorder {
+		req := httptest.NewRequest("POST", "/v1/messages", strings.NewReader(`{"model":"`+model+`","max_tokens":1,"messages":[{"role":"user","content":"."}]}`))
+		req.Header.Set("Authorization", "Bearer "+secret)
+		req.Header.Set("User-Agent", "Mozilla/5.0 (Macintosh) Claude/2.7032.0 Chrome/140.0 Electron/38.0")
+		w := httptest.NewRecorder()
+		srv.Handler().ServeHTTP(w, req)
+		return w
+	}
+	w := send(secrets[0], "claude-opus-4-6")
+	if w.Code != 403 {
+		t.Fatalf("the probe on the group the key may not use went as %d: %s", w.Code, w.Body.String())
+	}
+	if !strings.Contains(w.Body.String(), "may not use "+first) {
+		t.Fatalf("the 403 does not name the group the key was checked against: %s", w.Body.String())
+	}
+	if strings.Contains(w.Body.String(), "claude-opus-4-6") {
+		t.Fatalf("the 403 names the model the probe sent, not the one checked: %s", w.Body.String())
+	}
+	// the same key on the model it holds goes on another agent (Desktop's
+	// lists alone stand a request on the group): the refusal was the
+	// group's, not its own model's
+	plain := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(`{"model":"prova/glm-5-turbo","messages":[{"role":"user","content":"hi"}]}`))
+	plain.Header.Set("Authorization", "Bearer "+secrets[0])
+	w2 := httptest.NewRecorder()
+	srv.Handler().ServeHTTP(w2, plain)
+	if w2.Code != 200 {
+		t.Fatalf("the key's own model refused on another agent: %d %s", w2.Code, w2.Body.String())
+	}
+	// a key given the group's every member is answered on it
+	if w := send(secrets[1], "claude-opus-4-6"); w.Code != 200 {
+		t.Fatalf("an unrestricted key refused the check: %d %s", w.Code, w.Body.String())
+	}
+}
+
+// A Desktop check moved onto a model (no group among the lists) a key is
+// held away from is refused in that model's name, as the key's lists show
+// it (#4175).
+func TestClaudeDesktopProbeRefusalNamesTheModelNotTheProbe(t *testing.T) {
+	fresh(t)
+	served := &fake{t: t, reply: deepseekReply}
+	up := httptest.NewServer(served)
+	t.Cleanup(up.Close)
+	if err := provider.Save(provider.Provider{ID: "solo", Name: "Solo", Key: "k", Chat: up.URL + "/v1", Models: []string{"m1"}}); err != nil {
+		t.Fatal(err)
+	}
+	if err := provider.SetModelOrder("claude-desktop", []string{"solo/m1"}); err != nil {
+		t.Fatal(err)
+	}
+	keys, secrets := newCaller(t, "Held")
+	if _, err := access.Update("models-key", access.Change{Key: keys[0].ID, Models: []string{"other/*"}}); err != nil {
+		t.Fatal(err)
+	}
+	srv := New()
+	req := httptest.NewRequest("POST", "/v1/messages", strings.NewReader(`{"model":"claude-opus-4-6","max_tokens":1,"messages":[{"role":"user","content":"."}]}`))
+	req.Header.Set("Authorization", "Bearer "+secrets[0])
+	req.Header.Set("User-Agent", "Mozilla/5.0 (Macintosh) Claude/2.7032.0 Chrome/140.0 Electron/38.0")
+	w := httptest.NewRecorder()
+	srv.Handler().ServeHTTP(w, req)
+	if w.Code != 403 {
+		t.Fatalf("the probe on the model the key may not use went as %d: %s", w.Code, w.Body.String())
+	}
+	if !strings.Contains(w.Body.String(), "may not use solo/m1") {
+		t.Fatalf("the 403 does not name the model the key was checked against: %s", w.Body.String())
+	}
+	if strings.Contains(w.Body.String(), "claude-opus-4-6") {
+		t.Fatalf("the 403 names the model the probe sent, not the one checked: %s", w.Body.String())
+	}
+}
diff --git a/internal/gateway/gateway.go b/internal/gateway/gateway.go
index 077e3f3d7..7dffd5bd1 100644
--- a/internal/gateway/gateway.go
+++ b/internal/gateway/gateway.go
@@ -2452,7 +2452,16 @@ func (s *Server) serve(w http.ResponseWriter, r *http.Request, from provider.Pro
 	chose, _ := r.Context().Value(magpieChoseKey{}).(bool)
 	if keyHeld && (isGroup && !groupAllowed(keyWho, g, ms) || !isGroup && !modelAllowed(keyWho, p, model)) {
 		call.Status, call.Error = 403, "model not allowed for the gateway key"
-		writeError(w, from, 403, keyModelError(keyWho, call.Model))
+		// the model the key was checked against is named, not the one the
+		// client sent: an agent that stands a request on another model
+		// (Desktop's check on its list's first, a stand-in, a tier) was
+		// refused for that one, and the sent one the key may well hold
+		// (#4175); a group as the key's lists name it (its ref)
+		checked := asked
+		if isGroup {
+			checked = g.Ref()
+		}
+		writeError(w, from, 403, keyModelError(keyWho, checked))
 		turnedAway()
 		return
 	}
-- 
2.50.1 (Apple Git-155)


`````

</details>

**Branch**: https://github.com/ggbdpq/magpie/tree/fix/4175-probe-model-403 (head bc1488718e58256f6e4303879d70f9f8f31ae29c)
