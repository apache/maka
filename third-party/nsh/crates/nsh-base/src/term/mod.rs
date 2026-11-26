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

use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    rc::Rc,
    time::Duration,
};

use nsh_core::{
    element::{Style, measure_text},
    prelude::*,
    time::{Instant, now},
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

impl TerminalApi {
    /// Feeds raw program output bytes directly to the emulator without
    /// requiring each chunk to be valid UTF-8 (for example, PTY or SSH
    /// reads split mid-character or mid-escape sequence).
    pub fn write_bytes(&self, data: &[u8]) {
        self.term.write(data);
    }
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
    /// The size in cells the emulator has, `None` before the first layout.
    size: Rc<Cell<Option<TerminalSize>>>,
    /// The size the latest layout gave while it waits to be applied, and
    /// when: a drag of the box's edge lays it out every frame.
    pending: Rc<Cell<Option<(TerminalSize, Instant)>>>,
    rev: Signal<u64>,
    cx: Scope<TerminalEvent>,
    sink: ElementRef,
    focused: Signal<bool>,
    /// What an input method is composing in the hidden input (empty
    /// before it shows any text), `None` when nothing is: drawn at the
    /// cursor, which is hidden while it lasts.
    composition: Signal<Option<String>>,
    /// Where the rows are in the terminal and how big, as last laid out:
    /// the hidden input goes on the cursor's cell.
    rows_frame: Signal<Bounds<Points>>,
    /// What of the hidden input's text was sent.
    sink_text: Rc<RefCell<SinkText>>,
}

/// What the hidden input's text held and what of it the program has, so
/// each change sends only what is new, and an input method's composition
/// only what it commits, once.
///
/// The platforms agree on the order of a composition's events, not on its
/// text: a composition that starts or changes is reported before the
/// change of the text holding it, and one that ends after the change of
/// the text it committed. iOS, Android, the web and, for some edits,
/// AppKit keep the composed text in the field's text; Windows, GPUI and
/// GTK report only committed text, sometimes a part while the rest goes on
/// composing. A composition carries no range of the field's text, so what
/// of a change is composed cannot be told apart from what is committed:
/// while a composition lasts nothing is sent, only the latest text is
/// kept, and its end sends what that text has that the program does not
/// (the commit, parts committed during it included; nothing when it was
/// cancelled).
#[derive(Debug, Default)]
struct SinkText {
    /// The input's text up to what the program has.
    sent: String,
    /// An input method composes.
    composing: bool,
    /// The input's text last reported while it composes, until its end.
    pending: Option<String>,
}

impl SinkText {
    /// The input reported its text `text`: what to send of it.
    fn changed(&mut self, text: &str) -> String {
        if self.composing {
            self.pending = Some(text.to_owned());
            return String::new();
        }
        self.commit(text)
    }

    /// An input method's composition started or changed (`composing`), or
    /// ended: what to send, what the end committed.
    fn composed(&mut self, composing: bool) -> String {
        self.composing = composing;
        if composing {
            return String::new();
        }
        match self.pending.take() {
            Some(text) => self.commit(&text),
            None => String::new(),
        }
    }

    /// The input's committed text is `text`: what the program does not
    /// have yet. The input is never emptied (setting its text would end a
    /// composition), so its text grows as the user types (the keys that
    /// delete are bound and send their bytes); a text that does not start
    /// with what was sent (a character deleted natively, the platform's
    /// own reset) sends what follows the part they share.
    fn commit(&mut self, text: &str) -> String {
        let shared: usize = self
            .sent
            .chars()
            .zip(text.chars())
            .take_while(|(a, b)| a == b)
            .map(|(a, _)| a.len_utf8())
            .sum();
        let typed = text[shared..].to_owned();
        text.clone_into(&mut self.sent);
        typed
    }
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

    /// A layout gave the cells `size`. The first one applies at once;
    /// later ones wait until the size has held [`RESIZE_SETTLE`], so a drag
    /// (a split's handle, a window's edge) neither re-wraps the emulator
    /// and redraws every row nor has the program redraw its screen at each
    /// column it crosses: the rows are clipped to the box meanwhile, as
    /// terminals do.
    fn resize(&self, size: TerminalSize) {
        if self.size.get().is_none() {
            return self.apply_size(size);
        }
        if self.size.get() == Some(size) {
            self.pending.set(None);
            return;
        }
        let at = now() + RESIZE_SETTLE;
        if self.pending.replace(Some((size, at))).is_none() {
            self.resize_after(RESIZE_SETTLE);
        }
    }

    /// Applies the pending size once it has held, waiting again while it
    /// changed.
    fn resize_after(&self, delay: Duration) {
        let term = self.clone();
        set_timeout(delay, move || {
            let Some((size, at)) = term.pending.get() else {
                return;
            };
            let left = at.saturating_duration_since(now());
            if left.is_zero() {
                term.pending.set(None);
                term.apply_size(size);
            } else {
                term.resize_after(left);
            }
        });
    }

    fn apply_size(&self, size: TerminalSize) {
        // The first layout reports its size even when it is the one the
        // emulator starts at.
        if self.size.get() == Some(size) {
            return;
        }
        self.size.set(Some(size));
        self.emu.borrow_mut().resize(size);
        self.rev.update(|r| *r += 1);
        self.cx
            .emit(TerminalEvent::Resize(size.cols as u32, size.rows as u32));
    }

    /// The hidden input's text changed: sends what was typed, nothing while
    /// an input method composes ([`SinkText`]).
    fn sink_changed(&self, text: &str) {
        let typed = self.sink_text.borrow_mut().changed(text);
        self.send(&typed);
    }

    /// An input method's composition in the hidden input started, changed
    /// or ended: drawn at the cursor, hidden while it lasts; its end sends
    /// what it committed.
    fn sink_composed(&self, c: &Composition) {
        self.composition.set(c.composing.then(|| c.text.clone()));
        let typed = self.sink_text.borrow_mut().composed(c.composing);
        self.send(&typed);
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
            let sink = term.sink;
            for (keys, bytes) in keys::bindings(apple_keys()) {
                let term = term.clone();
                sink.on_key_with(
                    keys,
                    KeyOptions {
                        when: nsh_core::keymap::When::Always,
                        repeat: true,
                        for_focus: true,
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

/// How long a new size must hold before the terminal takes it.
const RESIZE_SETTLE: Duration = Duration::from_millis(80);

/// The CSS `font` shorthand `measure_text` takes.
fn font_css(family: &str, size: Points) -> String {
    let families = nsh_core::css_font_families(family);
    format!(
        "{}px {}",
        size.0,
        if families.is_empty() {
            "monospace"
        } else {
            &families
        }
    )
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
        size: Rc::new(Cell::new(None)),
        pending: Rc::new(Cell::new(None)),
        rev: signal(0),
        cx,
        sink: element_ref(),
        focused: signal(false),
        composition: signal(None),
        rows_frame: signal(Bounds::default()),
        sink_text: Rc::default(),
    };
    cx.methods(TerminalApi { term: term.clone() });
    term.bind_keys();

    let family = move || font_family(props.font_family.get());
    let font = computed(move || font_css(&family(), props.font_size.get()));
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
        row(row_term.clone(), props, font, cell_width, at)
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
        // A press focuses the sink: Tab goes to the sink, not to the box.
        .focusable(false)
        // The cells fill the box inside the app's padding.
        .child(
            // One selectable area: a drag selects across the lines.
            rows.selectable(true)
                .flex_1()
                .min_h(px(0.0))
                .on_layout(move |b: &Bounds<Points>| {
                    if layout_term.rows_frame.get_untracked() != *b {
                        layout_term.rows_frame.set(*b);
                    }
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
        .child(sink(term, props, cell_width, lh))
}

/// Line `at`: its runs, and the cursor when it is on it.
fn row(
    term: Term,
    props: TerminalProps,
    font: Memo<String>,
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
    // The column of the cursor, shown or hidden, when it is on this line:
    // where an input method's composition is drawn (nowhere, so not drawn,
    // while the emulator has fewer lines than the screen's rows).
    let caret = {
        let term = term.clone();
        computed(move || {
            term.rev.get();
            let emu = term.emu.borrow();
            let first_screen = emu
                .line_count()
                .checked_sub(term.size.get().unwrap_or_default().rows as usize)?;
            let at_cursor = emu.cursor_position();
            (at.index() == first_screen + at_cursor.row as usize).then_some(at_cursor.col)
        })
    };
    let composition = term.composition;
    // The composition on this line.
    let composing = computed(move || {
        caret.get()?;
        composition.get().filter(|text| !text.is_empty())
    });
    let cursor = computed(move || {
        // Hidden while an input method composes: a composition carries no
        // caret of its own, so no column would be where its caret is.
        if composition.with(Option::is_some) {
            return None;
        }
        term.rev.get();
        let emu = term.emu.borrow();
        let rows = term.size.get().unwrap_or_default().rows;
        let first_screen = emu.line_count().checked_sub(rows as usize)?;
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
        // The text, placed by cell as the backgrounds and the cursor are:
        // a font's own advances drift off the grid (a wide character's is
        // rarely two cells, and the text engine spaces CJK from Latin), so
        // the line is drawn as segments, each at its column. One selection
        // runs across them, and a copy gives the line whole.
        .child(dynamic(move || {
            let cw = cell_width.get().0;
            let font = font.get();
            let line = line.get();
            let parts = segments(&line, cw, |g| advance(&font, g));
            if parts.is_empty() {
                // An empty line keeps its empty text: a blank line stays in
                // a copy.
                return text("").select_text().into_element();
            }
            view()
                .absolute()
                .top_0()
                .bottom_0()
                .left_0()
                .right_0()
                .justify_center()
                .children(
                    parts
                        .into_iter()
                        .enumerate()
                        .map(|(i, part)| {
                            text("")
                                .select_text()
                                .when(i > 0, |t| t.continues_text(true))
                                .absolute()
                                .left(px(part.x))
                                .when(part.spacing != 0.0, |t| t.letter_spacing(px(part.spacing)))
                                .children(part.runs.into_iter().map(run_view).collect::<Vec<_>>())
                                .into_element()
                        })
                        .collect::<Vec<_>>(),
                )
                .into_element()
        }))
        // What an input method is composing, over the cells from the cursor
        // on, underlined as platforms mark it, on the theme's background.
        .child(when(
            move || composing.with(Option::is_some),
            move || {
                view()
                    .absolute()
                    .top_0()
                    .bottom_0()
                    .left(move || Length::from(cell_width.get() * caret.get().unwrap_or(0) as f32))
                    .justify_center()
                    .bg(move || theme().background)
                    .pointer_events(PointerEvents::None)
                    .child(
                        text(move || SharedString::from(composing.get().unwrap_or_default()))
                            .underline(),
                    )
            },
        ))
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

/// A piece of a line drawn as one text, at `x` in the row.
#[derive(Debug, PartialEq)]
struct Segment {
    /// Where it starts, in points from the row's start.
    x: f32,
    /// Letter spacing that makes each of its characters as wide as its
    /// cells (wide characters), else none.
    spacing: f32,
    /// Its runs, in the line's styles.
    runs: Vec<TerminalRun>,
}

/// `line` as segments placed by cell, `cell` points wide. A cell's text
/// is a character with a width and the zero-width ones after it (as
/// [`text_width`] counts the line's columns): the cells one wide go in one
/// segment from where they start (in whatever styles), and each stretch of
/// wide cells of one advance (as `advance` measures a cell's text) in a
/// segment of its own, letter-spaced to two cells a character and centered
/// in them. A cell ending in a zero-width joiner ends its segment, so
/// characters the font would join into one glyph keep the cells the
/// emulator gave them.
fn segments(line: &TerminalLine, cell: f32, mut advance: impl FnMut(&str) -> f32) -> Vec<Segment> {
    use unicode_width::UnicodeWidthChar;
    // A segment's kind: narrow, or wide of one advance (in hundredths of
    // a point, so equal advances compare equal).
    #[derive(PartialEq, Clone, Copy)]
    enum Kind {
        Narrow,
        Wide(i32),
    }
    let mut out: Vec<(Kind, bool, Segment)> = Vec::new();
    let mut col = 0usize;
    for run in &line.runs {
        // The run's cells: each character with a width, and the zero-width
        // ones after it.
        let mut cells: Vec<&str> = Vec::new();
        let mut start = 0;
        for (i, c) in run.text.char_indices() {
            if i > start && c.width().unwrap_or(0) > 0 {
                cells.push(&run.text[start..i]);
                start = i;
            }
        }
        if start < run.text.len() {
            cells.push(&run.text[start..]);
        }
        for g in cells {
            let width = text_width(g);
            let kind = match width >= 2 {
                true => Kind::Wide((advance(g) * 100.0).round() as i32),
                false => Kind::Narrow,
            };
            let open = matches!(out.last(), Some((k, closed, _)) if *k == kind && !closed);
            if !open {
                let (x, spacing) = match kind {
                    Kind::Narrow => (cell * col as f32, 0.0),
                    Kind::Wide(adv) => {
                        let spacing = 2.0 * cell - adv as f32 / 100.0;
                        (cell * col as f32 + spacing / 2.0, spacing)
                    }
                };
                out.push((
                    kind,
                    false,
                    Segment {
                        x,
                        spacing,
                        runs: Vec::new(),
                    },
                ));
            }
            let (_, closed, segment) = out.last_mut().expect("a segment");
            match segment.runs.last_mut() {
                Some(last) if last.style == run.style => last.text.push_str(g),
                _ => segment.runs.push(TerminalRun::new(g, run.style)),
            }
            *closed = kind != Kind::Narrow && g.ends_with('\u{200D}');
            col += width;
        }
    }
    out.into_iter().map(|(_, _, segment)| segment).collect()
}

thread_local! {
    /// Graphemes' advances by font, as the platform's text engine measures
    /// them.
    static ADVANCES: RefCell<HashMap<(String, String), f32>> = RefCell::new(HashMap::new());
}

/// How wide `font` draws `grapheme`, in points (measured once).
fn advance(font: &str, grapheme: &str) -> f32 {
    let key = (font.to_owned(), grapheme.to_owned());
    if let Some(width) = ADVANCES.with_borrow(|a| a.get(&key).copied()) {
        return width;
    }
    let width = measure_text(font, grapheme).0;
    ADVANCES.with_borrow_mut(|a| a.insert(key, width));
    width
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
/// text are bound while it has the focus, [`Term::bind_keys`]). It sits on
/// the cursor's cell, so an input method opens its candidates at the
/// cursor; the composition is drawn by the cursor's row. It stays a point
/// wide: what was typed stays in it (it is never emptied, which would end
/// an input method's composition; [`SinkText`] sends what is new), and a
/// narrow input scrolls its end, where the composition is, to its one
/// point.
fn sink(
    term: Term,
    props: TerminalProps,
    cell_width: Memo<Points>,
    lh: impl Fn() -> Points + 'static,
) -> impl IntoElement {
    let (change, compose, paste, focus, blur) = (
        term.clone(),
        term.clone(),
        term.clone(),
        term.clone(),
        term.clone(),
    );
    // The cursor's cell in the terminal's points: the rows end at the
    // bottom of their frame (the list follows the end), what is left of a
    // row's height above them.
    let place = {
        let term = term.clone();
        computed(move || {
            term.rev.get();
            let at = term.emu.borrow().cursor_position();
            let frame = term.rows_frame.get();
            let lh = props.line_height.get();
            let rows = term.size.get().unwrap_or_default().rows as f32;
            let above = (frame.size.height - lh * rows).max(Points(0.0));
            point(
                frame.origin.x + cell_width.get() * at.col as f32,
                frame.origin.y + above + lh * at.row as f32,
            )
        })
    };
    input()
        .element_ref(&term.sink)
        .absolute()
        .left(move || Length::from(place.get().x))
        .top(move || Length::from(place.get().y))
        .w(px(1.0))
        .h(move || Length::from(lh()))
        .pointer_events(PointerEvents::None)
        .p_0()
        .border(px(0.0))
        .bg(AdaptiveColor::TRANSPARENT)
        .text_color(AdaptiveColor::TRANSPARENT)
        // Not 0, which takes the input out of accessibility. A terminal
        // has no translucency and leaves a nearly transparent view out of
        // its geometry and focus: there the sink stays visible (its
        // transparent text draws nothing), as the editor's does.
        .opacity(if crate::terminal::is_terminal() {
            1.0
        } else {
            0.02
        })
        .caret(false)
        .auto_correct(false)
        .auto_capitalize(AutoCapitalize::None)
        .paste_behavior(PasteBehavior::Report)
        .value(String::new())
        .label(move || props.accessibility_label.get().unwrap_or_default())
        .on_change(move |text: &str| change.sink_changed(text))
        .on_composition_change(move |c: &Composition| compose.sink_composed(c))
        .on_paste(move |p: &PasteEvent| paste.paste(&p.text))
        .on_focus(move || focus.focused.set(true))
        .on_blur(move || blur.focused.set(false))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn red() -> TerminalStyle {
        TerminalStyle {
            fg: Some(TerminalColor::Indexed(1)),
            ..TerminalStyle::default()
        }
    }

    fn texts(segments: &[Segment]) -> Vec<(f32, f32, String)> {
        segments
            .iter()
            .map(|s| {
                (
                    s.x,
                    s.spacing,
                    s.runs.iter().map(|r| r.text.as_str()).collect(),
                )
            })
            .collect()
    }

    #[test]
    fn a_line_is_placed_by_cell_its_narrow_text_together_and_wide_characters_spaced_to_two_cells() {
        let plain = TerminalStyle::default();
        let line = TerminalLine::new(vec![
            TerminalRun::new("ab", plain),
            TerminalRun::new("c", red()),
            TerminalRun::new("中文d|", plain),
        ]);
        // Cells 8 wide; the font draws a CJK character 13 wide.
        let segments = segments(&line, 8.0, |_| 13.0);
        assert_eq!(
            texts(&segments),
            [
                (0.0, 0.0, "abc".into()),
                // Columns 3 to 6: three more a character, half of it before.
                (24.0 + 1.5, 3.0, "中文".into()),
                (56.0, 0.0, "d|".into()),
            ]
        );
        assert_eq!(segments[0].runs.len(), 2, "its styles stay runs");
    }

    #[test]
    fn wide_characters_of_another_advance_or_after_a_joiner_start_a_segment() {
        let plain = TerminalStyle::default();
        let line = TerminalLine::new(vec![TerminalRun::new(
            "中\u{1F44D}\u{1F468}\u{200D}\u{1F469}",
            plain,
        )]);
        let advance = |g: &str| if g == "中" { 13.0 } else { 15.0 };
        let at: Vec<f32> = segments(&line, 8.0, advance).iter().map(|s| s.x).collect();
        // 中 at 0; the thumb (another advance) at 2, the man and his joiner
        // with it; the woman, after the joiner, at 6.
        assert_eq!(at, [1.5, 16.5, 48.5]);
    }

    #[test]
    fn an_empty_line_has_no_segments() {
        assert!(segments(&TerminalLine::default(), 8.0, |_| 13.0).is_empty());
    }

    /// An event of the hidden input.
    #[derive(Clone, Copy)]
    enum Ev<'a> {
        /// `onChange` with the input's whole text.
        Change(&'a str),
        /// `onCompositionChange`: whether a composition is active.
        Compose(bool),
    }
    use Ev::{Change, Compose};

    /// What the terminal sends for `events`, in order.
    fn sent(events: &[Ev]) -> Vec<String> {
        let mut sink = SinkText::default();
        events
            .iter()
            .map(|e| match e {
                Change(text) => sink.changed(text),
                Compose(composing) => sink.composed(*composing),
            })
            .filter(|s| !s.is_empty())
            .collect()
    }

    #[test]
    fn typing_sends_each_new_character() {
        assert_eq!(
            sent(&[Change("l"), Change("ls"), Change("ls ")]),
            ["l", "s", " "]
        );
        // The input emptied, then typed into again.
        assert_eq!(sent(&[Change("ab"), Change("c")]), ["ab", "c"]);
        // A change that only deletes sends nothing (the key sent its bytes).
        assert_eq!(
            sent(&[Change("ab"), Change("a"), Change("ac")]),
            ["ab", "c"]
        );
    }

    #[test]
    fn a_composition_in_the_inputs_text_sends_only_its_commit() {
        // iOS, Android and the web: the composed text is in the input's
        // text, reported after the composition's start or change; the
        // commit's change before its end.
        let commit = [
            Change("$"),
            Compose(true),
            Change("$n"),
            Compose(true),
            Change("$ni"),
            Change("$你"),
            Compose(false),
        ];
        assert_eq!(sent(&commit), ["$", "你"]);
        // Typing goes on after it.
        let mut more = commit.to_vec();
        more.push(Change("$你a"));
        assert_eq!(sent(&more), ["$", "你", "a"]);
    }

    #[test]
    fn a_commit_of_the_composed_text_unchanged_is_sent_at_the_end() {
        // The text holds what was composed already: the end commits it,
        // whether the platform reports the text again or not.
        let again = [Compose(true), Change("ni"), Change("ni"), Compose(false)];
        assert_eq!(sent(&again), ["ni"]);
        let silent = [Compose(true), Change("ni"), Compose(false)];
        assert_eq!(sent(&silent), ["ni"]);
    }

    #[test]
    fn a_cancelled_composition_sends_nothing() {
        // In the input's text: the change drops it before the end.
        let removed = [
            Change("a"),
            Compose(true),
            Change("ani"),
            Change("a"),
            Compose(false),
        ];
        assert_eq!(sent(&removed), ["a"]);
        // Outside it (Windows, GPUI, GTK): no change at all.
        assert_eq!(sent(&[Change("a"), Compose(true), Compose(false)]), ["a"]);
    }

    #[test]
    fn a_composition_outside_the_inputs_text_sends_its_commit_once() {
        // Windows, GPUI, AppKit's marking and GTK: no change while it
        // composes, the committed text's change before the end.
        let events = [
            Change("a"),
            Compose(true),
            Compose(true),
            Change("a你"),
            Compose(false),
        ];
        assert_eq!(sent(&events), ["a", "你"]);
        // GTK commits a part while it composes the rest (outside the
        // text): sent with the rest, at the end.
        let partial = [Compose(true), Change("你"), Compose(true), Change("你好")];
        assert!(sent(&partial).is_empty());
        let mut ended = partial.to_vec();
        ended.push(Compose(false));
        assert_eq!(sent(&ended), ["你好"]);
    }

    #[test]
    fn a_part_committed_while_the_rest_composes_in_the_text_is_sent_at_the_end() {
        // Android or iOS: 日本 committed, ご composed after it. Nothing
        // tells the committed part from the composed one, so all of it
        // waits for the end.
        let events = [
            Compose(true),
            Change("にほんご"),
            Compose(true),
            Change("日本ご"),
            Change("日本語"),
        ];
        assert!(sent(&events).is_empty());
        let mut ended = events.to_vec();
        ended.push(Compose(false));
        assert_eq!(sent(&ended), ["日本語"]);
    }

    #[test]
    fn a_cancel_that_removes_text_matching_what_was_sent_sends_nothing() {
        // The composed `c` repeats the end of what was sent; the cancel
        // removes it from the text again.
        let events = [
            Change("abc"),
            Compose(true),
            Change("abcc"),
            Change("abc"),
            Compose(false),
        ];
        assert_eq!(sent(&events), ["abc"]);
    }

    #[test]
    fn nothing_is_sent_while_an_empty_composition_lasts() {
        // A composition that shows no text yet still holds back the
        // changes reported during it.
        let events = [Change("a"), Compose(true), Change("ax")];
        assert_eq!(sent(&events), ["a"]);
        let mut cancelled = events.to_vec();
        cancelled.extend([Change("a"), Compose(false)]);
        assert_eq!(sent(&cancelled), ["a"]);
        let mut committed = events.to_vec();
        committed.push(Compose(false));
        assert_eq!(sent(&committed), ["a", "x"]);
    }

    #[test]
    fn a_composition_ended_before_its_commit_is_reported_sends_the_commit_once() {
        // The headless driver's typing after a composition: its end with
        // nothing committed, then the typed text.
        let events = [Change("a"), Compose(true), Compose(false), Change("a你")];
        assert_eq!(sent(&events), ["a", "你"]);
    }

    #[test]
    fn palette() {
        assert_eq!(indexed(1), 0xcd3131);
        assert_eq!(indexed(16), 0);
        assert_eq!(indexed(231), 0xffffff);
        assert_eq!(indexed(232), 0x080808);
    }
}
