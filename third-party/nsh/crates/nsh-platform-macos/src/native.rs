//! Native controls (videos, web views) and the native components the
//! embedding app registers (`nsh/native`'s `nativeComponent`).
//!
//! Each control is an AppKit view hosted in its node's view
//! ([`NshView::set_native`]) filling it: the node's view keeps decoration,
//! frames, input and accessibility, as for any view, and [`resized`] keeps
//! the control at its size.
//!
//! - **Videos**: an `AVPlayer` shown in an `AVPlayerLayer` (the layer of a
//!   view that lets the pointer through, so presses and gestures reach the
//!   node as on any view), or in AVKit's `AVPlayerView` with the system's
//!   playback controls when `controls` is set (that view takes the mouse).
//!   AVFoundation and AVKit are loaded on first use (`dlopen`), as on iOS,
//!   so apps without videos do not pay for them at launch, and the player
//!   is made on a later frame than the one that mounts the video
//!   ([`start_later`]).
//! - **Web views**: a `WKWebView` (WebKit, also loaded on first use, and
//!   made on a later frame: [`start_later`]) that takes the mouse, wheel
//!   and keyboard itself. Pages talk to the app
//!   through `window.nsh.postMessage` (a script message
//!   handler); top-level navigations stay within the app's `webview`
//!   capability. WebKit on macOS has no scroll view to turn off: with
//!   `scrollable={false}` the root's `hitTest:` keeps wheel and
//!   trackpad scrolls from the web view ([`passes_wheel`]), so they move
//!   the app's scroll views around it, as on iOS (the page itself still
//!   scrolls with its keys and its own scripts).
//!   A web view with an `onDownload` or `onDownloadPending` listener turns
//!   what the page downloads (an attachment, a type WebKit cannot show, a
//!   `download` link) into a `WKDownload`; without one those navigations
//!   stay as they were. The download is handed to the core
//!   (`nsh_platform_apple::web_download`), which decides its destination,
//!   cancellation and lifecycle: the platform asks WebKit to write where
//!   the core says and reports where it is (started, finished, failed).
//!   Staging, publication and cleanup are the core's file rules; this
//!   backend never chooses a path or removes a file. Dropping the host
//!   cancels its downloads (WebKit stops writing; the core cleans up).
//! - **Registered components**: [`AppView::register_component`] names a
//!   factory; the core creates a [`ViewKind::Native`] container, names the
//!   component ([`MountItem::Component`]) and sends its props as JSON as
//!   they change. Components emit events and report their own size through
//!   their [`ComponentContext`]. Registries belong to one `AppView` (and
//!   the views made from the same [`AppOptions`]): no globals.
//!
//! [`AppView::register_component`]: crate::AppView::register_component
//! [`AppOptions`]: crate::AppOptions
//! [`MountItem::Component`]: nsh_core::MountItem::Component

use std::{
    cell::{Cell, RefCell},
    ffi::CStr,
    ptr::NonNull,
    rc::{Rc, Weak},
    sync::{Arc, OnceLock},
};

use block2::RcBlock;
use nsh_core::{
    Bounds, Command, EventKind, EventPayload, JsonValue, NativeProps, NodeId, PayloadValue, Points,
    ResizeMode, Size, VideoProps, ViewKind, WebInput, WebKey, WebProps, WebSource,
    access::WebMedia,
    geometry::Point,
    webview::{WebViewOperation, WebViewRequest},
};
use nsh_engine::{Access, App, EngineControl, Policy};
use nsh_platform_apple::web_download;
use objc2::{
    DefinedClass, Encode, Encoding, MainThreadMarker, MainThreadOnly, define_class, msg_send,
    rc::{Allocated, Retained},
    runtime::{AnyClass, AnyObject, Bool, ProtocolObject},
};
use objc2_app_kit::{NSEvent, NSEventModifierFlags, NSEventType, NSView, NSWindow};
use objc2_core_foundation::CGSize;
use objc2_foundation::{
    NSNotification, NSNotificationCenter, NSObject, NSObjectProtocol, NSOperationQueue, NSPoint,
    NSRect, NSString, NSURL,
};
use rustc_hash::{FxHashMap, FxHashSet};

use crate::{
    image::AssetBase,
    surface::{Next, Surface},
    view::{NshView, ViewObj},
};

/// A native component made by a registered factory.
///
/// ```no_run
/// use nsh_platform_macos::{
///     NativeComponent,
///     objc2::{MainThreadMarker, rc::Retained},
///     objc2_app_kit::{NSTextField, NSView},
///     objc2_foundation::NSString,
/// };
///
/// /// A label the app shows with a `text` prop.
/// struct Badge(Retained<NSTextField>);
///
/// impl Badge {
///     fn new(mtm: MainThreadMarker) -> Self {
///         Badge(NSTextField::labelWithString(&NSString::new(), mtm))
///     }
/// }
///
/// impl NativeComponent for Badge {
///     fn view(&self) -> Retained<NSView> {
///         Retained::into_super(Retained::into_super(self.0.clone()))
///     }
///
///     fn set_prop(&mut self, name: &str, value: Option<&serde_json::Value>) {
///         if name == "text" {
///             let text = value.and_then(|v| v.as_str()).unwrap_or("");
///             self.0.setStringValue(&NSString::from_str(text));
///         }
///     }
/// }
/// ```
pub trait NativeComponent {
    /// Its view; it fills the container nsh lays out.
    fn view(&self) -> Retained<NSView>;

    /// Prop `name` changed (`None`: removed). Every prop the app set comes
    /// right after the component is made.
    fn set_prop(&mut self, name: &str, value: Option<&JsonValue>);

    /// JS called `ref.command(name, args)`.
    fn command(&mut self, name: &str, args: &JsonValue) {
        let _ = (name, args);
    }

    /// Prop `name`, bound to an animated value, moved to `value` (on the
    /// frames it changes, without JS). By default, [`Self::set_prop`] with
    /// a JSON number.
    fn set_animated_number(&mut self, name: &str, value: f64) {
        let json = serde_json::Number::from_f64(value).map_or(JsonValue::Null, JsonValue::Number);
        self.set_prop(name, Some(&json));
    }

    /// Prop `name`, bound to an animated color, moved to `argb`
    /// (`0xAARRGGBB`). By default, [`Self::set_prop`] with a JSON number.
    fn set_animated_color(&mut self, name: &str, argb: u32) {
        self.set_prop(name, Some(&JsonValue::from(argb)));
    }
}

/// What a component can tell its app. Cheap to clone; usable from any
/// thread.
#[derive(Clone)]
pub struct ComponentContext {
    id: NodeId,
    control: EngineControl,
}

impl std::fmt::Debug for ComponentContext {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ComponentContext")
            .field("id", &self.id)
            .finish()
    }
}

impl ComponentContext {
    /// Emits event `name` with `data`: the handler `on<Name>` gets it.
    pub fn emit(&self, name: &str, data: JsonValue) {
        self.control.dispatch_event(
            self.id,
            EventKind::NativeEvent,
            EventPayload::Native {
                name: name.into(),
                data,
            },
        );
    }

    /// The component's own size (points): used where its style leaves a
    /// dimension open.
    pub fn set_size(&self, width: f32, height: f32) {
        self.control
            .set_component_size(self.id, Size::new(Points(width), Points(height)));
    }
}

// Components may emit from any thread (their own callbacks, workers).
const _: () = {
    const fn send_sync<T: Send + Sync>() {}
    send_sync::<ComponentContext>();
};

/// Makes a component for an element, given its context.
pub type ComponentFactory = Rc<dyn Fn(ComponentContext) -> Box<dyn NativeComponent>>;

/// The components registered with a view (shared by its clones, so
/// registrations apply to elements created from then on).
#[derive(Clone, Default)]
pub struct Components {
    factories: Rc<RefCell<FxHashMap<Arc<str>, ComponentFactory>>>,
    /// Names already reported as unknown.
    missing: Rc<RefCell<FxHashSet<Arc<str>>>>,
}

impl std::fmt::Debug for Components {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_set()
            .entries(self.factories.borrow().keys())
            .finish()
    }
}

impl Components {
    /// Registers `factory` under `name` (replacing an earlier one). Names
    /// under `nsh/` are NSH's own: registering one logs a warning and
    /// changes nothing.
    pub fn register(&self, name: &str, factory: ComponentFactory) {
        if nsh_core::platform::is_reserved_component(name) {
            log::warn!("native component `{name}` is not registered: names under `nsh/` are NSH's");
            return;
        }
        self.factories.borrow_mut().insert(name.into(), factory);
        self.missing.borrow_mut().remove(name);
    }

    /// The factory registered as `name`; `None` (logged once per name) if
    /// there is none.
    fn factory(&self, name: &Arc<str>) -> Option<ComponentFactory> {
        let factory = self.factories.borrow().get(name).cloned();
        if factory.is_none() && self.missing.borrow_mut().insert(name.clone()) {
            log::warn!(
                target: "js",
                "no native component is registered as `{name}`: it renders an empty view"
            );
        }
        factory
    }
}

/// The native controls of one surface.
#[derive(Default)]
pub(crate) struct NativeState {
    /// The components the app can use.
    components: RefCell<Components>,
    /// Where `asset:/` video sources are.
    asset_base: RefCell<Option<AssetBase>>,
    /// What the running app may show in web views (its `webview`
    /// capability); `None` before an app starts.
    access: RefCell<Option<Arc<Access>>>,
    /// The controls, by node.
    hosts: RefCell<FxHashMap<NodeId, Host>>,
    /// What the videos and web views not made yet were sent, by node
    /// ([`start_later`]).
    waiting: RefCell<FxHashMap<NodeId, Waiting>>,
    /// The last [`Waiting::serial`] given.
    serial: Cell<u64>,
}

impl NativeState {
    /// Uses `components` (an [`crate::AppOptions`]'s registry).
    pub(crate) fn set_components(&self, components: Components) {
        *self.components.borrow_mut() = components;
    }

    /// The registry, to register in.
    pub(crate) fn components(&self) -> Components {
        self.components.borrow().clone()
    }

    /// Where `asset:/` sources resolve from now on.
    pub(crate) fn set_asset_base(&self, base: Option<AssetBase>) {
        *self.asset_base.borrow_mut() = base;
    }

    /// `app` is about to start: its web views are limited to what its
    /// policy grants.
    pub(crate) fn set_app(&self, app: &App) {
        let access = match app {
            App::Js(bundle) => bundle.policy.access(),
            // Native code reaches what the platform allows.
            App::Rust(_) => Policy::default().access(),
        };
        *self.access.borrow_mut() = Some(Arc::new(access));
    }

    /// What the running app may reach (all before an app starts): what
    /// its image loads check their redirects against.
    pub(crate) fn access(&self) -> Arc<Access> {
        self.access.borrow().clone().unwrap_or_default()
    }

    /// Drops every control (the app stopped): media stops playing.
    pub(crate) fn clear(&self) {
        self.waiting.borrow_mut().clear();
        let hosts = std::mem::take(&mut *self.hosts.borrow_mut());
        drop(hosts);
    }
}

/// What a native view holds.
enum Host {
    Video(VideoHost),
    Web(WebHost),
    /// A registered component; `None` until named, or when unknown.
    Component(Option<Box<dyn NativeComponent>>),
}

impl Host {
    /// Its node's view and the hosted view, if that one shows what
    /// another process draws, which `renderInContext:` leaves out: a
    /// `WKWebView` (WebKit's web content process) or a video (an
    /// `AVPlayerLayer`, drawn by the media server).
    fn drawn_elsewhere(&self) -> Option<(NshView, Retained<NSView>)> {
        match self {
            Host::Web(host) => {
                let web = host.web.as_ref()?;
                let holder = host.holder.load().and_then(|v| NshView::from_ns(&v))?;
                // SAFETY: a WKWebView is an NSView.
                Some((holder, Retained::from(unsafe { as_view(web) })))
            }
            Host::Video(host) => Some((host.view.clone(), host.shown.clone()?)),
            Host::Component(_) => None,
        }
    }

    /// Whether `view` is the view it hosts in its node's view.
    fn hosts(&self, view: &NSView) -> bool {
        match self {
            Host::Web(host) => host.is(view),
            Host::Video(host) => host.shown.as_deref().is_some_and(|v| std::ptr::eq(v, view)),
            Host::Component(_) => false,
        }
    }
}

/// Sets up a web view, video or component container. A video's player
/// and a web view's `WKWebView` are made on a later frame
/// ([`start_later`]).
pub(crate) fn create(surface: &Rc<Surface>, view: &NshView) {
    let host = match view.kind() {
        ViewKind::Video => {
            start_later(surface, view);
            Host::Video(VideoHost::new(surface, view))
        }
        ViewKind::WebView => {
            start_later(surface, view);
            let access = surface.native.access.borrow().clone();
            Host::Web(WebHost::new(surface, view, access))
        }
        _ => Host::Component(None),
    };
    surface.native.hosts.borrow_mut().insert(view.id(), host);
}

/// A view was deleted: its control stops (a removal animation may keep
/// the view on screen a little longer).
pub(crate) fn deleted(surface: &Rc<Surface>, view: &NshView) {
    surface.native.waiting.borrow_mut().remove(&view.id());
    let host = surface.native.hosts.borrow_mut().remove(&view.id());
    drop(host);
}

/// What a video or web view not made yet was sent, in order.
struct Waiting {
    /// Tells this wait from a later one of a node with the same id.
    serial: u64,
    sent: Vec<Sent>,
}

/// One thing a waiting video or web view was sent.
enum Sent {
    Props(NativeProps),
    Command(Command),
}

/// Makes `view`'s player or `WKWebView` on a later frame than the one
/// that mounts it, and the props and commands it was sent meanwhile are
/// applied then, in order.
///
/// The first video or web view of a process costs the main thread a lot
/// once (measured on the gallery: 21 ms for the first video, 123 ms for
/// the first web view): loading AVFoundation or WebKit and setting up the
/// framework's process-wide state, all of which has to happen on the main
/// thread. Each step takes a frame of its own after the one that mounts
/// the page, so the page shows at once and the view fills in a few frames
/// later: the framework is loaded (if it is not yet), then a web view's
/// configuration is made (WebKit's process pool and website data store on
/// first use), then the player or `WKWebView`. Its events (load start,
/// ready, progress) come as they did, only later.
fn start_later(surface: &Rc<Surface>, view: &NshView) {
    let serial = surface.native.serial.get() + 1;
    surface.native.serial.set(serial);
    surface.native.waiting.borrow_mut().insert(
        view.id(),
        Waiting {
            serial,
            sent: Vec::new(),
        },
    );
    let (id, weak) = (view.id(), objc2::rc::Weak::new(&**view));
    // Called first in the frame that applies the batch: that one is left
    // to the batch.
    let mut frames = 0u32;
    surface.add_background_callback(move |surface, now| {
        let later = Next::At(now + 1.0 / 60.0);
        let current = surface.native.waiting.borrow().get(&id).map(|w| w.serial);
        if current != Some(serial) {
            // Deleted (or the app stopped) meanwhile.
            return Next::Done;
        }
        frames += 1;
        if frames == 1 {
            return later;
        }
        let Some(view) = weak.load().and_then(|v| NshView::from_ns(&v)) else {
            surface.native.waiting.borrow_mut().remove(&id);
            return Next::Done;
        };
        // One framework per frame.
        if let Some(framework) = frameworks(surface, &view).into_iter().find(|f| !f.tried()) {
            framework.get();
            return later;
        }
        // Then the costly steps of making it, one per frame.
        let step = match view.kind() {
            ViewKind::WebView => web_step(surface, &view),
            ViewKind::Video => video_step(surface, &view),
            _ => false,
        };
        if step {
            return later;
        }
        let sent = surface
            .native
            .waiting
            .borrow_mut()
            .remove(&id)
            .map(|w| w.sent)
            .unwrap_or_default();
        for sent in sent {
            match sent {
                Sent::Props(p) => apply_props(surface, &view, &p),
                Sent::Command(c) => apply_command(surface, &view, &c),
            }
        }
        Next::Done
    });
}

/// The frameworks the waiting `view` needs: WebKit for a web view,
/// AVFoundation for a video, and AVKit for one with `controls`.
fn frameworks(surface: &Surface, view: &NshView) -> Vec<&'static Framework> {
    match view.kind() {
        ViewKind::WebView => vec![&WEBKIT],
        ViewKind::Video => {
            let controls = surface
                .native
                .waiting
                .borrow()
                .get(&view.id())
                .is_some_and(|w| {
                    w.sent
                        .iter()
                        .any(|s| matches!(s, Sent::Props(NativeProps::Video(p)) if p.controls))
                });
            if controls {
                vec![&AV_FOUNDATION, &AV_KIT]
            } else {
                vec![&AV_FOUNDATION]
            }
        }
        _ => Vec::new(),
    }
}

/// The first props a waiting `view` was sent.
fn first_props(surface: &Surface, id: NodeId) -> Option<NativeProps> {
    surface.native.waiting.borrow().get(&id).and_then(|w| {
        w.sent.iter().find_map(|s| match s {
            Sent::Props(p) => Some(p.clone()),
            _ => None,
        })
    })
}

/// Takes the next costly step of making the waiting web view of `view`,
/// if one is left: its configuration ([`WebHost::configure`]), its
/// `WKWebView` ([`WebHost::build`]), the props it was sent before any
/// command with its page's load held ([`WebHost::hold_load`]), the load.
/// Whether it took one (the rest comes next frame); without one left, what
/// it was sent is applied.
/// How long a web view's first load waits for the surface to stop moving
/// ([`web_step`]).
const LOAD_WAIT: std::time::Duration = std::time::Duration::from_millis(500);

fn web_step(surface: &Rc<Surface>, view: &NshView) -> bool {
    let id = view.id();
    let first = match first_props(surface, id) {
        Some(NativeProps::WebView(p)) => Some(p),
        _ => None,
    };
    {
        let mut hosts = surface.native.hosts.borrow_mut();
        let Some(Host::Web(web)) = hosts.get_mut(&id) else {
            return false;
        };
        // WebKit failed: the props apply as they come (and fail as they did).
        if !webkit() {
            return false;
        }
        if web.config.is_none() {
            // No props were sent (the core sends them with the view): made
            // with the props when they come.
            let Some(first) = &first else { return false };
            if web.adopt(first) {
                return true;
            }
            web.configure(first);
            return web.config.is_some();
        }
        if web.web.is_none() {
            web.build();
            return web.web.is_some();
        }
        if web.props.is_some() {
            // Its settings are in: the load is this frame's step.
            web.hold_load = false;
            if !web.load_pending {
                return false;
            }
            // The first load of a process prepares its web content and
            // networking processes on this thread (tens of milliseconds):
            // it waits for the page's transition, for a while.
            let since = *web.load_waits.get_or_insert_with(std::time::Instant::now);
            if surface.moving() && since.elapsed() < LOAD_WAIT {
                return true;
            }
            web.load_waits = None;
            web.load_pending = false;
            if let Some(p) = web.props.clone() {
                web.load(&p);
            }
            return true;
        }
        web.hold_load = true;
    }
    // The props sent before any command (a command may need the page
    // loaded), applied with the load held.
    let settings: Vec<NativeProps> = {
        let mut waiting = surface.native.waiting.borrow_mut();
        let Some(w) = waiting.get_mut(&id) else {
            return false;
        };
        let n = w
            .sent
            .iter()
            .position(|s| matches!(s, Sent::Command(_)))
            .unwrap_or(w.sent.len());
        w.sent
            .drain(..n)
            .filter_map(|s| match s {
                Sent::Props(p) => Some(p),
                Sent::Command(_) => None,
            })
            .collect()
    };
    if settings.is_empty() {
        if let Some(Host::Web(web)) = surface.native.hosts.borrow_mut().get_mut(&id) {
            web.hold_load = false;
        }
        return false;
    }
    for p in &settings {
        apply_props(surface, view, p);
    }
    true
}

/// Takes the next costly step of making the waiting video of `view`, if
/// one is left: its player, opened with the first props' source
/// ([`VideoHost::prepare`]); the view showing it comes with the props
/// applied the frame after. Whether it took one.
fn video_step(surface: &Rc<Surface>, view: &NshView) -> bool {
    let Some(NativeProps::Video(first)) = first_props(surface, view.id()) else {
        return false;
    };
    let mut hosts = surface.native.hosts.borrow_mut();
    let Some(Host::Video(video)) = hosts.get_mut(&view.id()) else {
        return false;
    };
    if video.prepared.is_some() || video.props.is_some() || !av_foundation() {
        return false;
    }
    let base = surface.native.asset_base.borrow();
    video.prepare(&first, base.as_ref());
    true
}

thread_local! {
    /// The process pool [`warm_web`] made, which every web view's
    /// configuration then uses (all web views share one pool anyway since
    /// macOS 12; holding it keeps what was warmed alive).
    static WEB_POOL: RefCell<Option<Retained<AnyObject>>> = const { RefCell::new(None) };
    /// The warm-up's next step ([`warm_web`]) and the surface whose idle
    /// moments it waits for.
    static WEB_WARM: Cell<(u64, u8)> = const { Cell::new((0, 0)) };
    /// A `WKWebView` made ahead at an idle moment, which the next web view
    /// that can use it takes ([`WebHost::adopt`]).
    static WEB_SPARE: RefCell<Option<SpareWeb>> = const { RefCell::new(None) };
    /// A spare is being made: at most one at a time.
    static WEB_SPARE_SCHEDULED: Cell<bool> = const { Cell::new(false) };
}

/// A `WKWebView` made ahead ([`make_spare_web`]): its configuration has the
/// shared process pool and the default website data store, and no URL
/// scheme handlers or message handler; nothing is loaded in it.
struct SpareWeb {
    config: Retained<AnyObject>,
    web: Retained<AnyObject>,
}

/// Warms WebKit's process-wide state once per process, at idle moments
/// after `surface`'s app started, when the app may show web views: its
/// capabilities declare `webview`. An app without that grant (or one
/// whose policy restricts nothing, a Rust app's, which says nothing about
/// web views) never loads WebKit for it.
pub(crate) fn warm_web_later(surface: &Surface) {
    thread_local! {
        static SCHEDULED: Cell<bool> = const { Cell::new(false) };
    }
    let access = surface.native.access();
    if access.is_unrestricted() || !access.allows_webviews() || SCHEDULED.replace(true) {
        return;
    }
    WEB_WARM.set((surface.key(), 0));
    WEB_SPARE_SCHEDULED.set(true);
    crate::surface::when_idle(surface, warm_web);
}

/// What the first web view of a process would otherwise set up in its
/// frames, one step per idle moment (each a few milliseconds): WebKit
/// loaded and its classes initialized, the default website data store, a
/// process pool, the configuration's other parts, then a spare `WKWebView`
/// ([`make_spare_web`]). None of it starts a web content or networking
/// process: those launch with a web view's first load.
fn warm_web() {
    let (key, step) = WEB_WARM.get();
    if !webkit() {
        WEB_SPARE_SCHEDULED.set(false);
        return;
    }
    // SAFETY: WebKit's documented API, sent dynamically.
    let more = unsafe {
        (|| {
            match step {
                // Initializes the class (`+initialize`) without making a
                // view.
                0 => {
                    let _: Bool = msg_send![
                        class(c"WKWebView")?,
                        handlesURLScheme: &*NSString::from_str("https")
                    ];
                }
                1 => {
                    let store: Option<Retained<AnyObject>> =
                        msg_send![class(c"WKWebsiteDataStore")?, defaultDataStore];
                    store?;
                }
                2 => {
                    let config: Retained<AnyObject> =
                        msg_send![class(c"WKWebViewConfiguration")?, new];
                    let pool: Option<Retained<AnyObject>> = msg_send![&config, processPool];
                    WEB_POOL.with(|p| *p.borrow_mut() = pool);
                }
                3 => {
                    let config: Retained<AnyObject> =
                        msg_send![class(c"WKWebViewConfiguration")?, new];
                    let _: Option<Retained<AnyObject>> = msg_send![&config, websiteDataStore];
                    let _: Option<Retained<AnyObject>> = msg_send![&config, userContentController];
                    let _: Option<Retained<AnyObject>> =
                        msg_send![&config, defaultWebpagePreferences];
                }
                _ => {
                    WEB_SPARE_SCHEDULED.set(false);
                    make_spare_web();
                    return None;
                }
            }
            Some(())
        })()
    };
    if more.is_some() {
        WEB_WARM.set((key, step + 1));
        crate::surface::when_idle_key(key, warm_web);
    } else {
        WEB_SPARE_SCHEDULED.set(false);
    }
}

/// Makes the next spare `WKWebView` at an idle moment of the surface of
/// `key`, after one was taken, unless one is there or on its way.
fn spare_web_later(key: u64) {
    if WEB_SPARE_SCHEDULED.replace(true) {
        return;
    }
    crate::surface::when_idle_key(key, || {
        WEB_SPARE_SCHEDULED.set(false);
        make_spare_web();
    });
}

/// Makes a spare `WKWebView` ([`SpareWeb`]) unless there is one.
fn make_spare_web() {
    if WEB_SPARE.with(|s| s.borrow().is_some()) || !webkit() {
        return;
    }
    // SAFETY: WebKit's documented API, sent dynamically.
    let spare = unsafe {
        (|| {
            let config: Retained<AnyObject> = msg_send![class(c"WKWebViewConfiguration")?, new];
            if let Some(pool) = WEB_POOL.with(|p| p.borrow().clone()) {
                let _: () = msg_send![&config, setProcessPool: &*pool];
            }
            let alloc: Allocated<AnyObject> = msg_send![class(c"WKWebView")?, alloc];
            let web: Retained<AnyObject> =
                msg_send![alloc, initWithFrame: NSRect::ZERO, configuration: &*config];
            let no: Retained<AnyObject> = msg_send![class(c"NSNumber")?, numberWithBool: false];
            let _: () =
                msg_send![&web, setValue: &*no, forKey: &*NSString::from_str("drawsBackground")];
            Some(SpareWeb { config, web })
        })()
    };
    WEB_SPARE.with(|s| *s.borrow_mut() = spare);
}

/// The frame of `view` changed: its controls fill it again. Called by
/// [`NshView::place`] before it places its hosted views.
pub(crate) fn resized(view: &NshView) {
    let mut s = view.state_mut();
    if !matches!(
        s.kind,
        // An input's one hosted view is its pad (`crate::text_input`).
        ViewKind::Video | ViewKind::WebView | ViewKind::Native | ViewKind::Input
    ) {
        return;
    }
    let rect = bounds(s.frame.size.width.0, s.frame.size.height.0);
    for native in &mut s.natives {
        native.rect = rect;
    }
}

/// `NativeProps`.
pub(crate) fn props(surface: &Rc<Surface>, view: &NshView, props: &NativeProps) {
    if let Some(waiting) = surface.native.waiting.borrow_mut().get_mut(&view.id()) {
        waiting.sent.push(Sent::Props(props.clone()));
        return;
    }
    apply_props(surface, view, props);
}

/// Applies `props` to the control of `view`.
fn apply_props(surface: &Rc<Surface>, view: &NshView, props: &NativeProps) {
    let mut hosts = surface.native.hosts.borrow_mut();
    match (hosts.get_mut(&view.id()), props) {
        (Some(Host::Video(video)), NativeProps::Video(p)) => {
            let base = surface.native.asset_base.borrow();
            video.set(p, base.as_ref());
        }
        (Some(Host::Web(web)), NativeProps::WebView(p)) => web.set(p),
        _ => log::debug!("native: props for a view of another kind"),
    }
}

/// `Component`.
pub(crate) fn component(surface: &Rc<Surface>, view: &NshView, name: &Arc<str>) {
    let factory = surface.native.components.borrow().factory(name);
    let Some(factory) = factory else { return };
    let mut control = None;
    surface.control(|c| control = Some(c.clone()));
    let Some(control) = control else { return };
    let made = factory(ComponentContext {
        id: view.id(),
        control,
    });
    fill(view, &made.view());
    surface
        .native
        .hosts
        .borrow_mut()
        .insert(view.id(), Host::Component(Some(made)));
}

/// `ComponentProps`.
pub(crate) fn component_props(
    surface: &Rc<Surface>,
    view: &NshView,
    props: &[(Arc<str>, Option<JsonValue>)],
) {
    // Taken out while the app's code runs, so it may reach the surface.
    let Some(mut component) = take_component(surface, view.id()) else {
        return;
    };
    for (name, value) in props {
        component.set_prop(name, value.as_ref());
    }
    put_component(surface, view.id(), component);
}

/// A command for a web view, video or component.
pub(crate) fn command(surface: &Rc<Surface>, view: &NshView, command: &Command) {
    if let Some(waiting) = surface.native.waiting.borrow_mut().get_mut(&view.id()) {
        waiting.sent.push(Sent::Command(command.clone()));
        return;
    }
    apply_command(surface, view, command);
}

/// Carries out `command` on the control of `view`.
fn apply_command(surface: &Rc<Surface>, view: &NshView, command: &Command) {
    match command {
        Command::Seek(seconds) => {
            if let Some(Host::Video(video)) = surface.native.hosts.borrow().get(&view.id()) {
                video.seek(*seconds);
            }
        }
        Command::Native { name, args } => {
            if let Some(mut component) = take_component(surface, view.id()) {
                component.command(name, args);
                put_component(surface, view.id(), component);
            }
        }
        Command::SendInput(input) => {
            let web = match surface.native.hosts.borrow().get(&view.id()) {
                Some(Host::Web(web)) => web.web.clone(),
                _ => None,
            };
            if let Some(web) = web {
                web_input(&web, input);
            }
        }
        Command::Evaluate { .. } | Command::CancelEvaluate { .. } => {
            let found = match surface.native.hosts.borrow().get(&view.id()) {
                Some(Host::Web(web)) => Some((
                    web.handler.ivars().evaluations.clone(),
                    web.props.as_ref().is_none_or(|p| p.javascript_enabled),
                )),
                _ => None,
            };
            let Some((evaluations, scripts)) = found else {
                return;
            };
            match command {
                Command::Evaluate { request, script } => {
                    evaluations.start(*request, script, scripts)
                }
                Command::CancelEvaluate { request } => evaluations.cancel(*request),
                _ => {}
            }
        }
        Command::WebViewRequest(request) => {
            // The target is taken before anything may reenter the hosts
            // (accepting a download resumes WebKit, which calls the
            // delegate back).
            let target = match surface.native.hosts.borrow().get(&view.id()) {
                Some(Host::Web(host)) => Some((host.web.clone(), host.handler.clone())),
                _ => None,
            };
            match target {
                Some((Some(web), handler)) => {
                    web_request(surface, view.id(), &web, &handler, request);
                }
                Some((None, _)) => reply(
                    surface,
                    view.id(),
                    request.id,
                    Err("the web view is not available: WebKit could not be loaded".into()),
                ),
                None => reply(
                    surface,
                    view.id(),
                    request.id,
                    Err("this view is not a web view".into()),
                ),
            }
        }
        _ => {
            // WebKit may call the handler back synchronously (`stopLoading`
            // fails the navigation): the hosts are not borrowed meanwhile.
            let found = match surface.native.hosts.borrow().get(&view.id()) {
                Some(Host::Web(web)) => web
                    .web
                    .clone()
                    .map(|w| (w, web.handler.ivars().evaluations.clone())),
                _ => None,
            };
            if let Some((web, evaluations)) = found {
                if matches!(
                    command,
                    Command::Reload | Command::GoBack | Command::GoForward | Command::Load(_)
                ) {
                    evaluations.navigated();
                }
                web_command(&web, command);
            }
        }
    }
}

/// Whether `native` is a web view whose page does not scroll
/// (`scrollable={false}`): wheel and trackpad scrolls over it go to
/// the root, which scrolls the app's scroll views around it.
pub(crate) fn passes_wheel(surface: &Surface, native: &NSView) -> bool {
    let Ok(hosts) = surface.native.hosts.try_borrow() else {
        return false;
    };
    hosts.values().any(|host| match host {
        Host::Web(web) => !web.scrolls && web.is(native),
        _ => false,
    })
}

/// Whether the keyboard focus is in one of the surface's web views (the
/// page has it).
pub(crate) fn web_focused(surface: &Surface) -> bool {
    let Some(responder) = crate::input::event_root(surface)
        .ns()
        .window()
        .and_then(|w| w.firstResponder())
    else {
        return false;
    };
    let Some(focused) = responder.downcast_ref::<NSView>() else {
        return false;
    };
    let Ok(hosts) = surface.native.hosts.try_borrow() else {
        return false;
    };
    hosts.values().any(|host| match host {
        Host::Web(WebHost { web: Some(web), .. }) => {
            // SAFETY: a WKWebView is an NSView.
            focused.isDescendantOf(unsafe { as_view(web) })
        }
        _ => false,
    })
}

define_class!(
    /// Holds a web view or video lent to the image of a screen or modal
    /// that leaves ([`lend`]), clipped where its ancestors clipped it.
    /// The pointer passes through (the image takes no events).
    #[unsafe(super(NSView, objc2_app_kit::NSResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "NshLentClip"]
    struct LentClip;

    unsafe impl NSObjectProtocol for LentClip {}

    impl LentClip {
        #[unsafe(method(isFlipped))]
        fn is_flipped(&self) -> bool {
            true
        }

        #[unsafe(method_id(hitTest:))]
        fn hit_test(&self, _point: NSPoint) -> Option<Retained<NSView>> {
            None
        }
    }
);

/// A live web view or video lent to the image of a screen or modal that
/// leaves: `renderInContext:` cannot draw what other processes draw
/// (WebKit's, the media server), so the image shows the view itself
/// where it was. Dropping it (the image is gone) gives the view back to
/// its node's view if that still hosts it (the app kept the node), else
/// lets it go.
pub(crate) struct Lent {
    surface: Weak<Surface>,
    holder: NshView,
    shown: Retained<NSView>,
    clip: Retained<LentClip>,
}

impl Drop for Lent {
    fn drop(&mut self) {
        let id = self.holder.id();
        let back = self.surface.upgrade().is_some_and(|surface| {
            surface
                .native
                .hosts
                .try_borrow()
                .is_ok_and(|hosts| hosts.get(&id).is_some_and(|host| host.hosts(&self.shown)))
        });
        crate::surface::quiet(|| {
            if back {
                fill(&self.holder, &self.shown);
            } else {
                self.shown.removeFromSuperview();
            }
            self.clip.removeFromSuperview();
        });
    }
}

/// Moves the web views and videos inside `top` (a screen or modal that
/// leaves as an image of its layers) onto `image` (a view at `top`'s
/// place and size, showing that image), each where it showed and clipped
/// as it was (to a rectangle, rounded only by the corners of the one view
/// that clips it), so they keep showing their page or frame while the
/// image leaves. The keyboard focus does not go with them.
pub(crate) fn lend(surface: &Rc<Surface>, top: &NshView, image: &NSView) -> Vec<Lent> {
    let found: Vec<(NshView, Retained<NSView>)> = {
        let Ok(hosts) = surface.native.hosts.try_borrow() else {
            return Vec::new();
        };
        hosts
            .values()
            .filter_map(Host::drawn_elsewhere)
            .filter(|(_, shown)| shown.isDescendantOf(top.ns()))
            .collect()
    };
    let mut lent = Vec::new();
    for (holder, shown) in found {
        // `place_in` converts with AppKit's geometry, which the bounds place.
        crate::scroll::commit_ancestors(&holder);
        let Some(place) = place_in(&shown, top.ns()) else {
            continue;
        };
        if let Some(window) = shown.window() {
            let focused = window.firstResponder().is_some_and(|r| {
                r.downcast_ref::<NSView>()
                    .is_some_and(|v| v.isDescendantOf(&shown))
            });
            if focused {
                window.makeFirstResponder(Some(crate::input::root_in(surface, &window).ns()));
            }
        }
        // SAFETY: NSView's designated initializer.
        let clip: Retained<LentClip> =
            unsafe { msg_send![LentClip::alloc(surface.mtm), initWithFrame: place.clip] };
        crate::surface::quiet(|| {
            clip.setWantsLayer(true);
            if let Some(layer) = clip.layer() {
                layer.setMasksToBounds(true);
                if let Some(corners) = &place.corners {
                    layer.setCornerRadius(corners.cornerRadius());
                    layer.setMaskedCorners(corners.maskedCorners());
                    layer.setCornerCurve(&corners.cornerCurve());
                }
            }
            image.addSubview(&clip);
            holder
                .state_mut()
                .natives
                .retain(|n| !std::ptr::eq(&*n.view, &*shown));
            clip.addSubview(&shown);
            let (f, c) = (place.frame, place.clip);
            shown.setFrame(NSRect::new(
                NSPoint::new(f.origin.x - c.origin.x, f.origin.y - c.origin.y),
                f.size,
            ));
        });
        lent.push(Lent {
            surface: Rc::downgrade(surface),
            holder,
            shown,
            clip,
        });
    }
    lent
}

/// Where a lent view goes, in its leaving view's coordinates.
struct Place {
    /// The lent view's frame.
    frame: NSRect,
    /// What its ancestors let show of it.
    clip: NSRect,
    /// The layer whose rounded corners clipped it, when that layer alone
    /// made the clip.
    corners: Option<Retained<objc2_quartz_core::CALayer>>,
}

/// Where `shown` shows inside `top`; `None` when it does not (hidden, or
/// clipped away).
fn place_in(shown: &NSView, top: &NSView) -> Option<Place> {
    let frame = shown.convertRect_toView(shown.bounds(), Some(top));
    let mut clip = top.bounds();
    let mut innermost: Option<(NSRect, Retained<objc2_quartz_core::CALayer>)> = None;
    let mut at: Retained<NSView> = Retained::from(shown);
    while !std::ptr::eq(&*at, top) {
        if at.isHidden() || at.layer().is_some_and(|l| l.isHidden()) {
            return None;
        }
        at = crate::view::superview(&at)?;
        let Some(layer) = at.layer() else { continue };
        if layer.masksToBounds() || layer.mask().is_some() {
            let r = at.convertRect_toView(at.bounds(), Some(top));
            clip = intersect(clip, r)?;
            if innermost.is_none() {
                innermost = Some((r, layer));
            }
        }
    }
    let clip = intersect(clip, frame)?;
    // Corners belong to the clip only when its layer's bounds are the
    // whole clip; a mask (differing radii) is not copied.
    let corners = innermost
        .filter(|(r, layer)| layer.mask().is_none() && same_rect(*r, clip))
        .map(|(_, layer)| layer);
    Some(Place {
        frame,
        clip,
        corners,
    })
}

/// The intersection of two rectangles; `None` when it is empty.
fn intersect(a: NSRect, b: NSRect) -> Option<NSRect> {
    let x0 = a.origin.x.max(b.origin.x);
    let y0 = a.origin.y.max(b.origin.y);
    let x1 = (a.origin.x + a.size.width).min(b.origin.x + b.size.width);
    let y1 = (a.origin.y + a.size.height).min(b.origin.y + b.size.height);
    (x1 > x0 && y1 > y0).then(|| NSRect::new(NSPoint::new(x0, y0), CGSize::new(x1 - x0, y1 - y0)))
}

fn same_rect(a: NSRect, b: NSRect) -> bool {
    (a.origin.x - b.origin.x).abs() < 0.5
        && (a.origin.y - b.origin.y).abs() < 0.5
        && (a.size.width - b.size.width).abs() < 0.5
        && (a.size.height - b.size.height).abs() < 0.5
}

/// Whether view `id` holds a made component (its animated props wait until
/// it does).
pub(crate) fn has_component(surface: &Surface, id: NodeId) -> bool {
    matches!(
        surface.native.hosts.borrow().get(&id),
        Some(Host::Component(Some(_)))
    )
}

/// Bound props that moved (`Animator::write_components`): handed to their
/// components.
pub(crate) fn component_animated(
    surface: &Surface,
    moved: Vec<(NodeId, Arc<str>, nsh_core::animation::AnimatedPropValue)>,
) {
    use nsh_core::animation::AnimatedPropValue;
    for (id, name, value) in moved {
        // Taken out while the app's code runs, so it may reach the surface.
        let Some(mut component) = take_component(surface, id) else {
            continue;
        };
        match value {
            AnimatedPropValue::Number(n) => component.set_animated_number(&name, n),
            AnimatedPropValue::Color(argb) => component.set_animated_color(&name, argb),
            _ => {}
        }
        put_component(surface, id, component);
    }
}

fn take_component(surface: &Surface, id: NodeId) -> Option<Box<dyn NativeComponent>> {
    match surface.native.hosts.borrow_mut().get_mut(&id) {
        Some(Host::Component(component)) => component.take(),
        _ => None,
    }
}

fn put_component(surface: &Surface, id: NodeId, component: Box<dyn NativeComponent>) {
    // The view may have been deleted meanwhile: then the component drops.
    if let Some(Host::Component(slot)) = surface.native.hosts.borrow_mut().get_mut(&id) {
        *slot = Some(component);
    }
}

/// Hosts `native` in `view`, filling it ([`resized`] keeps it so).
fn fill(view: &NshView, native: &NSView) {
    let frame = view.state().frame;
    view.set_native(native, bounds(frame.size.width.0, frame.size.height.0));
}

fn bounds(width: f32, height: f32) -> Bounds<Points> {
    Bounds {
        origin: Point {
            x: Points(0.0),
            y: Points(0.0),
        },
        size: Size {
            width: Points(width),
            height: Points(height),
        },
    }
}

fn load(framework: &CStr) -> bool {
    // SAFETY: loads a system framework; the handle is never closed.
    let loaded = !unsafe { libc::dlopen(framework.as_ptr(), libc::RTLD_LAZY) }.is_null();
    if !loaded {
        log::error!("cannot load {}", framework.to_string_lossy());
    }
    loaded
}

/// A system framework loaded on first use (`dlopen`), so apps that never
/// show what it draws do not pay for it. Loaded on the main thread, in a
/// frame of its own ([`start_later`]): a `dlopen` of WebKit on a
/// background queue was seen never to return (under `nsh test --target
/// macos`; why is not known), and AVFoundation's waited behind it, so
/// nothing here loads off the main thread. Process-wide, as a loaded
/// image is.
struct Framework {
    path: &'static CStr,
    loaded: OnceLock<bool>,
}

impl Framework {
    const fn new(path: &'static CStr) -> Self {
        Framework {
            path,
            loaded: OnceLock::new(),
        }
    }

    /// Whether it was loaded (or failed to load) already.
    fn tried(&self) -> bool {
        self.loaded.get().is_some()
    }

    /// Whether it is loaded, loading it first if it is not.
    fn get(&self) -> bool {
        *self.loaded.get_or_init(|| load(self.path))
    }
}

static AV_FOUNDATION: Framework =
    Framework::new(c"/System/Library/Frameworks/AVFoundation.framework/AVFoundation");
static AV_KIT: Framework = Framework::new(c"/System/Library/Frameworks/AVKit.framework/AVKit");
static WEBKIT: Framework = Framework::new(c"/System/Library/Frameworks/WebKit.framework/WebKit");

fn av_foundation() -> bool {
    AV_FOUNDATION.get()
}

fn av_kit() -> bool {
    AV_KIT.get()
}

fn webkit() -> bool {
    WEBKIT.get()
}

fn class(name: &CStr) -> Option<&'static AnyClass> {
    AnyClass::get(name)
}

/// `object` as the AppKit view it is.
///
/// # Safety
///
/// `object` must be an `NSView`.
unsafe fn as_view(object: &AnyObject) -> &NSView {
    // SAFETY: the caller's guarantee.
    unsafe { &*(object as *const AnyObject as *const NSView) }
}

/// Sends a control's events to JS, when JS listens to them.
#[derive(Clone)]
struct Emitter {
    surface: Weak<Surface>,
    view: objc2::rc::Weak<ViewObj>,
    id: NodeId,
}

impl Emitter {
    fn new(surface: &Rc<Surface>, view: &NshView) -> Self {
        Emitter {
            surface: Rc::downgrade(surface),
            view: objc2::rc::Weak::new(&**view),
            id: view.id(),
        }
    }

    /// Whether the view has a listener for `kind`.
    fn listens(&self, kind: EventKind) -> bool {
        self.view
            .load()
            .and_then(|v| NshView::from_ns(&v))
            .is_some_and(|v| v.state().events.contains(kind))
    }

    fn emit(&self, kind: EventKind, payload: impl FnOnce() -> EventPayload) {
        if !self.listens(kind) {
            return;
        }
        if let Some(surface) = self.surface.upgrade() {
            surface.event(self.id, kind, payload());
        }
    }
}

fn error(message: String) -> EventPayload {
    EventPayload::Map(vec![("message", PayloadValue::Str(message))])
}

/// Where a video's source is.
#[derive(Debug, PartialEq)]
enum Location {
    /// A URL AVFoundation opens (`https://`, `file://`, ...).
    Uri(String),
    /// A file path.
    Path(std::path::PathBuf),
}

/// Resolves `source` (`asset:/` URIs against `base`).
fn locate(source: &str, base: Option<&AssetBase>) -> Option<Location> {
    if let Some(path) = source.strip_prefix("asset:/") {
        let path = path.trim_start_matches('/');
        return match base {
            Some(dirs @ (AssetBase::Directory(_) | AssetBase::Directories(_))) => {
                dirs.file(path).map(Location::Path)
            }
            Some(AssetBase::Http(url)) => Some(Location::Uri(format!(
                "{}/{path}",
                url.trim_end_matches('/')
            ))),
            None => None,
        };
    }
    if source.contains("://") {
        Some(Location::Uri(source.to_owned()))
    } else if source.is_empty() {
        None
    } else {
        Some(Location::Path(source.into()))
    }
}

/// CoreMedia's `CMTime`.
#[repr(C)]
#[derive(Clone, Copy, Debug)]
struct CMTime {
    value: i64,
    timescale: i32,
    flags: u32,
    epoch: i64,
}

// SAFETY: the layout and encoding of CoreMedia's `CMTime` (`{?=qiIq}`).
unsafe impl Encode for CMTime {
    const ENCODING: Encoding = Encoding::Struct(
        "?",
        &[i64::ENCODING, i32::ENCODING, u32::ENCODING, i64::ENCODING],
    );
}

impl CMTime {
    fn from_seconds(seconds: f64) -> Self {
        Self {
            value: (seconds * 600.0).round() as i64,
            timescale: 600,
            flags: 1,
            epoch: 0,
        }
    }

    /// Seconds, or NaN when invalid or indefinite (live streams).
    fn seconds(&self) -> f64 {
        if self.flags & 1 == 0 || self.flags & 0x10 != 0 || self.timescale == 0 {
            f64::NAN
        } else {
            self.value as f64 / self.timescale as f64
        }
    }
}

define_class!(
    /// Shows a video's `AVPlayerLayer` (its layer) and lets the pointer
    /// through to the node's view.
    #[unsafe(super(NSView, objc2_app_kit::NSResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "NshVideoLayerView"]
    struct VideoLayerView;

    unsafe impl NSObjectProtocol for VideoLayerView {}

    impl VideoLayerView {
        #[unsafe(method_id(hitTest:))]
        fn hit_test(&self, _point: NSPoint) -> Option<Retained<NSView>> {
            None
        }
    }
);

/// What a video reported so far.
#[derive(Default)]
struct Status {
    loaded: Cell<bool>,
    failed: Cell<bool>,
    buffering: Cell<bool>,
}

/// A video: its player and the view showing it.
struct VideoHost {
    emitter: Emitter,
    view: NshView,
    player: Option<Retained<AnyObject>>,
    /// The view showing the player: a [`VideoLayerView`] or an
    /// `AVPlayerView`.
    shown: Option<Retained<NSView>>,
    /// The `AVPlayerLayer` (without controls).
    layer: Option<Retained<AnyObject>>,
    time_observer: Option<Retained<AnyObject>>,
    end_observer: Option<Retained<ProtocolObject<dyn NSObjectProtocol>>>,
    status: Rc<Status>,
    /// The props applied (`None` before the first).
    props: Option<VideoProps>,
    repeat: Rc<Cell<bool>>,
    /// The item played to its end (and does not loop).
    ended: Rc<Cell<bool>>,
    /// The source a player was opened with ahead of the first props
    /// ([`Self::prepare`]).
    prepared: Option<Option<Arc<str>>>,
}

impl VideoHost {
    fn new(surface: &Rc<Surface>, view: &NshView) -> Self {
        VideoHost {
            emitter: Emitter::new(surface, view),
            view: view.clone(),
            player: None,
            shown: None,
            layer: None,
            time_observer: None,
            end_observer: None,
            status: Rc::default(),
            props: None,
            repeat: Rc::default(),
            ended: Rc::default(),
            prepared: None,
        }
    }

    /// Opens the player for `p`'s source ahead of its first props (in a
    /// frame of its own: [`video_step`]); they show it.
    fn prepare(&mut self, p: &VideoProps, base: Option<&AssetBase>) {
        self.open(p.source.as_deref(), base);
        self.prepared = Some(p.source.clone());
    }

    fn set(&mut self, p: &VideoProps, base: Option<&AssetBase>) {
        if !av_foundation() {
            return;
        }
        let old = self.props.take();
        let first = old.is_none();
        let old = old.unwrap_or_default();
        let reopened = if first {
            // Opened ahead with this source: kept.
            self.prepared.take().is_none_or(|source| source != p.source)
        } else {
            p.source != old.source
        };
        if reopened {
            self.open(p.source.as_deref(), base);
        }
        if first || reopened || p.controls != old.controls {
            self.show(p.controls);
        }
        if first || reopened || p.progress_interval_ms != old.progress_interval_ms {
            self.observe(p.progress_interval_ms);
        }
        self.repeat.set(p.repeat);
        if let Some(player) = &self.player {
            // Played from the end, a video starts over: a seek the app
            // makes in the same turn arrives after these props.
            if !p.paused && old.paused && self.ended.replace(false) {
                seek_exactly(player, 0.0);
            }
            // SAFETY: AVPlayer's documented API.
            unsafe {
                let _: () = msg_send![player, setMuted: Bool::new(p.muted)];
                let _: () = msg_send![player, setVolume: p.volume.clamp(0.0, 1.0)];
                // The system controls' play button and the `repeat` loop
                // play at the default rate (macOS 13 and iOS 16 on).
                let default_rate: Bool =
                    msg_send![player, respondsToSelector: objc2::sel!(setDefaultRate:)];
                if default_rate.as_bool() {
                    let _: () = msg_send![player, setDefaultRate: p.rate];
                }
                // `paused` is acted on when it changes (or for a new
                // source): a video the system controls paused would play
                // on whenever another prop (the volume, say) changed. A
                // new rate applies to a video that plays.
                let toggled = first || reopened || p.paused != old.paused;
                let rate: f32 = msg_send![player, rate];
                if p.paused {
                    if toggled {
                        let _: () = msg_send![player, pause];
                    }
                } else if toggled || p.rate != old.rate && rate != 0.0 {
                    let _: () = msg_send![player, setRate: p.rate];
                }
            }
        }
        let gravity = NSString::from_str(match p.resize_mode {
            ResizeMode::Cover => "AVLayerVideoGravityResizeAspectFill",
            ResizeMode::Stretch => "AVLayerVideoGravityResize",
            _ => "AVLayerVideoGravityResizeAspect",
        });
        // SAFETY: AVPlayerLayer's / AVPlayerView's `videoGravity` setters.
        unsafe {
            if let Some(layer) = &self.layer {
                let _: () = msg_send![layer, setVideoGravity: &*gravity];
            } else if let Some(shown) = &self.shown {
                let _: () = msg_send![shown, setVideoGravity: &*gravity];
            }
        }
        self.props = Some(p.clone());
    }

    /// Opens `source` (or nothing).
    fn open(&mut self, source: Option<&str>, base: Option<&AssetBase>) {
        self.close();
        self.status = Rc::default();
        self.ended.set(false);
        let Some(source) = source else { return };
        let url = match locate(source, base) {
            Some(Location::Uri(uri)) => NSURL::URLWithString(&NSString::from_str(&uri)),
            Some(Location::Path(path)) => Some(NSURL::fileURLWithPath(&NSString::from_str(
                &path.to_string_lossy(),
            ))),
            None => None,
        };
        let (Some(url), Some(cls)) = (url, class(c"AVPlayer")) else {
            self.status.failed.set(true);
            let message = format!("{source}: cannot resolve the video's location");
            self.emitter.emit(EventKind::Error, || error(message));
            return;
        };
        // What `playerWithURL:` makes, step by step.
        // SAFETY: AVFoundation's documented API.
        let player: Option<Retained<AnyObject>> = unsafe {
            (|| {
                let asset: Retained<AnyObject> = msg_send![
                    class(c"AVURLAsset")?,
                    URLAssetWithURL: &*url,
                    options: std::ptr::null::<AnyObject>()
                ];
                let item: Retained<AnyObject> =
                    msg_send![class(c"AVPlayerItem")?, playerItemWithAsset: &*asset];
                let player: Retained<AnyObject> = msg_send![cls, playerWithPlayerItem: &*item];
                Some(player)
            })()
        };
        let Some(player) = player else {
            self.status.failed.set(true);
            let message = format!("{source}: AVFoundation could not open it");
            self.emitter.emit(EventKind::Error, || error(message));
            return;
        };
        self.emitter
            .emit(EventKind::LoadStart, || EventPayload::None);
        // The end of the item: report it, and loop if asked.
        // SAFETY: AVPlayer's documented API.
        let item: Option<Retained<AnyObject>> = unsafe { msg_send![&player, currentItem] };
        let (emitter, repeat, ended) = (
            self.emitter.clone(),
            self.repeat.clone(),
            self.ended.clone(),
        );
        let weak_player = objc2::rc::Weak::from_retained(&player);
        let block = RcBlock::new(move |_: NonNull<NSNotification>| {
            emitter.emit(EventKind::End, || EventPayload::None);
            ended.set(!repeat.get());
            if repeat.get()
                && let Some(player) = weak_player.load()
            {
                // SAFETY: AVPlayer's documented API.
                unsafe {
                    let _: () = msg_send![&player, seekToTime: CMTime::from_seconds(0.0)];
                    let _: () = msg_send![&player, play];
                }
            }
        });
        // SAFETY: a documented notification, delivered on the main queue;
        // the observer is removed in `close`.
        self.end_observer = Some(unsafe {
            NSNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(
                Some(&NSString::from_str(
                    "AVPlayerItemDidPlayToEndTimeNotification",
                )),
                item.as_deref(),
                Some(&NSOperationQueue::mainQueue()),
                &block,
            )
        });
        poll_load(&player, self.emitter.clone(), &self.status);
        self.player = Some(player);
    }

    /// Stops the player and stops observing it.
    fn close(&mut self) {
        if let (Some(player), Some(token)) = (&self.player, self.time_observer.take()) {
            // SAFETY: removes the observer this host added.
            let _: () = unsafe { msg_send![player, removeTimeObserver: &*token] };
        }
        if let Some(observer) = self.end_observer.take() {
            // SAFETY: an observer token of the default center.
            unsafe { NSNotificationCenter::defaultCenter().removeObserver(observer.as_ref()) };
        }
        if let Some(player) = self.player.take() {
            // SAFETY: AVPlayer's documented API.
            let _: () = unsafe { msg_send![&player, pause] };
        }
    }

    /// Shows the player in a layer, or with the system's controls.
    fn show(&mut self, controls: bool) {
        if let Some(old) = self.shown.take() {
            self.view.remove_native(&old);
        }
        self.layer = None;
        let Some(player) = &self.player else { return };
        let mtm = MainThreadMarker::new().expect("main thread");
        // SAFETY: AVFoundation / AVKit's documented API, sent dynamically;
        // `AVPlayerView` is an `NSView`.
        let shown = unsafe {
            if controls
                && av_kit()
                && let Some(cls) = class(c"AVPlayerView")
            {
                let alloc: Allocated<AnyObject> = msg_send![cls, alloc];
                let view: Retained<AnyObject> = msg_send![alloc, initWithFrame: NSRect::ZERO];
                let _: () = msg_send![&view, setPlayer: &**player];
                // AVPlayerViewControlsStyleInline.
                let _: () = msg_send![&view, setControlsStyle: 1isize];
                Retained::from(as_view(&view))
            } else if let Some(cls) = class(c"AVPlayerLayer") {
                let layer: Retained<AnyObject> = msg_send![cls, playerLayerWithPlayer: &**player];
                let view: Retained<VideoLayerView> =
                    msg_send![VideoLayerView::alloc(mtm), initWithFrame: NSRect::ZERO];
                // A layer-hosting view: the player layer is its layer, so
                // it follows the view's size.
                let ca: &objc2_quartz_core::CALayer = &*(Retained::as_ptr(&layer) as *const _);
                view.setLayer(Some(ca));
                view.setWantsLayer(true);
                self.layer = Some(layer);
                Retained::into_super(view)
            } else {
                return;
            }
        };
        crate::surface::quiet(|| fill(&self.view, &shown));
        self.shown = Some(shown);
    }

    /// Reports `onProgress` every `interval_ms` while time passes, and the
    /// load, buffering and failure as they happen.
    fn observe(&mut self, interval_ms: f32) {
        let Some(player) = &self.player else { return };
        if let Some(token) = self.time_observer.take() {
            // SAFETY: removes the observer this host added.
            let _: () = unsafe { msg_send![player, removeTimeObserver: &*token] };
        }
        let (emitter, status) = (self.emitter.clone(), self.status.clone());
        let weak = objc2::rc::Weak::from_retained(player);
        let block = RcBlock::new(move |time: CMTime| {
            let Some(player) = weak.load() else { return };
            report(&player, &emitter, &status);
            let duration = item_duration(&player);
            emitter.emit(EventKind::Progress, || {
                EventPayload::Map(vec![
                    ("currentTime", PayloadValue::Number(time.seconds().max(0.0))),
                    ("duration", PayloadValue::Number(duration)),
                ])
            });
        });
        let interval = CMTime::from_seconds(interval_ms.max(16.0) as f64 / 1000.0);
        // SAFETY: AVPlayer's documented API; a nil queue is the main queue.
        self.time_observer = Some(unsafe {
            msg_send![
                player,
                addPeriodicTimeObserverForInterval: interval,
                queue: std::ptr::null::<AnyObject>(),
                usingBlock: &*block
            ]
        });
    }

    fn seek(&self, seconds: f64) {
        let Some(player) = &self.player else { return };
        seek_exactly(player, seconds);
        // The player stopped itself at the end; a video the app has not
        // paused plays on from where it was sought.
        if self.ended.replace(false)
            && let Some(props) = &self.props
            && !props.paused
        {
            // SAFETY: AVPlayer's documented API.
            let _: () = unsafe { msg_send![player, setRate: props.rate] };
        }
    }
}

/// Seeks `player` to `seconds`, to the frame.
fn seek_exactly(player: &AnyObject, seconds: f64) {
    let zero = CMTime::from_seconds(0.0);
    // SAFETY: AVPlayer's documented API.
    let _: () = unsafe {
        msg_send![
            player,
            seekToTime: CMTime::from_seconds(seconds.max(0.0)),
            toleranceBefore: zero,
            toleranceAfter: zero
        ]
    };
}

impl Drop for VideoHost {
    fn drop(&mut self) {
        // The view keeps showing the last frame while a removal animation
        // may still show it.
        self.close();
    }
}

/// Checks the player every 100ms until it loaded or failed (for at most 30
/// seconds): a paused player reports no time to the periodic observer.
/// Timed on the main queue rather than the display link, which stops while
/// the window is hidden.
fn poll_load(player: &Retained<AnyObject>, emitter: Emitter, status: &Rc<Status>) {
    poll(
        objc2::rc::Weak::from_retained(player),
        emitter,
        Rc::downgrade(status),
        0,
    );
}

fn poll(player: objc2::rc::Weak<AnyObject>, emitter: Emitter, status: Weak<Status>, attempt: u32) {
    let (Some(p), Some(s)) = (player.load(), status.upgrade()) else {
        return;
    };
    report(&p, &emitter, &s);
    if s.loaded.get() || s.failed.get() || attempt >= 300 {
        return;
    }
    let mtm = MainThreadMarker::new().expect("main thread");
    let state = dispatch2::MainThreadBound::new((player, emitter, status), mtm);
    let when = dispatch2::DispatchTime::NOW.time(100_000_000);
    let _ = dispatch2::DispatchQueue::main().after(when, move || {
        let mtm = MainThreadMarker::new().expect("main queue");
        let (player, emitter, status) = state.into_inner(mtm);
        poll(player, emitter, status, attempt + 1);
    });
}

fn item_duration(player: &AnyObject) -> f64 {
    // SAFETY: AVPlayer / AVPlayerItem getters.
    unsafe {
        let item: Option<Retained<AnyObject>> = msg_send![player, currentItem];
        item.map_or(f64::NAN, |item| {
            let duration: CMTime = msg_send![&item, duration];
            duration.seconds()
        })
    }
}

/// Reports a finished load (once), a failure (once) and buffering changes.
fn report(player: &AnyObject, emitter: &Emitter, status: &Status) {
    // SAFETY: AVPlayer / AVPlayerItem getters.
    unsafe {
        let item: Option<Retained<AnyObject>> = msg_send![player, currentItem];
        let Some(item) = item else { return };
        // AVPlayerItemStatus: 1 ready to play, 2 failed.
        let state: isize = msg_send![&item, status];
        if state == 1 && !status.loaded.replace(true) {
            let size: CGSize = msg_send![&item, presentationSize];
            emitter.emit(EventKind::Load, || {
                EventPayload::Map(vec![
                    ("duration", PayloadValue::Number(item_duration(player))),
                    ("width", PayloadValue::Number(size.width)),
                    ("height", PayloadValue::Number(size.height)),
                ])
            });
        }
        if state == 2 && !status.failed.replace(true) {
            let err: Option<Retained<AnyObject>> = msg_send![&item, error];
            let message = err
                .map(|e| {
                    let d: Retained<NSString> = msg_send![&e, localizedDescription];
                    d.to_string()
                })
                .unwrap_or_else(|| "the video failed to load".to_owned());
            log::warn!(target: "js", "video: {message}");
            emitter.emit(EventKind::Error, || error(message));
        }
        // AVPlayerTimeControlStatusWaitingToPlayAtSpecifiedRate.
        let control_status: isize = msg_send![player, timeControlStatus];
        let waiting = control_status == 1 && !status.failed.get();
        if status.buffering.replace(waiting) != waiting {
            emitter.emit(EventKind::Buffer, || {
                EventPayload::Map(vec![("isBuffering", PayloadValue::Bool(waiting))])
            });
        }
    }
}

/// Lets pages talk to the app: `window.nsh.postMessage(data)`.
const BRIDGE: &str = "window.nsh = window.nsh || { postMessage: function (data) { window.webkit.messageHandlers.nsh.postMessage(String(data)); } };";

/// Ivars of [`WebHandler`].
struct WebIvars {
    emitter: Emitter,
    /// What the app may show (its `webview` capability); `None`: nothing
    /// is known about the app, so nothing is refused.
    access: Option<Arc<Access>>,
    /// The web view's downloads: WebKit's transfers, reported to and
    /// directed by the core (which owns their destinations and lifecycle).
    download: Rc<web_download::Transport>,
    /// The core asked this view to hold downloads
    /// (`NativeProp::DeferDownloads`); an `onDownload` listener counts too.
    defer_downloads: Cell<bool>,
    navigation: Cell<Option<usize>>,
    /// Response policies that converted a navigation into a download.
    downloading: RefCell<FxHashSet<usize>>,
    /// The folder path (`/a/b/`) of the `file://` page the app last loaded
    /// here: the only files this web view may open (its pages can link to
    /// each other, never to a file outside it).
    file: RefCell<Option<String>>,
    /// The web view's `allowOrigin`, from its latest props.
    allow_origin: RefCell<Option<nsh_core::access::WebOrigin>>,
    /// `evaluate()`'s requests in this web view.
    evaluations: Rc<nsh_platform_apple::web_evaluation::Evaluations>,
}

define_class!(
    /// Navigation delegate and script message handler of one web view.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = WebIvars]
    #[name = "NshWebHandler"]
    struct WebHandler;

    unsafe impl NSObjectProtocol for WebHandler {}

    impl WebHandler {
        #[unsafe(method(userContentController:didReceiveScriptMessage:))]
        fn did_receive_message(&self, _controller: &AnyObject, message: &AnyObject) {
            // SAFETY: `body` of a WKScriptMessage.
            let body: Option<Retained<AnyObject>> = unsafe { msg_send![message, body] };
            let data = body.map(|b| describe(&b)).unwrap_or_default();
            self.emit(EventKind::Message, || {
                EventPayload::Map(vec![("data", PayloadValue::Str(data))])
            });
        }

        /// Top-level navigations stay within the app's `webview` capability.
        #[unsafe(method(webView:decidePolicyForNavigationAction:decisionHandler:))]
        fn decide_policy(
            &self,
            _web: &AnyObject,
            action: &AnyObject,
            decide: &block2::Block<dyn Fn(isize)>,
        ) {
            // SAFETY: WebKit's documented API (WKNavigationAction).
            let (main, url) = unsafe {
                let frame: Option<Retained<AnyObject>> = msg_send![action, targetFrame];
                // No target frame: a new window, which counts as top level.
                let main = frame.is_none_or(|f| msg_send![&*f, isMainFrame]);
                let request: Retained<AnyObject> = msg_send![action, request];
                let url: Option<Retained<NSURL>> = msg_send![&request, URL];
                let url = url
                    .and_then(|u| u.absoluteString())
                    .map(|s| s.to_string());
                (main, url.unwrap_or_default())
            };
            let ivars = self.ivars();
            let allowed = navigation_allowed(
                ivars.access.as_deref(),
                ivars.allow_origin.borrow().as_ref(),
                ivars.file.borrow().as_deref(),
                main,
                &url,
            );
            if !allowed {
                log::warn!(target: "js", "web view navigation to {url} is not granted");
                let message = format!("navigation to {url} is not granted");
                self.emit(EventKind::Error, || {
                    EventPayload::Map(vec![
                        ("message", PayloadValue::Str(message)),
                        ("code", PayloadValue::Str(nsh_core::element::codes::ACCESS_DENIED.into())),
                        ("url", PayloadValue::Str(url)),
                    ])
                });
            }
            // A `download` link becomes a download when the app asks for
            // downloads (WebKit knows `shouldPerformDownload` on macOS 11.3
            // and later).
            let download =
                allowed && self.wants_download() && web_download::should_download(action);
            // WKNavigationActionPolicyCancel = 0, Allow = 1, Download = 2.
            decide.call((if download { 2 } else { allowed as isize },));
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
            // WKMediaCaptureTypeCamera = 0, Microphone = 1, CameraAndMicrophone = 2.
            let wanted: &[WebMedia] = match kind {
                0 => &[WebMedia::Camera],
                1 => &[WebMedia::Microphone],
                _ => &[WebMedia::Camera, WebMedia::Microphone],
            };
            let access = self.ivars().access.as_ref();
            let granted = wanted
                .iter()
                .all(|m| access.is_some_and(|a| a.allows_web_media(*m)));
            if !granted {
                log::warn!(target: "js", "web view media capture is not granted: add it to capabilities.webview.media");
            }
            // WKPermissionDecisionGrant = 1, Deny = 2.
            decide.call((if granted { 1 } else { 2 },));
        }

        /// What the page cannot show, or the server sends as an attachment,
        /// is downloaded when the app listens for downloads.
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

        #[unsafe(method(webView:didStartProvisionalNavigation:))]
        fn did_start(&self, web: &AnyObject, navigation: Option<&AnyObject>) {
            self.ivars().evaluations.navigated();
            self.ivars().navigation.set(navigation.map(download_key));
            self.emit(EventKind::LoadStart, || navigation_state(web, true));
            self.emit(EventKind::NavigationStateChange, || {
                navigation_state(web, true)
            });
        }

        #[unsafe(method(webViewWebContentProcessDidTerminate:))]
        fn process_terminated(&self, _web: &AnyObject) {
            self.ivars().evaluations.process_terminated();
            // The app keeps running; the page comes back on its next reload.
            self.emit(EventKind::Error, || {
                EventPayload::Map(vec![
                    (
                        "message",
                        PayloadValue::Str("The web content process terminated".into()),
                    ),
                    (
                        "code",
                        PayloadValue::Str(nsh_core::element::codes::WEBVIEW_TERMINATED.into()),
                    ),
                ])
            });
        }

        #[unsafe(method(webView:didFinishNavigation:))]
        fn did_finish(&self, web: &AnyObject, navigation: Option<&AnyObject>) {
            if let Some(navigation) = navigation {
                self.ivars().downloading.borrow_mut().remove(&download_key(navigation));
            }
            self.emit(EventKind::Load, || navigation_state(web, false));
            self.emit(EventKind::NavigationStateChange, || {
                navigation_state(web, false)
            });
        }

        #[unsafe(method(webView:didFailNavigation:withError:))]
        fn did_fail(&self, _web: &AnyObject, navigation: Option<&AnyObject>, error: &AnyObject) {
            self.failed(navigation, error);
        }

        #[unsafe(method(webView:didFailProvisionalNavigation:withError:))]
        fn did_fail_provisional(
            &self,
            _web: &AnyObject,
            navigation: Option<&AnyObject>,
            error: &AnyObject,
        ) {
            self.failed(navigation, error);
        }
    }
);

impl WebHandler {
    fn new(
        mtm: MainThreadMarker,
        emitter: Emitter,
        access: Option<Arc<Access>>,
        download: Rc<web_download::Transport>,
        evaluations: Rc<nsh_platform_apple::web_evaluation::Evaluations>,
    ) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(WebIvars {
            emitter,
            access,
            download,
            defer_downloads: Cell::default(),
            navigation: Cell::default(),
            downloading: RefCell::default(),
            file: RefCell::new(None),
            allow_origin: RefCell::default(),
            evaluations,
        });
        // SAFETY: NSObject's designated initializer.
        unsafe { msg_send![super(this), init] }
    }

    fn emit(&self, kind: EventKind, payload: impl FnOnce() -> EventPayload) {
        self.ivars().emitter.emit(kind, payload);
    }

    /// Whether this web view holds downloads for the core: the core asked
    /// it to (`defer_downloads`, from the Rust builders) or the app listens
    /// (`onDownload`, `onDownloadPending`). Otherwise the navigations stay
    /// as they were.
    fn wants_download(&self) -> bool {
        self.ivars().defer_downloads.get()
            || self.ivars().emitter.listens(EventKind::Download)
            || self.ivars().emitter.listens(EventKind::DownloadPending)
    }

    /// The core asked (or stopped asking) this view to hold downloads.
    fn set_defer_downloads(&self, defer: bool) {
        self.ivars().defer_downloads.set(defer);
    }

    /// The web view's `allowOrigin`: its next navigations are checked with it.
    fn set_allow_origin(&self, origin: Option<nsh_core::access::WebOrigin>) {
        *self.ivars().allow_origin.borrow_mut() = origin;
    }

    fn failed(&self, navigation: Option<&AnyObject>, err: &AnyObject) {
        let downloading = navigation.is_some_and(|navigation| {
            self.ivars()
                .downloading
                .borrow_mut()
                .remove(&download_key(navigation))
        });
        // SAFETY: NSError's documented domain and code. WebKit reports 102
        // for the navigation we deliberately converted into a download.
        let (domain, code): (Retained<NSString>, isize) =
            unsafe { (msg_send![err, domain], msg_send![err, code]) };
        if downloading && domain.to_string() == "WebKitErrorDomain" && code == 102 {
            return;
        }
        // SAFETY: `localizedDescription` of an NSError.
        let message: Retained<NSString> = unsafe { msg_send![err, localizedDescription] };
        self.emit(EventKind::Error, || error(message.to_string()));
    }

    fn cancel_downloads(&self) {
        self.ivars().download.cancel_all();
    }
}

/// The identity of a native object (a download, a navigation) in a map.
fn download_key(download: &AnyObject) -> usize {
    download as *const AnyObject as usize
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

/// Whether a web view may navigate to `url`: a frame inside the page, a
/// file in the folder of the `file://` page the app itself loaded there
/// (`folder`, which the `webview` grant, made of web hosts, can't name),
/// and what the grant allows, with the web view's `allowOrigin` (`origin`).
/// Never a file outside that folder.
fn navigation_allowed(
    access: Option<&Access>,
    origin: Option<&nsh_core::access::WebOrigin>,
    folder: Option<&str>,
    main: bool,
    url: &str,
) -> bool {
    if !main || url.is_empty() {
        return true;
    }
    if is_file_url(url) {
        return folder.is_some_and(|dir| {
            local_file_path(url).is_some_and(|path| path.starts_with(dir) && !has_dot_segment(path))
        });
    }
    access.is_none_or(|a| a.allows_webview_with(url, origin))
}

fn is_file_url(url: &str) -> bool {
    url.get(..5)
        .is_some_and(|s| s.eq_ignore_ascii_case("file:"))
}

/// The path of a local `file://` URL, without query or fragment: `None`
/// for any other URL and for a file on another host. `file:///a` and
/// `file://localhost/a` are the same file, `/a`.
fn local_file_path(url: &str) -> Option<&str> {
    const SCHEME: &str = "file://";
    if !url
        .get(..SCHEME.len())
        .is_some_and(|s| s.eq_ignore_ascii_case(SCHEME))
    {
        return None;
    }
    let rest = &url[SCHEME.len()..];
    let slash = rest.find('/')?;
    let host = &rest[..slash];
    if !(host.is_empty() || host.eq_ignore_ascii_case("localhost")) {
        return None;
    }
    let path = &rest[slash..];
    Some(path.split(['?', '#']).next().unwrap_or(path))
}

/// Whether `path` has a `.` or `..` segment, written out or
/// percent-encoded (`%2e`, `..%2f`), which could name a folder above the
/// one it seems to.
fn has_dot_segment(path: &str) -> bool {
    percent_decoded(path)
        .split(|&b| b == b'/')
        .any(|segment| segment == b"." || segment == b"..")
}

/// The folder path (`/a/b/`) a `file://` page may read: the file's own and
/// what is under it, nothing above. `None` for any other URL, which loads
/// as a request, for a file on another host, for a file at the root, whose
/// folder is the whole disk (`file://localhost/a.pdf` included), and for a
/// path with a `.` or `..` segment.
fn file_read_scope(uri: &str) -> Option<&str> {
    let path = local_file_path(uri)?;
    if has_dot_segment(path) {
        return None;
    }
    let end = path.rfind('/')? + 1;
    (end > 1).then(|| &path[..end])
}

/// `s` with each `%XX` turned into its byte; a `%` not followed by two hex
/// digits stays as it is.
fn percent_decoded(s: &str) -> Vec<u8> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = |b: u8| (b as char).to_digit(16);
        if bytes[i] == b'%'
            && let (Some(h), Some(l)) = (
                bytes.get(i + 1).copied().and_then(hex),
                bytes.get(i + 2).copied().and_then(hex),
            )
        {
            out.push((h * 16 + l) as u8);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    out
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

/// A web view: the `WKWebView` (when WebKit loads) filling its node's view,
/// made with its first props (`incognito` picks its website data store).
struct WebHost {
    /// The node's view, which hosts the web view.
    holder: objc2::rc::Weak<ViewObj>,
    web: Option<Retained<AnyObject>>,
    /// The `WKWebViewConfiguration` it is made with ([`Self::configure`]).
    config: Option<Retained<AnyObject>>,
    handler: Retained<WebHandler>,
    /// Serves the URL schemes of the first props while the web view is
    /// here.
    schemes: Option<nsh_platform_apple::web_scheme::SchemeServer>,
    /// The props applied (`None` before the first).
    props: Option<WebProps>,
    /// The page scrolls with the wheel and the trackpad
    /// (`scrollable`).
    scrolls: bool,
    /// Loads the props ask for wait ([`Self::load_pending`]): while it is
    /// made, the load takes a frame of its own ([`web_step`]).
    hold_load: bool,
    /// A load waits for [`Self::hold_load`] to end.
    load_pending: bool,
    /// When the held load first could start ([`web_step`]), which waits
    /// while the surface moves, at most [`LOAD_WAIT`].
    load_waits: Option<std::time::Instant>,
    /// Its surface's key, whose idle moments make the next spare web view
    /// after it takes one ([`Self::adopt`]).
    surface: u64,
}

impl WebHost {
    fn new(surface: &Rc<Surface>, view: &NshView, access: Option<Arc<Access>>) -> Self {
        let node = view.id();
        // Replies are internal events: they reach the engine whether or not
        // the app listens.
        let weak = Rc::downgrade(surface);
        let evaluations = nsh_platform_apple::web_evaluation::Evaluations::new(
            node,
            Box::new(move |id, kind, payload| {
                if let Some(surface) = weak.upgrade() {
                    surface.event(id, kind, payload);
                }
            }),
        );
        // The transport's events are internal too: the sink is the core, so
        // they go to the node whether or not the app listens for them, and
        // they outlive this view (the engine handle keeps working after the
        // surface is gone; the core's teardown needs them).
        let emit_control = surface.event_control();
        let emit: web_download::Emit = Rc::new(move |kind, payload| {
            if let Some(control) = &emit_control {
                control.dispatch_event(node, kind, payload);
            }
        });
        // A download's redirects take the grant its navigations do.
        let grant = access.clone();
        let allows: web_download::Allows =
            Rc::new(move |url: &str| navigation_allowed(grant.as_deref(), None, None, true, url));
        let download = web_download::Transport::new(surface.mtm, emit, allows);
        let handler = WebHandler::new(
            surface.mtm,
            Emitter::new(surface, view),
            access,
            download,
            evaluations,
        );
        WebHost {
            holder: objc2::rc::Weak::new(&**view),
            web: None,
            config: None,
            handler,
            schemes: None,
            props: None,
            scrolls: true,
            hold_load: false,
            load_pending: false,
            load_waits: None,
            surface: surface.key(),
        }
    }

    /// Takes the spare `WKWebView` ([`SpareWeb`]) when one is there and `p`
    /// can use it: a web view without URL schemes of its own (their
    /// handlers are set before a web view is made) that keeps its website
    /// data (`incognito` is a data store of its own, set before too). What
    /// else its first props configure applies to a made web view: the
    /// message handler here, scripts and preferences in [`Self::set`].
    fn adopt(&mut self, p: &WebProps) -> bool {
        if self.config.is_some() || p.incognito || !p.url_schemes.is_empty() {
            return false;
        }
        let Some(view) = self.holder.load().and_then(|v| NshView::from_ns(&v)) else {
            return false;
        };
        let Some(spare) = WEB_SPARE.with(|s| s.borrow_mut().take()) else {
            return false;
        };
        let handler = &self.handler;
        // SAFETY: WebKit's documented API; the handler is unregistered when
        // the host is dropped. A web view's content controller is its
        // configuration's (the view copies the configuration, not the
        // controller).
        unsafe {
            let content: Retained<AnyObject> = msg_send![&spare.config, userContentController];
            let _: () = msg_send![
                &content,
                addScriptMessageHandler: &**handler,
                name: &*NSString::from_str("nsh")
            ];
            let _: () = msg_send![&spare.web, setNavigationDelegate: &**handler];
            let _: () = msg_send![&spare.web, setUIDelegate: &**handler];
            // A WKWebView is an NSView.
            crate::surface::quiet(|| fill(&view, as_view(&spare.web)));
        }
        self.config = Some(spare.config);
        self.web = Some(spare.web);
        self.handler.ivars().evaluations.set_web(self.web.as_ref());
        spare_web_later(self.surface);
        true
    }

    /// Makes the `WKWebViewConfiguration` from the first props: its
    /// website data kept in memory only (a store of its own) when
    /// `incognito`, the app's URL schemes served, the page's messages
    /// handled. The first one of a process also sets up WebKit's process
    /// pool and default website data store, which the configuration
    /// reaches for here so that their cost is not the `WKWebView`'s frame.
    fn configure(&mut self, p: &WebProps) {
        if self.config.is_some() || !webkit() {
            return;
        }
        let handler = &self.handler;
        // SAFETY: WebKit's documented API, sent dynamically; the handler is
        // unregistered when the host is dropped.
        let config = unsafe {
            (|| {
                let config: Retained<AnyObject> = msg_send![class(c"WKWebViewConfiguration")?, new];
                if let Some(pool) = WEB_POOL.with(|p| p.borrow().clone()) {
                    let _: () = msg_send![&config, setProcessPool: &*pool];
                }
                if p.incognito {
                    let store: Retained<AnyObject> =
                        msg_send![class(c"WKWebsiteDataStore")?, nonPersistentDataStore];
                    let _: () = msg_send![&config, setWebsiteDataStore: &*store];
                }
                // Made on first use; the `WKWebView` would otherwise.
                let _: Option<Retained<AnyObject>> = msg_send![&config, websiteDataStore];
                let _: Option<Retained<AnyObject>> = msg_send![&config, processPool];
                self.schemes =
                    nsh_platform_apple::web_scheme::serve(handler.mtm(), &config, &p.url_schemes);
                let content: Retained<AnyObject> = msg_send![&config, userContentController];
                let _: () = msg_send![
                    &content,
                    addScriptMessageHandler: &**handler,
                    name: &*NSString::from_str("nsh")
                ];
                Some(config)
            })()
        };
        self.config = config;
    }

    /// Makes the `WKWebView`: the spare one ([`Self::adopt`]) or one with
    /// its configuration ([`Self::configure`], from `p`).
    fn make(&mut self, p: &WebProps) {
        if !self.adopt(p) {
            self.configure(p);
            self.build();
        }
    }

    /// Makes the `WKWebView` with its configuration, if it has one, and
    /// hosts it in its node's view.
    fn build(&mut self) {
        let Some(view) = self.holder.load().and_then(|v| NshView::from_ns(&v)) else {
            return;
        };
        let handler = &self.handler;
        let web = self.config.as_ref().and_then(|config| {
            // SAFETY: WebKit's documented API, sent dynamically; a
            // WKWebView is an NSView.
            unsafe {
                let alloc: Allocated<AnyObject> = msg_send![class(c"WKWebView")?, alloc];
                let web: Retained<AnyObject> = msg_send![
                    alloc,
                    initWithFrame: NSRect::ZERO,
                    configuration: &**config
                ];
                let _: () = msg_send![&web, setNavigationDelegate: &**handler];
                let _: () = msg_send![&web, setUIDelegate: &**handler];
                // Transparent by default (WebKit paints white otherwise): a
                // page without a background shows the view behind it, the
                // way `backgroundColor` on the node expects.
                let no: Retained<AnyObject> = msg_send![class(c"NSNumber")?, numberWithBool: false];
                let _: () = msg_send![&web, setValue: &*no, forKey: &*NSString::from_str("drawsBackground")];
                crate::surface::quiet(|| fill(&view, as_view(&web)));
                Some(web)
            }
        });
        self.web = web;
        self.handler.ivars().evaluations.set_web(self.web.as_ref());
    }

    /// Whether `view` is its `WKWebView`.
    fn is(&self, view: &NSView) -> bool {
        self.web.as_ref().is_some_and(|web| {
            std::ptr::eq(
                Retained::as_ptr(web).cast::<u8>(),
                (view as *const NSView).cast::<u8>(),
            )
        })
    }

    fn set(&mut self, p: &WebProps) {
        self.scrolls = p.scrollable;
        self.handler.set_defer_downloads(p.defer_downloads);
        // Before the source loads: it applies to that navigation.
        self.handler.set_allow_origin(p.allow_origin.clone());
        if self.props.is_none() && self.web.is_none() {
            // The core keeps `incognito` and the URL schemes from changing
            // once it is made.
            self.make(p);
        }
        let Some(web) = &self.web else { return };
        if !p.javascript_enabled {
            self.handler.ivars().evaluations.scripts_disabled();
        }
        let old = self.props.take();
        let first = old.is_none();
        let old = old.unwrap_or_default();
        let scripts_changed = first
            || p.injected_js != old.injected_js
            || p.injected_js_before != old.injected_js_before;
        // SAFETY: WebKit's documented API.
        unsafe {
            let config: Retained<AnyObject> = msg_send![web, configuration];
            if scripts_changed {
                let content: Retained<AnyObject> = msg_send![&config, userContentController];
                let _: () = msg_send![&content, removeAllUserScripts];
                let add = |source: &str, at_end: bool| {
                    let Some(cls) = class(c"WKUserScript") else {
                        return;
                    };
                    let alloc: Allocated<AnyObject> = msg_send![cls, alloc];
                    // WKUserScriptInjectionTime: 0 at document start, 1 at
                    // its end.
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
            let _: () = msg_send![
                web,
                setAllowsBackForwardNavigationGestures: Bool::new(p.back_forward_gestures)
            ];
            // `zoomable`: pinch (trackpad) magnification; off is WebKit's
            // default. The core keeps it from changing once it is made.
            if first {
                let _: () = msg_send![web, setAllowsMagnification: Bool::new(p.zoomable)];
            }
            let prefs: Retained<AnyObject> = msg_send![&config, defaultWebpagePreferences];
            let _: () =
                msg_send![&prefs, setAllowsContentJavaScript: Bool::new(p.javascript_enabled)];
        }
        // Scripts apply to pages loaded from now on: load again.
        if first || p.source != old.source || scripts_changed {
            if self.hold_load {
                self.load_pending = true;
            } else {
                self.load(p);
            }
        }
        self.props = Some(p.clone());
    }

    /// Loads what `p` shows.
    fn load(&self, p: &WebProps) {
        let Some(web) = &self.web else { return };
        // SAFETY: WebKit's documented API.
        unsafe {
            // Only the file this load opens is the page's own: none for
            // any other source.
            *self.handler.ivars().file.borrow_mut() = None;
            if p.source != WebSource::None {
                self.handler.ivars().evaluations.navigated();
            }
            match &p.source {
                WebSource::Uri(uri) => {
                    let url = NSURL::URLWithString(&NSString::from_str(uri));
                    let dir = file_read_scope(uri);
                    let scope = dir.and_then(|dir| {
                        NSURL::URLWithString(&NSString::from_str(&format!("file://{dir}")))
                    });
                    if let (Some(url), Some(scope), Some(dir)) = (&url, scope, dir) {
                        *self.handler.ivars().file.borrow_mut() = Some(dir.to_owned());
                        // A request for a file URL shows nothing: WebKit
                        // reads a local file only where it is let.
                        let _: Option<Retained<AnyObject>> = msg_send![
                            web,
                            loadFileURL: &**url,
                            allowingReadAccessToURL: &*scope
                        ];
                    } else if let (Some(url), Some(cls)) = (url, class(c"NSURLRequest")) {
                        let request: Retained<AnyObject> = msg_send![cls, requestWithURL: &*url];
                        let _: Option<Retained<AnyObject>> = msg_send![web, loadRequest: &*request];
                    }
                }
                WebSource::Html { html, base_url } => {
                    let base = base_url
                        .as_deref()
                        .and_then(|b| NSURL::URLWithString(&NSString::from_str(b)));
                    let _: Option<Retained<AnyObject>> = msg_send![
                        web,
                        loadHTMLString: &*NSString::from_str(html),
                        baseURL: base.as_deref()
                    ];
                }
                WebSource::None => {}
            }
        }
    }
}

impl Drop for WebHost {
    fn drop(&mut self) {
        // A transfer still writing keeps the transport (and its events)
        // alive until WebKit confirms it stopped, so the core can clean
        // its staging directory afterwards.
        self.handler.cancel_downloads();
        self.handler.ivars().evaluations.dispose();
        // SAFETY: breaks the cycle web view → content controller → handler
        // and stops the page.
        unsafe {
            if let Some(web) = &self.web {
                let _: () = msg_send![web, stopLoading];
                let _: () = msg_send![web, setNavigationDelegate: std::ptr::null::<AnyObject>()];
                let _: () = msg_send![web, setUIDelegate: std::ptr::null::<AnyObject>()];
            }
            let Some(config) = &self.config else { return };
            let content: Retained<AnyObject> = msg_send![config, userContentController];
            let _: () = msg_send![
                &content,
                removeScriptMessageHandlerForName: &*NSString::from_str("nsh")
            ];
        }
    }
}

/// Handles a [`WebViewOperation`] on the web view and answers through
/// `EventKind::WebViewReply`.
fn web_request(
    surface: &Rc<Surface>,
    node: NodeId,
    _web: &AnyObject,
    handler: &WebHandler,
    request: &WebViewRequest,
) {
    let download = handler.ivars().download.clone();
    match &request.operation {
        WebViewOperation::StartDownload { id, staging } => {
            match download.start(id, staging) {
                // WebKit accepted the destination; the core publishes the
                // app's `started` and reports the completion as a
                // `DownloadEnd`.
                Ok(()) => reply(surface, node, request.id, Ok(JsonValue::Null)),
                Err(error) => reply(surface, node, request.id, Err(error)),
            }
        }
        WebViewOperation::CancelDownload { id } => {
            // The reply is the core's permission to clean the staging
            // directory: it comes only once WebKit has stopped writing,
            // also after the view is released (the core's teardown needs
            // it).
            let control = surface.event_control();
            let request_id = request.id;
            let result = download.cancel(id, move || {
                if let Some(control) = &control {
                    control.dispatch_event(
                        node,
                        EventKind::WebViewReply,
                        nsh_core::webview::reply(request_id, Ok(JsonValue::Null)),
                    );
                }
            });
            if let Err(error) = result {
                reply(surface, node, request.id, Err(error));
            }
        }
        // A newer core's operation: answer it rather than leave it pending.
        _ => reply(
            surface,
            node,
            request.id,
            Err("this macOS backend does not know the web view operation".into()),
        ),
    }
}

/// Answers request `request` of `node`: success carries `value` (null for
/// unit operations), failure `error`.
fn reply(surface: &Surface, node: NodeId, request: u64, result: Result<JsonValue, String>) {
    surface.event(
        node,
        EventKind::WebViewReply,
        nsh_core::webview::reply(request, result),
    );
}

/// `reload()`, `goBack()`, `goForward()`, `stopLoading()`,
/// `injectJavaScript()`, `postMessage()` and `load()`.
fn web_command(web: &AnyObject, command: &Command) {
    let script = match command {
        Command::InjectJavaScript(js) => Some(js.to_string()),
        Command::PostMessage(data) => Some(format!(
            "window.dispatchEvent(new MessageEvent('message', {{ data: {} }}));",
            js_string(data)
        )),
        _ => None,
    };
    // SAFETY: WebKit's documented API.
    unsafe {
        match (command, script) {
            (_, Some(js)) => {
                let _: () = msg_send![
                    web,
                    evaluateJavaScript: &*NSString::from_str(&js),
                    completionHandler: std::ptr::null::<AnyObject>()
                ];
            }
            (Command::Reload, _) => {
                let _: Option<Retained<AnyObject>> = msg_send![web, reload];
            }
            (Command::GoBack, _) => {
                let _: Option<Retained<AnyObject>> = msg_send![web, goBack];
            }
            (Command::GoForward, _) => {
                let _: Option<Retained<AnyObject>> = msg_send![web, goForward];
            }
            (Command::StopLoading, _) => {
                let _: () = msg_send![web, stopLoading];
            }
            (Command::Load(load), _) => web_load(web, load),
            _ => {}
        }
    }
}

/// `load()`: the page's request with the app's headers. Only this request
/// carries them; WebKit makes its subresources' and later navigations'
/// requests itself.
fn web_load(web: &AnyObject, load: &nsh_core::WebLoad) {
    let (Some(url), Some(cls)) = (
        NSURL::URLWithString(&NSString::from_str(&load.src)),
        class(c"NSMutableURLRequest"),
    ) else {
        return;
    };
    // SAFETY: Foundation's and WebKit's documented API.
    unsafe {
        let request: Retained<AnyObject> = msg_send![cls, requestWithURL: &*url];
        for (name, value) in &load.headers {
            let _: () = msg_send![
                &request,
                setValue: &*NSString::from_str(value),
                forHTTPHeaderField: &*NSString::from_str(name)
            ];
        }
        let _: Option<Retained<AnyObject>> = msg_send![web, loadRequest: &*request];
    }
}

/// `sendInput()`: events made as AppKit makes the user's and handed to the
/// web view, so the page sees them trusted, which injected scripts cannot do.
fn web_input(web: &AnyObject, input: &WebInput) {
    // SAFETY: AppKit's and WebKit's documented API, on the main thread.
    unsafe {
        let window: Option<Retained<NSWindow>> = msg_send![web, window];
        let Some(window) = window else { return };
        // Keys go to the first responder, which a click makes the web view
        // too: it takes the keyboard focus, unless it has it already.
        let first: Option<Retained<AnyObject>> = msg_send![&*window, firstResponder];
        if first.as_deref().is_none_or(|f| !std::ptr::eq(f, web)) {
            let _: Bool = msg_send![&*window, makeFirstResponder: web];
        }
        let time = objc2_foundation::NSProcessInfo::processInfo().systemUptime();
        match input {
            WebInput::Click { x, y } => {
                // CSS pixels are points scaled by the page's zoom and magnification.
                let zoom: f64 = msg_send![web, pageZoom];
                let magnification: f64 = msg_send![web, magnification];
                let scale = zoom * magnification;
                let point: NSPoint = msg_send![
                    web,
                    convertPoint: NSPoint::new(f64::from(x.0) * scale, f64::from(y.0) * scale),
                    toView: std::ptr::null::<AnyObject>()
                ];
                for (kind, pressure) in [
                    (NSEventType::LeftMouseDown, 1.0),
                    (NSEventType::LeftMouseUp, 0.0),
                ] {
                    let Some(event) = NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
                        kind,
                        point,
                        NSEventModifierFlags::empty(),
                        time,
                        window.windowNumber(),
                        None,
                        0,
                        1,
                        pressure,
                    ) else {
                        continue;
                    };
                    if kind == NSEventType::LeftMouseDown {
                        let _: () = msg_send![web, mouseDown: &*event];
                    } else {
                        let _: () = msg_send![web, mouseUp: &*event];
                    }
                }
            }
            WebInput::Text(text) => {
                // The US layout's key (and Shift) for each character, so the
                // page's `KeyboardEvent.code` names the key a user would press;
                // a line break is Return, and what no US key types (`é`, CJK,
                // emoji) no key at all (`code` "Unidentified").
                for c in text.chars() {
                    let c = if c == '\n' { '\r' } else { c };
                    let (code, shift) =
                        crate::input::us_typing_key(c).unwrap_or((crate::input::NO_KEY, false));
                    // What the key types without Shift (`a` for `A`), as AppKit's own.
                    let plain = crate::input::us_key(code).unwrap_or(c);
                    key(
                        web,
                        &window,
                        time,
                        &c.to_string(),
                        &plain.to_string(),
                        code,
                        shift,
                    );
                }
            }
            WebInput::Key(k) => {
                let (chars, code) = match k {
                    WebKey::Enter => ("\r", 36),
                    WebKey::Tab => ("\t", 48),
                    WebKey::Escape => ("\u{1b}", 53),
                    WebKey::Backspace => ("\u{7f}", 51),
                    _ => return,
                };
                key(web, &window, time, chars, chars, code, false);
            }
            _ => {}
        }
    }
}

/// A key's down and up, with `chars` typed (`plain` without modifiers),
/// handed to the web view.
fn key(
    web: &AnyObject,
    window: &NSWindow,
    time: f64,
    chars: &str,
    plain: &str,
    code: u16,
    shift: bool,
) {
    let s = NSString::from_str(chars);
    let plain = NSString::from_str(plain);
    for kind in [NSEventType::KeyDown, NSEventType::KeyUp] {
        let event = NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(
            kind,
            NSPoint::new(0.0, 0.0),
            if shift { NSEventModifierFlags::Shift } else { NSEventModifierFlags::empty() },
            time,
            window.windowNumber(),
            None,
            &s,
            &plain,
            false,
            code,
        );
        let Some(event) = event else { continue };
        // SAFETY: NSResponder's documented API, on the main thread.
        unsafe {
            if kind == NSEventType::KeyDown {
                let _: () = msg_send![web, keyDown: &*event];
            } else {
                let _: () = msg_send![web, keyUp: &*event];
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locates_sources() {
        let dir = AssetBase::Directory("/app/assets".into());
        let http = AssetBase::Http("http://10.0.0.2:8790/assets/".into());
        assert_eq!(
            locate("asset:/clips/a.mp4", Some(&dir)),
            Some(Location::Path("/app/assets/clips/a.mp4".into()))
        );
        assert_eq!(
            locate("asset:/a.mp4", Some(&http)),
            Some(Location::Uri("http://10.0.0.2:8790/assets/a.mp4".into()))
        );
        assert_eq!(locate("asset:/a.mp4", None), None);
        assert_eq!(
            locate("https://example.com/a.mp4", None),
            Some(Location::Uri("https://example.com/a.mp4".into()))
        );
        assert_eq!(
            locate("/Users/me/a.mp4", None),
            Some(Location::Path("/Users/me/a.mp4".into()))
        );
        assert_eq!(locate("", None), None);
    }

    #[test]
    fn a_file_url_reads_its_own_folder_and_nothing_wider() {
        assert_eq!(
            file_read_scope("file:///tmp/opened/7f/Invoice%20May.pdf"),
            Some("/tmp/opened/7f/")
        );
        assert_eq!(
            file_read_scope("FILE:///tmp/x/a.pdf#page=2"),
            Some("/tmp/x/")
        );
        assert_eq!(
            file_read_scope("file://localhost/tmp/x/a.pdf"),
            Some("/tmp/x/")
        );
        assert_eq!(
            file_read_scope("file://LOCALHOST/tmp/x/a.pdf"),
            Some("/tmp/x/")
        );
        assert_eq!(
            file_read_scope("file:///tmp/x/a.pdf?/b/c"),
            Some("/tmp/x/"),
            "a slash after the path is no folder"
        );
        assert_eq!(
            file_read_scope("file:///tmp/x/..a/b..pdf"),
            Some("/tmp/x/..a/"),
            "dots in a name are a name"
        );
        assert_eq!(file_read_scope("file:///tmp/x/a%20.pdf"), Some("/tmp/x/"));
        for uri in [
            "file:///a.pdf",
            "file://localhost/a.pdf",
            "file://localhost/",
            "file://server/share/a.pdf",
            "file://localhost",
            "file:///tmp/x/../../a.pdf",
            "file:///tmp/x/./a.pdf",
            "file:///tmp/x/%2e%2e/%2E%2E/a.pdf",
            "file:///tmp/x/.%2e/a.pdf",
            "file:///tmp/x/..%2f..%2fetc/a.pdf",
            "file:///tmp/x/..%2F/a.pdf",
            "file://localhost/tmp/../a.pdf",
            "file:///tmp/../a.pdf#page=2",
            "http://127.0.0.1:8790/file/raw/m1/a.pdf",
            "https://example.com/a.pdf",
            "about:blank",
            "/tmp/b.pdf",
            "",
        ] {
            assert_eq!(file_read_scope(uri), None, "{uri}");
        }
    }

    #[test]
    fn a_web_view_opens_only_files_in_the_folder_it_was_given() {
        let dir = "/tmp/opened/7f/";
        let native = Policy::default().access();
        let go = |loaded: Option<&str>, url: &str| {
            navigation_allowed(Some(&native), None, loaded, true, url)
        };
        for url in [
            "file:///tmp/opened/7f/a.pdf",
            "file:///tmp/opened/7f/a.pdf#page=2",
            "FILE:///tmp/opened/7f/a.pdf",
            "file://localhost/tmp/opened/7f/a.pdf",
            "file:///tmp/opened/7f/b.html",
            "file:///tmp/opened/7f/sub/c.html?x=1",
        ] {
            assert!(go(Some(dir), url), "same folder: {url}");
        }
        for url in [
            "file:///tmp/opened/a.pdf",
            "file:///etc/passwd",
            "file://localhost/etc/passwd",
            "file://server/tmp/opened/7f/a.pdf",
            "file:///tmp/opened/7f/../x.pdf",
            "file:///tmp/opened/7f/%2e%2e/x.pdf",
            "file:///tmp/opened/7fx/a.pdf",
        ] {
            assert!(!go(Some(dir), url), "outside the folder: {url}");
        }
        assert!(
            !go(None, "file:///tmp/opened/7f/a.pdf"),
            "a web view that loaded no file (the mail reader)"
        );
        assert!(
            !navigation_allowed(None, None, None, true, "file:///tmp/a.pdf"),
            "nothing known of the app"
        );
        // Not a file: the grant decides, unrestricted or not.
        assert!(go(Some(dir), "https://example.com/a"));
        assert!(go(None, "about:blank"));
        let granted = nsh_core::access::Capabilities::from_json(
            &serde_json::json!({ "webview": { "hosts": ["example.com"] } }),
        )
        .unwrap();
        let app = Access {
            declared: granted,
            granted: None,
        };
        for url in [
            "data:text/html,<p>x</p>",
            "buwiz://chat/new",
            "javascript:alert(1)",
        ] {
            assert!(!go(Some(dir), url), "not a web page: {url}");
            assert!(
                !navigation_allowed(Some(&app), None, Some(dir), true, url),
                "{url}"
            );
        }
        assert!(!navigation_allowed(
            Some(&app),
            None,
            Some(dir),
            true,
            "https://evil.example/a"
        ));
        assert!(
            navigation_allowed(
                Some(&app),
                None,
                Some(dir),
                true,
                "file:///tmp/opened/7f/a.pdf"
            ),
            "a JS app's own file page"
        );
        assert!(!navigation_allowed(
            Some(&app),
            None,
            None,
            true,
            "file:///tmp/opened/7f/a.pdf"
        ));
        assert!(navigation_allowed(
            Some(&app),
            None,
            None,
            true,
            "https://example.com/a"
        ));
        assert!(
            navigation_allowed(Some(&app), None, None, false, "file:///etc/passwd"),
            "a frame inside the page"
        );
    }

    #[test]
    fn a_blob_navigation_follows_the_origin_it_embeds() {
        let granted = nsh_core::access::Capabilities::from_json(
            &serde_json::json!({ "webview": { "hosts": ["example.com"] } }),
        )
        .unwrap();
        let app = Access {
            declared: granted,
            granted: None,
        };
        for url in [
            "blob:https://example.com/9f2",
            "blob:http://example.com:6711/uuid",
        ] {
            assert!(
                navigation_allowed(Some(&app), None, None, true, url),
                "{url}"
            );
        }
        for url in [
            "blob:https://evil.example/uuid",
            "blob:null/uuid",
            "blob:file:///etc/passwd",
        ] {
            assert!(
                !navigation_allowed(Some(&app), None, None, true, url),
                "{url}"
            );
        }
        // Nothing granted: a blob naming a host is still refused.
        let denied = Access {
            declared: nsh_core::access::Capabilities::from_json(&serde_json::json!({})).unwrap(),
            granted: None,
        };
        assert!(!navigation_allowed(
            Some(&denied),
            None,
            None,
            true,
            "blob:https://example.com/uuid"
        ));
        // HTTP(S) pages keep the grant they had.
        assert!(navigation_allowed(
            Some(&app),
            None,
            None,
            true,
            "https://example.com/a"
        ));
        assert!(!navigation_allowed(
            Some(&app),
            None,
            None,
            true,
            "https://evil.example/a"
        ));
    }

    #[test]
    fn quotes_js_strings() {
        assert_eq!(js_string("a\"b\\c\nd"), r#""a\"b\\c\nd""#);
        assert_eq!(js_string("\u{1}"), r#""\u0001""#);
    }

    #[test]
    fn registers_components() {
        let components = Components::default();
        let factory: ComponentFactory = Rc::new(|_| unreachable!("not made in this test"));
        // Clones share the registry.
        components.clone().register("com.example.map", factory);
        assert!(components.factory(&"com.example.map".into()).is_some());
        assert!(components.factory(&"com.example.none".into()).is_none());
        assert_eq!(format!("{components:?}"), r#"{"com.example.map"}"#);
    }
}
