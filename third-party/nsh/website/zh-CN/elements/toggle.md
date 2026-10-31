---
title: Toggle
description: Toggle 与 ToggleGroup：一个处于开或关的按钮，以及由它们组成的工具栏。每个开关按钮负责按压、键盘激活、禁用状态以及屏幕阅读器的角色和按下状态；这一组是一个工具栏，在键盘焦点里只占一站；外观以及哪些按钮按下都属于应用。
group: base
demo: el-toggle
---

# Toggle

开关按钮是一个保持开或关的按钮：文字工具栏里的加粗、收藏的星标、一个视图选项。`Toggle` 负责一个开关按钮的行为：按压、键盘激活、禁用状态，以及屏幕阅读器读到的按钮角色和它的按下状态，屏幕阅读器把它播报为开关按钮。包在几个开关按钮外面的 `ToggleGroup` 是一个工具栏：屏幕阅读器把它当作一个整体播报，键盘一站就进入它，再用方向键在其中的开关按钮之间移动。外观由应用决定：开关按钮没有自己的颜色、尺寸、图标或文字。它的子元素是应用自己的图标或标签，开关按钮上的 `aria-pressed:` 类，以及它里面元素上的 `group-aria-pressed:` 类，跟随它的状态。

```rust tabs
use nsh_base::{theme, toggle, toggle_group};
use nsh_core::prelude::*;

fn formatting() -> impl IntoElement {
    let bold = signal(true);
    let italic = signal(false);
    let item = move |label: &'static str, on: Signal<bool>| {
        toggle()
            .pressed(on)
            .accessibility_label(label)
            .on_change(move |pressed: &bool| on.set(*pressed))
            .size_8()
            .items_center()
            .justify_center()
            .rounded(move || theme().radius)
            .pressed_style(|s| s.bg(move || theme().accent))
            .child(text(&label[..1]).text_sm().text_color(move || {
                if on.get() { theme().accent_foreground } else { theme().muted_foreground }
            }))
    };
    toggle_group()
        .flex_row()
        .self_start()
        .gap_1()
        .child(item("Bold", bold))
        .child(item("Italic", italic))
}
```

```tsx tabs
import { mount, signal, Text } from "nsh";
import { Toggle, ToggleGroup } from "nsh/base";

function App() {
  const marks = signal<string[]>(["bold"]);
  const item = (value: string, label: string) => (
    <Toggle
      pressed={marks().includes(value)}
      accessibilityLabel={label}
      onChange={({ pressed }) =>
        marks.set(pressed ? [...marks(), value] : marks().filter((m) => m !== value))
      }
      class="group size-8 items-center justify-center rounded-(--radius) aria-pressed:bg-accent"
    >
      <Text class="text-sm text-muted-foreground group-aria-pressed:text-accent-foreground">{label[0]}</Text>
    </Toggle>
  );
  return (
    <ToggleGroup class="flex-row self-start gap-1">
      {item("bold", "Bold")}
      {item("italic", "Italic")}
    </ToggleGroup>
  );
}

mount(App);
```

`Toggle` 和 `ToggleGroup` 来自 [`nsh/base`](../modules/nsh-base.md)，在 Rust 中是 `nsh-base` crate。值属于应用：每个开关按钮被告知它是否按下，按压时用 `onChange` 报告它想要的值，开关按钮显示应用传回的 `pressed`。这一组也不持有值，所以能按下几个也由应用决定：任意多个（加粗、斜体和下划线），或者恰好一个（对齐方式、视图切换），这时应用按下被请求的那个、松开其他的，并让已按下的那个保持按下。在 Rust 中，`toggle()` 和 `toggle_group()` 创建它们，每个属性一个 setter（`.pressed(..)`），每个事件一个监听器（`.on_change(..)`），加上类型化的样式方法和放内容的 `.child(..)`。

## 属性

### Toggle

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `pressed` | `.pressed(..)` | `boolean` | `false` | 开或关：屏幕阅读器说它已按下，`aria-pressed:` 样式生效。按压时用 `onChange` 报告另一个值；开关按钮显示应用传回的值。 |
| `disabled` | `.disabled(..)` | `boolean` | `false` | 不接受按压，也没有按压反馈；`disabled:` 样式生效，屏幕阅读器说它不可用。禁用的 `ToggleGroup` 里的开关按钮也被禁用。 |
| `pressedStyle` | `.pressed_style(\|s\| ..)` | `StyleProp<ViewStyle>` | 无 | 按下且未禁用时开关按钮的样式，同 `aria-pressed:` 类。 |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | 无 | 屏幕阅读器读出的内容：当子元素里没有文字说明它开启什么时（一个图标）。 |
| `children` | `.child(..)` | `JSX.Element` | 无 | 应用的图标或标签，屏幕阅读器会读出。 |
| `class`、`style` | 样式方法 | `string`、`StyleProp<ViewStyle>` | 无 | 开关按钮本身：内容外面的那层表面。 |
| `activeStyle`、`hoverStyle`、`focusStyle`、`disabledStyle` | `.active(\|s\| ..)`、`.hover(..)`、`.focus(..)`、`.disabled_style(..)` | `StyleProp<ViewStyle>` | 无 | 正在按压、悬停、获得焦点或禁用时开关按钮的样式，同对应的 `<state>:` 类。 |

### ToggleGroup

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `disabled` | `.disabled(..)` | `boolean` | `false` | 组里的每个开关按钮都被禁用，不论它自己的 `disabled`。 |
| `children` | `.child(..)` | `JSX.Element` | 无 | 这一组的开关按钮，以及应用在它们之间布置的任何东西（一条分隔线）。 |
| `class`、`style` | 样式方法 | `string`、`StyleProp<ViewStyle>` | 无 | 这一组的布局和外观：默认是一列，`flex-row` 排成一行。 |

## 事件

| 事件 | Rust | 说明 |
|---|---|---|
| `onChange`（`Toggle`） | `.on_change(\|pressed: &bool\| ..)` | 开关按钮被按压：轻点、点击、拥有键盘焦点时按 Space 或 Return，或屏幕阅读器的激活。`{ pressed }` 是它想要的值，与 `pressed` 相反。它在任何变化之前运行：开关按钮显示应用传回的 `pressed`。 |

`ToggleGroup` 的方向键只移动键盘焦点：不按下任何东西。禁用的开关按钮什么也不报告。

## 部件

| 部件 | 位于 | 样式来自 | 状态 |
|---|---|---|---|
| 这一组 | | `ToggleGroup` 的 `class`、`style` | |
| 开关按钮 | 组里，或任何地方 | `Toggle` 的 `class`、`style` | `aria-pressed:`、`disabled:`、`active:`、`hover:`、`focus:`（或 `pressedStyle`、`disabledStyle` ……） |
| 图标或标签 | 开关按钮里 | 它自己的元素（`children`） | 开关按钮的 `class` 带 `group` 时的 `group-aria-pressed:`、`group-disabled:` 及其他 `group-*:` 变体 |

`aria-pressed:` 是开关按钮处于开；`active:` 是正在进行的按压，不论开或关。用开关按钮自己的表面显示它已按下：一层填充、一个凸起的胶囊、更醒目的图标（见[设计指南](../docs/design-guides.md)的交互状态一节）。

## 分段

开关按钮连在一起、一次只按下一个的一组，就是分段控件（视图切换）：应用保存一个值，并按下以它命名的那个开关按钮。连在一起的外观是应用的类：

```tsx
<ToggleGroup class="flex-row self-start">
  <Each of={["grid", "list"]}>
    {(value) => (
      <Toggle
        pressed={view() === value()}
        accessibilityLabel={`${value()} view`}
        onChange={({ pressed }) => pressed && view.set(value())}
        class="-ml-px h-8 px-3 border border-border first:ml-0 first:rounded-l-(--radius) last:rounded-r-(--radius) aria-pressed:bg-accent"
      >
        <Text class="text-sm">{value()}</Text>
      </Toggle>
    )}
  </Each>
</ToggleGroup>
```

## 禁用

禁用的开关按钮不接受按压，屏幕阅读器把它播报为不可用。它的 `disabled:` 类覆盖 `aria-pressed:` 类，它里面的 `group-disabled:` 类跟随。`ToggleGroup` 上的 `disabled` 禁用其中每个开关按钮，即应用锁定的工具栏：

```tsx
<ToggleGroup disabled={readonly()} class="flex-row gap-1">
  <Toggle pressed={bold()} onChange={({ pressed }) => bold.set(pressed)} class="size-8 disabled:opacity-50">
    <Text>B</Text>
  </Toggle>
</ToggleGroup>
```

## 无障碍

- 开关按钮对屏幕阅读器是一个元素，角色为 `"button"`，带按下状态：一个开关按钮。它的标签是子元素的文字，或 `accessibilityLabel`。
- `ToggleGroup` 的角色是 `"toolbar"`：屏幕阅读器把里面的开关按钮当作一个工具栏，每个仍是独立的元素。
- `disabled` 按平台的方式播报（VoiceOver、TalkBack、UI Automation、浏览器的无障碍树）。
- 在 macOS 和 Web 上，这一组在键盘焦点里只占一站，方向键在其中的开关按钮之间移动（见下文）。

关于标签、角色和播报的一般说明，见[无障碍](../docs/accessibility.md)。

## 键盘

在 macOS 和 Web 上，Tab 会停在接受按压的视图上，`ToggleGroup` 遵循 [WAI-ARIA 工具栏模式](https://www.w3.org/WAI/ARIA/apg/patterns/toolbar/)：

| 按键 | 作用 |
|---|---|
| Tab、Shift+Tab | 在第一个已按下的开关按钮进入这一组（都没按下时是第一个未禁用的），一步离开。 |
| Right、Down | 把焦点移到下一个开关按钮，从最后一个回到第一个。 |
| Left、Up | 把焦点移到上一个开关按钮，从第一个回到最后一个。 |
| Home、End | 把焦点移到第一个或最后一个开关按钮。 |
| Space、Return | 按下获得焦点的开关按钮。 |

方向键跳过禁用的开关按钮，且不按下任何东西：开关按钮只在被按压时改变。两组方向键都能移动，不论这一组的布局如何，布局是应用的类。`focus:` 样式显示焦点在哪里。`ToggleGroup` 之外的 `Toggle` 自己占一站。

## 平台说明

- iOS、Android 和 Mac Catalyst：按压是在开关按钮上（包括它的内容）结束的一次轻点。
- 桌面（macOS、Windows、Linux、GPUI）和 Web：按压是一次点击。在 macOS 和 Web 上，Space 和 Return 也会按下拥有键盘焦点的开关按钮，方向键、Home 和 End 移动焦点（见[键盘](#键盘)）。
- 每个平台都绘制应用设定的样式：开关按钮、已按下的那些的表面，以及这一组的轨道。
