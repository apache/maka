---
name: prd-me
description: PRD、原型截图、模块蓝图和 dev/docs 知识库入口。Use when turning PRD, UI screenshots, interface notes, or existing source into an executable module blueprint, especially when the user wants layout-first component splitting, project structure, module README, development order, test plan, or handoff docs.
---

# PRD To Module Blueprint

## 使用定位

用于从 PRD、原型截图、接口资料、已有源码和历史 Bug 进入可执行开发蓝图。核心目标是先定页面布局、组件边界、模块骨架、状态模型和接口契约，再进入编码。

## 输入优先级

1. 当前源码、`package.json`、运行入口。
2. 当前 README、dev/docs 索引和接口定义。
3. PRD、原型截图、UI 标注。
4. 历史 Bug、测试用例、开发记录。
5. 旧 PRD、旧截图、历史测试目录。

当前事实优先。历史材料只作为经验来源。

## 先判项目形态

| 项目形态 | 先读入口 | 蓝图重点 |
| --- | --- | --- |
| Taro 小程序 | `package.json`、`src/app.config.ts`、`src/app.tsx`、request、store | 主包、分包、登录态、请求、业务主链路 |
| Taro H5 内嵌 App | `app.h5.tsx`、`authWrapper`、原生 SDK、页面入口 | 原生 SDK、登录态缓存、H5 路由、原生注入数据 |
| Umi/Max 微前端 | `config/routes.ts`、`src/app.tsx`、`src/access.ts`、典型页面 | qiankun、权限、字典、通用列表组件、动态表单 |
| 独立 Node 服务 | `README.md`、`package.json`、routes、schemas、service、worker | route、schema、任务状态、媒体处理、storage、测试 |
| 文档或学习库 | `dev/README.md`、`docs/README.md` | 文档索引、阅读顺序、维护规则、验收入口 |

## 从组件反查页面入口

当用户提供组件、页面文件或问“这个组件从哪进”“页面入口在哪”“菜单路径是什么”时，先反查真实入口，再继续做模块蓝图。

执行顺序：

1. 从用户给的组件路径开始，搜索 import、动态 import 和省略扩展名的引用写法。
2. 向上追到页面级文件，优先锁定 `src/pages/**`、`src/views/**`、路由懒加载组件或承载 `router-view` 的父页面。
3. 对齐 `routes`、`router`、菜单配置、`meta.title`、`label`、`name` 和 `path`。
4. 继续搜索 `router.push`、`router-link`、`redirect`、按钮跳转和菜单项，判断路由是否仍在使用。
5. 输出真实点击路径，路径里的每一步都要对应界面可见的菜单、Tab、按钮或链接文案。

判断口径：

| 菜单可见 | 代码有跳转 | 结论 |
| --- | --- | --- |
| 是 | 是 | 正常入口，输出菜单路径和其它跳转入口 |
| 是 | 否 | 主要从菜单进入，说明未发现其它跳转 |
| 否 | 是 | 输出触发跳转的页面、按钮或链接 |
| 否 | 否 | 标注可能废弃，暂停确认是否仍在使用 |

输出时至少包含：

1. 简要进入路径。
2. 详细点击顺序。
3. 路由 path 或测试环境 hash 链接。
4. 组件在页面里的职责。
5. 是否存在废弃路由风险。
## 截图到模块蓝图

当用户提供 UI 截图或原型图时，先按业务区域拆布局，再决定组件。以典型的左右分栏看板页为例，有效拆法是：

| 区域 | 组件候选 | 职责 |
| --- | --- | --- |
| 页面壳 | `BoardPage` | 组织左侧栏、右侧主视图和全局操作 |
| 左侧筛选栏 | `FilterSidebar` | 时间选择、状态标记、条件筛选、左侧滚动区域 |
| 顶部标题和操作区 | `PageHeader` | 上下文切换、面包屑、主操作入口 |
| 主视图 | `MainView` | 维度切换、当前选中态、主体内容渲染 |
| 分组页签 | `GroupTabs` | 分组筛选、未分配、当前分组态 |
| 内容轴 | `ContentTimeline` | 刻度、内容卡片、空态、浮层入口 |
| 表单和详情 | `RecordFormModal`、`RecordDetailModal` | 新增、编辑、详情、状态操作 |

拆分规则：

1. 先按业务区块和交互职责拆，不按每个视觉元素机械拆。
2. 超过 400 行只是提醒，最终以职责、状态和复用边界裁决。
3. 能独立拥有状态、样式、接口动作或验收点的区块，优先进入 `components/`。
4. 页面入口只保留布局组合，业务编排进入 `index.hook.ts`。
5. 弹窗、浮层、内容卡片先定义状态机，再写 UI。

## 模块骨架契约

新模块默认输出下面的目录建议，并说明每个文件的职责：

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
├── components/
├── hooks/
├── styles/
├── types/
└── utils/
```

职责口径：

| 路径 | 职责 |
| --- | --- |
| `index.tsx` | 页面入口和布局组合 |
| `index.hook.ts` | 页面事件、状态编排、副作用编排 |
| `index.config.ts` | Taro 或页面级配置 |
| `README.md` | 模块用途、使用位置、运行前置、验收入口 |
| `store.ts` | 模块级状态，过大后拆为 `store/` |
| `service.ts` | 接口定义和请求入口，复杂后拆为 `service/` |
| `constants/` | 状态、事件、字典、枚举 |
| `components/` | 有独立职责的业务区块 |
| `hooks/` | 可复用数据、订阅、轮询、SSE、生命周期逻辑 |
| `styles/` | `_tokens.scss`、`_mixins.scss`、公共样式 |
| `types/` | DTO、ViewModel、组件 Props、状态类型 |
| `utils/` | 纯函数和辅助方法，按业务域拆分 |

## 输出蓝图

每次至少输出：

| 部分 | 内容 |
| --- | --- |
| 项目定位 | 业务类型、目标端、技术栈、运行前置 |
| 页面范围 | 本模块解决什么，哪些能力本轮不做 |
| 区域拆分 | 页面区域、弹窗、浮层、列表、表单、媒体区 |
| 组件树 | 页面入口、容器组件、业务组件、共享组件 |
| 目录骨架 | 文件和目录职责，新增与复用边界 |
| 状态模型 | URL、页面 hook、Zustand、storage、服务端状态 |
| 数据流 | 初始化、查询、提交、刷新、失败路径 |
| 接口依赖 | 请求参数、响应字段、字典、权限、任务状态 |
| 测试入口 | 首批轻量测试、接口契约、人工验收 |
| 开发顺序 | 骨架、接口、状态、UI、兼容、总结 |

## dev/docs 知识库结构

模块级 `dev` 推荐 7 类目录：

| 目录 | 内容 |
| --- | --- |
| `01-技术方案` | 架构设计、处理链路、运行依赖、接口定义 |
| `02-产品原型` | PRD、原型截图、产品需求文档 |
| `03-UI设计` | UI 还原说明、Figma 截图、样式清单 |
| `04-BUG报错` | Bug 分类、踩坑记录、修复策略、历史问题 |
| `05-接口定义` | 接口字段、请求响应、Mock 数据、联调口径 |
| `06-测试用例` | 自动化测试、人工测试、截图验证 |
| `07-项目总结` | 模块说明、新手指南、阶段复盘、维护说明 |

## 反模式

- 不从 PRD 直接跳代码。
- 不把截图中每个视觉元素都拆成独立组件。
- 不让历史 README 覆盖当前源码事实。
- 不用旧测试命令覆盖当前 `package.json`。
- 不把 `dev` 或 `docs` 当成资料垃圾桶。
- 不对大型项目全量扫源码，先从路由、入口、请求、状态、业务主链路切入。

## 输出格式

1. 结论摘要
2. 项目地图
3. 模块蓝图
4. 目录骨架
5. 开发顺序
6. 风险点
7. 首批测试
8. 待确认问题
9. 交接或沉淀写入位置