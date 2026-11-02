---
title: Toolbar
description: Toolbar、ToolbarGroup 与 ToolbarSeparator：由按钮、开关按钮和链接组成的一栏，在键盘焦点里只占一站，方向键沿着它移动，带有命名的分组和分隔线。外观以及每个控件的状态都属于应用。
group: base
demo: el-toolbar
---

# Toolbar

工具栏是一栏控件：文本编辑器的格式栏、媒体播放器的播放控制、竖排的工具面板。`Toolbar` 负责它的键盘和语义：屏幕阅读器把它播报为一个工具栏（名字来自 `accessibilityLabel`），键盘一站就进入它，再用其 `axis` 方向上的方向键在项目之间移动。它的项目是其中任意层级的 `Button`、`Toggle` 和 `Link`。`ToolbarGroup` 是一段有名字的相关项目（撤销与重做、对齐方式），`ToolbarSeparator` 是应用在各段之间画的一条线。外观由应用决定：工具栏没有自己的颜色、内边距或间距，每个控件保留自己的状态。

```rust tabs
use nsh_base::{button, theme, toggle, toolbar, toolbar_group, toolbar_separator};
use nsh_core::prelude::*;

fn formatting() -> impl IntoElement {
    let bold = signal(false);
    toolbar()
        .accessibility_label("Formatting")
        .items_center()
        .gap_1()
        .child(
            toolbar_group()
                .accessibility_label("History")
                .child(button().accessibility_label("Undo").size_8().child(text("↶")))
                .child(button().accessibility_label("Redo").size_8().child(text("↷"))),
        )
        .child(toolbar_separator().w(px(1.0)).h_5().bg(move || theme().border))
        .child(
            toggle()
                .pressed(bold)
                .accessibility_label("Bold")
                .on_change(move |pressed: &bool| bold.set(*pressed))
                .size_8()
                .items_center()
                .justify_center()
                .pressed_style(|s| s.bg(move || theme().accent))
                .child(text("B")),
        )
}
```

```tsx tabs
import { mount, signal, Text } from "nsh";
import { Button, Toggle, Toolbar, ToolbarGroup, ToolbarSeparator } from "nsh/base";

function App() {
  const bold = signal(false);
  return (
    <Toolbar accessibilityLabel="Formatting" class="items-center gap-1 self-start rounded-lg bg-muted p-1">
      <ToolbarGroup accessibilityLabel="History">
        <Button accessibilityLabel="Undo" class="size-8 items-center justify-center rounded-md hover:bg-accent">
          <Text>↶</Text>
        </Button>
        <Button accessibilityLabel="Redo" class="size-8 items-center justify-center rounded-md hover:bg-accent">
          <Text>↷</Text>
        </Button>
      </ToolbarGroup>
      <ToolbarSeparator class="h-5 w-px bg-border" />
      <Toggle
        pressed={bold()}
        accessibilityLabel="Bold"
        onChange={({ pressed }) => bold.set(pressed)}
        class="size-8 items-center justify-center rounded-md aria-pressed:bg-accent"
      >
        <Text>B</Text>
      </Toggle>
    </Toolbar>
  );
}

mount(App);
```

`Toolbar`、`ToolbarGroup` 和 `ToolbarSeparator` 来自 [`nsh/base`](../modules/nsh-base.md)，在 Rust 中是 `nsh-base` crate。工具栏不持有值：其中的开关按钮被告知是否按下并报告 `onChange`，按钮报告 `onPress`，状态由应用保存。在 Rust 中由 `toolbar()`、`toolbar_group()` 和 `toolbar_separator()` 创建，每个属性对应一个设置方法（`.axis(..)`、`.disabled(..)`），再加上类型化的样式方法和放内容的 `.child(..)`。

## 属性

### Toolbar

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `axis` | `.axis(..)` | `"horizontal" \| "vertical"` | `"horizontal"` | 项目排列的方向：沿它移动的方向键（左右，或上下），以及它排列子元素的方向（一行或一列）。在工具栏创建时读取。 |
| `disabled` | `.disabled(..)` | `boolean` | `false` | 工具栏的每个项目都被禁用，不论它自己的 `disabled`：不响应按压，不是键盘焦点的一站，屏幕阅读器读作变暗。 |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | 无 | 屏幕阅读器对工具栏的称呼（“Formatting”），页面上有多个工具栏时使用。 |
| `children` | `.child(..)` | `JSX.Element` | 无 | 项目、它们的分组和分隔线，以及应用放在其间的其他内容（标题、占位、输入框）。 |
| `class`、`style` | 样式方法 | `string`、`StyleProp<ViewStyle>` | 无 | 栏的布局和外观：对齐、间距、内边距、底色。 |

### ToolbarGroup

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `disabled` | `.disabled(..)` | `boolean` | `false` | 分组的每个项目都被禁用，不论它自己的 `disabled`。 |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | 无 | 屏幕阅读器对分组的称呼（“History”、“Alignment”）。 |
| `children` | `.child(..)` | `JSX.Element` | 无 | 分组的项目，以及应用放在其间的内容。 |
| `class`、`style` | 样式方法 | `string`、`StyleProp<ViewStyle>` | 无 | 分组的布局和外观。它沿工具栏的方向排列。 |

### ToolbarSeparator

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `class`、`style` | 样式方法 | `string`、`StyleProp<ViewStyle>` | 无 | 这条线：横穿一行（`h-5 w-px bg-border`）或一列（`h-px self-stretch bg-border`）的细线。 |

## 项目

工具栏的项目是其中的 `Button`、`Toggle` 和 `Link`，包括它的分组里的，以及放在它里面的 [`ToggleGroup`](./toggle.md) 里的。[`Menu`](./menu.md) 或 [`Popover`](./popover.md) 的触发器也是项目：即放在它的 `trigger` 插槽里的视图，弹出层把按下、焦点和 `expanded` 状态交给它。放在工具栏里的 `ToggleGroup` 是它的一个分组：其中的开关按钮就是工具栏的项目，屏幕阅读器听到的是一个分组，它的 `disabled` 仍然禁用它自己的开关按钮。其他控件（`Input`、`Select`、`Slider`）各自是键盘焦点的一站，保留自己的方向键；把它们放在栏的末尾。项目打开的弹出层里显示的内容（弹出框的输入框和按钮、菜单的项）不属于工具栏。方向键按栏里排列的顺序经过各个项目，无论项目嵌套多深；应用稍后才显示的项目也会排在它所在的位置。

## 部件

| 部件 | 位于 | 样式来自 | 状态 |
|---|---|---|---|
| 栏 | | `Toolbar` 的 `class`、`style` | |
| 分组 | 栏 | `ToolbarGroup` 的 `class`、`style` | |
| 分隔线 | 栏、分组 | `ToolbarSeparator` 的 `class`、`style` | |
| 项目 | 栏、分组 | 项目自己的 `class`、`style` | 它自己的：`aria-pressed:`、`disabled:`、`hover:`、`focus:`、`active:` |

用 `focus:` 样式显示键盘所在的项目，用按下的开关按钮自己的底色显示它的按下状态（见[设计指南](../docs/design-guides.md#交互状态)）。

## 竖排

工具面板是一列：`axis="vertical"` 让项目从上到下排列，上下键沿着它们移动。

```tsx
<Toolbar axis="vertical" accessibilityLabel="Tools" class="gap-1 self-start rounded-lg bg-muted p-1">
  <Each of={["select", "pen", "shape", "text"]}>
    {(t) => (
      <Toggle
        pressed={tool() === t()}
        accessibilityLabel={t()}
        onChange={({ pressed }) => pressed && tool.set(t())}
        class="size-8 items-center justify-center rounded-md aria-pressed:bg-accent"
      >
        <Text>{t()[0].toUpperCase()}</Text>
      </Toggle>
    )}
  </Each>
</Toolbar>
```

## 禁用

工具栏上的 `disabled` 禁用其中每个项目，相当于应用锁住的一栏；分组上的则禁用分组的项目。被禁用的项目不响应按压，方向键会跳过它，屏幕阅读器把它播报为变暗：

```tsx
<Toolbar disabled={readonly()} accessibilityLabel="Review" class="flex-row gap-1">
  <Button onPress={approve} class="h-8 px-3 disabled:opacity-50">
    <Text>Approve</Text>
  </Button>
</Toolbar>
```

## 无障碍

- `Toolbar` 的角色是 `"toolbar"`，名字来自 `accessibilityLabel`；它的项目仍然各自是一个元素。在 iOS 上工具栏是 VoiceOver 进入的语义分组。
- `ToolbarGroup` 的角色是 `"group"`，名字来自它的 `accessibilityLabel`，一段项目因此读作一个整体。放在工具栏里的 `ToggleGroup` 也是一个分组。
- `ToolbarSeparator` 对屏幕阅读器不是元素。
- `disabled` 按平台的方式播报（VoiceOver、TalkBack、UI Automation、浏览器的无障碍树）。

标签、角色和播报的一般说明见[无障碍](../docs/accessibility.md)。

## 键盘

在 macOS 和 Web 上，Tab 会到达响应按压的视图，`Toolbar` 遵循 [WAI-ARIA 工具栏模式](https://www.w3.org/WAI/ARIA/apg/patterns/toolbar/)：

| 按键 | 作用 |
|---|---|
| Tab、Shift+Tab | 从焦点上次离开的项目进入工具栏（一开始是第一个未禁用的项目），一步离开。 |
| 右、左（`axis="horizontal"`） | 把焦点移到下一个或上一个项目，从最后一个绕回第一个，反之亦然。 |
| 下、上（`axis="vertical"`） | 把焦点移到下一个或上一个项目，从最后一个绕回第一个，反之亦然。 |
| Home、End | 把焦点移到第一个或最后一个项目。 |
| 空格、回车 | 按下获得焦点的项目。 |

方向键跳过被禁用的项目，不会按下任何东西：开关按钮只在被按下时改变。另一对方向键留给项目使用（菜单的触发器用下键打开菜单）。

## 平台说明

- iOS、Android 和 Mac Catalyst：每个项目用轻点按下；工具栏是屏幕阅读器播报的一个分组。
- 桌面（macOS、Windows、Linux、GPUI）和 Web：按压就是点击。在 macOS 和 Web 上工具栏是 Tab 的一站，方向键、Home 和 End 在其项目之间移动（[键盘](#键盘)）。
- 每个平台都按应用的样式绘制：栏、分组、分隔线和项目。
