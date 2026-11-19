//! `<webview>`: a `WKWebView`. WebKit is loaded on first use (`dlopen`)
//! rather than linked, so apps without web views do not pay for it at
//! launch.

use std::{
    cell::{Cell, RefCell},
    ffi::CStr,
    rc::Rc,
    sync::OnceLock,
};

use nsh_core::{
    EventKind, EventMask, EventPayload, JsonValue, NodeId, PayloadValue, WebProps, WebSource,
    webview::{WebViewOperation, WebViewRequest},
};
use nsh_engine::EngineControl;
use nsh_platform_apple::web_download;
use objc2::{
    DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send,
    rc::{Allocated, Retained},
    runtime::{AnyClass, AnyObject, Bool},
};
use objc2_core_foundation::{CGPoint, CGRect, CGSize};
use objc2_foundation::{NSObject, NSObjectProtocol, NSString, NSURL};
use objc2_ui_kit::{UIView, UIViewAutoresizing};
use rustc_hash::FxHashSet;

use crate::native_view::NshView;

/// Lets pages talk to the app: `window.nsh.postMessage(data)`.
const BRIDGE: &str = "window.nsh = window.nsh || { postMessage: function (data) { window.webkit.messageHandlers.nsh.postMessage(String(data)); } };";

fn webkit() -> bool {
    static LOADED: OnceLock<bool> = OnceLock::new();
    *LOADED.get_or_init(|| {
        let path = c"/System/Library/Frameworks/WebKit.framework/WebKit";
        // SAFETY: loads a system framework; the handle is never closed.
        let handle = unsafe { libc::dlopen(path.as_ptr(), libc::RTLD_LAZY) };
        if handle.is_null() {
            log::error!("cannot load WebKit");
        }
        !handle.is_null()
    })
}

fn class(name: &CStr) -> &'static AnyClass {
    AnyClass::get(name).expect("WebKit class")
}

pub(crate) struct WebIvars {
    id: NodeId,
    control: EngineControl,
    /// What the app may show (its `webview` capability).
    access: std::sync::Arc<nsh_engine::Access>,
    /// WebKit's transfers, reported to and directed by the core (which
    /// owns their destinations and lifecycle).
    download: Rc<web_download::Transport>,
    /// The view listens for `Download` or `DownloadPending`.
    events_downloads: Cell<bool>,
    /// The core asked the view to hold downloads (`defer_downloads`).
    defer_downloads: Cell<bool>,
    navigation: Cell<Option<usize>>,
    /// Only these navigations may report an expected policy interruption.
    downloading: RefCell<FxHashSet<usize>>,
    evaluations: Rc<nsh_platform_apple::web_evaluation::Evaluations>,
}

define_class!(
    /// Navigation delegate and script message handler of one web view.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = WebIvars]
    pub(crate) struct WebHandler;

    unsafe impl NSObjectProtocol for WebHandler {}

    impl WebHandler {
        #[unsafe(method(userContentController:didReceiveScriptMessage:))]
        fn did_receive_message(&self, _controller: &AnyObject, message: &AnyObject) {
            // SAFETY: `body` of a WKScriptMessage.
            let body: Option<Retained<AnyObject>> = unsafe { msg_send![message, body] };
            let data = body.map(|b| describe(&b)).unwrap_or_default();
            self.send(EventKind::Message, EventPayload::Map(vec![("data", PayloadValue::Str(data))]));
        }

        /// Top-level navigations stay within the app's `webview` capability.
        #[unsafe(method(webView:decidePolicyForNavigationAction:decisionHandler:))]
        fn decide_policy(&self, _web: &AnyObject, action: &AnyObject, decide: &block2::Block<dyn Fn(isize)>) {
            // SAFETY: WebKit's documented API (WKNavigationAction).
            let (main, url) = unsafe {
                let frame: Option<Retained<AnyObject>> = msg_send![action, targetFrame];
                // No target frame: a new window, which counts as top level.
                let main = frame.is_none_or(|f| msg_send![&*f, isMainFrame]);
                let request: Retained<AnyObject> = msg_send![action, request];
                let url: Option<Retained<AnyObject>> = msg_send![&request, URL];
                let url = url.map(|u| {
                    let s: Option<Retained<NSString>> = msg_send![&*u, absoluteString];
                    s.map(|s| s.to_string()).unwrap_or_default()
                });
                (main, url.unwrap_or_default())
            };
            // WKNavigationActionPolicyCancel = 0, Allow = 1.
            let allowed = !main || url.is_empty() || self.ivars().access.allows_webview(&url);
            if !allowed {
                log::warn!(target: "js", "web view navigation to {url} is not granted");
                self.send(
                    EventKind::Error,
                    EventPayload::Map(vec![
                        ("message", PayloadValue::Str(format!("navigation to {url} is not granted"))),
                        ("code", PayloadValue::Str(nsh_core::element::codes::ACCESS_DENIED.into())),
                        ("url", PayloadValue::Str(url)),
                    ]),
                );
            }
            // WKNavigationActionPolicyCancel = 0, Allow = 1, Download = 2.
            // A `download` link becomes a download when the app asks for
            // downloads (WebKit knows `shouldPerformDownload` on iOS 14.5
            // and later).
            let download = allowed && self.wants_download() && web_download::should_download(action);
            decide.call((if download { 2 } else { allowed as isize },));
        }

        /// What the page cannot show, or the server sends as an attachment,
        /// is downloaded when the app asks for downloads.
        #[unsafe(method(webView:decidePolicyForNavigationResponse:decisionHandler:))]
        fn decide_response(
            &self,
            _web: &AnyObject,
            response: &AnyObject,
            decide: &block2::Block<dyn Fn(isize)>,
        ) {
            let download = self.wants_download() && web_download::is_download(response);
            if download && let Some(navigation) = self.ivars().navigation.get() {
                self.ivars().downloading.borrow_mut().insert(navigation);
            }
            // SAFETY: WKNavigationResponse's documented MIME support flag.
            let shows: Bool = unsafe { msg_send![response, canShowMIMEType] };
            // WKNavigationResponsePolicyCancel = 0, Allow = 1, Download = 2.
            decide.call((if download { 2 } else { shows.as_bool() as isize },));
        }

        #[unsafe(method(webView:navigationAction:didBecomeDownload:))]
        fn action_download(&self, _web: &AnyObject, _action: &AnyObject, download: &AnyObject) {
            self.ivars().download.adopt(download);
        }

        #[unsafe(method(webView:navigationResponse:didBecomeDownload:))]
        fn response_download(
            &self,
            _web: &AnyObject,
            _response: &AnyObject,
            download: &AnyObject,
        ) {
            self.ivars().download.adopt(download);
        }

        /// The page's `getUserMedia` gets what the app's `webview.media`
        /// capability grants; the system still asks the user.
        #[unsafe(method(webView:requestMediaCapturePermissionForOrigin:initiatedByFrame:type:decisionHandler:))]
        fn media_capture(
            &self,
            _web: &AnyObject,
            _origin: &AnyObject,
            _frame: &AnyObject,
            kind: isize,
            decide: &block2::Block<dyn Fn(isize)>,
        ) {
            use nsh_core::access::WebMedia;
            // WKMediaCaptureTypeCamera = 0, Microphone = 1, CameraAndMicrophone = 2.
            let wanted: &[WebMedia] = match kind {
                0 => &[WebMedia::Camera],
                1 => &[WebMedia::Microphone],
                _ => &[WebMedia::Camera, WebMedia::Microphone],
            };
            let granted = wanted.iter().all(|m| self.ivars().access.allows_web_media(*m));
            if !granted {
                log::warn!(target: "js", "web view media capture is not granted: add it to capabilities.webview.media");
            }
            // WKPermissionDecisionGrant = 1, Deny = 2.
            decide.call((if granted { 1 } else { 2 },));
        }

        #[unsafe(method(webView:didStartProvisionalNavigation:))]
        fn did_start(&self, web: &AnyObject, navigation: Option<&AnyObject>) {
            self.ivars().evaluations.navigated();
            self.ivars().navigation.set(navigation.map(navigation_key));
            let state = navigation_state(web, true);
            self.send(EventKind::LoadStart, state.clone());
            self.send(EventKind::NavigationStateChange, state);
        }

        #[unsafe(method(webViewWebContentProcessDidTerminate:))]
        fn process_terminated(&self, _web: &AnyObject) {
            self.ivars().evaluations.process_terminated();
            // The app keeps running; the page comes back on its next reload.
            self.send(
                EventKind::Error,
                EventPayload::Map(vec![
                    (
                        "message",
                        PayloadValue::Str("The web content process terminated".into()),
                    ),
                    (
                        "code",
                        PayloadValue::Str(nsh_core::element::codes::WEBVIEW_TERMINATED.into()),
                    ),
                ]),
            );
        }

        #[unsafe(method(webView:didFinishNavigation:))]
        fn did_finish(&self, web: &AnyObject, navigation: Option<&AnyObject>) {
            if let Some(navigation) = navigation {
                self.ivars().downloading.borrow_mut().remove(&navigation_key(navigation));
            }
            let state = navigation_state(web, false);
            self.send(EventKind::Load, state.clone());
            self.send(EventKind::NavigationStateChange, state);
        }

        #[unsafe(method(webView:didFailNavigation:withError:))]
        fn did_fail(&self, _web: &AnyObject, navigation: Option<&AnyObject>, error: &AnyObject) {
            self.failed(navigation, error);
        }

        #[unsafe(method(webView:didFailProvisionalNavigation:withError:))]
        fn did_fail_provisional(&self, _web: &AnyObject, navigation: Option<&AnyObject>, error: &AnyObject) {
            self.failed(navigation, error);
        }
    }
);

impl WebHandler {
    fn new(
        mtm: MainThreadMarker,
        id: NodeId,
        control: EngineControl,
        access: std::sync::Arc<nsh_engine::Access>,
        download: Rc<web_download::Transport>,
        evaluations: Rc<nsh_platform_apple::web_evaluation::Evaluations>,
    ) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(WebIvars {
            id,
            control,
            access,
            download,
            events_downloads: Cell::new(false),
            defer_downloads: Cell::new(false),
            navigation: Cell::default(),
            downloading: RefCell::default(),
            evaluations,
        });
        // SAFETY: NSObject's designated initializer.
        unsafe { msg_send![super(this), init] }
    }

    fn send(&self, event: EventKind, payload: EventPayload) {
        let ivars = self.ivars();
        ivars.control.dispatch_event(ivars.id, event, payload);
    }

    /// Whether this web view holds downloads for the core: the core asked
    /// it to (`defer_downloads`, from the Rust builders) or the app listens
    /// (`onDownload`, `onDownloadPending`). Otherwise the navigations stay
    /// as they were.
    fn wants_download(&self) -> bool {
        let ivars = self.ivars();
        ivars.events_downloads.get() || ivars.defer_downloads.get()
    }

    /// The events the app listens to changed.
    pub(crate) fn set_events(&self, events: EventMask) {
        self.ivars().events_downloads.set(
            events.contains(EventKind::Download) || events.contains(EventKind::DownloadPending),
        );
    }

    /// The core asked (or stopped asking) this view to hold downloads.
    pub(crate) fn set_defer_downloads(&self, defer: bool) {
        self.ivars().defer_downloads.set(defer);
    }

    /// The host is going: WebKit stops writing its transfers.
    pub(crate) fn cancel_downloads(&self) {
        self.ivars().download.cancel_all();
    }

    /// Answers a [`WebViewOperation`] through `EventKind::WebViewReply`.
    pub(crate) fn web_request(&self, request: &WebViewRequest) {
        let ivars = self.ivars();
        let download = ivars.download.clone();
        match &request.operation {
            WebViewOperation::StartDownload { id, staging } => match download.start(id, staging) {
                // WebKit accepted the destination; the core publishes the
                // app's `started` and reports the completion as a
                // `DownloadEnd`.
                Ok(()) => self.reply(request.id, Ok(JsonValue::Null)),
                Err(error) => self.reply(request.id, Err(error)),
            },
            WebViewOperation::CancelDownload { id } => {
                // The reply is the core's permission to clean the staging
                // directory: it comes only once WebKit has stopped writing,
                // also after the view is released (the core's teardown
                // needs it).
                let control = ivars.control.clone();
                let node = ivars.id;
                let request_id = request.id;
                let result = download.cancel(id, move || {
                    control.dispatch_event(
                        node,
                        EventKind::WebViewReply,
                        nsh_core::webview::reply(request_id, Ok(JsonValue::Null)),
                    );
                });
                if let Err(error) = result {
                    self.reply(request.id, Err(error));
                }
            }
            // A newer core's operation: answer it rather than leave it
            // pending.
            _ => self.reply(
                request.id,
                Err("this iOS backend does not know the web view operation".into()),
            ),
        }
    }

    fn reply(&self, request: u64, result: Result<JsonValue, String>) {
        self.send(
            EventKind::WebViewReply,
            nsh_core::webview::reply(request, result),
        );
    }

    fn failed(&self, navigation: Option<&AnyObject>, error: &AnyObject) {
        let downloading = navigation.is_some_and(|navigation| {
            self.ivars()
                .downloading
                .borrow_mut()
                .remove(&navigation_key(navigation))
        });
        // SAFETY: NSError's documented domain and code, as on macOS.
        let (domain, code): (Retained<NSString>, isize) =
            unsafe { (msg_send![error, domain], msg_send![error, code]) };
        if downloading && domain.to_string() == "WebKitErrorDomain" && code == 102 {
            return;
        }
        // SAFETY: `localizedDescription` of an NSError.
        let message: Retained<NSString> = unsafe { msg_send![error, localizedDescription] };
        self.send(
            EventKind::Error,
            EventPayload::Map(vec![("message", PayloadValue::Str(message.to_string()))]),
        );
    }
}

fn navigation_key(navigation: &AnyObject) -> usize {
    navigation as *const AnyObject as usize
}

/// `{ url, title, loading, canGoBack, canGoForward }` of a WKWebView.
fn navigation_state(web: &AnyObject, loading: bool) -> EventPayload {
    // SAFETY: WKWebView getters.
    let (url, title, back, forward) = unsafe {
        let url: Option<Retained<NSURL>> = msg_send![web, URL];
        let title: Option<Retained<NSString>> = msg_send![web, title];
        let back: Bool = msg_send![web, canGoBack];
        let forward: Bool = msg_send![web, canGoForward];
        (url, title, back.as_bool(), forward.as_bool())
    };
    let url = url
        .and_then(|u| u.absoluteString())
        .map(|s| s.to_string())
        .unwrap_or_default();
    EventPayload::Map(vec![
        ("url", PayloadValue::Str(url)),
        (
            "title",
            PayloadValue::Str(title.map(|t| t.to_string()).unwrap_or_default()),
        ),
        ("loading", PayloadValue::Bool(loading)),
        ("canGoBack", PayloadValue::Bool(back)),
        ("canGoForward", PayloadValue::Bool(forward)),
    ])
}

fn describe(object: &AnyObject) -> String {
    // SAFETY: every NSObject has a description.
    let d: Retained<NSString> = unsafe { msg_send![object, description] };
    d.to_string()
}

/// A JS string literal for `s`.
fn js_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\u{2028}' => out.push_str("\\u2028"),
            '\u{2029}' => out.push_str("\\u2029"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// A web view: a `NshView` placed by the core, holding the WKWebView.
pub(crate) struct WebHost {
    pub(crate) view: Retained<NshView>,
    /// The WKWebView, made with the first props (`incognito` picks its
    /// website data store).
    web: Option<Retained<AnyObject>>,
    /// [`Self::make`] ran.
    made: bool,
    handler: Retained<WebHandler>,
    evaluations: Rc<nsh_platform_apple::web_evaluation::Evaluations>,
    /// Serves the URL schemes of the first props while the web view is
    /// here.
    schemes: Option<nsh_platform_apple::web_scheme::SchemeServer>,
    props: WebProps,
}

impl WebHost {
    pub(crate) fn new(
        mtm: MainThreadMarker,
        id: NodeId,
        control: EngineControl,
        access: std::sync::Arc<nsh_engine::Access>,
    ) -> Self {
        let view = NshView::new(mtm);
        let evaluations = {
            let control = control.clone();
            nsh_platform_apple::web_evaluation::Evaluations::new(
                id,
                Box::new(move |id, kind, payload| control.dispatch_event(id, kind, payload)),
            )
        };
        // The transport's events are internal (the sink is the core): they
        // go to the node whether or not the app listens for them, and they
        // outlive this view (the engine handle keeps working after the host
        // is gone; the core's teardown needs them).
        let emit_control = control.clone();
        let emit: web_download::Emit = Rc::new(move |kind, payload| {
            emit_control.dispatch_event(id, kind, payload);
        });
        let download = web_download::Transport::new(mtm, emit);
        let handler = WebHandler::new(mtm, id, control, access, download, evaluations.clone());
        Self {
            view,
            web: None,
            made: false,
            handler,
            evaluations,
            schemes: None,
            props: WebProps {
                // Forces the first `configure` to load.
                source: WebSource::Uri("".into()),
                ..WebProps::default()
            },
        }
    }

    /// Makes the WKWebView, keeping its website data in memory only (a
    /// store of its own) when `incognito`, serving the app's URL schemes.
    fn make(&mut self, p: &WebProps) {
        self.made = true;
        if !webkit() {
            // No WKWebView: the app hears it and shows what it has instead.
            self.handler.send(
                EventKind::Error,
                EventPayload::Map(vec![
                    (
                        "message",
                        PayloadValue::Str("WebKit cannot be loaded".into()),
                    ),
                    (
                        "code",
                        PayloadValue::Str(nsh_core::element::codes::UNAVAILABLE.into()),
                    ),
                ]),
            );
            return;
        }
        let handler = &self.handler;
        // SAFETY: WebKit's documented API, sent dynamically; the handler
        // is unregistered when the host is dropped.
        let web = unsafe {
            let config: Retained<AnyObject> = msg_send![class(c"WKWebViewConfiguration"), new];
            if p.incognito {
                let store: Retained<AnyObject> =
                    msg_send![class(c"WKWebsiteDataStore"), nonPersistentDataStore];
                let _: () = msg_send![&config, setWebsiteDataStore: &*store];
            }
            self.schemes =
                nsh_platform_apple::web_scheme::serve(handler.mtm(), &config, &p.url_schemes);
            let content: Retained<AnyObject> = msg_send![&config, userContentController];
            let _: () = msg_send![&content, addScriptMessageHandler: &**handler, name: &*NSString::from_str("nsh")];
            let alloc: Allocated<AnyObject> = msg_send![class(c"WKWebView"), alloc];
            let web: Option<Retained<AnyObject>> = msg_send![alloc, initWithFrame: CGRect::new(CGPoint::ZERO, CGSize::ZERO), configuration: &*config];
            let Some(web) = web else { return };
            let _: () = msg_send![&web, setNavigationDelegate: &**handler];
            let _: () = msg_send![&web, setUIDelegate: &**handler];
            let ui: &UIView = &*(Retained::as_ptr(&web) as *const UIView);
            ui.setAutoresizingMask(
                UIViewAutoresizing::FlexibleWidth | UIViewAutoresizing::FlexibleHeight,
            );
            ui.setFrame(self.view.bounds());
            self.view.addSubview(ui);
            web
        };
        self.evaluations.set_web(Some(&web));
        self.web = Some(web);
    }

    pub(crate) fn configure(&mut self, p: WebProps) {
        self.handler.set_defer_downloads(p.defer_downloads);
        if !self.made {
            // The core keeps `incognito` and the URL schemes from changing
            // once it is made.
            self.make(&p);
        }
        let Some(web) = &self.web else {
            self.props = p;
            return;
        };
        if !p.javascript_enabled {
            self.evaluations.scripts_disabled();
        }
        // SAFETY: WebKit's documented API.
        unsafe {
            let scripts_changed = p.injected_js != self.props.injected_js
                || p.injected_js_before != self.props.injected_js_before
                || self.props.source == WebSource::Uri("".into());
            if scripts_changed {
                let config: Retained<AnyObject> = msg_send![web, configuration];
                let content: Retained<AnyObject> = msg_send![&config, userContentController];
                let _: () = msg_send![&content, removeAllUserScripts];
                let add = |source: &str, at_end: bool| {
                    let alloc: Allocated<AnyObject> = msg_send![class(c"WKUserScript"), alloc];
                    let script: Retained<AnyObject> = msg_send![
                        alloc,
                        initWithSource: &*NSString::from_str(source),
                        injectionTime: at_end as isize,
                        forMainFrameOnly: Bool::YES
                    ];
                    let _: () = msg_send![&content, addUserScript: &*script];
                };
                add(BRIDGE, false);
                if let Some(js) = &p.injected_js_before {
                    add(js, false);
                }
                if let Some(js) = &p.injected_js {
                    add(js, true);
                }
            }
            let ua = p.user_agent.as_deref().map(NSString::from_str);
            let _: () = msg_send![web, setCustomUserAgent: ua.as_deref()];
            let scroll: Retained<AnyObject> = msg_send![web, scrollView];
            let _: () = msg_send![&scroll, setScrollEnabled: Bool::new(p.scrollable)];
            let _: () = msg_send![web, setAllowsBackForwardNavigationGestures: Bool::new(p.back_forward_gestures)];
            let config: Retained<AnyObject> = msg_send![web, configuration];
            let prefs: Retained<AnyObject> = msg_send![&config, defaultWebpagePreferences];
            let _: () =
                msg_send![&prefs, setAllowsContentJavaScript: Bool::new(p.javascript_enabled)];
            if p.source != self.props.source || scripts_changed {
                if p.source != WebSource::None {
                    self.evaluations.navigated();
                }
                match &p.source {
                    WebSource::Uri(uri) => {
                        if let Some(url) = NSURL::URLWithString(&NSString::from_str(uri)) {
                            let request: Retained<AnyObject> =
                                msg_send![class(c"NSURLRequest"), requestWithURL: &*url];
                            let _: Option<Retained<AnyObject>> =
                                msg_send![web, loadRequest: &*request];
                        }
                    }
                    WebSource::Html { html, base_url } => {
                        let base = base_url
                            .as_deref()
                            .and_then(|b| NSURL::URLWithString(&NSString::from_str(b)));
                        let _: Option<Retained<AnyObject>> = msg_send![web, loadHTMLString: &*NSString::from_str(html), baseURL: base.as_deref()];
                    }
                    WebSource::None => {}
                }
            }
        }
        self.props = p;
    }

    /// `reload()`, `goBack()`, `goForward()`, `stopLoading()`,
    /// `injectJavaScript()`, `postMessage()` and `load()`.
    pub(crate) fn command(&self, command: &nsh_core::Command) {
        if let nsh_core::Command::WebViewRequest(request) = command {
            self.handler.web_request(request);
            return;
        }
        match command {
            nsh_core::Command::Evaluate { request, script } => {
                self.evaluations
                    .start(*request, script, self.props.javascript_enabled);
                return;
            }
            nsh_core::Command::CancelEvaluate { request } => {
                self.evaluations.cancel(*request);
                return;
            }
            nsh_core::Command::Reload
            | nsh_core::Command::GoBack
            | nsh_core::Command::GoForward
            | nsh_core::Command::Load(_) => {
                self.evaluations.navigated();
            }
            _ => {}
        }
        let Some(web) = &self.web else { return };
        let script = match command {
            nsh_core::Command::InjectJavaScript(js) => Some(js.clone()),
            nsh_core::Command::PostMessage(data) => Some(format!(
                "window.dispatchEvent(new MessageEvent('message', {{ data: {} }}));",
                js_string(data)
            )),
            _ => None,
        };
        // SAFETY: WebKit's documented API.
        unsafe {
            match (command, script) {
                (_, Some(js)) => {
                    let _: () = msg_send![web, evaluateJavaScript: &*NSString::from_str(&js), completionHandler: std::ptr::null::<AnyObject>()];
                }
                (nsh_core::Command::Reload, _) => {
                    let _: Option<Retained<AnyObject>> = msg_send![web, reload];
                }
                (nsh_core::Command::GoBack, _) => {
                    let _: Option<Retained<AnyObject>> = msg_send![web, goBack];
                }
                (nsh_core::Command::GoForward, _) => {
                    let _: Option<Retained<AnyObject>> = msg_send![web, goForward];
                }
                (nsh_core::Command::StopLoading, _) => {
                    let _: () = msg_send![web, stopLoading];
                }
                // Only this request carries the headers; WebKit makes its
                // subresources' and later navigations' requests itself.
                (nsh_core::Command::Load(load), _) => {
                    let Some(url) = NSURL::URLWithString(&NSString::from_str(&load.src)) else {
                        return;
                    };
                    let request: Retained<AnyObject> =
                        msg_send![class(c"NSMutableURLRequest"), requestWithURL: &*url];
                    for (name, value) in &load.headers {
                        let _: () = msg_send![
                            &request,
                            setValue: &*NSString::from_str(value),
                            forHTTPHeaderField: &*NSString::from_str(name)
                        ];
                    }
                    let _: Option<Retained<AnyObject>> = msg_send![web, loadRequest: &*request];
                }
                _ => {}
            }
        }
    }
    /// The events the app listens to changed: downloads are held for the
    /// core while it listens for either download event.
    pub(crate) fn set_events(&self, events: EventMask) {
        self.handler.set_events(events);
    }

    /// Carries out a web view request the core asked this view for.
    pub(crate) fn web_request(&self, request: &WebViewRequest) {
        self.handler.web_request(request);
    }
}

impl Drop for WebHost {
    fn drop(&mut self) {
        // A transfer still writing keeps the transport (and its events)
        // alive until WebKit confirms it stopped, so the core can clean its
        // staging directory afterwards.
        self.handler.cancel_downloads();
        self.evaluations.dispose();
        let Some(web) = &self.web else { return };
        // SAFETY: breaks the cycle web view -> controller -> handler.
        unsafe {
            let _: () = msg_send![web, setNavigationDelegate: std::ptr::null::<AnyObject>()];
            let _: () = msg_send![web, setUIDelegate: std::ptr::null::<AnyObject>()];
            let config: Retained<AnyObject> = msg_send![web, configuration];
            let content: Retained<AnyObject> = msg_send![&config, userContentController];
            let _: () =
                msg_send![&content, removeScriptMessageHandlerForName: &*NSString::from_str("nsh")];
        }
        let _ = &self.handler;
    }
}
