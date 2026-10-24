---
title: 列表
description: 用 Rust 和 TSX 渲染长列表和无限列表：复用、行标识、多列、吸顶标题、倒置的聊天列表、横向列表、页面中的列表、加载更多、可见性，以及滚动到指定条目。
order: 40
group: ui
demo: guide-lists
---

# 列表

列表（Rust 中的 `virtual_list(..)`，TSX 中 `nsh` 的 `List`）在原生滚动视图上渲染长数据，但只创建屏幕附近的行。哪些行存在、放在哪里、多列布局、吸顶标题以及哪些条目可见，全部由原生计算；只有当原生端要一个单元格时，你的代码才去填充内容。一百万条的列表，开销和三十条的差不多。

```rust tabs
use std::rc::Rc;

use nsh_core::ui::prelude::*;

#[component]
pub fn App() -> impl IntoElement {
    let titles: Rc<Vec<String>> = Rc::new((1..=10_000).map(|i| format!("Item {i}")).collect());
    virtual_list(titles.len(), move |at| {
        let titles = titles.clone();
        view()
            .p_4()
            .border_b_1()
            .border_b_color(rgb(0xeaeef2))
            .child(text(move || titles[at.index()].clone()).text_size(px(16.0)))
    })
    .estimated_item_size(px(52.0))
    .flex_1()
    .bg(white())
}
```

```tsx tabs
import { List, mount, Text, View } from "nsh";

const items = Array.from({ length: 10_000 }, (_, i) => ({ id: i, title: `Item ${i + 1}` }));

function App() {
  return (
    <List each={items} estimatedItemSize={52} style={{ flex: 1, backgroundColor: "#ffffff" }}>
      {(item) => (
        <View style={{ paddingHorizontal: 16, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: "#eaeef2" }}>
          <Text style={{ fontSize: 16 }}>{item().title}</Text>
        </View>
      )}
    </List>
  );
}

mount(App);
```

在 Rust 中，`virtual_list(count, row)` 接收行数（一个值、一个 signal 或一个闭包）和一个根据位置（`at.index()`）构建行的函数；行按这个索引读取你的数据。在 TSX 中，`each` 接收条目，行函数拿到条目。和[滚动视图](./scrolling.md)一样，列表本身是视口，需要父元素给出尺寸（`.flex_1()`、`flex: 1` 或一个高度）。

## 复用是如何工作的

行函数不是每个条目调用一次，而是**每个单元格**调用一次，并且单元格会被复用：某一行滚出屏幕足够远后，它的单元格会被分配给另一行，它的位置（Rust 中的 `at.index()`，TSX 中的 `item()` 和 `index()`）随之改变。行中读取位置的地方都会原地更新，就像其他任何 [signal](./reactivity.md) 一样。

由此得出两条规则：

**在用到的地方读取位置。** 在行函数开头复制出来的值，只属于这个单元格第一次显示的那一行。

```rust tabs
// 错误：单元格被复用后，`title` 仍是第一行的标题。
virtual_list(count, move |at| {
    let title = titles[at.index()].clone();
    text(title)
})

// 正确：文本跟随单元格当前的行。
virtual_list(count, move |at| {
    let titles = titles.clone();
    text(move || titles[at.index()].clone())
})
```

```tsx tabs
// 错误：单元格被复用后，`title` 仍是第一个条目的标题。
{(item) => {
  const title = item().title;
  return <Text>{title}</Text>;
}}

// 正确：文本跟随单元格当前的条目。
{(item) => <Text>{item().title}</Text>}
```

**把每个条目的状态放在数据里，而不是行里。** 在行内创建的 signal 属于单元格，会跟着它去到下一个条目。"这一行是否展开 / 选中 / 点赞" 应该存放在条目中，或存放在以 id 为键的集合里：

```rust tabs
let liked = signal(HashSet::<u32>::new());
let toggle = move |id: u32| {
    liked.update(|s| {
        if !s.remove(&id) {
            s.insert(id);
        }
    })
};

virtual_list(move || posts.with(Vec::len), move |at| {
    let post = computed(move || posts.with(|p| p[at.index()].clone()));
    view()
        .flex_row()
        .p_4()
        .child(text(move || post.with(|p| p.title.clone())).flex_1())
        .child(
            text(move || if liked.with(|s| s.contains(&post.with(|p| p.id))) { "♥" } else { "♡" })
                .on_press(move || toggle(post.with(|p| p.id))),
        )
})
.estimated_item_size(px(64.0))
.flex_1()
```

```tsx tabs
const liked = signal<Set<number>>(new Set());
const toggle = (id: number) =>
  liked.update((s) => {
    const next = new Set(s);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

<List each={posts()} estimatedItemSize={64} style={{ flex: 1 }}>
  {(post) => (
    <View style={{ flexDirection: "row", padding: 16 }}>
      <Text style={{ flex: 1 }}>{post().title}</Text>
      <Text onPress={() => toggle(post().id)}>{liked().has(post().id) ? "♥" : "♡"}</Text>
    </View>
  )}
</List>
```

各行可以高度不同。在测量之前，列表假定行高为预估尺寸（默认 50 点）；传入接近典型行高的值，滚动条和跳转到远处条目从一开始就会比较准确。

## 修改数据

在 Rust 中，把行数写成 signal 或闭包（`move || posts.with(Vec::len)`）：列表会原地增长和收缩。只在末尾增删的行不需要做别的；在其他位置增删行时，用 `.keys(move || posts.with(|p| p.iter().map(|p| p.id).collect::<Vec<_>>()))` 给出各行的标识，列表会保留相同的开头和结尾，中间部分视为删除和插入。

在 TSX 中，传入新数组即可改变条目：`posts.set([...posts(), ...more])`。列表会**按条目标识**（`===`）比较新旧数组，保留相同的开头和结尾，中间部分视为删除和插入。

两种方式下，测量结果都跟随各自的行；在屏幕上可见的行之上插入行时，可见行保持原位，不会跳动。

- 在 TSX 中用不可变的方式更新：新数组，未改变的条目对象原样复用。原地修改数组（`push`）不会被察觉。
- 改动过的条目应是一个新对象（`{ ...post, title }`），这样它的行才会显示变化。
- 在前面插入（新消息、刷新后的信息流）会保留用户的阅读位置。

`keyExtractor` 为可见性回调中的条目命名（见下文）；默认依次取 `item.key`、`item.id`、索引。在 TSX 中它不影响改动的匹配方式，匹配总是按标识进行。

## 属性

列表接受滚动视图中对列表有意义的所有滚动属性（`pagingEnabled`、`snapToInterval`、`snapToOffsets`、`snapToAlignment`、`decelerationRate`、`disableIntervalMomentum`、`bounces`、`scrollable`、`contentInset`、`contentOffset`、`keyboardShouldPersistTaps`、`keyboardDismissMode`、`scrollEventThrottle`、`onScroll`、`onScrollDragStart`、`onScrollDragEnd`、`onMomentumStart`、`onMomentumEnd`、`onScrollEnd`、`scrollValue`；在 Rust 中是与滚动视图相同的方法），说明见[滚动](./scrolling.md)。列表保持 1 倍缩放。它自己的属性：

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `each` | `virtual_list(count, ..)` | `readonly T[]` | | 条目；在 Rust 中是行数。 |
| `children` | `virtual_list(.., row)` | `(item: () => T, index: () => number) => JSX.Element` | | 渲染一个单元格；每个单元格调用一次，见[复用](#复用是如何工作的)。 |
| `estimatedItemSize` | `.estimated_item_size(px(..))` | `number` | `50` | 尚未测量的行的尺寸，单位为点。 |
| `horizontal` | `.horizontal()` | `boolean` | `false` | 横向滚动。 |
| `viewport` | `.viewport(ListViewport::..)` | `"own" \| "parent"` | `"own"` | `"own"`：列表在自己的滚动视图中滚动。`"parent"`：列表以完整长度排在外层滚动视图中，随页面其他内容一起滚动（见[页面中的列表](#页面中的列表viewportparent)）。在列表创建时确定。 |
| `numColumns` | `.columns(n)` | `number` | `1` | 每行的条目数（纵向列表）。 |
| `inverted` | `.inverted()` | `boolean` | `false` | 第 0 项在底部（聊天）；初始滚动到末尾，并保持与末尾的距离。 |
| `maintainVisibleContentPosition` | `.follow_end(px(..))` | `{ autoscrollToBottomThreshold?: number }` | | 非倒置列表在距离末尾不超过该点数时，随内容增长停留在末尾（见下文）。 |
| `stickyHeaderIndices` | `.sticky_header_indices(..)` | `number[]` | | 滚过时吸附在顶部的条目（单列且非倒置）。 |
| `stickyHeaderOffset` | `.sticky_header_offset(px(..))`、`.bind_sticky_header_offset(&node)` | `number \| AnimatedNode` | `0` | 吸顶条目吸附在距顶部多远的位置，同 CSS `position: sticky` 的 `top`；内容继续在其上方的空间下滚动。动画值让它们逐帧移动。 |
| `contentStyle` | `.content_padding(..)`、`.content_padding_x(..)` 等、`.row_gap(..)`、`.column_gap(..)` | `{ padding*, gap, rowGap, columnGap }` | | 内容的内边距和间距，只接受数字。 |
| `contentClass` | | `string` | | 同上，写成类名（`p-*`、`gap-*`）；`contentStyle` 优先。 |
| `header` | `.header(..)` | 组件或元素 | | 在条目之前。 |
| `footer` | `.footer(..)` | 组件或元素 | | 在条目之后。 |
| `empty` | `.empty(..)` | 组件或元素 | | 没有条目时代替条目显示。 |
| `separator` | `.separator(\|\| ..)` | 组件或元素 | | 条目之间（单列）。 |
| `initialScrollIndex` | `.initial_scroll_index(i)` | `number` | | 第一帧之前滚动到该条目。 |
| `onLoadMore` | `.on_load_more(..)` | `() => void` | | 接近末尾（见下文）。 |
| `loadMoreThreshold` | `.load_more_threshold(..)` | `number` | `1` | 距离末尾多少个视口时触发 `onLoadMore`。 |
| `onLoadMoreAtStart` | `.on_load_more_at_start(..)` | `() => void` | | 滚动后接近开头（见下文）。 |
| `loadMoreAtStartThreshold` | `.load_more_at_start_threshold(..)` | `number` | `1` | 距离开头多少个视口时触发 `onLoadMoreAtStart`。 |
| `onViewableItemsChange` | `.on_viewable_items_change(..)` | `(info) => void` | | 有条目变为可见或不再可见。 |
| `viewabilityConfig` | `.viewability(..)`、`.minimum_view_time(..)` | `ViewabilityConfig` | | 什么情况下条目算作可见。 |
| `keyExtractor` | `.keys(..)` | `(item, index) => string` | | 可见性回调中的键；在 Rust 中是各行的标识。 |
| `refreshing` / `onRefresh` | `.refreshing(..)` / `.on_refresh(..)` | `boolean` / `() => void` | | 下拉刷新。 |
| `scrollbar` | `.scrollbar(..)` | `boolean` | `true` | 显示滚动条。在桌面和桌面浏览器中，横向视图始终保留滚动条：它是鼠标的滚动条。 |
| `ref` | `.element_ref(&list)` | `YNode` | | `scrollToIndex`、`scrollToOffset`、`scrollToEnd`、`scrollTo`。 |

头部、尾部和空状态插槽接受元素（在 TSX 中也可以是组件：`header={Header}`）。它们是独立的单元格，从不被复用，并且和其他元素一样是响应式的。

## 多列与网格

`numColumns`（`.columns(n)`）把条目排成每行若干列；内容内边距添加在内容四周，并设置行间距和列间距。网格中各行的高度可以不同：每行与其中最高的条目一样高。

```rust tabs
let count = photos.len();
virtual_list(count, move |at| {
    let photos = photos.clone();
    image(move || photos[at.index()].thumb.clone()).aspect_square().rounded(px(8.0))
})
.columns(3)
.estimated_item_size(px(120.0))
.content_padding(px(12.0))
.row_gap(px(8.0))
.column_gap(px(8.0))
.flex_1()
```

```tsx tabs
<List
  each={photos}
  numColumns={3}
  estimatedItemSize={120}
  style={{ flex: 1 }}
  contentStyle={{ padding: 12, gap: 8 }}
>
  {(photo) => <Image src={photo().thumb} style={{ aspectRatio: 1, borderRadius: 8 }} />}
</List>
```

## 吸顶标题

`stickyHeaderIndices` 列出的条目在内容滚过时吸附在视口顶部，直到下一个吸顶条目把它推出去。分组列表就是一个由标题条目和普通行组成的列表，标题的索引设为吸顶。吸附在每一帧滚动时由原生完成。

```rust tabs
#[derive(Clone, PartialEq)]
enum Row {
    Header(String),
    Name(String),
}

let mut rows = Vec::new();
let mut headers = Vec::new();
for (letter, names) in groups {
    headers.push(rows.len());
    rows.push(Row::Header(letter));
    rows.extend(names.into_iter().map(Row::Name));
}
let count = rows.len();
let rows = Rc::new(rows);

virtual_list(count, move |at| {
    let rows = rows.clone();
    let row = computed(move || rows[at.index()].clone());
    let is_header = computed(move || matches!(row.get(), Row::Header(_)));
    let label = move || match row.get() {
        Row::Header(s) | Row::Name(s) => s,
    };
    when(is_header, move || {
        text(label).p(px(6.0)).bg(rgb(0xeaeef2)).font_weight(FontWeight::BOLD)
    })
    .otherwise(move || text(label).p_3())
})
.sticky_header_indices(headers)
.estimated_item_size(px(44.0))
.flex_1()
```

```tsx tabs
type Row = { header: string } | { name: string };

const rows: Row[] = [];
const headers: number[] = [];
for (const [letter, names] of groups) {
  headers.push(rows.length);
  rows.push({ header: letter });
  for (const name of names) rows.push({ name });
}

<List each={rows} stickyHeaderIndices={headers} estimatedItemSize={44} style={{ flex: 1 }}>
  {(row) => (
    <If
      when={"header" in row()}
      else={<Text style={{ padding: 12 }}>{(row() as { name: string }).name}</Text>}
    >
      <Text style={{ padding: 6, backgroundColor: "#eaeef2", fontWeight: "700" }}>{(row() as { header: string }).header}</Text>
    </If>
  )}
</List>
```

同一个单元格可能这会儿显示标题、过一会儿显示名字，所以行用 [`when` / `<If>`](../elements/control-flow.md) 决定渲染什么，它会在行改变时切换。吸顶标题要求单列且列表不倒置。

`stickyHeaderOffset`（Rust 中为 `.sticky_header_offset(..)`）让标题吸附在距顶部这么多点的位置，如同 CSS `position: sticky` 的 `top`：在 56 点高的半透明栏下，`stickyHeaderOffset={56}`（`.sticky_header_offset(px(56.0))`）让每个标题停在栏的下方，行则继续在栏下滚动，下一个标题从那里把它推出去。负值会让标题的一部分移出视口。

偏移量可以是[动画值](./animation.md#动画值)（Rust 中为 `.bind_sticky_header_offset(&node)`）：标题在 UI 线程上逐帧跟随它，因此始终停在移动的栏下方。对于内容向下滚动时隐藏、向上滚动时重新出现的栏（[`diffClamp`](./animation.md#算术运算与-diffclamp)），标题无论栏在哪里都吸附在它的下边缘：

```rust tabs
let offset = animated_value(0.0);
let hidden = offset.diff_clamp(0.0, 56.0);
let shown = hidden.mul(-1.0).add(56.0);

view().flex_1().overflow_hidden().child(
    virtual_list(rows.len(), row)
        .scroll_value(&offset)
        .sticky_header_indices(headers)
        .bind_sticky_header_offset(&shown),
).child(view().absolute().top_0().left_0().right_0().h(px(56.0)).bind_translate_y(&hidden.mul(-1.0)))
```

```tsx tabs
const scroll = createAnimatedValue(0);
const hidden = scroll.diffClamp(0, 56);
const shown = hidden.mul(-1).add(56);

<View style={{ flex: 1, overflow: "hidden" }}>
  <List each={rows} scrollValue={scroll} stickyHeaderIndices={headers} stickyHeaderOffset={shown}>…</List>
  <View style={{ position: "absolute", top: 0, left: 0, right: 0, height: 56, transform: [{ translateY: hidden.mul(-1) }] }}>…</View>
</View>
```

## 聊天：倒置列表

`inverted` 让列表从末尾开始排版：第 0 项在底部，列表初始滚动到末尾，并在条目变化时保持与末尾的距离。把最新的消息放在最前面；添加消息时插到前面，用 `onLoadMore` 加载更早的消息时追加到后面（倒置列表的"末尾"是顶部）。从一条旧消息打开的聊天用 [`onLoadMoreAtStart`](#在开头加载onloadmoreatstart) 加载更新的消息；设置它后，列表在底部时保持与底部的距离，向上滚动后条目变化时屏幕上的消息保持原位。

```rust tabs
use nsh_base::keyboard_avoiding_view;

#[derive(Clone, PartialEq)]
struct Message {
    id: u32,
    text: String,
    mine: bool,
}

pub fn chat() -> impl IntoElement {
    let next = stored(0_u32);
    let message = move |text: String, mine: bool| Message {
        id: next.with(|n| {
            *n += 1;
            *n
        }),
        text,
        mine,
    };
    // 最新的在最前。
    let messages = signal(
        (0..30)
            .map(|i| message(format!("Message {}", 30 - i), i % 3 == 0))
            .collect::<Vec<_>>(),
    );
    let draft = signal(String::new());
    let send = move || {
        let text = draft.get_untracked();
        if text.trim().is_empty() {
            return;
        }
        let sent = message(text, true);
        messages.update(|m| m.insert(0, sent));
        draft.set(String::new());
    };
    let load_older = move || {
        let older: Vec<_> = (0..20).map(|i| message(format!("Older {i}"), false)).collect();
        messages.update(|m| m.extend(older));
    };
    let list = virtual_list(
        move || messages.with(Vec::len),
        move |at| {
            let mine = computed(move || messages.with(|m| m[at.index()].mine));
            view()
                .style_when(mine, |s| s.self_end().bg(rgb(0x0969da)))
                .style_when(move || !mine.get(), |s| s.self_start().bg(rgb(0xeaeef2)))
                .max_w(relative(0.75))
                .px_3()
                .py_2()
                .rounded(px(14.0))
                .child(
                    text(move || messages.with(|m| m[at.index()].text.clone()))
                        .text_color(move || if mine.get() { rgb(0xffffff) } else { rgb(0x1f2328) }),
                )
        },
    )
    .keys(move || messages.with(|m| m.iter().map(|m| m.id).collect::<Vec<_>>()))
    .inverted()
    .estimated_item_size(px(44.0))
    .content_padding(px(12.0))
    .row_gap(px(6.0))
    .keyboard_dismiss_mode(KeyboardDismissMode::Interactive)
    .on_load_more(load_older)
    .load_more_threshold(0.5)
    .flex_1();
    keyboard_avoiding_view()
        .flex_1()
        .child(list)
        .child(
            view().flex_row().gap_2().p_2().child(
                input()
                    .value(move || draft.get())
                    .on_change(move |text: &str| draft.set(text.to_owned()))
                    .on_submit(move |_: &str| send())
                    .multiline(true)
                    .submit_behavior(SubmitBehavior::Submit)
                    .return_key_type(ReturnKeyType::Send)
                    .placeholder("Message")
                    .flex_1()
                    .max_h(px(120.0))
                    .border_1()
                    .border_color(rgb(0xd0d7de))
                    .rounded(px(18.0))
                    .px_3()
                    .py_2(),
            ),
        )
}
```

```tsx tabs
import { Input, List, mount, signal, Text, View } from "nsh";
import { KeyboardAvoidingView } from "nsh/base";

type Message = { id: number; text: string; mine: boolean };

function Chat() {
  let next = 0;
  const message = (text: string, mine: boolean): Message => ({ id: next++, text, mine });
  const messages = signal(Array.from({ length: 30 }, (_, i) => message(`Message ${30 - i}`, i % 3 === 0)));
  const draft = signal("");
  const send = () => {
    if (!draft().trim()) return;
    messages.update((m) => [message(draft(), true), ...m]); // 最新的在最前
    draft.set("");
  };
  const loadOlder = () => messages.update((m) => [...m, ...Array.from({ length: 20 }, (_, i) => message(`Older ${i}`, false))]);
  return (
    <KeyboardAvoidingView style={{ flex: 1 }}>
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
          <View
            style={{
              alignSelf: m().mine ? "flex-end" : "flex-start",
              maxWidth: "75%",
              paddingHorizontal: 12,
              paddingVertical: 8,
              borderRadius: 14,
              backgroundColor: m().mine ? "#0969da" : "#eaeef2",
            }}
          >
            <Text style={{ color: m().mine ? "#ffffff" : "#1f2328" }}>{m().text}</Text>
          </View>
        )}
      </List>
      <View style={{ flexDirection: "row", gap: 8, padding: 8 }}>
        <Input
          value={draft()}
          onChange={(t) => draft.set(t)}
          onSubmit={send}
          multiline
          submitBehavior="submit"
          returnKeyType="send"
          placeholder="Message"
          style={{ flex: 1, maxHeight: 120, borderWidth: 1, borderColor: "#d0d7de", borderRadius: 18, paddingHorizontal: 12, paddingVertical: 8 }}
        />
      </View>
    </KeyboardAvoidingView>
  );
}

mount(Chat);
```

在倒置列表上调用 `scroll_to_end(..)` / `scrollToEnd()` 会滚动到它的开头，也就是最新的消息。

### 让非倒置列表跟随末尾

按阅读顺序排列（最早的在前）的列表也可以跟随末尾：在 Rust 中用 `.follow_end(px(40.0))`，在 TSX 中用 `maintainVisibleContentPosition={{ autoscrollToBottomThreshold: 40 }}`，当用户停在末尾（或距离末尾不超过 40 点）时，列表会随内容增长停留在末尾：流式写入最后一项的回复、追加的新消息、键盘让列表变矮。用户往上滚得更远时，可见内容保持不动，新内容在其下方增长。在可见条目之上插入的条目从不会移动它们，无论是否设置该选项。

```rust tabs
virtual_list(move || messages.with(Vec::len), move |at| bubble(messages, at))
    .keys(move || messages.with(|m| m.iter().map(|m| m.id).collect::<Vec<_>>()))
    .follow_end(px(40.0))
    .flex_1()
```

```tsx tabs
<List each={messages()} keyExtractor={(m) => m.id} maintainVisibleContentPosition={{ autoscrollToBottomThreshold: 40 }} style={{ flex: 1 }}>
  {(m) => <Bubble message={m()} />}
</List>
```

## 横向列表

`horizontal` 让列表横向排列；单元格按列表的高度排版。配合吸附可以做出任意长度的轮播：

```rust tabs
let count = cards.len();
virtual_list(count, move |at| {
    let cards = cards.clone();
    view()
        .w(px(220.0))
        .h(px(140.0))
        .rounded(px(14.0))
        .bg(move || cards[at.index()].color)
})
.horizontal()
.estimated_item_size(px(232.0))
.snap_interval(px(232.0))
.deceleration(0.99)
.scrollbar(false)
.content_padding_x(px(16.0))
.column_gap(px(12.0))
.h(px(140.0))
```

```tsx tabs
<List
  each={cards}
  horizontal
  estimatedItemSize={232}
  snapToInterval={232}
  decelerationRate="fast"
  scrollbar={false}
  style={{ height: 140 }}
  contentStyle={{ paddingHorizontal: 16, gap: 12 }}
>
  {(card) => <View style={{ width: 220, height: 140, borderRadius: 14, backgroundColor: card().color }} />}
</List>
```

在从右到左布局中，横向列表从右侧开始向左排列。

## 页面中的列表：viewport="parent"

页面常常整体滚动：一个标题、几张卡片，然后是一个长列表，下面可能还有另一个列表。给列表设置 `viewport="parent"`（Rust 中是 `.viewport(ListViewport::Parent)`），并把它和页面的其他内容一起放进 `Scroll`：列表以完整的长度排在页面中，由页面的滚动视图和其他内容一起滚动。它仍然只创建页面视口附近的行并复用单元格，因此一个页面可以容纳多个长列表。

```rust tabs
scroll()
    .flex_1()
    .child(header())
    .child(
        virtual_list(count, row)
            .viewport(ListViewport::Parent)
            .estimated_item_size(px(56.0))
            .row_gap(px(6.0)),
    )
    .child(footer())
```

```tsx tabs
<Scroll style={{ flex: 1 }}>
  <Header />
  <List viewport="parent" each={items} estimatedItemSize={56} contentStyle={{ gap: 6 }}>
    {(item) => <Row item={item()} />}
  </List>
  <Footer />
</Scroll>
```

- 列表的长度就是它所有行的长度：它的高度（横向时是宽度）由内容决定，和普通视图一样；内边距、边框和外边距也和视图上的效果相同。
- 它的行跟随沿其方向最近的外层滚动视图，或者它所在的屏幕。
- 页面会像浏览器一样保持你正在阅读的内容不动：完全位于视口顶部以上的行改变尺寸时，页面随之移动同样的距离；列表开头在视口内时，变高的行会把下面的内容往下推。
- `scrollToIndex`、`scrollToEnd` 和 `initialScrollIndex` 会在页面内容范围内把页面滚动到列表的行；列表末尾接近视口时触发 `onLoadMore`，`onViewableItemsChange` 报告页面视口中的行。
- `stickyHeaderIndices` 和 `stickyHeaderOffset` 让行吸附在页面顶部：分组标题停在顶部，它的行从下面滚过，直到下一个标题把它推出；最后一个标题随列表的末尾一起离开。
- 页面如何滚动由它的滚动视图决定：把 `onScroll` 等滚动事件、`scrollValue`、`refreshing` / `onRefresh`、分页和吸附、`contentInset`、`scrollbar`、`scrollable` 和 `keyboardDismissMode` 设置在 `Scroll` 上。倒置列表和 `maintainVisibleContentPosition` 属于拥有自己视口的列表（`viewport="own"`，默认值）。
- 视口在列表创建时确定：要切换，请渲染一个新的列表。

## 加载更多：onLoadMore

当视口距离末尾不到 `loadMoreThreshold` 个视口时（默认 1：提前一屏），触发 `onLoadMore`（`.on_load_more(..)`）。追加下一页数据；新的末尾临近时会再次触发。

```rust tabs
let posts = signal(Vec::<Post>::new());
let page = stored(0_u32);
let loading = stored(false);

let load_more = move || {
    if loading.replace(true) {
        return;
    }
    let next = page.with(|p| {
        *p += 1;
        *p
    });
    spawn(async move {
        if let Ok(response) = fetch(format!("https://api.example.com/posts?page={next}")).await {
            let more = parse_posts(&response.text());
            posts.update(|p| p.extend(more));
        }
        loading.replace(false);
    });
};
load_more();

virtual_list(move || posts.with(Vec::len), move |at| post_row(posts, at))
    .estimated_item_size(px(72.0))
    .on_load_more(load_more)
    .load_more_threshold(0.5)
    .footer(text("Loading…").p_4().text_center().text_color(rgb(0x8c959f)))
    .flex_1()
```

```tsx tabs
const posts = signal<Post[]>([]);
let loading = false;
let page = 0;

const loadMore = async () => {
  if (loading) return;
  loading = true;
  try {
    const next: Post[] = await (await fetch(`https://api.example.com/posts?page=${++page}`)).json();
    posts.set([...posts(), ...next]);
  } finally {
    loading = false;
  }
};
loadMore();

<List
  each={posts()}
  estimatedItemSize={72}
  style={{ flex: 1 }}
  onLoadMore={loadMore}
  loadMoreThreshold={0.5}
  footer={<Text style={{ padding: 16, textAlign: "center", color: "#8c959f" }}>Loading…</Text>}
>
  {(post) => <PostRow post={post()} />}
</List>
```

像上面那样防止重复加载：在一页数据返回之前，末尾可能会被再次报告。

## 在开头加载：onLoadMoreAtStart

列表也可以从数据的中间打开：从搜索结果或引用跳到一条旧消息的聊天，显示的是它附近的一页，更新的消息还没有加载。当视口距离开头不到 `loadMoreAtStartThreshold` 个视口时（默认 1），触发 `onLoadMoreAtStart`（`.on_load_more_at_start(..)`）。开头是第 0 项所在的一侧：普通列表的顶部，倒置列表的底部。把这一页插到前面：新内容到达时，屏幕上的行保持原位（倒置列表离开底部后也是如此）；下一次接近开头时会再次触发，如果新的一页插入后仍在开头附近，则立即再次触发。

只有在用户滚动到开头，或滚动命令（包括 `initialScrollIndex`）把列表带到那里之后才会触发：从最新一项打开的列表不会请求任何内容，而用 `initialScrollIndex` 打开在开头附近的列表会立刻请求它之前的一页。

```rust tabs
let messages = signal(page_around(target)); // 最新的在前，结尾是一条旧消息
let loading = stored(false);

let load_newer = move |_: &()| {
    if loading.replace(true) {
        return;
    }
    let newest = messages.with(|m| m[0].id);
    spawn(async move {
        if let Ok(response) = fetch(format!("https://api.example.com/messages?after={newest}")).await {
            let newer = parse_messages(&response.text());
            messages.update(|m| {
                m.splice(0..0, newer);
            });
        }
        loading.replace(false);
    });
};

virtual_list(move || messages.with(Vec::len), move |at| message_row(messages, at))
    .inverted(true)
    .on_load_more(load_older)
    .on_load_more_at_start(load_newer)
    .load_more_at_start_threshold(0.5)
    .flex_1()
```

```tsx tabs
const messages = signal<Message[]>(pageAround(target)); // 最新的在前，结尾是一条旧消息
let loading = false;

const loadNewer = async () => {
  if (loading) return;
  loading = true;
  try {
    const newest = messages()[0].id;
    const newer: Message[] = await (await fetch(`https://api.example.com/messages?after=${newest}`)).json();
    messages.set([...newer, ...messages()]);
  } finally {
    loading = false;
  }
};

<List
  each={messages()}
  inverted
  style={{ flex: 1 }}
  onLoadMore={loadOlder}
  onLoadMoreAtStart={loadNewer}
  loadMoreAtStartThreshold={0.5}
>
  {(message) => <Bubble message={message()} />}
</List>
```

加载到最新的消息后就停止加载：之后新消息会像在任何聊天中一样出现在开头。

## 可见性

`onViewableItemsChange`（`.on_viewable_items_change(..)`）报告哪些条目在屏幕上，可用于统计曝光、自动播放可见的视频或把消息标记为已读。在 TSX 中它收到 `{ viewableItems, changed }`，两者都是由 `{ item, key, index, isViewable }` 组成的数组；在 Rust 中它收到 `ViewableItems`，包含第一个和最后一个可见行（`viewable`）以及状态发生变化的行（`changed()`）。可见性由原生计算，你的代码只在变化时收到通知。

| `viewabilityConfig` | Rust | 说明 |
|---|---|---|
| `itemVisiblePercentThreshold` | `Viewability { item_visible_percent, .. }` | 条目必须可见的百分比。 |
| `viewAreaCoveragePercentThreshold` | `Viewability { view_area_percent, .. }` | 条目必须覆盖视口的百分比。 |
| `minimumViewTime` | `.minimum_view_time(Duration)` | 条目保持可见多少毫秒后才被报告。 |

不设阈值时，只要有一个像素可见就算可见。

```rust tabs
let playing = signal(None::<usize>);

virtual_list(count, move |at| video_card(videos.clone(), at))
    .estimated_item_size(px(300.0))
    .viewability(Viewability {
        item_visible_percent: Some(60.0),
        ..Viewability::default()
    })
    .minimum_view_time(Duration::from_millis(250))
    .on_viewable_items_change(move |rows: &ViewableItems| {
        playing.set(rows.viewable.map(|(first, _)| first))
    })
    .flex_1()
```

```tsx tabs
<List
  each={videos}
  estimatedItemSize={300}
  style={{ flex: 1 }}
  keyExtractor={(v) => v.slug}
  viewabilityConfig={{ itemVisiblePercentThreshold: 60, minimumViewTime: 250 }}
  onViewableItemsChange={({ viewableItems }) => playing.set(viewableItems[0]?.key ?? null)}
>
  {(v) => <VideoCard video={v()} />}
</List>
```

## 从代码滚动

给列表设置 ref（Rust 中用 `element_ref()` 和 `.element_ref(&list)`，TSX 中用 `ref`）：

| Rust | TSX | 说明 |
|---|---|---|
| `scroll_to_index(index, view_position, view_offset, animated)` | `scrollToIndex({ index, animated?, viewPosition?, viewOffset? })` | 把第 `index` 项滚动到可见。视图位置决定它在哪里：0 在视口开头（默认），0.5 在中间，1 在末尾；视图偏移再额外偏移。 |
| `scroll_to_offset(offset, animated)` | `scrollToOffset({ offset, animated? })` | 沿列表主轴滚动到内容偏移处。 |
| `scroll_to_end(animated)` | `scrollToEnd({ animated? })` | 滚动到内容末尾（倒置列表则是开头）。 |
| `scroll_to(point, animated)` | `scrollTo({ x?, y?, animated? })` | 滚动到某个偏移，与滚动视图相同。 |

```rust tabs
let list = element_ref();

virtual_list(count, row).estimated_item_size(px(48.0)).flex_1().element_ref(&list)

list.scroll_to_index(120, percentage(0.5), px(0.0), true);
```

```tsx tabs
import { List, type YNode } from "nsh";

let list!: YNode;

<List ref={list} each={items} estimatedItemSize={48} style={{ flex: 1 }}>…</List>

list.scrollToIndex({ index: 120, viewPosition: 0.5 });
```

滚动到索引（以及滚动到末尾）由原生根据当时已知的尺寸计算：已测量的行用实测值，其余用预估尺寸。之后在目标附近的行被测量时，列表会持续跟随目标，因此能准确落位，直到用户自己滚动或数据变化为止。要让列表一打开就停在某个条目，请用 `initialScrollIndex`（`.initial_scroll_index(..)`），而不是在第一帧之后再滚动。

<a id="a-settings-style-list"></a>

## 设置风格的列表

列表的外观属于应用自己：列表负责摆放和复用行，行、分隔线和表面都是你的视图。分组的设置风格列表就是一个带内边距、分隔线、首尾行圆角的列表。把它写成自己的组件，在应用中需要列出设置的地方使用：

```rust tabs
use std::rc::Rc;

use nsh_core::ui::{palette::NEUTRAL, prelude::*};

pub struct Setting {
    pub id: &'static str,
    pub label: &'static str,
}

pub fn settings_list(settings: Rc<Vec<Setting>>, on_select: impl Fn(&Setting) + 'static) -> impl IntoElement {
    let surface = AdaptiveColor::new(white(), NEUTRAL.shade(900));
    let on_select = Rc::new(on_select);
    let count = settings.len();
    view().flex_1().bg(AdaptiveColor::new(NEUTRAL.shade(100), NEUTRAL.shade(950))).child(
        virtual_list(count, move |at| {
            let (pressed, shown, on_select) = (settings.clone(), settings.clone(), on_select.clone());
            view()
                .on_press(move || on_select(&pressed[at.index()]))
                .role(AccessibilityRole::Button)
                .h_12()
                .justify_center()
                .bg(surface)
                .px_4()
                .active(|s| s.bg(NEUTRAL.shade(200)))
                .rounded_t(move || px(if at.is_first() { 12.0 } else { 0.0 }))
                .rounded_b(move || px(if at.is_last() { 12.0 } else { 0.0 }))
                .child(text(move || shown[at.index()].label))
        })
        .estimated_item_size(px(48.0))
        .content_padding(px(16.0))
        .separator(move || {
            view()
                .bg(surface)
                .child(view().ml_4().h(px(1.0)).bg(AdaptiveColor::new(NEUTRAL.shade(200), NEUTRAL.shade(800))))
        })
        .flex_1(),
    )
}
```

```tsx tabs
import { List, Text, View } from "nsh";

type Setting = { id: string; label: string };

function SettingsList(props: { each: Setting[]; onSelect: (s: Setting) => void }) {
  return (
    <View class="flex-1 bg-neutral-100 dark:bg-neutral-950">
      <List
        each={props.each}
        estimatedItemSize={48}
        style={{ flex: 1 }}
        contentStyle={{ padding: 16 }}
        separator={() => (
          <View class="bg-white dark:bg-neutral-900">
            <View class="ml-4 h-px bg-neutral-200 dark:bg-neutral-800" />
          </View>
        )}
      >
        {(s, i) => (
          <View
            onPress={() => props.onSelect(s())}
            role="button"
            class="h-12 justify-center bg-white px-4 active:bg-neutral-200 dark:bg-neutral-900"
            classList={{ "rounded-t-xl": i() === 0, "rounded-b-xl": i() === props.each.length - 1 }}
          >
            <Text>{s().label}</Text>
          </View>
        )}
      </List>
    </View>
  );
}
```

## 性能提示

- 每个单元格单独排版，滚动时只重新排版有变化的单元格。行的层级保持浅一些，避免在行里读取每帧都会变化的 signal。
- 原生端分批请求单元格，每帧可以进行多轮，合并成一次更新；快速滑动时一帧内绑定许多单元格，也不会每个单元格调用一次你的代码。Rust 的行由核心自己在需要它们的那次提交中绑定。
- 用 [`nsh test --trace` 加上 `scroll` 步骤](./testing-and-trace.md#滚动)测量行在每一帧的开销。

## 相关内容

- [`List` 元素](../elements/list.md)：参考。
- [滚动](./scrolling.md)：列表与滚动视图共用的滚动属性。
- [响应式](./reactivity.md)：为什么行要在绑定中读取位置。
- [性能](./performance.md)：测量列表。
