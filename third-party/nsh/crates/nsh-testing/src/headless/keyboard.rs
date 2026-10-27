//! The step `keyboard.press(<keys>)`: a key with its modifiers, as a
//! hardware keyboard gives it, on every platform (`open`'s `platform`: the
//! phones and tablets have one too, a tablet's keyboard, a Chromebook's).
//! The app's shortcuts (`nsh/keymap`) take it first, as the platforms'
//! keymaps do: the newest binding of the keystroke that fires where the
//! focus is reports `onKeyCommand`. Else Tab moves the keyboard focus
//! between the inputs and the views that are its stops (those that take
//! presses, and `focusable` ones that take none) where the platform
//! does (macOS, the web), Return and Space press the pressable it is on,
//! the focused input takes the keys that edit it, and Escape goes back.

use nsh_core::{
    Command, EventKind, EventPayload, MountItem, NodeId, PayloadValue, ROOT_ID,
    keymap::{Key, KeyMatch, Keystroke},
    platform::Os,
    tailwind::state::FOCUSED,
};

use super::Headless;

impl Headless {
    /// The step `keyboard.press(<keys>)`: presses `keys`, a keystroke as
    /// `nsh/keymap` names it (`"mod+k"`, `"shift+tab"`, `"escape"`; `mod` is
    /// the app's platform's command key). A binding of the app's keymap
    /// that fires where the focus is hears it (`onKeyCommand`); else the
    /// focused input takes a character, Backspace or the return key, and
    /// Escape goes back as the desktops' back key does when there is
    /// something to go back from.
    pub fn press_key(&mut self, keys: &str) -> Result<(), String> {
        self.step(format!("keyboard.press({keys})"));
        let stroke = Keystroke::parse(keys, self.environment.os).map_err(|e| e.to_string())?;
        let editing = self.screen.focused().is_some();
        // A hardware keyboard fires the app's shortcuts (`on_key`,
        // `keymap.bind`), on every platform.
        let found = match self.screen.keymap() {
            Some(keymap) => keymap.find(stroke, editing, false),
            None => KeyMatch::None,
        };
        if let KeyMatch::Fire(id) = found {
            self.engine.control().dispatch_event(
                ROOT_ID,
                EventKind::KeyCommand,
                EventPayload::Value(PayloadValue::Number(f64::from(id))),
            );
            return self.done();
        }
        let m = stroke.modifiers;
        let plain = !(m.ctrl || m.alt || m.cmd);
        if stroke.key == Key::Tab && plain && self.tabs_to_views() {
            self.tab(m.shift);
            return self.done();
        }
        // A stop that takes no presses (a `focusable` chart) hears its keys
        // through the keymap only, above.
        if let Some(view) = self.screen.key_focus()
            && self.screen.focused().is_none()
            && self.screen.hears(view, EventKind::Press)
            && plain
            && !m.shift
            && matches!(stroke.key, Key::Enter | Key::Char(' '))
        {
            for kind in [EventKind::PressDown, EventKind::PressUp, EventKind::Press] {
                self.send(view, kind, EventPayload::None);
            }
            return self.done();
        }
        if let Some(input) = self.screen.focused() {
            match stroke.key {
                Key::Enter if plain => self.return_key(input),
                Key::Backspace if plain => self.backspace(input),
                Key::Char(c) if plain => {
                    let c = if m.shift { shifted(c) } else { c };
                    self.key(input, c);
                }
                _ => {}
            }
            return self.done();
        }
        if stroke.key == Key::Escape
            && plain
            && !m.shift
            && self.screen.back_target() != crate::screen::Back::Nothing
        {
            return self.back();
        }
        self.done()
    }

    /// Whether Tab stops at views (not only inputs), as on macOS and the
    /// web (the other platforms move it between fields only).
    fn tabs_to_views(&self) -> bool {
        matches!(self.environment.os, Os::MacOs | Os::Web)
    }

    /// Tab (`back`: Shift+Tab): the keyboard focus moves to the next stop
    /// ([`crate::screen::Screen::tab_stops`]), around from the last.
    fn tab(&mut self, back: bool) {
        let stops = self.screen.tab_stops();
        let current = self.screen.focused().or(self.screen.key_focus());
        let at = current.and_then(|id| stops.iter().position(|s| *s == id));
        let Some(next) = nsh_core::input::tab_stop(at, stops.len(), back, true) else {
            return;
        };
        self.move_focus(Some(stops[next]));
    }

    /// Moves the keyboard focus to `to` (an input or a view), telling
    /// the view it leaves and the one it reaches.
    pub(super) fn move_focus(&mut self, to: Option<NodeId>) {
        let from = self.screen.focused().or(self.screen.key_focus());
        if from == to {
            return;
        }
        self.screen.set_focused(None);
        self.screen.set_key_focus(None);
        if let Some(new) = to {
            if self.screen.input(new).is_some() {
                self.screen.set_focused(Some(new));
            } else {
                self.screen.set_key_focus(Some(new));
            }
        }
        self.engine
            .control()
            .set_focus_path(self.screen.focus_path());
        if let Some(old) = from {
            self.set_focused_state(old, false);
            self.send(old, EventKind::Blur, EventPayload::None);
        }
        if let Some(new) = to {
            self.set_focused_state(new, true);
            self.send(new, EventKind::Focus, EventPayload::None);
        }
    }

    /// Applies a non-input focus call after the screen applied this item,
    /// before the next item can retire or remove its target. Inputs and
    /// root blur are already handled by the screen.
    pub(super) fn focus_call(&mut self, item: &MountItem) {
        if !self.tabs_to_views() {
            return;
        }
        let MountItem::Command { id, command } = item else {
            return;
        };
        match command {
            Command::Focus
                if *id != ROOT_ID
                    && self.screen.input(*id).is_none()
                    && self.screen.tab_stops().contains(id) =>
            {
                self.screen.set_focused(None);
                self.screen.set_key_focus(Some(*id));
            }
            Command::Blur if self.screen.key_focus() == Some(*id) => {
                self.screen.set_key_focus(None);
            }
            _ => {}
        }
    }

    /// Reports the batch's net focus change. An intermediate target may
    /// already have been deleted or replaced, so it receives no late event.
    pub(super) fn report_focus_change(&mut self, focused: Option<NodeId>) {
        let now = self.screen.focused().or(self.screen.key_focus());
        if now != focused {
            self.engine
                .control()
                .set_focus_path(self.screen.focus_path());
            if let Some(old) = focused {
                self.set_focused_state(old, false);
                self.send(old, EventKind::Blur, EventPayload::None);
            }
            if let Some(new) = now {
                self.set_focused_state(new, true);
                self.send(new, EventKind::Focus, EventPayload::None);
            }
        }
    }

    /// A view's `focus:` state, which follows the keyboard focus.
    pub(super) fn set_focused_state(&mut self, id: NodeId, on: bool) {
        if self.screen.input(id).is_none()
            && let Some(states) = self.screen.set_state(id, FOCUSED, on)
        {
            self.engine.control().set_states(id, states);
        }
    }

    /// Backspace in input `id`: its last character goes.
    fn backspace(&mut self, id: nsh_core::NodeId) {
        self.key_press(id, "Backspace");
        let Some(input) = self.screen.input_mut(id) else {
            return;
        };
        if input.text.pop().is_none() {
            return;
        }
        input.count += 1;
        let payload = EventPayload::Text {
            text: input.text.clone(),
            count: input.count,
        };
        self.engine
            .control()
            .dispatch_event(id, EventKind::ChangeText, payload);
        self.report_selection(id);
    }
}

/// The character the key typing `c` types with Shift on the US layout.
fn shifted(c: char) -> char {
    const SHIFTED: &[(char, char)] = &[
        ('`', '~'),
        ('1', '!'),
        ('2', '@'),
        ('3', '#'),
        ('4', '$'),
        ('5', '%'),
        ('6', '^'),
        ('7', '&'),
        ('8', '*'),
        ('9', '('),
        ('0', ')'),
        ('-', '_'),
        ('=', '+'),
        ('[', '{'),
        (']', '}'),
        ('\\', '|'),
        (';', ':'),
        ('\'', '"'),
        (',', '<'),
        ('.', '>'),
        ('/', '?'),
    ];
    SHIFTED
        .iter()
        .find(|(plain, _)| *plain == c)
        .map_or(c.to_ascii_uppercase(), |(_, s)| *s)
}
