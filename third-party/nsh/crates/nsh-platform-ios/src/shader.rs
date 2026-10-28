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

use std::{cell::OnceCell, sync::Arc, time::Instant};

use nsh_core::{
    NodeId, ViewStyle,
    animation::AnimationValue,
    geometry::{Points, px, size},
    shader::ShaderLayer,
};
use nsh_engine::shader::{Frame, PixelFormat, Renderer, ShaderView};
use objc2::{Message, rc::Retained, runtime::AnyObject, sel};
use objc2_core_foundation::{CFRetained, CGFloat, CGPoint, CGRect};
use objc2_core_graphics::CGImage;
use objc2_foundation::{NSRunLoop, NSRunLoopCommonModes};
use objc2_quartz_core::{CADisplayLink, CALayer, CAShapeLayer, kCAGravityResize};
use objc2_ui_kit::UIView;
use rustc_hash::FxHashMap;

use crate::{
    decor::{corner_mask, quiet, rounded, set_corners},
    target::EventTarget,
};

/// Over the fills, gradients and inset shadows `decor` and `visual` put
/// behind the children (from -1024), under the borders drawn there
/// (-1023) and the children themselves: the shader paints the box as a
/// background image would.
const SHADER_Z: CGFloat = -1024.0 + 0.75;

/// The shader views of one surface and the GPU device they render with.
pub(crate) struct Shaders {
    /// Opened the first time a shader is mounted (`None` inside: there is
    /// no GPU device).
    renderer: OnceCell<Option<Renderer>>,
    views: FxHashMap<NodeId, ShaderState>,
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
            link,
            running: false,
        }
    }

    /// Whether `id` is a shader view.
    pub(crate) fn has(&self, id: NodeId) -> bool {
        self.views.contains_key(&id)
    }

    /// Mounts `layer` on `host`, view `id` (`None`: it shows nothing of
    /// its own).
    pub(crate) fn set(
        &mut self,
        id: NodeId,
        host: &UIView,
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
        let state = self.views.entry(id).or_insert_with(|| {
            let shown = CALayer::new();
            shown.setZPosition(SHADER_Z);
            // SAFETY: an immutable Core Animation constant.
            shown.setContentsGravity(unsafe { kCAGravityResize });
            host.layer().addSublayer(&shown);
            ShaderState {
                host: host.retain(),
                layer: shown,
                mask: None,
                view: ShaderView::default(),
            }
        });
        state.view.set_layer(Some(layer));
        state.layout(style, scale);
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
            state.layer.setContentsScale(scale);
            let bounds = state.host.bounds().size;
            state.view.set_size(
                size(Points(bounds.width as f32), Points(bounds.height as f32)),
                scale as f32,
            );
        }
        self.wake();
    }

    /// View `id` is deleted (or shows no shader any more).
    pub(crate) fn remove(&mut self, id: NodeId) {
        if let Some(state) = self.views.remove(&id) {
            state.layer.removeFromSuperlayer();
            self.wake();
        }
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
        for state in self.views.values_mut() {
            if !state.view.wants_frame() {
                continue;
            }
            // Out of every window: rendered once it is back in one.
            if state.host.window().is_some() && state.view.render(renderer, now) {
                state.show();
            }
            wants |= state.view.wants_frame();
        }
        self.set_running(wants);
    }

    /// Runs the link if some shader view has a frame to render.
    fn wake(&mut self) {
        let wants = matches!(self.renderer.get(), Some(Some(_)))
            && self.views.values().any(|s| s.view.wants_frame());
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
    }
}

impl ShaderState {
    /// Frames the layer over the host's bounds, clips it to the rounded
    /// box of `style`, and tells the shader its size at `scale`.
    fn layout(&mut self, style: &ViewStyle, scale: CGFloat) {
        let bounds = self.host.bounds().size;
        let (w, h) = (bounds.width as f32, bounds.height as f32);
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
        let image = rgba_image(self.view.frame());
        quiet(|| {
            // SAFETY: a CGImage is a valid `contents` object; `None` clears
            // them.
            unsafe {
                self.layer.setContents(
                    image
                        .as_deref()
                        .map(|cg| &*(cg as *const CGImage as *const AnyObject)),
                )
            }
        });
    }
}

/// A CGImage of the frame's premultiplied sRGB RGBA pixels (`None` for an
/// empty frame).
fn rgba_image(frame: &Frame) -> Option<CFRetained<CGImage>> {
    use objc2_core_graphics::{
        CGBitmapContextCreate, CGBitmapContextCreateImage, CGBitmapContextGetBytesPerRow,
        CGBitmapContextGetData, CGColorSpace, CGImageAlphaInfo, CGImageByteOrderInfo,
        kCGColorSpaceSRGB,
    };
    let (width, height) = (frame.width as usize, frame.height as usize);
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
        for (row, src) in frame.rows().enumerate() {
            let n = src.len().min(width * 4);
            pixels[row * stride..row * stride + n].copy_from_slice(&src[..n]);
        }
        CGBitmapContextCreateImage(Some(&context))
    }
}
