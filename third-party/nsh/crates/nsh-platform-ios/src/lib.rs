//! UIKit backend for nsh (iOS, iOS simulator and Mac Catalyst).
//!
//! - [`AppView`] runs one nsh app inside a `UIView`: embed it in any UIKit
//!   hierarchy (it can also load from a dev server in development builds),
//!   or let [`run_app`] create a window for a standalone app. [`Surface`]
//!   is the lower-level engine host it is built on.
//! - Mount batches from the engine thread are applied on the main thread in
//!   one main-queue hop per commit.
//! - Text is measured on the engine thread with the same attributed strings
//!   the labels render, so layout and rendering agree.
//! - [`embed`] (feature `embed`) is the C ABI of the `NativeShell` Swift
//!   module (`swift/`) that iOS apps embed nsh with.
//!
//! On non-UIKit targets this crate is empty.

#![cfg(target_os = "ios")]

#[cfg(feature = "dev")]
mod agent;
mod animation;
mod app;
mod blur;
mod canvas;
mod component;
mod decor;
#[cfg(feature = "dev")]
pub mod dev;
#[cfg(feature = "embed")]
pub mod embed;
mod fps;
mod image;
mod input;
mod interaction;
mod keymap;
mod mount;
mod native_view;
mod navigation;
mod net;
mod picker;
mod press;
mod selectable_view;
mod surface;
#[cfg(feature = "dev")]
mod synth;
mod system;
mod system_tab_bar;
mod target;
mod text;
mod text_selection;
mod text_view;
mod touch;
mod video;
mod view;
mod visual;
mod web;
mod zoom;

pub use nsh_engine::{Bundle, ByteSize, CacheLocation, CacheOptions, CachePolicy, Root};

/// The UI sets apps import ([`set_ui_sets`]; by default `nsh/base`).
static UI_SETS: std::sync::RwLock<Option<Vec<nsh_core::element::Registry>>> =
    std::sync::RwLock::new(None);

/// Sets the UI sets the engines started from now on serve: `nsh/base`
/// and an app's own Rust components (`nsh.json` `"rust"`), which a host
/// built for the app passes before it starts.
pub fn set_ui_sets(sets: Vec<nsh_core::element::Registry>) {
    *UI_SETS.write().unwrap_or_else(|e| e.into_inner()) = Some(sets);
}

/// The app's Rust root ([`set_root`]).
#[cfg(feature = "dev")]
static ROOT: std::sync::RwLock<Option<fn() -> nsh_engine::Root>> = std::sync::RwLock::new(None);

/// Sets the root of an app of Rust only (`nsh.json` `"root"`), which this
/// development host runs when its dev server publishes the app as the
/// host's root (`nsh test --target ios` of such an app) instead of a
/// bundle.
#[cfg(feature = "dev")]
pub fn set_root(root: fn() -> nsh_engine::Root) {
    *ROOT.write().unwrap_or_else(|e| e.into_inner()) = Some(root);
}

/// The app's Rust root, if the host has one ([`set_root`]).
#[cfg(feature = "dev")]
fn root() -> Option<nsh_engine::Root> {
    let root = *ROOT.read().unwrap_or_else(|e| e.into_inner());
    root.map(|root| root())
}

/// The UI sets engines serve.
fn ui_sets() -> Vec<nsh_core::element::Registry> {
    UI_SETS
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .unwrap_or_else(|| vec![nsh_base::registry()])
}

pub use crate::{
    app::{AppOptions, AppSource, in_app_bundle, run_app},
    component::{ComponentContext, ComponentFactory, Components, NativeComponent},
    image::AssetBase,
    surface::{Surface, SurfaceOptions},
    system::{preferred_status_bar_style, prefers_status_bar_hidden, status_bar_animation},
    text::CoreTextEngine,
    view::AppView,
};
