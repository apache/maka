---
title: Terminal
description: Terminal 组件：用平台自己的文字引擎绘制程序输出，把用户的按键发回程序，所有平台可用；应用可以替换终端模拟器。
group: base
demo: el-terminal
---

# Terminal

终端显示一个程序（shell、构建、远程会话）的输出，并像终端应用一样把用户输入发回程序。它解释程序的转义序列（颜色、光标移动、擦除、滚动区域、全屏程序的备用屏幕、标题、响铃），并用平台自己的文字引擎绘制每一行，因此在 NSH 运行的每个平台上都可用：macOS、Windows、Linux、iOS、Android、Web 和终端后端。它保留可以像列表一样滚动的回滚缓冲区，用户停在底部时自动跟随最新输出。

程序由应用负责。`Terminal` 不启动任何东西：应用通过 ref 的 `write` 和 `onData` 事件把它接到字节来源上（桌面上的伪终端、WebSocket、SSH 通道），并把 `onResize` 报告的行列数告诉程序。

```tsx tabs
import { mount } from "nsh";
import { Terminal, type TerminalRef } from "nsh/base";

function App() {
  let term: TerminalRef | undefined;
  const socket = new WebSocket("wss://example.com/shell");
  socket.onmessage = (e) => term?.write(e.data);
  return (
    <Terminal
      ref={(r) => (term = r)}
      onData={({ data }) => socket.send(data)}
      onResize={({ cols, rows }) => socket.send(JSON.stringify({ cols, rows }))}
      accessibilityLabel="Shell"
      cursorClass="bg-foreground/50"
      class="flex-1 rounded-xl bg-card px-3 py-2"
    />
  );
}

mount(App);
```

```rust tabs
use nsh_base::terminal;
use nsh_core::prelude::*;

fn shell() -> impl IntoElement {
    terminal()
        .accessibility_label("Shell")
        .cursor_class("bg-foreground/50")
        .on_data(|data: &SharedString| send_to_program(data))
        .flex_1()
}
```

`Terminal` 来自 [`nsh/base`](../modules/nsh-base.md)，在 Rust 中是 `nsh-base` crate（feature `term`，默认开启）。

## 属性

| 属性 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `scrollback` | `number` | `1000` | 滚出顶部后保留的行数。 |
| `fontFamily` | `string` | 主题的 `font-mono` | 等宽字体。 |
| `fontSize` | `number` | `13` | 字号，单位为点。 |
| `lineHeight` | `number` | `18` | 每行高度，单位为点。 |
| `accessibilityLabel` | `string` | 无 | 屏幕阅读器读出的终端名称。 |
| `cursorClass`、`cursorStyle` | `string`、`StyleProp<ViewStyle>` | 无 | 光标：覆盖在所在单元格上、一格宽的方块，颜色和形状由应用决定。 |
| `class`、`style` | `string`、`StyleProp<ViewStyle>` | 无 | 终端本身：背景、内边距、边框。 |

## 事件

| 事件 | 参数 | 触发时机 |
|---|---|---|
| `onData` | `{ data }` | 发给程序的文本：用户输入或粘贴的内容（程序要求时使用括号粘贴）、没有文字的按键按程序期望的编码，以及对程序查询的应答。 |
| `onResize` | `{ cols, rows }` | 行列数变化时，首次布局后也会触发。 |
| `onTitleChange` | `{ title }` | 程序设置了标题。 |
| `onBell` | | 程序响铃。 |

## Ref

| 方法 | 说明 |
|---|---|
| `write(data)` | 显示程序的输出。 |
| `reset()` | 清空屏幕和回滚缓冲区。 |
| `text()` | 所有行的文本，返回 Promise。 |
| `focus()` | 获取键盘焦点，手机上会弹出软键盘。 |

## 颜色

程序要求的颜色按原样显示：16 个 ANSI 颜色使用 VS Code 终端的配色，在浅色和深色背景上都清晰可读；256 色和 24 位颜色按给定值显示。没有指定颜色的文字使用主题的 `foreground`；没有背景色的单元格显示终端自身的背景，即应用的 `class`。

## 替换模拟器

内置的模拟器是 NSH 自己用 Rust 基于 `vte` 实现的。Rust 应用要使用其他模拟器（libghostty、`alacritty_terminal` 等），只需基于它实现 `TerminalEmulator`，再给下方的终端提供一个 `TerminalEmulatorFactory`；视图、按键和事件保持不变：

```rust
provide_context(TerminalEmulatorFactory::new(|size, scrollback| {
    Box::new(MyEmulator::new(size, scrollback))
}));
```

如果应用想使用另一个终端的完整视图（包括它自己的渲染器），把它注册为[原生组件](../docs/native-components.md)。
