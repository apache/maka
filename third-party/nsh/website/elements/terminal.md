---
title: Terminal
description: "The Terminal component: a program's output drawn with the platform's own text, the keys the user types sent back, on every platform; the emulator replaceable by the app."
group: base
demo: el-terminal
---

# Terminal

A terminal shows the output of a program (a shell, a build, a remote session) and sends what the user types back to
it, as a terminal application does. It interprets the program's escape sequences (colors, cursor moves, erasing,
scroll regions, the alternate screen of full-screen programs, titles, the bell) and draws the lines with the
platform's own text engine, so it runs everywhere NSH does: macOS, Windows, Linux, iOS, Android, the web and the
terminal backend. It keeps a scrollback that scrolls like a list and follows the end while the user is there.

The program is the app's. A `Terminal` starts nothing: the app connects it to a source of bytes (a pseudo-terminal
on the desktop, a WebSocket, an SSH channel) with the ref's `write` and the `onData` event, and tells the program the
size in cells that `onResize` reports.

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

`Terminal` comes from [`nsh/base`](../modules/nsh-base.md), the `nsh-base` crate in Rust (feature `term`, on by
default).

## Props

| Prop | Type | Default | Description |
|---|---|---|---|
| `scrollback` | `number` | `1000` | How many lines scrolled off the top are kept. |
| `fontFamily` | `string` | the theme's `font-mono` | The monospaced font. |
| `fontSize` | `number` | `13` | The font size, in points. |
| `lineHeight` | `number` | `18` | The height of a row, in points. |
| `accessibilityLabel` | `string` | none | What screen readers say the terminal is. |
| `cursorClass`, `cursorStyle` | `string`, `StyleProp<ViewStyle>` | none | The cursor: a box one cell wide over the cell it is at; its color and shape are the app's. |
| `class`, `style` | `string`, `StyleProp<ViewStyle>` | none | The terminal itself: its background, padding, border. |

## Events

| Event | Payload | When |
|---|---|---|
| `onData` | `{ data }` | Text for the program: what the user typed or pasted (bracketed when the program asks), the keys with no text as the program expects them, and answers to the program's queries. |
| `onResize` | `{ cols, rows }` | The size in cells changed, first once laid out. |
| `onTitleChange` | `{ title }` | The program set the title. |
| `onBell` | | The program rang the bell. |

## Ref

| Method | Description |
|---|---|
| `write(data)` | Shows the program's output. |
| `reset()` | Clears the screen and the scrollback. |
| `text()` | The text of every line, as a promise. |
| `focus()` | Takes the keyboard focus, showing the software keyboard on phones. |

## Colors

The program's colors show as it asks for them: the 16 ANSI colors in VS Code's terminal palette, which reads well on
light and dark backgrounds, 256-color and 24-bit colors as given. Text without a color is the theme's `foreground`;
cells without a background show the terminal's own, the app's `class`.

## Another emulator

The emulator built in is NSH's own, written in Rust on `vte`. A Rust app uses another one (libghostty,
`alacritty_terminal`, ...) by implementing `TerminalEmulator` over it and giving the terminals below a
`TerminalEmulatorFactory`; the view, the keys and the events stay the same:

```rust
provide_context(TerminalEmulatorFactory::new(|size, scrollback| {
    Box::new(MyEmulator::new(size, scrollback))
}));
```

An app that wants another terminal's whole view, its renderer included, registers it as a
[native component](../docs/native-components.md).
