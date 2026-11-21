# 技术选型 — 调查完毕，可以直接给结论了。

## 结论：magpie 没有 CPA 凭据的导入格式，而且不建议迁移

*…（截断）

- 标签：技术选型
- 日期：2026-10-20
- 来源：zcode 会话 session_（C:\Users\802165）
- 置信度：机器初筛候选，采纳前请对照原会话

## 触发上下文（用户最后一问）

[$ponytail](C:\\Users\\802165\\.zcode\\skills\\ponytail\\SKILL.md) 我现在在本地通过cpa，magpie去链接cpa在codex跑通了，我希望能不能直接C:\Users\802165\CLIProxyAPI\.cli-proxy-api\free让这些json在magpie这个大模型网关本地跑，这样就不需要cpa多一套中转了，但是magpie有没有cpa把json转换的格式呢

## 结论

调查完毕，可以直接给结论了。

## 结论：magpie 没有 CPA 凭据的导入格式，而且不建议迁移

**你的 CPA JSON 是什么**：那 23 个文件是平铺的 OAuth token 组（`access_token` + `refresh_token` + `account_id` + 过期时间）。`access_token` 几小时就过期，真正长期有效的是 `refresh_token`——谁用它，谁就必须实现去 OpenAI auth 端点换新 token 的刷新流程。CPA 的价值就在这：token 刷新 + 23 个免费账号的池化轮询（fill-first）、冷却调度、配额耗尽自动切换。

**magpie 侧的现状**（查了它的 [README](https://github.com/yetone/magpie/blob/main/README.zh-CN.md) 和 [reference 文档](https://raw.githubusercontent.com/yetone/magpie/main/docs/reference.md)）：

1. magpie 原生支持 ChatGPT/Codex 订阅供应商，也支持同供应商**多账号 + 自动 failover**（文档甚至提到 Free 账号排在 Plus 后面兜底），这个能力是有的。
2. 但账号进入 magpie 的方式只有两种：**在 magpie 里逐个走 OAuth 浏览器登录**，或 magpie 自动发现本机 Codex/Claude 的登录文件——而 Codex 本身是单账号登录，这条路最多带进 1 个账号。
3. 它的“导入”功能读的是 CC Switch、Codex `config.toml`、OpenCode `auth.json` 里的 **provider 配置和 API key**；文档明说订阅类 token（Claude Pro/Max、Copilot 这类 OAuth 登录信息）**"listed and skipped"——让你在 magpie 里重新登录**，不做 token 搬运。CPA 的 JSON 格式不在任何导入源里。

**所以“转换格式”这条路**：理论上的干净做法是给 magpie 写一个 pi/OpenCode auth 插件（magpie 支持插件自带登录逻辑），由插件读 CPA 的 JSON 池做刷新——但这是一个开发项目，不是配置活。

**算笔账（不划算）**：CPA 就跑在 127.0.0.1，这一跳的延迟是毫秒级、资源占用几乎为零，“省掉一层中转”的实际收益约等于零；代价却是 23 个免费账号逐个重新 OAuth 登录（有风控风险）+ 放弃 CPA 专门的免费号池调度。现在 magpie → CPA(8317) → codex 这条链你已经跑通了，维持现状就是最懒也最对的方案。

顺带一提：截图里 magpie 的 CPA 供应商只显示 4 个模型，而 CPA 现在实际暴露 9 个（含 `gpt-5.6-luna`）——在 magpie 里刷新一下该供应商的模型列表就能看到全部。

Sources: [magpie README 中文](https://github.com/yetone/magpie/blob/main/README.zh-CN.md) · [magpie docs/reference.md](https://github.com/yetone/magpie/blob/main/docs/reference.md)
