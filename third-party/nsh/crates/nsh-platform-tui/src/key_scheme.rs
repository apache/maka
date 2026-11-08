//! Terminal keys select actions; focus, navigation and scrolling execute them.

use nsh_core::keymap::{Key, Keystroke, Modifiers};

#[derive(Clone, Copy)]
pub(crate) enum Action {
    /// The next control in tree order (Tab, Ctrl+N), wrapping.
    Next,
    /// The previous control in tree order (Shift+Tab, Ctrl+P), wrapping.
    Previous,
    /// The control below (Down), scrolling to reach it.
    Down,
    /// The control above (Up), scrolling to reach it.
    Up,
    Right,
    Left,
    Activate,
    Back,
    PageDown,
    PageUp,
    Start,
    End,
    /// Opens the Minibuffer: forward (`true`) or backward.
    Search(bool),
    Quit,
}

pub(crate) fn keystroke(name: &str, mut modifiers: Modifiers) -> Option<Keystroke> {
    let mut chars = name.chars();
    let key = if let (Some(c), None) = (chars.next(), chars.next()) {
        const SHIFTED: &str = "~!@#$%^&*()_+{}|:\"<>?";
        const BASE: &str = "`1234567890-=[]\\;',./";
        if let Some((_, base)) = SHIFTED
            .chars()
            .zip(BASE.chars())
            .find(|(shifted, _)| *shifted == c)
        {
            modifiers.shift = true;
            Key::Char(base)
        } else {
            modifiers.shift |= c.is_ascii_uppercase();
            Key::Char(c.to_ascii_lowercase())
        }
    } else {
        Keystroke::parse(name, nsh_core::platform::Os::default())
            .ok()?
            .key
    };
    Some(Keystroke { key, modifiers })
}

/// The arrow key a terminal alias stands for (`Ctrl+F` is Right, `Ctrl+B`
/// Left), so the app's bindings of the arrows (a tab list's, a radio
/// group's roving keys) answer the alias as they answer the arrow before it
/// falls back to moving the focus.
pub(crate) fn arrow(stroke: Keystroke) -> Option<Keystroke> {
    let key = match terminal(stroke)? {
        Action::Right if stroke.modifiers.ctrl => Key::Right,
        Action::Left if stroke.modifiers.ctrl => Key::Left,
        _ => return None,
    };
    Some(Keystroke {
        key,
        modifiers: Modifiers::default(),
    })
}

pub(crate) fn terminal(stroke: Keystroke) -> Option<Action> {
    let Keystroke { key, modifiers: m } = stroke;
    if m.cmd {
        return None;
    }
    if m.ctrl && !m.alt && !m.shift {
        return Some(match key {
            Key::Char('n') => Action::Next,
            Key::Char('p') => Action::Previous,
            Key::Char('f') => Action::Right,
            Key::Char('b') => Action::Left,
            Key::Char('g') => Action::Back,
            Key::Char('v') => Action::PageDown,
            Key::Char('s') => Action::Search(true),
            Key::Char('r') => Action::Search(false),
            Key::Char('c') => Action::Quit,
            _ => return None,
        });
    }
    if m.alt && !m.ctrl {
        return Some(match (key, m.shift) {
            (Key::Char('v'), false) => Action::PageUp,
            (Key::Char(','), true) => Action::Start,
            (Key::Char('.'), true) => Action::End,
            _ => return None,
        });
    }
    if m.ctrl || m.alt {
        return None;
    }
    if key == Key::Tab {
        return Some(if m.shift {
            Action::Previous
        } else {
            Action::Next
        });
    }
    if m.shift {
        return None;
    }
    Some(match key {
        Key::Down => Action::Down,
        Key::Up => Action::Up,
        Key::Right => Action::Right,
        Key::Left => Action::Left,
        Key::Enter | Key::Char(' ') => Action::Activate,
        Key::Escape => Action::Back,
        Key::PageDown => Action::PageDown,
        Key::PageUp => Action::PageUp,
        Key::Home => Action::Start,
        Key::End => Action::End,
        _ => return None,
    })
}

#[derive(Clone, Copy)]
pub(crate) enum EditAction {
    Move(nsh_core::text_edit::Unit, bool),
    Boundary(bool),
    Document(bool),
    Vertical(bool),
    Delete(nsh_core::text_edit::Unit, bool),
    KillLine(bool),
    KillWord(bool),
    KillWhitespaceWord,
    ReadlineWord(bool),
    Yank,
    Transpose,
    SelectAll,
    Copy,
    Cut,
    Paste,
    Undo,
    Redo,
    Enter(bool),
    Leave,
}

pub(crate) fn editing(stroke: Keystroke, multiline: bool) -> Option<EditAction> {
    use EditAction::*;
    use nsh_core::text_edit::Unit::{Char, Word};
    let Keystroke { key, modifiers: m } = stroke;
    if m.cmd || (m.ctrl && m.shift && !m.alt && matches!(key, Key::Char(_))) {
        return Some(match key {
            Key::Char('a') => SelectAll,
            Key::Char('c') => Copy,
            Key::Char('x') => Cut,
            Key::Char('v') => Paste,
            Key::Char('z') => {
                if m.shift {
                    Redo
                } else {
                    Undo
                }
            }
            _ => return None,
        });
    }
    if m.ctrl && !m.alt && !m.shift {
        return Some(match key {
            Key::Char('a') => Boundary(false),
            Key::Char('e') => Boundary(true),
            Key::Char('f') => Move(Char, true),
            Key::Char('b') => Move(Char, false),
            Key::Char('d') => Delete(Char, true),
            Key::Char('h') => Delete(Char, false),
            Key::Char('k') => KillLine(true),
            Key::Char('u') => KillLine(false),
            Key::Char('w') => KillWhitespaceWord,
            Key::Char('y') => Yank,
            Key::Char('t') => Transpose,
            Key::Char('g') => Leave,
            Key::Char('n') if multiline => Vertical(true),
            Key::Char('p') if multiline => Vertical(false),
            Key::Char('v') => Paste,
            Key::Char('z') => Undo,
            Key::Insert => Copy,
            Key::Home => Document(false),
            Key::End => Document(true),
            Key::Left => Move(Word, false),
            Key::Right => Move(Word, true),
            Key::Backspace => Delete(Word, false),
            Key::Delete => Delete(Word, true),
            _ => return None,
        });
    }
    if m.alt && !m.ctrl {
        return Some(match key {
            Key::Char('f') => ReadlineWord(true),
            Key::Right => Move(Word, true),
            Key::Char('b') => ReadlineWord(false),
            Key::Left => Move(Word, false),
            Key::Char('d') => KillWord(true),
            Key::Backspace => KillWord(false),
            Key::Char('w') => Copy,
            Key::Char(',') if m.shift => Document(false),
            Key::Char('.') if m.shift => Document(true),
            Key::Enter => Enter(true),
            _ => return None,
        });
    }
    if m.ctrl && m.shift && matches!(key, Key::Left | Key::Right) {
        return Some(Move(Word, key == Key::Right));
    }
    if m.ctrl || m.alt {
        return None;
    }
    Some(match key {
        Key::Left => Move(Char, false),
        Key::Right => Move(Char, true),
        Key::Up if multiline => Vertical(false),
        Key::Down if multiline => Vertical(true),
        Key::Home => Boundary(false),
        Key::End => Boundary(true),
        Key::Backspace => Delete(Char, false),
        Key::Delete if m.shift => Cut,
        Key::Delete => Delete(Char, true),
        Key::Insert if m.shift => Paste,
        Key::Enter => Enter(m.shift),
        Key::Escape => Leave,
        _ => return None,
    })
}
