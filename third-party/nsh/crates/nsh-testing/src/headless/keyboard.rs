//! The step `keyboard.press(<keys>)`: a key with its modifiers, as a
//! hardware keyboard gives it, on every platform (`open`'s `platform`: the
//! phones and tablets have one too, a tablet's keyboard, a Chromebook's).
//! The app's shortcuts (`nsh/keymap`) take it first, as the platforms'
//! keymaps do: the newest binding of the keystroke that fires where the
//! focus is reports `onKeyCommand`. Else the focused input takes the keys
//! that edit it, and Escape goes back.

use nsh_core::{
    EventKind, EventPayload, PayloadValue, ROOT_ID,
    keymap::{Key, KeyMatch, Keystroke},
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
