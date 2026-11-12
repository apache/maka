//! A `WKWebView`'s part of `WebView`'s `evaluate`, shared by the macOS and
//! iOS backends: each request's script runs wrapped by
//! `nsh_core::platform::web_evaluation`, a Promise is polled until it
//! settles, and the reply goes back to the core as `EventKind::WebEvaluation`.
//! The core keeps the deadline (it sends `Command::CancelEvaluate`); the
//! backend cancels with `ERR_NSH_WEBVIEW_ABORTED` when the document navigates,
//! the content process ends or the web view goes away.
//!
//! The callback blocks and delayed work hold only weak state, never the host.
//! Membership and a per-request serial make late callbacks harmless after a
//! navigation, cancellation, disposal, or a reused request id.

use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    rc::Rc,
};

use nsh_core::{
    EventKind, EventPayload, NodeId, PayloadValue, element::codes,
    platform::web_evaluation as script,
};
use objc2::{
    MainThreadMarker, msg_send,
    rc::{Retained, Weak},
    runtime::AnyObject,
};
use objc2_foundation::NSString;

/// How often a pending Promise is polled, in nanoseconds.
const POLL_NS: i64 = 25_000_000;

/// Hands a reply to the engine: the node, `EventKind::WebEvaluation` and its
/// payload.
pub type Reply = Box<dyn Fn(NodeId, EventKind, EventPayload)>;

/// The evaluations of one web view.
pub struct Evaluations {
    id: NodeId,
    send: Reply,
    web: RefCell<Option<Weak<AnyObject>>>,
    pending: RefCell<HashMap<u32, Pending>>,
    serial: Cell<u64>,
    process_gone: Cell<bool>,
}

struct Pending {
    serial: u64,
    poll: String,
    cleanup: String,
}

impl Evaluations {
    /// The evaluations of the web view `id`, replying through `send`.
    pub fn new(id: NodeId, send: Reply) -> Rc<Self> {
        Rc::new(Self {
            id,
            send,
            web: RefCell::new(None),
            pending: RefCell::new(HashMap::new()),
            serial: Cell::new(0),
            process_gone: Cell::new(false),
        })
    }

    /// The `WKWebView` the scripts run in (held weakly); `None` when it goes
    /// away.
    pub fn set_web(&self, web: Option<&Retained<AnyObject>>) {
        *self.web.borrow_mut() = web.map(Weak::from_retained);
    }

    /// Runs request `request`'s script. `scripts` says whether the page runs
    /// scripts now (`javascriptEnabled`).
    pub fn start(self: &Rc<Self>, request: u32, script_source: &str, scripts: bool) {
        if self.web().is_none() {
            self.error(request, codes::WEBVIEW_ABORTED, "the web view went away");
            return;
        }
        if !scripts {
            self.error(request, codes::WEBVIEW_SCRIPT, "the page runs no scripts");
            return;
        }
        self.cancel(request);
        let serial = self.serial.get().wrapping_add(1);
        self.serial.set(serial);
        let key = format!("__nsh_evaluation_{}_{}_{}", self.id, request, serial);
        self.pending.borrow_mut().insert(
            request,
            Pending {
                serial,
                poll: script::poll_script(&key),
                cleanup: script::cleanup_script(&key),
            },
        );
        self.run(request, serial, &script::start_script(script_source, &key));
    }

    /// Forgets request `request` without replying (the core gave up on it).
    pub fn cancel(&self, request: u32) {
        let entry = self.pending.borrow_mut().remove(&request);
        if let Some(entry) = entry {
            self.cleanup(entry);
        }
    }

    /// The document navigated (or is about to): its evaluations are aborted.
    pub fn navigated(&self) {
        self.process_gone.set(false);
        self.cancel_all(codes::WEBVIEW_ABORTED, "the document navigated");
    }

    /// The web content process ended: its evaluations are aborted, and new
    /// ones wait for the next navigation.
    pub fn process_terminated(&self) {
        self.process_gone.set(true);
        self.cancel_all(codes::WEBVIEW_ABORTED, "the web content process ended");
    }

    /// The page stopped running scripts: its evaluations fail.
    pub fn scripts_disabled(&self) {
        self.cancel_all(codes::WEBVIEW_SCRIPT, "the page runs no scripts");
    }

    /// The web view goes away: its evaluations are aborted.
    pub fn dispose(&self) {
        self.cancel_all(codes::WEBVIEW_ABORTED, "the web view went away");
        self.set_web(None);
    }

    fn reply(&self, request: u32, data: String) {
        (self.send)(
            self.id,
            EventKind::WebEvaluation,
            EventPayload::Map(vec![
                ("id", PayloadValue::Number(request as f64)),
                ("data", PayloadValue::Str(data)),
            ]),
        );
    }

    fn error(&self, request: u32, code: &str, message: &str) {
        self.reply(
            request,
            serde_json::json!({ "status": "error", "code": code, "message": message }).to_string(),
        );
    }

    fn web(&self) -> Option<Retained<AnyObject>> {
        if self.process_gone.get() {
            return None;
        }
        self.web.borrow().as_ref().and_then(|web| web.load())
    }

    fn active(&self, request: u32, serial: u64) -> bool {
        self.pending
            .borrow()
            .get(&request)
            .is_some_and(|entry| entry.serial == serial)
    }

    fn cleanup(&self, entry: Pending) {
        if let Some(web) = self.web() {
            // SAFETY: WebKit's documented API; cleanup has no result.
            unsafe {
                let _: () = msg_send![&web, evaluateJavaScript: &*NSString::from_str(&entry.cleanup), completionHandler: std::ptr::null::<AnyObject>()];
            }
        }
    }

    fn cancel_all(&self, code: &str, message: &str) {
        let pending = std::mem::take(&mut *self.pending.borrow_mut());
        for (request, entry) in pending {
            self.cleanup(entry);
            self.error(request, code, message);
        }
    }

    fn finish(&self, request: u32, serial: u64, data: String) {
        if !self.active(request, serial) {
            return;
        }
        self.cancel(request);
        self.reply(request, data);
    }

    fn fail(&self, request: u32, serial: u64, code: &str, message: &str) {
        self.finish(
            request,
            serial,
            serde_json::json!({ "status": "error", "code": code, "message": message }).to_string(),
        );
    }

    fn after(self: &Rc<Self>, delay: i64, f: impl FnOnce(Rc<Self>) + 'static) {
        let mtm = MainThreadMarker::new().expect("main thread");
        let work = dispatch2::MainThreadBound::new((Rc::downgrade(self), f), mtm);
        dispatch2::DispatchQueue::main()
            .after(dispatch2::DispatchTime::NOW.time(delay), move || {
                let mtm = MainThreadMarker::new().expect("main queue");
                let (state, f) = work.into_inner(mtm);
                if let Some(state) = state.upgrade() {
                    f(state);
                }
            })
            .ok();
    }

    fn run(self: &Rc<Self>, request: u32, serial: u64, source: &str) {
        if !self.active(request, serial) {
            return;
        }
        let Some(web) = self.web() else {
            self.fail(
                request,
                serial,
                codes::WEBVIEW_ABORTED,
                "the web view went away",
            );
            return;
        };
        let state = Rc::downgrade(self);
        let done = block2::RcBlock::new(move |result: *mut AnyObject, error: *mut AnyObject| {
            let Some(state) = state.upgrade() else {
                return;
            };
            if !state.active(request, serial) {
                return;
            }
            if !error.is_null() {
                state.fail(
                    request,
                    serial,
                    codes::WEBVIEW_SCRIPT,
                    "the page could not run the script",
                );
                return;
            }
            // SAFETY: WebKit lends its result for the duration of this callback.
            let text = unsafe { result.as_ref() }
                .and_then(|value| value.downcast_ref::<NSString>())
                .map(|value| value.to_string());
            let Some(text) = text else {
                state.fail(
                    request,
                    serial,
                    codes::WEBVIEW_SCRIPT,
                    "the page gave no answer",
                );
                return;
            };
            if text.len() > script::MAX_RESULT_BYTES + 1024 {
                state.fail(
                    request,
                    serial,
                    codes::QUOTA_EXCEEDED,
                    "the script's result is too large",
                );
                return;
            }
            let status = serde_json::from_str::<serde_json::Value>(&text)
                .ok()
                .and_then(|value| {
                    value
                        .get("status")
                        .and_then(|status| status.as_str())
                        .map(str::to_owned)
                });
            match status.as_deref() {
                Some("pending") => state.after(POLL_NS, move |state| {
                    let poll = state
                        .pending
                        .borrow()
                        .get(&request)
                        .filter(|entry| entry.serial == serial)
                        .map(|entry| entry.poll.clone());
                    if let Some(poll) = poll {
                        state.run(request, serial, &poll);
                    }
                }),
                Some("ok" | "error") => state.finish(request, serial, text),
                _ => state.fail(
                    request,
                    serial,
                    codes::WEBVIEW_SCRIPT,
                    "the page gave no answer",
                ),
            }
        });
        // SAFETY: WebKit copies the completion block and calls it on the main thread.
        unsafe {
            let _: () = msg_send![&web, evaluateJavaScript: &*NSString::from_str(source), completionHandler: &*done];
        }
    }
}
