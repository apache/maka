---
name: helper-me
description: 个人开发实战与审查。做个人项目需要架构、技术栈或工作流指导（PRD→UI→API→Web→测试→缺陷→收尾）时用；审 React 代码/组件/hooks/pages/PR、复盘 React 项目代码，或准备 React code review 面试时用。跨技术栈通用原理用名词激活（单一可信来源/状态机/清场/数据所有权/最后写入获胜/测量先行等）。学习规划用 cognition-me，概念讲解用 mentor-me，技术写作用 writer-me，月度绩效用 performance-me（均为独立姊妹 skill）。
---

# helper-me — 个人开发实战与审查

个人项目开发的统一入口：判定技术栈 → 路由到最小必要的 `*-me` 专题 → 跨专题关键决策过工程决策门。不代替专题细节，不为简单任务加载整套规则。

## 意图与路由

先识别用户意图，一次只进一个：

- **开发实战**（架构决策、技术栈、交付工作流、工程决策门）：读本文件下文，按实际问题选择自动判定栈、相关工程决策或流程入口，不要求遍历全部阶段。
- **审查 React 代码**（审代码/PR、复盘 React 项目代码、R 规则与 review 清单、准备 React code review 面试）：直接加载 [references/03-dev/SKILL.md](references/03-dev/SKILL.md) 的 `review-me` 节（先读节索引定位行号，只读该节），不经过本文其余部分。专题文件内部的 references、assets、scripts 相对引用以其所在目录为根解析，保持原样。

## 方法论索引：名词定位，动作与验收约束执行

方法论名称用于检索，不替代具体行为与验收条件。关键规则保留一句可检查的动作；切换模型、推理强度或上下文后，应以代表性任务验证执行效果，不把熟悉名词当作一致执行的保证。

用法两条：

1. 用户话术或任务命中「命中场景」列时，用「名词」作为该任务的执行主轴，并按「细节去处」加载个人契约或外部规则。
2. 沉淀新经验前先查此表：能用已有名词命中的，只写个人差异，不复制通用原理；确实新的方法论才新增一行并起一个可复用的名词。

### 工程决策类

| 名词         | EN                     | 一句话原理                                                          | 命中场景                                                       | 细节去处                                                     |
| ------------ | ---------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------ |
| 单一可信来源 | Single Source of Truth | 同一份状态只允许一个拥有者，其余全是派生                            | 新增/编辑表单的 record/id/mode、双视图同步、编辑态归属         | helper-me 工程决策门；ui-me 状态机；review R01/R26           |
| 状态机       | State Machine          | 把生命周期枚举成固定阶段，每阶段只做该阶段的事，边界处清场          | 弹窗 `open→echo→submit→success→close→reopen`、异步任务、向导流 | ui-me；node-bff 任务状态机                                   |
| 数据所有权   | Data Ownership         | 服务端数据归查询层缓存，UI store 只放真 UI 状态，谁拥有谁刷新       | TanStack Query vs Zustand/Pinia 取舍、列表刷新、缓存失效       | helper-me 工程决策门；zustand-me                             |
| 最后写入获胜 | Latest-write Wins      | 自增序号或 Abort 信号拦截过期响应，只有最新一次能写状态             | 并发翻页、连点两条编辑、搜索联想、慢详情回显                   | react-me 数据编排；review R20                                |
| 清场         | Teardown               | 有创建就有清理，成对出现，关闭/卸载是第二次提交                     | 弹窗关闭清理、定时器/监听/播放器 unmount、临时产物删除         | ui-me；react-me；review R13                                  |
| 并行         | Parallelize            | 相互独立的操作同时发起，等待只发生在真正依赖处                      | 多区块首屏、多接口聚合、独立请求别排成瀑布                     | vercel-react-best-practices async-*；review R65              |
| 按需加载     | Load on Demand         | 索引常驻，全文用到才读——对代码包和上下文同时成立                    | 路由级代码分割、barrel imports、重组件延迟、skill 索引         | vercel-react-best-practices bundle-*                         |
| 测量先行     | Measure First          | 先找热点再优化，第一刀是切边界不是堆 memo；个位数数组不值得 useMemo | 性能优化、"感觉慢"、重渲染排查                                 | vercel-react-best-practices；react-me；review R33            |
| 最小订阅     | Minimal Subscription   | 只订阅渲染所需的最小状态，能在渲染期派生的不复制                    | 重渲染治理、selector 粒度、derived state、memo 边界            | vercel-react-best-practices rerender-*；react-me；review R02 |
| 最小复现     | Minimal Reproduction   | 先把问题收敛到最小可复现样本，再谈修复                              | Bug 定位、给上游报 issue、验证猜测                             | bug-me                                                       |
| 根因         | Root Cause             | 修所有调用方共享的那一处，不在每个症状点打补丁                      | 修 bug 前先 grep 调用方、回归反复出现时                        | bug-me；helper-me 反模式                                     |
| 契约先行     | Contract First         | 先锁接口/结构契约，再写实现；静态可断言的用结构测试锁               | 前后端联调、组件 API 设计、防回归                              | quality-me 验证设计；node-bff 契约测试；review R68           |

### 审查与简化类

| 名词           | EN                          | 一句话原理                                                 | 命中场景                              | 细节去处           |
| -------------- | --------------------------- | ---------------------------------------------------------- | ------------------------------------- | ------------------ |
| 第一性原理     | First Principles            | 回到稳定原语推导，不按页面按钮或工具能力类比照搬           | 方案设计、学新框架、路线图失控时      | cognition 工作原则 |
| 对抗式审查     | Adversarial Review          | 让没参与实现的视角专挑毛病，Prove it, don't tell me        | PR 自查、方案评审、交付前             | cognition 工作原则 |
| 消融实验       | Ablation                    | 去掉一个组件再跑一遍，每条规则每个依赖都要证明自己在起作用 | 优化后验证、配置清理、依赖退役        | —                  |
| 奥卡姆剃刀     | Occam's Razor               | 能用更少机制解决的方案优先                                 | 方案取舍、要不要引入新依赖            | —                  |
| YAGNI          | YAGNI                       | 投机的需要 = 不做，later can scaffold for itself           | 新功能、抽象层、配置项、"以后可能用"  | —                  |
| 高内聚低耦合   | High Cohesion, Low Coupling | 模块边界清晰就是在做上下文分片，要理解的东西更少           | 组件拆分、目录结构、skill 拆分        | web-me             |
| 列出不自信的点 | List Every Uncertainty      | 把承认不确定变成任务，全票通过不等于没有风险               | 交付自检、技术方案、绩效里写风险      | —                  |
| 批判性思维     | Critical Thinking           | 警惕讲得太顺的解释，不为对齐一张截图编造不存在的 bug       | 验证结果、看测试全绿、看他人结论      | —                  |
| 保持独立思考   | Independent Thinking        | 采纳别人观点前先形成自己的判断                             | 多 Agent 协作、看 review 意见、看文档 | —                  |
| 蒸馏           | Distillation                | 强者带弱者，给标准范例学；人指导 Agent 做的是同一件事      | 带新人、写范例、Agent Team 分工       | cognition          |

## 路由规则

1. **单一意图**：只加载当前任务所需内容；用户纠正或中止时立即重新确定执行方向，不等待旧流程完成。
2. **复合意图**：分别加载，按用户请求顺序执行，不混合各模式输出风格。
3. **意图模糊**：先利用上下文和只读检查消除歧义；只有答案会实质改变目标、契约、成本或不可逆结果时才提问。其余说明合理假设后继续，不从模糊请求推导写入或对外操作授权。
4. **模式内溯源**：用户追问细节出处时，指向对应文件与其 references，不凭记忆复述。
5. **事实分层**：项目事实（结构、端口、技术栈）在项目 `AGENTS.md` 或 `.kiro/steering`；跨项目的个人方法论只在本 skill 与各 `*-me` 专题文件，不在其他地方重复维护。

## 目录体系

### 参考树 `references/`（编号目录 + 技术栈单文件，按需单独加载）

| 目录/文件         | Skill 名称             | 何时使用                                                                                                                                                                             |
| ----------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `01-prd/`         | `prd-me`               | PRD、原型截图、模块蓝图、组件边界、开发顺序                                                                                                                                          |
| `02-api/`         | `api-me`               | 接口字段、DTO、mapper、字典、分页、状态流                                                                                                                                            |
| `03-dev/SKILL.md` | `dev-me`（八节合并体） | 开发执行层单文件渐进披露：先读节索引，再按节只读命中节。web-me 房规；react / zustand / vue / node-bff 技术栈专题；bug-me 最小修复；quality-me 质量门；review-me 审查（意图路由直达） |

已独立为姊妹 skill（与 helper-me 平级）：`ui-me`（业务 UI 契约）、`css-me`（样式治理）、`taro-me`（Taro 多端与 NutUI）。后端 Node BFF 收编在 [03-dev 的 node-bff-me 节](references/03-dev/SKILL.md)；Java 专题已退役删除（git 历史可恢复）。

目录口径：编号只表达流水线/资产顺序，不代表加载顺序；每个文件独立按需加载，只加文件不并内容。

## 自动判定栈

| 判定                                                                                                                                     | 栈                     | 优先专题                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------- |
| `package.json` 依赖含 `fastify` / `express` / `koa`；或有 route/schema/worker 且无 Taro 产品壳；或 Next.js 以 `src/app/**/route.ts` 为主 | Node 服务 / BFF        | `node-bff-me`                                                                      |
| `package.json` + Taro / `src/pages` / `src/app.config.ts` / Umi 产品壳                                                                   | Web 前端               | 按实际问题选择 `prd-me` / `ui-me` / `web-me` / `css-me` / `quality-me`，非固定顺序 |
| 同仓多栈                                                                                                                                 | 按当前编辑文件所在目录 | 对应专题                                                                           |
| 判定不出、跨栈通用、或用户只要最小修复                                                                                                   | 调试                   | `bug-me`                                                                           |

跨专题组合按需取用：布局 `ui-me`、视觉还原 `css-me`、字段与请求 `api-me`、组件边界与数据编排 `react-me`、多端 `taro-me`、状态边界 React `zustand-me` / Vue `vue-me`；通用原理先用上方「方法论触发词」表的名词激活，各专题只留个人差异。

## Web 工程决策门

开项、模块设计、重构或状态混乱时先过这道门。已有项目约定优先，以下只是新项目默认值；原理细节见上方「方法论触发词」表，此处只留名词与默认位置。

- **数据所有权**：服务端数据归查询层（确有缓存/刷新/失效需求用 TanStack Query），不进全局 store；列表刷新由唯一数据拥有者负责（query invalidation / 表格 ref/reload）。细节见 [03-dev/SKILL.md](references/03-dev/SKILL.md) 的 zustand-me、vue-me 节。
- **单一可信来源**：编辑态 `record/id/mode` 全程唯一；URL 状态归 search params；持久化走 typed storage adapter，凭证走现有认证方案。
- **最小订阅**：渲染期能派生的不再用 Effect 复制一份。默认位置：本地 UI 态→`useState`/`ref`，跨组件→Zustand/Pinia，表单→Form 实例局部态。
- **薄封装 + 错误分型**：请求层复用项目已有封装，新项目 Fetch + 一个轻量 `request`；业务、网络、鉴权、数据结构四类错误分开表达。字段与 DTO 读 [api-me](references/02-api/SKILL.md)。
- **状态机 + 清场 + 最后写入获胜**：表单弹窗按 `open → echo → submit → success → close → reopen` 检查——新增先清 record/id 再写默认值，编辑先定 record 再异步回显防慢响应覆盖，成功先通知唯一数据拥有者刷新再关闭，关闭集中清场。读姊妹 skill ui-me（业务 UI 契约，含 P0-P8 优先级总表）。

## 组件与首版落地

组件按业务红框建模：能跨模块复用的稳定结构单独抽，模块专用内容不泛化，多模式用明确组件不用布尔 props；静态数据、默认数组、ViewModel、mapper、constants 放渲染前，JSX 只消费稳定结构。渲染与组合细节用 `vercel-composition-patterns`、`vercel-react-best-practices` 收敛。

Figma 首版：`types/`、`utils/`、`constants/`、`hooks/` 上收到模块公共目录，组件子目录只留 `index.tsx`、`index.module.scss` 和纯展示组件；临时契约和 mapper 首版结束前上收或删除，不留"后面再清"的尾巴。

## 默认流程

**Web 模块开发**：按当前问题选择对应入口，不遍历全部阶段。需求或边界不清时补蓝图，字段问题查 API，组件或状态问题查对应开发节，视觉问题查样式节；已有信息足够时不重复设计。完成本次验收所需修改与验证即可收尾。

**Node BFF**：`node-bff-me` 先定形态 → 锁 route/schema/service/worker 边界 → 契约测试先行 → 再改类型或实现 → `quality-me` 收尾。

**模糊修复**：先用 `bug-me` 收敛阻断链，再按结果决定是否切回结构治理。

## 反模式

- 不把本 skill 当成所有任务的默认入口。
- 不在修 Bug 时加载整套最佳实践。
- 不把历史经验写成当前代码事实。
- 不为了统一风格扩大改动范围。
- 不新增旧长前缀命名。
- 不把 Node BFF 误判成 Web 前端。
- 不在入口或专题正文写真实项目名、私有路径或环境端口。

## 输出格式

遵循当前用户要求和适用项目宪法；结论先行，只保留必要行动与验证证据，不套固定报告模板。

## 维护口径

命名约定：03-dev 为单文件 `SKILL.md`（name: `dev-me`），节名即专题名（`## web-me：…`），按节路由；`01-prd/`、`02-api/` 沿用文件夹 + `SKILL.md`；旧长前缀仅历史兼容，不再新增。

合并口径：同一触发时机、同一阶段的经验合入同一文件（验证设计并入 `quality-me`，总结沉淀并入 `writer-me`，NutUI 并入 `taro-me`）；跨技术栈通用原理只留名词指针（上方「方法论触发词」表），不复制通用规则。

规则维护：依据代表性任务中的实际执行与验收结果决定是否删除，不依据模型版本、主观印象或低触发次数。合并重复内容，保留有实际价值的简短动作说明及低频但必要的安全、恢复与权限约束。

## 文件清单

- `references/` — 三个专题目录：01-prd / 02-api / 03-dev（03-dev 为八节合并体 `SKILL.md`，节索引在文件头，evals 在 03-dev/evals/）
- `tests/trigger-cases.md` — 触发与路由测试集，结构性编辑后对照验证

独立姊妹 skill（各自 description 自带触发词，不占本路由表）：`cognition-me`（学习规划/心智模型/时间杠杆）、`mentor-me`（概念讲解，teach me X）、`writer-me`（技术写作、翻译、去 AI 味）、`performance-me`（月度绩效自评与目标）。
