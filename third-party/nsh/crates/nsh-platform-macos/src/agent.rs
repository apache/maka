//! The platform's part of `nsh test --target macos` (`nsh_testing::agent`):
//! where a node's view is in the window, and the input a user's hands give
//! there, posted to the app as the system posts it ([`crate::synth`]).
//! The agent calls from a thread of its own; each call does its work on
//! the main queue (`exec_sync`) and returns once the input is posted.
//! Pointer input goes to the window the agent targets (the main one, or a
//! window of the app's own, by its root node), keys to the window that has
//! the keyboard; a view's bounds are in its own window's content.

use std::{
    cell::RefCell,
    rc::Rc,
    sync::Mutex,
    time::{Duration, Instant},
};

use dispatch2::DispatchQueue;
use nsh_core::{
    NodeId, ROOT_ID,
    desktop::WindowState,
    geometry::{Bounds, Point, Points, Size, point},
};
use nsh_testing::agent::{Key, Native};
use objc2::{
    MainThreadMarker,
    rc::Retained,
    runtime::{AnyClass, NSObjectProtocol},
};
use objc2_app_kit::{
    NSAppearance, NSAppearanceCustomization, NSAppearanceNameAqua, NSAppearanceNameDarkAqua,
    NSApplication, NSApplicationActivationPolicy, NSEvent, NSEventModifierFlags, NSEventType,
    NSView, NSWindow,
};
use objc2_foundation::{NSPoint, NSRect, NSSize};

use crate::{surface::Surface, synth};

/// How long a press waits for the app to become active at most (a locked
/// screen never lets it, and is not waited for).
const ACTIVATION: Duration = Duration::from_secs(1);
/// A display frame, where the window's screen tells none.
const FRAME: Duration = Duration::from_millis(16);
/// How long a screenshot waits for the window server to show the last
/// commit (three frames at 60 Hz): a picture taken at once was of the
/// frame before it.
const PRESENT: Duration = Duration::from_millis(50);
/// How far one gesture event scrolls at most, in points.
const GESTURE_STEP: f64 = 20.0;
/// How far a press may land from the last one, in points, and still count
/// as its next click (the window server's own distance is not public).
const CLICK_DISTANCE: f64 = 4.0;

/// A left button press: where, when (seconds since the system started)
/// and its click count.
#[derive(Clone, Copy)]
struct Click {
    x: f64,
    y: f64,
    time: f64,
    count: isize,
}

/// The surface the agent acts on, by key (its calls must be `Send`).
pub(crate) struct MacNative {
    key: u64,
    /// The last left button press, which the next one may follow.
    last_click: Mutex<Option<Click>>,
    /// The window pointer input goes to, by its root node.
    target: Mutex<NodeId>,
}

impl MacNative {
    pub(crate) fn new(key: u64) -> Self {
        MacNative {
            key,
            last_click: Mutex::new(None),
            target: Mutex::new(ROOT_ID),
        }
    }

    fn target(&self) -> NodeId {
        *self.target.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The click count of a left button press at `(x, y)` now: the window
    /// server stamps it on real presses, and AppKit and the input layer
    /// tell double and triple clicks by it. A press close to the last one
    /// within the system's double-click interval is its next click, as the
    /// window server counts them (on and on, not back to 1 after 3).
    fn click_count(&self, x: f64, y: f64) -> isize {
        let now = synth::timestamp();
        let mut last = self.last_click.lock().unwrap_or_else(|e| e.into_inner());
        let count = match *last {
            Some(last)
                if now - last.time <= NSEvent::doubleClickInterval()
                    && (x - last.x).abs() <= CLICK_DISTANCE
                    && (y - last.y).abs() <= CLICK_DISTANCE =>
            {
                last.count + 1
            }
            _ => 1,
        };
        *last = Some(Click {
            x,
            y,
            time: now,
            count,
        });
        count
    }

    /// `f` with the surface and its main window, on the main queue,
    /// waited for; `None` once either is gone.
    fn on_main<R: Send>(&self, f: impl FnOnce(&Rc<Surface>, &NSWindow) -> R + Send) -> Option<R> {
        self.on_window(Which::Main, f)
    }

    /// [`Self::on_main`] with the window the agent targets.
    fn on_target<R: Send>(&self, f: impl FnOnce(&Rc<Surface>, &NSWindow) -> R + Send) -> Option<R> {
        self.on_window(Which::Target(self.target()), f)
    }

    /// [`Self::on_main`] with the window that has the keyboard.
    fn on_key<R: Send>(&self, f: impl FnOnce(&Rc<Surface>, &NSWindow) -> R + Send) -> Option<R> {
        self.on_window(Which::Key, f)
    }

    fn on_window<R: Send>(
        &self,
        which: Which,
        f: impl FnOnce(&Rc<Surface>, &NSWindow) -> R + Send,
    ) -> Option<R> {
        let key = self.key;
        let mut out = None;
        let slot = &mut out;
        DispatchQueue::main().exec_sync(move || {
            let Some(surface) = Surface::with_key(key) else {
                return;
            };
            let window = match which {
                Which::Main => surface.root.ns().window(),
                Which::Target(id) => crate::window::window_of(&surface, id),
                Which::Key => crate::window::key_window(&surface),
            };
            let Some(window) = window else {
                return;
            };
            *slot = Some(f(&surface, &window));
        });
        out
    }

    /// A frame of the screen showing the window: a trackpad sends its
    /// gesture's events at the display's rate (120 Hz on ProMotion).
    fn frame(&self) -> Duration {
        self.on_target(|_, window| {
            let rate = window.screen()?.maximumFramesPerSecond();
            (rate > 0).then(|| Duration::from_secs_f64(1.0 / rate as f64))
        })
        .flatten()
        .unwrap_or(FRAME)
    }

    /// Makes the app active, as presses into web views need (in another
    /// app, a click into a page only activates it): waits for it a second
    /// at most. An app run in the background (`AppOptions::background`)
    /// cannot be activated, and is not asked to; nor is one while the
    /// screen is locked ([`crate::system::screen_locked`]), which never
    /// lets it: its presses into web views go to them directly
    /// ([`mouse`]).
    fn activate(&self) {
        let deadline = Instant::now() + ACTIVATION;
        while Instant::now() < deadline {
            let active = self.on_main(|_, window| {
                let app = NSApplication::sharedApplication(MainThreadMarker::from(window));
                if app.activationPolicy() == NSApplicationActivationPolicy::Prohibited
                    || app.isActive()
                {
                    return true;
                }
                if crate::system::screen_locked() {
                    log::debug!("the screen is locked: input goes to the inactive app");
                    return true;
                }
                #[allow(deprecated)]
                app.activateIgnoringOtherApps(true);
                app.isActive()
            });
            if active != Some(false) {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

thread_local! {
    /// The web view a left button press of the inactive app went to
    /// directly ([`mouse`]): its drags and its release follow it there.
    static WEB_PRESS: RefCell<Option<Retained<NSView>>> = const { RefCell::new(None) };
}

/// A left button event of `window` at `(x, y)` (content points), posted as
/// the system posts it ([`synth::mouse`]); but a press into a web view
/// while the app is not active (run in the background, or the screen
/// locked) goes to the web view directly, and so do its drags and its
/// release: AppKit hands an inactive app's window a first click only where
/// the view accepts the first mouse, which a `WKWebView` does not for a
/// click, so the press would only ask to activate the app. As
/// `WebViewRef.sendInput` hands a page its clicks (`native::web_input`),
/// and the web view takes the keyboard focus, as a click gives it.
fn mouse(window: &NSWindow, kind: NSEventType, x: f64, y: f64, clicks: isize) {
    let mtm = MainThreadMarker::from(window);
    let Some(event) = synth::mouse_event(window, kind, x, y, clicks, NSEventModifierFlags::empty())
    else {
        return;
    };
    let web = if kind == NSEventType::LeftMouseDown {
        let web = if NSApplication::sharedApplication(mtm).isActive() {
            None
        } else {
            web_view_at(window, &event)
        };
        WEB_PRESS.set(web.clone());
        web
    } else {
        WEB_PRESS.with_borrow(Clone::clone)
    };
    let Some(web) = web else {
        // Through the event queue, as real clicks come (`synth::mouse_with`).
        NSApplication::sharedApplication(mtm).postEvent_atStart(&event, false);
        return;
    };
    match kind {
        NSEventType::LeftMouseDown => {
            let focused = window
                .firstResponder()
                .is_some_and(|f| std::ptr::eq(Retained::as_ptr(&f).cast(), Retained::as_ptr(&web)));
            if !focused {
                window.makeFirstResponder(Some(&web));
            }
            web.mouseDown(&event);
        }
        NSEventType::LeftMouseDragged => web.mouseDragged(&event),
        _ => {
            WEB_PRESS.set(None);
            web.mouseUp(&event);
        }
    }
}

/// The web view (`WKWebView`) the press `event` lands in, picked as the
/// window picks the view a click goes to (the root's `hitTest:`).
fn web_view_at(window: &NSWindow, event: &NSEvent) -> Option<Retained<NSView>> {
    let web_class = AnyClass::get(c"WKWebView")?;
    let content = window.contentView()?;
    // `hitTest:` takes a point in the superview's coordinates.
    let p = match crate::view::superview(&content) {
        Some(outer) => outer.convertPoint_fromView(event.locationInWindow(), None),
        None => event.locationInWindow(),
    };
    let mut view = crate::view::scripted(event, || content.hitTest(p));
    while let Some(v) = view {
        if v.isKindOfClass(web_class) {
            return Some(v);
        }
        view = crate::view::superview(&v);
    }
    None
}

/// Which of the surface's windows a call acts in.
#[derive(Clone, Copy)]
enum Which {
    Main,
    /// A window by its root node (the main one's is the root).
    Target(NodeId),
    /// The window that has the keyboard.
    Key,
}

/// `rect` of view `ns` in its window's content, from its top left; `None`
/// when the view is in no window or hidden.
fn in_window(ns: &NSView, rect: NSRect) -> Option<Bounds<Points>> {
    let window = ns.window()?;
    if ns.isHiddenOrHasHiddenAncestor() {
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

/// `rect` of `view` (its coordinates) in the window's content, where it is
/// drawn: AppKit's conversion ([`in_window`]) places it as the frames and
/// scroll offsets do but leaves the views' layer transforms out, which
/// hit testing heeds, so each corner moves by what the transforms on the
/// way shift it ([`crate::input::to_top`]) and the box around them is
/// where it shows. A thumb centered with a `translate(-50%)` is pressed on
/// its middle.
fn mapped(view: &crate::view::NshView, rect: NSRect) -> Option<Bounds<Points>> {
    crate::scroll::commit_ancestors(view);
    let plain = in_window(view.ns(), rect)?;
    let (x0, y0) = (rect.origin.x as f32, rect.origin.y as f32);
    let (w, h) = (rect.size.width as f32, rect.size.height as f32);
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
    for (dx, dy) in [(0.0, 0.0), (w, 0.0), (0.0, h), (w, h)] {
        let corner = (x0 + dx, y0 + dy);
        let moved = crate::input::to_top(view, corner, true)?;
        let still = crate::input::to_top(view, corner, false)?;
        let x = plain.origin.x.0 + dx + moved.0 - still.0;
        let y = plain.origin.y.0 + dy + moved.1 - still.1;
        (min_x, min_y) = (min_x.min(x), min_y.min(y));
        (max_x, max_y) = (max_x.max(x), max_y.max(y));
    }
    Some(Bounds::new(
        point(Points(min_x), Points(min_y)),
        Size::new(Points(max_x - min_x), Points(max_y - min_y)),
    ))
}

/// Where `frame` goes to lie within `area` (both in screen coordinates,
/// from the bottom), moved as little as it takes; one wider or taller than
/// the area keeps its left edge and its top (the title bar) in it.
fn within(frame: NSRect, area: NSRect) -> NSPoint {
    let right = area.origin.x + area.size.width - frame.size.width;
    let x = frame.origin.x.min(right).max(area.origin.x);
    let top = area.origin.y + area.size.height - frame.size.height;
    let y = frame.origin.y.max(area.origin.y).min(top);
    NSPoint::new(x, y)
}

impl Native for MacNative {
    fn bounds(&self, id: NodeId) -> Option<Bounds<Points>> {
        self.on_main(|surface, _| {
            let mounter = surface.mounter.borrow();
            let view = mounter.views.get(&id)?;
            if !view.is_shown_in_tree() {
                return None;
            }
            mapped(view, view.ns().bounds())
        })
        .flatten()
    }

    fn text_bounds(&self, text: NodeId, start: u32, end: u32) -> Option<Bounds<Points>> {
        self.on_main(|surface, _| {
            let mounter = surface.mounter.borrow();
            let view = mounter.views.get(&text)?;
            if !view.is_shown_in_tree() {
                return None;
            }
            let rect = *crate::text::range_rects(&view.state(), start, end).first()?;
            mapped(view, rect)
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
        self.on_target(|_, window| {
            let clicks = self.click_count(x, y);
            // A real pointer arrives before it presses (hover state).
            synth::mouse(window, NSEventType::MouseMoved, x, y, 0);
            mouse(window, NSEventType::LeftMouseDown, x, y, clicks);
            mouse(window, NSEventType::LeftMouseUp, x, y, clicks);
        });
    }

    fn long_press(&self, at: Point<Points>, hold: Duration) {
        self.activate();
        let (x, y) = (f64::from(at.x.0), f64::from(at.y.0));
        let clicks = self.on_target(|_, window| {
            let clicks = self.click_count(x, y);
            synth::mouse(window, NSEventType::MouseMoved, x, y, 0);
            mouse(window, NSEventType::LeftMouseDown, x, y, clicks);
            clicks
        });
        std::thread::sleep(hold);
        let clicks = clicks.unwrap_or(1);
        self.on_target(|_, window| mouse(window, NSEventType::LeftMouseUp, x, y, clicks));
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
            self.on_target(move |_, window| {
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
        let clicks = self
            .on_target(move |_, window| {
                let clicks = self.click_count(x, y);
                synth::mouse(window, NSEventType::MouseMoved, x, y, 0);
                mouse(window, NSEventType::LeftMouseDown, x, y, clicks);
                clicks
            })
            .unwrap_or(1);
        std::thread::sleep(nsh_testing::agent::LANDING);
        let mut last = from;
        for at in nsh_testing::agent::drag_path(from, to) {
            std::thread::sleep(nsh_testing::agent::FRAME);
            let (x, y) = (f64::from(at.x.0), f64::from(at.y.0));
            self.on_target(move |_, window| {
                mouse(window, NSEventType::LeftMouseDragged, x, y, clicks);
            });
            last = at;
        }
        let (x, y) = (f64::from(last.x.0), f64::from(last.y.0));
        self.on_target(move |_, window| mouse(window, NSEventType::LeftMouseUp, x, y, clicks));
    }

    fn type_text(&self, text: &str) {
        let text = text.to_owned();
        self.on_key(move |surface, window| synth::type_text(surface, window, &text));
    }

    fn paste(&self, content: &nsh_core::PasteEvent) -> Result<(), String> {
        let content = content.clone();
        self.on_key(move |surface, window| {
            crate::text_input::paste_or_hold(surface, window, &content)
        })
        .unwrap_or_else(|| Err("the window is gone".into()))
    }

    fn key(&self, key: Key) {
        let name = match key {
            Key::Return => "Return",
            Key::Backspace => "BackSpace",
            Key::SelectAll => "cmd+a",
        };
        self.on_key(move |surface, window| synth::key(surface, window, name));
    }

    fn mouse(&self) -> bool {
        true
    }

    fn right_click(&self, at: Point<Points>) -> Result<(), String> {
        self.activate();
        // Another button's press ends a run of left clicks.
        *self.last_click.lock().unwrap_or_else(|e| e.into_inner()) = None;
        let (x, y) = (f64::from(at.x.0), f64::from(at.y.0));
        self.on_target(move |_, window| {
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
        self.on_target(move |surface, window| {
            let event = synth::mouse_event(
                window,
                NSEventType::MouseMoved,
                x,
                y,
                0,
                objc2_app_kit::NSEventModifierFlags::empty(),
            );
            if let Some(event) = event {
                let target = self.target();
                let root = (target != ROOT_ID)
                    .then(|| crate::window::root_view(surface, target))
                    .flatten();
                crate::input::enter(surface, root);
                crate::input::event(surface, &event);
                crate::input::enter(surface, None);
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
        self.on_key(move |surface, window| synth::key(surface, window, &name))
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
        self.on_key(|surface, window| {
            if crate::text_input::editing(surface) {
                synth::key(surface, window, "Escape");
            }
            synth::key(surface, window, "Escape");
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
        // The window server shows a commit a frame or two after it is
        // made: let it show the last one before taking its picture.
        self.on_main(|_, _| objc2_quartz_core::CATransaction::flush());
        std::thread::sleep(PRESENT);
        self.on_main(|_, window| synth::shot(window))
            .unwrap_or_else(|| Err("the window is gone".into()))
    }

    fn resize(&self, width: Points, height: Points) -> Result<(), String> {
        self.on_main(|_, window| {
            let content = NSSize::new(f64::from(width.0), f64::from(height.0));
            let old = window.frame();
            let size = window
                .frameRectForContentRect(NSRect::new(NSPoint::new(0.0, 0.0), content))
                .size;
            // Grown from its top left corner, it may reach past the
            // display's edge, where a screenshot of it shows nothing: moved
            // back just enough, so a window the app placed keeps its place
            // when it still fits. Its display is the one it was on (grown,
            // most of it may be on another).
            let top_left = NSPoint::new(old.origin.x, old.origin.y + old.size.height - size.height);
            let mut frame = NSRect::new(top_left, size);
            if let Some(screen) = window.screen() {
                frame.origin = within(frame, screen.visibleFrame());
            }
            // One change: a resize, then a move, left the screenshots that
            // followed misplaced on the window (its title bar in, its right
            // edge out).
            window.setFrame_display(frame, true);
        })
        .ok_or_else(|| "the window is gone".to_owned())
    }

    fn set_dark(&self, dark: bool) -> Result<(), String> {
        self.on_main(move |surface, window| {
            // SAFETY: immutable AppKit constants.
            let name = if dark {
                unsafe { NSAppearanceNameDarkAqua }
            } else {
                unsafe { NSAppearanceNameAqua }
            };
            let appearance = NSAppearance::appearanceNamed(name);
            window.setAppearance(appearance.as_deref());
            // Every window of the app's own follows, those it opens later
            // too (they inherit the application's), but for a window with
            // a color scheme of its own.
            NSApplication::sharedApplication(MainThreadMarker::from(window))
                .setAppearance(appearance.as_deref());
            crate::window::set_appearance(surface, appearance.as_deref());
        })
        .ok_or_else(|| "the window is gone".to_owned())
    }

    fn window_screenshot(&self, window: NodeId) -> Result<Vec<u8>, String> {
        self.on_main(move |surface, _| {
            let window =
                crate::window::window_of(surface, window).ok_or("no such window is open")?;
            synth::shot(&window)
        })
        .unwrap_or_else(|| Err("the window is gone".into()))
    }

    fn target_window(&self, window: NodeId) -> Result<(), String> {
        let open = self
            .on_main(move |surface, _| crate::window::window_of(surface, window).is_some())
            .ok_or_else(|| "the window is gone".to_owned())?;
        if !open {
            return Err("no such window is open".into());
        }
        *self.target.lock().unwrap_or_else(|e| e.into_inner()) = window;
        Ok(())
    }

    fn window_state(&self, window: NodeId) -> Result<Option<WindowState>, String> {
        self.on_main(move |surface, _| crate::window::state(surface, window))
            .ok_or_else(|| "the window is gone".to_owned())
    }

    fn press_window_close(&self, window: NodeId) -> Result<(), String> {
        self.on_main(move |surface, _| crate::window::press_close_button(surface, window))
            .unwrap_or_else(|| Err("the window is gone".to_owned()))
    }

    fn quit(&self) {
        self.on_main(|_, window| window.close());
    }
}
