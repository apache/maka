//! GPU views: views whose box a renderer of the app's own draws with wgpu
//! ([`nsh_core::gpu`], `MountItem::GpuView`), on the surface's render
//! thread (`nsh_engine::gpu`), shown in a sublayer under the children.
//!
//! The mounter keeps one [`SurfaceGpu`] (its [`GpuViews`] made with the
//! first GPU view, which starts the render thread). Each view's frames go
//! to IOSurfaces that become its layer's `contents` as they are, clipped
//! to its rounded box as a shader's are ([`crate::decor::clip_to_box`]);
//! where the device makes no IOSurface textures, the frames read back
//! show as CGImages. While any view wants a frame, a display link of its
//! own (at the screen's full rate, 120 Hz on ProMotion) asks for the frames
//! due at each view's size and the screen's scale and shows those done; it
//! pauses once none does. A view outside any window renders nothing until
//! it is back in one ([`SurfaceGpu::reveal`]). The renderers' events reach
//! the app as the views' `NativeEvent`s.

use std::sync::Arc;

use nsh_core::{
    EventKind, EventPayload, JsonValue, NodeId, ViewStyle,
    animation::{AnimationProp, NodeId as AnimationNode},
    geometry::{Points, size},
    gpu::GpuSource,
};
use nsh_engine::{EngineControl, gpu::GpuViews, shader::PixelFormat};
use objc2::{Message, rc::Retained, sel};
use objc2_core_foundation::CGFloat;
use objc2_foundation::{NSRunLoop, NSRunLoopCommonModes};
use objc2_quartz_core::{CADisplayLink, CALayer, CAShapeLayer};
use objc2_ui_kit::UIView;
use rustc_hash::FxHashMap;

use crate::{
    animation::Animator,
    component::BoundProps,
    decor::{clip_to_box, quiet},
    shader::{SHADER_Z, frames_layer, show_pixels, show_surface},
    target::EventTarget,
};

/// What a GPU view shows.
struct GpuState {
    /// The view the renderer draws in.
    host: Retained<UIView>,
    /// Shows the frames, clipped to the host's rounded box.
    layer: Retained<CALayer>,
    /// Clips [`GpuState::layer`] to corners of different radii.
    mask: Option<Retained<CAShapeLayer>>,
    /// Its renderer's animated props.
    bound: BoundProps,
}

/// The surface's GPU views, and the display link that runs while one
/// wants a frame.
pub(crate) struct SurfaceGpu {
    views: Option<GpuViews>,
    shown: FxHashMap<NodeId, GpuState>,
    /// The screen's pixels per point.
    scale: CGFloat,
    link: Retained<CADisplayLink>,
    /// The link is unpaused.
    ticking: bool,
}

impl SurfaceGpu {
    pub(crate) fn new(target: &EventTarget) -> Self {
        // SAFETY: `gpuFrame:` is implemented by `EventTarget`, which
        // outlives the link (it is invalidated in `Drop`).
        let link =
            unsafe { CADisplayLink::displayLinkWithTarget_selector(target, sel!(gpuFrame:)) };
        crate::animation::full_rate(&link);
        link.setPaused(true);
        // SAFETY: the main run loop and standard modes. Common modes keep
        // the views rendering while a scroll view is tracking.
        unsafe { link.addToRunLoop_forMode(&NSRunLoop::mainRunLoop(), NSRunLoopCommonModes) };
        Self {
            views: None,
            shown: FxHashMap::default(),
            scale: 2.0,
            link,
            ticking: false,
        }
    }

    fn views(&mut self) -> &mut GpuViews {
        self.views
            .get_or_insert_with(|| GpuViews::new(PixelFormat::Rgba))
    }

    /// Mounts `source`'s renderer on `host`, view `id` (`None`: it draws
    /// nothing of its own), its box of `style` shown at `scale`.
    pub(crate) fn set(
        &mut self,
        id: NodeId,
        host: &UIView,
        style: &ViewStyle,
        scale: CGFloat,
        source: Option<GpuSource>,
    ) {
        if self.shown.get(&id).is_some_and(|s| *s.host != *host) {
            self.deleted(id);
        }
        let none = source.is_none();
        let state = self.shown.entry(id).or_insert_with(|| GpuState {
            host: host.retain(),
            layer: frames_layer(host, SHADER_Z),
            mask: None,
            bound: BoundProps::default(),
        });
        if none {
            // SAFETY: clearing the contents.
            quiet(|| unsafe { state.layer.setContents(None) });
        }
        self.scale = scale;
        clip_to_box(
            &state.layer,
            &mut state.mask,
            host.bounds().size,
            style,
            scale,
        );
        let views = self.views();
        views.set(id, source);
        views.show_on_surfaces(id, true);
        self.start();
    }

    /// Whether view `id` is a GPU view.
    pub(crate) fn has(&self, id: NodeId) -> bool {
        self.views.as_ref().is_some_and(|v| v.has(id))
    }

    /// Props of view `id`'s renderer changed; `false` when it is no GPU
    /// view.
    pub(crate) fn props(&mut self, id: NodeId, props: &[(Arc<str>, Option<JsonValue>)]) -> bool {
        if !self.shown.contains_key(&id) {
            return false;
        }
        self.views().set_props(id, props);
        self.start();
        true
    }

    /// The names of view `id`'s animated prop slots
    /// (`MountItem::ComponentPropSlots`); `false` when it is no GPU view.
    pub(crate) fn prop_slots(&mut self, id: NodeId, names: &[Arc<str>]) -> bool {
        let Some(state) = self.shown.get_mut(&id) else {
            return false;
        };
        state.bound.slots = names.to_vec();
        state.bound.forget();
        true
    }

    /// Hands view `id`'s renderer its bound props that moved.
    pub(crate) fn animated(
        &mut self,
        id: NodeId,
        bindings: &[(AnimationProp, AnimationNode)],
        animator: &Animator,
    ) {
        let (Some(state), Some(views)) = (self.shown.get_mut(&id), self.views.as_mut()) else {
            return;
        };
        let mut any = false;
        state.bound.moved(bindings, animator, |name, value| {
            views.set_animated(id, name, value);
            any = true;
        });
        if any {
            self.start();
        }
    }

    /// View `id`'s bindings changed: what is bound is handed over again.
    pub(crate) fn rebound(
        &mut self,
        id: NodeId,
        bindings: &[(AnimationProp, AnimationNode)],
        animator: &Animator,
    ) {
        if let Some(state) = self.shown.get_mut(&id) {
            state.bound.forget();
            self.animated(id, bindings, animator);
        }
    }

    /// View `id` was resized or restyled: the layer follows its box and a
    /// frame of the new size is rendered.
    pub(crate) fn resized(&mut self, id: NodeId, style: &ViewStyle, scale: CGFloat) {
        let Some(state) = self.shown.get_mut(&id) else {
            return;
        };
        self.scale = scale;
        let bounds = state.host.bounds().size;
        clip_to_box(&state.layer, &mut state.mask, bounds, style, scale);
        self.start();
    }

    /// The screen's scale changed: every view renders again at `scale`.
    pub(crate) fn rescale(&mut self, scale: CGFloat) {
        if self.shown.is_empty() {
            return;
        }
        self.scale = scale;
        quiet(|| {
            for state in self.shown.values() {
                state.layer.setContentsScale(scale);
            }
        });
        self.start();
    }

    /// View `id` was deleted: its renderer and its layer go.
    pub(crate) fn deleted(&mut self, id: NodeId) {
        let Some(state) = self.shown.remove(&id) else {
            return;
        };
        quiet(|| state.layer.removeFromSuperlayer());
        if let Some(views) = self.views.as_mut() {
            views.remove(id);
        }
    }

    /// Sizes the views, tells those out of sight (out of every window,
    /// scrolled away or clipped off); `true` when one wants a frame.
    fn sync(&mut self) -> bool {
        let Some(views) = self.views.as_mut() else {
            return false;
        };
        for (&id, state) in &self.shown {
            let bounds = state.host.bounds().size;
            views.set_size(
                id,
                size(Points(bounds.width as f32), Points(bounds.height as f32)),
                self.scale as f32,
            );
            views.set_hidden(id, !crate::sight::shown(&state.host));
        }
        views.wants_frame()
    }

    /// Runs the display link while a view wants a frame.
    fn start(&mut self) {
        if self.ticking || !self.sync() {
            return;
        }
        self.ticking = true;
        self.link.setPaused(false);
    }

    /// A tick of the display link: asks for the frames due, shows those
    /// done, reports the events to `control`, and pauses the link once no
    /// view wants a frame.
    pub(crate) fn frame(&mut self, control: &EngineControl) {
        self.sync();
        let Some(views) = self.views.as_mut() else {
            self.pause();
            return;
        };
        let mut new = Vec::new();
        views.tick(|id| new.push(id));
        for id in new {
            let Some(state) = self.shown.get(&id) else {
                continue;
            };
            let layer = &state.layer;
            // No IOSurface textures on this device: the frame read back.
            if views.with_surface(id, |s| show_surface(layer, s)).is_none() {
                views.with_frame(id, |f| show_pixels(layer, f));
            }
        }
        for (id, name, data) in views.take_events() {
            control.dispatch_event(
                id,
                EventKind::NativeEvent,
                EventPayload::Native { name, data },
            );
        }
        if !views.wants_frame() {
            self.pause();
        }
    }

    fn pause(&mut self) {
        self.ticking = false;
        self.link.setPaused(true);
    }

    /// Views may be back in a window (a page shown again, the surface
    /// moved): the link runs if one wants a frame.
    pub(crate) fn reveal(&mut self) {
        if self.views.is_some() {
            self.start();
        }
    }
}

impl Drop for SurfaceGpu {
    fn drop(&mut self) {
        // The link retains its target; invalidating breaks the cycle.
        self.link.invalidate();
        for state in self.shown.values() {
            state.layer.removeFromSuperlayer();
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use nsh_gpu::{GpuFrame, GpuRenderer, wgpu};
    use objc2_core_foundation::{CGPoint, CGRect, CGSize};

    use super::*;

    /// Clears its frame to opaque red.
    struct Red;

    impl GpuRenderer for Red {
        fn render(&mut self, frame: &mut GpuFrame<'_>) {
            let target = frame.target().clone();
            frame
                .encoder()
                .begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: None,
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: &target,
                        depth_slice: None,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Clear(wgpu::Color::RED),
                            store: wgpu::StoreOp::Store,
                        },
                    })],
                    depth_stencil_attachment: None,
                    timestamp_writes: None,
                    occlusion_query_set: None,
                    multiview_mask: None,
                });
        }
    }

    #[test]
    fn a_gpu_views_frame_on_a_surface_shows_and_draws_in_pictures() {
        use objc2_core_graphics::{
            CGBitmapContextCreate, CGBitmapContextGetData, CGColorSpace, CGImageAlphaInfo,
            CGImageByteOrderInfo, kCGColorSpaceSRGB,
        };
        let id: NodeId = 2;
        let mut views = GpuViews::new(PixelFormat::Rgba);
        views.set(id, Some(nsh_gpu::renderer_source(|| Red)));
        views.show_on_surfaces(id, true);
        views.set_size(id, size(Points(4.0), Points(4.0)), 1.0);
        let start = Instant::now();
        let mut shown = false;
        while !shown && start.elapsed() < Duration::from_secs(5) {
            views.tick(|_| shown = true);
            std::thread::sleep(Duration::from_millis(1));
        }
        if !shown {
            // No GPU answered: GPU views draw nothing of their own.
            eprintln!("no GPU: skipped");
            return;
        }
        let layer = CALayer::new();
        layer.setFrame(CGRect::new(CGPoint::ZERO, CGSize::new(4.0, 4.0)));
        if views
            .with_surface(id, |s| show_surface(&layer, s))
            .is_none()
        {
            eprintln!("no IOSurface textures on this device: read back");
            views.with_frame(id, |f| show_pixels(&layer, f));
        }
        // SAFETY: reading the contents set above.
        assert!(
            unsafe { layer.contents() }.is_some(),
            "the frame is the contents"
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
}
