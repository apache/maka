//! `#[native_components]`'s entries, called as the hosts nsh generates call
//! them (`nsh-cli` `rust_app.rs`, `app_components()`): through a glob of the
//! crate in a block over NSH's stand-in, which a crate without native
//! components leaves in place.

use std::cell::RefCell;

#[cfg(windows)]
use nsh_core::element::__private::no_native_components as __nsh_native_components_windows;
#[cfg(target_os = "linux")]
use nsh_core::element::__private::no_native_components as __nsh_native_components_linux;
#[cfg(target_os = "macos")]
use nsh_core::element::__private::no_native_components as __nsh_native_components_macos;

/// A crate without `#[native_components]`.
mod without {}

/// Calls this platform's entry, whichever is in scope.
macro_rules! register {
    ($components:expr) => {
        #[cfg(windows)]
        __nsh_native_components_windows($components);
        #[cfg(target_os = "linux")]
        __nsh_native_components_linux($components);
        #[cfg(target_os = "macos")]
        __nsh_native_components_macos($components);
    };
}

#[test]
#[cfg(any(windows, target_os = "linux", target_os = "macos"))]
fn the_hosts_register_a_crates_native_components_through_its_entry() {
    // Not `components`: the glob below imports the function of that name.
    let registered = RefCell::new(Vec::new());
    {
        // The entry at the crate's root (`main.rs`), which calls the
        // function named as its parameter.
        #[allow(unused_imports)]
        use crate::*;
        register!(&registered);
    }
    assert_eq!(*registered.borrow(), [std::env::consts::OS]);
    {
        #[allow(unused_imports)]
        use without::*;
        register!(&registered);
    }
    assert_eq!(
        *registered.borrow(),
        [std::env::consts::OS],
        "the stand-in registers nothing"
    );
}
