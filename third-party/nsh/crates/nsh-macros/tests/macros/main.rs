//! The macros' integration tests, one test binary: what they make, used as
//! an app's crate uses it, through `nsh_core`'s re-exports.
//!
//! The binary's root stands in for the root of an app's crate (`lib.rs`),
//! where `#[native_components]` goes.

use std::cell::RefCell;

mod native_components;

// `#[native_components]` as an app's crate has it: at the crate's root, one
// function per platform, named as the attribute's documentation names it
// (as its parameter). `native_components`' tests call them as nsh's
// generated hosts do; a `RefCell` stands in for the platform's components.
#[nsh_core::element::native_components(windows)]
fn components(components: &RefCell<Vec<&'static str>>) {
    components.borrow_mut().push("windows");
}

#[nsh_core::element::native_components(macos)]
fn components(components: &RefCell<Vec<&'static str>>) {
    components.borrow_mut().push("macos");
}

#[nsh_core::element::native_components(linux)]
fn components(components: &RefCell<Vec<&'static str>>) {
    components.borrow_mut().push("linux");
}

#[nsh_core::element::native_components(ios)]
fn components(components: &RefCell<Vec<&'static str>>) {
    components.borrow_mut().push("ios");
}
