# 外部技能研究 — 天才 skill 仓库索引

> **定位**：只读研究素材索引，**不是 SSOT**——不进 `skills.manifest.json`、不被 `sk-rebuild.js` 重建、不入 `categories/`、不链接到各端。
> **现状（2026-09-13 校准）**：浅克隆本体已于 2026-09-01 移除（原 147MB），本目录仅存本文档与 [INDEX-主题索引.md](INDEX-主题索引.md)；深啃时按链接重新浅克隆。
> **研究周期**：2026-07-06 建立 → 2026-08-20 最后一次刷新（净增 dag-library；superpowers v6.3.0、gstack v1.67.2.0、compound SKILL.md 大瘦身）。

## 研究过的仓库（7 个）

| 仓库                                 | 链接                                                    |  星* | 形态                      |
| ------------------------------------ | ------------------------------------------------------- | ---: | ------------------------- |
| mattpocock/skills                    | https://github.com/mattpocock/skills                    | 158k | 纯 skills 集合            |
| obra/superpowers                     | https://github.com/obra/superpowers                     | 248k | agentic framework         |
| EveryInc/compound-engineering-plugin | https://github.com/EveryInc/compound-engineering-plugin |  23k | plugin                    |
| garrytan/gstack                      | https://github.com/garrytan/gstack                      | 120k | opinionated tools 套件    |
| code-yeongyu/oh-my-openagent         | https://github.com/code-yeongyu/oh-my-openagent         |  65k | agent harness（本体）     |
| code-yeongyu/lazycodex               | https://github.com/code-yeongyu/lazycodex               | 2.5k | Codex harness（omo 打包） |
| kunchenguid/no-mistakes              | https://github.com/kunchenguid/no-mistakes              | 5.4k | Go CLI + 1 skill          |

\* 星数为研究时快照，仅供体感。另有 vercel-labs/skills、vuejs-ai/skills 两个来源只做了占位登记（categories 各分类下的"来源--技能名"条目），未做深度研究，完整 9 仓库链接表见[根 README](../../README.md)。

## 研究结论（2026-08 快照）

- **182 个 unique skill**：26 个 categories 已有（DUP），156 个新货；新货里约 35 个水分（产品自运维 / iOS / 平台绑定）、约 55 个高价值通用。
- **oh-my-openagent ≈ lazycodex**：两仓库重复 26 个 skill（src 子模块同源）；深啃任选其一，推荐本体 oh-my-openagent。
- **现有通用工程 skill 的上游源头是 mattpocock + superpowers**：26 个 DUP 集中在这两位——回溯上游原版。
- **独特增量在 gstack + compound**：四角色 plan 评审、YC office-hours、retro、ce-compound 知识沉淀、ce-explain 可视化解释，是 categories 完全没有的方法论。

## 导航

- **[主题索引（按能力聚合，跨仓库 182 项）](INDEX-主题索引.md)** — 主入口，每项带 GitHub 源链接 + 价值标注（★ 强推 / ○ 可选 / ✗ 水分 / [DUP] 已有）

## DUP 重叠（26 个，categories 已有）

用作上游原版对照，可对比本地改写版与原作者原版：

`agent-browser` `ask-matt` `brainstorming` `codebase-design` `diagnosing-bugs` `dispatching-parallel-agents` `domain-modeling` `executing-plans` `grill-me` `grill-with-docs` `grilling` `handoff` `improve-codebase-architecture` `prototype` `setup-matt-pocock-skills` `systematic-debugging` `tdd` `teach` `test-driven-development` `to-issues` `to-prd` `triage` `verification-before-completion` `writing-great-skills` `writing-plans` `writing-skills`

## 维护规则

- 本目录是普通目录，非 junction（与 categories 隔离，互不污染）。
- 重新深啃某仓库：按链接 `git clone --depth 1` 到临时位置，研究完删除，不动本目录。
- 不把研究内容手动复制进 categories——入库是单独决策：评估 + 改写 + 更新 manifest + rebuild junction。
