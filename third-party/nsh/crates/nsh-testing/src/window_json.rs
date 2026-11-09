//! A window's state ([`WindowState`]) as the test agent of a real host
//! answers `app.window(id).state()` (`TestStep::WindowState`): the TS
//! `WindowState` object as JSON, `null` while the window is not open.

use nsh_core::desktop::WindowState;
use serde_json::Value;

/// `state` as the TS `WindowState` object.
#[cfg(feature = "agent")]
pub(crate) fn to_json(state: &WindowState) -> Value {
    serde_json::json!({
        "mode": state.mode,
        "minimized": state.minimized,
        "visible": state.visible,
        "focused": state.focused,
        "bounds": state.bounds,
        "contentBounds": state.content_bounds,
        "placement": state.placement,
        "display": state.display.map(|d| format!("{:016x}", d.0)),
        "scaleFactor": state.scale_factor,
    })
}

/// The state [`to_json`] wrote; `None` for `null`.
#[cfg(feature = "js")]
pub(crate) fn from_json(value: Value) -> Result<Option<WindowState>, String> {
    use nsh_core::{
        desktop::{DisplayId, WindowMode, WindowPlacement},
        geometry::{Bounds, Points},
    };
    use serde::Deserialize;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Wire {
        mode: WindowMode,
        minimized: bool,
        visible: bool,
        focused: bool,
        bounds: Bounds<Points>,
        content_bounds: Bounds<Points>,
        placement: WindowPlacement,
        display: Option<String>,
        scale_factor: f32,
    }
    if value.is_null() {
        return Ok(None);
    }
    let wire: Wire = serde_json::from_value(value)
        .map_err(|e| format!("the host sent an odd window state: {e}"))?;
    let mut state = WindowState::new(wire.bounds, wire.placement);
    state.mode = wire.mode;
    state.minimized = wire.minimized;
    state.visible = wire.visible;
    state.focused = wire.focused;
    state.content_bounds = wire.content_bounds;
    state.display = wire
        .display
        .and_then(|d| u64::from_str_radix(&d, 16).ok())
        .map(DisplayId);
    state.scale_factor = wire.scale_factor;
    Ok(Some(state))
}

#[cfg(all(test, feature = "agent", feature = "js"))]
mod tests {
    use nsh_core::{
        desktop::{DisplayId, WindowMode, WindowPlacement},
        geometry::{Bounds, point, px, size},
    };

    use super::*;

    #[test]
    fn a_state_goes_over_the_wire_and_back() {
        let bounds = Bounds::new(point(px(24.0), px(500.5)), size(px(220.0), px(140.0)));
        let mut state = WindowState::new(bounds, WindowPlacement::new(WindowMode::Normal, bounds));
        state.mode = WindowMode::Maximized;
        state.focused = true;
        state.display = Some(DisplayId(0xab));
        state.scale_factor = 2.0;
        let json = to_json(&state);
        assert_eq!(json["mode"], "maximized");
        assert_eq!(json["contentBounds"]["size"]["width"], 220.0);
        assert_eq!(json["display"], "00000000000000ab");
        assert_eq!(from_json(json).unwrap(), Some(state));
        assert_eq!(from_json(Value::Null).unwrap(), None);
    }
}
