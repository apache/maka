//! What a `TextView` asks of the formula typesetter ([`super::math`]).
//!
//! The native runtimes call it directly. The web runtime keeps it and the
//! KaTeX fonts out of what every page downloads: its code is a side module
//! with a gate of its own, and the first formula asks the page for both
//! (`nsh_core::runtime_data`, name `math`). Until they arrive the formula
//! shows as its TeX, and the rows that have one are made again after.

use nsh_core::prelude::*;

/// Whether formulas can be typeset now. Where they load later, a call that
/// finds them missing starts loading and sets `loaded` when that is over
/// (reading it here makes the caller's row again then).
#[cfg(all(feature = "math", target_arch = "wasm32"))]
pub(super) fn ready(loaded: Signal<bool>) -> bool {
    use std::sync::Arc;

    if ENGINE.get().is_some() && FONTS.get().is_some() {
        return true;
    }
    loaded.get();
    spawn(async move {
        // The page runs the gate before it hands over the fonts.
        if let Some(fonts) = nsh_core::runtime_data::load("math").await {
            let _ = FONTS.set(Arc::clone(&fonts));
        }
        loaded.set(true);
    });
    false
}

#[cfg(not(all(feature = "math", target_arch = "wasm32")))]
pub(super) fn ready(_loaded: Signal<bool>) -> bool {
    true
}

#[cfg(all(feature = "math", target_arch = "wasm32"))]
type Engine = fn(&str, bool, f32) -> Option<AnyElement>;

#[cfg(all(feature = "math", target_arch = "wasm32"))]
static ENGINE: std::sync::OnceLock<Engine> = std::sync::OnceLock::new();

#[cfg(all(feature = "math", target_arch = "wasm32"))]
static FONTS: std::sync::OnceLock<std::sync::Arc<[u8]>> = std::sync::OnceLock::new();

/// The gate's work ([`super::install_math`]).
#[cfg(all(feature = "math", target_arch = "wasm32"))]
pub fn install() {
    let _ = ENGINE.set(super::math::formula);
}

/// The KaTeX fonts' pack the page handed over.
#[cfg(all(feature = "math", target_arch = "wasm32"))]
pub(super) fn fonts() -> &'static [u8] {
    FONTS.get().map_or(&[], |fonts| &fonts[..])
}

/// `tex` typeset at `size` points per em; `None` for TeX that cannot be read
/// or while the typesetter is not there.
pub(super) fn formula(tex: &str, display: bool, size: f32) -> Option<AnyElement> {
    #[cfg(all(feature = "math", target_arch = "wasm32"))]
    return ENGINE.get()?(tex, display, size);
    #[cfg(all(feature = "math", not(target_arch = "wasm32")))]
    return super::math::formula(tex, display, size);
    #[cfg(not(feature = "math"))]
    {
        let _ = (tex, display, size);
        None
    }
}
