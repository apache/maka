//! Shader views: the layer [`MountItem::Shader`](nsh_core::MountItem)
//! mounts on a view, rendered by `nsh_engine::shader` and drawn as a bitmap.
//!
//! The surface opens the GPU device the first time a shader is mounted
//! ([`Surface::shader_renderer`]). Each shader view renders on the
//! surface's frame ticker ([`Surface::on_draw_frame`]) while it has a frame
//! to render or collect ([`ShaderView::wants_frame`]: its uniforms, size or
//! pictures changed, it reads `nsh.time`, or a transition runs), at the
//! window's scale; a frame that comes back is copied into the view's
//! Direct2D bitmap when the view is drawn (made again after a device loss)
//! and the view draws again. A view out of sight (hidden, on a concealed
//! screen, detached) stops rendering until a frame of its window finds it
//! in sight again ([`reveal`]).
//!
//! What the layer draws decides where its frames show
//! ([`ShaderRole`]):
//!
//! - A fill draws under the view's content and children, clipped to its
//!   rounded box as a background is ([`draw`]).
//! - An effect draws instead of its children ([`draw_effect`]): as the
//!   window draws it, its children are drawn into a bitmap of the box and
//!   its overflow by a context of their own, and read back once a view in
//!   them or the whole window changed since they last were (its own frames
//!   do not count); when the pixels changed, they are the shader's
//!   `sample_content`. Web views in them are hidden: their pages are not
//!   in the picture.
//! - A transition draws as an effect while one runs ([`start_transition`],
//!   before the rest of its batch): its children drawn then are its
//!   `sample_from`, its children as they are drawn its `sample_to`.
//! - A screen effect or transition is the root's: the root draws through
//!   it, its children (pages, dialogs, overlays) its content.
//!
//! What is behind a view (`sample_backdrop`) is read back from the window's
//! target before the view draws ([`take_backdrop`]); a partial frame that
//! meets such a view draws all of its box and overflow
//! ([`backdrop_areas`]), so it never reads its own earlier output.
//!
//! Pages and dialogs that come and go through a shader draw recordings of
//! their two sides through a [`NavItem`] hosted over the stack (the root
//! for a dialog), `crate::navigation`'s.
//!
//! Without a GPU device ([`Surface::shader_renderer`] has none) a view
//! shows its background and children: an effect draws its children as
//! they are, a transition starts no run, and a page or a dialog comes with
//! its own motion.
//!
//! Animated uniforms are written while the animation graph is borrowed
//! ([`set_args`]), so the views they start are queued and started once it
//! is not ([`start_pending`]).

use std::{
    cell::RefCell,
    hash::{Hash, Hasher},
    rc::{Rc, Weak},
    sync::Arc,
    time::{Duration, Instant},
};

use nsh_core::{
    NodeId, Points,
    animation::AnimationValue,
    geometry::{Size, size},
    shader::{ShaderInput, ShaderLayer, ShaderRole},
};
use nsh_engine::shader::{Renderer, ShaderView};
use windows::{
    Win32::Graphics::{
        Direct2D::{
            Common::{
                D2D_RECT_F, D2D_RECT_U, D2D_SIZE_U, D2D1_ALPHA_MODE_PREMULTIPLIED,
                D2D1_COMPOSITE_MODE_SOURCE_OVER, D2D1_PIXEL_FORMAT,
            },
            D2D1_BITMAP_OPTIONS_NONE, D2D1_BITMAP_PROPERTIES1, D2D1_INTERPOLATION_MODE_LINEAR,
            ID2D1Bitmap1, ID2D1DeviceContext, ID2D1Image,
        },
        Dxgi::Common::DXGI_FORMAT_B8G8R8A8_UNORM,
    },
    core::Interface,
};
use windows_numerics::Matrix3x2;

use crate::{
    geom::Mat4,
    render::{DrawCx, Pixels, Readback, rect_f},
    surface::Surface,
    view::{NshView, ViewState},
};

/// What a shader view shows.
#[derive(Default)]
pub(crate) struct ShaderState {
    /// The surface whose ticker renders it.
    surface: Weak<Surface>,
    renderer: Option<Rc<Renderer>>,
    view: ShaderView,
    /// Its frame client runs.
    ticking: bool,
    /// Out of sight with a frame to render ([`reveal`]).
    hidden: bool,
    /// The bitmap of the last frame (made while drawing, which only sees
    /// the state).
    drawn: RefCell<Option<Drawn>>,
    /// The view that mounted the layer the root draws (a screen effect's or
    /// transition's).
    owner: Option<NodeId>,
    /// It mounts a screen effect or transition: its layer is the root's.
    screen: bool,
    /// When the transition that runs ends.
    until: Option<Instant>,
    /// What a transition started from, shown until its first frame (with
    /// the serial of the frame shown when it started).
    start: Option<(u64, Pixels)>,
    /// The hashes of the pictures it was last given, by input.
    given: [Option<u64>; 4],
    /// The change stamp its children's picture holds every change up to
    /// ([`crate::view::change_stamp`]; `None`: it is to be taken): read
    /// back again only once a view in it changed since.
    pictured: Option<u64>,
    /// Where its children are drawn and read back, kept for the next.
    readback: Readback,
    /// Where what is behind it is read back, kept for the next, and the
    /// picture of its box made of it.
    backdrop: (Readback, Pixels),
}

/// A frame as a Direct2D bitmap.
struct Drawn {
    bitmap: ID2D1Bitmap1,
    /// Its size in pixels.
    size: (u32, u32),
    /// The frame it holds ([`nsh_engine::shader::Frame::serial`];
    /// [`u64::MAX`]: a picture of its own).
    serial: u64,
    /// The device generation it was made in.
    generation: u64,
}

/// `pixels` (`height` rows `stride` bytes apart) as a bitmap on `dc`'s
/// device: copied into `drawn`'s when `serial` is new, into a new one on
/// first use, for a new size and after a device loss.
fn upload(
    dc: &ID2D1DeviceContext,
    drawn: &mut Option<Drawn>,
    pixels: &[u8],
    (width, height): (u32, u32),
    stride: u32,
    serial: u64,
) -> Option<ID2D1Bitmap1> {
    if width == 0 || height == 0 {
        return None;
    }
    let generation = crate::gfx::generation();
    if let Some(d) = drawn.as_mut()
        && d.generation == generation
        && d.size == (width, height)
    {
        if d.serial == serial {
            return Some(d.bitmap.clone());
        }
        // SAFETY: `pixels` holds `height` rows `stride` bytes apart, the
        // bitmap's size.
        let copied = unsafe {
            d.bitmap
                .CopyFromMemory(None, pixels.as_ptr().cast(), stride)
        };
        match copied {
            Ok(()) => {
                d.serial = serial;
                return Some(d.bitmap.clone());
            }
            Err(e) => log::warn!("shader: cannot update the bitmap: {e}"),
        }
    }
    *drawn = None;
    let props = D2D1_BITMAP_PROPERTIES1 {
        pixelFormat: D2D1_PIXEL_FORMAT {
            format: DXGI_FORMAT_B8G8R8A8_UNORM,
            alphaMode: D2D1_ALPHA_MODE_PREMULTIPLIED,
        },
        dpiX: 96.0,
        dpiY: 96.0,
        bitmapOptions: D2D1_BITMAP_OPTIONS_NONE,
        colorContext: std::mem::ManuallyDrop::new(None),
    };
    // SAFETY: `pixels` holds `height` rows `stride` bytes apart.
    let made = unsafe {
        dc.CreateBitmap(
            D2D_SIZE_U { width, height },
            Some(pixels.as_ptr().cast()),
            stride,
            &props,
        )
    };
    match made {
        Ok(bitmap) => {
            *drawn = Some(Drawn {
                bitmap: bitmap.clone(),
                size: (width, height),
                serial,
                generation,
            });
            Some(bitmap)
        }
        Err(e) => {
            log::warn!("shader: cannot create a {width}x{height} bitmap: {e}");
            None
        }
    }
}

impl ShaderState {
    /// The bitmap of the last frame on `dc`'s device (what a transition
    /// started from, until its first frame).
    fn bitmap(&self, dc: &ID2D1DeviceContext) -> Option<ID2D1Bitmap1> {
        let frame = self.view.frame();
        let mut drawn = self.drawn.borrow_mut();
        match &self.start {
            Some((serial, from)) if *serial == frame.serial => upload(
                dc,
                &mut drawn,
                &from.data,
                (from.width, from.height),
                from.width * 4,
                u64::MAX,
            ),
            _ => upload(
                dc,
                &mut drawn,
                &frame.pixels,
                (frame.width, frame.height),
                frame.stride,
                frame.serial,
            ),
        }
    }

    fn role(&self) -> Option<ShaderRole> {
        self.view.layer().map(|l| l.role)
    }

    fn reads(&self, input: ShaderInput) -> bool {
        self.view
            .layer()
            .is_some_and(|l| l.shader.inputs().contains(input))
    }

    /// Whether it draws instead of its children now (never without a GPU
    /// device: no frame would come).
    fn replaces(&self) -> bool {
        if self.renderer.is_none() {
            return false;
        }
        match self.role() {
            Some(ShaderRole::Effect | ShaderRole::Screen) => true,
            Some(ShaderRole::Transition | ShaderRole::ScreenTransition) => {
                self.until.is_some_and(|u| Instant::now() < u)
            }
            _ => false,
        }
    }

    /// The picture its children are: an effect's content, a transition's
    /// `sample_to`.
    fn children_input(&self) -> ShaderInput {
        match self.role() {
            Some(ShaderRole::Transition | ShaderRole::ScreenTransition) => ShaderInput::To,
            _ => ShaderInput::Content,
        }
    }

    /// Whether its children are read back again as the window draws it:
    /// never read yet, or a view in it (`changes`, [`NshView::changes`],
    /// which a `ShaderInput` item stamps too) or the whole window
    /// ([`Surface::whole_change`]) changed since. Its own frames change
    /// neither: a shader reading `nsh.time` over still children reads
    /// them once.
    fn picture_due(&self, changes: u64) -> bool {
        let whole = self.surface.upgrade().map_or(0, |s| s.whole_change());
        self.pictured.is_none_or(|at| changes > at || whole > at)
    }
}

thread_local! {
    /// Shader views out of sight with a frame to render.
    static HIDDEN: RefCell<Vec<(Weak<Surface>, NodeId)>> = RefCell::default();
    /// Shader views whose animated uniforms changed while they were not
    /// rendering ([`set_args`]).
    static PENDING: RefCell<Vec<NshView>> = RefCell::default();
}

fn is_screen(role: Option<ShaderRole>) -> bool {
    matches!(
        role,
        Some(ShaderRole::Screen | ShaderRole::ScreenTransition)
    )
}

/// The view a layer mounted on `view` draws on: `view`, or the root for a
/// screen effect's or transition's view while the root draws its layer
/// (`None` once another screen effect's took its place).
fn target(view: &NshView) -> Option<NshView> {
    if !view.state().shader.as_ref().is_some_and(|s| s.screen) {
        return Some(view.clone());
    }
    let mut root = view.clone();
    while let Some(parent) = root.parent_view() {
        root = parent;
    }
    let owns = root
        .state()
        .shader
        .as_ref()
        .is_some_and(|s| s.owner == Some(view.id()));
    owns.then_some(root)
}

/// `view` was deleted: the layer of a screen effect or transition it
/// mounted leaves the root, unless another one's took its place.
pub(crate) fn deleted(surface: &Rc<Surface>, view: &NshView) {
    if view.state().shader.as_ref().is_some_and(|s| s.screen) {
        set(surface, view, None);
    }
}

/// Mounts `layer` on `view` (`None`: it shows nothing of its own).
pub(crate) fn set(surface: &Rc<Surface>, view: &NshView, layer: Option<Arc<ShaderLayer>>) {
    if is_screen(layer.as_ref().map(|l| l.role)) {
        view.state_mut()
            .shader
            .get_or_insert_with(Default::default)
            .screen = true;
    }
    let screen = view.state().shader.as_ref().is_some_and(|s| s.screen);
    let target = if screen {
        // One screen effect draws at a time, the latest; the root lets go
        // of a layer only for the view that gave it.
        let owner = surface.root.state().shader.as_ref().and_then(|s| s.owner);
        if layer.is_none() && owner != Some(view.id()) {
            return;
        }
        surface.root.clone()
    } else {
        view.clone()
    };
    let backdrop = {
        let mut state = target.state_mut();
        if layer.is_none() && state.shader.is_none() {
            return;
        }
        let shader = state.shader.get_or_insert_with(Default::default);
        shader.surface = Rc::downgrade(surface);
        if layer.is_some() && shader.renderer.is_none() {
            shader.renderer = surface.shader_renderer();
        }
        if layer.is_none() {
            *shader.drawn.get_mut() = None;
            shader.until = None;
            shader.start = None;
        }
        shader.owner = (screen && layer.is_some()).then(|| view.id());
        shader.given = [None; 4];
        shader.pictured = None;
        shader.view.set_layer(layer);
        let reads = shader.reads(ShaderInput::Backdrop);
        reads.then_some(state.id)
    };
    if let Some(id) = backdrop {
        let mut readers = surface.backdrop_readers.borrow_mut();
        if !readers.contains(&id) {
            readers.push(id);
        }
    }
    target.changed();
    tick(&target);
}

/// The values of the layer's animated slots. Called while the animation
/// graph is borrowed: a view that starts rendering is queued
/// ([`start_pending`]).
pub(crate) fn set_args(view: &NshView, values: &[(u16, AnimationValue)]) {
    let Some(view) = target(view) else {
        return;
    };
    let mut state = view.state_mut();
    let Some(shader) = state.shader.as_mut() else {
        return;
    };
    for &(slot, value) in values {
        shader.view.set_slot(slot, value);
    }
    if !shader.ticking && !shader.hidden && shader.view.wants_frame() {
        drop(state);
        PENDING.with(|p| p.borrow_mut().push(view.clone()));
    }
}

/// Starts the views [`set_args`] queued (once the animation graph is
/// written).
pub(crate) fn start_pending() {
    let pending = PENDING.with(|p| std::mem::take(&mut *p.borrow_mut()));
    for view in pending {
        tick(&view);
    }
}

/// Its size changed: a frame of the new size is rendered.
pub(crate) fn resized(surface: &Rc<Surface>, view: &NshView) {
    {
        let mut state = view.state_mut();
        let size = state.frame.size;
        let Some(shader) = state.shader.as_mut() else {
            return;
        };
        shader.view.set_size(size, surface.scale());
    }
    tick(view);
}

/// How far beyond its box a view's shader draws, in points.
pub(crate) fn overflow(state: &ViewState) -> f32 {
    state.shader.as_ref().map_or(0.0, |s| s.view.overflow().0)
}

/// The size in pixels of a picture of `frame` and `o` points around it.
fn pixels_of(frame: Size<Points>, o: f32, scale: f32) -> Option<(u32, u32)> {
    let (w, h) = (frame.width.0 + 2.0 * o, frame.height.0 + 2.0 * o);
    (w > 0.0 && h > 0.0).then(|| {
        (
            (w * scale).round().max(1.0) as u32,
            (h * scale).round().max(1.0) as u32,
        )
    })
}

fn whole((right, bottom): (u32, u32)) -> D2D_RECT_U {
    D2D_RECT_U {
        left: 0,
        top: 0,
        right,
        bottom,
    }
}

/// A shader transition starts ([`nsh_core::MountItem::ShaderTransition`],
/// before the rest of its batch): what shows now becomes its `sample_from`,
/// and `nsh.progress` goes from 0 to 1 over `duration`.
pub(crate) fn start_transition(surface: &Rc<Surface>, view: &NshView, duration: Duration) {
    let Some(view) = target(view) else {
        return;
    };
    let scale = surface.scale();
    let (running, o, frame) = {
        let s = view.state();
        let Some(shader) = s.shader.as_ref() else {
            return;
        };
        // Without a GPU device no run starts: the children change at once.
        if shader.renderer.is_none()
            || !matches!(
                shader.role(),
                Some(ShaderRole::Transition | ShaderRole::ScreenTransition)
            )
        {
            return;
        }
        (shader.replaces(), shader.view.overflow().0, s.frame.size)
    };
    // A running transition goes on from what it shows; otherwise it starts
    // from the children as they are.
    let from = if running {
        view.state().shader.as_ref().and_then(|s| {
            let f = s.view.frame();
            (f.width > 0 && f.height > 0).then(|| Pixels {
                width: f.width,
                height: f.height,
                data: f.tight().into_owned(),
            })
        })
    } else {
        offscreen_children(surface, &view, o, frame, scale)
    };
    {
        let mut s = view.state_mut();
        let Some(shader) = s.shader.as_mut() else {
            return;
        };
        let Some(renderer) = shader.renderer.clone() else {
            return;
        };
        if let Some(from) = from {
            shader.view.set_input(
                &renderer,
                ShaderInput::From,
                Some((&from.data, from.width, from.height, from.width * 4)),
            );
            shader.start = Some((shader.view.frame().serial, from));
        }
        let now = Instant::now();
        shader.view.start_transition(duration, now);
        shader.until = Some(now + duration);
        shader.given[ShaderInput::To.index()] = None;
        shader.pictured = None;
    }
    view.changed();
    tick(&view);
}

/// `view`'s children drawn outside the window's pass over its box and `o`
/// points around it, read back.
fn offscreen_children(
    surface: &Rc<Surface>,
    view: &NshView,
    o: f32,
    frame: Size<Points>,
    scale: f32,
) -> Option<Pixels> {
    let px = pixels_of(frame, o, scale)?;
    let gfx = crate::gfx::get().ok()?;
    let target = crate::render::target_bitmap(&gfx.dc, px, scale).ok()?;
    let image: ID2D1Image = target.cast().ok()?;
    let base = Mat4::new().translate(o, o);
    let drawn = crate::render::draw_offscreen(surface, &image, scale, |cx| {
        draw_children(cx, view, base);
    });
    if !drawn {
        return None;
    }
    crate::render::read_back(&gfx.dc, &target, whole(px))
        .map_err(|e| log::debug!("shader: no picture of the children: {e}"))
        .ok()
}

/// Draws `view`'s children at `base` (its coordinates in the target's).
fn draw_children(cx: &mut DrawCx<'_>, view: &NshView, base: Mat4) {
    view.with_children(|children| {
        for child in children {
            let origin = {
                let s = child.state();
                view.state().child_origin(s.frame, s.shift)
            };
            crate::render::draw_view(cx, child, base, origin);
        }
    });
}

/// Starts rendering the view on its surface's frame ticker if it has a
/// frame to render.
fn tick(view: &NshView) {
    let surface = {
        let mut state = view.state_mut();
        let Some(shader) = state.shader.as_mut() else {
            return;
        };
        if shader.ticking
            || shader.hidden
            || shader.renderer.is_none()
            || !shader.view.wants_frame()
        {
            return;
        }
        let Some(surface) = shader.surface.upgrade() else {
            return;
        };
        shader.ticking = true;
        surface
    };
    let id = view.id();
    surface.on_draw_frame(move |surface, _now| {
        let Some(view) = surface.view(id) else {
            return false;
        };
        let go_on = frame(surface, &view);
        if !go_on && let Some(shader) = view.state_mut().shader.as_mut() {
            shader.ticking = false;
        }
        go_on
    });
}

/// One frame of the ticker: renders, collects; whether to tick again.
fn frame(surface: &Rc<Surface>, view: &NshView) -> bool {
    if !in_sight(view) {
        let mut state = view.state_mut();
        let Some(shader) = state.shader.as_mut() else {
            return false;
        };
        if !shader.hidden {
            shader.hidden = true;
            let id = state.id;
            HIDDEN.with(|h| h.borrow_mut().push((Rc::downgrade(surface), id)));
        }
        return false;
    }
    let scale = surface.scale();
    let draw = {
        let mut state = view.state_mut();
        let frame_size = state.frame.size;
        let Some(shader) = state.shader.as_mut() else {
            return false;
        };
        let Some(renderer) = shader.renderer.clone() else {
            return false;
        };
        shader.view.set_size(
            size(Points(frame_size.width.0), Points(frame_size.height.0)),
            scale,
        );
        let now = Instant::now();
        // A transition that ended: the children show as they are again.
        let ended = shader.until.is_some_and(|u| now >= u);
        if ended {
            shader.until = None;
            shader.start = None;
        }
        shader.view.render(&renderer, now) || ended
    };
    // Its own frame: no change of the children it pictures.
    if draw {
        view.redraw();
    }
    view.state()
        .shader
        .as_ref()
        .is_some_and(|s| s.view.wants_frame() || s.until.is_some())
}

/// Whether `view` may show: attached to its surface, with neither it nor
/// an ancestor hidden or concealed (screens below the top one).
fn in_sight(view: &NshView) -> bool {
    if !view.attached() {
        return false;
    }
    let mut at = Some(view.clone());
    while let Some(v) = at {
        {
            let s = v.state();
            if s.style.hidden || s.concealed {
                return false;
            }
        }
        at = v.parent_view();
    }
    true
}

/// Starts the shader views that came into sight (before every frame of a
/// window is drawn).
pub(crate) fn reveal() {
    if HIDDEN.with(|h| h.borrow().is_empty()) {
        return;
    }
    let shown: Vec<NshView> = HIDDEN.with(|h| {
        let mut shown = Vec::new();
        h.borrow_mut().retain(|(surface, id)| {
            let Some(view) = surface.upgrade().and_then(|s| s.view(*id)) else {
                return false;
            };
            if !view.state().shader.as_ref().is_some_and(|s| s.hidden) {
                return false;
            }
            if !in_sight(&view) {
                return true;
            }
            shown.push(view);
            false
        });
        shown
    });
    for view in shown {
        if let Some(s) = view.state_mut().shader.as_mut() {
            s.hidden = false;
        }
        tick(&view);
    }
}

/// Draws `bitmap` over the box of `frame` and `o` points around it.
fn draw_bitmap(cx: &DrawCx<'_>, bitmap: &ID2D1Bitmap1, frame: Size<Points>, o: f32) {
    let (w, h) = (frame.width.0 + 2.0 * o, frame.height.0 + 2.0 * o);
    // SAFETY: a COM call on the live context with a bitmap of its device.
    unsafe {
        cx.dc.DrawBitmap(
            bitmap,
            Some(&rect_f(-o, -o, w, h)),
            1.0,
            D2D1_INTERPOLATION_MODE_LINEAR,
            None,
            None,
        )
    };
}

/// Draws a fill's last frame over the view's box, inside its rounded
/// corners (under its content and children; an effect draws with its
/// children, [`draw_effect`]).
pub(crate) fn draw(cx: &mut DrawCx<'_>, state: &ViewState) {
    let Some(shader) = state.shader.as_ref() else {
        return;
    };
    if shader.role() != Some(ShaderRole::Fill) {
        return;
    }
    let (w, h) = (state.frame.size.width.0, state.frame.size.height.0);
    if w <= 0.0 || h <= 0.0 {
        return;
    }
    let Some(bitmap) = shader.bitmap(cx.dc) else {
        return;
    };
    cx.push_clip_rounded(crate::geom::rect(0.0, 0.0, w, h), state.radii());
    draw_bitmap(cx, &bitmap, state.frame.size, shader.view.overflow().0);
    cx.pop();
}

/// Whether `state` draws its children through its shader now
/// ([`draw_effect`]).
pub(crate) fn effect(state: &ViewState) -> bool {
    state.shader.as_ref().is_some_and(ShaderState::replaces)
}

/// Draws an effect at `world` (set on the context): `view`'s children into
/// its picture, then the shader's last frame over its box and overflow.
/// False when it has no frame yet: the children are then drawn as they
/// are.
pub(crate) fn draw_effect(cx: &mut DrawCx<'_>, view: &NshView, world: Mat4) -> bool {
    let (input, reads, o, frame) = {
        let s = view.state();
        let Some(shader) = s.shader.as_ref() else {
            return false;
        };
        let input = shader.children_input();
        (
            input,
            shader.reads(input),
            shader.view.overflow().0,
            s.frame.size,
        )
    };
    if reads && let Some(px) = pixels_of(frame, o, cx.scale) {
        // The children are drawn every time (their hosted items take their
        // places), read back only after a view in it changed.
        let stamp = crate::view::change_stamp();
        let (due, mut readback) = {
            let mut s = view.state_mut();
            match s.shader.as_mut() {
                Some(shader) => (
                    shader.picture_due(view.changes()),
                    std::mem::take(&mut shader.readback),
                ),
                None => (false, Readback::default()),
            }
        };
        if let Some(target) = children(cx, view, o, px, &mut readback)
            && due
        {
            match readback.read(cx.dc, &target, whole(px)) {
                Ok(pixels) => {
                    give(view, input, pixels);
                    if let Some(shader) = view.state_mut().shader.as_mut() {
                        shader.pictured = Some(stamp);
                    }
                }
                Err(e) => log::debug!("shader: no picture of the children: {e}"),
            }
        }
        if let Some(shader) = view.state_mut().shader.as_mut() {
            shader.readback = readback;
        }
    }
    cx.set_transform(world);
    let state = view.state();
    let Some(bitmap) = state.shader.as_ref().and_then(|s| s.bitmap(cx.dc)) else {
        return false;
    };
    draw_bitmap(cx, &bitmap, frame, o);
    true
}

/// `view`'s children drawn by another context (what is pushed on `cx`
/// stays as it is) into `readback`'s target bitmap of `px` pixels, `o`
/// points beyond its box.
fn children(
    cx: &mut DrawCx<'_>,
    view: &NshView,
    o: f32,
    px: (u32, u32),
    readback: &mut Readback,
) -> Option<ID2D1Bitmap1> {
    let scale = cx.scale;
    let target = readback.target(cx.dc, px, scale).ok()?;
    let image: ID2D1Image = target.cast().ok()?;
    let base = Mat4::new().translate(o, o);
    // Web views in it are hidden: WebView2 draws a page into a visual of
    // its own, never into the picture.
    let drawn = cx.uncomposed(|cx| {
        crate::decor::layer::draw_into(cx, &image, scale, true, |inner| {
            draw_children(inner, view, base);
        })
    });
    drawn.then_some(target)
}

/// Gives `pixels` to `view`'s shader as `input` when they changed.
fn give(view: &NshView, input: ShaderInput, pixels: &Pixels) {
    let mut hasher = rustc_hash::FxHasher::default();
    (pixels.width, pixels.height).hash(&mut hasher);
    pixels.data.hash(&mut hasher);
    let hash = hasher.finish();
    {
        let mut s = view.state_mut();
        let Some(shader) = s.shader.as_mut() else {
            return;
        };
        if shader.given[input.index()] == Some(hash) {
            return;
        }
        let Some(renderer) = shader.renderer.clone() else {
            return;
        };
        shader.given[input.index()] = Some(hash);
        shader.view.set_input(
            &renderer,
            input,
            Some((&pixels.data, pixels.width, pixels.height, pixels.width * 4)),
        );
    }
    tick(view);
}

/// Where the views whose shader reads what is behind them read it
/// ([`take_backdrop`]), in the window's DIPs. A partial frame that meets
/// one draws all of it ([`crate::render::frame`]): what it reads is then
/// this frame's, never its own output of an earlier frame that the rest
/// of the back buffer still holds. Views that no longer read it leave
/// the surface's list.
pub(crate) fn backdrop_areas(surface: &Surface) -> Vec<D2D_RECT_F> {
    let mut areas = Vec::new();
    surface.backdrop_readers.borrow_mut().retain(|&id| {
        let Some(view) = surface.view(id) else {
            return false;
        };
        let reads = view
            .state()
            .shader
            .as_ref()
            .is_some_and(|s| s.renderer.is_some() && s.reads(ShaderInput::Backdrop));
        if reads && let Some(area) = backdrop_area(&view) {
            areas.push(area);
        }
        reads
    });
    areas
}

/// Where `view` reads what is behind it: its box and overflow in the
/// window's DIPs, a point out for the pixels the read rounds to. `None`
/// when it reads nothing (out of sight, or drawn offscreen under a
/// projective transform).
fn backdrop_area(view: &NshView) -> Option<D2D_RECT_F> {
    if !in_sight(view) {
        return None;
    }
    let world = view.to_root()?;
    if !world.is_affine() {
        return None;
    }
    let s = view.state();
    let o = overflow(&s) + 1.0;
    let (w, h) = (s.frame.size.width.0, s.frame.size.height.0);
    Some(crate::compose::map_bounds(
        &world.to_3x2(),
        &rect_f(-o, -o, w + 2.0 * o, h + 2.0 * o),
    ))
}

/// Reads what the pass drew so far under `view`'s box and overflow (what is
/// behind it) back for its shader when it reads it, before the view draws
/// anything: its own background is not behind it. Transparent where the
/// target has nothing (beyond the window).
pub(crate) fn take_backdrop(cx: &mut DrawCx<'_>, view: &NshView) {
    let (o, frame) = {
        let s = view.state();
        let Some(shader) = s
            .shader
            .as_ref()
            .filter(|s| s.renderer.is_some() && s.reads(ShaderInput::Backdrop))
        else {
            return;
        };
        (shader.view.overflow().0, s.frame.size)
    };
    // A pass drawn offscreen holds nothing behind it: the last picture
    // stays.
    if !cx.backdrop {
        return;
    }
    let scale = cx.scale;
    let Some(px) = pixels_of(frame, o, scale) else {
        return;
    };
    let Some((x, y, _, _)) =
        cx.transform
            .bounds(-o, -o, frame.width.0 + 2.0 * o, frame.height.0 + 2.0 * o)
    else {
        return;
    };
    // Kept from the last read: no bitmap made and nothing allocated again.
    let Some((mut readback, mut picture)) = view
        .state_mut()
        .shader
        .as_mut()
        .map(|s| std::mem::take(&mut s.backdrop))
    else {
        return;
    };
    // Layers pushed reach the target when they pop: it is read while they
    // are closed.
    let read = cx.flatten(|dc| {
        // SAFETY: COM calls on the live context and its target; the
        // pending drawing is flushed first.
        let target = unsafe {
            dc.Flush(None, None).ok()?;
            dc.GetTarget().ok()?.cast::<ID2D1Bitmap1>().ok()?
        };
        // SAFETY: a COM call on a live bitmap.
        let window = unsafe { target.GetPixelSize() };
        let (x, y) = ((x * scale).round() as i64, (y * scale).round() as i64);
        let left = x.clamp(0, window.width as i64);
        let top = y.clamp(0, window.height as i64);
        let right = (x + px.0 as i64).clamp(0, window.width as i64);
        let bottom = (y + px.1 as i64).clamp(0, window.height as i64);
        // Transparent beyond the window.
        picture.width = px.0;
        picture.height = px.1;
        picture.data.clear();
        picture.data.resize((px.0 * px.1 * 4) as usize, 0);
        if right > left && bottom > top {
            let read = readback
                .read(
                    dc,
                    &target,
                    D2D_RECT_U {
                        left: left as u32,
                        top: top as u32,
                        right: right as u32,
                        bottom: bottom as u32,
                    },
                )
                .map_err(|e| log::debug!("shader: backdrop not read: {e}"))
                .ok()?;
            let row = read.width as usize * 4;
            let (dx, dy) = ((left - x) as usize, (top - y) as usize);
            for (i, line) in read.data.chunks(row).enumerate() {
                let at = ((dy + i) * px.0 as usize + dx) * 4;
                picture.data[at..at + row].copy_from_slice(line);
            }
        }
        Some(())
    });
    if read.is_some() {
        give(view, ShaderInput::Backdrop, &picture);
    }
    if let Some(shader) = view.state_mut().shader.as_mut() {
        shader.backdrop = (readback, picture);
    }
}

/// A page's or a dialog's transition through a shader
/// ([`nsh_core::NavShader`]): an item hosted by a layer view over the
/// stack (the root for a dialog) that draws recordings of its two sides,
/// the lower one `sample_from` and the upper one `sample_to`, through the
/// shader as its transition runs (`ShaderView::start_transition`,
/// backwards when it goes). Frames come back from the GPU a frame or two
/// after they are asked for; the side it starts from shows before the
/// first.
pub(crate) struct NavItem {
    lower: ID2D1Image,
    upper: ID2D1Image,
    /// The device generation `lower` and `upper` were recorded in
    /// ([`crate::gfx::generation`]).
    generation: u64,
    /// It goes: it starts from its upper side.
    reverse: bool,
    paint: RefCell<NavPaint>,
}

struct NavPaint {
    renderer: Rc<Renderer>,
    view: ShaderView,
    /// Its sides were read back for the shader.
    given: bool,
    drawn: Option<Drawn>,
}

impl NavItem {
    /// `layer` over `lower` and `upper` (recordings in the host's points)
    /// for `duration` from now, `nsh.progress` from 1 to 0 when it goes
    /// (`reverse`); `None` without a GPU device.
    pub(crate) fn new(
        surface: &Surface,
        layer: &ShaderLayer,
        (lower, upper): (ID2D1Image, ID2D1Image),
        duration: Duration,
        reverse: bool,
    ) -> Option<Self> {
        let renderer = surface.shader_renderer()?;
        // The pictures cover the host's box.
        let layer = layer.clone().with_overflow(Points::ZERO);
        let mut view = ShaderView::default();
        view.set_layer(Some(Arc::new(layer)));
        let now = Instant::now();
        if reverse {
            view.start_transition_backwards(duration, now);
        } else {
            view.start_transition(duration, now);
        }
        Some(Self {
            lower,
            upper,
            generation: crate::gfx::generation(),
            reverse,
            paint: RefCell::new(NavPaint {
                renderer,
                view,
                given: false,
                drawn: None,
            }),
        })
    }
}

/// `image` (a recording in points) drawn into a bitmap of `size` points and
/// read back.
fn read_image(cx: &DrawCx<'_>, image: &ID2D1Image, (w, h): (f32, f32)) -> Option<Pixels> {
    let scale = cx.scale;
    let px = (
        (w * scale).round().max(1.0) as u32,
        (h * scale).round().max(1.0) as u32,
    );
    let target = crate::render::target_bitmap(cx.dc, px, scale).ok()?;
    let drawn = crate::decor::layer::with_context(cx.gfx, |dc| {
        // SAFETY: COM calls on a context nobody else draws with; `EndDraw`
        // follows `BeginDraw`.
        unsafe {
            dc.SetTarget(&target);
            dc.SetDpi(96.0 * scale, 96.0 * scale);
            dc.BeginDraw();
            dc.SetTransform(&Matrix3x2::identity());
            dc.Clear(None);
            dc.DrawImage(
                image,
                None,
                None,
                D2D1_INTERPOLATION_MODE_LINEAR,
                D2D1_COMPOSITE_MODE_SOURCE_OVER,
            );
            dc.EndDraw(None, None).is_ok()
        }
    })?;
    if !drawn {
        return None;
    }
    crate::render::read_back(cx.dc, &target, whole(px))
        .map_err(|e| log::debug!("shader: no picture of a side: {e}"))
        .ok()
}

impl crate::view::Hosted for NavItem {
    fn draw(&self, cx: &mut DrawCx<'_>, (w, h): (f32, f32)) {
        if w <= 0.0 || h <= 0.0 {
            return;
        }
        let mut paint = self.paint.borrow_mut();
        let paint = &mut *paint;
        let renderer = paint.renderer.clone();
        // Recordings of a lost device fail the frame that draws them. The
        // window that finds the device lost ends its own changes; one of
        // another window still runs and shows only the shader's frames,
        // made of the sides read while the device lived, if they were.
        let recorded = self.generation == crate::gfx::generation();
        if !paint.given && recorded {
            paint.given = true;
            for (input, image) in [
                (ShaderInput::From, &self.lower),
                (ShaderInput::To, &self.upper),
            ] {
                let pixels = read_image(cx, image, (w, h));
                paint.view.set_input(
                    &renderer,
                    input,
                    pixels
                        .as_ref()
                        .map(|p| (&p.data[..], p.width, p.height, p.width * 4)),
                );
            }
        }
        paint.view.set_size(size(Points(w), Points(h)), cx.scale);
        paint.view.render(&renderer, Instant::now());
        let f = paint.view.frame();
        let bitmap = upload(
            cx.dc,
            &mut paint.drawn,
            &f.pixels,
            (f.width, f.height),
            f.stride,
            f.serial,
        );
        match bitmap {
            Some(bitmap) => draw_bitmap(cx, &bitmap, size(Points(w), Points(h)), 0.0),
            // No frame yet: the side it starts from.
            None if recorded => {
                let image = if self.reverse {
                    &self.upper
                } else {
                    &self.lower
                };
                // SAFETY: a COM call on the live context with an image of
                // its device.
                unsafe {
                    cx.dc.DrawImage(
                        image,
                        None,
                        None,
                        D2D1_INTERPOLATION_MODE_LINEAR,
                        D2D1_COMPOSITE_MODE_SOURCE_OVER,
                    )
                };
            }
            None => {}
        }
    }

    fn hit(&self, _x: f32, _y: f32, _size: (f32, f32)) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use nsh_core::{MountItem, ROOT_ID, ViewKind, shader::Shader};

    use super::*;

    /// A surface without a GPU device: the tests open none.
    fn surface() -> Rc<Surface> {
        let surface = Surface::new(Default::default());
        surface.without_shader_renderer();
        surface
    }

    fn layer(role: ShaderRole) -> Arc<ShaderLayer> {
        let shader =
            Shader::compile("fn shade(uv: vec2f) -> vec4f {\n    return vec4f(uv, 0.0, 1.0);\n}\n")
                .expect("a valid shader");
        let mut layer = ShaderLayer::new(shader, &[], &mut Vec::new());
        layer.role = role;
        Arc::new(layer)
    }

    fn apply(surface: &Rc<Surface>, items: &[MountItem]) {
        for item in items {
            surface.mounter.borrow_mut().apply(surface, item);
        }
    }

    /// A view `id` under the root, showing a layer of `role`.
    fn mount(surface: &Rc<Surface>, id: NodeId, role: ShaderRole) -> NshView {
        apply(
            surface,
            &[
                MountItem::Create {
                    id,
                    kind: ViewKind::View,
                },
                MountItem::Insert {
                    parent: ROOT_ID,
                    child: id,
                    before: None,
                },
                MountItem::Shader {
                    id,
                    layer: Some(layer(role)),
                },
            ],
        );
        surface.view(id).expect("the view")
    }

    /// The view that gave the layer the root draws, and whether it draws
    /// one.
    fn root_layer(surface: &Surface) -> (Option<NodeId>, bool) {
        let s = surface.root.state();
        let shader = s.shader.as_ref();
        (
            shader.and_then(|s| s.owner),
            shader.is_some_and(|s| s.view.layer().is_some()),
        )
    }

    #[test]
    fn a_deleted_screen_effect_leaves_the_root() {
        let surface = surface();
        for (id, role) in [(2, ShaderRole::Screen), (4, ShaderRole::ScreenTransition)] {
            mount(&surface, id, role);
            assert_eq!(root_layer(&surface), (Some(id), true));
            apply(&surface, &[MountItem::Delete { id }]);
            assert_eq!(root_layer(&surface), (None, false));
        }
    }

    #[test]
    fn deleting_a_replaced_screen_effect_keeps_the_new_one() {
        let surface = surface();
        let first = mount(&surface, 2, ShaderRole::Screen);
        let second = mount(&surface, 4, ShaderRole::ScreenTransition);
        assert_eq!(root_layer(&surface), (Some(4), true));
        // The first one's animated uniforms and transitions no longer
        // reach the root.
        assert!(target(&first).is_none());
        assert!(target(&second).is_some_and(|t| t == surface.root));
        apply(&surface, &[MountItem::Delete { id: 2 }]);
        assert_eq!(root_layer(&surface), (Some(4), true));
        apply(&surface, &[MountItem::Delete { id: 4 }]);
        assert_eq!(root_layer(&surface), (None, false));
    }

    #[test]
    fn a_screen_effect_goes_with_the_views() {
        let surface = surface();
        mount(&surface, 2, ShaderRole::Screen);
        surface.mounter.borrow_mut().clear();
        assert_eq!(root_layer(&surface), (None, false));
    }

    /// Without a GPU device an effect and a screen effect draw their
    /// children as they are, and a transition starts no run.
    #[test]
    fn a_shader_that_cannot_draw_shows_the_children() {
        let surface = surface();
        let fx = mount(&surface, 2, ShaderRole::Effect);
        assert!(!effect(&fx.state()));
        let transition = mount(&surface, 4, ShaderRole::Transition);
        apply(
            &surface,
            &[MountItem::ShaderTransition {
                id: 4,
                duration: Duration::from_millis(300),
            }],
        );
        assert!(!effect(&transition.state()));
        let s = transition.state();
        assert!(s.shader.as_ref().is_some_and(|s| s.until.is_none()));
        drop(s);
        mount(&surface, 6, ShaderRole::Screen);
        assert!(!effect(&surface.root.state()));
    }

    /// A partial frame that meets a view reading what is behind it draws
    /// all of where it reads: its box and overflow in the window.
    #[test]
    fn a_backdrop_reader_reads_its_box_and_overflow() {
        let surface = surface();
        let shader =
            Shader::compile("fn shade(uv: vec2f) -> vec4f {\n    return sample_backdrop(uv);\n}\n")
                .expect("a valid shader");
        let layer = ShaderLayer::new(shader, &[], &mut Vec::new()).with_overflow(Points(4.0));
        let panel = mount(&surface, 2, ShaderRole::Fill);
        panel.state_mut().frame = crate::geom::rect(10.0, 20.0, 30.0, 40.0);
        set(&surface, &panel, Some(Arc::new(layer)));
        assert!(surface.backdrop_readers.borrow().contains(&2));
        let a = backdrop_area(&panel).expect("in sight");
        assert_eq!((a.left, a.top, a.right, a.bottom), (5.0, 15.0, 45.0, 65.0));
        panel.state_mut().style.hidden = true;
        assert!(backdrop_area(&panel).is_none(), "hidden: it reads nothing");
        // Without a GPU device nothing is read: it leaves the list.
        assert!(backdrop_areas(&surface).is_empty());
        assert!(surface.backdrop_readers.borrow().is_empty());
    }

    /// What [`draw_effect`] does with an effect's children each time the
    /// window draws it: whether it read them back.
    fn picture(fx: &NshView) -> bool {
        let stamp = crate::view::change_stamp();
        let mut s = fx.state_mut();
        let shader = s.shader.as_mut().expect("its shader");
        let due = shader.picture_due(fx.changes());
        if due {
            shader.pictured = Some(stamp);
        }
        due
    }

    /// An effect whose shader reads `nsh.time` draws a frame of its own
    /// every display frame: its children are read back once, then only
    /// after one of them, its `ShaderInput` or the whole window changed.
    #[test]
    fn an_effect_reads_its_children_back_only_after_a_change() {
        let surface = surface();
        let fx = mount(&surface, 2, ShaderRole::Effect);
        apply(
            &surface,
            &[
                MountItem::Create {
                    id: 4,
                    kind: ViewKind::View,
                },
                MountItem::Insert {
                    parent: 2,
                    child: 4,
                    before: None,
                },
            ],
        );
        let child = surface.view(4).expect("the child");
        let sibling = mount(&surface, 6, ShaderRole::Fill);
        let mut read = 0;
        for _ in 0..120 {
            // Its own frame, and one of a shader beside it.
            fx.redraw();
            sibling.redraw();
            read += usize::from(picture(&fx));
        }
        assert_eq!(read, 1, "120 frames of its own, one read");
        child.changed();
        assert!(picture(&fx), "a view in it changed");
        assert!(!picture(&fx));
        apply(&surface, &[MountItem::ShaderInput { id: 2 }]);
        assert!(picture(&fx), "the core says its pictures changed");
        assert!(!picture(&fx));
        // A video's frame, a native component or the theme.
        surface.invalidate();
        assert!(picture(&fx), "the whole window draws again");
        assert!(!picture(&fx));
    }
}
