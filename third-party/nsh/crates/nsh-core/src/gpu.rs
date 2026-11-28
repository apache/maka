//! GPU views: views whose box a renderer of the app's own draws with the GPU
//! (`GpuView` of `nsh`, Rust [`crate::element::gpu_view`]), each frame on a
//! thread of its own, composited by the platform under the view's children
//! as a shader's frames are.
//!
//! The renderers themselves (wgpu code) are the `nsh-gpu` crate's
//! `GpuRenderer`s; the core never names them. It carries a view's renderer
//! as a [`GpuSource`], an opaque handle `nsh-gpu` makes and reads back:
//! one a Rust element set, or one a UI set registered under a name
//! ([`crate::element::Registry::gpu_renderer_source`]), which TSX names
//! (`gpuView("gallery/scene", …)`). The view's own props, animated props
//! and events are a native component's ([`crate::Prop::ComponentProp`],
//! [`crate::Prop::ComponentPropBinding`], `onNativeEvent`), sent with
//! [`crate::MountItem::ComponentProps`] and
//! [`crate::MountItem::ComponentPropSlots`]; the renderer arrives with
//! [`crate::MountItem::GpuView`].

use std::{any::Any, fmt, sync::Arc};

/// What makes a GPU view's renderer: opaque to the core, made and read by
/// `nsh-gpu`. Cheap to clone; two sources are equal when they are the
/// same one.
#[derive(Clone)]
pub struct GpuSource(Arc<dyn Any + Send + Sync>);

impl GpuSource {
    /// Wraps `inner` (`nsh-gpu`'s factory).
    pub fn new(inner: impl Any + Send + Sync) -> Self {
        GpuSource(Arc::new(inner))
    }

    /// What [`Self::new`] wrapped, when it is a `T`.
    pub fn downcast_ref<T: Any>(&self) -> Option<&T> {
        self.0.downcast_ref()
    }
}

impl PartialEq for GpuSource {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}

impl fmt::Debug for GpuSource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("GpuSource")
    }
}
