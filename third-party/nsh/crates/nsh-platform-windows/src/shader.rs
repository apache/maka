//! Shader views: the layer [`MountItem::Shader`](nsh_core::MountItem)
//! mounts on a view, rendered by `nsh_engine::shader` and drawn as a bitmap under
//! the view's children, clipped to its rounded box as a background is.
//!
//! The surface opens the GPU device the first time a shader is mounted
//! ([`Surface::shader_renderer`]). Each shader view renders on the
//! surface's frame ticker ([`Surface::on_frame`]) while it has a frame to
//! render or collect ([`ShaderView::wants_frame`]: its uniforms or size
//! changed, or it reads `nsh.time`), at the window's scale; a frame that
//! comes back is copied into the view's Direct2D bitmap when the view is
//! drawn (made again after a device loss) and the view draws again. A view
//! out of sight (hidden, on a concealed screen, detached) stops rendering
//! until a frame of its window finds it in sight again ([`reveal`]).
//!
//! Animated uniforms are written while the animation graph is borrowed
//! ([`set_args`]), so the views they start are queued and started once it
//! is not ([`start_pending`]).

use std::{
    cell::RefCell,
    rc::{Rc, Weak},
    sync::Arc,
    time::Instant,
};

use nsh_core::{NodeId, Points, animation::AnimationValue, geometry::size, shader::ShaderLayer};
use nsh_engine::shader::{Renderer, ShaderView};
use windows::Win32::Graphics::{
    Direct2D::{
        Common::{D2D_SIZE_U, D2D1_ALPHA_MODE_PREMULTIPLIED, D2D1_PIXEL_FORMAT},
        D2D1_BITMAP_OPTIONS_NONE, D2D1_BITMAP_PROPERTIES1, D2D1_INTERPOLATION_MODE_LINEAR,
        ID2D1Bitmap1, ID2D1DeviceContext,
    },
    Dxgi::Common::DXGI_FORMAT_B8G8R8A8_UNORM,
};

use crate::{
    render::{DrawCx, rect_f},
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
}

/// A frame as a Direct2D bitmap.
struct Drawn {
    bitmap: ID2D1Bitmap1,
    /// Its size in pixels.
    size: (u32, u32),
    /// The frame it holds ([`nsh_engine::shader::Frame::serial`]).
    serial: u64,
    /// The device generation it was made in.
    generation: u64,
}

impl ShaderState {
    /// The bitmap of the last frame on `dc`'s device: the frame's pixels
    /// are copied in when they are new, and a bitmap is made on first use,
    /// for a new size and after a device loss.
    fn bitmap(&self, dc: &ID2D1DeviceContext) -> Option<ID2D1Bitmap1> {
        let frame = self.view.frame();
        if frame.width == 0 || frame.height == 0 {
            return None;
        }
        let generation = crate::gfx::generation();
        let mut drawn = self.drawn.borrow_mut();
        if let Some(d) = drawn.as_mut()
            && d.generation == generation
            && d.size == (frame.width, frame.height)
        {
            if d.serial == frame.serial {
                return Some(d.bitmap.clone());
            }
            // SAFETY: `pixels` holds `height` rows `stride` bytes apart,
            // the bitmap's size.
            let copied = unsafe {
                d.bitmap
                    .CopyFromMemory(None, frame.pixels.as_ptr().cast(), frame.stride)
            };
            match copied {
                Ok(()) => {
                    d.serial = frame.serial;
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
        let pixels = D2D_SIZE_U {
            width: frame.width,
            height: frame.height,
        };
        // SAFETY: `pixels` holds `height` rows `stride` bytes apart.
        let made = unsafe {
            dc.CreateBitmap(
                pixels,
                Some(frame.pixels.as_ptr().cast()),
                frame.stride,
                &props,
            )
        };
        match made {
            Ok(bitmap) => {
                *drawn = Some(Drawn {
                    bitmap: bitmap.clone(),
                    size: (frame.width, frame.height),
                    serial: frame.serial,
                    generation,
                });
                Some(bitmap)
            }
            Err(e) => {
                log::warn!(
                    "shader: cannot create a {}x{} bitmap: {e}",
                    frame.width,
                    frame.height
                );
                None
            }
        }
    }
}

thread_local! {
    /// Shader views out of sight with a frame to render.
    static HIDDEN: RefCell<Vec<(Weak<Surface>, NodeId)>> = RefCell::default();
    /// Shader views whose animated uniforms changed while they were not
    /// rendering ([`set_args`]).
    static PENDING: RefCell<Vec<NshView>> = RefCell::default();
}

/// Mounts `layer` on `view` (`None`: it shows nothing of its own).
pub(crate) fn set(surface: &Rc<Surface>, view: &NshView, layer: Option<Arc<ShaderLayer>>) {
    {
        let mut state = view.state_mut();
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
        }
        shader.view.set_layer(layer);
    }
    view.changed();
    tick(view);
}

/// The values of the layer's animated slots. Called while the animation
/// graph is borrowed: a view that starts rendering is queued
/// ([`start_pending`]).
pub(crate) fn set_args(view: &NshView, values: &[(u16, AnimationValue)]) {
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
pub(crate) fn resized(view: &NshView) {
    if view.state().shader.is_some() {
        tick(view);
    }
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
    surface.on_frame(move |surface, _now| {
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
    let new = {
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
        shader.view.render(&renderer, Instant::now())
    };
    if new {
        view.changed();
    }
    view.state()
        .shader
        .as_ref()
        .is_some_and(|s| s.view.wants_frame())
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

/// Draws the last frame over the view's box, inside its rounded corners
/// (under its content and children).
pub(crate) fn draw(cx: &mut DrawCx<'_>, state: &ViewState) {
    let Some(shader) = state.shader.as_ref() else {
        return;
    };
    let (w, h) = (state.frame.size.width.0, state.frame.size.height.0);
    if w <= 0.0 || h <= 0.0 {
        return;
    }
    let Some(bitmap) = shader.bitmap(cx.dc) else {
        return;
    };
    cx.push_clip_rounded(crate::geom::rect(0.0, 0.0, w, h), state.radii());
    // SAFETY: a COM call on the live context with a bitmap of its device.
    unsafe {
        cx.dc.DrawBitmap(
            &bitmap,
            Some(&rect_f(0.0, 0.0, w, h)),
            1.0,
            D2D1_INTERPOLATION_MODE_LINEAR,
            None,
            None,
        )
    };
    cx.pop();
}
