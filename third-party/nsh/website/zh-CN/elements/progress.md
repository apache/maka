---
title: Progress
description: Progress 组件：线性进度条，负责屏幕阅读器读到的角色、范围和数值，以及指示条随数值变化的宽度，轨道和指示条由应用设置样式。
order: 20.8
group: base
demo: el-progress
---

# Progress

进度条显示一个有明确工作量的任务完成了多少（下载、上传、设置中的一步），或者在 `indeterminate` 时表示一个工作量未知的任务正在进行。它负责屏幕阅读器读到的内容（进度条角色、0 到 100 的范围和数值）以及指示条的宽度：轨道宽度的 `value` 百分比。外观由应用决定：`Progress` 没有自己的颜色、尺寸、圆角、动效或文字。它由一条轨道、轨道里的指示条以及之后的子元素（标签、数值文字）组成，应用为每个部件设置样式。

```rust tabs
use nsh_base::{progress, theme};
use nsh_core::prelude::*;

fn upload(sent: Signal<f32>) -> impl IntoElement {
    progress()
        .value(sent)
        .accessibility_label("正在上传照片")
        .gap_2()
        .track_style(|s| s.h(px(8.0)).rounded_full().overflow_hidden().bg(move || theme().muted))
        .indicator_style(|s| s.h_full().rounded_full().bg(move || theme().primary))
        .child(
            text(move || format!("{:.0}%", sent.get()))
                .text_sm()
                .text_color(move || theme().muted_foreground),
        )
}
```

```tsx tabs
import { mount, signal, Text } from "nsh";
import { Progress } from "nsh/base";

function App() {
  const sent = signal(40);
  return (
    <Progress
      value={sent()}
      accessibilityLabel="正在上传照片"
      class="gap-2"
      trackClass="h-2 overflow-hidden rounded-full bg-muted"
      indicatorClass="h-full rounded-full bg-primary"
    >
      <Text class="text-sm text-muted-foreground">{`${sent()}%`}</Text>
    </Progress>
  );
}

mount(App);
```

`Progress` 来自 [`nsh/base`](../modules/nsh-base.md)，在 Rust 中是 `nsh-base` crate。数值由应用持有：进度条显示应用传入的 `value`，限定在 0 到 100 之间。在 Rust 中，`progress()` 创建一个进度条，每个属性有对应的设置方法（`.value(..)`、`.indicator_style(..)`），进度条本身用类型化的样式方法，标签用 `.child(..)`。

## 属性

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `value` | `.value(..)` | `number` | `0` | 任务完成了多少，0 到 100 的百分比（超出范围时取最近的一端）。指示条占轨道宽度的这个比例，屏幕阅读器读出它。 |
| `indeterminate` | `.indeterminate(..)` | `boolean` | `false` | 任务的工作量未知：屏幕阅读器听到一个没有数值的进度条，指示条的宽度由应用决定（`indicatorClass`）。 |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | 无 | 屏幕阅读器读出的内容：子元素里没有文字说明时，说明正在进行什么。 |
| `trackClass`、`trackStyle` | `.track_style(\|s\| ..)` | `string`、`StyleProp<ViewStyle>` | 无 | 轨道，指示条填充的部件。 |
| `indicatorClass`、`indicatorStyle` | `.indicator_style(\|s\| ..)` | `string`、`StyleProp<ViewStyle>` | 无 | 轨道里的指示条：它的高度、颜色和动效。 |
| `children` | `.child(..)` | `JSX.Element` | 无 | 轨道之后的内容：标签或数值文字，屏幕阅读器会读出。 |
| `class`、`style` | 样式方法 | `string`、`StyleProp<ViewStyle>` | 无 | 进度条本身：包住轨道和标签的列（或行）。 |

## 部件

| 部件 | 位于 | 样式 |
|---|---|---|
| 进度条 | | `class`、`style` |
| 轨道 | 进度条内，第一个 | `trackClass`、`trackStyle` |
| 指示条 | 轨道内 | `indicatorClass`、`indicatorStyle`；宽度是轨道宽度的 `value` 百分比 |
| 标签 | 进度条内，轨道之后 | 应用自己的元素（`children`） |

指示条从轨道的起始边开始；轨道上的 `overflow-hidden` 和圆角让它的末端与轨道一样圆。`w-*` 类或 `indicatorStyle` 里的 `width` 会取代按数值算出的宽度，不确定进度条就是这样得到自己的宽度。

## 不确定进度

工作量未知时，设置 `indeterminate`，并给指示条应用自己的宽度和动效。动效由应用选择，`motion-reduce:` 让偏好减少动态效果的用户看到静止的指示条：

```tsx
<Progress
  value={0}
  indeterminate={connecting()}
  trackClass="h-2 overflow-hidden rounded-full bg-muted"
  indicatorClass={
    connecting()
      ? "h-full w-1/3 rounded-full bg-primary animate-pulse motion-reduce:animate-none"
      : "h-full rounded-full bg-primary"
  }
/>
```

## 无障碍

- 进度条对屏幕阅读器是一个元素，角色为 `"progressbar"`，带 0 到 100 的范围和它的数值（VoiceOver 和 TalkBack 以百分比读出）；轨道和指示条是它的部件。它的标签是子元素的文字；没有文字时提供 `accessibilityLabel`。
- `indeterminate` 时保留角色和范围、没有数值（在浏览器中不设 `aria-valuenow`，正是 ARIA 表示不确定进度条的方式）。
- 它不接受按压，也不获得键盘焦点：它只报告进度，开始或停止任务的控件由应用提供。

标签、角色和播报的一般用法见[无障碍](../docs/accessibility.md)。

## 平台说明

- 各平台绘制应用设置的样式；指示条的宽度立即跟随 `value`，应用为它加上动画时变化会有动画。
- 屏幕阅读器：VoiceOver（iOS、macOS）以百分比读出数值，并把进度条当作频繁更新的元素；TalkBack、UI Automation（Windows）、GTK 的无障碍（Linux）和浏览器（`aria-valuenow`）得到范围和数值。
