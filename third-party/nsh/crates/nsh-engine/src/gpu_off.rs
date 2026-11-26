//! GPU views' runtime without wgpu (feature `shader` off): the same API, no
//! render thread and no GPU, so GPU views draw nothing of their own. The
//! backends' code stays the same either way.

use std::sync::Arc;

use nsh_core::{
    JsonValue, NodeId,
    animation::AnimatedPropValue,
    geometry::{Points, Size},
    gpu::GpuSource,
};

#[cfg(windows)]
use crate::shader_frame::SharedTexture;
use crate::shader_frame::{Frame, PixelFormat};

/// The GPU views of a surface, in a build without wgpu: they draw nothing.
pub struct GpuViews {
    warned: bool,
}

impl GpuViews {
    /// No views; this build renders none.
    pub fn new(format: PixelFormat) -> Self {
        let _ = format;
        Self { warned: false }
    }

    /// Never called: no render thread runs.
    pub fn on_ready(&self, f: impl Fn() + Send + Sync + 'static) {
        drop(f);
    }

    /// Says once that this build draws no GPU views.
    pub fn set(&mut self, id: NodeId, source: Option<GpuSource>) {
        if source.is_some() && !std::mem::replace(&mut self.warned, true) {
            log::warn!(
                "GPU view {id}: this build has no GPU renderer (feature `shader`); GPU views draw nothing"
            );
        }
    }

    /// Ignored.
    pub fn set_props(&mut self, id: NodeId, props: &[(Arc<str>, Option<JsonValue>)]) {
        let _ = (id, props);
    }

    /// Ignored.
    pub fn set_animated(&mut self, id: NodeId, name: &str, value: AnimatedPropValue) {
        let _ = (id, name, value);
    }

    /// Never: no view is made.
    pub fn has(&self, id: NodeId) -> bool {
        let _ = id;
        false
    }

    /// Ignored.
    pub fn set_hidden(&mut self, id: NodeId, hidden: bool) {
        let _ = (id, hidden);
    }

    /// Ignored.
    pub fn set_size(&mut self, id: NodeId, size: Size<Points>, scale: f32) {
        let _ = (id, size, scale);
    }

    /// Ignored.
    #[cfg(any(target_vendor = "apple", windows))]
    pub fn show_on_surfaces(&mut self, id: NodeId, on: bool) {
        let _ = (id, on);
    }

    /// Ignored.
    pub fn remove(&mut self, id: NodeId) {
        let _ = id;
    }

    /// Never: nothing renders.
    pub fn wants_frame(&self) -> bool {
        false
    }

    /// Nothing to do.
    pub fn tick(&mut self, f: impl FnMut(NodeId)) {
        drop(f);
    }

    /// None.
    pub fn take_events(&mut self) -> Vec<(NodeId, Arc<str>, JsonValue)> {
        Vec::new()
    }

    /// None.
    pub fn with_frame<T>(&self, id: NodeId, f: impl FnOnce(&Frame) -> T) -> Option<T> {
        let _ = (id, f);
        None
    }

    /// None.
    #[cfg(windows)]
    pub fn surface(&self, id: NodeId) -> Option<SharedTexture> {
        let _ = id;
        None
    }

    /// None.
    #[cfg(target_vendor = "apple")]
    pub fn with_surface<T>(
        &self,
        id: NodeId,
        f: impl FnOnce(&objc2_io_surface::IOSurfaceRef) -> T,
    ) -> Option<T> {
        let _ = (id, f);
        None
    }
}
