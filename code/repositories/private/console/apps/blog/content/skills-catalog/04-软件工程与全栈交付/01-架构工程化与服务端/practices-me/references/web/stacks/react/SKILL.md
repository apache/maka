---
name: react-me
description: React 组件架构与渲染实践。Use when designing, reviewing, or refactoring React/Taro React components, component boundaries, business components, ViewModel props, memo, static data placement, direct imports, children composition, replacing visual micro-components with maintainable business components, or writing data-orchestration hooks（并行请求、请求序号防竞态、canceled 守卫、keepPreviousData 刷新、防连点锁、入口路由参数只固化一次、身份维度组合 key 隔离缓存、失效面板自清理）. Pair with vercel-composition-patterns and vercel-react-best-practices.
---

# React 组件架构实践

## 使用定位

用于 React / Taro React 页面里的组件边界、组合方式、渲染性能和静态数据位置判断。它不替代业务需求判断；需求先看 `prd-me`，业务布局先看 `ui-me`，目录规范先看 `web-me`。

## 必须组合的外部最佳实践

- `vercel-composition-patterns`：用于收敛组件边界，避免布尔 props 膨胀，用明确业务组件替代多模式组件。
- `vercel-react-best-practices`：用于控制渲染、`memo`、`useMemo`、静态数据提升、直接导入和无效重渲染。

## 组件边界判断

| 信号 | 推荐做法 |
| --- | --- |
| 用户说“组件太细、文件太多、以后不好维护” | 按业务红框重建组件，而不是继续拆视觉微组件 |
| 多个模块都会用的标题、右侧卡片、筛选栏、空态 | 抽成稳定公共业务组件 |
| 只服务某个模块的一组卡片 | 保留模块专用组件，不强行泛化 |
| 一个组件出现多个布尔模式 | 拆成明确命名的业务组件或由父级组合 |
| JSX 里散落默认值、排序、字段兼容 | 上移到 constants、normalize、mapper |

## 推荐模式

1. 外层页面负责布局和组合。
2. 业务组件负责一个完整验收区块。
3. ViewModel 负责组件输入边界。
4. normalize 负责缺省、排序和安全显示。
5. mapper 负责接口 DTO 到 ViewModel。
6. constants 负责固定顺序、默认文案、静态预览数据。

## 示例口径

护理服务报告升级中，6 个组件比十几个视觉微组件更合适：

- `ReportSectionHeader`：公共标题栏。
- `ComfortMemory`：模块四左侧红框。
- `NextCareGuide`：模块四右侧红框。
- `CareContinuation`：模块五左上红框。
- `HomeCareProducts`：模块五左下红框。
- `NextVisitCard`：模块五右侧红框。

这个模式让维护者按业务区域找文件，而不是在 `Item`、`Card`、`Button` 之间猜职责。

## 数据编排 Hook 实战模式

页面聚合 Hook（`index.hook.ts`）和资源 Hook（`hooks/useXxxData.ts`）承接请求、缓存、竞态、跳转和防抖。以下是多个企业级模块（顾客详情、复盘总结、待办话术、回访邀约）沉淀下来、可直接复用的写法。展示组件只消费 Hook 输出的 ViewModel 和事件，不碰接口 DTO。

### 并行请求 + 部分成功

多个区块接口相互独立时，用 `Promise.allSettled` 并行拉取，单个失败不阻断其它区块；再按"有真实数据"派生一个可见区块白名单，空接口不展示对应页签。

```ts
useEffect(() => {
  if (!customerId || !orgId) { /* 清空所有区块，return */ }
  let canceled = false;
  setLoading(true);
  // 先清空旧区块，避免切换实体时闪现上一条数据
  const load = async () => {
    const [a, b, c] = await Promise.allSettled([reqA(), reqB(), reqC()]);
    if (canceled) return; // 竞态守卫：慢响应回来时当前实体已变，丢弃
    const aData = a.status === 'fulfilled' && a.value.code === 0 ? a.value.data : null;
    // ...派生 ViewModel、按非空区块 push 可见页签...
    setLoading(false);
  };
  void load();
  return () => { canceled = true; }; // 卸载/依赖变更时作废本次请求
}, [customerId, orgId, refreshKey]);
```

### 请求序号防竞态（并发翻页更强）

`canceled` boolean 只能作废"上一次"。分页/搜索会并发多次请求，用自增序号 ref 判定"是不是最新一次"，只有最新请求能写状态：

```ts
const seqRef = useRef(0);
const load = useCallback(async (pageIndex = 1) => {
  const seq = ++seqRef.current;
  const res = await getList({ pageIndex });
  if (seqRef.current !== seq) return; // 已有更新的请求发出，丢弃本次
  // ...写状态...
}, []);
```

### keepPreviousData 刷新，不闪空

外部 `refreshVersion` 变化触发刷新时，接口失败或未返回**不清空旧数据**，避免刷新瞬间白屏；只有首次加载或明确重置才允许清空。统计数字独立走 stats 接口，不从列表数量反推。

### ref 镜像 state，供回调读最新值

回调（防连点、触底加载）需要读"最新"的 loading / list，但又不想把它们塞进 `useCallback` 依赖导致函数频繁重建时，用一个 ref 镜像 state，写 state 时同步写 ref，回调里读 ref：

```ts
const loadingRef = useRef(false);
const setBusy = useCallback((v: boolean) => { loadingRef.current = v; setLoading(v); }, []);
const handleLoadMore = useCallback(() => {
  if (loadingRef.current || !hasMore) return; // 读 ref 拿最新值
  // ...
}, [hasMore]);
```

### 入口路由参数只固化一次

外部带参进入（自动打开某面板、定位某条数据）时，把路由参数用 `useRef(parse(params))` 固化一次，再配合 `xxxHandledRef` / `xxxGuardRef` 标志位，保证列表刷新、身份切换、用户手动操作后**不再反复消费**同一条入口指令。用户一旦手动改动，标志位置真，入口参数永久让位于用户选择。

### 身份维度组合 key 隔离缓存

登录员工 / 门店 / 租户变化时，用组合 key（`${tenantCode}-${orgId}-${employeeId}`）作为可复用列表组件的 `key`，身份变化即重建组件，避免沿用上一位身份的分页缓存。身份未就绪时用一个占位 key，不发请求。

### 防连点锁 + 提交态双保险

写操作（确认完成、安排、提交）用 `lockRef` 拦截接口返回前的重复点击，同时用一个 `submitting` state 驱动按钮禁用/隐藏。**接口失败不改本地成功态**：失败保留原面板、原数据，只 toast；成功后才关闭面板并递增 `refreshKey` 触发重拉。

### 失效面板/选中项自清理

完成待办或刷新后，当前打开的面板对应的数据可能已不在最新列表里。用 useEffect 监听列表，发现当前选中项 `id` 不再存在就自动关闭面板，避免用户继续操作一个已完成的对象。

### 计时器成对清理

`setTimeout` / `setInterval` / 播放器 / 监听必须在 unmount 的 `useEffect` cleanup 里清；用 `timerRef` 保存句柄，清理和重置两处都要 `clearTimeout` 并置空。

### 小 Hook 单一职责

纯跳转（`useXxxRouter`）、配置请求（用 `taro-hooks` 的 `useRequest` 封一层）、局部滚动同步各自独立成小 Hook，聚合 Hook 只做编排。不要把所有逻辑堆进一个巨型 hook。

## 反模式

- 不按每个图标、按钮、文字行建组件。
- 不用 `isA/isB/showX/showY` 堆出多模式组件。
- 不把接口原始字段写进展示组件。
- 不为一次性小样式新建组件或 token。
- 不为了“可复用”提前抽象还没有复用证据的模块专用内容。
- 不在分页/搜索场景只用 `canceled` boolean 防竞态，并发多请求要用自增序号 ref 判定最新一次。
- 不在刷新时无条件清空旧数据，接口失败应保留旧内容避免闪空。
- 不把接口失败当成功：写操作失败不改本地成功态、不关面板、不清数据。
- 不让外部入口路由参数在每次列表刷新/身份切换时反复消费，固化一次并让位于用户后续操作。
- 不省略计时器、监听、播放器和 SSE 流的 unmount 清理。