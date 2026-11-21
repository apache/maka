# 10 · OpenHands（Agent Canvas）：引擎与控制中心集于一身

> 跨层（自带 OpenHands agent + 驱动任意 ACP 兼容 agent 的控制中心） ｜ Stars ~86.1k（2026-09-04） ｜ TypeScript（GitHub 主语言字段） ｜ MIT ｜ beta ｜ [OpenHands/OpenHands](https://github.com/OpenHands/OpenHands)
> 学习目标：理解 2026 年最重要的产品转型样本——从"AI 软件工程师"到"开发者控制中心"；搞懂 ACP 协议为什么是分水岭。

## 一、为什么存在

这个仓库三年换了三个故事：All-Hands-AI 时代的"开源 AI 软件工程师"（自主跑任务的独立 agent 应用）→ 现在的 **Agent Canvas：自托管的开发者控制中心**——起会话、跑自动化（定时/Webhook 触发、发 Slack/GitHub/Linear/Notion），并且**既能跑自家 OpenHands agent，也能驱动 Claude Code、Codex、Gemini 或任何 ACP 兼容 agent**。

它值得专门一篇的原因：它是"**引擎 + 编排**"双持的唯一高星样本。对照判据"agent 是谁家的"，它的答案是"都行"——这正是编排层工具的终极形态，也是 Maka/Orca/Multica 对比文档里"向上爬层"趋势的最大案例（项目状态为 beta，接口仍在变）。

## 二、快速入门

```bash
npm 包：@openhands/agent-canvas（具体安装见仓库 README 与 docs.openhands.dev）
```

两条路线自选：

1. **本地起步**：装好后起一个会话，驱动本机的某个 agent（自家 OpenHands 或已装的 Claude Code）完成一个小任务；
2. **自托管**：按 `docs/SELF_HOSTING.md` 把后端跑在 Docker/VM/服务器上，体会"agent 在云上继续干活，笔记本合盖也没事"的形态。官方特别提醒自托管要做安全加固。

## 三、熟练掌握

| 概念 | 一句话 |
| --- | --- |
| Agent Canvas | 前端控制中心：会话 + 自动化 + 集成的统一界面 |
| OpenHands agent | 自家引擎，开箱即用 |
| ACP（Agent Client Protocol） | 与第三方 agent 之间的标准协议，Claude Code/Codex/Gemini 皆可接入 |
| Backend | 执行后端：本地 / Docker / VM / 云（OpenHands Cloud/Enterprise），可热切换 |
| Automations | 定时或事件触发的自动化工作流 |

熟练建议：同一个任务分别在"自家引擎后端"和"ACP 接入的第三方 agent 后端"各跑一次，对比两边你分别能观测到什么——这直接回答"编排层工具对执行过程的承诺边界在哪里"。

## 四、架构设计

控制面/执行面分离：Canvas 前端（`src/`）→ agent server 后端（可多个，本地/远程/云）→ 后端内跑具体 agent（自家引擎或 ACP 外援）。仓库里的 `electron/`（桌面壳）、`helm/`（K8s 自托管）、`tools/`、`.openhands/` 印证了多形态部署。

关键取舍：**用协议（ACP）换生态**——不把用户锁死在自家引擎，代价是执行过程的可见性与控制粒度取决于各 agent 对协议的支持程度。这与 Maka"一切过自家 Runtime Host"是相反的哲学：一个赌协议标准，一个赌单一权威。

## 五、源码地图与阅读路线

| 目录 | 职责 |
| --- | --- |
| `src/` | Canvas 前端主体 |
| `electron/` | 桌面端壳 |
| `tools/`、`.openhands/` | 自家 agent 相关与配置 |
| `helm/`、`docker/` | 自托管部署 |
| `docs/` | 含 SELF_HOSTING 与 ACP agents 文档——**先读** |

建议顺序：`docs/`（backends、acp-agents 两篇）→ `src/` 里找 backend 切换逻辑 → ACP 会话建立与事件流的代码路径。带着问题读："切换 backend 时，会话状态跟着走吗？"

## 六、自测清单

- [ ] 能用一段话讲清它的三个历史阶段
- [ ] 本地跑通一次非自家 agent 的 ACP 驱动
- [ ] 能对别人解释 ACP 协议改变了什么
- [ ] 能对比"协议标准路线"与"单一权威路线"的各自赌注

## 七、参考

- 仓库：<https://github.com/OpenHands/OpenHands>
- 文档：<https://docs.openhands.dev>（重点：Agent Canvas 的 backends 与 acp-agents 页）
