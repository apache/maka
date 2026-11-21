# #5537 兄弟面 rg 全查

模式：`claudeModel\(|ClaudeModel\(|ClaudeGroup\(`（非测试代码，修复后行号）。

## 已修（本单修复面：compact 写入，共享根因）

| 位置 | 判定 | 处置 |
| --- | --- | --- |
| internal/agent/claude.go:950 writeCompact | env 默认窗口跳过 | `claudeModel` → `claudeOfficial` |
| internal/agent/claude.go:1244 desktopPlan.work | per-model compact 值 -1 | 同上 |
| internal/agent/claude.go:1284 desktopPlan refs 循环 | per-model 条目跳过 | 同上 |
| internal/agent/claude.go:1292 desktopPlan def 守卫 | top-level 默认跳过 | 同上 |

## 不改（逐个对比理由）

| 位置 | 用途 | 不改理由 |
| --- | --- | --- |
| claude.go:1328/1337 pickerApart | MAX_CONTEXT_TOKENS（窗口告知）门控 | 报告者证据显示 MAX_CONTEXT_TOKENS 写出正常（1048576）；失效面只在压缩窗口 |
| claude.go:2768 claudeLongMain | [1m] main 走 desktopPlan 长窗路径的门 | 同属窗口告知面，非压缩；中转 claude [1m] 的窗口告知现状未被报告证据牵连 |
| claude.go:2828/2837 claudeOutput | 输出 token 上限告知 | 不同设置面（max output tokens），不在单况 |
| gateway/desktop.go:142,167,749,763,791、desktop_list.go:241 | 不同函数（Entry→名字，Desktop 列表） | listing 面，与 settings.json 压缩写入无共享根因 |
| provider/provider.go:2050 MessagesFirst | 路由 API 选择（Chat vs Messages，#997） | 中转 claude 走 Messages 是正确路由行为，与压缩无关 |
| provider/compact.go:107,117 ClaudeGroup | 全 claude 组判定 | 本单限定不动（组保持现状，已在帖 Not verified 中声明为已知限定） |

## 失败读取语义

- `claudeOfficial`：`claudeModel` false → false（非 claude 名，走普通模型路径）；ref 无 `/`（无 provider 前缀，CC 自己的 pick）→ true（保持旧行为：Anthropic 自己管）；`provider.Find` 失败（provider 已删/不可解析）→ false（按普通模型写窗口——多写窗口无害，少写会复现卡死会话）。
- `HostOf(p.Anthropic) == "api.anthropic.com"` 精确等值（沿 groupfast.go:120 既有模式），不用 `HasSuffix(host,"anthropic.com")`（会误吞 xanthropic.com 类域）。
