# #2622 tools 归一化 — 已被上游自修取代(B 路 hunt35 撤单留档)

## 状态:SUPERSEDED,不再跟进
- 维护者 yetone 于 2026-10-16 20:07:52Z 发修复 **72d6103e2**(`gateway: a Chat tool in MCP's or another API's shape goes upstream as a Chat function tool (#2622)`),在我 claim(20:06:25Z,评论 6223725397)一分钟后。issue 留开等报告者下一版复测,**别的 hunter 不要再接**。
- 上游修法:`shapeChatTools`,handle 与 parseChat 两个咽喉点,`parameters` 取 `parameters`/`inputSchema`/`input_schema`,覆盖 Anthropic 形状与翻译路径(parseChat 读不到名字会给 Messages/Responses 上游发空名工具——我本地实现没盖到这个面,上游更全)。

## 本地已做(全在工作树 magpie-pr2,已还原,无 commit/push)
- 根因定位:attempt 的 `from==provider.Chat` 出口(chatCallIDs 旁)缺 tools 形状归一化;错误面核实 400 非流式路径 APIError 如实透传上游原文(报告者自己一楼复现已证明),流内失败 `call.Error = p.Name+": "+hw.failMsg` 同样原样。
- TDD:chat_tools_test.go 三测试红(编译失败)→ chat_tools.go(toolAsFunction/chatTools,复用 editMessages/marshalPlain 风格)→ 绿 → 消融(摘 attempt 接线)端到端红 → 恢复绿。gofmt 清、vet nogui 三平台清、gateway 包 linux/windows 构建清、darwin 根包构建 ok。
- gateway 全量套件跑到一半因撤单中止,未计入。

## 关键定性(来自维护者评论,与代码核实一致)
- `inference request is invalid … reason=unknown retryable=false` **不是 magpie 输出**(代码无此字符串),是客户端包装上游错误的文案;透传面无 bug,不改。
