//! `fetch` on the browser's `fetch` (`web/nsh.js`, `fetch_*` imports): JS
//! reports what happens to each request through the `nsh_fetch_*` exports,
//! which hand it to the request's [`FetchEvents`] and pump the engine.
//!
//! What the browser decides stays the browser's: CORS (a cross-origin server
//! must allow the page's origin), cookies (sent to the page's own origin),
//! forbidden request headers (dropped). Response bodies stream through a
//! `ReadableStream` reader that stops reading while paused; streamed request
//! bodies are collected, then sent (browsers stream uploads only over HTTP/2
//! and not everywhere). Browsers hide redirect responses (`redirect:
//! "manual"` yields an opaque response): a hop that must not follow its
//! redirects (`redirect: "manual"` / `"error"`, and the hops the engine
//! checks against restricted capabilities) fails when it is redirected.

use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
};

use nsh_engine::{FetchEvent, FetchEvents, FetchTask, HttpBody, HttpHead, HttpRequest, Network};

use crate::ffi;

thread_local! {
    /// The events of each request in flight, by the id JS knows it by.
    static REQUESTS: RefCell<HashMap<u32, FetchEvents>> = RefCell::new(HashMap::new());
    static NEXT_ID: Cell<u32> = const { Cell::new(1) };
}

/// The browser's HTTP stack.
pub(crate) struct WebNetwork;

impl Network for WebNetwork {
    fn fetch(&self, request: HttpRequest, events: FetchEvents) -> Box<dyn FetchTask> {
        let id = NEXT_ID.with(|n| n.replace(n.get().wrapping_add(1).max(1)));
        REQUESTS.with(|r| r.borrow_mut().insert(id, events));
        let headers = serde_json::to_string(&request.headers).unwrap_or_else(|_| "[]".into());
        let (body, kind) = match &request.body {
            HttpBody::Empty => (&[][..], ffi::BODY_EMPTY),
            HttpBody::Bytes(bytes) => (&bytes[..], ffi::BODY_BYTES),
            HttpBody::Stream => (&[][..], ffi::BODY_STREAM),
        };
        ffi::fetch_start(
            id,
            &request.method,
            &request.url,
            &headers,
            body,
            kind,
            request.follow_redirects,
        );
        Box::new(Task { id })
    }
}

/// A request in flight in the page; dropping it aborts it.
struct Task {
    id: u32,
}

impl FetchTask for Task {
    fn send(&mut self, chunk: Vec<u8>) {
        ffi::fetch_send(self.id, &chunk);
    }

    fn finish(&mut self) {
        ffi::fetch_finish(self.id);
    }

    fn pause(&mut self, paused: bool) {
        ffi::fetch_pause(self.id, paused);
    }

    fn cancel(self: Box<Self>) {}
}

impl Drop for Task {
    fn drop(&mut self) {
        // Ended requests are gone from both sides already: JS ignores ids it
        // does not know.
        REQUESTS.with(|r| r.borrow_mut().remove(&self.id));
        ffi::fetch_cancel(self.id);
    }
}

/// Hands `event` to request `id` (taken out of the table while it runs:
/// it may end the request).
fn report(id: u32, event: FetchEvent) {
    let last = matches!(event, FetchEvent::End | FetchEvent::Failed(_));
    let Some(mut events) = REQUESTS.with(|r| r.borrow_mut().remove(&id)) else {
        return;
    };
    events(event);
    if !last {
        REQUESTS.with(|r| r.borrow_mut().insert(id, events));
    }
}

/// Request `id`'s streamed body may take its next chunk.
#[unsafe(no_mangle)]
pub extern "C" fn nsh_fetch_body_wanted(id: u32) -> f64 {
    report(id, FetchEvent::BodyWanted);
    crate::pump()
}

/// The response head of request `id`: its `status`, final URL, status
/// text, headers as a JSON array of `[name, value]` pairs, and whether it
/// was redirected.
///
/// # Safety
///
/// The three ranges are memory from [`crate::nsh_alloc`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_fetch_head(
    id: u32,
    status: u32,
    url: *const u8,
    url_len: usize,
    text: *const u8,
    text_len: usize,
    headers: *const u8,
    headers_len: usize,
    redirected: u32,
) -> f64 {
    // SAFETY: guaranteed by the caller.
    let (url, status_text, headers) = unsafe {
        (
            crate::string(url, url_len),
            crate::string(text, text_len),
            crate::string(headers, headers_len),
        )
    };
    let head = HttpHead {
        status: status as u16,
        status_text,
        url,
        redirected: redirected != 0,
        headers: serde_json::from_str(&headers).unwrap_or_default(),
    };
    report(id, FetchEvent::Head(head));
    crate::pump()
}

/// Bytes of request `id`'s response body.
///
/// # Safety
///
/// `ptr..ptr + len` is memory from [`crate::nsh_alloc`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_fetch_data(id: u32, ptr: *const u8, len: usize) -> f64 {
    // SAFETY: guaranteed by the caller.
    let data = unsafe { crate::bytes(ptr, len) }.to_vec();
    report(id, FetchEvent::Data(data));
    crate::pump()
}

/// Request `id`'s response body is complete.
#[unsafe(no_mangle)]
pub extern "C" fn nsh_fetch_end(id: u32) -> f64 {
    report(id, FetchEvent::End);
    crate::pump()
}

/// Request `id` failed with `message`.
///
/// # Safety
///
/// `ptr..ptr + len` is memory from [`crate::nsh_alloc`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsh_fetch_failed(id: u32, ptr: *const u8, len: usize) -> f64 {
    // SAFETY: guaranteed by the caller.
    let message = unsafe { crate::string(ptr, len) };
    report(id, FetchEvent::Failed(message));
    crate::pump()
}
