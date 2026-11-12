//! Shader views: the layer [`MountItem::Shader`](nsh_core::MountItem)
//! mounts on a view, rendered by `nsh_engine::shader` and shown as a `CGImage` in a
//! sublayer under the view's children, clipped to its rounded box as a
//! background is.
//!
//! The mounter opens the GPU device the first time a shader is mounted
//! ([`Shaders::set`]). A display link of its own runs while some shader
//! view has a frame to render or collect ([`ShaderView::wants_frame`]: its
//! uniforms or size changed, or it reads `nsh.time`); each tick renders at
//! the screen's scale and a frame that comes back becomes the sublayer's
//! contents. A view outside any window renders nothing until it is back in
//! one.
//!
//! Effects and transitions ([`ShaderRole`]) draw their children through
//! the shader: the children are in a view of their own
//! ([`crate::decor::Decor::set_effect`]; a backdrop blur stays behind the
//! view's background, under the frames) whose layer an empty mask hides
//! while the frames show (UIKit hit-tests views, not what shows, so they
//! keep their touches), and the frames' layer goes above it, `overflow`
//! points beyond the box. Where there is no GPU device the children show
//! as they are. A screen effect or transition does the same with the
//! surface's root view, whose children stay hidden while any of them hides
//! them. The pictures a shader reads are that view
//! rendered with `renderInContext:` (without its mask) and, for
//! `sample_backdrop`, the window with the view left out, taken again on
//! the tick after the core says they changed ([`Shaders::input_changed`])
//! or the mounter changed a view in them ([`Shaders::ui_changed`]). A
//! transition pictures the children as they were when it starts
//! ([`Shaders::start_transition`]).
//!
//! A page's or a dialog's `transitionShader` changes the screens at once
//! under a [`NavOverlay`] over the window's part where the surface is:
//! pictures of it before and after the change, run backwards when the
//! upper side leaves. Where there is no GPU device, a transition starts no
//! run and a page or a dialog comes and goes with its own motion
//! ([`Shaders::nav_overlay`]).

use std::{cell::OnceCell, sync::Arc, time::Instant};

use nsh_core::{
    NodeId, ViewStyle,
    animation::AnimationValue,
    geometry::{Points, px, size},
    shader::{ShaderInput, ShaderLayer, ShaderRole},
};
use nsh_engine::shader::{Frame, PixelFormat, Renderer, ShaderView};
use objc2::{Message, rc::Retained, runtime::AnyObject, sel};
use objc2_core_foundation::{CFRetained, CGFloat, CGPoint, CGRect, CGSize};
use objc2_core_graphics::CGImage;
use objc2_foundation::{NSRunLoop, NSRunLoopCommonModes};
use objc2_quartz_core::{CADisplayLink, CALayer, CAShapeLayer, kCAGravityResize};
use objc2_ui_kit::UIView;
use rustc_hash::FxHashMap;

use crate::{
    decor::{corner_mask, quiet, rounded, set_corners},
    target::EventTarget,
};

/// Whether the children `view`'s shader draws are hidden at `now`: an
/// effect's always, a transition's while it runs; never where the
/// `renderer` slot holds no GPU device (the view shows its background and
/// children as they are).
fn hides(view: &mut ShaderView, renderer: &OnceCell<Option<Renderer>>, now: Instant) -> bool {
    view.replaces_children(now) && matches!(renderer.get(), Some(Some(_)))
}

/// Over the fills, gradients and inset shadows `decor` and `visual` put
/// behind the children (from -1024), under the borders drawn there
/// (-1023) and the children themselves: the shader paints the box as a
/// background image would.
const SHADER_Z: CGFloat = -1024.0 + 0.75;

/// Above every child: the frames of an effect show instead of them.
const OVER: CGFloat = 1.0e6;

/// The shader views of one surface and the GPU device they render with.
pub(crate) struct Shaders {
    /// Opened the first time a shader is mounted (`None` inside: there is
    /// no GPU device).
    renderer: OnceCell<Option<Renderer>>,
    views: FxHashMap<NodeId, ShaderState>,
    /// Pages and dialogs coming or going through a shader.
    overlays: Vec<NavOverlay>,
    /// Pictures of what showed before pages and dialogs leave, taken
    /// before their views go ([`Shaders::hold`]).
    held: Vec<Held>,
    link: Retained<CADisplayLink>,
    /// The link is unpaused.
    running: bool,
}

/// What one shader view shows.
struct ShaderState {
    /// The view the shader draws in.
    host: Retained<UIView>,
    /// Shows the frames, clipped to the host's rounded box.
    layer: Retained<CALayer>,
    /// Clips [`ShaderState::layer`] to corners of different radii.
    mask: Option<Retained<CAShapeLayer>>,
    view: ShaderView,
    /// What the layer draws ([`ShaderRole::Fill`]: under the children; the
    /// others over them).
    role: ShaderRole,
    /// The view holding the children the shader draws (an effect's or a
    /// transition's).
    children: Option<Retained<UIView>>,
    /// The scale it renders at.
    scale: CGFloat,
    /// The children's picture is due.
    stale: bool,
    /// The backdrop's picture is due.
    backdrop_stale: bool,
    /// The children are masked: the frames show instead ([`hides`]).
    masked: bool,
    /// Where the children's pictures are drawn, kept for the next.
    canvas: Option<Canvas>,
    /// Where the backdrop's pictures are drawn, kept for the next.
    backdrop_canvas: Option<Canvas>,
}

impl Shaders {
    pub(crate) fn new(target: &EventTarget) -> Self {
        // SAFETY: `shaderFrame:` is implemented by `EventTarget`, which
        // outlives the link (it is invalidated in `Drop`).
        let link =
            unsafe { CADisplayLink::displayLinkWithTarget_selector(target, sel!(shaderFrame:)) };
        crate::animation::full_rate(&link);
        link.setPaused(true);
        // SAFETY: the main run loop and standard modes. Common modes keep
        // shaders running while a scroll view is tracking.
        unsafe { link.addToRunLoop_forMode(&NSRunLoop::mainRunLoop(), NSRunLoopCommonModes) };
        Self {
            renderer: OnceCell::new(),
            views: FxHashMap::default(),
            overlays: Vec::new(),
            held: Vec::new(),
            link,
            running: false,
        }
    }

    /// Whether `id` is a shader view.
    pub(crate) fn has(&self, id: NodeId) -> bool {
        self.views.contains_key(&id)
    }

    /// Whether shader view `id` is a screen effect or transition (it draws
    /// the root's children).
    pub(crate) fn draws_screen(&self, id: NodeId) -> bool {
        self.views.get(&id).is_some_and(|s| is_screen(s.role))
    }

    /// Whether any screen effect or transition is mounted.
    pub(crate) fn any_screen(&self) -> bool {
        self.views.values().any(|s| is_screen(s.role))
    }

    /// The device was looked for and there is none: shader views draw
    /// nothing.
    pub(crate) fn without_device(&self) -> bool {
        matches!(self.renderer.get(), Some(None))
    }

    /// Mounts `layer` on `host`, view `id` (`None`: it shows nothing of
    /// its own). `children` holds the children an effect or a transition
    /// draws (the root's, for a screen's).
    pub(crate) fn set(
        &mut self,
        id: NodeId,
        host: &UIView,
        children: Option<Retained<UIView>>,
        style: &ViewStyle,
        scale: CGFloat,
        layer: Option<Arc<ShaderLayer>>,
    ) {
        let Some(layer) = layer else {
            self.remove(id);
            return;
        };
        self.renderer
            .get_or_init(|| Renderer::new(PixelFormat::Rgba));
        if self
            .views
            .get(&id)
            .is_some_and(|s| *s.host != *host || s.role != layer.role)
        {
            self.remove(id);
        }
        let role = layer.role;
        let state = self.views.entry(id).or_insert_with(|| {
            let shown = CALayer::new();
            shown.setZPosition(if role == ShaderRole::Fill {
                SHADER_Z
            } else {
                OVER
            });
            // SAFETY: an immutable Core Animation constant.
            shown.setContentsGravity(unsafe { kCAGravityResize });
            host.layer().addSublayer(&shown);
            ShaderState {
                host: host.retain(),
                layer: shown,
                mask: None,
                view: surface_view(),
                role,
                children: None,
                scale,
                stale: false,
                backdrop_stale: false,
                masked: false,
                canvas: None,
                backdrop_canvas: None,
            }
        });
        let inputs = layer.shader.inputs();
        let before = std::mem::replace(&mut state.children, children);
        state.stale = role != ShaderRole::Fill;
        state.backdrop_stale = inputs.contains(ShaderInput::Backdrop);
        state.view.set_layer(Some(layer));
        state.layout(style, scale);
        // An effect always shows its frames, a transition while it runs (a
        // new layer mid-run too); without a device, the children.
        let changed = state.update_masked(&self.renderer, Instant::now());
        let children = state.children.clone();
        // What it drew before shows again, unless another shader hides it.
        if let Some(before) = before.filter(|b| children.as_deref() != Some(&**b)) {
            self.sync_mask(&before);
        }
        if changed && let Some(children) = &children {
            self.sync_mask(children);
        }
        self.wake();
    }

    /// The core says what shader view `id` reads changed
    /// ([`nsh_core::MountItem::ShaderInput`]): its pictures are taken again
    /// on the next tick.
    pub(crate) fn input_changed(&mut self, id: NodeId) {
        if let Some(s) = self.views.get_mut(&id) {
            s.mark(true);
            self.wake();
        }
    }

    /// The mounter changed `view` (an animated value, a scroll, an image
    /// that loaded): the effects around it, and every backdrop, take their
    /// pictures again.
    pub(crate) fn ui_changed(&mut self, view: &UIView) {
        let mut marked = false;
        for s in self.views.values_mut() {
            // Only a shader that reads them pictures its children (the
            // whole root, for a screen's) or its backdrop again.
            let reads = s.reads_children() || s.reads(ShaderInput::Backdrop);
            if !reads || *s.host == *view {
                continue;
            }
            let inside = is_screen(s.role) || view.isDescendantOfView(&s.host);
            s.mark(inside);
            marked = true;
        }
        if marked {
            self.wake();
        }
    }

    /// Whether some shader reads pictures ([`Shaders::ui_changed`] has
    /// something to do).
    pub(crate) fn pictured(&self) -> bool {
        self.views
            .values()
            .any(|s| s.reads_children() || s.reads(ShaderInput::Backdrop))
    }

    /// A transition starts ([`nsh_core::MountItem::ShaderTransition`],
    /// before the rest of its batch): the children as they show now (or
    /// the running transition's frame) are its `from`.
    pub(crate) fn start_transition(&mut self, id: NodeId, duration: std::time::Duration) {
        let Some(Some(renderer)) = self.renderer.get() else {
            return;
        };
        let Some(s) = self.views.get_mut(&id) else {
            return;
        };
        // The running transition's frame (copied on the GPU), or the
        // children.
        let from_frame = s.masked && s.view.set_input_from_frame(renderer, ShaderInput::From);
        let from = if from_frame {
            None
        } else {
            children_picture(&mut s.canvas, &s.children, &s.host, &s.view, s.scale)
        };
        if let Some(from) = from {
            s.view.set_input(renderer, ShaderInput::From, Some(from));
        }
        let now = Instant::now();
        s.view.start_transition(duration, now);
        s.stale = true;
        let changed = s
            .update_masked(&self.renderer, now)
            .then(|| s.children.clone())
            .flatten();
        if let Some(children) = changed {
            self.sync_mask(&children);
        }
        self.wake();
    }

    /// Starts drawing a page's or a dialog's coming or going through
    /// `shader` over `rect` of `host` (the window), as it shows now: the
    /// change happens after, at once ([`NavOverlay`]). `key` is what it
    /// changes, a stack or the surface (`ROOT_ID`, a dialog): one of the
    /// same key that still runs ends first, so the new one's pictures do
    /// not hold its frames. Whether it does: where there is no GPU device,
    /// or nothing to picture, the change keeps its own motion.
    pub(crate) fn nav_overlay(
        &mut self,
        key: NodeId,
        host: &UIView,
        rect: CGRect,
        scale: CGFloat,
        shader: &nsh_core::NavShader,
        backwards: bool,
    ) -> bool {
        if self
            .renderer
            .get_or_init(|| Renderer::new(PixelFormat::Rgba))
            .is_none()
        {
            return false;
        }
        self.overlays.retain(|o| o.key != key);
        let others: Vec<Retained<CALayer>> =
            self.overlays.iter().map(|o| o.layer.clone()).collect();
        let held = self
            .held
            .iter()
            .position(|h| h.key == key)
            .map(|i| self.held.swap_remove(i))
            .filter(|h| h.rect == rect)
            .map(|h| h.pixels);
        let Some(overlay) =
            NavOverlay::new(key, host, rect, scale, shader, backwards, &others, held)
        else {
            return false;
        };
        self.overlays.push(overlay);
        self.wake();
        true
    }

    /// Pictures `rect` of `host` (the window) as it shows now, every
    /// overlay left out, for a page or a dialog of `key` (as
    /// [`Shaders::nav_overlay`]'s) that leaves through its shader in this
    /// batch: the views it showed go before the change is made (the app
    /// removed and released them), so the picture before it is taken now.
    /// The first picture held for `key` stays until the change uses it.
    pub(crate) fn hold(&mut self, key: NodeId, host: &UIView, rect: CGRect, scale: CGFloat) {
        if self.held.iter().any(|h| h.key == key)
            || self
                .renderer
                .get_or_init(|| Renderer::new(PixelFormat::Rgba))
                .is_none()
        {
            return;
        }
        let Some((pw, ph)) = picture_size(rect.size.width, rect.size.height, scale) else {
            return;
        };
        let layers: Vec<Retained<CALayer>> =
            self.overlays.iter().map(|o| o.layer.clone()).collect();
        let pixels = without(&layers, || {
            render(&host.layer(), (rect.origin.x, rect.origin.y), pw, ph, scale)
        });
        self.held.push(Held { key, rect, pixels });
    }

    /// Lets go of the pictures [`Shaders::hold`] took that no change used,
    /// but those of the keys `keep` keeps (a stack whose change waits for
    /// UIKit's transition to end).
    pub(crate) fn release_held(&mut self, keep: impl Fn(NodeId) -> bool) {
        self.held.retain(|h| keep(h.key));
    }

    /// Views may be back in a window (a page shown again, the surface
    /// moved): the link runs if a picture or a frame is due.
    pub(crate) fn revisit(&mut self) {
        self.wake();
    }

    /// The values of the animated slots of shader view `id`.
    pub(crate) fn set_args(
        &mut self,
        id: NodeId,
        values: impl IntoIterator<Item = (u16, AnimationValue)>,
    ) {
        let Some(state) = self.views.get_mut(&id) else {
            return;
        };
        for (slot, value) in values {
            state.view.set_slot(slot, value);
        }
        self.wake();
    }

    /// Shader view `id` was resized or restyled: the layer follows its
    /// box and a frame of the new size is rendered.
    pub(crate) fn layout(&mut self, id: NodeId, style: &ViewStyle, scale: CGFloat) {
        if let Some(state) = self.views.get_mut(&id) {
            state.layout(style, scale);
            self.wake();
        }
    }

    /// The screen's scale changed: every shader renders again at `scale`.
    pub(crate) fn rescale(&mut self, scale: CGFloat) {
        if self.views.is_empty() {
            return;
        }
        for state in self.views.values_mut() {
            state.scale = scale;
            state.layer.setContentsScale(scale);
            let bounds = state.host.bounds().size;
            state.view.set_size(
                size(Points(bounds.width as f32), Points(bounds.height as f32)),
                scale as f32,
            );
        }
        self.wake();
    }

    /// View `id` is deleted (or shows no shader any more). A screen
    /// effect's or transition's frames, on the root rather than in the
    /// view, leave with it.
    pub(crate) fn remove(&mut self, id: NodeId) {
        if let Some(state) = self.views.remove(&id) {
            state.layer.removeFromSuperlayer();
            // What it drew shows again, unless another shader (a screen
            // one, over the same root) hides it.
            if let Some(children) = &state.children {
                self.sync_mask(children);
            }
            self.wake();
        }
    }

    /// Masks `children` while a shader drawing them hides them
    /// ([`ShaderState::masked`]): its own, or any of the surface's screen
    /// effects and transitions, which share the root's.
    fn sync_mask(&self, children: &UIView) {
        let masked = self
            .views
            .values()
            .any(|s| s.masked && s.children.as_deref().is_some_and(|c| c == children));
        let layer = children.layer();
        if layer.mask().is_some() == masked {
            return;
        }
        let mask = masked.then(CALayer::new);
        // SAFETY: a fresh, empty mask layer owned by the children's layer
        // (or none).
        quiet(|| unsafe { layer.setMask(mask.as_deref()) });
    }

    /// A tick of the display link: renders what is due, shows the frames
    /// that came back, and pauses the link once nothing is left to do.
    pub(crate) fn frame(&mut self) {
        let Some(Some(renderer)) = self.renderer.get() else {
            self.set_running(false);
            return;
        };
        let now = Instant::now();
        let mut wants = false;
        let mut masks = Vec::new();
        for state in self.views.values_mut() {
            if !state.due() {
                continue;
            }
            // Out of every window: rendered once it is back in one, which
            // wakes the link ([`Shaders::revisit`]); its pictures stay due.
            if state.host.window().is_none() {
                wants |= state.view.wants_frame();
                continue;
            }
            state.take_pictures(renderer, now);
            if state.view.render(renderer, now) {
                state.show();
            }
            // A transition that ended: its children show as they are
            // (unless a screen effect still hides the root's).
            if matches!(
                state.role,
                ShaderRole::Transition | ShaderRole::ScreenTransition
            ) && state.masked
                && !state.view.replaces_children(now)
            {
                // SAFETY: clearing the contents.
                quiet(|| unsafe { state.layer.setContents(None) });
            }
            if state.update_masked(&self.renderer, now)
                && let Some(children) = &state.children
            {
                masks.push(children.clone());
            }
            wants |= state.due();
        }
        for children in masks {
            self.sync_mask(&children);
        }
        let layers: Vec<Retained<CALayer>> =
            self.overlays.iter().map(|o| o.layer.clone()).collect();
        self.overlays.retain_mut(|o| o.tick(renderer, now, &layers));
        wants |= !self.overlays.is_empty();
        self.set_running(wants);
    }

    /// Runs the link if some shader view has a frame to render.
    fn wake(&mut self) {
        let wants = matches!(self.renderer.get(), Some(Some(_)))
            && (self.views.values().any(ShaderState::due) || !self.overlays.is_empty());
        self.set_running(wants);
    }

    fn set_running(&mut self, running: bool) {
        if running != self.running {
            self.running = running;
            self.link.setPaused(!running);
        }
    }
}

impl Drop for Shaders {
    fn drop(&mut self) {
        // The link retains its target; invalidating breaks the cycle.
        self.link.invalidate();
        for state in self.views.values() {
            state.layer.removeFromSuperlayer();
        }
        // The overlays leave the window (which the next app keeps) as
        // they drop.
        self.overlays.clear();
    }
}

impl ShaderState {
    /// It has a frame to render or a picture to take.
    fn due(&self) -> bool {
        self.view.wants_frame() || self.stale || self.backdrop_stale
    }

    /// Whether its program reads the children it draws (an effect's
    /// `sample_content`, a transition's `sample_to`): only then are they
    /// pictured again when they change.
    fn reads_children(&self) -> bool {
        reads_children(self.role, &self.view)
    }

    /// Whether its shader reads `input`.
    fn reads(&self, input: ShaderInput) -> bool {
        self.view
            .layer()
            .is_some_and(|l| l.shader.inputs().contains(input))
    }

    /// Marks its pictures due: the children's if `inside`, the backdrop's
    /// if it reads it.
    fn mark(&mut self, inside: bool) {
        self.stale |= inside && self.reads_children();
        self.backdrop_stale |= self.reads(ShaderInput::Backdrop);
    }

    /// Whether its children are hidden follows its role and the device
    /// in `renderer` ([`hides`]); whether that changed (their mask
    /// follows: [`Shaders::sync_mask`]).
    fn update_masked(&mut self, renderer: &OnceCell<Option<Renderer>>, now: Instant) -> bool {
        let masked = self.children.is_some() && hides(&mut self.view, renderer, now);
        std::mem::replace(&mut self.masked, masked) != masked
    }

    /// Takes the pictures it is due.
    fn take_pictures(&mut self, renderer: &Renderer, now: Instant) {
        // An idle transition draws nothing: its children show.
        let running = match self.role {
            ShaderRole::Transition | ShaderRole::ScreenTransition => {
                self.view.replaces_children(now)
            }
            _ => true,
        };
        let stale = std::mem::take(&mut self.stale) && running;
        let backdrop = std::mem::take(&mut self.backdrop_stale);
        if stale
            && let Some(picture) = children_picture(
                &mut self.canvas,
                &self.children,
                &self.host,
                &self.view,
                self.scale,
            )
        {
            let input = match self.role {
                ShaderRole::Transition | ShaderRole::ScreenTransition => ShaderInput::To,
                _ => ShaderInput::Content,
            };
            self.view.set_input(renderer, input, Some(picture));
        }
        if backdrop && let Some(window) = self.host.window() {
            // What is behind: the window without the view (and what it
            // holds), where the view is.
            let o = self.view.overflow().0 as f64;
            let at = self
                .host
                .convertRect_toView(self.host.bounds(), Some(&window));
            let Some((pw, ph)) = picture_size(
                at.size.width + 2.0 * o,
                at.size.height + 2.0 * o,
                self.scale,
            ) else {
                return;
            };
            let Some(canvas) = Canvas::of(&mut self.backdrop_canvas, (pw, ph, self.scale)) else {
                return;
            };
            let layer = self.host.layer();
            let picture = quiet(|| {
                let opacity = layer.opacity();
                layer.setOpacity(0.0);
                let origin = (at.origin.x - o, at.origin.y - o);
                let picture = canvas.render(&window.layer(), origin);
                layer.setOpacity(opacity);
                picture
            });
            self.view
                .set_input(renderer, ShaderInput::Backdrop, Some(picture));
        }
    }

    /// Frames the layer over the host's bounds, clips it to the rounded
    /// box of `style`, and tells the shader its size at `scale`.
    fn layout(&mut self, style: &ViewStyle, scale: CGFloat) {
        let bounds = self.host.bounds().size;
        let (w, h) = (bounds.width as f32, bounds.height as f32);
        self.scale = scale;
        if self.role != ShaderRole::Fill {
            // Over the box, `overflow` points beyond it.
            let o = self.view.overflow().0 as CGFloat;
            quiet(|| {
                self.layer.setFrame(CGRect::new(
                    CGPoint::new(-o, -o),
                    CGSize::new(bounds.width + 2.0 * o, bounds.height + 2.0 * o),
                ));
                self.layer.setContentsScale(scale);
            });
            self.view.set_size(size(Points(w), Points(h)), scale as f32);
            return;
        }
        let local = CGRect::new(CGPoint::ZERO, bounds);
        let raw = style.radii();
        quiet(|| {
            self.layer.setFrame(local);
            self.layer.setContentsScale(scale);
            match raw.shared() {
                // One radius: the layer's own corners clip it.
                Some(r) => {
                    let half = w.min(h).max(0.0) / 2.0;
                    let r = if w > 0.0 && h > 0.0 {
                        r.0.min(half)
                    } else {
                        r.0
                    };
                    set_corners(&self.layer, r as CGFloat, corner_mask(&raw), raw.continuous);
                    self.layer.setMasksToBounds(true);
                    // SAFETY: clearing the mask.
                    unsafe { self.layer.setMask(None) };
                    self.mask = None;
                }
                // Different radii: a shape of them.
                None => {
                    set_corners(&self.layer, 0.0, corner_mask(&raw), raw.continuous);
                    self.layer.setMasksToBounds(false);
                    let mask = self.mask.get_or_insert_with(CAShapeLayer::new).clone();
                    mask.setFrame(local);
                    mask.setPath(Some(&rounded(local, raw.fit(size(px(w), px(h))))));
                    // SAFETY: a mask layer owned by this state.
                    unsafe { self.layer.setMask(Some(&mask)) };
                }
            }
        });
        self.view.set_size(size(Points(w), Points(h)), scale as f32);
    }

    /// Shows the last frame collected.
    fn show(&self) {
        display_frame(&self.layer, &self.view);
    }
}

/// A shader view whose frames go to IOSurfaces ([`display_frame`]).
fn surface_view() -> ShaderView {
    let mut view = ShaderView::default();
    view.show_on_surfaces();
    view
}

/// Shows `view`'s last frame in `layer`: its IOSurface, which the render
/// server shows as it is and matches from sRGB to the display on the GPU;
/// else (no Metal device, or one that makes no IOSurface textures) the
/// pixels read back, as a CGImage, whose colours Core Animation matches on
/// the main thread.
fn display_frame(layer: &CALayer, view: &ShaderView) {
    match view.surface() {
        Some(surface) => quiet(|| {
            // SAFETY: an IOSurfaceRef is an Objective-C object (`IOSurface`,
            // toll-free bridged), a valid `contents` object.
            unsafe {
                layer.setContents(Some(
                    &*(surface as *const objc2_io_surface::IOSurfaceRef as *const AnyObject),
                ))
            }
        }),
        None => set_image(layer, rgba_image(view.frame()).as_deref()),
    }
}

/// A CGImage of the frame's premultiplied sRGB RGBA pixels (`None` for an
/// empty frame).
fn rgba_image(frame: &Frame) -> Option<CFRetained<CGImage>> {
    rows_image(frame.width as usize, frame.height as usize, frame.rows())
}

/// A CGImage of `height` rows of `width` premultiplied sRGB RGBA pixels
/// (`None` when it is empty).
fn rows_image<'a>(
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
    // context of these dimensions; the rows are copied within
    // `bytes_per_row * height` bytes while `context` lives.
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
            let n = src.len().min(width * 4);
            pixels[row * stride..row * stride + n].copy_from_slice(&src[..n]);
        }
        CGBitmapContextCreateImage(Some(&context))
    }
}

/// Sets `layer`'s contents to `image` (`None` clears them).
fn set_image(layer: &CALayer, image: Option<&CGImage>) {
    quiet(|| {
        // SAFETY: a CGImage is a valid `contents` object; `None` clears
        // them.
        unsafe { layer.setContents(image.map(|cg| &*(cg as *const CGImage as *const AnyObject))) }
    });
}

/// Whether `view`'s program reads the children a shader of `role` draws
/// ([`ShaderState::reads_children`]).
fn reads_children(role: ShaderRole, view: &ShaderView) -> bool {
    let inputs = view.layer().map(|l| l.shader.inputs()).unwrap_or_default();
    match role {
        ShaderRole::Fill => false,
        ShaderRole::Transition | ShaderRole::ScreenTransition => inputs.contains(ShaderInput::To),
        _ => inputs.contains(ShaderInput::Content),
    }
}

fn is_screen(role: ShaderRole) -> bool {
    matches!(role, ShaderRole::Screen | ShaderRole::ScreenTransition)
}

/// The size in pixels of a picture of `w` × `h` points at `scale` (at most
/// as large as the renderer draws).
fn picture_size(w: CGFloat, h: CGFloat, scale: CGFloat) -> Option<(usize, usize)> {
    if w <= 0.0 || h <= 0.0 {
        return None;
    }
    let scale = scale.min(nsh_engine::shader::MAX_SIDE as CGFloat / w.max(h));
    Some((
        (w * scale).round().max(1.0) as usize,
        (h * scale).round().max(1.0) as usize,
    ))
}

/// Draws the layers of `layer`'s tree that are due to draw: `renderInContext:`
/// takes their contents as they are.
fn display_tree(layer: &CALayer) {
    layer.displayIfNeeded();
    // SAFETY: a getter; the sublayers are retained while they are drawn.
    if let Some(sublayers) = unsafe { layer.sublayers() } {
        for sublayer in sublayers.iter() {
            display_tree(&sublayer);
        }
    }
}

/// The children (without the mask that hides them) of a shader view on
/// `host`, the box grown by its overflow, drawn into `canvas`.
fn children_picture<'a>(
    canvas: &'a mut Option<Canvas>,
    children: &Option<Retained<UIView>>,
    host: &UIView,
    view: &ShaderView,
    scale: CGFloat,
) -> Option<Pixels<'a>> {
    let children = children.as_ref()?;
    let o = view.overflow().0 as f64;
    let b = host.bounds().size;
    let (pw, ph) = picture_size(b.width + 2.0 * o, b.height + 2.0 * o, scale)?;
    let canvas = Canvas::of(canvas, (pw, ph, scale))?;
    let layer = children.layer();
    Some(quiet(|| {
        let mask = layer.mask();
        // SAFETY: clearing and restoring the view's own mask.
        unsafe { layer.setMask(None) };
        let picture = canvas.render(&layer, (-o, -o));
        // SAFETY: the view's own mask, cleared above, set back.
        unsafe { layer.setMask(mask.as_deref()) };
        picture
    }))
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

    /// `layer` rendered with its point `origin` at the top-left, top row
    /// first, over what it drew before (cleared first).
    fn render(&mut self, layer: &CALayer, origin: (CGFloat, CGFloat)) -> Pixels<'_> {
        use objc2_core_graphics::{
            CGBitmapContextGetBytesPerRow, CGBitmapContextGetData, CGContext,
        };
        display_tree(layer);
        let (pw, ph, scale) = self.size;
        let context = &self.context;
        CGContext::clear_rect(
            Some(context),
            CGRect::new(CGPoint::ZERO, CGSize::new(pw as CGFloat, ph as CGFloat)),
        );
        CGContext::save_g_state(Some(context));
        // UIKit's layers draw y down.
        CGContext::translate_ctm(Some(context), 0.0, ph as CGFloat);
        CGContext::scale_ctm(Some(context), scale, -scale);
        CGContext::translate_ctm(Some(context), -origin.0, -origin.1);
        // The layer is rendered on the main thread, which owns it.
        layer.renderInContext(context);
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

/// `layer` rendered into premultiplied RGBA of `pw` × `ph` pixels, top row
/// first: its point `origin` at the top-left.
fn render(
    layer: &CALayer,
    origin: (CGFloat, CGFloat),
    pw: usize,
    ph: usize,
    scale: CGFloat,
) -> Vec<u8> {
    use objc2_core_graphics::{
        CGBitmapContextCreate, CGColorSpace, CGContext, CGImageAlphaInfo, CGImageByteOrderInfo,
        kCGColorSpaceSRGB,
    };
    display_tree(layer);
    let mut out = vec![0u8; pw * ph * 4];
    // SAFETY: `out` holds `pw * 4 * ph` bytes and outlives the context; the
    // layer is rendered on the main thread, which owns it.
    unsafe {
        let Some(space) = CGColorSpace::with_name(Some(kCGColorSpaceSRGB)) else {
            return out;
        };
        let Some(context) = CGBitmapContextCreate(
            out.as_mut_ptr().cast(),
            pw,
            ph,
            8,
            pw * 4,
            Some(&space),
            CGImageAlphaInfo::PremultipliedLast.0 | CGImageByteOrderInfo::Order32Big.0,
        ) else {
            return out;
        };
        // UIKit's layers draw y down.
        CGContext::translate_ctm(Some(&context), 0.0, ph as CGFloat);
        CGContext::scale_ctm(Some(&context), scale, -scale);
        CGContext::translate_ctm(Some(&context), -origin.0, -origin.1);
        layer.renderInContext(&context);
    }
    out
}

/// A picture of `rect` of the window taken before a change of `key`
/// ([`Shaders::hold`]).
struct Held {
    key: NodeId,
    rect: CGRect,
    pixels: Vec<u8>,
}

/// A page's or a dialog's coming or going drawn through its
/// `transitionShader` ([`nsh_core::NavShader`]): a layer over `rect` of
/// `host` (the window) showing the shader's frames, which read the lower
/// side as `from` and the upper as `to`. It pictures `rect` before the
/// change and, on the first tick, after it; going away (the upper side is
/// the one before) runs backwards. It stays until the frames on their way
/// when the run ends have shown.
struct NavOverlay {
    /// What it changes: a stack, or the surface (`ROOT_ID`) for a dialog.
    key: NodeId,
    view: ShaderView,
    layer: Retained<CALayer>,
    host: Retained<UIView>,
    rect: CGRect,
    scale: CGFloat,
    /// The picture before the change.
    before: Option<Vec<u8>>,
    size: (usize, usize),
    duration: std::time::Duration,
    backwards: bool,
}

impl NavOverlay {
    /// Pictures `rect` of `host` as it shows now, the other overlays
    /// (`others`, of other stacks) left out, unless `held` is that picture.
    #[allow(clippy::too_many_arguments)]
    fn new(
        key: NodeId,
        host: &UIView,
        rect: CGRect,
        scale: CGFloat,
        shader: &nsh_core::NavShader,
        backwards: bool,
        others: &[Retained<CALayer>],
        held: Option<Vec<u8>>,
    ) -> Option<NavOverlay> {
        let (pw, ph) = picture_size(rect.size.width, rect.size.height, scale)?;
        let before = held.filter(|p| p.len() == pw * ph * 4).unwrap_or_else(|| {
            without(others, || {
                render(&host.layer(), (rect.origin.x, rect.origin.y), pw, ph, scale)
            })
        });
        let layer = CALayer::new();
        // SAFETY: an immutable Core Animation constant.
        layer.setContentsGravity(unsafe { kCAGravityResize });
        layer.setZPosition(OVER);
        let image = rows_image(pw, ph, before.chunks(pw * 4));
        quiet(|| {
            layer.setFrame(rect);
            host.layer().addSublayer(&layer);
        });
        // Until the first frame comes back: what showed.
        set_image(&layer, image.as_deref());
        let mut view = surface_view();
        view.set_layer(Some(shader.layer.clone()));
        view.set_size(
            size(
                Points(rect.size.width as f32),
                Points(rect.size.height as f32),
            ),
            scale as f32,
        );
        Some(NavOverlay {
            key,
            view,
            layer,
            host: host.retain(),
            rect,
            scale,
            before: Some(before),
            size: (pw, ph),
            duration: shader.duration,
            backwards,
        })
    }

    /// One tick: on the first, pictures the change (every overlay, `layers`,
    /// left out) and starts; renders and shows the frames, and once the run
    /// ended only those still on their way. Whether it is still needed.
    fn tick(&mut self, renderer: &Renderer, now: Instant, layers: &[Retained<CALayer>]) -> bool {
        if let Some(before) = self.before.take() {
            let (pw, ph) = self.size;
            // What the change put in the window is laid out before it is
            // pictured (a dialog UIKit just presented, the screen it put in
            // the stack).
            self.host.layoutIfNeeded();
            let after = without(layers, || {
                render(
                    &self.host.layer(),
                    (self.rect.origin.x, self.rect.origin.y),
                    pw,
                    ph,
                    self.scale,
                )
            });
            let (from, to) = if self.backwards {
                (after, before)
            } else {
                (before, after)
            };
            let stride = pw as u32 * 4;
            let (w, h) = (pw as u32, ph as u32);
            self.view
                .set_input(renderer, ShaderInput::From, Some((&from, w, h, stride)));
            self.view
                .set_input(renderer, ShaderInput::To, Some((&to, w, h, stride)));
            if self.backwards {
                self.view.start_transition_backwards(self.duration, now);
            } else {
                self.view.start_transition(self.duration, now);
            }
        }
        let running = self.view.transitioning(now);
        // Past its end the run renders nothing more (a program reading
        // `nsh.time` would draw on), and the frames still coming back show.
        let shown = if running {
            self.view.render(renderer, now)
        } else {
            self.view.collect_frame(renderer)
        };
        if shown {
            display_frame(&self.layer, &self.view);
        }
        // A frame shown on this tick is on screen at the next.
        running || shown || self.view.pending()
    }
}

impl Drop for NavOverlay {
    fn drop(&mut self) {
        quiet(|| self.layer.removeFromSuperlayer());
    }
}

/// Runs `draw` with `layers` hidden.
fn without<R>(layers: &[Retained<CALayer>], draw: impl FnOnce() -> R) -> R {
    quiet(|| {
        let shown: Vec<&Retained<CALayer>> = layers.iter().filter(|l| !l.isHidden()).collect();
        shown.iter().for_each(|l| l.setHidden(true));
        let out = draw();
        shown.iter().for_each(|l| l.setHidden(false));
        out
    })
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use nsh_core::shader::Shader;

    use super::*;

    /// A shader view showing a layer of `role`.
    fn view(role: ShaderRole) -> ShaderView {
        let shader =
            Shader::compile("fn shade(uv: vec2f) -> vec4f { return vec4f(uv, 0.0, 1.0); }")
                .expect("a shader");
        let mut layer = ShaderLayer::new(shader, &[], &mut Vec::new());
        layer.role = role;
        let mut view = ShaderView::default();
        view.set_layer(Some(Arc::new(layer)));
        view
    }

    #[test]
    fn a_frame_on_a_surface_shows_and_draws_in_pictures() {
        use objc2_core_graphics::{
            CGBitmapContextCreate, CGBitmapContextGetData, CGColorSpace, CGImageAlphaInfo,
            CGImageByteOrderInfo, kCGColorSpaceSRGB,
        };
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
        view.set_size(size(Points(4.0), Points(4.0)), 1.0);
        let start = Instant::now();
        while !view.render(&renderer, Instant::now()) {
            assert!(start.elapsed() < Duration::from_secs(5), "no frame");
        }
        if view.surface().is_none() {
            eprintln!("no IOSurface textures on this device: read back");
            return;
        }
        let layer = CALayer::new();
        layer.setFrame(CGRect::new(CGPoint::new(0.0, 0.0), CGSize::new(4.0, 4.0)));
        display_frame(&layer, &view);
        // SAFETY: reading the contents the line above set.
        assert!(
            unsafe { layer.contents() }.is_some(),
            "the surface is the contents"
        );
        // SAFETY: a 4 × 4 RGBA context CoreGraphics allocates, read while
        // it lives.
        unsafe {
            let space = CGColorSpace::with_name(Some(kCGColorSpaceSRGB)).unwrap();
            let context = CGBitmapContextCreate(
                std::ptr::null_mut(),
                4,
                4,
                8,
                16,
                Some(&space),
                CGImageAlphaInfo::PremultipliedLast.0 | CGImageByteOrderInfo::Order32Big.0,
            )
            .unwrap();
            layer.renderInContext(&context);
            let data = CGBitmapContextGetData(Some(&context)).cast::<u8>();
            let pixel = std::slice::from_raw_parts(data, 4);
            assert_eq!(pixel, [255, 0, 0, 255], "the frame is in the picture");
        }
    }

    #[test]
    fn without_a_device_nothing_hides_its_children() {
        // Looked for, and not found.
        let renderer = OnceCell::from(None);
        let now = Instant::now();
        for role in [ShaderRole::Effect, ShaderRole::Screen] {
            assert!(!hides(&mut view(role), &renderer, now), "{role:?}");
        }
        for role in [ShaderRole::Transition, ShaderRole::ScreenTransition] {
            let mut v = view(role);
            v.start_transition(Duration::from_millis(300), now);
            assert!(!hides(&mut v, &renderer, now), "{role:?}");
        }
    }

    #[test]
    fn an_effect_hides_its_children_and_a_transition_while_it_runs() {
        let renderer = OnceCell::from(Renderer::new(PixelFormat::Rgba));
        if matches!(renderer.get(), Some(None)) {
            eprintln!("no GPU: skipped");
            return;
        }
        let now = Instant::now();
        for role in [ShaderRole::Effect, ShaderRole::Screen] {
            let mut v = view(role);
            assert!(hides(&mut v, &renderer, now), "{role:?}");
            // It shows nothing of its own any more.
            v.set_layer(None);
            assert!(!hides(&mut v, &renderer, now), "{role:?}");
        }
        let duration = Duration::from_millis(300);
        for role in [ShaderRole::Transition, ShaderRole::ScreenTransition] {
            let mut v = view(role);
            assert!(!hides(&mut v, &renderer, now), "{role:?}: idle");
            v.start_transition(duration, now);
            assert!(hides(&mut v, &renderer, now), "{role:?}");
            // A new layer while it runs (another uniform) keeps them hidden.
            let layer = v.layer().cloned();
            v.set_layer(layer);
            assert!(hides(&mut v, &renderer, now), "{role:?}: a new layer");
            assert!(!hides(&mut v, &renderer, now + duration), "{role:?}: ended");
        }
        assert!(!hides(&mut view(ShaderRole::Fill), &renderer, now));
    }

    /// A view of `role` drawing with `source`'s `shade`.
    fn reading(role: ShaderRole, source: &str) -> ShaderView {
        let mut layer = ShaderLayer::new(
            Shader::compile(source).expect("a shader"),
            &[],
            &mut Vec::new(),
        );
        layer.role = role;
        let mut view = ShaderView::default();
        view.set_layer(Some(Arc::new(layer)));
        view
    }

    #[test]
    fn only_a_shader_that_reads_its_children_pictures_them_again() {
        let plain = "fn shade(uv: vec2f) -> vec4f { return vec4f(uv, 0.0, 1.0); }";
        let content = "fn shade(uv: vec2f) -> vec4f { return sample_content(uv); }";
        let to = "fn shade(uv: vec2f) -> vec4f { return sample_to(uv); }";
        for role in [ShaderRole::Effect, ShaderRole::Screen] {
            assert!(!reads_children(role, &reading(role, plain)), "{role:?}");
            assert!(reads_children(role, &reading(role, content)), "{role:?}");
        }
        for role in [ShaderRole::Transition, ShaderRole::ScreenTransition] {
            assert!(!reads_children(role, &reading(role, plain)), "{role:?}");
            assert!(reads_children(role, &reading(role, to)), "{role:?}");
        }
        let fill = ShaderRole::Fill;
        assert!(!reads_children(fill, &reading(fill, content)));
    }

    #[test]
    fn pictures_of_one_size_draw_into_the_same_canvas() {
        use objc2_core_graphics::CGBitmapContextGetData;
        let mut slot = None;
        let size = (8, 4, 2.0);
        let first = CGBitmapContextGetData(Some(&Canvas::of(&mut slot, size).unwrap().context));
        let again = CGBitmapContextGetData(Some(&Canvas::of(&mut slot, size).unwrap().context));
        assert_eq!(first, again, "kept");
        let canvas = Canvas::of(&mut slot, (16, 4, 2.0)).unwrap();
        assert_eq!(canvas.size, (16, 4, 2.0), "made again for another size");
        let red = CALayer::new();
        red.setFrame(CGRect::new(CGPoint::ZERO, CGSize::new(1.0, 1.0)));
        let color = objc2_core_graphics::CGColor::new_srgb(1.0, 0.0, 0.0, 1.0);
        red.setBackgroundColor(Some(&color));
        let (pixels, w, h, stride) = canvas.render(&red, (0.0, 0.0));
        assert_eq!((w, h), (16, 4));
        assert!(stride >= 64);
        assert_eq!(&pixels[..4], &[255, 0, 0, 255], "the layer, top-left");
        // What it drew before is cleared.
        let (pixels, ..) = canvas.render(&CALayer::new(), (0.0, 0.0));
        assert!(pixels.iter().all(|&b| b == 0));
    }

    #[test]
    fn a_picture_leaves_the_other_overlays_out_and_shows_them_after() {
        let (a, b) = (CALayer::new(), CALayer::new());
        b.setHidden(true);
        let layers = [a.clone(), b.clone()];
        let hidden = without(&layers, || (a.isHidden(), b.isHidden()));
        assert_eq!(hidden, (true, true));
        assert!(!a.isHidden(), "shown again");
        assert!(b.isHidden(), "one hidden before stays hidden");
    }
}
