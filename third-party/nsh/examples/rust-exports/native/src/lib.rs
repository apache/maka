//! What a Rust crate can export to TSX (`examples/rust-exports`): a
//! component ([`Gauge`]), a module of functions ([`Ledger`]) and a class
//! ([`Account`]). `App.tsx` imports all three from `rust-exports/native`,
//! the specifier of the set below (`nsh.json` `"rust": "native"`), and
//! their TypeScript declarations are generated from these types into
//! `.nsh/types/rust-exports/native.d.ts`. On the desktops and Android the
//! crate also registers a native component (`meter.rs`), which `App.tsx`
//! declares with `nativeComponent`.

mod account;
mod gauge;
mod ledger;
#[cfg(any(
    windows,
    target_os = "macos",
    target_os = "linux",
    target_os = "android"
))]
mod meter;

use nsh_core::prelude::*;

pub use crate::{
    account::Account,
    gauge::{Gauge, GaugeElement, GaugeEvent, GaugeProps, gauge},
    ledger::Ledger,
};

/// Renders a string passed as the JSX children.
#[derive(Debug, Clone, PartialEq, Props)]
pub struct TextChildProps {
    /// The text supplied between the JSX tags.
    pub children: Prop<SharedString>,
}

/// Render the supplied text, following changes to the JSX child.
#[component]
pub fn TextChild(props: TextChildProps) -> impl IntoElement {
    text(move || props.children.get())
}

/// The crate's UI set: what `App.tsx` imports from `rust-exports/native`.
#[native_module("rust-exports/native")]
fn native(registry: &mut Registry) {
    registry
        .register::<Gauge>()
        .register::<TextChild>()
        .module::<Ledger>()
        .class::<Account>();
}

/// The crate's native components on Windows, which the hosts nsh builds for
/// the app register on every view.
#[native_components(windows)]
fn components(components: &nsh_platform_windows::Components) {
    meter::register(components);
}

/// The crate's native components on macOS.
#[native_components(macos)]
fn components(components: &nsh_platform_macos::Components) {
    meter::register(components);
}

/// The crate's native components on Linux.
#[native_components(linux)]
fn components(components: &nsh_platform_linux::Components) {
    meter::register(components);
}

/// The crate's native components on Android.
#[native_components(android)]
fn components(components: &nsh::Components) {
    meter::register(components);
}
