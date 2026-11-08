//! What a [`Terminal`](super::Terminal) shows comes from an emulator: the
//! program's output in, a grid of styled lines out. NSH's own is
//! [`VtEmulator`](super::VtEmulator); an app replaces it with any other
//! (libghostty, `alacritty_terminal`, ...) through [`TerminalEmulator`] and
//! [`TerminalEmulatorFactory`], without NSH building it.

use std::rc::Rc;

/// A terminal's size in character cells.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub struct TerminalSize {
    /// Columns.
    pub cols: u16,
    /// Rows.
    pub rows: u16,
}

impl Default for TerminalSize {
    fn default() -> Self {
        Self { cols: 80, rows: 24 }
    }
}

impl TerminalSize {
    /// `cols` × `rows`, each at least 1.
    pub fn new(cols: u16, rows: u16) -> Self {
        Self {
            cols: cols.max(1),
            rows: rows.max(1),
        }
    }
}

/// A color a program asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalColor {
    /// One of the 256 indexed colors (0–15 the palette's).
    Indexed(u8),
    /// A 24-bit color.
    Rgb(u8, u8, u8),
}

/// How a run of cells is drawn.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[non_exhaustive]
pub struct TerminalStyle {
    /// The text's color, `None` the default foreground.
    pub fg: Option<TerminalColor>,
    /// The cells' color, `None` the default background.
    pub bg: Option<TerminalColor>,
    /// Bold.
    pub bold: bool,
    /// Faint.
    pub dim: bool,
    /// Italic.
    pub italic: bool,
    /// Underlined.
    pub underline: bool,
    /// Struck through.
    pub strikethrough: bool,
    /// Foreground and background swapped.
    pub inverse: bool,
    /// Not drawn (the cells keep their place).
    pub hidden: bool,
}

/// Cells of one style, in a line.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
#[non_exhaustive]
pub struct TerminalRun {
    /// The cells' text.
    pub text: String,
    /// How it is drawn.
    pub style: TerminalStyle,
}

impl TerminalRun {
    /// A run of `text` in `style`.
    pub fn new(text: impl Into<String>, style: TerminalStyle) -> Self {
        Self {
            text: text.into(),
            style,
        }
    }
}

/// One line: scrollback or screen.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
#[non_exhaustive]
pub struct TerminalLine {
    /// Its runs, left to right; trailing default cells may be left out.
    pub runs: Vec<TerminalRun>,
}

impl TerminalLine {
    /// A line of `runs`.
    pub fn new(runs: Vec<TerminalRun>) -> Self {
        Self { runs }
    }

    /// Its text.
    pub fn text(&self) -> String {
        self.runs.iter().map(|r| r.text.as_str()).collect()
    }
}

/// The cursor, on the screen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[non_exhaustive]
pub struct TerminalCursor {
    /// Its column.
    pub col: u16,
    /// Its row, 0 the screen's first.
    pub row: u16,
}

/// The modes a program set that change what input becomes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[non_exhaustive]
pub struct TerminalModes {
    /// Arrows send `ESC O A` rather than `ESC [ A` (DECCKM).
    pub application_cursor: bool,
    /// Pastes are wrapped in `ESC [ 200~` … `ESC [ 201~` (mode 2004).
    pub bracketed_paste: bool,
}

/// What an emulator reports while it takes output.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum TerminalEmulatorEvent {
    /// The program set the title.
    Title(String),
    /// The bell.
    Bell,
    /// Bytes to send back to the program (answers to its queries: the
    /// cursor's position, the device's attributes).
    Reply(Vec<u8>),
}

/// A terminal emulator: takes a program's output and holds the lines a
/// [`Terminal`](super::Terminal) shows. Lines are numbered from the
/// oldest scrollback line; the last [`TerminalSize::rows`] are the screen.
pub trait TerminalEmulator {
    /// Takes output of the program.
    fn feed(&mut self, bytes: &[u8]);
    /// Makes the screen `size`.
    fn resize(&mut self, size: TerminalSize);
    /// How many lines, scrollback and screen.
    fn line_count(&self) -> usize;
    /// Line `index`; past the last, an empty one.
    fn line(&self, index: usize) -> TerminalLine;
    /// The cursor, `None` while the program hides it.
    fn cursor(&self) -> Option<TerminalCursor>;
    /// What happened since the last call.
    fn take_events(&mut self) -> Vec<TerminalEmulatorEvent>;
    /// The input modes the program set.
    fn modes(&self) -> TerminalModes {
        TerminalModes::default()
    }
}

type MakeFn = dyn Fn(TerminalSize, usize) -> Box<dyn TerminalEmulator>;

/// Makes the emulator of the terminals below, given with
/// `provide_context`, in place of NSH's own ([`VtEmulator`](super::VtEmulator)).
/// It gets the screen's size and how many scrollback lines to keep.
///
/// ```ignore
/// provide_context(TerminalEmulatorFactory::new(|size, scrollback| {
///     Box::new(GhosttyEmulator::new(size, scrollback))
/// }));
/// ```
#[derive(Clone)]
pub struct TerminalEmulatorFactory(Rc<MakeFn>);

impl TerminalEmulatorFactory {
    /// A factory calling `make`.
    pub fn new(make: impl Fn(TerminalSize, usize) -> Box<dyn TerminalEmulator> + 'static) -> Self {
        Self(Rc::new(make))
    }

    pub(crate) fn make(&self, size: TerminalSize, scrollback: usize) -> Box<dyn TerminalEmulator> {
        (self.0)(size, scrollback)
    }
}

impl std::fmt::Debug for TerminalEmulatorFactory {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("TerminalEmulatorFactory")
    }
}
