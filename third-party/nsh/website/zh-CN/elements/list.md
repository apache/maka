---
title: List
description: 虚拟化、可复用单元格的列表：行、多列、吸顶标题、倒序聊天列表、可见性回调和滚动到指定项。
order: 7
group: primitives
demo: el-list
---

# List

`List` 用来展示很长或无上限的数据。视口附近的行才真正存在：用户滚动时，离开视口的行会被回收，用来显示新进入的行。哪些行存在、它们的位置、多列布局、吸顶标题和可见性都在原生侧计算，所以滚动一个上千项的列表，开销和二十项的列表相当。Rust 用 `virtual_list(count, |at| row)` 创建，TSX 用从 `nsh` 导入的 `<List>`。

```rust tabs
use nsh_core::prelude::*;

#[derive(Clone, PartialEq)]
struct Contact {
    id: usize,
    name: String,
}

fn app() -> impl IntoElement {
    let contacts = signal(
        (0..1000).map(|i| Contact { id: i, name: format!("联系人 {}", i + 1) }).collect::<Vec<_>>(),
    );
    virtual_list(move || contacts.with(|c| c.len()), move |at| {
        view().h(px(56.0)).px_4().justify_center().child(
            text(move || contacts.with(|c| format!("{}. {}", at.index() + 1, c[at.index()].name)))
                .text_base(),
        )
    })
    .estimated_item_size(px(56.0))
    .flex_1()
}
```

```tsx tabs
import { List, mount, Text, View } from "nsh";

const contacts = Array.from({ length: 1000 }, (_, i) => ({ id: i, name: `联系人 ${i + 1}` }));

function App() {
  return (
    <List each={contacts} estimatedItemSize={56} style={{ flex: 1 }}>
      {(contact, index) => (
        <View style={{ height: 56, paddingHorizontal: 16, justifyContent: "center" }}>
          <Text style={{ fontSize: 16 }}>
            {index() + 1}. {contact().name}
          </Text>
        </View>
      )}
    </List>
  );
}

mount(App);
```

在 TSX 中，`List` 是泛型组件：`List<T>` 会检查 `each` 与行函数的条目类型是否一致，TypeScript 会从 `each` 推断出条目类型（参见 [List API](../modules/nsh-list.md)）。在 Rust 中，`virtual_list` 接收行数（一个值、signal 或闭包：列表就地增减）和在某个 `Position` 构建行的函数；行通过 `at.index()` 读取组件的数据。

如果列表很短、所有行都应该存在（设置页、表单），在[滚动视图](./scroll.md)里用 [`Each`](./control-flow.md) 更简单。分组表格样式的列表见[设置风格的列表](../docs/lists.md#a-settings-style-list)。[列表指南](../docs/lists.md) 介绍了常见模式：无限加载、聊天、分组。

## 行会被复用

行函数对每个单元格执行一次，而不是对每个条目执行一次。单元格被复用来显示另一个条目时，它的位置会变化（TSX 中为 `item()` 和 `index()` 访问器；Rust 中为 `at.index()`），读取它的地方随之更新：

```rust tabs
virtual_list(move || messages.with(|m| m.len()), move |at| {
    text(move || messages.with(|m| m[at.index()].body.clone()))
})
```

```tsx tabs
<List each={messages()}>
  {(message) => <Text>{message().body}</Text>}
</List>
```

因此，每个条目自己的状态要放在数据里（按 id 区分），不要放在行函数内部创建的 signal 里：那样的 signal 会跟着单元格走，出现在别的条目上。

等待下一个条目的单元格，一旦它的行已不存在或由别的单元格显示，就会被隐藏，所以屏幕阅读器、触摸和 UI 测试每行只会遇到一次。

## 属性

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `each` | `virtual_list(count, ..)` | `readonly T[] \| ReadonlyListSource<T>` | | 条目：数组或[索引快照](../modules/nsh-list.md#数据与渲染)。 |
| `children` | `virtual_list(.., \|at\| row)` | `(item: () => T, index: () => number) => JSX.Element` | | 渲染一行。 |
| `estimatedItemSize` | `.estimated_item_size(px(..))` | `number` | `50` | 尚未测量的条目尺寸（点）。估值越接近，滚动条越稳定。 |
| `horizontal` | `.horizontal()` | `boolean` | `false` | 横向滚动。 |
| `viewport` | `.viewport(ListViewport::..)` | `"own" \| "parent"` | `"own"` | `"own"`：列表在自己的滚动视图中滚动。`"parent"`：列表没有自己的滚动视图，以完整长度排在父视图的布局中，只渲染外层滚动视图视口附近的行，随页面一起滚动（见[页面中的列表](../docs/lists.md#页面中的列表viewportparent)）。在列表创建时确定。 |
| `numColumns` | `.columns(n)` | `number` | `1` | 每行的条目数（纵向列表）。 |
| `inverted` | `.inverted()` | `boolean` | `false` | 从末端开始布局，第 0 项在最后（聊天样式）：初始滚动到末端，内容变化时保持与末端的距离。 |
| `maintainVisibleContentPosition` | `.follow_end(px(threshold))` | `{ autoscrollToBottomThreshold?: number }` | | 用于非倒序列表：位于内容末端或距末端不超过该点数时，内容增长或视口缩小时列表保持在末端；向上滚得更远时，可见内容保持不动。 |
| `stickyHeaderIndices` | `.sticky_header_indices([..])` | `number[]` | | 滚动经过时吸附在起始端的条目（单列、非倒序）。 |
| `contentStyle` | `.content_padding(..)`、`.content_padding_x(..)`、`.row_gap(..)`、`.column_gap(..)` 等 | `ListContentStyle` | | 内容的内边距和间距（点）：`padding`、`paddingHorizontal`、`paddingVertical`、`paddingTop`、`paddingRight`、`paddingBottom`、`paddingLeft`、`gap`、`rowGap`、`columnGap`。 |
| `contentClass` | | `string` | | 以类名（`p-*`、`gap-*`）给出的内容内边距和间距；`contentStyle` 优先。 |
| `header` | `.header(el)` | `ListSlot` | | 条目之前的内容：一个组件（`Header`）或一个元素（`<Header />`）。 |
| `footer` | `.footer(el)` | `ListSlot` | | 条目之后的内容。 |
| `empty` | `.empty(el)` | `ListSlot` | | `each` 为空时代替条目显示。 |
| `separator` | `.separator(\|\| el)` | `ListSlot` | | 条目之间的分隔（单列）。 |
| `initialScrollIndex` | `.initial_scroll_index(i)` | `number` | | 第一帧之前先滚动到该条目。 |
| `keyExtractor` | `.keys(\|\| ids)` | `(item: T, index: number) => string` | `item.key`、`item.id` 或索引 | 条目在可见性 token 中的 key。在 Rust 中是各行的标识，前面的行增删时，行保留自己的单元格和尺寸。 |
| `onLoadMore` | `.on_load_more(..)` | `() => void` | | 快到末端了：加载更多。 |
| `loadMoreThreshold` | `.load_more_threshold(viewports)` | `number` | `1` | 距末端多近（以视口为单位）时触发 `onLoadMore`。 |
| `onLoadMoreAtStart` | `.on_load_more_at_start(..)` | `() => void` | | 用户或滚动命令移动列表后快到开头了：加载第一项之前的内容。 |
| `loadMoreAtStartThreshold` | `.load_more_at_start_threshold(viewports)` | `number` | `1` | 距开头多近（以视口为单位）时触发 `onLoadMoreAtStart`。 |
| `onViewableItemsChange` | `.on_viewable_items_change(..)` | `(info: { viewableItems: ViewToken<T>[]; changed: ViewToken<T>[] }) => void` | | 有条目变为可见或不再可见。 |
| `viewabilityConfig` | `.viewability(..)`、`.minimum_view_time(..)` | `ViewabilityConfig` | | 条目何时算作可见（见下文）。 |
| `refreshing` | `.refreshing(..)` | `boolean` | | 显示下拉刷新的转圈。 |
| `onRefresh` | `.on_refresh(..)` | `() => void` | | 用户下拉刷新。 |
| `refreshIndicator` | `.refresh_indicator(Some(height))` | `{ height: number }` | | 应用自己绘制指示器，高 `height` 点：平台的转圈隐藏，下拉到 `height` 即刷新，刷新中在内容上方留出 `height`。`height` 不大于 0 时视为未设。 |
| `pullValue` | `.pull_value(&value)` | `AnimatedValue` | | 一个动画值，写入列表被拉过顶部的距离（静止为 0，随下拉增大；刷新中为内容上方留出的空间，设了 `refreshIndicator` 时等于 `height`），用来绘制应用的指示器。 |
| `scrollbar` | `.scrollbar(..)` | `boolean` | `true` | 显示滚动条。在桌面和桌面浏览器中，横向视图始终保留滚动条：它是鼠标的滚动条。 |
| `scrollValue` | `.scroll_value(&value)` | `AnimatedValue` | | 接收滚动偏移的动画值，用于随滚动变化的动画。 |
| `keyboardDismissMode` | `.keyboard_dismiss_mode(..)` | `"none" \| "on-drag" \| "interactive"` | `"none"` | 拖动时是否收起键盘。 |
| `style` | `Styled` 方法 | `StyleProp<ViewStyle>` | | 列表自身的样式（需要有确定的尺寸：`flex: 1` 或高度）。 |
| `testID` | `.test_id(id)` | `string` | | UI 测试查找列表滚动视图所用的 id（`nsh test` 的 `id:`、XCUITest、UI Automator）。 |
| `ref` | `.element_ref(&handle)` | `YNode \| (node: YNode) => void` | | 列表的节点（见 [ref 方法](#ref-方法)）。 |

列表同样支持 [`Scroll`](./scroll.md#滚动) 的滚动属性（Rust 中为 `Scrollable` 方法）：`pagingEnabled`、`snapToInterval`、`snapToOffsets`、`snapToAlignment`、`disableIntervalMomentum`、`decelerationRate`、`bounces`、`contentInset`、`contentOffset`、`keyboardShouldPersistTaps`、`scrollEventThrottle` 和 `scrollable`。列表保持原有比例。

所有元素通用的属性（[通用属性](./index.md#通用属性)）原样传给列表的滚动视图：`testID`、`accessibilityLabel` 等无障碍属性、样式、`onLayout`、触摸和响应者属性。UI 测试按 `testID` 找到列表，和找其他视图一样。

`ViewabilityConfig`（Rust：`Viewability { item_visible_percent, view_area_percent }` 与 `.minimum_view_time(..)`）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `itemVisiblePercentThreshold` | `number` | 条目可见部分须达到的百分比。 |
| `viewAreaCoveragePercentThreshold` | `number` | 条目须覆盖视口的百分比。两个阈值都不设时，露出任何一个像素都算可见。 |
| `minimumViewTime` | `number` | 条目须保持可见多少毫秒才会上报。 |

`ViewToken<T>` 为 `{ item, key, index, isViewable }`。Rust 的监听器收到 `ViewableItems`：`indices()` 是可见行的范围，`changed()` 是出现或离开的行。

## 事件

| 事件 | Rust | 载荷 | 时机 |
|---|---|---|---|
| `onScroll` | `.on_scroll` | `ScrollEvent` | 偏移发生变化。 |
| `onScrollDragStart` / `onScrollDragEnd` | `.on_scroll_drag_start` / `.on_scroll_drag_end` | `{ x, y }` | 开始 / 结束拖动。 |
| `onMomentumStart` / `onMomentumEnd` | `.on_momentum_start` / `.on_momentum_end` | `{ x, y }` | 惯性滑动开始 / 结束。 |
| `onScrollEnd` | `.on_scroll_end` | `{ x, y }` | 滚动停止。 |
| `onLoadMore` | `.on_load_more` | 无 | 距末端不足 `loadMoreThreshold` 个视口。 |
| `onLoadMoreAtStart` | `.on_load_more_at_start` | 无 | 滚动后距开头不足 `loadMoreAtStartThreshold` 个视口，每次接近触发一次。 |
| `onViewableItemsChange` | `.on_viewable_items_change` | `{ viewableItems, changed }`（`ViewableItems`） | 可见性变化。 |
| `onRefresh` | `.on_refresh` | 无 | 下拉刷新。 |

## ref 方法

| 方法 | Rust | 说明 |
|---|---|---|
| `scrollToIndex({ index, animated?, viewPosition?, viewOffset? })` | `scroll_to_index(index, percentage(0.5), px(0.0), animated)` | 把第 `index` 项滚动到视口内。`viewPosition` 决定位置：0 在视口起始处（默认），0.5 居中，1 在末端；`viewOffset` 再额外偏移。在原生侧按当前（已测量或估计的）条目尺寸计算。 |
| `scrollToOffset({ offset, animated? })` | `scroll_to_offset(px(..), animated)` | 沿列表方向滚动到某个偏移。 |
| `scrollToEnd({ animated? })` | `scroll_to_end(animated)` | 滚动到内容末端（倒序列表则是起始端）。 |
| `scrollTo({ x?, y?, animated? })` | `scroll_to(point(..), animated)` | 滚动到某个偏移。 |

## 示例

带标题和可见性回调的网格：

```rust tabs
let visible = signal(SharedString::default());
let list = element_ref();

virtual_list(move || photos.with(|p| p.len()), move |at| {
    image(move || photos.with(|p| p[at.index()].url.clone())).h(px(120.0)).rounded(px(8.0))
})
.element_ref(&list)
.columns(3)
.estimated_item_size(px(120.0))
.content_padding(px(12.0))
.row_gap(px(8.0))
.column_gap(px(8.0))
.viewability(Viewability { item_visible_percent: Some(50.0), ..Viewability::default() })
.on_viewable_items_change(move |items: &ViewableItems| {
    visible.set(format!("{} 项可见", items.indices().count()).into())
})
.header(
    text("跳到第 60 项")
        .on_press(move || list.scroll_to_index(60, percentage(0.5), px(0.0), true)),
)
.flex_1()
```

```tsx tabs
const visible = signal("");
let list!: YNode;

<List
  ref={list}
  each={photos}
  numColumns={3}
  estimatedItemSize={120}
  contentStyle={{ padding: 12, gap: 8 }}
  viewabilityConfig={{ itemVisiblePercentThreshold: 50 }}
  onViewableItemsChange={({ viewableItems }) => visible.set(`${viewableItems.length} 项可见`)}
  header={<Text onPress={() => list.scrollToIndex({ index: 60, viewPosition: 0.5 })}>跳到第 60 项</Text>}
  style={{ flex: 1 }}
>
  {(photo) => <Image src={photo().url} style={{ height: 120, borderRadius: 8 }} />}
</List>;
```

聊天：

```rust tabs
virtual_list(move || messages.with(|m| m.len()), move |at| bubble(messages, at))
    .keys(move || messages.with(|m| m.iter().map(|m| m.id).collect::<Vec<_>>()))
    .inverted()
    .estimated_item_size(px(64.0))
    .keyboard_dismiss_mode(KeyboardDismissMode::Interactive)
    .flex_1()
```

```tsx tabs
<List each={messages()} inverted estimatedItemSize={64} keyboardDismissMode="interactive" style={{ flex: 1 }}>
  {(m) => <Bubble message={m()} />}
</List>
```

第 0 项是最新的消息，画在最底部；新消息插到条目开头时，用户正在看的内容不会跳动。

## 平台说明

- 在可见行之上插入条目时，两个平台都会保持可见行不动。
- 从右到左布局中的横向列表在原生侧镜像。
- 吸顶标题在每一帧滚动时于原生侧固定。
