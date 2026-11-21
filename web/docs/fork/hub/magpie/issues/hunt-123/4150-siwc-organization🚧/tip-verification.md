# 4150 SIWC organization — tip verification (2026-11-05)

Tip: `upstream/main` @ `c32b820a9` (gateway: a "User location is not supported" refusal rests no account... #5182), worktree `/private/tmp/mg123-ac`, branch `fix/4150-siwc-organization`（判定帖，零代码，分支无 commit）。

## 报告者三点观察 @ tip 全部成立（行号漂移）

| 报告观察 | @ tip | 实测 |
| --- | --- | --- |
| `siwcAPI` 固定 `https://api.openai.com/v1` | 报告引 L3-L17 | `internal/provider/chatgpt_api.go:51` |
| `siwcCreds` 无 organization/project 字段 | 报告引 L79-L90 | `internal/provider/chatgpt_api.go:86-96` |
| `siwcProvider` 只签 `Authorization: Bearer` + session headers | 报告引 L717-L743 | `internal/provider/chatgpt_api.go:736-749` |

## magpie 侧根因（Headers 不可达 = 文档化设计）

- `internal/provider/provider.go:265-272`：`Headers` 契约明文 "Signed-in agent accounts ignore them: their auth is the agent's own"。
- `internal/provider/account.go:222-227`：`Provider.Sign` 对有 `Account.sign` 的 provider 提前 return，用户头永不应用。
- `chatgpt-api` 是内建 signed-in 账号 provider（`siwcAccount()`），无 Headers 设置面。
- 全仓 `rg -i 'OpenAI-Organization'` 零命中。

## OpenAI 侧证据（判定核心）

1. credits 文档（developers.openai.com/api/docs/guides/chatgpt-api-credits.md，2026-11-05 抓取原文）：
   - "Grants apply only to the linked API organization. Select that organization and use one of its project API keys when making requests."
   - "Codex usage through API keys is not supported by this benefit. These API credits also don't increase your ChatGPT or signed-in Codex usage limits."（两池显式分离；signed-in 用量不吃 org credits）
   - "Changing the receiving organization: Contact support."
2. Codex CLI（openai/codex，2026-11-05 contents API 实读）：
   - `codex-rs/http-client/src/openai_headers.rs`：定义 `OPENAI_ORGANIZATION_HEADER = "openai-organization"`。
   - `codex-rs/model-provider/src/runtime_auth.rs` `validate_runtime_selectors`：`ActorInfo::Chatgpt` → `validate(OPENAI_ORGANIZATION_HEADER, None)`（**必须缺席**）；`ActorInfo::Platform` → 必须 present 且匹配注册 org。参考客户端对 ChatGPT actor 带 org 头是拒绝语义。

## workaround 全链路代码级验证

- 内建 preset：`internal/provider/presets.go:169-171` `{ID: "openai", Chat/Responses: https://api.openai.com/v1}`。
- CLI：`magpie provider add openai <key> header.OpenAI-Organization=org-…` — `internal/cli/providers_cli.go:1278-1293` 解析 `header.*` 进 `p.Headers`。
- plain provider `Headers` 在 auth 后应用可覆盖：`internal/provider/account.go:245-263`。
- 结论：报告 option 2（标准 API-key provider + org 配置）今日已存在。

## 假设排序与定性

1. H1 用户头可达但无发现 → **半反证**（plain 可达且 CLI 有面；SIWC 按设计丢弃）。
2. H2 运行时硬丢用户头，TDD 放行 → **不采**：上游无文档支持 + Codex 参考客户端反向拒绝 + 本机无 eligible 账号不可验证，发头可能致拒。
3. H3 需新设置面 org 选择器 → **超范围且无上游语义**。

定性 = **判定帖**（#2602 形态先例）：零代码，取证链 + workaround + 裁量建议。

## 帖子九要素回读清单

① 评论存在有 ID ② 全英文 ③ 零中文 ④ AI 披露恰一次（GLM-5.3-Flash (ZCode)）⑤ credit zemul ⑥ OpenAI 文档原句引用两处 ⑦ 代码引用 file:line 齐 ⑧ 围栏成对 ⑨ workaround 命令在场
