---
title: OtpInput
description: OtpInput 组件：定长的数字一次性验证码，输入、粘贴或由系统自动填充到一个原生输入框中，显示在由应用设置样式的格子、分组和光标里。
order: 20.15
group: base
demo: el-otp-input
---

# OtpInput

一次性验证码输入框接收固定位数的数字（短信里的验证码、身份验证器的验证码），并把它们显示在格子里。行为由它负责：一个透明的原生输入框覆盖在格子之上，接收键盘输入，因此打字、输入法、粘贴、数字键盘以及系统的验证码自动填充（iOS 的“来自信息”、Android 的短信验证码建议）都是平台自己的，屏幕阅读器也只看到一个文本框。只有数字能输入，最多 `length` 位；退格键删除最后一位，填满时 `onComplete` 通知应用。外观由应用决定：`OtpInput` 没有自己的颜色、尺寸、边框或文字。它的部件是格子、格子分成的组和光标，应用为每个部件设置样式。

```rust tabs
use nsh_base::{OtpInputCompleteEvent, otp_input, theme};
use nsh_core::prelude::*;

fn verification(verify: impl Fn(&str) + 'static) -> impl IntoElement {
    let code = signal(SharedString::default());
    otp_input()
        .length(6)
        .groups(2)
        .value(move || Some(code.get()))
        .on_change(move |next: &SharedString| code.set(next.clone()))
        .on_complete(move |e: &OtpInputCompleteEvent| verify(&e.value))
        .accessibility_label("验证码，6 位数字")
        .flex_row()
        .gap_3()
        .group_style(|s| s.flex_row().gap_2())
        .cell_style(|s| {
            s.w(px(40.0))
                .h(px(48.0))
                .items_center()
                .justify_center()
                .rounded(px(8.0))
                .border_1()
                .border_color(move || theme().input)
                .text_xl()
        })
        // 输入框获得焦点时，接收下一位数字的格子。
        .cell_class("focus:border-ring")
        .caret_style(|s| s.w(px(2.0)).h(px(24.0)).bg(move || theme().foreground))
}
```

```tsx tabs
import { mount, signal } from "nsh";
import { OtpInput } from "nsh/base";

function App() {
  const code = signal("");
  const verify = (value: string) => console.log(`checking ${value}`);
  return (
    <OtpInput
      length={6}
      groups={2}
      value={code()}
      onChange={({ value }) => code.set(value)}
      onComplete={({ value }) => verify(value)}
      accessibilityLabel="验证码，6 位数字"
      class="flex-row gap-3"
      groupClass="flex-row gap-2"
      cellClass="w-10 h-12 items-center justify-center rounded-lg border border-input text-xl focus:border-ring"
      caretClass="w-0.5 h-6 bg-foreground"
    />
  );
}

mount(App);
```

`OtpInput` 来自 [`nsh/base`](../modules/nsh-base.md)，在 Rust 中是 `nsh-base` crate。在 Rust 中，`otp_input()` 创建一个输入框，每个 prop 有一个 setter（`.length(..)`、`.cell_style(..)`），每个事件有一个监听方法（`.on_complete(..)`），输入框本身用带类型的样式方法设置样式。

## 验证码

- **受控**：传入 `value` 并在 `onChange` 中更新它。格子显示应用传入的 `value`，原样显示；应用自己设置的值（输错后清空验证码）不会被报告。
- **非受控**：传入 `defaultValue`（或不传），从 `onChange` 和 `onComplete` 读取验证码。

用户的操作从输入框读取，光标始终在末尾：

| 用户 | 验证码 |
|---|---|
| 输入一位数字 | 验证码短于 `length` 时加到末尾；填满后不再变化。 |
| 输入全角数字（`０`–`９`，东亚输入法输入的） | 加入对应的 ASCII 数字。 |
| 输入其他字符 | 不变；输入框丢弃它。 |
| 按退格键 | 删除最后一位。 |
| 粘贴，或系统自动填充验证码 | 其中的数字同样加入；含有 `length` 位或更多数字的文本（`123-456`、短信里的验证码）用它的前 `length` 位替换验证码。 |

`onChange` 报告每次变化及新的验证码；变化填满最后一个格子时，紧接着是 `onComplete`，应用在这里校验验证码。

## Props

| Prop | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `length` | `.length(..)` | `number` | 必填 | 验证码的位数：每位一个格子。 |
| `value` | `.value(..)` | `string` | 无 | 由应用控制的验证码（原样显示）。不传时输入框自己保存。 |
| `defaultValue` | `.default_value(..)` | `string` | 无 | 未设置 `value` 时的初始验证码。 |
| `masked` | `.masked(..)` | `boolean` | `false` | 已填的格子显示圆点而不是数字，输入框是安全输入框：屏幕阅读器不读出验证码，系统也不会把它放进建议里。 |
| `disabled` | `.disabled(..)` | `boolean` | `false` | 不能获得焦点，不能编辑；`disabled:` 样式作用于输入框和它的部件，屏幕阅读器读出它不可用。 |
| `groups` | `.groups(..)` | `number` | `1` | 格子尽量平均地分成几组（六位分两组是 3 + 3）；至少一组，最多每个格子一组。 |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | 无 | 屏幕阅读器为输入框读出的内容：验证码的用途和位数。 |
| `cellClass`、`cellStyle` | `.cell_class(..)`、`.cell_style(\|s\| ..)` | `string`、`StyleProp<TextStyle>` | 无 | 每个格子：尺寸、边框和文字（`color`、`fontSize`，由格子里的数字继承）。 |
| `groupClass`、`groupStyle` | `.group_class(..)`、`.group_style(\|s\| ..)` | `string`、`StyleProp<ViewStyle>` | 无 | 每组格子（`flex-row gap-2`）。 |
| `caretClass`、`caretStyle` | `.caret_class(..)`、`.caret_style(\|s\| ..)` | `string`、`StyleProp<ViewStyle>` | 无 | 光标：宽度、高度和颜色。 |
| `class`、`style` | 样式方法 | `string`、`StyleProp<ViewStyle>` | 无 | 输入框本身：包住各组的行（或列）。 |

## 事件

| 事件 | Rust | 参数 | 时机 |
|---|---|---|---|
| `onChange` | `.on_change(\|value: &SharedString\| ..)` | `(e: { value: string })` | 用户改变了验证码：输入、删除、粘贴或自动填充。 |
| `onComplete` | `.on_complete(\|e: &OtpInputCompleteEvent\| ..)` | `{ value }` | 用户的改动填满了最后一个格子，在它的 `onChange` 之后。 |
| `onFocus` / `onBlur` | `.on_focus` / `.on_blur` | 无 | 输入框获得 / 失去键盘焦点。 |

## Ref 方法

| 方法 | Rust | 说明 |
|---|---|---|
| `focus()` | `focus()`（`OtpInputApi`） | 获得键盘焦点并弹出软键盘，与按下输入框相同。 |

## 部件

| 部件 | 位于 | 样式 |
|---|---|---|
| 输入框 | | `class`、`style` |
| 组 | 输入框内，每组一个 | `groupClass`、`groupStyle`；`disabled:` 跟随输入框 |
| 格子 | 所在的组内，每位数字一个 | `cellClass`、`cellStyle`；输入框有焦点时，接收下一位数字的格子带 `focus:`，`disabled:` 跟随输入框 |
| 数字 | 已填的格子内 | 格子的文字样式（`text-xl`、`font-semibold`）；`masked` 时为 `•` |
| 光标 | 输入框有焦点时，接收下一位数字的空格子内 | `caretClass`、`caretStyle` |

接收下一位数字的格子是最后一位数字之后的格子，验证码填满后是最后一个格子。光标像文本框的光标一样闪烁（亮半秒、灭半秒，每次编辑后保持亮一会儿）；偏好减少动态效果时保持不动。按下输入框的任何位置都会让它获得焦点：输入框覆盖在格子之上。

## 无障碍

- 屏幕阅读器只看到一个文本框，名称来自 `accessibilityLabel`（说明验证码的用途和位数：“验证码，6 位数字”），值是验证码；格子对屏幕阅读器隐藏。`masked` 时输入框是安全输入框，验证码不会被读出。
- 键盘是平台的：手机上是数字键盘，桌面上是任意键盘（只有数字能输入），以及退格键。Tab 键像对任何文本框一样到达它。
- `disabled` 时不能获得焦点，屏幕阅读器读出它不可用。

标签、角色和播报的一般用法见[无障碍](../docs/accessibility.md)。

## 平台说明

- iOS：输入框是验证码输入框（`textContentType` 为 `oneTimeCode`），QuickType 栏会提供来自“信息”或“邮件”的验证码；弹出数字键盘。`masked` 的输入框失去焦点后再次输入时会从头开始，与 iOS 的安全输入框一样。
- Android：`autofillHints` 为 `smsOTPCode`，键盘和自动填充服务可以提供短信里的验证码；弹出数字键盘。
- macOS、Windows、Linux 和网页：输入和粘贴进入输入框（在浏览器中带 `inputmode="numeric"`，手机上弹出数字键盘），格子上显示 I 形指针。
