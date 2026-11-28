//! OLE local-file destinations, using the surface's retained hit-test tree.
use std::{
    cell::{Cell, RefCell},
    ffi::OsString,
    os::windows::ffi::OsStringExt,
    path::PathBuf,
    rc::{Rc, Weak},
};

use nsh_core::{EventKind, EventPayload, NodeId, Points, ROOT_ID};
use windows::{
    Win32::{
        Foundation::{HWND, POINT, POINTL},
        Graphics::Gdi::ScreenToClient,
        System::{
            Com::{DVASPECT_CONTENT, FORMATETC, IDataObject, TYMED_HGLOBAL},
            Ole::{
                CF_HDROP, DROPEFFECT, DROPEFFECT_COPY, DROPEFFECT_NONE, IDropTarget,
                IDropTarget_Impl, RegisterDragDrop, ReleaseStgMedium, RevokeDragDrop,
            },
            SystemServices::MODIFIERKEYS_FLAGS,
        },
        UI::Shell::{DragQueryFileW, HDROP},
    },
    core::{Ref, Result, implement},
};

use crate::{input, surface::Surface, view::NshView};

#[derive(Default)]
pub(crate) struct State {
    target: RefCell<Option<NshView>>,
    destinations: RefCell<Destinations>,
    /// The windows a destination is registered on: the main window's and
    /// those of the app's own (`<Window>`), each taking drops for the
    /// views it shows.
    registered: RefCell<Vec<HWND>>,
    offered: Cell<bool>,
    uris: RefCell<Vec<String>>,
}

#[derive(Default)]
struct Destinations {
    /// The views that take drops, by id (a table that follows the views
    /// alive, not every id made).
    enabled: nsh_core::id_table::IdTable<()>,
}

impl Destinations {
    fn set(&mut self, id: NodeId, enabled: bool) {
        let index = id as usize;
        if self.enabled.contains(index) == enabled {
            return;
        }
        if enabled {
            self.enabled.insert(index, ());
        } else {
            self.enabled.remove(index);
        }
    }

    fn count(&self) -> usize {
        self.enabled.len()
    }
}

pub(crate) fn events_changed(surface: &Rc<Surface>, view: &NshView) {
    let enabled = view.state().events.contains(EventKind::FileDrop);
    if enabled {
        surface
            .file_drop
            .destinations
            .borrow_mut()
            .set(view.id(), true);
        register(surface, ROOT_ID, surface.hwnd());
        for id in crate::app_window::ids(surface) {
            if let Some(hwnd) = crate::app_window::hwnd_of(surface, id) {
                register(surface, id, hwnd);
            }
        }
    } else {
        deleted(surface, view.id());
    }
}

/// A window of the app's own opened: it takes drops too while views listen.
pub(crate) fn window_opened(surface: &Rc<Surface>, id: NodeId, hwnd: HWND) {
    if surface.file_drop.destinations.borrow().count() > 0 {
        register(surface, id, hwnd);
    }
}

/// A window of the app's own is about to be destroyed.
pub(crate) fn window_closing(surface: &Surface, hwnd: HWND) {
    let mut registered = surface.file_drop.registered.borrow_mut();
    if let Some(index) = registered.iter().position(|h| *h == hwnd) {
        registered.swap_remove(index);
        revoke(hwnd);
    }
}

/// Registers a destination on `hwnd`, the window showing `window`'s tree
/// (`ROOT_ID`: the main window's), unless it has one.
fn register(surface: &Rc<Surface>, window: NodeId, hwnd: HWND) {
    if hwnd.is_invalid() || surface.file_drop.registered.borrow().contains(&hwnd) {
        return;
    }
    let destination: IDropTarget = Destination {
        surface: Rc::downgrade(surface),
        window,
        hwnd,
    }
    .into();
    // SAFETY: mounted views and OLE destinations belong to the window's
    // UI thread. OLE retains the interface until RevokeDragDrop.
    match unsafe { RegisterDragDrop(hwnd, &destination) } {
        Ok(()) => surface.file_drop.registered.borrow_mut().push(hwnd),
        Err(error) => log::warn!("Could not register file drop destination: {error}"),
    }
}

fn revoke(hwnd: HWND) {
    // SAFETY: the registration belongs to this live HWND on this thread.
    if let Err(error) = unsafe { RevokeDragDrop(hwnd) } {
        log::warn!("Could not revoke file drop destination: {error}");
    }
}

pub(crate) fn deleted(surface: &Surface, id: NodeId) {
    surface.file_drop.destinations.borrow_mut().set(id, false);
    invalidate(surface, id);
    if surface.file_drop.destinations.borrow().count() == 0 {
        reset(surface);
    }
}

/// Ends the old destination's drag state without discarding OLE's offer.
pub(crate) fn invalidate(surface: &Surface, id: NodeId) {
    let matches = surface
        .file_drop
        .target
        .borrow()
        .as_ref()
        .is_some_and(|view| view.id() == id);
    if matches {
        set_target(surface, None);
    }
}

pub(crate) fn reset(surface: &Surface) {
    for hwnd in std::mem::take(&mut *surface.file_drop.registered.borrow_mut()) {
        revoke(hwnd);
    }
    *surface.file_drop.destinations.borrow_mut() = Destinations::default();
    surface.file_drop.offered.set(false);
    surface.file_drop.uris.borrow_mut().clear();
    set_target(surface, None);
}

fn set_target(surface: &Surface, next: Option<NshView>) {
    let previous = {
        let mut current = surface.file_drop.target.borrow_mut();
        if current.as_ref().map(NshView::id) == next.as_ref().map(NshView::id) {
            return;
        }
        std::mem::replace(&mut *current, next.clone())
    };
    if let Some(previous) = previous
        && previous.state().events.contains(EventKind::FileDragLeave)
    {
        surface.event(previous.id(), EventKind::FileDragLeave, EventPayload::None);
    }
    if let Some(next) = next
        && next.state().events.contains(EventKind::FileDragEnter)
    {
        surface.event(
            next.id(),
            EventKind::FileDragEnter,
            EventPayload::FileDrop(surface.file_drop.uris.borrow().clone()),
        );
    }
}

fn update(surface: &Surface, place: Place, point: &POINTL, effect: *mut DROPEFFECT) {
    if effect.is_null() {
        set_target(surface, None);
        return;
    }
    // SAFETY: OLE supplies an in/out effect pointer for this callback.
    let copy_allowed = unsafe { (*effect).0 & DROPEFFECT_COPY.0 != 0 };
    let target = if copy_allowed
        && surface.file_drop.offered.get()
        && let Some((x, y)) = client_points(surface, place, point)
    {
        // A window of the app's own picks views in its own tree.
        let _root = (place.window != ROOT_ID)
            .then(|| crate::app_window::enter(surface, place.window))
            .flatten();
        input::file_drop_target(surface, x, y)
    } else {
        None
    };
    // SAFETY: checked above; the effect is returned synchronously to OLE.
    unsafe {
        *effect = if target.is_some() {
            DROPEFFECT_COPY
        } else {
            DROPEFFECT_NONE
        }
    };
    set_target(surface, target);
}

/// OLE's drag point (`point`, screen pixels) in the window's client area,
/// in points: the root coordinates pointer input and hit testing use.
fn client_points(surface: &Surface, place: Place, point: &POINTL) -> Option<(f32, f32)> {
    let mut client = POINT {
        x: point.x,
        y: point.y,
    };
    // SAFETY: the surface owns the destination HWND; client is writable.
    unsafe { ScreenToClient(place.hwnd, &mut client) }
        .as_bool()
        .then(|| {
            // As the window's pointer input scales ([`crate::window`]).
            let scale = if place.window == ROOT_ID {
                surface.scale()
            } else {
                crate::window::dpi(place.hwnd) as f32 / 96.0
            };
            (client.x as f32 / scale, client.y as f32 / scale)
        })
}

fn format() -> FORMATETC {
    FORMATETC {
        cfFormat: CF_HDROP.0,
        dwAspect: DVASPECT_CONTENT.0,
        lindex: -1,
        tymed: TYMED_HGLOBAL.0 as u32,
        ..Default::default()
    }
}

fn files(data: &IDataObject) -> Vec<String> {
    // SAFETY: a typed CF_HDROP request; the returned medium is released below.
    let Ok(mut medium) = (unsafe { data.GetData(&format()) }) else {
        return Vec::new();
    };
    let mut uris = Vec::new();
    if medium.tymed == TYMED_HGLOBAL.0 as u32 {
        // SAFETY: HGLOBAL is the active union member for this medium. Shell
        // reads the HDROP handle directly; ownership stays with STGMEDIUM.
        let drop = HDROP(unsafe { medium.u.hGlobal }.0);
        let count = unsafe { DragQueryFileW(drop, u32::MAX, None) };
        for index in 0..count {
            // SAFETY: querying a file from the returned CF_HDROP list.
            let length = unsafe { DragQueryFileW(drop, index, None) };
            let Some(capacity) = length.checked_add(1) else {
                continue;
            };
            let mut name = vec![0; capacity as usize];
            // SAFETY: the buffer includes room for the trailing NUL.
            let copied = unsafe { DragQueryFileW(drop, index, Some(&mut name)) };
            if copied != length || copied == 0 {
                continue;
            }
            let path = PathBuf::from(OsString::from_wide(&name[..copied as usize]));
            if path.is_absolute()
                && let Ok(uri) = url::Url::from_file_path(path)
                && uri
                    .host_str()
                    .is_none_or(|host| host.is_empty() || host.eq_ignore_ascii_case("localhost"))
            {
                uris.push(uri.into());
            }
        }
    }
    // SAFETY: this medium was obtained from IDataObject::GetData and is
    // released exactly once; DragFinish would incorrectly free it twice.
    unsafe { ReleaseStgMedium(&mut medium) };
    uris
}

#[cfg(feature = "dev")]
/// Drops `uris` at `x`, `y` (points, root coordinates) as a file
/// manager's drag ends there, for the test agent: false when no view there
/// takes file drops.
pub(crate) fn drop_uris(surface: &Surface, x: f32, y: f32, uris: Vec<String>) -> bool {
    let Some(destination) = input::file_drop_target(surface, x, y) else {
        return false;
    };
    if uris.is_empty() {
        return false;
    }
    *surface.file_drop.uris.borrow_mut() = uris.clone();
    set_target(surface, Some(destination.clone()));
    surface.event(
        destination.id(),
        EventKind::FileDrop,
        EventPayload::FileDropAt {
            uris,
            page_position: nsh_core::prelude::point(nsh_core::Points(x), nsh_core::Points(y)),
        },
    );
    surface.file_drop.uris.borrow_mut().clear();
    set_target(surface, None);
    true
}

/// The window a destination takes drops for.
#[derive(Clone, Copy)]
struct Place {
    /// Its tree's root: `ROOT_ID` for the main window, else the dialog
    /// root of a window of the app's own.
    window: NodeId,
    hwnd: HWND,
}

#[implement(IDropTarget)]
struct Destination {
    surface: Weak<Surface>,
    window: NodeId,
    hwnd: HWND,
}

impl Destination {
    fn place(&self) -> Place {
        Place {
            window: self.window,
            hwnd: self.hwnd,
        }
    }
}

impl IDropTarget_Impl for Destination_Impl {
    fn DragEnter(
        &self,
        data: Ref<IDataObject>,
        _keys: MODIFIERKEYS_FLAGS,
        point: &POINTL,
        effect: *mut DROPEFFECT,
    ) -> Result<()> {
        if let Some(surface) = self.surface.upgrade() {
            // SAFETY: QueryGetData checks availability without reading files.
            let offered = data
                .as_ref()
                .is_some_and(|data| unsafe { data.QueryGetData(&format()) }.is_ok());
            surface.file_drop.offered.set(offered);
            // Eligibility stays with QueryGetData; the URLs are best effort, so
            // a source whose CF_HDROP fails to render at entry is still
            // accepted. CF_HDROP holds filenames only; keep them for target
            // changes during DragOver, which receives no IDataObject.
            *surface.file_drop.uris.borrow_mut() = if offered {
                data.as_ref().map(files).unwrap_or_default()
            } else {
                Vec::new()
            };
            update(&surface, self.place(), point, effect);
        } else if !effect.is_null() {
            // SAFETY: OLE's callback output pointer.
            unsafe { *effect = DROPEFFECT_NONE };
        }
        Ok(())
    }

    fn DragOver(
        &self,
        _keys: MODIFIERKEYS_FLAGS,
        point: &POINTL,
        effect: *mut DROPEFFECT,
    ) -> Result<()> {
        if let Some(surface) = self.surface.upgrade() {
            update(&surface, self.place(), point, effect);
        } else if !effect.is_null() {
            // SAFETY: OLE's callback output pointer.
            unsafe { *effect = DROPEFFECT_NONE };
        }
        Ok(())
    }

    fn DragLeave(&self) -> Result<()> {
        if let Some(surface) = self.surface.upgrade() {
            surface.file_drop.offered.set(false);
            surface.file_drop.uris.borrow_mut().clear();
            set_target(&surface, None);
        }
        Ok(())
    }

    fn Drop(
        &self,
        data: Ref<IDataObject>,
        _keys: MODIFIERKEYS_FLAGS,
        point: &POINTL,
        effect: *mut DROPEFFECT,
    ) -> Result<()> {
        if let Some(surface) = self.surface.upgrade() {
            update(&surface, self.place(), point, effect);
            let target = surface.file_drop.target.borrow().clone();
            let uris = if target.is_some() {
                data.as_ref().map(files).unwrap_or_default()
            } else {
                Vec::new()
            };
            if let Some(target) = target
                && !uris.is_empty()
                && let Some((x, y)) = client_points(&surface, self.place(), point)
            {
                let payload = EventPayload::FileDropAt {
                    uris,
                    page_position: nsh_core::prelude::point(Points(x), Points(y)),
                };
                surface.event(target.id(), EventKind::FileDrop, payload);
            } else if !effect.is_null() {
                // SAFETY: OLE's callback output pointer.
                unsafe { *effect = DROPEFFECT_NONE };
            }
            surface.file_drop.offered.set(false);
            surface.file_drop.uris.borrow_mut().clear();
            set_target(&surface, None);
        } else if !effect.is_null() {
            // SAFETY: OLE's callback output pointer.
            unsafe { *effect = DROPEFFECT_NONE };
        }
        Ok(())
    }
}

/// Terminal file transport uses the same native hit target and enter/drop/leave events.
#[cfg(feature = "terminal")]
pub(crate) fn terminal_drop(
    surface: &Surface,
    paths: Vec<std::path::PathBuf>,
    position: nsh_core::Point<nsh_core::Points>,
) {
    let target = input::file_drop_target(surface, position.x.0, position.y.0);
    set_target(surface, target.clone());
    let uris: Vec<_> = paths
        .into_iter()
        .filter_map(|p| url::Url::from_file_path(p).ok().map(String::from))
        .collect();
    if let Some(target) = target
        && !uris.is_empty()
    {
        surface.event(
            target.id(),
            EventKind::FileDrop,
            EventPayload::FileDrop(uris),
        );
    }
    set_target(surface, None);
}
