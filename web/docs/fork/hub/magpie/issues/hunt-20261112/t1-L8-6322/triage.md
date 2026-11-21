# t1-L8-6322 triage（2026-11-12，车道 L8）

单号 #6322「刚升级，多个会话，使用同一模型的时候，会让前一个的会话中断」（kxw999，0.1.3890，Windows GUI，0 评论，截图 6322-screenshot.png）。
take 帖：6827700312。处置：**判定帖，零 patch**（无 RED 可立——被断言的 magpie 行为在代码中不存在）。

## 事实（代码级，tip a5e5f539a 逐条核验）

1. 499 = `usage.StatusCanceled`（ledger.go:61），nginx 语义"客户端关了请求"。账册把一笔记为「已取消」仅当 error 恰为 `the agent canceled the request`（`CanceledBy` ledger.go:68，注释原文"a person stopped the reply, **or sent the next message while it was coming and the agent asked again**"）。magpie 自己的等待上限 499 措辞为 "magpie stopped waiting: …"（side_deadline.go:71），分类上保持 failure，二者被 `TestContextLeavesCanceledOutOfErrors`（context_canceled_test.go:15）钉开。→ 截图中所有「499 · 已取消」行 = 客户端先断开。
2. 网关 server 无活动请求写/读超时（gateway.go:871：ReadHeaderTimeout 30s + IdleTimeout 5m 仅）——magpie 不会掐在途回复。与 #2641 中 yetone 的定性一致。
3. 无「新请求驱逐/取消旧请求」路径（全查）：
   - `lanes.take`（concurrency.go:147）严格 FIFO；等待者只因自身 ctx 结束/队列界/等待界/被 move 走；在飞请求从不被撤销。
   - cap_near.go：接近用量上限一账号一 turn，后者**等待**不驱逐。
   - key_slots.go：key 上限同型排队，"its agent gone while it waits, it leaves the queue"。
   - 全仓 CancelFunc 存储仅各自请求作用域（codex socket keep / vision wait / side deadline / relay abort），无按模型/账号/会话键的可被新请求触发的 cancel。
4. GUI 保存路径只在用户显式给值时写 MaxConcurrency（gui/providers.go:2084 `in.MaxConcurrency = cc`），升级迁移不写默认。gateway key 上限是新特性（e215d335a，11-08，v0.1.3317 起），仅设置后生效。
5. 报告者模型 glm-5.3-flash——Start-Plan 形态的 GLM 条目是插件 provider（zcode_trial.go:34 PluginProvider()=="zcode"），插件可在 manifest 声明 maxConcurrency（host.js:2395：auth hook 的 maxConcurrency，否则 package.json 的 magpie.maxConcurrency）；插件仓库公开面查不到 zcode 清单，无法本地定值 → 转向报告者要。

## 推断（帖中已标 hypothesis）

- 多会话共模型下客户端 abort 增多的候选链：①provider/key 有并发上限 → 后到请求排队无首字节 → 客户端看门狗（#4433 报 ~60s）掐断 → 499 已取消（路由 trace 的 Queued/"slot" 相位可直接判别）；②并发摊慢首 token → 同一看门狗在 vendor 在飞时触发；③客户端自身策略（睡眠/自身排队/发下条取消上条——ledger 注释即承认后者）。
- 截图 200/499 交替 = 两会话共一条 lane/一个 plan 的日志形态，与「谁在等待谁被掐」一致。

## 未验证

- 报告者客户端身份/超时配置/客户端侧报错原文；provider/key 是否带并发上限；被取消行的路由 trace；升级自哪个版本、499 是否与升级同起；真实两会话复现（本机无 Windows/无 GLM 账号）。

## 同族索引

#2641（同语义判例：499=客户端断开，yetone 定性+计划有界避让）/ #4433（60s 首包看门狗；499 后不换腿 affinity 钉住）/ #3791（feature：客户端取消的有界冷却）/ #2902（取消计数的展示面）。#5252（本会话邻单）原帖 499 两笔同为 agent 取消，其 Not verified 亦点名 499 与 backoff 阶梯的关系。

## 七问核对

Q1 真实报告 ✓；Q2 现场记录=截图，但被断言的 magpie 行为被机制否定，客户端报错缺 → 不硬 patch ✓；Q3 无断言级 RED（行为不存在，测试在 main 上即绿）✓；Q4 收益=定性+索证 ✓；Q5 不踩维护者声明路线（#2641 "这个我们会做"）✓；Q6 机制面已全查 ✓；Q7 可三句话讲清 ✓。
