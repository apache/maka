//! `Terminal`: shows a terminal program's output and sends what the user
//! types back to it.
//!
//! The view draws an emulator's lines with the platform's own text engine
//! (rows of text in a virtualized list, the theme's monospaced font), so it
//! works wherever NSH runs: the desktops, iOS, Android, the web and the
//! terminal backend. It runs no program itself: the app connects it to
//! one (a pseudo-terminal, a WebSocket, an SSH channel) with `write` and
//! `onData`.
//!
//! The emulator is NSH's own ([`VtEmulator`], on `vte`) unless a Rust app
//! gives the terminals below a [`TerminalEmulatorFactory`] with
//! `provide_context`, to use libghostty, `alacritty_terminal` or any other
//! through [`TerminalEmulator`]; NSH builds none of them. An app that wants
//! another program's whole view (its own renderer) registers it as a
//! native component instead (`docs/dev/embedding.md`).

mod emulator;
mod keys;
mod vt;

use std::{cell::RefCell, rc::Rc};

use nsh_core::{
    element::{Style, measure_text},
    prelude::*,
};

pub use self::{
    emulator::{
        TerminalColor, TerminalCursor, TerminalEmulator, TerminalEmulatorEvent,
        TerminalEmulatorFactory, TerminalLine, TerminalModes, TerminalRun, TerminalSize,
        TerminalStyle,
    },
    vt::VtEmulator,
};
use crate::{input, theme};

/// The props of [`Terminal`].
#[derive(Clone, Copy, PartialEq, Props)]
pub struct TerminalProps {
    /// How many lines scrolled off the top are kept (default 1000).
    #[prop(default = 1000)]
    pub scrollback: Prop<u32>,
    /// The font family (default the theme's `font-mono`, else the
    /// system's monospaced font).
    pub font_family: Prop<Option<SharedString>>,
    /// The font size, in points (default 13).
    #[prop(default = Points(13.0))]
    pub font_size: Prop<Points>,
    /// The height of a row, in points (default 18).
    #[prop(default = Points(18.0))]
    pub line_height: Prop<Points>,
    /// What screen readers say the terminal is.
    pub accessibility_label: Prop<Option<SharedString>>,
    /// The Tailwind classes of the cursor, a box one cell wide over the
    /// cell it is at (its color, shape: `bg-foreground/60`, `w-0.5`).
    pub cursor_class: Prop<Option<SharedString>>,
    /// The style of the cursor, over `cursorClass`.
    #[prop(default)]
    pub cursor_style: Prop<Style>,
}

/// The events of a [`Terminal`].
#[derive(Debug, Clone, PartialEq, Event)]
pub enum TerminalEvent {
    /// Bytes for the program, as text: what the user typed or pasted, and
    /// the emulator's answers to the program's queries.
    #[args(data)]
    Data(SharedString),
    /// The terminal's size in cells changed (first once it is laid out):
    /// tell the program (a pseudo-terminal's window size).
    #[args(cols, rows)]
    Resize(u32, u32),
    /// The program set the title.
    #[args(title)]
    TitleChange(SharedString),
    /// The program rang the bell.
    Bell,
}

/// The methods of a [`Terminal`]'s ref.
pub struct TerminalApi {
    term: Term,
}

#[methods]
impl TerminalApi {
    /// Shows `data`, the program's output.
    pub fn write(&self, data: String) {
        self.term.write(data.as_bytes());
    }

    /// Clears the screen and the scrollback, as a reset (`ESC c`) does.
    pub fn reset(&self) {
        self.term.write(b"\x1bc");
    }

    /// The text of every line, scrollback and screen, one per line.
    pub fn text(&self) -> String {
        let emu = self.term.emu.borrow();
        (0..emu.line_count())
            .map(|i| emu.line(i).text().trim_end().to_owned())
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// Takes the keyboard focus (showing the software keyboard).
    pub fn focus(&self) {
        self.term.sink.focus();
    }
}

#[derive(Clone)]
struct Term {
    emu: Rc<RefCell<Box<dyn TerminalEmulator>>>,
    size: Rc<RefCell<TerminalSize>>,
    rev: Signal<u64>,
    cx: Scope<TerminalEvent>,
    sink: ElementRef,
    focused: Signal<bool>,
    /// What the hidden input holds: its value, and the text it held when
    /// it was emptied, until the platform reports the empty value.
    sink_value: Signal<String>,
    held: Rc<RefCell<(String, Option<String>)>>,
}

impl Term {
    fn write(&self, bytes: &[u8]) {
        let events = {
            let mut emu = self.emu.borrow_mut();
            emu.feed(bytes);
            emu.take_events()
        };
        self.rev.update(|r| *r += 1);
        for event in events {
            match event {
                TerminalEmulatorEvent::Title(t) => {
                    self.cx.emit(TerminalEvent::TitleChange(t.into()))
                }
                TerminalEmulatorEvent::Bell => self.cx.emit(TerminalEvent::Bell),
                TerminalEmulatorEvent::Reply(bytes) => self.send(&String::from_utf8_lossy(&bytes)),
            }
        }
    }

    fn send(&self, data: &str) {
        if !data.is_empty() {
            self.cx.emit(TerminalEvent::Data(data.to_owned().into()));
        }
    }

    fn resize(&self, size: TerminalSize) {
        if *self.size.borrow() == size {
            return;
        }
        *self.size.borrow_mut() = size;
        self.emu.borrow_mut().resize(size);
        self.rev.update(|r| *r += 1);
        self.cx
            .emit(TerminalEvent::Resize(size.cols as u32, size.rows as u32));
    }

    /// The hidden input's text changed: sends what was typed.
    fn sink_changed(&self, text: &str) {
        let typed = {
            let mut held = self.held.borrow_mut();
            let base = match held.1.take() {
                // The platform reports the text it held with what was typed
                // before the empty value reached it.
                Some(old) if text != old && text.starts_with(old.as_str()) => old,
                Some(_) => String::new(),
                None => std::mem::take(&mut held.0),
            };
            let typed = text.strip_prefix(base.as_str()).unwrap_or(text).to_owned();
            if !text.is_empty() {
                held.1 = Some(text.to_owned());
            }
            typed
        };
        self.send(&typed);
        if !text.is_empty() {
            self.sink_value.set(String::new());
        }
    }

    fn paste(&self, text: &str) {
        let text = text.replace("\r\n", "\r").replace('\n', "\r");
        match self.emu.borrow().modes().bracketed_paste {
            true => self.send(&format!("\x1b[200~{text}\x1b[201~")),
            false => self.send(&text),
        }
    }

    fn bind_keys(&self) {
        let term = self.clone();
        effect(move || {
            if !term.focused.get() {
                return;
            }
            for (keys, bytes) in keys::bindings(apple_keys()) {
                let term = term.clone();
                on_key_with(
                    keys,
                    KeyOptions {
                        when: nsh_core::keymap::When::Always,
                        repeat: true,
                        ..Default::default()
                    },
                    move |_| {
                        let modes = term.emu.borrow().modes();
                        term.send(&bytes.encode(modes));
                    },
                );
            }
        });
    }
}

/// The CSS `font` shorthand `measure_text` takes.
fn font_css(family: &str, size: Points) -> String {
    match family {
        "monospace" | "ui-monospace" => format!("{}px {family}", size.0),
        _ => format!("{}px \"{}\"", size.0, family.replace('"', "")),
    }
}

fn font_family(family: Option<SharedString>) -> SharedString {
    family
        .or_else(|| theme().font_mono.clone())
        .unwrap_or_else(|| "monospace".into())
}

/// A terminal: a program's output drawn with the platform's text engine,
/// the user's keys sent back to it. It owns the emulation, the scrollback
/// (scrolled like a list, following the end while the user is there), the
/// keyboard (text, arrows and control keys as the program expects them,
/// bracketed pastes) and its size in cells, and leaves the rest to the app:
/// the program and how bytes reach it, its background, padding and cursor
/// look. Colors are those the program asks for: the 16 ANSI colors in a
/// fixed palette (VS Code's terminal's), 256 and 24-bit colors as given; the default
/// foreground is the theme's `foreground`, the default background the
/// view's own.
///
/// Rust apps replace the emulator with [`TerminalEmulatorFactory`].
#[component(methods = TerminalApi)]
pub fn Terminal(props: TerminalProps, cx: Scope<TerminalEvent>) -> impl IntoElement {
    let size = TerminalSize::default();
    let scrollback = props.scrollback.get_untracked() as usize;
    let emu = match use_context::<TerminalEmulatorFactory>() {
        Some(factory) => factory.make(size, scrollback),
        None => Box::new(VtEmulator::new(size, scrollback)),
    };
    let term = Term {
        emu: Rc::new(RefCell::new(emu)),
        size: Rc::new(RefCell::new(size)),
        rev: signal(0),
        cx,
        sink: element_ref(),
        focused: signal(false),
        sink_value: signal(String::new()),
        held: Rc::default(),
    };
    cx.methods(TerminalApi { term: term.clone() });
    term.bind_keys();

    let family = move || font_family(props.font_family.get());
    let cell_width = computed(move || {
        let css = font_css(&family(), props.font_size.get());
        measure_text(&css, "0000000000") / 10.0
    });
    let lh = move || props.line_height.get();

    let count = {
        let term = term.clone();
        move || {
            term.rev.get();
            term.emu.borrow().line_count()
        }
    };
    let row_term = term.clone();
    let rows = virtual_list(count, move |at| {
        row(row_term.clone(), props, cell_width, at)
    })
    .alignment(ListAlignment::Bottom)
    .estimated_item_size(props.line_height.get_untracked());

    let (layout_term, press_term) = (term.clone(), term.clone());
    view()
        .overflow_hidden()
        .font_family(family)
        .text_size(move || Length::from(props.font_size.get()))
        .text_color(move || theme().foreground)
        .on_press(move |_: &PressEvent| press_term.sink.focus())
        // The cells fill the box inside the app's padding.
        .child(
            // One selectable area: a drag selects across the lines.
            rows.selectable(true)
                .flex_1()
                .min_h(px(0.0))
                .on_layout(move |b: &Bounds<Points>| {
                    let (cw, lh) = (
                        cell_width.get_untracked(),
                        props.line_height.get_untracked(),
                    );
                    if cw.0 <= 0.0 || lh.0 <= 0.0 {
                        return;
                    }
                    let cols = (b.size.width.0 / cw.0).floor().clamp(1.0, u16::MAX as f32) as u16;
                    let rows = (b.size.height.0 / lh.0).floor().clamp(1.0, u16::MAX as f32) as u16;
                    layout_term.resize(TerminalSize::new(cols, rows));
                }),
        )
        .child(sink(term, props, lh))
}

/// Line `at`: its runs, and the cursor when it is on it.
fn row(
    term: Term,
    props: TerminalProps,
    cell_width: Memo<Points>,
    at: Position,
) -> impl IntoElement {
    let line = {
        let term = term.clone();
        computed(move || {
            term.rev.get();
            term.emu.borrow().line(at.index())
        })
    };
    let cursor = computed(move || {
        term.rev.get();
        let emu = term.emu.borrow();
        let first_screen = emu.line_count() - term.size.borrow().rows as usize;
        let cursor = emu.cursor()?;
        (at.index() == first_screen + cursor.row as usize).then_some(cursor.col)
    });
    let backgrounds = line;
    view()
        .h(move || Length::from(props.line_height.get()))
        .justify_center()
        // The cells' backgrounds fill the whole row, as a terminal's do
        // (a span's background would only cover the glyphs' ink).
        .child(dynamic(move || {
            let cw = cell_width.get();
            let mut col = 0usize;
            let mut boxes = Vec::new();
            for run in backgrounds.get().runs {
                let cols = text_width(&run.text);
                if let (_, Some(bg)) = colors(run.style) {
                    boxes.push(
                        view()
                            .absolute()
                            .top_0()
                            .bottom_0()
                            .left(Length::from(cw * col as f32))
                            .w(Length::from(cw * cols as f32))
                            .bg(bg)
                            .into_element(),
                    );
                }
                col += cols;
            }
            view()
                .absolute()
                .top_0()
                .bottom_0()
                .left_0()
                .right_0()
                .pointer_events(PointerEvents::None)
                .children(boxes)
        }))
        .child(dynamic(move || {
            text("").select_text().children(
                line.get()
                    .runs
                    .into_iter()
                    .map(run_view)
                    .collect::<Vec<_>>(),
            )
        }))
        .child(when(
            move || cursor.get().is_some(),
            move || {
                view()
                    .absolute()
                    .top_0()
                    .bottom_0()
                    .left(move || Length::from(cell_width.get() * cursor.get().unwrap_or(0) as f32))
                    .w(move || Length::from(cell_width.get()))
                    .pointer_events(PointerEvents::None)
                    .app_class(props.cursor_class)
                    .inline_style(props.cursor_style)
            },
        ))
}

/// How many cells `text` takes (a wide character two).
fn text_width(text: &str) -> usize {
    use unicode_width::UnicodeWidthChar;
    text.chars().map(|c| c.width().unwrap_or(0)).sum()
}

/// A run's text and cell colors, `None` the defaults, swapped when it is
/// inverse (the defaults then the theme's, in either appearance).
fn colors(s: TerminalStyle) -> (Option<AdaptiveColor>, Option<AdaptiveColor>) {
    let (fg, bg) = (
        s.fg.map(|c| AdaptiveColor::from(color(c))),
        s.bg.map(|c| AdaptiveColor::from(color(c))),
    );
    if !s.inverse {
        return (fg, bg);
    }
    let theme = theme();
    (
        Some(bg.unwrap_or(theme.background)),
        Some(fg.unwrap_or(theme.foreground)),
    )
}

fn run_view(run: TerminalRun) -> AnyElement {
    let s = run.style;
    let mut el = text(run.text);
    if let (Some(fg), _) = colors(s) {
        el = el.text_color(fg);
    }
    if s.bold {
        el = el.font_weight(FontWeight::BOLD);
    }
    if s.italic {
        el = el.italic();
    }
    if s.underline {
        el = el.underline();
    }
    if s.strikethrough {
        el = el.line_through();
    }
    if s.dim || s.hidden {
        el = el.opacity(if s.hidden { 0.0 } else { 0.6 });
    }
    el.into_element()
}

/// The 16 ANSI colors: VS Code's terminal palette, readable on light and
/// dark backgrounds alike.
const ANSI: [u32; 16] = [
    0x000000, 0xcd3131, 0x0dbc79, 0xe5e510, 0x2472c8, 0xbc3fbc, 0x11a8cd, 0xe5e5e5, 0x666666,
    0xf14c4c, 0x23d18b, 0xf5f543, 0x3b8eea, 0xd670d6, 0x29b8db, 0xffffff,
];

fn color(c: TerminalColor) -> Hsla {
    let hex = match c {
        TerminalColor::Rgb(r, g, b) => (r as u32) << 16 | (g as u32) << 8 | b as u32,
        TerminalColor::Indexed(n) => indexed(n),
    };
    nsh_core::color::rgb(hex).into()
}

/// The 256-color palette: 16 ANSI, a 6×6×6 cube, 24 grays.
fn indexed(n: u8) -> u32 {
    match n {
        0..=15 => ANSI[n as usize],
        16..=231 => {
            let n = n - 16;
            let level = |v: u8| if v == 0 { 0 } else { 55 + v as u32 * 40 };
            level(n / 36) << 16 | level(n / 6 % 6) << 8 | level(n % 6)
        }
        _ => {
            let v = 8 + (n - 232) as u32 * 10;
            v << 16 | v << 8 | v
        }
    }
}

/// The input that takes the keyboard: text and pastes (the keys with no
/// text are bound while it has the focus, [`Term::bind_keys`]).
fn sink(term: Term, props: TerminalProps, lh: impl Fn() -> Points + 'static) -> impl IntoElement {
    let (change, paste, focus, blur) = (term.clone(), term.clone(), term.clone(), term.clone());
    let value = term.sink_value;
    input()
        .element_ref(&term.sink)
        .absolute()
        .left_0()
        .bottom_0()
        .w(px(1.0))
        .h(move || Length::from(lh()))
        .pointer_events(PointerEvents::None)
        .p_0()
        .border(px(0.0))
        .bg(AdaptiveColor::TRANSPARENT)
        .text_color(AdaptiveColor::TRANSPARENT)
        .opacity(0.02)
        .caret(false)
        .auto_correct(false)
        .auto_capitalize(AutoCapitalize::None)
        .paste_behavior(PasteBehavior::Report)
        .value(move || value.get())
        .label(move || props.accessibility_label.get().unwrap_or_default())
        .on_change(move |text: &str| change.sink_changed(text))
        .on_paste(move |p: &PasteEvent| paste.paste(&p.text))
        .on_focus(move || focus.focused.set(true))
        .on_blur(move || blur.focused.set(false))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn palette() {
        assert_eq!(indexed(1), 0xcd3131);
        assert_eq!(indexed(16), 0);
        assert_eq!(indexed(231), 0xffffff);
        assert_eq!(indexed(232), 0x080808);
    }
}
