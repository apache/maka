//! GPUI's input events into a surface's input handlers ([`crate::input`]).
//!
//! [`install`] runs in the surface element's paint (GPUI's mouse and key
//! listeners last one frame): mouse presses on the surface's hitbox, and
//! moves and releases while a press that began there lasts (GPUI captures
//! nothing: the listeners see every event of the window), wheel and
//! touchpad scrolls the hitbox should handle, and keys while the surface's
//! focus handle is in the focus path. Keys are heard in the bubble phase:
//! while one of the surface's native components has the focus, GPUI gives
//! it each key first (its bindings, then its listeners) and nsh sees only
//! what it let through ([`crate::input::component_key`]). Positions become root coordinates
//! (the surface's origin in the window subtracted); times are seconds of
//! the surface's clock. Each handler ends with [`crate::rt::flush`].
//!
//! GPUI takes the cursor from the frame (`set_cursor_style` while
//! painting): a move onto a view with another cursor draws the surface
//! again. Touchpad scrolls carry GPUI's phases into [`crate::input::touchpad`]
//! and touchpad pinches go to [`crate::input::touchpad_pinch`].

use std::rc::Rc;

use gpui::{
    App, Bounds, CursorStyle, DispatchPhase, FocusHandle, Hitbox, KeyDownEvent, KeyUpEvent,
    MouseButton, MouseDownEvent, MouseExitEvent, MouseMoveEvent, MouseUpEvent, PinchEvent, Pixels,
    ScrollDelta, ScrollWheelEvent, TouchPhase, Window,
};

use crate::{
    input::{Cursor, GesturePhase, KeyEvent, PointerEvent, PointerKind, WheelEvent},
    surface::Surface,
};

/// How many points a wheel line scrolls. GPUI counts a notch as three
/// lines on Linux and Windows (the systems' default), which then scrolls
/// 48 points as the Windows backend does; macOS reports lines of its own
/// (about one per notch, accelerated), counted as the macOS backend does.
#[cfg(target_os = "macos")]
pub(crate) const LINE: f32 = 10.0;
#[cfg(not(target_os = "macos"))]
pub(crate) const LINE: f32 = 16.0;

fn gesture_phase(phase: TouchPhase) -> GesturePhase {
    match phase {
        TouchPhase::Started => GesturePhase::Began,
        TouchPhase::Moved => GesturePhase::Moved,
        TouchPhase::Ended => GesturePhase::Ended,
        TouchPhase::Cancelled => GesturePhase::Cancelled,
    }
}

/// Points the surface's hitbox: the cursor over `(x, y)` (root
/// coordinates) for the next frame, which is drawn when it changed.
fn update_cursor(surface: &Rc<Surface>, x: f32, y: f32) {
    let c = crate::input::cursor(surface, x, y);
    if surface.input.cursor.replace(c) != c {
        surface.invalidate();
    }
}

fn button(b: MouseButton) -> Option<u8> {
    Some(match b {
        MouseButton::Left => 0,
        MouseButton::Right => 1,
        MouseButton::Middle => 2,
        MouseButton::Navigate(gpui::NavigationDirection::Back) => 3,
        MouseButton::Navigate(gpui::NavigationDirection::Forward) => 4,
    })
}

/// Ends the press of the primary button whose release never came (the
/// window lost it to another one, a system gesture took it).
fn cancel_press(surface: &Rc<Surface>, modifiers: &gpui::Modifiers) {
    surface.input_pressed.set(surface.input_pressed.get() & !1);
    crate::input::pointer(
        surface,
        PointerEvent {
            kind: PointerKind::Cancel,
            x: 0.0,
            y: 0.0,
            button: 0,
            pointer: 1,
            touch: false,
            pen: false,
            time: surface.clock(),
            modifiers: crate::keys::modifiers(modifiers),
            clicks: 0,
            pressed_button: None,
        },
    );
}

fn root_point(surface: &Surface, position: gpui::Point<Pixels>) -> (f32, f32) {
    let (ox, oy) = surface.origin.get();
    (f32::from(position.x) - ox, f32::from(position.y) - oy)
}

fn cursor_style(c: Cursor) -> CursorStyle {
    match c {
        Cursor::Arrow => CursorStyle::Arrow,
        Cursor::Hand => CursorStyle::PointingHand,
        Cursor::Text => CursorStyle::IBeam,
        Cursor::Crosshair => CursorStyle::Crosshair,
        Cursor::Move => CursorStyle::OpenHand,
        Cursor::NotAllowed => CursorStyle::OperationNotAllowed,
        Cursor::ResizeEw => CursorStyle::ResizeLeftRight,
        Cursor::ResizeNs => CursorStyle::ResizeUpDown,
        Cursor::Wait | Cursor::Progress | Cursor::Help => CursorStyle::Arrow,
        Cursor::Hidden => CursorStyle::Arrow,
    }
}

/// Listens to the window's input for `surface` this frame.
pub(crate) fn install(
    surface: &Rc<Surface>,
    focus: &FocusHandle,
    view: &gpui::WeakEntity<crate::app::AppView>,
    hitbox: &Hitbox,
    bounds: Bounds<Pixels>,
    window: &mut Window,
    cx: &mut App,
) {
    crate::native::apply_focus(surface, focus, window, cx);
    // The focused field's caret shows while the surface has the window's
    // focus; text and input methods come through the input handler.
    let has_focus = window.is_window_active() && focus.is_focused(window);
    if crate::text_input::window_focus(surface, has_focus) {
        window.refresh();
    }
    // The focused native field may change during an input burst before another
    // paint. The handler resolves that current field and accepts text dynamically.
    if let Some(view) = view.upgrade() {
        window.handle_input(focus, gpui::ElementInputHandler::new(bounds, view), cx);
    }

    if hitbox.is_hovered(window) {
        let (x, y) = root_point(surface, window.mouse_position());
        let c = crate::input::cursor(surface, x, y);
        surface.input.cursor.set(c);
        window.set_cursor_style(cursor_style(c), hitbox);
    }

    let s = surface.clone();
    let h = hitbox.clone();
    let f = focus.clone();
    window.on_mouse_event(move |e: &MouseDownEvent, phase, window, cx| {
        // Hit tested at the event's own position against the frame on
        // screen: a press is the surface's whatever the window last saw
        // (no move since it opened, keyboard input since).
        if phase != DispatchPhase::Bubble || !h.is_hovered_at(e.position, window) {
            return;
        }
        let Some(button) = button(e.button) else {
            return;
        };
        if !f.is_focused(window) {
            window.focus(&f, cx);
        }
        let (x, y) = root_point(&s, e.position);
        if button == 0 && s.input_pressed.get() & 1 != 0 {
            cancel_press(&s, &e.modifiers);
        }
        if button == 0 && crate::input::window_drag(&s, x, y) {
            #[cfg(not(windows))]
            window.start_window_move();
            return;
        }
        s.input_pressed.set(s.input_pressed.get() | 1 << button);
        crate::input::pointer(
            &s,
            PointerEvent {
                kind: PointerKind::Down,
                x,
                y,
                button,
                pointer: 1,
                touch: false,
                pen: false,
                time: s.clock(),
                modifiers: crate::keys::modifiers(&e.modifiers),
                clicks: e.click_count as u32,
                pressed_button: None,
            },
        );
        cx.stop_propagation();
        crate::rt::flush(cx);
    });

    let s = surface.clone();
    window.on_mouse_event(move |e: &MouseUpEvent, phase, _window, cx| {
        if phase != DispatchPhase::Bubble {
            return;
        }
        let Some(button) = button(e.button) else {
            return;
        };
        // Whatever this release ends, the button held is no longer known
        // (one pressed outside the surface, a Control-click released as
        // the left button): the next move says it again.
        s.input.button.set(None);
        let pressed = s.input_pressed.get();
        if pressed & 1 << button == 0 {
            return;
        }
        s.input_pressed.set(pressed & !(1 << button));
        let (x, y) = root_point(&s, e.position);
        crate::input::pointer(
            &s,
            PointerEvent {
                kind: PointerKind::Up,
                x,
                y,
                button,
                pointer: 1,
                touch: false,
                pen: false,
                time: s.clock(),
                modifiers: crate::keys::modifiers(&e.modifiers),
                clicks: e.click_count as u32,
                pressed_button: None,
            },
        );
        crate::rt::flush(cx);
    });

    let s = surface.clone();
    let h = hitbox.clone();
    window.on_mouse_event(move |e: &MouseMoveEvent, phase, window, cx| {
        if phase != DispatchPhase::Bubble {
            return;
        }
        let hovered = h.is_hovered_at(e.position, window);
        if s.input_pressed.get() & 1 != 0 && e.pressed_button.is_none() {
            cancel_press(&s, &e.modifiers);
        }
        let pressed = s.input_pressed.get() != 0;
        let (x, y) = root_point(&s, e.position);
        let kind = if hovered || pressed {
            s.input_hovered.set(true);
            PointerKind::Move
        } else if s.input_hovered.replace(false) {
            PointerKind::Leave
        } else {
            return;
        };
        if hovered {
            update_cursor(&s, x, y);
        }
        crate::input::pointer(
            &s,
            PointerEvent {
                kind,
                x,
                y,
                button: 0,
                pointer: 1,
                touch: false,
                pen: false,
                time: s.clock(),
                modifiers: crate::keys::modifiers(&e.modifiers),
                clicks: 0,
                pressed_button: e.pressed_button.and_then(button),
            },
        );
        crate::rt::flush(cx);
    });

    // The mouse left the window (moves outside it while a button is down
    // still come as moves).
    let s = surface.clone();
    window.on_mouse_event(move |e: &MouseExitEvent, phase, _window, cx| {
        if phase != DispatchPhase::Bubble
            || s.input_pressed.get() != 0
            || !s.input_hovered.replace(false)
        {
            return;
        }
        let (x, y) = root_point(&s, e.position);
        crate::input::pointer(
            &s,
            PointerEvent {
                kind: PointerKind::Leave,
                x,
                y,
                button: 0,
                pointer: 1,
                touch: false,
                pen: false,
                time: s.clock(),
                modifiers: crate::keys::modifiers(&e.modifiers),
                clicks: 0,
                pressed_button: e.pressed_button.and_then(button),
            },
        );
        crate::rt::flush(cx);
    });

    let s = surface.clone();
    let h = hitbox.clone();
    window.on_mouse_event(move |e: &ScrollWheelEvent, phase, window, cx| {
        if phase != DispatchPhase::Bubble || !h.should_handle_scroll(window) {
            return;
        }
        let (x, y) = root_point(&s, e.position);
        // GPUI's deltas move the content (positive: down / right); nsh's
        // scroll toward the end.
        let (dx, dy, precise) = match e.delta {
            ScrollDelta::Pixels(p) => (-f32::from(p.x), -f32::from(p.y), true),
            ScrollDelta::Lines(l) => (-l.x * LINE, -l.y * LINE, false),
        };
        let event = WheelEvent {
            x,
            y,
            dx,
            dy,
            precise,
            modifiers: crate::keys::modifiers(&e.modifiers),
            time: s.clock(),
        };
        if precise {
            crate::input::touchpad(&s, event, gesture_phase(e.touch_phase));
        } else {
            crate::input::wheel(&s, event);
        }
        cx.stop_propagation();
        crate::rt::flush(cx);
    });

    let s = surface.clone();
    let h = hitbox.clone();
    window.on_mouse_event(move |e: &PinchEvent, phase, window, cx| {
        if phase != DispatchPhase::Bubble {
            return;
        }
        // A pinch begins over the surface and is its own until it ends.
        let ours = s.input.pinching();
        if !ours && (e.phase != TouchPhase::Started || !h.is_hovered_at(e.position, window)) {
            return;
        }
        let (x, y) = root_point(&s, e.position);
        crate::input::touchpad_pinch(&s, x, y, e.delta, gesture_phase(e.phase));
        cx.stop_propagation();
        crate::rt::flush(cx);
    });

    let s = surface.clone();
    window.on_key_event(move |e: &KeyDownEvent, phase, window, cx| {
        if phase != DispatchPhase::Bubble {
            return;
        }
        crate::chrome::key_pressed(&s);
        let Some(vk) = crate::keys::vk_of(&e.keystroke.key) else {
            return;
        };
        let event = KeyEvent {
            vk,
            down: true,
            repeat: e.is_held,
            modifiers: crate::keys::modifiers(&e.keystroke.modifiers),
        };
        let handled = if crate::native::focused(&s, window) {
            crate::input::component_key(&s, event)
        } else {
            crate::input::key(&s, event)
        };
        if handled {
            cx.stop_propagation();
            window.prevent_default();
        }
        crate::rt::flush(cx);
    });

    let s = surface.clone();
    window.on_key_event(move |e: &KeyUpEvent, phase, window, cx| {
        if phase != DispatchPhase::Bubble {
            return;
        }
        let Some(vk) = crate::keys::vk_of(&e.keystroke.key) else {
            return;
        };
        let event = KeyEvent {
            vk,
            down: false,
            repeat: false,
            modifiers: crate::keys::modifiers(&e.keystroke.modifiers),
        };
        if crate::native::focused(&s, window) {
            crate::input::component_key(&s, event);
        } else {
            crate::input::key(&s, event);
        }
        crate::rt::flush(cx);
    });
    // The keymap's held key (see `crate::keymap::forget_held`), Alt alone
    // showing a menu bar that hides itself, and the views under a resting
    // mouse told of the new modifiers (`onMouseMove`).
    let s = surface.clone();
    window.on_modifiers_changed(move |e, _, cx| {
        crate::keymap::forget_held(&s);
        let modifiers = crate::keys::modifiers(&e.modifiers);
        crate::chrome::modifiers_changed(&s, &modifiers);
        crate::input::modifiers_changed(&s, modifiers);
        crate::rt::flush(cx);
    });
}
