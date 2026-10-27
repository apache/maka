//! Input as a user's hands give it, made in process (on the main thread):
//! pointers and wheels through the handlers real input goes through
//! ([`crate::input::simulate`]), text and keys into the focused field, and
//! pictures of the window rendered offscreen. The agent of `nsh test
//! --target linux` acts with them ([`crate::agent`]).

use std::{cell::RefCell, rc::Rc, time::Duration};

use gtk4::{self as gtk, gdk, glib, prelude::*};

use crate::surface::Surface;

/// The window showing `surface`.
pub(crate) fn window(surface: &Surface) -> Option<gtk::Window> {
    surface.root.root()?.downcast::<gtk::Window>().ok()
}

/// Runs `f` right after the window's next frame is painted (or after
/// half a second when no frame comes).
///
/// `GtkWidgetPaintable` draws the render nodes widgets kept from their
/// last frame, and a widget queueing a draw drops its node (and those of
/// its ancestors) until the next frame: a web view's page does so every
/// time it paints, so a shot taken between frames came out empty or
/// without the page.
pub(crate) fn after_paint(window: &gtk::Window, f: impl FnOnce(&gtk::Window) + 'static) {
    let Some(clock) = window.frame_clock() else {
        f(window);
        return;
    };
    let f = Rc::new(RefCell::new(Some(f)));
    let handler = Rc::new(std::cell::Cell::new(None::<glib::SignalHandlerId>));
    let run = {
        let window = window.clone();
        let clock = clock.clone();
        let handler = handler.clone();
        move || {
            if let Some(id) = handler.take() {
                clock.disconnect(id);
            }
            if let Some(f) = f.borrow_mut().take() {
                f(&window);
            }
        }
    };
    let run = Rc::new(run);
    handler.set(Some(clock.connect_after_paint({
        let run = run.clone();
        move |_| run()
    })));
    glib::timeout_add_local_once(Duration::from_millis(500), move || run());
    if let Some(child) = window.child() {
        child.queue_draw();
    }
}

/// Renders the window's content offscreen at its scale, as a PNG,
/// whatever covers the window on screen.
pub(crate) fn shot(window: &gtk::Window) -> Result<Vec<u8>, String> {
    let child = window.child().ok_or("the window shows nothing")?;
    let (w, h) = (child.width(), child.height());
    let scale = f64::from(window.scale_factor().max(1));
    let paintable = gtk::WidgetPaintable::new(Some(&child));
    let snapshot = gtk::Snapshot::new();
    snapshot.scale(scale as f32, scale as f32);
    paintable.snapshot(&snapshot, f64::from(w), f64::from(h));
    let (pw, ph) = ((f64::from(w) * scale) as f32, (f64::from(h) * scale) as f32);
    // An empty surface renders no node: a blank picture all the same.
    let node = snapshot.to_node().unwrap_or_else(|| {
        gtk::gsk::ColorNode::new(
            &gdk::RGBA::TRANSPARENT,
            &gtk::graphene::Rect::new(0.0, 0.0, pw, ph),
        )
        .upcast()
    });
    let renderer = window.renderer().ok_or("the window has no renderer")?;
    let bounds = gtk::graphene::Rect::new(0.0, 0.0, pw, ph);
    let texture = renderer.render_texture(&node, Some(&bounds));
    Ok(texture.save_to_png_bytes().to_vec())
}

/// The focused text field of `window`: a line's `GtkText` or an area's
/// `GtkTextView`.
pub(crate) fn focused_text(window: &gtk::Window) -> Option<gtk::Widget> {
    let mut focus = gtk::prelude::GtkWindowExt::focus(window)?;
    loop {
        if focus.is::<gtk::Text>() || focus.is::<gtk::TextView>() {
            return Some(focus);
        }
        focus = focus.parent()?;
    }
}

/// Types `text` into the focused field at its caret, as a keyboard's
/// characters come in (the field's checks see each insertion).
pub(crate) fn type_text(window: &gtk::Window, text: &str) {
    match focused_text(window) {
        Some(w) => {
            if let Some(t) = w.downcast_ref::<gtk::Text>() {
                let mut pos = t.position();
                t.insert_text(text, &mut pos);
                t.set_position(pos);
            } else if let Some(v) = w.downcast_ref::<gtk::TextView>() {
                v.buffer().insert_interactive_at_cursor(text, true);
            }
        }
        None => log::warn!("test: no focused text field to type into"),
    }
}

/// Selects all the focused field's text.
pub(crate) fn select_all(window: &gtk::Window) {
    match focused_text(window) {
        Some(w) => {
            if let Some(t) = w.downcast_ref::<gtk::Text>() {
                t.select_region(0, -1);
            } else if let Some(v) = w.downcast_ref::<gtk::TextView>() {
                let b = v.buffer();
                b.select_range(&b.start_iter(), &b.end_iter());
            }
        }
        None => log::warn!("test: no focused text field to select in"),
    }
}

/// Return in the focused field: a line submits (`activate`), an area
/// starts a new line.
pub(crate) fn enter(window: &gtk::Window) {
    match focused_text(window) {
        Some(w) => {
            if let Some(t) = w.downcast_ref::<gtk::Text>() {
                t.emit_by_name::<()>("activate", &[]);
            } else if let Some(v) = w.downcast_ref::<gtk::TextView>() {
                v.buffer().insert_interactive_at_cursor("\n", true);
            }
        }
        None => log::warn!("test: no focused text field to press Return in"),
    }
}

/// Backspace in the focused field: deletes the selection or the character
/// before the caret.
pub(crate) fn backspace(window: &gtk::Window) {
    match focused_text(window) {
        Some(w) => {
            if let Some(t) = w.downcast_ref::<gtk::Text>() {
                t.emit_by_name::<()>("backspace", &[]);
            } else if let Some(v) = w.downcast_ref::<gtk::TextView>() {
                v.emit_by_name::<()>("backspace", &[]);
            }
        }
        None => log::warn!("test: no focused text field to press Backspace in"),
    }
}
