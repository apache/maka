//! Web views: WebKitGTK 6.0 (`webkit6`, feature `webview`).
//!
//! A `WebKitWebView` is a GTK widget like any other: hosted in its node's
//! view and filling it ([`fill`]), it is drawn inside the view's snapshot
//! (WebKit appends the page as a render node), so it stacks, clips and
//! fades with nsh's content as text fields and videos do. Views mounted
//! after it, modals and their scrim, dialogs, toasts and the development
//! overlays draw over it; `overflow: hidden` ancestors clip it, opacity
//! and transforms apply to it, hidden screens unmap it (WebKit then
//! throttles the page), and a departing screen's `gtk::WidgetPaintable`
//! holds its last frame. No composition surface (a separate window, as
//! WebView2 on Windows) is needed. GTK's picking ignores nsh's clipping,
//! so pointer events that GTK would send to the clipped-off part of a page
//! are kept from it (`crate::input`).
//!
//! As on iOS and macOS, pages talk to the app through
//! `window.nsh.postMessage(data)` (a script message handler,
//! `onMessage`), and `postMessage()` dispatches a `message` event on the
//! page's `window`. Events are the iOS ones: `onLoadStart` and
//! `onNavigationStateChange` when a navigation starts, `onLoad` and
//! `onNavigationStateChange` when it finishes, `onError` when it fails
//! (not for cancelled ones), with WebKit's error page left out.
//!
//! Navigations are decided natively (`decide-policy`) from the app's
//! `webview` capability, never by asking JS. WebKitGTK does not say which
//! frame a navigation is for, so the capability applies to the
//! navigations of frames too (an `iframe` of a host that is not granted
//! stays empty), where iOS and macOS only check the main frame's.
//! Responses WebKit cannot show are refused rather than downloaded.
//!
//! A download is a transport: WebKit holds it without a destination and
//! the core hears its offer (`DownloadOffer`), chooses the staging path
//! (`StartDownload`) or cancels it. This backend never picks a destination,
//! publishes a file or removes one; it only writes where the core says
//! and reports the writer's end.
//!
//! Props: `injectedJavaScriptBeforeContentLoaded` and `injectedJavaScript`
//! are user scripts of the top frame (at the document's start and end);
//! `javaScriptEnabled` is WebKit's `enable-javascript-markup` (the page's
//! own scripts; injected ones still run, as with WebKit on Apple
//! platforms); `scrollable: false` is a user style sheet hiding the
//! top document's overflow (inner scrollable elements still scroll, as
//! with iOS's scroll view), and wheels over such a page go to the scroll
//! views around it; `allowsBackForwardNavigationGestures` is
//! `enable-back-forward-navigation-gestures` (touchpad swipes); the user
//! agent is WebKit's `user-agent` setting. Pages follow the app's color
//! scheme (`prefers-color-scheme`) through GTK's settings, which the
//! surface sets from it (`crate::system`).
//!
//! Website data (cookies, local storage, IndexedDB, the cache) is kept per
//! app id, in a `NetworkSession` of the app's own:
//! `$XDG_DATA_HOME/<app id>/webkit` and `$XDG_CACHE_HOME/<app id>/webkit`
//! (cookies in `cookies.sqlite` there), as the Windows backend keeps a
//! WebView2 profile per app id. The session lives as long as one of the
//! app's web views does, and WebKit's network process with it: an app
//! that has closed its last web view, such as one left running in the
//! tray, doesn't keep that process. The next web view starts a new one,
//! which reads the data from disk; only session cookies (those without an
//! expiry, which WebKit keeps in memory) end with it, as when a browser
//! is closed.
//! An `incognito` web view has an ephemeral `NetworkSession` of its own
//! instead, made with it: its data stays in memory and goes with it.
//!
//! The URL schemes the app serves (`WebView::url_scheme`) are registered on
//! the web context and answered per web view (`super::web_scheme`).
//!
//! Keys: a focused page gets them first. Escape the page does not use
//! comes back to the window, where it leaves the page as it leaves a text
//! field (`crate::navigation`). Alt+Left, the Back key and the mouse's
//! back button go back in the page's history when it has one, else back
//! in the app; Alt+Right, the Forward key and the forward button go
//! forward in the page (WebKitGTK treats arrows as used, so Alt+Left
//! would never reach the window).

use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    path::{Path, PathBuf},
    rc::Rc,
    sync::Arc,
};

use gtk4::{self as gtk, gdk, gio, glib, prelude::*};
use nsh_core::{
    Command, EventKind, EventPayload, JsonValue, PayloadValue, WebProps, WebSource,
    webview::{
        self, DownloadEnd, DownloadOffer, DownloadOutcome, WebDownloadSource, WebViewOperation,
        WebViewRequest,
    },
};
use nsh_engine::{Access, EngineControl};
use webkit6::{
    CookiePersistentStorage, Download, DownloadError, LoadEvent, NavigationPolicyDecision,
    NetworkError, NetworkSession, PolicyDecisionType, PolicyError, ResponsePolicyDecision,
    URIRequest, UserContentInjectedFrames, UserContentManager, UserMediaPermissionRequest,
    UserScript, UserScriptInjectionTime, UserStyleLevel, UserStyleSheet, WebView, prelude::*,
};

use super::{Emitter, UNSCROLLABLE, error, fill_sized};
use crate::{decor::rgba, surface::Surface, view::NshView};

/// The script message handler the bridge posts to.
const HANDLER: &str = "nsh";

/// Lets pages talk to the app: `window.nsh.postMessage(data)`.
const BRIDGE: &str = "window.nsh = window.nsh || { postMessage: function (data) { window.webkit.messageHandlers.nsh.postMessage(String(data)); } };";

/// `scrollable: false`: the top document does not scroll.
const NO_SCROLL: &str = "html, body { overflow: hidden !important; }";

/// What a web view's signal handlers share.
pub(super) struct Shared {
    emitter: Emitter,
    /// The engine's control, captured when the view was made: the internal
    /// download events (offers, ends, replies) go through it, so a writer's
    /// stop confirmation still reaches the core after the surface (and this
    /// view) is gone. UI events keep [`Self::emit`]'s surface-bound
    /// lifetime.
    control: Option<EngineControl>,
    /// Async callbacks may outlive this view or the engine it belonged to.
    live: Cell<bool>,
    /// What the app may show (its `webview` capability); `None`: nothing
    /// is known about the app, so nothing is refused.
    access: Option<Arc<Access>>,
    /// The current navigation failed (WebKit still finishes it).
    failed: Cell<bool>,
    /// The core asked this view to hold downloads (`defer_downloads`);
    /// an app listener asks for the same.
    defer_downloads: Cell<bool>,
    /// Downloads WebKit started for this page, by their id.
    downloads: RefCell<HashMap<String, Rc<DownloadState>>>,
    /// The id the next download is reported with.
    next_download: Cell<u64>,
}

impl Shared {
    fn emit(&self, kind: EventKind, payload: impl FnOnce() -> EventPayload) {
        if self.live.get() {
            self.emitter.emit(kind, payload);
        }
    }

    /// Reports a transport event to the core, whether or not the app
    /// listens for it: the core decides what the app hears. The node may
    /// be gone already (teardown); the captured control still delivers it.
    fn report(&self, kind: EventKind, payload: EventPayload) {
        self.dispatch(kind, payload);
    }

    /// Answers a [`Command::WebViewRequest`] `id`: its value, or the
    /// error. Sent even when nothing listens: the core is waiting. A
    /// teardown cancellation is answered too, so the core knows the
    /// native writer stopped before it removes anything.
    fn reply(&self, id: u64, result: Result<JsonValue, String>) {
        self.dispatch(EventKind::WebViewReply, webview::reply(id, result));
    }

    /// Sends an internal download event (offer, end, reply) to the core.
    /// The engine control was captured with this view: it outlives the
    /// surface, so the last stop acknowledgement is not lost when the view
    /// is disposed (the core then cleans its staging directory). UI events
    /// keep [`Self::emit`] and drop with the surface.
    fn dispatch(&self, kind: EventKind, payload: EventPayload) {
        if let Some(control) = &self.control {
            control.dispatch_event(self.emitter.id, kind, payload);
        } else if let Some(surface) = self.emitter.surface.upgrade() {
            // No engine ran when the view was made: the surface may still
            // take the event (a test host, for instance).
            surface.event(self.emitter.id, kind, payload);
        }
    }

    /// Whether this page's downloads are wanted at all: the core's
    /// `defer_downloads` prop (the Rust `onDownload`/`onDownloadPending`
    /// builders set it) or an app listener for either lifecycle event. The
    /// core decides which mode applies; without either, WebKit's default
    /// (nothing written) stands.
    fn offers_downloads(&self) -> bool {
        self.defer_downloads.get()
            || self.emitter.listens(EventKind::DownloadPending)
            || self.emitter.listens(EventKind::Download)
    }
}

/// A download WebKit holds for a page: reported to the core, which
/// chooses its staging path or cancels it.
///
/// WebKit creates the destination file itself; nothing is written before
/// the core's `StartDownload`. This backend keeps no file policy of its
/// own: the core stages, publishes and cleans up.
struct DownloadState {
    download: Download,
    /// Handlers on `download`, disconnected when it ends.
    handlers: RefCell<Vec<glib::SignalHandlerId>>,
    /// The id its events use.
    id: String,
    /// Whether the offer was reported (WebKit asks once).
    offered: Cell<bool>,
    /// The `StartDownload` request (its core id) waiting for WebKit to
    /// create the destination file.
    starting: Cell<Option<u64>>,
    /// The `CancelDownload` request (its core id) waiting for the writer
    /// to stop, so it is answered only then.
    cancelling: Cell<Option<u64>>,
    /// WebKit created the destination: the transfer writes.
    started: Cell<bool>,
    /// WebKit reported its end: nothing is answered or reported twice.
    ended: Cell<bool>,
}

impl DownloadState {
    /// Stops listening (so the download's handlers do not keep this for
    /// ever).
    fn disconnect(&self) {
        for id in self.handlers.borrow_mut().drain(..) {
            self.download.disconnect(id);
        }
    }

    /// Stops the transfer for teardown, keeping its callbacks connected
    /// until WebKit reports that writing stopped (a pending core request
    /// is answered then).
    fn cancel_for_cleanup(&self) {
        // CancelDownload may already precede Delete in the same mount batch.
        // A second WebKit cancel can deliver an IPC reply after its download client was retired.
        if !self.ended.get() && self.cancelling.get().is_none() {
            self.download.cancel();
        }
    }
}

/// A web view: the page filling its node's view.
pub(super) struct WebHost {
    web: WebView,
    content: UserContentManager,
    /// The app's network session (cookies, downloads).
    session: NetworkSession,
    /// What the handlers share (replies, downloads).
    shared: Rc<Shared>,
    /// Handlers on `web` (disconnected when the host goes).
    handlers: Vec<glib::SignalHandlerId>,
    /// The session's `download-started` handler: this view's downloads.
    download_started: Option<glib::SignalHandlerId>,
    /// The script message handler, on `content`.
    message: Option<glib::SignalHandlerId>,
    /// The props applied (`None` before the first).
    props: Option<WebProps>,
    /// WebKit's own background (white), for views without an opaque one.
    default_background: gdk::RGBA,
    /// A page to load once the web view is mapped ([`WebHost::load`]).
    pending: Rc<RefCell<Option<WebSource>>>,
    /// Serves the URL schemes of the first props while the web view is
    /// here (held for its drop).
    _schemes: Option<super::web_scheme::SchemeServer>,
}

impl WebHost {
    /// Makes the page with its first props: `incognito` gives it an
    /// ephemeral network session of its own, and it serves the app's URL
    /// schemes.
    pub(super) fn new(surface: &Rc<Surface>, view: &NshView, p: &WebProps) -> Self {
        let incognito = p.incognito;
        // Internal download events must outlive this view, so capture the
        // engine's handle now, while the app that mounts the view runs.
        let mut control = None;
        surface.control(|c| control = Some(c.clone()));
        let shared = Rc::new(Shared {
            emitter: Emitter {
                surface: Rc::downgrade(surface),
                view: view.downgrade(),
                id: view.id(),
            },
            control,
            live: Cell::new(true),
            access: surface.native.access.borrow().clone(),
            failed: Cell::new(false),
            defer_downloads: Cell::new(p.defer_downloads),
            downloads: RefCell::default(),
            next_download: Cell::new(0),
        });
        let content = UserContentManager::new();
        content.register_script_message_handler(HANDLER, None);
        let session = if incognito {
            NetworkSession::new_ephemeral()
        } else {
            session(&surface.native.app_id.borrow())
        };
        let web = WebView::builder()
            .network_session(&session)
            .user_content_manager(&content)
            .build();
        let schemes = super::web_scheme::serve(&web, &p.url_schemes);
        let default_background = web.background_color();
        let download_started = {
            let shared = shared.clone();
            let page = web.clone();
            session.connect_download_started(move |_, download| {
                // Every page of the app hears the app's session: only the
                // page that started it answers for it.
                if download.web_view().is_some_and(|view| view == page) {
                    started_download(&shared, download);
                }
            })
        };
        let message = {
            let shared = shared.clone();
            content.connect_script_message_received(Some(HANDLER), move |_, value| {
                let data = value.to_str().to_string();
                shared.emit(EventKind::Message, || {
                    EventPayload::Map(vec![("data", PayloadValue::Str(data))])
                });
            })
        };
        let mut handlers = vec![
            decide_policy(&web, &shared),
            permission_request(&web, &shared),
            load_changed(&web, &shared),
            load_failed(&web, &shared),
            web.connect_web_process_terminated({
                let shared = shared.clone();
                move |_, reason| {
                    log::warn!(target: "js", "web view: the page's process ended ({reason:?})");
                    // The app keeps running; the page comes back on its next reload.
                    shared.emit(EventKind::Error, || {
                        EventPayload::Map(vec![
                            (
                                "message",
                                PayloadValue::Str(format!(
                                    "The web content process terminated ({reason:?})"
                                )),
                            ),
                            (
                                "code",
                                PayloadValue::Str(
                                    nsh_core::element::codes::WEBVIEW_TERMINATED.into(),
                                ),
                            ),
                        ])
                    });
                }
            }),
        ];
        let pending: Rc<RefCell<Option<WebSource>>> = Rc::default();
        handlers.push(web.connect_map({
            let pending = pending.clone();
            move |web| {
                let source = pending.borrow_mut().take();
                if let Some(source) = source {
                    load(web, &source);
                }
            }
        }));
        history_keys(&web, surface);
        fill_sized(view, web.upcast_ref());
        WebHost {
            web,
            content,
            session,
            shared,
            handlers,
            download_started: Some(download_started),
            message: Some(message),
            pending,
            props: None,
            default_background,
            _schemes: schemes,
        }
    }

    /// The page (to call outside the hosts' borrow).
    pub(super) fn web(&self) -> WebView {
        self.web.clone()
    }

    /// The page and what its requests share: a request is answered with
    /// these, outside the hosts' borrow (WebKit may call back at once).
    pub(super) fn request_target(&self) -> (WebView, Rc<Shared>) {
        (self.web.clone(), self.shared.clone())
    }

    pub(super) fn set(&mut self, view: &NshView, p: &WebProps) {
        let web = &self.web;
        self.shared.defer_downloads.set(p.defer_downloads);
        let old = self.props.take();
        let first = old.is_none();
        let old = old.unwrap_or_default();
        let scripts_changed = first
            || p.injected_js != old.injected_js
            || p.injected_js_before != old.injected_js_before;
        if scripts_changed {
            self.content.remove_all_scripts();
            let add = |source: &str, time: UserScriptInjectionTime| {
                self.content.add_script(&UserScript::new(
                    source,
                    UserContentInjectedFrames::TopFrame,
                    time,
                    &[],
                    &[],
                ));
            };
            add(BRIDGE, UserScriptInjectionTime::Start);
            if let Some(js) = &p.injected_js_before {
                add(js, UserScriptInjectionTime::Start);
            }
            if let Some(js) = &p.injected_js {
                add(js, UserScriptInjectionTime::End);
            }
        }
        if first || p.scrollable != old.scrollable {
            self.content.remove_all_style_sheets();
            if p.scrollable {
                web.remove_css_class(UNSCROLLABLE);
            } else {
                self.content.add_style_sheet(&UserStyleSheet::new(
                    NO_SCROLL,
                    UserContentInjectedFrames::TopFrame,
                    UserStyleLevel::User,
                    &[],
                    &[],
                ));
                web.add_css_class(UNSCROLLABLE);
            }
        }
        if let Some(settings) = WebViewExt::settings(web) {
            settings.set_user_agent(p.user_agent.as_deref());
            settings.set_enable_javascript_markup(p.javascript_enabled);
            settings.set_enable_back_forward_navigation_gestures(p.back_forward_gestures);
        }
        // An opaque background of the view shows until the page paints
        // (and behind pages without one of their own), as on Windows.
        let background = view.state().style.background_color;
        if background.to_f64().3 >= 1.0 {
            web.set_background_color(&rgba(background));
        } else {
            web.set_background_color(&self.default_background);
        }
        // Scripts apply to pages loaded from now on: load again.
        if first || p.source != old.source || scripts_changed {
            self.load(&p.source);
        }
        self.props = Some(p.clone());
    }
}

impl WebHost {
    /// Loads `source`, once the web view is mapped. With WebKit's DMA-BUF
    /// renderer, a page loaded before its web view is mapped sometimes
    /// never shows (about one in six, on X11 and Wayland alike): it
    /// loads, but the view stays blank for good, whatever happens to it
    /// later. Loaded once mapped, as WebKit's MiniBrowser does, it always
    /// shows.
    fn load(&self, source: &WebSource) {
        if self.web.is_mapped() {
            self.pending.borrow_mut().take();
            load(&self.web, source);
        } else {
            *self.pending.borrow_mut() = Some(source.clone());
        }
    }
}

fn load(web: &WebView, source: &WebSource) {
    match source {
        WebSource::Uri(uri) => web.load_uri(uri),
        WebSource::Html { html, base_url } => web.load_html(html, base_url.as_deref()),
        WebSource::None => {}
    }
}

impl Drop for WebHost {
    fn drop(&mut self) {
        self.shared.live.set(false);
        // A removal animation may keep the view on screen a little longer:
        // it shows the page as it was, without loading or reporting.
        self.web.stop_loading();
        for id in self.handlers.drain(..) {
            self.web.disconnect(id);
        }
        if let Some(id) = self.download_started.take() {
            self.session.disconnect(id);
        }
        // Downloads of this page still under way: their native writers are
        // cancelled, and their callbacks stay connected until WebKit
        // reports the write stopped: a `CancelDownload` already waiting is
        // answered then, and nothing else (the core owns the staging
        // directory).
        let downloads = std::mem::take(&mut *self.shared.downloads.borrow_mut());
        for download in downloads.into_values() {
            download.cancel_for_cleanup();
        }
        if let Some(id) = self.message.take() {
            self.content.disconnect(id);
        }
        self.content
            .unregister_script_message_handler(HANDLER, None);
    }
}

/// `reload()`, `goBack()`, `goForward()`, `stopLoading()`,
/// `injectJavaScript()`, `postMessage()` and `load()`.
pub(super) fn command(web: &WebView, command: &Command) {
    let script = match command {
        Command::InjectJavaScript(js) => Some(js.clone()),
        Command::PostMessage(data) => Some(post_message(data)),
        _ => None,
    };
    match (command, script) {
        (_, Some(js)) => {
            web.evaluate_javascript(&js, None, None, None::<&gio::Cancellable>, |result| {
                // Scripts whose value cannot be returned still ran.
                if let Err(err) = result {
                    log::debug!("web view: script: {err}");
                }
            })
        }
        (Command::Reload, _) => web.reload(),
        (Command::GoBack, _) => web.go_back(),
        (Command::GoForward, _) => web.go_forward(),
        (Command::StopLoading, _) => web.stop_loading(),
        (Command::Load(load), _) => {
            // Only this request carries the headers; WebKit makes its
            // subresources' and later navigations' requests itself.
            let request = URIRequest::new(&load.src);
            if let Some(headers) = request.http_headers() {
                for (name, value) in &load.headers {
                    headers.append(name, value);
                }
            }
            web.load_request(&request);
        }
        _ => {}
    }
}

/// Navigations stay within the app's `webview` capability; responses
/// WebKit cannot show are not downloaded.
fn decide_policy(web: &WebView, shared: &Rc<Shared>) -> glib::SignalHandlerId {
    let shared = shared.clone();
    web.connect_decide_policy(move |_, decision, kind| match kind {
        PolicyDecisionType::NavigationAction | PolicyDecisionType::NewWindowAction => {
            let url = decision
                .downcast_ref::<NavigationPolicyDecision>()
                .and_then(|d| d.navigation_action())
                .and_then(|a| a.request())
                .and_then(|r| r.uri())
                .map(|u| u.to_string())
                .unwrap_or_default();
            if allows(shared.access.as_deref(), &url) {
                // WebKit's own handling: it loads (a new window opens
                // nothing, as there is no `create` handler).
                return false;
            }
            decision.ignore();
            log::warn!(target: "js", "web view navigation to {url} is not granted");
            let message = format!("navigation to {url} is not granted");
            shared.emit(EventKind::Error, || {
                EventPayload::Map(vec![
                    ("message", PayloadValue::Str(message)),
                    (
                        "code",
                        PayloadValue::Str(nsh_core::element::codes::ACCESS_DENIED.into()),
                    ),
                    ("url", PayloadValue::Str(url)),
                ])
            });
            true
        }
        PolicyDecisionType::Response => match decision.downcast_ref::<ResponsePolicyDecision>() {
            Some(response) if is_download(response) => {
                if shared.offers_downloads() {
                    // WebKit hands it to the session's downloads, which
                    // hold it for the core's decision.
                    decision.download();
                } else {
                    // Nothing listens: refused like a page WebKit cannot
                    // show, so nothing goes to the system's Downloads.
                    response.ignore();
                }
                true
            }
            Some(response) if !response.is_mime_type_supported() => {
                response.ignore();
                true
            }
            _ => false,
        },
        _ => false,
    })
}

/// Whether a response is a file to save: the main resource's, of a type
/// WebKit cannot show or sent as an attachment.
fn is_download(decision: &ResponsePolicyDecision) -> bool {
    if !decision.is_main_frame_main_resource() {
        return false;
    }
    if !decision.is_mime_type_supported() {
        return true;
    }
    decision
        .response()
        .and_then(|response| response.http_headers())
        .and_then(|headers| headers.content_disposition())
        .is_some_and(|(kind, _)| kind.eq_ignore_ascii_case("attachment"))
}

/// The page's `getUserMedia` gets what the app's `webview.media` grants;
/// WebKit's other permission requests keep its own handling.
fn permission_request(web: &WebView, shared: &Rc<Shared>) -> glib::SignalHandlerId {
    use nsh_core::access::WebMedia;
    let allows = |media| {
        shared
            .access
            .as_deref()
            .is_some_and(|a| a.allows_web_media(media))
    };
    let (microphone, camera) = (allows(WebMedia::Microphone), allows(WebMedia::Camera));
    if (microphone || camera)
        && let Some(settings) = WebViewExt::settings(web)
    {
        settings.set_enable_media_stream(true);
    }
    web.connect_permission_request(move |_, request| {
        let Some(media) = request.downcast_ref::<UserMediaPermissionRequest>() else {
            return false;
        };
        let granted = !webkit6::functions::user_media_permission_is_for_display_device(media)
            && (!media.is_for_audio_device() || microphone)
            && (!media.is_for_video_device() || camera);
        if granted {
            request.allow();
        } else {
            log::warn!(target: "js", "web view media capture is not granted: add it to capabilities.webview.media");
            request.deny();
        }
        true
    })
}

/// Whether the app may show `url` in a web view (`access`: its
/// capabilities, `None` when unknown).
fn allows(access: Option<&Access>, url: &str) -> bool {
    let Some(access) = access else { return true };
    match url {
        "" => true,
        // A frame's inline document (`srcdoc`): the page's own content.
        "about:srcdoc" => access.allows_webviews(),
        _ => access.allows_webview(url),
    }
}

fn load_changed(web: &WebView, shared: &Rc<Shared>) -> glib::SignalHandlerId {
    let shared = shared.clone();
    web.connect_load_changed(move |web, event| match event {
        LoadEvent::Started => {
            shared.failed.set(false);
            shared.emit(EventKind::LoadStart, || navigation_state(web, true));
            shared.emit(EventKind::NavigationStateChange, || {
                navigation_state(web, true)
            });
        }
        // A failed navigation finishes too: it was reported as an error.
        LoadEvent::Finished if !shared.failed.get() => {
            shared.emit(EventKind::Load, || navigation_state(web, false));
            shared.emit(EventKind::NavigationStateChange, || {
                navigation_state(web, false)
            });
        }
        _ => {}
    })
}

fn load_failed(web: &WebView, shared: &Rc<Shared>) -> glib::SignalHandlerId {
    let shared = shared.clone();
    web.connect_load_failed(move |_, _, _, err| {
        shared.failed.set(true);
        // Stopped, replaced by another navigation, or a response refused
        // above: not errors.
        let cancelled = err.matches(NetworkError::Cancelled)
            || err.matches(PolicyError::FrameLoadInterruptedByPolicyChange);
        if !cancelled {
            let message = err.message().to_owned();
            shared.emit(EventKind::Error, || error(message));
        }
        // The app shows failures itself: no WebKit error page.
        true
    })
}

/// Answers a [`Command::WebViewRequest`] for `web`, whose handlers share
/// `shared`: the id comes back in the reply
/// ([`EventKind::WebViewReply`]) on the node the request arrived at.
pub(super) fn web_request(web: &WebView, shared: &Rc<Shared>, request: &WebViewRequest) {
    let id = request.id;
    match &request.operation {
        WebViewOperation::StartDownload {
            id: download,
            staging,
        } => {
            start_download(shared, download, id, staging);
        }
        WebViewOperation::CancelDownload { id: download } => {
            cancel_download(shared, download, id);
        }
        // A newer core's operation: answered, never left waiting.
        _ => {
            let _ = web;
            shared.reply(id, Err("unsupported web view operation".into()));
        }
    }
}

/// WebKit reported a download of this page: held without a destination
/// (nothing is written) and reported to the core, which chooses the
/// staging path or cancels it.
fn started_download(shared: &Rc<Shared>, download: &Download) {
    let n = shared.next_download.get();
    shared.next_download.set(n + 1);
    let at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| since.as_nanos());
    let state = Rc::new(DownloadState {
        download: download.clone(),
        handlers: RefCell::default(),
        id: download_id(at, n),
        offered: Cell::new(false),
        starting: Cell::new(None),
        cancelling: Cell::new(None),
        started: Cell::new(false),
        ended: Cell::new(false),
    });
    shared
        .downloads
        .borrow_mut()
        .insert(state.id.clone(), state.clone());
    let mut handlers = Vec::new();
    {
        let shared = shared.clone();
        let state = state.clone();
        handlers.push(
            download.connect_decide_destination(move |download, _suggested| {
                // `true` in every case: WebKit never chooses a destination of
                // its own (`~/Downloads`); the core picks one or cancels.
                if !state.offered.replace(true) {
                    // A view being torn down offers nothing: the core has no
                    // session for it, and nothing may be written.
                    if shared.live.get() && shared.offers_downloads() {
                        let offer = offer_of(&state, download);
                        shared.report(EventKind::DownloadOffer, webview::download_offer(&offer));
                    } else {
                        // Nothing holds it: nothing may be written.
                        state.ended.set(true);
                        state.disconnect();
                        shared.downloads.borrow_mut().remove(&state.id);
                        download.cancel();
                    }
                }
                true
            }),
        );
    }
    {
        let shared = shared.clone();
        let state = state.clone();
        handlers.push(download.connect_created_destination(move |_, _| {
            // The core's staging file exists now and WebKit writes it: its
            // `StartDownload` is answered, never a later completion.
            state.started.set(true);
            if let Some(request) = state.starting.take() {
                shared.reply(request, Ok(JsonValue::Null));
            }
        }));
    }
    {
        let shared = shared.clone();
        let state = state.clone();
        handlers.push(download.connect_failed(move |_, err| {
            let cancelled = err.matches(DownloadError::CancelledByUser);
            state.ended.set(true);
            state.disconnect();
            shared.downloads.borrow_mut().remove(&state.id);
            let starting = state.starting.take();
            let cancelling = state.cancelling.take();
            if let Some(request) = starting {
                // The transfer stopped before it could write: the start
                // fails with WebKit's error.
                shared.reply(
                    request,
                    Err(if cancelled {
                        "the download was cancelled".into()
                    } else {
                        err.message().to_owned()
                    }),
                );
                if let Some(request) = cancelling {
                    // A cancel was already waiting: writing stopped, so the
                    // core may clean its staging directory. The start's
                    // failure is settled above; no `DownloadEnd` follows.
                    shared.reply(request, Ok(JsonValue::Null));
                    return;
                }
                // The core settles the start's failure and then asks for the
                // stop the ended transfer already made: this end is that
                // acknowledgement, so its staging directory is cleaned.
                let end = DownloadEnd {
                    id: state.id.clone(),
                    outcome: DownloadOutcome::Failed {
                        code: teardown_code(&shared),
                        message: err.message().to_owned(),
                    },
                };
                shared.report(EventKind::DownloadEnd, webview::download_end(&end));
                return;
            }
            if let Some(request) = cancelling {
                // Native writing stopped: the core may now clean its staging
                // directory. A cancellation is settled by the core, so no
                // `DownloadEnd` follows.
                shared.reply(request, Ok(JsonValue::Null));
                return;
            }
            // No request is waiting: this is the transfer's own end. The
            // core settles what it had for the id, or drops an unknown one.
            let end = DownloadEnd {
                id: state.id.clone(),
                outcome: DownloadOutcome::Failed {
                    code: teardown_code(&shared),
                    message: err.message().to_owned(),
                },
            };
            shared.report(EventKind::DownloadEnd, webview::download_end(&end));
        }));
    }
    {
        let shared = shared.clone();
        let state = state.clone();
        handlers.push(download.connect_finished(move |download| {
            state.ended.set(true);
            state.disconnect();
            shared.downloads.borrow_mut().remove(&state.id);
            // A transfer the core asked to write finished, whether or not
            // `created-destination` was seen.
            let started = state.started.get() || state.starting.get().is_some();
            let starting = state.starting.take();
            let cancelling = state.cancelling.take();
            if let Some(request) = starting {
                shared.reply(request, Ok(JsonValue::Null));
            }
            if let Some(request) = cancelling {
                // A cancel arrived before the last bytes were taken: writing
                // has stopped, and the core settles `cancelled`.
                shared.reply(request, Ok(JsonValue::Null));
                return;
            }
            if !started {
                return;
            }
            // The staging file WebKit wrote: the core publishes it. Even
            // after the view went away the file is complete, and the core
            // still owns the staging directory it made.
            let bytes = download
                .destination()
                .and_then(|path| std::fs::metadata(path.as_str()).ok())
                .map_or(0, |meta| meta.len());
            let end = DownloadEnd {
                id: state.id.clone(),
                outcome: DownloadOutcome::Finished { bytes },
            };
            shared.report(EventKind::DownloadEnd, webview::download_end(&end));
        }));
    }
    *state.handlers.borrow_mut() = handlers;
}

/// Writes the download `id` at the core's staging path: WebKit creates
/// the leaf itself (it must not exist), inside the core's private
/// directory. The answer waits only for that file, never for the transfer.
fn start_download(shared: &Rc<Shared>, id: &str, request: u64, staging: &Path) {
    let Some(state) = shared.downloads.borrow().get(id).cloned() else {
        shared.reply(request, Err(format!("unknown download {id}")));
        return;
    };
    if state.ended.get() {
        shared.reply(request, Err(format!("download {id} already finished")));
        return;
    }
    if state.started.get() || state.starting.get().is_some() {
        shared.reply(request, Err(format!("download {id} already started")));
        return;
    }
    if state.cancelling.get().is_some() {
        shared.reply(request, Err(format!("download {id} is being cancelled")));
        return;
    }
    let destination = match staging_destination(staging) {
        Ok(destination) => destination,
        Err(error) => {
            // Nothing was set: the transfer stays held for the core's
            // cancellation (a lossy path would write another file).
            shared.reply(request, Err(error));
            return;
        }
    };
    state.starting.set(Some(request));
    // The core's leaf does not exist: WebKit creates it, inside the core's
    // private directory. Only the answer waits, never the transfer.
    state.download.set_allow_overwrite(false);
    state.download.set_destination(destination);
}

/// The path WebKitGTK may be given for a download's `staging` file.
///
/// WebKitGTK 6 takes an absolute path in the GLib file name encoding
/// (UTF-8): not a file URL, and not bytes. A path it cannot represent must
/// be refused here, or a lossy conversion would make WebKit write another
/// file than the core named. (The core's leaf is ASCII, but the destination
/// folder it stages in need not be UTF-8.)
fn staging_destination(staging: &Path) -> Result<&str, String> {
    if !staging.is_absolute() {
        return Err(format!(
            "the staging path {} is not absolute",
            staging.display()
        ));
    }
    staging
        .to_str()
        .filter(|path| !path.contains('\0'))
        .ok_or_else(|| {
            format!(
                "the staging path {} is not a UTF-8 path WebKitGTK can write",
                staging.display()
            )
        })
}

/// Stops download `id`: answered only once WebKit reports its writer
/// stopped, so the core may then clean the staging directory safely.
fn cancel_download(shared: &Rc<Shared>, id: &str, request: u64) {
    let Some(state) = shared.downloads.borrow().get(id).cloned() else {
        shared.reply(request, Err(format!("unknown download {id}")));
        return;
    };
    if state.ended.get() {
        shared.reply(request, Err(format!("download {id} already finished")));
        return;
    }
    if state.cancelling.get().is_some() {
        shared.reply(
            request,
            Err(format!("download {id} is already being cancelled")),
        );
        return;
    }
    // The answer waits for WebKit's `failed`/`finished`: only then has the
    // writer stopped, and only then may the core clean the staging path.
    state.cancelling.set(Some(request));
    state.download.cancel();
}

/// What the core hears about a download WebKit holds: the final URL, the
/// server's file name (made safe), the type and declared size, and the
/// method WebKit actually used. WebKit owns the bytes, so its source is
/// `Transfer`.
fn offer_of(state: &DownloadState, download: &Download) -> DownloadOffer {
    let response = download.response();
    let request = download.request();
    let url = response
        .as_ref()
        .and_then(|response| response.uri())
        .or_else(|| request.as_ref().and_then(|request| request.uri()))
        .map(|uri| uri.to_string())
        .unwrap_or_default();
    let suggested = response
        .as_ref()
        .and_then(|response| response.suggested_filename());
    DownloadOffer {
        id: state.id.clone(),
        filename: download_name(suggested.as_deref().unwrap_or_default(), &url),
        mime_type: response
            .as_ref()
            .and_then(|response| response.mime_type())
            .map(|mime| mime.to_string()),
        bytes: response.as_ref().and_then(declared_bytes),
        method: request
            .as_ref()
            .and_then(|request| request.http_method())
            .map(|method| method.to_string()),
        url,
        source: WebDownloadSource::Transfer,
    }
}

/// The size the response declares, when it describes the bytes the file
/// receives: a `Content-Encoding` other than `identity` makes
/// `Content-Length` the encoded body's size, not the file's.
fn declared_bytes(response: &webkit6::URIResponse) -> Option<u64> {
    if response
        .http_headers()
        .and_then(|headers| headers.one("content-encoding"))
        .is_some_and(|encoding| !encoding.trim().eq_ignore_ascii_case("identity"))
    {
        return None;
    }
    let length = response.content_length();
    (length > 0).then_some(length)
}

/// A safe file name for a download: the server's suggested one, else the
/// URL's last segment.
fn download_name(suggested: &str, url: &str) -> String {
    if !suggested.trim().is_empty() {
        return file_name(suggested);
    }
    let path = url.split(['?', '#']).next().unwrap_or_default();
    file_name(path.rsplit('/').next().unwrap_or_default())
}

/// A safe id for a download: hex digits only, so it names a directory
/// without escaping it. Fixed widths, so no two differ only in where the
/// clock's digits end.
fn download_id(at: u128, n: u64) -> String {
    format!("{at:032x}{n:016x}")
}

/// The code a failed end carries once the view went away first (`None`
/// when the transfer failed on its own): the core still hears that
/// writing stopped, and only then may it remove the staging directory.
fn teardown_code(shared: &Shared) -> Option<String> {
    (!shared.live.get()).then(|| "ERR_NSH_DOWNLOAD_TEARDOWN".to_owned())
}

/// A file name for a server's suggested one: its last component, without
/// separators or a leading dot, at most 200 bytes; `download` when nothing
/// is left.
fn file_name(suggested: &str) -> String {
    let last = suggested.rsplit(['/', '\\']).next().unwrap_or_default();
    let mut name: String = last
        .chars()
        .filter(|c| {
            !c.is_control()
                && !matches!(c, ':' | '\u{061c}' | '\u{200e}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{206f}')
        })
        .collect::<String>()
        .trim()
        .trim_start_matches('.')
        .to_owned();
    if name.len() > 200 {
        // Preserve a normal extension while shortening the stem on UTF-8
        // boundaries.
        let extension = name
            .rsplit_once('.')
            .map(|(_, ext)| format!(".{ext}"))
            .filter(|ext| ext.len() + name.chars().next().map_or(0, char::len_utf8) <= 200);
        if let Some(extension) = &extension {
            name.truncate(name.len() - extension.len());
        }
        let limit = 200 - extension.as_ref().map_or(0, String::len);
        while name.len() > limit {
            name.pop();
        }
        if let Some(extension) = extension {
            name.push_str(&extension);
        }
    }
    if name.is_empty() {
        "download".to_owned()
    } else {
        name
    }
}

/// `{ url, title, loading, canGoBack, canGoForward }` of a page.
fn navigation_state(web: &WebView, loading: bool) -> EventPayload {
    EventPayload::Map(vec![
        (
            "url",
            PayloadValue::Str(web.uri().map(|u| u.to_string()).unwrap_or_default()),
        ),
        (
            "title",
            PayloadValue::Str(web.title().map(|t| t.to_string()).unwrap_or_default()),
        ),
        ("loading", PayloadValue::Bool(loading)),
        ("canGoBack", PayloadValue::Bool(web.can_go_back())),
        ("canGoForward", PayloadValue::Bool(web.can_go_forward())),
    ])
}

/// Which way a history key or button goes.
#[derive(Debug, Clone, Copy, PartialEq)]
enum History {
    Back,
    Forward,
}

/// The history key `key` with `modifiers` is, if it is one.
fn history_key(key: gdk::Key, modifiers: gdk::ModifierType) -> Option<History> {
    let mods = modifiers
        & (gdk::ModifierType::CONTROL_MASK
            | gdk::ModifierType::ALT_MASK
            | gdk::ModifierType::SHIFT_MASK
            | gdk::ModifierType::SUPER_MASK);
    let alt = mods == gdk::ModifierType::ALT_MASK;
    match key {
        gdk::Key::Back if mods.is_empty() => Some(History::Back),
        gdk::Key::Forward if mods.is_empty() => Some(History::Forward),
        gdk::Key::Left | gdk::Key::KP_Left if alt => Some(History::Back),
        gdk::Key::Right | gdk::Key::KP_Right if alt => Some(History::Forward),
        _ => None,
    }
}

/// Goes `way` in the page's history, or back in the app when the page
/// has none: whether something took it.
fn go(web: &WebView, surface: &std::rc::Weak<Surface>, way: History) -> bool {
    match way {
        History::Back if web.can_go_back() => web.go_back(),
        History::Forward if web.can_go_forward() => web.go_forward(),
        History::Back => {
            return surface
                .upgrade()
                .is_some_and(|s| crate::navigation::go_back(&s));
        }
        History::Forward => return false,
    }
    true
}

/// History keys and mouse buttons over the page, before WebKit sees them
/// (it keeps arrow keys, used or not).
fn history_keys(web: &WebView, surface: &Rc<Surface>) {
    let keys = gtk::EventControllerKey::new();
    keys.set_propagation_phase(gtk::PropagationPhase::Capture);
    let weak = Rc::downgrade(surface);
    keys.connect_key_pressed(move |keys, key, _, modifiers| {
        let taken = keys
            .widget()
            .and_downcast::<WebView>()
            .zip(history_key(key, modifiers))
            .is_some_and(|(web, way)| go(&web, &weak, way));
        if taken {
            glib::Propagation::Stop
        } else {
            glib::Propagation::Proceed
        }
    });
    web.add_controller(keys);
    let buttons = gtk::GestureClick::new();
    // Any button: only the back (8) and forward (9) ones are taken.
    buttons.set_button(0);
    buttons.set_propagation_phase(gtk::PropagationPhase::Capture);
    let weak = Rc::downgrade(surface);
    buttons.connect_pressed(move |gesture, _, _, _| {
        let way = match gesture.current_button() {
            8 => History::Back,
            9 => History::Forward,
            _ => return,
        };
        if let Some(web) = gesture.widget().and_downcast::<WebView>()
            && go(&web, &weak, way)
        {
            gesture.set_state(gtk::EventSequenceState::Claimed);
        }
    });
    web.add_controller(buttons);
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

/// The script `postMessage(data)` runs in the page.
fn post_message(data: &str) -> String {
    format!(
        "window.dispatchEvent(new MessageEvent('message', {{ data: {} }}));",
        js_string(data)
    )
}

/// Where web views of app `app_id` keep their data and cache.
fn folders(app_id: &str) -> (PathBuf, PathBuf) {
    let app = if app_id.is_empty() { "nsh" } else { app_id };
    // An id is a reverse domain name: keep it a single folder name.
    let app: String = app
        .chars()
        .map(|c| if c == '/' || c == '\0' { '_' } else { c })
        .collect();
    let app = if app == "." || app == ".." {
        "nsh".to_owned()
    } else {
        app
    };
    (
        glib::user_data_dir().join(&app).join("webkit"),
        glib::user_cache_dir().join(&app).join("webkit"),
    )
}

thread_local! {
    /// Network sessions by app id: one network process (and one set of
    /// cookies and storage) serves every web view of an app. Weak: each
    /// web view holds its session, which ends with the app's last one.
    static SESSIONS: RefCell<HashMap<String, glib::WeakRef<NetworkSession>>> = RefCell::default();
}

/// The network session of app `app_id`.
fn session(app_id: &str) -> NetworkSession {
    shared_session(app_id, || {
        let (data, cache) = folders(app_id);
        if let Err(err) = std::fs::create_dir_all(&data) {
            log::warn!("web view: cannot create {}: {err}", data.display());
        }
        let session = NetworkSession::new(data.to_str(), cache.to_str());
        // Cookies outlive the app, as other website data does.
        if let Some(cookies) = session.cookie_manager() {
            cookies.set_persistent_storage(
                &data.join("cookies.sqlite").to_string_lossy(),
                CookiePersistentStorage::Sqlite,
            );
        }
        session
    })
}

/// The session app `app_id`'s web views use, else the one `new` makes.
fn shared_session(app_id: &str, new: impl FnOnce() -> NetworkSession) -> NetworkSession {
    SESSIONS.with(|sessions| {
        let mut sessions = sessions.borrow_mut();
        if let Some(session) = sessions.get(app_id).and_then(|weak| weak.upgrade()) {
            return session;
        }
        let session = new();
        sessions.insert(app_id.to_owned(), session.downgrade());
        session
    })
}

#[cfg(test)]
mod tests {
    use nsh_engine::Capabilities;

    use super::*;

    #[test]
    fn escapes_js_strings() {
        assert_eq!(js_string("a\"b\\c\nd\u{1}"), r#""a\"b\\c\nd\u0001""#);
        assert_eq!(
            post_message("hi #1"),
            r#"window.dispatchEvent(new MessageEvent('message', { data: "hi #1" }));"#
        );
    }

    #[test]
    fn names_folders() {
        let (data, cache) = folders("com.example.app");
        assert!(data.ends_with("com.example.app/webkit"), "{data:?}");
        assert!(cache.ends_with("com.example.app/webkit"), "{cache:?}");
        assert!(folders("a/b").0.ends_with("a_b/webkit"));
        assert!(folders("..").0.ends_with("nsh/webkit"));
        assert!(folders("").0.ends_with("nsh/webkit"));
    }

    #[test]
    fn web_views_share_a_session_that_ends_with_the_last() {
        crate::gtk_test::run(|| {
            let ephemeral = || NetworkSession::new_ephemeral();
            let first = shared_session("sessions.test", ephemeral);
            let web = WebView::builder().network_session(&first).build();
            let ended = first.downgrade();
            drop(first);
            // A second web view of the app gets the first one's session.
            let second = shared_session("sessions.test", ephemeral);
            assert_eq!(web.network_session().as_ref(), Some(&second));
            drop(second);
            drop(web);
            // Nothing holds it once its last web view is gone, so WebKit
            // ends its network process.
            assert!(ended.upgrade().is_none());
        });
    }

    #[test]
    fn decides_navigations() {
        let caps =
            |json: &str| Capabilities::from_json(&serde_json::from_str(json).unwrap()).unwrap();
        let access = Access {
            declared: caps(r#"{ "webview": { "hosts": ["example.com"] } }"#),
            granted: None,
        };
        assert!(allows(None, "https://anything.test/"));
        assert!(allows(Some(&access), "https://example.com/a"));
        assert!(!allows(Some(&access), "https://other.test/"));
        assert!(allows(Some(&access), "about:blank"));
        assert!(allows(Some(&access), "about:srcdoc"));
        assert!(allows(Some(&access), ""));
        let none = Access {
            declared: caps("{}"),
            granted: None,
        };
        assert!(!allows(Some(&none), "about:blank"));
        assert!(!allows(Some(&none), "about:srcdoc"));
    }

    #[test]
    fn reads_history_keys() {
        use gdk::ModifierType as M;
        assert_eq!(
            history_key(gdk::Key::Left, M::ALT_MASK),
            Some(History::Back)
        );
        assert_eq!(
            history_key(gdk::Key::KP_Right, M::ALT_MASK),
            Some(History::Forward)
        );
        assert_eq!(history_key(gdk::Key::Back, M::empty()), Some(History::Back));
        assert_eq!(history_key(gdk::Key::Left, M::empty()), None);
        assert_eq!(
            history_key(gdk::Key::Left, M::ALT_MASK | M::SHIFT_MASK),
            None
        );
        // Lock keys and mouse buttons held do not count.
        assert_eq!(
            history_key(gdk::Key::Left, M::ALT_MASK | M::LOCK_MASK),
            Some(History::Back)
        );
    }
    #[test]
    fn names_download_file_names_safely() {
        assert_eq!(file_name("report.pdf"), "report.pdf");
        assert_eq!(file_name("../../etc/passwd"), "passwd");
        assert_eq!(file_name(r"..\..\boot.ini"), "boot.ini");
        assert_eq!(file_name(".profile"), "profile");
        assert_eq!(file_name("a\u{0}b\u{7}.txt"), "ab.txt");
        assert_eq!(file_name("   "), "download");
        assert_eq!(file_name(""), "download");
        assert_eq!(file_name("/"), "download");
        assert_eq!(file_name("报告.pdf"), "报告.pdf");
        let long = format!("{}.gz", "é".repeat(400));
        let name = file_name(&long);
        assert!(name.len() <= 200, "{} bytes", name.len());
        assert!(name.ends_with(".gz"), "{name}");
        assert_eq!(file_name("invoice\u{202e}fdp.exe"), "invoicefdp.exe");
    }

    #[test]
    fn names_download_directories_without_traversal() {
        let id = download_id(0x1234_5678_9abc_def0, 42);
        assert!(!id.is_empty());
        assert!(id.bytes().all(|b| b.is_ascii_hexdigit()));
        assert_ne!(id, download_id(0x1234_5678_9abc_def0, 43));
        assert_ne!(id, download_id(0x1234_5678_9abc_def1, 42));
        assert_eq!(Path::new(&id).components().count(), 1);
    }

    #[test]
    fn refuses_staging_paths_webkit_cannot_name() {
        assert_eq!(
            staging_destination(Path::new("/tmp/.nsh-download-1/x.bin")),
            Ok("/tmp/.nsh-download-1/x.bin")
        );
        assert!(staging_destination(Path::new("downloads/x.bin")).is_err());
        // A NUL would end the C string: never a path WebKit could write.
        assert!(staging_destination(Path::new("/tmp/a\0b")).is_err());
        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStrExt;
            let not_utf8 = std::ffi::OsStr::from_bytes(b"/tmp/\xff/x.bin");
            assert!(staging_destination(Path::new(not_utf8)).is_err());
        }
    }

    #[test]
    fn names_downloads_from_the_url_when_the_server_suggests_nothing() {
        assert_eq!(
            download_name("", "https://example.test/files/report.pdf?token=1#page"),
            "report.pdf"
        );
        assert_eq!(download_name("", "https://example.test/"), "download");
        assert_eq!(
            download_name("../../etc/passwd", "https://example.test/"),
            "passwd"
        );
        assert_eq!(download_name("", "https://example.test/a/b/"), "download");
    }
}
