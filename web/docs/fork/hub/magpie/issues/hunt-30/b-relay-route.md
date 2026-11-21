# gateway: Codex 转发被拒钥或空体失败时，Routing 页「Request and response」说请求已不在，而它的调用就在最近 40 条里

## 现象

af601541 给 Routing 页每个请求的 story 头部加了「Request and response」按钮：按下去用 `GET /api/gateway/call?route=<Route.ID>` 找到这次请求的调用记录，展示发出去和收回来的内容。提交说明写的是「set where serve, the Codex backend and a refused title record it」。

Codex 后端转发（`codexUpstreamOn`）一共有三个记录调用的出口，但只有成功出口接了 `call.Route = tr.ID`；两个失败出口记录的 Call 没带 Route：

- OpenAI 拒掉 API key（401，常见于中转签发的 key 留在 `~/.codex/auth.json`）；
- 上游 ≥400 且响应体为空（Codex 只显示 "Unknown error"）。

这两种请求在 Routing 页有正常的行（trace 打开了、`end()` 也把 try 标成完成），按「Request and response」却得到 404，页面提示「最近 40 条会保留到 magpie 退出、可以开请求存档」——两处都不对：这次调用此刻就在最近 40 条里（Gateway 页按 id 打得开）；而且 Codex 后端转发路径从不写存档（`wire` 只在 serveAgent 设置），开了存档也永远不会存到它。

## 最小复现

假上游回 401，向 `/backend-api/codex/responses` 发一次带 `Authorization: Bearer sk-…` 的请求（`codexAPIBase` 指向假上游）；断言 `RouteCall(route.ID)` 找得到调用：

```
--- FAIL: TestCodexKeyRefusedCarriesItsRoute (0.54s)
    codex_backend_test.go:214: route 1792121738812: no call in the ring, so Request and response says the request is gone though its call is one of the last 40
--- FAIL: TestCodexEmptyFailureCarriesItsRoute (0.00s)
    codex_backend_test.go:242: route 1792121738817: no call in the ring, so Request and response says the request is gone though its call is one of the last 40
```

红在当前 tip 7597c132 上复现。

## 根因

`internal/gateway/codex_backend.go`，`codexUpstreamOn`。tr 在 `rest == "/responses"` 时打开（约 745 行），三个 `s.record` 出口：

- 成功出口（约 986 行）：`call.Route = tr.ID` —— af601541 已接；
- 401 拒钥出口（约 903 行）：`s.record(Call{...})` 字面量没有 Route；
- 空体失败出口（约 917 行）：同上。

## 修法

两个失败出口照成功出口补 `Route`。401 出口对 `/responses/compact` 转发也会到达，而 compact 不开路由（tr 为 nil），所以要判空：`tr != nil` 时才设。成功出口无需判空，因为它只在 `sniff != nil`（即 `rest == "/responses"`）时到达。

## 验证

| 检查 | 结果 |
| --- | --- |
| 两个新测试在 7597c132（修前） | 双红，失败即上面输出 |
| 修复后同两测试 | 绿 |
| 消融（只 stash `codex_backend.go`，测试保留） | 回红，失败形状与修前一致 |
| `TestCodex*`（-tags nogui -p 2） | 21.7s ok |
| `TestRoutingRequestOpensItsBodies` / `TestArchiveWholeBodies`（gateway + gui） | ok |
| `gofmt -l internal/gateway/` | 干净 |
| `go vet` darwin / linux(nogui) / windows | 干净 |
| `go build` darwin / linux(nogui) / windows | ok（darwin 的 cgo `-Wenum-conversion` 警告与 ld duplicate 警告为本机已知环境噪音） |

补丁与分支：[ggbdpq/magpie 分支 `hunt30-gw-relay-route`](https://github.com/ggbdpq/magpie/tree/hunt30-gw-relay-route)（基于 7597c132，提交 f4958d93）。

<details>
<summary>patch（f4958d93，含两个新测试）</summary>

```patch
From f4958d931469a716e66959e76044b2d3da354b2e Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Fri, 16 Oct 2026 11:39:25 +0800
Subject: [PATCH] gateway: a refused or empty-failed Codex relay's call carries
 its route

What changed: af601541 wired Call.Route where serve, the Codex backend and
a refused title record a call, but of the Codex relay's three record exits
only the success one got it. The key OpenAI refuses (401) and the failure
said in nothing (>=400, empty body) recorded their calls bare, so the
Routing page's "Request and response" on such a turn said the request was
gone though its call was one of the last 40 - and the archive the note
offers can never have a Codex relay's bodies. The 401 exit is reached for
a compact relay too, where no route opens, so it takes the route only
when there is one.

Run: TestCodexKeyRefusedCarriesItsRoute and TestCodexEmptyFailureCarriesItsRoute
(new) red on 7597c132 before the fix ("route ...: no call in the ring"),
green after; red again with only codex_backend.go stashed. TestCodex*
21.7s ok. TestRoutingRequestOpensItsBodies, TestArchiveWholeBodies ok.
gofmt -l clean; vet on darwin, linux (nogui) and windows clean; build ok
on all three.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/codex_backend.go      | 10 ++--
 internal/gateway/codex_backend_test.go | 64 ++++++++++++++++++++++++++
 2 files changed, 71 insertions(+), 3 deletions(-)

diff --git a/internal/gateway/codex_backend.go b/internal/gateway/codex_backend.go
index 6e06c1e8..ea6d9113 100644
--- a/internal/gateway/codex_backend.go
+++ b/internal/gateway/codex_backend.go
@@ -900,9 +900,13 @@ func (s *Server) codexUpstreamOn(w http.ResponseWriter, r *http.Request, rest st
 		// models was picked, which goes out with Codex's own sign-in
 		msg, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
 		writeError(w, provider.Responses, res.StatusCode, codexKeyRefused(msg))
-		s.record(Call{Time: start, From: provider.Responses, To: provider.Responses, Model: modelOf(body),
+		refused := Call{Time: start, From: provider.Responses, To: provider.Responses, Model: modelOf(body),
 			Provider: "openai", Agent: agentOf(r), Status: res.StatusCode,
-			Millis: time.Since(start).Milliseconds(), Error: res.Status})
+			Millis: time.Since(start).Milliseconds(), Error: res.Status}
+		if tr != nil {
+			refused.Route = tr.ID
+		}
+		s.record(refused)
 		end(res.StatusCode, res.Status, 0, 0)
 		return
 	}
@@ -914,7 +918,7 @@ func (s *Server) codexUpstreamOn(w http.ResponseWriter, r *http.Request, rest st
 			// "Unknown error" alone (#409): said where the turn went
 			said := codexFailedEmpty(modelOf(body), res.Status)
 			writeError(w, provider.Responses, res.StatusCode, said)
-			s.record(Call{Time: start, From: provider.Responses, To: provider.Responses, Model: modelOf(body),
+			s.record(Call{Route: tr.ID, Time: start, From: provider.Responses, To: provider.Responses, Model: modelOf(body),
 				Provider: "openai", Agent: agentOf(r), Kind: callKind(r.Header), Status: res.StatusCode,
 				Millis: time.Since(start).Milliseconds(), Error: said})
 			end(res.StatusCode, said, 0, 0)
diff --git a/internal/gateway/codex_backend_test.go b/internal/gateway/codex_backend_test.go
index 781a0d17..454e67d1 100644
--- a/internal/gateway/codex_backend_test.go
+++ b/internal/gateway/codex_backend_test.go
@@ -182,6 +182,70 @@ func TestCodexAPIKeyRecordedAsOpenAI(t *testing.T) {
 	}
 }
 
+// A Codex relay OpenAI refuses (an API key it turns away) is still the
+// request its Routing row is: the call it records carries the route, so
+// the Routing page's "Request and response" opens it while the recent
+// calls have it, instead of saying it is gone.
+func TestCodexKeyRefusedCarriesItsRoute(t *testing.T) {
+	setup(t, provider.Chat, &fake{t: t})
+	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+		w.Header().Set("Content-Type", "application/json")
+		w.WriteHeader(http.StatusUnauthorized)
+		io.WriteString(w, `{"error":{"message":"invalid_api_key"}}`)
+	}))
+	t.Cleanup(up.Close)
+	was := codexAPIBase
+	codexAPIBase = up.URL + "/v1"
+	t.Cleanup(func() { codexAPIBase = was })
+	s := New()
+	rec := httptest.NewRecorder()
+	req := httptest.NewRequest("POST", CodexPath+"/responses", strings.NewReader(`{"model":"gpt-5.5","stream":true,"input":"hi"}`))
+	req.Header.Set("Authorization", "Bearer sk-synthetic")
+	s.Handler().ServeHTTP(rec, req)
+	if rec.Code != http.StatusUnauthorized {
+		t.Fatalf("%d %s", rec.Code, rec.Body.String())
+	}
+	st := s.Trace(t.Context(), 0, 0)
+	if len(st.Routes) != 1 {
+		t.Fatalf("routing view has %d routes, want the turn", len(st.Routes))
+	}
+	c, ok := s.RouteCall(st.Routes[0].ID)
+	if !ok {
+		t.Fatalf("route %d: no call in the ring, so Request and response says the request is gone though its call is one of the last 40", st.Routes[0].ID)
+	}
+	if c.Status != http.StatusUnauthorized {
+		t.Errorf("route %d is the call %d (%d), not the refusal", st.Routes[0].ID, c.ID, c.Status)
+	}
+}
+
+// A Codex relay the backend fails with nothing said (Codex shows it as
+// "Unknown error" alone) is the request its Routing row is too: its call
+// carries the route the same way.
+func TestCodexEmptyFailureCarriesItsRoute(t *testing.T) {
+	chatgpt(t, func(w http.ResponseWriter, r *http.Request) {
+		w.WriteHeader(http.StatusInternalServerError)
+	})
+	s := New()
+	rec := httptest.NewRecorder()
+	req := httptest.NewRequest("POST", CodexPath+"/responses", strings.NewReader(`{"model":"gpt-5.5","stream":true,"input":"hi"}`))
+	req.Header.Set("Authorization", "Bearer chatgpt-token")
+	s.Handler().ServeHTTP(rec, req)
+	if rec.Code != http.StatusInternalServerError {
+		t.Fatalf("%d %s", rec.Code, rec.Body.String())
+	}
+	st := s.Trace(t.Context(), 0, 0)
+	if len(st.Routes) != 1 {
+		t.Fatalf("routing view has %d routes, want the turn", len(st.Routes))
+	}
+	c, ok := s.RouteCall(st.Routes[0].ID)
+	if !ok {
+		t.Fatalf("route %d: no call in the ring, so Request and response says the request is gone though its call is one of the last 40", st.Routes[0].ID)
+	}
+	if c.Status != http.StatusInternalServerError {
+		t.Errorf("route %d is the call %d (%d), not the failure", st.Routes[0].ID, c.ID, c.Status)
+	}
+}
+
 // A compaction signed by another account is that account's, not the
 // sign-in the request would have relayed on. A request naming another
 // ChatGPT account than the sign-in magpie reads (a Codex in WSL, or
-- 
2.50.1 (Apple Git-155)
```

</details>

## 没跑什么

- 没跑全量套件（internal/gateway 全量本机约 40 分钟）；跑了改动面的定向族（上面表格）。
- 没在真实 ChatGPT/OpenAI 后端上验证（假上游回 401/500 空体，形状按代码注释与 #409 的描述构造）。
- GUI 侧（routing-bodies.test.cjs）没跑：修复只在 gateway 侧补字段，GUI 行为不变。
- 没验证 compact 转发的 401（`tr == nil` 分支无测试覆盖，改动是保持其 Route 为 0，与 `RouteCall` 的 `route != 0` 守卫一致）。

合入请保留原作者或加 `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`。

Generated-by: GLM-5.3-Flash (ZCode)
