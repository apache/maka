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

use std::{
    cell::{Cell, OnceCell, RefCell},
    rc::{Rc, Weak},
    sync::Arc,
    time::Instant,
};

use nsh_core::{animation::AnimationValue, canvas::Damage, shader::ShaderLayer};
use nsh_engine::shader::{Frame, PixelFormat, Renderer, ShaderView};
use objc2::rc::Retained;
use objc2_core_foundation::CFRetained;
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
    /// Its frame callback runs.
    running: Cell<bool>,
}

impl Shaders {
    /// The GPU device, opened the first time one asks.
    fn renderer(&self) -> Option<&Renderer> {
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
}

impl ShaderState {
    fn new(surface: &Rc<Surface>) -> Self {
        let layer = CALayer::new();
        // Clipped to its rounded corners ([`crate::decor`] sets them).
        layer.setMasksToBounds(true);
        // SAFETY: an immutable Core Animation constant.
        layer.setContentsGravity(unsafe { kCAGravityResize });
        // Above the background, its gradients and inset shadows, below the
        // borders behind the children and the children.
        layer.setZPosition(crate::decor::BEHIND + 0.75);
        ShaderState {
            surface: Rc::downgrade(surface),
            view: ShaderView::default(),
            layer,
            ticking: false,
            hidden: false,
        }
    }

    /// The layer the frames show in.
    pub(crate) fn layer(&self) -> &CALayer {
        &self.layer
    }
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
            .get_or_insert_with(|| ShaderState::new(surface));
        if layer.is_none() {
            // SAFETY: clearing the contents.
            unsafe { shader.layer.setContents(None) };
        }
        shader.view.set_layer(layer);
    }
    // The decoration shapes the layer and adds it to the view's.
    view.restyle();
    if tick(view) {
        start(surface);
    }
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
    if tick(view)
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

/// The app stopped: its views render no more.
pub(crate) fn clear(surface: &Surface) {
    surface.shaders.views.borrow_mut().clear();
    surface.shaders.running.set(false);
}

/// Adds `view` to the views rendering if it has a frame to render; whether
/// it was added (the caller then [`start`]s the frame callback).
fn tick(view: &NshView) -> bool {
    let surface = {
        let mut state = view.state_mut();
        let Some(shader) = state.shader.as_mut() else {
            return false;
        };
        if shader.ticking || shader.hidden || !shader.view.wants_frame() {
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
    surface.add_frame_callback(|surface, _| {
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
        let hidden = !deleted && !view.shown();
        let more = !deleted && !hidden && render(&view, renderer, now);
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
fn render(view: &NshView, renderer: &Renderer, now: Instant) -> bool {
    let scale = view.ns().window().map_or(2.0, |w| w.backingScaleFactor()) as f32;
    let mut state = view.state_mut();
    let size = state.frame.size;
    let Some(shader) = state.shader.as_mut() else {
        return false;
    };
    shader.view.set_size(size, scale);
    if shader.view.render(renderer, now) {
        let image = frame_image(shader.view.frame());
        let contents = image.as_deref().map(crate::decor::image_object);
        // SAFETY: a CGImage is a valid `contents` object (none clears it).
        unsafe { shader.layer.setContents(contents.as_deref()) };
    }
    shader.view.wants_frame()
}

/// A frame's premultiplied sRGB RGBA pixels as a CGImage (`None` when it is
/// empty).
fn frame_image(frame: &Frame) -> Option<CFRetained<CGImage>> {
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
        for (row, src) in frame.rows().enumerate() {
            let len = src.len().min(stride);
            pixels[row * stride..row * stride + len].copy_from_slice(&src[..len]);
        }
        CGBitmapContextCreateImage(Some(&context))
    }
}
