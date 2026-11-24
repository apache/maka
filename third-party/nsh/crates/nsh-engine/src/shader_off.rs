//! The native backends' shader API without the renderer (feature `shader` off):
//! no GPU is ever found ([`Renderer::new`] is `None`), so shader views draw
//! nothing of their own, and wgpu is not linked. The backends' code stays the
//! same either way.

use std::{
    sync::Arc,
    time::{Duration, Instant},
};

use nsh_core::{
    animation::AnimationValue,
    geometry::{Points, Size},
    shader::{ShaderInput, ShaderLayer},
};

#[cfg(windows)]
pub use crate::shader_frame::SharedTexture;
pub use crate::shader_frame::{Frame, MAX_SIDE, PixelFormat};

/// This build has no renderer: a platform reports `Environment::shaders`
/// `false` from the start.
pub const LINKED: bool = false;

/// No renderer ever looks for a GPU here.
pub(crate) fn no_gpu() -> bool {
    false
}

/// Never made: this build has no renderer.
pub struct Renderer {
    format: PixelFormat,
}

impl Renderer {
    /// `None`: this build has no renderer.
    pub fn new(_format: PixelFormat) -> Option<Renderer> {
        static WARNED: std::sync::Once = std::sync::Once::new();
        WARNED.call_once(|| {
            log::warn!(
                "a shader view draws nothing: this runtime was built without the NSH platform crate's feature `shader`"
            )
        });
        None
    }

    /// Calls `done(None)` at once: this build has no renderer.
    pub fn open(_format: PixelFormat, done: impl FnOnce(Option<Renderer>) + Send + 'static) {
        done(None);
    }

    /// Does nothing: no pipeline is ever compiled (`f` is dropped).
    pub fn on_pipeline_ready(&self, f: impl Fn() + Send + Sync + 'static) {
        drop(f);
    }

    /// `false`: no pipeline is ever compiled.
    pub fn compiling(&self) -> bool {
        false
    }

    /// `true` at once: no pipeline is ever compiled.
    pub fn wait_for_pipelines(&self, _timeout: Duration) -> bool {
        true
    }

    /// The format of the frames.
    pub fn format(&self) -> PixelFormat {
        self.format
    }

    /// `false`: there are no frames (`f` is dropped).
    pub fn when_done(&self, f: impl FnOnce() + Send + 'static) -> bool {
        drop(f);
        false
    }
}

/// One view's state, which never renders.
#[derive(Default)]
pub struct ShaderView {
    layer: Option<Arc<ShaderLayer>>,
    frame: Frame,
}

impl ShaderView {
    /// Keeps `layer`.
    pub fn set_layer(&mut self, layer: Option<Arc<ShaderLayer>>) {
        self.layer = layer;
    }

    /// Does nothing.
    pub fn set_input(
        &mut self,
        _renderer: &Renderer,
        _input: ShaderInput,
        _picture: Option<(&[u8], u32, u32, u32)>,
    ) {
    }

    /// `false`: there is no frame.
    pub fn set_input_from_frame(&mut self, _renderer: &Renderer, _input: ShaderInput) -> bool {
        false
    }

    /// `false`: nothing is kept.
    pub fn has_input(&self, _input: ShaderInput) -> bool {
        false
    }

    /// Does nothing: a transition ends at once.
    pub fn start_transition(&mut self, _duration: Duration, _now: Instant) {}

    /// Does nothing: a transition ends at once.
    pub fn start_transition_backwards(&mut self, _duration: Duration, _now: Instant) {}

    /// `false`: a transition ends at once.
    pub fn transitioning(&mut self, _now: Instant) -> bool {
        false
    }

    /// `false`: the children stay.
    pub fn replaces_children(&mut self, _now: Instant) -> bool {
        false
    }

    /// Nothing is drawn beyond the box.
    pub fn overflow(&self) -> Points {
        Points(0.0)
    }

    /// The layer it was given.
    pub fn layer(&self) -> Option<&Arc<ShaderLayer>> {
        self.layer.as_ref()
    }

    /// Does nothing.
    pub fn set_slot(&mut self, _slot: u16, _value: AnimationValue) {}

    /// Does nothing.
    pub fn set_size(&mut self, _size: Size<Points>, _scale: f32) {}

    /// `false`: there are no frames.
    pub fn wants_frame(&self) -> bool {
        false
    }

    /// `false`: nothing compiles.
    pub fn compiling(&self) -> bool {
        false
    }

    /// `false`: there are no frames.
    pub fn pending(&self) -> bool {
        false
    }

    /// `false`: there are no frames.
    pub fn due(&self) -> bool {
        false
    }

    /// `false`: there are no frames.
    pub fn animates(&self) -> bool {
        false
    }

    /// The empty frame.
    pub fn frame(&self) -> &Frame {
        &self.frame
    }

    /// Does nothing: there are no frames.
    #[cfg(any(target_vendor = "apple", windows))]
    pub fn show_on_surfaces(&mut self, _on: bool) {}

    /// `None`: there are no frames.
    #[cfg(windows)]
    pub fn surface(&self) -> Option<SharedTexture> {
        None
    }

    /// `None`: there are no frames.
    #[cfg(target_vendor = "apple")]
    pub fn surface(&self) -> Option<&objc2_io_surface::IOSurfaceRef> {
        None
    }

    /// `false`: there are no frames.
    pub fn collect_frame(&mut self, _renderer: &Renderer) -> bool {
        false
    }

    /// `false`: there are no frames.
    pub fn render(&mut self, _renderer: &Renderer, _now: Instant) -> bool {
        false
    }
}
