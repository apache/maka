//! Native Shell surfaces embedded in a terminal grid.
//!
//! The embedding app owns the terminal and event loop. Each [`AppView`]
//! runs an engine, applies complete commits during rendering, and draws
//! into the area supplied by the app. [`CellTextEngine`] measures on the
//! same fixed grid that drawing and input use.

mod app;
mod canvas;
mod dialog;
mod geometry;
mod gradient;
mod image;
mod input;
mod key_scheme;
mod keyboard;
mod menu;
mod mount;
mod native;
mod navigation;
mod palette;
mod perf;
mod render;
#[cfg(feature = "run-app")]
mod run;
mod scrollbar;
mod search;
mod selection;
mod surface;
mod text;
mod text_input;
mod view;

pub use nsh_core::platform::{Appearance, Locale};
pub use nsh_engine::{App, AppError, Bundle, CacheOptions, HostChannel, Limits, Root};
pub use perf::{FrameMetrics, MeasuredBackend, MeasuredWriter};

#[cfg(feature = "run-app")]
pub use crate::run::{RunEvent, run_app};
pub use crate::{
    app::{
        AccessibleNode, AppOptions, AppView, ColorDepth, InputContext, TerminalCapabilities,
        WakeCallback,
    },
    geometry::CellSize,
    image::{ImageProtocol, ProtocolType},
    input::{CursorStyle, Handled, Input, Modifiers, MouseButton, MouseInput, MouseKind},
    native::{ComponentFactory, NativeComponent},
    text::{CellTextEngine, PreparedText},
};
