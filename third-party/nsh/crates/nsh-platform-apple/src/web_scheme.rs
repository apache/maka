//! The URL schemes a web view serves from the app
//! ([`nsh_core::web_resource`]) on WebKit: one `WKURLSchemeHandler` per web
//! view, set on its `WKWebViewConfiguration` for each scheme before the
//! `WKWebView` is made ([`serve`]).
//!
//! WebKit starts a task for each load of a scheme's URL and stops it when
//! the page no longer needs it. Each task is kept, on the main thread,
//! until it is answered or stopped: an answer the app gives (from any
//! thread) hops to the main thread and finishes the task only while it is
//! kept, because WebKit raises an exception for calls on a stopped task. A
//! stopped task cancels its request ([`WebResourceRequest::is_cancelled`]),
//! and so does the web view going (dropping its [`SchemeServer`]).
//!
//! An answer is an HTTP 200 response with its `Content-Type`,
//! `Content-Length` and `Access-Control-Allow-Origin: *`, so a page's
//! scripts can `fetch` it whatever the page's origin (a page loaded from
//! HTML has an opaque one). A failure is `NSURLErrorFileDoesNotExist`.

use std::{
    cell::RefCell,
    collections::HashMap,
    ffi::c_void,
    ptr::NonNull,
    sync::atomic::{AtomicU64, Ordering},
};

use block2::RcBlock;
use dispatch2::DispatchQueue;
use nsh_core::web_resource::{WebResource, WebResourceCancel, WebResourceRequest, WebUrlScheme};
use objc2::{
    AllocAnyThread, DefinedClass, MainThreadMarker, MainThreadOnly, Message, define_class,
    msg_send,
    rc::Retained,
    runtime::{AnyClass, AnyObject, Bool, NSObject, NSObjectProtocol},
};
use objc2_foundation::{
    NSData, NSDictionary, NSError, NSHTTPURLResponse, NSString, NSURL, NSURLErrorDomain,
    NSURLErrorFileDoesNotExist, NSURLRequest, ns_string,
};

/// The schemes one web view serves.
struct SchemeIvars {
    schemes: Vec<WebUrlScheme>,
}

define_class!(
    /// The `WKURLSchemeHandler` of one web view, for each scheme it serves.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = SchemeIvars]
    #[name = "NshWebSchemeHandler"]
    struct WebSchemeHandler;

    unsafe impl NSObjectProtocol for WebSchemeHandler {}

    impl WebSchemeHandler {
        #[unsafe(method(webView:startURLSchemeTask:))]
        fn start_task(&self, _web: &AnyObject, task: &AnyObject) {
            self.start(task);
        }

        #[unsafe(method(webView:stopURLSchemeTask:))]
        fn stop_task(&self, _web: &AnyObject, task: &AnyObject) {
            if let Some(kept) = TASKS.with(|tasks| tasks.borrow_mut().remove(&key(task))) {
                kept.cancel.cancel();
            }
        }
    }
);

/// Serves a web view's schemes ([`serve`]) until dropped, with the web
/// view: the requests under way are then cancelled, and their tasks let
/// go unanswered (WebKit does not stop a task when its web view goes, only
/// when its page does).
pub struct SchemeServer(Retained<WebSchemeHandler>);

impl Drop for SchemeServer {
    fn drop(&mut self) {
        let owner = self.0.owner();
        let gone: Vec<Kept> = TASKS.with(|tasks| {
            tasks
                .borrow_mut()
                .extract_if(|_, kept| kept.owner == owner)
                .map(|(_, kept)| kept)
                .collect()
        });
        for kept in gone {
            kept.cancel.cancel();
        }
    }
}

/// A task WebKit started and the app has not answered yet.
struct Kept {
    /// Tells this task from a later one at the same address.
    id: u64,
    /// The handler's address.
    owner: usize,
    task: Retained<AnyObject>,
    /// The URL requested, which the response names.
    url: Retained<NSURL>,
    cancel: WebResourceCancel,
}

thread_local! {
    /// The tasks under way, by their address (main thread only).
    static TASKS: RefCell<HashMap<usize, Kept>> = RefCell::default();
}

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn key(task: &AnyObject) -> usize {
    (task as *const AnyObject).addr()
}

impl WebSchemeHandler {
    fn owner(&self) -> usize {
        (self as *const Self).addr()
    }

    fn start(&self, task: &AnyObject) {
        // SAFETY: WebKit's documented API (`WKURLSchemeTask.request`).
        let request: Retained<NSURLRequest> = unsafe { msg_send![task, request] };
        let Some(url) = request.URL() else {
            fail(task);
            return;
        };
        let scheme = url.scheme().map(|s| s.to_string().to_ascii_lowercase());
        let Some(served) =
            (self.ivars().schemes.iter()).find(|s| scheme.as_deref() == Some(s.scheme()))
        else {
            fail(task);
            return;
        };
        let method = request
            .HTTPMethod()
            .map_or_else(|| "GET".to_owned(), |m| m.to_string());
        let absolute = url
            .absoluteString()
            .map(|s| s.to_string())
            .unwrap_or_default();
        let task_key = key(task);
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        let (request, cancel) = WebResourceRequest::new(absolute, method, move |answer| {
            if MainThreadMarker::new().is_some() {
                finish(task_key, id, answer);
            } else {
                DispatchQueue::main().exec_async(move || finish(task_key, id, answer));
            }
        });
        TASKS.with(|tasks| {
            tasks.borrow_mut().insert(
                task_key,
                Kept {
                    id,
                    owner: self.owner(),
                    task: task.retain(),
                    url,
                    cancel,
                },
            )
        });
        served.handle(request);
    }
}

/// Answers the task `id` at `task_key`, if WebKit has not stopped it.
fn finish(task_key: usize, id: u64, answer: Option<WebResource>) {
    let kept = TASKS.with(|tasks| {
        let mut tasks = tasks.borrow_mut();
        match tasks.get(&task_key) {
            Some(kept) if kept.id == id => tasks.remove(&task_key),
            _ => None,
        }
    });
    let Some(kept) = kept else { return };
    let task = &*kept.task;
    let Some(resource) = answer else {
        fail(task);
        return;
    };
    let length = NSString::from_str(&resource.bytes.len().to_string());
    let headers: Retained<NSDictionary<NSString, NSString>> = NSDictionary::from_slices(
        &[
            ns_string!("Content-Type"),
            ns_string!("Content-Length"),
            ns_string!("Access-Control-Allow-Origin"),
        ],
        &[
            &*NSString::from_str(resource.mime_type_or_default()),
            &*length,
            ns_string!("*"),
        ],
    );
    let Some(response) = NSHTTPURLResponse::initWithURL_statusCode_HTTPVersion_headerFields(
        NSHTTPURLResponse::alloc(),
        &kept.url,
        200,
        Some(ns_string!("HTTP/1.1")),
        Some(&headers),
    ) else {
        fail(task);
        return;
    };
    let data = shared_data(resource.bytes);
    // SAFETY: WebKit's documented API on a task it has not stopped
    // (`TASKS` keeps only those), answered once (taken out of `TASKS`).
    unsafe {
        let _: () = msg_send![task, didReceiveResponse: &*response];
        let _: () = msg_send![task, didReceiveData: &*data];
        let _: () = msg_send![task, didFinish];
    }
}

/// `bytes` as `NSData` without copying them: the data keeps them until it
/// is freed.
fn shared_data(bytes: std::sync::Arc<[u8]>) -> Retained<NSData> {
    let pointer = NonNull::from(&*bytes).cast::<c_void>();
    let length = bytes.len();
    let release = RcBlock::new(move |_: NonNull<c_void>, _: usize| {
        let _ = &bytes;
    });
    // SAFETY: `pointer` and `length` are `bytes`', which the deallocator
    // block keeps alive (and unchanged: an `Arc<[u8]>` is immutable) until
    // the data no longer needs them.
    unsafe {
        NSData::initWithBytesNoCopy_length_deallocator(
            NSData::alloc(),
            pointer,
            length,
            Some(&release),
        )
    }
}

/// Fails `task`, which WebKit has not stopped, as a missing file.
fn fail(task: &AnyObject) {
    // SAFETY: Foundation's error domain constant, and WebKit's documented
    // API on a live task.
    unsafe {
        let error = NSError::errorWithDomain_code_userInfo(
            NSURLErrorDomain,
            NSURLErrorFileDoesNotExist,
            None,
        );
        let _: () = msg_send![task, didFailWithError: &*error];
    }
}

/// Sets a handler for each of `schemes` on `config`, a
/// `WKWebViewConfiguration` its `WKWebView` is not made with yet. A scheme
/// WebKit handles itself is left out with a warning (setting one raises an
/// exception). `None` when there is nothing to serve; else what serves
/// them until the web view goes.
pub fn serve(
    mtm: MainThreadMarker,
    config: &AnyObject,
    schemes: &[WebUrlScheme],
) -> Option<SchemeServer> {
    if schemes.is_empty() {
        return None;
    }
    let web = AnyClass::get(c"WKWebView")?;
    let handler: Retained<WebSchemeHandler> = {
        let this = WebSchemeHandler::alloc(mtm).set_ivars(SchemeIvars {
            schemes: schemes.to_vec(),
        });
        // SAFETY: NSObject's designated initializer.
        unsafe { msg_send![super(this), init] }
    };
    for scheme in schemes {
        let name = NSString::from_str(scheme.scheme());
        // SAFETY: WebKit's documented API: `handlesURLScheme:` is a class
        // method; the scheme is set once, before the web view is made.
        unsafe {
            let handled: Bool = msg_send![web, handlesURLScheme: &*name];
            if handled.as_bool() {
                log::warn!(
                    target: "js",
                    "web view: WebKit handles `{}:` itself, so the app cannot serve it",
                    scheme.scheme()
                );
                continue;
            }
            let _: () = msg_send![config, setURLSchemeHandler: &*handler, forURLScheme: &*name];
        }
    }
    Some(SchemeServer(handler))
}
