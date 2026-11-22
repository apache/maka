//! The URL schemes a web view serves from the app
//! ([`nsh_core::web_resource`]) on WebKitGTK.
//!
//! WebKitGTK registers a scheme on a `WebKitWebContext`, once, for every web
//! view of the context, where the app serves schemes per web view: each
//! scheme is registered the first time a web view serves it (as secure, so
//! `https` pages load it without mixed-content blocking, and CORS-enabled,
//! so pages may `fetch` it), and its requests go to the handler of the web
//! view that made them (`webkit_uri_scheme_request_get_web_view`). A
//! request of a web view that does not serve the scheme fails.
//!
//! An answer is an HTTP 200 response with its `Content-Type`,
//! `Content-Length` and `Access-Control-Allow-Origin: *` headers, so a
//! page's scripts can `fetch` it whatever the page's origin (a page loaded
//! from HTML has an opaque one) and read its type.
//!
//! Each request is kept, on the main thread, until it is answered: an
//! answer the app gives on the main thread finishes it at once, one given
//! on another thread is queued on the default main context, which GTK's
//! main thread runs (`g_main_context_invoke` would run it on the calling
//! thread whenever no thread owns the context). WebKitGTK tells no handler
//! when a page stops needing a request, so the requests of a web view are
//! cancelled and failed when it commits a new page (`load-changed`'s
//! `WEBKIT_LOAD_COMMITTED`: the old document is gone, and the new one's
//! requests come after it) and when it goes (dropping its
//! [`SchemeServer`]).

use std::{
    cell::RefCell,
    collections::{HashMap, HashSet},
    sync::atomic::{AtomicU64, Ordering},
};

use gtk4::{gio, glib, prelude::*};
use nsh_core::web_resource::{WebResource, WebResourceCancel, WebResourceRequest, WebUrlScheme};
use webkit6::{LoadEvent, URISchemeRequest, URISchemeResponse, WebView, prelude::*, soup};

/// The schemes one web view serves.
struct Served {
    web: glib::WeakRef<WebView>,
    schemes: Vec<WebUrlScheme>,
}

/// A request the app has not answered yet.
struct Pending {
    request: URISchemeRequest,
    web: glib::WeakRef<WebView>,
    cancel: WebResourceCancel,
}

thread_local! {
    /// The schemes registered, by context (its address) and name.
    static REGISTERED: RefCell<HashSet<(usize, String)>> = RefCell::default();
    /// The web views that serve schemes.
    static SERVED: RefCell<Vec<Served>> = RefCell::default();
    /// The requests under way, by id.
    static PENDING: RefCell<HashMap<u64, Pending>> = RefCell::default();
}

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// Serves a web view's schemes ([`serve`]) until dropped, with the web
/// view: its requests under way are then cancelled and fail.
pub(super) struct SchemeServer {
    web: WebView,
    /// Cancels the requests of the page a new one replaces.
    committed: Option<glib::SignalHandlerId>,
}

impl Drop for SchemeServer {
    fn drop(&mut self) {
        let web = &self.web;
        if let Some(id) = self.committed.take() {
            web.disconnect(id);
        }
        SERVED.with(|served| {
            served
                .borrow_mut()
                .retain(|s| s.web.upgrade().is_some_and(|w| &w != web));
        });
        cancel_pending(web);
    }
}

/// Cancels and fails the requests `web`'s pages (and those of web views
/// already gone) have under way.
fn cancel_pending(web: &WebView) {
    let gone: Vec<Pending> = PENDING.with(|pending| {
        pending
            .borrow_mut()
            .extract_if(|_, p| p.web.upgrade().is_none_or(|w| &w == web))
            .map(|(_, p)| p)
            .collect()
    });
    for p in gone {
        p.cancel.cancel();
        fail(&p.request);
    }
}

/// Serves `schemes` to `web`'s pages, registering those its context does
/// not know yet; `None` when there is nothing to serve.
pub(super) fn serve(web: &WebView, schemes: &[WebUrlScheme]) -> Option<SchemeServer> {
    if schemes.is_empty() {
        return None;
    }
    SERVED.with(|served| {
        served.borrow_mut().push(Served {
            web: web.downgrade(),
            schemes: schemes.to_vec(),
        })
    });
    let server = SchemeServer {
        web: web.clone(),
        committed: Some(web.connect_load_changed(|web, event| {
            if event == LoadEvent::Committed {
                cancel_pending(web);
            }
        })),
    };
    let Some(context) = WebViewExt::context(web) else {
        log::warn!(target: "js", "web view: no web context to serve URL schemes in");
        return Some(server);
    };
    let address = context.as_ptr() as usize;
    for scheme in schemes {
        let name = scheme.scheme();
        let new = REGISTERED.with(|r| r.borrow_mut().insert((address, name.to_owned())));
        if !new {
            continue;
        }
        context.register_uri_scheme(name, start);
        if let Some(security) = context.security_manager() {
            security.register_uri_scheme_as_secure(name);
            security.register_uri_scheme_as_cors_enabled(name);
        }
    }
    Some(server)
}

/// A page asked for a URL of a registered scheme.
fn start(request: &URISchemeRequest) {
    let url = request.uri().map(|u| u.to_string()).unwrap_or_default();
    let method = request
        .http_method()
        .map_or_else(|| "GET".to_owned(), |m| m.to_string());
    let scheme = request
        .scheme()
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    let Some(web) = request.web_view() else {
        fail(request);
        return;
    };
    let served = SERVED.with(|served| {
        served
            .borrow()
            .iter()
            .find(|s| s.web.upgrade().is_some_and(|w| w == web))
            .and_then(|s| s.schemes.iter().find(|s| s.scheme() == scheme).cloned())
    });
    let Some(served) = served else {
        fail(request);
        return;
    };
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let (answer, cancel) = WebResourceRequest::new(url, method, move |answer| {
        if gtk4::is_initialized_main_thread() {
            finish(id, answer);
        } else {
            glib::MainContext::default().spawn(async move { finish(id, answer) });
        }
    });
    PENDING.with(|pending| {
        pending.borrow_mut().insert(
            id,
            Pending {
                request: request.clone(),
                web: web.downgrade(),
                cancel,
            },
        )
    });
    served.handle(answer);
}

/// Answers the request `id`, if it is still under way.
fn finish(id: u64, answer: Option<WebResource>) {
    let Some(pending) = PENDING.with(|pending| pending.borrow_mut().remove(&id)) else {
        return;
    };
    let Some(resource) = answer else {
        fail(&pending.request);
        return;
    };
    let length = resource.bytes.len();
    let mime_type = resource.mime_type_or_default().to_owned();
    let stream = gio::MemoryInputStream::from_bytes(&glib::Bytes::from_owned(resource.bytes));
    let response = URISchemeResponse::new(&stream, length as i64);
    // WebKit's MIME type, and the header a page's script reads.
    response.set_content_type(&mime_type);
    response.set_status(200, None);
    let headers = soup::MessageHeaders::new(soup::MessageHeadersType::Response);
    headers.append("Content-Type", &mime_type);
    headers.append("Content-Length", &length.to_string());
    headers.append("Access-Control-Allow-Origin", "*");
    response.set_http_headers(headers);
    pending.request.finish_with_response(&response);
}

/// Fails `request` as a missing resource.
fn fail(request: &URISchemeRequest) {
    let mut error = glib::Error::new(gio::IOErrorEnum::NotFound, "the app does not serve it");
    request.finish_error(&mut error);
}
