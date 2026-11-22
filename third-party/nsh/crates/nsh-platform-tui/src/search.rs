//! The Minibuffer: `C-s` / `C-r` search the text on screen incrementally, after readline and Emacs's isearch.
//!
//! The query is matched grapheme by grapheme against the rows the Cell text engine laid out, so a match is
//! text the user reads on one row. A query without capitals ignores case (smart case). Matches are ordered by
//! their Cell position in the current focus scope, including text scrolled out of sight, and the order wraps.

use nsh_core::{
    Bounds, NodeId, Point, Points, Size,
    keymap::{Key, Keystroke},
};
use nsh_engine::EngineControl;
use ratatui_core::{
    buffer::Buffer,
    layout::{Position, Rect},
    style::{Modifier, Style},
};
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

use crate::{
    CellSize,
    geometry::CellBounds,
    keyboard::Keyboard,
    mount::Mounter,
    render::Geometry,
    text::{CellLayout, Glyph, Row},
};

const FORWARD_PROMPT: &str = "/";
const BACKWARD_PROMPT: &str = "?";

/// What a search acts on: the surface's tree, its last completed frame and its keyboard focus.
pub(crate) struct Scene<'a> {
    pub(crate) tree: &'a mut Mounter,
    pub(crate) geometry: &'a [Geometry],
    pub(crate) keyboard: &'a mut Keyboard,
    pub(crate) control: &'a EngineControl,
    pub(crate) cells: CellSize,
    pub(crate) area: Rect,
}

pub(crate) enum Outcome {
    Consumed,
    /// The search ended; the key takes its usual action.
    Ended,
}

#[derive(Default)]
pub(crate) struct Minibuffer {
    session: Option<Session>,
    last_query: String,
    cursor: Option<Position>,
}

struct Session {
    query: String,
    forward: bool,
    current: Option<Match>,
    failing: bool,
    history: Vec<Step>,
    origin: Origin,
}

struct Step {
    query_len: usize,
    forward: bool,
    current: Option<Match>,
    failing: bool,
}

struct Origin {
    focus: Option<NodeId>,
    search_point: Option<NodeId>,
    scrolls: Vec<(NodeId, Point<Points>)>,
}

#[derive(Clone, Copy)]
struct Match {
    text: NodeId,
    row: usize,
    start: usize,
    len: usize,
}

enum Command {
    Repeat(bool),
    Cancel,
    Accept,
    Undo,
    Insert(char),
    Other,
}

impl Minibuffer {
    pub(crate) fn is_open(&self) -> bool {
        self.session.is_some()
    }

    pub(crate) fn start(&mut self, forward: bool, scene: &mut Scene) {
        let scrolls = scene
            .tree
            .views
            .iter()
            .enumerate()
            .filter_map(|(index, view)| {
                let scroll = view.as_ref()?.scroll.as_ref()?;
                Some((index as NodeId, Point::new(scroll.x, scroll.y)))
            })
            .collect();
        self.session = Some(Session {
            query: String::new(),
            forward,
            current: None,
            failing: false,
            history: Vec::new(),
            origin: Origin {
                focus: scene.keyboard.focused,
                search_point: scene.keyboard.search_point,
                scrolls,
            },
        });
    }

    pub(crate) fn key(&mut self, name: &str, stroke: Keystroke, scene: &mut Scene) -> Outcome {
        let Some(session) = &mut self.session else {
            return Outcome::Ended;
        };
        match command(name, stroke) {
            Command::Repeat(forward) => {
                session.record();
                session.forward = forward;
                // Repeating with an empty query searches for the previous search's query again.
                let step = !session.query.is_empty();
                if !step {
                    session.query.clone_from(&self.last_query);
                }
                if !session.query.is_empty() {
                    session.find(step, scene);
                }
            }
            Command::Insert(character) => {
                session.record();
                session.query.push(character);
                session.find(false, scene);
            }
            Command::Undo => session.undo(scene),
            Command::Accept => self.end(),
            Command::Cancel => {
                if let Some(session) = self.session.take() {
                    session.origin.restore(scene);
                    self.remember(session.query);
                }
            }
            Command::Other => {
                self.end();
                return Outcome::Ended;
            }
        }
        Outcome::Consumed
    }

    /// Adds pasted text to the query; line breaks become spaces, since a match lies on one row.
    pub(crate) fn paste(&mut self, text: &str, scene: &mut Scene) {
        let Some(session) = &mut self.session else {
            return;
        };
        session.record();
        session
            .query
            .extend(text.chars().map(|c| if c.is_control() { ' ' } else { c }));
        session.find(false, scene);
    }

    /// Ends the search at the current match.
    pub(crate) fn end(&mut self) {
        if let Some(session) = self.session.take() {
            self.remember(session.query);
        }
    }

    fn remember(&mut self, query: String) {
        self.cursor = None;
        if !query.is_empty() {
            self.last_query = query;
        }
    }

    /// The terminal cursor at the end of the query, while searching.
    pub(crate) fn cursor(&self) -> Option<Position> {
        self.session.as_ref().and(self.cursor)
    }

    /// Reverses the current match's Cells and draws the Minibuffer over the bottom row, only while searching.
    pub(crate) fn draw(
        &mut self,
        tree: &Mounter,
        geometry: &[Geometry],
        cells: CellSize,
        area: Rect,
        buffer: &mut Buffer,
    ) {
        self.cursor = None;
        let Some(session) = &self.session else {
            return;
        };
        let clip = area.intersection(buffer.area);
        if clip.is_empty() {
            return;
        }
        if !session.failing
            && let Some(found) = session.current
            && let Some((bounds, visible)) = locate(tree, geometry, cells, area, found)
        {
            let highlight = bounds.clipped(visible);
            for y in highlight.top()..highlight.bottom() {
                for x in highlight.left()..highlight.right() {
                    buffer[(x, y)].modifier.insert(Modifier::REVERSED);
                }
            }
        }
        let y = clip.bottom() - 1;
        for x in clip.left()..clip.right() {
            buffer[(x, y)].reset();
        }
        let prompt = if session.forward {
            FORWARD_PROMPT
        } else {
            BACKWARD_PROMPT
        };
        buffer[(clip.x, y)].set_symbol(prompt);
        if clip.width < 2 {
            return;
        }
        // The tail of a long query stays in sight, with one Cell left for the cursor.
        let available = usize::from(clip.width - 2);
        let mut shown = session.query.len();
        let mut used = 0;
        for (index, grapheme) in session.query.grapheme_indices(true).rev() {
            if used + grapheme.width() > available {
                break;
            }
            used += grapheme.width();
            shown = index;
        }
        let style = if session.failing {
            Style::reset().add_modifier(Modifier::CROSSED_OUT)
        } else {
            Style::reset()
        };
        buffer.set_stringn(clip.x + 1, y, &session.query[shown..], available, style);
        self.cursor = Some(Position::new(clip.x + 1 + used as u16, y));
    }
}

fn command(name: &str, stroke: Keystroke) -> Command {
    let Keystroke { key, modifiers: m } = stroke;
    if m.cmd {
        return Command::Other;
    }
    if m.ctrl && !m.alt && !m.shift {
        return match key {
            Key::Char('s') => Command::Repeat(true),
            Key::Char('r') => Command::Repeat(false),
            Key::Char('g') => Command::Cancel,
            Key::Char('h') => Command::Undo,
            _ => Command::Other,
        };
    }
    if m.ctrl || m.alt {
        return Command::Other;
    }
    match key {
        Key::Escape => Command::Cancel,
        Key::Enter if !m.shift => Command::Accept,
        Key::Backspace => Command::Undo,
        Key::Char(key) => {
            let mut chars = name.chars();
            match (chars.next(), chars.next()) {
                (Some(typed), None) => Command::Insert(typed),
                _ => Command::Insert(key),
            }
        }
        _ => Command::Other,
    }
}

impl Session {
    fn record(&mut self) {
        self.history.push(Step {
            query_len: self.query.len(),
            forward: self.forward,
            current: self.current,
            failing: self.failing,
        });
    }

    /// Returns to the query and match before the last change, like isearch's Backspace.
    fn undo(&mut self, scene: &mut Scene) {
        let Some(step) = self.history.pop() else {
            return;
        };
        self.query.truncate(step.query_len);
        self.forward = step.forward;
        self.current = step.current;
        self.failing = step.failing;
        match self.current {
            Some(found) if !self.failing => show(found, scene),
            Some(_) => {}
            None => self.origin.restore(scene),
        }
    }

    /// Moves to the nearest match in the search's direction: from the current match, or from where the
    /// search began. Typing keeps a match that still matches (`step` false); repeating moves past it.
    fn find(&mut self, step: bool, scene: &mut Scene) {
        let found = matches(&self.query, scene);
        let from = self
            .current
            .and_then(|current| {
                locate(scene.tree, scene.geometry, scene.cells, scene.area, current)
            })
            .map(|(bounds, _)| (bounds.top, bounds.left))
            .or_else(|| self.origin.position(scene));
        let next = if self.forward {
            found
                .iter()
                .find(|(at, _)| from.is_none_or(|from| if step { *at > from } else { *at >= from }))
                .or(found.first())
        } else {
            found
                .iter()
                .rev()
                .find(|(at, _)| from.is_none_or(|from| if step { *at < from } else { *at <= from }))
                .or(found.last())
        };
        match next {
            Some(&(_, next)) => {
                self.failing = false;
                self.current = Some(next);
                show(next, scene);
            }
            None => self.failing = true,
        }
    }
}

impl Origin {
    fn position(&self, scene: &Scene) -> Option<(i32, i32)> {
        let id = self.focus.or(self.search_point)?;
        scene
            .geometry
            .iter()
            .find(|g| g.id == id)
            .map(|g| (g.bounds.top, g.bounds.left))
    }

    fn restore(&self, scene: &mut Scene) {
        for &(id, offset) in &self.scrolls {
            let Some(scroll) = scene.tree.get_mut(id).and_then(|view| view.scroll.as_mut()) else {
                continue;
            };
            if Point::new(scroll.x, scroll.y) != offset {
                scroll.x = offset.x;
                scroll.y = offset.y;
                if !scene.tree.scrolled.contains(&id) {
                    scene.tree.scrolled.push(id);
                }
            }
        }
        let focus = self.focus.filter(|&id| {
            scene
                .keyboard
                .candidates(scene.tree, scene.geometry)
                .iter()
                .any(|g| g.id == id)
        });
        scene.keyboard.focus(focus, scene.tree, scene.control);
        scene.keyboard.search_point = self.search_point;
    }
}

fn show(found: Match, scene: &mut Scene) {
    scene
        .keyboard
        .focus_match(found.text, scene.tree, scene.geometry, scene.control);
    if let Some((bounds, _)) = locate(scene.tree, scene.geometry, scene.cells, scene.area, found) {
        let frame = Bounds::new(
            bounds.origin(scene.cells, scene.area),
            Size::new(
                scene.cells.width() * (bounds.right - bounds.left) as f32,
                scene.cells.height(),
            ),
        );
        crate::keyboard::reveal_frame(scene.tree, scene.geometry, found.text, frame);
    }
}

fn matches(query: &str, scene: &Scene) -> Vec<((i32, i32), Match)> {
    let needle: Vec<&str> = query.graphemes(true).collect();
    if needle.is_empty() {
        return Vec::new();
    }
    let ignore_case = !query.chars().any(char::is_uppercase);
    let scope = crate::navigation::focus_scope(scene.tree);
    let mut found = Vec::new();
    for g in scene.geometry {
        if crate::keyboard::input_scope(scene.tree, g.id) != scope {
            continue;
        }
        let Some((layout, content)) = scene.tree.get(g.id).and_then(|view| view.text.as_ref())
        else {
            continue;
        };
        let Some(layout) = layout.downcast::<CellLayout>() else {
            continue;
        };
        let text = text_bounds(g, *content, scene.cells, scene.area);
        for (index, row) in layout.rows.iter().enumerate() {
            let Some(last) = row.glyphs.len().checked_sub(needle.len()) else {
                continue;
            };
            for start in 0..=last {
                if needle
                    .iter()
                    .zip(&row.glyphs[start..])
                    .all(|(wanted, glyph)| same(&glyph.text, wanted, ignore_case))
                {
                    let at = (
                        text.top + index as i32,
                        text.left + column(row, start) as i32,
                    );
                    found.push((
                        at,
                        Match {
                            text: g.id,
                            row: index,
                            start,
                            len: needle.len(),
                        },
                    ));
                }
            }
        }
    }
    found.sort_by_key(|(at, _)| *at);
    found
}

fn same(shown: &str, wanted: &str, ignore_case: bool) -> bool {
    if ignore_case {
        shown
            .chars()
            .flat_map(char::to_lowercase)
            .eq(wanted.chars().flat_map(char::to_lowercase))
    } else {
        shown == wanted
    }
}

fn width(glyphs: &[Glyph]) -> usize {
    glyphs.iter().map(|glyph| glyph.width).sum()
}

fn column(row: &Row, start: usize) -> usize {
    row.indent + width(&row.glyphs[..start])
}

fn text_bounds(g: &Geometry, content: Bounds<Points>, cells: CellSize, area: Rect) -> CellBounds {
    CellBounds::new(
        g.text_frame
            .unwrap_or_else(|| Bounds::new(g.frame.origin + content.origin, content.size)),
        cells,
        area,
    )
}

/// The match's Cells in the last frame, and the visible part of its text view.
fn locate(
    tree: &Mounter,
    geometry: &[Geometry],
    cells: CellSize,
    area: Rect,
    found: Match,
) -> Option<(CellBounds, Rect)> {
    let g = geometry.iter().find(|g| g.id == found.text)?;
    let (layout, content) = tree.get(found.text)?.text.as_ref()?;
    let row = layout.downcast::<CellLayout>()?.rows.get(found.row)?;
    let glyphs = row.glyphs.get(found.start..found.start + found.len)?;
    let text = text_bounds(g, *content, cells, area);
    let left = text.left + column(row, found.start) as i32;
    let top = text.top + found.row as i32;
    Some((
        CellBounds {
            left,
            top,
            right: left + width(glyphs) as i32,
            bottom: top + 1,
        },
        g.visible,
    ))
}
