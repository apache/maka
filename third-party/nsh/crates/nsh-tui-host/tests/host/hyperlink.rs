//! The text inside a `Link` reaches the terminal as OSC 8 hyperlinks to
//! its `href`, and
//! nothing else written for a frame changes: every frame is drawn twice from
//! the same Cell diff, once through the surface's backend (which links) and
//! once straight to an encoder, and the two differ only by the links.

use std::{
    io,
    sync::{Arc, mpsc},
    time::{Duration, Instant},
};

use nsh_base::link;
use nsh_core::prelude::*;
use nsh_platform_tui::{
    App, AppOptions, AppView, Handled, Input, MeasuredBackend, MouseButton, MouseInput, MouseKind,
    Root,
};
use ratatui_core::{
    backend::{Backend, ClearType, TestBackend, WindowSize},
    buffer::Cell,
    layout::{Position, Size},
    terminal::Terminal,
};
use ratatui_crossterm::CrosstermBackend;

use super::performance::{Capture, MemoryTerminal};

const CLOSE: &str = "\x1b]8;;\x1b\\";

/// The same diff, linked by the surface's backend and plain.
struct Twin {
    linked: MeasuredBackend<MemoryTerminal>,
    plain: MemoryTerminal,
}

impl Backend for Twin {
    type Error = io::Error;
    fn draw<'a, I>(&mut self, content: I) -> io::Result<()>
    where
        I: Iterator<Item = (u16, u16, &'a Cell)>,
    {
        let cells: Vec<_> = content.collect();
        self.plain.draw(cells.iter().copied())?;
        self.linked.draw(cells.into_iter())
    }
    fn hide_cursor(&mut self) -> io::Result<()> {
        self.plain.hide_cursor()?;
        self.linked.hide_cursor()
    }
    fn show_cursor(&mut self) -> io::Result<()> {
        self.plain.show_cursor()?;
        self.linked.show_cursor()
    }
    fn get_cursor_position(&mut self) -> io::Result<Position> {
        self.plain.get_cursor_position()
    }
    fn set_cursor_position<P: Into<Position>>(&mut self, position: P) -> io::Result<()> {
        let position = position.into();
        self.plain.set_cursor_position(position)?;
        self.linked.set_cursor_position(position)
    }
    fn clear(&mut self) -> io::Result<()> {
        self.plain.clear()?;
        self.linked.clear()
    }
    fn clear_region(&mut self, region: ClearType) -> io::Result<()> {
        self.plain.clear_region(region)?;
        self.linked.clear_region(region)
    }
    fn size(&self) -> io::Result<Size> {
        self.plain.size()
    }
    fn window_size(&mut self) -> io::Result<WindowSize> {
        self.plain.window_size()
    }
    fn flush(&mut self) -> io::Result<()> {
        self.plain.flush()?;
        Backend::flush(&mut self.linked)
    }
}

fn memory(view: &AppView, capture: &Capture) -> MemoryTerminal {
    MemoryTerminal {
        screen: TestBackend::new(40, 8),
        ansi: CrosstermBackend::new(view.measure_writer(capture.clone())),
    }
}

/// `bytes` without its OSC 8 sequences.
fn unlinked(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len());
    let mut rest = bytes;
    while !rest.is_empty() {
        if let Some(body) = rest.strip_prefix(b"\x1b]8;") {
            let end = body
                .windows(2)
                .position(|w| w == b"\x1b\\")
                .expect("an OSC 8 sequence ends in ST");
            rest = &body[end + 2..];
        } else {
            out.push(rest[0]);
            rest = &rest[1..];
        }
    }
    out
}

/// The opening sequences in `bytes`, each with the text it links, which
/// must be closed right after it.
fn links(bytes: &[u8]) -> Vec<(String, String)> {
    let text = String::from_utf8_lossy(bytes);
    let mut found = Vec::new();
    let mut rest = &*text;
    while let Some(at) = rest.find("\x1b]8;id=") {
        let after = &rest[at + 4..];
        let end = after.find("\x1b\\").unwrap();
        let open = after[..end].to_owned();
        let linked = &after[end + 2..];
        let close = linked
            .find(CLOSE)
            .expect("every linked Cell closes its link");
        let symbol = linked[..close].to_owned();
        assert!(
            !symbol.contains('\x1b'),
            "a link holds one Cell: {symbol:?}"
        );
        found.push((open, symbol));
        rest = &linked[close + CLOSE.len()..];
    }
    found
}

struct Run {
    view: AppView,
    terminal: Terminal<Twin>,
    linked: Capture,
    plain: Capture,
    rx: mpsc::Receiver<()>,
}

impl Run {
    fn new(app: App) -> Self {
        Self::with(app, true)
    }

    /// A run on a terminal that takes hyperlinks, or one that does not.
    fn with(app: App, hyperlinks: bool) -> Self {
        let (tx, rx) = mpsc::channel();
        let mut options = AppOptions::default();
        options.capabilities.hyperlinks = hyperlinks;
        options.wake = Some(Arc::new(move || {
            let _ = tx.send(());
        }));
        options.cache = nsh_platform_tui::CacheOptions::off();
        let mut view = AppView::new(options);
        let (linked, plain) = (Capture::default(), Capture::default());
        let twin = Twin {
            linked: view.measure_backend(memory(&view, &linked)),
            plain: memory(&view, &plain),
        };
        let terminal = Terminal::new(twin).unwrap();
        view.load(app).unwrap();
        Self {
            view,
            terminal,
            linked,
            plain,
            rx,
        }
    }

    /// Draws one frame and returns what the linked backend wrote, once the
    /// plain one wrote the same less the links.
    fn frame(&mut self) -> Vec<u8> {
        self.linked.0.borrow_mut().clear();
        self.plain.0.borrow_mut().clear();
        self.view.draw_terminal(&mut self.terminal).unwrap();
        let linked = self.linked.0.borrow().clone();
        let plain = self.plain.0.borrow().clone();
        assert_eq!(
            String::from_utf8_lossy(&unlinked(&linked)),
            String::from_utf8_lossy(&plain),
            "a frame differs only by its links"
        );
        linked
    }

    fn screen(&self) -> String {
        let buffer = self.terminal.backend().plain.screen.buffer();
        (0..buffer.area.height)
            .map(|y| {
                (0..buffer.area.width)
                    .map(|x| buffer[(x, y)].symbol())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// Draws until the screen shows `expected`; every frame's output.
    fn until(&mut self, expected: &str) -> Vec<Vec<u8>> {
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut frames = Vec::new();
        loop {
            frames.push(self.frame());
            if self.screen().contains(expected) {
                return frames;
            }
            assert!(
                Instant::now() < deadline,
                "expected {expected:?}, got\n{}",
                self.screen()
            );
            let due = self
                .view
                .next_frame_deadline()
                .map_or(deadline, |due| due.min(deadline));
            let _ = self
                .rx
                .recv_timeout(due.saturating_duration_since(Instant::now()));
        }
    }

    /// Redraws the whole screen.
    fn full(&mut self) -> Vec<u8> {
        self.terminal.clear().unwrap();
        self.frame()
    }

    fn press(&mut self, label: &str) {
        let (column, row) = self
            .screen()
            .lines()
            .enumerate()
            .find_map(|(y, line)| line.find(label).map(|x| (x as u16, y as u16)))
            .unwrap_or_else(|| panic!("{label} is on screen"));
        for kind in [
            MouseKind::Down(MouseButton::Left),
            MouseKind::Up(MouseButton::Left),
        ] {
            let mut mouse = MouseInput::default();
            mouse.column = column;
            mouse.row = row;
            mouse.kind = kind;
            assert_eq!(self.view.handle(Input::Mouse(mouse)), Handled::Yes);
        }
    }
}

fn page(linked: bool) -> impl IntoElement {
    let count = signal(0);
    let href = move |url: &'static str| linked.then(|| SharedString::from(url));
    view()
        .flex_1()
        // The count inside a link in a paragraph and after it, on one row.
        .child(
            text("x ")
                .child(
                    link()
                        .href(href("https://example.com/a"))
                        .child(text(move || format!("Go {}", count.get()))),
                )
                .child(text(move || format!(" / {}", count.get()))),
        )
        .child(
            view()
                .h(px(16.0))
                .on_press(move |_: &()| count.update(|c| *c += 1))
                .child(text("press")),
        )
        // A link whose content takes two rows: `ab cd` and `ef gh`.
        .child(
            link()
                .href(href("https://example.com/w"))
                .child(text("ab cd"))
                .child(text("ef gh")),
        )
}

#[component]
fn Linked() -> impl IntoElement {
    page(true)
}

#[component]
fn Plain() -> impl IntoElement {
    page(false)
}

#[test]
fn a_links_cells_are_each_linked_with_one_id_and_nothing_else_moves() {
    let mut run = Run::new(App::Rust(Root::new::<Linked>(|| ())));
    // The frame the links appear in writes each of their Cells, the blank
    // between words too: a Cell whose link changed is drawn again.
    let shown = run.until("ef gh");
    let full = shown
        .iter()
        .map(|frame| links(frame))
        .find(|links| !links.is_empty())
        .expect("a frame draws the links");
    let to = |url: &str| -> Vec<(String, String)> {
        full.iter()
            .filter(|(open, _)| open.ends_with(url))
            .cloned()
            .collect()
    };
    let first = to(";https://example.com/a");
    assert_eq!(
        first.iter().map(|(_, s)| s.as_str()).collect::<String>(),
        "Go 0"
    );
    let wrapped = to(";https://example.com/w");
    assert_eq!(
        wrapped.iter().map(|(_, s)| s.as_str()).collect::<String>(),
        "ab cdef gh"
    );
    // One id per link, shared by its Cells; another link's differs.
    let id = |links: &[(String, String)]| {
        let ids: std::collections::HashSet<_> = links
            .iter()
            .map(|(open, _)| open.split(';').next().unwrap().to_owned())
            .collect();
        assert_eq!(ids.len(), 1, "{ids:?}");
        ids.into_iter().next().unwrap()
    };
    assert!(id(&first).starts_with("id="));
    assert_ne!(id(&first), id(&wrapped));
    assert_eq!(full.len(), first.len() + wrapped.len());
    // The link is on both its rows.
    let buffer = run.terminal.backend().linked.inner().screen.buffer();
    let rows: std::collections::BTreeSet<_> = buffer
        .content
        .iter()
        .enumerate()
        .filter(|(_, cell)| cell.symbol().contains("example.com/w"))
        .map(|(index, _)| buffer.pos_of(index).1)
        .collect();
    assert_eq!(rows.len(), 2, "{rows:?}");
    // Redrawn whole, the screen gets the same links; a blank Cell equal to
    // the cleared screen's is not written, as without links.
    let again = links(&run.full());
    assert_eq!(
        again.iter().map(|(_, s)| s.as_str()).collect::<String>(),
        "Go0abcdefgh"
    );
    // A redraw of some Cells: the linked digit is linked again, the one
    // after the link is not, and both land where the plain output puts them
    // (`frame` compares every frame).
    run.press("press");
    let frames = run.until("Go 1 / 1");
    let redrawn: Vec<_> = frames.iter().flat_map(|frame| links(frame)).collect();
    assert!(
        redrawn
            .iter()
            .any(|(open, symbol)| open.ends_with("example.com/a") && symbol == "1"),
        "{redrawn:?}"
    );
    assert!(
        redrawn
            .iter()
            .all(|(open, _)| open.ends_with("example.com/a"))
    );
}

#[test]
fn a_link_without_an_href_is_written_as_text() {
    let mut run = Run::new(App::Rust(Root::new::<Plain>(|| ())));
    run.until("ef gh");
    let full = run.full();
    assert!(!String::from_utf8_lossy(&full).contains("\x1b]8"));
    assert_eq!(full, *run.plain.0.borrow());
    run.press("press");
    for frame in run.until("Go 1 / 1") {
        assert!(!String::from_utf8_lossy(&frame).contains("\x1b]8"));
    }
}

/// Links whose `href` is no URL the app could open.
#[component]
fn NoUrl() -> impl IntoElement {
    view()
        .child(
            link()
                .href("https://example.com/\x1b]8;;evil\x1b\\")
                .child(text("bad")),
        )
        .child(link().href("/settings").child(text("path")))
        .child(link().href("#top").child(text("anchor")))
}

#[test]
fn an_href_that_is_no_url_is_drawn_as_plain_text() {
    let mut run = Run::new(App::Rust(Root::new::<NoUrl>(|| ())));
    run.until("anchor");
    let full = run.full();
    assert!(!String::from_utf8_lossy(&full).contains("\x1b]8"));
}

#[test]
fn a_terminal_without_hyperlinks_gets_plain_text() {
    let mut run = Run::with(App::Rust(Root::new::<Linked>(|| ())), false);
    for frame in run.until("ef gh") {
        assert!(!String::from_utf8_lossy(&frame).contains("\x1b]8"));
    }
    assert!(!String::from_utf8_lossy(&run.full()).contains("\x1b]8"));
}
