---
title: 键盘
description: keyboard-inset-height 环境变量、Keyboard.dismiss 和键盘高度：让内容保持在软键盘之上，并随键盘移动。
order: 10.7
group: primitives
demo: el-keyboard
---

# 键盘

`env(keyboard-inset-height)` 是软键盘覆盖在界面上的高度，键盘隐藏时为 0。把它用作视图的底部内边距或外边距，可以让内容保持在键盘之上：键盘显示或隐藏时，视图按键盘高度让出空间，变化在原生侧随键盘一起动画。它用于滚动视图之外的内容，例如聊天界面底部的消息栏；[滚动视图](./scroll.md)或 [List](./list.md) 中的输入框会在原生侧滚动到可见位置。与它配套的还有隐藏键盘的 `Keyboard.dismiss()`，以及用于自定义布局的键盘高度。

```rust tabs
use nsh_core::prelude::*;

fn chat() -> impl IntoElement {
    let draft = signal(String::new());
    view()
        .flex_1()
        .bg(white())
        .pb_keyboard()
        .child(scroll().flex_1().child(text("Messages…").p_4()))
        .child(
            view()
                .flex_row()
                .gap_2()
                .p_2()
                .border_t_1()
                .border_color(rgb(0xe5e5e5))
                .child(
                    input()
                        .value(draft)
                        .on_change(move |v: &str| draft.set(v.to_owned()))
                        .placeholder("Message")
                        .flex_1()
                        .p_2(),
                ),
        )
}
```

```tsx tabs
import { mount, Scroll, signal, Text, View } from "nsh";
import { Input } from "nsh/base";

function App() {
  const draft = signal("");
  return (
    <View style={{ flex: 1, backgroundColor: "#ffffff", paddingBottom: "env(keyboard-inset-height)" }}>
      <Scroll style={{ flex: 1 }} keyboardDismissMode="interactive">
        <Text style={{ padding: 16, paddingTop: 48 }}>Messages…</Text>
      </Scroll>
      <View style={{ flexDirection: "row", gap: 8, padding: 8, borderTopWidth: 1, borderTopColor: "#e5e5e5" }}>
        <Input
          value={draft()}
          onChange={(v) => draft.set(v)}
          placeholder="Message"
          style={{ flex: 1, fontSize: 16, padding: 8 }}
        />
      </View>
    </View>
  );
}

mount(App);
```

完整的键盘高度适用于延伸到屏幕底部的视图，界面的内容通常如此。如果它下方还有东西，例如标签栏，就用一个长度减去它：`calc(env(keyboard-inset-height) + -49px)` 让视图保持在 49 pt 的标签栏之上，`calc(env(keyboard-inset-height) + 12px)` 在键盘上方增加间距。内边距至少为 0。

## 内边距或外边距

| 样式 | 让出空间的方式 |
|---|---|
| `paddingBottom: "env(keyboard-inset-height)"`（Tailwind `pb-[env(keyboard-inset-height)]`，Rust `.pb_keyboard()`） | 上方的内容缩小；背景仍延伸到屏幕底部。 |
| `marginBottom: "env(keyboard-inset-height)"`（Tailwind `mb-[env(keyboard-inset-height)]`，Rust `.mb_keyboard()`） | 整个视图（包括背景）在键盘顶部结束。 |

键盘高度只与同一声明中的长度相加，因此视图用 `calc()` 把它和自己的间距组合起来。在 Rust 中，`.pb_keyboard_plus(px(..))` 和 `.mb_keyboard_plus(px(..))` 加上一个长度。

```rust tabs
use nsh_core::prelude::*;

fn sign_in() -> impl IntoElement {
    view()
        .mb_keyboard_plus(px(-49.0))
        .flex_1()
        .p_4()
        .gap_3()
        .child(input().placeholder("E-mail").keyboard_type(KeyboardType::Email))
}
```

```tsx tabs
<View class="flex-1 gap-3 p-4 mb-[calc(env(keyboard-inset-height)+-49px)]">
  <Input placeholder="E-mail" keyboardType="email-address" class="rounded-lg border border-neutral-300 px-3 py-2" />
</View>
```

这里视图下方 49 pt 的标签栏已经遮住了一部分键盘高度。要关闭让位，就在样式中去掉这个变量，例如根据一个信号加条件。

## 隐藏键盘

`nsh` 的 `Keyboard.dismiss()` 让获得焦点的输入框失去焦点，从而隐藏键盘。没有输入框获得焦点时，它不做任何改变。Rust 组件调用 `dismiss_keyboard()`。

```rust tabs
use nsh_base::button;
use nsh_core::prelude::*;

fn done() -> impl IntoElement {
    button()
        .on_press(|| dismiss_keyboard())
        .rounded_lg()
        .bg(rgb(0x2563eb))
        .px_4()
        .py_3()
        .child(text("Done").text_color(white()))
}
```

```tsx tabs
import { Text, Keyboard } from "nsh";
import { Button } from "nsh/base";

function Done() {
  return (
    <Button onPress={() => Keyboard.dismiss()} class="rounded-lg bg-blue-600 px-4 py-3 active:bg-blue-700">
      <Text class="text-center font-semibold text-white">Done</Text>
    </Button>
  );
}
```

> [!TIP]
> 要在用户拖动滚动视图时隐藏键盘，请在[滚动视图](./scroll.md)或 [List](./list.md) 上设置 `keyboardDismissMode="on-drag"` 或 `"interactive"`。

## 键盘高度

| TSX | Rust | 返回 |
|---|---|---|
| `keyboardFrame()` | `keyboard_height()`、`keyboard_duration()` | 软键盘覆盖在 NSH 界面上的高度，单位为点（隐藏时为 0），以及其显示或隐藏动画的时长，单位为秒。 |

两者都是响应式的：读取它们的 effect、JSX 表达式或样式闭包会在键盘显示、隐藏或改变高度时重新运行。

```rust tabs
use nsh_core::prelude::*;

fn message_bar() -> impl IntoElement {
    view()
        .flex_row()
        .p_2()
        .pb(move || {
            // The home indicator's inset only matters while the keyboard is hidden.
            let home = if keyboard_height() > Points::ZERO {
                Points::ZERO
            } else {
                safe_area().bottom
            };
            px(8.0) + home
        })
        .child(input().placeholder("Message").flex_1())
}
```

```tsx tabs
import { View, keyboardFrame, safeArea } from "nsh";
import { Input } from "nsh/base";

function MessageBar() {
  const insets = safeArea();
  return (
    <View
      style={{
        flexDirection: "row",
        padding: 8,
        // The home indicator's inset only matters while the keyboard is hidden.
        paddingBottom: 8 + (keyboardFrame().height > 0 ? 0 : insets().bottom),
      }}
    >
      <Input placeholder="Message" style={{ flex: 1 }} />
    </View>
  );
}
```

高度是键盘与 NSH 界面重叠的部分。当窗口本身为键盘缩小时（会调整大小的 Android activity），或 NSH 嵌入在结束于键盘上方的视图中时，高度为 0。

> [!NOTE]
> 要让内容保持在键盘之上，`env(keyboard-inset-height)` 是更简单的方式：它在原生侧随键盘动画，不需要运行代码。

## 平台说明

- **iOS**：让位以键盘自身的时长和 ease-in-ease-out 曲线动画。
- **Android**：窗口为键盘缩小时（会调整大小的 activity），内容已经在键盘上方结束，变量为 0。键盘与视图重叠时，与 iOS 一样让出空间。
- **桌面平台和 Mac Catalyst** 使用硬件键盘输入：变量为 0，视图保持原有布局。
- **Web**：变量是浏览器自己的（VirtualKeyboard API 的）。

焦点顺序、回车键和输入附件参见[表单与键盘](../docs/forms-and-keyboard.md)，其他环境变量参见[安全区](./safe-area.md)。
