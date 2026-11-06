//! Input delivered by a terminal to the owning native surface.
use std::{ops::Range, sync::Arc, time::Instant};

use crate::{Bounds, DevicePixels, FrameToken, Point, Points, Size};

/// Keyboard modifiers in the terminal's logical event.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct Modifiers {
    /// Control modifier.
    pub control: bool,
    /// Alternate modifier.
    pub alt: bool,
    /// Shift modifier.
    pub shift: bool,
    /// Command/Super modifier.
    pub platform: bool,
    /// Function modifier.
    pub function: bool,
}
/// One physical key and its optional literal text.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct Keystroke {
    /// Modifiers.
    pub modifiers: Modifiers,
    /// Normalized key name.
    pub key: String,
    /// Literal terminal text, never reconstructed from a keyboard layout.
    pub key_char: Option<String>,
}
/// A native mouse button.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum MouseButton {
    /// Primary button.
    #[default]
    Left,
    /// Secondary button.
    Right,
    /// Middle button.
    Middle,
}
/// A key-down event.
#[derive(Clone, Debug, Default)]
#[non_exhaustive]
pub struct KeyDownEvent {
    /// Key and literal text.
    pub keystroke: Keystroke,
    /// Repeated physical key.
    pub is_held: bool,
    /// Whether a terminal requested literal character preference.
    pub prefer_character_input: bool,
}
/// A key-up event.
#[derive(Clone, Debug, Default)]
#[non_exhaustive]
pub struct KeyUpEvent {
    /// Released key.
    pub keystroke: Keystroke,
}
/// A pointer press in logical points.
#[derive(Clone, Debug, Default)]
#[non_exhaustive]
pub struct MouseDownEvent {
    /// Button.
    pub button: MouseButton,
    /// Position.
    pub position: Point<Points>,
    /// Modifiers.
    pub modifiers: Modifiers,
    /// Consecutive click count.
    pub click_count: usize,
    /// Activation click.
    pub first_mouse: bool,
}
/// A pointer release.
#[derive(Clone, Debug, Default)]
#[non_exhaustive]
pub struct MouseUpEvent {
    /// Button.
    pub button: MouseButton,
    /// Position.
    pub position: Point<Points>,
    /// Modifiers.
    pub modifiers: Modifiers,
    /// Click count.
    pub click_count: usize,
}
/// Pointer movement, including a captured drag outside the viewport.
#[derive(Clone, Debug, Default)]
#[non_exhaustive]
pub struct MouseMoveEvent {
    /// Position.
    pub position: Point<Points>,
    /// Held button.
    pub pressed_button: Option<MouseButton>,
    /// Modifiers.
    pub modifiers: Modifiers,
}
/// Scroll distances retain their source units.
#[derive(Clone, Debug)]
pub enum ScrollDelta {
    /// Wheel line distances.
    Lines(Point<f32>),
    /// Precise logical-point distances.
    Pixels(Point<Points>),
}
impl Default for ScrollDelta {
    fn default() -> Self {
        Self::Lines(Point::default())
    }
}
/// Scroll gesture phase.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum TouchPhase {
    /// Start.
    Started,
    /// Motion.
    #[default]
    Moved,
    /// End.
    Ended,
}
/// Wheel or precise scrolling.
#[derive(Clone, Debug, Default)]
#[non_exhaustive]
pub struct ScrollWheelEvent {
    /// Pointer position.
    pub position: Point<Points>,
    /// Modifiers.
    pub modifiers: Modifiers,
    /// Delta.
    pub delta: ScrollDelta,
    /// Gesture phase.
    pub touch_phase: TouchPhase,
}
/// Input routed through the platform's ordinary native handlers.
#[derive(Clone, Debug)]
pub enum PlatformInput {
    /// Key press.
    KeyDown(KeyDownEvent),
    /// Key release.
    KeyUp(KeyUpEvent),
    /// Pointer press.
    MouseDown(MouseDownEvent),
    /// Pointer release.
    MouseUp(MouseUpEvent),
    /// Pointer move.
    MouseMove(MouseMoveEvent),
    /// Scroll.
    ScrollWheel(ScrollWheelEvent),
}

/// Revocable identity of one focused editor, scoped to its native surface.
#[derive(Clone, Debug)]
pub struct TextInputTarget {
    issuer: Arc<()>,
    node: u64,
    generation: u64,
}
impl PartialEq for TextInputTarget {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.issuer, &other.issuer)
            && self.node == other.node
            && self.generation == other.generation
    }
}
impl Eq for TextInputTarget {}
impl TextInputTarget {
    /// Native node identity, meaningful only after admission validation.
    pub fn node(&self) -> u64 {
        self.node
    }
}
/// Focus changes revoke composition admission, including focus away and back.
#[derive(Default)]
#[non_exhaustive]
pub struct InputAdmissions {
    issuer: Arc<()>,
    generation: u64,
    target: Option<TextInputTarget>,
}
impl InputAdmissions {
    /// Updates focus using the native node identity; call with None on blur/removal/reload.
    pub fn focus(&mut self, node: Option<u64>) -> Option<TextInputTarget> {
        if self.target.as_ref().map(|t| t.node) != node {
            self.generation = self
                .generation
                .checked_add(1)
                .expect("input admission exhausted");
            self.target = node.map(|node| TextInputTarget {
                issuer: self.issuer.clone(),
                node,
                generation: self.generation,
            });
        }
        self.target.clone()
    }
    /// Latest native focus admission.
    pub fn target(&self) -> Option<TextInputTarget> {
        self.target.clone()
    }
    /// Whether an external composition still belongs to the focused editor.
    pub fn accepts(&self, target: &TextInputTarget) -> bool {
        self.target.as_ref() == Some(target)
    }
}

/// UI-thread-owned native offscreen surface. No method performs terminal IO.
pub trait NativeSurface {
    /// Physical viewport dimensions.
    fn viewport_size(&self) -> Size<DevicePixels>;
    /// Logical-point density.
    fn scale_factor(&self) -> f32;
    /// Visible native pressable bounds matching an accessibility label.
    fn pressable_bounds(&self, label: &str) -> Vec<Bounds<Points>>;
    /// Text in the focused native editor; secure fields must return None.
    fn editor_text(&self) -> Option<String>;
    /// Sets the host clipboard used by native paste shortcuts.
    fn set_clipboard_text(&self, text: &str);
    /// Delivers an authorized file drop through the native drop route.
    fn drop_paths(&self, paths: Vec<std::path::PathBuf>, position: Point<Points>);
    /// Updates the native editor selection in UTF-16 units.
    fn set_selected_text_range(&self, range: Range<usize>) -> Result<(), String>;
    /// Terminal focus state, independent of any desktop foreground window.
    fn is_active(&self) -> bool;
    /// Stops the app's engine while retaining the reusable native surface.
    fn stop(&self);
    /// Resize and revoke old frame receipts.
    fn set_viewport(&self, size: Size<DevicePixels>, scale: f32) -> Result<(), String>;
    /// Drain native work, optionally capturing a changed frame.
    fn pump_with_draw(&self, draw: bool) -> bool;
    /// Dispatch through native input.
    fn dispatch_input(&self, input: PlatformInput) -> Result<(), String>;
    /// Set terminal focus.
    fn set_active(&self, active: bool) -> Result<(), String>;
    /// Cancel pointer capture on resize or focus loss.
    fn cancel_pointer(&self);
    /// Paste literal text through the native paste contract.
    fn paste(&self, event: nsh_core::PasteEvent) -> bool;
    /// Replace the app with the same explicitly supplied capabilities.
    fn load_with_config(&self, config: nsh_engine::EngineConfig);
    /// Fence pending application input before a Host reload.
    fn pause_input(&self, done: Box<dyn FnOnce(Result<(), String>)>);
    /// Reopen native input after an aborted reload.
    fn resume_input(&self);
    /// Current revocable input admission.
    fn text_input_target(&self) -> Option<TextInputTarget>;
    /// Apply commit/preedit only to the admitted editor; ranges are UTF-16.
    fn apply_composition(
        &self,
        target: &TextInputTarget,
        commit: &str,
        preedit: &str,
        selection: Option<Range<usize>>,
        active: bool,
    ) -> Result<bool, String>;
    /// Logical caret bounds.
    fn input_caret_bounds(&self) -> Option<Bounds<Points>>;
    /// Logical IME candidate anchor.
    fn input_candidate_bounds(&self) -> Option<Bounds<Points>>;
    /// Native clipboard write for terminal transport.
    fn take_clipboard_write(&self) -> Option<String>;
    /// Checks whether a capture survived app reload and viewport changes.
    fn frame_is_current(&self, token: &FrameToken) -> bool;
    /// Validate the sole output owner's receipt.
    fn mark_presented(&self, token: FrameToken) -> Result<(), String>;
    /// Retrieve a native failure without swallowing it.
    fn take_error(&self) -> Option<String>;
    /// Native close intent.
    fn is_quit_requested(&self) -> bool;
    /// Whether native work is ready.
    fn has_pending(&self) -> bool;
    /// Next native animation/timer deadline.
    fn next_deadline(&self) -> Option<Instant>;
    /// Join/release the engine and native resources.
    fn shutdown(&self);
}
