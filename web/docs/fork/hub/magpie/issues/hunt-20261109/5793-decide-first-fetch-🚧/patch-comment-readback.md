@yetone — a plugin provider whose `config` hook says `decide` was unreachable until its first model listing landed: **Fetch models** failed with `HMind's plugin lists no decision models` and the provider stayed empty, and the provider's test answered the same line on the same initial state; only restarting magpie — which loads the listing kept on disk — made the provider work (#5793). Thank you @ZY-WANG-0304 for the isolated-HOME repro that pinned the transient state (`models=0 decideOnly=true` right after sign-in, `models=2 decideOnly=false` once the list is in): once seen, the shape falls straight out of the code.

**Root cause**: the `config` hook records the decision API before any model is listed, and a plugin provider's conversation endpoints are derived from its listing's models (`internal/provider/plugins.go:591`) — so the provider as read before the first list carries `Decide` and no `Chat`/`Responses`/`Anthropic`, which reads as `DecideOnly()` (`internal/provider/decide.go:145`). `fetchList` checked that shape before the account's own lister (`internal/provider/models.go:469`), so **Fetch models** went to `fetchDecide`, whose plugin branch reads the decision models the listing holds (`internal/provider/decide.go:898`); a listing without models holds none, and the fetch died at the decision-model line without ever asking the account's list — the one call that fills the listing in. `Test` had the same early return into `testDecide` (`internal/provider/test.go:48`), and its trailing decide probe kept the same line coming on every test after the list landed, for a plugin that marks no decision model. `decide: true` declares an additional API, exactly as the report says; neither path treated it so.

**The fix** (the report's two suggested points, plus the trailing row that the same initial state kept emitting once ② alone stood): `fetchList` asks an account's lister first and falls to the decision API only when there is none — no provider with a lister of its own has ever served conversations on an endpoint of its own beside it, so the swap moves no existing caller off its answer and only lets the plugin past the look-alike. `Test` no longer enters `testDecide` on a plugin that reads decision-only: it fetches the list, takes the conversation endpoints the listing now serves (the caller's provider value keeps its account, its keys and its picks — `TestProviderTestAsksAnAccountThatServesItsModel` pins that), and tests them as any provider's test does; a decision model the plugin lists still asks at the bottom, and a listing that names none says nothing there, where there was nothing its decision API could answer.

The transient state is reached in the tests both ways: in memory, as `pluginAccounts` builds the provider from a listing that has none of the plugin's models yet; and through the plugin's host, with the fake plugin taught a `FAKE_DECIDE=dynamic` — a plugin that says decide and lists no model of its own — against a vendor that refuses its list first and serves it after. All three tests read red at the issue's own words before the change, green after; the ablation backs just the two product files.

Sibling-face scan of the same family, each point left or changed with its reason:

- `refetch`'s account/decision arm (`internal/provider/models.go:316`): a plugin enters the plugin arm above it and never reaches it; the arm's own order matches this change. Left.
- `FetchNew`'s `newDue`/`fetchDue` (`internal/provider/models.go:744,773`): a due decision provider asks its account's fetch whenever it has one (`f.decide && p.Account == nil` guards the decide ask) — the same order this change gives `fetchList`. Left.
- `ListAsks` (`internal/provider/models.go:579`): says `false` for a decision-only provider, keeping the gateway's rest probe off a plugin's fetch; a display-and-probe contract, not the list fetch this issue is about. Left.
- `entriesOf` (`internal/provider/models.go:3327`): a provider that reads decision-only exposes no conversation entries; while the listing is out a plugin has no conversation endpoint to expose anyway, and the catalog rebuilds once the list lands. Left.
- `ModelTest` and `AsksDecideModels` (`internal/provider/test.go:192,216`): the editor's own-test classification; nothing there fetches or answers the decision API. Left.
- `decideModels`/`decideListed`/`pluginDecisions` and `fetchDecide`'s plugin branch (`internal/provider/decide.go`): readers of the decision models a listing already holds; the branch stays the answer for a plugin that lists decision models, and the honest error for anything else. Left.
- The gateway's routing skips (`internal/gateway/video.go`, `vision.go`, `draw.go`, `kind_group.go`): a provider that reads decision-only offers nothing to route while it has no conversation endpoint, whatever the reason it reads so; the list landing flips it back. Left.
- The GUI/CLI/TUI display branches (`internal/gui/api.go:889,903,941`, `internal/gui/groups.go:342`, `internal/gui/providers.go:779`, `internal/cli/providers_cli.go:850,855`, `internal/tui/pages.go:679`): display of the same shape, refreshed by the listing; no fetch or decision ask of their own. Left.
- The listing-readiness side (`p.Listed()` at `internal/provider/models.go:749,767`, `plugin.Cached`/`commitProviders`/`keepListed`, the hourly relist in `internal/provider/plugin_relist.go`): untouched — this change only decides who is asked first while the listing is not in yet.

<details><summary>patch: plugin: a provider that says decide fetches its list before it looks decision-only — git am applies it as is; SHA-256 first 16: e8bdd3176108aa02</summary>

```text
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Tue, 10 Nov 2026 00:03:45 +0800
Subject: [PATCH] plugin: a provider that says decide fetches its list before
 it looks decision-only
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

A plugin whose config hook says decide and that lists every model
itself, none marked a decision model, builds a provider that reads
decision-only until its first list arrives: decide set, and no
conversation endpoint a listing without models could derive. Its fetch
then went to the decision API alone, which is empty before the first
list, and failed with "X's plugin lists no decision models" (#5793,
ZY-WANG-0304) — the account's list, the one that fills the listing in,
was never asked. After a restart the list kept on disk made the
provider whole, and the same action worked: the state was transient,
and the fetch took it for the provider's shape.

fetchList now asks an account's lister first and falls to the decision
API only when there is none — no provider with a lister of its own has
ever served conversations on an endpoint of its own beside it. Test no
longer enters testDecide on a plugin that reads decision-only: it
fetches the list, takes the conversation endpoints the listing now
serves, and tests those, as every other provider's test does; a plugin
whose listing names no decision model says so no more on every test's
decide row, where there was nothing its decision API could answer.

Run (mote, at ddd6c649b plus this change):
- go test -tags nogui -run TestPluginDecide ./internal/provider/
  -count=1: three tests red before the change at the issue's own words
  ("HMind's plugin lists no decision models"), green after; one of them
  through the plugin's host (bun), with a vendor that refuses its list
  first and serves it after — FAKE_DECIDE=dynamic, a plugin that says
  decide and lists no model of its own
- go test -tags nogui -count=1 ./... -timeout 60m: ok, but for the
  machine's standing reds (TestMothX, TestProxyCheckSaysAProxyPassedBy,
  this host's TestHostToldTheGatewayAddress, red at ddd6c649b too)
  and TestProviderTestAsksAnAccountThatServesItsModel, red at the
  first cut of this change — a test's provider value carries the
  caller's account models, and the re-read took them away; the re-read
  now moves the endpoints alone, and the package is green again
- go test -tags nogui -count=1 ./internal/provider/ ./internal/gui/:
  ok, but for TestProxyCheckSaysAProxyPassedBy (the machine's proxy)
- gofmt -l: clean; go vet ./..., GOOS=linux go vet -tags nogui ./...,
  GOOS=windows go vet ./...: ok; go build ./..., GOOS=linux, GOOS=windows:
  ok

Reported-by: ZY-WANG-0304 (yetone/magpie#5793)
Attribution: 分析与补丁由 GLM-5.3-Flash (ZCode) 协助完成
Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/plugin/testdata/fake/index.js        |  22 +-
 internal/provider/models.go                   |  13 +-
 .../provider/plugin_decide_first_list_test.go | 238 ++++++++++++++++++
 internal/provider/test.go                     |  20 +-
 4 files changed, 284 insertions(+), 9 deletions(-)
 create mode 100644 internal/provider/plugin_decide_first_list_test.go

diff --git a/internal/plugin/testdata/fake/index.js b/internal/plugin/testdata/fake/index.js
index ea884fb21..b13e4289f 100644
--- a/internal/plugin/testdata/fake/index.js
+++ b/internal/plugin/testdata/fake/index.js
@@ -170,11 +170,19 @@ export const FakePlugin = async ({ client }) => ({
     // $FAKE_DECIDE: the provider serves a decision API too (#1514), asked
     // at its base /systemone through the loader's fetch: fake-clef is a
     // decision model it marks, jev-9 one magpie knows by its name.
-    // "models" marks them without saying decide.
+    // "models" marks them without saying decide. "dynamic" says decide and
+    // lists no model of its own, as a plugin that reads its vendor's list
+    // does (#5793): before its first list the provider reads decision-only.
     if (process.env.FAKE_DECIDE) {
       if (process.env.FAKE_DECIDE !== "models") cfg.provider[ID].decide = true
-      cfg.provider[ID].models["fake-clef"] = { name: "Fake Clef", decides: true, limit: { context: 1000, output: 0 } }
-      cfg.provider[ID].models["jev-9"] = { name: "Jev 9", limit: { context: 1000, output: 0 } }
+      if (process.env.FAKE_DECIDE !== "dynamic") {
+        cfg.provider[ID].models["fake-clef"] = { name: "Fake Clef", decides: true, limit: { context: 1000, output: 0 } }
+        cfg.provider[ID].models["jev-9"] = { name: "Jev 9", limit: { context: 1000, output: 0 } }
+      } else {
+        // its models are the hook's alone: none in the config, so before
+        // its first list the provider reads decision-only (#5793)
+        cfg.provider[ID].models = {}
+      }
     }
     // $FAKE_OFF: a model that stops thinking at none and one that can't,
     // as Factory's plugin has Kimi K3 and GLM-5.3 (#899)
@@ -390,6 +398,12 @@ export const FakePlugin = async ({ client }) => ({
         }
         await client.auth.set({ path: { id: ID }, body: { ...auth, refresh: auth.refresh + "+" } })
       }
+      // $FAKE_DECIDE=dynamic: its models are the hook's alone, two
+      // ordinary chat models, none marked a decision model (#5793)
+      if (process.env.FAKE_DECIDE === "dynamic") {
+        p.models["fake-1"] ??= { name: "Fake One", limit: { context: 1000, output: 100 } }
+        p.models["fake-claude"] ??= { name: "Fake Claude", provider: { npm: "@ai-sdk/anthropic" }, modalities: { input: ["text", "image"], output: ["text"] }, limit: { context: 2000, output: 200 } }
+      }
       // fake-1 costs the plan nothing, as a WorkBuddy model of x0.00
       // credits ($FAKE_NO_FREE: a list with no free model, as ZCode's is)
       if (!process.env.FAKE_NO_FREE) p.models["fake-1"].free = true
@@ -430,7 +444,7 @@ export const FakePlugin = async ({ client }) => ({
       if (process.env.FAKE_SEARCHER) p.models["fake-search"] = { ...p.models["fake-1"], id: "fake-search", name: "Fake Search", api: { ...p.models["fake-1"].api, id: "fake-search" }, free: false, searches: true }
       // $FAKE_DECIDE: one more decision model, marked on the list the hook
       // gives, as a plugin that reads its vendor's list marks one
-      if (process.env.FAKE_DECIDE) p.models["fake-judge"] = { ...p.models["fake-1"], id: "fake-judge", name: "Fake Judge", api: { ...p.models["fake-1"].api, id: "fake-judge" }, free: false, decides: true }
+      if (process.env.FAKE_DECIDE && process.env.FAKE_DECIDE !== "dynamic") p.models["fake-judge"] = { ...p.models["fake-1"], id: "fake-judge", name: "Fake Judge", api: { ...p.models["fake-1"].api, id: "fake-judge" }, free: false, decides: true }
       // $FAKE_FAST=tier: as Cursor's plugin 0.2.x lists a model, once per
       // context size, and from 0.2.2 says fast on the sizes Cursor has a
       // fast variant at (Opus 5.5's 300k, not its 1m); no -fast model
diff --git a/internal/provider/models.go b/internal/provider/models.go
index 84e26bda7..2512519fb 100644
--- a/internal/provider/models.go
+++ b/internal/provider/models.go
@@ -466,12 +466,19 @@ func (p Provider) fetchList(ctx context.Context) ([]catalog.Model, error) {
 		return nil, ErrListOff
 	}
 	ctx = p.ownRequests(p.Via(ctx), probelog.KindList)
-	if p.DecideOnly() {
-		return p.fetchDecide(ctx)
-	}
+	// an account's list first, even when p looks decision-only: a plugin
+	// with decide said reads so before its first list, and its decision
+	// API is empty then — the account's list is what fills the listing in
+	// (#5793). A provider with a lister of its own serves its
+	// conversations through the same account, never on an endpoint of its
+	// own beside it, so nothing that had both ever asked here the other
+	// way round.
 	if p.Account != nil && p.Account.fetch != nil {
 		return p.Account.fetch(ctx)
 	}
+	if p.DecideOnly() {
+		return p.fetchDecide(ctx)
+	}
 	if p.Account != nil && p.Account.models != nil {
 		// a plan with no list to ask (ZCode's, WorkBuddy's): its models
 		// are the ones it has, and its endpoint's /models isn't one
diff --git a/internal/provider/plugin_decide_first_list_test.go b/internal/provider/plugin_decide_first_list_test.go
new file mode 100644
index 000000000..1ad97e95d
--- /dev/null
+++ b/internal/provider/plugin_decide_first_list_test.go
@@ -0,0 +1,238 @@
+package provider
+
+import (
+	"context"
+	"encoding/json"
+	"net/http"
+	"net/http/httptest"
+	"os"
+	"path/filepath"
+	"slices"
+	"strings"
+	"sync"
+	"testing"
+	"time"
+
+	"github.com/yetone/magpie/internal/catalog"
+	"github.com/yetone/magpie/internal/plugin"
+	"github.com/yetone/magpie/internal/settings"
+	"github.com/yetone/magpie/internal/testenv"
+)
+
+// A plugin whose config hook says decide and that lists every model
+// itself, none marked a decision model (HMind's, #5793), builds a
+// provider that reads decision-only until its first list arrives: decide
+// said, no conversation endpoint a listing without models could derive.
+// Its fetch then went to the decision API alone, which is empty before
+// the first list, and failed with "X's plugin lists no decision models"
+// — the account's list, the one that fills the listing in, was never
+// asked. Test asked it too, at its early testDecide.
+
+// writePluginFile is a file of magpie's settings folder, as the plugin
+// host and magpie keep them.
+func writePluginFile(t *testing.T, name string, v any) {
+	t.Helper()
+	b, _ := json.Marshal(v)
+	os.MkdirAll(settings.Dir(), 0o700)
+	if err := os.WriteFile(filepath.Join(settings.Dir(), name), b, 0o600); err != nil {
+		t.Fatal(err)
+	}
+}
+
+// hmindBeforeItsList is the provider as magpie serves it before the
+// plugin's first model list: decide said, no model listed.
+func hmindBeforeItsList(t *testing.T) Provider {
+	t.Helper()
+	spec := "@example/hmind-auth"
+	writePluginFile(t, "plugins.json", map[string]any{"plugins": []map[string]any{{"spec": spec}}})
+	writePluginFile(t, "plugin-auth.json", map[string]map[string]any{"hmind": {"type": "api", "key": "sk-hmind"}})
+	plugin.UseCached([]plugin.Provider{{
+		ID:       "hmind",
+		Spec:     spec,
+		Name:     "HMind",
+		Methods:  []plugin.Method{{Type: "api", Label: "API key"}},
+		Decide:   true,
+		Accounts: []plugin.Account{{Key: "hmind", Type: "api"}},
+	}})
+	t.Cleanup(func() { plugin.UseCached(nil) })
+	saveLogins(t, savedLogin{Agent: "plugin:hmind", User: "one@hmind", Home: "hmind", On: true})
+	ps := pluginAccounts()
+	i := slices.IndexFunc(ps, func(p Provider) bool { return p.ID == "hmind" })
+	if i < 0 {
+		t.Fatalf("no hmind provider among the accounts: %v", ps)
+	}
+	return ps[i]
+}
+
+// Fetching the list of a plugin that reads decision-only before its first
+// list asks the plugin's account list, whose answer fills the listing in
+// — it doesn't stop at the empty decision API (#5793).
+func TestPluginDecideFetchAsksTheListFirst(t *testing.T) {
+	claudeHome(t)
+	t.Setenv("MAGPIE_BUN", "")
+	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
+	defer cancel()
+	p := hmindBeforeItsList(t)
+	if !p.DecideOnly() {
+		t.Fatalf("before its first list the provider reads decision-only: chat %q, responses %q, decide %q", p.Chat, p.Responses, p.Decide)
+	}
+	asked := false
+	p.Account.fetch = func(context.Context) ([]catalog.Model, error) {
+		asked = true
+		return []catalog.Model{{ID: "hmind-chat-1"}, {ID: "hmind-chat-2"}}, nil
+	}
+	ms, err := p.Fetch(ctx)
+	if err != nil {
+		t.Fatalf("fetch: %v", err)
+	}
+	if !asked {
+		t.Fatal("the plugin's account list was never asked")
+	}
+	if len(ms) != 2 || ms[0].ID != "hmind-chat-1" || ms[1].ID != "hmind-chat-2" {
+		t.Fatalf("the fetch gave %v", ms)
+	}
+}
+
+// Testing the same provider enters no testDecide while its listing has no
+// decision model: the decide row it answered is the error #5793 is about.
+func TestPluginDecideTestLeavesNoDecideRowWithoutModels(t *testing.T) {
+	claudeHome(t)
+	t.Setenv("MAGPIE_BUN", "")
+	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
+	defer cancel()
+	p := hmindBeforeItsList(t)
+	p.Account.fetch = func(context.Context) ([]catalog.Model, error) {
+		return nil, context.DeadlineExceeded
+	}
+	for _, r := range p.Test(ctx) {
+		if r.Protocol == "decide" || strings.Contains(r.Error, "lists no decision models") {
+			t.Fatalf("the decide row came back: %+v", r)
+		}
+	}
+}
+
+// The whole way, through the plugin's host: a plugin that says decide and
+// lists no model of its own ($FAKE_DECIDE=dynamic) whose vendor refuses
+// its list at first. Fetching its models asks the vendor (the account's
+// list), not the empty decision API; once the vendor answers, the same
+// fetch gives its chat models, and a test probes the conversation
+// endpoint it lists instead of saying "FakeCo's plugin lists no decision
+// models" (#5793).
+func TestPluginDecideFetchBeforeItsFirstList(t *testing.T) {
+	bun := testenv.Bun(t)
+	claudeHome(t)
+	t.Setenv("MAGPIE_BUN", bun)
+	t.Setenv("FAKE_DECIDE", "dynamic")
+	t.Setenv("FAKE_MODELS_THROW", "1")
+	t.Cleanup(plugin.Settle)
+	// the vendor refuses its /models at first (the connection hangs up
+	// mid-answer, as a stuck vendor's does), and serves conversations once
+	// its list is asked for
+	var mu sync.Mutex
+	refuse, asked := true, 0
+	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+		mu.Lock()
+		defer mu.Unlock()
+		if strings.HasSuffix(r.URL.Path, "/models") {
+			asked++
+			if refuse {
+				if conn, _, err := w.(http.Hijacker).Hijack(); err == nil {
+					conn.Close()
+					return
+				}
+				panic("the vendor refuses its list")
+			}
+			w.Write([]byte("later"))
+			return
+		}
+		if strings.HasSuffix(r.URL.Path, "/chat/completions") {
+			w.Header().Set("Content-Type", "text/event-stream")
+			w.Write([]byte("data: {\"id\":\"c\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"from the plugin\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n"))
+			return
+		}
+		http.NotFound(w, r)
+	}))
+	t.Cleanup(up.Close)
+	t.Setenv("FAKE_BASE", up.URL+"/v1")
+	t.Setenv("FAKE_MODELS", up.URL+"/models")
+	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
+	defer cancel()
+	abs, _ := filepath.Abs("../plugin/testdata/fake/index.js")
+	if _, err := plugin.Add(ctx, abs); err != nil {
+		t.Fatal(err)
+	}
+	key, err := plugin.Import(ctx, "fakeco", map[string]any{"type": "oauth", "refresh": "r-ok", "access": "a", "expires": 9e15, "accountId": "a@fake"})
+	if err != nil {
+		t.Fatal(err)
+	}
+	saveLogins(t, savedLogin{Agent: "plugin:fakeco", User: "a@fake", Home: key, On: true})
+	// the first listing: the models hook asks the vendor, which refuses,
+	// and the row keeps what the config said — decide, and no model
+	ps, err := plugin.Providers(ctx)
+	if err != nil {
+		t.Fatal(err)
+	}
+	i := slices.IndexFunc(ps, func(pp plugin.Provider) bool { return pp.ID == "fakeco" })
+	if i < 0 {
+		t.Fatalf("no fakeco among the listed: %v", ps)
+	}
+	if !ps[i].Decide || len(ps[i].Models) != 0 {
+		var ids []string
+		for _, m := range ps[i].Models {
+			ids = append(ids, m.ID)
+		}
+		t.Fatalf("before its first list the plugin says decide %v with %d models: %v", ps[i].Decide, len(ps[i].Models), ids)
+	}
+	p, err := Find(PluginID("fakeco"))
+	if err != nil {
+		t.Fatal(err)
+	}
+	if !p.DecideOnly() {
+		t.Fatalf("before its first list the provider reads decision-only: chat %q, responses %q, anthropic %q, decide %q", p.Chat, p.Responses, p.Anthropic, p.Decide)
+	}
+
+	// Fetch models before the first list: the vendor is asked — the
+	// account's list, which says why it couldn't — and the answer is not
+	// the decision API's empty hand (#5793)
+	_, err = p.Fetch(ctx)
+	mu.Lock()
+	hits, stillRefusing := asked, refuse
+	mu.Unlock()
+	if hits == 0 {
+		t.Fatal("the vendor was never asked for its list")
+	}
+	if err != nil && strings.Contains(err.Error(), "lists no decision models") {
+		t.Fatalf("the fetch stopped at the decision API: %v", err)
+	}
+	if !stillRefusing {
+		t.Fatal("the vendor should still be refusing here")
+	}
+
+	// the vendor serves its list now: the same fetch gives its chat models
+	mu.Lock()
+	refuse = false
+	mu.Unlock()
+	ms, err := p.Fetch(ctx)
+	if err != nil {
+		t.Fatalf("fetch after the list: %v", err)
+	}
+	if !slices.ContainsFunc(ms, func(m catalog.Model) bool { return m.ID == "fake-1" }) {
+		t.Fatalf("the fetch after the list gave %v", ms)
+	}
+
+	// and a test probes the conversation endpoints the list named, with no
+	// decide row saying the plugin lists no decision models
+	rs := p.Test(ctx)
+	chat := false
+	for _, r := range rs {
+		if r.Protocol == "decide" || strings.Contains(r.Error, "lists no decision models") {
+			t.Errorf("the decide row came back: %+v", r)
+		}
+		if r.Protocol == "chat" {
+			chat = true
+		}
+	}
+	if !chat {
+		t.Errorf("no conversation endpoint was tested: %+v", rs)
+	}
+}
diff --git a/internal/provider/test.go b/internal/provider/test.go
index bc3f4d6ef..64eec2948 100644
--- a/internal/provider/test.go
+++ b/internal/provider/test.go
@@ -45,10 +45,24 @@ type Result struct {
 // sees, and reports what came back.
 func (p Provider) Test(ctx context.Context) []Result {
 	ctx = withUnreached(p.ownRequests(p.Via(ctx), probelog.KindTest))
-	if p.DecideOnly() {
+	// a plugin reads decision-only before its first list, and its
+	// decision API is empty then (#5793): the list is fetched below, and
+	// what the plugin serves — its conversation endpoints among them — is
+	// tested instead. Any decision model it lists asks at the bottom, as
+	// every other provider's does.
+	if p.DecideOnly() && !p.IsPlugin() {
 		return p.testDecide(ctx)
 	}
 	_, listErr := p.Fetch(ctx)
+	if p.IsPlugin() {
+		// the list fetched may be the plugin's first: the conversation
+		// endpoints it discovered are what the tests below ask, taken
+		// from the provider the listing now serves — the caller's value
+		// keeps its account, its keys and its picks (#5793)
+		if q, err := Find(p.ID); err == nil && q.IsPlugin() {
+			p.Chat, p.Responses, p.Anthropic = q.Chat, q.Responses, q.Anthropic
+		}
+	}
 	if client := testClient(ctx); client != "" {
 		// the one endpoint that agent's requests go to
 		proto := clientProto(client, p.Speaks())
@@ -106,7 +120,9 @@ func (p Provider) Test(ctx context.Context) []Result {
 		if model := p.Jev(); listErr == nil && model != "" {
 			out = append(out, Result{Protocol: "decide", Model: model, OK: true, Status: http.StatusOK})
 		}
-	} else if p.Decides() {
+	} else if p.Decides() && (!p.IsPlugin() || len(p.decideModels()) > 0) {
+		// a plugin that lists no decision model has none its decision API
+		// could answer (#5793): saying so on every test is no answer
 		out = append(out, p.testDecide(ctx)...)
 	}
 	return out
-- 
2.50.1 (Apple Git-155)
```

</details>

Fork branch: https://github.com/ggbdpq/magpie/tree/fix/5793-decide-blocks-first-fetch (3078acad43111693d441c31bd71c3460acbbccaf, rebased on yetone/main fdd38154b).

