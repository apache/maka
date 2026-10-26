//! Native controls (videos, web views) and the native components the
//! embedding app registers (`nsh/native`'s `nativeComponent`).
//!
//! Each control is an item its node's view hosts ([`NshView::set_native`])
//! filling it: the view keeps decoration, frames, touches and
//! accessibility, as for any view, and [`resized`] keeps the item at the
//! view's bounds.
//!
//! - **Registered components** render *GPUI elements*:
//!   [`crate::AppView::register_component`] names a factory; the core
//!   creates a [`ViewKind::Native`] container, names the component
//!   ([`MountItem::Component`]) and sends its props as JSON as they change.
//!   Every frame, the surface element's prepaint asks each visible
//!   component for its element ([`NativeComponent::render`]: any GPUI or
//!   GPUI Kit element, an `Entity` view of the app's own included), lays it
//!   out at its container's box in the window and prepaints it there,
//!   clipped to the container's clipping ancestors ([`prepaint`]); the
//!   element is painted where the tree draws its container, so nsh content
//!   drawn above it covers it. A hitbox that blocks the mouse goes under
//!   the element: the component's own hitboxes take the pointer and the
//!   wheel over its box, nsh's input does not. Keys go to the component
//!   first while focus is inside it ([`focused`]); those it lets through
//!   reach the window's shortcuts, the app's bindings and the menu's
//!   shortcuts as from a text field ([`crate::input::component_key`]); a component with a focus
//!   handle ([`NativeComponent::focus_handle`]) is a Tab stop among the text
//!   fields, at its container's place ([`crate::input`], [`apply_focus`]).
//!   GPUI's content masks are rectangles: a rounded clipping ancestor cuts
//!   a component's element (and a web view) to its rectangle only. Components emit events and
//!   report their own size through their [`ComponentContext`], from any
//!   thread. Registries belong to one `AppView` (and the views made from
//!   the same [`crate::AppOptions`]): no globals.
//! - **Web views** ([`web`]) are wry web views in GPUI Fast native
//!   composition surfaces, placed at their view's box by every prepaint.
//! - **Videos** ([`video`]).
//!
//! Every control belongs to its surface ([`NativeState`]): stopping the app
//! drops them, so media stops playing and web views close.
//!
//! [`MountItem::Component`]: nsh_core::MountItem::Component

mod video;
mod web;

use std::{
    cell::RefCell,
    rc::{Rc, Weak},
    sync::Arc,
};

use gpui::{
    AnyElement, App, AvailableSpace, Bounds, ContentMask, FocusHandle, HitboxBehavior, IntoElement,
    ParentElement, Pixels, Styled, Window, px,
};
use nsh_core::{
    Command, EventKind, EventPayload, NativeProps, NodeId, PayloadValue, Points, Size, ViewKind,
};
use nsh_engine::{Access, EngineControl};
use rustc_hash::{FxHashMap, FxHashSet};
use serde_json::Value as JsonValue;

use crate::{
    image::AssetBase,
    render::DrawCx,
    surface::Surface,
    view::{Hosted, NshView},
};

/// A native component made by a registered factory: GPUI content that the
/// app embedding nsh lays into an nsh layout.
///
/// ```no_run
/// use nsh_platform_gpui::{
///     ComponentContext, NativeComponent,
///     gpui::{
///         AnyElement, App, InteractiveElement, IntoElement, ParentElement,
///         StatefulInteractiveElement, Styled, Window, div, rgb,
///     },
/// };
///
/// /// A label the app sets with a `text` prop; clicks emit `tap`.
/// struct Badge {
///     cx: ComponentContext,
///     text: String,
/// }
///
/// impl NativeComponent for Badge {
///     fn render(&mut self, _window: &mut Window, _cx: &mut App) -> Option<AnyElement> {
///         let context = self.cx.clone();
///         Some(
///             div()
///                 .id("badge")
///                 .size_full()
///                 .bg(rgb(0x8250df))
///                 .text_color(rgb(0xffffff))
///                 .child(self.text.clone())
///                 .on_click(move |_, _, _| context.emit("tap", serde_json::json!({})))
///                 .into_any_element(),
///         )
///     }
///
///     fn set_prop(
///         &mut self,
///         name: &str,
///         value: Option<&serde_json::Value>,
///         _window: &mut Window,
///         _cx: &mut App,
///     ) {
///         if name == "text" {
///             self.text = value.and_then(|v| v.as_str()).unwrap_or("").to_owned();
///         }
///     }
/// }
/// ```
pub trait NativeComponent {
    /// The GPUI element showing the component, laid out at its container's
    /// box (it is given exactly that size) and painted where nsh draws the
    /// container. Called on every frame of the surface while the container
    /// is visible; `None` draws nothing. Ask for a frame with
    /// [`ComponentContext::redraw`] when what it shows changes (an
    /// `Entity` the element shows redraws by itself when notified).
    fn render(&mut self, window: &mut Window, cx: &mut App) -> Option<AnyElement> {
        let _ = (window, cx);
        None
    }

    /// Where the last frame drew the container, in window coordinates, or
    /// `None` when it was not drawn: for components that move a native
    /// surface of their own with it.
    fn placed(&mut self, bounds: Option<Bounds<Pixels>>) {
        let _ = bounds;
    }

    /// The focus handle Tab moves to (a clone of the widget's), if the
    /// component takes the keyboard: it joins the surface's Tab order with
    /// its text fields, at the container's place in the tree.
    fn focus_handle(&self) -> Option<FocusHandle> {
        None
    }

    /// Prop `name` changed (`None`: removed). Every prop the app set comes
    /// right after the component is made. Delivered with the next frame of
    /// the surface, before [`NativeComponent::render`], with its window:
    /// the component may update its entities here.
    fn set_prop(
        &mut self,
        name: &str,
        value: Option<&JsonValue>,
        window: &mut Window,
        cx: &mut App,
    );

    /// JS called `ref.command(name, args)`. Delivered as props are, in
    /// order with them.
    fn command(&mut self, name: &str, args: &JsonValue, window: &mut Window, cx: &mut App) {
        let _ = (name, args, window, cx);
    }

    /// Prop `name`, bound to an animated value, moved to `value` (on the
    /// frames it changes, without JS; delivered as props are). By default,
    /// [`Self::set_prop`] with a JSON number.
    fn set_animated_number(&mut self, name: &str, value: f64, window: &mut Window, cx: &mut App) {
        let json = serde_json::Number::from_f64(value).map_or(JsonValue::Null, JsonValue::Number);
        self.set_prop(name, Some(&json), window, cx);
    }

    /// Prop `name`, bound to an animated color, moved to `argb`
    /// (`0xAARRGGBB`). By default, [`Self::set_prop`] with a JSON number.
    fn set_animated_color(&mut self, name: &str, argb: u32, window: &mut Window, cx: &mut App) {
        self.set_prop(name, Some(&JsonValue::from(argb)), window, cx);
    }
}

/// What a component can tell its app. Cheap to clone; usable from any
/// thread.
#[derive(Clone)]
pub struct ComponentContext {
    id: NodeId,
    control: EngineControl,
    /// The surface's key, to draw again from any thread.
    surface: u64,
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

    /// What the component shows changed: the surface draws again, asking
    /// for its element (from any thread).
    pub fn redraw(&self) {
        let key = self.surface;
        crate::rt::invoke(move || {
            if let Some(surface) = Surface::by_key(key) {
                surface.invalidate();
            }
        });
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
    /// What the running app may reach (web view navigations).
    access: RefCell<Option<Arc<Access>>>,
    /// The controls, by node.
    hosts: RefCell<FxHashMap<NodeId, Host>>,
    /// The focus handles inside components that the last prepaint found
    /// focused, with their nodes: keys go to them, not to nsh.
    focused: RefCell<Vec<(NodeId, FocusHandle)>>,
    /// An explicit focus transfer, resolved by [`apply_focus`].
    tab_to: std::cell::Cell<Option<FocusTarget>>,
}

/// One explicit native focus transfer, consumed with the real window.
#[derive(Clone, Copy)]
enum FocusTarget {
    Component(NodeId),
    Surface,
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

    /// What the app that starts may reach: web views keep their top-level
    /// navigations within its `webview` capability.
    pub(crate) fn set_access(&self, access: Arc<Access>) {
        *self.access.borrow_mut() = Some(access);
    }

    /// Drops every control (the app stopped): media stops playing.
    pub(crate) fn clear(&self) {
        let hosts = std::mem::take(&mut *self.hosts.borrow_mut());
        drop(hosts);
        self.focused.borrow_mut().clear();
        self.tab_to.set(None);
    }
}

/// What a native view holds.
enum Host {
    Video(Rc<video::VideoItem>),
    Web(Rc<web::WebItem>),
    Component(Rc<ComponentItem>),
}

impl Host {
    fn item(&self) -> Rc<dyn Hosted> {
        match self {
            Host::Video(v) => v.clone(),
            Host::Web(w) => w.clone(),
            Host::Component(c) => c.clone(),
        }
    }

    /// The host's item, cloned out of the map so that no borrow of it is
    /// held while the control runs.
    fn item_ref(&self) -> HostRef {
        match self {
            Host::Video(v) => HostRef::Video(v.clone()),
            Host::Web(w) => HostRef::Web(w.clone()),
            Host::Component(c) => HostRef::Component(c.clone()),
        }
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        // The item may outlive its control in its view (a removal
        // animation keeps the view on screen a little longer): it shows the
        // last frame of a video, and nothing of a web view.
        match self {
            Host::Video(v) => v.close(),
            Host::Web(w) => w.close(),
            Host::Component(c) => c.close(),
        }
    }
}

/// A host's item ([`Host::item_ref`]).
enum HostRef {
    Video(Rc<video::VideoItem>),
    Web(Rc<web::WebItem>),
    Component(Rc<ComponentItem>),
}

/// Sets up a web view, video or component container.
pub(crate) fn create(surface: &Rc<Surface>, view: &NshView) {
    let id = view.id();
    let host = match view.kind() {
        ViewKind::Video => Host::Video(video::VideoItem::new(surface, id)),
        ViewKind::WebView => Host::Web(web::WebItem::new(surface, id)),
        _ => Host::Component(Rc::new(ComponentItem {
            surface: Rc::downgrade(surface),
            id,
            component: RefCell::new(None),
            element: RefCell::new(None),
            pending: RefCell::default(),
        })),
    };
    fill(view, &host.item());
    surface.native.hosts.borrow_mut().insert(id, host);
}

/// A view was deleted: its control stops (a removal animation may keep
/// the view on screen a little longer).
pub(crate) fn deleted(surface: &Rc<Surface>, view: &NshView) {
    let host = surface.native.hosts.borrow_mut().remove(&view.id());
    drop(host);
}

/// The view's frame changed: its item fills it again.
pub(crate) fn resized(view: &NshView) {
    let mut s = view.state_mut();
    let rect = bounds(s.frame.size.width.0, s.frame.size.height.0);
    for native in &mut s.natives {
        native.rect = rect;
    }
}

/// `NativeProps`.
pub(crate) fn props(surface: &Rc<Surface>, view: &NshView, props: &NativeProps) {
    let host = surface
        .native
        .hosts
        .borrow()
        .get(&view.id())
        .map(Host::item_ref);
    match (host, props) {
        (Some(HostRef::Video(video)), NativeProps::Video(p)) => {
            let base = surface.native.asset_base.borrow().clone();
            video.set(surface, p, base.as_ref());
        }
        (Some(HostRef::Web(web)), NativeProps::WebView(p)) => web.set(surface, view, p),
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
    let Some(item) = component_item(surface, view.id()) else {
        return;
    };
    // Made with no borrow held: the app's code may reach the surface.
    let made = factory(ComponentContext {
        id: view.id(),
        control,
        surface: surface.key(),
    });
    *item.component.borrow_mut() = Some(made);
    view.changed();
}

/// `ComponentProps`.
pub(crate) fn component_props(
    surface: &Rc<Surface>,
    view: &NshView,
    props: &[(Arc<str>, Option<JsonValue>)],
) {
    let Some(item) = component_item(surface, view.id()) else {
        return;
    };
    if item.component.borrow().is_none() {
        return;
    }
    let mut pending = item.pending.borrow_mut();
    for (name, value) in props {
        pending.push(Pending::Prop(name.clone(), value.clone()));
    }
    drop(pending);
    view.changed();
}

/// A command for a web view, video or component.
pub(crate) fn command(surface: &Rc<Surface>, view: &NshView, command: &Command) {
    let host = surface
        .native
        .hosts
        .borrow()
        .get(&view.id())
        .map(Host::item_ref);
    match (host, command) {
        (Some(HostRef::Video(video)), Command::Seek(seconds)) => video.seek(*seconds),
        (Some(HostRef::Web(web)), _) => web.command(command),
        (Some(HostRef::Component(item)), Command::Native { name, args })
            if item.component.borrow().is_some() =>
        {
            item.pending
                .borrow_mut()
                .push(Pending::Command(name.clone(), args.clone()));
            view.changed();
        }
        _ => {}
    }
}

/// The surface element's prepaint, after it inserted its own hitbox (and
/// set its origin and size): lays out and prepaints the components'
/// elements at their containers' boxes and places the web views, each over
/// a hitbox that keeps nsh's input away from it.
pub(crate) fn prepaint(surface: &Rc<Surface>, window: &mut Window, cx: &mut App) {
    let hosts: Vec<(NodeId, HostRef)> = {
        let hosts = surface.native.hosts.borrow();
        let mut hosts: Vec<_> = hosts
            .iter()
            .filter(|(_, h)| !matches!(h, Host::Video(_)))
            .map(|(id, h)| (*id, h.item_ref()))
            .collect();
        // Hitboxes stack in insertion order: keep it the same from frame to
        // frame (nodes made later are usually drawn later, above).
        hosts.sort_unstable_by_key(|(id, _)| *id);
        hosts
    };
    // Video frames (and images) dropped where nothing draws images.
    crate::image::release_dropped(window, cx);
    let mut focused = Vec::new();
    for (id, host) in hosts {
        let Some(view) = surface.view(id) else {
            continue;
        };
        let geometry = geometry(surface, &view);
        match host {
            HostRef::Component(item) => {
                item.deliver(window, cx);
                if let Some(focus) = item.prepaint(geometry, window, cx) {
                    focused.push((id, focus));
                }
            }
            HostRef::Web(web) => web.prepaint(surface, &view, geometry, window, cx),
            HostRef::Video(_) => {}
        }
    }
    let changed = {
        let old = surface.native.focused.borrow();
        !old.iter()
            .map(|(id, _)| id)
            .eq(focused.iter().map(|(id, _)| id))
    };
    let has_native = !focused.is_empty();
    *surface.native.focused.borrow_mut() = focused;
    if changed {
        if has_native && !matches!(surface.native.tab_to.get(), Some(FocusTarget::Surface)) {
            crate::text_input::blur_all(surface);
        }
        surface.sync_focus();
    }
}

/// True when focus is inside one of the surface's components: keys go
/// there first, and only the app's shortcuts see what it lets through.
pub(crate) fn focused(surface: &Surface, window: &Window) -> bool {
    let in_frame = surface
        .native
        .focused
        .borrow()
        .iter()
        .any(|(_, f)| f.is_focused(window));
    in_frame
        || surface.native.hosts.borrow().values().any(|h| match h {
            Host::Component(item) => item.component.try_borrow().is_ok_and(|c| {
                c.as_ref()
                    .and_then(|c| c.focus_handle())
                    .is_some_and(|f| f.is_focused(window))
            }),
            _ => false,
        })
}

/// How many components the surface has.
pub(crate) fn component_count(surface: &Surface) -> usize {
    surface
        .native
        .hosts
        .borrow()
        .values()
        .filter(|h| matches!(h, Host::Component(_)))
        .count()
}

/// True when the component in node `id` takes the keyboard (a Tab stop).
pub(crate) fn focusable(surface: &Surface, id: NodeId) -> bool {
    component_item(surface, id).is_some_and(|item| {
        item.component
            .try_borrow()
            .is_ok_and(|c| c.as_ref().is_some_and(|c| c.focus_handle().is_some()))
    })
}

/// The component focus was inside at the last frame, unless an explicit
/// transfer to the surface has already revoked that native owner.
pub(crate) fn focused_component(surface: &Surface) -> Option<NodeId> {
    if matches!(surface.native.tab_to.get(), Some(FocusTarget::Surface)) {
        return None;
    }
    surface.native.focused.borrow().first().map(|(id, _)| *id)
}

/// The component awaiting the window's next focus application. This is
/// the existing native focus intent, ahead of last frame's actual owner.
pub(crate) fn requested_focus(surface: &Surface) -> Option<NodeId> {
    match surface.native.tab_to.get() {
        Some(FocusTarget::Component(id)) => Some(id),
        _ => None,
    }
}

/// Tab moved to the component in node `id`: [`apply_focus`] focuses it.
pub(crate) fn tab_to(surface: &Surface, id: NodeId) {
    surface.native.tab_to.set(Some(FocusTarget::Component(id)));
}

/// An explicit NSH focus request returns the window's focus to its surface.
/// Retained focus alone never steals focus from a native component.
pub(crate) fn focus_surface(surface: &Surface) {
    surface.native.focused.borrow_mut().clear();
    surface.native.tab_to.set(Some(FocusTarget::Surface));
}

/// Resolves the existing one-shot native focus intent with the window.
/// Without an intent, a real component focus clears the NSH control owner.
pub(crate) fn apply_focus(
    surface: &Rc<Surface>,
    own: &FocusHandle,
    window: &mut Window,
    cx: &mut App,
) {
    match surface.native.tab_to.take() {
        Some(FocusTarget::Component(id)) => {
            let handle = component_item(surface, id).and_then(|item| {
                let c = item.component.try_borrow().ok()?;
                c.as_ref()?.focus_handle()
            });
            if let Some(handle) = handle {
                surface.native.focused.borrow_mut().clear();
                crate::text_input::blur_all(surface);
                window.focus(&handle, cx);
                surface.native.focused.borrow_mut().push((id, handle));
                surface.sync_focus();
                surface.invalidate();
            }
        }
        Some(FocusTarget::Surface) => {
            surface.native.focused.borrow_mut().clear();
            window.focus(own, cx);
            surface.sync_focus();
            surface.invalidate();
        }
        None if focused(surface, window) => crate::text_input::blur_all(surface),
        None => {}
    }
}

/// Where a native control goes in the window: its view's box (window
/// coordinates) and the part of it its clipping ancestors leave visible.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Geometry {
    /// The whole box.
    pub(crate) document: Bounds<Pixels>,
    /// Its visible part (empty when clipped away, or when the box is).
    pub(crate) visible: Bounds<Pixels>,
}

impl Geometry {
    /// True when some of the box shows.
    pub(crate) fn shows(&self) -> bool {
        !empty(&self.visible)
    }
}

/// Where `view` is in the window, `None` when it is not attached or it or
/// an ancestor is hidden or transparent.
fn geometry(surface: &Surface, view: &NshView) -> Option<Geometry> {
    let (w, h) = {
        let s = view.try_state()?;
        (s.frame.size.width.0, s.frame.size.height.0)
    };
    let (ox, oy) = surface.origin.get();
    let to_window = |v: &NshView, w: f32, h: f32| {
        let (x, y, bw, bh) = v.to_root()?.bounds(0.0, 0.0, w, h)?;
        Some(crate::render::bounds(x + ox, y + oy, bw, bh))
    };
    let document = to_window(view, w, h)?;
    let (sw, sh) = surface.size();
    let mut visible = document.intersect(&crate::render::bounds(ox, oy, sw, sh));
    let mut node = Some(view.clone());
    while let Some(v) = node {
        let (shows, clips, size) = {
            let s = v.try_state()?;
            (
                !s.style.hidden && !s.concealed && s.opacity() > 0.0,
                s.clips(),
                (s.frame.size.width.0, s.frame.size.height.0),
            )
        };
        if !shows {
            return None;
        }
        if clips
            && v != *view
            && let Some(r) = to_window(&v, size.0, size.1)
        {
            visible = visible.intersect(&r);
        }
        node = v.parent_view();
    }
    Some(Geometry { document, visible })
}

/// True when `b` has no area.
fn empty(b: &Bounds<Pixels>) -> bool {
    b.size.width <= px(0.0) || b.size.height <= px(0.0)
}

/// Whether view `id` holds a made component (its animated props wait until
/// it does).
pub(crate) fn has_component(surface: &Surface, id: NodeId) -> bool {
    component_item(surface, id).is_some_and(|item| item.component.borrow().is_some())
}

/// Bound props that moved (`Animator::write_components`): queued for their
/// components, delivered with the next frame as props are.
pub(crate) fn component_animated(
    surface: &Surface,
    moved: Vec<(NodeId, Arc<str>, nsh_core::animation::AnimatedPropValue)>,
) {
    for (id, name, value) in moved {
        let Some(item) = component_item(surface, id) else {
            continue;
        };
        queue_animated(&mut item.pending.borrow_mut(), name, value);
        if let Some(view) = surface.mounter.borrow().views.get(id) {
            view.changed();
        }
    }
}

/// Queues bound prop `name`'s new value, replacing one still queued: a
/// component that is not drawn for a while gets the latest value once, and
/// the queue does not grow meanwhile.
fn queue_animated(
    pending: &mut Vec<Pending>,
    name: Arc<str>,
    value: nsh_core::animation::AnimatedPropValue,
) {
    for p in pending.iter_mut() {
        if let Pending::Animated(queued, v) = p
            && *queued == name
        {
            *v = value;
            return;
        }
    }
    pending.push(Pending::Animated(name, value));
}

fn component_item(surface: &Surface, id: NodeId) -> Option<Rc<ComponentItem>> {
    match surface.native.hosts.borrow().get(&id) {
        Some(Host::Component(item)) => Some(item.clone()),
        _ => None,
    }
}

/// Hosts `item` in `view`, filling it ([`resized`] follows the frame).
fn fill(view: &NshView, item: &Rc<dyn Hosted>) {
    let frame = view.state().frame;
    view.set_native(item, bounds(frame.size.width.0, frame.size.height.0));
}

fn bounds(width: f32, height: f32) -> nsh_core::Bounds<Points> {
    nsh_core::Bounds {
        origin: nsh_core::Point {
            x: Points(0.0),
            y: Points(0.0),
        },
        size: nsh_core::Size {
            width: Points(width),
            height: Points(height),
        },
    }
}

/// A registered component in its container.
struct ComponentItem {
    surface: Weak<Surface>,
    id: NodeId,
    /// `None` until named (or when no factory has the name), and while the
    /// app's code runs.
    component: RefCell<Option<Box<dyn NativeComponent>>>,
    /// The element the last prepaint laid out, painted when the tree draws
    /// the container.
    element: RefCell<Option<AnyElement>>,
    /// Props and commands for the next prepaint, which has the window.
    pending: RefCell<Vec<Pending>>,
}

/// A prop or command waiting for [`ComponentItem::deliver`].
enum Pending {
    Prop(Arc<str>, Option<JsonValue>),
    Command(Arc<str>, JsonValue),
    /// A bound prop that moved.
    Animated(Arc<str>, nsh_core::animation::AnimatedPropValue),
}

impl ComponentItem {
    /// Puts `component` back, unless the view was deleted meanwhile (then
    /// it drops).
    fn put(&self, component: Box<dyn NativeComponent>) {
        let alive = self.surface.upgrade().is_some_and(|s| {
            matches!(
                s.native.hosts.borrow().get(&self.id),
                Some(Host::Component(_))
            )
        });
        if alive {
            *self.component.borrow_mut() = Some(component);
        }
    }

    /// Hands the props and commands that came since the last frame to the
    /// component, in order.
    fn deliver(&self, window: &mut Window, cx: &mut App) {
        let pending = std::mem::take(&mut *self.pending.borrow_mut());
        if pending.is_empty() {
            return;
        }
        // Taken out while the app's code runs, so it may reach the surface.
        let Some(mut component) = self.component.borrow_mut().take() else {
            return;
        };
        for p in &pending {
            match p {
                Pending::Prop(name, value) => component.set_prop(name, value.as_ref(), window, cx),
                Pending::Command(name, args) => component.command(name, args, window, cx),
                Pending::Animated(name, value) => match *value {
                    nsh_core::animation::AnimatedPropValue::Number(n) => {
                        component.set_animated_number(name, n, window, cx)
                    }
                    nsh_core::animation::AnimatedPropValue::Color(argb) => {
                        component.set_animated_color(name, argb, window, cx)
                    }
                    _ => {}
                },
            }
        }
        self.put(component);
    }

    fn close(&self) {
        self.pending.borrow_mut().clear();
        self.element.borrow_mut().take();
        // Dropped here, with whatever the component holds.
        let component = self.component.borrow_mut().take();
        drop(component);
    }

    /// Asks the component for its element and prepaints it at `geometry`
    /// (nothing when `None`). Returns the focus handle focused inside it.
    fn prepaint(
        &self,
        geometry: Option<Geometry>,
        window: &mut Window,
        cx: &mut App,
    ) -> Option<FocusHandle> {
        self.element.borrow_mut().take();
        // Asked while its box is empty too: it may size itself
        // ([`ComponentContext::set_size`]).
        let geometry = geometry.filter(|g| g.shows() || empty(&g.document))?;
        // Taken out while the app's code runs, so it may reach the surface.
        let mut component = self.component.borrow_mut().take()?;
        let element = component.render(window, cx);
        self.put(component);
        let size = geometry.document.size;
        let mask = ContentMask {
            bounds: geometry.visible,
        };
        let (focus, element) = window.with_content_mask(Some(mask), |window| {
            // Under the component's own hitboxes: nsh's input (and the
            // embedding app's, under the surface) stays away from its box.
            if geometry.shows() {
                window.insert_hitbox(geometry.visible, HitboxBehavior::BlockMouse);
            }
            // Given exactly the container's size.
            let mut root = gpui::div()
                .w(size.width)
                .h(size.height)
                .child(element?)
                .into_any_element();
            let id = ("nsh-native", self.id as usize);
            let focus = window.with_element_namespace(id, |window| {
                root.prepaint_as_root(
                    geometry.document.origin,
                    gpui::size(
                        AvailableSpace::Definite(size.width),
                        AvailableSpace::Definite(size.height),
                    ),
                    window,
                    cx,
                )
            });
            Some((focus, root))
        })?;
        *self.element.borrow_mut() = Some(element);
        focus
    }
}

impl Hosted for ComponentItem {
    fn draw(&self, cx: &mut DrawCx<'_>, _size: (f32, f32)) {
        let Some(mut element) = self.element.borrow_mut().take() else {
            return;
        };
        if cx.culled() {
            return;
        }
        // In the namespace it was prepainted in, as GPUI requires.
        let id = ("nsh-native", self.id as usize);
        cx.paint(|window, app| {
            window.with_element_namespace(id, |window| element.paint(window, app))
        });
    }

    fn hit(&self, _x: f32, _y: f32, _size: (f32, f32)) -> bool {
        // GPUI's hitboxes give the component its input.
        false
    }

    fn placed(&self, rect: Option<Bounds<Pixels>>) {
        let taken = self.component.borrow_mut().take();
        if let Some(mut component) = taken {
            component.placed(rect);
            self.put(component);
        }
    }
}

/// Where a video's source is.
#[derive(Debug, PartialEq)]
#[cfg_attr(not(feature = "video"), allow(dead_code))]
enum Location {
    /// A URL (`https://`, `file://`, ...).
    Url(String),
    /// A file path.
    Path(std::path::PathBuf),
}

/// Resolves `source` (`asset:/` URIs against `base`).
#[cfg_attr(not(feature = "video"), allow(dead_code))]
fn locate(source: &str, base: Option<&AssetBase>) -> Option<Location> {
    if let Some(path) = source.strip_prefix("asset:/") {
        let path = path.trim_start_matches('/');
        return match base {
            Some(dirs @ (AssetBase::Directory(_) | AssetBase::Directories(_))) => {
                dirs.file(path).map(Location::Path)
            }
            Some(AssetBase::Http(url)) => Some(Location::Url(format!(
                "{}/{path}",
                url.trim_end_matches('/')
            ))),
            None => None,
        };
    }
    if source.contains("://") {
        Some(Location::Url(source.to_owned()))
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
    id: NodeId,
}

impl Emitter {
    fn new(surface: &Rc<Surface>, id: NodeId) -> Self {
        Emitter {
            surface: Rc::downgrade(surface),
            id,
        }
    }

    fn emit(&self, kind: EventKind, payload: impl FnOnce() -> EventPayload) {
        let Some(surface) = self.surface.upgrade() else {
            return;
        };
        // A view whose state is being changed right now cannot be read:
        // send the event, JS ignores events it has no handler for.
        let listens = surface
            .view(self.id)
            .is_some_and(|v| v.try_state().is_none_or(|s| s.events.contains(kind)));
        if listens {
            surface.event(self.id, kind, payload());
        }
    }
}

fn error(message: String) -> EventPayload {
    EventPayload::Map(vec![("message", PayloadValue::Str(message))])
}

/// Paints `text` centered in the current item's `size`, in a neutral gray:
/// what a control that cannot show draws.
fn placeholder(cx: &mut DrawCx<'_>, size: (f32, f32), text: &'static str) {
    if cx.culled() {
        return;
    }
    let font_size = 13.0 * cx.transform_scale();
    let line_height = px(font_size * 1.3);
    let color = cx.color(nsh_core::Color::rgba(140, 140, 140, 255));
    let center = cx.map(size.0 / 2.0, size.1 / 2.0);
    cx.paint(|window, app| {
        let run = gpui::TextRun {
            len: text.len(),
            font: gpui::font(crate::text::ui_family()),
            color,
            background_color: None,
            underline: None,
            strikethrough: None,
        };
        let line = window
            .text_system()
            .shape_line(text.into(), px(font_size), &[run], None);
        let origin = gpui::point(center.x - line.width / 2.0, center.y - line_height / 2.0);
        let _ = line.paint(
            origin,
            line_height,
            gpui::TextAlign::Left,
            None,
            window,
            app,
        );
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn animated_props_queue_their_latest_value() {
        use nsh_core::animation::AnimatedPropValue;
        let mut pending = vec![Pending::Command("go".into(), JsonValue::Null)];
        for v in [0.1, 0.2, 0.3] {
            queue_animated(
                &mut pending,
                "progress".into(),
                AnimatedPropValue::Number(v),
            );
        }
        queue_animated(
            &mut pending,
            "tint".into(),
            AnimatedPropValue::Color(0xff00_00ff),
        );
        let animated: Vec<_> = pending
            .iter()
            .filter_map(|p| match p {
                Pending::Animated(name, value) => Some((name.to_string(), *value)),
                _ => None,
            })
            .collect();
        assert_eq!(
            animated,
            [
                ("progress".to_string(), AnimatedPropValue::Number(0.3)),
                ("tint".to_string(), AnimatedPropValue::Color(0xff00_00ff)),
            ]
        );
        assert_eq!(pending.len(), 3, "the command stays");
    }

    #[test]
    fn locates_sources() {
        let dir = AssetBase::Directory("/app/assets".into());
        let http = AssetBase::Http("http://10.0.0.2:8790/assets/".into());
        assert_eq!(
            locate("asset:/clips/a.mp4", Some(&dir)),
            Some(Location::Path(
                std::path::Path::new("/app/assets").join("clips/a.mp4")
            ))
        );
        assert_eq!(
            locate("asset:/a.mp4", Some(&http)),
            Some(Location::Url("http://10.0.0.2:8790/assets/a.mp4".into()))
        );
        assert_eq!(locate("asset:/a.mp4", None), None);
        assert_eq!(
            locate("https://example.com/a.mp4", None),
            Some(Location::Url("https://example.com/a.mp4".into()))
        );
        assert_eq!(
            locate("/videos/a.mp4", None),
            Some(Location::Path("/videos/a.mp4".into()))
        );
        assert_eq!(locate("", None), None);
    }

    #[test]
    fn empty_bounds() {
        let b = crate::render::bounds;
        assert!(!empty(&b(0.0, 0.0, 10.0, 10.0)));
        assert!(empty(
            &b(0.0, 0.0, 10.0, 10.0).intersect(&b(10.0, 0.0, 10.0, 10.0))
        ));
        assert!(empty(&b(5.0, 5.0, 0.0, 10.0)));
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
