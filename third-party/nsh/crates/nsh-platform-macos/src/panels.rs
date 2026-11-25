//! The open and save panels an app has up (`file_requests.rs`: `pick_paths`,
//! `pick_save_path`, `Picker.pickFiles`; `picker.rs`: `Picker.pickImages`),
//! by surface. The user closes a panel by answering it. If the app stops or
//! its surface drops first, the panel would stay on the host's window and
//! block it, and its answer would go to an engine that is gone. [`close`]
//! takes the panels away with the app, as [`crate::system::clear`] does the
//! alerts.

use std::cell::RefCell;

use objc2::{Message, msg_send, rc::Retained, runtime::AnyObject};

use crate::surface::Surface;

struct Open {
    /// The surface the panel shows for ([`Surface::key`]).
    surface: u64,
    /// An `NSSavePanel` (or an `NSOpenPanel`).
    panel: Retained<AnyObject>,
}

thread_local! {
    static OPEN: RefCell<Vec<Open>> = const { RefCell::new(Vec::new()) };
}

/// `panel` shows for `surface` until [`finished`] or [`close`]. `try_with`
/// throughout: a surface also drops as the thread ends.
pub(crate) fn track(surface: &Surface, panel: &AnyObject) {
    let open = Open {
        surface: surface.key(),
        panel: panel.retain(),
    };
    let _ = OPEN.try_with(|o| o.borrow_mut().push(open));
}

/// `panel` was answered by the user: it is no longer tracked. `false` when
/// [`close`] took it before, so its answer is not for the app any more.
/// `true` when the list is gone with the thread: nothing closed the panel,
/// so its handler runs as it always did.
pub(crate) fn finished(panel: &AnyObject) -> bool {
    OPEN.try_with(|o| {
        let mut open = o.borrow_mut();
        let at = open.iter().position(|p| std::ptr::eq(&*p.panel, panel));
        at.map(|at| open.remove(at)).is_some()
    })
    .unwrap_or(true)
}

/// The app stopped, or the surface went: its panels close, unanswered.
/// `cancel:` ends the panel with `NSModalResponseCancel`; its completion
/// handler then finds the panel no longer tracked ([`finished`]) and does
/// nothing.
pub(crate) fn close(surface: &Surface) {
    let key = surface.key();
    let taken = OPEN.try_with(|o| {
        let Ok(mut open) = o.try_borrow_mut() else {
            return Vec::new();
        };
        let (ours, rest): (Vec<Open>, Vec<Open>) = std::mem::take(&mut *open)
            .into_iter()
            .partition(|p| p.surface == key);
        *open = rest;
        ours
    });
    for Open { panel, .. } in taken.unwrap_or_default() {
        // SAFETY: AppKit's documented NSSavePanel `cancel:`, on the main
        // thread (nil sender).
        unsafe {
            let _: () = msg_send![&panel, cancel: std::ptr::null::<AnyObject>()];
        }
    }
}
