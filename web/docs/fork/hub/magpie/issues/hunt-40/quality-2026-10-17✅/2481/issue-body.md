# Codex relay 的两处失败出口缺 Call.Route，Routing 无法找到仍在 recent ring 的调用

> 本地待发布稿；核验基线：`6f950653fcdb46c73044a071328cdc508f12ccef`（2026-10-17，澳门时间）。本轮未更新 GitHub。

## 来源、影响与根因

来源是代码审计和本地 `httptest` 合成上游，不是一次已采集的真实 OpenAI/ChatGPT 失败会话。`codexUpstreamOn` 只为 `/responses` 创建 Routing route；成功/非空失败共用的末尾出口已绑定 `Call.Route`，但 API key 被拒的 401 出口、`/responses` 上游空体且状态 >= 400 的出口未绑定。

因此调用仍在最近 40 条 ring 中时，`Trace` 有该 route，`RouteCall(routeID)` 却返回未找到，Routing 的请求详情接口缺少该调用。这里证明的是调用关联缺失，不宣称修复新增了 Codex relay 的完整原始请求/响应归档，也不把界面提示推断为数据已被删除。

## 最小修复与相邻边界

仅在两个已有 `record` 出口补同一次请求的 route：

- API key 401 出口也用于 `/responses/compact`；仅当 `tr != nil` 才赋值，compact 没有 route，保持 `Route == 0`。
- 空失败出口受 `rest == "/responses"` 约束，已有 route 可直接使用。
- 不更改状态码、错误消息、重试、计费、路由选择或历史数据；不新增原生 compact trace。
- 同步 `docs/subsystems/gateway-routing.md`，说明这条关联及 compact 无 route 的兼容边界。

补丁：`updated.patch`，是相对固定 main 的真实 unified diff，不是伪造的 commit 或已发布分支。

## 本轮验证

测试接缝经用户确认：HTTP 请求 → `Server.Handler` → `Trace` / `RouteCall`，不调用失败出口的私有方法来直接填入预期。

- `TestCodexKeyRefusedCarriesItsRoute`：固定 main 运行实际 FAIL，`no call in the ring`；只修 401 出口后 PASS。
- `TestCodexEmptyFailureCarriesItsRoute`：第二出口未修时实际 FAIL，同样找不到 call；补第二出口后两条 PASS。
- `TestCodexCompactFailureKeepsTheTurnRoute`：先完成普通 turn，再请求原生 compact 的 API 401、API 空 500、ChatGPT 空 500、ChatGPT 非空 403。检查 compact 不新建 route、不替换此前 turn 对应 call、不改变此前成功状态；非 401 仍保持上游原体。**这是保护性测试：旧 main 已通过，不当作修前 RED。**
- 全产品消融、nil guard 人为破坏、修复恢复、定向 `-race` 与已有 Codex/trace/archive 回归的实际命令、输入、输出和退出码见 `verification.json` / `logs/`，以日志为准。

## 未验证与发布边界

本轮没有真实 OpenAI/ChatGPT key、真实 Codex 会话或浏览器 GUI 交互验收。`Server.Handler` 接口测试不是 Chromium/WebKit 或 Playwright 验证；未改 GUI assets。原帖所述 GUI Go 接口测试不应写成“浏览器 GUI 已验证”。本地测试不代表维护者采纳、远端 CI 或发布验收。四份补丁叠跑的 `go test -tags nogui ./...` 退出码 1，见 [组合结果](../integration/RESULT.md)：`internal/gateway` 通过，`internal/gui` 有一条失败。

AI 协作：OpenAI Codex 参与本轮测试与待发布稿完善；补丁和输出供提交者逐项审阅。
