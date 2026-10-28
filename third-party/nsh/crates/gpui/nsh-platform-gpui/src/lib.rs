//! GPUI backend for nsh: apps drawn by GPUI (GPUI Fast), on macOS, Windows
//! and Linux alike, for embedding in GPUI and GPUI Kit apps (standalone
//! apps run on each OS's own backend: AppKit, Win32, GTK 4).
//!
//! - Each node is an [`view::NshView`], a retained view the core placed at
//!   its frame. A surface is one GPUI element ([`render::SurfaceElement`])
//!   that paints the whole tree with GPUI's primitives (quads, shadows,
//!   paths, glyphs, images): shadows and background, the content (shader,
//!   text, image, canvas), the children, the border, then the items the view
//!   hosts (text editors, headers).
//! - The engine runs on its own thread ([`nsh_engine::Engine`]); each
//!   commit is one closure sent to GPUI's main thread ([`rt`],
//!   [`surface`]), which notifies the surface's view.
//! - Text is shaped by GPUI's text system on the engine thread and broken
//!   into lines by nsh; the main thread paints the glyphs it placed
//!   ([`text`]).
//! - Native animations and JS frame requests tick on the window's frames
//!   while something animates.
//!
//! [`AppView`] is one surface as a GPUI view (`Entity<AppView>`), to put
//! anywhere in a GPUI app's element tree; [`run_app`] opens one in a
//! window, as the development host does. The input, scrolling, transition and editing logic is the
//! Windows backend's (its virtual key codes included, [`keys`]). Off the
//! desktop this crate is empty.

#![cfg(any(target_os = "linux", target_os = "macos", windows))]

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
mod events;
mod file_drop;
mod focus_return;
mod geom;
mod image;
mod input;
mod keymap;
mod keys;
mod mount;
mod native;
mod navigation;
mod render;
mod rt;
mod scroll;
mod selectable_view;
mod shader;
mod stats;
mod surface;
#[cfg(feature = "dev")]
mod synth;
mod system;
mod text;
mod text_input;
mod transition;
mod view;

// Windows of GPUI's test platform, which `shot` turns on.
#[cfg(all(test, feature = "shot"))]
mod tests;

pub use gpui;
pub use nsh_base::{Theme, ThemeError};
pub use nsh_core::{
    element::{AdaptiveColor, Color, Hsla, Rgba},
    platform::{Appearance, Locale},
};
pub use nsh_engine::{
    App, AppError, AppErrorKind, Bundle, ByteSize, CacheLocation, CacheOptions, CachePolicy,
    Limits, PackageInfo, Root,
};
/// Signed packages: verifying, unpacking and accepting them
/// (`docs/dev/signed-packages.md`).
#[cfg(feature = "js")]
pub use nsh_engine::{LoadedPackage, accept_package, load_package, package, verify_package};

#[cfg(feature = "dev")]
pub use crate::app::set_root;
pub use crate::{
    app::{AppOptions, AppSource, AppView, CloseRequest, open_app_window, run_app, set_ui_sets},
    chrome::titlebar_options,
    image::AssetBase,
    native::{ComponentContext, ComponentFactory, Components, NativeComponent},
};
