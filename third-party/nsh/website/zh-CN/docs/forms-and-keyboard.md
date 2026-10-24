---
title: 表单与键盘
description: 用 input 元素输入文本：受控与非受控的值、键盘类型、回车键、焦点、选区、自动增高的多行输入框，以及让内容避开软键盘。
order: 42
group: ui
demo: guide-forms
---

# 表单与键盘

文本输入使用 input 元素，Rust 中是 `input()`，TSX 中是 `<Input>`：iOS 上是 UITextField 或 UITextView，Android 上是 EditText。输入、光标、选区、自动更正和自动填充都由平台自己处理；应用通过事件拿到文本，也可以控制文本。NSH 还会自动让获得焦点的输入框保持在软键盘上方，并把键盘高度作为响应式的值提供给你，用于它自己处理不了的情况。

输入框和其他视图一样接受样式（Rust 中是类型化的样式方法，TSX 中是样式和 Tailwind 类），所以表单里的输入框是应用自己的外观。带标签的输入框就是一个简短的自定义组件：

```rust tabs
use nsh_core::ui::prelude::*;

fn field(label: &'static str, value: Signal<String>, masked: bool) -> impl IntoElement {
    let focused = signal(false);
    view()
        .gap_1()
        .child(text(label).text_sm().text_color(rgb(0x737373)))
        .child(
            input()
                .value(move || value.get())
                .on_change(move |text: &str| value.set(text.to_owned()))
                .masked(masked)
                .on_focus(move || focused.set(true))
                .on_blur(move || focused.set(false))
                .rounded_lg()
                .border_1()
                .px_3()
                .py_2()
                .text_base()
                .border_color(move || if focused.get() { rgb(0x0969da) } else { rgb(0xd0d7de) }),
        )
}
```

```tsx tabs
import { Input, signal, Text, View } from "nsh";

function Field(props: { label: string; value: string; onChange: (text: string) => void; masked?: boolean }) {
  const focused = signal(false);
  return (
    <View class="gap-1">
      <Text class="text-sm text-neutral-500">{props.label}</Text>
      <Input
        value={props.value}
        onChange={props.onChange}
        masked={props.masked}
        onFocus={() => focused.set(true)}
        onBlur={() => focused.set(false)}
        class="rounded-lg border px-3 py-2 text-base"
        style={{ borderColor: focused() ? "#0969da" : "#d0d7de" }}
      />
    </View>
  );
}
```

## 受控与非受控输入框

传入值时（`.value(..)`，TSX 的 `value`）输入框是**受控**的：它显示 signal 中的内容，由你在变化事件（`.on_change(..)`，TSX 的 `onChange`）中更新 signal。

```rust tabs
use nsh_core::ui::prelude::*;

#[component]
pub fn App() -> impl IntoElement {
    let name = signal(String::new());
    view()
        .flex_1()
        .p(px(16.0))
        .pt(px(60.0))
        .gap(px(8.0))
        .child(
            input()
                .value(move || name.get())
                .on_change(move |text: &str| name.set(text.to_owned()))
                .placeholder("Your name")
                .text_size(px(17.0))
                .border_1()
                .border_color(rgb(0xd0d7de))
                .rounded(px(10.0))
                .p(px(12.0)),
        )
        .child(text(move || {
            let name = name.get();
            format!("Hello, {}", if name.is_empty() { "stranger" } else { &name })
        }))
}
```

```tsx tabs
import { Input, mount, signal, Text, View } from "nsh";

function App() {
  const name = signal("");
  return (
    <View style={{ flex: 1, padding: 16, paddingTop: 60, gap: 8 }}>
      <Input
        value={name()}
        onChange={(text) => name.set(text)}
        placeholder="Your name"
        style={{ fontSize: 17, borderWidth: 1, borderColor: "#d0d7de", borderRadius: 10, padding: 12 }}
      />
      <Text>Hello, {name() || "stranger"}</Text>
    </View>
  );
}

mount(App);
```

既然值由你控制，就可以变换用户输入的内容：`.on_change(move |t: &str| tag.set(t.to_uppercase()))` 转为大写，`onChange={(t) => code.set(t.replace(/[^0-9]/g, ""))}` 只保留数字。

### 输入法

中文、日文、韩文输入法先组字再上屏：拼音在选字后变成“腾”。`onCompositionChange`（Rust 的 `.on_composition_change(..)`） 随组字报告其状态：用户输入时为 `{ composing: true, text: "teng" }`，结束时为 `{ composing: false, text: "" }`；上屏的文本先经 `onChange` 报告，然后才报告结束。在 iOS、Android、macOS 和 Web 上，系统把正在组的字放在输入框里，`onChange` 也会报告它；在 Windows、Linux 和 GPUI 上，`onChange` 报告上屏后的文本。受控输入框无论应用如何处理值，组字都会继续：用户组字时设置的 `value` 在组字结束后显示，因此转大写或过滤文本的输入框也能正常输入拼音。

只搜索上屏文本的搜索框：

```rust tabs
let query = signal(String::new());
let composing = signal(false);
input()
    .value(move || query.get())
    .on_change(move |text: &str| {
        query.set(text.to_owned());
        if !composing.get() {
            search(text);
        }
    })
    .on_composition_change(move |e: &Composition| {
        composing.set(e.composing);
        if !e.composing {
            search(&query.get());
        }
    })
```

```tsx tabs
const query = signal("");
let composing = false;
<Input
  value={query()}
  onChange={(text) => {
    query.set(text);
    if (!composing) search(text);
  }}
  onCompositionChange={(e) => {
    composing = e.composing;
    if (!e.composing) search(query());
  }}
/>
```

不传值时输入框是**非受控**的：它自己保存文本，初始值为默认值（`.default_value(..)`，TSX 的 `defaultValue`），需要时从变化或提交事件读取。只在提交时读取的字段（例如密码）适合这样用。

> [!NOTE]
> 受控输入框不会丢失按键。每次原生编辑都带有一个编辑计数，JS 传回的 `value` 只有对应最新一次编辑时才会被应用。如果 JS 较慢，而用户在这期间又输入了更多内容，过期的值会被丢弃，不会覆盖更新的文本。

## 属性

在 Rust 中，每个属性都是 `input()` 上同名的蛇形命名方法（`.placeholder(..)`、`.masked(true)`、`.max_length(6)`、`.return_key_type(ReturnKeyType::Next)`、`.selected_range((0, 4))`），以下几个有自己的名字：`.keyboard_type(KeyboardType::Email)` 及 `KeyboardType` 的其他变体，`autoComplete` 对应 `.auto_fill(AutoFill::Email)`，`ios={{ … }}` 中的属性对应 `.keyboard_appearance(..)` 和 `.input_accessory(..)`。每个事件都是一个 `on_` 方法：`.on_change(|text: &str| ..)`、`.on_submit(|text: &str| ..)`、`.on_focus(..)`、`.on_blur(..)`、`.on_selection_change(|s: &Selection| ..)`、`.on_key_press(|key: &str| ..)`、`.on_content_size_change(|size: &Size<Points>| ..)`。

| 属性 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `value` | `string` | | 由 JS 控制的文本。 |
| `defaultValue` | `string` | | 非受控输入框的初始文本。 |
| `placeholder` | `string` | | 输入框为空时显示。 |
| `masked` | `boolean` | `false` | 隐藏文本（密码）。 |
| `keyboardType` | `KeyboardType` | `"default"` | 键盘布局。 |
| `returnKeyType` | `ReturnKeyType` | `"default"` | 回车键上的文字。 |
| `autoCapitalize` | `"none" \| "sentences" \| "words" \| "characters"` | `"sentences"` | 自动大写。 |
| `autoCorrect` | `boolean` | `true` | 系统的自动更正。 |
| `autoComplete` | `AutoComplete` | | 输入框内容的类型，用于自动填充。 |
| `multiline` | `boolean` | `false` | 多行；回车插入换行（`submitBehavior` 另有设置时除外）。 |
| `maxLength` | `number` | | 用户最多能输入的字符数。 |
| `readonly` | `boolean` | `false` | 用户可以选择和复制文本，但不能修改。 |
| `autoFocus` | `boolean` | `false` | 出现时自动获得焦点。 |
| `submitBehavior` | `"submit" \| "blurAndSubmit" \| "newline"` | 单行 `"blurAndSubmit"`，多行 `"newline"` | 回车键做什么：提交并保持焦点、提交后失去焦点，或插入换行（仅多行）。 |
| `pasteBehavior` | `"insert" \| "report"` | `"insert"` | 粘贴做什么：插入其文本，或什么都不插入（[粘贴](#粘贴图片和文件)）。 |
| `caret` | `boolean` | `true` | 绘制光标；`false` 隐藏光标。 |
| `ios={{ keyboardAppearance }}` | `"default" \| "light" \| "dark"` | `"default"` | 键盘的外观（iOS）。 |
| `selectedRange` | `{ start: number; end?: number }` | | 受控的选区，单位为 UTF-16 码元。 |
| `allowFontScaling` | `boolean` | `true` | 跟随系统文字大小。 |
| `maxFontSizeMultiplier` | `number` | | 系统缩放的上限（0：无上限）。 |
| `ios={{ inputAccessoryViewID }}` | `string` | | iOS：显示在键盘上方的工具栏（见下文）。 |
| `ios={{ textContentType }}` | `TextContentType` | | iOS 对 `autoComplete` 取值的叫法。 |

事件：

| 事件 | 参数 | 触发时机 |
|---|---|---|
| `onChange` | `text: string` | 文本改变。 |
| `onSubmit` | `{ text }` | 在会提交的输入框中按下回车键（单行，或 `submitBehavior` 为 `"submit"` / `"blurAndSubmit"`）。 |
| `onFocus` / `onBlur` | | 获得 / 失去焦点。 |
| `onSelectionChange` | `{ start, end }` | 光标或选区移动（UTF-16 码元）。 |
| `onPaste` | `{ text, files, uris }` | 用户粘贴了内容：文本、作为 `File` 的图片、本地文件的 URL（[粘贴](#粘贴图片和文件)）。 |
| `onCaretMove` | `{ bounds, pageBounds }` | 光标移动：它在输入框和窗口中的位置（[光标位置](#光标位置)）。 |
| `onKeyPress` | `{ key }` | 文本改变之前：`key` 是输入的文本、`"Backspace"` 或 `"Enter"`。 |
| `onContentSizeChange` | `{ width, height }` | 文本尺寸改变（多行时按输入框的宽度计算），随输入报告；输入框为空时报告一行空行的尺寸，与占位文字无关。 |
| `onCompositionChange` | `{ composing, text }` | 输入法的组字开始、变化或结束（见[输入法](#输入法)）。 |

输入框的样式与文本相同：`fontSize`、`color`、`fontFamily`、`textAlign`、`letterSpacing` 以及其余[文本样式](./text.md)，再加上边框、内边距和背景。焦点样式（Rust 中是 `.focus(|s| ..)`，TSX 中是 Tailwind 的 `focus:` 变体或 `focusStyle`）在输入框获得焦点时生效。占位文字的颜色是 `.placeholder_color(..)`（样式键 `placeholderColor`，`placeholder:text-*`），光标和选区的颜色是 `.selection_color(..)`（`selectionColor`，`selection:text-*`）：

```rust tabs
input()
    .placeholder("Search")
    .rounded_lg()
    .border_1()
    .border_color(rgb(0xd4d4d8))
    .px_3()
    .py_2()
    .text_base()
    .focus(|s| s.border_color(rgb(0x3b82f6)))
    .placeholder_color(rgb(0xa1a1aa))
    .selection_color(rgb(0x2563eb))
```

```tsx tabs
<Input
  class="rounded-lg border border-zinc-300 px-3 py-2 text-base focus:border-blue-500 placeholder:text-zinc-400 selection:text-blue-600"
  placeholder="Search"
/>
```

## 键盘与自动填充

键盘类型（`.keyboard_type(..)`，TSX 的 `keyboardType`）选择键盘布局：

| Rust | TSX | 键盘 |
|---|---|---|
| `KeyboardType::Default` | `"default"` | 文本。 |
| `KeyboardType::Email` | `"email-address"` | 文本，方便输入 `@` 和 `.`。 |
| `KeyboardType::Url` | `"url"` | 文本，方便输入 `/` 和 `.com`。 |
| `KeyboardType::Number` | `"number-pad"` | 只有数字：没有正负号和小数点（验证码、PIN）。 |
| `KeyboardType::Decimal` | `"decimal-pad"` | 数字和小数点。 |
| `KeyboardType::Numeric` | `"numeric"` | 与 React Native 相同：iOS 上是小数键盘；Android 上是带正负号和小数点的数字键盘。 |
| `KeyboardType::NumbersAndPunctuation` | `"numbers-and-punctuation"` | 数字、负号和标点（iOS 的数字与标点键盘；Android 上是带正负号和小数点的数字键盘）。在 iOS 上输入负数时使用它。 |
| `KeyboardType::Phone` | `"phone-pad"` | 电话拨号盘。 |

在 iOS 上，`.keyboard_appearance(KeyboardAppearance::Dark)`（TSX 的 `ios={{ keyboardAppearance: "dark" }}`；或浅色、默认）让键盘使用浅色或深色外观而不随系统外观变化，适合在浅色模式下运行的深色应用。Android 的键盘始终跟随系统主题。

自动填充（`.auto_fill(AutoFill::Email)`，TSX 的 `autoComplete`）告诉系统字段里装的是什么，系统就能提供已保存的姓名、地址、密码以及短信中的验证码。Rust 的 `AutoFill` 每种内容一个变体（`Name`、`GivenName`、`FamilyName`、`Email`、`Tel`、`Username`、`Password`、`NewPassword`、`OneTimeCode`、`StreetAddress`、`PostalCode`、`Country`、`CreditCardNumber`、`Url`、`Birthdate` 等，以及 `Off`）。TSX 接受以下取值：`"name"`、`"given-name"`、`"family-name"`、`"email"`、`"tel"`、`"username"`、`"current-password"`、`"new-password"`、`"one-time-code"`、`"street-address"`、`"postal-code"`、`"country"`、`"cc-number"`、`"cc-exp"`、`"cc-csc"`、`"url"`、`"birthdate-full"` 等，或 `"off"`。iOS 自己的名字（`"emailAddress"`、`"oneTimeCode"` 等）也可以用在 `autoComplete` 或 `ios={{ textContentType }}` 中。

```rust tabs
use nsh_core::ui::AutoFill;

input()
    .keyboard_type(KeyboardType::Email)
    .auto_capitalize(AutoCapitalize::None)
    .auto_correct(false)
    .auto_fill(AutoFill::Email)
    .placeholder("E-mail")
input().masked(true).auto_fill(AutoFill::NewPassword).placeholder("Password")
input()
    .keyboard_type(KeyboardType::Number)
    .auto_fill(AutoFill::OneTimeCode)
    .max_length(6)
    .placeholder("Code")
```

```tsx tabs
<Input keyboardType="email-address" autoCapitalize="none" autoCorrect={false} autoComplete="email" placeholder="E-mail" />
<Input masked autoComplete="new-password" placeholder="Password" />
<Input keyboardType="number-pad" autoComplete="one-time-code" maxLength={6} placeholder="Code" />
```

## 回车键与在字段间切换

回车键类型（`.return_key_type(ReturnKeyType::Next)`，TSX 的 `returnKeyType`）设置回车键上的文字：默认、完成、前往、下一项、搜索或发送。按下它做什么由提交行为（`.submit_behavior(..)`，TSX 的 `submitBehavior`）决定：

| Rust | TSX | 回车 | 默认用于 |
|---|---|---|---|
| `SubmitBehavior::BlurAndSubmit` | `"blurAndSubmit"` | 触发提交事件，随后输入框失去焦点 | 单行输入框 |
| `SubmitBehavior::Submit` | `"submit"` | 触发提交事件，输入框保持焦点 | |
| `SubmitBehavior::Newline` | `"newline"` | 插入换行（仅多行输入框） | 多行输入框 |

设置了 `"submit"` 或 `"blurAndSubmit"` 的多行输入框像聊天输入框一样按回车发送，文本仍会自动换行；使用硬件键盘时（桌面、Mac、平板的外接键盘），Shift+Return 或 Option / Alt+Return 插入换行。用回车确认输入法的候选词（例如中文或日文输入）只会上屏，不会提交。

要切换到下一个字段，保存输入框的 ref（Rust 中是 `element_ref()` 和 `.element_ref(&r)`，TSX 中是 `ref`）并调用 `focus()`：

```rust tabs
use nsh_core::ui::prelude::*;

pub fn sign_in() -> impl IntoElement {
    let email = signal(String::new());
    let password = element_ref();
    let submit = move || log::info!("sign in {}", email.get());
    view()
        .flex_1()
        .p(px(16.0))
        .pt(px(60.0))
        .gap(px(12.0))
        .child(
            input()
                .value(move || email.get())
                .on_change(move |t: &str| email.set(t.to_owned()))
                .keyboard_type(KeyboardType::Email)
                .auto_capitalize(AutoCapitalize::None)
                .return_key_type(ReturnKeyType::Next)
                .submit_behavior(SubmitBehavior::Submit)
                .on_submit(move |_: &str| password.focus())
                .placeholder("E-mail"),
        )
        .child(
            input()
                .element_ref(&password)
                .masked(true)
                .return_key_type(ReturnKeyType::Go)
                .on_submit(move |_: &str| submit())
                .placeholder("Password"),
        )
}
```

```tsx tabs
import { Input, mount, signal, View, type YNode } from "nsh";

function SignIn() {
  const email = signal("");
  let password!: YNode;
  const submit = () => console.log("sign in", email());
  return (
    <View style={{ flex: 1, padding: 16, paddingTop: 60, gap: 12 }}>
      <Input
        value={email()}
        onChange={(t) => email.set(t)}
        keyboardType="email-address"
        autoCapitalize="none"
        returnKeyType="next"
        submitBehavior="submit"
        onSubmit={() => password.focus()}
        placeholder="E-mail"
      />
      <Input ref={password} masked returnKeyType="go" onSubmit={submit} placeholder="Password" />
    </View>
  );
}

mount(SignIn);
```

第一个字段上提交而不失去焦点（`SubmitBehavior::Submit`，`submitBehavior="submit"`）让键盘在焦点切换时保持弹出，不会先收起再弹起。按回车发送并保持焦点的聊天输入框也这样提交（见[下面](#滚动视图之外的内容keyboardavoidingview)的输入栏）。

最大长度和提交行为都在原生端执行：用户输入时，平台会询问"能否再加这个字符？"和"回车是否结束编辑？"，NSH 根据属性直接回答，不等待 JS。

## 从代码控制焦点

输入框的 ref 提供：

| Rust | TSX | 说明 |
|---|---|---|
| `focus()` | `focus()` | 让输入框获得焦点并弹出键盘。 |
| `blur()` | `blur()` | 让它失去焦点。 |
| `set_selection(start, end)` | `setSelection(start, end?)` | 选中 `start..end`（UTF-16 码元）；两者相等时为光标（TSX：不传 `end`）。 |

Rust 中的 `dismiss_keyboard()` 和 TSX 中 `nsh/base` 的 `Keyboard.dismiss()` 让当前拥有焦点的输入框失去焦点：

```rust tabs
view().on_press(|| dismiss_keyboard())
```

```tsx tabs
import { View } from "nsh";
import { Keyboard } from "nsh/base";

<View onPress={() => Keyboard.dismiss()}>…</View>
```

## 选区

选区事件（`.on_selection_change(..)`，TSX 的 `onSelectionChange`）报告光标和选区，ref 的 `set_selection` 或选区属性（`.selected_range(..)`，TSX 的 `selectedRange`）设置它们。位置以 UTF-16 码元计，与 JavaScript 字符串索引一致，所以在 TSX 中 `text.slice(start, end)` 就是选中的文本；在 Rust 中按文本的 UTF-16 码元截取。

```rust tabs
/// `text` 中按 UTF-16 码元计的 `start..end`，与输入框的计数方式一致。
fn utf16_slice(text: &str, start: u32, end: u32) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    let end = (end as usize).min(units.len());
    String::from_utf16_lossy(&units[(start as usize).min(end)..end])
}

let content = signal("Select part of this text".to_owned());
let range = signal(Selection::default());
let field = element_ref();

view()
    .child(
        input()
            .element_ref(&field)
            .value(move || content.get())
            .on_change(move |t: &str| content.set(t.to_owned()))
            .on_selection_change(move |r: &Selection| range.set(*r)),
    )
    .child(text(move || {
        let r = range.get();
        format!("Selected: \"{}\"", content.with(|t| utf16_slice(t, r.start, r.end)))
    }))
    .child(
        view()
            .on_press(move || {
                let len = content.with(|t| t.encode_utf16().count()) as u32;
                field.set_selection(0, len);
            })
            .child(text("Select all")),
    )
```

```tsx tabs
const text = signal("Select part of this text");
const range = signal({ start: 0, end: 0 });
const selection = signal<{ start: number; end?: number } | undefined>(undefined);

<Input
  value={text()}
  onChange={(t) => text.set(t)}
  selectedRange={selection()}
  onSelectionChange={(r) => range.set(r)}
/>
<Text>Selected: "{text().slice(range().start, range().end)}"</Text>
<View onPress={() => selection.set({ start: 0, end: text().length })}><Text>Select all</Text></View>
```

## 光标位置

光标事件（`.on_caret_move(..)`，TSX 的 `onCaretMove`）报告光标在哪里，让属于光标处的内容在那里打开：`@` 提及的候选列表、斜杠命令的菜单、表情选择器。`bounds` 是光标在输入框中的 `Bounds`（`origin` 和 `size`，已计入输入框的内边距和滚动），宽度是平台绘制的光标宽度，高度是它所在的行高；`pageBounds` 是同一个矩形在窗口（或输入框所在的对话框）中的位置，可直接作为浮层的 `anchor`。输入框获得焦点时，光标每次移动都会触发这个事件：随选区移动时，以及输入框的文本滚动或重新换行时。在 Rust 中，浮层用 `.anchor_bounds(..)` 相对一个矩形放置。

```rust tabs
let draft = signal(String::new());
let end = signal(0u32);
let caret = signal(None::<Bounds<Points>>);

view()
    .child(
        input()
            .multiline(true)
            .value(move || draft.get())
            .on_change(move |t: &str| draft.set(t.to_owned()))
            .on_selection_change(move |s: &Selection| end.set(s.end))
            .on_caret_move(move |e: &CaretEvent| {
                // 光标前的词以 "@" 开头时显示候选。
                let typed = draft.with(|t| utf16_slice(t, 0, end.get()));
                let word = typed.rsplit(char::is_whitespace).next().unwrap_or("");
                caret.set(word.starts_with('@').then_some(e.page_bounds));
            })
            .p_2(),
    )
    .child(when(
        move || caret.get().is_some(),
        move || {
            overlay()
                .anchor_bounds(move || caret.get().unwrap_or_default())
                .placement(Placement::Bottom)
                .align(Align::Start)
                .offset(px(4.0))
                .child(text("@ada"))
                .child(text("@grace"))
        },
    ))
```

```tsx tabs
import { type Bounds, Input, Overlay, Text, View, signal } from "nsh";

const draft = signal("");
const end = signal(0);
const caret = signal<Bounds | null>(null);

<View>
  <Input
    multiline
    value={draft()}
    onChange={(t) => draft.set(t)}
    onSelectionChange={(e) => end.set(e.end)}
    onCaretMove={(e) => {
      // 光标前的词以 "@" 开头时显示候选。
      const word = draft().slice(0, end()).split(/\s/).pop() ?? "";
      caret.set(word.startsWith("@") ? e.pageBounds : null);
    }}
    class="p-2"
  />
  <If when={caret()}>
    <Overlay anchor={caret()} placement="bottom" align="start" offset={4}>
      <Text>@ada</Text>
      <Text>@grace</Text>
    </Overlay>
  </If>
</View>;
```

`pageBounds` 是事件发生时光标所在的位置：页面在输入框下方滚动会移动输入框，但不会触发事件，所以页面滚动时关闭候选列表，或把它锚定到输入框本身。

## 粘贴图片和文件

粘贴事件（`.on_paste(..)`，TSX 的 `onPaste`）报告用户粘贴了什么，无论来自快捷键、菜单中的“粘贴”，还是键盘插入的图片：`text`、`files` 和 `uris`。`files` 是剪贴板中以数据形式存在的内容，例如截图、从网页或其他应用复制的图片：应用可以上传或显示的 `File`，名为 `image.png`（或其实际类型）。`uris` 是在文件管理器中复制的文件的 `file:` URL，与拖放文件时一样。平台在用户粘贴时读取剪贴板，且只在那时读取。

输入框照常自己插入粘贴的文本：事件在该文本的 `onChange` 之前到达。图片和文件从不插入，因为输入框只容纳文本。`pasteBehavior` 为 `"report"` 时输入框什么都不插入，由应用决定粘贴的效果：把长文本作为附件发送，或插入整理后的版本。由于系统要求当场作答，输入框根据这个属性立即决定。

```rust tabs
let attachments = signal(Vec::<PastedFile>::new());

input()
    .multiline(true)
    .placeholder("Message")
    .on_paste(move |e: &PasteEvent| {
        // 粘贴到消息里的截图作为图片一起发送。
        attachments.update(|a| a.extend(e.files.iter().cloned()));
    })
    .p_2()
```

```tsx tabs
import { Input, signal } from "nsh";

const attachments = signal<File[]>([]);

<Input
  multiline
  placeholder="Message"
  onPaste={(e) => {
    // 粘贴到消息里的截图作为图片一起发送。
    attachments.update((a) => [...a, ...e.files]);
  }}
  class="p-2"
/>;
```

像上传任何 `File` 一样上传粘贴的文件，使用 `fetch` 和 `FormData`（`form.append("image", file)`）；它的字节在发送前一直留在原生侧。在 Android 上，插入图片的键盘（GIF、贴纸）也以同样方式报告。在 Linux 上剪贴板是异步读取的，因此事件可能在它插入的文本的 `onChange` 之后到达。macOS 上的密码输入框保留 AppKit 自己的粘贴，不报告任何内容。

## 自动增高的多行输入框

多行输入框（`.multiline(true)`，TSX 的 `multiline`）在自身高度内滚动文本。要让它随内容增高，把内容尺寸事件（`.on_content_size_change(..)`，TSX 的 `onContentSizeChange`）报告的高度加上上限后写回样式：

```rust tabs
let height = signal(px(0.0));

input()
    .multiline(true)
    .placeholder("Write a comment")
    .on_content_size_change(move |e: &Size<Points>| height.set(e.height.min(px(120.0))))
    .text_size(px(16.0))
    .p(px(10.0))
    .border_1()
    .border_color(rgb(0xd0d7de))
    .rounded(px(10.0))
    .h(move || height.get().max(px(20.0)) + px(20.0))
```

```tsx tabs
const height = signal(0);

<Input
  multiline
  placeholder="Write a comment"
  onContentSizeChange={(e) => height.set(Math.min(e.height, 120))}
  style={{ fontSize: 16, padding: 10, borderWidth: 1, borderColor: "#d0d7de", borderRadius: 10, height: Math.max(height(), 20) + 20 }}
/>
```

报告的高度是文本本身的高度（按输入框宽度计算），所以要像上面那样自己加上上下内边距。

## 让输入框保持在键盘上方

### 滚动视图内：自动处理

当键盘弹出、而获得焦点的输入框位于滚动视图或列表中时，NSH 会给滚动视图加上与键盘等高的底部 inset，并把输入框滚动到可见位置。这是原生完成的，不需要任何代码。长表单就是一个装满输入框的滚动视图：

```rust tabs
scroll()
    .flex_1()
    .keyboard_dismiss_mode(KeyboardDismissMode::OnDrag)
    .keyboard_taps(KeyboardTaps::Handled)
    .child(view().p(px(16.0)).gap(px(12.0)) /* 输入框 */)
```

```tsx tabs
<Scroll style={{ flex: 1 }} keyboardDismissMode="on-drag" keyboardShouldPersistTaps="handled">
  <View style={{ padding: 16, gap: 12 }}>
    {/* 输入框 */}
  </View>
</Scroll>
```

收起方式（`.keyboard_dismiss_mode(..)`，TSX 的 `keyboardDismissMode`：不收起、拖动时、交互式）让拖动表单时收起键盘；已处理的点击（`.keyboard_taps(KeyboardTaps::Handled)`，TSX 的 `keyboardShouldPersistTaps="handled"`）让键盘弹出时点击按钮能直接生效，而不只是收起键盘。见[滚动](./scrolling.md#滚动视图与键盘)。

### 滚动视图之外的内容：KeyboardAvoidingView

固定在页面底部的消息栏不在滚动视图中，没有东西会移动它。用 `nsh_base`（TSX：`nsh/base`）中的 `KeyboardAvoidingView` 包住页面：它会在底部让出与键盘等高的空间，并与键盘同步动画。

```rust tabs
use nsh_base::keyboard_avoiding_view;
use nsh_core::ui::prelude::*;

pub fn chat_screen() -> impl IntoElement {
    let draft = signal(String::new());
    let send = move || {
        let text = draft.get();
        if !text.trim().is_empty() {
            log::info!("send {text}");
        }
        draft.set(String::new());
    };
    keyboard_avoiding_view()
        .flex_1()
        .child(scroll().flex_1().keyboard_dismiss_mode(KeyboardDismissMode::Interactive) /* 消息 */)
        .child(
            view()
                .flex_row()
                .p(px(8.0))
                // 在 Home 指示条之上，除非键盘已经盖住了它。
                .pb(move || {
                    px(8.0) + if keyboard_height() > px(0.0) { px(0.0) } else { safe_area().bottom }
                })
                .child(
                    input()
                        .value(move || draft.get())
                        .on_change(move |t: &str| draft.set(t.to_owned()))
                        .multiline(true)
                        .submit_behavior(SubmitBehavior::Submit)
                        .return_key_type(ReturnKeyType::Send)
                        .on_submit(move |_: &str| send())
                        .placeholder("Message")
                        .flex_1()
                        .max_h(px(120.0)),
                ),
        )
}
```

```tsx tabs
import { Input, Scroll, signal, View } from "nsh";
import { keyboardFrame, KeyboardAvoidingView, safeAreaInsets } from "nsh/base";

function ChatScreen() {
  const insets = safeAreaInsets();
  const draft = signal("");
  const send = () => {
    if (draft().trim()) console.log("send", draft());
    draft.set("");
  };
  return (
    <KeyboardAvoidingView style={{ flex: 1 }}>
      <Scroll style={{ flex: 1 }} keyboardDismissMode="interactive">
        {/* 消息 */}
      </Scroll>
      <View
        style={{
          flexDirection: "row",
          padding: 8,
          // 在 Home 指示条之上，除非键盘已经盖住了它。
          paddingBottom: 8 + (keyboardFrame().height > 0 ? 0 : insets().bottom),
        }}
      >
        <Input
          value={draft()}
          onChange={(t) => draft.set(t)}
          multiline
          submitBehavior="submit"
          returnKeyType="send"
          onSubmit={send}
          placeholder="Message"
          style={{ flex: 1, maxHeight: 120 }}
        />
      </View>
    </KeyboardAvoidingView>
  );
}
```

在 Rust 中，每个属性都是 `keyboard_avoiding_view()` 的一个设置方法（`.behavior(AvoidBehavior::Height)`、`.offset(px(49.0))`、`.enabled(move || ..)`）：

| 属性 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `behavior` | `"padding" \| "height"` | `"padding"` | `padding` 按键盘高度增加底部内边距；`height` 缩短视图（背景止于键盘处）。 |
| `enabled` | `boolean` | `true` | 是否避开键盘。 |
| `offset` | `number` | `0` | 键盘显示时额外加到键盘高度上的值（比如视图下方还有一个标签栏）。 |

它假定自己延伸到 surface 的底部，页面内容通常如此。在会为键盘缩小窗口的 Android 宿主上，窗口本身已经变小，`KeyboardAvoidingView` 无事可做。见 [KeyboardAvoidingView](../modules/nsh-base.md#keyboardavoidingview)。

### 键盘访问器

Rust 中的 `keyboard_height()` 和 `keyboard_duration()`，以及 TSX 中 `nsh/base` 的 `keyboardFrame()`（一个 `{ height, duration }`），都是响应式的：键盘伸入 surface 的高度（隐藏时为 0，包含被它盖住的底部安全区域）以及它的动画时长（秒）。需要自定义行为时读取它们，例如输入时隐藏浮动按钮，或调整面板尺寸。随它们变化的布局在键盘的曲线上做动画时，就与键盘一起移动：`LayoutAnimation.configureNext({ duration: keyboardFrame().duration * 1000, update: { type: "keyboard" } })`（Rust：`LayoutCurve::Keyboard`），`KeyboardAvoidingView` 就是这样做的。

```rust tabs
view().child(when(
    || keyboard_height() == px(0.0),
    || view().absolute().right(px(16.0)).bottom(px(16.0)), /* … */
))
```

```tsx tabs
import { View } from "nsh";
import { keyboardFrame } from "nsh/base";

<If when={keyboardFrame().height === 0}>
  <View style={{ position: "absolute", right: 16, bottom: 16 }}>…</View>
</If>
```

## 键盘上方的工具栏：InputAccessoryView

Rust 中的 `input_accessory_view(id)` 和 TSX 中 `nsh/ios` 的 `InputAccessoryView` 会在引用它的输入框获得焦点时，在键盘顶部显示一个附着的工具栏，即 iOS 的 `inputAccessoryView`。它由原生跟随键盘移动，包括交互式收起键盘的过程。它在树中所处的位置不占空间；输入框通过它的 id 引用它（`.input_accessory(id)`，TSX 的 `ios={{ inputAccessoryViewID }}` 与 `nativeID`）：

```rust tabs
use nsh_core::ui::prelude::*;

pub fn note() -> impl IntoElement {
    let content = signal(String::new());
    let field = element_ref();
    view()
        .p(px(16.0))
        .child(
            input()
                .element_ref(&field)
                .value(move || content.get())
                .on_change(move |t: &str| content.set(t.to_owned()))
                .input_accessory("note-bar")
                .placeholder("A note"),
        )
        .child(
            input_accessory_view("note-bar").bg(rgb(0xf6f8fa)).child(
                view()
                    .flex_row()
                    .items_center()
                    .p(px(8.0))
                    .child(
                        text(move || format!("{} characters", content.with(|t| t.chars().count())))
                            .flex_1()
                            .text_color(rgb(0x57606a)),
                    )
                    .child(
                        text("Done")
                            .on_press(move || field.blur())
                            .text_color(rgb(0x0969da))
                            .font_weight(FontWeight::SEMIBOLD),
                    ),
            ),
        )
}
```

```tsx tabs
import { Input, signal, Text, View, type YNode } from "nsh";
import { InputAccessoryView } from "nsh/ios";

function Note() {
  const text = signal("");
  let input!: YNode;
  return (
    <View style={{ padding: 16 }}>
      <Input
        ref={input}
        value={text()}
        onChange={(t) => text.set(t)}
        ios={{ inputAccessoryViewID: "note-bar" }}
        placeholder="A note"
      />
      <InputAccessoryView nativeID="note-bar" style={{ backgroundColor: "#f6f8fa" }}>
        <View style={{ flexDirection: "row", alignItems: "center", padding: 8 }}>
          <Text style={{ flex: 1, color: "#57606a" }}>{text().length} characters</Text>
          <Text onPress={() => input.blur()} style={{ color: "#0969da", fontWeight: "600" }}>Done</Text>
        </View>
      </InputAccessoryView>
    </View>
  );
}
```

工具栏与窗口等宽，高度由内容决定。输入附件视图是 iOS 的功能：在 Android 上它是一个空的隐藏视图（`nsh/ios` 的 `isAvailable` 为 `false`），所以在那里要为这些控件另找位置，例如放在输入框上方（Rust 中判断 `os() == Os::Android`，TSX 中判断 `platform.os === "android"`）。

## 相关内容

- [`Input`](../elements/input.md)：元素参考。
- [`KeyboardAvoidingView`](../modules/nsh-base.md#keyboardavoidingview) 与 [`Keyboard`](../modules/nsh-base.md#keyboard)。
- [`nsh/ios`](../modules/nsh-ios.md)：`InputAccessoryView`。
- [滚动](./scrolling.md#滚动视图与键盘)：滚动视图中的键盘收起与点击。
