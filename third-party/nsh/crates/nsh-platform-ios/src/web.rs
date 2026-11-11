//! `<webview>`: a `WKWebView`. WebKit is loaded on first use (`dlopen`)
//! rather than linked, so apps without web views do not pay for it at
//! launch.

use std::{ffi::CStr, rc::Rc, sync::OnceLock};

use nsh_core::{EventKind, EventPayload, NodeId, PayloadValue, WebProps, WebSource};
use nsh_engine::EngineControl;
use objc2::{
    DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send,
    rc::{Allocated, Retained},
    runtime::{AnyClass, AnyObject, Bool},
};
use objc2_core_foundation::{CGPoint, CGRect, CGSize};
use objc2_foundation::{NSObject, NSObjectProtocol, NSString, NSURL};
use objc2_ui_kit::{UIView, UIViewAutoresizing};

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
            decide.call((allowed as isize,));
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
        fn did_start(&self, web: &AnyObject, _navigation: Option<&AnyObject>) {
            self.ivars().evaluations.navigated();
            let state = navigation_state(web, true);
            self.send(EventKind::LoadStart, state.clone());
            self.send(EventKind::NavigationStateChange, state);
        }

        #[unsafe(method(webViewWebContentProcessDidTerminate:))]
        fn process_terminated(&self, _web: &AnyObject) {
            self.ivars().evaluations.process_terminated();
        }

        #[unsafe(method(webView:didFinishNavigation:))]
        fn did_finish(&self, web: &AnyObject, _navigation: Option<&AnyObject>) {
            let state = navigation_state(web, false);
            self.send(EventKind::Load, state.clone());
            self.send(EventKind::NavigationStateChange, state);
        }

        #[unsafe(method(webView:didFailNavigation:withError:))]
        fn did_fail(&self, _web: &AnyObject, _navigation: Option<&AnyObject>, error: &AnyObject) {
            self.failed(error);
        }

        #[unsafe(method(webView:didFailProvisionalNavigation:withError:))]
        fn did_fail_provisional(&self, _web: &AnyObject, _navigation: Option<&AnyObject>, error: &AnyObject) {
            self.failed(error);
        }
    }
);

impl WebHandler {
    fn new(
        mtm: MainThreadMarker,
        id: NodeId,
        control: EngineControl,
        access: std::sync::Arc<nsh_engine::Access>,
        evaluations: Rc<nsh_platform_apple::web_evaluation::Evaluations>,
    ) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(WebIvars {
            id,
            control,
            access,
            evaluations,
        });
        // SAFETY: NSObject's designated initializer.
        unsafe { msg_send![super(this), init] }
    }

    fn send(&self, event: EventKind, payload: EventPayload) {
        let ivars = self.ivars();
        ivars.control.dispatch_event(ivars.id, event, payload);
    }

    fn failed(&self, error: &AnyObject) {
        // SAFETY: `localizedDescription` of an NSError.
        let message: Retained<NSString> = unsafe { msg_send![error, localizedDescription] };
        self.send(
            EventKind::Error,
            EventPayload::Map(vec![("message", PayloadValue::Str(message.to_string()))]),
        );
    }
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
        let handler = WebHandler::new(mtm, id, control, access, evaluations.clone());
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
}

impl Drop for WebHost {
    fn drop(&mut self) {
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
