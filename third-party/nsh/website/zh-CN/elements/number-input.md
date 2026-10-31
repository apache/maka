---
title: NumberInput
description: "NumberInput 组件：在输入框里输入、或用按钮、方向键和屏幕阅读器步进的数字，保留步长的小数位并止于 min 和 max；输入框、按钮和按钮列由应用设置样式。"
group: base
demo: el-number-input
---

# NumberInput

数字输入框存放一个用户输入或步进的数字：数量、价格、尺寸。它负责自己的行为：输入框只接受数字或正在输入成数字的文本（`-`、`1.`），拒绝其他内容，其他键盘输入的数字和符号也能识别；
按钮、Up 和 Down 以及屏幕阅读器的增加和减少操作按 `step` 步进数字，保留小数位，并止于 `min` 和 `max`；离开输入框时，输入的数字会被限制在这个范围内。外观由应用决定：
`NumberInput` 没有自己的颜色、尺寸、边框、图标或文字。它由减少按钮、夹在应用的 `prefix` 和 `suffix` 之间的输入框、增加按钮组成（或用 `controlsRight` 变成夹在两者之间的输入框和一列放着两个按钮的控件列），
应用为每个部件设置样式并填充按钮内容。

```rust tabs
use nsh_base::{number_input, theme};
use nsh_core::prelude::*;

fn tickets(count: Signal<Option<f64>>) -> impl IntoElement {
    number_input()
        .value(move || count.get())
        .min(1.0)
        .max(10.0)
        .accessibility_label("Tickets")
        .on_change(move |next: &Option<f64>| count.set(*next))
        .h(px(32.0))
        .flex_row()
        .rounded(px(8.0))
        .border_1()
        .border_color(move || theme().input)
        .input_style(|s| s.flex_1().text_center().text_color(move || theme().foreground))
        .decrement_button_style(|s| s.w(px(32.0)).items_center().justify_center())
        .increment_button_style(|s| s.w(px(32.0)).items_center().justify_center())
        .decrement_button(text("−"))
        .increment_button(text("+"))
}
```

```tsx tabs
import { mount, signal, Text } from "nsh";
import { NumberInput } from "nsh/base";

function App() {
  const tickets = signal<number | null>(2);
  return (
    <NumberInput
      value={tickets()}
      onChange={({ value }) => tickets.set(value)}
      min={1}
      max={10}
      accessibilityLabel="Tickets"
      class="h-8 flex-row overflow-hidden rounded-lg border border-input bg-field focus-within:outline-2 focus-within:outline-ring"
      inputClass="flex-1 text-center text-foreground"
      decrementButtonClass="w-8 items-center justify-center enabled:hover:bg-accent active:bg-muted disabled:opacity-40"
      incrementButtonClass="w-8 items-center justify-center enabled:hover:bg-accent active:bg-muted disabled:opacity-40"
      decrementButton={<Text>−</Text>}
      incrementButton={<Text>+</Text>}
    />
  );
}

mount(App);
```

`NumberInput` 来自 [`nsh/base`](../modules/nsh-base.md)，在 Rust 中是 `nsh-base` crate。在 Rust 中，`number_input()` 创建一个数字输入框，每个属性一个
setter（`.value(..)`、`.input_style(..)`），每个事件一个监听方法（`.on_change(..)`），用类型化的样式方法设置输入框本身，用 `.prefix(..)` / `.suffix(..)` 添加输入框前后的内容。它的值是
`Option<f64>`。

## 值

值是一个数字，或表示空输入框的 `null`。和 `nsh/base` 的所有控件一样，应用用 `value` 持有它，并把 `onChange` 报告的值设回去；也可以用 `defaultValue` 把值交给输入框自己保存，
变化照样会报告。

输入框的文本和值在需要时分开保存，让用户可以自由输入：

- 输入框读出的数字变化时，`onChange` 报告这个数字：文本读不出数字时（空、`-`、`.`）报告 `null`；在 `1` 后面输入成 `1.`，或在 `1.5` 后面输入成 `1.50`，不会报告。
- 只要文本读出的是输入框当前持有的值，文本就保持用户输入的样子，所以把每个报告的值设回去的受控输入框会保留 `1.` 和 `2.50`。应用设置的、输入框没有报告过的值会显示在输入框里，
  写成能读回这个值的最短文本（`0.3`、`12`）。
- 输入过程中，数字可以超出 `min` 和 `max`（`min={10}` 时，输入 15 要先经过 1），并按输入的样子报告。离开输入框或按 Return / Enter 时，它被限制到这个范围内并报告；
  读不出数字的文本保持原样。
- 一次步进（按钮、按键、屏幕阅读器的操作）通过 `onChange` 请求下一个值；受控时，应用把值设回去后输入框才变化，并保留步进的小数位（`max={100}` 时 `99.5` 向上步进显示
  `100.0`），所以拒绝这次步进的应用会让输入框保持不变。应用拒绝的输入在编辑期间留在输入框里，离开输入框时消失。

```tsx
const price = signal<number | null>(19.95);

<NumberInput
  value={price()}
  onChange={({ value }) => price.set(value)}
  onSubmit={({ value }) => save(value)}
  min={0}
  step={0.05}
  placeholder="Price"
  accessibilityLabel="Price"
/>;
```

输入框接受：

- 数字、一个小数点和开头的一个正负号（`+` 或 `-`）；字母、第二个小数点或正负号、出现在其他位置的正负号会被拒绝，输入框回到原来的文本。
- 全角数字、正负号和小数点，减号（U+2212）和中文句号（`。`），按对应的 ASCII 字符读取，就像中文和日文输入法输入的那样。
- 文本中没有小数点时，逗号作为小数点（`3,25` 是 3.25），就像许多语言的键盘上小数键输入的那样。

## 属性

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `value` | `.value(..)` | `number \| null` | 无 | 值（受控）：一个数字，或表示空输入框的 `null`。应用把 `onChange` 报告的值设回去。 |
| `defaultValue` | `.default_value(..)` | `number \| null` | 无 | 未设置 `value` 时的初始值；之后由输入框自己保存。 |
| `min` | `.min(..)` | `number` | 无 | 最小值：步进止于它，离开输入框时低于它的输入值会被限制为它。 |
| `max` | `.max(..)` | `number` | 无 | 最大值，与 `min` 相对；小于 `min` 时取 `min`。 |
| `step` | `.step(..)` | `number` | `1` | 一次步进的距离（Page Up / Page Down：十步）；不是正数时取 `1`。 |
| `disabled` | `.disabled(..)` | `boolean` | `false` | 不能输入、步进或获得焦点；`disabled:` 类名作用于输入框和它的部件。 |
| `readonly` | `.readonly(..)` | `boolean` | `false` | 文本可以选择和复制，但不能通过输入或步进修改；按钮禁用。 |
| `placeholder` | `.placeholder(..)` | `string` | 无 | 输入框为空时显示。 |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | 无 | 没有可见标签时，屏幕阅读器为输入框朗读的内容。 |
| `controlsRight` | `.controls_right(..)` | `boolean` | `false` | 两个按钮竖着放在输入框右边，增加在上、减少在下。在创建时读取。 |
| `inputClass`、`inputStyle` | `.input_style(\|s\| ..)` | `string`、`StyleProp<InputStyle>` | 无 | 输入框：它的盒子和文字（`color`、`fontSize`、`textAlign`、`placeholderColor`）。 |
| `decrementButtonClass`、`decrementButtonStyle` | `.decrement_button_style(\|s\| ..)` | `string`、`StyleProp<ViewStyle>` | 无 | 减少按钮。 |
| `incrementButtonClass`、`incrementButtonStyle` | `.increment_button_style(\|s\| ..)` | `string`、`StyleProp<ViewStyle>` | 无 | 增加按钮。 |
| `decrementButton`、`incrementButton` | `.decrement_button(..)`、`.increment_button(..)` | `JSX.Element` | 无 | 按钮的内容：一个符号、一个图标。 |
| `controlsClass`、`controlsStyle` | `.controls_style(\|s\| ..)` | `string`、`StyleProp<ViewStyle>` | 无 | `controlsRight` 时放两个按钮的那一列。 |
| `prefix` | `.prefix(..)` | `JSX.Element` | 无 | 输入框前面、左侧按钮后面的内容：货币符号、图标。 |
| `suffix` | `.suffix(..)` | `JSX.Element` | 无 | 输入框后面、右侧按钮前面的内容：单位、币种。 |
| `class`、`style` | 样式方法 | `string`、`StyleProp<ViewStyle>` | 无 | 数字输入框本身：包住输入框和按钮的那一行。 |

## 事件

| 事件 | Rust | 参数 | 触发时机 |
|---|---|---|---|
| `onChange` | `.on_change(\|value: &Option<f64>\| ..)` | `{ value: number \| null }` | 输入框读出的数字变化了（输入、步进、屏幕阅读器的增加或减少、离开输入框时值超出范围）。 |
| `onSubmit` | `.on_submit(\|value: &Option<f64>\| ..)` | `{ value: number \| null }` | 在输入框里按 Return / Enter：被限制在 `min` 和 `max` 之间的值。 |
| `onFocus` | `.on_focus(..)` | 无 | 输入框获得了键盘焦点。 |
| `onBlur` | `.on_blur(..)` | 无 | 输入框失去了键盘焦点（先把值限制在 `min` 和 `max` 之间）。 |

## 部件

| 部件 | 位置 | 样式 |
|---|---|---|
| 数字输入框 | | `class`、`style` |
| 减少按钮 | 数字输入框里第一个（`controlsRight` 时：控件列里第二个） | `decrementButtonClass`、`decrementButtonStyle`；内容 `decrementButton` |
| 输入框 | 数字输入框里 | `inputClass`、`inputStyle` |
| 前缀 | 数字输入框里，输入框之前 | 它自己的元素（`prefix`） |
| 后缀 | 数字输入框里，输入框之后 | 它自己的元素（`suffix`） |
| 增加按钮 | 数字输入框里最后一个（`controlsRight` 时：控件列里第一个） | `incrementButtonClass`、`incrementButtonStyle`；内容 `incrementButton` |
| 控件列 | 数字输入框里最后一个，`controlsRight` 时 | `controlsClass`、`controlsStyle` |

数字输入框是一行，由应用布局：在 `class` 上用 `flex-row`，在输入框上用 `flex-1` 让它占满按钮留下的空间。各部件显示的状态：

- 数字输入框：输入框编辑时的 `focus-within:`（围住整个数字输入框的焦点环）、`disabled:`。
- 输入框：编辑时的 `focus:`、`disabled:`。
- 按钮：指针悬停时的 `hover:`、按下时的 `active:`，数字输入框禁用或只读时、以及步进不起作用时（减少按钮在 `min`、增加按钮在 `max`）的 `disabled:`。把悬停放在
  `enabled:` 后面（`enabled:hover:bg-accent`），禁用的按钮就不会亮起。

状态的动效由应用决定（`transition-colors`），`motion-reduce:` 让希望减少动效的用户看到静止的状态。

## 键盘

输入框编辑时，数字输入框接收 WAI-ARIA 数值调节框（spin button）的按键，按住时会重复：

| 按键 | 作用 |
|---|---|
| Up | 向上一步。 |
| Down | 向下一步。 |
| Page Up、Page Down | 向上或向下十步。 |

Home 和 End 仍归输入框：它们在文本中移动光标。按钮不是键盘焦点的一站：Tab 从输入框直接移到数字输入框后面的内容，按下按钮时焦点留在输入框里（在桌面平台上，焦点在别处时按下按钮会把焦点移到输入框；
在触摸屏上不会移动焦点，所以不会弹出键盘）。

## 无障碍

- 输入框是一个数值调节框（`"spinbutton"`），带有它的标签、值（读出的数字，在 `min` 和 `max` 之间）和文本。
- 屏幕阅读器的增加和减少操作（VoiceOver 的上下轻扫）会步进它，和 Up、Down 一样。
- 和浏览器的数字输入框一样，按钮对屏幕阅读器隐藏：输入框自己的增加和减少操作就能步进它。
- `disabled` 时，屏幕阅读器会说明输入框已变暗。

标签、角色和操作的一般用法见[无障碍](../docs/accessibility.md)。

## 平台说明

- 输入框是平台自己的文本框（[Input](./input.md)）：键盘、光标、选择、复制粘贴和输入法都由系统提供。手机上显示小数键盘，`min` 小于 0 或未设置时带正负号。
- 每个平台都绘制应用设置的样式。硬件键盘的 Up / Down 和 Page Up / Page Down 在所有平台上都能到达数字输入框。
