---
name: taro-me
description: Taro 3.6 + React 17 多端开发工作流。Use this skill when working on Taro H5, weapp, mini program subpackages, APP_TYPE, API_ENV, writeId/reWriteId, dev:h5, dev:weapp, build:h5, build:weapp, app.config.ts, app.h5.tsx, authWrapper/loginWrapper, App SDK, ScrollView, route params, chooseMessageFile, InnerAudioContext.duration, Android tablet, old WebView, App 内嵌 H5 预加载与转发事件初始化, initialApp 双调用点, finishInitialEvent JS 就绪契约, 状态栏高度缓存, hetsdk goBack 返回栈, or 真机多端差异.
---

# Taro Multiplatform Dev Workflow

## 使用定位

用于 Taro 3.6、React 17、TypeScript、Sass、Zustand 项目的 H5、小程序、分包、App 内嵌页和真机差异开发。样式细节归 `css-me`；状态边界归 helper-me 的 `zustand-me` 节，字段契约归 helper-me 的 `api-me` 专题。

## 先判定运行目标

| 目标        | 先读文件                                                           | 常见命令                                       |
| ----------- | ------------------------------------------------------------------ | ---------------------------------------------- |
| 微信小程序  | `package.json`、`project.config`、`src/app.config.ts`、分包 README | `npm run dev:weapp:*`、`npm run build:weapp:*` |
| H5 内嵌 App | `src/app.h5.tsx`、`authWrapper`、App SDK、H5 路由                  | `npm run dev:h5:*`、`npm run build:h5:*`       |
| 多 APP 类型 | `APP_TYPE`、scripts、config                                        | 只用当前项目脚本                               |
| 平板终端    | 登录缓存、员工会话、Android WebView、vConsole                      | 需要真机或内置浏览器验收                       |
| 分包功能    | `src/subPackage`、`src/aiAgentPackage`、`src/aiDesignPackage`      | 先看入口 README 和路由参数                     |

先读 `package.json`，再确认 Taro、React、Webpack、脚本、目标端和 `browserslist`。不要套用另一个项目命令。

## 项目主线

### 小程序业务主包

重点入口：

- `src/app.config.ts`
- `src/app.tsx`
- `src/features/loginWrapper/index.tsx`
- `src/stores/gloablStore.ts`
- `src/services/request/index.ts`
- `src/pages/home/index.tsx`
- `src/pages/aiCoach/index.tsx`
- `src/aiAgentPackage/aiAgent`

核心链路是租户配置驱动首页、登录态初始化、AI 私教首页、AI Agent 流式会话和 A2UI 卡片渲染。

### H5 内嵌应用

重点入口：

- `src/app.config.ts`
- `src/app.h5.tsx`
- `src/features/authWrapper/index.tsx`
- `src/utils/hetsdk`
- `src/services/request`
- `src/pages/<page-name>`
- `src/pages/aiAnalysis`、`src/hooks/useSSE`

核心风险是 App SDK 注入、员工缓存、H5 路由、SSE、设备控制和 H5 与 weapp 配置差异。

## App 内嵌 H5 的预加载 + 转发初始化（架构决策，别当重复代码改掉）

为极限压缩「原生 App 打开 H5」的耗时，一种成熟做法是：App 提前拉离线包并**预加载**一个只渲染 loading 的默认页；用户真正点入口时，App 通过 bridge 事件把真实业务页 URL **转发**给已就绪的 H5 容器，H5 收到后 `redirectTo` 跳转，省掉冷启动开销。这套链路会引入几个**看似矛盾、实为有意**的设计，维护时不要"顺手修正"，否则破坏预加载语义。

### 初始化有两个调用点，是有意的

| 调用点                      | 场景                                                    |
| --------------------------- | ------------------------------------------------------- |
| H5 入口 `componentDidMount` | 冷启动：App 未预加载时正常打开 H5                       |
| 预加载页转发事件回调        | 预加载路径：真实打开时刷新可能已过时的 token / 启动数据 |

预加载可能发生在真实打开的几分钟甚至更早之前，预加载时取到的 token、启动数据可能过时，因此转发时必须重新初始化，**转发时那次结果是权威的**。看到"两次 initialApp"不要合并成一次。

### 关键契约与兜底

| 主题          | 口径                                                                                                                                                                                         |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "JS 就绪"事件 | 预加载页注册完转发监听后立刻通知 App "JS 已就绪"，此时鉴权大概率还没完成。这是有意的：越早通知，App 越早能转发。                                                                             |
| 鉴权时序安全  | 由页面级 authWrapper HOC 兜底：业务页发现未认证会自行补调鉴权并显示 loading，不依赖初始化事件里的鉴权已完成。                                                                                |
| 竞态防护      | 若 token/启动数据都走 App bridge（毫秒级返回、非 HTTP），实践中不存在旧结果覆盖新结果的窗口，可不做竞态防护。**一旦其中一项改走 HTTP（进入百毫秒级），必须补"最新一次调用胜出"的序号防护。** |
| 初始化失败    | 只打日志，不自动重试、不跳登录，与 bridge 调用自身的错误风格一致。                                                                                                                           |
| 状态栏高度    | 强制从 SDK 取新值并覆盖缓存，但**不先清空**。转发场景下业务页会在新值返回前挂载并同步读缓存，清空会读到 0 引发布局跳动；状态栏高度是设备物理属性，旧值在窗口期内仍正确。                     |

### 返回栈规则

App 内嵌 H5 的顶栏、标题栏、业务返回按钮默认走宿主 bridge 的真实回退栈（如 `goBack()`），不要用 `Taro.redirectTo` / `reLaunch` / 再次 `navigateTo` 伪造来源页返回；只有登录重置、角色切换、入口替换或明确无上级页面兜底时才例外。新页面入口可用 `navigateTo` 入栈，但对应返回仍优先复用宿主回退，避免把来源页再压栈或替换栈顶。

### AI 音频编辑小程序入口

重点入口：

- `src/<module-path>/README.md`
- `src/<module-path>/service.ts`
- `src/<module-path>/store.ts`
- `src/<module-path>/hooks/use<Module>Runtime.ts`
- `src/<module-path>/test/*.contract.test.cjs`

关键坑：

| 问题                         | 口径                                                                              |
| ---------------------------- | --------------------------------------------------------------------------------- |
| `chooseMessageFile` 临时路径 | 不能直接给后端，确认上传或本地静态服务                                            |
| 中文标题和 URL               | 路由参数 `title`、`audioUrl`、`duration` 编码                                     |
| `InnerAudioContext.duration` | 初期可能取不到，保留刷新或重试策略                                                |
| 任务 toast                   | `trim`、`remove_silence`、`smart_clip` 分开展示                                   |
| Node BFF 调用边界            | 前端只调 Java v1 API，本地 mock Java 可通过 Node BFF 代理，端口配置见项目 `.env`  |
| 任务 query                   | detail、cancel、confirm 使用 `jobId`，前端页面态可继续叫 `taskId`                 |
| 波形缓存                     | 优先使用 `audioId` 作为稳定身份，缺失时才回退历史 `recordId/relationId/sourceUrl` |
| 另存为                       | 另存提示对应 confirm 链路，不要在前端伪造成功保存                                 |

## SSE 流式与 A2UI 协议分发（来自美肤私教产品推荐模块）

AI 智能体类页面通常用 SSE 持续推送混合内容（普通文本 + 步骤进度 + 结构化 UI 指令），前端必须做三件事：流式接收、标记切分、协议解析后分发渲染。美肤私教 `aiAgent` 模块把这套路径走通并固化为 A2UI 体系。

### 流式分拣三段式

后端在一条 SSE 流里返回三类内容，用固定文本标记分隔，前端不能假设 JSON 一次到位：

| 片段类型 | 标记常量                                              | 解析产物             | 渲染组件           |
| -------- | ----------------------------------------------------- | -------------------- | ------------------ |
| `md`     | 无（标记之外的都是 md）                               | Markdown 原文        | `MarkdownPreview`  |
| `step`   | `------step-start------` / `------step-end------`     | `StepProgressItem[]` | `StepProgressCard` |
| `a2ui`   | `------a2ui-start--------` / `------a2ui-end--------` | `A2UIChunk`          | 注册表里的业务组件 |

关键算法要点（来自 `AnswerRender/parser.ts`）：

- 从左到右扫描，`findNextStart` 找最近的 start 标记，标记前的文本切成 `md` 片段。
- 有对应 end 标记 → `complete: true`；只有 start 没有 end（流还没传完）→ `complete: false`，先渲染一个未完成占位态。
- `safeJsonParse` 必须套一层 try/catch 返回 null，AI 场景和流式场景下 JSON 可能半截，直接 `JSON.parse` 会崩页。
- step 片段在 `complete=false` 且有数据时，把最后一步状态强制改成 `RUNNING` 做视觉补偿，因为最后一步大概率是“正在执行”。
- a2ui 片段在 `complete=false` 时渲染骨架屏（3 条灰色脉冲线），不要先解析半截 JSON。

### A2UI 协议三段 JSON 与合并解析

后端下发的 a2ui 块包含**三个顺序连接的 JSON 对象**（不是数组，用空白字符连接），分别负责建画布、声明组件、喂数据：

```text
{ "createSurface": { "surfaceId": "...", "catalogId": "..." } }
{ "updateComponents": { "components": [{ "id": "root", "component": "ServiceReportInterpretation" }] } }
{ "updateDataModel": { "value": { /* 业务数据 */ } } }
```

`extractJsonObjects` 维护花括号深度逐个提取 JSON（忽略字符串内部的花括号），`parseA2UIChunk` 合并三段产出 `{ componentId, value, surfaceId, rootId }`。

`surfaceId` 有三处回退来源（`createSurface` → `updateComponents` → `updateDataModel`），兼容不同后端下发习惯。

流式去重用 `collapseSingletons`：同一个 a2ui 块在流式中多次更新（`complete=false` → `complete=true`），保留首次出现位置保 React key 稳定，内容取最后一块的最新状态。

### 组件注册表与四态渲染

A2UI 不下发可执行 UI 描述，只下发 `componentId`，前端本地维护映射表。这套方案适合技能数量有限、组件稳定的场景，联调成本低、维护轻。

| `componentId`                 | 渲染组件                        | 关键 props               |
| ----------------------------- | ------------------------------- | ------------------------ |
| `SkinTestAnalysis`            | `<AiSkinDetails>`               | `data`                   |
| `ProductRecommend`            | `<ProductRecommend>`            | `data`                   |
| `ServiceReportInterpretation` | `<ServiceReportInterpretation>` | `data` + `createSession` |
| `SkinTestRecord`              | `<SkinTestRecord>`              | `records` + `onSend`     |
| ...                           | ...                             | ...                      |

props 命名有四种（`data` / `records` / `createSession` / `onSend`），混用会导致数据或回调丢失。`handleSend` 是二跳触发器，prop 名按业务习惯可能叫 `createSession` 或 `onSend`。

四种渲染状态要有兜底：

| 状态         | 触发                                   | 表现                |
| ------------ | -------------------------------------- | ------------------- |
| 骨架屏       | `complete=false`                       | 3 条灰色脉冲线      |
| 解析失败     | `!chunk \|\| !componentId \|\| !value` | “结果解析失败”      |
| 不支持的组件 | 注册表未命中                           | “不支持的组件: xxx” |
| 渲染成功     | 注册表命中 + ErrorBoundary 包裹        | 业务组件正常展示    |

组件不显示的排查顺序：AI 回复有没有 a2ui 块 → a2ui 块 `complete` 有没有变 true → 解析后 `componentId` 是否为空 → 注册表 case 字符串是否拼对（拼写错误是最常见的“组件不显示”原因） → 业务组件有没有收到 `value`。

### SSE Hook 使用要点

`qaId` 变化重跑（`autoRun=false` 不自动）、卸载/参数变化 `cancel()` 防慢响应覆盖（最后写入获胜）、`useImperativeHandle` 暴露 `run/cancel` 供父级触发；`useSSE` 暴露 `content/state/loading`，渲染用 `useMemo(() => parseAnswerContent(content), [content])` 随 content 重解析。

## NutUI 使用与适配

- 只在组件能力匹配时用 NutUI，不为统一而替换稳定自研组件；表单、弹窗、选择器、日历、Toast 优先看项目已有封装。
- 覆盖样式限定在当前模块容器下，不写宽泛 `:global(.nut-*)`；没有设计差异依据不重写主题色。
- H5、小程序、老安卓 WebView 分开验收，不用一个端推断所有端；弹窗和选择器重点检查遮罩、滚动、底部按钮、安全区和键盘压缩。
- 不用 NutUI 组件绕开已有业务权限或数据校验。

## 多端差异台账

| 差异     | 处理口径                                             |
| -------- | ---------------------------------------------------- |
| 路由参数 | 中文、URL、JSON 字符串都要编码和解码对齐             |
| 页面配置 | H5 和 weapp 的 `app.config` 可能不同，不能互相推断   |
| 分包路径 | 小程序优先看 `src/subPackage`，H5 优先看 `src/pages` |
| 请求域名 | `API_ENV`、`APP_TYPE`、特殊 agentpaas 域名分别确认   |
| 登录态   | 微信登录、App SDK 缓存、员工会话、顾客缓存分开判断   |
| 静态资源 | 小程序包体、远程资源、COS、本地服务 URL 分开处理     |
| 组件能力 | `ScrollView`、Picker、音频、文件选择按目标端验收     |
| 构建脚本 | `writeId/reWriteId`、大小写和平台敏感性要核对        |

## 开发顺序

确认目标端 → 找页面入口与路由参数 → 读请求封装/baseUrl/env/token → 读全局 store 与页面 hook → 按业务主链路追 service/store/跳转 → 多端差异写成台账（不散落组件）→ 关键边界用契约测试固化。

模块工程结构（目录划分、service/store 超 400 行拆文件夹 + index.ts 索引、测试文件随功能同提交）见 helper-me `03-dev` 的 `web-me` 节；样式治理归 `css-me`。

## 老安卓和平板兼容

| 层级      | 看什么                             | 常见问题             |
| --------- | ---------------------------------- | -------------------- |
| CSS 语法  | `gap`、`inset`、CSS 变量、sticky   | 低版本不支持         |
| 容器高度  | 父级高度、`min-height`、`overflow` | `ScrollView` 不滚    |
| 触摸滚动  | 遮罩、弹窗、内部滚动               | 穿透或卡住           |
| Flex 布局 | 最小宽高、兄弟间距                 | 卡片挤压             |
| Polyfill  | `core-js`、fetch、编码             | H5 运行时报错        |
| 目标配置  | browserslist、build type           | 构建目标与真机不一致 |

兼容修复只落在核心布局和已出问题区域，不机械替换全项目。

## 验收方式

| 场景    | 验收                                                                |
| ------- | ------------------------------------------------------------------- |
| H5 页面 | 本地 URL、代理、App SDK 前置条件、vConsole                          |
| 小程序  | 开发者工具、真机、分包路径、`writeId/reWriteId`                     |
| 平板    | 时间轴密度、ScrollView、弹窗、浮层、安全区                          |
| 音频    | 文件选择、路由参数、duration、任务轮询                              |
| 老安卓  | `gap`、`inset`、滚动容器、CSS 变量扫描和人工验收                    |
| 模块名  | `node src/<module-path>/test/page.contract.test.cjs` 及业务契约测试 |

## 反模式

- 不要没读 `package.json` 就套命令。
- 不要把 H5 代理问题写成小程序兼容问题。
- 不要把 `writeId/reWriteId` 当成可省略步骤。
- 不要随手修正 `gloablStore`、`reWriteId` 这类历史命名。
- 不要用 H5 表现判断完整小程序行为。
- 不要把平台判断散进多个业务组件。
- 不要把接口慢、音频时长晚到误判成布局兼容。
- 不要用完整构建验证所有小 Bug，能用轻量测试时先用轻量测试。
- 不要对流式 JSON 直接 `JSON.parse`，必须用 `safeJsonParse` 套 try/catch，半截 JSON 会崩页。
- 不要假设 a2ui 块一次到位，`complete=false` 时只能渲染骨架屏，不能提前解析半截内容。
- 不要新增 A2UI 组件时只改源码不改注册表，`case` 字符串拼错是最常见的“组件不显示”原因。
- 不要把 SSE 流的卸载清理省掉，组件卸载后流继续写状态会触发 setState on unmounted 警告和数据错乱。
- 不要把 App 内嵌 H5 预加载链路里的"两次初始化"当重复代码合并，转发那次刷新的是权威 token / 启动数据。
- 不要把"JS 就绪"事件当成"鉴权完成"，鉴权时序由 authWrapper 兜底，不是初始化事件保证。
- 不要在转发场景清空状态栏高度缓存再取新值，业务页会在窗口期读到 0 引发布局跳动。
- 不要用 `redirectTo` / `reLaunch` 伪造 App 内嵌页返回，优先复用宿主 bridge 的真实回退栈。

## 输出格式

结论摘要 → 目标端和运行前置 → 当前项目脚本 → 模块入口 → 多端差异台账 → 验收方式 → 未改事项。
