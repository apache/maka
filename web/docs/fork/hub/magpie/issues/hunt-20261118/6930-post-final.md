Verification of @zhangyan-unipat's fix — commit `f29fd4a3b1e6edcd1d0dfb88d64e63c6135aa794` on `zhangyan-unipat/magpie`. Targeted checks, targeted `-race` and the complete gateway, provider and GUI package tests passed on the first carrier; after a clean refresh rebase onto the current `upstream/main`, the named tests, `-race`, the UI suites and the cross-platform matrix were re-run on the final carrier and passed. The full repository suite completed with exit 1 because three CLI assertions failed; full acceptance is not established. I independently reviewed and rebased the reporter's original commit; its author is unchanged.

**What I verified independently** (not trusting the write-up)
- Current base: the original commit was rebased onto `upstream/main` `889991b15f9ed3af3ed4e7e783dc832ef9c3e929` (first carrier `ad64e342d22ac6c095cbe0ceb44a145a9498da51`); the only conflict was `internal/gui/assets/app.js`, resolved to retain both upstream's `maxImages` Advanced-state condition and this fix's `geminiModelInBody` condition. A refresh rebase onto the current `upstream/main` `cd25b37358e47cc1a42facfd185a6a68ee662ff4` applied cleanly; `git range-diff` between the two carriers is `=` and the final carrier is `bffb833c6cf8918d40483ef8117b48cfb7a4f0c2`. The commit author remains `zhangyan-unipat <zhangyan@unipat.ai>`.
- Red without the fix (refresh base `cd25b3735`): with the new tests kept and the product changes that preserve/send the model removed, `TestGeminiRelayModelBody` and `TestGeminiRelayModelBodyProbe` each failed with the relay's reported HTTP 400, `Model is unsupported and no wildcard routing rule is configured`. Restoring the product changes turned both green.
- Green with the fix (final carrier `bffb833c6`): targeted `-run 'TestGeminiRelayModelBody'` passed in `internal/gateway`, `internal/provider`, `internal/cli` and `internal/gui`, and the same targeted run passed with `-race`. The gateway test covers translated Responses and Messages requests, native Gemini generate/stream requests, two routed models and their upstream-name mappings. The provider test covers model probing with the mapped upstream name and the stays-out-of-other-wires case. The same targeted and race checks had already passed on the first carrier with its four changed Go packages.
- UI (final carrier): `provider-gemini-model-body.test.cjs` passed 20/20 across Chromium and WebKit, five languages (en, zh, zh-TW, ja, de), and 1100px/420px. The existing provider images compatibility controls (`provider-max-images.test.cjs`, 60 tests across both engines) passed. `i18n-keys.test.cjs` and `TestCoreScriptBudget` passed.
- Siblings: `SendsGeminiModel` gates only custom Gemini API providers (`Gemini != ""`, no account, not Vertex). `forwardOnce` otherwise continues stripping `model`; model-probe request construction uses the same gate. The explicit regression test confirms the opt-in does not affect the official Google URL default, non-Gemini APIs, signed-in accounts or Vertex. Factory keeps its existing body-model behavior. No other model-stripping site was found by `rg`.
- Formatting and tools (final carrier): `gofmt -l` on the changed Go files produced no output; `git diff --check` passed. `go vet ./...` passed on darwin; `GOOS=linux CGO_ENABLED=0 go vet -tags nogui ./...` and the Windows equivalent passed. Darwin build and Linux/Windows `nogui` builds passed.
- Strict `git am` check: applied on a clean detached worktree at `cd25b3735`; the resulting tree is identical to the final carrier's tree (`23d6666c877a3429dbad420df2ef8d5e224ee353`), the author remains `zhangyan-unipat <zhangyan@unipat.ai>` and the committer is `ggbdpq <ggbdpq@gmail.com>`.
- Full-suite status (first carrier `ad64e342d`, base `889991b15` — the pre-refresh tree): the final `go test -tags nogui -timeout=45m -count=1 ./...` completed on that carrier, from 2026-11-18T03:24:57Z to 03:44:14Z, **exit 1**. It used Go 1.26.8 with `GOROOT=/private/tmp/mg-6907-toolchain-copy/go1.26.8`, `GOTOOLCHAIN=local`, a private cache and HOME, a PATH without the real Claude executable but with Node/Bun, and a process-local `scutil --proxy` wrapper returning an empty proxy dictionary. System proxy settings and the user's running gateway were untouched. Complete package results include gateway PASS (1057.255s), provider PASS (263.245s), GUI PASS (177.448s), agent PASS (396.969s), and build/darwin PASS (9.339s). The only failing package was CLI (115.108s): `TestHealthcheckFindsTheRunningGatewayWithoutMagpieAddr` at healthcheck_cli_test.go:116 reported `a note naming another pid than the one answering passed`; `TestUpdateRestartsTheGatewayItFindsWithoutMagpieAddr` at :151 reported `the magpie serving the gateway (0.1.4388) runs from another copy, which wasn't updated: update that one, or restart it`; `TestUpdateFindsAMagpieThatWroteNoRecord` at update_find_test.go:29 found `http://127.0.0.1:3425` instead of `http://127.0.0.1:61035`. These exact failures are reported without calling them pre-existing. The full suite did not pass.
- Earlier attempts: the first command used the invalid flag `-timeout45m` and exited before tests; a corrected earlier suite was interrupted (exit unknown, log ended at internal/fx). A later changed-package run was interrupted during slot overlap and is excluded from accepted verification. An initial retry resolved Go 1.25.5 and failed the go.mod version check before tests. All these logs were preserved; none is represented as passing evidence. The final run above supersedes the incomplete coverage, not the historical failures.
- Real relay: **Not verified independently.** No live relay request was sent. The reporter's account of a real relay is their evidence, not mine.

**Found along the way**
- The completed full suite has the three CLI failures listed above. The existing [#6223 patch discussion](https://github.com/yetone/magpie/issues/6223#issuecomment-6814580486) names all three exact tests and describes `fakeServing` leaving the Settings port at the host default, so these failures match that reported isolation problem. This is a read-only comparison: I have not applied or tested its patch in this carrier and do not claim that it fixes this run. No failure was observed in the targeted tests for this change, or in the completed gateway/provider/GUI packages. Full-repository acceptance remains blocked by the CLI failures.

**Not verified**: live Gemini relay; resolution of the three CLI assertions. The user's existing gateway was not stopped to make tests pass.

**Final full-suite evidence** (local log, first-carrier tree): `/tmp/mg6930-full-suite-v4.log` (900 lines; SHA-256 `b6bdee0abce7a274ad91e42fbd0a316d3850390ae3e90d524050921d684d5946`), `/tmp/mg6930-full-suite-v4.meta`, `/tmp/mg6930-full-suite-v4.exit` (`1`).

**Attribution**: The fix, implementation and commit are @zhangyan-unipat's. The carrier branch preserves the original commit author; it is not my patch. Verification was AI-assisted (GPT-6.1 and GLM-5.3-Flash via ZCode).

**Branch with the commit**: [`verify/6930-gemini-relay-model`](https://github.com/ggbdpq/magpie/tree/verify/6930-gemini-relay-model), head `bffb833c6cf8918d40483ef8117b48cfb7a4f0c2`.

<details><summary>patch: providers, gateway, gui: Gemini 中转可按需携带动态模型名 — git am applies it as is; SHA-256 first 16: 46e7be922470934e</summary>

```patch
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: zhangyan-unipat <zhangyan@unipat.ai>
Date: Tue, 17 Nov 2026 14:04:57 +0800
Subject: [PATCH] =?UTF-8?q?providers,=20gateway,=20gui:=20Gemini=20?=
 =?UTF-8?q?=E4=B8=AD=E8=BD=AC=E5=8F=AF=E6=8C=89=E9=9C=80=E6=90=BA=E5=B8=A6?=
 =?UTF-8?q?=E5=8A=A8=E6=80=81=E6=A8=A1=E5=9E=8B=E5=90=8D?=
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

部分 Gemini 兼容中转除了 URL，还要求请求体包含 model 字段；
现有网关会移除该字段，模型测试也不发送它，因此两条路径都返回 400。

新增默认关闭的供应商级 geminiModelInBody 设置，开启时保留最终路由的
上游模型名。支持 CLI gemini-model=body|path、界面编辑及未保存表单的测试。
切换模型和上游别名映射不需要额外请求体常量。Vertex 和订阅线路保持原状。
为满足现有脚本体积预算，将已有 Errors/Images 控件与新控件一起按需加载。

验证：
- provider/gateway/cli/gui 定向 Go 回归与原有默认 Gemini 线路测试通过。
- 禁用新增发送行为后，TestGeminiRelayModelBody 和
  TestGeminiRelayModelBodyProbe 均以原报告的 400 错误失败；恢复后通过。
- provider/gateway/gui 定向 -race 通过；gofmt 与 diff --check 通过。
- macOS go vet ./...、nogui vet，以及 Linux/Windows nogui vet 通过。
- nogui CLI、原生桌面及 Linux/Windows nogui 构建通过。
- Chromium/WebKit 各 70 项相关界面测试通过，覆盖五种语言及宽窄视口。
- 临时 HOME、独立 API key 配置的真实 Gemini 中转探测通过；未修改运行中的
  Magpie 或用户的 agent 配置。
- 国际化键和新增文案检查通过；完整 i18n-keys 检查另有既存失败：
  plugins/routing 的 ", with an image" 被未修改的 claude_image_budget_test.go 使用。
- 完整 nogui Go 套件未通过并已停止：现有健康检查和更新发现测试会发现
  本机正在运行的 127.0.0.1:3425 网关，导致三个临时服务断言失败。
  未停止或替换用户的网关来跑绿这些测试，不宣称完整套件通过。
---
 docs/subsystems/providers-accounts.md         |  4 +
 internal/cli/providers_cli.go                 | 11 +++
 .../cli/providers_gemini_model_cli_test.go    | 22 +++++
 internal/gateway/gateway.go                   |  2 +-
 internal/gateway/gemini_model_body_test.go    | 66 +++++++++++++++
 internal/gui/assets/app.js                    | 23 +++---
 internal/gui/assets/i18n.js                   | 12 +++
 internal/gui/assets/providercompat.js         | 20 +++++
 .../gui/provider_gemini_model_body_test.go    | 50 ++++++++++++
 internal/gui/providers.go                     | 28 +++++--
 .../tests/provider-gemini-model-body.test.cjs | 80 +++++++++++++++++++
 internal/provider/gemini_api.go               |  6 ++
 internal/provider/gemini_model_body_test.go   | 60 ++++++++++++++
 internal/provider/provider.go                 |  3 +
 internal/provider/test.go                     |  6 +-
 15 files changed, 370 insertions(+), 23 deletions(-)
 create mode 100644 internal/cli/providers_gemini_model_cli_test.go
 create mode 100644 internal/gateway/gemini_model_body_test.go
 create mode 100644 internal/gui/assets/providercompat.js
 create mode 100644 internal/gui/provider_gemini_model_body_test.go
 create mode 100644 internal/gui/tests/provider-gemini-model-body.test.cjs
 create mode 100644 internal/provider/gemini_model_body_test.go

diff --git a/docs/subsystems/providers-accounts.md b/docs/subsystems/providers-accounts.md
index 8dc9dc61b..af5ba0798 100644
--- a/docs/subsystems/providers-accounts.md
+++ b/docs/subsystems/providers-accounts.md
@@ -13,6 +13,10 @@ Plugin ownership of the deprecated built-in subscriptions is in
 [Provider and plugin ownership](provider-plugins.md). How the gateway orders
 keys and accounts per request is in [Gateway routing and fallback](gateway-routing.md).
 
+## Gemini relays that route by the request body
+
+A Gemini API normally takes its model from the URL. A relay that additionally requires `model` in the JSON body can opt in with `geminiModelInBody: true` in its provider, or `magpie provider set <id> gemini-model=body`. The provider editor offers **Send model in Gemini request body** under Advanced. The field follows the final routed upstream name, including model switches and upstream-name mappings; it is not a fixed extra-body value. Both ordinary requests (translated or relayed) and model tests send it. Other APIs, Vertex AI and signed-in accounts are unaffected. The default, `gemini-model=path`, leaves the field out, as Google's own API expects.
+
 ## Responsibilities and sources of truth
 
 | Part | Responsibility | Source |
diff --git a/internal/cli/providers_cli.go b/internal/cli/providers_cli.go
index 68748c0cf..74f9fbf06 100644
--- a/internal/cli/providers_cli.go
+++ b/internal/cli/providers_cli.go
@@ -59,6 +59,8 @@ const providerUsage = `usage:
                                           resolve.<host>=<IP>[,dns:<name>…] connects a host of its base URLs there
                                           (curl --resolve: the URL's name stays for TLS and Host); empty takes the
                                           host's out, resolve= clears them all
+                                          gemini-model=body also sends the routed model in a Gemini relay's request body;
+                                          gemini-model=path, the default, names it in the URL alone
                                           image-files=off sends DeepSeek's API an agent's images inline on every
                                           turn; image-files=on, the default, uploads each once (for a day)
                                           and names it by its file id
@@ -1288,6 +1290,15 @@ func applyPairs(p *provider.Provider, pairs []string) error {
 			default:
 				return fmt.Errorf("codex=as-sent|default, not %q", v)
 			}
+		case "gemini-model":
+			switch strings.ToLower(v) {
+			case "body":
+				p.GeminiModelInBody = true
+			case "path", "default":
+				p.GeminiModelInBody = false
+			default:
+				return fmt.Errorf("gemini-model=path|body, not %q", v)
+			}
 		case "image-files":
 			// off: DeepSeek's own API is sent an agent's images inline on
 			// every turn, not uploaded once and named by file id (#5407)
diff --git a/internal/cli/providers_gemini_model_cli_test.go b/internal/cli/providers_gemini_model_cli_test.go
new file mode 100644
index 000000000..428c7d43e
--- /dev/null
+++ b/internal/cli/providers_gemini_model_cli_test.go
@@ -0,0 +1,22 @@
+package cli
+
+import (
+	"testing"
+
+	"github.com/yetone/magpie/internal/provider"
+)
+
+func TestGeminiRelayModelBodyPair(t *testing.T) {
+	p := provider.Provider{ID: "relay", Gemini: "https://relay.example/v1beta"}
+	for _, value := range []string{"body", "path", "body", "default"} {
+		if err := applyPairs(&p, []string{"gemini-model=" + value}); err != nil {
+			t.Fatal(err)
+		}
+		if p.GeminiModelInBody != (value == "body") {
+			t.Fatalf("gemini-model=%s: body=%v", value, p.GeminiModelInBody)
+		}
+	}
+	if err := applyPairs(&p, []string{"gemini-model=unknown"}); err == nil {
+		t.Fatal("an unknown model location was accepted")
+	}
+}
diff --git a/internal/gateway/gateway.go b/internal/gateway/gateway.go
index a774d1cfc..f3f09472f 100644
--- a/internal/gateway/gateway.go
+++ b/internal/gateway/gateway.go
@@ -6378,7 +6378,7 @@ func (s *Server) forwardOnce(ctx context.Context, p provider.Provider, to provid
 		// (#3172); before the user's own fields, which may name one
 		body = withoutAccessPrograms(body)
 	}
-	if to == provider.Gemini && !p.FactoryGemini() {
+	if to == provider.Gemini && !p.FactoryGemini() && !p.SendsGeminiModel() {
 		// the model is in a Gemini API's and Vertex AI's path
 		// (upstreamPath), as Google's own SDK asks it; Factory's generate
 		// route reads it from the body
diff --git a/internal/gateway/gemini_model_body_test.go b/internal/gateway/gemini_model_body_test.go
new file mode 100644
index 000000000..f06bbb6d4
--- /dev/null
+++ b/internal/gateway/gemini_model_body_test.go
@@ -0,0 +1,66 @@
+package gateway
+
+import (
+	"fmt"
+	"io"
+	"net/http"
+	"net/http/httptest"
+	"strings"
+	"testing"
+
+	"github.com/tidwall/gjson"
+	"github.com/yetone/magpie/internal/provider"
+)
+
+func TestGeminiRelayModelBody(t *testing.T) {
+	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
+	t.Setenv("XDG_CACHE_HOME", t.TempDir())
+	seen := make(chan string, 16)
+	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+		body, _ := io.ReadAll(r.Body)
+		model := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/v1beta/models/"), ":streamGenerateContent")
+		if gjson.GetBytes(body, "model").String() != model {
+			http.Error(w, `{"error":{"message":"Model is unsupported and no wildcard routing rule is configured"}}`, http.StatusBadRequest)
+			return
+		}
+		if r.URL.RawQuery != "alt=sse" || r.Header.Get("x-goog-api-key") != "relay-key" || gjson.GetBytes(body, "stream").Exists() || !gjson.GetBytes(body, "contents").IsArray() {
+			http.Error(w, "wrong Gemini request shape", http.StatusBadRequest)
+			return
+		}
+		seen <- model
+		w.Header().Set("Content-Type", "text/event-stream")
+		io.WriteString(w, "data: {\"candidates\":[{\"content\":{\"role\":\"model\",\"parts\":[{\"text\":\"native reply\"}]},\"finishReason\":\"STOP\"}],\"usageMetadata\":{\"promptTokenCount\":4,\"candidatesTokenCount\":2,\"totalTokenCount\":6}}\n\n")
+	}))
+	t.Cleanup(up.Close)
+	if err := provider.Save(provider.Provider{ID: "relay", Name: "Relay", Key: "relay-key", Gemini: up.URL + "/v1beta", GeminiModelInBody: true, Models: []string{"gemini-one", "gemini-two"}}); err != nil {
+		t.Fatal(err)
+	}
+	for _, model := range []string{"gemini-one", "gemini-two"} {
+		if err := provider.SetUpstreamName("relay/"+model, "vendor/"+model); err != nil {
+			t.Fatal(err)
+		}
+	}
+	for _, model := range []string{"gemini-one", "gemini-two"} {
+		for _, call := range []struct{ path, body string }{
+			{"/v1/responses", fmt.Sprintf(`{"model":"relay/%s","input":"hi","stream":false}`, model)},
+			{"/v1/responses", fmt.Sprintf(`{"model":"relay/%s","input":"hi","stream":true}`, model)},
+			{"/v1/messages", fmt.Sprintf(`{"model":"relay/%s","max_tokens":64,"messages":[{"role":"user","content":"hi"}]}`, model)},
+			{"/v1/messages", fmt.Sprintf(`{"model":"relay/%s","max_tokens":64,"stream":true,"messages":[{"role":"user","content":"hi"}]}`, model)},
+			{"/v1beta/models/relay/" + model + ":generateContent", `{"contents":[{"role":"user","parts":[{"text":"hi"}]}]}`},
+			{"/v1beta/models/relay/" + model + ":streamGenerateContent?alt=sse", `{"contents":[{"role":"user","parts":[{"text":"hi"}]}]}`},
+		} {
+			code, body := post(t, call.path, call.body)
+			if code != http.StatusOK || !strings.Contains(body, "native reply") {
+				t.Fatalf("%s for %s: %d %s", call.path, model, code, body)
+			}
+			select {
+			case got := <-seen:
+				if got != "vendor/"+model {
+					t.Fatalf("%s: asked %q, want %q", call.path, got, "vendor/"+model)
+				}
+			default:
+				t.Fatalf("%s did not reach the Gemini relay", call.path)
+			}
+		}
+	}
+}
diff --git a/internal/gui/assets/app.js b/internal/gui/assets/app.js
index 37e1e49ea..e5e41e8ae 100644
--- a/internal/gui/assets/app.js
+++ b/internal/gui/assets/app.js
@@ -8110,7 +8110,7 @@ function advancedSet(d, p) {
     !!d.proxyMode || Object.values(d.accountProxies || {}).some((x) => x?.mode) || Object.values(d.keyPriceRates || {}).some((v) => String(v).trim()) ||
     [d.concurrency, d.maxAccounts, d.queueLimit, d.queueWait, d.maxRPM, d.priceRate, d.contexts, d.outputs, d.compacts].some((v) => String(v ?? "").trim()) ||
     !!d.rateWindows?.length ||
-    !!(d.searches || d.authHeader || d.passUserAgent === false || d.unredacted || d.countFree || d.billing || d.pinUpstream || d.nativeCompaction || d.balanceToken || d.limitRestOff || d.noBalanceProbe || d.http1 || d.socket || d.imageFilesOff || d.passErrors || d.clientCert || d.serverCA || d.serverPin || d.resolve) ||
+    !!(d.searches || d.authHeader || d.passUserAgent === false || d.unredacted || d.countFree || d.billing || d.pinUpstream || d.nativeCompaction || d.balanceToken || d.limitRestOff || d.noBalanceProbe || d.http1 || d.socket || d.imageFilesOff || d.geminiModelInBody || d.passErrors || d.clientCert || d.serverCA || d.serverPin || d.resolve) ||
     !!d.fallback?.length || !!(p?.balanceToken?.set || p?.connectAgents || p?.maxImages);
 }
 function priceRateError(ed) {
@@ -8180,6 +8180,7 @@ function asTyped() {
   // credentials typed, as a pasted key is
   if (draft.vertex) body.vertex = vertexOfDraft();
   if (draft.headers) body.headers = headersOf(draft.headers);
+  body.geminiModelInBody = !!draft.geminiModelInBody;
   // the extra body typed, when it reads; one that doesn't is the saved one's
   const xb = extraBodyOf(draft.extraBody);
   if (xb.value) body.extraBody = xb.value;
@@ -9447,7 +9448,7 @@ function baseAPIOf(p) {
 
 // draftOf is a saved provider as its editor's form holds it.
 function draftOf(p) {
-  return { id: p.id, name: p.name, preset: p.preset, chat: p.chat, responses: p.responses, anthropic: p.anthropic, gemini: p.gemini || "", catalog: p.catalog, decide: p.decide || "", key: "", api: baseAPIOf(p), chosen: pickedOf(p), none: !!p.noModels, best: !!p.bestInFamily, extra: [], headers: headerRows(p.headers), extraBody: extraBodyText(p.extraBody), replyHeaders: (p.replyHeaders || []).join(", "), passHeaders: (p.passHeaders || []).join(", "), icon: p.icon || "", iconFrom: p.iconFrom || "", fallback: [...(p.fallback || [])], unlisted: !!p.unlisted, hiddenDrawers: [...(p.hiddenDrawers || [])], hiddenVideomakers: [...(p.hiddenVideomakers || [])], searches: !!p.searches, unredacted: !!p.unredacted, countFree: !!p.countFree, billing: p.billing || "", insecureTLS: !!p.insecureTLS, http1: !!p.http1, clientCert: p.clientCert || "", clientKey: p.clientKey || "", serverCA: p.serverCA || "", serverPin: p.serverPin || "", resolve: p.resolve, socket: p.socket || "", limitRestOff: !!p.limitRestOff, noBalanceProbe: !!p.noBalanceProbe, upstreamProviders: !!p.upstreamProviders, passErrors: !!p.passErrors, imageFilesOff: !!p.imageFilesOff, nativeCompaction: !!p.nativeCompaction, passUserAgent: p.passUserAgent !== false, pinUpstream: !!p.pinUpstream, authHeader: p.authHeader || "", balanceURL: p.balanceURL || "", balancePath: p.balancePath || "", balanceMethod: p.balanceMethod || "", modelsURL: p.modelsURL || "", listOff: !!p.listOff, contexts: contextsText(p.contexts), outputs: contextsText(p.outputs), compacts: contextsText(p.compacts), keysUrl: p.keysUrl || "", ...proxyDraft(p), ...concurrencyDraft(p), rateWindows: (p.rateWindows || []).map((w) => ({ ...w })) };
+  return { id: p.id, name: p.name, preset: p.preset, chat: p.chat, responses: p.responses, anthropic: p.anthropic, gemini: p.gemini || "", geminiModelInBody: !!p.geminiModelInBody, catalog: p.catalog, decide: p.decide || "", key: "", api: baseAPIOf(p), chosen: pickedOf(p), none: !!p.noModels, best: !!p.bestInFamily, extra: [], headers: headerRows(p.headers), extraBody: extraBodyText(p.extraBody), replyHeaders: (p.replyHeaders || []).join(", "), passHeaders: (p.passHeaders || []).join(", "), icon: p.icon || "", iconFrom: p.iconFrom || "", fallback: [...(p.fallback || [])], unlisted: !!p.unlisted, hiddenDrawers: [...(p.hiddenDrawers || [])], hiddenVideomakers: [...(p.hiddenVideomakers || [])], searches: !!p.searches, unredacted: !!p.unredacted, countFree: !!p.countFree, billing: p.billing || "", insecureTLS: !!p.insecureTLS, http1: !!p.http1, clientCert: p.clientCert || "", clientKey: p.clientKey || "", serverCA: p.serverCA || "", serverPin: p.serverPin || "", resolve: p.resolve, socket: p.socket || "", limitRestOff: !!p.limitRestOff, noBalanceProbe: !!p.noBalanceProbe, upstreamProviders: !!p.upstreamProviders, passErrors: !!p.passErrors, imageFilesOff: !!p.imageFilesOff, nativeCompaction: !!p.nativeCompaction, passUserAgent: p.passUserAgent !== false, pinUpstream: !!p.pinUpstream, authHeader: p.authHeader || "", balanceURL: p.balanceURL || "", balancePath: p.balancePath || "", balanceMethod: p.balanceMethod || "", modelsURL: p.modelsURL || "", listOff: !!p.listOff, contexts: contextsText(p.contexts), outputs: contextsText(p.outputs), compacts: contextsText(p.compacts), keysUrl: p.keysUrl || "", ...proxyDraft(p), ...concurrencyDraft(p), rateWindows: (p.rateWindows || []).map((w) => ({ ...w })) };
 }
 
 // duplicateProvider opens the Add form on a copy of p, its key p's unless another is pasted (#268).
@@ -10127,18 +10128,11 @@ function drawEditor(p, presetID) {
     advIn.append(...field(t("Rests"), rtk, t("Off: a 429 or an out-of-quota refusal doesn't rest its keys, and the next request is sent to it as usual. For a relay whose limits pass in a moment.")));
   }
 
-  if (p ? p.takesPassErrors : custom) {
-    const b = el("button", "sess-pick pass-errors"), d = draft;
-    import("./passerrors.js").then(() => passErrorsFill(b, d), statusErr);
-    advIn.append(...field(t("Errors"), b));
-  }
-
-  // image-files, on DeepSeek's own API (#5407)
-  if (p?.takesImageFiles) {
-    const [itk, icb] = tick(t("Upload images once and send them by file id"), !draft.imageFilesOff);
-    itk.classList.add("image-files");
-    icb.onchange = () => { draft.imageFilesOff = !icb.checked; };
-    advIn.append(...field(t("Images"), itk, t("Off: an agent's images are sent inline on every turn.")));
+  if (custom || p?.takesPassErrors || p?.takesImageFiles) {
+    const compat = el("div"), d = draft;
+    compat.style.display = "contents";
+    advIn.append(compat);
+    import("./providercompat.js").then(() => providerCompatFill(compat, d, p, custom), statusErr);
   }
 
   let balFix = null, balSlot = null;
@@ -10511,6 +10505,7 @@ function drawEditor(p, presetID) {
     body.noBalanceProbe = !!draft.noBalanceProbe;
     if ((p?.preset || pr?.id) === "remote-magpie") body.upstreamProviders = !!draft.upstreamProviders;
     if (p?.takesImageFiles) body.imageFilesOff = !!draft.imageFilesOff;
+    if (custom) body.geminiModelInBody = !!draft.geminiModelInBody;
     if (p ? p.takesPassErrors : custom) body.passErrors = !!draft.passErrors;
     if (!decideOnly(p || pr)) body.nativeCompaction = !!draft.nativeCompaction && carriesCompaction();
     if (uaPassable()) body.passUserAgent = draft.passUserAgent !== false;
diff --git a/internal/gui/assets/i18n.js b/internal/gui/assets/i18n.js
index cb6d0ad8b..659fa93ea 100644
--- a/internal/gui/assets/i18n.js
+++ b/internal/gui/assets/i18n.js
@@ -4787,6 +4787,9 @@ const I18N = {
     "magpie handles": "由 magpie 处理",
     "Pass through": "原样转发",
     "Upload images once and send them by file id": "图片只上传一次，之后按文件 ID 发送",
+    "Gemini": "Gemini",
+    "Send model in Gemini request body": "在 Gemini 请求体中发送模型名",
+    "For Gemini relays that require a model field beside the URL. Uses the routed upstream model, including when you switch models. Leave off for Google's API.": "用于除 URL 外还要求请求体带 model 字段的 Gemini 中转。切换模型时会自动使用实际路由的上游模型名。Google 官方 API 请保持关闭。",
     "Off: an agent's images are sent inline on every turn.": "关闭后：智能体的图片每一轮都直接随请求发送。",
     "Certificate": "证书",
     "Server certificate": "服务器证书",
@@ -10243,6 +10246,9 @@ const I18N = {
     "magpie handles": "由 magpie 處理",
     "Pass through": "原樣轉發",
     "Upload images once and send them by file id": "圖片只上傳一次，之後按檔案 ID 傳送",
+    "Gemini": "Gemini",
+    "Send model in Gemini request body": "在 Gemini 請求本文中傳送模型名稱",
+    "For Gemini relays that require a model field beside the URL. Uses the routed upstream model, including when you switch models. Leave off for Google's API.": "用於除了 URL 外還要求請求本文包含 model 欄位的 Gemini 中轉。切換模型時會自動使用實際路由的上游模型名稱。Google 官方 API 請保持關閉。",
     "Off: an agent's images are sent inline on every turn.": "關閉後：代理的圖片每一輪都直接隨請求傳送。",
     "Certificate": "憑證",
     "Server certificate": "伺服器憑證",
@@ -15713,6 +15719,9 @@ const I18N = {
     "magpie handles": "magpie が処理",
     "Pass through": "そのまま渡す",
     "Upload images once and send them by file id": "画像は一度だけアップロードし、以降はファイル ID で送る",
+    "Gemini": "Gemini",
+    "Send model in Gemini request body": "Gemini のリクエスト本文にモデル名を送信",
+    "For Gemini relays that require a model field beside the URL. Uses the routed upstream model, including when you switch models. Leave off for Google's API.": "URL に加えて本文にも model フィールドを必要とする Gemini リレー向けです。モデルを切り替えると、ルーティング先のモデル名も切り替わります。Google 公式 API ではオフにしてください。",
     "Off: an agent's images are sent inline on every turn.": "オフ：エージェントの画像を毎ターンそのまま送ります。",
     "Certificate": "証明書",
     "Server certificate": "サーバー証明書",
@@ -21208,6 +21217,9 @@ const I18N = {
     "magpie handles": "magpie kümmert sich",
     "Pass through": "Durchreichen",
     "Upload images once and send them by file id": "Bilder einmal hochladen und per Datei-ID senden",
+    "Gemini": "Gemini",
+    "Send model in Gemini request body": "Modell im Gemini-Anfragetext senden",
+    "For Gemini relays that require a model field beside the URL. Uses the routed upstream model, including when you switch models. Leave off for Google's API.": "Für Gemini-Relays, die neben der URL ein model-Feld im Anfragetext benötigen. Verwendet auch nach einem Modellwechsel den tatsächlich gewählten Upstream-Modellnamen. Für Googles API ausgeschaltet lassen.",
     "Off: an agent's images are sent inline on every turn.": "Aus: Die Bilder eines Agenten werden in jeder Runde direkt mitgeschickt.",
     "Certificate": "Zertifikat",
     "Server certificate": "Server-Zertifikat",
diff --git a/internal/gui/assets/providercompat.js b/internal/gui/assets/providercompat.js
new file mode 100644
index 000000000..bfa406339
--- /dev/null
+++ b/internal/gui/assets/providercompat.js
@@ -0,0 +1,20 @@
+// Provider-specific compatibility fields are loaded with the editor.
+window.providerCompatFill = function (box, draft, provider, custom) {
+  if (provider ? provider.takesPassErrors : custom) {
+    const button = el("button", "sess-pick pass-errors");
+    import("./passerrors.js").then(() => passErrorsFill(button, draft), statusErr);
+    box.append(...field(t("Errors"), button));
+  }
+  if (provider?.takesImageFiles) {
+    const [row, checkbox] = tick(t("Upload images once and send them by file id"), !draft.imageFilesOff);
+    row.classList.add("image-files");
+    checkbox.onchange = () => { draft.imageFilesOff = !checkbox.checked; };
+    box.append(...field(t("Images"), row, t("Off: an agent's images are sent inline on every turn.")));
+  }
+  if (custom) {
+    const [row, checkbox] = tick(t("Send model in Gemini request body"), !!draft.geminiModelInBody);
+    row.classList.add("gemini-model-body");
+    checkbox.onchange = () => { draft.geminiModelInBody = checkbox.checked; };
+    box.append(...field(t("Gemini"), row, t("For Gemini relays that require a model field beside the URL. Uses the routed upstream model, including when you switch models. Leave off for Google's API.")));
+  }
+};
diff --git a/internal/gui/provider_gemini_model_body_test.go b/internal/gui/provider_gemini_model_body_test.go
new file mode 100644
index 000000000..51ddfc8ce
--- /dev/null
+++ b/internal/gui/provider_gemini_model_body_test.go
@@ -0,0 +1,50 @@
+package gui
+
+import (
+	"net/http"
+	"net/http/httptest"
+	"strings"
+	"testing"
+
+	"github.com/yetone/magpie/internal/provider"
+)
+
+func TestGeminiRelayModelBodySaved(t *testing.T) {
+	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
+	t.Setenv("XDG_CACHE_HOME", t.TempDir())
+	mux := http.NewServeMux()
+	providerRoutes(mux, nil)
+	for _, step := range []struct {
+		setting string
+		want    bool
+	}{
+		{`,"geminiModelInBody":true`, true},
+		{"", true},
+		{`,"geminiModelInBody":false`, false},
+	} {
+		w := httptest.NewRecorder()
+		body := `{"id":"relay","name":"Relay","key":"relay-key","gemini":"http://127.0.0.1:1/v1beta","models":["gemini-one"]` + step.setting + `}`
+		mux.ServeHTTP(w, httptest.NewRequest("POST", "/api/provider/save", strings.NewReader(body)))
+		if w.Code != http.StatusOK {
+			t.Fatalf("save: %d %s", w.Code, w.Body)
+		}
+		p, err := provider.Find("relay")
+		if err != nil {
+			t.Fatal(err)
+		}
+		if p.GeminiModelInBody != step.want || providerInfo(*p, nil).GeminiModelInBody != step.want {
+			t.Fatalf("setting %q: stored=%v, want %v", step.setting, p.GeminiModelInBody, step.want)
+		}
+	}
+}
+
+func TestGeminiRelayModelBodyTyped(t *testing.T) {
+	p := provider.Provider{Gemini: "https://relay.example/v1beta", GeminiModelInBody: true}
+	for _, value := range []*bool{nil, new(false), new(true)} {
+		got := typed(p, provider.Provider{}, nil, nil, nil, value)
+		want := value == nil || *value
+		if got.GeminiModelInBody != want {
+			t.Fatalf("unsaved test: body=%v, want %v", got.GeminiModelInBody, want)
+		}
+	}
+}
diff --git a/internal/gui/providers.go b/internal/gui/providers.go
index 5bc9789b0..d73601002 100644
--- a/internal/gui/providers.go
+++ b/internal/gui/providers.go
@@ -164,6 +164,9 @@ type providerJSON struct {
 	Website   string            `json:"website"`
 	KeysURL   string            `json:"keysUrl"`
 	Headers   map[string]string `json:"headers,omitempty"`
+
+	GeminiModelInBody bool `json:"geminiModelInBody,omitempty"`
+
 	// JSON fields added to each request's body (provider.ExtraBody, #1604)
 	ExtraBody provider.ExtraBody `json:"extraBody,omitempty"`
 	// headers of the vendor's reply passed on (provider.ReplyHeaders, #4145)
@@ -984,7 +987,7 @@ func providerInfoWith(p provider.Provider, ls provider.Listing, agents []agentUs
 	avail := ls.Available
 	out := providerJSON{
 		ID: p.ID, Name: p.Name, Icon: p.Icon, IconFrom: p.IconFrom, Preset: p.Preset, Host: p.Host(),
-		Chat: p.Chat, Responses: p.Responses, Anthropic: p.Anthropic, Gemini: p.Gemini, Decide: p.Decide, BaseAPI: p.BaseAPI, ModelTest: p.ModelTest(), TestsAs: p.TestClients(), TestPicks: p.TestPicks(), DecideTest: p.AsksDecideModels(), MarksKinds: p.MarksKinds(),
+		Chat: p.Chat, Responses: p.Responses, Anthropic: p.Anthropic, Gemini: p.Gemini, GeminiModelInBody: p.GeminiModelInBody, Decide: p.Decide, BaseAPI: p.BaseAPI, ModelTest: p.ModelTest(), TestsAs: p.TestClients(), TestPicks: p.TestPicks(), DecideTest: p.AsksDecideModels(), MarksKinds: p.MarksKinds(),
 		Catalog: p.Catalog, Website: p.Website, KeysURL: p.KeysURL,
 		Proxy: p.Proxy, AccountProxies: p.AccountProxies, AccountModels: p.AccountModels, AccountCaps: p.AccountCaps, AccountWindowCaps: p.AccountWindowCaps, AccountWindowAmounts: p.AccountWindowAmounts, AccountNames: p.AccountNames, Headers: p.Headers, ExtraBody: p.ExtraBody, ReplyHeaders: p.ReplyHeaders, PassHeaders: p.PassHeaders, Searches: p.Searches, Cline: p.ClinePinnable(), PinUpstream: p.PinUpstream, Unredacted: p.Unredacted, CountFree: p.CountFree, Billing: p.Billing, BillingKind: p.BillingKind(), InsecureTLS: p.InsecureTLS, TakesInsecureTLS: p.TakesInsecureTLS(), HTTP1: p.HTTP1, ClientCert: tilde(p.ClientCert), ClientKey: tilde(p.ClientKey), ServerCA: tilde(p.ServerCA), TakesClientCert: p.TakesClientCert(), ServerPin: p.ServerPin, TakesServerPin: p.TakesServerPin(), Resolve: p.Resolve, TakesResolve: p.TakesResolve(), Socket: p.Socket, TakesSocket: p.TakesSocket(), LimitRestOff: p.LimitRestOff, UpstreamProviders: p.UpstreamProviders, ImageFilesOff: p.ImageFilesOff, TakesImageFiles: p.TakesImageFiles(), NativeCompaction: p.NativeCompaction, CarriesCompaction: p.CarriesCompaction(), PassUserAgent: !p.MagpieUserAgent, OwnClient: p.OwnClient(), PassErrors: p.PassErrors, TakesPassErrors: p.TakesPassErrors(), AuthHeader: p.AuthHeader, BothAuth: p.BothAuth(), BalanceURL: p.BalanceURL, BalancePath: p.BalancePath, BalanceMethod: p.BalanceMethod, NoBalanceProbe: p.NoBalanceProbe, ModelsURL: p.ModelsURL, ListOff: p.ListsOff(), TakesListOff: p.Account == nil && !p.IsPlugin() && !p.DecideOnly(), TakesModelHeaders: p.Account == nil, DecideAPIKind: p.DecideAPIKind(),
 		Ready: p.Ready(), Chosen: p.PicksOf(avail), Agents: make([]providerAgent, 0, len(agents)),
@@ -1902,6 +1905,7 @@ func providerRoutes(mux *http.ServeMux, w Windows) {
 	mux.HandleFunc("POST /api/provider/{action}", func(rw http.ResponseWriter, r *http.Request) {
 		var req struct {
 			provider.Provider
+			GeminiModelInBody *bool `json:"geminiModelInBody"`
 			// Proxy is the proxy its requests go through (#237), "" to
 			// follow the global one; a save that leaves it out keeps it
 			Proxy *string `json:"proxy"`
@@ -2133,6 +2137,9 @@ func providerRoutes(mux *http.ServeMux, w Windows) {
 			return
 		}
 		in := req.Provider
+		if req.GeminiModelInBody != nil {
+			in.GeminiModelInBody = *req.GeminiModelInBody
+		}
 		if !provider.BillingOK(in.Billing) {
 			fail(rw, fmt.Errorf("billing is plan, payg or empty, not %q", in.Billing))
 			return
@@ -2256,6 +2263,7 @@ func providerRoutes(mux *http.ServeMux, w Windows) {
 				pr.BestInFamily = in.BestInFamily
 				pr.ListOff = in.ListOff
 				pr.ExtraBody = in.ExtraBody
+				pr.GeminiModelInBody = in.GeminiModelInBody
 				pr.ReplyHeaders = in.ReplyHeaders
 				pr.PassHeaders = in.PassHeaders
 				pr.SecretAccessKey = in.SecretAccessKey
@@ -2486,6 +2494,9 @@ func providerRoutes(mux *http.ServeMux, w Windows) {
 				} else if old != nil {
 					in.ImageFilesOff = old.ImageFilesOff
 				}
+				if req.GeminiModelInBody == nil && old != nil {
+					in.GeminiModelInBody = old.GeminiModelInBody
+				}
 				if req.PassErrors != nil {
 					in.PassErrors = *req.PassErrors
 				} else if old != nil {
@@ -3088,7 +3099,7 @@ func providerRoutes(mux *http.ServeMux, w Windows) {
 			}
 			saved := *p
 			if req.Typed {
-				q := withCerts(typed(*p, in, req.Proxy, req.InsecureTLS, req.HTTP1), p, req.ClientCert, req.ClientKey, req.ServerCA, req.ServerPin, req.Resolve)
+				q := withCerts(typed(*p, in, req.Proxy, req.InsecureTLS, req.HTTP1, req.GeminiModelInBody), p, req.ClientCert, req.ClientKey, req.ServerCA, req.ServerPin, req.Resolve)
 				p = &q
 			}
 			if len(req.Test) > 0 {
@@ -3125,7 +3136,7 @@ func providerRoutes(mux *http.ServeMux, w Windows) {
 				}
 				p = *saved
 			}
-			p = withCerts(typed(p, in, req.Proxy, req.InsecureTLS, req.HTTP1), &p, req.ClientCert, req.ClientKey, req.ServerCA, req.ServerPin, req.Resolve)
+			p = withCerts(typed(p, in, req.Proxy, req.InsecureTLS, req.HTTP1, req.GeminiModelInBody), &p, req.ClientCert, req.ClientKey, req.ServerCA, req.ServerPin, req.Resolve)
 			if strings.TrimSpace(in.Decide) != "" {
 				// a decision API is asked its smallest question, at
 				// POST …/systemone (#647)
@@ -3216,7 +3227,7 @@ func providerRoutes(mux *http.ServeMux, w Windows) {
 			if old, err := provider.Find(in.ID); err == nil && in.ID != "" {
 				p = *old
 			}
-			p = withCerts(typed(p, in, req.Proxy, req.InsecureTLS, req.HTTP1), &p, req.ClientCert, req.ClientKey, req.ServerCA, req.ServerPin, req.Resolve)
+			p = withCerts(typed(p, in, req.Proxy, req.InsecureTLS, req.HTTP1, req.GeminiModelInBody), &p, req.ClientCert, req.ClientKey, req.ServerCA, req.ServerPin, req.Resolve)
 			ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
 			defer cancel()
 			seen, err := p.PeekServerCert(ctx)
@@ -3237,7 +3248,7 @@ func providerRoutes(mux *http.ServeMux, w Windows) {
 			if p.Name == "" {
 				p.Name = cmp.Or(strings.TrimSpace(in.Name), "the vendor")
 			}
-			p = withCerts(typed(p, in, req.Proxy, req.InsecureTLS, req.HTTP1), &p, req.ClientCert, req.ClientKey, req.ServerCA, req.ServerPin, req.Resolve)
+			p = withCerts(typed(p, in, req.Proxy, req.InsecureTLS, req.HTTP1, req.GeminiModelInBody), &p, req.ClientCert, req.ClientKey, req.ServerCA, req.ServerPin, req.Resolve)
 			ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
 			defer cancel()
 			all, err := p.ListAll(ctx)
@@ -3281,7 +3292,7 @@ func providerRoutes(mux *http.ServeMux, w Windows) {
 			defer cancel()
 			ask := *p
 			if req.Typed {
-				ask = withCerts(typed(*p, in, req.Proxy, req.InsecureTLS, req.HTTP1), p, req.ClientCert, req.ClientKey, req.ServerCA, req.ServerPin, req.Resolve)
+				ask = withCerts(typed(*p, in, req.Proxy, req.InsecureTLS, req.HTTP1, req.GeminiModelInBody), p, req.ClientCert, req.ClientKey, req.ServerCA, req.ServerPin, req.Resolve)
 			}
 			ms, dropped, err := ask.Refetch(ctx)
 			if err != nil {
@@ -3886,7 +3897,7 @@ var testRuns sync.Map
 // Vertex AI provider's project, location, credentials file and service
 // account are the ones typed, spelled as a Save keeps them, unless no
 // project is.
-func typed(p, in provider.Provider, proxy *string, insecureTLS, http1 *bool) provider.Provider {
+func typed(p, in provider.Provider, proxy *string, insecureTLS, http1, geminiModelInBody *bool) provider.Provider {
 	if k := strings.TrimSpace(in.Key); k != "" && k != p.Key {
 		p.Key, p.KeyName, p.KeyProtocol, p.KeyWeight, p.KeyPlan = k, "", "", 0, ""
 	}
@@ -3918,6 +3929,9 @@ func typed(p, in provider.Provider, proxy *string, insecureTLS, http1 *bool) pro
 	if http1 != nil {
 		p.HTTP1 = *http1
 	}
+	if geminiModelInBody != nil {
+		p.GeminiModelInBody = *geminiModelInBody
+	}
 	return p
 }
 
diff --git a/internal/gui/tests/provider-gemini-model-body.test.cjs b/internal/gui/tests/provider-gemini-model-body.test.cjs
new file mode 100644
index 000000000..12080cee2
--- /dev/null
+++ b/internal/gui/tests/provider-gemini-model-body.test.cjs
@@ -0,0 +1,80 @@
+const assert = require("node:assert/strict");
+const fs = require("node:fs/promises");
+const path = require("node:path");
+const { test } = require("node:test");
+const { chromium, webkit } = require("playwright");
+
+const assets = path.resolve(__dirname, "../assets");
+const label = "Send model in Gemini request body";
+const hint = "For Gemini relays that require a model field beside the URL. Uses the routed upstream model, including when you switch models. Leave off for Google's API.";
+
+for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ["chromium", "webkit"])) {
+  for (const lang of ["en", "zh", "zh-TW", "ja", "de"]) {
+    for (const width of [1100, 420]) {
+      test(`${engine} ${lang} ${width}: Gemini body model is opt-in, saved, reopened and disabled`, async (t) => {
+        const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
+        t.after(() => browser.close());
+        const page = await (await browser.newContext({ viewport: { width, height: 800 }, reducedMotion: "reduce" })).newPage();
+        page.setDefaultTimeout(10000);
+        const posts = [], errors = [];
+        const provider = {
+          id: "relay", name: "Gem Relay", icon: "generic", gemini: "https://relay.example/v1beta", baseAPI: "gemini",
+          models: [{ id: "gemini-one", name: "Gemini One", on: true }], agents: [], headers: {}, fallback: [],
+          key: { set: true, masked: "key" }, keyList: [], balanceToken: { takes: false, set: false },
+        };
+        const providers = { providers: [provider], presets: [], excluded: [], gateway: { running: true, window: true } };
+        page.on("pageerror", (error) => errors.push(error.message));
+        await page.route("**/*", async (route) => {
+          const url = new URL(route.request().url());
+          if (url.pathname === "/boot.js") return route.fulfill({ contentType: "text/javascript", body: `window.bootPrefs={lang:${JSON.stringify(lang)},theme:"light",web:true};` });
+          if (url.pathname === "/wails/runtime.js") return route.fulfill({ contentType: "text/javascript", body: "export const Window={};" });
+          if (url.pathname === "/api/state") return route.fulfill({ json: { agents: [], profiles: [], settings: { lang, theme: "light" } } });
+          if (url.pathname === "/api/providers") return route.fulfill({ json: providers });
+          if (url.pathname === "/api/groups") return route.fulfill({ json: { groups: [] } });
+          if (url.pathname === "/api/provider/save") {
+            const body = route.request().postDataJSON();
+            posts.push(body);
+            provider.geminiModelInBody = body.geminiModelInBody;
+            return route.fulfill({ json: providers });
+          }
+          if (url.pathname.startsWith("/api/")) return route.fulfill({ json: {} });
+          const file = path.join(assets, url.pathname === "/" ? "index.html" : url.pathname);
+          try {
+            return route.fulfill({ body: await fs.readFile(file), contentType: { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" }[path.extname(file)] });
+          } catch {
+            return route.fulfill({ status: 404, body: "" });
+          }
+        });
+        await page.goto("http://magpie.test/?view=providers");
+        const words = await page.evaluate(([lang, keys]) => Object.fromEntries(keys.map((key) => [key, (I18N[lang] || {})[key] || key])), [lang, [label, hint, "Save"]]);
+        const open = async () => {
+          await page.locator(".row.provider", { hasText: "Gem Relay" }).click();
+          await page.locator(".editor .bar").waitFor();
+        };
+        await open();
+        const advanced = page.locator(".editor details.advanced");
+        if (!(await advanced.evaluate((element) => element.open))) await advanced.locator(":scope > summary").click();
+        const row = page.locator(".editor .gemini-model-body");
+        const checkbox = row.locator("input[type=checkbox]");
+        await row.waitFor();
+        assert.equal(await checkbox.isChecked(), false);
+        assert.ok((await row.textContent()).includes(words[label]));
+        assert.ok((await advanced.textContent()).includes(words[hint]));
+        if (lang !== "en") assert.notEqual(words[label], label);
+        await checkbox.check();
+        await page.locator(".editor .bar").getByRole("button", { name: words.Save, exact: true }).click();
+        await page.waitForFunction(() => !document.querySelector(".editor"));
+        assert.equal(posts.at(-1).geminiModelInBody, true);
+        await open();
+        assert.equal(await advanced.evaluate((element) => element.open), true);
+        await checkbox.waitFor();
+        assert.equal(await checkbox.isChecked(), true);
+        await checkbox.uncheck();
+        await page.locator(".editor .bar").getByRole("button", { name: words.Save, exact: true }).click();
+        await page.waitForFunction(() => !document.querySelector(".editor"));
+        assert.equal(posts.at(-1).geminiModelInBody, false);
+        assert.deepEqual(errors, []);
+      });
+    }
+  }
+}
diff --git a/internal/provider/gemini_api.go b/internal/provider/gemini_api.go
index 7df7ebefd..667bade11 100644
--- a/internal/provider/gemini_api.go
+++ b/internal/provider/gemini_api.go
@@ -109,6 +109,12 @@ func GeminiPath(model string, stream bool) string {
 	return "/models/" + m + ":generateContent"
 }
 
+// SendsGeminiModel keeps the routed upstream model in a Gemini relay's
+// request body. Vertex and signed-in accounts keep their own wire shape.
+func (p Provider) SendsGeminiModel() bool {
+	return p.GeminiModelInBody && p.Gemini != "" && p.Account == nil && !p.IsVertex()
+}
+
 // AIStudioChat is Google AI Studio's OpenAI-compatible base, the Google
 // Gemini preset's Chat URL.
 const AIStudioChat = "https://generativelanguage.googleapis.com/v1beta/openai"
diff --git a/internal/provider/gemini_model_body_test.go b/internal/provider/gemini_model_body_test.go
new file mode 100644
index 000000000..995611ae1
--- /dev/null
+++ b/internal/provider/gemini_model_body_test.go
@@ -0,0 +1,60 @@
+package provider
+
+import (
+	"context"
+	"encoding/json"
+	"net/http"
+	"net/http/httptest"
+	"strings"
+	"testing"
+)
+
+func TestGeminiRelayModelBodyProbe(t *testing.T) {
+	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
+	t.Setenv("XDG_CACHE_HOME", t.TempDir())
+	seen := make(chan string, 2)
+	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+		var body struct{ Model string }
+		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
+			http.Error(w, err.Error(), http.StatusBadRequest)
+			return
+		}
+		want := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/v1beta/models/"), ":generateContent")
+		if body.Model != want {
+			http.Error(w, `{"error":{"message":"Model is unsupported and no wildcard routing rule is configured"}}`, http.StatusBadRequest)
+			return
+		}
+		seen <- body.Model
+		w.Header().Set("Content-Type", "application/json")
+		w.Write([]byte(`{"candidates":[{"content":{"role":"model","parts":[{"text":"OK"}]},"finishReason":"STOP"}]}`))
+	}))
+	t.Cleanup(up.Close)
+	p := Provider{ID: "relay", Name: "Relay", Key: "relay-key", Gemini: up.URL + "/v1beta", GeminiModelInBody: true, Models: []string{"gemini-one", "gemini-two"}}
+	if err := Save(p); err != nil {
+		t.Fatal(err)
+	}
+	if err := SetUpstreamName("relay/gemini-two", "vendor/gemini-two"); err != nil {
+		t.Fatal(err)
+	}
+	for _, result := range p.TestModels(context.Background(), p.Models) {
+		if !result.OK {
+			t.Fatalf("%s: status %d: %s", result.Model, result.Status, result.Error)
+		}
+	}
+	if len(seen) != 2 {
+		t.Fatalf("%d probes reached the relay, want two", len(seen))
+	}
+}
+
+func TestGeminiRelayModelBodyStaysOutOfOtherWires(t *testing.T) {
+	for _, p := range []Provider{
+		{Gemini: "https://generativelanguage.googleapis.com/v1beta"},
+		{GeminiModelInBody: true, Responses: "https://relay.example/v1"},
+		{GeminiModelInBody: true, Gemini: "https://relay.example/v1beta", Account: &Account{Agent: "gemini"}},
+		{Preset: VertexPreset, GeminiModelInBody: true, Gemini: "https://relay.example/v1beta", Vertex: &Vertex{Project: "project"}},
+	} {
+		if p.SendsGeminiModel() {
+			t.Fatalf("an unrelated wire sends the Gemini model: %+v", p)
+		}
+	}
+}
diff --git a/internal/provider/provider.go b/internal/provider/provider.go
index 475e67532..6a10a20e2 100644
--- a/internal/provider/provider.go
+++ b/internal/provider/provider.go
@@ -102,6 +102,9 @@ type Provider struct {
 	// under it, with the key in x-goog-api-key, and models under it lists
 	// them (#1346).
 	Gemini string `json:"gemini,omitempty"`
+	// GeminiModelInBody is for relays that also route by the model in the
+	// generateContent body. The default names the model in the URL alone.
+	GeminiModelInBody bool `json:"geminiModelInBody,omitempty"`
 	// GeminiFilled is that magpie filled Gemini in once, for a provider
 	// at AI Studio's OpenAI-compatible URL (aiStudioNative): a Gemini URL
 	// the user cleared after that stays empty.
diff --git a/internal/provider/test.go b/internal/provider/test.go
index a25b4bd3d..31ad582d6 100644
--- a/internal/provider/test.go
+++ b/internal/provider/test.go
@@ -264,7 +264,11 @@ func tinyBody(q Provider, proto Protocol, model string) (url, body string) {
 			// Factory's generate route. droid sends no stream field.
 			return q.Base(Gemini) + "/generate", fmt.Sprintf(`{"model":%q,"contents":[{"role":"user","parts":[{"text":"hi"}]}]}`, model)
 		}
-		return q.Base(Gemini) + GeminiPath(model, false), `{"contents":[{"role":"user","parts":[{"text":"hi"}]}],"generationConfig":{"maxOutputTokens":16}}`
+		body := `{"contents":[{"role":"user","parts":[{"text":"hi"}]}],"generationConfig":{"maxOutputTokens":16}}`
+		if q.SendsGeminiModel() {
+			body = fmt.Sprintf(`{"model":%q,%s`, model, body[1:])
+		}
+		return q.Base(Gemini) + GeminiPath(model, false), body
 	}
 	return "", ""
 }
-- 
2.50.1 (Apple Git-155)

```

</details>
