---
title: Pagination
description: Pagination 组件：在一组内容的各页之间移动，显示当前页附近的页码、省略号、上一页和下一页，提供紧凑的翻页器、键盘操作，并让屏幕阅读器知道当前页，样式由应用决定。
group: base
demo: el-pagination
---

# Pagination

分页用于在一组内容的各页之间移动，比如搜索结果、表格的行、归档列表。它依次显示上一页、当前页附近的页码（第一页和最后一页总会显示，每段被省略的页显示一个省略号）、应用的子元素和下一页。它负责行为：显示哪些页、按压、键盘、两端时禁用上一页和下一页、导航地标，以及让屏幕阅读器知道当前页。外观由应用决定：各项没有自己的颜色、尺寸或文字，由应用设置样式或自己绘制。

```rust tabs
use nsh_base::{pagination, theme};
use nsh_core::prelude::*;

fn results() -> impl IntoElement {
    let page = signal(1u32);
    pagination()
        .page(move || page.get())
        .total_pages(24)
        .accessibility_label("Search results")
        .previous_accessibility_label("Previous")
        .next_accessibility_label("Next")
        .item_class("min-w-9 h-9 px-2 items-center justify-center rounded-md hover:bg-accent selected:bg-primary selected:text-primary-foreground disabled:opacity-50")
        .gap_1()
        .on_change(move |p: &u32| page.set(*p))
}
```

```tsx tabs
import { mount, signal } from "nsh";
import { Pagination } from "nsh/base";

function App() {
  const page = signal(1);
  return (
    <Pagination
      page={page()}
      totalPages={24}
      accessibilityLabel="Search results"
      previousAccessibilityLabel="Previous"
      nextAccessibilityLabel="Next"
      class="gap-1"
      itemClass="min-w-9 h-9 px-2 items-center justify-center rounded-md hover:bg-accent selected:bg-primary selected:text-primary-foreground disabled:opacity-50"
      onChange={({ page: next }) => page.set(next)}
    />
  );
}

mount(App);
```

`Pagination` 来自 [`nsh/base`](../modules/nsh-base.md)，在 Rust 中是 `nsh-base` crate。Rust 中 `pagination()` 创建一个分页，每个 prop 有一个 setter（`.page(..)`、`.total_pages(..)`），`.on_change(..)` 接收用户选择的页，行用带类型的样式方法设置，应用的内容用 `.child(..)` 放入。

## 当前页

当前页由应用持有：`page` 是当前页，从 1 开始；用户按下某一页、上一页或下一页时，`onChange({ page })` 报告所选的页。应用设置它、加载那一页并显示其中的内容。`totalPages` 是总页数；超过最后一页的 `page` 显示为最后一页。按下当前页不会报告任何事件，第一页时的上一页和最后一页时的下一页也一样。

## 显示的页

`visiblePages`（至少 5，也是默认值）页放得下时，所有页都会显示。超过时，显示第一页和最后一页、当前页及其两侧各 `(visiblePages - 3) / 2` 页，每段被省略的页显示一个省略号：

| 共 20 页时的 `page`，`visiblePages={7}` | 显示 |
|---|---|
| 1 | `1 2 3 4 5 … 20` |
| 6 | `1 … 4 5 6 7 8 … 20` |
| 20 | `1 … 16 17 18 19 20` |

一万页时显示的也是同样的七项。奇数的 `visiblePages` 让当前页居中。

## 各项

每一项都使用应用的 `itemClass` 和 `itemStyle`：当前页带 `selected:`，不接受按压的项带 `disabled:`，获得键盘焦点的项带 `focus:`。整行的布局由应用的 `class` 决定（默认是一行；`gap-*`、`justify-*`）。

没有 `renderItem` 时，页显示页码，省略号显示 `…`，上一页和下一页显示它们的无障碍标签（没有标签时显示 `‹` 和 `›`）。`renderItem` 根据 `PaginationItemState` 绘制每一项的内容：

| 字段 | 类型 | 说明 |
|---|---|---|
| `kind` | `"previous" \| "page" \| "ellipsis" \| "next"` | 这一项是什么。 |
| `page` | `number` | 页的页码；上一页或下一页要去的页（两端时为当前页）；省略号省略的第一页。 |
| `start`、`end` | `number` | 省略号省略的页：包含 `start`，不包含 `end`（下一个显示的页）。 |
| `current` | `boolean` | 是否是当前页。 |
| `disabled` | `boolean` | 不接受按压：第一页时的上一页、最后一页时的下一页、禁用的分页中的所有项。 |

```tsx
<Pagination
  page={page()}
  totalPages={pages()}
  previousAccessibilityLabel="Previous page"
  nextAccessibilityLabel="Next page"
  itemClass="size-9 items-center justify-center rounded-md selected:bg-primary"
  renderItem={(item) =>
    item.kind === "previous" ? <Icon name="chevron-left" /> :
    item.kind === "next" ? <Icon name="chevron-right" /> :
    item.kind === "ellipsis" ? <JumpMenu from={item.start!} to={item.end!} onPick={(p) => page.set(p)} /> :
    <Text class={item.current ? "font-semibold text-primary-foreground" : "text-foreground"}>{item.page}</Text>
  }
  onChange={({ page: next }) => page.set(next)}
/>
```

省略号自己不接受按压：它做什么由应用决定。像上面的 `JumpMenu` 那样，在里面绘制一个 `Menu`，就能列出它省略的页。

## 紧凑

`compact` 只显示上一页、子元素和下一页：适合窄屏的翻页器，当前页由子元素说明。

```tsx
<Pagination compact page={page()} totalPages={12} onChange={({ page: next }) => page.set(next)} class="items-center gap-3">
  <Text class="text-sm text-muted-foreground">{`${page()} of 12`}</Text>
</Pagination>
```

两种形式下，子元素都位于页码之后、下一页之前：比如页数，或跳转到某页的输入框。

## Props

| Prop | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `page` | `.page(..)` | `number` | 必填 | 当前页，从 1 开始；应用在 `onChange` 中设置它。 |
| `totalPages` | `.total_pages(..)` | `number` | 必填 | 总页数，至少为 1。 |
| `visiblePages` | `.visible_pages(..)` | `number` | `5` | 同时显示的最多页数，包括第一页和最后一页；至少为 5。 |
| `compact` | `.compact(..)` | `boolean` | `false` | 只显示上一页、子元素和下一页。 |
| `disabled` | `.disabled(..)` | `boolean` | `false` | 所有项都不接受按压和键盘焦点；`disabled:` 样式生效，屏幕阅读器读作已变暗。 |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | 无 | 屏幕阅读器对这个导航的称呼：它分页的是什么。 |
| `previousAccessibilityLabel`、`nextAccessibilityLabel` | `.previous_accessibility_label(..)`、`.next_accessibility_label(..)` | `string` | 无 | 屏幕阅读器对上一页和下一页的称呼，也是没有 `renderItem` 时它们的内容。 |
| `itemClass`、`itemStyle` | `.item_class(..)`、`.item_style(\|s\| ..)` | `string`、`StyleProp<TextStyle>` | 无 | 每一项的外观：当前页 `selected:`、`disabled:`、`focus:`；文字样式传给其中的内容。 |
| `renderItem` | `.render_item(\|s: &PaginationItemState\| ..)` | `(item: PaginationItemState) => JSX.Element` | 无 | 根据状态绘制每一项的内容。 |
| `children` | `.child(..)` | `JSX.Element` | 无 | 应用的内容，位于页码之后、下一页之前。 |
| `class`、`style` | 样式方法 | `string`、`StyleProp<ViewStyle>` | 无 | 整行的外观和布局。 |

## 事件

| 事件 | Rust | 说明 |
|---|---|---|
| `onChange` | `.on_change(\|page: &u32\| ..)` | `{ page }`：用户通过某一页、上一页或下一页选择的页。当前页永远不会被报告。 |

## 动效

当前页按应用的 `selected:` 类从一项移到另一项：在 `itemClass` 上加 `transition-colors`，高亮就会从离开的页淡入到到达的页。换页时每一项都留在原位，只改变它显示的内容，所以整行不会闪烁；开启减少动态效果时，应用的过渡会停住（`motion-reduce:transition-none`）。

## 无障碍

- 整行是一个导航地标，由 `accessibilityLabel` 命名。
- 每一页、上一页和下一页都是按钮。当前页读作当前页（ARIA 的 `aria-current="page"`），并且处于选中状态；第一页时的上一页和最后一页时的下一页读作已变暗。
- 在 macOS 和 Web 上，每一页、上一页和下一页都是键盘焦点的一站，Return 和 Space 按下它。用键盘按下的页在应用显示它之后保留焦点，无论它落在行中的哪个位置；上一页或下一页到达第一页或最后一页时，焦点也会移到那一页。

关于标签、角色和播报的一般说明，见[无障碍](../docs/accessibility.md)。

## 平台说明

- iOS、Android 和 Mac Catalyst：按压是在某一项上结束的轻点。
- 桌面（macOS、Windows、Linux、GPUI）和 Web：按压是点击；在 macOS 和 Web 上，Tab 可以到达各项。
- 每个平台都绘制应用设置的样式。
