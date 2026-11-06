//! Backend-independent native pixel frames and terminal graphics protocols.
//!
//! Native surfaces own UI state. The terminal output owner alone acknowledges
//! presentation; rendering and encoding never confer presentation authority.

pub mod inline;
mod input;
pub mod kitty;
mod wire;
pub use input::*;
pub use nsh_core::geometry::{Bounds, DevicePixels, Point, Points, Size, point, px, size};
/// Logical points, retained for terminal input geometry.
pub type Pixels = Points;

use std::{
    hash::{Hash, Hasher},
    sync::Arc,
};

/// Identity of one draw from one surface and viewport generation.
#[derive(Clone, Debug, Default)]
#[non_exhaustive]
pub struct FrameToken {
    pub(crate) issuer: Option<Arc<()>>,
    pub(crate) sequence: u64,
    pub(crate) viewport_generation: u64,
}
impl FrameToken {
    /// Creates an inert diagnostic token, never accepted as a presentation.
    pub fn inert(sequence: u64) -> Self {
        Self {
            sequence,
            ..Self::default()
        }
    }
    /// Monotonic draw sequence.
    pub fn sequence(&self) -> u64 {
        self.sequence
    }
    /// Viewport generation at capture.
    pub fn viewport_generation(&self) -> u64 {
        self.viewport_generation
    }
}
impl PartialEq for FrameToken {
    fn eq(&self, other: &Self) -> bool {
        self.sequence == other.sequence
            && self.viewport_generation == other.viewport_generation
            && match (&self.issuer, &other.issuer) {
                (Some(a), Some(b)) => Arc::ptr_eq(a, b),
                (None, None) => true,
                _ => false,
            }
    }
}
impl Eq for FrameToken {}
impl Hash for FrameToken {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.issuer.as_ref().map(Arc::as_ptr).hash(state);
        self.sequence.hash(state);
        self.viewport_generation.hash(state);
    }
}

/// Native RGBA capture, owned independently of the mutable UI surface.
#[derive(Default)]
#[non_exhaustive]
pub struct PreparedFrame {
    frame: CandidateFrame,
}
impl PreparedFrame {
    /// Capture identity.
    pub fn token(&self) -> FrameToken {
        self.frame.token()
    }
    /// Physical pixel dimensions.
    pub fn size(&self) -> Size<DevicePixels> {
        self.frame.size
    }
    /// Tightly packed RGBA byte count.
    pub fn pixel_len(&self) -> usize {
        self.frame.pixels.len()
    }
    /// Transfers a native capture to the background encoder. No GPU work is implied.
    pub fn submit(self) -> anyhow::Result<SubmittedFrame> {
        Ok(SubmittedFrame { frame: self.frame })
    }
}
/// Owned native capture transferred to the background encoder.
#[derive(Default)]
#[non_exhaustive]
pub struct SubmittedFrame {
    frame: CandidateFrame,
}
impl SubmittedFrame {
    /// Capture identity.
    pub fn token(&self) -> FrameToken {
        self.frame.token()
    }
    /// Physical pixel dimensions.
    pub fn size(&self) -> Size<DevicePixels> {
        self.frame.size
    }
    /// Tightly packed RGBA byte count.
    pub fn pixel_len(&self) -> usize {
        self.frame.pixels.len()
    }
    /// Returns the completed capture without sampling mutable application state.
    pub fn complete(self) -> anyhow::Result<CandidateFrame> {
        Ok(self.frame)
    }
}
/// Straight RGBA8, top-down, awaiting the output owner's admission.
#[derive(Debug, Default)]
#[non_exhaustive]
pub struct CandidateFrame {
    pub(crate) token: FrameToken,
    pub(crate) size: Size<DevicePixels>,
    pub(crate) pixels: Vec<u8>,
}
impl CandidateFrame {
    /// Capture identity.
    pub fn token(&self) -> FrameToken {
        self.token.clone()
    }
    /// Physical pixel dimensions.
    pub fn size(&self) -> Size<DevicePixels> {
        self.size
    }
    /// Tightly packed straight RGBA8 bytes.
    pub fn pixels(&self) -> &[u8] {
        &self.pixels
    }
}

/// Per-surface issuance and presentation ledger. Resize revokes old captures.
#[derive(Default)]
#[non_exhaustive]
pub struct FrameClock {
    issuer: Arc<()>,
    sequence: u64,
    generation: u64,
    size: Size<DevicePixels>,
    scale: f32,
    presented: Option<FrameToken>,
}
impl FrameClock {
    /// Validates geometry and revokes captures when physical size or density changes.
    pub fn set_viewport(&mut self, size: Size<DevicePixels>, scale: f32) -> Result<(), String> {
        rgba_len(size).map_err(|e| e.to_string())?;
        if !scale.is_finite() || scale <= 0.0 {
            return Err("invalid terminal pixel scale".into());
        }
        if size != self.size || scale != self.scale {
            self.generation = self
                .generation
                .checked_add(1)
                .ok_or("viewport generation exhausted")?;
            self.size = size;
            self.scale = scale;
            self.presented = None;
        }
        Ok(())
    }
    /// Revokes all outstanding captures when an app reloads or shuts down.
    pub fn revoke(&mut self) {
        self.generation = self
            .generation
            .checked_add(1)
            .expect("viewport generation exhausted");
        self.presented = None;
    }
    /// Current device-pixel dimensions.
    pub fn size(&self) -> Size<DevicePixels> {
        self.size
    }
    /// Current logical-to-device scale.
    pub fn scale(&self) -> f32 {
        self.scale
    }
    /// Issues only a validated complete capture of the current viewport.
    pub fn prepare(&mut self, pixels: Vec<u8>) -> Result<PreparedFrame, String> {
        if pixels.len() != rgba_len(self.size).map_err(|e| e.to_string())? {
            return Err("native capture size mismatch".into());
        }
        self.sequence = self
            .sequence
            .checked_add(1)
            .ok_or("frame sequence exhausted")?;
        Ok(PreparedFrame {
            frame: CandidateFrame {
                token: FrameToken {
                    issuer: Some(self.issuer.clone()),
                    sequence: self.sequence,
                    viewport_generation: self.generation,
                },
                size: self.size,
                pixels,
            },
        })
    }
    /// Whether the capture still belongs to this loaded surface and viewport.
    pub fn is_current(&self, token: &FrameToken) -> bool {
        token
            .issuer
            .as_ref()
            .is_some_and(|i| Arc::ptr_eq(i, &self.issuer))
            && token.sequence != 0
            && token.sequence <= self.sequence
            && token.viewport_generation == self.generation
    }
    /// Records an output-owner receipt, refusing foreign, stale and regressing tokens.
    pub fn mark_presented(&mut self, token: FrameToken) -> Result<(), String> {
        if !token
            .issuer
            .as_ref()
            .is_some_and(|i| Arc::ptr_eq(i, &self.issuer))
            || token.sequence == 0
            || token.sequence > self.sequence
            || token.viewport_generation != self.generation
            || self
                .presented
                .as_ref()
                .is_some_and(|p| token.sequence < p.sequence)
        {
            return Err("stale or foreign native frame receipt".into());
        }
        self.presented = Some(token);
        Ok(())
    }
    /// Last admitted output receipt, not input authority.
    pub fn presented(&self) -> Option<FrameToken> {
        self.presented.clone()
    }
}

pub(crate) fn rgba_len(size: Size<DevicePixels>) -> anyhow::Result<usize> {
    let width = usize::try_from(size.width.0)?;
    let height = usize::try_from(size.height.0)?;
    anyhow::ensure!(
        width > 0 && height > 0 && width <= 16384 && height <= 16384,
        "invalid terminal viewport dimensions"
    );
    let bytes = width
        .checked_mul(height)
        .and_then(|n| n.checked_mul(4))
        .ok_or_else(|| anyhow::anyhow!("terminal pixel dimensions overflow"))?;
    anyhow::ensure!(
        bytes <= 256 * 1024 * 1024,
        "terminal viewport exceeds capture memory budget"
    );
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn clock() -> FrameClock {
        let mut clock = FrameClock::default();
        clock
            .set_viewport(size(DevicePixels(2), DevicePixels(2)), 1.0)
            .unwrap();
        clock
    }
    #[test]
    fn receipts_require_current_surface_and_geometry() {
        let mut clock = clock();
        let mut other = self::clock();
        let first = clock.prepare(vec![0; 16]).unwrap().token();
        assert!(other.mark_presented(first.clone()).is_err());
        assert!(
            clock
                .mark_presented(FrameToken::inert(first.sequence()))
                .is_err()
        );
        clock.mark_presented(first.clone()).unwrap();
        clock
            .set_viewport(size(DevicePixels(2), DevicePixels(2)), 2.0)
            .unwrap();
        assert!(clock.presented().is_none());
        assert!(clock.mark_presented(first).is_err());
        let new = clock.prepare(vec![0; 16]).unwrap().token();
        clock.mark_presented(new.clone()).unwrap();
        assert_eq!(clock.presented(), Some(new));
    }
    #[test]
    fn captured_pixels_and_identity_survive_background_transfer() {
        let mut clock = clock();
        let pixels = (0..16).collect::<Vec<_>>();
        let prepared = clock.prepare(pixels.clone()).unwrap();
        let token = prepared.token();
        let candidate = std::thread::spawn(move || prepared.submit().unwrap().complete().unwrap())
            .join()
            .unwrap();
        assert_eq!(candidate.token(), token);
        assert_eq!(candidate.pixels(), pixels);
        assert!(clock.presented().is_none());
        clock.mark_presented(token).unwrap();
    }
    #[test]
    fn receipt_cannot_regress_and_bad_capture_does_not_issue_a_frame() {
        let mut clock = clock();
        assert!(clock.prepare(vec![0; 15]).is_err());
        let first = clock.prepare(vec![0; 16]).unwrap().token();
        let second = clock.prepare(vec![0; 16]).unwrap().token();
        assert_eq!(first.sequence(), 1);
        clock.mark_presented(second.clone()).unwrap();
        assert!(clock.mark_presented(first).is_err());
        assert_eq!(clock.presented(), Some(second));
    }
    #[test]
    fn bounds_and_focus_are_validated_before_admission() {
        let mut clock = clock();
        for scale in [0.0, -1.0, f32::NAN, f32::INFINITY] {
            assert!(
                clock
                    .set_viewport(size(DevicePixels(2), DevicePixels(2)), scale)
                    .is_err()
            );
        }
        assert!(
            clock
                .set_viewport(size(DevicePixels(i32::MAX), DevicePixels(2)), 1.0)
                .is_err()
        );
        let mut input = InputAdmissions::default();
        let first = input.focus(Some(2)).unwrap();
        assert!(input.accepts(&first));
        assert_eq!(input.focus(Some(2)), Some(first.clone()));
        input.focus(None);
        let second = input.focus(Some(2)).unwrap();
        assert_ne!(first, second);
        assert!(!input.accepts(&first));
        let mut other = InputAdmissions::default();
        other.focus(Some(2));
        assert!(!other.accepts(&second));
    }
}
