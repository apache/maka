use std::sync::Arc;

use nsh_core::{Command, JsonValue};
use ratatui_core::{buffer::Buffer, layout::Rect};

/// An embedding app's native terminal content, drawn inside its assigned area.
pub trait NativeComponent {
    /// Draws into the surface's buffer, within `area`.
    fn render(&mut self, area: Rect, buffer: &mut Buffer);

    /// Applies changed properties; `None` removes a property.
    fn set_props(&mut self, props: &[(Arc<str>, Option<JsonValue>)]);

    /// Handles a command; returns false if it has no meaning for this component.
    fn command(&mut self, command: &Command) -> bool;
}

/// Creates a separate native widget for each mounted instance.
pub type ComponentFactory = Box<dyn Fn() -> Box<dyn NativeComponent>>;
