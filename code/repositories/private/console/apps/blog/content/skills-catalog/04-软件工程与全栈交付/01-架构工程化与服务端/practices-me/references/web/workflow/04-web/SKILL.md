---
name: web-me
description: 前端模块结构与代码规范。Use when initializing or reviewing React, TypeScript, Taro, H5, or Umi modules, deciding directory structure, component boundaries, naming, JSDoc, index.tsx and index.hook.ts separation, constants, store, service, utils, types, styles, module README conventions, or 完整企业模块目录标杆（types/service DTO 分文件、utils 按子域拆 mapper、hooks 分层、README 接口边界表）.
---

# Frontend Module Standards

## 使用定位

用于确定前端模块目录、组件职责、命名、Hook 分层、类型、常量、样式和 README 口径。它服务于模块稳定开发，不负责业务需求裁决；需求裁决先走 `prd-me`。

## 默认目录

```text
module/
├── index.tsx
├── index.hook.ts
├── index.module.scss
├── index.config.ts
├── README.md
├── store.ts
├── service.ts
├── constants/
│   └── index.ts
├── components/
├── hooks/
│   └── index.ts
├── styles/
├── types/
│   └── index.ts
└── utils/
    └── index.ts
```

## 目录索引规则

流程页面、长任务模块和可复用业务模块默认保留 `types/`、`hooks/`、`constants/`、`utils/` 四类目录，并各自提供 `index.ts` 作为稳定出口。

| 目录 | `index.ts` 职责 | 使用规则 |
| --- | --- | --- |
| `types/index.ts` | 汇总 DTO、ViewModel、Props、状态类型 | 组件和 Hook 优先从 `types` 目录入口导入，避免深层路径扩散 |
| `hooks/index.ts` | 汇总模块共享 Hook | 根 `index.hook.ts` 保持页面聚合职责；可复用查询、轮询、资源 Hook 下沉到 `hooks/` |
| `constants/index.ts` | 汇总状态、路由 key、字典、默认值 | 常量按文件拆分，消费方优先走目录入口 |
| `utils/index.ts` | 汇总 mapper、guard、route、formatter 等纯函数 | utils 不读写全局状态、不请求接口；新文件必须补出口 |

轻量展示组件可以缩减为单文件 `types.ts` 或 `utils.ts`；一旦出现接口 DTO、路由参数、分页、弹窗动作或跨组件复用，就升级为目录 + `index.ts`。

## 分层规则

| 层 | 职责 | 禁止事项 |
| --- | --- | --- |
| `index.tsx` | 页面布局、组件组合、少量条件渲染 | 放请求、复杂计算、状态机 |
| `index.hook.ts` | 页面编排、事件处理、副作用协调 | 写纯展示 JSX |
| `hooks/` | 可复用数据、轮询、SSE、生命周期逻辑 | 混入无关工具函数 |
| `components/` | 独立业务区块、弹窗、卡片、时间轴 | 为每个小视觉元素建组件 |
| `store.ts` | 模块级跨组件状态 | 混入接口 DTO 转换细节 |
| `service.ts` | 请求入口和接口封装 | 写 UI 兜底逻辑 |
| `utils/` | 纯函数、格式化、转换、计算 | 做请求、读写全局状态 |
| `types/` | DTO、ViewModel、Props、状态类型 | 类型散落到组件内部 |
| `styles/` | token、mixin、公共样式 | 抽一次性样式 |
| `constants/` | 状态、事件、字典、枚举 | 把业务常量写在 JSX 里 |

## 新建模块骨架

按"默认目录"创建骨架，步骤：

1. 复制成熟模块或模板目录、改名；无模板时按目录树逐个创建。
2. 先创建 `types/index.ts`、`hooks/index.ts`、`constants/index.ts`、`utils/index.ts`，再按真实职责补子文件。
3. 占位用统一前缀（如 `Template`），全局替换为目标模块名。
4. `index.tsx` 只放布局，业务下沉到 `index.hook.ts`（轻量）或 `hooks/`（重模块）。
5. `store.ts` 起空骨架 `create<State>(set => ({...}))`，状态类型补到 `types/`。
6. `service.ts` 起统一请求封装骨架（自定义 Error + 业务 code 校验）。
7. 路由注册、分包配置等框架特定步骤见对应专题（如 `taro`）。

轻量模块（单入口、少量状态）保留 `index.hook.ts` 即可；重模块（多业务入口、任务状态机、复杂副作用）改用 `hooks/` 聚合层 + 子 hook 分层，分界参考"分层规则"。各项目可在模板目录里沉淀贴合自身技术栈的占位代码包，但结构规则以本 skill 为准。

## 流程页面拆分样板

列表 + 详情 + 记录 + 内容生成的流程页面适合作为分层样板：

- 页面入口负责左右布局、详情面板和动作面板组合。
- 列表、详情、记录、内容生成分别拆成 service DTO、mapper、Hook 编排和展示组件。
- `types/service/*` 记录接口原始形态，`types/view*` 记录页面模型，`utils/*Mappers.ts` 负责 DTO 到 ViewModel。
- 详情聚合接口一次返回多个业务字段（主体信息、扩展档案、关联清单、待办列表等）时，不再保留旧拆分接口作为主链路。
- 二级跳转和详情动作都依赖隐藏业务主键，类型和 mapper 必须显式保留，不因当前 UI 没展示就丢字段。

## 完整企业模块目录标杆

「列表 + 聚合详情 + 多记录区块 + 内容生成 + 外部带参入口」这类完整企业模块，推荐按下面这套目录组织。它把接口原始形态、视图模型、纯映射、请求、编排、展示彻底分层，是本人多个实战模块（顾客管理、复盘总结、回访邀约）收敛后的稳定标杆：

```text
module/
├── index.tsx                     # 只做左右布局与面板组合
├── index.hook.ts                 # 页面级聚合：选中态、面板开关、跳转、编排子 Hook
├── service.ts                    # 该模块全部接口封装（带 JSDoc 写清真实路径/方法/复用点）
├── README.md                     # 来源、组件定位、接口边界表、行为边界、验收重点
├── constants/
│   ├── index.ts                  # 出口
│   ├── <domain>.ts               # 业务枚举、默认模板、排序、路由 key
│   └── icons.ts                  # 图标常量集中
├── hooks/
│   ├── index.ts                  # 出口
│   ├── useXxxDetailData.ts       # 并行请求 + allSettled + canceled 守卫的资源 Hook
│   ├── useXxxContactSpeech.ts    # 内容生成类副作用 Hook
│   └── useXxxScrollSync.ts       # 局部滚动/交互小 Hook
├── types/
│   ├── index.ts                  # 出口，重导出 service 与 view
│   ├── hooks.ts                  # Hook 入参/返回类型
│   ├── view.ts                   # 页面 ViewModel（如 XxxListItem、XxxTaskReminder）
│   └── service/                  # 接口原始 DTO 按子域拆文件
│       ├── customer.ts
│       ├── customerContext.ts
│       └── ...
└── utils/
    ├── index.ts                  # 出口
    ├── <domain>Mappers.ts        # DTO → ViewModel 映射，按子域一域一文件
    ├── <domain>MapperShared.ts   # 跨映射复用的共享逻辑
    └── <domain>Routes.ts         # 路由拼装（buildXxxUrl，缺关键字段返回空并由调用方兜底）
```

关键约定：

- `types/service/*` 一比一记录接口返回结构，`types/view.ts` 记录页面模型，两者不混。
- `utils/*Mappers.ts` 每个业务子域一个映射文件，共享逻辑抽 `*MapperShared.ts`，映射函数不读全局状态、不请求接口。
- 二级跳转、详情动作依赖的隐藏业务主键（`launchId`、`customerId`、`todoId`），类型和 mapper 必须显式保留，不因当前 UI 没展示就丢字段。
- 路由拼装统一 `buildXxxUrl`，缺关键字段返回空字符串，由调用方 toast 兜底，不在 util 里弹提示。
- README 必须含"接口边界表"（能力 / 方法与路径 / 用途）和"行为边界""验收重点"，让接手人不读源码也能对齐契约。

## 组件拆分

1. 先按业务区块和交互职责拆。
2. 有独立状态、独立样式、独立验收点或独立接口动作时，进入 `components/`。
3. `components/ComponentName/index.tsx` 负责视图。
4. `components/ComponentName/index.hook.ts` 负责组件内部编排。
5. 只被单处使用的复杂弹窗和卡片也可以进入 `components/`。

## 命名规范

| 类型 | 规范 | 示例 |
| --- | --- | --- |
| 变量和函数 | `camelCase`，动作用 `handle`、`on`、`build`、`map`、`is`、`has`、`to` | `handleAddAppointment` |
| 组件 | `PascalCase` | `CalendarSidebar` |
| 常量 | `SCREAMING_SNAKE_CASE` | `DEFAULT_DURATION_HOURS` |
| 类型 | `PascalCase` | `AppointmentStatus` |
| 文件夹 | 沿用项目现有风格，新增模块优先语义清晰 | `components/CalendarSidebar` |

## 注释规范

导出函数、复杂状态机、兼容分支和重要副作用写 JSDoc 或短注释。注释补业务意图、边界和原因，不复述代码。

```typescript
/**
 * Build appointment cards for timeline rendering.
 *
 * Keeps service duration, consultant ownership, and visual stacking in one mapping step.
 */
export function buildTimelineCards() {}
```


## JavaScript / TypeScript 实践补充

- 页面入口少写临时对象和长表达式，先把接口 DTO 映射成稳定 ViewModel。
- 三个以上字段共同决定展示时，抽成命名清楚的派生函数或 mapper。
- 固定顺序、默认文案、静态预览数据放在 constants 或模块作用域，不放在 render 内。
- 类型优先表达业务语义，例如 `NextVisitViewModel`、`CarePlanBlockViewModel`，不要只写 `CardProps`、`ItemProps`。
- 业务组件对外暴露粗粒度 Props；内部小视觉元素只有在复用稳定、独立状态或独立动作出现时才下沉。
- React 项目需要续续读取 `react-me`，由它结合 `vercel-composition-patterns` 和 `vercel-react-best-practices` 校准组件边界、memo、静态数据和导入方式。
## README 口径

模块 README 至少说明：

1. 模块用途和使用入口。
2. 目录职责。
3. 运行前置。
4. 核心接口和状态。
5. 验证命令。
6. 常见坑和未覆盖边界。

## 存储与副作用清理

- 持久化不要到处直读 `localStorage` / `sessionStorage`。用 typed storage adapter 集中解析、过期和默认值。
- 定时器、监听、播放器、图表必须成对清理：`setInterval` 不能只在倒计时到 0 时清，页面离开也要清。

## 反模式

- 不把业务逻辑塞进 `index.tsx`。
- 不把接口事实写成 UI 文案兜底。
- 不为了一次性样式新增 token 或 mixin。
- 不把所有 hooks 都放进一个巨大文件。
- 不在修小问题时顺手改目录结构。
- 不把历史项目命名强套到当前项目。
- 不把接口 DTO 和页面 ViewModel 混在同一个类型文件里。
- 不因当前 UI 没展示就在 mapper 里丢掉二级跳转依赖的隐藏主键。
- 不在路由拼装 util 里弹 toast，缺字段返回空由调用方兜底。

## 输出格式

1. 结论摘要
2. 修改文件清单
3. 结构建议
4. 命名和分层判断
5. 可执行步骤
6. 验收方式