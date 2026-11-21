# React Code Review 野战手册（精简版）

> 从 21 万字完整版蒸馏而来。完整版（md/docx/pdf）已删除，其独有增量（SSAP 论证链 + 64 条症状库）压入文末附录。日常只用这一本。
> 案例两个来源：SSAP（原书精编）+ SCWF / SIAM 等希音真实仓库（真实代码，路径标注）。
> 配套资产：速查表（R01-R71 一句话）· react-me skill · DRILL 题库与台账。用法见文末。

---

## 0. 开局三件套

拿到任何 React 代码，先在脑中过这三样，再开始扫。

### 五层扫描顺序

1. 职责与边界 —— 这个组件/hook 负责什么，塞了几类职责
2. 状态与数据流 —— 直接改 state、派生状态、双数据源、状态粒度
3. 渲染与交互 —— key、条件渲染、冒泡串扰、重渲范围
4. 副作用与异步 —— 依赖、loading/error 闭环、竞态、取消、cleanup
5. 性能/安全/体验 —— 热点、XSS、状态可区分、键盘可达

### P0-P3 分级

- **P0**：错误结果、明确故障、安全风险
- **P1**：高概率隐患、重要链路不完整、会持续恶化
- **P2**：影响质量与体验
- **P3**：风格与一致性，可提但不先提

### 四段式输出

每条发现都压成：**这里有什么问题 → 违反什么原则 → 会导致什么后果 → 建议先改哪一刀。**
先归类再展开，先 P0/P1 再补 P2/P3。

---

## 一、状态建模与数据流（R01-R08, R67）

### 脑中模型

状态是后面一切行为的源头：状态建错，渲染、交互、副作用、异步、性能跟着一起坏。七个判断原则：**单一数据源**（一个业务事实只存一份主状态）、**派生现算**（能从 props/state/children 算出来的不存储）、**不可变更新**（新引用表达变化）、**最小状态**、**职责分层**（局部 state / 表单实例 / 全局 store / 服务端数据不越界）、**更新语义准确**（setState 不是同步赋值也不是 promise）、**可追踪**（来源去向触发条件一眼能看）。

扫的顺序：先找真状态 → 再找派生值候选 → 找第二数据源 → 查更新语义（直接改引用？await setState？依赖旧值没用函数式？）→ 查四层职责是否越界 → 问"这状态会不会让 effect 更难写"→ 给最小重构路径。

### 固定追问（七问）

- 这个值是真状态，还是派生结果？
- 同一业务事实有没有两份以上副本？
- 这个状态谁创建、谁消费、谁触发更新？
- 更新时是不是依赖旧值？
- 有没有直接修改引用类型？
- 有没有把 setState 理解错？
- 这个状态会不会让 effect 更难写？

### SSAP 案例：search-form 的两处状态病

**病一：`await setFormData(...)`。** 把 setState 当成可等待的异步操作来建立时序——更新语义误判，await 不会给你想要的顺序保证，还误导后续阅读者。

> Review 语言：「这里把 setState 当成了可等待的异步操作，更新语义有误判。建议把依赖后续值的逻辑改为显式使用新值、函数式更新，或放入真正受状态驱动的 effect 与回调。」

**病二：三套视角。** `searchData` 由 children 解析而来，`selectedChild` 又依赖当前项和 `searchData`，`tags` 再把查询条件投影一份。UI 结构视角、表单值视角、标签展示视角三套并存，重置和回填时必然漂移。更狠的是 `selectedChild` 直接存 ReactNode——state 开始承载"渲染结果"而不是"业务事实"。

> Review 语言：「当前搜索区既维护表单值，又维护标签态和派生配置，且 state 直接持有 ReactNode。建议只存决定渲染的最小标识，以表单值或统一 queryState 作为唯一查询源，标签只做展示投影。」

### 真实案例 1（SCWF）：原地 delete + 一份状态两个用途

`pages/process/list/index.hook.tsx:172`

```tsx
const onChangeSearchInfo = usePersistFn((searchInfo: ProcessReportParams) => {
  const { processKey } = searchInfo;
  // 页面表格和弹窗共用一套 searchInfo，如果在页面表格的搜索条件存在processKey，就立即删除processKey
  if (processKey) delete searchInfo.processKey;
  setSearchInfo(searchInfo);
  ...
});
```

**命中**：R03 不可变更新 + R01 双用途。
**机制**：`delete` 直接改写 store 快照的原对象，绕过状态更新机制；注释自曝"页面表格和弹窗共用一套 searchInfo"——一个对象服务两个互斥用途，只能靠"进来自删字段"打补丁，从弹窗返回页面时搜索条件可能已被悄悄改掉。
**修法**：表格与弹窗各持查询源，或派生出各自视图；删除字段用解构生成新对象。

### 真实案例 2（SIAM）：倒计时——存了不该存的东西

`hooks/use-count-down.tsx`

```tsx
const [timer, setTimer] = useSafeState<NodeJS.Timeout>();
const [countDown, setCountDown] = useSafeState<string>(`${interval}`);
...
const timer = setInterval(() => {
  setCountDown((prev) => {
    if (+prev === 1) { resetCountDown(); return `${interval}`; }
    const next = +prev - 1;
    return next > 9 ? `${next}` : `0${next}`;
  });
}, 1000);
```

**命中**：R01/R04（反面）+ R13（正面）。
**机制**：非渲染数据（interval 句柄）进了 state；剩余秒数这个事实被"补零后的展示字符串"覆盖，判断时还得 `+prev` 解析回来。更重的隐患：连续两次 `startCountDown` 时第一个 interval 句柄被覆盖，永远无法清除——泄漏 + 倒计时双倍跳变。正面：`useEffect(() => resetCountDown, ...)` 卸载必清定时器，cleanup 意识在线。
**修法**：剩余秒数存数字、补零留给渲染层，句柄放 ref。

### 本组规则

- R01 单一数据源优先于多份状态副本
- R02 派生值优先计算，不优先存储
- R03 不可变更新是底线：不原地 push/splice/delete
- R04 state 只存业务事实，不存 UI 结果
- R05 setState 不是同步赋值也不是 promise
- R06 状态粒度过粗会放大更新范围
- R07 页面级/局部/表单/服务端状态要分层
- R08 状态设计先问"以后 effect 会不会更难写"
- R67 状态写入前先过业务约束（去重/存在性/权限）

---

## 二、事件、交互与副作用（R09-R16）

### 脑中模型

先列页面的动作表（点击/选择/展开/搜索/重置/提交/关闭/删除/批量），每个动作问"主意图是什么，是否只表达了这一件事"。然后做最关键的一刀：**这段逻辑本来该在用户点击时发生（事件层），还是只是因为某个状态变了而被动同步外部系统（effect 层）？** 前者回 handler，后者才进 effect。effect 三问：同步什么外部事实、依赖什么真实值、清理什么外部资源——答不上来就是万能补丁。

### 固定追问（十问）

- 这个动作的主意图是什么？会不会顺带触发别的动作？
- 是否存在事件冒泡串扰（子级点击触发父级、弹窗关闭触发底层）？
- 哪些逻辑该在事件层，哪些该在 effect 层？
- effect 里到底在同步什么外部事实？
- 依赖数组和真实依赖一致吗？
- 异步结果回来时，当前视图还是原来的视图吗？
- 有没有 cleanup？订阅/绑定/定时器对称吗？
- 第三方实例的创建、更新、销毁是否混在一起？
- 用户操作后有没有清晰反馈（loading/禁用/成败提示）？
- 一次动作会不会通过多条路径触发同一结果？

### SSAP 案例：dashboard 的隐式副作用链

一个 600 行的首页 hook 里同时有：默认值初始化、筛选联动、图表请求、弹窗控制、枚举回填、权限树选中。单看每个 effect 都有理由，合起来就是"A 变触发 B、B 再触发 C、C 再发请求"的隐式链——一次用户动作通过多条路径触发同一结果，接口被调两三次，排查要在 effect 间跳。

> Review 语言：「当前首页 hook 的交互动作和副作用链路耦合较深。建议按初始化、筛选联动、图表请求、弹窗控制四类职责拆开，降低 effect 之间的隐式依赖。」

### 真实案例 1（SCWF）：一次选择引发的联动环

`pages/approval/list/index.hook.tsx:286`

```tsx
useUpdateEffect(() => {
  if (bizSystemList?.find((item) => item.value === searchInfo?.bizSystem)) {
    fetchProcessModelInfo({ bizSystem });
  }
}, [searchInfo.bizSystem]);

useUpdateEffect(() => {
  if (searchInfo?.processKey) {
    const params = { ...searchInfo, bizSystem: processModelMap[searchInfo?.processKey] };
    setSearchInfo(params);
    nextTick(() => { getApprovalDurationList(params); });
  }
}, [searchInfo.processKey]);
```

**命中**：R43/R15 联动网络、隐式多级 effect。
**机制**：选模板 → effect2 反写 bizSystem → 触发 effect1 再拉模板接口，还叠一层 rAF 延迟发请求。字段 A 变化引发 B、B 又引发 C，全靠 effect 隐式传播，一次选择实际发出 2-3 个请求。
**修法**：把"A 变 → 要哪些结果"收敛到一个显式迁移函数（或状态机），联动在 handler 里一次算清，不靠 effect 相互放大的隐式传播。

### 真实案例 2（SIAM）：async 直接当 effect + 用旧值当依赖

`pages/notice-manage/send-notice/index.hook.tsx:85`

```tsx
useEffect(async () => {
  if (!collapse || prevSearchText === searchText) return;
  searchUser(searchText, 1);
}, [prevSearchText, searchText, collapse]);
```

**命中**：R11 万能补丁 + R12 依赖扭曲。
**机制**：async 函数返回 Promise，React 会当 cleanup 报警告且无法清理；"停止输入就搜索"是事件逻辑被搬进 effect；把 `usePrevious` 的旧值放进依赖当比较器——监听"变化"却依赖"旧值"，快速输入每次击键都发一次请求。
**修法**：搜索回 handler 或 debounce，effect 不做事件的事。

### 真实案例 3（好例子，SCWF）：rAF 的对称清理

`hooks/use-next-tick.tsx`

```tsx
useEffect(() => {
  let id: number;
  if (nextTickFunc) {
    id = requestAnimationFrame(nextTickFunc);
  }
  return () => {
    id && cancelAnimationFrame(id);
  };
}, [nextTickFunc]);
```

**命中**：R13 正面样板。申请 rAF 就在 cleanup 取消，文件头还诚实标注了 Chrome>=55 下 StrictMode double-effect 的风险。订阅/取消成对出现，就这一个要求。

### 本组规则

- R09 一个动作只表达一个主意图
- R10 事件传播路径必须可控
- R11 effect 只同步外部事实，不做万能补丁
- R12 effect 依赖必须和真实业务依赖一致
- R13 cleanup 必须对称：on 有 off、定时器要清、实例要销毁
- R14 交互反馈必须闭环
- R15 复杂页面优先检查隐式副作用链
- R16 第三方实例创建/更新/销毁/事件绑定必须分层

---

## 三、异步请求与错误恢复（R17-R24, R65）

### 脑中模型

异步代码的危险特征：演示时能跑，边界才炸。每个请求按三段看——**触发源**（谁发的、入口统一吗）、**结果回写**（回来时还是当前视图吗）、**状态闭环**（loading/error/empty 完整吗，失败后用户能恢复吗）。默认代码只写了成功路径，所以重点全在失败分支：catch 缺没缺、loading 有没有 finally 收口、旧响应会不会覆盖新视图、基础组件会不会把故障放大到所有页面。

### 固定追问（十问）

- 请求从哪里触发？这些触发源能不能统一？
- loading 是否成功失败都能关闭？
- error 和 empty 能不能区分？
- 失败后用户能怎么恢复（重试/保留输入/回退）？
- 请求回来时，条件还是原条件、组件还挂着吗？
- 会不会旧请求覆盖新结果（有取消/版本戳/最新优先吗）？
- 操作成功后哪些状态需要回收（页码/勾选/弹窗）？
- 基础组件会不会把故障放大？
- 这个页面是不是只设计了成功路径？
- 相互独立的请求有没有被人为串行？

### SSAP 案例：table 的 try/finally 与 rules-config 的时效问句

**table 组件**（`src/components/table/index.tsx`）的 fetch 只在成功后关 loading——接口一抛错，公共表格永远转圈，所有接入页一起假死。这不是"少了个 catch"，是界面状态没有对异常分支闭合。

> Review 语言：「这里的请求缺少对 loading 的异常对称收口。一旦接口抛错，表格会长期停留在 loading。建议将 loading 开关包进统一请求函数，用 try/finally 保证成功失败都能回收。」

**rules/config 页**的联动请求最值钱的一句 review 问话："如果 formatId 已经变了，旧的模板请求回来后还能直接写进表单吗？"答不清，就说明异步时效没有设计。

> Review 语言：「当前异步结果默认直接回写状态，没有体现当前视图时效性。建议补取消请求、版本戳或最新响应优先，避免旧响应覆盖当前界面。」

### 真实案例 1（SCWF）：基础表格 loading 卡死——本手册头号案例

`components/table/index.tsx:131`

```tsx
const fetch = usePersistFn(
  async ({ pageNum = pageInfo.pageNum, pageSize = pageInfo.pageSize } = {}) => {
    if (!isReadyToFetch || loading) return;
    setLoadingTrue();
    const params = isSetPagination ? { ...fetchParams, pageNum, pageSize } : fetchParams;
    const { meta = {}, data = [] } = await fetchApi(clearEmpty(paramTrim(params)));
    ...
    setLoadingFalse();
    setSelectedRows([]);
  },
);
```

**命中**：R18 loading 不闭环 + R19 失败无恢复 + R24 故障放大器。
**机制**：`setLoadingFalse()` 只在成功路径执行，接口 reject 后 loading 永远为 true；入口的 `if (loading) return` 守卫会把后续所有翻页/搜索请求静默丢弃——列表页从此假死、无报错。这是全项目列表页共用的基础组件，一处烂处处烂。它和 SSAP 的 table 案例是同一个病，证明这是组织级习惯，不是个人失误。
**修法**：try/finally 包住请求体；失败分支进入可区分的 error 态；守卫加"上次失败可重试"的出路。

### 真实案例 2（SIAM）：竞态覆盖 + 每渲染 cloneDeep

`pages/notice-manage/send-notice/index.hook.tsx:116`

```tsx
setUserListLoading(true);
const { code, info } = await fetchUserList(params);
setUserListLoading(false);
if (code === '0') {
  const sortedData = [...data].sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
  if (pageNum === 1) { changeUserList(sortedData); }
  else { changeUserList([...sortedData, ...userList]); }
```

**命中**：R18 + R20 竞态 + R37。
**机制**：请求失败 loading 永远转圈；连续输入时先发后至的旧响应覆盖新结果；第 2 页数据 `[...sortedData, ...userList]` 的最终顺序取决于响应到达顺序，用户会看到重复或乱序联系人。同文件 38 行还有 `usePrevious<string[]>(cloneDeep(noticeData.userIds))`——每次渲染对已选用户深克隆一遍，只为喂 isEqual。
**修法**：finally 收 loading；追加分页前校验请求序号或用 AbortController；cloneDeep 从渲染路径拿掉。

### 真实案例 3（SIAM）：登录失败静默 + 恒真条件

`pages/login/index.hook.tsx:150`

```tsx
if (res && res.code === '0') {
  Message.success(message);
  ...
}
```

**命中**：R21/R19 失败无反馈。
**机制**：登录返回非 '0'（密码错误/验证码过期）或抛异常时，无提示、按钮不恢复、验证码不清空——用户视角是"点了没反应"。上文还有 `const message = FORM_MODE.LOGIN ? t('登录成功') : t('注册成功')`——对枚举常量做真值判断，恒为真，注册成功永远提示"登录成功"。认证系统最伤排查的两类缺陷撞在同一个文件里。
**修法**：失败分支补提示 + 恢复按钮；枚举比较用 `=== FORM_MODE.LOGIN`。

### 本组规则

- R17 同一页面请求入口尽量统一
- R18 loading 必须成功失败都能收口（try/finally）
- R19 error 和 empty 不能混成一种状态
- R20 旧请求不能覆盖新结果（取消/版本戳/最新优先）
- R21 请求失败后页面必须有恢复路径
- R22 联动请求必须明确触发源
- R23 批量操作/删除/提交后的回收规则统一
- R24 基础组件的异步设计按"故障放大器"标准审查
- R65 独立请求并行发起（Promise.all），不人为串行
---

## 四、列表、表格与搜索区（R25-R32）

### 脑中模型

列表页同时承载六类职责：展示、查询、分页、行选择、批量操作、请求管理。review 不盯单个变量，先画数据流图——六类事实（查询条件/请求参数/分页/列表结果/勾选/批量结果）谁是谁。三把快刀：**查询条件单一来源**（form 实例或统一 queryState，怕的是 form 一份、state 一份、tags 再一份）、**请求入口统一**（初始化/翻页/搜索/重置/批量回刷走同一 fetch）、**重置是状态回收动作**（表单、标签、页码、参数、联动字段、selectedRows 一起收，不是清空几个输入框）。

### 固定追问（十问）

- 查询条件到底以谁为准？
- 请求入口是不是统一？
- 分页和筛选是否使用同一模型？
- 重置会不会留下旧状态？
- 勾选态稳定吗（rowKey 稳定？跨页保留？刷新清空？批量后回收？）
- table 基础组件是不是吃了太多业务？
- search-form 里派生状态是否过多？
- tags 和表单值会不会失同步？
- 列表刷新后哪些状态该保留、哪些该回收？
- 改一个搜索条件，会不会拖着整块 UI 一起重跑？

### SSAP 案例：回收规则清单

表格和搜索区联动后，最容易 review 出价值的是"动作后回收规则"。固定问：查询后是否回第一页？重置后是否回第一页？删除最后一条后是否自动回前一页？批量操作后是否清空 selectedRows？刷新后是否保留当前条件？这些看似产品细节，实际是列表页数据流稳定性的关键。

> Review 语言：「当前列表页的搜索、翻页与刷新逻辑还没有完全冻结到同一模型里。建议统一请求入口和分页回收策略，降低行为漂移风险。」

### 真实案例 1（SDCP 正例 + DOMP 对照）：入口统一的两代版本

DOMP 母版 `public-component/table/table.jsx:104`：

```js
try {
  if (!isReadyToFetch || loading) return;
  setLoading(true);
  ...
  const { code, info, msg } = await fetchApi(trimParams);
  ...
} catch (err) {
  Modal.error({ content: err?.msg || err?.reason?.message });
} finally {
  setLoading(false);
  setSelectedRows([]);
  onFetchCompleted && onFetchCompleted();
}
```

**命中**：R18 正例 + R17 正面（init/refresh/参数 effect/页码 effect 四入口汇聚到一个 fetch）。
**但有一个高级讨论点**：全仓库唯一的防竞态手段就是 `if (loading) return` 这道重入闸——效果不是取消旧请求，而是**丢掉新的用户意图**。翻页瞬间改搜索条件，新查询被静默吞掉。R20 的正解是取消旧请求/版本戳，不是拒绝新请求。

SDCP 正例 `pages/device-manage/detail/index.hook.tsx:94`——"重置→查询"收敛为一条链：

```ts
useEffect(() => {
  systemReady && init();
  return () => {
    resetDeviceInfo();
  };
}, [systemReady, init]);
```

进页拉详情、出页 resetDeviceInfo 归位 store，进出对称；handler 全部 `usePersistFn` 保持引用稳定，重置后用 nextTick 等 store 落地再查询。SDCP 的"页面 = index.tsx 视图 + index.hook.tsx 逻辑 + store"分层，是五个仓里 hooks 时代最规范的一个。

### 真实案例 2（SCWF）：搜索走"改 store → 监听 effect 深比较"链路

`components/table/index.tsx:183`

```tsx
useUpdateEffect(() => {
  if (!isNeedReFetchByParamsChange || !prevFetchParams || isEqual(prevFetchParams, fetchParams))
    return;
  if (!isSetPagination) { fetch(); return; }
  const { pageNum, pageSize } = pageInfo;
  fetch({ pageNum, pageSize });
}, [fetchParams]);
```

**命中**：R17/R27 请求模型 + R12。
**机制**：用户点"搜索"这个事件被拆成 onChange 写 store → 父组件重渲染 → fetchParams 引用变化 → effect 里 `isEqual` 深比较决定是否请求。事件意图被三层间接隐藏，深比较既昂贵又掩盖了"哪些字段变化才该刷新"的业务语义。
**修法**：搜索动作在 handler 里直接调统一 fetch；effect 只留给真正的外部同步。

### 本组规则

- R25 列表渲染必须有稳定 key：可重排列表尤其不能用 index
- R26 搜索条件必须有唯一可信来源
- R27 搜索/翻页/重置/刷新共用同一请求模型
- R28 重置是状态回收动作，不是清空输入框
- R29 selectedRows 生命周期显式
- R30 columns 和 cell render 是表格性能热点
- R31 搜索区复杂度在状态关系，不在控件数量
- R32 搜索组件成长后从结构驱动转向 schema 驱动

---

## 五、图表、重型组件与性能（R33-R40, R66）

### 脑中模型

性能 review 两个极端都要躲：完全不看，或者到处加 memo。顺序固定：**先找最重的区域**（图表/大表格/复杂搜索区/重型弹窗/首屏大依赖）→ 分类根因（边界？effect 结构？输入不稳定？实例生命周期？首屏策略？）→ **第一刀是切边界不是加 memo**（dashboard 拆筛选区/图表区/弹窗区）→ 第三方实例按创建/更新/销毁三层分开 → 检查重型组件输入引用稳定性 → 最后才评估 memo 值不值。

一个很有杀伤力的问句："**这个 state 改动之后，理论上谁该更新，实际上谁在更新？**"

### 固定追问（十问）

- 页面真正最重的区域在哪里？
- 问题属于边界、状态、effect 还是输入不稳定？
- 第三方实例创建/更新/销毁分层了吗？
- 图表会不会因为 props 变化被反复重建？
- 局部 state 改动是否带动整页重跑？
- columns、options、callbacks 是否不断新建？
- 昂贵计算在 render 路径上吗？
- 首屏加载了本可延后的重型依赖吗？
- 现有优化真的减少了渲染和实例重建吗？
- 这条优化建议值得引入的复杂度吗？

### SSAP 案例：base-chart 的四宗罪

SSAP 的 `src/components/echarts/base-chart.tsx` 是实例生命周期审查的主案例：①init、setOption、click 绑定、dispose 揉在一个依赖 options 的 effect——options 一变整套生命周期重走；②事件绑定存在重复绑定风险；③`debounceResize` 每次 render 新建，防抖形同虚设；④`ResizeObserver.observe(viewElem!)` 防御不足。

> Review 语言：「当前图表组件把实例创建、配置更新和事件绑定放进了同一层副作用，导致 options 变化时触发不必要的实例销毁与重建。建议实例初始化与销毁独立，setOption 作为单独更新路径，事件绑定解绑单独管理。」

### 真实案例 1（SCWF）：SSAP 同款病的真实版——options 一变就 dispose 重建

`components/echarts/base-chart.tsx:54`

```tsx
useEffect(() => {
  if (cDom.current) {
    cInstance.current = echarts.getInstanceByDom(cDom.current);
    if (!cInstance.current) {
      cInstance.current = echarts.init(cDom.current, null, { renderer: 'svg' });
    }
    cInstance.current.on('click', (event) => { if (event && onClick) onClick(event); });
    options && cInstance.current.setOption(options);
  }
  return () => { cInstance.current.dispose(); };
}, [cDom, options]);
```

**命中**：R16 生命周期混层 + R12/R36 依赖整个对象。
**机制**：cleanup 在每次 options 变化时都执行——图表每次数据更新都 dispose 后重新 init，而不是增量 setOption；而上游 dashboard 每次渲染都新建 options（`const options = echartsOption(everyDayDetails)` 在 render 路径），两者叠加成"父组件每渲染一次就重建一次图表"。click 回调也随 effect 反复重绑。与 SSAP 案例互为印证：这是中后台图表组件的通用病。
**修法**：init/dispose 只跟容器生命周期走；options 变化只 setOption；click 回调经 ref 间接引用。

### 真实案例 2（BCP）：监听只加不减，点一次柱子发 N 个请求

`component/analysis/execute/grid/chart.jsx:210`

```js
leftChartRef.current?.on('click', 'series.bar', function (params) {
  Store.setStore({ leftSelectTime: params.value.periodValue })
  Store.getRightChart()
});
window.addEventListener('resize', () => {
  leftChartRef.current && leftChartRef.current?.resize()
});
}, [currentPage, showLabelValue, leftChartData, currentUnit]);
```

**命中**：R13 cleanup 不对称 + R15。
**机制**：这个 effect 依赖 leftChartData/currentUnit 等，每跑一次就 `.on('click')` 叠一个回调、再挂一个匿名 resize（匿名函数永远无法 remove）。init effect 倒是对称 dispose 了，但 update 路径裸奔——点一次柱子触发 N 次 `getRightChart()`，窗口缩放时 resize 执行 N 次，切几次筛选就卡。教科书级"init 收拾干净、update 路径裸奔"对照案例。
**修法**：绑定/解绑成对；回调先 off 再 on，或用 `echarts.getInstanceByDom` 判重。

### 真实案例 3（DOMP）：没有依赖数组的 effect + 假 loading

`pages/board/comprehensive/components/echarts/barEcharts.jsx:49`

```js
useEffect(() => {
  const option = { ... };
  initECharts.current.showLoading({ ... });
  initECharts.current.setOption(option, true);
  setTimeout(() => {
    initECharts.current.hideLoading();
  }, 500);
});
```

**命中**：R15 + R18（假 loading）。
**机制**：effect 没有依赖数组，父组件任何一次 render 都全量重建 option 并 setOption；隐藏 loading 靠写死 500ms 而不是数据就绪，多个 setTimeout 交错时 loading 闪烁。且 init effect 有 `if (echartsId)` 守卫，echartsId 默认空串时实例根本没建，这里直接 TypeError。
**修法**：补依赖数组；loading 跟数据请求走，不跟定时器走。

### 好例子（SCWF）：小数据直接现算，不搞形式优化

`pages/dashboard/index.hook.tsx:27`

```tsx
const tableData = [
  { title: t('今日'), id: 'TODAY', ...todayDetails },
  { title: t('昨日'), id: 'YESTERDAY', ...yesterdayDetails },
  { title: t('日环比'), id: 'DAY_ON_DAY_RATIO', visitorCount: uvRatio, ... },
];
```

R40 正面：3 行派生数据直接 render 里算，不包 useMemo、不进 store——代码短、无缓存失效 bug。R02 与 R40 是一体两面（唯一注意：别把这个新引用喂给 key 了引用的图表 effect，见上面案例 1）。

### 首屏一句

BCP `chart.jsx:2` 是 `import * as Echarts from 'echarts'` 全量进 bundle；DOMP 的 `echarts.config.js` 反而按 `echarts/core` 按需注册——同一家两种标准。图表/编辑器/富文本/导出模块，review 时固定问一句：必须首屏加载吗？

### 本组规则

- R33 先找热点再优化
- R34 性能第一刀是切边界，不是堆 memo
- R35 第三方实例按创建/更新/销毁三层分开
- R36 重型组件输入必须稳定
- R37 昂贵计算不无脑放 render 路径
- R38 局部动作不拖动整页
- R39 重型依赖按需加载
- R40 优化看真实收益，不做形式优化
- R66 条件渲染不用 && 兜数字

---

## 六、工程化、可维护性与基础抽象（R41-R48）

### 脑中模型

工程化 review 的对象不是"这一行对不对"，而是"项目还能不能稳地长下去"。先数职责数量（状态/请求/展示/交互/弹窗/表单/图表/初始化），不看行数。四类稳定语言：**职责、边界、接口、扩散半径**。对基础组件最苛刻的问题："它在提供能力，还是已在承载业务规则？每接一个页面是不是都要往里加判断？"对长 hook："每段逻辑都有理由"不等于"它们该在同一边界里"。对业务复杂度："业务复杂"不能替结构背锅——复杂的是字段依赖还是结构组织？是三态混在一处还是请求/表单/模板注入没分层？

### 固定追问（十问）

- 这个模块承担了几类职责？
- 它是公共能力，还是页面特例？
- 当前抽象是真通用，还是勉强复用？
- 基础组件被业务污染了吗？
- 长 hook 的复杂度根因是什么？
- props 和开关是否已经膨胀？
- 命名和目录支持快速建图吗？
- 公共模块出错会影响多大范围？
- 当前复杂度已经影响迭代效率了吗？
- 有没有明确的最小重构路径？

### SSAP 案例：五个文件的工程化结论

- **table**：正从展示组件变成"半业务容器"，业务判断开始进公共层——回收特例到页面层。
- **search-form**：children 解析 + 标签映射 + 表单值耦合，结构驱动接近极限——向 schema 化演进。
- **dashboard hook**：四类职责混装，根因是边界未拆——按筛选/图表/弹窗/初始化拆子 hook。
- **rules/config hook**：业务确实复杂，但表单/枚举/模板/请求状态全在一个边界里、onChange 各自重置下游且无统一迁移模型——复杂度该用分层状态机承接，不是继续堆。

> Review 语言：「当前 dashboard hook 同时承担筛选条件、图表数据、弹窗控制、默认值初始化等多类职责。复杂度根因在于边界未拆，而不是单点实现细节。建议先按作用域拆子 hook。」

### 真实案例 1（BCP）：被削窄的依赖 + eslint-disable = 结构补丁

`component/maindata/budget/components/list.jsx:120`

```js
// 实时获取编辑预算分类的数据
useEffect(() => {
  if (cateNodeInfo?.id || cateNodeInfo?.id === 0) {
    setRowValue((prm) => ({ ...prm, ...cateNodeInfo }));
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [cateNodeInfo?.id]);
```

**命中**：R01/R02 双数据源 + R48（反面：补丁式修复）。
**机制**：store 的选中节点和编辑表单值是同一数据两份副本，靠削窄依赖 + eslint-disable 手动同步。节点内容变了但 id 没变时表单不更新，`...prm` 浅合并还让旧字段残留——树里快速切换节点时"表单显示的是上一次的数据"。用 lint 豁免换来的同步链，是结构问题被当成了时序问题来修。
**修法**：编辑表单以"打开编辑那一刻的快照"初始化，之后独立演进；不做双份持续同步。

### 真实案例 2（SDCP vs SIAM）：分层是拷贝出来的还是长出来的

SDCP 全仓统一"视图 + hook + store"三层，页面间结构可预测——R46 正例。SIAM 的 `send-notice/index.hook.tsx` 的 IntersectionObserver 模式在 `system-manage/detail/index.hook.tsx:47` 被原样复制粘贴——坏模式也复制。R47 的问句在这里具象化：一个公共 hook 出问题，波及几个页面？

> Review 语言：「这里的观察器模式已在多处复制。建议收敛为共享 hooks（use-infinite-scroll 类），让清理策略只有一份实现，故障只修一处。」

### 本组规则

- R41 长文件的问题是职责数量，不是行数
- R42 长 hook 按作用域拆，不按代码块拆
- R43 复杂表单按主状态/选项数据/模板系统/提交编排分层
- R44 基础组件最怕业务污染
- R45 真抽象有稳定输入/输出/语义
- R46 命名和目录支持快速建图
- R47 公共层故障按扩散半径审查
- R48 重构建议给最小重构路径：说先拆哪一刀
---

## 七、安全、语义、无障碍与体验（R49-R56）

### 脑中模型

这组问题不立刻报错、不被抱怨，但积累起来直接伤害系统可信度。安全上**默认不信任**：任何用户输入、服务端返回、富文本，先假定可注入，追问链固定五步——数据来自哪里？可信吗？清洗了吗？后端兜底了吗？前端还要不要白名单？体验上三句话：**状态可区分**（loading/empty/error/无权限/无结果不长一个样）、**反馈可恢复**（失败知道为什么、知道下一步）、**操作可理解**（语义元素、键盘可达、焦点流转）。

### 固定追问（十问）

- 这段内容有注入风险吗？
- 用户能一眼看懂这里能做什么吗？
- 关键交互用的是正确语义元素吗（button/link vs div+onClick）？
- loading、empty、error、无权限区分清楚了吗？
- 失败时用户知道下一步怎么办吗？
- 表单和搜索区有清晰的辅助信息吗（label/placeholder/禁用原因/校验定位）？
- 键盘用户能完成关键操作吗？
- 弹窗的焦点流转稳定吗（进出弹窗焦点管理）？
- 操作成功失败有闭环反馈吗？
- 同类页面的体验规则一致吗？

### 真实案例 1（BCP + DOMP 配对）：同一个仓库两种安全标准

BCP 公告弹窗 `component/manage/notice/components/noticeModal.jsx:116`：

```jsx
<div
  // eslint-disable-next-line react/no-danger
  dangerouslySetInnerHTML={{ __html: content }}
  className={styles.bcp_content_html}
/>
```

DOMP 同类场景的正例 `public-component/editor/view.jsx:18`：

```jsx
value={BraftEditor.createEditorState(filterXSS(value))}
```

**命中**：R49。
**机制**：BCP 的公告正文是任何有发布权限的人可写的富文本，直接注入且全仓无 DOMPurify/xss 过滤——中后台存储型 XSS 的标准入口，还顺手 eslint-disable 了保护规则。DOMP 的 editor 却老老实实过 `filterXSS`。同一组织两种标准，正好演示 R47 的收敛思想：**危险出口必须收敛到一个经过净化的公共组件**。DOMP 还有一处反面配对：`push-remind-record/list.jsx:113` 用 20 行手写正则把用户侧 markdown 转 HTML 后原样注入 Popover。

> Review 语言：「这里直接渲染 HTML 内容，存在 XSS 风险。除非数据源经过可信清洗，否则不应直接注入页面。建议收敛到统一的净化渲染组件（同仓库 editor 已有 filterXSS 先例）。」

### 真实案例 2（SIAM）：div 模拟按钮——反例带半个正例

`components/captcha/index.tsx:107`

```tsx
<div className={styles.emptyCaptchaTips} onClick={handleRefreshCode}>{t('图片加载失败')}</div>
```

**命中**：R50/R54。
**机制**：div+onClick 模拟按钮，键盘用户无法 Tab 聚焦、无法 Enter 触发，屏幕阅读器也不知道这是可操作项。**但同文件 53 行有半个正例**：`useThrottledFn(() => refresh(), { wait: 300 })` 防连点、加载失败保留点击重试入口——R21 恢复路径的意识在线，只差换成 `<button>`。
**修法**：换语义元素；焦点管理补齐。

### SSAP 案例：体验三查

- **table**：loading 和 empty 区分了吗？错误态可见吗？批量操作后有反馈吗？禁用操作解释原因了吗？
- **search-form**：placeholder 有意义吗？联动字段禁用解释了吗？校验失败能定位到字段吗？
- **弹窗**：打开后焦点进弹窗了吗？关闭后焦点回原位了吗？

> Review 语言：「当前页面的状态表达还不够可区分。建议显式区分 loading、empty、error 和无权限，避免用户把失败误判成『没有数据』。」

### 本组规则

- R49 危险内容默认不可信
- R50 交互优先原生语义元素
- R51 loading/empty/error/无权限必须可区分
- R52 错误提示要能帮助恢复
- R53 表单辅助信息服务于理解
- R54 重要交互键盘可达
- R55 操作反馈闭环
- R56 同类页面体验规则一致

---

## 八、Review 输出与面试模板（R57-R64）

> 这一组不审代码，审"怎么说"。来源：原书第 13 章全量精华。面试前只读这一组。
> 规则对照：R57 开场报方法 · R58 先 P0/P1 · R59 四段式 · R60 先归类 · R61 不说感觉 · R62 三层追问 · R63 三种长度 · R64 像 reviewer 一样说话。

### 开场模板（先报方法，再报问题）

> 我会先按固定顺序做 code review：先看模块职责和状态，再看列表与渲染结构，然后看事件和副作用，再看异步链路，最后补性能、安全和可维护性。我会优先说 P0 和 P1，也就是会直接导致错误结果、状态异常、请求异常的问题。

### 四段式（一切问题的表达骨架）

问题 → 原则 → 后果 → 修法。示例（effect 依赖不完整）：

> 这里的 effect 用到了 `user.id`，但依赖数组没有把它纳入。这违反了副作用依赖和真实业务依赖保持一致的原则。后果是组件复用或条件切换时出现漏请求、旧数据或逻辑漂移。建议补齐真实依赖，并视场景加取消请求或时效保护。

### 五类问题对号入座

| 类别 | 覆盖症状 | 句式要点 |
|---|---|---|
| 状态类 | 直接改 state、派生过多、双数据源、setState 语义误判 | 单一数据源/不可变更新/最小状态 → 状态漂移、effect 难写 → 收敛源状态、派生回 render |
| 交互类 | 冒泡串扰、动作多义、重复点击 | 交互边界 → 操作结果不可预测 → 显式隔离传播、动作压回单义 |
| 副作用异步类 | 依赖脱钩、重复请求、旧覆盖新、loading 卡死 | 生命周期闭环 → 重复请求/旧数据/卡死 → 统一入口、补收口、加时效保护 |
| 性能类 | 整页重渲、图表重建、columns 重建 | 根因是边界/输入/生命周期，不是少了 memo → 先隔离分层再稳定输入 |
| 工程化类 | 长 hook、业务污染、伪抽象、props 膨胀 | 结构失控 → 维护成本上升 → 按职责拆边界、特例回页面层 |

### 优先级清单（先说什么后说什么）

- **P0 先说**：直接改 state / effect 依赖脱钩 / 请求异常不收 loading / 旧请求覆盖新结果 / dangerouslySetInnerHTML / key 缺失错位 / 交互串扰触发错误动作
- **P1 接着**：派生状态过多 / 基础组件职责过重 / 图表生命周期没分层 / 搜索区双数据源 / 长 hook 没拆 / 请求模型不统一
- **P2 最后**：双等号 / 样式组织 / 命名 / 轻量可访问性缺口

### 五分钟实战五步

1. 开场定方法（一句话报扫描顺序）
2. 先报两个最重的问题（P0，各走四段式）
3. 再补交互串扰和安全风险
4. 最后补细节（0 渲染、key、语义、可访问性）
5. 每个点都按四段式展开，不说"感觉不对"

### 面试官追问"为什么"的三层接法

- **原理层**（state/effect/浅比较）：React 关注引用变化和依赖边界，直接改原值或依赖不一致，代码还能跑，但 React 的更新模型和你的业务模型已经脱钩。
- **工程层**（长 hook/抽象）：今天未必炸，但职责混装后每个新需求只能往现有边界里堆，阅读、review、修改成本一起上升。
- **用户层**（体验/安全）：用户不关心你少写了哪个依赖，他只觉得页面有时没反应、有时结果不对。

### 三种长度（同一道题）

- **20 秒**：报两个 P0（直接改 state + effect 依赖脱钩），各一句后果。
- **60 秒**：扫描顺序 → 两个 P0 四段式 → 补交互串扰和 XSS → 补细节。
- **90 秒**：P0 两个完整四段式 → P1 两个（交互边界 + 异步闭环）→ 收尾补安全/体验/工程化。

### 五个禁忌

1. "这里感觉不太对" → 改说"这是一个 X 类问题"
2. "平时不会这样写" → 改说违反什么原则、会怎样坏
3. "可以优化一下" → 说清是性能/结构/生命周期/输入稳定化
4. 上来先说样式命名双等号 → 永远 P0 先行
5. 只说"不推荐"不说"为什么会坏" → 后果链才是分量

---

## 九、跨组通用规则（maka 实战，R68-R71）

React 之外的 review 通用件，来自 Apache maka 真实 PR 复盘：

- **R68 测试有效性**：fixture 形状 ≠ 生产 producer 真实发出的形状时，测试证明的是 fixture 而非系统。（#4506：fixture 给 `args:{}`，生产 projector 永远发 `args:undefined`）
- **R69 write-only 机制按死代码审查**：参与不进任何决策的状态与记录，读起来像仍在参与。（#4518：记录了 step/tool 但没有任何决策读它）
- **R70 哨兵值按真实形状写**：首图/初始实体往往是 0、空串、空对象，不是 undefined。（#4514：夹具 createdAt:0 绕过只查 undefined 的守卫）
- **R71 交付物一致性**：PR 正文/Summary/Checklist 与 diff 矛盾 = P1，正文也是交付物。（#4506：正文声称"退出码不变"，diff 里测试 0→1 翻转）

---

## 配套资产与使用方法

| 资产 | 位置 | 什么时候用 |
|---|---|---|
| 速查表（R01-R71 一句话） | 本目录《React-Code-Review-规则速查表.md》 | 看 PR 时快速对照 |
| DRILL 题库（3 题+答案键） | 本目录《DRILL-题库.md》 | 每周/双周限时脱稿练 |
| DRILL 台账 | 本目录《Review-DRILL.md》 | 记命中/漏掉/漏因 |
| react-me skill | `~/.agents/skills/react-me/` | 让 AI 按本体系审代码 |
| 附录（原书独有增量：论证链 + 症状库） | 本文件文末 | 想看某条结论的论证过程 / 按症状反查规则时 |
| maka 实战台账 | `E:\guahub\docs\gh\fork\maka\PR-JOURNAL.md` | R68-R71 案例细节 |

**使用规则**：

1. drill 漏因 A（没认出）→ 翻本手册对应组，读脑中模型 + 真实案例；漏因 B（说不清）→ 读第八组四段式；漏因 C（顺序乱）→ 背第 0 章扫描顺序。
2. 面试前 → 只读第八组。
3. 审 PR → 速查表过一遍 + 本手册对应场景组。
4. 案例代码全部来自真实仓库（SCWF/SIAM/BCP/DOMP/SDCP/SSAP），片段仅供个人学习复盘，不入库不外传。
---

## 附录：原书独有增量（SSAP 论证链 + 64 条症状库）

> 来自已删除的 21 万字完整版第 11、14 章，是唯一没并入正文的两块：论证过程和症状速查。

### 附录 A：SSAP 五组件论证链精编

**table/index.tsx（254 行，半容器基础组件）**
写对的：useImperativeHandle 暴露 init/refresh、useCreation 稳定分页配置、formatListFunc 留转换口。先识别做对了什么，review 才像建设性改进。
论证链四条：①fetch 无 try/finally，基础组件级故障（正文已收）；②**`usePersistFn` 稳定的是引用不是逻辑**——闭包里的 `pageInfo` 直接展开再写回、`loading` 当重入闸，`setPageInfo({ ...pageInfo, ... })` 依赖"闭包里拿到的是最新值"，比函数式更新脆；③参数变化不回第一页——不是错，但分页回收语义必须显式冻结，否则不同页面行为预期分裂；④selectedRows 是页面态还是组件态没说死，未来不同页面要求不同时，组件面临吞逻辑还是暴露策略的选择。
总判断：方向对，需补异常闭环、状态更新稳态化、分页语义冻结、选中态策略显式化。

**search-form/index.tsx（274 行，结构驱动搜索区）**
写对的：onSearch(formData) 统一出口、tags 做查询可视化、children 扩展。
论证链五条：①五份状态里三份是派生（正文已收）；②selectedChild 存 ReactNode（正文已收）；③await setFormData 语义误判（正文已收）；④**`onClickPlus` 一个函数同时承担输入校验、展示拼装、去重规则、查询参数写入**——不是 bug，是已进入复杂化通道的节点，等"某些字段可重复、时间范围不可重复、多选拆多 tag"需求一来就会爆；⑤从 children 反推配置的结构驱动抽象上限低，要转 schema 驱动。
总判断：看得见一个公共组件怎么一步步长复杂（children 复用→加 tags→加选中项→加表单值→派生 UI）。

**base-chart.tsx（131 行，重型组件基座）**
写对的：实例缓存、dispose 意识、ResizeObserver、受控 loading。
论证链四条：①创建/更新/绑定/销毁混一个 effect（正文已收）；②`.on('click')` 无 off，effect 多跑一次绑一次——见到绑定立刻追问解绑策略，这是第三方实例组件的条件反射；③**`debounceResize = debounce(resize, 500)` 写在组件体里，每次 render 新建**——observer 订阅的是哪个实例不稳定，卸载时也没有统一引用可 cancel；④`ResizeObserver.observe(viewElem!)` 非空断言——重型基础组件对首次 render/条件渲染/卸载边界要更敏感。
总判断：比加 memo 更有价值的是生命周期分层。

**dashboard/index.hook.tsx（656 行，首页长 hook）**
写对的：命名可推断（getDashboardLineData 类）、按图表/弹窗分组意识、usePersistFn/useCreation 控引用。
论证链四条：①弹窗作用域的状态（modalVisible/modalData/selectDialogType/分页/handleClose）与首页主逻辑同边界——改哪边都要想着另一边，拆法：useDashboardFilters / useDashboardCharts / useDashboardDialogs；②六条 effect 链（权限树→默认选中→饼图；业务域→重置系统值→整套统计……）单条都对，合起来无法判断一个变化沿哪几条链扩散；③三个图表请求 loading 全部无异常对称；④业务域变化 resetChartsData、应用变化清多区域——"理论上该影响谁，实际上影响了谁"。
总判断：命名和组织有基础，边界还没从"按功能堆"升级到"按作用域拆"。

**rules/config/index.hook.tsx（675 行，复杂表单联动网）**
写对的：PAGE_TYPE 三态显式区分、useCreation 收拢派生、onChange 全部显式命名、卸载有回收。
论证链五条：①表单/枚举/模板/权限树/请求十份状态混一个边界（正文已收）；②四个 onChange 各自重置一大批下游字段——迁移链分散在多个 handler，新增联动要在多处补；③**模板动态注入字段是"动态表单 schema 系统的胚胎"**——必须按高复杂区审：动态字段何时初始化/清空、取消选择后旧字段回不回收、编辑态和新增态注入策略是否一致；④formatId 变化拉采集来源+模板列表、formatId+auditDepartment+configBy 拉行为分类、tagId 变化拉采集来源、application 变化拉权限树——单条业务正确，合起来是一张网，"风险不在 effect 对不对，而在 effect 网络规模已接近需要重新分层"；⑤**onSubmit 已经是一套可测试的参数编排层**（页面类型×单批配置×模板列表→构造提交参数），够资格单独抽层——抽离后 review、单测、回归成本全降。
总判断：复杂表单页真正难的不是控件，是联动网络；review 的核心任务是把网络压回几条可理解的主链。

**五个原型（看到类似结构自动归类）**：①基础表格→问请求闭环/分页语义/selection 生命周期/业务污染；②复杂搜索区→问唯一查询源/派生状态/结构 or schema 驱动/标签同步；③第三方实例→问创建/更新/绑定解绑/observer 清理/loading 受控；④首页大 hook→问页面级状态/局部弹窗状态/effect 链/影响范围/拆分切口；⑤复杂配置页→问表单主状态/联动网络/动态 schema/提交编排/多业务态。

**全章总结论**：SSAP 的问题不是不会写 React，而是复杂度增长后边界没有同步收紧。复杂度几乎从不以"突然写出烂代码"出现，它的样子是：每一步都合理，累计起来边界松了。高级 reviewer 看的是这段代码是不是正把系统带向更难维护的方向。

### 附录 B：64 条症状库（R01-R64 典型症状速查）

- R01 表单值/local state/tags 各存一份同一事实
- R02 searchData、selectedChild、selectedTemplateList 一类派生值越存越多
- R03 push、原地改字段、原地 splice/delete
- R04 state 里存 ReactNode、clone 出来的 JSX、拼好的展示结构
- R05 `await setState(...)`、set 完立刻读、以为拿到新值
- R06 一个大对象 state 控整页，局部改动整页重跑
- R07 页面 hook 同时维护表单、弹窗、图表、请求缓存、默认值
- R08 一份数据到处复制，effect 依赖越来越难列
- R09 点击按钮同时展开父层、切状态、发请求、刷列表
- R10 子按钮误触发父级 click；弹窗内点击影响底层页面
- R11 事件逻辑搬进 effect；一个 effect 同时初始化、补状态、发请求、改 UI
- R12 用到 A、B、C 依赖只写 A；为防重复故意少写
- R13 `on` 没 `off`、observe 没 unobserve、定时器没清
- R14 提交无 loading、失败无提示、重复点击无防护
- R15 A 变触发 B，B 再触发 C，C 再触发请求
- R16 一个 effect 同时 init、setOption、on、dispose
- R17 每种动作各有一套请求函数和参数拼装
- R18 只在成功分支关 loading、catch 漏掉、异常卡死
- R19 请求失败后页面显示空白/空列表，像没数据
- R20 快速切换筛选后旧响应覆盖新页面
- R21 失败后只有控制台报错，无重试无解释
- R22 多字段联动但触发关系散落在多个 handler 和 effect
- R23 删除后停留空页、批量后 selectedRows 没清、提交后弹窗残留
- R24 基础 table loading 卡死、chart 错误无感、公共 modal 关闭后仍回写
- R25 index 当 key、复杂列表没有稳定 id
- R26 表单一份、queryState 一份、tags 再一份
- R27 搜索重置回第一页、刷新不回；翻页和查询参数各自维护
- R28 表单清了 tags 没清、页码不回收、联动字段残留旧值
- R29 刷新后是否清空不明确、跨页保留不明确、批量后回收不统一
- R30 columns 每次新建、cell render 做昂贵计算、表格刷新带动整页
- R31 selectedChild、searchData、tags、formData 同时存在
- R32 大量 children 解析、clone 子组件、靠组件类型反推配置
- R33 全局到处加 memo，不知道真正热点
- R34 局部改动带动整页重跑、一上来 useMemo 救火
- R35 options 变化就 dispose 再 init、一个 effect 干完所有事
- R36 图表 options/回调/columns 每次新建
- R37 复杂 map/filter、children 解析、大对象拼装、树拍平挂在 render
- R38 改一个筛选整页 dashboard 全动、开弹窗主页全部重算
- R39 弹窗里的重型组件打进主包、首页默认加载所有图表库
- R40 到处加 memo/callback 但说不出收益点
- R41 一个 hook 同时管筛选、图表、弹窗、默认值、分页、提交
- R42 拆成几个"杂货函数"但职责边界没变
- R43 联动、枚举、模板、提交逻辑全压一个 hook
- R44 每接一个页面就往 table/search-form 加一个判断
- R45 props 越来越多、开关越来越多、默认行为越来越难预测
- R46 hook 命名模糊、工具函数混在页面逻辑、目录按历史堆积
- R47 基础 table 卡死、chart 事件泄漏、公共 search-form 漂移
- R48 comment 只有"建议优化结构"，没有第一刀
- R49 dangerouslySetInnerHTML、富文本直接进页面
- R50 div+onClick、图标可点语义不清、不可聚焦交互
- R51 没数据和报错都显示空白、无权限像系统坏了
- R52 只 toast 一句失败，没有指引没有重试
- R53 placeholder 无意义、禁用无解释、校验错误难定位
- R54 关键按钮不可聚焦、弹窗焦点飘、关键路径只能鼠标完成
- R55 保存无 loading、删除无反馈、导出无状态提示
- R56 A 页删除有确认 B 页没有、A 页重置回第一页 B 页不回
- R57 开口就说某一行不好
- R58 先说样式命名，后说状态异步
- R59 说半天只有感觉没有结论
- R60 零散找点没有类别
- R61 "感觉不太对""一般不这么写"
- R62 只会说现象，追问两层就空
- R63 只有单一长度的回答
- R64 像在猜题，不像在做真实 review
