//! Public terminal surface and cell text contracts.

mod text;
mod text_input;

mod alignment;
#[cfg(feature = "js")]
mod animation;
mod app;

mod canvas;
mod controls;
mod data_table;
mod degraded;
mod diff_view;
mod dock;
mod editor;
mod focus_navigation;
mod geometry;
mod image;
mod keyboard;
mod menu_bar;
mod modal_focus;
mod navigation;
mod painting;
mod palette;
mod performance;
mod pointer;
mod popup;
mod scroll;
mod search;
mod tooltip;

/// The platform's accent in a terminal of true color on a dark page (the
/// tests' default), the brand indigo; ANSI blue at 16 and 256 colors.
pub(crate) const ACCENT: ratatui_core::style::Color =
    ratatui_core::style::Color::Rgb(0x8f, 0x9b, 0xff);
