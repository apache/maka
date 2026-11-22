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
