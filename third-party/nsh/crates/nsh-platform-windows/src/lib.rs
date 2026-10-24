//! Windows backend for nsh: a Win32 window per surface, the views drawn
//! with Direct2D, text laid out with DirectWrite.
//!
//! - Each node is an [`view::NshView`], a retained view the core placed at
//!   its frame. A surface's window draws the whole tree with Direct2D into
//!   a flip-model swap chain ([`render`]): shadows and background, the
//!   content (text, image, canvas), the children, the border, then the
//!   items the view hosts (text editors, headers). nsh content needs no
//!   child windows. A window with web views composes them with
//!   DirectComposition between layers of what nsh draws before and after
//!   each one ([`compose`]), so nsh content drawn over a page covers it.
//! - The engine runs on its own thread ([`nsh_engine::Engine`]); each
//!   commit is one message posted to the window ([`surface`]).
//! - Text is shaped and broken into lines by DirectWrite on the engine
//!   thread; the main thread draws the layout it produced ([`text`]).
//! - Native animations and JS frame requests run on a frame ticker paced
//!   by the compositor (`DwmFlush`, [`window`]).
//!
//! [`AppView`] is one surface as a window (top-level or a child of the
//! embedding app's window); [`run_app`] opens one and runs the message
//! loop. Off Windows this crate is empty.

#![cfg(windows)]

mod access;
#[cfg(feature = "dev")]
mod agent;
mod animation;
mod app;
mod canvas;
mod chrome;
mod compose;
mod decor;
#[cfg(feature = "dev")]
pub mod dev;
mod file_drop;
mod fps;
mod geom;
mod gfx;
mod image;
mod input;
mod keymap;
mod mount;
mod native;
mod navigation;
mod picker;
mod render;
mod scroll;
mod selection_area;
mod surface;
#[cfg(feature = "dev")]
mod synth;
mod system;
mod text;
mod text_input;
mod transition;
mod view;
mod window;

pub use nsh_core::platform::{Appearance, Locale};
pub use nsh_engine::{
    App, Bundle, ByteSize, CacheLocation, CacheOptions, CachePolicy, Limits, Root,
};
pub use windows;

#[cfg(feature = "dev")]
pub use crate::app::set_root;
pub use crate::{
    app::{AppOptions, AppSource, AppView, debug_output, fatal_error, run_app, set_ui_sets},
    image::AssetBase,
    native::{ComponentContext, ComponentFactory, Components, NativeComponent},
};
