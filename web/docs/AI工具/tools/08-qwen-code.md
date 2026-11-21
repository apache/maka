# 08 · qwen-code：最好的 fork 演化样本

> 引擎层 ｜ Stars ~27.6k（2026-09-04） ｜ TypeScript ｜ Apache-2.0 ｜ [QwenLM/qwen-code](https://github.com/QwenLM/qwen-code)
> 学习目标：跑通它；把它与 gemini-cli 对读，理解一个 fork 如何从"换模型"长成"换方向"。

## 一、为什么存在

阿里 Qwen 团队的终端编码 agent，起点是 gemini-cli 的 fork（代码结构至今同构：`packages/` monorepo），但已走出独立方向：**多协议模型接入**（OpenAI/Anthropic/Gemini/Qwen API + Ollama/vLLM 本地模型，运行时可切）、**agent 能力包**（Auto-Memory、Auto-Skills、SubAgents、Agent Teams）、**超越终端的交付面**（IDE 插件、桌面 App、daemon 模式、SDK、IM bot：Telegram/钉钉/微信/飞书）。对中国用户，它是接入成本最低的选择之一。

它还有个彩蛋：官方声明用 qwen-code 自己开发自己（自举），issues/PR/评审都有自家 agent 参与。

## 二、快速入门

Windows（PowerShell）：

```powershell
irm https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.ps1 | iex
```

macOS/Linux：

```bash
curl -fsSL https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.sh | bash
# 或 npm install -g @qwen-code/qwen-code@latest（需 Node 22+）
```

第一次跑通：`qwen` 启动 → `/auth` 配 provider 与 key → 让它改一个文件。装完记得重开终端。

## 三、熟练掌握

| 概念 | 一句话 |
| --- | --- |
| 多协议 | 四家 API 协议 + 本地模型，运行时切换 |
| SubAgents / Agent Teams | 子 agent 与团队协作，fork 后长出的能力 |
| Auto-Memory / Auto-Skills | 自动记忆与技能沉淀 |
| IM bot | 在钉钉/微信/飞书/Telegram 里驱动它 |
| daemon 模式 | 常驻后台，供其他入口调用 |

熟练建议：同一个任务分别在 Qwen 官方模型和一个本地 Ollama 模型上跑，观察协议适配层是否真的无感——这是检验"多协议"含金量的方法。

## 四、架构设计

与 gemini-cli 同构的 monorepo：`packages/`（core/cli 等）、`docs/`、`integration-tests/`。它的架构故事不在结构而在**演化策略**：先复用上游全部基建（fork 省下一年工程量），再在三个方向叠加自己的差异化（模型协议层、agent 能力层、交付面层）。

这是 fork 的教科书路径：**结构继承 → 层内替换（provider）→ 层上新增（skills/bots）**。读代码时始终问："这个文件和上游一致，还是被改过？"——用 `git log` 追目录比读文件更能看清战略。

## 五、源码地图与阅读路线

| 目录 | 职责 |
| --- | --- |
| `packages/` | core（引擎）与 cli 等，同 gemini-cli 布局 |
| `integrations/` | 与外部系统的集成（bot、IDE 等） |
| `docs/`、`docs-site/` | 文档与文档站 |
| `integration-tests/`、`eslint-rules/` | 质量基建 |

建议顺序：先读 04 gemini-cli 建立上游基线 → 本仓库 `packages/` 找 provider 抽象层的差异 → `integrations/` 看 IM bot 如何复用同一引擎。带着问题读："多协议适配放在引擎内核，还是适配器层？为什么？"

## 六、自测清单

- [ ] 跑通并完成一次 provider 切换（云 ↔ 本地）
- [ ] 能说出它与上游 gemini-cli 的三个结构相似点和一个方向性差异
- [ ] 解释 fork 演化三阶段（继承/替换/新增）各对应哪些目录
- [ ] 用 git 历史验证其中一个判断

## 七、参考

- 仓库：<https://github.com/QwenLM/qwen-code>
- 文档（含中文）：<https://qwenlm.github.io/qwen-code-docs/>
