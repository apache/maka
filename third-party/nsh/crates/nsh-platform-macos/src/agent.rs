//! The platform's part of `nsh test --target macos` (`nsh_testing::agent`):
//! where a node's view is in the window, and the input a user's hands give
//! there, posted to the app as the system posts it ([`crate::synth`]).
//! The agent calls from a thread of its own; each call does its work on
//! the main queue (`exec_sync`) and returns once the input is posted.

use std::{
    rc::Rc,
    time::{Duration, Instant},
};

use dispatch2::DispatchQueue;
use nsh_core::{
    NodeId,
    geometry::{Bounds, Point, Points, Size, point},
};
use nsh_testing::agent::{Key, Native};
use objc2::MainThreadMarker;
use objc2_app_kit::{
    NSAppearance, NSAppearanceCustomization, NSAppearanceNameAqua, NSAppearanceNameDarkAqua,
    NSApplication, NSEventType, NSView, NSWindow,
};
use objc2_foundation::{NSRect, NSSize};

use crate::{surface::Surface, synth};

/// How long a press waits for the app to become active at most (a locked
/// screen never lets it).
const ACTIVATION: Duration = Duration::from_secs(1);
/// A display frame, where the window's screen tells none.
const FRAME: Duration = Duration::from_millis(16);
/// How far one gesture event scrolls at most, in points.
const GESTURE_STEP: f64 = 20.0;

/// The surface the agent acts on, by key (its calls must be `Send`).
pub(crate) struct MacNative {
    key: u64,
}

impl MacNative {
    pub(crate) fn new(key: u64) -> Self {
        MacNative { key }
    }

    /// `f` with the surface and its window, on the main queue, waited for;
    /// `None` once either is gone.
    fn on_main<R: Send>(&self, f: impl FnOnce(&Rc<Surface>, &NSWindow) -> R + Send) -> Option<R> {
        let key = self.key;
        let mut out = None;
        let slot = &mut out;
        DispatchQueue::main().exec_sync(move || {
            let Some(surface) = Surface::with_key(key) else {
                return;
            };
            let Some(window) = surface.root.ns().window() else {
                return;
            };
            *slot = Some(f(&surface, &window));
        });
        out
    }

    /// A frame of the screen showing the window: a trackpad sends its
    /// gesture's events at the display's rate (120 Hz on ProMotion).
    fn frame(&self) -> Duration {
        self.on_main(|_, window| {
            let rate = window.screen()?.maximumFramesPerSecond();
            (rate > 0).then(|| Duration::from_secs_f64(1.0 / rate as f64))
        })
        .flatten()
        .unwrap_or(FRAME)
    }

    /// Makes the app active, as presses into web views need (in another
    /// app, a click into a page only activates it): waits for it a second
    /// at most.
    fn activate(&self) {
        let deadline = Instant::now() + ACTIVATION;
        while Instant::now() < deadline {
            let active = self.on_main(|_, window| {
                let app = NSApplication::sharedApplication(MainThreadMarker::from(window));
                if !app.isActive() {
                    #[allow(deprecated)]
                    app.activateIgnoringOtherApps(true);
                }
                app.isActive()
            });
            if active != Some(false) {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

/// `rect` of view `ns` in the window's content, from its top left; `None`
/// when the view is not in the window or hidden.
fn in_window(ns: &NSView, rect: NSRect, window: &NSWindow) -> Option<Bounds<Points>> {
    if ns.window().is_none() || ns.isHiddenOrHasHiddenAncestor() {
        return None;
    }
    // Window coordinates (from the bottom left), as the content view's are.
    let rect = ns.convertRect_toView(rect, None);
    let height = window.contentView()?.frame().size.height;
    Some(Bounds::new(
        point(
            Points(rect.origin.x as f32),
            Points((height - rect.origin.y - rect.size.height) as f32),
        ),
        Size::new(
            Points(rect.size.width as f32),
            Points(rect.size.height as f32),
        ),
    ))
}

impl Native for MacNative {
    fn bounds(&self, id: NodeId) -> Option<Bounds<Points>> {
        self.on_main(|surface, window| {
            let mounter = surface.mounter.borrow();
            let view = mounter.views.get(&id)?;
            crate::scroll::commit_ancestors(view);
            in_window(view.ns(), view.ns().bounds(), window)
        })
        .flatten()
    }

    fn text_bounds(&self, text: NodeId, start: u32, end: u32) -> Option<Bounds<Points>> {
        self.on_main(|surface, window| {
            let mounter = surface.mounter.borrow();
            let view = mounter.views.get(&text)?;
            crate::scroll::commit_ancestors(view);
            let rect = *crate::text::range_rects(&view.state(), start, end).first()?;
            in_window(view.ns(), rect, window)
        })
        .flatten()
    }

    fn viewport(&self) -> Size<Points> {
        self.on_main(|_, window| {
            let size = window.contentView().map(|v| v.frame().size);
            size.map_or(Size::new(Points(0.0), Points(0.0)), |s| {
                Size::new(Points(s.width as f32), Points(s.height as f32))
            })
        })
        .unwrap_or(Size::new(Points(0.0), Points(0.0)))
    }

    fn press(&self, at: Point<Points>) {
        self.activate();
        let (x, y) = (f64::from(at.x.0), f64::from(at.y.0));
        self.on_main(|_, window| {
            // A real pointer arrives before it presses (hover state).
            synth::mouse(window, NSEventType::MouseMoved, x, y, 0);
            synth::mouse(window, NSEventType::LeftMouseDown, x, y, 1);
            synth::mouse(window, NSEventType::LeftMouseUp, x, y, 1);
        });
    }

    fn long_press(&self, at: Point<Points>, hold: Duration) {
        self.activate();
        let (x, y) = (f64::from(at.x.0), f64::from(at.y.0));
        self.on_main(|_, window| {
            synth::mouse(window, NSEventType::MouseMoved, x, y, 0);
            synth::mouse(window, NSEventType::LeftMouseDown, x, y, 1);
        });
        std::thread::sleep(hold);
        self.on_main(|_, window| synth::mouse(window, NSEventType::LeftMouseUp, x, y, 1));
    }

    fn scroll(&self, at: Point<Points>, delta: Point<Points>) {
        let (x, y) = (f64::from(at.x.0), f64::from(at.y.0));
        let (dx, dy) = (f64::from(delta.x.0), f64::from(delta.y.0));
        // A trackpad gesture: began, changed events a frame apart carrying
        // whole points that add up to the distance, ended (no momentum).
        // On a schedule, so the main thread's hops do not slow them down.
        let frames = ((dx.abs().max(dy.abs()) / GESTURE_STEP).ceil() as u32).max(1);
        let frame = self.frame();
        let mut next = Instant::now();
        let mut gesture = |dx: i32, dy: i32, phase: i64| {
            self.on_main(move |_, window| {
                synth::wheel_with(window, x, y, dx, dy, Some(phase), 0, synth::timestamp());
            });
            next += frame;
            std::thread::sleep(next.saturating_duration_since(Instant::now()));
        };
        gesture(0, 0, 1);
        let (mut sent_x, mut sent_y) = (0, 0);
        for i in 1..=frames {
            let t = f64::from(i) / f64::from(frames);
            let (to_x, to_y) = ((dx * t).round() as i32, (dy * t).round() as i32);
            gesture(to_x - sent_x, to_y - sent_y, 2);
            (sent_x, sent_y) = (to_x, to_y);
        }
        gesture(0, 0, 4);
    }

    fn drag(&self, from: Point<Points>, to: Point<Points>) {
        self.activate();
        let (x, y) = (f64::from(from.x.0), f64::from(from.y.0));
        self.on_main(move |_, window| {
            synth::mouse(window, NSEventType::MouseMoved, x, y, 0);
            synth::mouse(window, NSEventType::LeftMouseDown, x, y, 1);
        });
        std::thread::sleep(nsh_testing::agent::LANDING);
        let mut last = from;
        for at in nsh_testing::agent::drag_path(from, to) {
            std::thread::sleep(nsh_testing::agent::FRAME);
            let (x, y) = (f64::from(at.x.0), f64::from(at.y.0));
            self.on_main(move |_, window| {
                synth::mouse(window, NSEventType::LeftMouseDragged, x, y, 1);
            });
            last = at;
        }
        let (x, y) = (f64::from(last.x.0), f64::from(last.y.0));
        self.on_main(move |_, window| synth::mouse(window, NSEventType::LeftMouseUp, x, y, 1));
    }

    fn type_text(&self, text: &str) {
        let text = text.to_owned();
        self.on_main(move |_, window| synth::type_text(window, &text));
    }

    fn paste(&self, content: &nsh_core::PasteEvent) -> Result<(), String> {
        let content = content.clone();
        self.on_main(move |_, window| crate::text_input::test_paste(window, &content))
            .unwrap_or_else(|| Err("the window is gone".into()))
    }

    fn key(&self, key: Key) {
        let name = match key {
            Key::Return => "Return",
            Key::Backspace => "BackSpace",
            Key::SelectAll => "cmd+a",
        };
        self.on_main(move |_, window| synth::key(window, name));
    }

    fn mouse(&self) -> bool {
        true
    }

    fn right_click(&self, at: Point<Points>) -> Result<(), String> {
        self.activate();
        let (x, y) = (f64::from(at.x.0), f64::from(at.y.0));
        self.on_main(move |_, window| {
            synth::mouse(window, NSEventType::RightMouseDown, x, y, 1);
            synth::mouse(window, NSEventType::RightMouseUp, x, y, 1);
        })
        .ok_or_else(|| "the window is gone".to_owned())
    }

    fn choose_menu_item(&self, path: &[String]) -> Result<(), String> {
        let path = path.to_vec();
        self.on_main(move |_, _| crate::chrome::choose_open_menu(&path))
            .unwrap_or_else(|| Err("the window is gone".to_owned()))
    }

    fn close_menu(&self) -> Result<(), String> {
        self.on_main(|_, _| crate::chrome::close_open_menu())
            .unwrap_or_else(|| Err("the window is gone".to_owned()))
    }

    fn hover(&self, at: Point<Points>) -> Result<(), String> {
        let (x, y) = (f64::from(at.x.0), f64::from(at.y.0));
        // Straight to the surface's input: AppKit hands a posted mouse
        // move to the first responder only, not to the view under it.
        self.on_main(move |surface, window| {
            let event = synth::mouse_event(
                window,
                NSEventType::MouseMoved,
                x,
                y,
                0,
                objc2_app_kit::NSEventModifierFlags::empty(),
            );
            if let Some(event) = event {
                crate::input::event(surface, &event);
            }
        })
        .ok_or_else(|| "the window is gone".to_owned())
    }

    fn press_keys(&self, keys: &str) -> Result<(), String> {
        use nsh_core::keymap::{Key, Keystroke};
        let stroke =
            Keystroke::parse(keys, nsh_core::platform::Os::MacOs).map_err(|e| e.to_string())?;
        // As `synth::key` names keys: modifiers, then the key.
        let mut name = String::new();
        let m = stroke.modifiers;
        for (on, prefix) in [
            (m.cmd, "cmd+"),
            (m.ctrl, "ctrl+"),
            (m.alt, "alt+"),
            (m.shift, "shift+"),
        ] {
            if on {
                name.push_str(prefix);
            }
        }
        name.push_str(&match stroke.key {
            Key::Char(' ') => "space".into(),
            Key::Char(c) => c.to_string(),
            Key::Enter => "Return".into(),
            Key::Escape => "Escape".into(),
            Key::Tab => "Tab".into(),
            Key::Backspace => "BackSpace".into(),
            Key::Delete => "Delete".into(),
            Key::Insert => "Help".into(),
            Key::Up => "Up".into(),
            Key::Down => "Down".into(),
            Key::Left => "Left".into(),
            Key::Right => "Right".into(),
            Key::Home => "Home".into(),
            Key::End => "End".into(),
            Key::PageUp => "Page_Up".into(),
            Key::PageDown => "Page_Down".into(),
            Key::F(n) => format!("F{n}"),
        });
        self.activate();
        self.on_main(move |_, window| synth::key(window, &name))
            .ok_or_else(|| "the window is gone".to_owned())
    }

    fn input_text(&self, id: NodeId) -> Option<String> {
        self.on_main(|surface, _| {
            let mounter = surface.mounter.borrow();
            crate::text_input::current_text(mounter.views.get(&id)?)
        })
        .flatten()
    }

    fn back(&self) -> Result<(), String> {
        // Escape, as a user goes back: in a focused field it only leaves
        // it, so then once more.
        self.on_main(|surface, window| {
            if crate::text_input::editing(surface) {
                synth::key(window, "Escape");
            }
            synth::key(window, "Escape");
        })
        .ok_or_else(|| "the window is gone".to_owned())
    }

    fn answer_dialog(&self, button: Option<&str>) -> Result<(), String> {
        let button = button.map(str::to_owned);
        self.on_main(move |surface, _| crate::system::answer_dialog(surface, button.as_deref()))
            .unwrap_or_else(|| Err("the window is gone".into()))
    }

    fn animating(&self) -> bool {
        self.on_main(|surface, _| surface.animating())
            .unwrap_or(false)
    }

    fn screenshot(&self) -> Result<Vec<u8>, String> {
        self.on_main(|_, window| synth::shot(window))
            .unwrap_or_else(|| Err("the window is gone".into()))
    }

    fn resize(&self, width: Points, height: Points) -> Result<(), String> {
        self.on_main(|_, window| {
            window.setContentSize(NSSize::new(f64::from(width.0), f64::from(height.0)));
        })
        .ok_or_else(|| "the window is gone".to_owned())
    }

    fn set_dark(&self, dark: bool) -> Result<(), String> {
        self.on_main(move |_, window| {
            // SAFETY: immutable AppKit constants.
            let name = if dark {
                unsafe { NSAppearanceNameDarkAqua }
            } else {
                unsafe { NSAppearanceNameAqua }
            };
            window.setAppearance(NSAppearance::appearanceNamed(name).as_deref());
        })
        .ok_or_else(|| "the window is gone".to_owned())
    }

    fn quit(&self) {
        self.on_main(|_, window| window.close());
    }
}
