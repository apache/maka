//! GPU views: views whose box a renderer of the app's own draws with wgpu
//! ([`nsh_core::gpu`], `MountItem::GpuView`), on the surface's render
//! thread (`nsh_engine::gpu`), shown as a texture under the children.
//!
//! The surface keeps one [`GpuViews`] (made with the first GPU view, which
//! starts the render thread). While any view wants a frame, a tick
//! callback on the root asks for the frames due on every frame of the
//! clock, at each view's size and the surface's scale, and collects the
//! frames read back: each becomes a `GdkMemoryTexture` its view draws,
//! clipped to its rounded box as a background is ([`draw`]). A view out of
//! sight (outside a clipping ancestor or the window) renders nothing until
//! it comes into sight again ([`reveal`]). The renderers' events reach the
//! app as the views' `NativeEvent`s.

use std::rc::Rc;

use gtk4::{self as gtk, gdk, glib, prelude::*};
use nsh_core::{
    EventKind, EventPayload, JsonValue, NodeId,
    animation::AnimatedPropValue,
    geometry::{Points, size},
    gpu::GpuSource,
};
use nsh_engine::gpu::GpuViews;

use crate::{
    surface::Surface,
    view::{NshView, ViewState},
};

/// What a GPU view shows.
#[derive(Default)]
pub(crate) struct GpuState {
    texture: Option<gdk::MemoryTexture>,
}

/// The surface's GPU views, and whether its tick callback runs.
#[derive(Default)]
pub(crate) struct SurfaceGpu {
    views: Option<GpuViews>,
    /// The GPU views, to size them and tell those out of sight.
    shown: Vec<glib::WeakRef<NshView>>,
    ticking: bool,
    /// The surface, for its tick callback (set with the first view).
    surface: std::rc::Weak<Surface>,
}

impl SurfaceGpu {
    fn views(&mut self) -> &mut GpuViews {
        self.views
            .get_or_insert_with(|| GpuViews::new(nsh_engine::shader::PixelFormat::Rgba))
    }
}

/// Mounts `source`'s renderer on `view` (`None`: it draws nothing of its
/// own).
pub(crate) fn set(surface: &Rc<Surface>, view: &NshView, source: Option<GpuSource>) {
    {
        let mut state = view.state_mut();
        let gpu = state.gpu.get_or_insert_with(Default::default);
        if source.is_none() {
            gpu.texture = None;
        }
    }
    {
        let mut gpu = surface.gpu.borrow_mut();
        gpu.surface = Rc::downgrade(surface);
        if !gpu.shown.iter().any(|w| w.upgrade().as_ref() == Some(view)) {
            gpu.shown.push(view.downgrade());
        }
        gpu.views().set(view.id(), source);
    }
    view.redraw();
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
    props: &[(std::sync::Arc<str>, Option<JsonValue>)],
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
pub(crate) fn animated(
    surface: &Surface,
    moved: &mut Vec<(NodeId, std::sync::Arc<str>, AnimatedPropValue)>,
) {
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
    if any {
        start(surface);
    }
}

/// Its size changed: a frame of the new size is rendered.
pub(crate) fn resized(surface: &Rc<Surface>, view: &NshView) {
    if view.state().gpu.is_some() {
        start(surface);
    }
}

/// `view` was deleted: its renderer goes.
pub(crate) fn deleted(surface: &Rc<Surface>, view: &NshView) {
    if view.state().gpu.is_none() {
        return;
    }
    let mut gpu = surface.gpu.borrow_mut();
    gpu.shown
        .retain(|w| w.upgrade().is_some_and(|v| v != *view));
    if let Some(views) = gpu.views.as_mut() {
        views.remove(view.id());
    }
}

/// Sizes the views, tells those out of sight; `true` when one wants a
/// frame.
fn sync(surface: &Surface) -> bool {
    let mut gpu = surface.gpu.borrow_mut();
    let SurfaceGpu { views, shown, .. } = &mut *gpu;
    let Some(views) = views.as_mut() else {
        return false;
    };
    shown.retain(|weak| {
        let Some(view) = weak.upgrade() else {
            return false;
        };
        let frame = view.state().frame.size;
        views.set_size(
            view.id(),
            size(Points(frame.width.0), Points(frame.height.0)),
            crate::shader::scale_of(&view),
        );
        views.set_hidden(
            view.id(),
            !view.is_mapped() || !crate::canvas::in_sight(&view),
        );
        true
    });
    views.wants_frame()
}

/// Starts the root's tick callback while a view wants a frame.
fn start(surface: &Surface) {
    if surface.gpu.borrow().ticking || !sync(surface) {
        return;
    }
    let weak = {
        let mut gpu = surface.gpu.borrow_mut();
        gpu.ticking = true;
        gpu.surface.clone()
    };
    surface.root.add_tick_callback(move |_, _| {
        let go_on = weak.upgrade().is_some_and(|s| frame(&s));
        if go_on {
            glib::ControlFlow::Continue
        } else {
            if let Some(surface) = weak.upgrade() {
                surface.gpu.borrow_mut().ticking = false;
            }
            glib::ControlFlow::Break
        }
    });
}

/// One frame of the clock: asks for the frames due, shows those done,
/// reports the events; whether to tick again.
fn frame(surface: &Rc<Surface>) -> bool {
    sync(surface);
    let mut new = Vec::new();
    let events = {
        let mut gpu = surface.gpu.borrow_mut();
        let Some(views) = gpu.views.as_mut() else {
            return false;
        };
        views.tick(|id| new.push(id));
        for id in &new {
            let texture = views
                .with_frame(*id, |f| {
                    (f.width > 0 && f.height > 0).then(|| {
                        gdk::MemoryTexture::new(
                            f.width as i32,
                            f.height as i32,
                            gdk::MemoryFormat::R8g8b8a8Premultiplied,
                            &glib::Bytes::from(&f.pixels[..]),
                            f.stride as usize,
                        )
                    })
                })
                .flatten();
            if let Some(view) = surface.mounter.borrow().views.get(id) {
                if let Some(gpu) = view.state_mut().gpu.as_mut() {
                    gpu.texture = texture;
                }
                view.redraw();
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

/// Starts the views that came into sight (every frame, after layout).
pub(crate) fn reveal(surface: &Rc<Surface>) {
    if surface.gpu.borrow().views.is_some() {
        start(surface);
    }
}

/// Draws a GPU view's last frame over its box, inside its rounded corners.
pub(crate) fn draw(snapshot: &gtk::Snapshot, state: &ViewState) {
    let Some(texture) = state.gpu.as_ref().and_then(|g| g.texture.as_ref()) else {
        return;
    };
    let size = state.frame.size;
    if size.width.0 <= 0.0 || size.height.0 <= 0.0 {
        return;
    }
    crate::decor::push_clip(snapshot, state);
    snapshot.append_texture(
        texture,
        &gtk4::graphene::Rect::new(0.0, 0.0, size.width.0, size.height.0),
    );
    snapshot.pop();
}

#[cfg(test)]
mod tests {
    use nsh_core::{MountItem, ROOT_ID, ViewKind};
    use nsh_gpu::{GpuFrame, GpuRenderer, wgpu};

    use super::*;
    use crate::gtk_test::{self, apply, frame};

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
    fn a_gpu_view_shows_its_renderers_frame() {
        let read = gtk_test::run(|| {
            let surface = gtk_test::surface();
            let window = gtk_test::show(&surface);
            let id: NodeId = 2;
            apply(
                &surface,
                &[
                    MountItem::Create {
                        id,
                        kind: ViewKind::View,
                    },
                    MountItem::Insert {
                        parent: ROOT_ID,
                        child: id,
                        before: None,
                    },
                    MountItem::Frame {
                        id,
                        frame: frame(0.0, 0.0, 40.0, 30.0),
                    },
                    MountItem::GpuView {
                        id,
                        source: Some(nsh_gpu::renderer_source(|| Red)),
                    },
                ],
            );
            let view = gtk_test::view(&surface, id);
            let shown = gtk_test::wait_until(|| {
                view.state()
                    .gpu
                    .as_ref()
                    .is_some_and(|g| g.texture.is_some())
            });
            window.close();
            if !shown {
                // No GPU answered: GPU views draw nothing of their own.
                return None;
            }
            let state = view.state();
            let texture = state.gpu.as_ref().and_then(|g| g.texture.clone())?;
            let mut pixels = vec![0_u8; texture.width() as usize * texture.height() as usize * 4];
            texture.download(&mut pixels, texture.width() as usize * 4);
            Some((texture.width(), pixels[..4].to_vec()))
        })
        .flatten();
        if let Some((width, first)) = read {
            assert!(width >= 40, "a frame of the view's pixels, not {width}");
            // GDK downloads as B8g8r8a8Premultiplied.
            assert_eq!(first, [0, 0, 255, 255]);
        }
    }
}
