//! Wakes the sleeping frame scheduler when Direct3D reports device removal.

use std::{ffi::c_void, sync::Arc};

use gpui_util::ResultExt;

use windows::{
    Win32::{
        Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE},
        Graphics::Direct3D11::{ID3D11Device, ID3D11Device4},
        System::Threading::{
            CreateEventW, INFINITE, RegisterWaitForSingleObject, UnregisterWaitEx,
            WT_EXECUTEONLYONCE,
        },
    },
    core::Interface,
};

use super::frame_schedule::FrameWake;

pub(crate) struct DeviceWake {
    device: ID3D11Device4,
    event: HANDLE,
    cookie: u32,
    wait: HANDLE,
    wake: Arc<FrameWake>,
}

impl DeviceWake {
    /// Without a registration the scheduler falls back to polling for device loss.
    pub(crate) fn start(device: &ID3D11Device, wake: &Arc<FrameWake>) -> Option<Self> {
        Self::new(device, wake.clone()).log_err()
    }

    fn new(device: &ID3D11Device, wake: Arc<FrameWake>) -> windows::core::Result<Self> {
        let device: ID3D11Device4 = device.cast()?;
        unsafe {
            let event = CreateEventW(None, false, false, None)?;
            let cookie = match device.RegisterDeviceRemovedEvent(event) {
                Ok(cookie) => cookie,
                Err(error) => {
                    let _ = CloseHandle(event);
                    return Err(error);
                }
            };
            let mut wait = HANDLE::default();
            if let Err(error) = RegisterWaitForSingleObject(
                &mut wait,
                event,
                Some(wake_scheduler),
                Some(Arc::as_ptr(&wake).cast()),
                INFINITE,
                WT_EXECUTEONLYONCE,
            ) {
                device.UnregisterDeviceRemoved(cookie);
                let _ = CloseHandle(event);
                return Err(error);
            }
            Ok(Self {
                device,
                event,
                cookie,
                wait,
                wake,
            })
        }
    }
}

unsafe extern "system" fn wake_scheduler(context: *mut c_void, _: bool) {
    // DeviceWake owns the Arc until UnregisterWaitEx has joined this callback.
    unsafe { &*context.cast::<FrameWake>() }.request();
}

impl Drop for DeviceWake {
    fn drop(&mut self) {
        unsafe {
            // The callback only signals the scheduler, so joining it never waits on the UI.
            // This can run while the worker unwinds from a device loss, so it must not panic.
            if UnregisterWaitEx(self.wait, Some(INVALID_HANDLE_VALUE))
                .log_err()
                .is_none()
            {
                // The callback may still run, so keep everything it can touch alive.
                std::mem::forget(self.wake.clone());
                return;
            }
            self.device.UnregisterDeviceRemoved(self.cookie);
            let _ = CloseHandle(self.event);
        }
    }
}
