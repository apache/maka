---
name: practices-me
description: >
  个人项目实战跃迁。Use when working on the user's personal projects and needing
  to identify the stack, route to the matching *-me topic, or make cross-cutting
  frontend decisions about state ownership, request layers, forms, and dialogs.
  Auto-detects stack by project markers. Do not treat package.json alone as Web.
---

# 个人项目实战跃迁

## 目标

这是个人项目从“能做完”走向“可复用、可验证、少返工”的统一入口。它负责四件事：判定任务落在哪个技术栈与业务场景、路由到最小必要的 `*-me` 专题、在跨专题关键决策前执行工程决策门、提醒需要组合的外部最佳实践。它不代替专题细节，也不为一次简单任务加载整套规则。

目录命名和 skill 命名分开：**文件夹用英文短名，`SKILL.md` frontmatter 的 `name` 才带 `-me` 后缀**。旧的长前缀只作为历史兼容口径，不再作为新增经验的命名方式。

## 目录体系

### Web 流程专题

Web 流程专题放在 `references/web/workflow`，文件夹统一使用 `01-07` 序号，具体 `SKILL.md` 使用 `*-me` 名称。

| 顺序 | 文件夹 | Skill 名称 | 何时使用 |
| --- | --- | --- | --- |
| 01 | `01-prd` | `prd-me` | PRD、原型截图、模块蓝图、组件边界、开发顺序 |
| 02 | `02-ui` | `ui-me` | 业务页面布局、红框区块、卡片、弹窗、空态、加载态 |
| 03 | `03-api` | `api-me` | 接口字段、DTO、mapper、字典、分页、状态流 |
| 04 | `04-web` | `web-me` | React/Taro/Vue 前端目录、组件命名、JS/TS 结构、Hook 分层 |
| 05 | `05-test` | `test-me` | 用例设计、契约测试、轻量验证、验收清单 |
| 06 | `06-bug` | `bug-me` | 明确阻断 Bug、最小 diff、根因收敛、回归闭环 |
| 07 | `07-summary` | `summary-me` | 项目总结、交接、复盘、组件说明、开发记录 |

### Web 技术栈专题

Web 技术栈专题放在 `references/web/stacks`，文件夹只写技术栈英文名，具体 `SKILL.md` 使用 `*-me` 名称。

| 文件夹 | Skill 名称 | 何时使用 |
| --- | --- | --- |
| `react` | `react-me` | React 组件架构、组合模式、渲染性能、静态数据位置 |
| `taro` | `taro-me` | Taro H5、小程序、App 内嵌页、平板与老 WebView 差异 |
| `nutui` | `nutui-me` | NutUI 组件使用、主题覆盖、弹窗/表单/选择器适配 |
| `zustand` | `zustand-me` | Zustand store、selector、缓存、页面生命周期 |
| `vue` | `vue-me` | Vue3/Vue2 Options、Pinia、v-html、Vue Router 分叉点 |
| `css` | `css-me` | SCSS、CSS Modules、UI 还原、跨端兼容、样式治理 |

### Web 其他专题

Web 其他专题放在 `references/web/others`，用于不属于 01-07 主流程、也不是纯技术栈的专项经验。

| 文件夹 | Skill 名称 | 何时使用 |
| --- | --- | --- |
| `ai-audio` | `ai-audio-me` | AI 音频、TTS、音频编辑、波形、长音频异步处理 |
| `quality-gate` | `quality-me` | 改后质量门禁、提交前只读检查、格式和 lint 策略 |

### 后端专题

后端专题仍在 `references/node`、`references/java` 下，保持当前目录结构。Java 专题沿用“业务场景 + `-me`”命名：`java-ddd-me`、`java-feign-me`、`mybatis-me`、`solon-mcp-me`。

## 自动判定栈

| 判定 | 栈 | 优先专题 |
| --- | --- | --- |
| `pom.xml` / `application.yml` / `*-support/{common,client,start}` / `@McpServerEndpoint` | Java 后端 | `java-ddd-me` / `java-feign-me` / `mybatis-me` / `solon-mcp-me` |
| `package.json` 依赖含 `fastify` / `express` / `koa`；或存在 route/schema/worker，且没有 Taro / `src/pages` / `src/app.config.ts` 产品壳 | Node 服务 | `node-bff-me` |
| Next.js App Router 以 `src/app/**/route.ts` 为主，前端不直连 worker | Node BFF | `node-bff-me` |
| `package.json` + Taro / `src/pages` / `src/app.config.ts` / Umi 产品壳 | Web 前端 | `prd-me` → `ui-me` → `web-me` → `css-me` → `quality-me` |
| 同仓多栈 | 按当前编辑文件所在目录 | 对应专题 |
| 判定不出、跨栈通用、或用户只要最小修复 | 调试 | `bug-me` |

## Web 前端路由

| 用户目标 | 先读专题 | 常组合专题 |
| --- | --- | --- |
| 从 PRD、截图、接口资料拆模块蓝图 | `prd-me` | `ui-me`、`web-me`、`api-me` |
| 业务页面布局、卡片、红框区块、弹窗、空态 | `ui-me` | `css-me`、`react-me` |
| Figma/UI 还原、SCSS Modules、平板兼容 | `css-me` | `ui-me`、`taro-me` |
| 接口字段、DTO、mapper、字典、状态流 | `api-me` | `web-me`、`test-me` |
| 请求封装、错误分层、接口结果校验 | `api-me` | `web-me`、`test-me` |
| 目录结构、组件命名、Hook 分层、TypeScript 类型 | `web-me` | `react-me`、`quality-me` |
| React 组件边界、组合模式、渲染优化 | `react-me` | `vercel-composition-patterns`、`vercel-react-best-practices` |
| Taro 多端、H5 内嵌、小程序、平板 WebView | `taro-me` | `css-me`、`quality-me` |
| NutUI 弹窗、表单、选择器、主题覆盖 | `nutui-me` | `ui-me`、`css-me` |
| 状态归属、服务端查询、URL/表单/持久化边界 | React 用 `zustand-me`，Vue 用 `vue-me` | `ui-me`、`api-me`、`test-me` |
| 新增/编辑、表单弹窗状态机、异步回显 | `ui-me` | `api-me`、`test-me` |
| Vue 项目结构和 React 分叉点 | `vue-me` | `ui-me`、`css-me` |
| 测试用例、契约测试、轻量验证 | `test-me` | `quality-me` |
| 明确阻断 Bug | `bug-me` | 对应技术栈专题 |
| 交接、项目总结、开发记录、组件说明 | `summary-me` | `writer-me` |
| AI 音频相关功能 | `ai-audio-me` | `api-me`、`quality-me` |

## Web 工程决策门

当任务涉及开项、模块设计、重构或状态混乱时，先完成对应判断，再读取具体专题。已有项目约定优先；只有新项目或现有方案确实失效时，才采用下面的默认选择。

### 状态归属

| 状态类型 | 默认位置 | 判断依据 |
| --- | --- | --- |
| 本地 UI 状态 | React `useState` / Vue `ref` | 只服务当前组件，不需要全局化 |
| 跨组件 UI 状态 | Zustand / Pinia | 多组件共享，但不承担接口缓存 |
| 服务端查询状态 | 项目已有查询层；确有缓存、刷新、重试和失效需求时用 TanStack Query | 数据权威在服务端，不长期复制到 UI store |
| 表单状态 | Form 实例 + 局部状态 | 生命周期与页面或弹窗绑定 |
| URL 状态 | Router search params | 需要分享、返回和刷新后恢复 |
| 持久化状态 | 偏好用 `localStorage`；凭证遵循现有认证方案，浏览器优先安全 Cookie，跨端用 secure storage | 只持久化跨会话仍有价值的数据 |

硬规则：

- 服务端数据不要长期复制进 Zustand 或 Pinia，也不要只为单次请求引入查询库。
- 弹窗临时表单状态不要上升到全局 store。
- 列表刷新由 query invalidation、表格 `ref/reload` 或唯一数据拥有者负责，不在多处手动 `setState`。
- 编辑态 `record/id/mode` 必须只有一个可信来源。
- React 只订阅渲染所需的最小状态；能在渲染阶段派生的值不再用 Effect 复制一份。

React 状态实现细节读取 [zustand-me](references/web/stacks/zustand/SKILL.md)，Vue 分叉点读取 [vue-me](references/web/stacks/vue/SKILL.md)。

### 请求层

1. 先复用项目已有请求封装，不为统一风格替换稳定方案。
2. React / Next 新项目默认使用 Fetch，外层只封装一个轻量 `request`；Vue 或存量项目优先沿用现有 Axios 封装。
3. 请求层只负责 `baseURL`、headers、token 注入、超时、HTTP/鉴权错误、JSON 解析、上传下载分支和可选 Zod 结果校验。
4. 业务错误、网络错误、鉴权错误和数据结构错误分开表达，不堆进一个万能拦截器。
5. TanStack Query 管理服务端状态，不替代底层 HTTP 通信；独立请求应并行发起，避免人为瀑布。

接口字段、DTO 和结果校验继续读取 [api-me](references/web/workflow/03-api/SKILL.md)。

### 表单和弹窗

统一按 `open → echo → submit → success → close → reopen` 检查完整生命周期：

- 新增入口先清 `record/id`，再重置表单和校验，最后写默认值。
- 编辑入口先确定当前 `record/id`，再请求详情或回显数据。
- 保存中禁用重复提交；成功后先通知唯一数据拥有者刷新，再关闭弹窗或返回上一页。
- 关闭完成后集中清理表单、校验、record、loading、临时列表、选择态、上传状态和子弹层。
- 异步详情返回时校验当前打开记录或请求序号，禁止慢响应覆盖新弹窗。

具体组件契约和状态机实现读取 [ui-me](references/web/workflow/02-ui/SKILL.md)。

## 组件架构补充规则

当用户要求“组件太细、边界不清、以后不好维护”时，优先按业务红框重新建模：

1. 先识别页面中的业务区块，而不是图标、按钮、单行卡片。
2. 能被其他模块复用的稳定结构单独抽，例如 `ReportSectionHeader`、`NextVisitCard`。
3. 模块专用内容保留专用组件，不为了泛化而增加 props。
4. 需要不同模式时，优先创建明确组件，而不是给一个组件塞多个布尔 props。
5. ViewModel、normalize、mapper、constants 放在渲染前；JSX 只消费稳定结构。
6. 静态数据、默认数组、预览数据放到模块作用域或 constants，避免 render 内重复创建。
7. 外部最佳实践路由：用 `vercel-composition-patterns` 收敛组件边界，用 `vercel-react-best-practices` 控制渲染、memo、静态数据和导入方式。

## Figma 首版落地规则

当输入来自 Figma 链接、原型图或截图，且处于第一次页面开发时：

1. 先在当前负责模块的公共目录创建 `types/`、`utils/`、`constants/`、`hooks/`。
2. 组件子目录只保留 `index.tsx`、`index.module.scss` 和必要的纯展示组件。
3. 临时契约、mapper、辅助函数不要塞进子组件目录图省事；首版结束前要么上收进公共目录，要么删除，不留“后面再清”的尾巴。

## 默认流程

**Web 模块开发**：涉及状态、请求、表单或弹窗时先过对应工程决策门 → `prd-me` 建蓝图 → `ui-me` 定业务布局 → `web-me` 定结构命名 → `react-me` 校准组件边界和渲染模式 → `api-me` 校准字段 → `css-me` 落地视觉 → `test-me` 设计验证 → `quality-me` 收尾。

**Node BFF**：`node-bff-me` 先定形态 → 锁 route/schema/service/worker 边界 → 契约测试先行 → 再改类型或实现 → `quality-me` 收尾。

**Java 服务**：`java-ddd-me` 定分层 → `java-feign-me` 定调用链 → `mybatis-me` 落持久化 → `quality-me` 收尾。

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

按项目宪法：结论摘要 → 修改文件清单 → 改动目的 → 可执行步骤 → 验收方式 → 未改事项。