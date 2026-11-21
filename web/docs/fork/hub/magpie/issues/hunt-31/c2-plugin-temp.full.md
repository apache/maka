补丁在 [ggbdpq/magpie@hunt31-c2-prov-plugin-temp](https://github.com/ggbdpq/magpie/tree/hunt31-c2-prov-plugin-temp)（基于 ea3dee96）。

## 现象

帖子里说的链路属实，且两条口子都在：

1. `host.js` 的 `info()` 处理 config models 时，capabilities spread 只读 `m.reasoning`/`m.attachment`/`m.tool_call`/`m.modalities`，**config 模型行的 `temperature` 键根本没被读**——Factory 0.1.31 在 config models 里写的 `temperature: false` 到这一步就丢了；
2. `host.js` 输出给 magpie 的模型行不带 `capabilities.temperature`，`plugin.Model`（internal/plugin/providers.go）也没有这个字段，`pluginCatalog`（internal/provider/plugins.go）因此不填 `catalog.Model.Temperature`，`Provider.RejectsTemperature` 对插件模型永远返回 false，gateway 的构建把 temperature/top_p 照发。

## 修法

- `host.js` `info()`：config models 的 capabilities spread 加 `...(m.temperature !== undefined ? { temperature: m.temperature } : {})`；
- `host.js` providers 输出：仿 `imageSaid` 先例加 `temperatureSaid`（有没有说）与 `temperature`（说的是不是 true），models hook 与 config 两条路都覆盖；
- `plugin.Model` 加 `temperatureSaid`/`temperature`；`pluginCatalog` 在说了的情况下填 `catalog.Model.Temperature`；
- `RejectsTemperature` 经 `Available()` 即得，gateway `buildFor` 无需改动——插件模型拒绝 temperature/top_p 后走与 catalog 模型同一条剥离路径。

## 红绿证据

新增 `internal/gateway/plugin_temperature_test.go`，fake 插件加 `$FAKE_NOTEMP`：一个 config 模型写 `temperature: false`（Factory 0.1.31 的写法），一个 models hook 模型在 capabilities 上说 false（OpenCode 原生形状），走完整 gateway 栈发 `{"temperature":0.4,"top_p":0.9,...}`，断言到达插件 fetch 的请求体。

当前 main（ea3dee96）无补丁时：

```
--- FAIL: TestPluginModelTemperatureSaidIsRead
    plugin_temperature_test.go:63: a config model saying temperature: false was asked with map[temperature:true top_p:true]
    plugin_temperature_test.go:66: a models hook model saying capabilities.temperature false was asked with map[temperature:true top_p:true]
```

带补丁转绿，且「什么都没说」的 `fake-1` 照旧带 temperature/top_p（同测试第三断言）。消融：把三个产品文件（host.js、providers.go ×2）摘回 HEAD 重放，同形红。

## 验证

| 项目 | 结果 |
| --- | --- |
| 修前红 / 消融回红 | 见上，ea3dee96 上复现 |
| 修后 | 该测试绿；`go test -tags nogui -p 2` internal/plugin、internal/provider 整包 ok，gateway 的 `Plugin\|Fake\|Moved\|Mover\|Parity` 全绿 |
| `gofmt -l` | 无输出 |
| `go vet` | darwin、`GOOS=linux -tags nogui`、`GOOS=windows` 对 plugin/provider/gateway 均通过 |
| `go build` | darwin、`GOOS=linux -tags nogui`、`GOOS=windows` 均通过 |
| **没跑的** | 没用真实 Factory 账号实测（帖子报告的 400 依据 sweanng424 的 Discord 报告与 plugins#154，测试用 fake 插件同一形状）；没测 Responses/Anthropic 协议下插件模型的剥离（`rejectTemp` 在 buildChat/buildResponses 两处生效，测试只走 Chat） |

合入请保留原作者或加 Co-authored-by: ggbdpq <ggbdpq@gmail.com>。

Generated-by: GLM-5.3-Flash (ZCode)

<details><summary>git format-patch</summary>
```diff
From e700d950c5c81d57803b44244a9707aba15bacc2 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Fri, 16 Oct 2026 20:37:50 +0800
Subject: [PATCH] plugin: a plugin model said temperature: false is asked
 without temperature and top_p, as a catalog's model refusing them is (#2492)

What changed: host.js didn't pass on OpenCode's capabilities.temperature
(its config models' temperature key wasn't read either), plugin.Model had
no field for it and pluginCatalog filled no Temperature in, so
RejectsTemperature never held for a plugin's model and Factory's OpenAI
models went to the plugin with temperature and top_p on (sweanng424 on
Discord; the plugin strips them itself since 0.1.31, magpie-community/
plugins#154). host.js carries the capability into the model rows now
(temperatureSaid/temperature, as imageSaid is), its config models'
temperature key is read into capabilities, plugin.Model takes both fields
and pluginCatalog fills catalog.Model.Temperature, which
Provider.RejectsTemperature reads through Available(); the gateway's
builds then leave temperature and top_p off for such a model. One said
true, and one said nothing of, go with what the agent asked.

Run at ea3dee96 + this change: TestPluginModelTemperatureSaidIsRead red
without it (both a config model saying temperature: false and one whose
models hook says capabilities.temperature false were asked with
temperature and top_p on), green with it; go test -tags nogui -p 2 of
internal/plugin, internal/provider and the gateway's Plugin|Fake|Moved|
Mover|Parity set ok. gofmt -l clean; GOOS=darwin/linux/windows go vet of
plugin, provider and gateway clean; the three builds ok.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/plugin_temperature_test.go | 71 +++++++++++++++++++++
 internal/plugin/host.js                     |  5 ++
 internal/plugin/providers.go                |  6 ++
 internal/plugin/testdata/fake/index.js      |  6 ++
 internal/provider/plugins.go                |  7 ++
 5 files changed, 95 insertions(+)
 create mode 100644 internal/gateway/plugin_temperature_test.go

diff --git a/internal/gateway/plugin_temperature_test.go b/internal/gateway/plugin_temperature_test.go
new file mode 100644
index 00000000..e18790b2
--- /dev/null
+++ b/internal/gateway/plugin_temperature_test.go
@@ -0,0 +1,71 @@
+package gateway
+
+import (
+	"encoding/json"
+	"io"
+	"net/http"
+	"net/http/httptest"
+	"strings"
+	"sync"
+	"testing"
+)
+
+// tempUp is an upstream for the fake plugin that answers Chat and keeps
+// whether each body it was asked with carried temperature and top_p.
+type tempUp struct {
+	mu    sync.Mutex
+	sents []map[string]bool
+}
+
+func (u *tempUp) ServeHTTP(w http.ResponseWriter, r *http.Request) {
+	var q map[string]any
+	b, _ := io.ReadAll(r.Body)
+	json.Unmarshal(b, &q)
+	u.mu.Lock()
+	u.sents = append(u.sents, map[string]bool{"temperature": q["temperature"] != nil, "top_p": q["top_p"] != nil})
+	u.mu.Unlock()
+	w.Header().Set("Content-Type", "text/event-stream")
+	io.WriteString(w, sse(`data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"},"finish_reason":"stop"}]}`, `data: [DONE]`))
+}
+
+func (u *tempUp) sent(t *testing.T, model string) map[string]bool {
+	t.Helper()
+	u.mu.Lock()
+	defer u.mu.Unlock()
+	if len(u.sents) == 0 {
+		t.Fatal("the plugin asked its upstream nothing")
+	}
+	return u.sents[len(u.sents)-1]
+}
+
+// A plugin model that refuses temperature and top_p says so where a
+// catalog's does: its config model's temperature (Factory's 0.1.31, #154)
+// or its models hook's capabilities.temperature (OpenCode's shape). The
+// request magpie builds goes without them (#2492), as RejectsTemperature
+// holds for a provider of the user's own; one said true, and one said
+// nothing of, go with what the agent asked.
+func TestPluginModelTemperatureSaidIsRead(t *testing.T) {
+	t.Setenv("FAKE_NOTEMP", "1")
+	up := &tempUp{}
+	pid := besideFake(t, "notemp", up)
+	h := New().Handler()
+	ask := func(model string) map[string]bool {
+		t.Helper()
+		rec := httptest.NewRecorder()
+		h.ServeHTTP(rec, httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(
+			`{"model":"`+pid+`/`+model+`","temperature":0.4,"top_p":0.9,"messages":[{"role":"user","content":"hi"}]}`)))
+		if rec.Code != 200 {
+			t.Fatalf("%s: %d %s", model, rec.Code, rec.Body)
+		}
+		return up.sent(t, model)
+	}
+	if s := ask("fake-notemp"); s["temperature"] || s["top_p"] {
+		t.Errorf("a config model saying temperature: false was asked with %v", s)
+	}
+	if s := ask("fake-hooktemp"); s["temperature"] || s["top_p"] {
+		t.Errorf("a models hook model saying capabilities.temperature false was asked with %v", s)
+	}
+	if s := ask("fake-1"); !s["temperature"] || !s["top_p"] {
+		t.Errorf("a model said nothing of was asked with %v, want both on", s)
+	}
+}
diff --git a/internal/plugin/host.js b/internal/plugin/host.js
index c6324892..fce08af9 100644
--- a/internal/plugin/host.js
+++ b/internal/plugin/host.js
@@ -1502,6 +1502,7 @@ async function info(id, key, strict) {
       headers: { ...(was?.headers ?? {}), ...(m.headers ?? {}) },
       capabilities: {
         ...(was?.capabilities ?? { temperature: true, toolcall: true, input: { text: true }, output: { text: true } }),
+        ...(m.temperature !== undefined ? { temperature: m.temperature } : {}),
         ...(m.reasoning !== undefined ? { reasoning: m.reasoning } : {}),
         ...(m.attachment !== undefined ? { attachment: m.attachment } : {}),
         ...(m.tool_call !== undefined ? { toolcall: m.tool_call } : {}),
@@ -1729,6 +1730,10 @@ async function providers({ proxies } = {}) {
           reasoning: !!m.capabilities?.reasoning,
           image: !!m.capabilities?.input?.image,
           imageSaid: typeof m.capabilities?.input?.image === "boolean",
+          // whether the model takes temperature: a model said false refuses
+          // it and top_p, as a catalog's does (#2492); not said, not known
+          temperatureSaid: typeof m.capabilities?.temperature === "boolean",
+          temperature: m.capabilities?.temperature === true,
           // every kind it takes and gives, not image alone (#1595)
           inputs: kinds(m.capabilities?.input),
           outputs: kinds(m.capabilities?.output),
diff --git a/internal/plugin/providers.go b/internal/plugin/providers.go
index 56b603a9..38bc6062 100644
--- a/internal/plugin/providers.go
+++ b/internal/plugin/providers.go
@@ -84,6 +84,12 @@ type Model struct {
 	// ImageSaid is whether the plugin (or models.dev) said if it takes
 	// images: Image false without it is not known
 	ImageSaid bool `json:"imageSaid"`
+	// TemperatureSaid is whether the plugin (its config, models.dev or the
+	// models hook) said whether the model takes temperature: Temperature
+	// false refuses it and top_p, as a catalog's does (#2492). Said
+	// nothing, not known.
+	TemperatureSaid bool `json:"temperatureSaid"`
+	Temperature     bool `json:"temperature"`
 	// Inputs and Outputs are the kinds capabilities.input and .output say
 	// the model takes and gives (text, image, audio, video, pdf), in
 	// OpenCode's order: not image alone (#1595)
diff --git a/internal/plugin/testdata/fake/index.js b/internal/plugin/testdata/fake/index.js
index 9981f08a..4f1a65b9 100644
--- a/internal/plugin/testdata/fake/index.js
+++ b/internal/plugin/testdata/fake/index.js
@@ -112,6 +112,9 @@ export const FakePlugin = async ({ client }) => ({
     if (process.env.FAKE_ZEN) {
       cfg.provider[ID].models["muse-spark-1.3-contributor-free"] = {"id":"muse-spark-1.3-contributor-free","name":"Muse Spark 1.3 Free","provider":{"npm":"@ai-sdk/openai"},"limit":{"context":1048576,"output":131072},"reasoning":true,"tool_call":true,"attachment":true,"modalities":{"input":["text","image","audio","video","pdf"],"output":["text"]},"cost":{"input":0,"output":0},"variants":{"minimal":{"reasoningEffort":"minimal"},"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"},"xhigh":{"reasoningEffort":"xhigh"}},"free":true}
     }
+    // $FAKE_NOTEMP: a model that refuses temperature and top_p, saying so
+    // in its config as Factory's 0.1.31 does (magpie-community/plugins#154)
+    if (process.env.FAKE_NOTEMP) cfg.provider[ID].models["fake-notemp"] = { name: "Fake No Temp", temperature: false, limit: { context: 1000, output: 100 } }
   },
   auth: {
     provider: ID,
@@ -263,6 +266,9 @@ export const FakePlugin = async ({ client }) => ({
         p.models["mimo-v2.6-flash-free"] = { ...p.models["fake-1"], id: "mimo-v2.6-flash-free", name: "MiMo V2.6 Flash Free", api: { ...p.models["fake-1"].api, id: "mimo-v2.6-flash-free" }, free: true, variants: {},
           capabilities: {"temperature":true,"reasoning":true,"attachment":true,"toolcall":true,"input":{"text":true,"image":true,"audio":true,"video":true,"pdf":false},"output":{"text":true,"image":false,"audio":false,"video":false,"pdf":false},"interleaved":{"field":"reasoning_content"}} }
       }
+      // $FAKE_NOTEMP: one more, saying so on its capabilities as a models
+      // hook does (OpenCode's shape)
+      if (process.env.FAKE_NOTEMP) p.models["fake-hooktemp"] = { ...p.models["fake-1"], id: "fake-hooktemp", name: "Fake Hook Temp", api: { ...p.models["fake-1"].api, id: "fake-hooktemp" }, capabilities: { ...p.models["fake-1"].capabilities, temperature: false } }
       // $FAKE_DECIDE: one more decision model, marked on the list the hook
       // gives, as a plugin that reads its vendor's list marks one
       if (process.env.FAKE_DECIDE) p.models["fake-judge"] = { ...p.models["fake-1"], id: "fake-judge", name: "Fake Judge", api: { ...p.models["fake-1"].api, id: "fake-judge" }, free: false, decides: true }
diff --git a/internal/provider/plugins.go b/internal/provider/plugins.go
index eb6e0843..ba4e2890 100644
--- a/internal/provider/plugins.go
+++ b/internal/provider/plugins.go
@@ -249,6 +249,13 @@ func pluginCatalog(pp plugin.Provider) []catalog.Model {
 			c.InputModalities = m.Inputs
 		}
 		c.OutputModalities = m.Outputs
+		// whether it takes temperature, where the plugin said: a model said
+		// false refuses it and top_p, as one a catalog says false of does
+		// (#2492)
+		if m.TemperatureSaid {
+			takes := m.Temperature
+			c.Temperature = &takes
+		}
 		out = append(out, c)
 	}
 	return out
-- 
2.50.1 (Apple Git-155)

```

</details>
