//! Native controls (videos, web views) and the native components the
//! embedding app registers (`nsh/native`'s `nativeComponent`).
//!
//! Each control is an item its node's view hosts ([`NshView::set_native`])
//! filling it: the view keeps decoration, frames, touches and
//! accessibility, as for any view, and [`resized`] keeps the item at the
//! view's bounds.
//!
//! - **Videos** play through Media Foundation's media engine in frame
//!   server mode ([`video`]): decoded on the GPU (the engine shares the
//!   thread's Direct3D device), each new frame is copied into a texture
//!   Direct2D draws in the view, so a video is clipped, transformed and
//!   covered like any other content. `controls` draws a small control bar
//!   (play / pause, a scrubber, the time) over the picture.
//! - **Web views** are WebView2 composition controllers ([`web`]): the page
//!   is a visual of the window's composition ([`crate::compose`]), placed,
//!   clipped and faded like its view by every frame, between what nsh draws
//!   before it and what it draws after it, so nsh content over a page (a
//!   dialog, a sheet, a menu) covers it. The window takes the input and
//!   forwards to the page what nsh's hit testing gives it.
//! - **Registered components**: [`crate::AppView::register_component`]
//!   names a factory; the core creates a [`ViewKind::Native`] container,
//!   names the component ([`MountItem::Component`]) and sends its props as
//!   JSON as they change. A component draws with Direct2D in the view
//!   ([`NativeComponent::draw`]) or brings a child window of its own
//!   ([`NativeComponent::window`]), moved where the view was drawn after
//!   every frame ([`Hosted::placed`]), clipped to its clipping ancestors
//!   and its rounded corners with a window region and hidden while its view
//!   is not drawn. Being a window, it sits above everything nsh draws (the
//!   "airspace" limit of child windows): nsh content drawn over it is
//!   covered by it. Components emit events and report their own size
//!   through their [`ComponentContext`].
//!   Registries belong to one `AppView` (and the views made from the same
//!   [`crate::AppOptions`]): no globals.
//!
//! Every control belongs to its surface ([`NativeState`]): stopping the app
//! drops them, so media stops playing and web views close.
//!
//! [`MountItem::Component`]: nsh_core::MountItem::Component

mod video;
mod web;

use std::{
    cell::{Cell, RefCell},
    rc::{Rc, Weak},
    sync::Arc,
};

use nsh_core::{
    Bounds, Command, EventKind, EventPayload, NativeProps, NodeId, PayloadValue, Points, Size,
    ViewKind, geometry::Point,
};
use nsh_engine::{Access, EngineControl};
use rustc_hash::{FxHashMap, FxHashSet};
use serde_json::Value as JsonValue;
use windows::Win32::{
    Foundation::{HWND, RECT},
    Graphics::Gdi::{
        CombineRgn, CreateRectRgn, CreateRoundRectRgn, DeleteObject, RGN_AND, SetWindowRgn,
    },
    UI::WindowsAndMessaging::{
        GWL_STYLE, GetWindowLongPtrW, HWND_TOP, SW_HIDE, SWP_NOACTIVATE, SWP_NOZORDER,
        SWP_SHOWWINDOW, SetParent, SetWindowLongPtrW, SetWindowPos, ShowWindow, WS_CHILD,
        WS_CLIPSIBLINGS, WS_POPUP,
    },
};

use crate::{
    image::AssetBase,
    render::DrawCx,
    surface::Surface,
    view::{Hosted, NshView},
};

/// A native component made by a registered factory.
///
/// ```no_run
/// use nsh_platform_windows::{
///     NativeComponent,
///     windows::Win32::Graphics::Direct2D::{Common::D2D1_COLOR_F, ID2D1DeviceContext},
/// };
///
/// /// A filled box whose color the app sets with a `red` prop (0..1).
/// struct Swatch(f32);
///
/// impl NativeComponent for Swatch {
///     fn draw(&self, dc: &ID2D1DeviceContext, size: (f32, f32)) {
///         let color = D2D1_COLOR_F {
///             r: self.0,
///             g: 0.2,
///             b: 0.4,
///             a: 1.0,
///         };
///         // SAFETY: Direct2D calls on the context nsh draws with.
///         unsafe {
///             if let Ok(brush) = dc.CreateSolidColorBrush(&color, None) {
///                 let rect = windows::Win32::Graphics::Direct2D::Common::D2D_RECT_F {
///                     left: 0.0,
///                     top: 0.0,
///                     right: size.0,
///                     bottom: size.1,
///                 };
///                 dc.FillRectangle(&rect, &brush);
///             }
///         }
///     }
///
///     fn set_prop(&mut self, name: &str, value: Option<&serde_json::Value>) {
///         if name == "red" {
///             self.0 = value.and_then(|v| v.as_f64()).unwrap_or(0.0) as f32;
///         }
///     }
/// }
/// ```
pub trait NativeComponent {
    /// Draws the component in its view's bounds (`size` points; the context
    /// is in the view's coordinates, clipped to its bounds). Called with
    /// every frame of the window: ask for one with
    /// [`ComponentContext::redraw`] when what it shows changes.
    fn draw(&self, dc: &windows::Win32::Graphics::Direct2D::ID2D1DeviceContext, size: (f32, f32)) {
        let _ = (dc, size);
    }

    /// A window of its own (a map, a video surface, a third-party control),
    /// if it has one: nsh makes it a child of the surface's window and
    /// moves, clips and hides it with the view. It sits above whatever nsh
    /// draws, web views included.
    fn window(&self) -> Option<HWND> {
        None
    }

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
    /// The surface's key and window, to draw again from any thread.
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

    /// What the component draws changed: the window draws again (from any
    /// thread).
    pub fn redraw(&self) {
        let key = self.surface;
        crate::window::invoke(move || {
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
    /// The application id: web views keep their data under it.
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

    /// What the app that starts may reach: web views keep their top-level
    /// navigations within its `webview` capability.
    pub(crate) fn set_access(&self, access: Arc<Access>) {
        *self.access.borrow_mut() = Some(access);
    }

    /// The application id ([`crate::AppOptions::app_id`]): web views keep
    /// their profile in `%LOCALAPPDATA%\<app id>\WebView2`.
    pub(crate) fn set_app_id(&self, app_id: &str) {
        *self.app_id.borrow_mut() = app_id.to_owned();
    }

    /// Drops every control (the app stopped): media stops playing, pages
    /// close.
    pub(crate) fn clear(&self) {
        let hosts = std::mem::take(&mut *self.hosts.borrow_mut());
        for host in hosts.values() {
            if let Host::Web(w) = host {
                w.close();
            }
        }
        drop(hosts);
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
}

impl Drop for Host {
    fn drop(&mut self) {
        // The item may outlive its control in its view (a removal
        // animation keeps the view on screen a little longer): it shows the
        // last frame of a video, and a web view's page until the view is
        // not drawn anymore.
        match self {
            Host::Video(v) => v.close(),
            Host::Web(w) => w.retire(),
            Host::Component(c) => c.close(),
        }
    }
}

/// Sets up a web view, video or component container.
pub(crate) fn create(surface: &Rc<Surface>, view: &NshView) {
    let id = view.id();
    let host = match view.kind() {
        ViewKind::Video => Host::Video(video::VideoItem::new(surface, id)),
        ViewKind::WebView => Host::Web(web::WebItem::new(surface, view)),
        _ => Host::Component(Rc::new(ComponentItem {
            surface: Rc::downgrade(surface),
            id,
            component: RefCell::new(None),
            window: Cell::new(None),
            placement: Placement::default(),
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
    let item = match surface.native.hosts.borrow().get(&view.id()) {
        Some(Host::Component(item)) => item.clone(),
        _ => return,
    };
    // Made with no borrow held: the app's code may reach the surface.
    let made = factory(ComponentContext {
        id: view.id(),
        control,
        surface: surface.key(),
    });
    if let Some(hwnd) = made.window() {
        adopt(surface.hwnd(), hwnd);
        item.window.set(Some(hwnd));
    }
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
    // Taken out while the app's code runs, so it may reach the surface.
    let Some(mut component) = item.component.borrow_mut().take() else {
        return;
    };
    for (name, value) in props {
        component.set_prop(name, value.as_ref());
    }
    item.put(component);
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
        (Some(HostRef::Component(item)), Command::Native { name, args }) => {
            let taken = item.component.borrow_mut().take();
            if let Some(mut component) = taken {
                component.command(name, args);
                item.put(component);
            }
        }
        _ => {}
    }
}

/// A host's item, cloned out of the map so that no borrow of it is held
/// while the control runs.
enum HostRef {
    Video(Rc<video::VideoItem>),
    Web(Rc<web::WebItem>),
    Component(Rc<ComponentItem>),
}

impl Host {
    fn item_ref(&self) -> HostRef {
        match self {
            Host::Video(v) => HostRef::Video(v.clone()),
            Host::Web(w) => HostRef::Web(w.clone()),
            Host::Component(c) => HostRef::Component(c.clone()),
        }
    }
}

/// The page or registered child window that currently owns the keyboard.
pub(crate) fn focused(surface: &Surface) -> Option<NshView> {
    use windows::Win32::UI::{Input::KeyboardAndMouse::GetFocus, WindowsAndMessaging::IsChild};
    // SAFETY: querying this UI thread's native keyboard owner.
    let focus = unsafe { GetFocus() };
    surface.native.hosts.borrow().iter().find_map(|(id, host)| {
        let focused = match host {
            Host::Web(item) => item.focused(),
            Host::Component(item) => item.window.get().is_some_and(|window| {
                !focus.is_invalid()
                    // SAFETY: both handles belong to this UI thread.
                    && (focus == window || unsafe { IsChild(window, focus) }.as_bool())
            }),
            Host::Video(_) => false,
        };
        focused
            .then(|| surface.view(*id))
            .flatten()
            .filter(NshView::attached)
    })
}

/// Hides hosted input surfaces synchronously when a recycling row leaves
/// the mounted tree, rather than waiting for the next drawn frame.
pub(crate) fn detached(view: &NshView) {
    let items: Vec<_> = view
        .state()
        .natives
        .iter()
        .map(|native| native.item.clone())
        .collect();
    for item in items {
        item.placed(None);
        item.compose_at(None);
    }
    for child in view.child_views() {
        detached(&child);
    }
}

/// Content that takes the keyboard (a dialog, a modal) comes over the
/// views: a page that had the focus gives it back to the window, as a web
/// view resigns first responder when something is presented over it.
pub(crate) fn take_keyboard(surface: &Surface) {
    use windows::Win32::UI::{
        Input::KeyboardAndMouse::{GetFocus, SetFocus},
        WindowsAndMessaging::IsChild,
    };
    let hwnd = surface.hwnd();
    if hwnd.is_invalid() {
        return;
    }
    // SAFETY: plain calls on this thread's window.
    unsafe {
        let focus = GetFocus();
        if !focus.is_invalid() && focus != hwnd && IsChild(hwnd, focus).as_bool() {
            let _ = SetFocus(Some(hwnd));
        }
    }
}

/// The web view of node `id`.
fn web_item(surface: &Surface, id: NodeId) -> Option<Rc<web::WebItem>> {
    match surface.native.hosts.borrow().get(&id) {
        Some(Host::Web(item)) => Some(item.clone()),
        _ => None,
    }
}

/// Whether view `id` holds a made component (its animated props wait until
/// it does).
pub(crate) fn has_component(surface: &Surface, id: NodeId) -> bool {
    component_item(surface, id).is_some_and(|item| item.component.borrow().is_some())
}

/// Bound props that moved (`Animator::write_components`): handed to their
/// components.
pub(crate) fn component_animated(
    surface: &Surface,
    moved: Vec<(NodeId, Arc<str>, nsh_core::animation::AnimatedPropValue)>,
) {
    use nsh_core::animation::AnimatedPropValue;
    for (id, name, value) in moved {
        let Some(item) = component_item(surface, id) else {
            continue;
        };
        // Taken out while the app's code runs, so it may reach the surface.
        let Some(mut component) = item.component.borrow_mut().take() else {
            continue;
        };
        match value {
            AnimatedPropValue::Number(n) => component.set_animated_number(&name, n),
            AnimatedPropValue::Color(argb) => component.set_animated_color(&name, argb),
            _ => {}
        }
        item.put(component);
    }
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

/// The view of node `id`.
fn view_of(surface: &Surface, id: NodeId) -> Option<NshView> {
    surface.view(id)
}

/// A registered component in its container.
struct ComponentItem {
    surface: Weak<Surface>,
    id: NodeId,
    /// `None` until named (or when no factory has the name), and while the
    /// app's code runs.
    component: RefCell<Option<Box<dyn NativeComponent>>>,
    /// The component's own window.
    window: Cell<Option<HWND>>,
    placement: Placement,
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

    fn close(&self) {
        if let Some(hwnd) = self.window.take() {
            // SAFETY: plain calls on a window the component made; it
            // destroys it when it drops.
            unsafe {
                let _ = ShowWindow(hwnd, SW_HIDE);
            }
        }
        // Dropped here: the component's window goes with it.
        let component = self.component.borrow_mut().take();
        drop(component);
    }
}

impl Hosted for ComponentItem {
    fn draw(&self, cx: &mut DrawCx<'_>, size: (f32, f32)) {
        let Ok(component) = self.component.try_borrow() else {
            return;
        };
        let Some(component) = &*component else { return };
        cx.push_clip_rect(0.0, 0.0, size.0, size.1);
        component.draw(cx.dc, size);
        cx.pop();
    }

    fn hit(&self, _x: f32, _y: f32, _size: (f32, f32)) -> bool {
        // Touches go to the view (presses, gestures, the responder system);
        // a component's own window gets its input from Windows.
        false
    }

    fn placed(&self, rect: Option<RECT>) {
        let (Some(hwnd), Some(surface)) = (self.window.get(), self.surface.upgrade()) else {
            return;
        };
        self.placement.apply(&surface, self.id, hwnd, rect);
    }
}

/// Makes `child` (a window a component brought) a child of `parent`.
fn adopt(parent: HWND, child: HWND) {
    // SAFETY: plain calls on live windows; the style change makes it a
    // child before it is reparented, as `SetParent` requires.
    unsafe {
        let style = GetWindowLongPtrW(child, GWL_STYLE) as u32;
        let style = (style & !WS_POPUP.0) | WS_CHILD.0 | WS_CLIPSIBLINGS.0;
        SetWindowLongPtrW(child, GWL_STYLE, style as isize);
        if let Err(err) = SetParent(child, Some(parent)) {
            log::warn!("native: cannot host the component's window: {err}");
        }
        let _ = ShowWindow(child, SW_HIDE);
    }
}

/// Where a child window (a web view's, a component's) was last put: it
/// follows its view after every frame, and only moves when that changed.
#[derive(Default)]
struct Placement {
    /// The window rectangle, the visible part (window pixels) and the
    /// corner radius (pixels) applied; `None` while hidden.
    last: Cell<Option<(RECT, RECT, i32)>>,
}

impl Placement {
    /// Puts `hwnd` at `rect` (window pixels, `None`: the view was not
    /// drawn), clipped to its view's clipping ancestors and rounded with
    /// its corners. Returns the size it has (pixels) when shown.
    fn apply(
        &self,
        surface: &Surface,
        id: NodeId,
        hwnd: HWND,
        rect: Option<RECT>,
    ) -> Option<(i32, i32)> {
        let shown = rect.and_then(|rect| {
            let view = view_of(surface, id)?;
            let (visible, radius) = clip(surface, &view, rect)?;
            Some((rect, visible, radius))
        });
        if shown == self.last.get() {
            return shown.map(|(r, _, _)| (r.right - r.left, r.bottom - r.top));
        }
        self.last.set(shown);
        let Some((rect, visible, radius)) = shown else {
            // SAFETY: a plain call on a live window.
            unsafe {
                let _ = ShowWindow(hwnd, SW_HIDE);
            }
            return None;
        };
        let (w, h) = (rect.right - rect.left, rect.bottom - rect.top);
        // SAFETY: plain GDI and window calls on a live window; the region
        // belongs to the window once set (and is deleted otherwise).
        unsafe {
            let _ = SetWindowPos(
                hwnd,
                Some(HWND_TOP),
                rect.left,
                rect.top,
                w,
                h,
                SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_NOZORDER,
            );
            let whole = visible == rect && radius == 0;
            if whole {
                SetWindowRgn(hwnd, None, true);
            } else {
                let region = if radius > 0 {
                    CreateRoundRectRgn(0, 0, w + 1, h + 1, radius * 2, radius * 2)
                } else {
                    CreateRectRgn(0, 0, w, h)
                };
                let cut = CreateRectRgn(
                    visible.left - rect.left,
                    visible.top - rect.top,
                    visible.right - rect.left,
                    visible.bottom - rect.top,
                );
                CombineRgn(Some(region), Some(region), Some(cut), RGN_AND);
                let _ = DeleteObject(cut.into());
                if SetWindowRgn(hwnd, Some(region), true) == 0 {
                    let _ = DeleteObject(region.into());
                }
            }
        }
        Some((w, h))
    }
}

/// The part of `rect` (the view's window rectangle, pixels) its clipping
/// ancestors leave visible, and its corner radius in pixels when it clips
/// its own content; `None` when nothing is visible.
fn clip(surface: &Surface, view: &NshView, rect: RECT) -> Option<(RECT, i32)> {
    let scale = surface.scale();
    let (sw, sh) = surface.pixel_size();
    let mut visible = intersect(
        rect,
        RECT {
            left: 0,
            top: 0,
            right: sw as i32,
            bottom: sh as i32,
        },
    )?;
    let mut parent = view.parent_view();
    while let Some(p) = parent {
        let clips = p.try_state().is_some_and(|s| s.clips());
        if clips {
            let (w, h) = {
                let s = p.state();
                (s.frame.size.width.0, s.frame.size.height.0)
            };
            if let Some((x, y, bw, bh)) = p.to_root().and_then(|m| m.bounds(0.0, 0.0, w, h)) {
                let r = RECT {
                    left: (x * scale).round() as i32,
                    top: (y * scale).round() as i32,
                    right: ((x + bw) * scale).round() as i32,
                    bottom: ((y + bh) * scale).round() as i32,
                };
                visible = intersect(visible, r)?;
            }
        }
        parent = p.parent_view();
    }
    let radius = view.try_state().map_or(0.0, |s| {
        if s.clips() {
            s.radii().into_iter().fold(0.0f32, f32::max)
        } else {
            0.0
        }
    });
    Some((visible, (radius * scale).round() as i32))
}

/// The intersection of two rectangles, `None` when empty.
fn intersect(a: RECT, b: RECT) -> Option<RECT> {
    let r = RECT {
        left: a.left.max(b.left),
        top: a.top.max(b.top),
        right: a.right.min(b.right),
        bottom: a.bottom.min(b.bottom),
    };
    (r.right > r.left && r.bottom > r.top).then_some(r)
}

/// Where a video's source is.
#[derive(Debug, PartialEq)]
enum Location {
    /// A URL Media Foundation opens (`https://`, `file://`, ...).
    Url(String),
    /// A file path.
    Path(std::path::PathBuf),
}

impl Location {
    /// The URL the media engine opens.
    fn url(&self) -> String {
        match self {
            Location::Url(url) => url.clone(),
            Location::Path(path) => file_url(&path.to_string_lossy()),
        }
    }
}

/// Resolves `source` (`asset:/` URIs against `base`).
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

/// A `file:` URL for a Windows path (`C:\a b\c.mp4` →
/// `file:///C:/a%20b/c.mp4`; `\\server\share\c.mp4` →
/// `file://server/share/c.mp4`).
fn file_url(path: &str) -> String {
    let unc = path.strip_prefix(r"\\");
    let mut url = String::with_capacity(path.len() + 8);
    url.push_str(if unc.is_some() { "file://" } else { "file:///" });
    for c in unc.unwrap_or(path).chars() {
        match c {
            '\\' => url.push('/'),
            ' ' => url.push_str("%20"),
            '#' => url.push_str("%23"),
            '%' => url.push_str("%25"),
            '?' => url.push_str("%3F"),
            c => url.push(c),
        }
    }
    url
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locates_sources() {
        let dir = AssetBase::Directory(r"C:\app\assets".into());
        let http = AssetBase::Http("http://10.0.0.2:8790/assets/".into());
        assert_eq!(
            locate("asset:/clips/a.mp4", Some(&dir)),
            Some(Location::Path(
                std::path::Path::new(r"C:\app\assets").join("clips/a.mp4")
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
            locate(r"C:\Videos\a.mp4", None),
            Some(Location::Path(r"C:\Videos\a.mp4".into()))
        );
        assert_eq!(locate("", None), None);
    }

    #[test]
    fn makes_file_urls() {
        assert_eq!(
            file_url(r"C:\My Videos\a#1.mp4"),
            "file:///C:/My%20Videos/a%231.mp4"
        );
        assert_eq!(file_url(r"\\nas\share\a.mp4"), "file://nas/share/a.mp4");
        assert_eq!(
            Location::Path(r"C:\app\assets\clips/a.mp4".into()).url(),
            "file:///C:/app/assets/clips/a.mp4"
        );
    }

    #[test]
    fn intersects_rects() {
        let r = |left, top, right, bottom| RECT {
            left,
            top,
            right,
            bottom,
        };
        assert_eq!(
            intersect(r(0, 0, 10, 10), r(5, 5, 20, 20)),
            Some(r(5, 5, 10, 10))
        );
        assert_eq!(intersect(r(0, 0, 10, 10), r(10, 0, 20, 10)), None);
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
