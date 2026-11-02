---
title: Radio
description: Radio 与 RadioGroup：一组选项，用户从中恰好选一个。每个单选框负责按压、键盘激活、禁用状态以及屏幕阅读器的角色和勾选状态；分组就是这组选项；外观和值都属于应用。
group: base
demo: el-radio
---

# Radio

单选框提供一组选项，用户从中恰好选一个：一个套餐、一种排序、一个主题。每个 `Radio` 负责一个选项的行为：按压、键盘激活、禁用状态，以及屏幕阅读器读到的单选框角色和它的勾选状态。包在外面的 `RadioGroup` 就是这一组，屏幕阅读器把它当作一个分组播报。外观由应用决定：单选框没有自己的圆圈、圆点、颜色、尺寸或文字。它的子元素是应用自己的指示器和标签，单选框上的 `checked:` 类，以及它里面元素上的 `group-checked:` 类，跟随它的状态。

```rust tabs
use nsh_base::{radio, radio_group, theme};
use nsh_core::prelude::*;

fn plans() -> impl IntoElement {
    let plan = signal("basic");
    let option = move |value: &'static str, label: &'static str| {
        let checked = move || plan.get() == value;
        radio()
            .checked(checked)
            .on_change(move |_: &bool| plan.set(value))
            .flex_row()
            .items_center()
            .gap_2()
            .child(
                view()
                    .size(px(20.0))
                    .items_center()
                    .justify_center()
                    .rounded_full()
                    .border_2()
                    .border_color(move || theme().border)
                    .child(
                        view()
                            .size(px(10.0))
                            .rounded_full()
                            .bg(move || theme().primary)
                            .opacity(move || if checked() { 1.0_f32 } else { 0.0 }),
                    ),
            )
            .child(text(label))
    };
    radio_group()
        .gap_3()
        .child(option("basic", "Basic"))
        .child(option("pro", "Pro"))
}
```

```tsx tabs
import { mount, signal, Text, View } from "nsh";
import { Radio, RadioGroup } from "nsh/base";

function App() {
  const plan = signal("basic");
  const option = (value: string, label: string) => (
    <Radio
      checked={plan() === value}
      onChange={() => plan.set(value)}
      class="group flex-row items-center gap-2"
    >
      <View class="size-5 items-center justify-center rounded-full border-2 border-border group-checked:border-primary">
        <View class="size-2.5 rounded-full group-checked:bg-primary" />
      </View>
      <Text>{label}</Text>
    </Radio>
  );
  return (
    <RadioGroup class="gap-3">
      {option("basic", "Basic")}
      {option("pro", "Pro")}
    </RadioGroup>
  );
}

mount(App);
```

`Radio` 和 `RadioGroup` 来自 [`nsh/base`](../modules/nsh-base.md)，在 Rust 中是 `nsh-base` crate。值由应用持有：分组本身不持有值。每个单选框被告知自己是否勾选；按下未勾选的单选框时通过 `onChange({ checked: true })` 报告，应用设置自己的值，每个单选框显示应用传回的 `checked`。在 Rust 中，`radio()` 和 `radio_group()` 创建它们，每个属性对应一个设置方法（`.checked(..)`），每个事件对应一个监听方法（`.on_change(..)`），外观用类型化的样式方法，内容用 `.child(..)`。

<a id="props"></a>

## 属性

### Radio

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `checked` | `.checked(..)` | `boolean` | `false` | 是否勾选。按下未勾选的单选框时通过 `onChange` 报告 `true`；单选框显示应用传回的值。 |
| `disabled` | `.disabled(..)` | `boolean` | `false` | 不响应按压，也没有按压反馈；`disabled:` 样式生效，屏幕阅读器会报告它不可用。 |
| `checkedStyle` | `.checked_style(\|s\| ..)` | `StyleProp<ViewStyle>` | 无 | 勾选且未禁用时单选框自身的样式，与 `checked:` 类相同。 |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | 无 | 屏幕阅读器读出的文字：子元素没有说明这个选项的文字时设置。 |
| `children` | `.child(..)` | `JSX.Element` | 无 | 应用的指示器和标签，屏幕阅读器会读出。 |
| `class`、`style` | 样式方法 | `string`、`StyleProp<ViewStyle>` | 无 | 单选框自身：包住指示器和标签的那一行。 |
| `activeStyle`、`hoverStyle`、`focusStyle`、`disabledStyle` | `.active(\|s\| ..)`、`.hover(..)`、`.focus(..)`、`.disabled_style(..)` | `StyleProp<ViewStyle>` | 无 | 单选框按下、悬停、获得焦点或禁用时的样式，与对应的 `<state>:` 类相同。 |

### RadioGroup

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `children` | `.child(..)` | `JSX.Element` | 无 | 这一组单选框，以及应用放在它们之间的其他内容。 |
| `class`、`style` | 样式方法 | `string`、`StyleProp<ViewStyle>` | 无 | 分组的布局和外观：默认是一列，`flex-row` 排成一行。 |

<a id="events"></a>

## 事件

| 事件 | Rust | 说明 |
|---|---|---|
| `onChange`（`Radio`） | `.on_change(\|checked: &bool\| ..)` | 未勾选的单选框被按下：轻点、点击、拥有键盘焦点时按 Space 或 Return，或屏幕阅读器的激活；或者分组的方向键把键盘焦点移到了它上面。它请求被勾选，所以 `checked` 是 `true`。它在任何变化之前运行：单选框显示应用传回的 `checked`。 |

已勾选的单选框保持勾选，不报告任何事件，因为单选框不能取消自己的勾选；禁用的单选框同样不报告。

<a id="parts"></a>

## 部件

| 部件 | 位置 | 样式 | 状态 |
|---|---|---|---|
| 分组 | | `RadioGroup` 的 `class`、`style` | |
| 单选框 | 分组里 | `Radio` 的 `class`、`style` | `checked:`、`disabled:`、`active:`、`hover:`、`focus:`（或 `checkedStyle`、`disabledStyle` 等） |
| 指示器和标签 | 单选框里 | 它们自己的元素（`children`） | 在单选框的 `class` 上加 `group` 后，使用 `group-checked:`、`group-disabled:` 等 `group-*:` 变体 |

指示器是应用的内容：带圆点的圆环、对勾、高亮的卡片都可以。在单选框的 `class` 上加 `group` 后，指示器的 `group-checked:` 类在单选框勾选时显示圆点。

<a id="disabled"></a>

## 禁用

禁用的单选框不响应按压，屏幕阅读器会报告它不可用。它的 `disabled:` 类生效并覆盖 `checked:` 类，它里面的 `group-disabled:` 类随之生效：

```tsx
<Radio
  checked={plan() === "team"}
  disabled={!eligible()}
  onChange={() => plan.set("team")}
  class="group flex-row items-center gap-2 disabled:opacity-50"
>
  <View class="size-5 items-center justify-center rounded-full border-2 border-border group-checked:border-primary">
    <View class="size-2.5 rounded-full group-checked:bg-primary" />
  </View>
  <Text>Team</Text>
</Radio>
```

<a id="accessibility"></a>

## 无障碍

- 单选框对屏幕阅读器而言是一个元素，角色是 `"radio"`，带有它的状态：是否勾选，以及勾选时为已选中。有的屏幕阅读器读前者，有的读后者（UI Automation 的单选框是可选中的项）。指示器和标签是它的部件；它的标签是子元素的文字，或 `accessibilityLabel`。
- `RadioGroup` 的角色是 `"radiogroup"`：屏幕阅读器把其中的单选框当作一组播报，每个单选框仍然是独立的元素。
- `disabled` 按平台的方式报告（VoiceOver、TalkBack、UI Automation、浏览器的无障碍树）。
- 在 macOS 和 Web 上，整个 `RadioGroup` 是键盘焦点的一站，方向键在它的单选框之间移动并勾选它们（见下文）。

标签、角色和播报的一般用法见[无障碍](../docs/accessibility.md)。

<a id="keyboard"></a>

## 键盘

在 macOS 和 Web 上，Tab 会到达接受按压的视图，`RadioGroup` 遵循
[WAI-ARIA 单选组模式](https://www.w3.org/WAI/ARIA/apg/patterns/radio/)：

| 按键 | 作用 |
|---|---|
| Tab、Shift+Tab | 从勾选的单选框进入分组（没有勾选时是第一个未禁用的单选框），一步离开分组。 |
| Down、Right | 把焦点移到下一个单选框（从最后一个回到第一个），并勾选它。 |
| Up、Left | 把焦点移到上一个单选框（从第一个回到最后一个），并勾选它。 |
| Space | 勾选拥有焦点的单选框。 |

方向键跳过禁用的单选框；焦点移到的单选框通过 `onChange` 请求被勾选，由应用勾选它。`focus:` 样式显示焦点所在。不在 `RadioGroup` 里的 `Radio` 是独立的一站，Tab 可以到达它，Space 和 Return 勾选它。

<a id="platform-notes"></a>

## 平台说明

- iOS、Android 和 Mac Catalyst：按压是在单选框上（包括它的标签）结束的一次轻点。
- 桌面（macOS、Windows、Linux、GPUI）和 Web：按压是一次点击。在 macOS 和 Web 上，Space 和 Return 也会勾选拥有键盘焦点的单选框，方向键移动焦点（见[键盘](#keyboard)）。
- 每个平台都按应用的样式绘制：指示器、标签以及它们的过渡。
