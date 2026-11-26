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
//! - Hardware keys: a `focusable` view becomes the first responder
//!   (`canBecomeFirstResponder`) and a UIKit focus item
//!   (`canBecomeFocused`), reports one `on_key_down` / `on_key_up` per
//!   `UIPress` transition with the DOM `key` UIKit reports for the press
//!   (case and layout included; the unmodified character only for
//!   nonprinting control chords), the DOM `code` mapped from
//!   `UIKey.keyCode`'s USB HID usage, the modifier flags, `repeat` false
//!   (UIKit sends a held key's press once) and the mounted `capture_keys`
//!   decision in `default_prevented`. Tab and Shift+Tab move the focus
//!   between inputs and focusable views: app shortcuts and mounted Tab
//!   captures become prioritized `UIKeyCommand`s (a `KeyDown` with no
//!   `code` and no invented release), an unbound, uncaptured Tab on a
//!   focused view follows normal traversal, and the surface root, the first
//!   responder until a view or input takes the focus, moves to the first
//!   or last stop from no focus. A focused view that blurs or is deleted
//!   gives the keyboard back to the root on the next turn when the window
//!   has no responder left, never taking it from an input, a hosted view or
//!   another custom view. Return
//!   and Space press a focused view that takes presses. App shortcuts
//!   (`nsh/keymap`) keep their precedence, and focused native inputs, web
//!   views and native components keep their own keys and input methods.
//!   Blur, cancellation and deactivation forget held keys without
//!   synthesizing a release (`keyboard.rs`).
//! - [`embed`] (feature `embed`) is the C ABI of the `NativeShell` Swift
//!   module (`swift/`) that iOS apps embed nsh with.
//!
//! On non-UIKit targets this crate is empty.
//!
//! # Hardware keyboard tests
//!
//! With Xcode's simulator, the regression app presses real IOHID keys:
//!
//! ```sh
//! nsh test crates/nsh-platform-ios/tests/keyboard --target ios
//! nsh test crates/nsh-platform-ios/tests/keyboard --target catalyst
//! ```
//!
//! It checks the reported key, DOM code, modifiers, single press and
//! release of a focusable view, a mounted capture taking a key before its
//! default, Tab / Shift+Tab traversal (a captured or app-bound Tab stays),
//! a scroll ancestor and an overlay's logical ancestors, that a tap
//! focuses a view without press handlers, and that the views inside such a
//! view keep their presses. UIKit sends a held key's press once and reports
//! no auto-repeat, so `repeat` is false; an app that wants repeats starts
//! its own timer from the press.

#![cfg(target_os = "ios")]

#[cfg(feature = "dev")]
mod agent;
mod animation;
mod app;
mod application;
mod auth_session;
mod blur;
mod bottom_bar;
mod canvas;
mod component;
mod decor;
#[cfg(feature = "dev")]
pub mod dev;
#[cfg(feature = "embed")]
pub mod embed;
mod file_drop;
mod fps;
mod haptics;
mod image;
mod input;
mod interaction;
mod keyboard;
mod keymap;
mod mount;
mod native_view;
mod navigation;
mod net;
mod picker;
mod presenting;
mod press;
mod scroll_edge;
mod scroll_watch;
mod selectable_view;
mod shader;
mod share;
mod split;
mod state_words;
// Sound (`Sound`, `AudioPlayer`) and the notification center, shared with
// macOS.
use nsh_platform_apple::{audio, notifications};
mod surface;
#[cfg(feature = "dev")]
mod synth;
mod system;
mod system_context_menu;
mod system_date_time_picker;
mod system_menu_button;
mod system_segmented_control;
mod system_switch;
mod system_tab_bar;
mod target;
mod text;
mod text_access;
mod text_selection;
mod text_view;
mod touch;
mod video;
mod view;
mod visual;
mod web;
mod zoom;

pub use nsh_engine::{Bundle, ByteSize, CacheLocation, CacheOptions, CachePolicy, Root};
pub use picker::prepare_image;
pub use presenting::presenting_controller;

/// The UI sets apps import ([`set_ui_sets`]; by default [`default_ui_sets`]).
static UI_SETS: std::sync::RwLock<Option<Vec<nsh_core::element::Registry>>> =
    std::sync::RwLock::new(None);

/// Sets the UI sets the engines started from now on serve: `nsh/base`
/// and an app's own Rust components (`nsh.json` `"rust"`), which a host
/// built for the app passes before it starts.
pub fn set_ui_sets(sets: Vec<nsh_core::element::Registry>) {
    *UI_SETS.write().unwrap_or_else(|e| e.into_inner()) = Some(sets);
}

/// The app's native components ([`set_components`]). Process-wide, as the
/// UI sets of [`set_ui_sets`] are: only the hosts and runners nsh generates
/// for an app's crate set it, so in an embedding app (the iOS SDK included)
/// it stays `None` and each registry holds only what was registered on its
/// own view.
static COMPONENTS: std::sync::RwLock<Option<fn(&Components)>> = std::sync::RwLock::new(None);

/// Sets what registers the app's own native components (`nsh.json`
/// `"rust"`, `#[native_components(ios)]`): every [`AppView`] calls it on
/// its [`SurfaceOptions::components`] when it is made, so the app's
/// elements find them as an embedding app's. It runs before the code
/// holding the view can register: a name registered on the view afterwards
/// ([`AppView::register_component`]) replaces the crate's. The development
/// host and release runner nsh generates for such an app call this before
/// [`run_app`].
pub fn set_components(register: fn(&Components)) {
    *COMPONENTS.write().unwrap_or_else(|e| e.into_inner()) = Some(register);
}

/// Registers the app's native components ([`set_components`]) on
/// `components`.
fn register_app_components(components: &Components) {
    let register = *COMPONENTS.read().unwrap_or_else(|e| e.into_inner());
    if let Some(register) = register {
        register(components);
    }
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

/// The UI sets engines serve: [`set_ui_sets`]'s, else [`default_ui_sets`].
fn ui_sets() -> Vec<nsh_core::element::Registry> {
    UI_SETS
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .unwrap_or_else(default_ui_sets)
}

/// All of `nsh/base` in the iOS SDK, as in Android's `NshView`: its Swift
/// hosts run any app's JS and have no [`set_ui_sets`] to call.
#[cfg(feature = "embed")]
fn default_ui_sets() -> Vec<nsh_core::element::Registry> {
    vec![nsh_base::registry()]
}

/// `nsh/base`'s core part only. A Rust app makes `nsh/base`'s components
/// by type, so registering every part would link every component into its
/// binary; hosts that run JS register the sets their code imports.
#[cfg(not(feature = "embed"))]
fn default_ui_sets() -> Vec<nsh_core::element::Registry> {
    vec![nsh_base::registry_of([
        nsh_base::parts::core as nsh_base::parts::Part
    ])]
}

pub use crate::{
    app::{AppOptions, AppSource, in_app_bundle, run_app},
    application::{
        ApplicationEvent, FetchCompletion, FetchResult, NativeDictionary, on_application_event,
    },
    component::{ComponentContext, ComponentFactory, Components, NativeComponent},
    image::AssetBase,
    scroll_watch::{ScrollHandle, ScrollWatcher, ScrollWatchers},
    surface::{Surface, SurfaceOptions},
    system::{preferred_status_bar_style, prefers_status_bar_hidden, status_bar_animation},
    text::CoreTextEngine,
    view::AppView,
};
