//! Shader views: the layer [`MountItem::Shader`](nsh_core::MountItem)
//! mounts on a view, rendered by `nsh_engine::shader` on the UI thread next to the
//! animator and shown by `Box.java` as a bitmap under the view's children,
//! clipped to its rounded box as a background is.
//!
//! The layer stays here, by view id: `encode.rs` only tells Java which views
//! show a shader (`SHADER`), and Java reports their size in pixels
//! (`Native.shaderSize`). The GPU device is opened the first time a shader
//! is mounted on the `NshView` and kept across app loads. The animated slots
//! are written from the animation graph whenever its outputs are read
//! ([`crate::animation::UiAnimation::outputs`]), which also keeps the
//! `Choreographer` ticking while a shader view has a frame to render or
//! collect ([`ShaderView::wants_frame`]); each tick renders them, and a frame
//! that comes back crosses to Java once (`NshView.shaderFrame`), which copies
//! it into the view's bitmap.

use std::{sync::Arc, time::Instant};

use jni::{
    objects::{JObject, JValue},
    signature::{Primitive, ReturnType},
};
use nsh_core::{
    geometry::{Points, size},
    shader::ShaderLayer,
};
use nsh_engine::shader::{Frame, PixelFormat, Renderer, ShaderView};
use rustc_hash::FxHashMap;

use crate::java::{java, with_env};

/// The shader views of one `NshView` and the GPU device they render with.
#[derive(Default)]
pub(crate) struct Shaders {
    /// Opened the first time a shader is mounted (`Some(None)`: there is
    /// no device, and shader views show nothing of their own).
    renderer: Option<Option<Renderer>>,
    views: FxHashMap<u32, ShaderView>,
}

impl Shaders {
    /// Forgets every view (a new app runs), keeping the device.
    pub(crate) fn clear(&mut self) {
        self.views.clear();
    }

    /// Mounts `layer` on view `id` (`None`: it shows nothing of its own).
    pub(crate) fn set(&mut self, id: u32, layer: Option<Arc<ShaderLayer>>) {
        if layer.is_none() && !self.views.contains_key(&id) {
            return;
        }
        if layer.is_some() && self.renderer.is_none() {
            // Android's ARGB_8888 is R, G, B, A in memory, premultiplied.
            self.renderer = Some(Renderer::new(PixelFormat::Rgba));
        }
        self.views.entry(id).or_default().set_layer(layer);
    }

    /// View `id` is `width` × `height` pixels at `density` pixels per point
    /// (Java reports it before the layer arrives, so this may come first).
    pub(crate) fn resized(&mut self, id: u32, width: i32, height: i32, density: f32) {
        let density = density.max(f32::MIN_POSITIVE);
        self.views.entry(id).or_default().set_size(
            size(
                Points(width.max(0) as f32 / density),
                Points(height.max(0) as f32 / density),
            ),
            density,
        );
    }

    /// View `id` is gone.
    pub(crate) fn delete(&mut self, id: u32) {
        self.views.remove(&id);
    }

    /// Whether view `id` shows (or showed) a shader: its animated values are
    /// written here, never sent to Java.
    pub(crate) fn contains(&self, id: u32) -> bool {
        self.views.contains_key(&id)
    }

    /// The views, to write their animated slots.
    pub(crate) fn views_mut(&mut self) -> impl Iterator<Item = (u32, &mut ShaderView)> {
        self.views.iter_mut().map(|(&id, view)| (id, view))
    }

    /// Whether a view has a frame to render or collect.
    pub(crate) fn wants_frame(&self) -> bool {
        matches!(self.renderer, Some(Some(_))) && self.views.values().any(ShaderView::wants_frame)
    }

    /// One `Choreographer` frame: renders the views that have a frame due,
    /// hands those that came back to `nsh_view` (the `NshView`); whether
    /// one wants another frame.
    pub(crate) fn render(&mut self, nsh_view: &JObject<'_>) -> bool {
        let Some(Some(renderer)) = &self.renderer else {
            return false;
        };
        let now = Instant::now();
        let mut more = false;
        for (&id, view) in &mut self.views {
            if !view.wants_frame() {
                continue;
            }
            if view.render(renderer, now) {
                deliver(nsh_view, id, view.frame());
            }
            more |= view.wants_frame();
        }
        more
    }
}

/// `NshView.shaderFrame(id, pixels, width, height)`: Java copies the
/// pixels into the view's bitmap (null pixels: an empty frame).
fn deliver(nsh_view: &JObject<'_>, id: u32, frame: &Frame) {
    let pixels = frame.tight();
    let (width, height) = (frame.width as i32, frame.height as i32);
    with_env(|env| {
        let buffer = if width > 0 && height > 0 && !pixels.is_empty() {
            // SAFETY: `pixels` is a live, non-empty allocation of this
            // length that outlives the call below; Java only reads it, and
            // copies it out before `shaderFrame` returns without keeping
            // the buffer.
            JObject::from(unsafe {
                env.new_direct_byte_buffer(pixels.as_ptr().cast_mut(), pixels.len())
            }?)
        } else {
            JObject::null()
        };
        // SAFETY: matches the signature checked in `java::init`.
        unsafe {
            env.call_method_unchecked(
                nsh_view,
                java().view_shader_frame,
                ReturnType::Primitive(Primitive::Void),
                &[
                    JValue::Int(id as i32).as_jni(),
                    JValue::Object(&buffer).as_jni(),
                    JValue::Int(width).as_jni(),
                    JValue::Int(height).as_jni(),
                ],
            )
        }
        .map(|_| ())
    });
}
