//! Shader views: the layer [`MountItem::Shader`](nsh_core::MountItem)
//! mounts on a view, rendered by `nsh_engine::shader` and painted as a GPUI image
//! under the view's children, clipped to its rounded box as a background
//! is.
//!
//! The surface opens the GPU device the first time a shader is mounted
//! ([`Surface::shader_renderer`]). Each shader view renders on a frame
//! client of its surface ([`Surface::on_frame`]) while it has a frame to
//! render or collect ([`ShaderView::wants_frame`]: its uniforms or size
//! changed, or it reads `nsh.time`), at the window's scale factor. A frame
//! that comes back is uploaded when it is next drawn (BGRA, straight, the
//! view's opacity multiplied in, as canvas' pixmaps are) and the image it
//! replaces leaves GPUI's atlases ([`Texture`]). A view that was not drawn
//! in the last frame (clipped away, scrolled out, transparent, detached)
//! stops rendering until it is drawn again.

use std::{
    cell::{Cell, RefCell},
    rc::Rc,
    sync::Arc,
    time::Instant,
};

use gpui::{Corners, RenderImage};
use nsh_core::{animation::AnimationValue, shader::ShaderLayer};
use nsh_engine::shader::{Renderer, ShaderView};

use crate::{
    image::Texture,
    render::DrawCx,
    surface::Surface,
    view::{NshView, ViewState},
};

/// What a shader view shows.
#[derive(Default)]
pub(crate) struct ShaderState {
    renderer: Option<Rc<Renderer>>,
    view: ShaderView,
    /// Its surface's key ([`Surface::by_key`]): the animator's writes and
    /// drawing have no surface at hand.
    surface: u64,
    /// Its frame client runs.
    ticking: bool,
    /// Drawn (and not culled) since its frame client last ran.
    seen: Cell<bool>,
    /// Stopped because it was not drawn: drawing it starts it again.
    hidden: Cell<bool>,
    /// The window's scale factor it was last drawn at: a new one renders
    /// a frame at it.
    scale: Cell<f32>,
    /// The last frame as uploaded.
    shown: RefCell<Option<Shown>>,
}

/// A frame uploaded as a GPUI image.
struct Shown {
    /// The frame's [`nsh_engine::shader::Frame::serial`].
    serial: u64,
    /// The opacity multiplied in.
    opacity: f32,
    /// The image (`None`: the frame is transparent).
    texture: Option<Texture>,
}

/// Mounts `layer` on `view` (`None`: it shows nothing of its own).
pub(crate) fn set(surface: &Rc<Surface>, view: &NshView, layer: Option<Arc<ShaderLayer>>) {
    {
        let mut state = view.state_mut();
        if layer.is_none() && state.shader.is_none() {
            return;
        }
        let shader = state.shader.get_or_insert_with(Default::default);
        shader.surface = surface.key();
        if layer.is_some() && shader.renderer.is_none() {
            shader.renderer = surface.shader_renderer();
        }
        if layer.is_none() {
            shader.shown.get_mut().take();
        }
        shader.view.set_layer(layer);
    }
    view.changed();
    start(surface, view);
}

/// The values of the layer's animated slots (called while the animator
/// writes into the views).
pub(crate) fn set_args(view: &NshView, values: &[(u16, AnimationValue)]) {
    let key = {
        let mut state = view.state_mut();
        let Some(shader) = state.shader.as_mut() else {
            return;
        };
        for &(slot, value) in values {
            shader.view.set_slot(slot, value);
        }
        shader.surface
    };
    if let Some(surface) = Surface::by_key(key) {
        start(&surface, view);
    }
}

/// Its size changed: a frame of the new size is rendered.
pub(crate) fn resized(surface: &Rc<Surface>, view: &NshView) {
    refresh(surface, view);
}

/// Renders a frame at the view's size and the window's scale factor if
/// either changed.
fn refresh(surface: &Surface, view: &NshView) {
    {
        let mut state = view.state_mut();
        let size = state.frame.size;
        let Some(shader) = state.shader.as_mut() else {
            return;
        };
        shader.view.set_size(size, surface.scale());
    }
    start(surface, view);
}

/// Adds the view's frame client if it has a frame to render.
fn start(surface: &Surface, view: &NshView) {
    {
        let mut state = view.state_mut();
        let Some(shader) = state.shader.as_mut() else {
            return;
        };
        if shader.ticking
            || shader.hidden.get()
            || shader.renderer.is_none()
            || !shader.view.wants_frame()
        {
            return;
        }
        shader.ticking = true;
        // Its first frame is rendered whether it was drawn or not.
        shader.seen.set(true);
    }
    let view = view.clone();
    // Not `on_frame`: the animator's writes hold the animation graph, which
    // it looks at.
    surface.add_frame_client(move |surface, _| {
        let go_on = frame(surface, &view);
        if !go_on && let Some(shader) = view.state_mut().shader.as_mut() {
            shader.ticking = false;
        }
        go_on
    });
}

/// One frame of the window (before it is drawn): renders, collects;
/// whether to run again.
fn frame(surface: &Surface, view: &NshView) -> bool {
    let scale = surface.scale();
    let new = {
        let mut state = view.state_mut();
        let size = state.frame.size;
        let Some(shader) = state.shader.as_mut() else {
            return false;
        };
        if !shader.seen.replace(false) {
            shader.hidden.set(true);
            return false;
        }
        let Some(renderer) = shader.renderer.clone() else {
            return false;
        };
        shader.view.set_size(size, scale);
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

/// Draws the last frame over the view's box, inside its rounded corners.
pub(crate) fn draw(cx: &mut DrawCx<'_>, state: &ViewState) {
    let Some(shader) = state.shader.as_ref() else {
        return;
    };
    let (w, h) = (state.frame.size.width.0, state.frame.size.height.0);
    cx.push_clip_rounded(crate::geom::rect(0.0, 0.0, w, h), state.radii());
    if w > 0.0 && h > 0.0 && !cx.culled() {
        shader.seen.set(true);
        let shown_again = shader.hidden.replace(false);
        let rescaled = shader.scale.replace(cx.scale) != cx.scale;
        if shown_again || rescaled {
            // Renders from the next frame on (the view's state is borrowed
            // while drawing).
            let (key, id) = (shader.surface, state.id);
            crate::rt::invoke(move || {
                if let Some(surface) = Surface::by_key(key)
                    && let Some(view) = surface.view(id)
                {
                    refresh(&surface, &view);
                }
            });
        }
        paint(cx, shader, (w, h));
    }
    cx.pop();
}

/// Paints the last frame stretched over `size` (points, the view's
/// coordinates), uploading it first if it is new.
fn paint(cx: &mut DrawCx<'_>, shader: &ShaderState, (w, h): (f32, f32)) {
    // Images uploaded before and dropped since leave the atlas.
    crate::image::release_textures(cx);
    let frame = shader.view.frame();
    let mut shown = shader.shown.borrow_mut();
    if frame.width == 0 || frame.height == 0 {
        *shown = None;
        return;
    }
    let opacity = cx.opacity;
    if shown
        .as_ref()
        .is_none_or(|s| s.serial != frame.serial || s.opacity != opacity)
    {
        *shown = Some(Shown {
            serial: frame.serial,
            opacity,
            texture: upload(frame, opacity).map(Texture::new),
        });
    }
    let Some(texture) = shown.as_ref().and_then(|s| s.texture.as_ref()) else {
        return;
    };
    let placed = cx.rect(0.0, 0.0, w, h);
    // GPUI rounds the sprite itself: the view's corners (pushed by
    // `draw`), or a rounded parent's where the view reaches them.
    let (bounds, corners) = cx.clip_rounded(placed, Corners::default());
    let image = texture.image().clone();
    cx.paint(|window, _| {
        if let Err(e) = window.paint_image(bounds, placed, corners, image, 0, false) {
            log::debug!("shader: not painted: {e}");
        }
    });
}

/// A frame (premultiplied BGRA) as a GPUI image (straight BGRA) at
/// `opacity`; `None` when it is transparent.
fn upload(frame: &nsh_engine::shader::Frame, opacity: f32) -> Option<Arc<RenderImage>> {
    let mut buf = Vec::with_capacity(frame.width as usize * frame.height as usize * 4);
    let mut any = false;
    for p in frame.rows().flat_map(|row| row.as_chunks::<4>().0) {
        let a = p[3];
        if a == 0 {
            buf.extend_from_slice(&[0; 4]);
            continue;
        }
        any = true;
        let straight = |c: u8| ((c as u32 * 255 + a as u32 / 2) / a as u32).min(255) as u8;
        let alpha = (a as f32 * opacity).round() as u8;
        buf.extend_from_slice(&[straight(p[0]), straight(p[1]), straight(p[2]), alpha]);
    }
    if !any {
        return None;
    }
    let image = image::RgbaImage::from_raw(frame.width, frame.height, buf)?;
    Some(Arc::new(RenderImage::new(vec![image::Frame::new(image)])))
}
