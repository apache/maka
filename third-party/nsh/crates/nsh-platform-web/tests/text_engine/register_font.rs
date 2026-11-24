//! `register_font` gives a variable font's `FontFace` its `wght` range: a
//! single weight pins the axis, so every `fontWeight` drew the same.

use nsh_core::TextEngine;

use crate::ffi::REGISTERED;
use crate::text::WebTextEngine;

fn registered(data: &[u8]) -> (String, u16, u16) {
    REGISTERED.with(|r| r.borrow_mut().clear());
    WebTextEngine::default()
        .register_font(data)
        .expect("registered");
    REGISTERED.with(|r| r.borrow().last().cloned().expect("a FontFace"))
}

#[test]
fn a_variable_font_registers_its_wght_range() {
    // Adwaita Sans (OFL) subset to "H", axes wght 100..900 and opsz;
    // OS/2 weight 400.
    let font = include_bytes!("../fonts/AdwaitaSans-Var-Subset.ttf");
    assert_eq!(registered(font), ("Adwaita Sans".to_owned(), 100, 900));
}

#[test]
fn a_static_font_registers_its_one_weight() {
    let font = include_bytes!("../../../../tests/compat/cases/layout/fonts/Pacifico-Regular.ttf");
    assert_eq!(registered(font), ("Pacifico".to_owned(), 400, 400));
}
