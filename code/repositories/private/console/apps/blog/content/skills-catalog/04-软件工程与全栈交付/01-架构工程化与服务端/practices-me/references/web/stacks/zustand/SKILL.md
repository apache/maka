---
name: zustand-me
description: React 17 + Zustand 4 模块状态管理。Use this skill when designing, reviewing, or fixing Zustand stores in Taro H5, mini program, Umi/Max, React 17 projects, global stores, list dashboard state, AI chat state, media task state, selectors, async actions, page lifecycle cleanup, cross-page cache, stale state, unnecessary re-render, service/hook/store boundaries, or store splitting.
---

# Zustand React17 Module State

## 使用定位

用于 React 17 项目里的 Zustand 状态设计、修复和评审。适用 Taro H5、小程序分包、Umi/Max Web 平台和 AI 会话模块。重点是状态生命周期、作用域、selector、异步 action、页面卸载和跨端稳定性。

## 状态归属判断

| 状态类型 | 放置位置 | 判断标准 |
| --- | --- | --- |
| 纯 UI 临时态 | 组件或 hook | 弹窗开关、输入框、局部 loading |
| 页面查询态 | 页面 hook、URL、表单 | 日期、筛选、分页、当前 tab |
| 跨组件业务态 | 模块 Zustand store | 多区域共享、跨组件刷新、缓存复用 |
| 接口实体 | service + mapper | 字段口径先稳定在接口层 |
| 跨页面缓存 | store 或 storage adapter | 离开页面后仍要保留 |
| 外部注入态 | wrapper 或 adapter | App SDK、qiankun 主应用、微信登录态 |

先判断生命周期，再决定是否进 store。多个组件使用不等于必须全局化。

## 设计规则

1. store 按业务模块拆，不按组件树机械拆。
2. state 和 actions 分开命名，action 用业务动词。
3. 组件用 selector 订阅最小字段，避免整 store 订阅。
4. 异步 action 只编排状态和 service，不写复杂字段映射。
5. 页面卸载、门店切换、日期切换、用户切换要有清理或刷新口径。
6. Taro 页面生命周期和 React hook 生命周期分开考虑。
7. 历史命名如 `gloablStore` 不要无需求重命名。

## 典型场景

### 多区域仪表盘与列表模块

| 状态 | 归属 |
| --- | --- |
| 当前门店、日期、右侧页签 | 页面 hook |
| 左侧状态筛选 | 页面 hook，本地过滤 |
| 列表、统计、日历标记 | resource hook 调度 |
| 新增、修改、状态操作 | mutation hook 调度 |
| 字段映射 | mapper 或 utils |
| 会话级缓存 | store |

经验：统计和日历标记固定当前登录用户，右侧页签只影响列表。新增、修改、取消后要刷新列表、统计和标记，不靠组件自己猜。

### 小程序业务和 AI 会话

| 状态 | 归属 |
| --- | --- |
| token、userInfo、tenantConfig、dictionaryObj | `gloablStore` |
| AI 后台任务 | 任务 store 或入口 hook |
| AI 会话、消息、SSE 状态 | aiAgent 独立 store |
| 协议渲染数据 | 消息解析层到组件映射 |
| tabbar 数量和选中态 | tabbar store |

经验：AI 会话的流式消息、step、协议指令、suggestion 要拆层，不要让一个 store action 同时做请求、解析、渲染和 UI 兜底。

### 媒体编辑小程序

| 状态 | 归属 |
| --- | --- |
| 播放状态、裁剪区间 | 页面 hook 或局部 store |
| 任务创建、轮询、取消 | hook 编排 |
| 模式相关 toast | mode-aware 状态判断 |
| 媒体元数据（如 duration） | 允许晚到刷新 |
| 路由参数 | 入口解析后保存稳定值 |
| 资源缓存（如波形、预览） | 模块 store，可跨页面生命周期保留 |
| 派生区间数据 | store 或 hook 均可，取决于是否跨组件复用 |

媒体编辑的经验规则：

| 规则 | 原因 |
| --- | --- |
| 模块 reset 不应默认清空资源缓存 | 用户离开再回来时可复用，避免重复请求 |
| 任务身份和资源身份优先稳定主键 | 前端恢复和缓存都以稳定主键为索引；缺失时才兼容历史字段 |
| 轮询、媒体实例、定时器由页面 hook 清理 | store 不应持有不可序列化运行时资源 |
| 任务完成后停止轮询并保留结果态 | 结果提示、已播放和结果展示都依赖完成态 |
| 弹窗开关留在页面或局部 hook | 一次性提示不需要进入跨页面 store |

### 中后台 Web 平台

大后台页面优先让 URL、表单和 store 各司其职。微前端主应用下发的 currentUser、dictionaryMap、permissionCodeList 属于外部注入态，缺失时先处理运行前置条件。

## Selector 规则

```ts
const currentStoreId = useStore((state) => state.currentStoreId);
const setCurrentStore = useStore((state) => state.setCurrentStore);
```

避免：

```ts
const store = useStore();
```

如果一个组件需要多个字段，优先组合 selector 或拆子组件，不让整个页面跟随全 store 重渲染。

## 清理口径

| 场景 | 动作 |
| --- | --- |
| 页面卸载 | 清理一次性 UI 态、轮询、媒体实例 |
| 作用域切换 | 清理列表、关联维度、统计、标记相关缓存 |
| 用户切换 | 清理 token、身份、字典派生状态 |
| 查询条件切换 | 刷新列表和时间轴，不污染全局统计口径 |
| 任务完成 | 停止轮询，保留结果或按业务清理 |

## Typed storage adapter

跨页面缓存必须走 typed storage adapter：集中解析、过期、默认策略。禁止页面和 store 各自 `JSON.parse(localStorage.getItem(...))`。

## 反模式

- 不要组件直接 `useStore()` 订阅整棵 store。
- 不要在 store 里混写接口 DTO 到 UI entity 的复杂转换。
- 不要让全局 store 保存一次性弹窗临时态。
- 不要忘记作用域、用户、查询条件、页面卸载后的缓存清理。
- 不要为一个页面的局部状态创建跨项目通用 store。
- 不要把 React 18 或 React Compiler 建议直接套到 React 17 项目。
- 不要为了拼写正确重命名历史 `gloablStore`。
- 不要让轮询、媒体实例和 SSE 连接在页面离开后继续运行。

## 输出格式

按以下结构输出：

1. 结论摘要
2. 状态清单
3. 生命周期
4. store 边界
5. selector 建议
6. action 设计
7. 清理策略
8. 测试点
9. 未进 store 的状态
