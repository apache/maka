//! Native Shell in a terminal, using the shared engine and Taffy layout.
//!
//! Mount batches update a retained surface. Text is measured on the engine
//! thread in virtual points and rendered as terminal cells. Ratatui owns
//! buffer differences; an embedding host keeps control of terminal IO.

mod app;
mod canvas;
mod composite;
mod editor;
mod fonts;
mod geometry;
mod image;
mod image_state;
mod input;
mod media;
mod metrics;
mod motion;
mod native;
mod navigation;
mod net;
mod protocol;
mod render;
mod script;
mod scroll;
mod selection_area;
mod services;
mod surface;
mod text;
mod worker;

pub use crossterm;
pub use nsh_core::platform::Appearance;
pub use nsh_engine::{App, Bundle, Limits, Root};
pub use ratatui;
pub use ratatui_image;

pub use crate::{
    app::{AppOptions, AppSource, AppView, AssetBase, init_logging, run_app, set_ui_sets},
    input::{InputContext, InputEdit},
    metrics::CellMetrics,
    native::{
        ComponentContext, ComponentEvent, ComponentFactory, ComponentResponse, Components,
        NativeComponent,
    },
    protocol::{ImageProtocol, ProtocolType},
    services::{
        AccessibleNode, ClipboardContent, HostServices, ServiceCancellation, ServiceOutput,
        ServiceRequest, SystemServices,
    },
    surface::{Surface, SurfaceEvent},
    text::TerminalTextEngine,
};
