# 18 · claude-task-master：给任何 agent 装上任务系统

> 周边层（任务中间件） ｜ Stars ~28.0k（2026-09-04） ｜ JavaScript ｜ **MIT + Commons Clause**（限制"售卖软件本身"，自用/内部使用不受影响） ｜ [eyaltoledano/claude-task-master](https://github.com/eyaltoledano/claude-task-master)
> 学习目标：掌握"PRD → 任务 DAG → 逐个执行"的工作流；理解 MCP server 形态为什么是中间件的最佳载体。

## 一、为什么存在

它不管 agent、不管终端、不管看板——只管一件事：**把模糊的大需求变成有依赖关系、有优先级的任务清单，让任何 AI 逐个吃掉**。工作流：写 PRD → `parse_prd` 生成任务图 → 按依赖顺序把下一个任务喂给你的 agent（Cursor、Claude Code、Roo 等）→ 完成即标记 → 展开下一个。

它是"任务中间件"：上面接人，下面接任何 agent，中间是纯粹的任务工程。名字里的 claude 是历史（为 Claude Code 生态而生），今天的官方定位是 Taskmaster，配任何 AI chat 都行。

## 二、快速入门

```bash
npm i -g task-master-ai        # 或 npx task-master-ai
cd 你的项目
task-master init               # 初始化 .taskmaster 目录
# 配好模型 key 后：
task-master parse-prd --input=prd.txt
task-master next               # 拿到下一个该做的任务
```

第一次跑通：写十行 PRD → 解析成任务 → `task-master next` 把任务内容粘给你正在用的任何 agent → 做完 `task-master set-status --status=done` → 再取下一个。

## 三、熟练掌握

| 概念 | 一句话 |
| --- | --- |
| PRD → 任务 DAG | 大需求解析为带依赖与优先级的任务图 |
| Tags / Workstreams | 多工作流并行，任务集互不干扰 |
| MCP server 形态 | `mcp-server/` 让 agent 直接在会话内调用任务管理 |
| Loop 命令 | 自动循环"取任务→执行"的批处理形态 |
| 依赖管理 | 任务完成后自动解锁下游 |

熟练建议：用一个 5 功能的小项目全流程走一遍，重点体会**依赖顺序对质量的影响**——agent 有了 DAG 就不再"边想边干"，这是个人工作流里性价比最高的一笔投入。

## 四、架构设计

仓库即产品：`src/`（核心逻辑：解析、依赖、状态）、`mcp-server/`（MCP 形态的对外服务）、`bin/`（CLI 入口）、`apps/` 与 `packages/`（周边）、`.taskmaster/`（项目数据目录约定）。

两个设计决策值得学：**双形态交付（CLI + MCP server）**——人用 CLI，agent 用 MCP，同一套任务数据，互不抢上下文；**文件即数据库**——任务存 JSON 于项目内，版本可控、可 diff、不依赖服务端，代价是多端并发编辑要自己协调。许可上的 Commons Clause 是商业边界声明：拿它当工具用免费，拿它当产品卖不行。

## 五、源码地图与阅读路线

| 目录 | 职责 |
| --- | --- |
| `src/` | 核心：PRD 解析、任务模型、依赖与状态机 |
| `mcp-server/` | MCP 工具封装（agent 的调用面） |
| `bin/` | CLI 入口 |
| `apps/`、`packages/` | 周边应用与共享包 |
| `.taskmaster/` | 数据目录约定（在你 init 后的项目里） |

建议顺序：`src/` 的任务模型与依赖解析 → `mcp-server/` 看一条 MCP 工具如何包一层 CLI 逻辑 → 数据目录的读写路径。代码是直白的 JavaScript，无框架魔法，读起来轻松。

## 六、自测清单

- [ ] 完成 PRD → 任务 → 执行 → 完结的完整闭环
- [ ] 在你的 agent 里以 MCP 方式接入 task-master 并调用一次
- [ ] 能向别人解释 Commons Clause 允许与禁止的各一件事
- [ ] 能说明"文件即数据库"的收益与代价

## 七、参考

- 仓库：<https://github.com/eyaltoledano/claude-task-master>
- 文档：<https://tryhamster.com/docs/taskmaster>
