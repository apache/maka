Refreshed on current `main` (`729664580`) — refreshed, not redesigned: same change (a tool schema whose `$ref` reaches a recursive any-JSON anyOf goes to DashScope with the ref dropped where it stands), cherry-picked onto today's tip with the one conflict resolved to keep upstream's reworked `geminiTypes` beside the new `aliyunToolAnyRefs` line.

**Red without the fix** (bare `729664580`): the rewrite lives in `aliyun_schema.go`, a file the base has no trace of — the behavior red is carried by ablation below (the function answered no-op, the rewrite never happens, the test fails); the unit test runs the rewrite itself against the reporter's exact shape (kimi-k3.1-pro, one recursive anyOf behind `$defs/__schema0`) plus the three guards: another provider untouched, a ref with no cycle untouched, a cycle outside an anyOf untouched.

With the fix: `TestAliyunToolAnyRefs ok` — the ref becomes `{}`, the defs only it read go with it, `$defs` goes when it empties.

**Verification** (all on `729664580`, darwin/arm64):
| What | Result |
| --- | --- |
| `go test ./internal/gateway -run TestAliyunToolAnyRefs` | ok 1.1s |
| full `go test -timeout 25m ./internal/gateway` | ok 883.7s, zero failures |
| `gofmt` / `go vet` | clean |
| ablation (the `dashScope`/`$ref` gate answers `true` early — the function a no-op) | red again (`TestAliyunToolAnyRefs FAIL`); restored, green |
| `git am` on detached `729664580` | applies as is; tree identical to the branch head |

**Siblings**: `dashScope()`'s other consumers (image drawing, the 429 reset, the relay non-stream wait) are separate faces; the neighboring tool-shape rewriters in `forwardOnce` (`toolOneOfAsAnyOf`, `kimiToolRefTypes`, `geminiTypes`) keep their own protocols — this one only answers DashScope's recursive anyOf refusal.

**Branch with the commit**: [hunt-20261111-rf-5601](https://github.com/ggbdpq/magpie/tree/hunt-20261111-rf-5601) (head `69e37fca8f14991d`).

**Not verified**: Aliyun's DashScope endpoint itself (the reporter's 400 "Invalid request parameters" is the pinned shape; the rewrite is checked against their verified control — an empty object holds what the recursion described).

**Attribution**: AI-written; I've read the whole diff and can answer questions on it myself. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

**Patch**: <details><summary>patch: gateway: a recursive any-JSON $ref in a tool schema goes to DashScope as {} (#5601) — git am applies it as is; SHA-256 first 16: e706031f1cfab5ee</summary>

```patch
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Sun, 8 Nov 2026 00:12:22 +0800
Subject: [PATCH] gateway: a recursive any-JSON $ref in a tool schema goes to
 DashScope as {} (#5601)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

Aliyun's OpenAI-compatible serving (DashScope) rejects a tool schema
whose $ref reaches a recursive anyOf outright — 400 "Invalid request
parameters" on the model layer, one user message, no tool call needed
(#5601, Eleef: kimi-k3.1-pro; the reporter's A/B table rules history and
reasoning replay out, and their verified control replaces the recursive
target with {} and drops the now-unused defs). kimiToolRefTypes leaves
an anyOf target alone on purpose (Kimi's validator says the type belongs
in the items), and a custom Aliyun provider is no Kimi at all, so the
ref rode to Aliyun as it was.

The ref is dropped where it stands on DashScope-bound Responses bodies:
an empty object holds exactly the values such a recursion describes, so
the schema says the same. The defs only that ref was reading go with it,
and $defs with them when it empties. A ref with no cycle behind it, a
cycle outside an anyOf, and a chain that ends nowhere or never ends are
left as they were, as are other providers and protocols. dashScope's
preset list shares the work: the same serving layer answers Qwen's
presets, where the recursion would refuse the same way.

The reporter left the placement to the maintainer (Kimi normalization,
an Aliyun/K3.1 compatibility transform, or the provider's own fix); the
narrow DashScope transform is the one the evidence supports, and the
other two stay open.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/aliyun_schema.go      | 234 +++++++++++++++++++++++++
 internal/gateway/aliyun_schema_test.go |  62 +++++++
 internal/gateway/gateway.go            |   1 +
 3 files changed, 297 insertions(+)
 create mode 100644 internal/gateway/aliyun_schema.go
 create mode 100644 internal/gateway/aliyun_schema_test.go

diff --git a/internal/gateway/aliyun_schema.go b/internal/gateway/aliyun_schema.go
new file mode 100644
index 000000000..d477dc161
--- /dev/null
+++ b/internal/gateway/aliyun_schema.go
@@ -0,0 +1,234 @@
+package gateway
+
+import (
+	"bytes"
+	"strings"
+
+	"github.com/tidwall/gjson"
+	"github.com/yetone/magpie/internal/provider"
+)
+
+// aliyunToolAnyRefs is body with each tool-schema $ref that reaches a
+// recursive anyOf dropped where it stands — the schema holding it is left
+// an empty object, which accepts exactly the values such a recursion
+// describes (#5601, Eleef: Aliyun's OpenAI-compatible serving rejects the
+// request outright, 400 "Invalid request parameters", one user message,
+// no tool call needed; the reporter's verified control replaces the
+// recursive target with {} and drops the now-unused defs). The defs only
+// that ref was reading go with it, and $defs with them when it empties.
+// A ref with no cycle behind it, a cycle outside an anyOf, and a chain
+// that ends nowhere or never ends are left as they were, as are other
+// providers, protocols and schemas.
+func aliyunToolAnyRefs(p provider.Provider, to provider.Protocol, body []byte) []byte {
+	if !dashScope(p) || !bytes.Contains(body, []byte(`"$ref"`)) {
+		return body
+	}
+	tools := gjson.GetBytes(body, "tools")
+	if !tools.IsArray() || tools.Index <= 0 {
+		return body
+	}
+	var cuts []span
+	tools.ForEach(func(_, tool gjson.Result) bool {
+		for _, at := range []string{"function.parameters", "parameters", "input_schema"} {
+			if root := tool.Get(at); root.IsObject() {
+				cuts = append(cuts, aliyunRecursiveRefs(body, root)...)
+			}
+		}
+		return true
+	})
+	if len(cuts) == 0 {
+		return body
+	}
+	body = cutSpans(body, cuts)
+	// defs the dropped ref was the last reader of go with it, a chain of
+	// them one round at a time, and $defs when it empties.
+	for r := 0; r < 10; r++ {
+		var gone []span
+		tools = gjson.GetBytes(body, "tools")
+		tools.ForEach(func(_, tool gjson.Result) bool {
+			for _, at := range []string{"function.parameters", "parameters", "input_schema"} {
+				if root := tool.Get(at); root.IsObject() {
+					used := refNamesIn(root)
+					gone = append(gone, orphanDefs(body, root, used)...)
+				}
+			}
+			return true
+		})
+		if len(gone) == 0 {
+			break
+		}
+		body = cutSpans(body, gone)
+	}
+	return body
+}
+
+// aliyunRecursiveRefs adds a span over each $ref under root whose target
+// takes part in a reference cycle and is an anyOf: taken for any JSON
+// value it stands for, an empty object says the same, and Aliyun refuses
+// the recursion. The span covers the "$ref" key and its value, ready for
+// cutSpans. A chain that ends nowhere or never ends adds nothing.
+func aliyunRecursiveRefs(body []byte, root gjson.Result) []span {
+	var cuts []span
+	walkSchema(root, func(s gjson.Result) {
+		ref := s.Get(`\$ref`)
+		if ref.Type != gjson.String {
+			return
+		}
+		t, ok := refTarget(root, ref.String())
+		if !ok {
+			return
+		}
+		for i := 0; ; i++ {
+			r := t.Get(`\$ref`)
+			if r.Type != gjson.String {
+				break
+			}
+			n, ok := refTarget(root, r.String())
+			if !ok || n.Index == t.Index {
+				break // the chain ends here or circles: take t as it ends
+			}
+			t = n
+		}
+		if !t.Get("anyOf").Exists() || !reachesItself(root, t) {
+			return
+		}
+		key := bytes.LastIndex(body[:ref.Index], []byte(`"$ref"`))
+		if key < 0 {
+			return
+		}
+		cuts = append(cuts, span{key, ref.Index + len(ref.Raw)})
+	})
+	return cuts
+}
+
+// reachesItself says whether any $ref under s comes back to s, directly
+// or through the refs it reaches: s then stands inside a cycle.
+func reachesItself(root, s gjson.Result) bool {
+	seen := map[int]bool{s.Index: true}
+	var walk func(n gjson.Result) bool
+	walk = func(n gjson.Result) bool {
+		found := false
+		walkSchema(n, func(x gjson.Result) {
+			if found {
+				return
+			}
+			r := x.Get(`\$ref`)
+			if r.Type != gjson.String {
+				return
+			}
+			t, ok := refTarget(root, r.String())
+			if !ok {
+				return
+			}
+			for {
+				q := t.Get(`\$ref`)
+				if q.Type != gjson.String {
+					break
+				}
+				u, ok := refTarget(root, q.String())
+				if !ok || u.Index == t.Index {
+					break
+				}
+				t = u
+			}
+			if t.Index == s.Index {
+				found = true
+			} else if !seen[t.Index] {
+				seen[t.Index] = true
+				found = walk(t)
+			}
+		})
+		return found
+	}
+	return walk(s)
+}
+
+// refNamesIn lists the def names root's $refs read, "#/$defs/x" taking x.
+func refNamesIn(root gjson.Result) map[string]bool {
+	used := map[string]bool{}
+	walkSchema(root, func(s gjson.Result) {
+		ref := s.Get(`\$ref`)
+		if ref.Type != gjson.String {
+			return
+		}
+		if rest, ok := strings.CutPrefix(ref.String(), "#/$defs/"); ok {
+			used[rest] = true
+		}
+	})
+	return used
+}
+
+// orphanDefs adds spans over the defs under root's "$defs" nothing reads,
+// and over "$defs" itself once it is empty.
+func orphanDefs(body []byte, root gjson.Result, used map[string]bool) []span {
+	var cuts []span
+	defs := root.Get("$defs")
+	if !defs.IsObject() || defs.Index <= 0 {
+		return nil
+	}
+	live := 0
+	defs.ForEach(func(name, def gjson.Result) bool {
+		if used[name.String()] {
+			live++
+			return true
+		}
+		key := bytes.LastIndex(body[:def.Index], []byte(`"`+name.String()+`"`))
+		if key >= 0 {
+			cuts = append(cuts, span{key, def.Index + len(def.Raw)})
+		}
+		return true
+	})
+	if live == 0 {
+		key := bytes.LastIndex(body[:defs.Index], []byte(`"$defs"`))
+		if key >= 0 {
+			cuts = append(cuts, span{key, defs.Index + len(defs.Raw)})
+		}
+	}
+	return cuts
+}
+
+// span is a half-open byte range of body a cut removes.
+type span struct {
+	at, end int
+}
+
+// cutSpans is body with every span removed, rebuilt front to back (the
+// withTypes pattern): a cut takes the comma before it with it, or the one
+// after when there is no comma before, so what stays behind still parses.
+// A span past an earlier cut's start, or off the body, is skipped.
+func cutSpans(body []byte, cuts []span) []byte {
+	for i := 1; i < len(cuts); i++ {
+		for j := i; j > 0 && cuts[j-1].at > cuts[j].at; j-- {
+			cuts[j], cuts[j-1] = cuts[j-1], cuts[j]
+		}
+	}
+	var out bytes.Buffer
+	out.Grow(len(body))
+	last := 0
+	for _, c := range cuts {
+		if c.at < last || c.end > len(body) || c.at >= c.end {
+			continue
+		}
+		k := c.at - 1
+		for k >= last && (body[k] == ' ' || body[k] == '\t' || body[k] == '\n' || body[k] == '\r') {
+			k--
+		}
+		if k >= last && body[k] == ',' {
+			out.Write(body[last:k])
+			last = c.end
+			continue
+		}
+		out.Write(body[last:c.at])
+		j := c.end
+		for j < len(body) && (body[j] == ' ' || body[j] == '\t' || body[j] == '\n' || body[j] == '\r') {
+			j++
+		}
+		if j < len(body) && body[j] == ',' {
+			last = j + 1
+		} else {
+			last = c.end
+		}
+	}
+	out.Write(body[last:])
+	return out.Bytes()
+}
diff --git a/internal/gateway/aliyun_schema_test.go b/internal/gateway/aliyun_schema_test.go
new file mode 100644
index 000000000..81078f89e
--- /dev/null
+++ b/internal/gateway/aliyun_schema_test.go
@@ -0,0 +1,62 @@
+package gateway
+
+import (
+	"encoding/json"
+	"testing"
+
+	"github.com/yetone/magpie/internal/provider"
+)
+
+// TestAliyunToolAnyRefs: Aliyun's OpenAI-compatible serving (DashScope)
+// rejects a tool schema whose $ref reaches a recursive anyOf outright,
+// 400 "Invalid request parameters" (#5601, Eleef: kimi-k3.1-pro, one
+// user message, no tool call), though an empty object holds the values
+// the recursion describes — the reporter's verified control. The ref is
+// dropped where it stands (an empty object is what remains), the defs
+// only it read go with it, and $defs with them when it empties. Refs
+// with no cycle behind them, cycles outside an anyOf, and other
+// providers are left as they were.
+func TestAliyunToolAnyRefs(t *testing.T) {
+	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
+	t.Setenv("XDG_CACHE_HOME", t.TempDir())
+	aliyun := provider.Provider{ID: "aliyun", Name: "Aliyun", Key: "k", Chat: "https://dashscope.aliyuncs.com/compatible-mode/v1", Models: []string{"kimi-k3.1-pro"}}
+	other := provider.Provider{ID: "other", Name: "Other", Key: "k", Chat: "https://api.other.test/v1", Models: []string{"m"}}
+	schema := `{"type":"object","properties":{"mode":{"type":"string","enum":["repositories","name"]},` +
+		`"secrets":{"type":"array","items":{"type":"object","properties":{"name":{"type":"string"},` +
+		`"target":{"$ref":"#/$defs/__schema0"}},"required":["name"],"additionalProperties":false}}},` +
+		`"required":["mode"],"additionalProperties":false,` +
+		`"$defs":{"__schema0":{"anyOf":[{"type":"string"},{"type":"number"},{"type":"boolean"},{"type":"null"},` +
+		`{"type":"array","items":{"$ref":"#/$defs/__schema0"}},` +
+		`{"type":"object","properties":{},"additionalProperties":{"$ref":"#/$defs/__schema0"}}]}}}`
+	body := `{"tools":[{"type":"function","name":"request_environment_input","strict":false,"parameters":` + schema + `}]}`
+
+	out := aliyunToolAnyRefs(aliyun, provider.Chat, []byte(body))
+	var o map[string]any
+	if err := json.Unmarshal(out, &o); err != nil {
+		t.Fatalf("rewritten body is not JSON: %v: %s", err, out)
+	}
+	params := o["tools"].([]any)[0].(map[string]any)["parameters"].(map[string]any)
+	if _, has := params["$defs"]; has {
+		t.Fatalf("$defs kept: %s", out)
+	}
+	props := params["properties"].(map[string]any)
+	target := props["secrets"].(map[string]any)["items"].(map[string]any)["properties"].(map[string]any)["target"].(map[string]any)
+	if len(target) != 0 {
+		t.Fatalf("target not emptied: %v", target)
+	}
+	if _, ok := props["mode"]; !ok {
+		t.Fatalf("mode lost: %s", out)
+	}
+	if string(aliyunToolAnyRefs(other, provider.Chat, []byte(body))) != body {
+		t.Fatalf("a non-Aliyun provider's body was touched: %s", out)
+	}
+
+	simple := `{"tools":[{"type":"function","name":"t","parameters":{"type":"object","properties":{"p":{"$ref":"#/$defs/P"}},"$defs":{"P":{"type":"string"}}}}]}`
+	if string(aliyunToolAnyRefs(aliyun, provider.Chat, []byte(simple))) != simple {
+		t.Fatalf("a ref with no cycle behind it was touched: %s", aliyunToolAnyRefs(aliyun, provider.Chat, []byte(simple)))
+	}
+	oneof := `{"tools":[{"type":"function","name":"t","parameters":{"type":"object","properties":{"p":{"$ref":"#/$defs/R"}},"$defs":{"R":{"oneOf":[{"type":"string"},{"$ref":"#/$defs/R"}]}}}}]}`
+	if string(aliyunToolAnyRefs(aliyun, provider.Chat, []byte(oneof))) != oneof {
+		t.Fatalf("a cycle outside an anyOf was touched: %s", aliyunToolAnyRefs(aliyun, provider.Chat, []byte(oneof)))
+	}
+}
diff --git a/internal/gateway/gateway.go b/internal/gateway/gateway.go
index 607f8c2b6..25703ba50 100644
--- a/internal/gateway/gateway.go
+++ b/internal/gateway/gateway.go
@@ -5968,6 +5968,7 @@ func (s *Server) forwardOnce(ctx context.Context, p provider.Provider, to provid
 	body = copilotGrokFlat(p, to, body)
 	body = kimiToolEnumTypes(p, to, body)
 	body = kimiToolRefTypes(p, to, body)
+	body = aliyunToolAnyRefs(p, to, body)
 	body = geminiTypes(body, copilotGemini(p, body))
 	body = kimiLockedSampling(p, to, body)
 	body = clinePin(p, to, body)
-- 
2.50.1 (Apple Git-155)

```
</details>

