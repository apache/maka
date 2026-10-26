//! Native controls (videos, web views) and the native components the
//! embedding app registers (`nsh/native`'s `nativeComponent`).
//!
//! Each control is a GTK widget hosted in its node's view
//! ([`NshView::set_native`]) filling it: the view keeps decoration,
//! frames, touches and accessibility, as for any view, and resizes the
//! widget with its frame ([`fill`]).
//!
//! - **Videos** play through GTK's media support (`gtk::MediaFile`, which
//!   GTK backs with GStreamer): a `gtk::Picture` showing the stream, or a
//!   `gtk::Video` with GTK's playback controls when `controls` is set.
//!   GTK streams have no playback rate, so `rate` is ignored (warned once);
//!   a looping stream starts over without ending, so `onEnd` only comes
//!   for videos that do not loop.
//!   A stream GStreamer cannot play (no plug-in for its container or
//!   codec) reports `onError` (logged once, with a hint) and stops; it
//!   never reports `onLoad`.
//! - **Web views** (feature `webview`): a `WebKitWebView` (WebKitGTK 6.0)
//!   filling the view, see `web`. Without the feature (nsh built without
//!   WebKitGTK), a web view shows a neutral placeholder and ignores its
//!   commands.
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
    rc::{Rc, Weak},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use gtk4::{self as gtk, gio, glib, prelude::*};
use nsh_core::{
    Bounds, Command, EventKind, EventPayload, JsonValue, NativeProps, NodeId, PayloadValue, Points,
    ResizeMode, Size, VideoProps, ViewKind, geometry::Point,
};
use nsh_engine::EngineControl;
use rustc_hash::{FxHashMap, FxHashSet};

use crate::{image::AssetBase, surface::Surface, view::NshView};

#[cfg(feature = "webview")]
mod web;

/// A native component made by a registered factory.
///
/// ```no_run
/// use gtk::prelude::*;
/// use nsh_platform_linux::{NativeComponent, gtk4 as gtk};
///
/// /// A label the app shows with a `text` prop.
/// struct Badge(gtk::Label);
///
/// impl NativeComponent for Badge {
///     fn widget(&self) -> gtk::Widget {
///         self.0.clone().upcast()
///     }
///
///     fn set_prop(&mut self, name: &str, value: Option<&serde_json::Value>) {
///         if name == "text" {
///             self.0
///                 .set_text(value.and_then(|v| v.as_str()).unwrap_or(""));
///         }
///     }
/// }
/// ```
pub trait NativeComponent {
    /// Its widget; it fills the container nsh lays out.
    fn widget(&self) -> gtk::Widget;

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
    /// What the running app may reach (web view navigations); `None`
    /// before an app starts.
    #[cfg(feature = "webview")]
    access: RefCell<Option<Arc<nsh_engine::Access>>>,
    /// The application id: web views keep their data under it.
    #[cfg(feature = "webview")]
    app_id: RefCell<String>,
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

    /// What the app that starts may reach: web views keep their
    /// navigations within its `webview` capability.
    #[cfg(feature = "webview")]
    pub(crate) fn set_access(&self, access: Arc<nsh_engine::Access>) {
        *self.access.borrow_mut() = Some(access);
    }

    /// What the app that starts may reach (nothing to keep without web
    /// views).
    #[cfg(not(feature = "webview"))]
    pub(crate) fn set_access(&self, _access: Arc<nsh_engine::Access>) {}

    /// The application id ([`crate::AppOptions::app_id`]): web views keep
    /// their data in `$XDG_DATA_HOME/<app id>/webkit`.
    #[cfg(feature = "webview")]
    pub(crate) fn set_app_id(&self, app_id: &str) {
        *self.app_id.borrow_mut() = app_id.to_owned();
    }

    /// The application id (nothing to keep without web views).
    #[cfg(not(feature = "webview"))]
    pub(crate) fn set_app_id(&self, _app_id: &str) {}

    /// Whether any web view is mounted (input then keeps pointer events
    /// from the parts of pages nsh clips off).
    #[cfg(feature = "webview")]
    pub(crate) fn has_pages(&self) -> bool {
        self.hosts
            .borrow()
            .values()
            .any(|h| matches!(h, Host::Web(_)))
    }

    /// Whether any web view is mounted: never without WebKitGTK.
    #[cfg(not(feature = "webview"))]
    pub(crate) fn has_pages(&self) -> bool {
        false
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
    #[cfg(feature = "webview")]
    Web(web::WebHost),
    /// A web view's placeholder (kept by the view).
    #[cfg(not(feature = "webview"))]
    Web,
    /// A registered component; `None` until named, or when unknown.
    Component(Option<Box<dyn NativeComponent>>),
}

/// Sets up a web view, video or component container.
pub(crate) fn create(surface: &Rc<Surface>, view: &NshView) {
    let host = match view.kind() {
        ViewKind::Video => Host::Video(VideoHost::new(surface, view)),
        #[cfg(feature = "webview")]
        ViewKind::WebView => Host::Web(web::WebHost::new(surface, view)),
        #[cfg(not(feature = "webview"))]
        ViewKind::WebView => {
            static WARNED: AtomicBool = AtomicBool::new(false);
            if !WARNED.swap(true, Ordering::Relaxed) {
                log::warn!(
                    target: "js",
                    "WebView is not available: nsh is built without WebKitGTK (feature `webview` of nsh-platform-linux); it shows a placeholder"
                );
            }
            // Gray reads on light and dark apps alike.
            let label = gtk::Label::new(None);
            label.set_markup(
                "<span foreground=\"#8c8c8c\">WebView is not available on Linux</span>",
            );
            label.set_wrap(true);
            // Small boxes clip the text rather than overflow.
            label.set_ellipsize(gtk::pango::EllipsizeMode::End);
            label.set_lines(3);
            label.set_justify(gtk::Justification::Center);
            label.set_halign(gtk::Align::Center);
            label.set_valign(gtk::Align::Center);
            label.set_can_target(false);
            fill(view, label.upcast_ref());
            Host::Web
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

/// `NativeProps`.
pub(crate) fn props(surface: &Rc<Surface>, view: &NshView, props: &NativeProps) {
    let mut hosts = surface.native.hosts.borrow_mut();
    match (hosts.get_mut(&view.id()), props) {
        (Some(Host::Video(video)), NativeProps::Video(p)) => {
            let base = surface.native.asset_base.borrow();
            video.set(view, p, base.as_ref());
        }
        #[cfg(feature = "webview")]
        (Some(Host::Web(web)), NativeProps::WebView(p)) => web.set(view, p),
        // Nothing to configure on the placeholder.
        #[cfg(not(feature = "webview"))]
        (Some(Host::Web), NativeProps::WebView(_)) => {}
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
    fill(view, &made.widget());
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
        #[cfg(feature = "webview")]
        _ => {
            // Outside the hosts' borrow: WebKit may call back at once.
            let web = match surface.native.hosts.borrow().get(&view.id()) {
                Some(Host::Web(web)) => Some(web.web()),
                _ => None,
            };
            if let Some(web) = web {
                web::command(&web, command);
            }
        }
        // Web view commands: the placeholder has no page.
        #[cfg(not(feature = "webview"))]
        _ => {}
    }
}

/// The web view `widget` is, or is inside (up to its node's view).
#[cfg(feature = "webview")]
pub(crate) fn page_of(widget: &gtk::Widget) -> Option<gtk::Widget> {
    let mut current = Some(widget.clone());
    while let Some(w) = current {
        if w.is::<webkit6::WebView>() {
            return Some(w);
        }
        if w.is::<NshView>() {
            return None;
        }
        current = w.parent();
    }
    None
}

/// The web view `widget` is in: none without WebKitGTK.
#[cfg(not(feature = "webview"))]
pub(crate) fn page_of(_widget: &gtk::Widget) -> Option<gtk::Widget> {
    None
}

/// The CSS class of a web view whose page does not scroll
/// (`scrollable: false`): wheels over it go to the scroll views around
/// it (`crate::input`).
pub(crate) const UNSCROLLABLE: &str = "nsh-unscrollable";

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

/// Hosts `widget` in `view`, filling it at every frame.
fn fill(view: &NshView, widget: &gtk::Widget) {
    host(view, widget, false);
}

/// Hosts `widget` in `view` like [`fill`], mapped only while the view has
/// a size. WebKit sizes a page's surface from its widget: mapped at 0 × 0
/// (a view's frame comes after the view) and resized a frame later, a
/// page sometimes never presents a frame and stays blank for good.
#[cfg(feature = "webview")]
fn fill_sized(view: &NshView, widget: &gtk::Widget) {
    host(view, widget, true);
}

fn host(view: &NshView, widget: &gtk::Widget, sized: bool) {
    let frame = view.state().frame;
    let has_size = |rect: Bounds<Points>| rect.size.width.0 >= 1.0 && rect.size.height.0 >= 1.0;
    let rect = bounds(frame.size.width.0, frame.size.height.0);
    view.set_native(widget, rect);
    // After `set_native`: parenting makes a widget child visible.
    if sized {
        widget.set_child_visible(has_size(rect));
    }
    let weak = view.downgrade();
    let hosted = widget.downgrade();
    // Runs at the start of the view's allocation, before it places its
    // natives: no allocation needs to be queued.
    view.on_resize(move |_, _| {
        if let Some(view) = weak.upgrade() {
            let mut s = view.state_mut();
            let rect = bounds(s.frame.size.width.0, s.frame.size.height.0);
            for native in &mut s.natives {
                native.rect = rect;
            }
            drop(s);
            if sized && let Some(widget) = hosted.upgrade() {
                widget.set_child_visible(has_size(rect));
            }
        }
    });
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

/// Where a video's source is.
#[derive(Debug, PartialEq)]
enum Location {
    /// A URI GStreamer opens (`https://`, `file://`, ...).
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

/// Sends a control's events to JS, when JS listens to them.
#[derive(Clone)]
struct Emitter {
    surface: Weak<Surface>,
    view: glib::WeakRef<NshView>,
    id: NodeId,
}

impl Emitter {
    fn emit(&self, kind: EventKind, payload: impl FnOnce() -> EventPayload) {
        let listens = self
            .view
            .upgrade()
            .is_some_and(|v| v.state().events.contains(kind));
        if !listens {
            return;
        }
        if let Some(surface) = self.surface.upgrade() {
            surface.event(self.id, kind, payload());
        }
    }
}

/// What a video reported so far.
#[derive(Default)]
struct Status {
    loaded: Cell<bool>,
    failed: Cell<bool>,
    buffering: Cell<bool>,
    /// Playing was asked for (applied again once the stream is prepared).
    playing: Cell<bool>,
}

impl Status {
    fn set_buffering(&self, emitter: &Emitter, buffering: bool) {
        if self.buffering.replace(buffering) != buffering {
            emitter.emit(EventKind::Buffer, || {
                EventPayload::Map(vec![("isBuffering", PayloadValue::Bool(buffering))])
            });
        }
    }
}

/// A video: its stream and the widget showing it.
struct VideoHost {
    emitter: Emitter,
    /// A `Picture`, or a `Video` with controls.
    widget: Option<gtk::Widget>,
    stream: Option<gtk::MediaFile>,
    status: Rc<Status>,
    /// The props applied (`None` before the first).
    props: Option<VideoProps>,
    /// Reports `onProgress`.
    progress: Option<glib::SourceId>,
}

impl VideoHost {
    fn new(surface: &Rc<Surface>, view: &NshView) -> Self {
        VideoHost {
            emitter: Emitter {
                surface: Rc::downgrade(surface),
                view: view.downgrade(),
                id: view.id(),
            },
            widget: None,
            stream: None,
            status: Rc::default(),
            props: None,
            progress: None,
        }
    }

    fn set(&mut self, view: &NshView, p: &VideoProps, base: Option<&AssetBase>) {
        let old = self.props.take();
        let first = old.is_none();
        let old = old.unwrap_or_default();
        let reopened = first || p.source != old.source;
        if reopened {
            self.open(p.source.as_deref(), base);
        }
        if reopened || p.controls != old.controls {
            self.show(view, p.controls);
        }
        if p.rate != 1.0 {
            static WARNED: AtomicBool = AtomicBool::new(false);
            if !WARNED.swap(true, Ordering::Relaxed) {
                log::warn!(target: "js", "Video `rate` is not supported on Linux: it plays at 1×");
            }
        }
        if let Some(stream) = &self.stream {
            stream.set_muted(p.muted);
            stream.set_volume(p.volume.clamp(0.0, 1.0) as f64);
            stream.set_loop(p.repeat);
            self.status.playing.set(!p.paused);
            stream.set_playing(!p.paused && !self.status.failed.get());
            let waiting = !p.paused && !self.status.loaded.get() && !self.status.failed.get();
            self.status.set_buffering(&self.emitter, waiting);
        }
        if let Some(widget) = &self.widget {
            if let Some(picture) = widget.downcast_ref::<gtk::Picture>() {
                picture.set_content_fit(match p.resize_mode {
                    ResizeMode::Cover => gtk::ContentFit::Cover,
                    ResizeMode::Stretch => gtk::ContentFit::Fill,
                    // GTK draws no picture at its natural size in a box of
                    // another: `center` shrinks it to fit, as `scale-down`.
                    ResizeMode::Center | ResizeMode::ScaleDown => gtk::ContentFit::ScaleDown,
                    ResizeMode::Contain => gtk::ContentFit::Contain,
                });
            } else if let Some(video) = widget.downcast_ref::<gtk::Video>() {
                video.set_loop(p.repeat);
            }
        }
        if reopened || p.progress_interval_ms != old.progress_interval_ms {
            self.observe(p.progress_interval_ms);
        }
        self.props = Some(p.clone());
    }

    /// Opens `source` (or nothing).
    fn open(&mut self, source: Option<&str>, base: Option<&AssetBase>) {
        self.close();
        self.status = Rc::default();
        let Some(source) = source else { return };
        let file = match locate(source, base) {
            Some(Location::Uri(uri)) => gio::File::for_uri(&uri),
            Some(Location::Path(path)) => gio::File::for_path(path),
            None => {
                self.status.failed.set(true);
                let message = format!("{source}: no asset directory to resolve it from");
                self.emitter.emit(EventKind::Error, || error(message));
                return;
            }
        };
        let stream = gtk::MediaFile::for_file(&file);
        self.emitter
            .emit(EventKind::LoadStart, || EventPayload::None);
        let (emitter, status) = (self.emitter.clone(), self.status.clone());
        stream.connect_prepared_notify(move |stream| loaded(stream, &emitter, &status));
        // The picture's size is known with the first frame, which may come
        // after `prepared`.
        let (emitter, status) = (self.emitter.clone(), self.status.clone());
        stream.connect_invalidate_size(move |stream| {
            if let Some(stream) = stream.downcast_ref::<gtk::MediaFile>() {
                loaded(stream, &emitter, &status);
            }
        });
        let emitter = self.emitter.clone();
        stream.connect_ended_notify(move |stream| {
            if stream.is_ended() {
                emitter.emit(EventKind::End, || EventPayload::None);
            }
        });
        let (emitter, status) = (self.emitter.clone(), self.status.clone());
        let name = source.to_owned();
        stream.connect_error_notify(move |stream| {
            let Some(err) = stream.error() else { return };
            if status.failed.replace(true) {
                return;
            }
            // Nothing plays: no progress, and the app hears it stopped.
            stream.set_playing(false);
            let message = media_error(err.message());
            log::warn!(target: "js", "video {name}: {message}");
            status.set_buffering(&emitter, false);
            emitter.emit(EventKind::Error, || error(message));
        });
        self.stream = Some(stream);
    }

    /// Stops and drops the stream.
    fn close(&mut self) {
        if let Some(stream) = self.stream.take() {
            stream.set_playing(false);
            stream.clear();
        }
    }

    /// Shows the stream with or without GTK's controls.
    fn show(&mut self, view: &NshView, controls: bool) {
        if let Some(old) = self.widget.take() {
            view.remove_native(&old);
        }
        let widget: gtk::Widget = if controls {
            let video = gtk::Video::new();
            // nsh drives playback (`paused`), not the widget.
            video.set_autoplay(false);
            video.set_media_stream(self.stream.as_ref());
            video.upcast()
        } else {
            let picture = gtk::Picture::new();
            picture.set_can_shrink(true);
            picture.set_paintable(self.stream.as_ref());
            // Touches go to the view (presses, gestures).
            picture.set_can_target(false);
            picture.upcast()
        };
        fill(view, &widget);
        self.widget = Some(widget);
    }

    /// Reports `onProgress` every `interval_ms` while playing.
    fn observe(&mut self, interval_ms: f32) {
        if let Some(id) = self.progress.take() {
            id.remove();
        }
        let Some(stream) = self.stream.as_ref().map(|s| s.downgrade()) else {
            return;
        };
        let emitter = self.emitter.clone();
        let interval = Duration::from_millis(interval_ms.max(16.0) as u64);
        self.progress = Some(glib::timeout_add_local(interval, move || {
            if let Some(stream) = stream.upgrade()
                && stream.is_playing()
                && stream.is_prepared()
            {
                emitter.emit(EventKind::Progress, || {
                    EventPayload::Map(vec![
                        ("currentTime", seconds(stream.timestamp())),
                        ("duration", seconds(stream.duration())),
                    ])
                });
            }
            glib::ControlFlow::Continue
        }));
    }

    fn seek(&self, seconds: f64) {
        if let Some(stream) = &self.stream
            && stream.is_seekable()
        {
            stream.seek((seconds.max(0.0) * 1e6) as i64);
        }
    }
}

impl Drop for VideoHost {
    fn drop(&mut self) {
        if let Some(id) = self.progress.take() {
            id.remove();
        }
        // A removal animation may keep the view on screen a little longer:
        // it shows the last frame, without the stream.
        if let Some(picture) = self
            .widget
            .as_ref()
            .and_then(|w| w.downcast_ref::<gtk::Picture>())
        {
            let still = picture.paintable().map(|p| p.current_image());
            picture.set_paintable(still.as_ref());
        }
        self.close();
    }
}

/// Reports the load once the stream is prepared and its size is known.
fn loaded(stream: &gtk::MediaFile, emitter: &Emitter, status: &Status) {
    // A stream that failed (GStreamer prepares one with no streams when it
    // has no plug-in for them) never loads.
    if status.loaded.get() || status.failed.get() || !stream.is_prepared() {
        return;
    }
    if !stream.has_video() && !stream.has_audio() {
        return;
    }
    let (width, height) = (stream.intrinsic_width(), stream.intrinsic_height());
    if stream.has_video() && width <= 0 {
        return;
    }
    status.loaded.set(true);
    // Playing asked for before the pipeline was ready.
    if status.playing.get() && !stream.is_playing() {
        stream.set_playing(true);
    }
    status.set_buffering(emitter, false);
    emitter.emit(EventKind::Load, || {
        EventPayload::Map(vec![
            ("duration", seconds(stream.duration())),
            ("width", PayloadValue::Number(width as f64)),
            ("height", PayloadValue::Number(height as f64)),
        ])
    });
}

/// GTK's microseconds as seconds.
fn seconds(us: i64) -> PayloadValue {
    PayloadValue::Number(us as f64 / 1e6)
}

/// What GStreamer's error says, for apps: its first line without the
/// element path (GstPlay puts the debug details on further lines), and a
/// hint when a plug-in is missing.
fn media_error(message: &str) -> String {
    let line = message.lines().next().unwrap_or(message).trim();
    let line = match line.strip_prefix("Error from element ") {
        Some(rest) => rest.split_once(": ").map_or(rest, |(_, m)| m),
        None => line,
    };
    if message.contains("missing a plug-in") || message.contains("No suitable plugins") {
        return format!(
            "{line} No installed GStreamer plug-in can play this format \
             (H.264 / AAC need gst-libav or gst-plugins-ugly / -bad)."
        );
    }
    line.to_owned()
}

fn error(message: String) -> EventPayload {
    EventPayload::Map(vec![("message", PayloadValue::Str(message))])
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
            locate("/home/me/a.mp4", None),
            Some(Location::Path("/home/me/a.mp4".into()))
        );
        assert_eq!(locate("", None), None);
    }

    #[test]
    fn words_media_errors() {
        let gst = "Error from element /GstPlayBin3:playbin3/GstDecodebin3:decodebin3-0: \
                   Your GStreamer installation is missing a plug-in.\n\
                   Your GStreamer installation is missing a plug-in.\n\
                   ../gstdecodebin3.c(3258): mq_slot_check_reconfiguration (): /GstPlayBin3\n\
                   No suitable plugins found";
        let message = media_error(gst);
        assert!(message.starts_with("Your GStreamer installation is missing a plug-in. No"));
        assert!(!message.contains('\n'));
        assert_eq!(media_error("Resource not found."), "Resource not found.");
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
