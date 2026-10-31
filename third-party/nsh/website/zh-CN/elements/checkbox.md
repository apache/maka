---
title: Checkbox
description: Checkbox 组件：一个勾选、未勾选或半选的控件，负责按压、键盘激活、禁用状态以及屏幕阅读器的角色和值，指示器及其中的标记由应用设置样式。
group: base
demo: el-checkbox
---

# Checkbox

复选框用来选择一个选项、列表中的一项，或者全部选项。它处于勾选、未勾选或半选（两者都不是：部分选中时的“全选”）状态。它负责行为：按压、键盘激活、禁用状态，以及屏幕阅读器读到的复选框角色和它的值。外观由应用决定：`Checkbox` 没有自己的方框、标记、颜色、尺寸或文字。它由一个指示器（方框，里面是应用的标记）以及之后的子元素（标签）组成，应用为每个部件设置样式，部件上的 `checked:`、`indeterminate:` 和 `disabled:` 类跟随复选框的状态。

```rust tabs
use nsh_base::{checkbox, theme};
use nsh_core::prelude::*;

fn notify() -> impl IntoElement {
    let on = signal(false);
    checkbox()
        .checked(on)
        .on_change(move |next: &bool| on.set(*next))
        .flex_row()
        .items_center()
        .gap_2()
        .indicator_style(|s| {
            s.size(px(20.0))
                .items_center()
                .justify_center()
                .rounded_md()
                .border_2()
                .border_color(move || theme().border)
                .transition_colors()
                .checked(|s| s.bg(move || theme().primary).border_color(move || theme().primary))
        })
        .indicator(text(move || if on.get() { "✓" } else { "" }).text_color(move || theme().primary_foreground))
        .child(text("Notify me"))
}
```

```tsx tabs
import { mount, signal, Text } from "nsh";
import { Checkbox } from "nsh/base";

function App() {
  const on = signal(false);
  return (
    <Checkbox
      checked={on()}
      onChange={({ checked }) => on.set(checked)}
      class="flex-row items-center gap-2"
      indicatorClass="size-5 items-center justify-center rounded-md border-2 border-border transition-colors checked:border-primary checked:bg-primary"
      indicator={<Text class="text-primary-foreground">{on() ? "✓" : ""}</Text>}
    >
      <Text>Notify me</Text>
    </Checkbox>
  );
}

mount(App);
```

`Checkbox` 来自 [`nsh/base`](../modules/nsh-base.md)，在 Rust 中是 `nsh-base` crate。值由应用持有：按压时通过 `onChange` 报告下一个值，复选框显示应用传回的 `checked` 和 `indeterminate`。在 Rust 中，`checkbox()` 创建一个复选框，每个属性对应一个设置方法（`.checked(..)`、`.indicator_style(..)`），每个事件对应一个监听方法（`.on_change(..)`），复选框自身用类型化的样式方法，标签用 `.child(..)`；指示器的样式接受跟随复选框的状态方法（`.checked(..)`、`.indeterminate(..)`、`.disabled_style(..)`）。

<a id="props"></a>

## 属性

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `checked` | `.checked(..)` | `boolean` | `false` | 是否勾选。按压时通过 `onChange` 报告下一个值；复选框显示应用传回的值。 |
| `indeterminate` | `.indeterminate(..)` | `boolean` | `false` | 既非勾选也非未勾选，成立时优先于 `checked`：屏幕阅读器报告为部分选中，按压时请求勾选。 |
| `disabled` | `.disabled(..)` | `boolean` | `false` | 不响应按压，也没有按压反馈；复选框及其指示器的 `disabled:` 样式生效，屏幕阅读器会报告它不可用。 |
| `checkedStyle` | `.checked_style(\|s\| ..)` | `StyleProp<ViewStyle>` | 无 | 勾选且未禁用时复选框自身的样式，与 `checked:` 类相同。 |
| `indeterminateStyle` | `.indeterminate_style(\|s\| ..)` | `StyleProp<ViewStyle>` | 无 | 半选且未禁用时复选框自身的样式，与 `indeterminate:` 类相同。 |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | 无 | 屏幕阅读器读出的文字：子元素没有说明它选择什么的文字时设置。 |
| `role` | `.role(..)` | `AccessibilityRole` | `"checkbox"` | 它对屏幕阅读器而言是什么，用于更具体的情形（可勾选的菜单项：`"menuitem"`）。 |
| `indicatorClass`、`indicatorStyle` | `.indicator_style(\|s\| ..)` | `string`、`StyleProp<ViewStyle>` | 无 | 指示器，显示值的方框。 |
| `indicator` | `.indicator(..)` | `JSX.Element` | 无 | 指示器里的内容：标记（对勾、短横），由应用按它持有的值显示。 |
| `children` | `.child(..)` | `JSX.Element` | 无 | 指示器之后的内容：一个标签，屏幕阅读器会读出。 |
| `class`、`style` | 样式方法 | `string`、`StyleProp<ViewStyle>` | 无 | 复选框自身：包住指示器和标签的那一行。 |
| `activeStyle`、`hoverStyle`、`focusStyle`、`disabledStyle` | `.active(\|s\| ..)`、`.hover(..)`、`.focus(..)`、`.disabled_style(..)` | `StyleProp<ViewStyle>` | 无 | 复选框按下、悬停、获得焦点或禁用时的样式，与对应的 `<state>:` 类相同。 |

<a id="events"></a>

## 事件

| 事件 | Rust | 说明 |
|---|---|---|
| `onChange` | `.on_change(\|checked: &bool\| ..)` | 复选框被按下：轻点、点击、拥有键盘焦点时按 Space 或 Return，或屏幕阅读器的激活。它以 `checked` 报告复选框请求的值：从未勾选和半选时为 `true`，从勾选时为 `false`。 |

禁用的复选框不报告任何事件。

<a id="parts"></a>

## 部件

| 部件 | 位置 | 样式 | 状态 |
|---|---|---|---|
| 复选框 | | `class`、`style` | `checked:`、`indeterminate:`、`disabled:`、`active:`、`hover:`、`focus:`（或 `checkedStyle`、`indeterminateStyle`、`disabledStyle` 等） |
| 指示器 | 复选框里的第一个 | `indicatorClass`、`indicatorStyle` | `checked:`、`indeterminate:`、`disabled:` 跟随复选框 |
| 标记 | 指示器里 | 它自己的元素（`indicator`） | 在 `indicatorClass` 上加 `group` 后，使用 `group-checked:`、`group-indeterminate:` 等 `group-*:` 变体 |
| 标签 | 复选框里，指示器之后 | 它自己的元素（`children`） | 在复选框的 `class` 上加 `group` 后，使用 `group-*:` 变体 |

标记是应用的内容，所以显示什么由应用决定：根据应用持有的值，勾选时显示对勾、半选时显示短横；或者两个标记都放进去，用 `group-checked:` / `group-indeterminate:` 类选出显示的那一个。

<a id="indeterminate"></a>

## 半选

部分条目被选中时，“全选”复选框处于半选状态。按压时请求勾选，应用随即选中所有条目：

```tsx
const selected = signal<string[]>([]);
const all = () => selected().length === items.length;
const some = () => selected().length > 0 && !all();

<Checkbox
  checked={all()}
  indeterminate={some()}
  onChange={({ checked }) => selected.set(checked ? items.map((i) => i.id) : [])}
  class="flex-row items-center gap-2"
  indicatorClass="group size-5 items-center justify-center rounded-md border-2 border-border checked:border-primary checked:bg-primary indeterminate:border-primary indeterminate:bg-primary"
  indicator={
    <>
      <Text class="hidden text-primary-foreground group-checked:flex">✓</Text>
      <View class="hidden h-0.5 w-2.5 bg-primary-foreground group-indeterminate:flex" />
    </>
  }
>
  <Text>Select all</Text>
</Checkbox>
```

<a id="disabled"></a>

## 禁用

禁用的复选框不响应按压，屏幕阅读器会报告它不可用。它自身以及指示器的 `disabled:` 类生效，并覆盖它们的 `checked:` 和 `indeterminate:` 类：

```tsx
<Checkbox
  checked={on()}
  disabled={locked()}
  onChange={({ checked }) => on.set(checked)}
  class="flex-row items-center gap-2 disabled:opacity-50"
  indicatorClass="size-5 rounded-md border-2 border-border checked:border-primary checked:bg-primary disabled:border-border disabled:bg-muted"
>
  <Text>Share usage data</Text>
</Checkbox>
```

<a id="accessibility"></a>

## 无障碍

- 复选框对屏幕阅读器而言是一个元素，角色是 `"checkbox"`（或它的 `role`），带有它的值：勾选、未勾选，或半选时的部分选中。指示器和标记是它的部件。它的标签是子元素的文字；没有文字时设置 `accessibilityLabel`。
- `disabled` 按平台的方式报告（VoiceOver、TalkBack、UI Automation、浏览器的无障碍树）。
- 在 macOS 和 Web 上，复选框是键盘焦点的一站：Tab 可以到达它，Space 和 Return 切换它，`focus:` 样式显示焦点所在。

标签、角色和播报的一般用法见[无障碍](../docs/accessibility.md)。

<a id="platform-notes"></a>

## 平台说明

- iOS、Android 和 Mac Catalyst：按压是在复选框上（包括它的标签）结束的一次轻点。
- 桌面（macOS、Windows、Linux、GPUI）和 Web：按压是一次点击。在 macOS 和 Web 上，Space 和 Return 也会切换拥有键盘焦点的复选框。
- 每个平台都按应用的样式绘制：指示器、标记以及它们的过渡。
