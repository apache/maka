//! The step `keyboard.press(<keys>)`: a key with its modifiers, as a
//! hardware keyboard gives it, on every platform (`open`'s `platform`: the
//! phones and tablets have one too, a tablet's keyboard, a Chromebook's).
//! The app's shortcuts (`nsh/keymap`) take it first, as the platforms'
//! keymaps do: the newest binding of the keystroke that fires where the
//! focus is reports `onKeyCommand`; Return and Space on a focused control
//! (in the newest modal over its window, if one shows) fire only the
//! focus' own bindings (`KeyOptions::for_focus`), else they press the
//! control. Then, on Linux (the simulated backend whose raw path
//! delivers input), a view that has the keyboard focus hears the press
//! (its `on_key_down` and its ancestors'), the capture rule of it or of an
//! enabled view around it deciding whether the platform keeps it
//! (`capture_keys`): a captured press types nothing and runs no default,
//! and the view focused when the source reports the release hears its
//! `KeyUp`. A press the platform keeps goes on to its defaults:
//! Return and Space press the focused control, then on a desktop the
//! application menu's item with that shortcut is chosen (`onMenu`); else
//! Tab moves the keyboard focus between the inputs and the views that are
//! its stops (those that take presses, and `focusable` ones that take none)
//! where the platform does (macOS, the web, Linux), Shift+F10 asks it for
//! its context menu (the web, Linux), the focused input takes the keys that
//! edit it, and Escape goes back.

use nsh_core::{
    Command, EventKind, EventPayload, KeyEvent, MountBatch, MountItem, NodeId, PayloadValue,
    ROOT_ID,
    desktop::{MenuItem, Shortcut},
    element::SharedString,
    geometry::Points,
    keymap::{self, KeyFocus, KeyMatch, Keystroke},
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
    /// the app's platform's command key).
    ///
    /// The app's shortcuts take the key first (`onKeyCommand`), as the
    /// platforms' keymaps do: those of the focused window and those of no
    /// window, and one that passes the key through lets it go on. Return and
    /// Space on a focused control (in the newest modal over its window, if
    /// one shows) fire only the focus' own bindings
    /// (`KeyOptions::for_focus`), else they press the control. Then, on
    /// Linux, a view that has the keyboard focus (`focusable(true)`) hears
    /// the press, and so do its ancestors (`on_key_down`); a capture rule of
    /// it or of an enabled view around it (`capture_keys`), read off the
    /// mounted props, says whether the platform keeps the press: a captured
    /// press types nothing and runs no default. The view focused when the
    /// source reports the release hears the `KeyUp` after the platform has
    /// chosen what the key does (the defaults below, or none when
    /// captured), with its capture rule read afresh. What the platform
    /// keeps goes on to its defaults: Return and Space press
    /// the focused control, then the application menu's shortcuts, a
    /// window's Escape, the context-menu keys and Tab; elsewhere the focused
    /// input takes a character, Backspace or the return key, and Escape goes
    /// back as the desktops' back key does when there is something to go
    /// back from.
    pub fn press_key(&mut self, keys: &str) -> Result<(), String> {
        self.step(format!("keyboard.press({keys})"));
        self.send_key(keys)?;
        self.done()
    }

    /// Presses `keys` one after another, each as [`Headless::press_key`]
    /// does, without letting the app handle one before the next comes:
    /// keys typed ahead, faster than the app takes them (each goes where
    /// the screen had the focus before the first), then settles once.
    pub fn press_keys(&mut self, keys: &[&str]) -> Result<(), String> {
        self.step(format!("keyboard.press({})", keys.join(", ")));
        for key in keys {
            if self.send_key(key)? {
                return self.done();
            }
        }
        self.done()
    }

    /// Sends key `keys` without settling, except a Back transition must
    /// finish before its release is reported. True ends a typed-ahead batch
    /// after that Back transition; the caller settles the remaining events.
    fn send_key(&mut self, keys: &str) -> Result<bool, String> {
        self.input_with(nsh_core::platform::InputModality::Keyboard);
        let stroke = Keystroke::parse(keys, self.environment.os).map_err(|e| e.to_string())?;
        // A text input the newest modal over its window covers (the app
        // left the focus under a dialog where the platform does not move it
        // into the modal) edits nothing: the modal's window has the keys,
        // as on Android, whose dialog is a window of its own, so Escape
        // reaches the dialog instead of the input under it.
        let input = self
            .screen
            .focused()
            .filter(|&view| self.screen.in_focus_scope(view));
        let focused_view = self.screen.focused().or(self.screen.key_focus());
        let editing = input.is_some();
        // The control with the keyboard focus, which Return and Space press
        // (a stop that takes no presses, a `focusable` chart, hears its keys
        // through the keymap only). Only one in the newest modal over its
        // window counts, as on macOS: a focus the app left under a dialog
        // leaves the keys to the bindings (Linux and the web never let it
        // go there).
        let control = self.screen.key_focus().filter(|&view| {
            !editing
                && self.screen.hears(view, EventKind::Press)
                && self.screen.in_focus_scope(view)
        });
        // The window the key is pressed in: the focused one, as the
        // desktops match their bindings.
        let window = self
            .windows
            .as_ref()
            .and_then(|w| w.focused())
            .unwrap_or(ROOT_ID);
        // The app's shortcuts take the key first, as the platforms' keymaps
        // do: those of the focused window and those of no window, as the
        // desktops match them. Return and Space on a focused control fire
        // only the focus' own bindings. A binding that passes the key
        // through leaves it to the view and the defaults below.
        // A focus the newest modal covers (a popup gave it back to its
        // trigger under a dialog) has no keys of its own, as on macOS.
        let mut focus = KeyFocus::default();
        focus.editing = editing;
        focus.control = control.is_some();
        focus.covered = focused_view.is_some_and(|view| !self.screen.in_focus_scope(view));
        let found = match self.screen.keymap() {
            Some(keymap) => keymap.find_eligible(window, stroke, focus, false, |binding| {
                !binding.fallback
                    && binding.within.is_none_or(|scope| {
                        focused_view
                            .is_some_and(|id| id == scope || self.screen.is_inside(id, scope))
                    })
            }),
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
            return Ok(false);
        }
        // The raw notification is the focused view's, unless a native
        // input or native content has (or is) the focus: those own their
        // keys and text, and a rule around them does not intercept them.
        // Its `KeyDown` and `KeyUp` are both reported to whatever view is
        // focused when the source reports them; the simulator moves the
        // focus between them as a Tab or a dialog can.
        let mut raw = false;
        let captured = if self.screen.focused().is_none()
            && self.delivers_raw_input()
            && let Some(view) = self.screen.key_focus()
            && self.screen.accepts_key_focus(view)
        {
            if self.screen.hosts_native(view) {
                return Ok(false);
            }
            let mut event = view_key_event(&stroke);
            let captured = self.screen.captures_key(view, &stroke);
            event.default_prevented = captured;
            // The platform sends the key whatever the view reports itself:
            // the core bubbles it to its ancestors, so a listener above a
            // view that has none still hears it (the driver's `send` would
            // drop it before that).
            self.engine.control().dispatch_event(
                view,
                EventKind::KeyDown,
                EventPayload::Key(event),
            );
            raw = true;
            captured
        } else {
            false
        };
        let m = stroke.modifiers;
        let mut go_back = false;
        // What the platform does with an uncaptured key, in the order the
        // platforms run it; the release follows below.
        if !captured {
            'defaults: {
                // Then they press that control, before the menus' shortcuts:
                // a binding of Return elsewhere does not act instead of it.
                if let Some(view) = control
                    && nsh_core::input::presses_focused_control(stroke.key, stroke.modifiers)
                {
                    for kind in [EventKind::PressDown, EventKind::PressUp, EventKind::Press] {
                        self.send(view, kind, EventPayload::None);
                    }
                    break 'defaults;
                }
                // Then the application menu's shortcuts choose its items,
                // on a desktop, as the platforms' menus do after the
                // keymap; an item that leaves the key to the focused field
                // does not take it.
                let apple = matches!(self.environment.os, Os::MacOs | Os::Ios);
                if self.environment.desktop()
                    && let Ok(pressed) = Shortcut::parse(keys, apple)
                    && let Some((id, fires)) = self.screen.app_menu().and_then(|items| {
                        MenuItem::find_shortcut(items, &pressed)
                            .map(|a| (a.id, !editing || a.fires_while_editing()))
                    })
                    && fires
                {
                    // A role item (id 0: Quit, Hide) is the system's on a
                    // platform: here it takes the key and does nothing.
                    if id != 0 {
                        self.engine.control().dispatch_event(
                            ROOT_ID,
                            EventKind::Menu,
                            EventPayload::Map(vec![("id", PayloadValue::Number(f64::from(id)))]),
                        );
                    }
                    break 'defaults;
                }
                let plain = !(m.ctrl || m.alt || m.cmd);
                // The key goes to the focused window: Escape closes one of
                // the app's own that says so (`closeOnEscape`), natively.
                if stroke.key == keymap::Key::Escape
                    && plain
                    && !m.shift
                    && self.windows.as_mut().is_some_and(|w| w.escape())
                {
                    self.report_windows();
                    break 'defaults;
                }
                // Shift+F10 asks the focused view for its context menu
                // where the platform reads the key on a view: the web and
                // Linux (macOS has no such key; Windows asks through UI
                // Automation only). The nearest view around it listening
                // hears `onContextMenu`, with no pointer, at its
                // bottom-start corner; a focused input keeps the key for
                // its own edit menu.
                if matches!(self.environment.os, Os::Web | Os::Linux)
                    && nsh_core::input::opens_context_menu(false, Some(stroke.key), m)
                {
                    if self.screen.focused().is_none()
                        && let Some(from) = self.screen.key_focus()
                    {
                        self.keyboard_context_menu(from, m);
                    }
                    break 'defaults;
                }
                if stroke.key == keymap::Key::Tab && plain && self.tabs_to_views() {
                    self.tab(m.shift);
                    break 'defaults;
                }
                if let Some(input) = input {
                    let multiline = self.screen.input(input).is_some_and(|i| i.config.multiline);
                    match stroke.key {
                        keymap::Key::Enter
                            if multiline && (m.shift || m.alt) && !(m.ctrl || m.cmd) =>
                        {
                            self.key(input, '\n');
                        }
                        keymap::Key::Enter if plain => self.return_key(input),
                        keymap::Key::Backspace if plain => self.backspace(input),
                        keymap::Key::Char(c) if plain => {
                            let c = if m.shift { shifted(c) } else { c };
                            self.key(input, c);
                        }
                        _ => {}
                    }
                    break 'defaults;
                }
                if stroke.key == keymap::Key::Escape
                    && plain
                    && !m.shift
                    && self.screen.back_target() != crate::screen::Back::Nothing
                {
                    go_back = true;
                }
            }
        }
        if go_back {
            self.back()?;
        }
        // The release follows what the key did, as a platform sends it, to
        // the view focused now (a default may have moved it) with the
        // capture rule mounted now. A native input or native content owns
        // the release it receives.
        if raw
            && self.screen.focused().is_none()
            && let Some(view) = self.screen.key_focus()
            && self.screen.accepts_key_focus(view)
            && !self.screen.hosts_native(view)
        {
            let mut up = view_key_event(&stroke);
            up.default_prevented = self.screen.captures_key(view, &stroke);
            self.engine
                .control()
                .dispatch_event(view, EventKind::KeyUp, EventPayload::Key(up));
        }
        Ok(go_back)
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

    /// Whether the platform gives a view its own input — a focused view its
    /// keys, a view under the wheel its scrolling: Linux, outside a terminal
    /// (the terminal host reads and delivers its own).
    pub(super) fn delivers_raw_input(&self) -> bool {
        self.environment.os == Os::Linux
            && self.environment.idiom != nsh_core::platform::Idiom::Terminal
    }

    /// Whether Tab stops at views (not only inputs), as on the desktops
    /// (macOS, Windows, Linux), the web and in a terminal: a view that takes
    /// presses or is `focusable` is a stop beside the fields. iOS and
    /// Android move it between fields only.
    fn tabs_to_views(&self) -> bool {
        matches!(
            self.environment.os,
            Os::MacOs | Os::Windows | Os::Linux | Os::Web
        ) || self.environment.idiom == nsh_core::platform::Idiom::Terminal
    }

    /// Tab (`back`: Shift+Tab): the keyboard focus moves to the next stop
    /// ([`crate::screen::Screen::tab_stops`]), around from the last; with
    /// a dialog shown over the window of the focus, among the dialog's
    /// stops only ([`crate::screen::Screen::focus_scope`]), as the
    /// platforms keep it there.
    fn tab(&mut self, back: bool) {
        let current = self.screen.focused().or(self.screen.key_focus());
        let window = current.map_or(ROOT_ID, |id| self.screen.window_of(id));
        let mut stops = self.screen.tab_stops();
        if let Some(scope) = self.screen.focus_scope(window) {
            stops.retain(|&id| self.screen.within(id, scope));
        }
        let at = current.and_then(|id| stops.iter().position(|s| *s == id));
        let Some(next) = nsh_core::input::tab_stop(at, stops.len(), back, true) else {
            return;
        };
        self.move_focus(Some(stops[next]));
        self.reveal(stops[next]);
    }

    /// Whether a modal keeps the keyboard focus to itself while it shows
    /// and gives it back when it goes, as the desktops and the web do.
    fn modals_scope_focus(&self) -> bool {
        matches!(
            self.environment.os,
            Os::MacOs | Os::Windows | Os::Linux | Os::Web
        )
    }

    /// The batch just applied presented modals, `before` the input or Tab
    /// stop that had the keyboard focus before it: each modal remembers
    /// it when it is under the modal, in its window, and the focus leaves
    /// it, as on the platforms (a Return pressed meanwhile presses nothing
    /// under the modal).
    pub(super) fn modals_presented(&mut self, before: Option<NodeId>) {
        if !self.modals_scope_focus() {
            return;
        }
        for modal in self.screen.presenting() {
            if self.focus_before.iter().any(|(m, _)| *m == modal) {
                continue;
            }
            let window = self.screen.window_of(modal);
            let under = before.filter(|&view| {
                !self.screen.within(view, modal) && self.screen.window_of(view) == window
            });
            self.focus_before.push((modal, under));
            if under.is_some() && self.screen.focused().or(self.screen.key_focus()) == under {
                self.move_focus(None);
            }
        }
    }

    /// Modals that went (the app left them out, or a back closed them):
    /// the focus inside one leaves it, and the view that had it before the
    /// modal came gets it back when nothing else took it meanwhile and it
    /// can still take it (shown, inside the newest modal still over its
    /// window), as the platforms give it back. A newer modal remembering a
    /// view of one that went gives that one's back instead.
    pub(super) fn modals_closed(&mut self) {
        let mut i = 0;
        while i < self.focus_before.len() {
            let (modal, before) = self.focus_before[i];
            if self.screen.in_tree(modal) {
                i += 1;
                continue;
            }
            self.focus_before.remove(i);
            for (_, newer) in &mut self.focus_before[i..] {
                if newer.is_some_and(|view| self.screen.within(view, modal)) {
                    *newer = before;
                }
            }
            let current = self.screen.focused().or(self.screen.key_focus());
            let fell = current
                .is_none_or(|view| self.screen.within(view, modal) || !self.screen.in_tree(view));
            if !fell {
                continue;
            }
            let back = before.filter(|&view| {
                self.screen.in_tree(view)
                    && self
                        .screen
                        .focus_scope(self.screen.window_of(view))
                        .is_none_or(|scope| self.screen.within(view, scope))
                    && (self.screen.input(view).is_some()
                        || self.screen.tab_stops().contains(&view))
            });
            if back.is_some() || current.is_some() {
                self.move_focus(back);
            }
        }
    }

    /// The keyboard focus on a stack's page that no longer shows (a newer
    /// page covers it, a back popped it) leaves it, as the platforms hand it
    /// to the window before they hide or take away the page: the view
    /// hears its blur and loses its `focus:` state, and with it what the
    /// focus showed (a tooltip). Nothing gets it instead.
    pub(super) fn leave_covered_pages(&mut self) {
        let current = self.screen.focused().or(self.screen.key_focus());
        if current.is_some_and(|id| self.screen.on_covered_page(id)) {
            self.move_focus(None);
        }
    }

    /// The scroll views around `id`, which the keyboard focus reached,
    /// scroll so that it shows, innermost first, as the platforms scroll
    /// them for a focus Tab moves (at once here: no animation).
    fn reveal(&mut self, id: NodeId) {
        for view in self.screen.scrolls_around(id) {
            let (Some(target), Some(viewport), Some(scroll)) = (
                self.screen.bounds_in_root(id),
                self.screen.bounds_in_root(view),
                self.screen.scroll(view),
            ) else {
                continue;
            };
            let (start, len, dim, offset) = if scroll.horizontal {
                (
                    target.origin.x - viewport.origin.x,
                    target.size.width,
                    viewport.size.width,
                    scroll.x,
                )
            } else {
                (
                    target.origin.y - viewport.origin.y,
                    target.size.height,
                    viewport.size.height,
                    scroll.y,
                )
            };
            let delta = nsh_core::scroll::reveal_focus_delta(start, start + len, dim);
            let to = (offset + delta).clamp(Points::ZERO, self.screen.scroll_end(view));
            if (to - offset).abs() >= Points(0.5) {
                self.scroll_to(view, to);
            }
        }
    }

    /// Moves the keyboard focus to `to` (an input or a view), telling
    /// the view it leaves and the one it reaches.
    ///
    /// The view it reaches reports its `focus:` state before the one it
    /// leaves: the engine may commit between the two messages, and the
    /// core takes a view's focus as the focus whatever came before but
    /// a blur of a view that no longer has it as nothing, so the move is
    /// one change of `focus-within` however the commits fall (a blur
    /// first could leave the views both chains share for a commit).
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
            self.set_focused_state(new, true);
        }
        if let Some(old) = from {
            self.set_focused_state(old, false);
            self.send(old, EventKind::Blur, EventPayload::None);
        }
        if let Some(new) = to {
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
            // As in `move_focus`: the view the focus reaches reports first.
            let key = now.and_then(|_| self.screen.key_focus());
            if let Some(new) = now {
                self.set_focused_state(new, true);
            }
            if let Some(old) = focused {
                self.set_focused_state(old, false);
                // A removed input hears no blur (`Screen::taken_out`).
                if self.screen.within(old, ROOT_ID) {
                    self.send(old, EventKind::Blur, EventPayload::None);
                }
            }
            if let Some(new) = now {
                // The pressable that had the keyboard focus loses it.
                if let Some(key) = key {
                    self.screen.set_key_focus(None);
                    self.set_focused_state(key, false);
                    self.send(key, EventKind::Blur, EventPayload::None);
                }
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
                Command::Focus if id != ROOT_ID && self.screen.accepts_key_focus(id) => {
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

/// The key event of `stroke`, as a simulated platform reports it on a
/// focused view. The logical key is what the stroke types with Shift
/// applied and the DOM's name for the named keys.
///
/// The simulation is generic: it reports what its generated keystroke
/// says, only on the platforms whose simulated raw path delivers keys
/// (`delivers_raw_input`). It has no hardware identity and invents none, so
/// `code` is `""` (the DOM's unknown code); nor does it fabricate repeats,
/// which its strokes do not model.
fn view_key_event(stroke: &Keystroke) -> KeyEvent {
    let m = stroke.modifiers;
    let named = match stroke.key {
        keymap::Key::Char(_) => None,
        keymap::Key::Enter => Some("Enter"),
        keymap::Key::Escape => Some("Escape"),
        keymap::Key::Tab => Some("Tab"),
        keymap::Key::Backspace => Some("Backspace"),
        keymap::Key::Delete => Some("Delete"),
        keymap::Key::Insert => Some("Insert"),
        keymap::Key::Up => Some("ArrowUp"),
        keymap::Key::Down => Some("ArrowDown"),
        keymap::Key::Left => Some("ArrowLeft"),
        keymap::Key::Right => Some("ArrowRight"),
        keymap::Key::Home => Some("Home"),
        keymap::Key::End => Some("End"),
        keymap::Key::PageUp => Some("PageUp"),
        keymap::Key::PageDown => Some("PageDown"),
        keymap::Key::F(n) => Some(match n {
            1 => "F1",
            2 => "F2",
            3 => "F3",
            4 => "F4",
            5 => "F5",
            6 => "F6",
            7 => "F7",
            8 => "F8",
            9 => "F9",
            10 => "F10",
            11 => "F11",
            12 => "F12",
            13 => "F13",
            14 => "F14",
            15 => "F15",
            16 => "F16",
            17 => "F17",
            18 => "F18",
            19 => "F19",
            20 => "F20",
            21 => "F21",
            22 => "F22",
            23 => "F23",
            _ => "F24",
        }),
    };
    let typed = match stroke.key {
        keymap::Key::Char(c) => Some(if m.shift { shifted(c) } else { c }),
        _ => None,
    };
    let key = match (named, typed) {
        (Some(name), _) => SharedString::from(name),
        (None, Some(c)) => SharedString::from(c.to_string()),
        (None, None) => SharedString::from("Unidentified"),
    };
    let mut event = KeyEvent::default();
    event.key = key;
    event.modifiers = m;
    event
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
