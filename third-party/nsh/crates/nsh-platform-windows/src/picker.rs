//! `Picker.pickImages`: the shell's file open dialog (`IFileOpenDialog`),
//! owned by the surface's window and filtered to the image formats the
//! request takes. It runs on a thread of its own (a single-threaded COM
//! apartment), so the surface's message loop never waits in it; the files
//! are read there as they are (no scaling or conversion here:
//! `nsh_core::picker::read_files`) and go to the engine in one root `Pick`
//! event.

use std::{path::PathBuf, rc::Rc};

use nsh_core::{EventKind, EventPayload, ROOT_ID, picker::PickRequest};
use windows::{
    Win32::{
        Foundation::HWND,
        System::Com::{
            CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx,
            CoTaskMemFree, CoUninitialize,
        },
        UI::Shell::{
            Common::COMDLG_FILTERSPEC, FOS_ALLOWMULTISELECT, FOS_FILEMUSTEXIST,
            FOS_FORCEFILESYSTEM, FileOpenDialog, IFileOpenDialog, SIGDN_FILESYSPATH,
        },
    },
    core::{HSTRING, PCWSTR},
};

use crate::surface::Surface;

/// Shows the dialog for pick `id`.
pub(crate) fn pick_images(surface: &Rc<Surface>, id: u32, request: PickRequest) {
    let mut control = None;
    surface.control(|c| control = Some(c.clone()));
    let Some(control) = control else { return };
    // A window handle is an address the other thread only hands to the
    // dialog as its owner.
    let owner = surface.hwnd().0 as isize;
    let spawned = std::thread::Builder::new()
        .name("nsh-picker".into())
        .spawn(move || {
            let paths = open(HWND(owner as *mut _), &request).unwrap_or_else(|e| {
                log::warn!("the file dialog failed: {e}");
                Vec::new()
            });
            let files = nsh_core::picker::read_files(&paths, &request);
            control.dispatch_event(ROOT_ID, EventKind::Pick, EventPayload::Picked { id, files });
        });
    if let Err(e) = spawned {
        log::warn!("cannot show the file dialog: {e}");
    }
}

/// The paths picked in the dialog; none when it was cancelled.
fn open(owner: HWND, request: &PickRequest) -> windows::core::Result<Vec<PathBuf>> {
    // SAFETY: COM initialized for this thread, which owns the dialog until
    // it returns; the filter strings outlive the call that reads them.
    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok()?;
        let result = (|| {
            let dialog: IFileOpenDialog =
                CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)?;
            let mut options = dialog.GetOptions()? | FOS_FILEMUSTEXIST | FOS_FORCEFILESYSTEM;
            if request.multiple() {
                options |= FOS_ALLOWMULTISELECT;
            }
            dialog.SetOptions(options)?;
            // No label of NSH's own: the filter shows its patterns.
            let pattern = nsh_core::picker::dialog_extensions(request)
                .iter()
                .map(|e| format!("*.{e}"))
                .collect::<Vec<_>>()
                .join(";");
            let pattern = HSTRING::from(pattern);
            let spec = [COMDLG_FILTERSPEC {
                pszName: PCWSTR(pattern.as_ptr()),
                pszSpec: PCWSTR(pattern.as_ptr()),
            }];
            dialog.SetFileTypes(&spec)?;
            if dialog.Show(Some(owner)).is_err() {
                // Cancelled.
                return Ok(Vec::new());
            }
            let items = dialog.GetResults()?;
            let mut paths = Vec::new();
            for i in 0..items.GetCount()? {
                let item = items.GetItemAt(i)?;
                let path = item.GetDisplayName(SIGDN_FILESYSPATH)?;
                if let Ok(text) = path.to_string() {
                    paths.push(PathBuf::from(text));
                }
                CoTaskMemFree(Some(path.0 as *const _));
            }
            Ok(paths)
        })();
        CoUninitialize();
        result
    }
}
