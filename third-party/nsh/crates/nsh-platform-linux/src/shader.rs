//! Shader views: the layer [`MountItem::Shader`](nsh_core::MountItem)
//! mounts on a view, rendered by `nsh_engine::shader` and shown as a texture.
//!
//! The surface opens the GPU device the first time a shader is mounted
//! ([`Surface::shader_renderer`]). Each shader view renders on its own tick
//! callback while it has a frame to render or collect
//! ([`ShaderView::wants_frame`]: its uniforms, size or pictures changed, it
//! reads `nsh.time`, or a transition runs), at the surface's scale; a frame
//! that comes back becomes a `GdkMemoryTexture` and the view draws again. A
//! view out of sight (outside a clipping ancestor or the window) stops
//! ticking until it comes into sight again ([`reveal`]).
//!
//! What the layer draws decides where its frames show
//! ([`ShaderRole`]):
//!
//! - A fill draws under the view's children, clipped to its rounded box as
//!   a background is ([`draw`]).
//! - An effect draws instead of its children ([`draw_effect`]): whenever GTK
//!   draws the view, its children are drawn into a render node of their
//!   own, which the window's renderer renders into a texture of the box and
//!   its overflow; downloaded, it is the shader's `sample_content` when its
//!   pixels changed. The children keep their allocation, so they keep their
//!   presses.
//! - A transition draws as an effect while one runs ([`start_transition`],
//!   before the rest of its batch): what showed is its `sample_from`, its
//!   children its `sample_to`.
//! - A screen effect or transition is the root's: the root draws through
//!   it, its children (pages, dialogs, overlays) its content.
//!
//! What is behind a view (`sample_backdrop`) is a picture too: once the
//! frame is painted after something changed (the core's `ShaderInput`,
//! [`ui_changed`]), the surface's views are drawn anew up to the view
//! ([`skipped`]: the view and what comes after it are above it), rendered
//! and downloaded alike, and given to the shader when its pixels changed.
//!
//! Pages and dialogs that come and go through a shader draw pictures of
//! their two sides through a [`NavPainter`] in a layer over the stack (the
//! root for a dialog), `crate::navigation`'s.
//!
//! Without a GPU device ([`Surface::shader_renderer`] has none) a view
//! shows its background and children: an effect draws its children as
//! they are, a transition starts no run, and a page or a dialog comes with
//! its own motion.

use std::{
    cell::{Cell, RefCell},
    hash::{Hash, Hasher},
    rc::Rc,
    sync::Arc,
    time::{Duration, Instant},
};

use gtk4::{self as gtk, gdk, glib, graphene, gsk, prelude::*};
use nsh_core::{
    NodeId,
    animation::AnimationValue,
    geometry::{Points, Size, size},
    shader::{ShaderInput, ShaderLayer, ShaderRole},
};
use nsh_engine::shader::{Frame, Renderer, ShaderView};

use crate::{
    surface::Surface,
    view::{NshView, ViewState},
};

/// What a shader view shows.
#[derive(Default)]
pub(crate) struct ShaderState {
    renderer: Option<Rc<Renderer>>,
    view: ShaderView,
    texture: Option<gdk::MemoryTexture>,
    /// Its tick callback runs.
    ticking: bool,
    /// Out of sight with a frame to render ([`reveal`]).
    hidden: bool,
    /// The view that mounted the layer the root draws (a screen effect's or
    /// transition's).
    owner: Option<NodeId>,
    /// It mounts a screen effect or transition: its layer is the root's.
    screen: bool,
    /// When the transition that runs ends.
    until: Option<Instant>,
    /// The hash of the children's picture it was last given.
    children: Option<u64>,
    /// The children's render nodes that picture was rendered from: while
    /// GTK draws the same ones (it keeps a widget's node until the widget
    /// draws again), it is not rendered and downloaded again.
    drawn: Option<gsk::RenderNode>,
    /// The hash of the picture of what is behind it it was last given: one
    /// with the same pixels is not given again.
    backdrop: Option<u64>,
    /// What is behind it is to be taken again once a frame is painted.
    marked: Cell<bool>,
    scheduled: Cell<bool>,
}

impl ShaderState {
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

    /// Shows `pixels` until its first frame comes back.
    fn show(&mut self, pixels: &Pixels) {
        self.texture = Some(texture(
            pixels.width,
            pixels.height,
            &pixels.rgba,
            pixels.width as usize * 4,
        ));
    }
}

thread_local! {
    /// Shader views out of sight with a frame to render.
    static HIDDEN: RefCell<Vec<glib::WeakRef<NshView>>> = RefCell::default();
    /// Shader views that read what is behind them, each once ([`set`]).
    static BACKDROPS: RefCell<Vec<glib::WeakRef<NshView>>> = RefCell::default();
    /// While a picture of what is behind a view is drawn: the view (none:
    /// all of it is drawn), and whether the drawing reached it.
    static TRACE: RefCell<Option<(Option<NshView>, bool)>> = const { RefCell::new(None) };
}

#[cfg(test)]
thread_local! {
    /// Pictures of an effect's or a transition's children rendered and
    /// downloaded ([`render_children`]), counted for the tests.
    static RENDERED: Cell<usize> = const { Cell::new(0) };
}

fn texture(width: u32, height: u32, pixels: &[u8], stride: usize) -> gdk::MemoryTexture {
    gdk::MemoryTexture::new(
        width as i32,
        height as i32,
        gdk::MemoryFormat::R8g8b8a8Premultiplied,
        &glib::Bytes::from(pixels),
        stride,
    )
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
    {
        let mut state = target.state_mut();
        if layer.is_none() && state.shader.is_none() {
            return;
        }
        let shader = state.shader.get_or_insert_with(Default::default);
        if layer.is_some() && shader.renderer.is_none() {
            shader.renderer = surface.shader_renderer();
        }
        if layer.is_none() {
            shader.texture = None;
            shader.until = None;
        }
        shader.owner = (screen && layer.is_some()).then(|| view.id());
        shader.children = None;
        shader.drawn = None;
        shader.backdrop = None;
        shader.view.set_layer(layer);
        // Listed once while it reads what is behind it: the core sends the
        // layer again for every change of it, a uniform's included.
        let reads = shader.reads(ShaderInput::Backdrop);
        BACKDROPS.with(|b| {
            let mut b = b.borrow_mut();
            b.retain(|w| w.upgrade().is_some_and(|v| v != target));
            if reads {
                b.push(target.downgrade());
            }
        });
    }
    mark(&target);
    target.changed();
    tick(&target);
}

/// The values of the layer's animated slots.
pub(crate) fn set_args(view: &NshView, values: &[(u16, AnimationValue)]) {
    let Some(view) = target(view) else {
        return;
    };
    {
        let mut state = view.state_mut();
        let Some(shader) = state.shader.as_mut() else {
            return;
        };
        for &(slot, value) in values {
            shader.view.set_slot(slot, value);
        }
    }
    tick(&view);
}

/// Its size changed: a frame of the new size is rendered.
pub(crate) fn resized(view: &NshView) {
    if view.state().shader.is_some() {
        tick(view);
    }
}

/// A shader transition starts ([`nsh_core::MountItem::ShaderTransition`],
/// before the rest of its batch): what shows now becomes its `sample_from`,
/// and `nsh.progress` goes from 0 to 1 over `duration`.
pub(crate) fn start_transition(view: &NshView, duration: Duration) {
    let Some(view) = target(view) else {
        return;
    };
    let (running, overflow, frame) = {
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
        view.state()
            .shader
            .as_ref()
            .map(|s| s.view.frame())
            .filter(|f| f.width > 0 && f.height > 0)
            .map(Pixels::of_frame)
    } else {
        children(&view, overflow, frame, scale_of(&view))
    };
    {
        let mut s = view.state_mut();
        let Some(shader) = s.shader.as_mut() else {
            return;
        };
        let Some(renderer) = shader.renderer.clone() else {
            return;
        };
        if let Some(from) = &from {
            shader.view.set_input(
                &renderer,
                ShaderInput::From,
                Some((&from.rgba, from.width, from.height, from.width * 4)),
            );
            shader.show(from);
        }
        let now = Instant::now();
        shader.view.start_transition(duration, now);
        shader.until = Some(now + duration);
        shader.children = None;
        shader.drawn = None;
    }
    view.redraw();
    tick(&view);
}

/// Starts the view's tick callback if it has a frame to render.
fn tick(view: &NshView) {
    {
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
        shader.ticking = true;
    }
    view.add_tick_callback(|widget, clock| {
        let view = widget.downcast_ref::<NshView>().expect("an NshView");
        let go_on = frame(view, clock);
        if !go_on && let Some(shader) = view.state_mut().shader.as_mut() {
            shader.ticking = false;
        }
        if go_on {
            glib::ControlFlow::Continue
        } else {
            glib::ControlFlow::Break
        }
    });
}

/// The surface's own scale, fractional ones included.
fn scale_of(view: &impl IsA<gtk::Widget>) -> f32 {
    let view = view.as_ref();
    view.native()
        .and_then(|n| n.surface())
        .map_or(view.scale_factor() as f64, |s| s.scale()) as f32
}

/// One frame of the clock: renders, collects; whether to tick again.
fn frame(view: &NshView, _clock: &gdk::FrameClock) -> bool {
    if !crate::canvas::in_sight(view) {
        let mut state = view.state_mut();
        let Some(shader) = state.shader.as_mut() else {
            return false;
        };
        if !shader.hidden {
            shader.hidden = true;
            HIDDEN.with(|h| h.borrow_mut().push(view.downgrade()));
        }
        return false;
    }
    let scale = scale_of(view);
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
        }
        let new = shader.view.render(&renderer, now);
        if new {
            let f = shader.view.frame();
            shader.texture = (f.width > 0 && f.height > 0)
                .then(|| texture(f.width, f.height, &f.pixels, f.stride as usize));
        }
        new || ended
    };
    // Its own frame: what is behind other views is not taken again for it.
    if draw {
        view.redraw();
    }
    view.state()
        .shader
        .as_ref()
        .is_some_and(|s| s.view.wants_frame() || s.until.is_some())
}

/// Starts the shader views that came into sight (every frame, after layout).
pub(crate) fn reveal() {
    let shown: Vec<NshView> = HIDDEN.with(|h| {
        let mut shown = Vec::new();
        h.borrow_mut().retain(|weak| {
            let Some(view) = weak.upgrade() else {
                return false;
            };
            if !view.is_mapped() || !crate::canvas::in_sight(&view) {
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

/// Draws `texture` over the box and `overflow` points around it.
fn append(snapshot: &gtk::Snapshot, texture: &gdk::MemoryTexture, frame: Size<Points>, o: f32) {
    snapshot.append_texture(
        texture,
        &graphene::Rect::new(-o, -o, frame.width.0 + 2.0 * o, frame.height.0 + 2.0 * o),
    );
}

/// Draws a fill's last frame over the view's box, inside its rounded
/// corners (an effect draws with its children, [`draw_effect`]).
pub(crate) fn draw(snapshot: &gtk::Snapshot, state: &ViewState) {
    let Some(shader) = state.shader.as_ref() else {
        return;
    };
    if shader.role() != Some(ShaderRole::Fill) {
        return;
    }
    let Some(texture) = shader.texture.as_ref() else {
        return;
    };
    let size = state.frame.size;
    if size.width.0 <= 0.0 || size.height.0 <= 0.0 {
        return;
    }
    crate::decor::push_clip(snapshot, state);
    append(snapshot, texture, size, shader.view.overflow().0);
    snapshot.pop();
}

/// Whether `state` draws its children through its shader now
/// ([`draw_effect`]).
pub(crate) fn effect(state: &ViewState) -> bool {
    state.shader.as_ref().is_some_and(ShaderState::replaces)
}

/// Draws an effect: `view`'s children into its picture, then the shader's
/// last frame over its box and overflow. False when it has no frame yet:
/// the children are then drawn as they are.
pub(crate) fn draw_effect(snapshot: &gtk::Snapshot, view: &NshView) -> bool {
    let (input, reads, overflow, frame) = {
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
    // A picture of what is behind a view draws the last frame. The
    // children are pictured again only when GTK drew any of them again (an
    // effect that reads `nsh.time` draws itself on every frame, its
    // children as they were).
    let scale = scale_of(view);
    let node = (reads && !tracing())
        .then(|| children_node(view, overflow, scale))
        .filter(|node| {
            let s = view.state();
            let drawn = s.shader.as_ref().and_then(|s| s.drawn.as_ref());
            drawn.is_none_or(|drawn| !same_nodes(drawn, node))
        });
    if let Some(node) = node
        && let Some(pixels) = render_children(view, node.clone(), overflow, frame, scale)
    {
        let hash = pixels.hash();
        let given = {
            let mut s = view.state_mut();
            match s.shader.as_mut() {
                Some(shader) => {
                    shader.drawn = Some(node);
                    let new = shader.children != Some(hash);
                    if new {
                        shader.children = Some(hash);
                        if let Some(renderer) = shader.renderer.clone() {
                            shader.view.set_input(
                                &renderer,
                                input,
                                Some((&pixels.rgba, pixels.width, pixels.height, pixels.width * 4)),
                            );
                        }
                    }
                    new
                }
                None => false,
            }
        };
        if given {
            tick(view);
        }
    }
    let s = view.state();
    let Some(texture) = s.shader.as_ref().and_then(|s| s.texture.as_ref()) else {
        return false;
    };
    append(snapshot, texture, frame, overflow);
    true
}

/// `view`'s children rendered over its box and `overflow` points around
/// it at `scale`.
fn children(view: &NshView, overflow: f32, frame: Size<Points>, scale: f32) -> Option<Pixels> {
    let node = children_node(view, overflow, scale);
    render_children(view, node, overflow, frame, scale)
}

/// `view`'s children's render nodes, placed as [`children`] renders them:
/// GTK's own nodes of the last frame for the widgets it did not draw again.
fn children_node(view: &NshView, overflow: f32, scale: f32) -> gsk::RenderNode {
    let inner = gtk::Snapshot::new();
    inner.scale(scale, scale);
    inner.translate(&graphene::Point::new(overflow, overflow));
    view.snapshot_children(&inner);
    inner
        .to_node()
        .unwrap_or_else(|| gsk::ContainerNode::new(&[]).upcast())
}

/// `node` ([`children_node`]) rendered over `view`'s box and `overflow`
/// points around it at `scale`.
fn render_children(
    view: &NshView,
    node: gsk::RenderNode,
    overflow: f32,
    frame: Size<Points>,
    scale: f32,
) -> Option<Pixels> {
    let renderer = view.native()?.renderer()?;
    let (w, h) = (
        frame.width.0 + 2.0 * overflow,
        frame.height.0 + 2.0 * overflow,
    );
    if w <= 0.0 || h <= 0.0 {
        return None;
    }
    let viewport = graphene::Rect::new(
        0.0,
        0.0,
        (w * scale).round().max(1.0),
        (h * scale).round().max(1.0),
    );
    let pixels = Pixels::of(&renderer.render_texture(&node, Some(&viewport)));
    #[cfg(test)]
    RENDERED.set(RENDERED.get() + 1);
    Some(pixels)
}

/// Whether render nodes `a` and `b` draw the same: they are one node, or
/// the same kind of node around the same nodes (the wrappers a snapshot
/// makes anew each time it places what GTK kept).
fn same_nodes(a: &gsk::RenderNode, b: &gsk::RenderNode) -> bool {
    use gtk::glib::translate::ToGlibPtr;
    let (pa, pb): (*mut gsk::ffi::GskRenderNode, *mut gsk::ffi::GskRenderNode) =
        (a.to_glib_none().0, b.to_glib_none().0);
    if pa == pb {
        return true;
    }
    if a.node_type() != b.node_type() {
        return false;
    }
    if let (Some(a), Some(b)) = (
        a.downcast_ref::<gsk::ContainerNode>(),
        b.downcast_ref::<gsk::ContainerNode>(),
    ) {
        return a.n_children() == b.n_children()
            && (0..a.n_children()).all(|i| same_nodes(&a.child(i), &b.child(i)));
    }
    if let (Some(a), Some(b)) = (
        a.downcast_ref::<gsk::TransformNode>(),
        b.downcast_ref::<gsk::TransformNode>(),
    ) {
        return a.transform() == b.transform() && same_nodes(&a.child(), &b.child());
    }
    if let (Some(a), Some(b)) = (
        a.downcast_ref::<gsk::ClipNode>(),
        b.downcast_ref::<gsk::ClipNode>(),
    ) {
        return a.clip() == b.clip() && same_nodes(&a.child(), &b.child());
    }
    if let (Some(a), Some(b)) = (
        a.downcast_ref::<gsk::OpacityNode>(),
        b.downcast_ref::<gsk::OpacityNode>(),
    ) {
        return a.opacity() == b.opacity() && same_nodes(&a.child(), &b.child());
    }
    if let (Some(a), Some(b)) = (
        a.downcast_ref::<gsk::DebugNode>(),
        b.downcast_ref::<gsk::DebugNode>(),
    ) {
        return same_nodes(&a.child(), &b.child());
    }
    false
}

/// `snapshot` rendered over `pixels` (width, height) by the window's
/// renderer and downloaded; transparent when it drew nothing.
fn render(renderer: &gsk::Renderer, snapshot: gtk::Snapshot, pixels: (f32, f32)) -> Pixels {
    let viewport = graphene::Rect::new(
        0.0,
        0.0,
        pixels.0.round().max(1.0),
        pixels.1.round().max(1.0),
    );
    let node = snapshot
        .to_node()
        .unwrap_or_else(|| gsk::ColorNode::new(&gdk::RGBA::TRANSPARENT, &viewport).upcast());
    Pixels::of(&renderer.render_texture(&node, Some(&viewport)))
}

/// What the core says changed under an effect or behind a view
/// (`MountItem::ShaderInput`): an effect draws again (its children's
/// picture is taken then), what is behind a view is taken again.
pub(crate) fn input_changed(view: &NshView) {
    let Some(view) = target(view) else {
        return;
    };
    if let Some(shader) = view.state_mut().shader.as_mut() {
        shader.drawn = None;
    }
    mark(&view);
    view.redraw();
}

/// `changed` changed on the UI thread (an animation, scrolling, an image):
/// what is behind each view that reads it is taken again where `changed`
/// draws behind that view ([`behind`]); what draws in it or above it does
/// not show in that picture.
pub(crate) fn ui_changed(changed: &NshView) {
    if tracing() {
        return;
    }
    let views: Vec<NshView> = BACKDROPS.with(|b| {
        let mut b = b.borrow_mut();
        b.retain(|w| {
            w.upgrade().is_some_and(|v| {
                v.state()
                    .shader
                    .as_ref()
                    .is_some_and(|s| s.reads(ShaderInput::Backdrop))
            })
        });
        b.iter().filter_map(|w| w.upgrade()).collect()
    });
    if views.is_empty() {
        return;
    }
    let at = draw_path(changed.upcast_ref());
    for view in views {
        if behind(&at, &draw_path(view.upcast_ref())) {
            mark(&view);
        }
    }
}

/// Where `widget` draws among its window's widgets: its place among its
/// siblings at each level, from the top.
fn draw_path(widget: &gtk::Widget) -> Vec<usize> {
    let mut path = Vec::new();
    let mut widget = widget.clone();
    while let Some(parent) = widget.parent() {
        let mut place = 0;
        let mut sibling = widget.prev_sibling();
        while let Some(s) = sibling {
            place += 1;
            sibling = s.prev_sibling();
        }
        path.push(place);
        widget = parent;
    }
    path.reverse();
    path
}

/// Whether what draws at `changed` ([`draw_path`]) shows behind the view at
/// `view`: an ancestor's own drawing, or what draws before it; not the view
/// itself, what it holds or what draws after it.
fn behind(changed: &[usize], view: &[usize]) -> bool {
    for (c, v) in changed.iter().zip(view) {
        if c != v {
            return c < v;
        }
    }
    changed.len() < view.len()
}

/// What is behind `view` is to be taken again, once a frame is painted.
fn mark(view: &NshView) {
    let due = {
        let s = view.state();
        let Some(shader) = s
            .shader
            .as_ref()
            .filter(|s| s.renderer.is_some() && s.reads(ShaderInput::Backdrop))
        else {
            return;
        };
        shader.marked.set(true);
        !tracing() && !shader.scheduled.replace(true)
    };
    if due {
        schedule(view);
    }
}

/// True while a picture of what is behind a view is drawn.
pub(crate) fn tracing() -> bool {
    TRACE.with(|t| t.borrow().is_some())
}

/// True while a picture of what is behind a view is drawn and the drawing
/// reached it: what follows is above it.
pub(crate) fn past() -> bool {
    TRACE.with(|t| t.borrow().as_ref().is_some_and(|(_, reached)| *reached))
}

/// True when `view` is left out of the picture being drawn: it is the view
/// the picture is behind, or above it.
pub(crate) fn skipped(view: &NshView) -> bool {
    TRACE.with(|t| {
        let mut t = t.borrow_mut();
        let Some((of, reached)) = t.as_mut() else {
            return false;
        };
        if !*reached && of.as_ref() == Some(view) {
            *reached = true;
        }
        *reached
    })
}

/// Takes the picture of what is behind `view` once the frame being painted
/// is (its views drawn and placed).
fn schedule(view: &NshView) {
    let Some(clock) = view.frame_clock() else {
        if let Some(s) = view.state().shader.as_ref() {
            s.scheduled.set(false);
        }
        return;
    };
    let handler = Rc::new(Cell::new(None::<glib::SignalHandlerId>));
    let weak = view.downgrade();
    let id = clock.connect_after_paint({
        let handler = handler.clone();
        move |clock| {
            if let Some(id) = handler.take() {
                clock.disconnect(id);
            }
            if let Some(view) = weak.upgrade() {
                take_backdrop(&view);
            }
        }
    });
    handler.set(Some(id));
}

/// Draws the surface's views anew up to `view` (what is behind it) over its
/// box and overflow and gives the picture to its shader when its pixels
/// changed.
fn take_backdrop(view: &NshView) {
    let scale = scale_of(view);
    let (overflow, frame) = {
        let s = view.state();
        let Some(shader) = s.shader.as_ref() else {
            return;
        };
        shader.scheduled.set(false);
        if !shader.marked.replace(false) {
            return;
        }
        (shader.view.overflow().0, s.frame.size)
    };
    let (w, h) = (
        frame.width.0 + 2.0 * overflow,
        frame.height.0 + 2.0 * overflow,
    );
    if w <= 0.0 || h <= 0.0 {
        return;
    }
    let mut root = view.clone();
    while let Some(parent) = root.parent_view() {
        root = parent;
    }
    let picture = (|| {
        let renderer = view.native()?.renderer()?;
        let at = view.compute_point(&root, &graphene::Point::new(-overflow, -overflow))?;
        let snapshot = gtk::Snapshot::new();
        snapshot.scale(scale, scale);
        snapshot.translate(&graphene::Point::new(-at.x(), -at.y()));
        if root != *view {
            TRACE.with(|t| *t.borrow_mut() = Some((Some(view.clone()), false)));
            root.draw(&snapshot);
            TRACE.with(|t| *t.borrow_mut() = None);
        }
        Some(render(&renderer, snapshot, (w * scale, h * scale)))
    })();
    let hash = picture.as_ref().map(Pixels::hash);
    {
        let mut s = view.state_mut();
        let Some(shader) = s.shader.as_mut() else {
            return;
        };
        let Some(renderer) = shader.renderer.clone() else {
            return;
        };
        // What is behind it looks as it did (what changed is outside its
        // box or above it, or drew the same): its frame stands.
        if hash.is_some() && hash == shader.backdrop {
            return;
        }
        shader.backdrop = hash;
        shader.view.set_input(
            &renderer,
            ShaderInput::Backdrop,
            picture
                .as_ref()
                .map(|p| (&p.rgba[..], p.width, p.height, p.width * 4)),
        );
    }
    tick(view);
}

/// A picture's pixels: RGBA, premultiplied, rows packed.
pub(crate) struct Pixels {
    width: u32,
    height: u32,
    rgba: Vec<u8>,
}

impl Pixels {
    /// `texture`'s pixels.
    fn of(texture: &gdk::Texture) -> Pixels {
        let (width, height) = (texture.width() as u32, texture.height() as u32);
        let mut downloader = gdk::TextureDownloader::new(texture);
        downloader.set_format(gdk::MemoryFormat::R8g8b8a8Premultiplied);
        let (bytes, stride) = downloader.download_bytes();
        let row = width as usize * 4;
        let mut rgba = Vec::with_capacity(row * height as usize);
        for line in bytes.chunks(stride).take(height as usize) {
            rgba.extend_from_slice(&line[..row]);
        }
        Pixels {
            width,
            height,
            rgba,
        }
    }

    /// A shader's frame.
    fn of_frame(frame: &Frame) -> Pixels {
        Pixels {
            width: frame.width,
            height: frame.height,
            rgba: frame.tight().into_owned(),
        }
    }

    fn hash(&self) -> u64 {
        let mut hasher = rustc_hash::FxHasher::default();
        (self.width, self.height).hash(&mut hasher);
        self.rgba.hash(&mut hasher);
        hasher.finish()
    }
}

/// `host` drawn anew into pixels (its views' own drawing, not GTK's render
/// nodes of the last frame): without `upper` and what draws after it when
/// given (a transition's lower side), and without `hidden` (an image
/// navigation hosts).
pub(crate) fn nav_picture(
    host: &NshView,
    upper: Option<&NshView>,
    hidden: Option<&gtk::Widget>,
) -> Option<Rc<Pixels>> {
    let renderer = host.native()?.renderer()?;
    let scale = scale_of(host);
    let size = host.state().frame.size;
    let snapshot = gtk::Snapshot::new();
    snapshot.scale(scale, scale);
    let shown = hidden.map(|w| (w, w.is_child_visible()));
    if let Some((w, _)) = &shown {
        w.set_child_visible(false);
    }
    TRACE.with(|t| *t.borrow_mut() = Some((upper.cloned(), false)));
    host.draw(&snapshot);
    TRACE.with(|t| *t.borrow_mut() = None);
    if let Some((w, visible)) = shown {
        w.set_child_visible(visible);
    }
    Some(Rc::new(render(
        &renderer,
        snapshot,
        (size.width.0 * scale, size.height.0 * scale),
    )))
}

/// A page's or a dialog's transition through a shader
/// ([`nsh_core::NavShader`]): pictures of its lower side (`sample_from`)
/// and upper side (`sample_to`) drawn through the shader as its transition
/// runs (`ShaderView::start_transition`, backwards when it goes). Frames
/// come back from the GPU a frame or two after they are asked for; the last
/// one shows meanwhile, the side it starts from before the first.
pub(crate) struct NavPainter {
    renderer: Rc<Renderer>,
    view: ShaderView,
    size: Size<Points>,
    texture: gdk::MemoryTexture,
}

impl NavPainter {
    /// `layer` over `from` and `to`, pictures of a host of `size`, for
    /// `duration` from now, `nsh.progress` from 1 to 0 when it goes
    /// (`reverse`); `None` without a GPU device.
    pub(crate) fn new(
        surface: &Surface,
        layer: &ShaderLayer,
        (from, to): (&Pixels, &Pixels),
        size: Size<Points>,
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
        let first = if reverse { to } else { from };
        let mut painter = Self {
            renderer,
            view,
            size,
            texture: texture(
                first.width,
                first.height,
                &first.rgba,
                first.width as usize * 4,
            ),
        };
        painter.input(ShaderInput::From, from);
        painter.input(ShaderInput::To, to);
        Some(painter)
    }

    fn input(&mut self, input: ShaderInput, pixels: &Pixels) {
        self.view.set_input(
            &self.renderer,
            input,
            Some((&pixels.rgba, pixels.width, pixels.height, pixels.width * 4)),
        );
    }

    /// The transition as it is now, at `widget`'s scale.
    pub(crate) fn node(&mut self, widget: &impl IsA<gtk::Widget>) -> gsk::RenderNode {
        self.view.set_size(self.size, scale_of(widget));
        if self.view.render(&self.renderer, Instant::now()) {
            let f = self.view.frame();
            if f.width > 0 && f.height > 0 {
                self.texture = texture(f.width, f.height, &f.pixels, f.stride as usize);
            }
        }
        gsk::TextureNode::new(
            &self.texture,
            &graphene::Rect::new(0.0, 0.0, self.size.width.0, self.size.height.0),
        )
        .upcast()
    }
}

#[cfg(test)]
mod tests {
    use nsh_core::{Bounds, MountItem, ROOT_ID, ViewKind, shader::Shader};

    use super::*;
    use crate::gtk_test::{self, apply, frame};

    fn layer(role: ShaderRole) -> Arc<ShaderLayer> {
        shading(role, "vec4f(uv, 0.0, 1.0)")
    }

    /// A layer of `role` whose `shade` returns `color` (WGSL, of `uv`).
    fn shading(role: ShaderRole, color: &str) -> Arc<ShaderLayer> {
        let source = format!("fn shade(uv: vec2f) -> vec4f {{\n    return {color};\n}}\n");
        let shader = Shader::compile(&source).expect("a valid shader");
        let mut layer = ShaderLayer::new(shader, &[], &mut Vec::new());
        layer.role = role;
        Arc::new(layer)
    }

    /// A view `id` under `parent`, at `at`.
    fn add(surface: &Rc<Surface>, id: NodeId, parent: NodeId, at: Bounds<Points>) -> NshView {
        apply(
            surface,
            &[
                MountItem::Create {
                    id,
                    kind: ViewKind::View,
                },
                MountItem::Insert {
                    parent,
                    child: id,
                    before: None,
                },
                MountItem::Frame { id, frame: at },
            ],
        );
        gtk_test::view(surface, id)
    }

    /// A view `id` under the root, 100 points square, showing `layer`.
    fn mount(surface: &Rc<Surface>, id: NodeId, layer: Arc<ShaderLayer>) -> NshView {
        let view = add(surface, id, ROOT_ID, frame(0.0, 0.0, 100.0, 100.0));
        apply(
            surface,
            &[MountItem::Shader {
                id,
                layer: Some(layer),
            }],
        );
        view
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
        gtk_test::run(|| {
            let surface = gtk_test::surface();
            for (id, role) in [(2, ShaderRole::Screen), (4, ShaderRole::ScreenTransition)] {
                mount(&surface, id, layer(role));
                assert_eq!(root_layer(&surface), (Some(id), true));
                apply(&surface, &[MountItem::Delete { id }]);
                assert_eq!(root_layer(&surface), (None, false));
            }
        });
    }

    #[test]
    fn deleting_a_replaced_screen_effect_keeps_the_new_one() {
        gtk_test::run(|| {
            let surface = gtk_test::surface();
            let first = mount(&surface, 2, layer(ShaderRole::Screen));
            let second = mount(&surface, 4, layer(ShaderRole::ScreenTransition));
            assert_eq!(root_layer(&surface), (Some(4), true));
            // The first one's animated uniforms and transitions no longer
            // reach the root.
            assert!(target(&first).is_none());
            assert!(target(&second).is_some_and(|t| t == surface.root));
            apply(&surface, &[MountItem::Delete { id: 2 }]);
            assert_eq!(root_layer(&surface), (Some(4), true));
            apply(&surface, &[MountItem::Delete { id: 4 }]);
            assert_eq!(root_layer(&surface), (None, false));
        });
    }

    #[test]
    fn a_screen_effect_goes_with_the_views() {
        gtk_test::run(|| {
            let surface = gtk_test::surface();
            mount(&surface, 2, layer(ShaderRole::Screen));
            surface.mounter.borrow_mut().clear();
            assert_eq!(root_layer(&surface), (None, false));
        });
    }

    /// A view that reads what is behind it is listed once however often
    /// its layer comes (the core sends it again for every change of it, a
    /// uniform's included), and no longer once it stops reading it.
    #[test]
    fn a_backdrop_reader_is_listed_once() {
        gtk_test::run(|| {
            let surface = gtk_test::surface();
            let glass = shading(ShaderRole::Fill, "sample_backdrop(uv)");
            let view = mount(&surface, 2, glass.clone());
            for _ in 0..5 {
                apply(
                    &surface,
                    &[MountItem::Shader {
                        id: 2,
                        layer: Some(glass.clone()),
                    }],
                );
            }
            let listed = || {
                BACKDROPS.with(|b| {
                    b.borrow()
                        .iter()
                        .filter(|w| w.upgrade().as_ref() == Some(&view))
                        .count()
                })
            };
            assert_eq!(listed(), 1);
            apply(
                &surface,
                &[MountItem::Shader {
                    id: 2,
                    layer: Some(layer(ShaderRole::Fill)),
                }],
            );
            assert_eq!(listed(), 0);
        });
    }

    /// An effect that reads `nsh.time` draws itself on every frame (its
    /// shader's frames only `redraw` it): its children, which GTK did not
    /// draw again, are rendered and downloaded once, and again only after
    /// one of them draws again.
    #[test]
    fn an_effect_renders_its_children_again_only_after_they_change() {
        gtk_test::run(|| {
            let surface = gtk_test::surface();
            let content = shading(ShaderRole::Effect, "sample_content(uv)");
            let effect = mount(&surface, 2, content);
            let child = add(&surface, 4, 2, frame(10.0, 10.0, 40.0, 40.0));
            child.state_mut().style.background_color = nsh_core::Color(0xff0000ff);
            child.changed();
            let window = gtk_test::show(&surface);
            assert!(
                gtk_test::wait_until(|| child.width() > 0),
                "the views are laid out"
            );
            let before = RENDERED.get();
            // One of the effect's frames, as GTK draws it.
            let draw = || {
                effect.redraw();
                draw_effect(&gtk::Snapshot::new(), &effect);
            };
            for _ in 0..10 {
                draw();
            }
            assert_eq!(RENDERED.get() - before, 1, "ten frames, one picture");
            child.changed();
            draw();
            draw();
            assert_eq!(RENDERED.get() - before, 2, "a child drew again");
            window.destroy();
        });
    }

    /// A picture of what is behind a view leaves out the widgets its
    /// ancestors host after it (a text field, navigation's layers), as it
    /// leaves out the views after it.
    #[test]
    fn what_is_behind_a_view_leaves_out_widgets_hosted_above_it() {
        gtk_test::run(|| {
            let surface = gtk_test::surface();
            let parent = add(&surface, 2, ROOT_ID, frame(0.0, 0.0, 100.0, 100.0));
            let glass = add(&surface, 4, 2, frame(10.0, 10.0, 20.0, 20.0));
            let hosted = gtk::DrawingArea::new();
            hosted.set_draw_func(|_, cx, _, _| {
                cx.set_source_rgb(1.0, 0.0, 0.0);
                let _ = cx.paint();
            });
            parent.set_native(&hosted, frame(60.0, 60.0, 30.0, 30.0));
            let window = gtk_test::show(&surface);
            assert!(
                gtk_test::wait_until(|| hosted.width() > 0),
                "the views are laid out"
            );
            let area = graphene::Rect::new(60.0, 60.0, 30.0, 30.0);
            // Whether the surface drawn anew up to `view` (all of it for
            // `None`), as a picture of what is behind it is, shows the
            // hosted widget.
            let shows = |view: Option<&NshView>| {
                let snapshot = gtk::Snapshot::new();
                TRACE.with(|t| *t.borrow_mut() = Some((view.cloned(), false)));
                surface.root.draw(&snapshot);
                TRACE.with(|t| *t.borrow_mut() = None);
                snapshot
                    .to_node()
                    .is_some_and(|node| node.bounds().intersection(&area).is_some())
            };
            assert!(shows(None), "the whole surface");
            assert!(!shows(Some(&glass)), "what is behind the view");
            window.destroy();
        });
    }

    /// A build without the feature `shader` refuses shaders, saying why,
    /// and has no renderer.
    #[cfg(not(feature = "shader"))]
    #[test]
    fn without_the_feature_there_are_no_shaders() {
        let error = Shader::compile("fn shade(uv: vec2f) -> vec4f { return vec4f(1.0); }")
            .expect_err("no compiler");
        assert!(error.to_string().contains("feature `shader`"), "{error}");
        assert!(Renderer::new(nsh_engine::shader::PixelFormat::Rgba).is_none());
        let mut view = ShaderView::default();
        assert!(!view.wants_frame());
        assert!(!view.replaces_children(Instant::now()));
    }

    /// Without a GPU device an effect and a screen effect draw their
    /// children as they are, and so does a transition that would run.
    #[test]
    fn a_shader_that_cannot_draw_shows_the_children() {
        let mut shader = ShaderState::default();
        for role in [ShaderRole::Effect, ShaderRole::Screen] {
            shader.view.set_layer(Some(layer(role)));
            assert!(!shader.replaces());
        }
        shader.view.set_layer(Some(layer(ShaderRole::Transition)));
        shader.until = Some(Instant::now() + Duration::from_secs(60));
        assert!(!shader.replaces());
    }

    /// What is behind a view is pictured again for a change drawn before
    /// it only.
    #[test]
    fn a_backdrop_follows_what_draws_behind_it() {
        let view = [0, 2, 1];
        assert!(behind(&[0], &view), "an ancestor's own drawing");
        assert!(
            behind(&[0, 1, 5], &view),
            "a sibling of an ancestor before it"
        );
        assert!(
            behind(&[0, 2, 0, 3], &view),
            "a sibling before it, and what it holds"
        );
        assert!(!behind(&view, &view), "its own frame");
        assert!(!behind(&[0, 2, 1, 0], &view), "what it holds");
        assert!(!behind(&[0, 2, 2], &view), "a sibling after it");
        assert!(!behind(&[1], &view), "what draws after an ancestor");
    }

    /// The children are pictured again only when GTK drew one of them
    /// again: wrappers made anew around the nodes it kept draw the same.
    #[test]
    fn children_are_pictured_again_when_their_nodes_change() {
        // GSK registers its node types when one is first asked for, not
        // when a node is made: without this, making one before any other
        // test initialized GTK aborts.
        <gsk::ColorNode as glib::prelude::StaticType>::static_type();
        let rect = graphene::Rect::new(0.0, 0.0, 10.0, 10.0);
        let kept = gsk::ColorNode::new(&gdk::RGBA::RED, &rect);
        let other = gsk::ColorNode::new(&gdk::RGBA::RED, &rect);
        let placed = |node: &gsk::ColorNode, x: f32| -> gsk::RenderNode {
            let at = gsk::Transform::new().translate(&graphene::Point::new(x, 0.0));
            gsk::ContainerNode::new(&[gsk::TransformNode::new(node, Some(&at)).upcast()]).upcast()
        };
        assert!(same_nodes(&placed(&kept, 4.0), &placed(&kept, 4.0)));
        assert!(
            !same_nodes(&placed(&kept, 4.0), &placed(&other, 4.0)),
            "drawn again"
        );
        assert!(
            !same_nodes(&placed(&kept, 4.0), &placed(&kept, 8.0)),
            "moved"
        );
    }
}
