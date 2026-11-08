//! Resources a web view's page loads from the app: the URLs of a scheme the
//! app serves ([`WebView::url_scheme`](crate::element::WebView::url_scheme)),
//! answered by the app's handler with bytes and a MIME type.
//!
//! The page refers to them as to any subresource (`<img src="app-image:1">`,
//! `fetch("app-image:1")`), and the platform's web engine loads them through
//! its own scheme handler (WebKit's `WKURLSchemeHandler` on iOS and macOS,
//! `webkit_web_context_register_uri_scheme` on Linux): the bytes reach the
//! page's process as they are, without being encoded into a script or a
//! `data:` URL and without waiting behind the page's scripts.
//!
//! The platform calls the handler on its main thread, with a
//! [`WebResourceRequest`] the app answers then or later, from any thread
//! ([`WebResourceRequest::respond`], [`WebResourceRequest::fail`]): the
//! handler returns at once and hands slow work (a file read, a decode) to
//! a thread of its own. A request dropped unanswered fails, so the page
//! never waits for an answer that cannot come. When the page no longer
//! needs a resource (it navigated away, the web view went), the platform
//! cancels the request ([`WebResourceRequest::is_cancelled`]), and an
//! answer given after that is dropped.
//!
//! The schemes are read when the platform makes the web view, as
//! `incognito` is: a web view serves the schemes of its first props.

use std::{
    fmt,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

/// The function that answers a scheme's requests.
type Handler = dyn Fn(WebResourceRequest) + Send + Sync;

/// What a request's platform does with its answer: the resource, or
/// `None` when it failed.
type Respond = Box<dyn FnOnce(Option<WebResource>) + Send>;

/// A URL scheme a web view serves from the app: its name and the handler
/// that answers its requests. Platform plumbing: apps use
/// [`WebView::url_scheme`](crate::element::WebView::url_scheme).
#[doc(hidden)]
#[derive(Clone)]
pub struct WebUrlScheme {
    scheme: Arc<str>,
    handler: Arc<Handler>,
}

impl WebUrlScheme {
    /// The scheme `scheme` (`"app-image"`, without the colon), answered by
    /// `handler`. A scheme is a letter followed by letters, digits, `+`,
    /// `-` or `.`, and none of those the web engine or the system own
    /// (`http`, `https`, `file`, `data`, `blob`, `about`, ...); it is kept
    /// in lower case. The error says what is wrong.
    pub fn new(
        scheme: &str,
        handler: impl Fn(WebResourceRequest) + Send + Sync + 'static,
    ) -> Result<Self, String> {
        crate::url_scheme::check_scheme(scheme)?;
        Ok(Self {
            scheme: scheme.to_ascii_lowercase().into(),
            handler: Arc::new(handler),
        })
    }

    /// The scheme, in lower case, without the colon.
    pub fn scheme(&self) -> &str {
        &self.scheme
    }

    /// Answers `request` with the app's handler (for the platforms, on
    /// their main thread).
    pub fn handle(&self, request: WebResourceRequest) {
        (self.handler)(request);
    }
}

impl PartialEq for WebUrlScheme {
    fn eq(&self, other: &Self) -> bool {
        self.scheme == other.scheme && Arc::ptr_eq(&self.handler, &other.handler)
    }
}

impl fmt::Debug for WebUrlScheme {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_tuple("WebUrlScheme").field(&self.scheme).finish()
    }
}

/// What a scheme's URL serves: its bytes and their MIME type.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct WebResource {
    /// The MIME type (`"image/png"`); an empty one is
    /// `application/octet-stream`.
    pub mime_type: Arc<str>,
    /// The bytes.
    pub bytes: Arc<[u8]>,
}

impl WebResource {
    /// `bytes` of the MIME type `mime_type`.
    pub fn new(mime_type: impl Into<Arc<str>>, bytes: impl Into<Arc<[u8]>>) -> Self {
        Self {
            mime_type: mime_type.into(),
            bytes: bytes.into(),
        }
    }

    /// The MIME type the platform answers with:
    /// `application/octet-stream` when none is set.
    #[doc(hidden)]
    pub fn mime_type_or_default(&self) -> &str {
        if self.mime_type.is_empty() {
            "application/octet-stream"
        } else {
            &self.mime_type
        }
    }
}

/// A request of the page for a URL of a scheme the app serves. It is
/// answered once, by [`respond`](Self::respond) or [`fail`](Self::fail),
/// from any thread; dropped unanswered, it fails.
pub struct WebResourceRequest {
    url: String,
    method: String,
    cancelled: Arc<AtomicBool>,
    respond: Option<Respond>,
}

impl WebResourceRequest {
    /// A request for `url` with the HTTP method `method` (`"GET"`), for the
    /// platforms: `respond` takes its answer (from whichever thread the app
    /// answers on; `None` when it failed), and the [`WebResourceCancel`]
    /// cancels it when the page no longer needs it.
    #[doc(hidden)]
    pub fn new(
        url: impl Into<String>,
        method: impl Into<String>,
        respond: impl FnOnce(Option<WebResource>) + Send + 'static,
    ) -> (Self, WebResourceCancel) {
        let cancelled = Arc::new(AtomicBool::new(false));
        let request = Self {
            url: url.into(),
            method: method.into(),
            cancelled: cancelled.clone(),
            respond: Some(Box::new(respond)),
        };
        (request, WebResourceCancel(cancelled))
    }

    /// The URL requested (`app-image:1`), as the page's engine resolved it.
    pub fn url(&self) -> &str {
        &self.url
    }

    /// The HTTP method (`"GET"` for images and most loads).
    pub fn method(&self) -> &str {
        &self.method
    }

    /// Whether the page no longer needs it (it navigated away, the web view
    /// went): work for it can stop, and an answer is dropped.
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }

    /// Answers with `resource`.
    pub fn respond(mut self, resource: WebResource) {
        self.finish(Some(resource));
    }

    /// Answers that there is nothing there: the page's load fails (an
    /// image's `error` event, a rejected `fetch`).
    pub fn fail(mut self) {
        self.finish(None);
    }

    fn finish(&mut self, resource: Option<WebResource>) {
        if let Some(respond) = self.respond.take()
            && !self.is_cancelled()
        {
            respond(resource);
        }
    }
}

impl Drop for WebResourceRequest {
    fn drop(&mut self) {
        self.finish(None);
    }
}

impl fmt::Debug for WebResourceRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("WebResourceRequest")
            .field("url", &self.url)
            .field("method", &self.method)
            .field("cancelled", &self.is_cancelled())
            .finish()
    }
}

/// Cancels a [`WebResourceRequest`] (the platform's side of it). Platform
/// plumbing, not for apps.
#[doc(hidden)]
#[derive(Debug, Clone)]
pub struct WebResourceCancel(Arc<AtomicBool>);

impl WebResourceCancel {
    /// The page no longer needs the resource: the request reports it, and
    /// its answer is dropped.
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    fn new_request() -> (
        WebResourceRequest,
        WebResourceCancel,
        Arc<Mutex<Vec<Option<WebResource>>>>,
    ) {
        let answers = Arc::new(Mutex::new(Vec::new()));
        let (request, cancel) = WebResourceRequest::new("app-image:1", "GET", {
            let answers = answers.clone();
            move |answer| answers.lock().unwrap().push(answer)
        });
        (request, cancel, answers)
    }

    #[test]
    fn checks_schemes() {
        let scheme = WebUrlScheme::new("App-Image", |_| {}).unwrap();
        assert_eq!(scheme.scheme(), "app-image");
        assert!(WebUrlScheme::new("https", |_| {}).is_err());
        assert!(WebUrlScheme::new("data", |_| {}).is_err());
        assert!(WebUrlScheme::new("1app", |_| {}).is_err());
        assert!(WebUrlScheme::new("app image", |_| {}).is_err());
        assert_eq!(scheme, scheme.clone());
        assert_ne!(scheme, WebUrlScheme::new("app-image", |_| {}).unwrap());
    }

    #[test]
    fn answers_once() {
        let (request, _cancel, answers) = new_request();
        assert_eq!(request.url(), "app-image:1");
        assert_eq!(request.method(), "GET");
        let resource = WebResource::new("image/png", vec![1, 2, 3]);
        std::thread::spawn(move || request.respond(resource))
            .join()
            .unwrap();
        let answers = answers.lock().unwrap();
        assert_eq!(answers.len(), 1);
        let resource = answers[0].as_ref().unwrap();
        assert_eq!(resource.mime_type_or_default(), "image/png");
        assert_eq!(&*resource.bytes, &[1, 2, 3]);
    }

    #[test]
    fn fails_when_dropped_or_failed() {
        let (request, _cancel, answers) = new_request();
        drop(request);
        let (request, _cancel, failed) = new_request();
        request.fail();
        assert_eq!(*answers.lock().unwrap(), vec![None]);
        assert_eq!(*failed.lock().unwrap(), vec![None]);
    }

    #[test]
    fn drops_answers_once_cancelled() {
        let (request, cancel, answers) = new_request();
        cancel.cancel();
        assert!(request.is_cancelled());
        request.respond(WebResource::default());
        assert!(answers.lock().unwrap().is_empty());
        assert_eq!(
            WebResource::default().mime_type_or_default(),
            "application/octet-stream"
        );
    }
}
