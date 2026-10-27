//! Android backend for nsh.
//!
//! Built as `libnsh.so`, loaded by the Java runtime in `java/com/longbridge/nsh`. The
//! split mirrors the Apple backend:
//!
//! - The engine thread runs JS and layout. Text is typeset there with
//!   `StaticLayout` (through JNI), and every commit is encoded into one
//!   `byte[]` (+ an object array for strings and layouts) that a single JNI
//!   call hands to the UI thread, where `Mounter.java` applies it.
//! - Native animations (nsh-core's `animation` graph) run on the UI thread in Rust:
//!   `Choreographer` ticks call in, and changed values come back as a
//!   compact array.
//! - Selections across the texts of a selectable view use nsh-core's model
//!   on the UI thread too (`selectable_view.rs`, `SelectableView.java`).
//!
//! On non-Android targets this crate is empty.

#![cfg(target_os = "android")]

#[cfg(feature = "dev")]
mod agent;
mod animation;
#[cfg(feature = "dev")]
mod dev;
mod encode;
mod host;
mod java;
mod keymap;
mod logger;
mod net;
#[cfg(feature = "js")]
mod package;
mod selectable_view;
mod svg;
mod text;

use std::ffi::c_void;

pub use host::run_root;
/// What [`ui_sets!`] gives.
pub use nsh_core::element::Registry;
/// What [`root!`] gives.
pub use nsh_engine::Root;

/// The UI sets apps import ([`set_ui_sets`]; by default `nsh/base`).
static UI_SETS: std::sync::RwLock<Option<Vec<nsh_core::element::Registry>>> =
    std::sync::RwLock::new(None);

/// Sets the UI sets the engines started from now on serve: `nsh/base`
/// and an app's own Rust components (`nsh.json` `"rust"`), which a host
/// built for the app passes before it starts.
pub fn set_ui_sets(sets: Vec<nsh_core::element::Registry>) {
    *UI_SETS.write().unwrap_or_else(|e| e.into_inner()) = Some(sets);
}

/// The UI sets engines serve: [`set_ui_sets`]'s, else those of an app
/// library built with [`ui_sets!`], else `nsh/base`.
fn ui_sets() -> Vec<nsh_core::element::Registry> {
    if let Some(sets) = UI_SETS.read().unwrap_or_else(|e| e.into_inner()).clone() {
        return sets;
    }
    // SAFETY: looks up a symbol of the loaded libraries; [`ui_sets!`]
    // defines it with this signature, in a library built with this crate.
    let app = unsafe { libc::dlsym(libc::RTLD_DEFAULT, c"nsh_app_ui_sets".as_ptr()) };
    if !app.is_null() {
        // SAFETY: as above.
        let sets: fn() -> Vec<nsh_core::element::Registry> = unsafe { std::mem::transmute(app) };
        return sets();
    }
    vec![nsh_base::registry()]
}

/// Makes this library an app's `libnsh.so` that serves `$sets` (an
/// expression giving the `Vec<Registry>` of `nsh/base` and the app's
/// own Rust components): `nsh run` builds one for apps with `"rust"` in
/// `nsh.json`.
#[macro_export]
macro_rules! ui_sets {
    ($sets:expr) => {
        #[unsafe(no_mangle)]
        fn nsh_app_ui_sets() -> ::std::vec::Vec<$crate::Registry> {
            $sets
        }
    };
}
/// Makes `$root` (an expression giving a [`Root`]) the root of
/// an app of Rust only (`nsh.json` `"root"`) in this development library:
/// what it runs when its dev server publishes the app as the host's root
/// (`nsh test --target android` of such an app) instead of a bundle.
#[macro_export]
macro_rules! root {
    ($root:expr) => {
        #[unsafe(no_mangle)]
        fn nsh_app_root() -> $crate::Root {
            $root
        }
    };
}

/// The app's Rust root, if this library has one ([`root!`]).
#[cfg(feature = "dev")]
fn app_root() -> Option<Root> {
    // SAFETY: looks up a symbol of the loaded libraries; [`root!`] defines
    // it with this signature, in a library built with this crate.
    let root = unsafe { libc::dlsym(libc::RTLD_DEFAULT, c"nsh_app_root".as_ptr()) };
    if root.is_null() {
        return None;
    }
    // SAFETY: as above.
    let root: fn() -> Root = unsafe { std::mem::transmute(root) };
    Some(root())
}

/// The JNI bindings [`main`] expands to.
pub use jni;
use jni::{JavaVM, sys::jint};

/// Called by the VM when `System.loadLibrary("nsh")` runs.
#[unsafe(no_mangle)]
pub extern "system" fn JNI_OnLoad(vm: JavaVM, _: *mut c_void) -> jint {
    logger::init();
    if let Err(err) = java::init(vm) {
        log::error!("nsh: JNI setup failed: {err}");
    }
    jni::sys::JNI_VERSION_1_6
}

/// Makes this library a Rust app's `libnsh.so` (built by
/// `nsh package --rust`): defines `Native.runRust`, which `AppActivity`
/// calls to run `$root` (a [`nsh_engine::Root`]).
#[macro_export]
macro_rules! main {
    ($root:expr) => {
        #[unsafe(no_mangle)]
        extern "system" fn Java_com_longbridge_nsh_Native_runRust(
            _: $crate::jni::JNIEnv<'_>,
            _: $crate::jni::objects::JClass<'_>,
            handle: $crate::jni::sys::jlong,
        ) {
            $crate::run_root(handle, $root);
        }
    };
}
