//! A color picker's eyedropper (`Command::PickScreenColor`): AppKit's
//! `NSColorSampler`, the magnifier that picks a color anywhere on the
//! screen. The color goes to the engine in one root `ScreenColor` event, in
//! sRGB; Escape answers without one.

use std::{cell::RefCell, rc::Rc};

use block2::RcBlock;
use nsh_core::{EventKind, EventPayload, PayloadValue, ROOT_ID};
use objc2::{
    msg_send,
    rc::Retained,
    runtime::{AnyClass, AnyObject},
};
use objc2_core_foundation::CGFloat;

use crate::surface::Surface;

thread_local! {
    /// The sampler showing, kept until the next one: AppKit's docs do not
    /// say it keeps itself while it shows.
    static SAMPLER: RefCell<Option<Retained<AnyObject>>> = const { RefCell::new(None) };
}

/// Shows the sampler for request `id`.
pub(crate) fn pick_screen_color(surface: &Rc<Surface>, id: u32) {
    let mut control = None;
    surface.control(|c| control = Some(c.clone()));
    let Some(control) = control else { return };
    let answer = move |color: Option<u32>| {
        let mut entries = vec![("id", PayloadValue::Number(id as f64))];
        if let Some(color) = color {
            entries.push(("color", PayloadValue::Number(color as f64)));
        }
        control.dispatch_event(ROOT_ID, EventKind::ScreenColor, EventPayload::Map(entries));
    };
    let Some(class) = AnyClass::get(c"NSColorSampler") else {
        answer(None);
        return;
    };
    // SAFETY: AppKit's documented NSColorSampler API (macOS 10.15), on the
    // main thread; the handler gets an NSColor or nil.
    unsafe {
        let sampler: Retained<AnyObject> = msg_send![class, new];
        let handler = RcBlock::new(move |color: *mut AnyObject| {
            answer(color.as_ref().and_then(|color| packed(color)));
        });
        let _: () = msg_send![&sampler, showSamplerWithSelectionHandler: &*handler];
        SAMPLER.with(|s| *s.borrow_mut() = Some(sampler));
    }
}

/// `color` in sRGB, packed `0xRRGGBBAA`.
///
/// # Safety
///
/// `color` is an NSColor; on the main thread.
unsafe fn packed(color: &AnyObject) -> Option<u32> {
    let space_class = AnyClass::get(c"NSColorSpace")?;
    // SAFETY: guaranteed by the caller; NSColorSpace and NSColor's
    // documented API.
    unsafe {
        let srgb: Retained<AnyObject> = msg_send![space_class, sRGBColorSpace];
        let color: Option<Retained<AnyObject>> = msg_send![color, colorUsingColorSpace: &*srgb];
        let color = color?;
        let channel = |value: CGFloat| (value.clamp(0.0, 1.0) * 255.0).round() as u32;
        let r: CGFloat = msg_send![&color, redComponent];
        let g: CGFloat = msg_send![&color, greenComponent];
        let b: CGFloat = msg_send![&color, blueComponent];
        let a: CGFloat = msg_send![&color, alphaComponent];
        Some(channel(r) << 24 | channel(g) << 16 | channel(b) << 8 | channel(a))
    }
}
