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
//! WebView2 profile per app id.
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
    path::PathBuf,
    rc::Rc,
    sync::Arc,
};

use gtk4::{self as gtk, gdk, gio, glib, prelude::*};
use nsh_core::{Command, EventKind, EventPayload, PayloadValue, WebProps, WebSource};
use nsh_engine::Access;
use webkit6::{
    CookiePersistentStorage, LoadEvent, NavigationPolicyDecision, NetworkError, NetworkSession,
    PolicyDecisionType, PolicyError, ResponsePolicyDecision, UserContentInjectedFrames,
    UserContentManager, UserScript, UserScriptInjectionTime, UserStyleLevel, UserStyleSheet,
    WebView, prelude::*,
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
struct Shared {
    emitter: Emitter,
    /// What the app may show (its `webview` capability); `None`: nothing
    /// is known about the app, so nothing is refused.
    access: Option<Arc<Access>>,
    /// The current navigation failed (WebKit still finishes it).
    failed: Cell<bool>,
}

impl Shared {
    fn emit(&self, kind: EventKind, payload: impl FnOnce() -> EventPayload) {
        self.emitter.emit(kind, payload);
    }
}

/// A web view: the page filling its node's view.
pub(super) struct WebHost {
    web: WebView,
    content: UserContentManager,
    /// Handlers on `web` (disconnected when the host goes).
    handlers: Vec<glib::SignalHandlerId>,
    /// The script message handler, on `content`.
    message: Option<glib::SignalHandlerId>,
    /// The props applied (`None` before the first).
    props: Option<WebProps>,
    /// WebKit's own background (white), for views without an opaque one.
    default_background: gdk::RGBA,
    /// A page to load once the web view is mapped ([`WebHost::load`]).
    pending: Rc<RefCell<Option<WebSource>>>,
}

impl WebHost {
    pub(super) fn new(surface: &Rc<Surface>, view: &NshView) -> Self {
        let shared = Rc::new(Shared {
            emitter: Emitter {
                surface: Rc::downgrade(surface),
                view: view.downgrade(),
                id: view.id(),
            },
            access: surface.native.access.borrow().clone(),
            failed: Cell::new(false),
        });
        let content = UserContentManager::new();
        content.register_script_message_handler(HANDLER, None);
        let session = session(&surface.native.app_id.borrow());
        let web = WebView::builder()
            .network_session(&session)
            .user_content_manager(&content)
            .build();
        let default_background = web.background_color();
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
            load_changed(&web, &shared),
            load_failed(&web, &shared),
            web.connect_web_process_terminated(|_, reason| {
                log::warn!(target: "js", "web view: the page's process ended ({reason:?})");
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
            handlers,
            message: Some(message),
            pending,
            props: None,
            default_background,
        }
    }

    /// The page (to call outside the hosts' borrow).
    pub(super) fn web(&self) -> WebView {
        self.web.clone()
    }

    pub(super) fn set(&mut self, view: &NshView, p: &WebProps) {
        let web = &self.web;
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
        // A removal animation may keep the view on screen a little longer:
        // it shows the page as it was, without loading or reporting.
        self.web.stop_loading();
        for id in self.handlers.drain(..) {
            self.web.disconnect(id);
        }
        if let Some(id) = self.message.take() {
            self.content.disconnect(id);
        }
        self.content
            .unregister_script_message_handler(HANDLER, None);
    }
}

/// `reload()`, `goBack()`, `goForward()`, `stopLoading()`,
/// `injectJavaScript()` and `postMessage()`.
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
            Some(response) if !response.is_mime_type_supported() => {
                response.ignore();
                true
            }
            _ => false,
        },
        _ => false,
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
    /// cookies and storage) serves every web view of an app.
    static SESSIONS: RefCell<HashMap<String, NetworkSession>> = RefCell::default();
}

/// The network session of app `app_id`.
fn session(app_id: &str) -> NetworkSession {
    SESSIONS.with(|sessions| {
        sessions
            .borrow_mut()
            .entry(app_id.to_owned())
            .or_insert_with(|| {
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
            .clone()
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
}
