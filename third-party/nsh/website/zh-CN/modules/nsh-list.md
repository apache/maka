---
title: List
description: List：基于原生滚动视图、虚拟化并复用单元格的列表，以及它的全部属性、事件和 ref 方法。
order: 2.1
---

# List

`nsh` 导出 `List`：一个基于原生滚动视图的虚拟化列表。只有视口附近的行才真正存在，滚动时单元格会被复用。哪些行存在、它们的位置、多列布局、吸顶标题和可见性都在原生侧计算，因此滚动一个上万条目的列表时，除了单元格被复用时变化的行绑定之外，不会运行任何 JS。

```ts
import { List, type ListProps, type ReadonlyListSource, type ViewToken, type ViewabilityConfig } from "nsh";
```

教程见[列表](../docs/lists.md)，元素的属性见 [`<List>`](../elements/list.md)。

## List

```ts
function List<T>(props: ListProps<T>): YNode;
```

```tsx
import { List, mount, Text, View } from "nsh";

const contacts = Array.from({ length: 1000 }, (_, i) => ({ id: String(i), name: `Contact ${i}` }));

function App() {
  return (
    <List each={contacts} estimatedItemSize={48} style={{ flex: 1 }}>
      {(item, index) => (
        <View style={{ height: 48, paddingHorizontal: 16, justifyContent: "center", backgroundColor: index() % 2 ? "#f8fafc" : "#fff" }}>
          <Text>{item().name}</Text>
        </View>
      )}
    </List>
  );
}

mount(App);
```

### 行会被复用

`children` 是一个渲染**单个单元格**的函数。它按单元格运行一次，而不是按条目运行一次：单元格滚出视口后会被复用来显示另一个条目，此时 `item()` 和 `index()`（两者都是 accessor）会变化。请在 JSX 表达式中读取它们（`{item().name}`），这样单元格被复用时才会更新。

> [!WARNING]
> 不要在行函数内部创建 signal 来保存每个条目的状态：单元格会被复用于其他条目，signal 跟着的是单元格而不是条目。请把这类状态放在数据里，按 id 索引（例如用一个保存已选 id 集合 `Set` 的 signal）。

## 属性

`ListProps<T>` 由列表自己的属性、与 `<Scroll>` 共用的滚动属性和所有元素通用的属性组成，通用属性传给列表的滚动视图。

### 数据与渲染

| 属性 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `each` | `readonly T[] \| ReadonlyListSource<T>` | （必填） | 条目。传入 signal 的值（`each={items()}`）即可跟随变化；在可见行之上插入数组条目时，可见行保持不动。 |
| `children` | `(item: () => T, index: () => number) => JSX.Element` | （必填） | 渲染一行（见上文）。 |
| `estimatedItemSize` | `number` | `50` | 尚未测量的行沿列表方向的尺寸（点）。估计越准，滚动条和 `scrollToIndex` 越准确。 |
| `numColumns` | `number` | `1` | 每行的条目数（纵向列表）：即网格。 |
| `horizontal` | `boolean` | `false` | 横向滚动。 |
| `inverted` | `boolean` | `false` | 从末端开始布局，条目 0 在最后（聊天风格）；初始滚动到末端，内容变化时保持与末端的距离。 |
| `stickyHeaderIndices` | `number[]` | | 滚动经过时吸附在顶部的条目（仅单列且非 inverted）。 |
| `header` | `ListSlot` | | 渲染在所有条目之前。 |
| `footer` | `ListSlot` | | 渲染在所有条目之后。 |
| `empty` | `ListSlot` | | `each` 为空时代替条目显示。 |
| `separator` | `ListSlot` | | 渲染在条目之间（单列）。 |
| `keyExtractor` | `(item: T, index: number) => string` | `item.key`、`item.id` 或索引 | 条目在可见性 token 中的 key。 |
| `initialScrollIndex` | `number` | | 在第一帧之前滚动到该条目。 |
| `contentStyle` | `ListContentStyle` | | 内容的内边距和间距：`padding`、`paddingHorizontal`、`paddingVertical`、`paddingTop`、`paddingRight`、`paddingBottom`、`paddingLeft`、`gap`、`rowGap`、`columnGap`（数字）。 |
| `contentClass` | `string` | | 以类名（`p-*`、`gap-*`）给出的内容内边距和间距；`contentStyle` 优先。 |
| `style` | `StyleProp<ViewStyle>` | | 列表自身的样式（需要给它尺寸：`flex: 1` 或高度）。 |
| `testID` | `string` | | UI 测试查找列表滚动视图所用的 id（`nsh test` 的 `id:`、XCUITest、UI Automator）。 |
| `ref` | `YNode \| ((node: YNode) => void)` | | 见 [ref 方法](#ref-方法)。 |

`ListSlot` 是一个组件（`Header`）或一个元素（`<Header />`）。

`ReadonlyListSource<T>` 提供按索引读取的快照；条目在行渲染或报告为可见时读取：

```ts
interface ReadonlyListSource<T> {
  readonly length: number;
  at(index: number): T;
}
```

`length` 是 0 到 4,294,967,295 的整数，与数组长度范围一致。`at` 接收此范围内小于 `length` 的索引，
其接收者为 source 本身。快照的长度和内容保持固定；替换快照时传入新的 source 对象。新的 source 会替换
整个条目范围；数组继续通过条目身份比较公共前后缀。source 可以直接从原生数据生成每个被请求的条目。

### 加载、刷新与可见性

| 属性 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `onLoadMore` | `() => void` | | 距离末端不超过 `loadMoreThreshold` 个视口时调用：用于加载更多。 |
| `loadMoreThreshold` | `number` | `1` | 距离末端多近（以视口长度计）时触发 `onLoadMore`。 |
| `onLoadMoreAtStart` | `() => void` | | 用户或滚动命令移动列表后，距离开头不超过 `loadMoreAtStartThreshold` 个视口时调用：加载第一项之前的内容。 |
| `loadMoreAtStartThreshold` | `number` | `1` | 距离开头多近（以视口长度计）时触发 `onLoadMoreAtStart`。 |
| `refreshing` | `boolean` | | 显示下拉刷新的加载指示器。 |
| `onRefresh` | `() => void` | | 启用下拉刷新；加载期间设置 `refreshing`。 |
| `refreshIndicator` | `{ height: number }` | | 应用自己绘制下拉刷新指示器，高 `height`，取代转圈。 |
| `pullValue` | `AnimatedValue` | | 写入列表被拉过顶部的距离，用于绘制那个指示器。 |
| `onViewableItemsChange` | `(info: { viewableItems: ViewToken<T>[]; changed: ViewToken<T>[] }) => void` | | 变为可见或不再可见的条目。 |
| `viewabilityConfig` | `ViewabilityConfig` | | 条目何时算作可见。 |

```ts
interface ViewToken<T> {
  item: T;
  key: string;
  index: number;
  isViewable: boolean;
}

interface ViewabilityConfig {
  /** 条目需覆盖视口的比例（0 到 1）才算可见。 */
  viewAreaCoverageThreshold?: number;
  /** 条目自身需可见的比例（0 到 1）。两个阈值都不设时，只要有一个像素可见就算。 */
  itemVisibleThreshold?: number;
  /** 条目需保持可见多少毫秒才会被报告。 */
  minimumViewTime?: number;
}
```

### 滚动

| 属性 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `scrollbar` | `boolean` | `true` | 显示滚动条。 |
| `scrollable` | `boolean` | `true` | 用户可以滚动。 |
| `bounces` | `boolean` | `true` | 允许越过边缘回弹。 |
| `pagingEnabled` | `boolean` | `false` | 按视口长度的整数倍停靠。 |
| `snapToInterval` | `number` | `0` | 按该长度的整数倍停靠（0：关闭）。 |
| `snapToOffsets` | `number[]` | | 停靠在这些偏移位置。 |
| `snapToAlignment` | `"start" \| "center" \| "end"` | `"start"` | 使用 `snapToInterval` 时条目的哪个位置与视口对齐。 |
| `disableIntervalMomentum` | `boolean` | `false` | 一次快速滑动最多移动一个停靠点。 |
| `decelerationRate` | `"normal" \| "fast" \| number` | 平台默认 | 快速滑动的减速快慢（`0.998` / `0.99`，或每毫秒保留的速度比例）。 |
| `contentInset` | `Partial<Edges>` | | 内容四周的留白。 |
| `contentOffset` | `{ x?, y? }` | | 初始滚动位置。 |
| `keyboardShouldPersistTaps` | `"never" \| "always" \| "handled" \| boolean` | `"never"` | 点击是否收起键盘（`"never"`：这次点击只用来收起键盘）。 |
| `keyboardDismissMode` | `"none" \| "on-drag" \| "interactive"` | `"none"` | 拖动时是否收起键盘。 |
| `scrollEventThrottle` | `number` | | `onScroll` 事件之间的最小间隔毫秒数（无论如何每帧最多一次）。 |
| `scrollValue` | `AnimatedValue` | | 在 UI 线程上接收滚动偏移（主轴方向）的[动画值](./nsh.md#animation)，用于与滚动联动的效果。 |

### 滚动事件

| 事件 | 数据 | 时机 |
|---|---|---|
| `onScroll` | `ScrollEvent`：`{ offset, contentSize, size, zoomScale }` | 滚动过程中。 |
| `onScrollDragStart` | `{ x, y }` | 开始拖动。 |
| `onScrollDragEnd` | `{ x, y }` | 手指抬起。 |
| `onMomentumStart` | `{ x, y }` | 拖动后开始惯性滑动。 |
| `onMomentumEnd` | `{ x, y }` | 惯性滑动结束（被新的拖动打断时也会触发）。 |
| `onScrollEnd` | `{ x, y }` | 滚动停止。 |

列表也接受所有元素通用的属性（[通用属性](../elements/index.md)）。

## ref 方法

列表的 `ref` 拿到的 `YNode` 有以下方法：

| 方法 | 说明 |
|---|---|
| `scrollToIndex({ index, animated?, viewPosition?, viewOffset? })` | 把条目 `index` 滚动到可见区域。`viewPosition` 决定位置：`0` 在视口开头（默认），`0.5` 在中间，`1` 在末尾；`viewOffset` 再额外偏移。由原生侧根据已测量（或估计）的行尺寸计算。 |
| `scrollToOffset({ offset, animated? })` | 沿列表方向滚动到某个内容偏移。 |
| `scrollToEnd({ animated? })` | 滚动到内容末尾（inverted 列表的开头）。 |
| `scrollTo({ x?, y?, animated? })` | 滚动到某个偏移。 |

```tsx
import { List, Text, View, type YNode } from "nsh";

let list!: YNode;

<View style={{ flex: 1 }}>
  <Text onPress={() => list.scrollToIndex({ index: 60, viewPosition: 0.5 })}>Jump to 60</Text>
  <List ref={list} each={items} numColumns={3} estimatedItemSize={90} style={{ flex: 1 }}
        contentStyle={{ padding: 12, gap: 8 }}>
    {(item) => <View style={{ height: 90, backgroundColor: "#e0e7ff" }}><Text>{item().title}</Text></View>}
  </List>
</View>
```

## 示例

聊天：最新消息在底部，向上滚动时加载更早的消息。

```tsx
<List
  each={messages()}
  inverted
  estimatedItemSize={44}
  style={{ flex: 1 }}
  contentStyle={{ padding: 12, gap: 6 }}
  keyboardDismissMode="interactive"
  onLoadMore={loadOlder}
  loadMoreThreshold={0.5}
>
  {(m) => (
    <View style={{ alignSelf: m().mine ? "flex-end" : "flex-start", maxWidth: "75%", padding: 10, borderRadius: 14, backgroundColor: m().mine ? "#6366f1" : "#e2e8f0" }}>
      <Text style={{ color: m().mine ? "#fff" : "#0f172a" }}>{m().text}</Text>
    </View>
  )}
</List>
```

下拉刷新：

```tsx
const refreshing = signal(false);
const refresh = async () => {
  refreshing.set(true);
  items.set(await load());
  refreshing.set(false);
};

<List each={items()} refreshing={refreshing()} onRefresh={refresh} style={{ flex: 1 }}>
  {(item) => <Text style={{ padding: 16 }}>{item().title}</Text>}
</List>
```

## ListItemsProps

```ts
type ListItemsProps<T> = Pick<ListProps<T>,
  "each" | "children" | "keyExtractor" | "stickyHeaderIndices" | "initialScrollIndex"
  | "onViewableItemsChange" | "viewabilityConfig" | "refreshing" | "onRefresh"
  | "onLoadMore" | "loadMoreThreshold"
  | "header" | "footer" | "empty">;
```

`ListProps` 中关于数据和行的那一半：传给你自己的、自行布局列表的组件（例如一个用自己的内边距和分隔线包装 `List` 的设置列表）的内容。
