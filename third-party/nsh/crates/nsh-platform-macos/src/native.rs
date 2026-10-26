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
//!   so apps without videos do not pay for them at launch.
//! - **Web views**: a `WKWebView` (WebKit, also loaded on first use) that
//!   takes the mouse, wheel and keyboard itself. Pages talk to the app
//!   through `window.nsh.postMessage` (a script message
//!   handler); top-level navigations stay within the app's `webview`
//!   capability. WebKit on macOS has no scroll view to turn off: with
//!   `scrollable={false}` the root's `hitTest:` keeps wheel and
//!   trackpad scrolls from the web view ([`passes_wheel`]), so they move
//!   the app's scroll views around it, as on iOS (the page itself still
//!   scrolls with its keys and its own scripts).
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
    ResizeMode, Size, VideoProps, ViewKind, WebProps, WebSource, geometry::Point,
};
use nsh_engine::{Access, App, EngineControl, Policy};
use objc2::{
    DefinedClass, Encode, Encoding, MainThreadMarker, MainThreadOnly, define_class, msg_send,
    rc::{Allocated, Retained},
    runtime::{AnyClass, AnyObject, Bool, ProtocolObject},
};
use objc2_app_kit::NSView;
use objc2_core_foundation::CGSize;
use objc2_foundation::{
    NSNotification, NSNotificationCenter, NSObject, NSObjectProtocol, NSOperationQueue, NSPoint,
    NSRect, NSString, NSURL,
};
use rustc_hash::{FxHashMap, FxHashSet};

use crate::{
    image::AssetBase,
    surface::Surface,
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

    /// Drops every control (the app stopped): media stops playing.
    pub(crate) fn clear(&self) {
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

/// Sets up a web view, video or component container.
pub(crate) fn create(surface: &Rc<Surface>, view: &NshView) {
    let host = match view.kind() {
        ViewKind::Video => Host::Video(VideoHost::new(surface, view)),
        ViewKind::WebView => {
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
    let host = surface.native.hosts.borrow_mut().remove(&view.id());
    drop(host);
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
        _ => {
            // WebKit may call the handler back synchronously (`stopLoading`
            // fails the navigation): the hosts are not borrowed meanwhile.
            let web = match surface.native.hosts.borrow().get(&view.id()) {
                Some(Host::Web(web)) => web.web.clone(),
                _ => None,
            };
            if let Some(web) = web {
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
    let Some(responder) = surface.root.ns().window().and_then(|w| w.firstResponder()) else {
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
                window.makeFirstResponder(Some(surface.root.ns()));
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

fn av_foundation() -> bool {
    static LOADED: OnceLock<bool> = OnceLock::new();
    *LOADED.get_or_init(|| load(c"/System/Library/Frameworks/AVFoundation.framework/AVFoundation"))
}

fn av_kit() -> bool {
    static LOADED: OnceLock<bool> = OnceLock::new();
    *LOADED.get_or_init(|| load(c"/System/Library/Frameworks/AVKit.framework/AVKit"))
}

fn webkit() -> bool {
    static LOADED: OnceLock<bool> = OnceLock::new();
    *LOADED.get_or_init(|| load(c"/System/Library/Frameworks/WebKit.framework/WebKit"))
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

    fn emit(&self, kind: EventKind, payload: impl FnOnce() -> EventPayload) {
        let listens = self
            .view
            .load()
            .and_then(|v| NshView::from_ns(&v))
            .is_some_and(|v| v.state().events.contains(kind));
        if !listens {
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
            Some(AssetBase::Directory(dir)) => Some(Location::Path(dir.join(path))),
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
        }
    }

    fn set(&mut self, p: &VideoProps, base: Option<&AssetBase>) {
        if !av_foundation() {
            return;
        }
        let old = self.props.take();
        let first = old.is_none();
        let old = old.unwrap_or_default();
        let reopened = first || p.source != old.source;
        if reopened {
            self.open(p.source.as_deref(), base);
        }
        if reopened || p.controls != old.controls {
            self.show(p.controls);
        }
        if reopened || p.progress_interval_ms != old.progress_interval_ms {
            self.observe(p.progress_interval_ms);
        }
        self.repeat.set(p.repeat);
        if let Some(player) = &self.player {
            // SAFETY: AVPlayer's documented API.
            unsafe {
                let _: () = msg_send![player, setMuted: Bool::new(p.muted)];
                let _: () = msg_send![player, setVolume: p.volume.clamp(0.0, 1.0)];
                if p.paused {
                    let _: () = msg_send![player, pause];
                } else {
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
        // SAFETY: AVPlayer's documented API.
        let player: Retained<AnyObject> = unsafe { msg_send![cls, playerWithURL: &*url] };
        self.emitter
            .emit(EventKind::LoadStart, || EventPayload::None);
        // The end of the item: report it, and loop if asked.
        // SAFETY: AVPlayer's documented API.
        let item: Option<Retained<AnyObject>> = unsafe { msg_send![&player, currentItem] };
        let (emitter, repeat) = (self.emitter.clone(), self.repeat.clone());
        let weak_player = objc2::rc::Weak::from_retained(&player);
        let block = RcBlock::new(move |_: NonNull<NSNotification>| {
            emitter.emit(EventKind::End, || EventPayload::None);
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
        if let Some(player) = &self.player {
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
    }
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
            let allowed = !main
                || url.is_empty()
                || self
                    .ivars()
                    .access
                    .as_ref()
                    .is_none_or(|a| a.allows_webview(&url));
            if !allowed {
                log::warn!(target: "js", "web view navigation to {url} is not granted");
                let message = format!("navigation to {url} is not granted");
                self.emit(EventKind::Error, || {
                    EventPayload::Map(vec![
                        ("message", PayloadValue::Str(message)),
                        ("url", PayloadValue::Str(url)),
                    ])
                });
            }
            // WKNavigationActionPolicyCancel = 0, Allow = 1.
            decide.call((allowed as isize,));
        }

        #[unsafe(method(webView:didStartProvisionalNavigation:))]
        fn did_start(&self, web: &AnyObject, _navigation: Option<&AnyObject>) {
            self.emit(EventKind::LoadStart, || navigation_state(web, true));
            self.emit(EventKind::NavigationStateChange, || {
                navigation_state(web, true)
            });
        }

        #[unsafe(method(webView:didFinishNavigation:))]
        fn did_finish(&self, web: &AnyObject, _navigation: Option<&AnyObject>) {
            self.emit(EventKind::Load, || navigation_state(web, false));
            self.emit(EventKind::NavigationStateChange, || {
                navigation_state(web, false)
            });
        }

        #[unsafe(method(webView:didFailNavigation:withError:))]
        fn did_fail(&self, _web: &AnyObject, _navigation: Option<&AnyObject>, error: &AnyObject) {
            self.failed(error);
        }

        #[unsafe(method(webView:didFailProvisionalNavigation:withError:))]
        fn did_fail_provisional(
            &self,
            _web: &AnyObject,
            _navigation: Option<&AnyObject>,
            error: &AnyObject,
        ) {
            self.failed(error);
        }
    }
);

impl WebHandler {
    fn new(mtm: MainThreadMarker, emitter: Emitter, access: Option<Arc<Access>>) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(WebIvars { emitter, access });
        // SAFETY: NSObject's designated initializer.
        unsafe { msg_send![super(this), init] }
    }

    fn emit(&self, kind: EventKind, payload: impl FnOnce() -> EventPayload) {
        self.ivars().emitter.emit(kind, payload);
    }

    fn failed(&self, err: &AnyObject) {
        // SAFETY: `localizedDescription` of an NSError.
        let message: Retained<NSString> = unsafe { msg_send![err, localizedDescription] };
        self.emit(EventKind::Error, || error(message.to_string()));
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

/// A web view: the `WKWebView` (when WebKit loads) filling its node's view.
struct WebHost {
    /// The node's view, which hosts the web view.
    holder: objc2::rc::Weak<ViewObj>,
    web: Option<Retained<AnyObject>>,
    handler: Retained<WebHandler>,
    /// The props applied (`None` before the first).
    props: Option<WebProps>,
    /// The page scrolls with the wheel and the trackpad
    /// (`scrollable`).
    scrolls: bool,
}

impl WebHost {
    fn new(surface: &Rc<Surface>, view: &NshView, access: Option<Arc<Access>>) -> Self {
        let handler = WebHandler::new(surface.mtm, Emitter::new(surface, view), access);
        let web = webkit().then(|| {
            // SAFETY: WebKit's documented API, sent dynamically; the handler
            // is unregistered when the host is dropped; a WKWebView is an
            // NSView.
            unsafe {
                let config: Retained<AnyObject> = msg_send![class(c"WKWebViewConfiguration")?, new];
                let content: Retained<AnyObject> = msg_send![&config, userContentController];
                let _: () = msg_send![
                    &content,
                    addScriptMessageHandler: &*handler,
                    name: &*NSString::from_str("nsh")
                ];
                let alloc: Allocated<AnyObject> = msg_send![class(c"WKWebView")?, alloc];
                let web: Retained<AnyObject> = msg_send![
                    alloc,
                    initWithFrame: NSRect::ZERO,
                    configuration: &*config
                ];
                let _: () = msg_send![&web, setNavigationDelegate: &*handler];
                // Transparent by default (WebKit paints white otherwise): a
                // page without a background shows the view behind it, the
                // way `backgroundColor` on the node expects.
                let no: Retained<AnyObject> = msg_send![class(c"NSNumber")?, numberWithBool: false];
                let _: () = msg_send![&web, setValue: &*no, forKey: &*NSString::from_str("drawsBackground")];
                crate::surface::quiet(|| fill(view, as_view(&web)));
                Some(web)
            }
        });
        WebHost {
            holder: objc2::rc::Weak::new(&**view),
            web: web.flatten(),
            handler,
            props: None,
            scrolls: true,
        }
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
        let Some(web) = &self.web else { return };
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
            let prefs: Retained<AnyObject> = msg_send![&config, defaultWebpagePreferences];
            let _: () =
                msg_send![&prefs, setAllowsContentJavaScript: Bool::new(p.javascript_enabled)];
            // Scripts apply to pages loaded from now on: load again.
            if first || p.source != old.source || scripts_changed {
                match &p.source {
                    WebSource::Uri(uri) => {
                        if let (Some(url), Some(cls)) = (
                            NSURL::URLWithString(&NSString::from_str(uri)),
                            class(c"NSURLRequest"),
                        ) {
                            let request: Retained<AnyObject> =
                                msg_send![cls, requestWithURL: &*url];
                            let _: Option<Retained<AnyObject>> =
                                msg_send![web, loadRequest: &*request];
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
        self.props = Some(p.clone());
    }
}

impl Drop for WebHost {
    fn drop(&mut self) {
        let Some(web) = &self.web else { return };
        // SAFETY: breaks the cycle web view → content controller → handler
        // and stops the page.
        unsafe {
            let _: () = msg_send![web, stopLoading];
            let _: () = msg_send![web, setNavigationDelegate: std::ptr::null::<AnyObject>()];
            let config: Retained<AnyObject> = msg_send![web, configuration];
            let content: Retained<AnyObject> = msg_send![&config, userContentController];
            let _: () = msg_send![
                &content,
                removeScriptMessageHandlerForName: &*NSString::from_str("nsh")
            ];
        }
        let _ = &self.handler;
    }
}

/// `reload()`, `goBack()`, `goForward()`, `stopLoading()`,
/// `injectJavaScript()` and `postMessage()`.
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
            _ => {}
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
