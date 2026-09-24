/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

//! Sheets, the one modal dialog shape: a bold title inside the box, prose,
//! a body, and buttons at the bottom right. The chosen button holds focus
//! when a sheet opens, Tab cycles inside it, and Esc or a click outside asks
//! its owner to dismiss it. Nothing beneath a sheet sees input.
use super::{
    layout,
    node::{Node, On, Role, Size, Tone},
    surface::{Context, Outcome, Surface},
};
use crossterm::event::{Event, KeyCode, KeyEventKind, KeyModifiers, MouseButton, MouseEventKind};
use ratatui::{
    Frame,
    layout::{Margin, Position, Rect},
    style::{Modifier, Style},
    widgets::{Block, BorderType},
};

const ROOT: &str = "sheet";
/// The owner-drawn part of a field, beneath its label.
const INPUT: &str = "input";
const WIDTH: u16 = 64;
/// Narrower than this, prose wraps into a column nobody can read.
const MIN_WIDTH: u16 = 28;

/// Width of a sheet's content over a terminal this wide: what an owner
/// lays out a field for before the sheet is drawn.
pub fn content_width(width: u16) -> u16 {
    WIDTH.min(width.saturating_sub(2)).saturating_sub(4)
}

pub struct Sheet<M> {
    key: String,
    title: String,
    body: Vec<Node<M>>,
    /// Secondary commands at the bottom left (paging, retrying).
    aside: Vec<Node<M>>,
    buttons: Vec<Node<M>>,
    /// Full id of the node focused on open.
    focus: Option<String>,
    back: Option<M>,
}

impl<M> Sheet<M> {
    /// `key` names what the sheet shows; a different key opens fresh, with
    /// the chosen button focused again.
    pub fn new(key: impl Into<String>, title: impl Into<String>) -> Self {
        Self {
            key: key.into(),
            title: title.into(),
            body: vec![],
            aside: vec![],
            buttons: vec![],
            focus: None,
            back: None,
        }
    }

    /// Prose wrapped per source line; blank lines stay as spacing.
    pub fn text(self, key: &'static str, text: &str, tone: Tone) -> Self {
        let lines = text
            .lines()
            .enumerate()
            .map(|(index, line)| Node::text(index.to_string(), vec![(line.to_owned(), tone)]))
            .collect();
        self.body(Node::column(key, lines))
    }

    pub fn body(mut self, node: Node<M>) -> Self {
        self.body.push(node);
        self
    }

    pub fn button(
        mut self,
        key: &'static str,
        label: String,
        role: Role,
        message: M,
        enabled: bool,
    ) -> Self {
        self.buttons.push(
            Node::button(key, label, role)
                .on(On::Activate(message))
                .enabled(enabled),
        );
        self
    }

    /// A text field its owner draws into `Layer::slot(key)` and feeds keys
    /// while focused; Enter in it sends `submit`. A label sits directly
    /// above it. An enabled field is where the sheet opens unless a button
    /// is chosen afterwards.
    pub fn field(
        mut self,
        key: &'static str,
        label: Option<String>,
        rows: u16,
        submit: M,
        enabled: bool,
    ) -> Self {
        if enabled && self.focus.is_none() {
            self.focus = Some(format!("{ROOT}/{key}/{INPUT}"));
        }
        let mut children: Vec<_> = label
            .map(|label| Node::text("label", vec![(label, Tone::Subtle)]))
            .into_iter()
            .collect();
        children.push(
            Node::slot(INPUT, rows)
                .on(On::Activate(submit))
                .enabled(enabled),
        );
        self.body(Node::column(key, children))
    }

    /// A secondary command kept apart from the decision, at the bottom left.
    pub fn aside(mut self, key: &'static str, label: String, message: M, enabled: bool) -> Self {
        self.aside.push(
            Node::button(key, label, Role::Normal)
                .on(On::Activate(message))
                .enabled(enabled),
        );
        self
    }

    /// The button focused on open. Confirmations of a change choose Cancel,
    /// so Enter alone never commits it.
    pub fn focus(mut self, key: &'static str) -> Self {
        self.focus = Some(format!("{ROOT}/footer/{key}"));
        self
    }

    /// A body node focused on open, by its path below the sheet (the
    /// current choice of a list).
    pub fn focus_node(mut self, path: impl std::fmt::Display) -> Self {
        self.focus = Some(format!("{ROOT}/{path}"));
        self
    }

    /// A step inside a flow: Esc goes back here rather than dismissing.
    pub fn back(mut self, message: M) -> Self {
        self.back = Some(message);
        self
    }

    /// Where Esc leads, read from a sheet built for the current state.
    pub fn escape(self) -> Option<M> {
        self.back
    }

    fn footer_width(&self) -> u16 {
        let count = self.aside.len() + self.buttons.len();
        let gaps = 2 * count.saturating_sub(1) as u16;
        // Buttons are fixed-width: their padding counts, not just the label.
        let width = |nodes: &[Node<M>]| {
            nodes
                .iter()
                .map(|node| match node.size {
                    Size::Fixed(width) => width,
                    _ => layout::width(node),
                })
                .sum::<u16>()
        };
        width(&self.aside) + width(&self.buttons) + gaps
    }

    fn tree(self) -> Node<M> {
        let mut children = vec![Node::text("title", vec![(self.title, Tone::Strong)])];
        children.extend(self.body);
        let mut footer = self.aside;
        footer.push(Node::text("space", vec![]).size(Size::Fill));
        footer.extend(self.buttons);
        children.push(Node::row("footer", footer).gap(2));
        Node::column(ROOT, children).gap(1)
    }
}

/// The modal layer that presents one sheet at a time.
pub struct Layer<M> {
    surface: Surface<M>,
    shown: Option<String>,
    /// Sheets this one was reached from, newest last: returning to one
    /// (a sub-view closing, a review going back to editing) resumes its
    /// focus instead of opening fresh.
    earlier: Vec<(String, Surface<M>)>,
    /// The drawn box; clicks outside it dismiss.
    area: Option<Rect>,
    /// Where the shown sheet opened: the area it centered in and its top.
    top: Option<(Rect, u16)>,
}

/// Deep enough for a flow and its sub-views; older steps open fresh.
const EARLIER: usize = 8;

impl<M> Default for Layer<M> {
    fn default() -> Self {
        Self {
            surface: Surface::default(),
            shown: None,
            earlier: vec![],
            area: None,
            top: None,
        }
    }
}

impl<M: Clone> Layer<M> {
    /// Centers the sheet over `area`. Returns false, leaving nothing
    /// clickable, when it does not fit; the caller says so instead.
    pub fn render(
        &mut self,
        frame: &mut Frame<'_>,
        area: Rect,
        mut sheet: Sheet<M>,
        context: Context,
    ) -> bool {
        let width = WIDTH.min(area.width.saturating_sub(2));
        // Border and padding: two cells a side, one row above and below.
        let inner = content_width(area.width);
        let fits_footer = inner >= sheet.footer_width().max(MIN_WIDTH);
        let key = sheet.key.clone();
        let focus = sheet.focus.take();
        let tree = sheet.tree();
        let height = layout::height(&tree, inner).saturating_add(4);
        if !fits_footer || height > area.height.saturating_sub(2) {
            self.area = None;
            self.top = None;
            self.surface.invalidate();
            return false;
        }
        if self.shown.as_ref() != Some(&key) {
            self.top = None;
            let left = std::mem::take(&mut self.surface);
            if let Some(shown) = self.shown.take() {
                self.earlier.push((shown, left));
                if self.earlier.len() > EARLIER {
                    self.earlier.remove(0);
                }
            }
            match self
                .earlier
                .iter()
                .rposition(|(earlier, _)| *earlier == key)
            {
                Some(index) => {
                    // Back to an earlier step: steps reached from it are gone.
                    self.surface = self.earlier.remove(index).1;
                    self.earlier.truncate(index);
                }
                None => {
                    if let Some(focus) = focus {
                        self.surface.focus(focus);
                    }
                }
            }
            self.shown = Some(key);
        }
        // Content that changes while shown (a status arriving, an error
        // appearing) grows the sheet downward from where it opened rather
        // than moving what the pointer is aiming at; a new step, a resize or
        // a sheet that no longer fits centers again.
        let top = self
            .top
            .filter(|(placed, top)| *placed == area && top + height < area.bottom())
            .map_or(area.y + (area.height - height) / 2, |(_, top)| top);
        self.top = Some((area, top));
        let rect = Rect::new(area.x + (area.width - width) / 2, top, width, height);
        // The page stays visible but recedes, so the sheet is what reads.
        frame
            .buffer_mut()
            .set_style(area, Style::default().add_modifier(Modifier::DIM));
        crate::view::clear_overlay(frame, rect);
        let block = Block::bordered()
            .border_type(if context.ascii {
                BorderType::Plain
            } else {
                BorderType::Rounded
            })
            .border_style(Style::default().fg(context.colors.border))
            .style(context.colors.base());
        // One cell of breathing room inside the border on every side.
        let content = block.inner(rect).inner(Margin::new(1, 1));
        frame.render_widget(block, rect);
        let context = Context {
            focused: true,
            ..context
        };
        self.surface.render(frame, content, tree, context);
        self.area = Some(rect);
        true
    }

    /// Where the owner draws field `key`, as committed by the last frame.
    pub fn slot(&self, key: &str) -> Option<Rect> {
        self.area?;
        self.surface.rect(&format!("{ROOT}/{key}/{INPUT}"))
    }

    /// Whether field `key` holds the keyboard focus.
    pub fn focused(&self, key: &str) -> bool {
        self.surface.focused() == Some(&format!("{ROOT}/{key}/{INPUT}"))
    }

    /// The owner took a pointer press into field `key`.
    pub fn focus(&mut self, key: &str) {
        self.surface.move_focus(format!("{ROOT}/{key}/{INPUT}"));
    }

    /// Where the node at `path` below the sheet was drawn (an owner-drawn
    /// row among several); empty when scrolled out.
    pub fn rect(&self, path: &str) -> Option<Rect> {
        self.area?;
        self.surface.rect(&format!("{ROOT}/{path}"))
    }

    /// The focused node's path below the sheet.
    pub fn focused_path(&self) -> Option<&str> {
        self.surface
            .focused()?
            .strip_prefix(ROOT)?
            .strip_prefix('/')
    }

    pub fn focus_path(&mut self, path: &str) {
        self.surface.move_focus(format!("{ROOT}/{path}"));
    }

    /// Geometry changed: nothing is clickable until the next draw.
    pub fn invalidate(&mut self) {
        self.area = None;
        self.surface.invalidate();
    }

    /// No sheet is shown; the next one opens fresh.
    pub fn close(&mut self) {
        self.shown = None;
        self.earlier.clear();
        self.area = None;
        self.top = None;
        self.surface.leave();
    }

    /// Modal: every key, paste and pointer event is consumed except shell
    /// chords (Ctrl, Alt, Super), which stay reachable for quitting. `dismiss`
    /// is what a click outside the box sends, and Esc unless `back` names
    /// the previous step; both come from the current state, never a frame.
    pub fn input(&mut self, event: &Event, dismiss: M, back: Option<M>) -> Outcome<M> {
        let consumed = |outcome: Outcome<M>| Outcome {
            consumed: true,
            ..outcome
        };
        match event {
            Event::Key(key) if key.kind != KeyEventKind::Release => {
                if key.modifiers.intersects(
                    KeyModifiers::CONTROL
                        | KeyModifiers::ALT
                        | KeyModifiers::SUPER
                        | KeyModifiers::META,
                ) {
                    return Outcome::ignored();
                }
                if key.code == KeyCode::Esc && !self.surface.captures() {
                    return Outcome::emit(back.unwrap_or(dismiss));
                }
                let outcome = self.surface.input(event);
                if !outcome.consumed
                    && matches!(key.code, KeyCode::Tab | KeyCode::BackTab)
                    && self.area.is_some()
                {
                    // Past either end, focus wraps: there is nowhere else to go.
                    self.surface.enter(
                        key.code == KeyCode::BackTab || key.modifiers.contains(KeyModifiers::SHIFT),
                    );
                    return Outcome::handled(true);
                }
                consumed(outcome)
            }
            Event::Mouse(mouse) => {
                let outside = self
                    .area
                    .is_some_and(|area| !area.contains(Position::new(mouse.column, mouse.row)));
                if outside
                    && mouse.kind == MouseEventKind::Down(MouseButton::Left)
                    && !self.surface.captures()
                {
                    return Outcome::emit(dismiss);
                }
                consumed(self.surface.input(event))
            }
            Event::Resize(..) | Event::FocusLost | Event::FocusGained => self.surface.input(event),
            _ => Outcome::handled(false),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::{KeyEvent, MouseEvent};
    use ratatui::{Terminal, backend::TestBackend};

    #[derive(Clone, Debug, PartialEq)]
    enum Message {
        Cancel,
        Archive,
        Dismiss,
    }

    fn sheet(key: &str, archive: bool) -> Sheet<Message> {
        Sheet::new(key, "Put this session away?")
            .text(
                "note",
                "History is kept.\n\nYou can restore it later.",
                Tone::Subtle,
            )
            .button(
                "cancel",
                "Cancel".into(),
                Role::Normal,
                Message::Cancel,
                true,
            )
            .button(
                "archive",
                "Archive".into(),
                Role::Primary,
                Message::Archive,
                archive,
            )
            .focus("cancel")
    }

    fn draw(
        layer: &mut Layer<Message>,
        sheet: Sheet<Message>,
        width: u16,
        height: u16,
    ) -> (bool, Terminal<TestBackend>) {
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        let mut shown = false;
        terminal
            .draw(|frame| {
                let context = Context {
                    colors: crate::theme::Palette::default(),
                    ascii: false,
                    focused: false,
                };
                shown = layer.render(frame, frame.area(), sheet, context);
            })
            .unwrap();
        (shown, terminal)
    }

    fn locate(terminal: &Terminal<TestBackend>, text: &str) -> (u16, u16) {
        let buffer = terminal.backend().buffer();
        for y in 0..buffer.area.height {
            let line: String = (0..buffer.area.width)
                .map(|x| buffer[(x, y)].symbol())
                .collect();
            if let Some(byte) = line.find(text) {
                return (
                    unicode_width::UnicodeWidthStr::width(&line[..byte]) as u16,
                    y,
                );
            }
        }
        panic!("{text:?} is not on screen");
    }

    fn key(code: KeyCode) -> Event {
        Event::Key(KeyEvent::new(code, KeyModifiers::NONE))
    }
    fn click(x: u16, y: u16) -> Event {
        Event::Mouse(MouseEvent {
            kind: MouseEventKind::Down(MouseButton::Left),
            column: x,
            row: y,
            modifiers: KeyModifiers::NONE,
        })
    }

    #[test]
    fn sheets_focus_their_default_wrap_tab_and_dismiss_from_outside() {
        let mut layer = Layer::default();
        let (shown, terminal) = draw(&mut layer, sheet("a", true), 80, 24);
        assert!(shown);
        let mut send = |event: Event| layer.input(&event, Message::Dismiss, None).message;
        assert_eq!(
            send(key(KeyCode::Enter)),
            Some(Message::Cancel),
            "Enter alone commits nothing"
        );
        send(key(KeyCode::Tab));
        assert_eq!(send(key(KeyCode::Enter)), Some(Message::Archive));
        send(key(KeyCode::Tab));
        assert_eq!(
            send(key(KeyCode::Char(' '))),
            Some(Message::Cancel),
            "Tab past the last button wraps to the first"
        );
        let (x, y) = locate(&terminal, "Put this");
        assert_eq!(send(click(x, y)), None, "prose inside the box is inert");
        let (x, y) = locate(&terminal, "Archive");
        assert_eq!(send(click(x, y)), Some(Message::Archive));
        assert_eq!(send(click(0, 0)), Some(Message::Dismiss));
        let quit = Event::Key(KeyEvent::new(KeyCode::Char('q'), KeyModifiers::CONTROL));
        let outcome = layer.input(&quit, Message::Dismiss, None);
        assert!(!outcome.consumed, "shell chords stay reachable");
        let paste = layer.input(&Event::Paste("text".into()), Message::Dismiss, None);
        assert!(
            paste.consumed && paste.message.is_none(),
            "nothing reaches the page"
        );
    }

    #[test]
    fn fields_open_focused_submit_on_enter_and_steps_go_back_on_esc() {
        let form = || {
            Sheet::new("rename", "Rename session")
                .field("field", None, 1, Message::Archive, true)
                .button(
                    "cancel",
                    "Cancel".into(),
                    Role::Normal,
                    Message::Cancel,
                    true,
                )
        };
        let mut layer = Layer::default();
        let (_, terminal) = draw(&mut layer, form(), 80, 24);
        assert!(layer.focused("field"), "a field is where a form opens");
        let slot = layer.slot("field").expect("the owner learns where to draw");
        assert_eq!(slot.height, 1);
        assert_eq!(
            layer
                .input(&key(KeyCode::Enter), Message::Dismiss, None)
                .message,
            Some(Message::Archive)
        );
        layer.input(&key(KeyCode::Tab), Message::Dismiss, None);
        assert!(!layer.focused("field"));
        assert!(locate(&terminal, "Cancel").1 > slot.y);
        assert_eq!(
            layer
                .input(&click(slot.x, slot.y), Message::Dismiss, None)
                .message,
            None,
            "clicking into a field focuses it, never submits"
        );
        assert!(layer.focused("field"));
        let back = Some(Message::Cancel);
        assert_eq!(
            layer
                .input(&key(KeyCode::Esc), Message::Dismiss, back.clone())
                .message,
            Some(Message::Cancel),
            "a step goes back"
        );
        assert_eq!(
            layer.input(&click(0, 0), Message::Dismiss, back).message,
            Some(Message::Dismiss),
            "outside still dismisses"
        );
    }

    #[test]
    fn viewers_grow_to_their_cap_scroll_by_keyboard_and_otherwise_pass_focus_on() {
        let viewer = |count: usize| {
            let rows = (0..count)
                .map(|index| {
                    Node::text(
                        index.to_string(),
                        vec![(format!("line {index}"), Tone::Normal)],
                    )
                })
                .collect();
            Sheet::new("viewer", "Viewer")
                .body(
                    Node::scroll("view", Node::column("rows", rows))
                        .on(On::Scroll)
                        .size(Size::Upto(4)),
                )
                .button("close", "Close".into(), Role::Normal, Message::Cancel, true)
        };
        let shown = |terminal: &Terminal<TestBackend>, text: &str| {
            let buffer = terminal.backend().buffer();
            (0..buffer.area.height).any(|y| {
                (0..buffer.area.width)
                    .map(|x| buffer[(x, y)].symbol())
                    .collect::<String>()
                    .contains(text)
            })
        };
        let mut layer = Layer::default();
        let (_, terminal) = draw(&mut layer, viewer(10), 60, 24);
        assert!(
            shown(&terminal, "line 3") && !shown(&terminal, "line 4"),
            "capped at 4 rows"
        );
        layer.input(&key(KeyCode::Down), Message::Dismiss, None);
        let (_, terminal) = draw(&mut layer, viewer(10), 60, 24);
        assert!(shown(&terminal, "line 4") && !shown(&terminal, "line 0"));
        layer.input(&key(KeyCode::End), Message::Dismiss, None);
        let (_, terminal) = draw(&mut layer, viewer(10), 60, 24);
        assert!(shown(&terminal, "line 9"));
        // Short content has nothing to scroll; Tab still moves on to Close.
        let mut layer = Layer::default();
        let (_, terminal) = draw(&mut layer, viewer(2), 60, 24);
        assert!(shown(&terminal, "line 1"));
        let down = layer.input(&key(KeyCode::Down), Message::Dismiss, None);
        assert!(down.message.is_none() && !down.redraw);
        layer.input(&key(KeyCode::Tab), Message::Dismiss, None);
        assert_eq!(
            layer
                .input(&key(KeyCode::Enter), Message::Dismiss, None)
                .message,
            Some(Message::Cancel)
        );
    }

    #[test]
    fn returning_to_an_earlier_sheet_resumes_its_focus_until_the_layer_closes() {
        let mut layer = Layer::default();
        let enter = |layer: &mut Layer<Message>| {
            layer
                .input(&key(KeyCode::Enter), Message::Dismiss, None)
                .message
        };
        draw(&mut layer, sheet("form", true), 80, 24);
        layer.input(&key(KeyCode::Tab), Message::Dismiss, None);
        draw(&mut layer, sheet("browser", true), 80, 24);
        assert_eq!(
            enter(&mut layer),
            Some(Message::Cancel),
            "a sub-view opens fresh"
        );
        draw(&mut layer, sheet("form", true), 80, 24);
        assert_eq!(
            enter(&mut layer),
            Some(Message::Archive),
            "back where the reader left it"
        );
        layer.close();
        draw(&mut layer, sheet("form", true), 80, 24);
        assert_eq!(
            enter(&mut layer),
            Some(Message::Cancel),
            "reopening starts over"
        );
    }

    #[test]
    fn a_sheet_that_does_not_fit_presents_nothing_to_activate() {
        let mut layer = Layer::default();
        draw(&mut layer, sheet("a", true), 80, 24);
        layer.input(&key(KeyCode::Tab), Message::Dismiss, None);
        let (shown, _) = draw(&mut layer, sheet("a", true), 30, 8);
        assert!(!shown);
        let outcome = layer.input(&key(KeyCode::Enter), Message::Dismiss, None);
        assert!(outcome.consumed && outcome.message.is_none());
        assert_eq!(
            layer
                .input(&key(KeyCode::Esc), Message::Dismiss, None)
                .message,
            Some(Message::Dismiss),
            "Esc still leaves"
        );
        // A new sheet starts from its default; a disabled button is skipped.
        draw(&mut layer, sheet("b", false), 80, 24);
        layer.input(&key(KeyCode::Tab), Message::Dismiss, None);
        assert_eq!(
            layer
                .input(&key(KeyCode::Enter), Message::Dismiss, None)
                .message,
            Some(Message::Cancel)
        );
    }

    #[test]
    fn a_shown_sheet_grows_downward_and_a_new_step_centers() {
        let mut layer = Layer::default();
        let title = "Put this session away?";
        let (_, terminal) = draw(&mut layer, sheet("a", true), 60, 24);
        let top = locate(&terminal, title).1;
        let grown = |key| sheet(key, true).text("more", "One.\nTwo.\nThree.", Tone::Subtle);
        let (_, terminal) = draw(&mut layer, grown("a"), 60, 24);
        assert_eq!(locate(&terminal, title).1, top, "a status arriving");
        let (_, terminal) = draw(&mut layer, grown("b"), 60, 24);
        assert_eq!(locate(&terminal, title).1, top - 2, "the next step");
    }
}
