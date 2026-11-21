# WP6 · 路由组、健康簿与改道管线

- **目标**：落地 ADR-0006：`group/<id>` 别名、ordered / smart 选路、首字节前改道、健康簿歇息、路由事件。
- **依赖**：WP0、WP5（WP1–WP3 合并后更好测，但非硬依赖）
- **分支**：`feat/wp6-routing-pipeline`
- **归属文件**：`apps/gateway/src/routing/{routeGroups,health,pipeline,routeEvents,capabilityView}.ts`、`src/server/server.ts` 中把 `provider.stream` 替换为 `routeStream` 的那一处、`test/routing/**`
- **起点**：`附录/代码骨架/src/{routeGroups,health,pipeline,routeEvents}.ts` + `test/pipeline.test.ts`（17 个用例已绿）

## 步骤

1. 移植四个骨架文件，`Capabilities` 布尔视图改为由 `capabilityView()` 从三态能力计算（02 §1）。
2. `resolveTarget` 保留 v0.1 语义（02 §4 的四步顺序），`QODER_MODEL_ROUTES` / `QODER_MODEL_MAP` 测试全部保持绿。
3. 组级 `maxAttempts`（默认 3，1–5）。
4. `server.ts` 只把直接调用 provider 的那一处换成 `routeStream(request, ctx, deps)`；`deps` 是不可变快照（WP7 会替换引用）。
5. 默认中间件：`stripUnsupported`——目标成员不支持 thinking 时去掉 thinking 参数；改道到不同 `kind` 时剥离对方不认识的 `signature` / `cache_control`（05 R2）。
6. 会话亲和：`conversationId`（来自 `x-qpa-conversation` 头、Anthropic `metadata.user_id` 或首条 user 消息哈希）→ 上次成功成员，TTL 30 分钟。
7. 写 `assertSequence(events)` 测试工具，断言 02 §2.2 的 6 条约束；所有管线测试都调用它。

## 验收

- 骨架 17 个管线用例 + 5 个 e2e 用例移植后全绿。
- 不变量 I1–I6（04 §2）各有专门用例。
- 新增：直连 + 429 → 下游 429 无 reroute；改道到不同 kind 时 signature 被剥离；`capabilityView` 对三态值的转换。
- 原有路由测试全绿。

## 不要做

- 不做同成员重试；不做 commit 后改道；不做账号池（ADR-0006）。
- 不做 admin API（WP7）；事件只进 `RouteEventBus`。

## Cursor 提示词

```text
你在 qoder-proxy-api 做 WP6：路由组 + 健康簿 + 改道管线。只改 apps/gateway/src/routing/{routeGroups,health,pipeline,routeEvents,capabilityView}.ts、apps/gateway/src/server/server.ts 中调用 provider.stream 的那一处，以及 apps/gateway/test/routing/**。

先读文档包 ADR草案/ADR-0006、02-接口契约.md §2/§4/§5、04-测试与验收.md §2。
起点是 附录/代码骨架/src/{routeGroups,health,pipeline,routeEvents}.ts 和 test/pipeline.test.ts（17 个用例已绿）。移植进来，适配真实类型：
- plan() 需要的布尔能力由 capabilityView() 从三态能力（tools/vision/thinking 的 none 与否）计算并缓存；
- resolveTarget 顺序：group/<id> → QODER_MODEL_ROUTES/directRoutes → <providerId>/<model> → 默认 provider；原有路由测试必须保持绿；
- 组级 maxAttempts 默认 3。
在 server.ts 里只把直接调用 provider 的地方换成 routeStream，deps 作为不可变快照传入。
加默认中间件 stripUnsupported：目标不支持 thinking 时去掉 thinking 参数；改道到不同 kind 的成员时剥离 signature 和 cache_control。
加会话亲和（x-qpa-conversation 头或首条 user 消息哈希，TTL 30 分钟）。
写 assertSequence(events) 断言：request.start 开头、恰好一条 request.end 在最后、firstByte 之后无 attempt/reroute、reroute 紧跟 reroutable 的 failed、direct 无 reroute、reroutes 计数一致。所有管线测试调用它。

约束：只在首个内容事件前改道；只在组内改道；不做同成员重试；事件里不放 prompt 和 Key；不加运行时依赖。
```
