//! Linux backend for nsh: GTK 4 widgets for views, Pango for text.
//!
//! - Each node is an [`view::NshView`] (a `gtk::Widget` subclass) placed
//!   at the frame the core laid out and drawn with GSK render nodes
//!   (background, borders, shadows, text glyphs, images); text fields,
//!   web views and videos are GTK widgets hosted in their node's view.
//! - The engine runs on its own thread ([`nsh_engine::Engine`]); each
//!   commit is one hop to the GTK main loop ([`surface`]).
//! - Text is shaped and broken into lines by Pango on the engine thread;
//!   the main thread only draws the glyph runs it produced ([`text`]).
//! - Native animations run on the root's frame clock ([`animation`]).
//!
//! [`AppView`] is one surface as a widget (for embedding); [`run_app`]
//! opens one in a window. Off Linux this crate is empty.

#![cfg(target_os = "linux")]

mod access;
#[cfg(feature = "dev")]
mod agent;
mod animation;
mod app;
mod canvas;
mod chrome;
mod decor;
#[cfg(feature = "dev")]
pub mod dev;
mod file_drop;
mod file_requests;
mod fps;
mod image;
mod input;
mod keymap;
mod menu_style;
mod mount;
mod native;
mod navigation;
mod scroll;
mod selectable_view;
mod shader;
mod surface;
#[cfg(feature = "dev")]
mod synth;
mod system;
mod text;
mod text_input;
mod transition;
mod view;

pub use gtk4;
pub use nsh_core::platform::{Appearance, Locale};
pub use nsh_engine::{
    App, Bundle, ByteSize, CacheLocation, CacheOptions, CachePolicy, Limits, Root,
};

#[cfg(feature = "dev")]
pub use crate::app::set_root;
pub use crate::{
    app::{AppOptions, AppSource, AppView, run_app, set_ui_sets},
    image::AssetBase,
    native::{ComponentContext, ComponentFactory, Components, NativeComponent},
};
