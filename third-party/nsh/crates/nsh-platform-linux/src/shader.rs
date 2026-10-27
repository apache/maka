//! Shader views: the layer [`MountItem::Shader`](nsh_core::MountItem)
//! mounts on a view, rendered by `nsh_engine::shader` and shown as a texture under
//! the view's children, clipped to its rounded box as a background is.
//!
//! The surface opens the GPU device the first time a shader is mounted
//! ([`Surface::shader_renderer`]). Each shader view renders on its own tick
//! callback while it has a frame to render or collect
//! ([`ShaderView::wants_frame`]: its uniforms or size changed, or it reads
//! `nsh.time`), at the surface's scale; a frame that comes back becomes a
//! `GdkMemoryTexture` and the view draws again. A view out of sight (outside
//! a clipping ancestor or the window) stops ticking until it comes into
//! sight again ([`reveal`]).

use std::{cell::RefCell, rc::Rc, sync::Arc, time::Instant};

use gtk4::{self as gtk, gdk, glib, graphene, prelude::*};
use nsh_core::{
    animation::AnimationValue,
    geometry::{Points, size},
    shader::ShaderLayer,
};
use nsh_engine::shader::{Renderer, ShaderView};

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
}

thread_local! {
    /// Shader views out of sight with a frame to render.
    static HIDDEN: RefCell<Vec<glib::WeakRef<NshView>>> = RefCell::default();
}

/// Mounts `layer` on `view` (`None`: it shows nothing of its own).
pub(crate) fn set(surface: &Rc<Surface>, view: &NshView, layer: Option<Arc<ShaderLayer>>) {
    {
        let mut state = view.state_mut();
        if layer.is_none() && state.shader.is_none() {
            return;
        }
        let shader = state.shader.get_or_insert_with(Default::default);
        if layer.is_some() && shader.renderer.is_none() {
            shader.renderer = surface.shader_renderer();
        }
        if layer.is_none() {
            shader.texture = None;
        }
        shader.view.set_layer(layer);
    }
    view.changed();
    tick(view);
}

/// The values of the layer's animated slots.
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
pub(crate) fn resized(view: &NshView) {
    if view.state().shader.is_some() {
        tick(view);
    }
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
    let scale = view
        .native()
        .and_then(|n| n.surface())
        .map_or(view.scale_factor() as f64, |s| s.scale()) as f32;
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
        if shader.view.render(&renderer, Instant::now()) {
            let f = shader.view.frame();
            shader.texture = (f.width > 0 && f.height > 0).then(|| {
                gdk::MemoryTexture::new(
                    f.width as i32,
                    f.height as i32,
                    gdk::MemoryFormat::R8g8b8a8Premultiplied,
                    &glib::Bytes::from(&f.pixels[..]),
                    f.stride as usize,
                )
            });
            true
        } else {
            false
        }
    };
    if new {
        view.changed();
    }
    view.state()
        .shader
        .as_ref()
        .is_some_and(|s| s.view.wants_frame())
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

/// Draws the last frame over the view's box, inside its rounded corners.
pub(crate) fn draw(snapshot: &gtk::Snapshot, state: &ViewState) {
    let Some(texture) = state.shader.as_ref().and_then(|s| s.texture.as_ref()) else {
        return;
    };
    let (w, h) = (state.frame.size.width.0, state.frame.size.height.0);
    if w <= 0.0 || h <= 0.0 {
        return;
    }
    snapshot.push_rounded_clip(&state.rounded_bounds());
    snapshot.append_texture(texture, &graphene::Rect::new(0.0, 0.0, w, h));
    snapshot.pop();
}
