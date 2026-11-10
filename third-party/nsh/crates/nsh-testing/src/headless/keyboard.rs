//! The step `keyboard.press(<keys>)`: a key with its modifiers, as a
//! hardware keyboard gives it, on every platform (`open`'s `platform`: the
//! phones and tablets have one too, a tablet's keyboard, a Chromebook's).
//! The app's shortcuts (`nsh/keymap`) take it first, as the platforms'
//! keymaps do: the newest binding of the keystroke that fires where the
//! focus is reports `onKeyCommand`. Else Tab moves the keyboard focus
//! between the inputs and the views that are its stops (those that take
//! presses, and `focusable` ones that take none) where the platform
//! does (macOS, the web), Return and Space press the pressable it is on,
//! Shift+F10 asks it for its context menu (the web, Linux), the
//! focused input takes the keys that edit it, and Escape goes back.

use nsh_core::{
    Command, EventKind, EventPayload, MountBatch, MountItem, NodeId, PayloadValue, ROOT_ID,
    keymap::{Key, KeyMatch, Keystroke},
    platform::Os,
    tailwind::state::FOCUSED,
};

use super::Headless;

impl Headless {
    /// The steps `keyboard.down(<keys>)` / `keyboard.up(<keys>)`: holds or
    /// lets go of modifier keys (`"mod"`, `"shift"`, `"alt"`, `"ctrl"`,
    /// `"meta"`, joined by `+`), which the presses, drags and hovers until
    /// then carry, as a hand on the keyboard does while the pointer acts.
    pub fn hold_keys(&mut self, keys: &str, down: bool) -> Result<(), String> {
        self.step(format!(
            "keyboard.{}({keys})",
            if down { "down" } else { "up" }
        ));
        let apple = matches!(self.environment.os, Os::MacOs | Os::Ios);
        for name in keys.split('+') {
            let flag = match name.trim().to_ascii_lowercase().as_str() {
                "mod" if apple => &mut self.held.cmd,
                "mod" | "ctrl" | "control" => &mut self.held.ctrl,
                "alt" | "option" => &mut self.held.alt,
                "shift" => &mut self.held.shift,
                "meta" | "cmd" | "command" => &mut self.held.cmd,
                other => {
                    return Err(format!(
                        "`{other}` is no modifier key: mod, shift, alt, ctrl or meta"
                    ));
                }
            };
            *flag = down;
        }
        self.done()
    }

    /// The step `keyboard.press(<keys>)`: presses `keys`, a keystroke as
    /// `nsh/keymap` names it (`"mod+k"`, `"shift+tab"`, `"escape"`; `mod` is
    /// the app's platform's command key). A binding of the app's keymap
    /// that fires where the focus is hears it (`onKeyCommand`), and takes
    /// the key unless it passes it through; else the focused input takes a character, Backspace or the return key, and
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
        if let Some(id) = found.fired() {
            self.engine.control().dispatch_event(
                ROOT_ID,
                EventKind::KeyCommand,
                EventPayload::Value(PayloadValue::Number(f64::from(id))),
            );
        }
        // A binding passing the key through leaves it to what follows, as a
        // platform does: on the screen as it is when the key comes.
        if found.consumed() {
            return self.done();
        }
        let m = stroke.modifiers;
        let plain = !(m.ctrl || m.alt || m.cmd);
        // The key goes to the focused window: Escape closes one of the app's
        // own that says so (`closeOnEscape`), natively.
        if stroke.key == Key::Escape
            && plain
            && !m.shift
            && self.windows.as_mut().is_some_and(|w| w.escape())
        {
            self.report_windows();
            return self.done();
        }
        // Shift+F10 asks the focused view for its context menu where views
        // take the keyboard focus and the key is the platform's: the web
        // and Linux (macOS has no such key; Windows focuses fields only). The
        // nearest view around it listening hears `onContextMenu`, with no
        // pointer, at its bottom-start corner; a focused input keeps the
        // key for its own edit menu.
        if matches!(self.environment.os, Os::Web | Os::Linux)
            && nsh_core::input::opens_context_menu(false, Some(stroke.key), m)
        {
            if self.screen.focused().is_none()
                && let Some(from) = self.screen.key_focus()
            {
                self.keyboard_context_menu(from, m);
            }
            return self.done();
        }
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

    /// The keyboard asked view `from` (the keyboard focus) for its context
    /// menu: the nearest view around it listening hears `onContextMenu`
    /// at its bottom-start corner (left to right: the screen keeps no
    /// direction), with no pointer.
    fn keyboard_context_menu(&mut self, from: NodeId, modifiers: nsh_core::keymap::Modifiers) {
        let Some(id) = self.screen.context_menu_target(from) else {
            return;
        };
        let Some(bounds) = self.screen.bounds_in_root(id) else {
            return;
        };
        let position = nsh_core::input::context_menu_anchor(bounds.size, false);
        let event =
            nsh_core::ContextMenuEvent::new(position, bounds.origin + position, modifiers, None);
        self.send(id, EventKind::ContextMenu, EventPayload::ContextMenu(event));
    }

    /// Whether Tab stops at views (not only inputs), as on macOS, the web,
    /// Linux and in a terminal (the other platforms move it between fields only).
    fn tabs_to_views(&self) -> bool {
        matches!(self.environment.os, Os::MacOs | Os::Web | Os::Linux)
            || self.environment.idiom == nsh_core::platform::Idiom::Terminal
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
        if let Some(old) = from {
            self.screen.set_focused(None);
            self.screen.set_key_focus(None);
            self.set_focused_state(old, false);
            self.send(old, EventKind::Blur, EventPayload::None);
        }
        if let Some(new) = to {
            if self.screen.input(new).is_some() {
                self.screen.set_focused(Some(new));
            } else {
                self.screen.set_key_focus(Some(new));
            }
            self.set_focused_state(new, true);
            self.send(new, EventKind::Focus, EventPayload::None);
        }
    }

    /// The app moved the focus (`focus()`, `blur()`) in `batch`, applied
    /// with input `focused` focused before it: platforms tell the views as
    /// when the user moves it. The screen applied the calls on inputs;
    /// where Tab stops at views that take presses, a call on one of those
    /// moves the keyboard focus as Tab does (the batch's last call counts).
    pub(super) fn focus_calls(&mut self, batch: &MountBatch, focused: Option<NodeId>) {
        let now = self.screen.focused();
        if now != focused {
            if let Some(old) = focused {
                self.set_focused_state(old, false);
                self.send(old, EventKind::Blur, EventPayload::None);
            }
            if let Some(new) = now {
                // The pressable that had the keyboard focus loses it.
                if let Some(key) = self.screen.key_focus() {
                    self.screen.set_key_focus(None);
                    self.set_focused_state(key, false);
                    self.send(key, EventKind::Blur, EventPayload::None);
                }
                self.set_focused_state(new, true);
                self.send(new, EventKind::Focus, EventPayload::None);
            }
        }
        if !self.tabs_to_views() {
            return;
        }
        let mut key = self.screen.key_focus();
        let mut to = None;
        for item in &batch.items {
            let MountItem::Command { id, command } = item else {
                continue;
            };
            let id = *id;
            match command {
                Command::Focus if self.screen.input(id).is_some() => {
                    to = None;
                    key = None;
                }
                Command::Focus if id != ROOT_ID && self.screen.tab_stops().contains(&id) => {
                    to = Some(Some(id));
                    key = Some(id);
                }
                Command::Blur if id != ROOT_ID && key == Some(id) => {
                    to = Some(None);
                    key = None;
                }
                _ => {}
            }
        }
        if let Some(to) = to {
            self.move_focus(to);
        }
    }

    /// A view's or an input's `focus:` state, which follows the keyboard
    /// focus: reported whatever the view tracks, as the platforms report
    /// it (`nsh_core::input::reported_states`; the core works out
    /// `focus-within` from it).
    pub(super) fn set_focused_state(&mut self, id: NodeId, on: bool) {
        if let Some(states) = self.screen.set_state(id, FOCUSED, on) {
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
