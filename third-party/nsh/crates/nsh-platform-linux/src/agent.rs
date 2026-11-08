//! The platform's part of `nsh test --target linux` (`nsh_testing::agent`):
//! where a node's view is in the window, and the input a user's hands give
//! there, through the handlers real input goes through ([`crate::synth`]).
//! The agent calls from a thread of its own; each call does its work on
//! the GTK main thread and returns once it is done. Calls go at the
//! default priority, as input does: an idle source (`MainContext::invoke`)
//! waits for a busy main loop (software rendering redrawing) to be idle.

use std::{
    rc::Rc,
    sync::{
        Arc,
        atomic::{AtomicU32, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};

use gtk4::{self as gtk, gdk, glib, prelude::*};
use nsh_core::{
    NodeId, ROOT_ID,
    desktop::WindowState,
    geometry::{Bounds, Point, Points, Size, point},
};
use nsh_testing::agent::{Key, Native};

use crate::{input::Simulated, surface::Surface, synth, xtest::Xtest};

/// How long a call waits for the main thread at most.
const MAIN: Duration = Duration::from_secs(10);
/// A press's hold, as a quick click's.
const CLICK: Duration = Duration::from_millis(60);
/// A display frame, where the window's monitor tells none.
const FRAME: Duration = Duration::from_millis(16);
/// How long the X server's key events take to come back to GDK, at most
/// about.
const KEY_SETTLE: Duration = Duration::from_millis(20);
/// How far one scroll event moves at most, in points.
const SCROLL_STEP: f32 = 20.0;

/// The surface the agent acts on, by key (its calls must be `Send`).
pub(crate) struct LinuxNative {
    key: u64,
    /// The window pointer input goes to (its root node; `target_window`).
    target: Arc<AtomicU32>,
}

impl LinuxNative {
    pub(crate) fn new(key: u64) -> Self {
        LinuxNative {
            key,
            target: Arc::new(AtomicU32::new(ROOT_ID)),
        }
    }

    /// `f` on the main thread with pointer input aimed at the target
    /// window (points in its content); `press` activates it first, as a
    /// real press in a window does.
    fn sim<R: Send + 'static>(
        &self,
        press: bool,
        f: impl FnOnce(&Rc<Surface>) -> R + Send + 'static,
    ) -> Option<R> {
        let target = self.target.load(Ordering::Relaxed);
        self.on_main(move |s| {
            let root = (target != ROOT_ID)
                .then(|| crate::window::root_view(s, target))
                .flatten();
            crate::input::set_event_root(s, root);
            if press
                && let Some(window) = crate::window::native_window(s, target)
                && !window.is_active()
            {
                window.present();
            }
            f(s)
        })
    }

    /// `f` with the window keys go to (the focused one) on the main thread.
    fn with_key_window<R: Send + 'static>(
        &self,
        f: impl FnOnce(&Rc<Surface>, &gtk::Window) -> R + Send + 'static,
    ) -> Option<R> {
        self.on_main(move |surface| crate::window::key_window(surface).map(|w| f(surface, &w)))
            .flatten()
    }

    /// `f` with the surface on the main thread, waited for; `None` once
    /// the surface is gone.
    fn on_main<R: Send + 'static>(
        &self,
        f: impl FnOnce(&Rc<Surface>) -> R + Send + 'static,
    ) -> Option<R> {
        let (tx, rx) = mpsc::channel();
        let key = self.key;
        glib::MainContext::default().invoke_with_priority(glib::Priority::DEFAULT, move || {
            let _ = tx.send(Surface::by_key(key).map(|surface| f(&surface)));
        });
        rx.recv_timeout(MAIN).ok().flatten()
    }

    /// A frame of the monitor showing the window: a touchpad sends its
    /// scroll events at the display's rate.
    fn frame(&self) -> Duration {
        self.with_window(|_, window| {
            let surface = window.surface()?;
            let rate = WidgetExt::display(window)
                .monitor_at_surface(&surface)?
                .refresh_rate();
            // Millihertz.
            (rate > 0).then(|| Duration::from_secs_f64(1000.0 / rate as f64))
        })
        .flatten()
        .unwrap_or(FRAME)
    }

    /// `f` with the surface's window on the main thread.
    fn with_window<R: Send + 'static>(
        &self,
        f: impl FnOnce(&Rc<Surface>, &gtk::Window) -> R + Send + 'static,
    ) -> Option<R> {
        self.on_main(move |surface| synth::window(surface).map(|w| f(surface, &w)))
            .flatten()
    }

    /// Real key events (XTest) under X11: `f` on the main thread with the
    /// window given the X focus, then a wait for GTK to have handled them.
    /// `None` where there is no XTest (Wayland), and the agent keeps to the
    /// widgets' signals; else what `f` says (false: it typed nothing).
    fn real_keys(&self, f: impl FnOnce(&Xtest) -> bool + Send + 'static) -> Option<bool> {
        // The focus first, handled before the keys come: GTK drops a key
        // that comes with the window's focus-in.
        let moved = self
            .with_key_window(|_, w| Xtest::with(|x| x.focus(w)))
            .flatten()?;
        if moved {
            std::thread::sleep(KEY_SETTLE);
            self.on_main(|_| ());
        }
        let typed = self.on_main(move |_| Xtest::with(f)).flatten()?;
        // The events come back through GDK's source on the main loop.
        std::thread::sleep(KEY_SETTLE);
        self.on_main(|_| Xtest::with(Xtest::restore_mapping));
        Some(typed)
    }

    fn click(&self, at: Point<Points>, hold: Duration) {
        let (x, y) = (at.x.0, at.y.0);
        // A real pointer arrives before it presses (hover state).
        self.sim(true, move |s| {
            crate::input::simulate(s, Simulated::Hover(x, y));
            crate::input::simulate(s, Simulated::Down(x, y));
        });
        std::thread::sleep(hold);
        self.sim(false, move |s| {
            crate::input::simulate(s, Simulated::Up(x, y))
        });
    }
}

impl Native for LinuxNative {
    fn bounds(&self, id: NodeId) -> Option<Bounds<Points>> {
        self.on_main(move |surface| {
            let view = surface.mounter.borrow().views.get(&id)?.clone();
            if !view.is_drawable() {
                return None;
            }
            // In the content of the window it is in.
            let r = view.compute_bounds(&crate::window::root_of(surface, &view))?;
            Some(Bounds::new(
                point(Points(r.x()), Points(r.y())),
                Size::new(Points(r.width()), Points(r.height())),
            ))
        })
        .flatten()
    }

    fn text_bounds(&self, text: NodeId, start: u32, end: u32) -> Option<Bounds<Points>> {
        self.on_main(move |surface| {
            let view = surface.mounter.borrow().views.get(&text)?.clone();
            if !view.is_drawable() {
                return None;
            }
            let (x, y, width, height) = crate::text::range_rect(&view.state(), start, end)?;
            let r = view.compute_bounds(&crate::window::root_of(surface, &view))?;
            Some(Bounds::new(
                point(Points(r.x() + x), Points(r.y() + y)),
                Size::new(Points(width), Points(height)),
            ))
        })
        .flatten()
    }

    fn viewport(&self) -> Size<Points> {
        // The target window's content.
        let target = self.target.load(Ordering::Relaxed);
        let (width, height) = self
            .on_main(move |s| {
                let root = (target != ROOT_ID)
                    .then(|| crate::window::root_view(s, target))
                    .flatten()
                    .unwrap_or_else(|| s.root.clone());
                (root.width() as f32, root.height() as f32)
            })
            .unwrap_or((0.0, 0.0));
        Size::new(Points(width), Points(height))
    }

    fn press(&self, at: Point<Points>) {
        self.click(at, CLICK);
    }

    fn long_press(&self, at: Point<Points>, hold: Duration) {
        self.click(at, hold);
    }

    fn scroll(&self, at: Point<Points>, delta: Point<Points>) {
        let (x, y) = (at.x.0, at.y.0);
        let (dx, dy) = (delta.x.0, delta.y.0);
        // A touchpad's smooth events, a frame apart, adding up to it: on a
        // schedule, so the main thread's hops do not slow them down.
        let n = (dx.abs().max(dy.abs()) / SCROLL_STEP).ceil().max(1.0) as u32;
        let frame = self.frame();
        let mut next = Instant::now();
        for _ in 0..n {
            let (sx, sy) = (dx / n as f32, dy / n as f32);
            self.sim(false, move |s| {
                crate::input::simulate(s, Simulated::Wheel(x, y, sx, sy))
            });
            next += frame;
            std::thread::sleep(next.saturating_duration_since(Instant::now()));
        }
    }

    fn drag(&self, from: Point<Points>, to: Point<Points>) {
        let (x, y) = (from.x.0, from.y.0);
        self.sim(true, move |s| {
            crate::input::simulate(s, Simulated::Hover(x, y));
            crate::input::simulate(s, Simulated::Down(x, y));
        });
        std::thread::sleep(nsh_testing::agent::LANDING);
        let mut last = from;
        for at in nsh_testing::agent::drag_path(from, to) {
            std::thread::sleep(FRAME);
            let (x, y) = (at.x.0, at.y.0);
            self.sim(false, move |s| {
                crate::input::simulate(s, Simulated::Move(x, y))
            });
            last = at;
        }
        let (x, y) = (last.x.0, last.y.0);
        self.sim(false, move |s| {
            crate::input::simulate(s, Simulated::Up(x, y))
        });
    }

    fn drag_and_hold(&self, from: Point<Points>, to: Point<Points>) -> Result<(), String> {
        let (x, y) = (from.x.0, from.y.0);
        self.sim(true, move |s| {
            crate::input::simulate(s, Simulated::Hover(x, y));
            crate::input::simulate(s, Simulated::Down(x, y));
        })
        .ok_or("the window is gone")?;
        std::thread::sleep(nsh_testing::agent::LANDING);
        for at in nsh_testing::agent::drag_path(from, to) {
            std::thread::sleep(FRAME);
            let (x, y) = (at.x.0, at.y.0);
            self.sim(false, move |s| {
                crate::input::simulate(s, Simulated::Move(x, y))
            });
        }
        Ok(())
    }

    fn drop_files(&self, at: Point<Points>, uris: Vec<String>) -> Result<(), String> {
        let (x, y) = (at.x.0, at.y.0);
        match self.sim(false, move |s| crate::file_drop::drop_uris(s, x, y, uris)) {
            Some(true) => Ok(()),
            Some(false) => Err("no view there listens to `onFileDrop`".into()),
            None => Err("the window is gone".into()),
        }
    }

    fn drop_at(&self, at: Point<Points>) -> Result<(), String> {
        let (x, y) = (at.x.0, at.y.0);
        self.sim(false, move |s| {
            crate::input::simulate(s, Simulated::Up(x, y))
        })
        .ok_or_else(|| "the window is gone".to_owned())
    }

    fn type_text(&self, text: &str) {
        // Key by key, as a keyboard's characters come.
        for ch in text.chars() {
            let keysym = crate::xtest::char_keysym(ch);
            if self.real_keys(move |x| x.stroke(&[], keysym)) == Some(true) {
                continue;
            }
            self.with_key_window(move |_, w| synth::type_text(w, &ch.to_string()));
        }
    }

    fn key(&self, key: Key) {
        use crate::xtest::CONTROL_L;
        let (modifiers, keysym): (&'static [u64], u64) = match key {
            Key::Return => (&[], 0xff0d),
            Key::Backspace => (&[], 0xff08),
            Key::SelectAll => (&[CONTROL_L], u64::from('a')),
        };
        if self.real_keys(move |x| x.stroke(modifiers, keysym)) == Some(true) {
            return;
        }
        self.with_key_window(move |_, w| match key {
            Key::Return => synth::enter(w),
            Key::Backspace => synth::backspace(w),
            Key::SelectAll => synth::select_all(w),
        });
    }

    fn mouse(&self) -> bool {
        true
    }

    fn right_click(&self, at: Point<Points>) -> Result<(), String> {
        let (x, y) = (at.x.0, at.y.0);
        self.sim(false, move |s| {
            crate::input::simulate(s, Simulated::ContextMenu(x, y))
        })
        .ok_or_else(|| "the window is gone".to_owned())
    }

    fn choose_menu_item(&self, path: &[String]) -> Result<(), String> {
        let path = path.to_vec();
        self.on_main(move |s| crate::chrome::choose_open_menu(s, &path))
            .unwrap_or_else(|| Err("the window is gone".to_owned()))
    }

    fn close_menu(&self) -> Result<(), String> {
        self.on_main(|s| crate::chrome::close_open_menu(s))
            .unwrap_or_else(|| Err("the window is gone".to_owned()))
    }

    fn hold_keys(&self, keys: &str, down: bool) -> Result<(), String> {
        let mut mask = gdk::ModifierType::empty();
        let mut keysyms = Vec::new();
        for name in keys.split('+') {
            let name = name.trim().to_ascii_lowercase();
            keysyms.extend(crate::xtest::modifier_keysym(&name));
            mask |= match name.as_str() {
                // Linux's command key is Control.
                "mod" | "ctrl" | "control" => gdk::ModifierType::CONTROL_MASK,
                "alt" | "option" => gdk::ModifierType::ALT_MASK,
                "shift" => gdk::ModifierType::SHIFT_MASK,
                "meta" | "cmd" | "command" | "super" => gdk::ModifierType::SUPER_MASK,
                other => {
                    return Err(format!(
                        "`{other}` is no modifier key: mod, shift, alt, ctrl or meta"
                    ));
                }
            };
        }
        // The keys held for real too where there are real key events, so
        // the keys typed meanwhile carry them; the simulated pointer's
        // events carry the mask.
        self.real_keys(move |x| {
            for k in keysyms {
                x.key(k, down);
            }
            true
        });
        self.on_main(move |_| crate::input::hold(mask, down))
            .ok_or_else(|| "the window is gone".to_owned())
    }

    fn hover(&self, at: Point<Points>) -> Result<(), String> {
        let (x, y) = (at.x.0, at.y.0);
        self.sim(false, move |s| {
            crate::input::simulate(s, Simulated::Hover(x, y))
        })
        .ok_or_else(|| "the window is gone".to_owned())
    }

    fn press_keys(&self, keys: &str) -> Result<(), String> {
        use nsh_core::keymap::{Key as K, Keystroke};
        let stroke =
            Keystroke::parse(keys, nsh_core::platform::Os::Linux).map_err(|e| e.to_string())?;
        // A real keystroke where there are real key events: GTK's
        // shortcut controllers, the focus' key bindings and the input
        // method see it as they see a keyboard's.
        let m = stroke.modifiers;
        let held: Vec<u64> = [
            (m.ctrl, crate::xtest::CONTROL_L),
            (m.alt, crate::xtest::ALT_L),
            (m.shift, crate::xtest::SHIFT_L),
            (m.cmd, crate::xtest::SUPER_L),
        ]
        .into_iter()
        .filter_map(|(on, k)| on.then_some(k))
        .collect();
        let keysym = crate::xtest::key_keysym(stroke.key);
        if self.real_keys(move |x| x.stroke(&held, keysym)) == Some(true) {
            return Ok(());
        }
        // The app's shortcuts first, as GTK's shortcut controller (capture
        // phase) runs before the focus.
        if self
            .on_main(move |surface| crate::keymap::press(surface, stroke))
            .unwrap_or(false)
        {
            return Ok(());
        }
        let m = stroke.modifiers;
        let plain = !(m.ctrl || m.alt || m.cmd);
        let mut modifiers = gdk::ModifierType::empty();
        for (on, mask) in [
            (m.ctrl, gdk::ModifierType::CONTROL_MASK),
            (m.alt, gdk::ModifierType::ALT_MASK),
            (m.shift, gdk::ModifierType::SHIFT_MASK),
            (m.cmd, gdk::ModifierType::SUPER_MASK),
        ] {
            if on {
                modifiers |= mask;
            }
        }
        match stroke.key {
            // The focused field's own keys, through its signals.
            K::Enter if plain => {
                self.with_key_window(|_, w| synth::enter(w));
            }
            K::Backspace if plain => {
                self.with_key_window(|_, w| synth::backspace(w));
            }
            K::Char('a') if m.ctrl && !m.alt && !m.cmd => {
                self.with_key_window(|_, w| synth::select_all(w));
            }
            K::Char(c) if plain => {
                let c = if m.shift { shifted(c) } else { c };
                self.with_key_window(move |_, w| synth::type_text(w, &c.to_string()));
            }
            // The focused window's keys: Escape closes a window of the
            // app's own that `closeOnEscape` lets close; the main window's
            // go back.
            K::Escape | K::Left => {
                let key = if stroke.key == K::Escape {
                    gdk::Key::Escape
                } else {
                    gdk::Key::Left
                };
                self.on_main(move |surface| {
                    let window = crate::window::key_window(surface);
                    let main = synth::window(surface);
                    if let Some(window) = window.as_ref().filter(|&w| Some(w) != main.as_ref()) {
                        crate::window::press_key(surface, window, key, modifiers);
                        return;
                    }
                    crate::navigation::key_pressed(surface, key, modifiers);
                });
            }
            _ => {}
        }
        Ok(())
    }

    fn focused(&self) -> Option<NodeId> {
        self.with_key_window(|_, w| {
            let field = synth::focused_text(w)?;
            let view = field
                .ancestor(crate::view::NshView::static_type())
                .and_then(|v| v.downcast::<crate::view::NshView>().ok())?;
            Some(view.id())
        })
        .flatten()
    }

    fn paste(&self, content: &nsh_core::PasteEvent) -> Result<(), String> {
        // As the user's paste of `content` does (`text_input`'s `pasting`),
        // without the system's clipboard: reported, then its text inserted
        // where the input inserts pastes.
        let content = content.clone();
        self.with_key_window(move |surface, w| {
            let field = synth::focused_text(w).ok_or("no focused input to paste into")?;
            let view = field
                .ancestor(crate::view::NshView::static_type())
                .and_then(|v| v.downcast::<crate::view::NshView>().ok())
                .ok_or("the focused field is no input's")?;
            if view.state().events.contains(nsh_core::EventKind::Paste) {
                surface.event(
                    view.id(),
                    nsh_core::EventKind::Paste,
                    nsh_core::EventPayload::Paste(Box::new(content.clone())),
                );
            }
            if crate::text_input::pastes_text(&view) && !content.text.is_empty() {
                synth::type_text(w, &content.text);
            }
            Ok(())
        })
        .unwrap_or_else(|| Err("the window is gone".into()))
    }

    fn input_text(&self, id: NodeId) -> Option<String> {
        self.on_main(move |surface| {
            let view = surface.mounter.borrow().views.get(&id)?.clone();
            crate::text_input::current_text(&view)
        })
        .flatten()
    }

    fn back(&self) -> Result<(), String> {
        // Escape, as a user goes back: in a focused field it only leaves
        // it, so then once more.
        self.on_main(|s| {
            if crate::navigation::focused_field(s).is_some() {
                crate::navigation::key_pressed(s, gdk::Key::Escape, gdk::ModifierType::empty());
            }
            crate::navigation::key_pressed(s, gdk::Key::Escape, gdk::ModifierType::empty());
        })
        .ok_or_else(|| "the window is gone".to_owned())
    }

    fn answer_dialog(&self, button: Option<&str>) -> Result<(), String> {
        let button = button.map(str::to_owned);
        self.on_main(move |s| crate::system::answer_dialog(s, button.as_deref()))
            .unwrap_or_else(|| Err("the window is gone".into()))
    }

    fn animating(&self) -> bool {
        self.on_main(|s| s.animating()).unwrap_or(false)
    }

    fn screenshot(&self) -> Result<Vec<u8>, String> {
        let (tx, rx) = mpsc::channel();
        let key = self.key;
        glib::MainContext::default().invoke_with_priority(glib::Priority::DEFAULT, move || {
            let Some(window) = Surface::by_key(key).and_then(|s| synth::window(&s)) else {
                let _ = tx.send(Err("the window is gone".to_owned()));
                return;
            };
            // Once what changed so far is painted.
            synth::after_paint(&window, move |w| {
                let _ = tx.send(synth::shot(w));
            });
        });
        rx.recv_timeout(MAIN)
            .map_err(|_| "the window drew no picture".to_owned())?
    }

    fn window_screenshot(&self, window: NodeId) -> Result<Vec<u8>, String> {
        let (tx, rx) = mpsc::channel();
        let key = self.key;
        glib::MainContext::default().invoke_with_priority(glib::Priority::DEFAULT, move || {
            let Some(surface) = Surface::by_key(key) else {
                let _ = tx.send(Err("the window is gone".to_owned()));
                return;
            };
            // The main window's for `ROOT_ID`.
            let Some(native) = crate::window::native_window(&surface, window) else {
                let _ = tx.send(Err(format!("no window of the app has root node {window}")));
                return;
            };
            // Once what changed so far is painted, as `screenshot`.
            synth::after_paint(&native, move |w| {
                let _ = tx.send(synth::shot(w));
            });
        });
        rx.recv_timeout(MAIN)
            .map_err(|_| "the window drew no picture".to_owned())?
    }

    fn resize(&self, width: Points, height: Points) -> Result<(), String> {
        self.with_window(move |_, w| w.set_default_size(width.0 as i32, height.0 as i32))
            .ok_or_else(|| "the window is gone".to_owned())
    }

    fn set_dark(&self, dark: bool) -> Result<(), String> {
        self.on_main(move |_| crate::system::simulate_system_scheme(dark))
            .ok_or_else(|| "the window is gone".to_owned())
    }

    fn target_window(&self, window: NodeId) -> Result<(), String> {
        let open = self
            .on_main(move |s| crate::window::native_window(s, window).is_some())
            .ok_or("the window is gone")?;
        if !open {
            return Err(format!("no window of the app has root node {window}"));
        }
        self.target.store(window, Ordering::Relaxed);
        Ok(())
    }

    fn window_state(&self, window: NodeId) -> Result<Option<WindowState>, String> {
        self.on_main(move |s| crate::window::current_state(s, window))
            .ok_or_else(|| "the window is gone".to_owned())
    }

    fn press_window_close(&self, window: NodeId) -> Result<(), String> {
        // What the title bar's close button does: `gtk_window_close`,
        // whose `close-request` answers the window's policy.
        self.on_main(move |s| {
            let native = crate::window::native_window(s, window)
                .ok_or_else(|| format!("no window of the app has root node {window}"))?;
            crate::window::press_close(&native, nsh_core::desktop::CloseReason::CloseButton);
            Ok(())
        })
        .unwrap_or_else(|| Err("the window is gone".to_owned()))
    }

    fn quit(&self) {
        self.with_window(|_, w| w.close());
    }
}

/// The character Shift and `c` type on a US layout, as a keyboard's keys
/// name them: a letter's capital, a digit's or a symbol's upper sign.
fn shifted(c: char) -> char {
    const PAIRS: [(char, char); 21] = [
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
        ('`', '~'),
    ];
    PAIRS
        .iter()
        .find(|(plain, _)| *plain == c)
        .map_or(c.to_ascii_uppercase(), |(_, up)| *up)
}
