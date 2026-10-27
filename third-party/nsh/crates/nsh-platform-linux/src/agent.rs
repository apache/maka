//! The platform's part of `nsh test --target linux` (`nsh_testing::agent`):
//! where a node's view is in the window, and the input a user's hands give
//! there, through the handlers real input goes through ([`crate::synth`]).
//! The agent calls from a thread of its own; each call does its work on
//! the GTK main thread and returns once it is done. Calls go at the
//! default priority, as input does: an idle source (`MainContext::invoke`)
//! waits for a busy main loop (software rendering redrawing) to be idle.

use std::{
    rc::Rc,
    sync::mpsc,
    time::{Duration, Instant},
};

use gtk4::{self as gtk, gdk, glib, prelude::*};
use nsh_core::{
    NodeId,
    geometry::{Bounds, Point, Points, Size, point},
};
use nsh_testing::agent::{Key, Native};

use crate::{input::Simulated, surface::Surface, synth};

/// How long a call waits for the main thread at most.
const MAIN: Duration = Duration::from_secs(10);
/// A press's hold, as a quick click's.
const CLICK: Duration = Duration::from_millis(60);
/// A display frame, where the window's monitor tells none.
const FRAME: Duration = Duration::from_millis(16);
/// How far one scroll event moves at most, in points.
const SCROLL_STEP: f32 = 20.0;

/// The surface the agent acts on, by key (its calls must be `Send`).
pub(crate) struct LinuxNative {
    key: u64,
}

impl LinuxNative {
    pub(crate) fn new(key: u64) -> Self {
        LinuxNative { key }
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

    fn click(&self, at: Point<Points>, hold: Duration) {
        let (x, y) = (at.x.0, at.y.0);
        // A real pointer arrives before it presses (hover state).
        self.on_main(move |s| {
            crate::input::simulate(s, Simulated::Hover(x, y));
            crate::input::simulate(s, Simulated::Down(x, y));
        });
        std::thread::sleep(hold);
        self.on_main(move |s| crate::input::simulate(s, Simulated::Up(x, y)));
    }
}

impl Native for LinuxNative {
    fn bounds(&self, id: NodeId) -> Option<Bounds<Points>> {
        self.on_main(move |surface| {
            let view = surface.mounter.borrow().views.get(&id)?.clone();
            if !view.is_drawable() {
                return None;
            }
            let r = view.compute_bounds(&surface.root)?;
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
            let r = view.compute_bounds(&surface.root)?;
            Some(Bounds::new(
                point(Points(r.x() + x), Points(r.y() + y)),
                Size::new(Points(width), Points(height)),
            ))
        })
        .flatten()
    }

    fn viewport(&self) -> Size<Points> {
        let (width, height) = self
            .on_main(|s| (s.root.width() as f32, s.root.height() as f32))
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
            self.on_main(move |s| crate::input::simulate(s, Simulated::Wheel(x, y, sx, sy)));
            next += frame;
            std::thread::sleep(next.saturating_duration_since(Instant::now()));
        }
    }

    fn drag(&self, from: Point<Points>, to: Point<Points>) {
        let (x, y) = (from.x.0, from.y.0);
        self.on_main(move |s| {
            crate::input::simulate(s, Simulated::Hover(x, y));
            crate::input::simulate(s, Simulated::Down(x, y));
        });
        std::thread::sleep(nsh_testing::agent::LANDING);
        let mut last = from;
        for at in nsh_testing::agent::drag_path(from, to) {
            std::thread::sleep(FRAME);
            let (x, y) = (at.x.0, at.y.0);
            self.on_main(move |s| crate::input::simulate(s, Simulated::Move(x, y)));
            last = at;
        }
        let (x, y) = (last.x.0, last.y.0);
        self.on_main(move |s| crate::input::simulate(s, Simulated::Up(x, y)));
    }

    fn type_text(&self, text: &str) {
        // Key by key, as a keyboard's characters come.
        for ch in text.chars() {
            self.with_window(move |_, w| synth::type_text(w, &ch.to_string()));
        }
    }

    fn key(&self, key: Key) {
        self.with_window(move |_, w| match key {
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
        self.on_main(move |s| crate::input::simulate(s, Simulated::ContextMenu(x, y)))
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

    fn hover(&self, at: Point<Points>) -> Result<(), String> {
        let (x, y) = (at.x.0, at.y.0);
        self.on_main(move |s| crate::input::simulate(s, Simulated::Hover(x, y)))
            .ok_or_else(|| "the window is gone".to_owned())
    }

    fn press_keys(&self, keys: &str) -> Result<(), String> {
        use nsh_core::keymap::{Key as K, Keystroke};
        let stroke =
            Keystroke::parse(keys, nsh_core::platform::Os::Linux).map_err(|e| e.to_string())?;
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
                self.with_window(|_, w| synth::enter(w));
            }
            K::Backspace if plain => {
                self.with_window(|_, w| synth::backspace(w));
            }
            K::Char('a') if m.ctrl && !m.alt && !m.cmd => {
                self.with_window(|_, w| synth::select_all(w));
            }
            K::Char(c) if plain => {
                let c = if m.shift { c.to_ascii_uppercase() } else { c };
                self.with_window(move |_, w| synth::type_text(w, &c.to_string()));
            }
            // The root's keys: going back.
            K::Escape | K::Left => {
                let key = if stroke.key == K::Escape {
                    gdk::Key::Escape
                } else {
                    gdk::Key::Left
                };
                self.on_main(move |surface| {
                    crate::navigation::key_pressed(surface, key, modifiers);
                });
            }
            _ => {}
        }
        Ok(())
    }

    fn paste(&self, content: &nsh_core::PasteEvent) -> Result<(), String> {
        // As the user's paste of `content` does (`text_input`'s `pasting`),
        // without the system's clipboard: reported, then its text inserted
        // where the input inserts pastes.
        let content = content.clone();
        self.with_window(move |surface, w| {
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

    fn resize(&self, width: Points, height: Points) -> Result<(), String> {
        self.with_window(move |_, w| w.set_default_size(width.0 as i32, height.0 as i32))
            .ok_or_else(|| "the window is gone".to_owned())
    }

    fn set_dark(&self, dark: bool) -> Result<(), String> {
        self.on_main(move |_| crate::system::simulate_system_scheme(dark))
            .ok_or_else(|| "the window is gone".to_owned())
    }

    fn quit(&self) {
        self.with_window(|_, w| w.close());
    }
}
