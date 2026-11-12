//! Shader views: the layer [`MountItem::Shader`](nsh_core::MountItem)
//! mounts on a view, rendered by `nsh_engine::shader` and shown as the contents of
//! a sublayer under the view's children, clipped to its rounded box as a
//! background is ([`crate::decor`] shapes it with the view).
//!
//! The surface opens the GPU device the first time a shader is mounted
//! ([`Shaders`]). The shader views with a frame to render or collect
//! ([`ShaderView::wants_frame`]: their uniforms or size changed, or they
//! read `nsh.time`) render at their window's backing scale, on one frame
//! callback of the surface's display link while their frames change with
//! time or anything else wants frames; a view that only changed (a uniform
//! the app set) renders once the batch is applied, and its frame shows
//! when the GPU says it is done ([`Drive`]), without the display link. A
//! frame that comes back becomes the layer's contents (an IOSurface, else
//! a `CGImage`), stretched over the view's box. A view
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
//! `sample_backdrop`, what draws under the view where it reads: the root
//! without the view, what it holds and the layers that draw over it
//! ([`over_reader`]), only the reader's box and overflow drawn
//! ([`backdrop_picture`]). They are taken again on the frame after the
//! core says they changed ([`input_changed`]) or the UI thread changed a
//! view in them ([`ui_changed`]); a backdrop only when the changed view
//! (or a shader's frame) draws under the reader where it reads
//! ([`behind`]), and one with the pixels of the last is not uploaded
//! again ([`picture_hash`]). A transition pictures
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

use dispatch2::DispatchQueue;
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
    /// What renders the views now.
    drive: Cell<Drive>,
    /// The GPU's notifications asked for ([`Drive::Gpu`]): only the last
    /// one drives.
    asked: Cell<u64>,
}

/// What renders a surface's shader views. Resuming the display link for
/// one frame wakes the process about as often as keeping it running, so a
/// view that changed renders without it when nothing else wants frames.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum Drive {
    /// Nothing: no view has a frame to render or collect.
    #[default]
    Idle,
    /// A frame callback of the display link: views whose frames change
    /// with time, that read pictures, or whose frame waits for a free
    /// surface; or the link runs anyway.
    Link,
    /// The main queue, once what runs now is done: views that changed,
    /// rendering their one new frame.
    Soon,
    /// The GPU, once it finished the frames rendered: views waiting only
    /// for them to come back.
    Gpu,
}

/// What a view in [`Shaders::views`] has left, least first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Need {
    /// Nothing.
    None,
    /// A frame on its way back from the GPU.
    Pending,
    /// One new frame: something changed (after a pass, a frame that found
    /// no free surface, which the display link tries again).
    Changed,
    /// The frame clock: its frames change with time, or it takes pictures.
    Clock,
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
    /// The hash of the last backdrop given to the shader ([`picture_hash`];
    /// 0: none): one equal to it is not given again.
    backdrop_hash: u64,
    /// The layers a backdrop's picture leaves out ([`over_reader`]), kept
    /// for its allocation (empty between pictures).
    over: Vec<Retained<CALayer>>,
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
            view: surface_view(),
            layer,
            ticking: false,
            hidden: false,
            role: ShaderRole::Fill,
            stale: false,
            backdrop_stale: false,
            masked: false,
            canvas: None,
            backdrop_canvas: None,
            backdrop_hash: 0,
            over: Vec::new(),
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

    /// What it has left to render or collect. Effects and transitions
    /// render on the frame clock, with their pictures.
    fn need(&self) -> Need {
        if self.view.animates() || self.stale || self.backdrop_stale {
            Need::Clock
        } else if self.view.due() {
            if self.role == ShaderRole::Fill {
                Need::Changed
            } else {
                Need::Clock
            }
        } else if self.view.pending() {
            Need::Pending
        } else {
            Need::None
        }
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
        if layer.is_some() && surface.shaders.renderer().is_none() {
            // No GPU: the app hears it (`shadersAvailable()`); the engine
            // takes the first report only.
            surface.control(nsh_engine::EngineControl::shaders_unavailable);
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
        // The new layer's backdrop is given whether or not it changed.
        shader.backdrop_hash = 0;
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
/// that loaded): the effects around it take their pictures again, and so
/// do the backdrop readers it draws under where they read ([`behind`]).
pub(crate) fn ui_changed(view: &NshView) {
    #[cfg(feature = "terminal")]
    view.invalidate_capture();
    changed_in_surfaces(view, false);
}

/// The UI thread is about to move or restyle `view`: a backdrop reader
/// over where it draws now takes its picture again ([`behind`]), as what
/// it leaves there shows anew ([`ui_changed`] after the change sees only
/// where it went).
pub(crate) fn ui_changing(view: &NshView) {
    changed_in_surfaces(view, true);
}

fn changed_in_surfaces(view: &NshView, backdrops_only: bool) {
    // By index, not a copy of the keys: this runs on every animator
    // write (a surface leaving meanwhile only shifts the rest).
    let mut i = 0;
    while let Some(key) = PICTURING.with(|p| p.borrow().get(i).copied()) {
        i += 1;
        if let Some(surface) = Surface::with_key(key) {
            ui_changed_in(&surface, view, backdrops_only);
        }
    }
}

/// Marks the pictures `view`'s change makes due in `surface`: the
/// overlays and effects around it (not `backdrops_only`) and the backdrop
/// readers it draws under where they read.
fn ui_changed_in(surface: &Rc<Surface>, view: &NshView, backdrops_only: bool) {
    // Another surface's view (an app embedding two): none of this one's
    // pictures holds it. A window of the app's own is this surface's.
    if crate::window::root_containing(surface, view).is_none() {
        return;
    }
    // A page's or a dialog's overlay pictures its side again.
    if !backdrops_only {
        for mark in surface.shaders.overlays.borrow().iter() {
            if let Some(mark) = mark.upgrade()
                && view.ns().isDescendantOf(&mark.host)
            {
                mark.dirty.set(true);
            }
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
        let inside = !backdrops_only
            && shader.reads_children()
            && (is_screen(shader.role) || view.ns().isDescendantOf(v.ns()));
        // A backdrop already due needs no look; one that is not is due
        // when the view draws under the reader where it reads (what draws
        // over it, it holds, or draws elsewhere is not in its picture).
        let backdrop = shader
            .view
            .layer()
            .is_some_and(|l| l.shader.inputs().contains(ShaderInput::Backdrop))
            && (shader.backdrop_stale || behind(view, v, shader.view.overflow().0));
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
    // From what shows: the running transition's frame (copied on the
    // GPU), or the children.
    let (from_frame, mut canvas) = {
        let mut state = view.state_mut();
        let shader = state.shader.as_mut().expect("a shader");
        let from_frame = shader.masked
            && shader
                .view
                .set_input_from_frame(renderer, ShaderInput::From);
        (from_frame, shader.canvas.take())
    };
    let from = if from_frame {
        None
    } else {
        children_picture(&mut canvas, &host, size, overflow.0, scale, is_screen(role))
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

/// What draws under `reader` where it reads, its box grown by `overflow`
/// points, drawn into `canvas` from `root` (the reader's window's root):
/// the root's tree without the layers [`over_reader`] lists (the reader,
/// what it holds and what draws over it), as Linux paints the surface up
/// to the view. The subtrees that draw nothing there ([`cull`]: a list's
/// rows away from the reader, the rest of a page) are left out as well:
/// `renderInContext:` rasterizes every layer it is given, wherever it
/// lands, and skips hidden ones. They are hidden only while it draws, and
/// those hidden already stay so; the pixels are those of the whole tree.
/// `over` is kept for its allocation and left empty. `None`: `root` does
/// not hold `reader`.
fn backdrop_picture<'a>(
    canvas: &'a mut Canvas,
    root: &CALayer,
    reader: &CALayer,
    overflow: f32,
    over: &mut Vec<Retained<CALayer>>,
) -> Option<Pixels<'a>> {
    if !over_reader(reader, root, over) {
        over.clear();
        return None;
    }
    let at = reader.convertRect_toLayer(reader.bounds(), Some(root));
    let area = grow(at, overflow as CGFloat);
    // The layers it lists are left out anyway; [`cull`] adds after them.
    let listed = over.len();
    cull(root, area, over, listed);
    let pixels = canvas.draw((area.origin.x, area.origin.y), |context| {
        // After the drawing above, which places views' layers again.
        over.retain(|l| !l.isHidden());
        over.iter().for_each(|l| l.setHidden(true));
        root.renderInContext(context);
        over.iter().for_each(|l| l.setHidden(false));
    });
    over.clear();
    Some(pixels)
}

/// A list of layers, kept to be filled again.
type Layers = Vec<Retained<CALayer>>;

/// The layers a backdrop of `reader` leaves out, into `out`: the reader
/// (with what it holds) and, at each layer on its way up to `root`, the
/// siblings that draw over that way ([`draws_over`]): the views after the
/// reader and after each of its ancestors (NSH orders a view's subviews by
/// `zIndex` and stacking, then by order), hosted native views, the frames
/// of effects around it, borders drawn in front. Whether `root` holds
/// `reader`.
fn over_reader(reader: &CALayer, root: &CALayer, out: &mut Vec<Retained<CALayer>>) -> bool {
    out.clear();
    let mut child: Retained<CALayer> = Retained::from(reader);
    out.push(child.clone());
    while !same(&child, root) {
        let Some(parent) = child.superlayer() else {
            return false;
        };
        // SAFETY: a getter; the sublayers are retained while listed.
        if let Some(sublayers) = unsafe { parent.sublayers() }
            && let Some(at) = sublayers.iter().position(|l| same(&l, &child))
        {
            let z = child.zPosition();
            out.extend(
                sublayers
                    .iter()
                    .enumerate()
                    .filter(|(i, l)| draws_over((l.zPosition(), *i), (z, at)))
                    .map(|(_, l)| l),
            );
        }
        child = parent;
    }
    true
}

/// What [`cull`] found of a layer's tree.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Reach {
    /// Hidden already, or left out ([`over_reader`]): nothing to do.
    Out,
    /// It draws nothing in the area: the caller hides it.
    Misses,
    /// Some of it draws in the area.
    Shows,
}

/// Readies a backdrop's picture of `layer`'s tree where it meets `area`
/// (in `layer`'s space): the layers due to draw that show there draw (as
/// [`display_tree`]), and the largest subtrees that draw nothing there
/// are added to `hide` (whose first `listed` are left out already). A
/// layer draws where [`drawn`] says (its bounds, a shape's path, its
/// shadow) and its sublayers where they do, cut by its clip
/// ([`clip_rect`]); what overflows a layer that does not clip shows, so a
/// tree misses only when none of it meets the area. A tree whose reach is
/// not known (a filter, a shadow cast by its content) is kept whole, and
/// so is one where coordinates stop being finite (a flattening
/// transform).
fn cull(layer: &CALayer, area: CGRect, hide: &mut Layers, listed: usize) -> Reach {
    if layer.isHidden() || hide[..listed].iter().any(|l| same(l, layer)) {
        return Reach::Out;
    }
    let own = match drawn(layer) {
        Some(own) if finite(area) => own,
        _ => {
            display_tree(layer);
            return Reach::Shows;
        }
    };
    let shows = meets(own, area);
    let inner = match clip_rect(layer) {
        Some(clip) => intersection(area, clip),
        None => Some(area),
    };
    let start = hide.len();
    let mut any = false;
    // SAFETY: a getter; the sublayers are retained while looked at.
    if let Some(sublayers) = unsafe { layer.sublayers() } {
        for sublayer in sublayers.iter() {
            let reach = match inner {
                Some(inner) => cull(
                    &sublayer,
                    layer.convertRect_toLayer(inner, Some(&sublayer)),
                    hide,
                    listed,
                ),
                // Clipped away: hidden too, so that nothing draws it.
                None if sublayer.isHidden()
                    || hide[..listed].iter().any(|l| same(l, &sublayer)) =>
                {
                    Reach::Out
                }
                None => Reach::Misses,
            };
            match reach {
                Reach::Misses => hide.push(sublayer),
                Reach::Shows => any = true,
                Reach::Out => {}
            }
        }
    }
    if !shows && !any {
        // The whole tree misses: the caller hides it, not its parts.
        hide.truncate(start);
        return Reach::Misses;
    }
    if shows {
        layer.displayIfNeeded();
    }
    Reach::Shows
}

thread_local! {
    /// The ways up [`behind`] compares, kept for their allocations: it
    /// runs on animator writes while a backdrop reader shows.
    static WAYS: RefCell<(Layers, Layers)> =
        const { RefCell::new((Vec::new(), Vec::new())) };
}

/// The most layers [`reaches`] looks through before it takes a tree as
/// reaching the area (a whole page that moved).
const REACH_LAYERS: u32 = 256;

/// Whether `changed`, which the UI thread changed, may show in `reader`'s
/// backdrop: it draws before (under) the reader ([`order`]: an ancestor,
/// or a view before it in the order layers composite; not the reader,
/// what it holds or what draws over it), and what its tree draws, clipped
/// by its ancestors that clip (a scroll view), meets the reader's box
/// grown by `overflow` points. Unsure (no layer, no tree in common, a
/// filter, a tree too large to look through): yes.
fn behind(changed: &NshView, reader: &NshView, overflow: f32) -> bool {
    match (changed.ns().layer(), reader.ns().layer()) {
        (Some(changed), Some(reader)) => layer_behind(&changed, &reader, overflow),
        _ => true,
    }
}

/// [`behind`] for the views' layers.
fn layer_behind(changed: &CALayer, reader: &CALayer, overflow: f32) -> bool {
    WAYS.with(|ways| {
        let Ok(mut ways) = ways.try_borrow_mut() else {
            return true;
        };
        let (from, to) = &mut *ways;
        way_up(changed, from);
        way_up(reader, to);
        let behind = match order(
            &from[..],
            &to[..],
            |a, b| same(a, b),
            |p, a, b| stacks_before(p, a, b),
        ) {
            None => true,
            Some(false) => false,
            Some(true) => meets_reader(&from[..], reader, overflow),
        };
        from.clear();
        to.clear();
        behind
    })
}

/// `layer` and its superlayers up to the top of its tree, into `way`.
fn way_up(layer: &CALayer, way: &mut Vec<Retained<CALayer>>) {
    way.clear();
    let mut at: Option<Retained<CALayer>> = Some(Retained::from(layer));
    while let Some(layer) = at {
        at = layer.superlayer();
        way.push(layer);
    }
}

/// Whether what the tree of `way[0]` draws (`way` its way up, to the top
/// `reader` shares), clipped by its ancestors that clip, may meet
/// `reader`'s box grown by `overflow` points.
fn meets_reader(way: &[Retained<CALayer>], reader: &CALayer, overflow: f32) -> bool {
    let (Some(layer), Some(top)) = (way.first(), way.last()) else {
        return true;
    };
    let mut area =
        reader.convertRect_toLayer(grow(reader.bounds(), overflow as CGFloat), Some(top));
    for ancestor in &way[1..] {
        if !finite(area) {
            return true;
        }
        if let Some(clip) = clip_rect(ancestor) {
            match intersection(area, ancestor.convertRect_toLayer(clip, Some(top))) {
                Some(r) => area = r,
                None => return false,
            }
        }
    }
    let mut budget = REACH_LAYERS;
    reaches(
        layer,
        top.convertRect_toLayer(area, Some(layer)),
        &mut budget,
    )
}

/// Whether what `layer`'s tree draws may meet `area` (in `layer`'s
/// space). A layer that clips holds its tree in its clip ([`clip_rect`]);
/// what overflows one that does not shows (as in CSS), so its sublayers
/// are looked at too. Unsure (a filter, a coordinate that is not finite,
/// more layers than `budget`): yes.
fn reaches(layer: &CALayer, area: CGRect, budget: &mut u32) -> bool {
    if !finite(area) || *budget == 0 {
        return true;
    }
    *budget -= 1;
    let Some(drawn) = drawn(layer) else {
        return true;
    };
    if meets(drawn, area) {
        return true;
    }
    let area = match clip_rect(layer) {
        Some(clip) => match intersection(area, clip) {
            Some(area) => area,
            None => return false,
        },
        None => area,
    };
    // SAFETY: a getter; the sublayers are retained while looked at.
    let Some(sublayers) = (unsafe { layer.sublayers() }) else {
        return false;
    };
    sublayers
        .iter()
        .any(|l| reaches(&l, layer.convertRect_toLayer(area, Some(&l)), budget))
}

/// Where `layer` itself draws, in its space: its bounds (the contents and
/// backing store NSH draws into), a shape layer's path with its stroke,
/// and its shadow's reach. `None`: not known (a filter, such as a blur,
/// draws beyond them; a shadow without a path is cast by the content of
/// the whole tree).
fn drawn(layer: &CALayer) -> Option<CGRect> {
    use objc2_core_graphics::CGPath;
    if layer.filters().is_some_and(|f| f.count() > 0) {
        return None;
    }
    let bounds = layer.bounds();
    let shape = layer
        .downcast_ref::<objc2_quartz_core::CAShapeLayer>()
        .and_then(|s| {
            let path = s.path()?;
            // A miter reaches `miterLimit` half widths out.
            let stroke = s.lineWidth() * s.miterLimit().max(1.0) / 2.0;
            Some(grow(CGPath::bounding_box(Some(&*path)), stroke))
        });
    let own = shape.map_or(bounds, |s| union(bounds, s));
    if layer.shadowOpacity() <= 0.0 {
        return Some(own);
    }
    let path = layer.shadowPath()?;
    let cast = CGPath::bounding_box(Some(&*path));
    let offset = layer.shadowOffset();
    let cast = CGRect::new(
        CGPoint::new(cast.origin.x + offset.width, cast.origin.y + offset.height),
        cast.size,
    );
    Some(union(own, grow(cast, shadow_reach(layer.shadowRadius()))))
}

/// How far beyond its path a shadow of `radius` may draw: Core Animation
/// blurs it over about twice the radius; this keeps a margin past that.
fn shadow_reach(radius: CGFloat) -> CGFloat {
    4.0 * radius.max(0.0) + 2.0
}

/// Where `layer` clips its tree (its sublayers and contents), in its
/// space: its bounds with `masksToBounds`, its mask's frame (a shadow
/// caster's mask reaches beyond the box), or both; `None`: it does not
/// clip.
fn clip_rect(layer: &CALayer) -> Option<CGRect> {
    let mask = layer.mask().map(|m| m.frame());
    if !layer.masksToBounds() {
        return mask;
    }
    let bounds = layer.bounds();
    Some(match mask {
        Some(mask) => intersection(bounds, mask)
            .unwrap_or_else(|| CGRect::new(bounds.origin, CGSize::new(0.0, 0.0))),
        None => bounds,
    })
}

/// Whether `a` and `b` are the same layer.
fn same(a: &CALayer, b: &CALayer) -> bool {
    std::ptr::eq(a, b)
}

/// Whether `parent`'s sublayer `a` draws before (under) its sublayer `b`
/// ([`draws_over`]); yes when either is not one of them.
fn stacks_before(parent: &CALayer, a: &CALayer, b: &CALayer) -> bool {
    // SAFETY: a getter; the sublayers are retained while looked at.
    let Some(sublayers) = (unsafe { parent.sublayers() }) else {
        return true;
    };
    let (mut at_a, mut at_b) = (None, None);
    for (i, l) in sublayers.iter().enumerate() {
        if same(&l, a) {
            at_a = Some(i);
        } else if same(&l, b) {
            at_b = Some(i);
        }
    }
    match (at_a, at_b) {
        (Some(i), Some(j)) => draws_over((b.zPosition(), j), (a.zPosition(), i)),
        _ => true,
    }
}

/// Whether a sublayer at `a` (its `zPosition`, its index) draws over one
/// at `b` of the same layer: Core Animation composites sublayers by
/// `zPosition`, in their order where it is equal.
fn draws_over(a: (CGFloat, usize), b: (CGFloat, usize)) -> bool {
    a.0.partial_cmp(&b.0)
        .unwrap_or(std::cmp::Ordering::Equal)
        .then(a.1.cmp(&b.1))
        .is_gt()
}

/// Whether the node whose way up is `changed` draws before (under) the
/// one whose way up is `reader` (each itself first, the top of its tree
/// last), as core's `Core::draws_before` decides: an ancestor of the
/// reader does (its own box is behind it), the reader and what it holds
/// do not, and of two subtrees of one parent the one `before(parent, a,
/// b)` puts first does. `None`: they are in no tree together.
fn order<N>(
    changed: &[N],
    reader: &[N],
    same: impl Fn(&N, &N) -> bool,
    before: impl Fn(&N, &N, &N) -> bool,
) -> Option<bool> {
    for (j, node) in changed.iter().enumerate() {
        if let Some(i) = reader.iter().position(|r| same(r, node)) {
            return Some(match (i, j) {
                (0, _) => false,
                (_, 0) => true,
                _ => before(node, &changed[j - 1], &reader[i - 1]),
            });
        }
    }
    None
}

/// `r` grown by `by` on each side.
fn grow(r: CGRect, by: CGFloat) -> CGRect {
    CGRect::new(
        CGPoint::new(r.origin.x - by, r.origin.y - by),
        CGSize::new(r.size.width + 2.0 * by, r.size.height + 2.0 * by),
    )
}

/// Whether `r`'s coordinates are all finite (a transform that flattens a
/// layer makes conversions through it infinite or NaN).
fn finite(r: CGRect) -> bool {
    [r.origin.x, r.origin.y, r.size.width, r.size.height]
        .iter()
        .all(|v| v.is_finite())
}

/// `r` as `(x0, y0, x1, y1)`, with a negative size taken from the other
/// side, as Core Graphics does.
fn span(r: CGRect) -> (CGFloat, CGFloat, CGFloat, CGFloat) {
    let (x0, x1) = (r.origin.x, r.origin.x + r.size.width);
    let (y0, y1) = (r.origin.y, r.origin.y + r.size.height);
    (x0.min(x1), y0.min(y1), x0.max(x1), y0.max(y1))
}

/// Where `a` and `b` overlap; `None`: they do not (touching edges do not).
fn intersection(a: CGRect, b: CGRect) -> Option<CGRect> {
    let (a, b) = (span(a), span(b));
    let (x0, y0, x1, y1) = (a.0.max(b.0), a.1.max(b.1), a.2.min(b.2), a.3.min(b.3));
    (x1 > x0 && y1 > y0).then(|| CGRect::new(CGPoint::new(x0, y0), CGSize::new(x1 - x0, y1 - y0)))
}

/// Whether `a` and `b` overlap; yes when either is not finite.
fn meets(a: CGRect, b: CGRect) -> bool {
    !finite(a) || !finite(b) || intersection(a, b).is_some()
}

/// The smallest rectangle holding `a` and `b`.
fn union(a: CGRect, b: CGRect) -> CGRect {
    let (a, b) = (span(a), span(b));
    let (x0, y0, x1, y1) = (a.0.min(b.0), a.1.min(b.1), a.2.max(b.2), a.3.max(b.3));
    CGRect::new(CGPoint::new(x0, y0), CGSize::new(x1 - x0, y1 - y0))
}

/// A picture's hash ([`ShaderState::backdrop_hash`]), never 0.
fn picture_hash((pixels, width, height, stride): Pixels<'_>) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = rustc_hash::FxHasher::default();
    (width, height, stride).hash(&mut hasher);
    pixels.hash(&mut hasher);
    hasher.finish() | 1
}

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
        display_tree(layer);
        self.draw(origin, draw)
    }

    /// As [`Canvas::render`], the layers due to draw drawn by the caller.
    fn draw(
        &mut self,
        origin: (f64, f64),
        draw: impl FnOnce(&objc2_core_graphics::CGContext),
    ) -> Pixels<'_> {
        use objc2_core_graphics::{
            CGBitmapContextGetBytesPerRow, CGBitmapContextGetData, CGContext,
        };
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
    let (mut canvas, mut backdrop_canvas, mut over, mut backdrop_hash) = {
        let mut state = view.state_mut();
        let Some(shader) = state.shader.as_mut() else {
            return;
        };
        (
            shader.canvas.take(),
            shader.backdrop_canvas.take(),
            std::mem::take(&mut shader.over),
            shader.backdrop_hash,
        )
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
        && let Some(pixels) = backdrop_picture(backdrop, &root, &layer, overflow, &mut over)
    {
        // The pixels of the last (a change under an opaque view, one that
        // came back where it was) are not uploaded or rendered again.
        let hash = picture_hash(pixels);
        if hash != backdrop_hash {
            backdrop_hash = hash;
            pictures.push((ShaderInput::Backdrop, pixels));
        }
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
    shader.over = over;
    shader.backdrop_hash = backdrop_hash;
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
    if shaders.drive.get() != Drive::Idle || shaders.views.borrow().is_empty() {
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
    surface.shaders.drive.set(Drive::Idle);
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

/// Renders the views, if nothing does ([`Drive`]): on the display link
/// when one needs the frame clock or the link runs anyway, else once what
/// runs now (the batch that changed them) is done.
fn start(surface: &Rc<Surface>) {
    let shaders = &surface.shaders;
    if shaders.drive.get() != Drive::Idle || shaders.views.borrow().is_empty() {
        return;
    }
    if surface.wants_frames() || needs(surface) == Need::Clock {
        drive_on_link(surface);
        return;
    }
    shaders.drive.set(Drive::Soon);
    let key = surface.key();
    DispatchQueue::main().exec_async(move || {
        if let Some(surface) = Surface::with_key(key)
            && surface.shaders.drive.get() == Drive::Soon
        {
            pass(&surface);
        }
    });
}

/// Renders the views on every display frame until they need it no more.
fn drive_on_link(surface: &Rc<Surface>) {
    surface.shaders.drive.set(Drive::Link);
    surface.add_draw_callback(|surface, _| {
        frame(surface);
        let next = next_drive(surface);
        surface.shaders.drive.set(next);
        next == Drive::Link
    });
}

/// One pass over the views off the display link, then what renders them
/// next.
fn pass(surface: &Rc<Surface>) {
    frame(surface);
    match next_drive(surface) {
        Drive::Link => drive_on_link(surface),
        next => surface.shaders.drive.set(next),
    }
}

/// What renders the views after a pass over them: nothing when none has
/// anything left; the GPU when they only wait for frames to come back and
/// the display link does not run anyway (asking it to tell); else the
/// display link.
fn next_drive(surface: &Rc<Surface>) -> Drive {
    match needs(surface) {
        Need::None => Drive::Idle,
        Need::Pending if !surface.wants_frames() && ask_gpu(surface) => Drive::Gpu,
        _ => Drive::Link,
    }
}

/// Asks the GPU to tell, once it finished the frames rendered, the main
/// thread, which collects them ([`pass`]); whether it can.
fn ask_gpu(surface: &Surface) -> bool {
    let shaders = &surface.shaders;
    let Some(renderer) = shaders.renderer() else {
        return false;
    };
    let asked = shaders.asked.get() + 1;
    shaders.asked.set(asked);
    let key = surface.key();
    renderer.when_done(move || {
        DispatchQueue::main().exec_async(move || {
            if let Some(surface) = Surface::with_key(key)
                && surface.shaders.drive.get() == Drive::Gpu
                && surface.shaders.asked.get() == asked
            {
                pass(&surface);
            }
        });
    })
}

/// What the views rendering have left, the most of them.
fn needs(surface: &Surface) -> Need {
    surface
        .shaders
        .views
        .borrow()
        .iter()
        .map(need)
        .max()
        .unwrap_or(Need::None)
}

/// What `view` has left ([`ShaderState::need`]).
fn need(view: &NshView) -> Need {
    view.state()
        .shader
        .as_ref()
        .map_or(Need::None, |s| s.need())
}

/// One pass over the views (a display frame's, or one off the display
/// link: [`Drive`]): each renders and collects; those with more to render
/// or collect stay.
fn frame(surface: &Rc<Surface>) {
    let shaders = &surface.shaders;
    let Some(renderer) = shaders.renderer() else {
        return;
    };
    // Mounting: the views stay for the next pass.
    let Ok(mounter) = surface.mounter.try_borrow() else {
        return;
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
}

/// Renders and collects `view`'s frame, showing one that came back;
/// whether it has more to render. A frame that showed (or a transition's
/// that went) changes what the backdrop readers over it read where it
/// draws ([`behind`]): they picture it again.
fn render_view(surface: &Rc<Surface>, view: &NshView, renderer: &Renderer, now: Instant) -> bool {
    let (more, showed) = show_frame(surface, view, renderer, now);
    if showed {
        ui_changed_in(surface, view, true);
    }
    more
}

/// [`render_view`]'s frame: whether it has more to render, and whether
/// what its layer shows changed.
fn show_frame(
    surface: &Surface,
    view: &NshView,
    renderer: &Renderer,
    now: Instant,
) -> (bool, bool) {
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
        return (false, false);
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
    let showed = shader.view.render(renderer, now);
    if showed {
        display_frame(&shader.layer, &shader.view);
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
        return (false, true);
    }
    let more = shader.view.wants_frame() || shader.stale || shader.backdrop_stale;
    (more, showed)
}

/// A shader view whose frames go to IOSurfaces ([`display_frame`]).
fn surface_view() -> ShaderView {
    let mut view = ShaderView::default();
    view.show_on_surfaces();
    view
}

/// Shows `view`'s last frame in `layer`: its IOSurface, which the window
/// server shows as it is and matches from sRGB to the display on the GPU;
/// else (no Metal device) the pixels read back, as a CGImage, whose colours
/// Core Animation matches on the main thread.
fn display_frame(layer: &CALayer, view: &ShaderView) {
    let contents = match view.surface() {
        Some(surface) => Some(surface_object(surface)),
        None => frame_image(view.frame())
            .as_deref()
            .map(crate::decor::image_object),
    };
    // SAFETY: an IOSurface and a CGImage are valid `contents` objects (none
    // clears it).
    crate::surface::quiet(|| unsafe { layer.setContents(contents.as_deref()) });
}

/// An IOSurface as an object (a `contents` value).
fn surface_object(surface: &objc2_io_surface::IOSurfaceRef) -> Retained<objc2::runtime::AnyObject> {
    let ptr = surface as *const objc2_io_surface::IOSurfaceRef as *mut objc2::runtime::AnyObject;
    // SAFETY: an IOSurfaceRef is an Objective-C object (`IOSurface`, toll-free
    // bridged); retained for the result.
    unsafe { Retained::retain(ptr) }.expect("surface")
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
        let mut view = surface_view();
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
                display_frame(&self.layer, &view);
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
            display_frame(&self.layer, &view);
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
    use objc2_quartz_core::CATransform3D;

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

    /// A fill that changed renders off the display link and waits for the
    /// GPU after; what changes with time or takes pictures keeps the frame
    /// clock.
    #[test]
    fn only_what_changes_with_time_or_takes_pictures_needs_the_frame_clock() {
        assert_eq!(state(ShaderRole::Fill).need(), Need::Changed);
        assert_eq!(state(ShaderRole::Effect).need(), Need::Clock);
        let timed = |paused: bool| {
            let shader = Shader::compile(
                "fn shade(uv: vec2f) -> vec4f { return vec4f(fract(nsh.time), 0.0, 0.0, 1.0); }",
            )
            .expect("a shader");
            let layer = ShaderLayer::new(shader, &[], &mut Vec::new()).with_paused(paused);
            let mut s = ShaderState::new(Weak::new());
            s.view.set_layer(Some(Arc::new(layer)));
            s.need()
        };
        assert_eq!(timed(false), Need::Clock, "its time runs");
        assert_eq!(timed(true), Need::Changed, "paused: one frame");
        let mut stale = state(ShaderRole::Fill);
        stale.stale = true;
        assert_eq!(stale.need(), Need::Clock, "a picture is due");

        let Some(renderer) = Renderer::new(PixelFormat::Rgba) else {
            eprintln!("no GPU: skipped");
            return;
        };
        let mut s = state(ShaderRole::Fill);
        s.view.set_size(
            nsh_core::geometry::size(nsh_core::geometry::px(4.0), nsh_core::geometry::px(4.0)),
            1.0,
        );
        let _ = s.view.render(&renderer, Instant::now());
        if s.need() == Need::Pending {
            let (tx, rx) = std::sync::mpsc::channel();
            assert!(renderer.when_done(move || {
                let _ = tx.send(());
            }));
            rx.recv_timeout(Duration::from_secs(5))
                .expect("the GPU tells");
            assert!(s.view.collect_frame(&renderer), "its frame is back");
        }
        assert_eq!(s.need(), Need::None, "shown: nothing left");
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

    #[test]
    fn sublayers_composite_by_z_then_order() {
        assert!(draws_over((0.0, 2), (0.0, 1)), "later, same z");
        assert!(!draws_over((0.0, 1), (0.0, 2)));
        assert!(!draws_over((0.0, 1), (0.0, 1)), "itself");
        assert!(draws_over((OVER, 0), (0.0, 5)), "higher z, earlier");
        assert!(
            !draws_over((crate::decor::BEHIND, 9), (0.0, 0)),
            "lower z, later"
        );
    }

    /// A tree of `parent` links (`None`: a top) and per-node `z`, for
    /// [`order`]: a parent's children composite by z, then by number.
    struct Tree {
        parent: Vec<Option<usize>>,
        z: Vec<f64>,
    }

    impl Tree {
        fn way(&self, node: usize) -> Vec<usize> {
            std::iter::successors(Some(node), |&n| self.parent[n]).collect()
        }

        fn before(&self, changed: usize, reader: usize) -> Option<bool> {
            order(
                &self.way(changed),
                &self.way(reader),
                |a, b| a == b,
                |_, &a, &b| draws_over((self.z[b], b), (self.z[a], a)),
            )
        }
    }

    #[test]
    fn what_draws_before_a_reader_is_what_core_says_draws_before_it() {
        // 0 root: 1 page (2 list, 3 row in it), 4 bar (the reader; 5 its
        // child), 6 controls over the bar; 7 a top of its own.
        let mut t = Tree {
            parent: vec![
                None,
                Some(0),
                Some(1),
                Some(2),
                Some(0),
                Some(4),
                Some(0),
                None,
            ],
            z: vec![0.0; 8],
        };
        let reader = 4;
        assert_eq!(t.before(0, reader), Some(true), "the root, under it");
        assert_eq!(t.before(1, reader), Some(true), "an earlier sibling");
        assert_eq!(t.before(3, reader), Some(true), "in an earlier sibling");
        assert_eq!(t.before(reader, reader), Some(false), "itself");
        assert_eq!(t.before(5, reader), Some(false), "what it holds");
        assert_eq!(t.before(6, reader), Some(false), "a later sibling");
        assert_eq!(t.before(7, reader), None, "another tree");
        // A higher z puts the page over the bar, a lower one the controls
        // under it.
        t.z[1] = 1.0;
        assert_eq!(t.before(3, reader), Some(false));
        t.z[6] = -1.0;
        assert_eq!(t.before(6, reader), Some(true));
    }

    #[test]
    fn rectangles_meet_only_where_they_overlap() {
        let r = |x, y, w, h| CGRect::new(CGPoint::new(x, y), CGSize::new(w, h));
        assert!(meets(r(0.0, 0.0, 10.0, 10.0), r(5.0, 5.0, 10.0, 10.0)));
        assert!(
            !meets(r(0.0, 0.0, 10.0, 10.0), r(10.0, 0.0, 10.0, 10.0)),
            "touching"
        );
        assert!(!meets(r(0.0, 0.0, 10.0, 10.0), r(0.0, 20.0, 10.0, 10.0)));
        assert!(
            meets(r(0.0, 0.0, 10.0, -10.0), r(0.0, -5.0, 1.0, 1.0)),
            "negative size"
        );
        assert!(
            meets(r(f64::NAN, 0.0, 1.0, 1.0), r(50.0, 50.0, 1.0, 1.0)),
            "unsure"
        );
        assert_eq!(
            intersection(r(0.0, 0.0, 10.0, 10.0), r(5.0, 2.0, 10.0, 4.0)),
            Some(r(5.0, 2.0, 5.0, 4.0))
        );
        assert_eq!(
            union(r(0.0, 0.0, 1.0, 1.0), r(5.0, 5.0, 1.0, 1.0)),
            r(0.0, 0.0, 6.0, 6.0)
        );
        assert_eq!(grow(r(1.0, 1.0, 2.0, 2.0), 1.0), r(0.0, 0.0, 4.0, 4.0));
    }

    /// A layer at `(x, y, w, h)` in `parent` (added on top).
    fn sublayer(parent: Option<&CALayer>, (x, y, w, h): (f64, f64, f64, f64)) -> Retained<CALayer> {
        let layer = CALayer::new();
        layer.setAnchorPoint(CGPoint::new(0.0, 0.0));
        layer.setFrame(CGRect::new(CGPoint::new(x, y), CGSize::new(w, h)));
        if let Some(parent) = parent {
            parent.addSublayer(&layer);
        }
        layer
    }

    #[test]
    fn a_backdrop_is_marked_only_by_what_draws_under_it_where_it_reads() {
        crate::surface::quiet(|| {
            // A 100-point window: a page with a scroll view (0..80) of
            // rows, and the bar floating over its bottom (70..100), the
            // bar's controls over it.
            let root = sublayer(None, (0.0, 0.0, 100.0, 100.0));
            let page = sublayer(Some(&root), (0.0, 0.0, 100.0, 100.0));
            let scroll = sublayer(Some(&page), (0.0, 0.0, 100.0, 80.0));
            scroll.setMasksToBounds(true);
            let near = sublayer(Some(&scroll), (0.0, 60.0, 100.0, 20.0));
            let far = sublayer(Some(&scroll), (0.0, 0.0, 100.0, 20.0));
            let below = sublayer(Some(&scroll), (0.0, 120.0, 100.0, 20.0));
            let header = sublayer(Some(&page), (0.0, 0.0, 100.0, 20.0));
            let bar = sublayer(Some(&root), (0.0, 70.0, 100.0, 30.0));
            let label = sublayer(Some(&bar), (10.0, 5.0, 50.0, 20.0));
            let controls = sublayer(Some(&root), (0.0, 70.0, 100.0, 30.0));
            let elsewhere = sublayer(None, (0.0, 0.0, 100.0, 100.0));

            assert!(layer_behind(&near, &bar, 0.0), "a row under the bar");
            assert!(!layer_behind(&far, &bar, 0.0), "a row elsewhere");
            assert!(
                !layer_behind(&below, &bar, 0.0),
                "a row the scroll view clips away"
            );
            assert!(
                layer_behind(&scroll, &bar, 0.0),
                "the scroll view, scrolling"
            );
            assert!(layer_behind(&page, &bar, 0.0), "the page under it");
            assert!(layer_behind(&root, &bar, 0.0), "the root, its ancestor");
            assert!(!layer_behind(&bar, &bar, 0.0), "the reader");
            assert!(!layer_behind(&label, &bar, 0.0), "what it holds");
            assert!(!layer_behind(&controls, &bar, 0.0), "what draws over it");
            assert!(
                layer_behind(&elsewhere, &bar, 0.0),
                "no tree in common: unsure"
            );
            // The header reaches the bar only with the bar's overflow.
            assert!(!layer_behind(&header, &bar, 0.0));
            assert!(layer_behind(&header, &bar, 60.0), "within the overflow");

            // Scrolled 50 points (as NSH scrolls: the content's
            // sublayerTransform): the far row leaves, the one below comes.
            scroll.setSublayerTransform(CATransform3D::new_translation(0.0, -50.0, 0.0));
            assert!(!layer_behind(&far, &bar, 0.0));
            assert!(layer_behind(&below, &bar, 0.0), "clipped to 70..80");

            // A shadow reaches beyond the box; a child beyond its parent
            // (which does not clip) shows there too.
            let card = sublayer(Some(&page), (0.0, 50.0, 100.0, 15.0));
            assert!(!layer_behind(&card, &bar, 0.0));
            // Core Animation's default offset is 3 points up; a shadow
            // cast by the content has no known reach.
            card.setShadowOpacity(0.5);
            card.setShadowRadius(2.0);
            assert!(layer_behind(&card, &bar, 0.0), "a shadow without a path");
            card.setShadowPath(Some(&rect_path((0.0, 0.0, 100.0, 15.0))));
            card.setShadowRadius(0.5);
            assert!(!layer_behind(&card, &bar, 0.0), "a short shadow");
            card.setShadowRadius(2.0);
            assert!(layer_behind(&card, &bar, 0.0), "its shadow");
            let anchor = sublayer(Some(&page), (0.0, 0.0, 10.0, 10.0));
            let _overflowing = sublayer(Some(&anchor), (0.0, 75.0, 10.0, 10.0));
            assert!(layer_behind(&anchor, &bar, 0.0), "its child");

            // Over the bar in the array but under it by z.
            controls.setZPosition(-1.0);
            assert!(layer_behind(&controls, &bar, 0.0));
        });
    }

    #[test]
    fn a_backdrop_leaves_out_the_reader_and_what_draws_over_it() {
        fn paint(layer: &CALayer, (r, g, b): (f64, f64, f64)) {
            let color = objc2_core_graphics::CGColor::new_srgb(r, g, b, 1.0);
            layer.setBackgroundColor(Some(&*color));
        }
        let full = (0.0, 0.0, 100.0, 100.0);
        let root = sublayer(None, full);
        // Over everything by z though first in the array (an effect's
        // frames around the reader).
        let front = sublayer(Some(&root), full);
        front.setZPosition(OVER);
        paint(&front, (1.0, 1.0, 0.0));
        let page = sublayer(Some(&root), full);
        paint(&page, (1.0, 0.0, 0.0));
        let strip = sublayer(Some(&root), (0.0, 0.0, 50.0, 100.0));
        paint(&strip, (0.0, 1.0, 0.0));
        let holder = sublayer(Some(&root), full);
        let reader = sublayer(Some(&holder), (10.0, 60.0, 80.0, 30.0));
        paint(&reader, (1.0, 1.0, 1.0));
        let inner = sublayer(Some(&reader), (0.0, 0.0, 80.0, 30.0));
        paint(&inner, (0.0, 0.0, 0.0));
        let over = sublayer(Some(&holder), (10.0, 60.0, 80.0, 30.0));
        paint(&over, (0.0, 0.0, 1.0));
        let hidden = sublayer(Some(&holder), full);
        paint(&hidden, (1.0, 0.0, 1.0));
        hidden.setHidden(true);
        let later = sublayer(Some(&root), full);
        paint(&later, (0.0, 1.0, 1.0));

        let mut list = Vec::new();
        assert!(over_reader(&reader, &root, &mut list));
        let listed = |l: &CALayer| list.iter().any(|o| same(o, l));
        for (layer, name) in [
            (&reader, "reader"),
            (&over, "over"),
            (&hidden, "hidden"),
            (&front, "front"),
            (&later, "later"),
        ] {
            assert!(listed(layer), "{name} left out");
        }
        for (layer, name) in [(&page, "page"), (&strip, "strip"), (&holder, "holder")] {
            assert!(!listed(layer), "{name} drawn");
        }
        assert!(
            !over_reader(&reader, &sublayer(None, full), &mut list),
            "another root"
        );

        let mut slot = None;
        let canvas = Canvas::of(&mut slot, (80, 30, 1.0)).unwrap();
        let (pixels, w, h, stride) =
            backdrop_picture(canvas, &root, &reader, 0.0, &mut list).expect("a picture");
        assert_eq!((w, h), (80, 30));
        assert!(list.is_empty(), "nothing kept between pictures");
        let at = |x: usize, y: usize| {
            let i = y * stride as usize + x * 4;
            [pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]]
        };
        assert_eq!(at(5, 5), [0, 255, 0, 255], "the strip under it");
        assert_eq!(at(60, 5), [255, 0, 0, 255], "the page under it");
        // Shown again as they were.
        assert!(!reader.isHidden() && !over.isHidden() && !front.isHidden() && !later.isHidden());
        assert!(hidden.isHidden(), "hidden before, hidden after");
    }

    #[test]
    fn equal_pictures_hash_equal() {
        let a = [1u8, 2, 3, 4, 5, 6, 7, 8];
        let mut b = a;
        assert_eq!(
            picture_hash((&a[..], 2, 1, 8)),
            picture_hash((&b[..], 2, 1, 8))
        );
        b[7] = 9;
        assert_ne!(
            picture_hash((&a[..], 2, 1, 8)),
            picture_hash((&b[..], 2, 1, 8))
        );
        assert_ne!(
            picture_hash((&a[..], 2, 1, 8)),
            picture_hash((&a[..], 1, 2, 4)),
            "its size"
        );
        assert_ne!(picture_hash((&[][..], 0, 0, 0)), 0, "0 is no picture");
    }

    /// A rectangle `(x, y, w, h)` as a path.
    fn rect_path((x, y, w, h): (f64, f64, f64, f64)) -> CFRetained<objc2_core_graphics::CGPath> {
        let rect = CGRect::new(CGPoint::new(x, y), CGSize::new(w, h));
        // SAFETY: no transform.
        unsafe { objc2_core_graphics::CGPath::with_rect(rect, std::ptr::null()) }
    }

    /// `layer`'s background, opaque.
    fn fill(layer: &CALayer, (r, g, b): (f64, f64, f64)) {
        let color = objc2_core_graphics::CGColor::new_srgb(r, g, b, 1.0);
        layer.setBackgroundColor(Some(&*color));
    }

    /// A 100-point window: a page with a header, a card whose shadow
    /// reaches down to 66, a zero-size anchor whose child overflows to
    /// 70..80, and a scroll view (0..80, clipping) of 20 rows of 10 points,
    /// each with a label, scrolled `offset` points; the bar (60..100) over
    /// them: the root, the bar, the rows.
    fn page(offset: f64) -> (Retained<CALayer>, Retained<CALayer>, Vec<Retained<CALayer>>) {
        let root = sublayer(None, (0.0, 0.0, 100.0, 100.0));
        let page = sublayer(Some(&root), (0.0, 0.0, 100.0, 100.0));
        fill(&page, (0.2, 0.2, 0.2));
        let header = sublayer(Some(&page), (0.0, 0.0, 100.0, 20.0));
        fill(&header, (1.0, 1.0, 0.0));
        let card = sublayer(Some(&page), (10.0, 30.0, 80.0, 20.0));
        fill(&card, (1.0, 1.0, 1.0));
        card.setShadowPath(Some(&rect_path((0.0, 0.0, 80.0, 20.0))));
        card.setShadowOpacity(1.0);
        card.setShadowRadius(4.0);
        card.setShadowOffset(CGSize::new(0.0, 4.0));
        let anchor = sublayer(Some(&page), (90.0, 0.0, 0.0, 0.0));
        let overflowing = sublayer(Some(&anchor), (0.0, 70.0, 10.0, 10.0));
        fill(&overflowing, (1.0, 0.0, 1.0));
        let scroll = sublayer(Some(&page), (0.0, 20.0, 100.0, 60.0));
        scroll.setMasksToBounds(true);
        scroll.setSublayerTransform(CATransform3D::new_translation(0.0, -offset, 0.0));
        let rows = (0..20)
            .map(|i| {
                let row = sublayer(Some(&scroll), (0.0, i as f64 * 10.0, 90.0, 10.0));
                let shade = i as f64 / 20.0;
                fill(&row, (shade, 0.5, 1.0 - shade));
                let label = sublayer(Some(&row), (2.0, 2.0, 40.0, 6.0));
                fill(&label, (0.0, 0.0, 0.0));
                row
            })
            .collect();
        let bar = sublayer(Some(&root), (0.0, 60.0, 100.0, 40.0));
        fill(&bar, (0.0, 1.0, 0.0));
        let _controls = sublayer(Some(&root), (0.0, 60.0, 100.0, 40.0));
        (root, bar, rows)
    }

    #[test]
    fn a_backdrop_leaves_out_the_trees_that_draw_nothing_where_it_reads() {
        let (root, bar, rows) = page(0.0);
        let mut hide = Vec::new();
        assert!(over_reader(&bar, &root, &mut hide));
        let listed = hide.len();
        let area = grow(bar.convertRect_toLayer(bar.bounds(), Some(&root)), 0.0);
        assert_eq!(cull(&root, area, &mut hide, listed), Reach::Shows);
        let culled = |l: &CALayer| hide[listed..].iter().any(|h| same(h, l));
        // SAFETY: getters.
        let children = |l: &CALayer| unsafe { l.sublayers() }.unwrap().to_vec();
        let top = children(&root);
        let content = &top[0];
        let parts = children(content);
        let [header, card, anchor, scroll] = &parts[..] else {
            panic!("the page's layers");
        };
        assert!(culled(header), "the header, away from the bar");
        assert!(
            !culled(card),
            "the card, whose shadow reaches under the bar"
        );
        assert!(
            !culled(anchor),
            "the anchor, whose child overflows under it"
        );
        assert!(!culled(scroll));
        // The scroll view shows 20..80 of the window: rows 4 and 5 (60..80)
        // are under the bar; the rest is hidden row by row (not their
        // labels: a row that misses goes whole).
        for (i, row) in rows.iter().enumerate() {
            assert_eq!(culled(row), !(4..6).contains(&i), "row {i}");
            assert!(!culled(&children(row)[0]), "row {i}'s label");
        }
        assert!(!culled(&root) && !culled(content));
        // Scrolled 25 points: rows 6 to 8 (55..85 in the window, clipped to
        // 80) show.
        let (root, bar, rows) = page(25.0);
        let mut hide = Vec::new();
        over_reader(&bar, &root, &mut hide);
        let listed = hide.len();
        let area = bar.convertRect_toLayer(bar.bounds(), Some(&root));
        cull(&root, area, &mut hide, listed);
        for (i, row) in rows.iter().enumerate() {
            let culled = hide[listed..].iter().any(|h| same(h, row));
            assert_eq!(culled, !(6..9).contains(&i), "row {i}, scrolled");
        }
    }

    #[test]
    fn a_picture_draws_a_shader_frame_shown_on_a_surface() {
        let Some(renderer) = Renderer::new(PixelFormat::Rgba) else {
            eprintln!("no GPU: skipped");
            return;
        };
        let shader =
            Shader::compile("fn shade(uv: vec2f) -> vec4f { return vec4f(1.0, 0.0, 0.0, 1.0); }")
                .expect("a shader");
        let mut view = surface_view();
        view.set_layer(Some(Arc::new(ShaderLayer::new(
            shader,
            &[],
            &mut Vec::new(),
        ))));
        view.set_size(
            nsh_core::Size::new(nsh_core::Points(10.0), nsh_core::Points(10.0)),
            2.0,
        );
        let start = Instant::now();
        while !view.render(&renderer, Instant::now()) {
            assert!(start.elapsed() < Duration::from_secs(5), "no frame");
        }
        assert!(view.surface().is_some(), "on a surface");
        let layer = CALayer::new();
        layer.setFrame(CGRect::new(CGPoint::new(0.0, 0.0), CGSize::new(10.0, 10.0)));
        // SAFETY: an immutable Core Animation constant.
        layer.setContentsGravity(unsafe { kCAGravityResize });
        display_frame(&layer, &view);
        let picture = picture_size(
            nsh_core::Size::new(nsh_core::Points(10.0), nsh_core::Points(10.0)),
            0.0,
            2.0,
        )
        .unwrap();
        let mut slot = None;
        let pixels = Canvas::of(&mut slot, picture)
            .unwrap()
            .render(&layer, (0.0, 0.0), |context| layer.renderInContext(context))
            .0
            .to_vec();
        assert_eq!(pixels[..4], [255, 0, 0, 255], "the frame is in the picture");
    }

    #[test]
    fn a_culled_backdrop_has_the_pixels_of_the_whole_tree() {
        for offset in [0.0, 25.0, 113.0] {
            for overflow in [0.0, 12.0] {
                let (root, bar, rows) = page(offset);
                let picture = picture_size(
                    nsh_core::Size::new(nsh_core::Points(100.0), nsh_core::Points(40.0)),
                    overflow,
                    2.0,
                )
                .unwrap();
                // Everything but the bar and what draws over it.
                let mut over = Vec::new();
                over_reader(&bar, &root, &mut over);
                let mut slot = None;
                let origin = (-(overflow as f64), 60.0 - overflow as f64);
                let whole = Canvas::of(&mut slot, picture)
                    .unwrap()
                    .render(&root, origin, |context| {
                        over.iter().for_each(|l| l.setHidden(true));
                        root.renderInContext(context);
                        over.iter().for_each(|l| l.setHidden(false));
                    })
                    .0
                    .to_vec();
                let mut slot = None;
                let canvas = Canvas::of(&mut slot, picture).unwrap();
                let (culled, ..) =
                    backdrop_picture(canvas, &root, &bar, overflow, &mut over).unwrap();
                assert!(whole == culled, "offset {offset}, overflow {overflow}");
                assert!(whole.iter().any(|&b| b != 0), "something drawn");
                assert!(over.is_empty());
                assert!(rows.iter().all(|r| !r.isHidden()), "shown again");
            }
        }
    }
}
