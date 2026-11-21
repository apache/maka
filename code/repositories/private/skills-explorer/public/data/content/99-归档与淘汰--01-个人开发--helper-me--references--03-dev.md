---
name: dev-me
description: 开发执行层八节合并体（web/react/zustand/vue/node-bff/bug/quality/review-me）。由 helper-me 主入口按节路由：先读节索引，再用 Grep 定位节标题、按行号只读命中节，不通读全文。
---

# 03-dev — 开发执行层

> 八个专题的合并体，单文件渐进式披露：helper-me 主入口按意图路由到本文件的某一节。**先读下方节索引，再按节标题行号只读命中节**（Read 支持 offset/limit，Grep 可定位 `## <节名>`），不要求通读。

## 节索引

| 节            | 专题                                         | 何时读                                                                                      |
| ------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `web-me`      | Frontend Module Standards 前端结构与命名房规 | 初始化/检查 React、TS、Taro、H5、Umi 模块；目录、组件边界、命名、JSDoc、README 口径         |
| `react-me`    | React 组件架构实践                           | 设计/审查/重构 React(Taro) 组件、ViewModel props、memo、数据编排 hook（并行、防竞态、清场） |
| `zustand-me`  | Zustand React17 模块状态                     | 设计/修复 Zustand store、状态归属、selector、异步 action、页面清理、跨页缓存                |
| `vue-me`      | Vue 与 React 分叉点                          | Vue3/Options API、Pinia vs Zustand、v-html、超大 SFC、Vue Router 守卫                       |
| `node-bff-me` | Node BFF 与后台服务                          | Fastify/Express/Koa 服务、Next App Router BFF、JSON Schema、worker、契约测试、TS 迁移       |
| `bug-me`      | 最小改动修复                                 | 明确阻断 Bug、启动失败、兼容问题、最小 diff、受控 console 诊断                              |
| `quality-me`  | Project Quality Gate 质量门禁                | 用例设计、改后验证、提交前只读检查、格式/lint 门禁                                          |
| `review-me`   | 个人 React Review 审查体系                   | 审代码/审 PR、复盘 React 项目、review 面试；helper-me 审查意图直达本节                      |

## web-me：Frontend Module Standards 前端结构与命名房规

前端模块的目录、职责、命名与 README 口径（房规）。需求裁决走 `prd-me`，业务布局走 `ui-me`。

### 默认目录

```text
module/
├── index.tsx
├── index.module.scss
├── index.config.ts
├── README.md               # 含设计源优先级声明（见「模块文档体系」）
├── mappers.ts              # 契约 → 视图模型的唯一映射层
├── store.ts
├── service.ts
├── components/             # 默认纯展示：index.tsx + index.module.scss
├── constants/
│   └── index.ts
├── docs/                   # 四册：prototype / interface / ui-design / test-case（见「模块文档体系」）
├── hooks/                  # use<Module> 页面编排 + 子 hook，index.ts 做出口
│   └── index.ts
├── styles/                 # 三件套：ui.scss 变量 / mixins.scss 配方 / index.scss 入口
├── tests/                  # page.test.cjs（入库层，见「验证资产分层」）
├── types/
│   └── index.ts
└── utils/
    └── index.ts
```

流程页面、长任务模块和可复用业务模块默认保留 `types/`、`hooks/`、`constants/`、`utils/` 四类目录，各自 `index.ts` 作稳定出口，消费方走目录入口不深层导入。轻量展示组件可缩减为单文件 `types.ts`/`utils.ts`；一旦出现接口 DTO、路由参数、分页、弹窗动作或跨组件复用，升级为目录 + `index.ts`。

### 分层规则

| 层                     | 职责                                                        | 禁止                                             |
| ---------------------- | ----------------------------------------------------------- | ------------------------------------------------ |
| `index.tsx`            | 页面布局、组件组合、少量条件渲染                            | 放请求、复杂计算、状态机                         |
| `hooks/use<Module>.ts` | 页面编排、事件处理、副作用协调（`hooks/index.ts` 统一出口） | 写纯展示 JSX                                     |
| `hooks/<子 hook>.ts`   | 可复用数据、轮询、SSE、生命周期逻辑                         | 混入无关工具函数                                 |
| `mappers.ts`           | 契约 DTO → 视图模型映射，**唯一映射层**                     | 组件或 `utils/` 里散落映射函数                   |
| `components/`          | 独立业务区块、弹窗、卡片、时间轴；**默认纯展示**            | 为每个小视觉元素建组件；为纯展示组件套 hook 文件 |
| `store.ts`             | 模块级跨组件状态                                            | 混入接口 DTO 转换细节                            |
| `service.ts`           | 请求入口和接口封装                                          | 写 UI 兜底逻辑                                   |
| `utils/`               | 纯函数、格式化、转换、计算                                  | 做请求、读写全局状态                             |
| `types/`               | DTO、ViewModel、Props、状态类型                             | 类型散落到组件内部                               |
| `styles/`              | token、mixin、公共样式                                      | 抽一次性样式                                     |
| `constants/`           | 状态、事件、字典、枚举                                      | 把业务常量写在 JSX 里                            |

组件内 hook 文件（历史上的 `index.hook.ts`）只在组件自持复杂编排（状态机、拖拽、轮询）时才建；纯展示组件一律不建，逻辑上移模块 `hooks/`。页面级编排固定 `hooks/use<Module>.ts`；`index.hook.ts` 属历史命名，新模块不用、老模块不专门改名。

### 新建模块骨架

复制成熟模块或模板改名（无模板按目录树逐个建）→ 先建 `types/`、`hooks/`、`constants/`、`utils/` 四个 `index.ts` 出口再补子文件 → 占位统一前缀（如 `Template`）全局替换 → `store.ts` 起空骨架、`service.ts` 起统一请求封装骨架（自定义 Error + 业务 code 校验）→ 路由注册、分包配置等框架步骤见对应专题（如 taro）。

轻量模块保留页面级 `hooks/use<Module>.ts` 即可；重模块（多业务入口、任务状态机、复杂副作用）用 `hooks/` 聚合层 + 子 hook 分层。

### 流程页面拆分样板

列表 + 详情 + 记录 + 内容生成的流程页面：入口负责布局与面板组合；各区块拆成 service DTO、mapper、Hook 编排和展示组件；`types/service/*` 记录接口原始形态，`types/view*` 记录页面模型，`mappers.ts` 负责 DTO→ViewModel（超 500 行按域拆 `mappers/` 目录 + `index.ts` 索引）；详情聚合接口一次返回多业务字段时不再保留旧拆分接口作主链路；二级跳转依赖的隐藏业务主键，类型和 mapper 必须显式保留。

### 完整企业模块目录标杆

「列表 + 聚合详情 + 多记录区块 + 内容生成 + 外部带参入口」类完整企业模块，按此组织（多项目收敛后的稳定标杆）：

```text
module/
├── index.tsx                     # 只做左右布局与面板组合
├── mappers.ts                    # 契约 → 视图模型唯一映射层（超 500 行按域拆目录）
├── service.ts                    # 该模块全部接口封装（JSDoc 写清真实路径/方法/复用点）
├── README.md                     # 来源、组件定位、接口边界表、行为边界、验收重点
├── constants/
│   ├── index.ts                  # 出口
│   ├── <domain>.ts               # 业务枚举、默认模板、排序、路由 key
│   └── icons.ts                  # 图标常量集中
├── hooks/
│   ├── index.ts                  # 出口
│   ├── use<Module>.ts            # 页面级聚合：选中态、面板开关、跳转、编排子 Hook
│   ├── useXxxDetailData.ts       # 并行请求 + allSettled + canceled 守卫的资源 Hook
│   ├── useXxxContactSpeech.ts    # 内容生成类副作用 Hook
│   └── useXxxScrollSync.ts       # 局部滚动/交互小 Hook
├── types/
│   ├── index.ts                  # 出口，重导出 service 与 view
│   ├── hooks.ts                  # Hook 入参/返回类型
│   ├── view.ts                   # 页面 ViewModel（如 XxxListItem、XxxTaskReminder）
│   └── service/                  # 接口原始 DTO 按子域拆文件
│       ├── customer.ts
│       └── ...
└── utils/
    ├── index.ts                  # 出口
    ├── <domain>MapperShared.ts   # 跨映射复用的共享逻辑（映射主体在根 mappers.ts）
    └── <domain>Routes.ts         # 路由拼装（buildXxxUrl，缺关键字段返回空由调用方兜底）
```

关键约定：

- `types/service/*` 一比一记录接口返回，`types/view.ts` 记录页面模型，两者不混；契约→视图映射全部收口根 `mappers.ts`，不在 `utils/` 里另起一套 Mappers。
- 映射函数不读全局状态、不请求接口；隐藏业务主键（`launchId`、`customerId`、`todoId`）全链路保留，不因 UI 没展示就丢字段。
- 路由拼装统一 `buildXxxUrl`，缺字段返回空串由调用方 toast 兜底，不在 util 里弹提示。
- README 必须含"接口边界表"（能力 / 方法与路径 / 用途）、"行为边界""验收重点"，让接手人不读源码也能对齐契约。
- 模块 README 至少说明：用途与入口、目录职责、运行前置、核心接口和状态、验证命令、常见坑和未覆盖边界。

### 分包业务模块标杆（receptionPrep，分包 + mock + 文档体系）

分包里「卡片页 + 详情页 + 弹层 + 接口契约 + mock 兜底」类模块（小程序 subPackage），在上述企业模块标杆基础上多三样：`detail/` 二级页、`docs/` 契约与 UI 文档、`mock/` 按域拆文件。目录照抄：

```text
src/subPackage/<module>/
├── index.tsx                   # 卡片页入口：装配 + 页面级编排
├── index.module.scss
├── README.md
├── service.ts                  # 接口封装：请求、数据源分流（local/apifox/真实）、模块缓存
├── store.ts                    # 模块状态（跨组件才建，页面态留在 hooks）
├── mappers/                    # 契约 → 视图模型唯一映射层；起步单文件 mappers.ts，超 500 行按域拆目录 + index.ts，调用方导入路径不变
│   ├── index.ts
│   └── <域>.ts                 # customer / focus / opportunity / target / plan / cards / evidence
├── components/<Component>/     # 核心业务组件：直接对应产品业务块；私有子组件放组件内 components/
├── commonComponents/           # 模块公共展示/交互，跨业务块或双页复用才进（判定见「组件两层体系」）
├── detail/                     # 二级页三件套（index.tsx/scss/config）；只做装配，数据与组件复用模块层，不复制卡片页状态
├── constants/                  # 文案、字典、图片 URL 按域拆文件（texts/dictionary/images/<域>）+ index.ts 汇出
├── docs/                       # 四册随模块走：prototype / interface / ui-design / test-case（口径见「模块文档体系」）
├── hooks/                      # use<Module> 页面编排 + 数据/资源子 hook + index.ts 出口
├── mock/                       # mock<域>.ts 按域拆文件 + index.ts（USE_MOCK 唯一开关）
├── styles/                     # 模块公共样式三件套，写法归 css-me
├── tests/                      # page.test.cjs 结构测试 + 样式/契约守卫测试
├── types/                      # api.ts 契约类型 + view.ts 视图模型 + index.ts 出口
└── utils/                      # 纯函数工具按域拆文件 + index.ts 出口
```

关键约定：

- `mappers/`（起步为单文件 `mappers.ts`）是契约与视图的唯一桥梁，mock 与真实接口共用同一套映射，接口就绪后 UI 零改动。
- `mock/index.ts` 只做 `USE_MOCK` 开关与按域 re-export，`mock<域>.ts` 一域一文件，fixture 与契约返回示例同构。
- `docs/` 跟模块走：接口口径、UI 规格、组件走查都沉淀在模块内，不散到根目录。
- 跨目录导入一律 `@/` 别名，同文件夹才用相对路径；各层 `index.ts` 只做索引不写实现，子层文件不对外直引。

### 组件两层体系（components / commonComponents）

分包模块组件分两层，防止核心业务定位被公共件淹没：

| 层                  | 收什么                                                                                 | 边界                                                                                               |
| ------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `components/`       | 直接对应产品业务块的核心组件，产品/测试提问题时应能按名直接定位                        | 自持私有子组件与局部状态                                                                           |
| `commonComponents/` | 跨业务块或跨页面复用的公共展示与交互（底部操作区、区块头、抽屉、骨架屏、空态、加载态） | 收业务数据和回调，但不做完整业务流程、不请求接口、不含 hooks/utils/types/constants、不嵌套分类目录 |

新增组件按序判定：直接对应核心业务块 → `components/`；否则被多个业务块或两个页面复用 → `commonComponents/`；否则留在所属业务组件内部。

- 只服务单个业务组件的子组件放该组件自己的 `components/`，不为目录统一提前提升。
- 提升下沉双向：业务组件被第二处复用才升 `commonComponents/`；公共组件退化到只服务一个业务块时下沉回去。
- 页面负责判定当前状态（加载/空/有数据），公共组件只渲染对应形态。

### 文件规模与拆分

- `service.ts`、`store.ts`、`mappers.ts` 超过 **500 行**就拆成同名文件夹：`service/<域>.ts` + `service/index.ts`；`index.ts` 只做 re-export 索引，调用方 `from '@/subPackage/<module>/service'` 的导入路径不变。TS/TSX/SCSS 单文件同以 500 行为治理阈值。
- 拆分按业务域（如 `service/opportunity.ts`、`service/plan.ts`），不按行数机械切块；类型同理按域拆。拆出的子文件内部辅助函数默认模块私有，跨文件复用才 export。
- 存量超标文件（如 audioEdit `service.ts` 587 行）在**下一次实质改动时顺手拆**，不专门立项重构。
- 测试文件与被测代码**同一提交入库**：功能提交必须包含对应测试改动，不允许测试长期留在暂存区或工作区不提交。实测教训：测试桩没随提交入库，提交后的代码跑测试必挂，等于没有回归防线。交付前 `git status` 检查 `tests/` 下无未跟踪、未暂存的测试文件。

### 模块文档体系

模块内 `docs/` 按四册建，跟模块走、不散到仓库根；体量大到不适合入库的资料（完整 PRD 包、历史契约快照、重型测试归档）放外部文档库，模块 README 登记外部路径：

| 册           | 内容                                                                                                                          |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `prototype/` | 产品原型：PRD 摘要、原型截图、需求说明；与 UI 稿冲突时以 UI 稿为准                                                            |
| `interface/` | 接口定义（路径/入参/出参/字段口径/联调待确认项）+ 契约核对记录（`<主题>-核对-<日期>.md`：逐接口结论 + 新旧对照 + 待确认清单） |
| `ui-design/` | 按主题编号分册：还原明细（组件与规格）、样式公式与层级规范、弹层/抽屉逐帧规格、组件走查（截图 + 数据来源溯源）                |
| `test-case/` | 测试用例与验收资料：单元/契约/联调自测口径、人工验收清单、验收脑图                                                            |

README 骨架固定四段：**设计源优先级声明** → 接口边界表 → 目录职责 → 验证命令。

设计源优先级声明（多稿并存时的裁决顺序，写进每个模块 README 顶部）：

1. spec 评审确认的口径优先于一切设计稿；
2. UI 设计稿（有节点的）为视觉第一优先：尺寸、文案、布局、颜色以节点 metadata 为准；
3. 产品稿只补 UI 稿未画出的结构与细节，并标注「待 UI 稿补充确认」；
4. 两稿冲突时以 UI 设计稿为准。

### mock 体系（接口未定稿阶段）

- `mock/index.ts` 是**唯一开关**（`USE_MOCK`）与索引入口；`mock/mock<域>.ts` 一域一文件。
- 数据源开关升级形态：路由参数 `?useMock=local|apifox` 切本地 fixtures / 云端 Mock，默认走真实接口；静态设计稿验收用 `?preview=full|partial|empty` 渲染三态，不改业务代码。开关解析放 `mock/` 内，不散进 hooks 或页面。
- fixtures 与契约返回示例**同构**：字段名、嵌套、枚举、可空性照契约写，只替换演示值。
- mapper 只有一套（`mappers/`），mock 与真实接口共用；接口就绪后把开关置回真实数据源，**UI 零改动**。
- 真实顾客路径用 mock 补齐演示内容时，逐项写清「真实值优先、缺失才补」，避免把演示数据当真实数据。

### 验证资产分层

| 层     | 放哪                        | 内容                                                                                                             |
| ------ | --------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 入库层 | 模块 `tests/`，随功能同提交 | `page.test.cjs`：结构断言（文案、类名、弹层开关、跳转链路），node:test + `require` 桩 + JSDOM 渲染，不引测试框架 |
| 归档层 | 模块归档目录，按需手动跑    | 重型守卫脚本：样式编译对比、视觉契约、UI 校正等；跑完把结论写回交付说明                                          |

设计取舍：入库层保证「提交即可运行、可回归」；重型脚本依赖特定基线或环境，留在归档层避免拖累仓库。往期无测试的模块不强行补测，新模块与重构模块按此标配。

### 组件与命名

- 组件按业务区块和交互职责拆；有独立状态、样式、验收点或接口动作才进 `components/`；**组件默认纯展示**（`index.tsx` 管视图），只有自持复杂编排（状态机、拖拽、轮询）时才建组件内 hook 文件。
- 命名：变量函数 `camelCase`（动作前缀 handle/on/build/map/is/has/to）、组件与类型 `PascalCase`、常量 `SCREAMING_SNAKE_CASE`；类型表达业务语义（`NextVisitViewModel` 不是 `CardProps`）；文件夹沿用项目风格。
- 注释以中文短注释为主，解释业务意图、兼容原因、状态机边界，不复述代码（详见 ui-me 中文注释契约）。
- 页面入口少写临时对象，先把 DTO 映射成稳定 ViewModel；三个以上字段共同决定展示时抽命名派生函数；React 项目续读 `react-me`。

### 存储与副作用

持久化走 typed storage adapter，不到处直读 `localStorage`/`sessionStorage`；定时器、监听、播放器、图表成对清理（详见 react-me）。

### 反模式

- 不把业务逻辑塞进 `index.tsx`；不把接口事实写成 UI 文案兜底。
- 不为一次性样式新增 token 或 mixin；不把所有 hooks 堆进一个巨大文件。
- 不在小修时顺手改目录结构；不把历史项目命名强套当前项目。
- 不为纯展示组件套 hook 文件；不给每个组件都建 `index.hook.ts`（新模块页面编排一律 `hooks/use<Module>.ts`）。
- 不把 DTO→ViewModel 映射散落在 `utils/` 和组件里，统一收口根 `mappers.ts`。
- 不新建两分册 scss（`_tokens.scss + _mixins.scss`）的老写法，模块样式统一三件套（写法见 css-me）。
- 不把接口 DTO 和页面 ViewModel 混在同一类型文件；不在 mapper 里丢隐藏主键；不在路由 util 里弹 toast。

### 输出格式

结论摘要 → 修改文件清单 → 结构建议 → 命名和分层判断 → 可执行步骤 → 验收方式。

## react-me：React 组件架构实践

> 适用：React / Taro React。通用原理用名词激活（helper-me/SKILL.md 名词表：最后写入获胜、清场、单一可信来源、最小订阅），本节只留个人词汇与组合惯例。渲染与组合细节用 `vercel-composition-patterns`、`vercel-react-best-practices` 收敛。

### 组件边界（业务红框）

组件按业务红框建模，不按视觉微组件拆：

- 用户抱怨"组件太细、不好维护"→ 按业务区块重建；多模式用明确命名的业务组件，不用布尔 props 堆。
- 跨模块复用的稳定结构（标题栏、右侧卡片、筛选栏、空态）抽公共组件；模块专用内容不强行泛化。
- JSX 里散落的默认值、排序、字段兼容上移到 constants / normalize / mapper。
- 黄金案例：护理服务报告 6 个业务区块组件（`ReportSectionHeader`、`ComfortMemory`、`NextCareGuide`、`CareContinuation`、`HomeCareProducts`、`NextVisitCard`）胜过十几个视觉微组件——维护者按业务区域找文件，而不是在 `Item`、`Card` 之间猜职责。

### 数据编排 Hook（个人组合惯例）

原理归名词表，这里只留 React 落地口径：

- 并行请求：`Promise.allSettled` + `canceled` 守卫 + 卸载作废；**并发翻页/搜索必须用自增序号 ref（最后写入获胜）——canceled 只能防"上一次"，拦不住并发**。
- 刷新不闪空：外部 refreshVersion 触发的刷新失败或未返回不清旧数据；统计数字走独立接口，不从列表数量反推。
- 回调读最新值：ref 镜像 state（写 state 同步写 ref）；防连点用 `lockRef` + `submitting` state 双保险，`try/finally` 复位。**接口失败不改本地成功态、不关面板、只 toast**。
- 入口路由参数只固化一次：`useRef(parse(params))` + `xxxHandledRef` 标志位，用户手动操作后永久让位，不随列表刷新反复消费。
- 身份维度组合 key（`${tenantCode}-${orgId}-${employeeId}`）作可复用列表组件的 `key`，身份变化即重建隔离缓存；身份未就绪用占位 key 不发请求。
- 失效面板自清理：监听列表，当前选中项 id 不存在就自动关闭面板。
- 计时器/监听/播放器/SSE 在 unmount cleanup 成对清理；纯跳转、配置请求、局部滚动各自独立小 hook，聚合 hook 只做编排。

### 反模式

- 不按图标、按钮、文字行建组件；不用 `isA/isB/showX` 堆多模式组件。
- 不把接口原始字段写进展示组件；不为一次性小样式新建组件或 token。
- 不为"可复用"提前抽象没有复用证据的模块专用内容。
- 不在分页/搜索场景只用 `canceled` boolean 防竞态。
- 不在刷新时无条件清空旧数据；不把接口失败当成功。
- 不省略计时器、监听、播放器和 SSE 流的 unmount 清理。

## zustand-me：Zustand React17 模块状态

React 17 项目的 Zustand 状态设计、修复和评审（Taro H5、小程序分包、Umi/Max、AI 会话模块）。核心：先判断生命周期，再决定是否进 store——**多个组件使用不等于必须全局化**。

### 状态归属

| 状态类型                                          | 放置位置                                   |
| ------------------------------------------------- | ------------------------------------------ |
| 纯 UI 临时态（弹窗开关、输入、局部 loading）      | 组件或 hook                                |
| 页面查询态（日期、筛选、分页、tab）               | 页面 hook、URL、表单                       |
| 跨组件业务态                                      | 模块 Zustand store                         |
| 接口实体                                          | service + mapper（字段口径先在接口层稳定） |
| 跨页面缓存                                        | store 或 typed storage adapter             |
| 外部注入态（App SDK、qiankun 主应用、微信登录态） | wrapper / adapter                          |

### 设计规则

- store 按业务模块拆，不按组件树机械拆；action 用业务动词、只编排状态和 service，不写 DTO→entity 的复杂字段映射。
- 组件用 selector 订阅最小字段，禁止裸 `useStore()` 订阅整棵 store；多字段优先组合 selector 或拆子组件。
- 页面卸载、门店切换、日期切换、用户切换都要有清理或刷新口径；Taro 页面生命周期与 React hook 生命周期分开考虑。
- 历史命名如 `gloablStore` 无需求不重命名。

### 典型场景（个人项目词表）

#### 多区域仪表盘与列表模块

| 状态                     | 归属                            |
| ------------------------ | ------------------------------- |
| 当前门店、日期、右侧页签 | 页面 hook                       |
| 左侧状态筛选             | 页面 hook，仅本地过滤"我的"页签 |
| 列表、统计、日历标记     | resource hook 调度              |
| 新增、修改、状态操作     | mutation hook 调度              |
| 字段映射                 | mapper 或 utils                 |
| 会话级缓存               | store                           |

经验：统计和日历标记固定当前登录用户，右侧页签只影响列表；变更后要刷新列表、统计、标记三类，不靠组件自己猜。

#### 小程序业务和 AI 会话

token/userInfo/tenantConfig/dictionaryObj 归 `gloablStore`；AI 后台任务归任务 store 或入口 hook；AI 会话消息、SSE 状态归独立 `aiAgent` store——流式消息、step、协议指令、suggestion 要拆层，不让一个 action 同时做请求、解析、渲染和 UI 兜底。tabbar 数量与选中态归 tabbar store。

#### 媒体编辑小程序

播放状态、裁剪区间归页面 hook 或局部 store；任务创建/轮询/取消由 hook 编排；波形等资源缓存归模块 store（可跨页面生命周期保留）。经验规则：

| 规则                                   | 原因                                           |
| -------------------------------------- | ---------------------------------------------- |
| 模块 reset 不默认清资源缓存            | 用户离开再回来可复用，避免重复请求             |
| 任务与资源身份用稳定主键               | 恢复和缓存都以稳定主键索引，缺失才兼容历史字段 |
| 轮询、媒体实例、定时器由页面 hook 清理 | store 不持有不可序列化运行时资源               |
| 任务完成停轮询但保留结果态             | 结果提示、已播放、结果展示都依赖完成态         |

### 清理口径

| 场景         | 动作                                 |
| ------------ | ------------------------------------ |
| 页面卸载     | 清一次性 UI 态、轮询、媒体实例       |
| 作用域切换   | 清列表、关联维度、统计、标记相关缓存 |
| 用户切换     | 清 token、身份、字典派生状态         |
| 查询条件切换 | 刷新列表和时间轴，不污染全局统计口径 |
| 任务完成     | 停止轮询，保留结果或按业务清理       |

跨页面缓存必须走 typed storage adapter（集中解析、过期、默认策略），禁止页面和 store 各自 `JSON.parse(localStorage.getItem(...))`。

### 反模式

- 不裸订阅整棵 store；不在 store 混写 DTO→entity 转换；不让全局 store 存一次性弹窗临时态。
- 不为单页面局部状态建跨项目通用 store；不把 React 18 / React Compiler 建议套进 React 17 项目。
- 不重命名历史 `gloablStore`；不让轮询、媒体实例、SSE 在页面离开后继续跑。

## vue-me：Vue 与 React 分叉点

### 使用定位

本专题只收 Vue 与 React 真正分叉的几条。目录、命名、质量门、业务 UI 契约仍走 `web-me`、`ui-me`、`quality-me`、`css-me`。

### 何时读本专题

| 信号                                          | 动作                                |
| --------------------------------------------- | ----------------------------------- |
| `.vue` 单文件、Options API、`Pinia`、`v-html` | 读本专题，再回通用前端专题          |
| React / Taro / Zustand                        | 不要用本专题替代 `zustand` / `taro` |

### 分叉规则

#### Options 大文件

超过约 400 行的 Options SFC 按「模板 / 状态 / 请求 / 副作用」拆：

- `setup` 或 composable 承接请求与生命周期。
- 模板只绑定已映射的视图模型。
- 不要在 `methods` 里堆字段映射和路由跳转。

React 侧对应的是 `index.tsx` + 页面编排 `hooks/use<Module>.ts`，映射收口 `mappers.ts`，规则在 `web-me`。

#### `v-html`

| 来源                         | 处理                            |
| ---------------------------- | ------------------------------- |
| 内部白名单函数输出的固定片段 | 可接受，但优先改成组件          |
| 接口、AI、富文本、用户输入   | 必须消毒、标注来源、补 XSS 测试 |

不要把 `v-html` 当普通插值。React 的 `dangerouslySetInnerHTML` 同一条门禁，收在 `quality-me`。

#### Pinia vs Zustand

| 场景                 | 选择                                  |
| -------------------- | ------------------------------------- |
| Vue 模块跨组件业务态 | Pinia store，selector 订阅最小字段    |
| React 模块           | Zustand，走 `zustand-me`              |
| 纯 UI 临时态         | 组件内 ref / reactive，不进全局 store |

清理口径两边相同：卸载时停掉轮询、定时器、WebSocket；不要把不可序列化运行时对象放进 store。

### 反模式

- 不把 React 目录规范整份抄进 Vue 项目。
- 不把 Pinia 和 Zustand 规则混写成一份。
- 不在业务模板直接渲染未消毒 HTML。
- 不把本专题扩成完整 Vue 风格指南。

### 输出格式

1. 结论摘要（哪条分叉命中）
2. 修改文件清单
3. 与 React 专题的分工
4. 可执行步骤
5. 验收方式

## node-bff-me：Node BFF 与后台服务

### 使用定位

用于 Node 服务层，不是产品前端壳。覆盖两类形态（各有真实项目背书）：

1. **独立 HTTP 服务**（Fastify）：入口 `src/app/server.ts`，`src/modules/<domain>/` 分层。
2. **薄聚合 BFF**（Next.js App Router）：`src/app/api|v1/**/route.ts` 只做鉴权、编排、字段裁剪；重活放 `src/lib/<domain>/` 或下游服务。

动工前先读项目 `AGENTS.md`——项目级约定（端口、文案语言、提交 scope）以它为准，本专题只管跨项目通用规则。`CLAUDE.md` 只写一行 `@AGENTS.md`，保持单事实源。

### 先判定形态

| 信号                                                                              | 形态           | 默认动作                             |
| --------------------------------------------------------------------------------- | -------------- | ------------------------------------ |
| 依赖含 `fastify` / `express` / `koa`，有 `src/app/routes/*.route.ts`              | 独立 HTTP 服务 | 锁 route → schema → service → worker |
| `src/app/v1/**/route.ts` 或 `src/app/api` + `src/lib/<domain>` + `test:contracts` | 薄聚合 BFF     | 锁契约测试，保持 route 薄            |
| 同仓既有 React UI 又有契约测试 / mock 网关                                        | 仍按 Node BFF  | 不要切到产品壳专题                   |

### Fastify 独立服务标杆

```text
src/app/                  # server.ts 启动、app.ts 装配、plugins/、routes/（健康/容量/内部任务）、alerting/
src/modules/<domain>/
  routes/                 # 模块公开接口
  schemas/                # Fastify JSON Schema + FromSchema 推导类型
  services/               # 任务编排、状态流转
  workers/                # ffmpeg 等重执行、重试、并发
  infrastructure/         # 对象存储、回调、repository、权限适配
  domain/                 # 状态机、不变量、纯函数
  tests/                  # contract / property / unit 三层
```

依赖方向铁律：`app → routes → services → workers/infrastructure/domain`。对外能力从 `src/modules/<domain>/index.ts` 暴露。

| 层                 | 职责                                                  | 禁止                    |
| ------------------ | ----------------------------------------------------- | ----------------------- |
| `app.ts` / plugins | 启动、插件、错误处理、鉴权钩子                        | 写业务状态机            |
| `routes/`          | 绑定方法、调 schema、转交 service                     | 直读对象存储或队列      |
| `schemas/`         | JSON Schema 是请求入参权威，类型用 `FromSchema` 推导  | 藏业务规则              |
| `domain/`          | 任务状态机只活在这里（创建/排队/处理/成功/失败/取消） | 发 HTTP、碰 SDK         |
| `services/`        | 编排存储、下游、事务边界                              | 面向 UI 的文案          |
| `workers/`         | 异步执行与回写                                        | 被产品页直接调用        |
| `infrastructure/`  | 签名/上传/下载集中一个 adapter，业务只拿稳定资源主键  | route 里 new SDK 客户端 |
| `tests/`           | 锁请求响应形状和状态迁移                              | 依赖真实云账号          |

权限逻辑从 handler 迁到 hook 前，必须先补契约测试，确保 401/403/400/404 响应结构不变。handler 成功分支直返 `ApiEnvelope<T>`，需设状态码才用 `reply.code(...).send(...)`。

### Next.js 薄聚合标杆

`route.ts` 只做鉴权、参数校验、转发、字段裁剪——聚合层膨胀会把 UI 和 worker 绑死。业务能力按 `src/lib/<domain>/` 组织：`schemas.ts` + `client.ts` + `api-response.ts` + `providers/`，一个域一个目录。

教训（真实发生）：独立小 BFF 仓库会被收编——某独立识别服务最终以 `lib/<domain>` 形态并入宿主单仓，独立仓库只剩空壳。**新起 BFF 前先问：能不能直接做成宿主 BFF 的 `lib/<domain>`？** 只有独立部署、独立扩缩需求才值得单仓。

Next 侧契约测试不构建整个 next：用专用 `tsconfig.<lib>-test.json` 把 lib 编译到 `.tmp-<lib>-test/`，再 `node --test` 跑编译产物。mock 网关用脚本管理（`mock:xxx:reset / test / density / endpoint:on-off` 系列），进程内 Map 或 better-sqlite3 模拟下游 DB；联调成立后删运行时 mock，测试夹具留测试文件。

### 测试与验证门禁

测试栈：原生 `node:test` + tsx，不引 jest/vitest。Fastify 侧脚本形态：`node --import tsx --test src/modules/*/tests/{unit,contract,property}/*.test.ts`。

改动分级门禁：

| 改动                               | 至少跑                                                     |
| ---------------------------------- | ---------------------------------------------------------- |
| TS、schema、路由                   | `test:contracts` + `type-check` + `build`                  |
| worker、service、storage、任务状态 | 上行 + `test:unit` + `test:property`                       |
| 外部集成（对象存储、回调）         | 上行 + `verify:integrations --env-file .env`，跑不了要说明 |
| 仅 Markdown                        | `git diff --check`                                         |

env 加载用 Node 原生 `node --env-file-if-exists=.env`，不引 dotenv。

### 文案与日志中英文规则

- 给人看的（错误描述、日志说明、接口 `msg`/`userMessage`）默认中文；给机器匹配的（方法名、环境变量、`errorKey`、`eventCode`、`mode`、`jobId`、枚举值）保留英文。
- 改错误文案时优先保留稳定的机器字段，不依赖英文句子做业务判断。
- 日志排障文案写业务步骤、当前任务位置、下一步排查方向，不写裸的 `xxx failed`。
- 日志 `message` 不带 `[服务名][端口]` 重复前缀；服务名、端口、模块放结构化字段。
- 生产日志只输出结构化摘要：`module`、`url`、`method`、`code`、`requestId`、任务主键。不打印完整 body、签名 URL、cookie、token。

### 链路与安全边界

- 典型拓扑：`前端 → Java / mock BFF → Node BFF`；前端不直连 Node BFF，不恢复旧直连接口。
- 内部任务查询/取消统一 `?jobId=` 查询参数，不用动态路径变量。
- 提交用 Conventional Commit（中文 bullet 正文，scope 按项目域）；不提交 `.env`、密钥、真实产物（`output/`、`.ffmpeg-runtime/`）。
- Windows 中文读写：PowerShell 先显式 UTF-8；写入失败先查 diff 再换方式，不在同一高风险命令上反复试错。

### TypeScript 迁移

1. 先补或跑 `test:contracts`，用失败用例钉住当前 JSON。
2. 再收窄类型：从边界 DTO 往里推，不一次改完全仓 `any`。
3. 每步保持 `type-check` 与契约测试可运行。
4. mock 与真实适配器类型共享，不各写一套。

不要「先全部改成严格类型再补测试」。没有契约，类型迁移无法证明行为没变。

### 反模式

- 不把含 `package.json` 的 Node 服务当前端项目处理。
- 不让产品页直连 worker 或对象存储。
- 不在 route 里写状态机和 SDK 调用。
- 不一次改完全仓类型。
- 不把真实下游凭据写进 mock。
- 不为独立 BFF 单开仓库而绕过宿主 `lib/<domain>` 收编判断。
- 不在本专题写真实仓库名、私有路径或环境端口。

### 输出格式

1. 结论摘要（形态 + 边界）
2. 修改文件清单
3. 契约与测试
4. 可执行步骤
5. 验收方式
6. 未改事项

## bug-me：最小改动修复

只解决当前目标的直接阻断点，目标是最小可审阅 diff，改到阻断解除就停。若目标其实是蓝图、目录规范或新 skill 提炼，切对应 skill。

### 铁律

- Fail fast and loudly：不加 fallback 吞错，不让 UI 显得比真实更平静。
- 测试只在"先证明当前 bug 会失败"时写，不为修复扩测试基建。

### 动手前：阻断链三分法

| 分类        | 判断                           | 处理     |
| ----------- | ------------------------------ | -------- |
| `required`  | 不做它，当前目标仍失败         | 本轮实现 |
| `optional`  | 更整洁但不阻断                 | 列为后续 |
| `off-scope` | 重构、文档、相邻问题、测试基建 | 本轮不做 |

### 定位：最小失败原语四问

| 问题                     | 输出                                      |
| ------------------------ | ----------------------------------------- |
| 真实失败是什么           | 一个可复现的失败断言/日志/请求/页面行为   |
| 最短调用链是什么         | 入口、直接调用方、一层被调方              |
| 必须保持不变的契约是什么 | 字段、状态码、返回结构、UI 行为、命令输出 |
| 最小可验证切口是什么     | 单测、契约测试、命令、人工检查点中的一个  |

### 对抗性修复审查（动手前和收尾前各问一遍）

吞掉真实错误？改变原业务契约？扩大文件边界？把环境问题写成代码绕过？为了"更优雅"抽象？——命中任何一条：删 fallback 改显式报错 / 补契约测试 / 只留 required 文件 / 改为说明命令依赖 / 留为后续。

### 受控诊断打点（用户只要"看看为什么/debug"时）

1. 只在指定文件、直接调用方或一层被调方加最少 console，统一 `[DEBUG]` 前缀。
2. 诊断模式禁止改业务分支、返回值、异常处理、请求参数、状态写入、依赖版本、目录结构。
3. 用户贴新日志只调诊断点缩小范围；用户说已找到原因或删 console 时，先删 `[DEBUG]` 及 eslint 注释再继续。
4. 只有明确要求修复时才从诊断切回修复。

### 反模式

- 不顺手清理；不把一个 Bug 修成通用框架。
- 不捕获异常后发明新 UI 状态解释它。
- 不改脚本名、依赖版本或目录结构来显得更整齐。
- 不把真实外部接口混进轻量测试，除非目标就是集成验收。

### 输出格式

结论摘要 → 根因链路 → 修改文件清单 → 必须改的原因 → 测试命令和结果 → 未改事项。

## quality-me：Project Quality Gate 质量门禁

改动后的收尾验证门禁。原则：只格式化本轮 touched files；优先项目已有脚本；命令失败报告真实错误，不声称通过。

### 提交前只读检查

基于 `git status`、`git diff`、`git diff --cached` 涉及的文件检查；不格式化、不修复、不写文件（用户明确授权除外）；每项给结论，不适用的说明原因；结尾问用户要我改还是手动处理。

重点检查七类：

| 类别     | 检查点                                                                       |
| -------- | ---------------------------------------------------------------------------- |
| 调试残留 | `console.log`、`[DEBUG]`、临时 `try/catch`、调试节点、`debug/temp/test` 标识 |
| 语法类型 | 模板拼接错误、未使用 import、TS 类型缺口、RPC 必填参数缺失                   |
| 边界条件 | 空引用、接口字段判空、小程序 rect/DOM 判空、`if ([])`、`res \|\| 1` 误兜底   |
| 行为风险 | 临时 return、展开覆盖、同步删除后引用未更新、路由跳转/卸载后 setState        |
| 资源清理 | `removeEventListener`、`clearTimeout/Interval` 成对                          |
| 环境污染 | 测试 URL 硬编码、公共模块混子应用定制、Vue scoped 遗漏、手写浏览器前缀       |
| 临时代码 | 注释掉的调试块、过时注释、TODO、待产品确认                                   |

### 文件类型门禁

| 类型                | 动作                                                                                                                             |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| TS/TSX/JS/JSX       | Prettier → ESLint fix → 相关测试                                                                                                 |
| SCSS/CSS Modules    | Prettier → Stylelint fix → 样式契约或截图验收                                                                                    |
| JSON                | Prettier 或 parse                                                                                                                |
| lint/formatter 配置 | 先解析配置再跑最小检查                                                                                                           |
| 服务端 JS           | `node --check` + `node --test` 或契约                                                                                            |
| Markdown/skill      | UTF-8 可读、frontmatter 有 name/description、链接的 reference 存在、无乱码（Windows 中文环境 Python 先设 `$env:PYTHONUTF8='1'`） |

### 验证设计（改完先想清楚验证什么）

1. 先验证用户当轮明确要求；再验证本轮 touched files 的路径、导入、类型引用和关键分支。
2. 纯函数优先最小输入输出用例；接口字段优先 mapper/contract 测试；UI 还原记录 URL、截图、设备、人工验收点。
3. 用户明确跳过构建/lint 时，改用 UTF-8、冲突标记、行尾空白、`git diff --check` 等轻量检查。
4. 报告必须区分已验证项和未跑项及原因；不把静态检查说成真机验收，不把截图相似说成联调完成。

两条提交前门禁（准备提交、或工作区混着他人/历史改动时用）：

- **纯暂存态验证**：`git stash push --keep-index` 后跑测试，确认「只提交暂存区」的快照自身可运行（测试桩、配套断言都已入库），跑完 `git stash pop` 恢复。教训：测试桩留在工作区没进暂存区，提交后的代码跑测试必挂。
- **独立 TS 诊断**：项目自带 `tsc` 版本旧、或被 `node_modules` 的 `.d.ts` 报错淹没时会**漏报** src 下真实类型错误。判定基线用编辑器（或独立新版诊断，如 `npx -y -p typescript@5 tsc -p tsconfig.json --noEmit`）过滤出目标模块的错误数，不拿旧 CLI 的「0 错误」当通过证据。

### 日志与例外

- 禁止长期 `console.log`/`debugger`；请求层禁止打印完整请求响应；生产日志只出结构化摘要（module/url/method/code/requestId）。
- ESLint 长期关闭必须写范围、原因、退出条件（常见：`exhaustive-deps`、`no-console`、`no-explicit-any`、`vue/no-v-html`）。
- Electron/PDF 不单开专题：IPC 与 preload 暴露面最小；影像与桌面构建走独立产物。

### 反模式

- 不只跑测试跳过格式和 lint；不在 dirty tree 全量格式化无关文件。
- 不把失败命令包装成通过；不为通过检查顺手改无关文件。
- 不新增 formatter 后忽略 `.prettierignore`/Stylelint ignore。
- 不因是文档改动跳过 UTF-8 和 frontmatter 检查。

### 输出格式

结论摘要 → 修改文件清单 → 改动目的 → 可执行步骤 → 验收方式 → 未改事项（含未跑检查与原因、剩余风险归属本轮还是历史）。

## review-me：个人 React Review 审查体系

### 定位：与上游 skill 的分工

- `vercel-react-best-practices`（上游原版，不修改）：70 条性能规则，机制索引，**写新代码 / 重构 / 性能优化**时用。
- 本节：71 条本地规则（R01-R71），场景索引，**审代码 / 审 PR / 复盘**时用。
- 两层同时生效：命中本层报 R 编号，命中上游报 rule-id；同一问题两层都命中时只报一次（见文末映射表）。

### 输出规范

- 分级：P0 错误结果/明确故障/安全风险；P1 高概率隐患/重要链路不完整；P2 影响质量与体验；P3 风格与一致性，可提但不先提。
- 每条发现用四段式：这里有什么问题 → 违反什么原则 → 会导致什么后果 → 建议先改哪一刀。
- 先归类再展开，先 P0/P1 再补 P2/P3。

### 扫描索引（按本次影响范围选取）

从本次 diff、相关调用方与失败路径开始；以下五层是检查索引，不是每次必走的流程。明确要求全面审查，或发现跨层影响时，再完整遍历；保留本次影响范围内的安全、权限、契约和失败路径检查。

1. 职责与边界：这个组件/hook 负责什么，塞了几类职责。
2. 状态与数据流：直接改 state、派生状态、双数据源、状态粒度。
3. 渲染与交互：key、条件渲染、冒泡串扰、重渲范围。
4. 副作用与异步：依赖、loading/error 闭环、竞态、取消、cleanup。
5. 性能/安全/体验：热点、XSS、状态可区分、键盘可达。

### 71 条规则速查（R 编号 ↔ 名词簇，定义细版见外部答案键速查表）

| 名词簇                               | 覆盖 R 编号                       | 一句话簇义                                                                                            |
| ------------------------------------ | --------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 单一可信来源                         | R01、R26、R27、R07                | 同一业务事实只维护一份主状态；搜索条件与请求模型不各说各话                                            |
| 派生与状态纯度                       | R02、R03、R04、R05、R06、R08、R67 | 派生值算不存；不可变更新；state 不存 JSX；setState 非同步；粒度不过粗；写入前过业务约束               |
| 事件与副作用                         | R09-R16                           | 一个动作一个意图；传播可控；effect 只同步外部事实且依赖真实；cleanup 对称；反馈闭环；第三方实例分层   |
| 请求与恢复                           | R17-R24、R65                      | 请求入口统一；try/finally 收口；error≠empty；旧请求不覆盖新结果；失败有恢复路径；独立请求并行         |
| 列表与搜索区                         | R25、R28-R32                      | 稳定 key；重置是状态回收；selectedRows 生命周期显式；columns 是热点；复杂搜索区转 schema 驱动         |
| 性能与热点                           | R33-R40、R66                      | 热点先行；第一刀切边界不堆 memo；重型输入稳定；按需加载；不做形式优化；条件渲染不用 && 兜数字         |
| 工程化与抽象                         | R41-R48                           | 长文件看职责数量；hook 按作用域拆；基础组件防业务污染；真抽象有稳定契约；命名支持建图；重构给最小路径 |
| 安全与体验                           | R49-R56                           | 危险内容先消毒；原生语义元素；四态可区分；错误助恢复；键盘可达；同类页面一致                          |
| Review 输出自律                      | R57-R64                           | 开场报扫描方法；先 P0/P1；压四段式；说"这是 X 类问题"不说"感觉不对"；备 20/60/90 秒三版               |
| maka 实战（通用 review，超出 React） | R68-R71                           | 见下节，逐条保留                                                                                      |

#### R68-R71（maka 实战，逐条保留）

- R68 测试有效性：fixture 形状 ≠ 生产 producer 真实发出的形状时，测试证明的是 fixture 而非系统。
- R69 write-only 机制按死代码审查：参与不进任何决策的状态与记录，读起来像仍在参与。
- R70 哨兵值按真实形状写：首图/初始实体往往是 0、空串、空对象，不是 undefined。
- R71 交付物一致性：PR 正文/Summary/Checklist 与 diff 矛盾 = P1。

### R 编号 ↔ 上游 rule-id 映射（两层都命中时只报一次）

| 本地      | 上游                                                                   | 关系                                            |
| --------- | ---------------------------------------------------------------------- | ----------------------------------------------- |
| R02       | rerender-derived-state-no-effect / rerender-derived-state              | 同题                                            |
| R11       | rerender-move-effect-to-event                                          | 同题                                            |
| R12       | rerender-dependencies                                                  | 互补：本层"别骗 linter"，上游"用原始值减订阅面" |
| R36       | rerender-memo / rerender-memo-with-default-value                       | 本地带 columns/options 场景                     |
| R06 / R38 | rerender-split-combined-hooks / rerender-defer-reads                   | 部分重叠                                        |
| R39       | bundle-dynamic-imports / bundle-conditional / bundle-defer-third-party | 同题                                            |
| R17       | client-swr-dedup                                                       | 同题不同解：架构收口 vs 库去重                  |
| R13       | client-event-listeners                                                 | 互补：对称清理 vs 去重共享                      |
| R40       | rerender-simple-expression-in-memo                                     | 同一反形式优化立场                              |
| R65       | async-parallel                                                         | 同题（补遗来自上游对齐）                        |
| R66       | rendering-conditional-render                                           | 同题（补遗来自原题考点）                        |

上游无对应（本地独有）：R01/R03-R10/R14-R16/R18-R35/R37/R41-R64/R67-R71。

### maka 真实复盘（规则 × 案例证据）

| 案例                                              | 规则                        | 机制一句话                                                   |
| ------------------------------------------------- | --------------------------- | ------------------------------------------------------------ |
| #4506 args 比对测试全绿但生产不可达               | R68                         | fixture 给 `args:{}`，生产 projector 永远发 `args:undefined` |
| #4518 审计文档留下 write-only 机制                | R69                         | 记录了 step/tool，但没有任何决策读它                         |
| #4514 夹具 createdAt:0 绕过 undefined 守卫        | R70                         | 首图真实形状是 0，守卫只查 undefined                         |
| #4506 正文"退出码不变"与 diff 的 0→1 测试翻转矛盾 | R71                         | Summary 与 Checklist 互斥，reviewer 按 P1 打回               |
| #4514 秒表 effect 依赖整个 snapshot，每次刷新归零 | R12 / rerender-dependencies | 依赖收到 `snapshot?.graphId`                                 |
| #4514 GRAPH_LIVE_STATUSES 与 stop 判定两份事实    | R01                         | 同一事实两处表达必然漂移，落到有测试跑道的一处               |
| #4517 Windows glob 吃 resolve() 反斜杠绝对路径    | R70 邻域（平台哨兵形状）    | 静默失配；索引 53→251 是最硬证据                             |
| #4514 连续两轮不同 e2e 红                         | R68 邻域（基线有效性）      | 基点落后在上游已修的 flaky 上复现，先 rebase 再下结论        |
| #4506 format:check 对 desktop 无证明力            | R71 邻域（验证覆盖）        | biome 豁免时验证行换 typecheck/lint                          |

### 配套资产（仅本机 Windows 路径，其他机器按名搜索）

- 训练题库（3 题 + 答案键）：`E:\guahub\docs\temp\Code Review\DRILL-题库.md`
- 训练台账：`E:\guahub\docs\temp\Code Review\Review-DRILL.md`
- 答案键速查表（R01-R71 逐条定义）：`E:\guahub\docs\temp\Code Review\React-Code-Review-64条规则速查表.md`
- 档案（21 万字完整手册，仅按需查阅、不整读）：`E:\guahub\docs\temp\Code Review\` 同目录
- 实战案例台账：`E:\guahub\docs\gh\fork\maka\PR-JOURNAL.md`
