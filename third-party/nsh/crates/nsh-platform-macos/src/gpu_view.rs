//! GPU views: views whose box a renderer of the app's own draws with wgpu
//! ([`nsh_core::gpu`], `MountItem::GpuView`), on the surface's render
//! thread (`nsh_engine::gpu`), shown as the contents of a sublayer under
//! the children.
//!
//! The surface keeps one [`GpuViews`] (made with the first GPU view, which
//! starts the render thread). Its frames go to IOSurfaces
//! ([`GpuViews::show_on_surfaces`]): while any view wants a frame, a draw
//! callback of the surface's display link (the shaders' frame clock) asks
//! for the frames due on every display frame, at each view's size and
//! backing scale, and sets each new frame's IOSurface as its view's layer
//! contents, which the window server shows without a copy. Where a frame
//! has no surface it is read back and shown as a CGImage. The layer is
//! shaped as a shader's fill ([`crate::decor`]: under the children, inside
//! the rounded corners). A view out of sight (a list row scrolled away, a
//! screen under another) renders nothing until it shows again ([`shown`],
//! from [`crate::mount::Mounter::revisit`]). The renderers' events reach
//! the app as the views' `NativeEvent`s.

use std::{rc::Rc, sync::Arc};

use nsh_core::{
    EventKind, EventPayload, JsonValue, NodeId, animation::AnimatedPropValue, canvas::Damage,
    gpu::GpuSource,
};
use nsh_engine::{gpu::GpuViews, shader::PixelFormat};
use objc2::rc::Retained;
use objc2_quartz_core::CALayer;

use crate::{surface::Surface, view::NshView};

/// What a GPU view shows.
pub(crate) struct GpuState {
    /// Shows the frames: a sublayer of the view's layer, under its
    /// children ([`crate::decor`] shapes it).
    layer: Retained<CALayer>,
}

impl GpuState {
    /// The layer the frames show in.
    pub(crate) fn layer(&self) -> &CALayer {
        &self.layer
    }
}

/// The surface's GPU views, and whether its draw callback runs.
#[derive(Default)]
pub(crate) struct SurfaceGpu {
    views: Option<GpuViews>,
    /// The GPU views, to size them and tell those out of sight.
    shown: Vec<NshView>,
    ticking: bool,
}

impl SurfaceGpu {
    fn views(&mut self) -> &mut GpuViews {
        // RGBA, as the shaders' frames ([`crate::shader`]).
        self.views
            .get_or_insert_with(|| GpuViews::new(PixelFormat::Rgba))
    }
}

/// Mounts `source`'s renderer on `view` (`None`: it draws nothing of its
/// own).
pub(crate) fn set(surface: &Rc<Surface>, view: &NshView, source: Option<GpuSource>) {
    {
        let mut state = view.state_mut();
        let gpu = state.gpu.get_or_insert_with(|| {
            Box::new(GpuState {
                layer: crate::shader::fill_layer(),
            })
        });
        if source.is_none() {
            // SAFETY: clearing the contents.
            crate::surface::quiet(|| unsafe { gpu.layer.setContents(None) });
        }
    }
    {
        let mut gpu = surface.gpu.borrow_mut();
        if !gpu.shown.contains(view) {
            gpu.shown.push(view.clone());
        }
        let on = source.is_some();
        let views = gpu.views();
        views.set(view.id(), source);
        if on {
            views.show_on_surfaces(view.id(), true);
        }
    }
    // The decoration shapes the layer and adds it to the view's.
    view.restyle();
    start(surface);
}

/// Whether view `id` is a GPU view.
pub(crate) fn has(surface: &Surface, id: NodeId) -> bool {
    surface
        .gpu
        .borrow()
        .views
        .as_ref()
        .is_some_and(|v| v.has(id))
}

/// Props of `view`'s renderer changed; `false` when it is no GPU view.
pub(crate) fn props(
    surface: &Rc<Surface>,
    view: &NshView,
    props: &[(Arc<str>, Option<JsonValue>)],
) -> bool {
    if view.state().gpu.is_none() {
        return false;
    }
    surface.gpu.borrow_mut().views().set_props(view.id(), props);
    start(surface);
    true
}

/// Takes the bound props that moved for GPU views out of `moved` and
/// hands them to their renderers.
pub(crate) fn animated(surface: &Surface, moved: &mut Vec<(NodeId, Arc<str>, AnimatedPropValue)>) {
    let any = {
        let mut gpu = surface.gpu.borrow_mut();
        let Some(views) = gpu.views.as_mut() else {
            return;
        };
        let before = moved.len();
        moved.retain(|(id, name, value)| {
            if !views.has(*id) {
                return true;
            }
            views.set_animated(*id, name, *value);
            false
        });
        moved.len() != before
    };
    if any && let Some(surface) = Surface::with_key(surface.key()) {
        start(&surface);
    }
}

/// Its size changed: a frame of the new size is rendered.
pub(crate) fn resized(surface: &Rc<Surface>, view: &NshView) {
    if view.state().gpu.is_some() {
        start(surface);
    }
}

/// `view` was deleted: its renderer goes.
pub(crate) fn deleted(surface: &Surface, view: &NshView) {
    if view.state().gpu.is_none() {
        return;
    }
    let mut gpu = surface.gpu.borrow_mut();
    gpu.shown.retain(|v| v != view);
    if let Some(views) = gpu.views.as_mut() {
        views.remove(view.id());
    }
}

/// It can be seen again (after [`crate::mount::Mounter::draw_when_shown`]
/// put it off): renders what it missed.
pub(crate) fn shown(view: &NshView) {
    if view.state().gpu.is_none() {
        return;
    }
    if let Some(surface) = view.surface() {
        start(&surface);
    }
}

/// The app stopped: its views render no more.
pub(crate) fn clear(surface: &Surface) {
    let mut gpu = surface.gpu.borrow_mut();
    gpu.shown.clear();
    gpu.views = None;
}

/// Sizes the views and, with `sight`, tells those out of sight (shown
/// again through [`shown`]); `true` when one wants a frame. Sight is only
/// decided on a display frame, as shaders do: while mounting, AppKit has
/// not placed the views yet and every one would look out of sight.
fn sync(surface: &Surface, sight: bool) -> bool {
    let hidden = {
        let mut gpu = surface.gpu.borrow_mut();
        let SurfaceGpu { views, shown, .. } = &mut *gpu;
        let Some(views) = views.as_mut() else {
            return false;
        };
        let mut hidden = Vec::new();
        for view in shown.iter() {
            let size = view.state().frame.size;
            views.set_size(
                view.id(),
                size,
                crate::view::backing_scale_of(view.ns()) as f32,
            );
            let out = sight && !view.shown();
            views.set_hidden(view.id(), out);
            if out {
                hidden.push(view.clone());
            }
        }
        hidden
    };
    if !hidden.is_empty()
        && let Ok(mounter) = surface.mounter.try_borrow()
    {
        for view in &hidden {
            mounter.draw_when_shown(view, Damage::All);
        }
    }
    surface
        .gpu
        .borrow()
        .views
        .as_ref()
        .is_some_and(GpuViews::wants_frame)
}

/// Starts the display link's draw callback while a view wants a frame.
fn start(surface: &Rc<Surface>) {
    if surface.gpu.borrow().ticking || !sync(surface, false) {
        return;
    }
    surface.gpu.borrow_mut().ticking = true;
    surface.add_draw_callback(|surface, _| {
        let go_on = frame(surface);
        if !go_on {
            surface.gpu.borrow_mut().ticking = false;
        }
        go_on
    });
}

/// One frame of the clock: asks for the frames due, shows those done,
/// reports the events; whether to tick again.
fn frame(surface: &Rc<Surface>) -> bool {
    sync(surface, true);
    let mut new = Vec::new();
    let events = {
        let mut gpu = surface.gpu.borrow_mut();
        let SurfaceGpu { views, shown, .. } = &mut *gpu;
        let Some(views) = views.as_mut() else {
            return false;
        };
        views.tick(|id| new.push(id));
        for id in &new {
            let Some(view) = shown.iter().find(|v| v.id() == *id) else {
                continue;
            };
            let state = view.state();
            let Some(layer) = state.gpu.as_ref().map(|g| &g.layer) else {
                continue;
            };
            if views
                .with_surface(*id, |s| crate::shader::show_surface(layer, s))
                .is_none()
            {
                // No surface (no Metal device): the frame read back.
                views.with_frame(*id, |f| crate::shader::show_pixels(layer, f));
            }
        }
        views.take_events()
    };
    for (id, name, data) in events {
        surface.event(
            id,
            EventKind::NativeEvent,
            EventPayload::Native { name, data },
        );
    }
    surface
        .gpu
        .borrow()
        .views
        .as_ref()
        .is_some_and(GpuViews::wants_frame)
}
