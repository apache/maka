//! OLE local-file destinations, using the surface's retained hit-test tree.
use std::{
    cell::{Cell, RefCell},
    ffi::OsString,
    os::windows::ffi::OsStringExt,
    path::PathBuf,
    rc::{Rc, Weak},
};

use nsh_core::{EventKind, EventPayload, NodeId};
use windows::{
    Win32::{
        Foundation::{POINT, POINTL},
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
    registered: Cell<bool>,
    offered: Cell<bool>,
}

#[derive(Default)]
struct Destinations {
    enabled: Vec<bool>,
    count: usize,
}

impl Destinations {
    fn set(&mut self, id: NodeId, enabled: bool) {
        let index = id as usize;
        if self.enabled.get(index).copied().unwrap_or(false) == enabled {
            return;
        }
        if enabled {
            self.enabled
                .resize(self.enabled.len().max(index + 1), false);
            self.count += 1;
        } else {
            self.count -= 1;
        }
        self.enabled[index] = enabled;
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
        if !surface.file_drop.registered.get() {
            let destination: IDropTarget = Destination {
                surface: Rc::downgrade(surface),
            }
            .into();
            // SAFETY: mounted views and OLE destinations belong to the window's
            // UI thread. OLE retains the interface until RevokeDragDrop.
            match unsafe { RegisterDragDrop(surface.hwnd(), &destination) } {
                Ok(()) => surface.file_drop.registered.set(true),
                Err(error) => log::warn!("Could not register file drop destination: {error}"),
            }
        }
    } else {
        deleted(surface, view.id());
    }
}

pub(crate) fn deleted(surface: &Surface, id: NodeId) {
    surface.file_drop.destinations.borrow_mut().set(id, false);
    invalidate(surface, id);
    if surface.file_drop.destinations.borrow().count == 0 {
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
    if surface.file_drop.registered.replace(false) {
        // SAFETY: the registration belongs to this live HWND on this thread.
        if let Err(error) = unsafe { RevokeDragDrop(surface.hwnd()) } {
            log::warn!("Could not revoke file drop destination: {error}");
        }
    }
    *surface.file_drop.destinations.borrow_mut() = Destinations::default();
    surface.file_drop.offered.set(false);
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
        surface.event(next.id(), EventKind::FileDragEnter, EventPayload::None);
    }
}

fn update(surface: &Surface, point: &POINTL, effect: *mut DROPEFFECT) {
    if effect.is_null() {
        set_target(surface, None);
        return;
    }
    // SAFETY: OLE supplies an in/out effect pointer for this callback.
    let copy_allowed = unsafe { (*effect).0 & DROPEFFECT_COPY.0 != 0 };
    let mut client = POINT {
        x: point.x,
        y: point.y,
    };
    // SAFETY: the surface owns the destination HWND; client is writable.
    let target = if copy_allowed
        && surface.file_drop.offered.get()
        && unsafe { ScreenToClient(surface.hwnd(), &mut client) }.as_bool()
    {
        input::file_drop_target(
            surface,
            client.x as f32 / surface.scale(),
            client.y as f32 / surface.scale(),
        )
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

#[implement(IDropTarget)]
struct Destination {
    surface: Weak<Surface>,
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
            surface.file_drop.offered.set(
                data.as_ref()
                    .is_some_and(|data| unsafe { data.QueryGetData(&format()) }.is_ok()),
            );
            update(&surface, point, effect);
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
            update(&surface, point, effect);
        } else if !effect.is_null() {
            // SAFETY: OLE's callback output pointer.
            unsafe { *effect = DROPEFFECT_NONE };
        }
        Ok(())
    }

    fn DragLeave(&self) -> Result<()> {
        if let Some(surface) = self.surface.upgrade() {
            surface.file_drop.offered.set(false);
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
            update(&surface, point, effect);
            let target = surface.file_drop.target.borrow().clone();
            let uris = if target.is_some() {
                data.as_ref().map(files).unwrap_or_default()
            } else {
                Vec::new()
            };
            if let Some(target) = target
                && !uris.is_empty()
            {
                surface.event(
                    target.id(),
                    EventKind::FileDrop,
                    EventPayload::FileDrop(uris),
                );
            } else if !effect.is_null() {
                // SAFETY: OLE's callback output pointer.
                unsafe { *effect = DROPEFFECT_NONE };
            }
            surface.file_drop.offered.set(false);
            set_target(&surface, None);
        } else if !effect.is_null() {
            // SAFETY: OLE's callback output pointer.
            unsafe { *effect = DROPEFFECT_NONE };
        }
        Ok(())
    }
}
