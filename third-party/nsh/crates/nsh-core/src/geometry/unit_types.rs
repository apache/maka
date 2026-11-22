//! Holds nsh-core's public API to typed units (docs/dev/geometry.md,
//! "Typed API") with the scan in `unit_scan.rs`, which nsh-js and
//! nsh-engine share.
//!
//! Not scanned here: the `geometry` module (the units themselves, whose
//! constructors take the bare value) and `color` (colors are typed; their
//! components have no unit).

use std::{fs, path::Path};

use super::unit_scan::{check, scan};

/// Modules the scan leaves out (see the module docs).
const SKIPPED: &[&str] = &["geometry", "color"];

#[test]
fn public_api_is_typed() {
    check(Path::new(env!("CARGO_MANIFEST_DIR")), SKIPPED);
}

#[test]
fn the_scan_sees_what_it_should() {
    let dir = std::env::temp_dir().join(format!("nsh-unit-types-{}", std::process::id()));
    let src = dir.join("src");
    fs::create_dir_all(src.join("a")).unwrap();
    fs::write(
        src.join("a/mod.rs"),
        "pub fn f(x: f32, y: crate::Points) -> Option<f32> { None }
         pub(crate) fn hidden(x: f32) {}
         pub struct S { pub w: [f32; 2], private: f32 }
         pub enum E { V(f32), W { at: (u8, f64) } }
         impl S { pub fn get(&self) -> f32 { 0.0 } fn own(&self, v: f32) {} }
         impl Default for S { fn default() -> Self { todo!() } }
         pub trait T { fn t(&self, v: f32); }
         pub const C: f32 = 1.0;
         #[cfg(test)] mod tests { pub fn t(x: f32) {} }",
    )
    .unwrap();
    // The units' own constructors take the bare value.
    fs::write(src.join("geometry.rs"), "pub fn px(points: f32) {}").unwrap();
    let found: Vec<_> = scan(&src, SKIPPED).into_iter().collect();
    fs::remove_dir_all(&dir).ok();
    assert_eq!(
        found,
        [
            "a::C",
            "a::E::V.0",
            "a::E::W.at",
            "a::S.w",
            "a::S::get ->",
            "a::T::t(v)",
            "a::f ->",
            "a::f(x)"
        ]
    );
}
