//! The platform's part of `nsh test --target gpui` (`nsh_testing::agent`):
//! where a node's view is in the window, and the input a user's hands give
//! there, through the handlers real input goes through ([`crate::synth`]).
//! The agent calls from a thread of its own; each call does its work on
//! GPUI's main thread ([`crate::rt::invoke`], then with the app) and
//! returns once it is done.

use std::{rc::Rc, time::Duration};

use gpui::{App, Context, Window, WindowHandle};
use nsh_core::{
    NodeId,
    geometry::{Bounds, Point, Points, Size, point},
};
use nsh_testing::agent::{Key, Native};

use crate::{
    app::AppView,
    input::{Modifiers, PointerEvent, PointerKind, WheelEvent},
    surface::Surface,
    synth,
};

/// How long a call waits for the main thread at most.
const MAIN: Duration = Duration::from_secs(10);
/// A press's hold, as a quick click's.
const CLICK: Duration = Duration::from_millis(60);
/// A precise scroll's events, a display frame apart.
const FRAME: Duration = Duration::from_millis(16);
/// How far one scroll event moves at most, in points.
const SCROLL_STEP: f32 = 20.0;

/// The surface the agent acts on, by key (its calls must be `Send`).
pub(crate) struct GpuiNative {
    key: u64,
}

/// The window showing the surface `key`.
fn window_of(key: u64, cx: &App) -> Option<WindowHandle<AppView>> {
    cx.windows().into_iter().find_map(|handle| {
        let handle = handle.downcast::<AppView>()?;
        let shows = handle
            .read_with(cx, |view, _| view.surface().key() == key)
            .unwrap_or(false);
        shows.then_some(handle)
    })
}

impl GpuiNative {
    pub(crate) fn new(key: u64) -> Self {
        GpuiNative { key }
    }

    /// `f` with the window's view on the main thread, waited for (what it
    /// changed drawn after); `None` once the window is gone.
    fn on_main<R: Send + 'static>(
        &self,
        f: impl FnOnce(&mut AppView, &mut Window, &mut Context<AppView>) -> R + Send + 'static,
    ) -> Option<R> {
        let (tx, rx) = std::sync::mpsc::channel();
        let key = self.key;
        crate::rt::invoke(move || {
            crate::rt::on_app(move |cx| {
                let r = window_of(key, cx).and_then(|handle| {
                    handle
                        .update(cx, |view, window, cx| {
                            let r = f(view, window, cx);
                            crate::rt::flush(cx);
                            r
                        })
                        .ok()
                });
                let _ = tx.send(r);
            });
        });
        rx.recv_timeout(MAIN).ok().flatten()
    }

    /// `f` with the surface, on the main thread.
    fn with_surface<R: Send + 'static>(
        &self,
        f: impl FnOnce(&Rc<Surface>) -> R + Send + 'static,
    ) -> Option<R> {
        self.on_main(move |view, _, _| f(&view.surface().clone()))
    }

    /// A press or release of the mouse's `button` at `at`, or a move to it
    /// with `button` held when `held`; a press first focuses the window's
    /// view, as a real one does ([`crate::events`]).
    fn mouse(&self, kind: PointerKind, at: Point<Points>, button: u8, held: bool) {
        let (x, y) = (at.x.0, at.y.0);
        self.on_main(move |view, window, cx| {
            if kind == PointerKind::Down {
                let focus = gpui::Focusable::focus_handle(view, cx);
                if !focus.is_focused(window) {
                    window.focus(&focus, cx);
                }
            }
            let surface = view.surface().clone();
            crate::input::pointer(
                &surface,
                PointerEvent {
                    kind,
                    x,
                    y,
                    button,
                    pointer: 1,
                    touch: false,
                    pen: false,
                    time: surface.clock(),
                    modifiers: Modifiers::default(),
                    clicks: 1,
                    pressed_button: held.then_some(button),
                },
            );
        });
    }

    fn click(&self, at: Point<Points>, hold: Duration, button: u8) {
        self.mouse(PointerKind::Down, at, button, false);
        std::thread::sleep(hold);
        self.mouse(PointerKind::Up, at, button, false);
    }
}

impl Native for GpuiNative {
    fn bounds(&self, id: NodeId) -> Option<Bounds<Points>> {
        self.with_surface(move |surface| {
            let view = surface.mounter.borrow().views.get(id)?;
            let to_root = view.to_root()?;
            let size = view.state().frame.size;
            mapped_bounds(
                |x, y| to_root.map(x, y),
                (0.0, 0.0, size.width.0, size.height.0),
            )
        })
        .flatten()
    }

    fn text_bounds(&self, text: NodeId, start: u32, end: u32) -> Option<Bounds<Points>> {
        self.with_surface(move |surface| {
            let view = surface.mounter.borrow().views.get(text)?;
            let rect = crate::text::range_rect(&view.state(), start, end)?;
            let to_root = view.to_root()?;
            mapped_bounds(|x, y| to_root.map(x, y), rect)
        })
        .flatten()
    }

    fn viewport(&self) -> Size<Points> {
        self.on_main(|_, window, _| {
            let size = window.viewport_size();
            Size::new(
                Points(f32::from(size.width)),
                Points(f32::from(size.height)),
            )
        })
        .unwrap_or(Size::new(Points(0.0), Points(0.0)))
    }

    fn press(&self, at: Point<Points>) {
        self.click(at, CLICK, 0);
    }

    fn long_press(&self, at: Point<Points>, hold: Duration) {
        self.click(at, hold, 0);
    }

    fn scroll(&self, at: Point<Points>, delta: Point<Points>) {
        let (x, y) = (at.x.0, at.y.0);
        let (dx, dy) = (delta.x.0, delta.y.0);
        // A precise touchpad's events, a frame apart, adding up to it.
        let n = (dx.abs().max(dy.abs()) / SCROLL_STEP).ceil().max(1.0) as u32;
        for _ in 0..n {
            self.with_surface(move |surface| {
                crate::input::wheel(
                    surface,
                    WheelEvent {
                        x,
                        y,
                        dx: dx / n as f32,
                        dy: dy / n as f32,
                        precise: true,
                        modifiers: Modifiers::default(),
                        time: surface.clock(),
                    },
                );
            });
            std::thread::sleep(FRAME);
        }
    }

    fn drag(&self, from: Point<Points>, to: Point<Points>) {
        self.mouse(PointerKind::Move, from, 0, false);
        self.mouse(PointerKind::Down, from, 0, false);
        std::thread::sleep(nsh_testing::agent::LANDING);
        let mut last = from;
        for at in nsh_testing::agent::drag_path(from, to) {
            std::thread::sleep(FRAME);
            self.mouse(PointerKind::Move, at, 0, true);
            last = at;
        }
        self.mouse(PointerKind::Up, last, 0, false);
    }

    fn type_text(&self, text: &str) {
        let text = text.to_owned();
        self.with_surface(move |surface| crate::text_input::char_input(surface, &text));
    }

    fn key(&self, key: Key) {
        let (vk, command) = match key {
            Key::Return => (0x0D, false),
            Key::Backspace => (0x08, false),
            Key::SelectAll => (u16::from(b'A'), true),
        };
        // The platform's command key: Command on macOS, else Ctrl.
        let modifiers = Modifiers {
            meta: command && cfg!(target_os = "macos"),
            ctrl: command && !cfg!(target_os = "macos"),
            ..Modifiers::default()
        };
        self.with_surface(move |surface| synth::press(surface, vk, modifiers));
    }

    fn mouse(&self) -> bool {
        true
    }

    fn right_click(&self, at: Point<Points>) -> Result<(), String> {
        // The secondary button.
        self.click(at, CLICK, 1);
        Ok(())
    }

    fn choose_menu_item(&self, path: &[String]) -> Result<(), String> {
        let path = path.to_vec();
        self.with_surface(move |surface| crate::chrome::choose_menu_path(surface, &path))
            .unwrap_or_else(|| Err("the window is gone".to_owned()))
    }

    fn close_menu(&self) -> Result<(), String> {
        self.with_surface(|surface| crate::chrome::close_menu(surface))
            .unwrap_or_else(|| Err("the window is gone".to_owned()))
    }

    fn hover(&self, at: Point<Points>) -> Result<(), String> {
        self.mouse(PointerKind::Move, at, 0, false);
        Ok(())
    }

    fn press_keys(&self, keys: &str) -> Result<(), String> {
        use nsh_core::platform::Os;
        let os = if cfg!(target_os = "macos") {
            Os::MacOs
        } else if cfg!(windows) {
            Os::Windows
        } else {
            Os::Linux
        };
        let stroke = nsh_core::keymap::Keystroke::parse(keys, os).map_err(|e| e.to_string())?;
        let vk = stroke
            .key
            .virtual_key()
            .ok_or_else(|| format!("{keys:?} has no key on this keyboard"))?;
        let m = stroke.modifiers;
        let modifiers = Modifiers {
            shift: m.shift,
            ctrl: m.ctrl,
            alt: m.alt,
            meta: m.cmd,
        };
        self.with_surface(move |surface| synth::press(surface, vk, modifiers))
            .ok_or_else(|| "the window is gone".to_owned())
    }

    fn input_text(&self, id: NodeId) -> Option<String> {
        self.with_surface(move |surface| {
            let view = surface.mounter.borrow().views.get(id)?;
            crate::text_input::current_text(&view)
        })
        .flatten()
    }

    fn back(&self) -> Result<(), String> {
        // The mouse's back button goes back from wherever the focus is
        // ([`crate::input`]), as in browsers.
        let middle = self.viewport();
        let at = point(Points(middle.width.0 / 2.0), Points(middle.height.0 / 2.0));
        self.click(at, CLICK, 3);
        Ok(())
    }

    fn answer_dialog(&self, button: Option<&str>) -> Result<(), String> {
        let button = button.map(str::to_owned);
        let (x, y) = self
            .with_surface(move |surface| crate::system::dialog_point(surface, button.as_deref()))
            .unwrap_or_else(|| Err("the window is gone".into()))?;
        self.click(point(Points(x), Points(y)), CLICK, 0);
        Ok(())
    }

    fn animating(&self) -> bool {
        self.with_surface(|surface| surface.animating())
            .unwrap_or(false)
    }

    fn screenshot(&self) -> Result<Vec<u8>, String> {
        let (tx, rx) = std::sync::mpsc::channel();
        let key = self.key;
        crate::rt::invoke(move || {
            crate::rt::on_app(move |cx| {
                let Some(handle) = window_of(key, cx) else {
                    let _ = tx.send(Err("the window is gone".to_owned()));
                    return;
                };
                cx.spawn(async move |cx| {
                    let png = match synth::frame(handle, cx).await {
                        None => Err("the window is gone".to_owned()),
                        Some(Err(err)) => Err(format!("{err:#}")),
                        Some(Ok((frame, _))) => {
                            let mut png = std::io::Cursor::new(Vec::new());
                            frame
                                .write_to(&mut png, ::image::ImageFormat::Png)
                                .map(|()| png.into_inner())
                                .map_err(|e| e.to_string())
                        }
                    };
                    let _ = tx.send(png);
                })
                .detach();
            });
        });
        rx.recv_timeout(MAIN * 2)
            .map_err(|_| "the window drew no picture".to_owned())?
    }

    fn resize(&self, width: Points, height: Points) -> Result<(), String> {
        self.on_main(move |_, window, _| {
            window.resize(gpui::size(gpui::px(width.0), gpui::px(height.0)));
        })
        .ok_or_else(|| "the window is gone".to_owned())
    }

    fn set_dark(&self, dark: bool) -> Result<(), String> {
        self.on_main(move |_, window, _| {
            crate::system::simulate_system_scheme(dark);
            window.refresh();
        })
        .ok_or_else(|| "the window is gone".to_owned())
    }

    fn quit(&self) {
        self.on_main(|_, window, _| window.remove_window());
    }
}

/// The box `(x, y, width, height)` of a view (in its coordinates) in the
/// root's, through `map`, the view's transform to the root: the box
/// around its mapped corners.
fn mapped_bounds(
    map: impl Fn(f32, f32) -> Option<(f32, f32)>,
    (x, y, width, height): (f32, f32, f32, f32),
) -> Option<Bounds<Points>> {
    let corners = [
        (x, y),
        (x + width, y),
        (x, y + height),
        (x + width, y + height),
    ];
    let mapped: Vec<(f32, f32)> = corners
        .iter()
        .map(|&(x, y)| map(x, y))
        .collect::<Option<_>>()?;
    let (x0, y0) = mapped
        .iter()
        .fold((f32::MAX, f32::MAX), |(a, b), &(x, y)| (a.min(x), b.min(y)));
    let (x1, y1) = mapped
        .iter()
        .fold((f32::MIN, f32::MIN), |(a, b), &(x, y)| (a.max(x), b.max(y)));
    Some(Bounds::new(
        point(Points(x0), Points(y0)),
        Size::new(Points(x1 - x0), Points(y1 - y0)),
    ))
}
