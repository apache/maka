//! Shader views: the layer [`MountItem::Shader`](nsh_core::MountItem)
//! mounts on a view, rendered by `nsh_engine::shader` and shown as the contents of
//! a sublayer under the view's children, clipped to its rounded box as a
//! background is ([`crate::decor`] shapes it with the view).
//!
//! The surface opens the GPU device the first time a shader is mounted
//! ([`Shaders`]). The shader views with a frame to render or collect
//! ([`ShaderView::wants_frame`]: their uniforms or size changed, or they
//! read `nsh.time`) render on one frame callback of the surface's display
//! link, at their window's backing scale; a frame that comes back becomes a
//! `CGImage`, the layer's contents, stretched over the view's box. A view
//! out of sight (a list row scrolled away, a screen under another) stops
//! rendering and starts again once it shows ([`shown`], from
//! [`crate::mount::Mounter::revisit`]).
//!
//! Effects and transitions ([`ShaderRole`]) draw their children through
//! the shader: the children move into a container (as for clipping,
//! [`NshView::ensure_container`]) whose layer an empty mask hides while the
//! shader's frames show (AppKit hit-tests views, not what shows, so they
//! keep their clicks; [`crate::decor::hide_children`], which the
//! decoration's own clipping leaves in place), and the frames' layer goes
//! above the container, `overflow` points beyond the box. Where there is
//! no GPU device the children show as they are. A screen effect or
//! transition does the same with the surface's root, whose children stay
//! hidden while any of them hides them; its layer leaves the root when it
//! is deleted ([`deleted`]) or the app stops ([`clear`]). The pictures a
//! shader reads are the
//! container rendered with `renderInContext:` (without its mask) and, for
//! `sample_backdrop`, the root with the view left out, taken again on the
//! frame after the core says they changed ([`input_changed`]) or the UI
//! thread changed a view in them ([`ui_changed`]). A transition pictures
//! the children as they were when it starts ([`start_transition`]).
//! `renderInContext:` draws no video or web page, nor other shaders'
//! frames under an effect taken before they arrive.
//!
//! A page's or a dialog's `transitionShader` runs over the stack or the
//! surface as a [`NavOverlay`]: pictures of the lower and the upper side,
//! from and to. Where there is no GPU device, a transition starts no run
//! and a page or a dialog comes and goes with its own `animation`.

use std::{
    cell::{Cell, OnceCell, RefCell},
    rc::{Rc, Weak},
    sync::Arc,
    time::Instant,
};

use nsh_core::{
    animation::AnimationValue,
    canvas::Damage,
    shader::{ShaderInput, ShaderLayer, ShaderRole},
};
use nsh_engine::shader::{Frame, PixelFormat, Renderer, ShaderView};
use objc2::rc::Retained;
use objc2_core_foundation::{CFRetained, CGFloat, CGPoint, CGRect, CGSize};
use objc2_core_graphics::CGImage;
use objc2_quartz_core::{CALayer, kCAGravityResize};

use crate::{surface::Surface, view::NshView};

/// A surface's shader views: the GPU device, and the views rendering.
#[derive(Default)]
pub(crate) struct Shaders {
    /// Opened the first time a shader is mounted (`None` inside: there is
    /// no device, and shader views show nothing of their own).
    renderer: OnceCell<Option<Renderer>>,
    /// The views with a frame to render or collect.
    views: RefCell<Vec<NshView>>,
    /// The views whose shaders read pictures (effects, transitions,
    /// screens, backdrops): [`ui_changed`] looks among them.
    pictured: RefCell<Vec<NshView>>,
    /// The running page and dialog overlays' marks ([`NavOverlay`]), which
    /// [`ui_changed`] sets when a view under one changes.
    overlays: RefCell<Vec<Weak<Mark>>>,
    /// Its frame callback runs.
    running: Cell<bool>,
}

impl Shaders {
    /// The GPU device, opened the first time one asks.
    pub(crate) fn renderer(&self) -> Option<&Renderer> {
        self.renderer
            .get_or_init(|| Renderer::new(PixelFormat::Rgba))
            .as_ref()
    }
}

/// What a shader view shows.
pub(crate) struct ShaderState {
    surface: Weak<Surface>,
    view: ShaderView,
    /// Shows the frames: a sublayer of the view's layer, under its
    /// children.
    layer: Retained<CALayer>,
    /// It is in [`Shaders::views`].
    ticking: bool,
    /// Out of sight with a frame to render ([`shown`]).
    hidden: bool,
    /// What the layer draws ([`ShaderRole::Fill`]: under the children, as
    /// upstream's; the others over them).
    role: ShaderRole,
    /// The children's (the root's, for a screen's) picture is due.
    stale: bool,
    /// The backdrop's picture is due.
    backdrop_stale: bool,
    /// The children's container is masked: the frames show instead
    /// ([`ShaderState::hides`]).
    masked: bool,
    /// Where the children's (the root's) pictures are drawn, kept for the
    /// next.
    canvas: Option<Canvas>,
    /// Where the backdrop's pictures are drawn, kept for the next.
    backdrop_canvas: Option<Canvas>,
}

impl ShaderState {
    fn new(surface: Weak<Surface>) -> Self {
        let layer = CALayer::new();
        // Clipped to its rounded corners ([`crate::decor`] sets them).
        layer.setMasksToBounds(true);
        // SAFETY: an immutable Core Animation constant.
        layer.setContentsGravity(unsafe { kCAGravityResize });
        // Above the background, its gradients and inset shadows, below the
        // borders behind the children and the children.
        layer.setZPosition(crate::decor::BEHIND + 0.75);
        ShaderState {
            surface,
            view: ShaderView::default(),
            layer,
            ticking: false,
            hidden: false,
            role: ShaderRole::Fill,
            stale: false,
            backdrop_stale: false,
            masked: false,
            canvas: None,
            backdrop_canvas: None,
        }
    }

    /// The layer the frames show in.
    pub(crate) fn layer(&self) -> &CALayer {
        &self.layer
    }

    /// Whether it draws under the children, shaped as a background
    /// ([`crate::decor`] places it); the others place themselves.
    pub(crate) fn fills(&self) -> bool {
        self.role == ShaderRole::Fill
    }

    /// Whether the children it draws are hidden now: an effect's always, a
    /// transition's while it runs; never where there is no GPU device (the
    /// view shows its background and children as they are).
    fn hides(&mut self, shaders: &Shaders, now: Instant) -> bool {
        self.view.replaces_children(now) && shaders.renderer().is_some()
    }

    /// Whether its program reads the children it draws (an effect's
    /// `sample_content`, a transition's `sample_to`): only then are they
    /// pictured again when they change.
    fn reads_children(&self) -> bool {
        let inputs = self
            .view
            .layer()
            .map(|l| l.shader.inputs())
            .unwrap_or_default();
        match self.role {
            ShaderRole::Fill => false,
            ShaderRole::Transition | ShaderRole::ScreenTransition => {
                inputs.contains(ShaderInput::To)
            }
            _ => inputs.contains(ShaderInput::Content),
        }
    }
}

/// Above every child (and a canvas's or text's content), as the frames of
/// an effect show instead of them.
const OVER: CGFloat = 1.0e6;

/// The display frames after its first on which a page's or a dialog's
/// overlay pictures its live side whether or not a view under it changed:
/// AppKit lays out and draws what navigation just showed over these.
const SETTLING_FRAMES: u32 = 3;

/// How long a [`NavOverlay`] stays after its shader's run: the one or two
/// frames rendered last come back from the GPU a frame or two late, and
/// show before it goes (the motion under it already ended).
pub(crate) const LINGER: std::time::Duration = std::time::Duration::from_millis(50);

thread_local! {
    /// The keys of the surfaces with views in [`Shaders::pictured`] (no
    /// views: those are the surfaces').
    static PICTURING: RefCell<Vec<u64>> = const { RefCell::new(Vec::new()) };
}

fn is_screen(role: ShaderRole) -> bool {
    matches!(role, ShaderRole::Screen | ShaderRole::ScreenTransition)
}

/// The view whose children `view`'s shader draws: itself, or the root of
/// its window (the surface's, or a window of the app's own) for a screen
/// effect or transition.
fn host(surface: &Surface, view: &NshView, role: ShaderRole) -> NshView {
    if is_screen(role) {
        crate::window::root_containing(surface, view).unwrap_or_else(|| surface.root.clone())
    } else {
        view.clone()
    }
}

/// Hides `host`'s children while a shader drawing them hides them
/// ([`ShaderState::masked`]): its own, or any of the surface's screen
/// effects and transitions, which share the root's.
fn sync_mask(surface: &Surface, host: &NshView) {
    let masked = surface.shaders.pictured.borrow().iter().any(|v| {
        v.state()
            .shader
            .as_ref()
            .is_some_and(|s| s.masked && self::host(surface, v, s.role) == *host)
    });
    crate::decor::hide_children(host, masked);
}

/// Whether the children `view`'s shader draws are hidden follows its role
/// and the device ([`ShaderState::hides`]), and so does their mask.
fn refresh_mask(surface: &Surface, view: &NshView, now: Instant) {
    let role = {
        let mut state = view.state_mut();
        let Some(shader) = state.shader.as_mut() else {
            return;
        };
        let masked = shader.hides(&surface.shaders, now);
        if masked == shader.masked {
            return;
        }
        shader.masked = masked;
        shader.role
    };
    sync_mask(surface, &host(surface, view, role));
}

/// Keeps `view` among the views whose shaders read pictures, or not.
fn track(surface: &Surface, view: &NshView, pictures: bool) {
    {
        let mut pictured = surface.shaders.pictured.borrow_mut();
        pictured.retain(|v| v != view);
        if pictures {
            pictured.push(view.clone());
        }
    }
    sync_picturing(surface);
}

/// Keeps the surface among [`PICTURING`] while it has views that read
/// pictures or overlays running.
fn sync_picturing(surface: &Surface) {
    let shaders = &surface.shaders;
    shaders
        .overlays
        .borrow_mut()
        .retain(|m| m.strong_count() > 0);
    let picturing = !shaders.pictured.borrow().is_empty() || !shaders.overlays.borrow().is_empty();
    let key = surface.key();
    PICTURING.with(|p| {
        let mut p = p.borrow_mut();
        p.retain(|&k| k != key);
        if picturing {
            p.push(key);
        }
    });
}

/// Mounts `layer` on `view` (`None`: it shows nothing of its own).
pub(crate) fn set(surface: &Rc<Surface>, view: &NshView, layer: Option<Arc<ShaderLayer>>) {
    {
        let mut state = view.state_mut();
        if layer.is_none() && state.shader.is_none() {
            return;
        }
        if layer.is_some() {
            surface.shaders.renderer();
        }
        let shader = state
            .shader
            .get_or_insert_with(|| Box::new(ShaderState::new(Rc::downgrade(surface))));
        if layer.is_none() {
            // SAFETY: clearing the contents.
            unsafe { shader.layer.setContents(None) };
        }
        let role = layer.as_ref().map_or(shader.role, |l| l.role);
        let pictures = layer
            .as_ref()
            .is_some_and(|l| !l.shader.inputs().is_empty() || l.role != ShaderRole::Fill);
        shader.backdrop_stale = layer
            .as_ref()
            .is_some_and(|l| l.shader.inputs().contains(ShaderInput::Backdrop));
        shader.stale = pictures;
        shader.role = role;
        shader.view.set_layer(layer.clone());
        track(surface, view, pictures);
    }
    let (role, on) = {
        let state = view.state();
        let shader = state.shader.as_ref().expect("a shader");
        (shader.role, shader.view.layer().is_some())
    };
    if role != ShaderRole::Fill {
        let host = host(surface, view, role);
        let state = view.state();
        let shader = state.shader.as_ref().expect("a shader");
        if on {
            if shader.layer.superlayer().is_none()
                && let Some(parent) = host.ns().layer()
            {
                shader.layer.setZPosition(OVER);
                parent.addSublayer(&shader.layer);
            }
        } else {
            shader.layer.removeFromSuperlayer();
        }
        drop(state);
        if on {
            // Its pictures are of the children alone.
            host.ensure_container();
        }
        // An effect always shows its frames, a transition while it runs (a
        // new layer mid-run too); without a device, the children.
        refresh_mask(surface, view, Instant::now());
    }
    // The decoration shapes a fill's layer and adds it to the view's.
    view.restyle();
    if tick(view) {
        start(surface);
    }
}

/// Hides the children the frames show instead of, in `window`, for an
/// in-process picture of it ([`crate::capture::bitmap`]: `cacheDisplayInRect:`
/// draws masked layers whole); the views to show again after.
#[cfg(any(feature = "dev", feature = "terminal"))]
pub(crate) fn hide_masked(
    window: &objc2_app_kit::NSWindow,
) -> Vec<Retained<objc2_app_kit::NSView>> {
    let keys = PICTURING.with(|p| p.borrow().clone());
    let views: Vec<NshView> = keys
        .into_iter()
        .filter_map(Surface::with_key)
        .flat_map(|s| s.shaders.pictured.borrow().clone())
        .collect();
    let mut hidden = Vec::new();
    for view in views {
        let Some(surface) = view
            .state()
            .shader
            .as_ref()
            .filter(|s| s.masked)
            .and_then(|s| {
                let role = s.role;
                s.surface.upgrade().map(|surface| (surface, role))
            })
        else {
            continue;
        };
        let host = host(&surface.0, &view, surface.1);
        if let Some(c) = host.container_view()
            && c.window().as_deref() == Some(window)
            && !c.isHidden()
        {
            c.setHidden(true);
            hidden.push(c);
        }
    }
    hidden
}

/// The core says what `view`'s shader reads changed
/// ([`nsh_core::MountItem::ShaderInput`]): its pictures are taken again on
/// the next display frame.
pub(crate) fn input_changed(surface: &Rc<Surface>, view: &NshView) {
    let marked = view.state_mut().shader.as_mut().is_some_and(|s| {
        let inputs = s
            .view
            .layer()
            .map(|l| l.shader.inputs())
            .unwrap_or_default();
        s.stale = s.reads_children();
        s.backdrop_stale = inputs.contains(ShaderInput::Backdrop);
        s.stale || s.backdrop_stale
    });
    if marked && tick_due(view) {
        start(surface);
    }
}

/// The UI thread changed `view` (an animated value, a scroll, an image
/// that loaded): the effects around it, and every backdrop, take their
/// pictures again.
pub(crate) fn ui_changed(view: &NshView) {
    #[cfg(feature = "terminal")]
    view.invalidate_capture();
    let keys = PICTURING.with(|p| p.borrow().clone());
    for key in keys {
        if let Some(surface) = Surface::with_key(key) {
            ui_changed_in(&surface, view);
        }
    }
}

fn ui_changed_in(surface: &Rc<Surface>, view: &NshView) {
    // Another surface's view (an app embedding two): none of this one's
    // pictures holds it. A window of the app's own is this surface's.
    if crate::window::root_containing(surface, view).is_none() {
        return;
    }
    // A page's or a dialog's overlay pictures its side again.
    for mark in surface.shaders.overlays.borrow().iter() {
        if let Some(mark) = mark.upgrade()
            && view.ns().isDescendantOf(&mark.host)
        {
            mark.dirty.set(true);
        }
    }
    let views = surface.shaders.pictured.borrow();
    let mut marked = false;
    // Marking takes no other borrow of `pictured` ([`tick_due`] adds to
    // `views`), so it is walked in place, not copied on every change.
    for v in views.iter() {
        if v == view {
            continue;
        }
        let Some(mut state) = v.try_state_mut() else {
            continue;
        };
        let Some(shader) = state.shader.as_mut() else {
            continue;
        };
        // Only a shader that reads them pictures its children (the whole
        // surface, for a screen's) again.
        let inside =
            shader.reads_children() && (is_screen(shader.role) || view.ns().isDescendantOf(v.ns()));
        let backdrop = shader
            .view
            .layer()
            .is_some_and(|l| l.shader.inputs().contains(ShaderInput::Backdrop));
        if inside {
            shader.stale = true;
        }
        if backdrop {
            shader.backdrop_stale = true;
        }
        if inside || backdrop {
            marked = true;
            drop(state);
            tick_due(v);
        }
    }
    drop(views);
    // While the animator writes, [`wake`] starts them once it is done.
    if marked && surface.anim.try_borrow_mut().is_ok() {
        start(surface);
    }
}

/// A transition starts ([`nsh_core::MountItem::ShaderTransition`], before
/// the rest of its batch): the children as they show now are its `from`.
pub(crate) fn start_transition(
    surface: &Rc<Surface>,
    view: &NshView,
    duration: std::time::Duration,
) {
    let Some(renderer) = surface.shaders.renderer() else {
        return;
    };
    let (role, overflow) = {
        let state = view.state();
        let Some(shader) = state.shader.as_ref() else {
            return;
        };
        (shader.role, shader.view.overflow())
    };
    let host = host(surface, view, role);
    let scale = host.ns().window().map_or(2.0, |w| w.backingScaleFactor());
    let size = host.state().frame.size;
    // From what shows: the running transition's frame, or the children.
    let (frame, mut canvas) = {
        let mut state = view.state_mut();
        let shader = state.shader.as_mut().expect("a shader");
        let frame = (shader.masked && shader.view.frame().width > 0).then(|| {
            let frame = shader.view.frame();
            (frame.tight().to_vec(), frame.width, frame.height)
        });
        (frame, shader.canvas.take())
    };
    let from = match &frame {
        Some((rgba, w, h)) => Some((&rgba[..], *w, *h, *w * 4)),
        None => children_picture(&mut canvas, &host, size, overflow.0, scale, is_screen(role)),
    };
    let now = Instant::now();
    {
        let mut state = view.state_mut();
        let shader = state.shader.as_mut().expect("a shader");
        if let Some(from) = from {
            shader
                .view
                .set_input(renderer, ShaderInput::From, Some(from));
        }
        shader.view.start_transition(duration, now);
        shader.stale = true;
        shader.canvas = canvas;
    }
    refresh_mask(surface, view, now);
    if tick_due(view) {
        start(surface);
    }
}

/// `host`'s children (its container, without the mask that hides them),
/// the box grown by `overflow` points, at `scale`, drawn into `canvas`. A
/// screen's (`whole`) is all the root shows (the dialogs and what
/// navigation hosts are beside the container) but the frames over it.
fn children_picture<'a>(
    canvas: &'a mut Option<Canvas>,
    host: &NshView,
    size: nsh_core::Size<nsh_core::Points>,
    overflow: f32,
    scale: CGFloat,
    whole: bool,
) -> Option<Pixels<'a>> {
    let container = host.container_view().and_then(|c| c.layer());
    let layer = match (&container, whole) {
        (Some(c), false) => c.clone(),
        _ => host.ns().layer()?,
    };
    let canvas = Canvas::of(canvas, picture_size(size, overflow, scale)?)?;
    let origin = (-overflow as f64, -overflow as f64);
    Some(canvas.render(&layer, origin, |context| {
        let mask = container.as_ref().and_then(|c| c.mask());
        if let Some(c) = &container {
            // SAFETY: clearing (and below restoring) the container's own mask.
            unsafe { c.setMask(None) };
        }
        // SAFETY: a getter; the sublayers are retained while hidden.
        let over: Vec<Retained<CALayer>> = unsafe { layer.sublayers() }
            .map(|l| {
                l.iter()
                    .filter(|l| l.zPosition() >= OVER && !l.isHidden())
                    .collect()
            })
            .unwrap_or_default();
        over.iter().for_each(|l| l.setHidden(true));
        layer.renderInContext(context);
        over.iter().for_each(|l| l.setHidden(false));
        if let Some(c) = &container {
            // SAFETY: the container's own mask, cleared above, set back.
            unsafe { c.setMask(mask.as_deref()) };
        }
    }))
}

fn picture_size(
    size: nsh_core::Size<nsh_core::Points>,
    overflow: f32,
    scale: CGFloat,
) -> Option<(usize, usize, CGFloat)> {
    let (w, h) = (
        size.width.0 as f64 + 2.0 * overflow as f64,
        size.height.0 as f64 + 2.0 * overflow as f64,
    );
    if w <= 0.0 || h <= 0.0 {
        return None;
    }
    // At most as large as the renderer draws.
    let scale = scale.min(nsh_engine::shader::MAX_SIDE as f64 / w.max(h));
    Some((
        (w * scale).round().max(1.0) as usize,
        (h * scale).round().max(1.0) as usize,
        scale,
    ))
}

/// Draws the layers of `layer`'s tree that are due to draw (text and
/// canvases, which draw through a delegate): `renderInContext:` takes
/// their contents as they are.
fn display_tree(layer: &CALayer) {
    layer.displayIfNeeded();
    // SAFETY: a getter; the sublayers are retained while they are drawn.
    if let Some(sublayers) = unsafe { layer.sublayers() } {
        for sublayer in sublayers.iter() {
            display_tree(&sublayer);
        }
    }
}

/// A picture's pixels: premultiplied RGBA, its width, height and stride.
type Pixels<'a> = (&'a [u8], u32, u32, u32);

/// A bitmap context and the pixels it draws into, kept so that a picture
/// taken again at the same size draws into them again: a picture as large
/// as the renderer draws is 64 MB, too much to allocate on every display
/// frame.
struct Canvas {
    context: CFRetained<objc2_core_graphics::CGContext>,
    /// Width and height in pixels, and pixels per point.
    size: (usize, usize, CGFloat),
}

impl Canvas {
    /// `slot`'s canvas, made again when it is not of `size`.
    fn of(slot: &mut Option<Canvas>, size: (usize, usize, CGFloat)) -> Option<&mut Canvas> {
        if slot.as_ref().is_none_or(|c| c.size != size) {
            *slot = Canvas::new(size);
        }
        slot.as_mut()
    }

    fn new((pw, ph, scale): (usize, usize, CGFloat)) -> Option<Canvas> {
        use objc2_core_graphics::{
            CGBitmapContextCreate, CGColorSpace, CGImageAlphaInfo, CGImageByteOrderInfo,
            kCGColorSpaceSRGB,
        };
        // SAFETY: a constant of CoreGraphics.
        let space = CGColorSpace::with_name(Some(unsafe { kCGColorSpaceSRGB }))?;
        // SAFETY: CoreGraphics allocates the pixels (null data) and frees
        // them with the context.
        let context = unsafe {
            CGBitmapContextCreate(
                std::ptr::null_mut(),
                pw,
                ph,
                8,
                pw * 4,
                Some(&space),
                CGImageAlphaInfo::PremultipliedLast.0 | CGImageByteOrderInfo::Order32Big.0,
            )
        }?;
        Some(Canvas {
            context,
            size: (pw, ph, scale),
        })
    }

    /// `layer` (its views draw y down) rendered with its point `origin` at
    /// the top-left, top row first. Its layers that are due to draw draw
    /// first; then `draw` renders into the context (`renderInContext:`),
    /// hiding what it leaves out (after the drawing, which sets the views'
    /// layers again).
    fn render(
        &mut self,
        layer: &CALayer,
        origin: (f64, f64),
        draw: impl FnOnce(&objc2_core_graphics::CGContext),
    ) -> Pixels<'_> {
        use objc2_core_graphics::{
            CGBitmapContextGetBytesPerRow, CGBitmapContextGetData, CGContext,
        };
        display_tree(layer);
        let (pw, ph, scale) = self.size;
        let context = &self.context;
        CGContext::clear_rect(
            Some(context),
            CGRect::new(
                CGPoint::new(0.0, 0.0),
                CGSize::new(pw as CGFloat, ph as CGFloat),
            ),
        );
        CGContext::save_g_state(Some(context));
        CGContext::translate_ctm(Some(context), 0.0, ph as CGFloat);
        CGContext::scale_ctm(Some(context), scale, -scale);
        CGContext::translate_ctm(Some(context), -origin.0, -origin.1);
        // The layer is rendered on the main thread, which owns it.
        crate::surface::quiet(|| draw(context));
        CGContext::restore_g_state(Some(context));
        let stride = CGBitmapContextGetBytesPerRow(Some(context));
        let data = CGBitmapContextGetData(Some(context)).cast::<u8>();
        if data.is_null() {
            return (&[], 0, 0, 0);
        }
        // SAFETY: the context's `stride * ph` bytes, which it keeps while
        // `self` is borrowed and nothing draws into.
        let pixels = unsafe { std::slice::from_raw_parts(data, stride * ph) };
        (pixels, pw as u32, ph as u32, stride as u32)
    }
}

/// Takes the pictures `view`'s shader is due ([`ShaderState::stale`]).
fn take_pictures(surface: &Surface, view: &NshView, renderer: &Renderer, now: Instant) {
    let (role, stale, backdrop, overflow) = {
        let mut state = view.state_mut();
        let Some(shader) = state.shader.as_mut() else {
            return;
        };
        // An idle transition draws nothing: its children show.
        let running = match shader.role {
            ShaderRole::Transition | ShaderRole::ScreenTransition => {
                shader.view.replaces_children(now)
            }
            _ => true,
        };
        let stale = shader.stale && running && shader.role != ShaderRole::Fill;
        let backdrop = shader.backdrop_stale;
        // An idle transition's are taken again when it starts.
        shader.stale = false;
        shader.backdrop_stale = false;
        (shader.role, stale, backdrop, shader.view.overflow().0)
    };
    if !stale && !backdrop {
        return;
    }
    let host = host(surface, view, role);
    let Some(window) = host.ns().window() else {
        return;
    };
    let scale = window.backingScaleFactor();
    let size = host.state().frame.size;
    // The canvases leave the state while they draw (rendering lays out
    // and draws views, which may look at it).
    let (mut canvas, mut backdrop_canvas) = {
        let mut state = view.state_mut();
        let Some(shader) = state.shader.as_mut() else {
            return;
        };
        (shader.canvas.take(), shader.backdrop_canvas.take())
    };
    let mut pictures = Vec::new();
    if stale
        && let Some(p) =
            children_picture(&mut canvas, &host, size, overflow, scale, is_screen(role))
    {
        let input = match role {
            ShaderRole::Transition | ShaderRole::ScreenTransition => ShaderInput::To,
            _ => ShaderInput::Content,
        };
        pictures.push((input, p));
    }
    if backdrop
        && let Some(root) = crate::window::root_containing(surface, view)
        && let (Some(root), Some(layer)) = (root.ns().layer(), view.ns().layer())
        && let Some(picture) = picture_size(size, overflow, scale)
        && let Some(backdrop) = Canvas::of(&mut backdrop_canvas, picture)
    {
        // What is behind: the surface without the view (and what it holds),
        // where the view's layer is.
        let at = layer.convertRect_toLayer(layer.bounds(), Some(&root));
        let origin = (at.origin.x - overflow as f64, at.origin.y - overflow as f64);
        let pixels = backdrop.render(&root, origin, |context| {
            let hidden = layer.isHidden();
            layer.setHidden(true);
            root.renderInContext(context);
            layer.setHidden(hidden);
        });
        pictures.push((ShaderInput::Backdrop, pixels));
    }
    let mut state = view.state_mut();
    let Some(shader) = state.shader.as_mut() else {
        return;
    };
    for (input, pixels) in pictures {
        shader.view.set_input(renderer, input, Some(pixels));
    }
    shader.canvas = canvas;
    shader.backdrop_canvas = backdrop_canvas;
}

/// The values of the layer's animated slots. The animator is borrowed
/// while it writes them: rendering starts once it is done ([`wake`]).
pub(crate) fn set_args(view: &NshView, values: &[(u16, AnimationValue)]) {
    {
        let mut state = view.state_mut();
        let Some(shader) = state.shader.as_mut() else {
            return;
        };
        for &(slot, value) in values {
            shader.view.set_slot(slot, value);
        }
    }
    tick(view);
}

/// It was deleted: no more pictures are taken for it. A screen effect's
/// or transition's frames, on the root rather than in the view, leave with
/// it, and the root's children show again unless another screen shader
/// hides them.
pub(crate) fn deleted(surface: &Surface, view: &NshView) {
    let screen = {
        let mut state = view.state_mut();
        let Some(shader) = state.shader.as_mut() else {
            return;
        };
        let screen = is_screen(shader.role);
        if screen {
            shader.masked = false;
            crate::surface::quiet(|| shader.layer.removeFromSuperlayer());
        }
        screen
    };
    track(surface, view, false);
    if screen {
        // The view may have left its window already: every root's mask.
        sync_mask(surface, &surface.root);
        for root in crate::window::roots(surface) {
            sync_mask(surface, &root);
        }
    }
}

/// Its size changed: a frame of the new size is rendered.
pub(crate) fn resized(surface: &Rc<Surface>, view: &NshView) {
    if view.state().shader.is_some() && tick(view) {
        start(surface);
    }
}

/// It can be seen again (after [`crate::mount::Mounter::draw_when_shown`]
/// put it off): renders what it missed.
pub(crate) fn shown(view: &NshView) {
    let surface = {
        let mut state = view.state_mut();
        let Some(shader) = state.shader.as_mut() else {
            return;
        };
        if !shader.hidden {
            return;
        }
        shader.hidden = false;
        shader.surface.upgrade()
    };
    // A picture that fell due while it was out of sight is taken now.
    if tick_due(view)
        && let Some(surface) = surface
    {
        start(&surface);
    }
}

/// Starts rendering the views whose animated slots were written
/// ([`set_args`]), once the animator is no longer borrowed.
pub(crate) fn wake(surface: &Surface) {
    let shaders = &surface.shaders;
    if shaders.running.get() || shaders.views.borrow().is_empty() {
        return;
    }
    if let Some(surface) = Surface::with_key(surface.key()) {
        start(&surface);
    }
}

/// The app stopped: its views render no more, and the screen effects'
/// and transitions' frames leave the root (which the next app keeps),
/// showing its children again.
pub(crate) fn clear(surface: &Surface) {
    let pictured = std::mem::take(&mut *surface.shaders.pictured.borrow_mut());
    for view in &pictured {
        if let Some(shader) = view.state_mut().shader.as_mut()
            && is_screen(shader.role)
        {
            shader.masked = false;
            crate::surface::quiet(|| shader.layer.removeFromSuperlayer());
        }
    }
    crate::decor::hide_children(&surface.root, false);
    for root in crate::window::roots(surface) {
        crate::decor::hide_children(&root, false);
    }
    let key = surface.key();
    PICTURING.with(|p| p.borrow_mut().retain(|&k| k != key));
    surface.shaders.views.borrow_mut().clear();
    surface.shaders.running.set(false);
}

/// Adds `view` to the views rendering if it has a frame to render; whether
/// it was added (the caller then [`start`]s the frame callback).
fn tick(view: &NshView) -> bool {
    tick_if(view, false)
}

/// As [`tick`], also when only pictures are due.
fn tick_due(view: &NshView) -> bool {
    tick_if(view, true)
}

fn tick_if(view: &NshView, pictures_due: bool) -> bool {
    let surface = {
        let mut state = view.state_mut();
        let Some(shader) = state.shader.as_mut() else {
            return false;
        };
        let due =
            shader.view.wants_frame() || (pictures_due && (shader.stale || shader.backdrop_stale));
        if shader.ticking || shader.hidden || !due {
            return false;
        }
        let Some(surface) = shader.surface.upgrade() else {
            return false;
        };
        if surface.shaders.renderer().is_none() {
            return false;
        }
        shader.ticking = true;
        surface
    };
    surface.shaders.views.borrow_mut().push(view.clone());
    true
}

/// Runs the frame callback that renders the views, if it does not run.
fn start(surface: &Rc<Surface>) {
    let shaders = &surface.shaders;
    if shaders.running.get() || shaders.views.borrow().is_empty() {
        return;
    }
    shaders.running.set(true);
    surface.add_draw_callback(|surface, _| {
        let more = frame(surface);
        if !more {
            surface.shaders.running.set(false);
        }
        more
    });
}

/// One display frame: each view renders and collects; whether a view has
/// more to render.
fn frame(surface: &Rc<Surface>) -> bool {
    let shaders = &surface.shaders;
    let Some(renderer) = shaders.renderer() else {
        return false;
    };
    let Ok(mounter) = surface.mounter.try_borrow() else {
        return true;
    };
    let views = std::mem::take(&mut *shaders.views.borrow_mut());
    let now = Instant::now();
    let mut kept = Vec::with_capacity(views.len());
    for view in views {
        let deleted = mounter.views.get(&view.id()) != Some(&view);
        let screen = view
            .state()
            .shader
            .as_ref()
            .is_some_and(|s| is_screen(s.role));
        let hidden = !deleted && !screen && !view.shown();
        if !deleted && !hidden {
            take_pictures(surface, &view, renderer, now);
        }
        let more = !deleted && !hidden && render_view(surface, &view, renderer, now);
        if more {
            kept.push(view);
            continue;
        }
        if let Some(shader) = view.state_mut().shader.as_mut() {
            shader.ticking = false;
            shader.hidden = hidden;
        }
        if hidden {
            // Rendered again once it shows ([`shown`]).
            mounter.draw_when_shown(&view, Damage::All);
        }
    }
    drop(mounter);
    let mut views = shaders.views.borrow_mut();
    kept.append(&mut views);
    *views = kept;
    !views.is_empty()
}

/// Renders and collects `view`'s frame, showing one that came back;
/// whether it has more to render.
fn render_view(surface: &Surface, view: &NshView, renderer: &Renderer, now: Instant) -> bool {
    let role = view
        .state()
        .shader
        .as_ref()
        .map_or(ShaderRole::Fill, |s| s.role);
    let host = host(surface, view, role);
    let scale = host.ns().window().map_or(2.0, |w| w.backingScaleFactor()) as f32;
    let size = host.state().frame.size;
    let mut state = view.state_mut();
    let Some(shader) = state.shader.as_mut() else {
        return false;
    };
    shader.view.set_size(size, scale);
    if role != ShaderRole::Fill {
        // Over the box, `overflow` points beyond it.
        let o = shader.view.overflow().0 as f64;
        crate::surface::quiet(|| {
            shader.layer.setFrame(CGRect::new(
                CGPoint::new(-o, -o),
                CGSize::new(
                    size.width.0 as f64 + 2.0 * o,
                    size.height.0 as f64 + 2.0 * o,
                ),
            ));
        });
    }
    if shader.view.render(renderer, now) {
        let image = frame_image(shader.view.frame());
        let contents = image.as_deref().map(crate::decor::image_object);
        // SAFETY: a CGImage is a valid `contents` object (none clears it).
        crate::surface::quiet(|| unsafe { shader.layer.setContents(contents.as_deref()) });
    }
    // A transition that ended: its children show as they are (unless a
    // screen effect still hides the root's).
    if matches!(role, ShaderRole::Transition | ShaderRole::ScreenTransition)
        && shader.masked
        && !shader.view.replaces_children(now)
    {
        shader.masked = false;
        // SAFETY: clearing the contents.
        crate::surface::quiet(|| unsafe { shader.layer.setContents(None) });
        drop(state);
        sync_mask(surface, &host);
        return false;
    }
    shader.view.wants_frame() || shader.stale || shader.backdrop_stale
}

/// A frame's premultiplied sRGB RGBA pixels as a CGImage (`None` when it is
/// empty).
fn frame_image(frame: &Frame) -> Option<CFRetained<CGImage>> {
    rgba_image(frame.width as usize, frame.height as usize, frame.rows())
}

/// `height` rows of `width` premultiplied sRGB RGBA pixels as a CGImage
/// (`None` when it is empty).
fn rgba_image<'a>(
    width: usize,
    height: usize,
    rows: impl Iterator<Item = &'a [u8]>,
) -> Option<CFRetained<CGImage>> {
    use objc2_core_graphics::{
        CGBitmapContextCreate, CGBitmapContextCreateImage, CGBitmapContextGetBytesPerRow,
        CGBitmapContextGetData, CGColorSpace, CGImageAlphaInfo, CGImageByteOrderInfo,
        kCGColorSpaceSRGB,
    };
    if width == 0 || height == 0 {
        return None;
    }
    // SAFETY: a constant of CoreGraphics.
    let space = CGColorSpace::with_name(Some(unsafe { kCGColorSpaceSRGB }))?;
    // SAFETY: CoreGraphics allocates the pixels (null data) of an RGBA
    // context of these dimensions; each row is copied within its
    // `bytes_per_row` bytes of the `bytes_per_row * height` while `context`
    // lives.
    unsafe {
        let context = CGBitmapContextCreate(
            std::ptr::null_mut(),
            width,
            height,
            8,
            width * 4,
            Some(&space),
            CGImageAlphaInfo::PremultipliedLast.0 | CGImageByteOrderInfo::Order32Big.0,
        )?;
        let data = CGBitmapContextGetData(Some(&context)).cast::<u8>();
        if data.is_null() {
            return None;
        }
        let stride = CGBitmapContextGetBytesPerRow(Some(&context));
        let pixels = std::slice::from_raw_parts_mut(data, stride * height);
        for (row, src) in rows.enumerate() {
            let len = src.len().min(stride);
            pixels[row * stride..row * stride + len].copy_from_slice(&src[..len]);
        }
        CGBitmapContextCreateImage(Some(&context))
    }
}

/// A page's or a dialog's coming or going drawn through its
/// `transitionShader` ([`nsh_core::NavShader`]): a layer over `host` (the
/// stack, or the root for a dialog) showing the shader's frames, which read
/// the host without the upper side as `from` and with it as `to`; going
/// away runs backwards. Both are pictured on its first display frame (a
/// view navigation just showed has no layer in the tree before AppKit
/// displays the window, and out of it its layers draw y up). After that
/// only the side that stays live is (the upper side coming, the lower
/// going: the other is what left): on the next few frames, while what just
/// showed is laid out and drawn, then only after a view under the host
/// changed ([`Mark`]). Navigation keeps the views at rest under it and ends
/// it with its motion, [`LINGER`] after the shader's run.
pub(crate) struct NavOverlay {
    view: RefCell<ShaderView>,
    layer: Retained<CALayer>,
    host: NshView,
    upper: Retained<objc2_app_kit::NSView>,
    /// What the upper side shows, when it is a picture navigation hosts
    /// (a page or a dialog that left: its view's layer is out of the tree).
    image: Option<CFRetained<CGImage>>,
    backwards: bool,
    duration: std::time::Duration,
    picture: (usize, usize, CGFloat),
    /// The display frames it has run.
    frames: Cell<u32>,
    /// Set when a view under the host changes: the live side is pictured
    /// again.
    mark: Rc<Mark>,
    /// Where the sides are drawn.
    canvas: RefCell<Option<Canvas>>,
}

/// A running [`NavOverlay`]'s host and whether a view under it changed
/// since its live side was pictured ([`ui_changed`] sets it).
pub(crate) struct Mark {
    host: Retained<objc2_app_kit::NSView>,
    dirty: Cell<bool>,
}

impl NavOverlay {
    /// Starts the shader over `host`, whose upper side is `upper` (a view
    /// in it, showing `image` when it is a picture); `None`: there is no
    /// GPU device, or nothing to show.
    pub(crate) fn new(
        surface: &Surface,
        host: &NshView,
        upper: &objc2_app_kit::NSView,
        image: Option<CFRetained<CGImage>>,
        shader: &nsh_core::NavShader,
        backwards: bool,
    ) -> Option<NavOverlay> {
        surface.shaders.renderer()?;
        let layer = host.ns().layer()?;
        let scale = host.ns().window().map_or(2.0, |w| w.backingScaleFactor());
        let size = host.state().frame.size;
        let picture = picture_size(size, 0.0, scale)?;
        let mut view = ShaderView::default();
        view.set_layer(Some(shader.layer.clone()));
        view.set_size(size, picture.2 as f32);
        let mark = Rc::new(Mark {
            host: Retained::from(host.ns()),
            dirty: Cell::new(false),
        });
        surface
            .shaders
            .overlays
            .borrow_mut()
            .push(Rc::downgrade(&mark));
        sync_picturing(surface);
        let overlay = NavOverlay {
            view: RefCell::new(view),
            layer: CALayer::new(),
            host: host.clone(),
            upper: Retained::from(upper),
            image,
            backwards,
            duration: shader.duration,
            picture,
            frames: Cell::new(0),
            mark,
            canvas: RefCell::new(None),
        };
        // SAFETY: an immutable Core Animation constant.
        overlay
            .layer
            .setContentsGravity(unsafe { kCAGravityResize });
        overlay.layer.setZPosition(OVER);
        // Until its first frame: what showed. Coming, the lower side (the
        // host as it is, the upper side left out); going, the views at rest
        // show it (the upper side on top).
        let image = (!backwards)
            .then(|| {
                let mut canvas = overlay.canvas.borrow_mut();
                let (pixels, w, h, stride) = overlay.side(&mut canvas, false)?;
                rgba_image(
                    w as usize,
                    h as usize,
                    pixels.chunks(stride as usize).map(|r| &r[..w as usize * 4]),
                )
            })
            .flatten();
        let contents = image.as_deref().map(crate::decor::image_object);
        crate::surface::quiet(|| {
            overlay.layer.setFrame(CGRect::new(
                CGPoint::new(0.0, 0.0),
                CGSize::new(size.width.0 as f64, size.height.0 as f64),
            ));
            // SAFETY: a CGImage is a valid `contents` object.
            unsafe { overlay.layer.setContents(contents.as_deref()) };
            layer.addSublayer(&overlay.layer);
        });
        Some(overlay)
    }

    /// The host without the upper side (`with_upper`: with it on top, drawn
    /// on its own where its view is), the overlay left out, drawn into
    /// `canvas`.
    fn side<'a>(&self, canvas: &'a mut Option<Canvas>, with_upper: bool) -> Option<Pixels<'a>> {
        let (Some(host), Some(upper)) = (self.host.ns().layer(), self.upper.layer()) else {
            return None;
        };
        display_tree(&upper);
        let at = self.upper.convertPoint_toView(
            objc2_foundation::NSPoint::new(0.0, 0.0),
            Some(self.host.ns()),
        );
        let canvas = Canvas::of(canvas, self.picture)?;
        Some(canvas.render(&host, (0.0, 0.0), |context| {
            use objc2_core_graphics::CGContext;
            let hidden = (upper.isHidden(), self.layer.isHidden());
            upper.setHidden(true);
            self.layer.setHidden(true);
            host.renderInContext(context);
            upper.setHidden(hidden.0);
            self.layer.setHidden(hidden.1);
            if with_upper {
                CGContext::save_g_state(Some(context));
                CGContext::translate_ctm(Some(context), at.x, at.y);
                match &self.image {
                    // Images draw y up.
                    Some(image) => {
                        let size = self.upper.frame().size;
                        CGContext::translate_ctm(Some(context), 0.0, size.height);
                        CGContext::scale_ctm(Some(context), 1.0, -1.0);
                        let rect = CGRect::new(CGPoint::new(0.0, 0.0), size);
                        CGContext::draw_image(Some(context), rect, Some(image));
                    }
                    None => upper.renderInContext(context),
                }
                CGContext::restore_g_state(Some(context));
            }
        }))
    }

    /// The sides display frame `frame` (from 0) pictures: both on the
    /// first, then the live one (`to` coming, `from` going) while what just
    /// showed settles ([`SETTLING_FRAMES`]) or once a view under the host
    /// changed (`dirty`), else none.
    fn due(frame: u32, backwards: bool, dirty: bool) -> Vec<ShaderInput> {
        if frame == 0 {
            vec![ShaderInput::From, ShaderInput::To]
        } else if !dirty && frame >= SETTLING_FRAMES {
            Vec::new()
        } else if backwards {
            vec![ShaderInput::From]
        } else {
            vec![ShaderInput::To]
        }
    }

    /// One display frame: pictures the sides that are due ([`Self::due`]),
    /// renders and shows a frame that came back. Once the shader's own
    /// clock ended it renders nothing more and shows the frames still on
    /// their way ([`LINGER`] keeps it up for them).
    pub(crate) fn tick(&self, surface: &Surface) {
        let Some(renderer) = surface.shaders.renderer() else {
            return;
        };
        let frame = self.frames.get();
        self.frames.set(frame.saturating_add(1));
        let first = frame == 0;
        let mut view = self.view.borrow_mut();
        let now = Instant::now();
        if !first && !view.transitioning(now) {
            if view.collect_frame(renderer) {
                let image = frame_image(view.frame());
                let contents = image.as_deref().map(crate::decor::image_object);
                // SAFETY: a CGImage is a valid `contents` object.
                crate::surface::quiet(|| unsafe { self.layer.setContents(contents.as_deref()) });
            }
            return;
        }
        let dirty = self.mark.dirty.replace(false);
        let mut canvas = self.canvas.borrow_mut();
        for input in Self::due(frame, self.backwards, dirty) {
            let picture = self.side(&mut canvas, input == ShaderInput::To);
            view.set_input(renderer, input, picture);
        }
        // Picturing draws views due to draw, which may mark it again.
        self.mark.dirty.set(false);
        if first {
            if self.backwards {
                view.start_transition_backwards(self.duration, now);
            } else {
                view.start_transition(self.duration, now);
            }
        }
        if view.render(renderer, now) {
            let image = frame_image(view.frame());
            let contents = image.as_deref().map(crate::decor::image_object);
            // SAFETY: a CGImage is a valid `contents` object.
            crate::surface::quiet(|| unsafe { self.layer.setContents(contents.as_deref()) });
        }
    }
}

impl Drop for NavOverlay {
    fn drop(&mut self) {
        crate::surface::quiet(|| self.layer.removeFromSuperlayer());
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use nsh_core::shader::Shader;

    use super::*;

    /// A shader view showing a layer of `role`, outside any surface.
    fn state(role: ShaderRole) -> ShaderState {
        let shader =
            Shader::compile("fn shade(uv: vec2f) -> vec4f { return vec4f(uv, 0.0, 1.0); }")
                .expect("a shader");
        let mut layer = ShaderLayer::new(shader, &[], &mut Vec::new());
        layer.role = role;
        let mut state = ShaderState::new(Weak::new());
        state.role = role;
        state.view.set_layer(Some(Arc::new(layer)));
        state
    }

    /// Shaders whose GPU device was looked for and not found.
    fn no_device() -> Shaders {
        Shaders {
            renderer: OnceCell::from(None),
            ..Shaders::default()
        }
    }

    #[test]
    fn without_a_device_nothing_hides_its_children() {
        let shaders = no_device();
        let now = Instant::now();
        for role in [ShaderRole::Effect, ShaderRole::Screen] {
            assert!(!state(role).hides(&shaders, now), "{role:?}");
        }
        for role in [ShaderRole::Transition, ShaderRole::ScreenTransition] {
            let mut s = state(role);
            s.view.start_transition(Duration::from_millis(300), now);
            assert!(!s.hides(&shaders, now), "{role:?}");
        }
    }

    #[test]
    fn an_effect_hides_its_children_and_a_transition_while_it_runs() {
        let shaders = Shaders::default();
        if shaders.renderer().is_none() {
            eprintln!("no GPU: skipped");
            return;
        }
        let now = Instant::now();
        for role in [ShaderRole::Effect, ShaderRole::Screen] {
            let mut s = state(role);
            assert!(s.hides(&shaders, now), "{role:?}");
            // It shows nothing of its own any more.
            s.view.set_layer(None);
            assert!(!s.hides(&shaders, now), "{role:?}");
        }
        let duration = Duration::from_millis(300);
        for role in [ShaderRole::Transition, ShaderRole::ScreenTransition] {
            let mut s = state(role);
            assert!(!s.hides(&shaders, now), "{role:?}: idle");
            s.view.start_transition(duration, now);
            assert!(s.hides(&shaders, now), "{role:?}");
            // A new layer while it runs (another uniform) keeps them hidden.
            let layer = s.view.layer().cloned();
            s.view.set_layer(layer);
            assert!(s.hides(&shaders, now), "{role:?}: a new layer");
            assert!(!s.hides(&shaders, now + duration), "{role:?}: ended");
        }
        assert!(!state(ShaderRole::Fill).hides(&shaders, now));
    }

    /// A layer of `role` drawing with `source`'s `shade`.
    fn reading(role: ShaderRole, source: &str) -> ShaderState {
        let mut layer = ShaderLayer::new(
            Shader::compile(source).expect("a shader"),
            &[],
            &mut Vec::new(),
        );
        layer.role = role;
        let mut state = ShaderState::new(Weak::new());
        state.role = role;
        state.view.set_layer(Some(Arc::new(layer)));
        state
    }

    #[test]
    fn only_a_shader_that_reads_its_children_pictures_them_again() {
        let plain = "fn shade(uv: vec2f) -> vec4f { return vec4f(uv, 0.0, 1.0); }";
        let content = "fn shade(uv: vec2f) -> vec4f { return sample_content(uv); }";
        let to = "fn shade(uv: vec2f) -> vec4f { return sample_to(uv); }";
        for role in [ShaderRole::Effect, ShaderRole::Screen] {
            assert!(!reading(role, plain).reads_children(), "{role:?}");
            assert!(reading(role, content).reads_children(), "{role:?}");
        }
        for role in [ShaderRole::Transition, ShaderRole::ScreenTransition] {
            assert!(!reading(role, plain).reads_children(), "{role:?}");
            assert!(reading(role, to).reads_children(), "{role:?}");
        }
        assert!(!reading(ShaderRole::Fill, content).reads_children());
    }

    #[test]
    fn a_page_overlay_pictures_its_live_side_only_while_it_settles_or_changes() {
        use ShaderInput::{From, To};
        assert_eq!(NavOverlay::due(0, false, false), [From, To]);
        assert_eq!(NavOverlay::due(0, true, false), [From, To]);
        for frame in 1..SETTLING_FRAMES {
            assert_eq!(
                NavOverlay::due(frame, false, false),
                [To],
                "coming, {frame}"
            );
            assert_eq!(
                NavOverlay::due(frame, true, false),
                [From],
                "going, {frame}"
            );
        }
        // Settled: nothing, unless a view under the host changed.
        assert!(NavOverlay::due(SETTLING_FRAMES, false, false).is_empty());
        assert!(NavOverlay::due(100, true, false).is_empty());
        assert_eq!(NavOverlay::due(100, false, true), [To]);
        assert_eq!(NavOverlay::due(100, true, true), [From]);
    }

    #[test]
    fn pictures_of_one_size_draw_into_the_same_canvas() {
        use objc2_core_graphics::CGBitmapContextGetData;
        let mut slot = None;
        let size = (8, 4, 2.0);
        let first = CGBitmapContextGetData(Some(&Canvas::of(&mut slot, size).unwrap().context));
        let again = CGBitmapContextGetData(Some(&Canvas::of(&mut slot, size).unwrap().context));
        assert_eq!(first, again, "kept");
        let other = Canvas::of(&mut slot, (16, 4, 2.0)).unwrap();
        assert_eq!(other.size, (16, 4, 2.0), "made again for another size");
        // What it drew before is cleared: a layer drawing nothing leaves it
        // transparent.
        let layer = CALayer::new();
        layer.setBounds(CGRect::new(CGPoint::new(0.0, 0.0), CGSize::new(8.0, 2.0)));
        let (pixels, w, h, stride) = other.render(&layer, (0.0, 0.0), |context| {
            objc2_core_graphics::CGContext::set_rgb_fill_color(Some(context), 1.0, 0.0, 0.0, 1.0);
            objc2_core_graphics::CGContext::fill_rect(
                Some(context),
                CGRect::new(CGPoint::new(0.0, 0.0), CGSize::new(1.0, 1.0)),
            );
        });
        assert_eq!((w, h), (16, 4));
        assert!(stride >= 64);
        assert_eq!(&pixels[..4], &[255, 0, 0, 255], "the drawing, top-left");
        let (pixels, ..) = other.render(&layer, (0.0, 0.0), |_| {});
        assert!(pixels.iter().all(|&b| b == 0), "cleared before drawing");
    }
}
