//! `nsh`'s `setFpsEnabled`: the platform's performance monitor, turned on
//! and off by the app (the macOS panel, the other platforms' `nsh::fps`
//! lines; `--fps` and `NSH_FPS=1` turn it on at launch). `fpsEnabled()`,
//! what the platform did, is `nsh-js`'s accessor (`env.rs`).

use crate::element::{ModuleCx, module, services};

/// The performance monitor: frame rate, frame and commit costs, CPU and
/// memory, measured while the app runs.
#[module]
pub(crate) struct Fps;

#[module(flat)]
impl Fps {
    /// Turns the performance monitor on or off: a panel at the top right
    /// of the app on macOS, one `nsh::fps` log line a second on iOS,
    /// Windows, Linux and GPUI, a status line in the terminal. Platforms
    /// without a monitor ignore it; `fpsEnabled()` follows what the
    /// platform did.
    pub(crate) fn set_fps_enabled(enabled: bool, cx: &mut ModuleCx) {
        cx.act(services::perf_monitor(enabled));
    }
}
