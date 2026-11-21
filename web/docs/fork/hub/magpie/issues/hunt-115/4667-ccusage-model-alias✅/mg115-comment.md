Root-caused and fixed: the `model` field of the reply carried magpie's own deployment alias, and ccusage counts models by exactly that field.

## Root cause

9bb1efdde ("a reply names the model the agent asked for when it went out under another name", released 11-01) makes the reply's `model` say the name the agent asked for whenever magpie sent the request upstream under another name. For a Claude Code session in Desktop's Code tab, that asked-for name is one of magpie's own Desktop aliases (fb1575730): `magpie-<n>.anthropic.claude-opus-5-5` for a Claude model with reasoning levels — precisely the `magpie-2213244526.anthropic…` in the screenshot. The subscription is asked under the model's own id and replies with it (the `opus-5-5` you saw before), and the rule overwrote that with the alias on its way back into Claude Code's usage records.

## Fix

A request that came in under one of magpie's alias ids (all four forms — `magpie-<n>.anthropic.<claude model>`, `mythos-magpie-<n>`, `anthropic/magpie-<n>`, `claude-magpie-<n>` — with or without `[1m]`) is now served the vendor's own name, as every reply was before the asked-name rule. The recognition is the alias shape alone, not a catalog lookup, so a session saved on an old alias keeps the vendor's name too. `MemberModel` and `X-Magpie-Response-Model: member` are untouched; the usage ledger still records the catalog id asked for and the vendor's name as served.

## Verification

| Check | Result |
|---|---|
| New `TestReplyToMagpieAliasKeepsVendorName` (10 subtests: the four alias forms and `[1m]`, streamed and not) | red before the fix (every subtest had the reply naming the alias), green after |
| `go test -tags nogui -count=1 ./internal/gateway` (full package) | ok (573s) |
| `-race -count=1` on the member and alias tests | ok |
| Ablation: product files back at the parent, test kept | 11 failures, all "the reply names \<alias\>, want the vendor's opus-5-5" |
| `gofmt -l`, `go vet -tags nogui`, `GOOS=linux`/`GOOS=windows` vet | clean |
| Builds: darwin arm64; linux and windows `-tags nogui` (the Makefile's own cross-compile form) | ok |

## Not verified

- Against a real Claude subscription behind Desktop's Code tab (no account here): the harness is a fake Anthropic vendor answering `opus-5-5` to a request that asked by the alias — the same reply field ccusage reads.
- The Responses WebSocket path, which never carries a Desktop alias (Codex-side ids).

---

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

<details><summary>patch: gateway: a reply to one of magpie's own aliases keeps the vendor's model name (#4667) — git am applies it as is; SHA-256 first 16: 3a35820674f7fe1b</summary>

```patch
From 4ce5b6c0fd422c104bccc59968169b54e18a4bc4 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Sun, 1 Nov 2026 17:42:22 +0800
Subject: [PATCH] gateway: a reply to one of magpie's own aliases keeps the
 vendor's model name (#4667)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

leizh007: with Claude Code Desktop served through magpie, ccusage counted
the model as "magpie-2213244526.anthropic…" from the 11-01 release on;
before it said the subscription's own "opus-5-5".

The asked-name rule (9bb1efdde) names a reply after the model the agent
asked for whenever the request went out under another name. Claude
Desktop's effort-picker aliases (fb1575730) made Desktop's Code tab ask by
such a name: magpie-<n>.anthropic.claude-opus-5-5, mythos-magpie-<n>,
anthropic/magpie-<n>, Claude Science's claude-magpie-<n>. The vendor is
asked under the model's own name, the reply came back under it, and the
rule wrote the alias over it — into Claude Code's usage records, where
ccusage counts each model by the reply's name. An alias is magpie's
deployment name, not a model id any vendor knows.

Now a request that came in under one of those aliases is served the
vendor's own name, as every reply was before the asked-name rule. The
recognition is the alias shape alone (magpieAliasAsked), not a catalog
lookup: a session saved on an old alias is served all the same, and its
reply keeps the vendor's name too. MemberModel and X-Magpie-Response-Model:
member are untouched — an explicit ask for magpie's id still says it. The
usage ledger still records the catalog id asked for and the vendor's name
as served.

Run (this head on dfe868a1e, upstream/main):
- go test -tags nogui -count=1 ./internal/gateway: ok (573s). The new
  TestReplyToMagpieAliasKeepsVendorName (10 subtests: the four alias forms
  and [1m], streamed and not) was red before the fix — every subtest had
  the reply naming the alias — and TestReplyNamesAskedModel,
  TestReplyNamesMember, TestGeminiReplyNamesAskedModel, TestMemberLine,
  TestMemberLines stay green.
- Ablation (product files back at the parent, test kept): 11 failures,
  all "the reply names <alias>, want the vendor's opus-5-5".
- go test -tags nogui -race -count=1 on the member and alias tests: ok.
- gofmt -l clean; go vet -tags nogui ./internal/gateway clean;
  GOOS=linux and GOOS=windows vet clean.
- Builds: darwin arm64 (cgo warnings in internal/gui pre-existing),
  linux and windows with -tags nogui, the Makefile's own cross-compile
  form (Makefile line 105).

Sibling faces checked: the alias constants are constructed only in
desktop.go and science.go; aliased() serves resolution (unprefixed) and
GUI display, both of which need the catalog, unchanged; the memberWriter
is the one writer of reply names and this gate covers it; the Responses
WebSocket path never carries a Desktop alias (Codex-side ids).

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/desktop.go     | 25 ++++++++++++++
 internal/gateway/member.go      | 23 ++++++++-----
 internal/gateway/member_test.go | 61 +++++++++++++++++++++++++++++++++
 3 files changed, 100 insertions(+), 9 deletions(-)

diff --git a/internal/gateway/desktop.go b/internal/gateway/desktop.go
index 258d9bc0a..8a149e3c8 100644
--- a/internal/gateway/desktop.go
+++ b/internal/gateway/desktop.go
@@ -453,6 +453,31 @@ func aliased(id string) (string, bool) {
 	return "", false
 }
 
+// magpieAliasAsked says asked is one of magpie's own alias ids for Claude
+// Desktop or Claude Science (aliased's forms, with or without Claude
+// Code's "[1m]"): anthropic/magpie-<number>, mythos-magpie-<number>,
+// magpie-<number>.anthropic.<Claude model> or claude-magpie-<number>, the
+// number one of magpie's own (aliasNumber's ten digits). Whether the
+// catalog still lists a model under it is not asked: a session saved on an
+// old alias is served all the same, and a reply to it must not name the
+// alias either (#4667).
+func magpieAliasAsked(id string) bool {
+	id = strings.TrimSuffix(id, "[1m]")
+	var n string
+	if rest, ok := strings.CutPrefix(id, desktopAlias); ok {
+		n = rest
+	} else if rest, ok := strings.CutPrefix(id, desktopEffortAlias); ok {
+		n = rest
+	} else if rest, ok := strings.CutPrefix(id, scienceAlias); ok {
+		n = rest
+	} else if rest, ok := strings.CutPrefix(id, "magpie-"); ok {
+		if i := strings.Index(rest, desktopClaudeInfix); i > 0 {
+			n = rest[:i]
+		}
+	}
+	return len(n) == 10 && strings.IndexFunc(n, func(r rune) bool { return r < '0' || r > '9' }) < 0
+}
+
 // isClaudeDesktop is a request from Claude Desktop's own gateway client: its
 // Electron session's User-Agent ("Mozilla/5.0 … Claude/2.7032.0 Chrome/…"),
 // which says nothing of it before the first slash.
diff --git a/internal/gateway/member.go b/internal/gateway/member.go
index 70cc61665..aa53226ce 100644
--- a/internal/gateway/member.go
+++ b/internal/gateway/member.go
@@ -12,14 +12,19 @@ package gateway
 // a provider/model id, a name the user gave the model upstream — since
 // agents compare it with what they asked and warn when it differs
 // (issennknight on Discord: deepseek-v4.1-flash served as
-// deepseek-v4.1-flash-1017). A request that went out under the name it
-// asked for keeps the vendor's text, a dated name included. Settings'
-// MemberModel, or a request's X-Magpie-Response-Model: member, has the
-// body's model say magpie's id instead, except for the agents that read
-// it themselves (vendorNamed); X-Magpie-Response-Model: vendor keeps the
-// vendor's text. The vendor's own name is still in the usage log
-// (Record.Served) and on the Routing page: the request's capture is
-// inside this writer.
+// deepseek-v4.1-flash-1017). One of magpie's own aliases for Claude
+// Desktop or Science (magpieAliasAsked) is not among these: it names the
+// model only to Desktop and its Code tab, and a reply that carried it put
+// magpie's deployment name in the agent's usage records, where ccusage
+// counted it as a model of its own (#4667), so such a request keeps the
+// vendor's text, as every reply did before the asked-name rule. A request
+// that went out under the name it asked for keeps the vendor's text, a
+// dated name included. Settings' MemberModel, or a request's
+// X-Magpie-Response-Model: member, has the body's model say magpie's id
+// instead, except for the agents that read it themselves (vendorNamed);
+// X-Magpie-Response-Model: vendor keeps the vendor's text. The vendor's
+// own name is still in the usage log (Record.Served) and on the Routing
+// page: the request's capture is inside this writer.
 
 import (
 	"bytes"
@@ -108,7 +113,7 @@ func namesMember(r *http.Request, agent string) bool {
 // the handler is done.
 func withMemberNames(w http.ResponseWriter, r *http.Request, from provider.Protocol, asked string) (http.ResponseWriter, *http.Request, func()) {
 	naming := replyNamingOf(r, agentOf(r))
-	if naming == nameVendor || naming == nameAsked && asked == "" {
+	if naming == nameVendor || naming == nameAsked && (asked == "" || magpieAliasAsked(asked)) {
 		return w, r, func() {}
 	}
 	mw := &memberWriter{w: w, naming: naming, asked: asked, paths: memberPathsOf(from)}
diff --git a/internal/gateway/member_test.go b/internal/gateway/member_test.go
index 6cfc7d3b6..daec74142 100644
--- a/internal/gateway/member_test.go
+++ b/internal/gateway/member_test.go
@@ -305,6 +305,67 @@ func TestReplyNamesAskedModel(t *testing.T) {
 	}
 }
 
+// A reply to a request that came in under one of magpie's own aliases for
+// Claude Desktop or Claude Science keeps the vendor's own name (#4667):
+// the alias — magpie-<n>.anthropic.claude-opus-5-5 among them — is
+// magpie's deployment name, not one the vendor knows, and naming the reply
+// with it put that name in Claude Code's usage records, where ccusage
+// counts it as a model of its own instead of the one the subscription
+// served. Before the asked-name rule these ids were served the vendor's
+// name, as every other agent still is.
+func TestReplyToMagpieAliasKeepsVendorName(t *testing.T) {
+	const served = "opus-5-5" // what the subscription's reply says
+	aliases := []string{
+		"magpie-" + aliasNumber("sub/claude-opus-5-5") + desktopClaudeInfix + "claude-opus-5-5",
+		"magpie-" + aliasNumber("sub/claude-opus-5-5") + desktopClaudeInfix + "claude-opus-5-5[1m]",
+		aliasFor("sub/claude-opus-5-5"),
+		desktopEffortAlias + aliasNumber("sub/claude-opus-5-5"),
+		scienceAlias + aliasNumber("sub/claude-opus-5-5"),
+	}
+	for _, stream := range []bool{false, true} {
+		for _, asked := range aliases {
+			name := asked
+			if stream {
+				name += "/stream"
+			}
+			t.Run(name, func(t *testing.T) {
+				fresh(t)
+				up := httptest.NewServer(servedBy(provider.Anthropic, served))
+				t.Cleanup(up.Close)
+				if err := provider.Save(provider.Provider{ID: "sub", Name: "Sub", Key: "k", Anthropic: up.URL, Models: []string{"claude-opus-5-5"}}); err != nil {
+					t.Fatal(err)
+				}
+				m, _ := json.Marshal(asked)
+				body := `{"model":` + string(m) + `,"max_tokens":100,"messages":[{"role":"user","content":"hi"}]`
+				if stream {
+					body += `,"stream":true`
+				}
+				rec := httptest.NewRecorder()
+				s := New()
+				s.Handler().ServeHTTP(rec, httptest.NewRequest("POST", "/v1/messages", strings.NewReader(body+"}")))
+				if rec.Code != 200 || !strings.Contains(rec.Body.String(), "hi") {
+					t.Fatalf("%d %s", rec.Code, rec.Body)
+				}
+				names := modelsNamed(rec.Body.String(), stream)
+				if len(names) == 0 {
+					t.Fatalf("no model named in %s", rec.Body)
+				}
+				for _, n := range names {
+					if n != served {
+						t.Fatalf("the reply names %q, want the vendor's %q:\n%s", n, served, rec.Body)
+					}
+				}
+				if r := lastRoute(s); r.Served != served {
+					t.Errorf("the route says %q served it, want the vendor's %q", r.Served, served)
+				}
+				if calls := s.Recent(); len(calls) == 0 || calls[0].Usage.Served != served {
+					t.Errorf("the log says %+v served it, want the vendor's %q", calls, served)
+				}
+			})
+		}
+	}
+}
+
 // A Gemini agent asks in the URL, and the reply's modelVersion names that
 // model when the request went out under another name.
 func TestGeminiReplyNamesAskedModel(t *testing.T) {
-- 
2.50.1 (Apple Git-155)

```

</details>

Branch with the commit: [hunt115-a3-4667](https://github.com/ggbdpq/magpie/tree/hunt115-a3-4667) (head `4ce5b6c0fd422c104bccc59968169b54e18a4bc4`).
