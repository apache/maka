---
title: Input
description: 原生文本输入框：受控与非受控文本、键盘、自动填充、选区、多行输入和焦点。
order: 6
group: primitives
demo: el-input
---

# Input

`Input` 是原生文本输入框：iOS 和 Mac Catalyst 上是 UITextField（单行）或 UITextView（多行），Android 上是 EditText。输入、光标、选区、自动更正和自动填充都由平台自己处理。Rust 用 `input()` 创建，TSX 用从 `nsh` 导入的 `<Input>`。

```rust tabs
use nsh_core::ui::prelude::*;

fn name_field() -> impl IntoElement {
    let name = signal(String::new());
    input()
        .value(name)
        .on_change(move |text: &str| name.set(text.to_string()))
        .placeholder("你的名字")
        .auto_capitalize(AutoCapitalize::Words)
        .return_key_type(ReturnKeyType::Done)
        .text_base()
        .p_3()
        .border_1()
        .border_color(rgb(0xd0d7de))
        .rounded(px(8.0))
}
```

```tsx tabs
import { Input, signal } from "nsh";

function NameField() {
  const name = signal("");
  return (
    <Input
      value={name()}
      onChange={(text) => name.set(text)}
      placeholder="你的名字"
      autoCapitalize="words"
      returnKeyType="done"
      style={{ fontSize: 16, padding: 12, borderWidth: 1, borderColor: "#d0d7de", borderRadius: 8 }}
    />
  );
}
```

## 受控与非受控

- **受控**：传入 `value`，并在 `onChange` 中更新它。应用可以改写用户的输入（去掉空白、格式化）：输入框会立即显示用户的编辑，新的 `value` 到达后再被修正。每次原生编辑都带有一个计数，基于最新一次编辑的 `value` 才会被应用，因此用户更新的输入总是优先于较慢的更新。
- **非受控**：传入 `defaultValue`（`.default_value(..)`，或不传），从 `onChange` 或 `onSubmit` 读取文本。

用户输入过程中必须遵守的规则以属性形式给出，由原生侧直接判断：`maxLength` 限制长度，`submitBehavior` 决定回车键的行为。参见[表单与键盘](../docs/forms-and-keyboard.md)。

## 属性

除[通用属性](./index.md#通用属性)外（`style` 的类型为 `TextStyle`：字体、颜色、对齐方式和视图样式都适用）：

### 文本

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `value` | `.value(..)` | `string` | | 由应用控制的文本。 |
| `defaultValue` | `.default_value(..)` | `string` | | 初始文本。 |
| `placeholder` | `.placeholder(..)` | `string` | | 输入框为空时显示的提示。 |
| `multiline` | `.multiline(..)` | `boolean` | `false` | 多行；回车插入换行（`submitBehavior` 另有设置时除外）。 |
| `maxLength` | `.max_length(..)` | `number` | | 用户最多能输入的字符数。 |
| `readonly` | `.readonly(..)` | `boolean` | `false` | 用户可以选择和复制文本，但不能修改。 |
| `masked` | `.masked(..)` | `boolean` | `false` | 隐藏文本（密码）。 |
| `allowFontScaling` | | `boolean` | `true` | 跟随系统文字大小。 |
| `maxFontSizeMultiplier` | | `number` | `0` | 系统缩放的上限（0 表示不限）。 |

### 键盘

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `keyboardType` | `.keyboard_type(KeyboardType::Email)` | `"default" \| "number-pad" \| "decimal-pad" \| "numeric" \| "numbers-and-punctuation" \| "email-address" \| "phone-pad" \| "url"` | `"default"` | 键盘布局（[各取值](../docs/forms-and-keyboard.md#键盘与自动填充)；`numbers-and-punctuation` 在 iOS 上有负号）。 |
| `returnKeyType` | `.return_key_type(ReturnKeyType::Next)` | `"default" \| "done" \| "go" \| "next" \| "search" \| "send"` | `"default"` | 回车键的标签。 |
| `autoCapitalize` | `.auto_capitalize(AutoCapitalize::None)` | `"none" \| "sentences" \| "words" \| "characters"` | `"sentences"` | 自动大写。 |
| `autoCorrect` | `.auto_correct(..)` | `boolean` | `true` | 系统自动更正。 |
| `autoComplete` | `.auto_fill(AutoFill::OneTimeCode)` | `AutoComplete \| TextContentType` | | 输入框内容的类型，用于自动填充：`"username"`、`"current-password"`、`"new-password"`、`"one-time-code"`、`"email"`、`"tel"`、`"postal-code"`、`"cc-number"`、`"off"` 等。 |
| `pasteBehavior` | `.paste_behavior(PasteBehavior::Report)` | `"insert" \| "report"` | `"insert"` | 粘贴做什么：`"insert"` 插入粘贴的文本，`"report"` 不插入任何内容，由应用处理 `onPaste` 报告的内容。图片和文件从不插入。 |
| `submitBehavior` | `.submit_behavior(SubmitBehavior::Submit)` | `"submit" \| "blurAndSubmit" \| "newline"` | `"blurAndSubmit"`（单行），`"newline"`（多行） | 回车键做什么：`"submit"` 触发 `onSubmit` 并保持焦点，`"blurAndSubmit"` 提交后再失去焦点，`"newline"` 插入换行（多行；单行总是提交）。会提交的多行输入框在硬件键盘上仍可用 Shift+Return 或 Option / Alt+Return 换行。`"submit"` 让键盘保持弹出（例如连续发送多条消息）。 |
| `autoFocus` | `.auto_focus(..)` | `boolean` | `false` | 出现时自动获得焦点。 |

### 光标与选区

| 属性 | Rust | 类型 | 说明 |
|---|---|---|---|
| `caret` | `.caret(..)` | `boolean` | 绘制光标（默认 `true`；`false` 隐藏光标）。 |
| `selectedRange` | `.selected_range((start, end))` | `{ start: number; end?: number }` | 受控选区，以 UTF-16 为单位；`end` 默认等于 `start`（即光标）。 |

### 颜色

提示文字的颜色以及光标和选区的颜色是样式键，有对应的 Tailwind 变体，在 Rust 中是方法：

| 样式键 | Rust | 类 | 说明 |
|---|---|---|---|
| `placeholderColor` | `.placeholder_color(..)` | `placeholder:text-*` | 提示文字的颜色。 |
| `selectionColor` | `.selection_color(..)` | `selection:text-*` | 光标和选区的颜色。 |

```rust tabs
input()
    .placeholder("搜索")
    .text_color(rgb(0x18181b))
    .placeholder_color(rgb(0x9ca3af))
    .selection_color(rgb(0x2563eb))
```

```tsx tabs
<Input placeholder="搜索" class="text-zinc-900 placeholder:text-zinc-400 selection:text-blue-600" />
<Input placeholder="搜索" style={{ placeholderColor: "#9ca3af", selectionColor: "#2563eb" }} />
```

### iOS

| `ios` 键 | Rust | 类型 | 说明 |
|---|---|---|---|
| `textContentType` | `.auto_fill(..)` | `AutoComplete \| TextContentType` | `autoComplete` 在 iOS 上的名称（`"oneTimeCode"`、`"newPassword"` 等）。 |
| `inputAccessoryViewID` | `.input_accessory(id)` | `string` | 一个 `InputAccessoryView`（[`nsh/ios`](../modules/nsh-ios.md)）的 `nativeID`，输入框获得焦点时显示在键盘上方。 |
| `keyboardAppearance` | `.keyboard_appearance(KeyboardAppearance::Dark)` | `"default" \| "light" \| "dark"` | 键盘的外观；`"default"` 跟随系统外观。Android 的键盘跟随系统主题。 |

```rust tabs
use nsh_core::ui::AutoFill;

input().auto_fill(AutoFill::OneTimeCode).keyboard_type(KeyboardType::Number)
```

```tsx tabs
<Input autoComplete="one-time-code" keyboardType="number-pad" ios={{ textContentType: "oneTimeCode" }} />
```

## 事件

| 事件 | Rust | 载荷 | 触发时机 |
|---|---|---|---|
| `onChange` | `.on_change(\|text: &str\| ..)` | `(text: string)` | 用户修改了文本。 |
| `onSubmit` | `.on_submit(\|text: &str\| ..)` | `{ text }` | 在会提交的输入框中按下了回车键（单行，或 `submitBehavior` 为 `"submit"` / `"blurAndSubmit"`）。 |
| `onFocus` / `onBlur` | `.on_focus` / `.on_blur` | 无 | 输入框获得 / 失去焦点。 |
| `onSelectionChange` | `.on_selection_change(\|s: &Selection\| ..)` | `{ start, end }` | 光标或选区移动（UTF-16 单位）。 |
| `onPaste` | `.on_paste(\|e: &PasteEvent\| ..)` | `{ text, files, uris }` | 用户粘贴了内容：文本、作为 `File` 的图片（如截图）、本地文件的 `file:` URL。在它插入的文本的 `onChange` 之前（[表单与键盘](../docs/forms-and-keyboard.md#粘贴图片和文件)）。 |
| `onCaretMove` | `.on_caret_move(\|e: &CaretEvent\| ..)` | `{ bounds, pageBounds }` | 光标随选区移动，或因文本滚动、重新换行而移动：`bounds` 是它在输入框中的位置，`pageBounds` 是它在窗口中的位置，可作为 `Overlay` 的 `anchor`（[表单与键盘](../docs/forms-and-keyboard.md#光标位置)）。 |
| `onKeyPress` | `.on_key_press(\|key: &str\| ..)` | `{ key }` | 文本变化之前：`key` 是输入的文本、`"Backspace"` 或 `"Enter"`。 |
| `onContentSizeChange` | `.on_content_size_change(\|size: &Size<Points>\| ..)` | `{ width, height }` | 文本尺寸变化（多行时按输入框宽度计算），随输入报告；输入框为空时报告一行空行的尺寸，与占位文字无关。 |
| `onCompositionChange` | `.on_composition_change(\|e: &Composition\| ..)` | `{ composing, text }` | 输入法的组字开始、变化或结束：`text` 是正在组的字（选字前的拼音、变换前的假名），结束时为 `""`。上屏的文本先经 `onChange` 报告，然后才报告结束。 |

随文本增高的多行输入框：

```rust tabs
let height = signal(px(40.0));

input()
    .multiline(true)
    .on_content_size_change(move |size: &Size<Points>| {
        height.set(px((size.height.0 + 16.0).clamp(40.0, 120.0)));
    })
    .h(move || height.get())
    .px_3()
    .py_2()
```

```tsx tabs
const height = signal(40);
<Input
  multiline
  onContentSizeChange={(e) => height.set(Math.min(120, Math.max(40, e.height + 16)))}
  style={{ height: height(), paddingHorizontal: 12, paddingVertical: 8 }}
/>;
```

## ref 方法

| 方法 | Rust | 说明 |
|---|---|---|
| `focus()` | `focus()` | 让输入框获得焦点并弹出键盘。 |
| `blur()` | `blur()` | 让它失去焦点。 |
| `setSelection(start, end?)` | `set_selection(start, end)` | 选中 `start..end`（UTF-16 单位）；两者相等时为光标。 |

按回车把焦点移到下一个输入框：

```rust tabs
use nsh_core::ui::AutoFill;

let password = element_ref();

view()
    .child(input().return_key_type(ReturnKeyType::Next).on_submit(move |_: &str| password.focus()))
    .child(input().element_ref(&password).masked(true).auto_fill(AutoFill::Password))
```

```tsx tabs
let password!: YNode;
<>
  <Input returnKeyType="next" onSubmit={() => password.focus()} />
  <Input ref={password} masked autoComplete="current-password" />
</>;
```

无论哪个输入框持有键盘，`nsh/base` 的 `Keyboard.dismiss()`（Rust 中为 `dismiss_keyboard()`）都能把它收起。

## 平台说明

- [滚动视图](./scroll.md#键盘)中的输入框会在原生侧自动避开键盘。其他位置请使用 [`KeyboardAvoidingView`](./keyboard-avoiding-view.md)。
- `disabled` 除了应用禁用样式，还会禁用输入框（不能获得焦点）；`readonly` 的输入框仍可获得焦点和选择文本。
- `inputAccessoryViewID` 在 iOS 上生效，那里的键盘有附件栏。
