//! System dialogs: `AlertDialog`'s alerts and action sheets
//! ([`nsh_core::Command::Dialog`]), drawn by the backend in the terminal's
//! own look as the other backends show the system's (`NSAlert`, UIKit's and
//! Android's alerts): what is behind dims, the dialog is a cleared box with
//! a rounded dim border, its title in the border, its message wrapped
//! inside, and its buttons as `< Label >` in a row at the bottom right (an
//! action sheet's options as rows); the focused button is reversed, the
//! default one bold, a destructive one red. Every label is the app's.
//!
//! The oldest dialog shown is on top until answered; it takes every key and
//! press. Left / Right, Up / Down and Tab / Shift+Tab move between the
//! buttons, Enter and Space choose the focused one, Escape answers the
//! cancel button (or dismisses a cancelable dialog); a press on a button
//! chooses it, a press outside dismisses a cancelable dialog. The answer
//! is [`EventKind::Dialog`] on the root with the button's index, `-1` when
//! dismissed.

use nsh_core::{
    Dialog, DialogButtonStyle, EventKind, EventPayload, PayloadValue, ROOT_ID,
    keymap::{Key, Modifiers},
};
use ratatui_core::{
    buffer::Buffer,
    layout::{Position, Rect},
    style::{Color, Modifier},
};
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

use crate::{
    key_scheme,
    palette::{Ramp, SELECT},
};

/// The widest a dialog's box grows, in Cells, border included.
const MAX_WIDTH: u16 = 64;
/// The gap between two buttons in a row.
const BUTTON_GAP: u16 = 2;

/// A dialog's answer: what the root's `onDialog` gets.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Answer {
    /// The dialog's id, echoed.
    pub(crate) id: u32,
    /// The chosen button's index; `-1` when dismissed.
    pub(crate) index: i32,
}

impl Answer {
    /// Sends the answer to the app.
    pub(crate) fn dispatch(self, control: &nsh_engine::EngineControl) {
        control.dispatch_event(
            ROOT_ID,
            EventKind::Dialog,
            EventPayload::Map(vec![
                ("id", PayloadValue::Number(f64::from(self.id))),
                ("index", PayloadValue::Number(f64::from(self.index))),
            ]),
        );
    }
}

/// What a key or press did while a dialog is shown.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Outcome {
    /// The dialog took it and stays shown.
    Taken,
    /// The dialog was answered (and is gone).
    Answered(Answer),
}

/// A shown dialog and where its parts were last drawn.
pub(crate) struct SystemDialog {
    dialog: Dialog,
    /// The buttons' indices in the order they are shown.
    order: Vec<usize>,
    /// The focused entry of `order`.
    focused: usize,
    /// The box, as last drawn.
    rect: Rect,
    /// Each shown button's Cells, by entry of `order`.
    buttons: Vec<Rect>,
}

impl SystemDialog {
    pub(crate) fn new(dialog: Dialog) -> Self {
        let buttons = &dialog.buttons;
        let cancel = buttons
            .iter()
            .position(|b| b.style == DialogButtonStyle::Cancel);
        // An alert's row reads with its cancel button first (leftmost, as
        // iOS and macOS lay out two buttons); an action sheet lists its
        // options with the cancel one last.
        let mut order: Vec<usize> = (0..buttons.len()).filter(|i| Some(*i) != cancel).collect();
        if dialog.sheet {
            order.extend(cancel);
        } else if let Some(cancel) = cancel {
            order.insert(0, cancel);
        }
        // An action sheet is a list read from its first row; an alert's
        // focus starts on its last default button (the primary one), else
        // its last button that is not the cancel one.
        let focused = if dialog.sheet {
            0
        } else {
            order
                .iter()
                .rposition(|&i| buttons[i].style == DialogButtonStyle::Default)
                .or_else(|| order.iter().rposition(|&i| Some(i) != cancel))
                .unwrap_or(0)
        };
        Self {
            dialog,
            order,
            focused,
            rect: Rect::default(),
            buttons: Vec::new(),
        }
    }

    fn answer(&self, index: i32) -> Outcome {
        Outcome::Answered(Answer {
            id: self.dialog.id,
            index,
        })
    }

    /// What Escape or a press outside answers: the cancel button, else a
    /// dismissal when the dialog is cancelable.
    fn cancel(&self, escape: bool) -> Outcome {
        if let Some(cancel) = self
            .dialog
            .buttons
            .iter()
            .position(|b| b.style == DialogButtonStyle::Cancel)
            .filter(|_| escape)
        {
            return self.answer(cancel as i32);
        }
        if self.dialog.cancelable || self.dialog.buttons.is_empty() {
            self.answer(-1)
        } else {
            Outcome::Taken
        }
    }

    fn step(&mut self, forward: bool) {
        let count = self.order.len();
        if count > 0 {
            self.focused = if forward {
                (self.focused + 1) % count
            } else {
                (self.focused + count - 1) % count
            };
        }
    }

    fn key(&mut self, name: &str, modifiers: Modifiers) -> Outcome {
        let Some(stroke) = key_scheme::keystroke(name, modifiers) else {
            return Outcome::Taken;
        };
        let m = stroke.modifiers;
        if m.ctrl || m.alt || m.cmd {
            return Outcome::Taken;
        }
        match stroke.key {
            Key::Tab => self.step(!m.shift),
            Key::Right | Key::Down => self.step(true),
            Key::Left | Key::Up => self.step(false),
            Key::Home => self.focused = 0,
            Key::End => self.focused = self.order.len().saturating_sub(1),
            Key::Enter | Key::Char(' ') => {
                return match self.order.get(self.focused) {
                    Some(&index) => self.answer(index as i32),
                    None => self.answer(-1),
                };
            }
            Key::Escape => return self.cancel(true),
            _ => {}
        }
        Outcome::Taken
    }

    fn press(&mut self, position: Position) -> Outcome {
        if let Some(entry) = self.buttons.iter().position(|r| r.contains(position)) {
            self.focused = entry;
            return self.answer(self.order[entry] as i32);
        }
        if self.rect.contains(position) {
            Outcome::Taken
        } else {
            self.cancel(false)
        }
    }

    /// Draws the dialog centered in `area`, over the page as it is (a
    /// terminal shows no scrim), on the terminal's surfaces `ramp` (`None`: the bandless look, its buttons
    /// in angle brackets).
    fn draw(&mut self, buffer: &mut Buffer, area: Rect, ramp: Option<Ramp>) {
        let area = area.intersection(buffer.area);
        if area.width < 6 || area.height < 3 {
            self.rect = Rect::default();
            self.buttons.clear();
            return;
        }
        let max = area.width.saturating_sub(4).clamp(6, MAX_WIDTH);
        let inner_max = max - 4;
        let labels: Vec<String> = self
            .order
            .iter()
            .map(|&i| match ramp {
                Some(_) => self.dialog.buttons[i].text.to_string(),
                None => format!("< {} >", self.dialog.buttons[i].text),
            })
            .collect();
        let row: u16 = labels.iter().map(|l| width(l)).sum::<u16>()
            + BUTTON_GAP * labels.len().saturating_sub(1) as u16;
        let title = self.dialog.title.as_deref().unwrap_or_default();
        let widest_option = labels.iter().map(|l| width(l)).max().unwrap_or(0);
        let message = self.dialog.message.as_deref().unwrap_or_default();
        let wanted = [
            width(title) + 2,
            width(message),
            if self.dialog.sheet {
                widest_option
            } else {
                row
            },
        ]
        .into_iter()
        .max()
        .unwrap_or(0)
        .clamp(12, inner_max);
        let lines = wrap(message, wanted);
        let buttons_rows = if self.dialog.sheet {
            self.order.len() as u16
        } else {
            u16::from(!self.order.is_empty())
        };
        let gap = u16::from(!lines.is_empty() && buttons_rows > 0);
        let height = (lines.len() as u16 + gap + buttons_rows + 2).min(area.height);
        let width = wanted + 4;
        let rect = Rect::new(
            area.x + (area.width - width) / 2,
            area.y + (area.height - height) / 2,
            width,
            height,
        );
        self.rect = rect;
        clear(buffer, rect);
        frame(buffer, rect, title, ramp);
        let inner = Rect::new(rect.x + 2, rect.y + 1, wanted, height.saturating_sub(2));
        let mut y = inner.y;
        for line in &lines {
            if y >= inner.bottom() {
                break;
            }
            put(
                buffer,
                inner.x,
                y,
                line,
                inner.width,
                Color::Reset,
                Modifier::empty(),
            );
            y += 1;
        }
        y += gap;
        self.buttons.clear();
        let style = |dialog: &Self, entry: usize| {
            let button = &dialog.dialog.buttons[dialog.order[entry]];
            let color = match button.style {
                DialogButtonStyle::Destructive => Color::Red,
                _ => Color::Reset,
            };
            let mut modifier = Modifier::empty();
            if button.style == DialogButtonStyle::Default {
                modifier |= Modifier::BOLD;
            }
            if entry == dialog.focused {
                // A band where the terminal has surfaces, else reverse video.
                modifier |= if ramp.is_some() {
                    Modifier::BOLD
                } else {
                    Modifier::REVERSED
                };
            }
            (color, modifier)
        };
        let band = |buffer: &mut Buffer, rect: Rect| {
            if let Some(ramp) = ramp {
                for x in rect.x..rect.right() {
                    buffer[(x, rect.y)].bg = ramp.level(SELECT);
                }
            }
        };
        if self.dialog.sheet {
            for (entry, label) in labels.iter().enumerate() {
                if y >= inner.bottom() {
                    break;
                }
                let (color, modifier) = style(self, entry);
                let text = if ramp.is_some() {
                    label.as_str()
                } else {
                    &label[2..label.len() - 2]
                };
                let row = Rect::new(inner.x, y, inner.width, 1);
                put(buffer, row.x, y, text, row.width, color, modifier);
                if entry == self.focused {
                    if ramp.is_some() {
                        band(buffer, row);
                    } else {
                        for x in row.x..row.right() {
                            buffer[(x, y)].modifier.insert(Modifier::REVERSED);
                        }
                    }
                }
                self.buttons.push(row);
                y += 1;
            }
        } else if y < inner.bottom() {
            let mut x = inner.right().saturating_sub(row.min(inner.width));
            for (entry, label) in labels.iter().enumerate() {
                let (color, modifier) = style(self, entry);
                let shown = put(buffer, x, y, label, inner.right() - x, color, modifier);
                if entry == self.focused {
                    band(buffer, Rect::new(x, y, shown, 1));
                }
                self.buttons.push(Rect::new(x, y, shown, 1));
                x = (x + shown + BUTTON_GAP).min(inner.right());
            }
        }
    }
}

/// The dialogs shown, oldest first.
#[derive(Default)]
pub(crate) struct Dialogs {
    shown: Vec<SystemDialog>,
}

impl Dialogs {
    pub(crate) fn show(&mut self, dialog: Dialog) {
        self.shown.push(SystemDialog::new(dialog));
    }

    /// Whether a dialog is shown (and takes all input).
    pub(crate) fn is_shown(&self) -> bool {
        !self.shown.is_empty()
    }

    pub(crate) fn clear(&mut self) {
        self.shown.clear();
    }

    /// Hands a key to the top dialog; `None` when none is shown.
    pub(crate) fn key(&mut self, name: &str, modifiers: Modifiers) -> Option<Outcome> {
        let outcome = self.shown.first_mut()?.key(name, modifiers);
        Some(self.settle(outcome))
    }

    /// Hands a press at `position` to the top dialog; `None` when none is
    /// shown.
    pub(crate) fn press(&mut self, position: Position) -> Option<Outcome> {
        let outcome = self.shown.first_mut()?.press(position);
        Some(self.settle(outcome))
    }

    fn settle(&mut self, outcome: Outcome) -> Outcome {
        if matches!(outcome, Outcome::Answered(_)) {
            self.shown.remove(0);
        }
        outcome
    }

    /// Draws the top dialog over everything in `area`, on the terminal's
    /// surfaces `ramp` when it has them.
    pub(crate) fn draw(&mut self, buffer: &mut Buffer, area: Rect, ramp: Option<Ramp>) {
        if let Some(dialog) = self.shown.first_mut() {
            dialog.draw(buffer, area, ramp);
        }
    }
}

/// Empties the Cells of `rect`: a popup's box over what is behind it.
pub(crate) fn clear(buffer: &mut Buffer, rect: Rect) {
    let rect = rect.intersection(buffer.area);
    for y in rect.y..rect.bottom() {
        for x in rect.x..rect.right() {
            buffer[(x, y)].reset();
        }
    }
}

/// A rounded box on the edge Cells of `rect`, `title` in its top border
/// (bold, in the default foreground): in the border color of the
/// terminal's surfaces (`ramp`), its title set off as `─ Title ─`, else dim.
pub(crate) fn frame(buffer: &mut Buffer, rect: Rect, title: &str, ramp: Option<Ramp>) {
    let rect = rect.intersection(buffer.area);
    if rect.width < 2 || rect.height < 2 {
        return;
    }
    let (line, modifier) = match ramp {
        Some(ramp) => (ramp.border(), Modifier::empty()),
        None => (Color::Reset, Modifier::DIM),
    };
    let (right, bottom) = (rect.right() - 1, rect.bottom() - 1);
    for x in rect.x..=right {
        for (y, symbol) in [(rect.y, "─"), (bottom, "─")] {
            let symbol = match (x == rect.x, x == right, y == rect.y) {
                (true, _, true) => "╭",
                (_, true, true) => "╮",
                (true, _, false) => "╰",
                (_, true, false) => "╯",
                _ => symbol,
            };
            put_one(buffer, x, y, symbol, line, modifier);
        }
    }
    for y in rect.y + 1..bottom {
        put_one(buffer, rect.x, y, "│", line, modifier);
        put_one(buffer, right, y, "│", line, modifier);
    }
    let offset = if ramp.is_some() { 2 } else { 1 };
    if !title.is_empty() && rect.width > 4 + 2 * offset {
        let room = rect.width - 2 - 2 * offset;
        let title = format!(" {title} ");
        let drawn = put(
            buffer,
            rect.x + offset,
            rect.y,
            &title,
            room + 2,
            Color::Reset,
            Modifier::BOLD,
        );
        // A system dialog always holds the focus: its title is an accent
        // chip where the terminal has surfaces.
        if let Some(ramp) = ramp {
            for x in rect.x + offset..rect.x + offset + drawn {
                buffer[(x, rect.y)].bg = Color::Blue;
                buffer[(x, rect.y)].fg = ramp.base();
            }
        }
    }
}

fn put_one(buffer: &mut Buffer, x: u16, y: u16, symbol: &str, color: Color, modifier: Modifier) {
    let cell = &mut buffer[(x, y)];
    cell.set_symbol(symbol);
    cell.fg = color;
    cell.modifier = modifier;
}

/// Writes `text` from `(x, y)` in at most `room` Cells, whole graphemes;
/// returns the Cells written.
pub(crate) fn put(
    buffer: &mut Buffer,
    x: u16,
    y: u16,
    text: &str,
    room: u16,
    color: Color,
    modifier: Modifier,
) -> u16 {
    let end = x.saturating_add(room).min(buffer.area.right());
    let mut at = x;
    for grapheme in text.graphemes(true) {
        let w = grapheme.width() as u16;
        if w == 0 {
            continue;
        }
        if at + w > end {
            break;
        }
        put_one(buffer, at, y, grapheme, color, modifier);
        for after in 1..w {
            put_one(buffer, at + after, y, " ", color, modifier);
        }
        at += w;
    }
    at - x
}

fn width(text: &str) -> u16 {
    text.width().min(usize::from(u16::MAX)) as u16
}

/// `text` wrapped at words to lines of at most `room` Cells (a word wider
/// than that is broken).
fn wrap(text: &str, room: u16) -> Vec<String> {
    let room = usize::from(room.max(1));
    let mut lines = Vec::new();
    for paragraph in text.lines() {
        let mut line = String::new();
        let mut used = 0;
        for word in paragraph.split_word_bounds() {
            let w = word.width();
            if used + w > room && used > 0 {
                lines.push(std::mem::take(&mut line).trim_end().to_owned());
                used = 0;
                if word.trim().is_empty() {
                    continue;
                }
            }
            if w > room {
                for grapheme in word.graphemes(true) {
                    let g = grapheme.width();
                    if used + g > room {
                        lines.push(std::mem::take(&mut line));
                        used = 0;
                    }
                    line.push_str(grapheme);
                    used += g;
                }
            } else {
                line.push_str(word);
                used += w;
            }
        }
        lines.push(line.trim_end().to_owned());
    }
    lines
}

#[cfg(test)]
mod tests {
    use nsh_core::{Dialog, DialogButton, DialogButtonStyle, keymap::Modifiers};
    use ratatui_core::{
        buffer::Buffer,
        layout::{Position, Rect},
        style::Modifier,
    };

    use super::{Answer, Dialogs, Outcome, wrap};

    fn dialog(sheet: bool) -> Dialog {
        let button = |text: &str, style| DialogButton {
            text: text.into(),
            style,
        };
        Dialog {
            id: 7,
            title: Some("Delete file".into()),
            message: Some("This cannot be undone.".into()),
            buttons: vec![
                button("Delete", DialogButtonStyle::Destructive),
                button("Cancel", DialogButtonStyle::Cancel),
            ],
            cancelable: false,
            sheet,
        }
    }

    fn text(buffer: &Buffer, y: u16) -> String {
        (0..buffer.area.width)
            .map(|x| buffer[(x, y)].symbol())
            .collect()
    }

    #[test]
    fn an_alert_is_a_titled_box_with_its_buttons_in_a_row() {
        let mut dialogs = Dialogs::default();
        dialogs.show(dialog(false));
        let mut buffer = Buffer::empty(Rect::new(0, 0, 40, 9));
        buffer.set_string(0, 0, "behind", ratatui_core::style::Style::default());
        let area = buffer.area;
        dialogs.draw(&mut buffer, area, None);
        // No scrim: the page around the box is left as it was.
        assert_eq!(buffer[(0, 0)].symbol(), "b");
        assert_eq!(buffer[(0, 0)].modifier, Modifier::empty());
        let rows: Vec<String> = (0..9).map(|y| text(&buffer, y)).collect();
        let top = rows.iter().position(|r| r.contains("╭")).unwrap();
        assert!(rows[top].contains(" Delete file "), "{rows:#?}");
        assert!(rows[top + 1].contains("This cannot be undone."));
        let buttons = &rows[top + 3];
        let cancel = buttons.find("< Cancel >").unwrap();
        let delete = buttons.find("< Delete >").unwrap();
        assert!(cancel < delete, "{buttons}");
        // The last regular button is focused.
        let x = buttons[..delete].chars().count() as u16;
        assert!(
            buffer[(x, top as u16 + 3)]
                .modifier
                .contains(Modifier::REVERSED)
        );
    }

    #[test]
    fn keys_move_between_buttons_and_choose_one() {
        let mut dialogs = Dialogs::default();
        dialogs.show(dialog(false));
        let none = Modifiers::default();
        assert_eq!(dialogs.key("ArrowLeft", none), Some(Outcome::Taken));
        assert_eq!(
            dialogs.key("Enter", none),
            Some(Outcome::Answered(Answer { id: 7, index: 1 }))
        );
        assert!(!dialogs.is_shown());
        dialogs.show(dialog(false));
        assert_eq!(
            dialogs.key("Escape", none),
            Some(Outcome::Answered(Answer { id: 7, index: 1 }))
        );
        assert_eq!(dialogs.key("Enter", none), None);
    }

    #[test]
    fn presses_choose_buttons_and_outside_dismisses_only_cancelable_dialogs() {
        let mut dialogs = Dialogs::default();
        let mut buffer = Buffer::empty(Rect::new(0, 0, 40, 9));
        let mut sheet = dialog(true);
        sheet.cancelable = true;
        dialogs.show(sheet);
        let area = buffer.area;
        dialogs.draw(&mut buffer, area, None);
        let rows: Vec<String> = (0..9).map(|y| text(&buffer, y)).collect();
        let row = rows
            .iter()
            .position(|r| r.contains("Delete") && !r.contains("file"))
            .unwrap();
        let x = rows[row].find("Delete").unwrap() as u16;
        assert_eq!(
            dialogs.press(Position::new(x, row as u16)),
            Some(Outcome::Answered(Answer { id: 7, index: 0 }))
        );
        let mut sheet = dialog(true);
        sheet.cancelable = true;
        dialogs.show(sheet);
        let area = buffer.area;
        dialogs.draw(&mut buffer, area, None);
        assert_eq!(
            dialogs.press(Position::new(0, 0)),
            Some(Outcome::Answered(Answer { id: 7, index: -1 }))
        );
        dialogs.show(dialog(false));
        let area = buffer.area;
        dialogs.draw(&mut buffer, area, None);
        assert_eq!(dialogs.press(Position::new(0, 0)), Some(Outcome::Taken));
    }

    #[test]
    fn messages_wrap_at_words() {
        assert_eq!(wrap("one two three", 7), ["one two", "three"]);
        assert_eq!(wrap("abcdefghij", 4), ["abcd", "efgh", "ij"]);
    }

    #[test]
    fn on_surfaces_an_alert_leaves_the_page_and_bands_its_focused_button() {
        let ramp =
            crate::palette::Ramp::new(crate::ColorDepth::TrueColor, Some([24; 3]), Some([224; 3]));
        let mut dialogs = Dialogs::default();
        dialogs.show(dialog(false));
        let mut buffer = Buffer::empty(Rect::new(0, 0, 40, 9));
        buffer.set_string(0, 0, "behind", ratatui_core::style::Style::default());
        let area = buffer.area;
        dialogs.draw(&mut buffer, area, ramp);
        assert_eq!(buffer[(0, 0)].modifier, Modifier::empty());
        assert_eq!(
            buffer[(0, 0)].fg,
            ratatui_core::style::Color::Reset,
            "the page keeps its look"
        );
        let rows: Vec<String> = (0..9).map(|y| text(&buffer, y)).collect();
        let top = rows.iter().position(|r| r.contains("╭")).unwrap();
        assert!(rows[top].contains("╭─ Delete file ─"), "{rows:#?}");
        let buttons = &rows[top + 3];
        assert!(!buttons.contains('<'), "{buttons}");
        let delete = buttons.find("Delete").unwrap();
        assert!(buttons.find("Cancel").unwrap() < delete, "{buttons}");
        let x = buttons[..delete].chars().count() as u16;
        let cell = &buffer[(x, top as u16 + 3)];
        assert_eq!(cell.bg, ramp.unwrap().level(crate::palette::SELECT));
        assert!(cell.modifier.contains(Modifier::BOLD));
        assert!(!cell.modifier.contains(Modifier::REVERSED));
    }
}
