---
name: bottom-sheet-audit-comment
overview: 审核 BottomSheet 重构等价性，回退一个时间戳口径差异以严格保持原行为，然后参照 useScrollRestore.ts 的风格为六个文件的变量与函数补齐中文注释。
todos:
  - id: revert_timestamp
    content: 为 fetchSkincareDetail 新增 useNowForDetail 选项，openCategory 护理分支传入该选项，严格回退旧版 dayjs().unix()
    status: completed
  - id: comment_index_tsx
    content: 为 index.tsx 添加文件头、Props 字段、组件、Popup 关键属性的中文注释
    status: completed
  - id: comment_hook
    content: 为 index.hook.ts 添加全部函数 / useEffect / 关键局部变量的中文注释
    status: completed
  - id: comment_store
    content: 为 store.ts 添加 type/interface 字段、state、setter、resetSheetState 的中文注释
    status: completed
  - id: comment_utils
    content: 为 utils.ts 添加常量、类型、十个工具函数的中文注释
    status: completed
  - id: comment_category_sheet
    content: 为 CategorySheet.tsx 添加文件头、Props、组件注释
    status: completed
  - id: comment_record_sheet
    content: 为 RecordSheet.tsx 添加文件头、Props、组件及内部 handler 的注释
    status: completed
  - id: lint_check
    content: 对六个改动文件跑 eslint，确认无新增告警
    status: completed
isProject: false
---

## 一、行为对齐（一处微调，严格按旧版字节级恢复）

`fetchSkincareDetail` 当前统一用 `dayjs(dayTime).unix()`，但原 `openCategory('护理')` 用的是 `dayjs().unix()`（当前时刻）。为不改变功能，给 `fetchSkincareDetail` 增加一个可选开关回退到旧写法。

改动点：[src/aiAgentPackage/aiAgent/components/BottomSheet/index.hook.ts](src/aiAgentPackage/aiAgent/components/BottomSheet/index.hook.ts)

```ts
const fetchSkincareDetail = useCallback(
  async (
    dayTime: string,
    type: SkincareRoutineType,
    options?: { useLineBreak?: boolean; useNowForDetail?: boolean }
  ) => {
    const { customerId } = getCustomerContext();
    const toDay = options?.useNowForDetail ? dayjs().unix() : dayjs(dayTime).unix();
    const [result, response] = await Promise.all([
      fetchCheckInStatus(dayTime, type),
      getDayDetailApi({ customerId, dayTime: String(toDay) + '000' })
    ]);
    return createSkincareCheckInData(type, dayTime, result, response?.data, options);
  },
  [fetchCheckInStatus]
);
```

`openCategory` 护理分支改为：

```ts
const skincareData = await fetchSkincareDetail(today, 'morning', {
  useLineBreak: true,
  useNowForDetail: true
});
```

`handleDateChange` / `handleSkincareRoutineChange` 继续不传 `useNowForDetail`，保持按传入日期计算，与旧版一致。

其余差异（`Promise.all` 并发、`console.log` 字符串化）不影响业务结果，保持现状。

## 二、注释风格统一

参照 [src/subPackage/aiAgent/hooks/useScrollRestore.ts](src/subPackage/aiAgent/hooks/useScrollRestore.ts)：

- 文件顶端：一段总览块注释，说明文件职责与分层。
- 常量 / 类型 / 接口字段 / ref / state / 变量：上一行 `/* 说明 */`（含必要时多行 `/* ... */`）。
- 函数 / 方法 / hook：上方多行块注释，写清楚目的、执行顺序或边界条件；不啰嗦叙述代码本身。
- 不改业务逻辑，不删除现有的文件头 `@Author` 注释块，仅追加说明。

## 三、逐文件注释清单

### [src/aiAgentPackage/aiAgent/components/BottomSheet/index.tsx](src/aiAgentPackage/aiAgent/components/BottomSheet/index.tsx)

- 文件顶注：说明本组件只做视图组合，数据由 hook 提供，并解释 `bottom-sheet-popup` 类的作用。
- `BottomSheetProps`：逐字段注释 `visible` / `onClose` / `presetType`。
- `BottomSheet` 组件：块注释说明四类视图切换与 `afterClose` 的状态复位职责。
- `Popup` 关键属性：在 JSX 附近用行内块注释标记 `duration={0}` / `destroyOnClose` / `closeOnOverlayClick` / `afterClose` 的目的（保留原样式隔离方案说明）。

### [src/aiAgentPackage/aiAgent/components/BottomSheet/index.hook.ts](src/aiAgentPackage/aiAgent/components/BottomSheet/index.hook.ts)

- 文件顶注：说明本 hook 承担的打卡业务逻辑 + store 订阅方式。
- `UseBottomSheetOptions` / `SLIDER_CATEGORY_MAP`：加说明。
- `useBottomSheetStore(...)` 返回字段：在解构位置用块注释概述「只订阅视图+业务状态」。
- 函数逐个加块注释：
  - `fetchCheckInStatus`：说明「读用户上下文 → 拉当日打卡状态 → 过滤最新一条并解 JSON，异常兜底」。
  - `fetchSkincareDetail`：说明两个请求并发、`useLineBreak` 与 `useNowForDetail` 的语义。
  - `openCategory`：说明五个分支与跳转饮食后的 `onClose`。
  - `handleCategoryClick` / `handleRecord` / `handleDateChange` / `handleSkincareRoutineChange` / `handleSkincareCheckInRecord`：各自加块注释，强调参数来源、接口、失败分支。
  - 两个 `useEffect`：分别说明「拉护肤方案 ID」「按 presetType 准备首屏数据再打开弹窗」，列出 `isMounted` 守卫意图。
- 局部变量 `today` / `sliderType` / `checkInDay` / `categoryNameMap`：上一行 `/* ... */`。

### [src/aiAgentPackage/aiAgent/components/BottomSheet/store.ts](src/aiAgentPackage/aiAgent/components/BottomSheet/store.ts)

- 文件顶注：说明使用 zustand 管理的弹窗内部状态，和 `resetSheetState` 关闭时的重置边界。
- 逐项注释 type 联合：`BottomSheetView` / `BottomSheetPresetType` / `SkincareRoutineType` / `CheckInType`。
- `SkincareCheckInData` 接口：逐字段注释。
- `BottomSheetState` 接口：state 字段与 setter 各自加注释，`resetSheetState` 强调「不清 `currentCheckInType`，与旧实现一致」。
- `create<BottomSheetState>` 工厂：块注释说明默认值与 `resetSheetState` 的字段集合及理由。

### [src/aiAgentPackage/aiAgent/components/BottomSheet/utils.ts](src/aiAgentPackage/aiAgent/components/BottomSheet/utils.ts)

- 文件顶注：说明仅放无副作用的常量、数据装配、日期 / JSON 工具。
- 常量 `CATEGORY_NAMES` / `categoryData` / `DEFAULT_LIFE_ITEMS` / `DEFAULT_MOOD`：各自 `/* ... */`。
- 类型 `CategoryItem` / `CheckInStatusResult`：字段级注释。
- 函数 `getCustomerContext` / `getCheckInDay` / `parseCheckInJson` / `findLatestCheckInData` / `getRoutineSceneKey` / `getDefaultRoutineTips` / `getSkincareRoutineDetail` / `createSkincareCheckInData` / `createSliderRecordData` / `createDefaultPresetRecordData`：逐个块注释，突出「什么时候被调用」「返回结构」「边界」。

### [src/aiAgentPackage/aiAgent/components/BottomSheet/components/CategorySheet.tsx](src/aiAgentPackage/aiAgent/components/BottomSheet/components/CategorySheet.tsx)

- 文件顶注：说明仅渲染分类入口，不做业务。
- `CategorySheetProps`：字段注释。
- `CategorySheet`：组件块注释，说明 `items` 默认来自 `categoryData`。

### [src/aiAgentPackage/aiAgent/components/BottomSheet/components/RecordSheet.tsx](src/aiAgentPackage/aiAgent/components/BottomSheet/components/RecordSheet.tsx)

- 文件顶注：说明承接「护肤」与「滑块」两类面板。
- `RecordSheetProps`：字段注释。
- `RecordSheet`：组件块注释；内部 `handleDateChange` / `handleRoutineChange` 各自块注释，说明 `void` 吞掉 Promise 的原因是适配子组件的同步签名。

## 四、自测与校验

执行范围限于本次修改的六个文件：

1. `npx eslint --ext .ts,.tsx` 跑六个文件，确认无新增告警。
2. `npx stylelint` 不动 scss，跳过。
3. 人工过一遍修改后的 `index.hook.ts`，确认 `useNowForDetail` 仅在 `openCategory('护理')` 传入，且其它调用点未改动。
4. 用 Grep 确认 `dayjs().unix()` 只出现一次（仅在 `fetchSkincareDetail` 内部），避免误用。

不构建、不跑真实接口，保持与重构总结文档相同的自测边界。

## 五、非本轮动作（记录，不修改）

- `store.ts` 的 `isDataReady` 在新旧版本里都只写不读，属历史死状态，本轮不清理。
- 图标尺寸、样式变量与 JSX 中的渐变 / 阴影等视觉细节不动。
- 不修改全局 `src/app.scss`、不增删任何接口层方法。
