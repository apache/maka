//! The web backend's text rules and input encoding, off WebAssembly: the
//! crate itself is empty there (`lib.rs`), so this binary builds the
//! modules that depend on nothing of the browser from their sources.

#[path = "../../src/text/css.rs"]
#[allow(dead_code)]
mod css;

#[path = "../../src/text/hit.rs"]
#[allow(dead_code, reason = "the wasm-only layout uses the rest")]
mod hit;

#[path = "../../src/text/wrap.rs"]
#[allow(dead_code)]
mod wrap;

#[path = "../../src/encode/input.rs"]
mod input;

mod fonts;
mod hit_testing;
mod lines;
