---
title: Switch
description: Switch 组件：一个开 / 关控件，负责按压、键盘激活、禁用状态以及屏幕阅读器的角色和值，轨道和滑块由应用设置样式。
group: base
demo: el-switch
---

# Switch

开关用来打开或关闭一项设置，改变立即生效。它负责行为：按压、键盘激活、禁用状态，以及屏幕阅读器读到的开关角色和它的值。外观由应用决定：`Switch` 没有自己的颜色、尺寸、动效或文字。它由一条轨道、轨道里的滑块以及之后的子元素（标签）组成，应用为每个部件设置样式，部件上的 `checked:` 和 `disabled:` 类跟随开关的状态。

```rust tabs
use nsh_base::{switch, theme};
use nsh_core::prelude::*;

fn wifi() -> impl IntoElement {
    let on = signal(false);
    switch()
        .checked(on)
        .on_change(move |next: &bool| on.set(*next))
        .flex_row()
        .items_center()
        .gap_3()
        .track_style(|s| {
            s.w(px(44.0))
                .p(px(2.0))
                .rounded_full()
                .bg(move || theme().muted)
                .transition_colors()
                .checked(|s| s.bg(move || theme().primary))
        })
        .thumb_style(|s| {
            s.size(px(20.0))
                .rounded_full()
                .bg(move || theme().background)
                .shadow_sm()
                .transition_transform()
                .checked(|s| s.translate_x(px(20.0)))
        })
        .child(text("Wi-Fi"))
}
```

```tsx tabs
import { mount, signal, Text } from "nsh";
import { Switch } from "nsh/base";

function App() {
  const on = signal(false);
  return (
    <Switch
      checked={on()}
      onChange={({ checked }) => on.set(checked)}
      class="flex-row items-center gap-3"
      trackClass="w-11 rounded-full bg-muted p-0.5 transition-colors checked:bg-primary"
      thumbClass="size-5 rounded-full bg-background shadow-sm transition-transform checked:translate-x-5"
    >
      <Text>Wi-Fi</Text>
    </Switch>
  );
}

mount(App);
```

`Switch` 来自 [`nsh/base`](../modules/nsh-base.md)，在 Rust 中是 `nsh-base` crate。值由应用持有：按压时通过 `onChange` 报告下一个值，开关显示应用传回的 `checked`。在 Rust 中，`switch()` 创建一个开关，每个属性对应一个设置方法（`.checked(..)`、`.track_style(..)`），每个事件对应一个监听方法（`.on_change(..)`），开关自身用类型化的样式方法，标签用 `.child(..)`；部件的样式接受跟随开关的状态方法（`.checked(..)`、`.disabled_style(..)`）。

<a id="props"></a>

## 属性

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `checked` | `.checked(..)` | `boolean` | `false` | 开或关。按压时通过 `onChange` 报告下一个值；开关显示应用传回的值。 |
| `disabled` | `.disabled(..)` | `boolean` | `false` | 不响应按压，也没有按压反馈；开关及其部件的 `disabled:` 样式生效，屏幕阅读器会报告它不可用。 |
| `checkedStyle` | `.checked_style(\|s\| ..)` | `StyleProp<ViewStyle>` | 无 | `checked` 且未禁用时开关自身的样式，与 `checked:` 类相同。 |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | 无 | 屏幕阅读器读出的文字：子元素没有说明它打开什么的文字时设置。 |
| `trackClass`、`trackStyle` | `.track_style(\|s\| ..)` | `string`、`StyleProp<ViewStyle>` | 无 | 轨道，滑块沿着它移动。 |
| `thumbClass`、`thumbStyle` | `.thumb_style(\|s\| ..)` | `string`、`StyleProp<ViewStyle>` | 无 | 滑块，在轨道里面。 |
| `children` | `.child(..)` | `JSX.Element` | 无 | 轨道之后的内容：一个标签，屏幕阅读器会读出。 |
| `class`、`style` | 样式方法 | `string`、`StyleProp<ViewStyle>` | 无 | 开关自身：包住轨道和标签的那一行。 |
| `activeStyle`、`hoverStyle`、`focusStyle`、`disabledStyle` | `.active(\|s\| ..)`、`.hover(..)`、`.focus(..)`、`.disabled_style(..)` | `StyleProp<ViewStyle>` | 无 | 开关按下、悬停、获得焦点或禁用时的样式，与对应的 `<state>:` 类相同。 |

<a id="events"></a>

## 事件

| 事件 | Rust | 说明 |
|---|---|---|
| `onChange` | `.on_change(\|checked: &bool\| ..)` | 开关被按下：轻点、点击、拥有键盘焦点时按 Space 或 Return，或屏幕阅读器的激活。它以 `checked` 报告开关请求的值，即它当前 `checked` 的相反值。 |

禁用的开关不报告任何事件。

<a id="parts"></a>

## 部件

| 部件 | 位置 | 样式 | 状态 |
|---|---|---|---|
| 开关 | | `class`、`style` | `checked:`、`disabled:`、`active:`、`hover:`、`focus:`（或 `checkedStyle`、`disabledStyle` 等） |
| 轨道 | 开关里的第一个 | `trackClass`、`trackStyle` | `checked:`、`disabled:` 跟随开关 |
| 滑块 | 轨道里 | `thumbClass`、`thumbStyle` | `checked:`、`disabled:` 跟随开关 |
| 标签 | 开关里，轨道之后 | 它自己的元素（`children`） | 在开关的 `class` 上加 `group` 后，使用 `group-checked:` 等 `group-*:` 变体 |

滑块靠它自己的 `checked:` 样式移动：位移（`checked:translate-x-5`），或者外边距、轨道的对齐方式（轨道上的 `checked:justify-end`）。`transition-*` 类会在原生层为变化加上动画。要把标签放在轨道前面，反转这一行即可：`class="flex-row-reverse justify-between"`。

<a id="disabled"></a>

## 禁用

禁用的开关不响应按压，屏幕阅读器会报告它不可用。它自身以及轨道和滑块的 `disabled:` 类生效，并覆盖它们的 `checked:` 类：

```tsx
<Switch
  checked={on()}
  disabled={!online()}
  onChange={({ checked }) => on.set(checked)}
  class="flex-row items-center gap-3 disabled:opacity-50"
  trackClass="w-11 rounded-full bg-muted p-0.5 checked:bg-primary disabled:bg-muted"
  thumbClass="size-5 rounded-full bg-background checked:translate-x-5"
>
  <Text>Sync over cellular</Text>
</Switch>
```

<a id="accessibility"></a>

## 无障碍

- 开关对屏幕阅读器而言是一个元素，角色是 `"switch"`，带有它的值（开或关）；轨道和滑块是它的部件。它的标签是子元素的文字；没有文字时设置 `accessibilityLabel`。
- `disabled` 按平台的方式报告（VoiceOver、TalkBack、UI Automation、浏览器的无障碍树）。
- 在 macOS 和 Web 上，开关是键盘焦点的一站：Tab 可以到达它，Space 和 Return 切换它，`focus:` 样式显示焦点所在。

标签、角色和播报的一般用法见[无障碍](../docs/accessibility.md)。

<a id="platform-notes"></a>

## 平台说明

- iOS、Android 和 Mac Catalyst：按压是在开关上（包括它的标签）结束的一次轻点。
- 桌面（macOS、Windows、Linux、GPUI）和 Web：按压是一次点击。在 macOS 和 Web 上，Space 和 Return 也会切换拥有键盘焦点的开关。
- 每个平台都按应用的样式绘制；滑块按应用的样式和过渡移动。
