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

pub use crate::shader_frame::{Frame, MAX_SIDE, PixelFormat};

/// Never made: this build has no renderer.
pub struct Renderer {
    format: PixelFormat,
}

impl Renderer {
    /// `None`: this build has no renderer.
    pub fn new(_format: PixelFormat) -> Option<Renderer> {
        None
    }

    /// The format of the frames.
    pub fn format(&self) -> PixelFormat {
        self.format
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

    /// `false`: there are no frames.
    pub fn pending(&self) -> bool {
        false
    }

    /// The empty frame.
    pub fn frame(&self) -> &Frame {
        &self.frame
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
