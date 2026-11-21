# 04 · gemini-cli：免费额度最大的规范实现

> 引擎层 ｜ Stars ~106.8k（2026-09-04） ｜ TypeScript ｜ Apache-2.0 ｜ [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli)
> 学习目标：跑通它；把它当作"引擎层规范实现"来读——结构清晰、文档齐全，还是 qwen-code 的上游。

## 一、为什么存在

Google 官方开源终端 agent，Apache-2.0。最大卖点不是技术而是**门槛**：个人 Google 账号免费额度 60 请求/分钟、1000 请求/天，配 Gemini 3 系模型与 1M token 上下文——学习成本几乎为零。同时它是这个领域里工程规范度最高的仓库之一：CI/E2E/集成测试/评测目录齐全，适合当"教科书实现"读。

## 二、快速入门

```bash
npx @google/gemini-cli          # 免安装直接跑
npm install -g @google/gemini-cli
brew install gemini-cli         # macOS/Linux
```

第一次跑通：项目目录运行 `gemini`，用 Google 账号登录，让它"读一下这个项目并画出模块依赖"。内置工具覆盖 Google 搜索接地、文件操作、shell、网页抓取。

## 三、熟练掌握

| 概念 | 一句话 |
| --- | --- |
| 免费额度 | 个人账号 60 req/min、1000 req/day，学习与轻量使用够用 |
| 1M 上下文 | 大仓库整读的底气，但注意成本与注意力稀释 |
| 内置工具 | 搜索接地 / 文件 / shell / fetch |
| MCP | 标准协议扩展外部能力 |
| GEMINI.md | 项目记忆文件，同 CLAUDE.md 思路 |

熟练建议：用一个 1M 上下文能吃下、你的其他工具吃不下的大仓库做一次重构实验，体会"超长上下文"什么时候是真优势、什么时候只是贵。

## 四、架构设计

Monorepo，`packages/` 下核心拆分（core：agent 循环与工具；cli：终端前端），另有 `docs/`、`evals/`、`integration-tests/`、`schemas/`、`tools/`。

三个值得学的工程决策：**core 与 cli 分包**（引擎可被 IDE 插件等复用）；**evals 目录进主干**（评测是工程的一部分，不是附属品）；**schema 显式化**（配置与协议有 schema，避免"配置即字符串"）。

## 五、源码地图与阅读路线

| 目录 | 职责 |
| --- | --- |
| `packages/` | `core`（引擎）与 `cli`（终端 UI）等包 |
| `docs/` | 架构与使用文档 |
| `evals/` | 评测任务——理解"这个 agent 认为什么叫做好" |
| `integration-tests/`、`perf-tests/`、`memory-tests/` | 质量基建 |
| `schemas/` | 配置/协议 schema |

建议顺序：`packages/core` 的 agent 循环 → 工具注册机制 → `evals/` 里挑一个任务看它怎么被量化。读完这篇再去读 08 qwen-code，对照 fork 走了多远。

## 六、自测清单

- [ ] 免费额度登录跑通，说出额度的两个数字
- [ ] 能画出 core/cli 两包的职责边界
- [ ] 解释 evals 目录为什么应该出现在每个 agent 仓库里
- [ ] 找到工具（如 shell）从模型调用到真正执行的代码路径

## 七、参考

- 仓库：<https://github.com/google-gemini/gemini-cli>
- 文档：<https://geminicli.com/docs/>
