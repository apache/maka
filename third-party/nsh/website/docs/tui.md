---
title: TUI
description: "Run Rust and TSX NSH apps in a terminal: the Cell layout, keyboard and mouse input, the terminal's colors, how components and popups look on the grid, detecting the terminal in app code, testing, and embedding AppView in a ratatui app."
order: 16.5
group: platforms
---

# TUI

NSH apps also run in a terminal. The terminal backend draws an app on the terminal's grid of character Cells with
[ratatui](https://ratatui.rs), in the terminal's own font and colors, and takes its input from the keyboard and the
mouse. The core, the reactive graph, the renderer, the components and the native modules are the same as on every
other platform, so the app that runs in a window runs in a terminal too: the gallery's demos are the same code here
as on a phone.

The terminal is a device form of its own, as a phone and a desktop are: `idiom()` is `Idiom::Terminal`
(`nsh_core::platform::Idiom`; `platform.idiom` is `"terminal"` in TSX), and `os()` (`platform.os`) is the machine's own system, macOS, Windows or
Linux, so `fs/promises` and `process` work as on that desktop. Desktop behavior applies: `desktop={{…}}` props,
`platform.select`'s `desktop` key, `platform.desktop`, keyboard shortcuts, hover, tooltips and context menus. The
application menu (`Menu.setApplicationMenu`) is a menu bar on the top row, as in mc and htop: F10 or a click on a title
opens its menu, and its items' shortcuts work with the bar closed.

## Running an app

```sh
nsh run App.tsx --target tui        # a TSX app
nsh run --target tui                # a Rust app, from its directory
```

The app fills the terminal it was started in, with hot updates on save; a Rust app's root runs in a terminal
development host built with its crate, rebuilt and restarted when its Rust code changes. In a checkout, `nsh run`
builds the development host (`nsh-tui-host`) first.

During startup, the CLI shows build progress, and the crate being compiled when a development host is built; `-v` streams the tools’ output.
Once the app opens, the terminal shows the app alone. Diagnostics (the CLI's output, the host's logs, `console.log`) go to the app's
`.nsh/tui.log`, and `C-h e` (Ctrl+H, then E) opens them in a panel over the app: the arrows and Page Up / Page Down
scroll it, `r` reloads the latest build, and Escape, `C-g` or `q` closes it. An error in the app opens the panel by
itself, and the next update closes it. Ctrl+C copies a text selection, and otherwise quits; the terminal is restored
as it was.

`--fps` shows a performance line in the top right corner (frame rate, frame times, the bytes and Cells each frame
writes); `C-h p` shows and hides it.

```sh
nsh run App.tsx --target tui --fps
nsh run App.tsx --target tui --points-per-cell 10x20
```

## Cells

The core lays the app out in points, as everywhere, and the terminal maps points to Cells: one Cell is **8 × 16
points** by default. Set another size in `nsh.json`, or for one run with `--points-per-cell`, which wins:

```json
{ "tui": { "pointsPerCell": "10x20" } }
```

In a terminal the core lays out with an algorithm made for the grid, the way terminal apps lay themselves out: every
frame is whole Cells, and spacing designed in points for a screen becomes the Cells a terminal can give it.

- **Spacing.** A gap in a row is one column, two from 24 points. In a column, gaps and margins of 16 points or more
  are one blank row. Horizontal padding is one Cell from 8 points and two from 24 points; vertical padding is a row
  from 24 points.
- **Borders.** A card (a container padded 12 points or more, or around two or more rows of content) keeps its border,
  one Cell on each side that has one, drawn in box-drawing lines: `─` and `│`, rounded corners `╭╮╰╯` where a radius
  is set, square ones `┌┐└┘` otherwise, dashed `╌╎` and dotted `┈┊`. A control (a button, a tab, a text field) is its
  label row.
- **Flex and grid.** `flexDirection`, `flexGrow`, `justifyContent`, `alignItems`, `flexWrap`, grid templates and spans
  divide whole Cells. When a row is short of room, gaps give first, then the texts wrap.
- **Text** is one row per line in the terminal's font at any font size, weight 600 and above bold, with italic,
  underline and strike-through kept. Wide characters (CJK, emoji) take two Cells and grapheme clusters stay whole.
  `numberOfLines` and ellipses work as elsewhere, the ellipsis taking one Cell.
- **Layouts** report points: frames, `onLayout`, hit testing, overlays and scroll offsets work as on other
  platforms.

## Keyboard

Every control is reachable from the keyboard. Tab and Shift+Tab visit pressable and editable views in document order,
as on the desktops; the arrows move to the nearest control in that direction, scrolling to reach it. A control
scrolled into view by the keyboard is centered in its scroll view. While a dialog or a sheet is open over its
backdrop, Tab stays in it, and closing it gives the focus back to the control it came from. Tab always moves to the
next control: in a `DataTable` it leaves the table, and the arrows move between its columns. A click gives the focus
to the control it is on, or the one around it, and Tab goes on from there.

| Keys | Do |
|---|---|
| Tab, Ctrl+N / Shift+Tab, Ctrl+P | The next / previous control, wrapping at the ends |
| Down / Up | The nearest control below / above, scrolling to reach it |
| Right, Ctrl+F / Left, Ctrl+B | The nearest control to the right / left on the same row |
| Enter, Space | Press the focused control |
| Escape, Ctrl+G | Leave the focused field; otherwise go back: the app's `onBackPress`, then the newest dialog or the navigation stack |
| Page Down, Ctrl+V / Page Up, Alt+V | Scroll the scroll view around the focused control by a page |
| Home, Alt+< / End, Alt+> | The first / last control of that scroll view |
| Ctrl+S / Ctrl+R | Search the text on screen forward / backward |
| Ctrl+C | Copy the selection (so do Ctrl+Shift+C, Cmd+C, Ctrl+Insert and Alt+W); with none, quit |
| Ctrl+A, Cmd+A | With text selected, select all the text of its selectable view |
| F10 | The application menu's bar: Left / Right between the titles, Down, Enter or a title's initial opens its menu, Escape closes it, then leaves the bar |

The app's own shortcuts ([`keymap`](../modules/nsh.md#keymap)) come first, and so do the keys a focused component
binds (a slider's arrows, a list's), so a component gets its keys before they move the focus. Terminals that speak
the kitty keyboard protocol report Ctrl+I, Ctrl+M and Ctrl+[ apart from Tab, Enter and Escape, key repeats and
releases, and Super as Cmd, so `cmd+` shortcuts work there; on macOS terminals without it, a Ctrl shortcut that no
binding takes is tried again as Cmd, and menus and hints (`keymap.label`, `Command`) show those shortcuts with
Ctrl, the key to press there (`⌃O` for `mod+o`).

**Search.** Ctrl+S and Ctrl+R search the text on screen as you type, as readline and Emacs do. The query shows on the
bottom row after `/` (forward) or `?` (backward), the match is highlighted and focus moves to the control it belongs
to. Ctrl+S / Ctrl+R go to the next / previous match, Backspace or Ctrl+H takes back the last key, Enter ends the
search there, and Escape or Ctrl+G puts focus and scrolling back as they were.

**Text fields** take readline's keys as well as the desktop's:

| Keys in a field | Do |
|---|---|
| Ctrl+A / Ctrl+E, Home / End | Start / end of the line |
| Ctrl+Home / Ctrl+End, Alt+< / Alt+> | Start / end of the text |
| Ctrl+F / Ctrl+B, Alt+F / Alt+B | A character, a word forward / back |
| Ctrl+Right / Ctrl+Left, Alt+Right / Alt+Left | A word forward / back, as on the desktops |
| Ctrl+N / Ctrl+P, Down / Up | The next / previous line of a multiline field |
| Ctrl+K / Ctrl+U, Ctrl+W, Alt+Backspace, Alt+D | Kill to the end / start of the line, a word back, a word forward |
| Ctrl+Y | Insert the last killed text |
| Ctrl+T | Swap the characters beside the caret |
| Ctrl+D, Delete / Ctrl+H, Backspace | Delete forward / back |
| Ctrl+Delete / Ctrl+Backspace | Delete a word forward / back |
| Shift with the movement keys | Extend the selection |
| Ctrl+Shift+A, Cmd+A | Select all |
| Ctrl+Z / Ctrl+Shift+Z, Cmd+Z / Cmd+Shift+Z | Undo / redo |
| Ctrl+Shift+C, Cmd+C, Ctrl+Insert, Alt+W | Copy |
| Ctrl+Shift+X, Cmd+X, Shift+Delete | Cut |
| Ctrl+V, Ctrl+Shift+V, Cmd+V, Shift+Insert | Paste |
| Enter | What `submitBehavior` says: submit, submit and leave, or a new line |
| Shift+Enter, Alt+Enter | A new line in a multiline field that submits on Enter |
| Escape, Ctrl+G | Leave the field |

While a field is edited, the terminal's cursor is a bar at the caret. Input methods compose in the terminal
emulator, and the committed text enters the field; a paste is one insertion. Copied text goes to the system clipboard
through the terminal (OSC 52, over SSH too, where the terminal allows it).

## Mouse

The terminal reports the mouse at Cell precision, and NSH turns each Cell into the point at its middle.

- **Clicks** press what is under the pointer; double and triple clicks select a word and a line in fields and
  selectable text, and a drag after them extends by words or lines. A right click opens the context menu
  (`onContextMenu`) of the nearest view that listens for one.
- **The wheel** scrolls the scroll view under the pointer by three rows (six columns sideways; Shift turns a vertical
  wheel sideways), and leaves the keyboard focus where it is.
- **Hover** tracks the pointer Cell by Cell: the view under it and its ancestors take `hover:` styles and
  `onMouseEnter` / `onMouseMove` / `onMouseLeave`, a hovered control stands on a lighter band, and tooltips and hover
  cards open on the views under it. Leaving the terminal, or the terminal losing focus, clears hover.
- **Dragging** follows the pointer Cell by Cell:
  - a `Slider` (and a `ColorSlider` or `ColorArea`): a press on the track moves the nearest thumb there, and a drag
    moves it with the pointer; a range slider's thumbs stay within each other;
  - a scroll bar: a press on the track jumps the thumb there, and a held thumb follows the pointer;
  - the handle lines of a `ResizablePanelGroup` or `DockArea` resize their panes, and a `DockArea` tab dragged over a
    group outlines where it lands;
  - text in selectable views and fields is selected; Shift+click extends the selection, and Ctrl+C, Ctrl+Shift+C or
    Cmd+C copies it; a selection held past the edge of its scroll view (or on the terminal's own edge row) scrolls it
    row by row, faster the farther past the pointer is;
  - content that nothing else claims scrolls with the drag, and the app's gestures (`panActivation`, the responder
    system) get every move; a drag keeps its target while the pointer is outside the app.

  A drag never presses what it started on.

## Colors and themes

The app is drawn in the terminal's own theme. When it starts, the host asks the terminal for its default foreground
and background, and the app's light or dark mode follows the background (dark when the terminal does not say). The
color depth comes from the environment: `COLORTERM=truecolor` (or a terminal known for 24-bit color) is true color, a
`TERM` with `256color` is 256 colors, and anything else is the 16 standard colors. `NO_COLOR` draws without colors:
states are shown with reverse video, underlines, bold and strike-through. `NSH_TUI_COLORS=truecolor`, `256`, `16`
or `mono` sets it.

The app's colors are read as meanings, so an app designed for screens reads well on any terminal theme:

- a saturated color (a primary button, an error, a link) is the terminal's accent of its hue: red, yellow, green,
  cyan, blue or magenta;
- a neutral color is the terminal's foreground, and a low-contrast one (secondary text, placeholders, separators) a
  fade of it;
- canvases, color swatches and syntax highlighting keep their own colors, at the terminal's color depth.

With 256 colors or more and a known background, fills are **surfaces**: steps of the terminal's own background mixed
toward its foreground, so a card, a sidebar or a selected row stands on a band a shade lighter or darker than what is
around it, and the page itself is the terminal's background, transparency included. On a 16-color terminal the same
app, laid out the same, is drawn in lines, bold, dim and reverse video, and its small fills in the standard colors:
a chip or a tag on the dark gray, a primary button in its color; panels and cards are set apart by their space.

The terminal shows state in its own way: a selected row and a focused control are a highlighted band and bold, a
hovered control a lighter band, a disabled one faint; the selected row of the pane that has the focus is in the
accent. The app's focus styles still apply on top.

## Components and popups

`nsh/base`'s controls take the terminal's own forms, one row each, with the app's labels, values and events:

| Component | In the terminal |
|---|---|
| `Checkbox` | `[✓]`, `[ ]` or `[–]`, then its label |
| `Radio` | `(●)` or `( )`, then its label |
| `Switch` | `[✓]` on, `[ ]` off, as a checkbox |
| `Slider` | a row of `─`, filled with `━` up to the value, a `●` per thumb |
| `Progress` | a heavy line `━` in the indicator's color, then a light `─` in the line color |
| `Select`, `Combobox`, `DatePicker` | the value (a `Select`'s `placeholder` while none is chosen, or the app's `trigger`) with `▾` near the right end of its band, a blank Cell after it as before the text, and `×` before it while there is a value to clear, muted, in the accent while focused or open; the list opens under it. An app's own `trigger` leaves the band's last three Cells free for them (six with `×`) |
| `Tabs` | the tabs in a row, the selected one bold |
| `Calendar`, `DatePicker` | `cal`'s month: the days' numbers right-aligned in columns, today bold, the selected days banded; the months and the years to pick centered in the month's width |
| `OtpInput` | the cells in a row, the terminal's cursor in the middle of the cell that takes the next digit; an empty cell shows `·`, muted, a masked digit `●`; a cell with a border and no fill is a framed box (`┌───┐`), its digit in the middle, the next cell's line in the accent |
| `Pagination` | Previous, the pages, `…` and Next as words in a row, the current page banded |
| `MenuItem`, `Submenu` | the title from the row's start; `✓` at the row's end on a checked item (`●` on a radio item), ` ›` on a submenu's trigger |
| `Select`, `Combobox` lists | each title from the row's start, `✓` at the end of the chosen row |
| `Accordion`, `Collapsible`, `Tree` | `▸` closed, `▾` open |
| `Scrollbar` | the terminal's own scroll bar |
| `TextView` | a terminal reader's document: blocks a blank row apart, headings without `#` in bold (h1 ruled), quotes behind `▎`, code in a band under its language, alerts as one tinted band with their icon, tables in box lines fitted to the view, tasks `☐` / `☑` |

**Popups** (popovers, menus, a select's list, a command palette) open beside their anchor, framed by a
rounded line, with the label of their first surface as a title in the top border (`╭─ Title ─`). With surfaces they
stand raised on a band and cast a one-Cell shadow; the item under the keyboard or the pointer is a full-row band in
the accent. **Dialogs** center a framed box and fade what is behind them; focus stays inside the newest one, Escape
asks it to close, and closing it gives the focus back to the control that opened it. `AlertDialog` is drawn
the same way, its buttons `Cancel  OK` in a row (`< Cancel >  < OK >` on 16 colors).

**Toasts** show on the status line, the screen's bottom row, one at a time: the newest toast's content in a row, and a
new toast takes the line from the last. Nothing stacks or animates; Escape closes the toast there, as its own buttons
and its timeout do. A tooltip shares the line and shows there while no toast does.

**Scroll views** that overflow show a one-Cell scroll bar, `│` with a `┃` thumb, on their inner edge, or on the line of
the pane they fill. **Canvases** draw in braille dots, two across and four down per Cell, with text on whole Cells;
chart demos and drawings keep their shapes. An **icon button** (a button whose content is an icon) shows its
accessibility label as its text, and a popup's trigger shows `▾`.

**Marks you press** (a trigger's `▾`, a clear `×`, a stepper's `−` / `+`) each take a slot of three Cells with the
mark in the middle, ` ▾ `, and a press anywhere in the slot counts. Slots sit side by side (` ×  ▾ `), so the mark at a
band's end has a blank Cell after it. The mark is muted and turns the accent while its control is focused or open,
while it is pressed and while the pointer is over its slot. For a mark of your own, make a pressable `View`
three Cells wide and one Cell high (24 × 16 points at the default size) with the glyph centered. With `controlsRight`,
`NumberInput` sets its steppers side by side in a terminal, the decrement first (` −  + `).

**Media elements keep their space in the layout.** An `Image`, `Video`, `WebView` or shader view larger than an icon
keeps its box, so the text and controls around it stay where the design puts them; the terminal shows text and
lines, so the box is blank Cells. Images, videos, web views, shaders and canvases of icon size (48 × 48 points or
smaller) give their room to the content around them. With surfaces, a view in the image role whose background is a color (a color
swatch) shows that color.

## Laying out for the terminal

Most apps need no change: desktop behavior applies, and the layout rules above fit a desktop design to the grid.
Where the terminal should get a layout of its own, the idiom says so:

```rust tabs
use nsh_core::{platform::Idiom, prelude::*};

#[component]
pub fn Shell() -> impl IntoElement {
    // The terminal gets one compact column; windows get a sidebar.
    view()
        .flex_1()
        .child(if idiom() == Idiom::Terminal { compact_layout() } else { sidebar_layout() })
}

fn compact_layout() -> AnyElement {
    view().flex_1().flex_col().into_element()
}

fn sidebar_layout() -> AnyElement {
    view().flex_1().flex_row().into_element()
}
```

```tsx tabs
import { View, platform } from "nsh";

export function Shell() {
  // The terminal gets one compact column; windows get a sidebar.
  return (
    <View class="flex-1">
      {platform.idiom === "terminal" ? <CompactLayout /> : <SidebarLayout />}
    </View>
  );
}

function CompactLayout() {
  return <View class="flex-1 flex-col" />;
}

function SidebarLayout() {
  return <View class="flex-1 flex-row" />;
}
```

`platform.desktop` is `true` in a terminal, and `platform.idiom === "desktop"` matches windows and desktop browsers,
so code that asks for a pointer and a wide window with the idiom keeps the terminal on its own branch. Window chrome
an app draws itself for `nsh/desktop` (a title bar of its own) is the app's content in a terminal; leave it out for
`platform.idiom === "terminal"`. The environment reports reduced motion: navigation and layout transitions take their
final state at once, and the app's own animations run as written. The safe area and the keyboard height are 0.

## Testing

```sh
nsh test --target tui
```

runs the app's tests through the terminal development host, on an in-memory terminal, so it needs no terminal of its
own and runs in CI. The steps press, type and scroll with the terminal's input; `open(entry, { width, height })` sets
the viewport in points (390 × 844 by default), rounded up to whole Cells. `app.screenshot("cells.json")` returns the
screen as UTF-8 JSON, one entry per Cell with its symbol, colors and modifiers, so a test can compare renders exactly
([Testing](./testing-and-trace.md#on-a-real-platform)).

## Running a bundle

The development host also runs a built bundle on its own, or connects to a development server you start yourself:

```sh
nsh build my-app --out build
nsh-tui-host --bundle build/bundle.js                       # in a checkout: target/debug/nsh-tui-host
nsh-tui-host --dev-server ws://127.0.0.1:8790/ws
```

| Option | Does |
|---|---|
| `--points-per-cell <WIDTHxHEIGHT>` | The size of one Cell in points (`8x16` by default) |
| `--no-mouse` | Leaves the mouse to the terminal emulator and its own text selection; the keyboard works as above |
| `--fps` | Shows the performance line (`C-h p` toggles it) |
| `--log-file <PATH>` | Where diagnostics go (by default a file in the system's temporary directory, shown by `C-h e`) |
| `--data-dir <PATH>` | Where the app keeps its data |
| `--trace` | Adds the engine's timings to the log |

The bundle's assets are read from the `assets/` directory next to it.

## Embedding in a terminal app

The `nsh-platform-tui` crate gives a Rust [ratatui](https://ratatui.rs) app `AppView`: one NSH engine drawn into any
area of the app's own frame. The app keeps its terminal, its event loop and its layout; each `AppView` is
independent, and several can share a screen.

```rust
use nsh_platform_tui::{AppOptions, AppView, Input, Root};

let mut options = AppOptions::default();
options.ui_sets = vec![nsh_base::registry(), my_app::registry()];
let mut view = AppView::new(options);
view.load(Root::of::<my_app::App>())?;

// In the app's draw: the view takes the area it is given.
terminal.draw(|frame| view.render(frame, frame.area()))?;

// In the app's event loop: keys, pastes and mouse events, at absolute Cells.
view.handle(input);

// Draw again when the view asks: `next_frame_deadline()` is when its next frame is due.
let due = view.next_frame_deadline();
```

`load` also takes a `Bundle` (`Bundle::read(path)`, a TSX app that `nsh build` wrote). `AppView::set_wake_callback`
tells the app's loop that the view has a frame to draw, from the engine's thread; `set_focused` gives or takes the
keyboard focus; `set_appearance` sets light or dark mode; `register_component` adds the app's own native components,
drawn into their Cells. `AppOptions` sets the Cell size (`cells`), the terminal's colors and depth (`capabilities`),
the limits, storage, assets and clipboard. With feature `run-app`, `run_app(&mut terminal, &mut view, poll)` is a
ready loop for an app that gives the whole terminal to one view, as the development host does.

## See also

- [CLI](./cli.md): `nsh run --target tui`, `nsh test --target tui`
- [Platform-specific code](./platform-specific.md)
- [Device and environment](./device-and-environment.md)
