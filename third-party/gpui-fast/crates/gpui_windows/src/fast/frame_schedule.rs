//! Demand-driven Windows frames, including idle device recovery and manipulation tails.

use super::device_wake::DeviceWake;
use crate::direct_manipulation::DirectManipulationHandler;
use crate::{DrawCoordinator, WindowsWindow, WindowsWindowInner};
use gpui::{DispatchEventResult, PlatformInput};
use gpui_util::ResultExt;
use std::{
    cell::Cell,
    rc::Rc,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use windows::Win32::{
    Foundation::HWND,
    Graphics::{
        Direct3D11::ID3D11Device,
        DirectManipulation::{DIRECTMANIPULATION_INERTIA, DIRECTMANIPULATION_RUNNING},
        Gdi::ValidateRect,
    },
};

/// How long a touchpad contact keeps Direct Manipulation updating before its gesture starts.
const CONTACT_POLL: Duration = Duration::from_secs(1);

#[derive(Default)]
pub(crate) struct FrameWake {
    pending: parking_lot::Mutex<bool>,
    changed: parking_lot::Condvar,
}

impl FrameWake {
    pub(crate) fn request(&self) {
        *self.pending.lock() = true;
        // A replacement GPU thread may start before the previous one exits.
        self.changed.notify_all();
    }

    pub(crate) fn wait(&self, stopped: &AtomicBool, device_notifications: bool) -> bool {
        let mut pending = self.pending.lock();
        while !*pending && !stopped.load(Ordering::Acquire) {
            if device_notifications {
                self.changed.wait(&mut pending);
            } else if self
                .changed
                .wait_for(&mut pending, Duration::from_secs(1))
                .timed_out()
            {
                // Keep recovery available if Windows cannot register a device notification.
                break;
            }
        }
        if stopped.load(Ordering::Acquire) {
            return false;
        }
        *pending = false;
        true
    }
}

pub(crate) struct FrameRequest {
    pending: AtomicBool,
    wake: Arc<FrameWake>,
}

impl FrameRequest {
    pub(crate) fn new(wake: Arc<FrameWake>) -> Self {
        Self {
            pending: AtomicBool::new(false),
            wake,
        }
    }

    pub(crate) fn request(&self) {
        // A request already pending has woken the worker, which has yet to take it.
        if !self.pending.swap(true, Ordering::AcqRel) {
            self.wake.request();
        }
    }

    pub(crate) fn take(&self) -> bool {
        self.pending.swap(false, Ordering::AcqRel)
    }
}

/// The VSync worker's side of the schedule: its wake, and the device-removal registration
/// that lets it sleep without polling for device loss.
pub(crate) struct Worker {
    wake: Arc<FrameWake>,
    device_wake: Option<DeviceWake>,
}

impl Worker {
    pub(crate) fn new(wake: Arc<FrameWake>, device: &ID3D11Device) -> Self {
        let device_wake = DeviceWake::start(device, &wake);
        Self { wake, device_wake }
    }

    pub(crate) fn wait(&self, stopped: &AtomicBool) -> bool {
        self.wake.wait(stopped, self.device_wake.is_some())
    }

    /// Registers for removal of the device that replaced a lost one.
    pub(crate) fn watch(&mut self, device: &ID3D11Device) {
        self.device_wake = DeviceWake::start(device, &self.wake);
    }
}

pub(crate) fn frame_wake(coordinator: &DrawCoordinator) -> Arc<FrameWake> {
    coordinator.fast_frame_wake.clone()
}

/// Takes a window's pending request; the worker redraws only windows that asked for a frame.
pub(crate) fn take_request(hwnd: HWND, request: &FrameRequest) -> bool {
    #[cfg(test)]
    crate::fast::native_tests::before_frame_request(hwnd);
    #[cfg(not(test))]
    let _ = hwnd;
    request.take()
}

pub(crate) fn stop_vsync(stop: Arc<AtomicBool>, coordinator: &DrawCoordinator) {
    // Joining here would deadlock a worker sending a synchronous window message.
    stop.store(true, Ordering::Release);
    coordinator.fast_frame_wake.request();
}

pub(crate) fn new_request(coordinator: &DrawCoordinator) -> Arc<FrameRequest> {
    Arc::new(FrameRequest::new(coordinator.fast_frame_wake.clone()))
}

pub(crate) fn frame_waker(window: &WindowsWindow) -> Option<Rc<dyn Fn()>> {
    let request = window.state.fast_frame_request.clone();
    Some(Rc::new(move || request.request()))
}

pub(crate) fn schedule_frame(window: &WindowsWindow) {
    window.state.fast_frame_request.request();
}

pub(crate) fn on_input(
    window: &WindowsWindow,
    mut callback: Box<dyn FnMut(PlatformInput) -> DispatchEventResult>,
) {
    let request = window.state.fast_frame_request.clone();
    #[cfg(test)]
    let hwnd = gpui::PlatformWindow::get_raw_handle(window).0 as usize;
    window
        .state
        .callbacks
        .input
        .set(Some(Box::new(move |event| {
            #[cfg(test)]
            crate::fast::native_tests::input(hwnd);
            let result = callback(event);
            request.request();
            result
        })));
}

pub(crate) fn defer_draw(window: &WindowsWindowInner, handle: HWND) {
    // Validate nested paints now and retry at VSync instead of spinning a modal message loop.
    validate_current_paint(handle);
    window.state.fast_frame_request.request();
}

pub(crate) fn validate_current_paint(handle: HWND) {
    // Retire only the current paint, before callbacks can request another one.
    // A trailing ValidateRect would also erase a concurrent worker invalidation.
    unsafe {
        ValidateRect(Some(handle), None).ok().log_err();
    }
}

/// Keeps Direct Manipulation updating while a touchpad gesture may be in progress.
pub(crate) struct ManipulationFrames {
    request: Arc<FrameRequest>,
    contact_at: Cell<Option<Instant>>,
}

impl ManipulationFrames {
    pub(crate) fn new(request: Arc<FrameRequest>) -> Self {
        Self {
            request,
            contact_at: Cell::new(None),
        }
    }

    pub(crate) fn contact(&self) {
        self.contact_at.set(Some(Instant::now()));
        self.request.request();
    }
}

pub(crate) fn update_manipulation(handler: &DirectManipulationHandler) {
    let frames = &handler.fast_manipulation;
    unsafe {
        handler.update_manager.Update(None).log_err();
        let running = handler.viewport.GetStatus().is_ok_and(|status| {
            status == DIRECTMANIPULATION_RUNNING || status == DIRECTMANIPULATION_INERTIA
        });
        if running {
            frames.contact_at.set(None);
        }
        // Direct Manipulation consumes a contact's pointer messages, so until the gesture
        // starts nothing else requests the frames that run Update.
        let contact = frames
            .contact_at
            .get()
            .is_some_and(|at| at.elapsed() < CONTACT_POLL);
        if running || contact {
            frames.request.request();
        } else {
            frames.contact_at.set(None);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{FrameRequest, FrameWake};
    use std::{
        sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
            mpsc,
        },
        thread,
        time::Duration,
    };

    #[test]
    fn requests_coalesce_without_invalidating_other_windows() {
        let wake = Arc::new(FrameWake::default());
        let first = FrameRequest::new(wake.clone());
        let second = FrameRequest::new(wake.clone());
        first.request();
        first.request();
        assert!(first.take());
        assert!(!first.take());
        assert!(!second.take());
        assert!(wake.wait(&AtomicBool::new(false), true));
        assert!(!*wake.pending.lock());
    }

    #[test]
    fn stop_wakes_a_sleeping_worker() {
        let wake = Arc::new(FrameWake::default());
        let stop = Arc::new(AtomicBool::new(false));
        let (tx, rx) = mpsc::channel();
        let worker = {
            let wake = wake.clone();
            let stop = stop.clone();
            thread::spawn(move || {
                tx.send(wake.wait(&stop, true)).unwrap();
            })
        };
        assert!(matches!(
            rx.recv_timeout(Duration::from_millis(20)),
            Err(mpsc::RecvTimeoutError::Timeout)
        ));
        stop.store(true, Ordering::Release);
        wake.request();
        assert!(!rx.recv_timeout(Duration::from_secs(2)).unwrap());
        worker.join().unwrap();
    }

    #[test]
    fn replacement_worker_cannot_consume_the_old_workers_stop() {
        let wake = Arc::new(FrameWake::default());
        let old_stop = Arc::new(AtomicBool::new(false));
        let new_stop = Arc::new(AtomicBool::new(false));
        let (tx, rx) = mpsc::channel();
        let workers = [(true, old_stop.clone()), (false, new_stop)].map(|(old, stop)| {
            let wake = wake.clone();
            let tx = tx.clone();
            thread::spawn(move || {
                tx.send((old, wake.wait(&stop, true))).unwrap();
            })
        });
        old_stop.store(true, Ordering::Release);
        wake.request();
        let mut results = [
            rx.recv_timeout(Duration::from_secs(2)).unwrap(),
            rx.recv_timeout(Duration::from_secs(2)).unwrap(),
        ];
        results.sort_by_key(|(old, _)| *old);
        assert_eq!(results, [(false, true), (true, false)]);
        for worker in workers {
            worker.join().unwrap();
        }
    }
}
