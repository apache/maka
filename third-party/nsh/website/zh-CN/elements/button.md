---
title: Button
description: Button 组件：一个负责按压、禁用和选中状态以及屏幕阅读器角色的按压目标，样式由应用决定。
order: 20
group: base
demo: el-button
---

# Button

按钮是一个按压目标。它负责行为：按压、通过应用的状态样式呈现的按压反馈、禁用和选中状态、键盘焦点，以及它对屏幕阅读器而言的角色。外观由应用决定：`Button` 没有自己的颜色、尺寸、内边距或文字，所以同一个组件可以按你给它的样式和子元素，成为主按钮、图标按钮、标签页、工具栏开关或列表的一行。

```rust tabs
use nsh_base::button;
use nsh_core::prelude::*;

fn counter() -> impl IntoElement {
    let count = signal(0_u32);
    button()
        .on_press(move || count.update(|n| *n += 1))
        .self_center()
        .px_5()
        .py_3()
        .rounded_xl()
        .bg(rgb(0x2563eb))
        .active(|s| s.bg(rgb(0x1d4ed8)))
        .child(
            text(move || format!("Pressed {}", count.get()))
                .text_color(white())
                .font_weight(FontWeight::SEMIBOLD),
        )
}
```

```tsx tabs
import { mount, signal, Text } from "nsh";
import { Button } from "nsh/base";

function App() {
  const count = signal(0);
  return (
    <Button
      onPress={() => count.update((n) => n + 1)}
      class="self-center rounded-xl bg-blue-600 px-5 py-3 active:bg-blue-700"
    >
      <Text class="text-base font-semibold text-white">{`Pressed ${count()}`}</Text>
    </Button>
  );
}

mount(App);
```

`Button` 来自 [`nsh/base`](../modules/nsh-base.md)，在 Rust 中来自 `nsh-base` crate。在 TSX 中，它的外观是 `class` 和 `style`，配合状态变体 `active:`、`hover:`、`focus:`、`selected:` 和 `disabled:`（或对应的 `activeStyle`、`hoverStyle`、`focusStyle`、`selectedStyle` 和 `disabledStyle`）。在 Rust 中，`button()` 像 `view()` 创建视图那样创建按钮：每个属性一个设置方法（`.disabled(..)`、`.selected(..)`），每个事件一个监听方法（`.on_press(..)`），类型化的样式方法（`.px_4()`、`.bg(..)`）决定外观，状态方法（`.active(..)`、`.hover(..)`、`.focus(..)`、`.selected_style(..)`、`.disabled_style(..)`）设置各状态的样式，`.child(..)` 添加内容。

<a id="props"></a>

## 属性

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `disabled` | `.disabled(..)` | `boolean` | `false` | 不响应按压，也没有按压反馈；`disabled:` 样式生效，屏幕阅读器会报告它不可用。 |
| `selected` | `.selected(..)` | `boolean` | `false` | 选中：打开的开关、当前标签页。屏幕阅读器会报告。值由应用持有，样式也由应用决定。 |
| `selectedStyle` | `.selected_style(\|s\| ..)` | `StyleProp<ViewStyle>` | 无 | `selected` 且未禁用时的样式，与 `selected:` 类相同。 |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | 无 | 内容不足以说明时（比如只有图标），屏幕阅读器读出的文字。 |
| `role` | `.role(..)` | `AccessibilityRole` | `"button"` | 当 `nsh/base` 没有对应的组件时，它对屏幕阅读器而言是什么：`"link"`（打开一个 URL）等。 |
| `children` | `.child(..)` | `JSX.Element` | 无 | 内容：文字、图标或任意布局。 |
| `class`、`style` | 样式方法 | `string`、`StyleProp<ViewStyle>` | 无 | 它的全部外观。 |
| `activeStyle`、`hoverStyle`、`focusStyle`、`disabledStyle` | `.active(\|s\| ..)`、`.hover(..)`、`.focus(..)`、`.disabled_style(..)` | `StyleProp<ViewStyle>` | 无 | 按下、悬停、获得焦点或禁用时的样式，与对应的 `<state>:` 类相同。后面的状态优先，`disabled` 优先于所有状态。 |

在 Rust 中，每个属性是一个设置方法，接受值、信号或闭包；没有设置的属性保留默认值：

```rust
button()
    .disabled(move || saving.get())
    .accessibility_label("Save")
```

<a id="events"></a>

## 事件

| 事件 | Rust | 说明 |
|---|---|---|
| `onPress` | `.on_press(\|\| ..)` | 按钮被按下：轻点、单击、拥有键盘焦点时按 Return 或空格，或屏幕阅读器激活它。 |
| `onPressDown` | `.on_press_down(\|\| ..)` | 一次按压在它上面按下。 |
| `onPressUp` | `.on_press_up(\|\| ..)` | 按压结束：松开、移开或被取消。 |

`onPressDown` 和 `onPressUp` 用于你自己的按压反馈，比如状态样式表达不了的弹簧效果或高亮。禁用的按钮不会报告这些事件。

<a id="styling"></a>

## 样式

按钮的外观属于你的应用：什么是主按钮、什么是次按钮，由应用决定。用两个小组件就能把这个决定集中在一处：

```rust tabs
use nsh_base::button;
use nsh_core::prelude::*;

/// A filled button, darker while pressed.
fn primary(label: &'static str, on_press: impl Fn() + 'static) -> impl IntoElement {
    button()
        .on_press(on_press)
        .items_center()
        .rounded_lg()
        .px_4()
        .py_3()
        .bg(rgb(0x2563eb))
        .active(|s| s.bg(rgb(0x1d4ed8)))
        .disabled_style(|s| s.opacity(0.4))
        .child(text(label).text_color(white()).font_weight(FontWeight::SEMIBOLD))
}

/// An outlined button.
fn secondary(label: &'static str, on_press: impl Fn() + 'static) -> impl IntoElement {
    button()
        .on_press(on_press)
        .items_center()
        .rounded_lg()
        .px_4()
        .py_3()
        .border_1()
        .border_color(rgb(0xd4d4d4))
        .hover(|s| s.bg(rgb(0xfafafa)))
        .active(|s| s.bg(rgb(0xf5f5f5)))
        .child(text(label).text_color(rgb(0x171717)))
}
```

```tsx tabs
import { Text } from "nsh";
import { Button } from "nsh/base";

function Primary(props: { label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Button
      onPress={props.onPress}
      disabled={props.disabled}
      class="items-center rounded-lg bg-blue-600 px-4 py-3 active:bg-blue-700 disabled:opacity-40"
    >
      <Text class="font-semibold text-white">{props.label}</Text>
    </Button>
  );
}

function Secondary(props: { label: string; onPress: () => void }) {
  return (
    <Button
      onPress={props.onPress}
      class="items-center rounded-lg border border-neutral-300 px-4 py-3 active:bg-neutral-100 hover:bg-neutral-50"
    >
      <Text class="text-neutral-900">{props.label}</Text>
    </Button>
  );
}
```

状态变体在原生侧应用：按下时按钮在主线程上变暗，不需要运行任何 JS 或 Rust。在 Rust 中，状态方法就是这些变体：`.active(..)`、`.hover(..)`、`.focus(..)`、`.selected_style(..)` 和 `.disabled_style(..)` 跟随按钮自身的状态。主题颜色的用法相同：TSX 中写 `bg-primary`，Rust 中写 `theme().primary`（见[主题 token](../docs/tailwind.md#主题-token)）。

<a id="disabled"></a>

## 禁用

禁用的按钮不响应按压，也没有反馈，屏幕阅读器会报告它不可用。它禁用时的外观由你决定，使用 `disabled:` 类或 `disabledStyle`：

```rust tabs
fn save(saving: Signal<bool>) -> impl IntoElement {
    button()
        .disabled(saving)
        .on_press(move || saving.set(true))
        .rounded_lg()
        .px_4()
        .py_3()
        .bg(rgb(0x2563eb))
        .disabled_style(|s| s.opacity(0.4))
        .child(text("Save").text_color(white()))
}
```

```tsx tabs
<Button disabled={saving()} onPress={save} class="rounded-lg bg-blue-600 px-4 py-3 disabled:opacity-40">
  <Text class="text-white">Save</Text>
</Button>
```

<a id="a-toggle-with-selected"></a>

## 用 selected 做开关

`selected` 让按钮成为一个开关：工具栏的加粗按钮、筛选标签、当前标签页。值由应用持有，在 `onPress` 中切换，并为选中状态设置样式；屏幕阅读器会报告按钮已选中。

```rust tabs
fn bold(on: Signal<bool>) -> impl IntoElement {
    button()
        .selected(on)
        .accessibility_label("Bold")
        .on_press(move || on.update(|on| *on = !*on))
        .size(px(40.0))
        .items_center()
        .justify_center()
        .rounded_md()
        .selected_style(|s| s.bg(rgb(0xdbeafe)))
        .child(text("B").font_weight(FontWeight::BOLD))
}
```

```tsx tabs
<Button
  selected={bold()}
  onPress={() => bold.set(!bold())}
  accessibilityLabel="Bold"
  class="size-10 items-center justify-center rounded-md selected:bg-blue-100"
>
  <Text class="font-bold">B</Text>
</Button>
```

标签行用 [`Tabs`](./tabs.md)，开关用 [`Switch`](./switch.md)（均来自 `nsh/base`）：它们自带该类控件的角色、选中状态和键盘行为，用 `role="tab"` 或 `role="switch"` 的 `Button` 做不到这些。

<a id="accessibility"></a>

## 无障碍

- 对屏幕阅读器而言，按钮是一个元素，角色为 `"button"`，除非 `role` 另有指定。它的标签是它的文字内容；内容是图标或说明不足时，设置 `accessibilityLabel`。
- `disabled` 和 `selected` 按平台的方式播报（VoiceOver、TalkBack、UI Automation、浏览器的无障碍树）。
- 在 macOS 和 Web 上，按钮是键盘焦点的一站：Tab 可以到达它，Return 和空格按下它，`focus:` 样式显示焦点所在。

标签、角色和播报的一般用法见[无障碍](../docs/accessibility.md)。

<a id="platform-notes"></a>

## 平台说明

- iOS、Android 和 Mac Catalyst：一次按压是在按钮上结束的轻点；移开会取消它，与系统自己的按钮一致。
- 桌面平台（macOS、Windows、Linux、GPUI）和 Web：一次按压是一次单击。在 macOS 和 Web 上，Return 和空格也会按下拥有键盘焦点的按钮。`hover:` 样式在鼠标或触控板指针下生效。
- 每个平台都只绘制应用设定的样式：按压反馈是 `active:` / `activeStyle` 或你自己的动画。
