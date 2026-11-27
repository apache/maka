//! #1691: an input's text must not move when it takes the focus. AppKit
//! draws an idle single-line field with its cell and an edited one with the
//! window's field editor in a clip view. The editor was taller than the
//! field when the font has leading (Arial, not the system font) or the field
//! sat between pixels, and the clip view scrolled it up. Draws each input
//! off screen, idle and focused, and compares where its text's ink lies.
//!
//! `NSH_INPUT_BASELINE_CHECK_ONLY=1` runs this check alone.

use std::time::{Duration, Instant};

use nsh_base::input;
use nsh_core::prelude::*;
use nsh_platform_macos::{
    self as platform,
    objc2::{AnyThread, MainThreadMarker, MainThreadOnly, Message, rc::Retained},
    objc2_app_kit::{
        NSAccessibility, NSApplication, NSBackingStoreType, NSBitmapImageRep, NSColor,
        NSDeviceRGBColorSpace, NSTextField, NSTextView, NSView, NSWindow, NSWindowStyleMask,
    },
    objc2_foundation::{NSDate, NSPoint, NSRange, NSRect, NSRunLoop, NSSize},
};

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Text,
    Password,
    /// Empty, showing its placeholder.
    Placeholder,
    Multiline,
}

/// The inputs: id, font family (empty: the system font), size (0: the
/// issue's `text-4xl`, 36 points on 40-point lines, centered a half point
/// off the pixels in its box) and kind. In this order, the shared field
/// editor also moves between fonts and from fields between pixels.
const INPUTS: [(&str, &str, f32, Kind); 10] = [
    ("arial-4xl", "Arial", 0.0, Kind::Text),
    ("menlo-4xl", "Menlo", 0.0, Kind::Text),
    ("arial", "Arial", 36.0, Kind::Text),
    ("arial-password", "Arial", 36.0, Kind::Password),
    ("menlo", "Menlo", 36.0, Kind::Text),
    ("arial-small", "Arial", 14.0, Kind::Text),
    ("arial-placeholder", "Arial", 0.0, Kind::Placeholder),
    ("system", "", 36.0, Kind::Text),
    ("system-small", "", 14.0, Kind::Text),
    ("arial-multiline", "Arial", 0.0, Kind::Multiline),
];

/// Pixels per point of the off-screen drawing: fine enough to see a
/// quarter-point move whatever the display's scale.
const SCALE: f64 = 4.0;

/// How far the text may move: an eighth of a point, below what a 2x display
/// shows.
const TOLERANCE: f64 = 0.125;

#[component]
fn Page() -> impl IntoElement {
    let mut page = view().size_full().p(px(16.0)).gap(px(8.0));
    for (id, family, size, kind) in INPUTS {
        let mut field = input()
            .test_id(id)
            .w(px(240.0))
            .p(px(4.0))
            .text_color(rgb(0x000000))
            .masked(kind == Kind::Password)
            .multiline(kind == Kind::Multiline);
        field = if kind == Kind::Placeholder {
            field.placeholder("Hallo")
        } else {
            field.default_value("Hallo")
        };
        field = if size == 0.0 {
            field.text_4xl().border(px(1.0))
        } else {
            field.text_size(px(size))
        };
        if !family.is_empty() {
            field = field.font_family(family);
        }
        page = page.child(field);
    }
    page
}

fn find(view: &NSView, matches: &dyn Fn(&NSView) -> bool) -> Option<Retained<NSView>> {
    if matches(view) {
        return Some(view.retain());
    }
    view.subviews()
        .iter()
        .find_map(|child| find(&child, matches))
}

/// The view that edits input `id`: its field, or a multiline one's text
/// view.
fn editable(root: &NSView, id: &str) -> Option<Retained<NSView>> {
    let input = find(root, &|v| {
        v.accessibilityIdentifier()
            .is_some_and(|s| s.to_string() == id)
    })?;
    find(&input, &|v| {
        (v.downcast_ref::<NSTextField>().is_some() || v.downcast_ref::<NSTextView>().is_some())
            && !v.isHiddenOrHasHiddenAncestor()
    })
}

fn settle() {
    NSRunLoop::currentRunLoop().runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(0.05));
}

/// The view that hosts the input's editor and does not move with the focus:
/// a field's parent, or the parent of a text view's scroll view.
fn host(editable: &NSView) -> Retained<NSView> {
    // SAFETY: AppKit getters on the main thread.
    unsafe {
        match editable.downcast_ref::<NSTextView>() {
            Some(text) => text.enclosingScrollView().unwrap().superview(),
            None => editable.superview(),
        }
    }
    .unwrap()
}

/// Where the text's ink lies in `host`, in points from its top: the top and
/// bottom rows it covers and its alpha-weighted vertical center. The host
/// (with the field editor in a field while editing) is drawn off screen;
/// the glyphs are the same in both states, so the center moves exactly as
/// far as the text does.
fn ink(host: &NSView) -> Ink {
    let bounds = host.bounds();
    let (w, h) = (
        (bounds.size.width * SCALE) as isize,
        (bounds.size.height * SCALE) as isize,
    );
    // SAFETY: AppKit allocates the planes for a null pointer; 8-bit RGBA.
    let rep = unsafe {
        NSBitmapImageRep::initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bytesPerRow_bitsPerPixel(
            NSBitmapImageRep::alloc(),
            std::ptr::null_mut(),
            w,
            h,
            8,
            4,
            true,
            false,
            NSDeviceRGBColorSpace,
            0,
            32,
        )
    }
    .unwrap();
    rep.setSize(bounds.size);
    host.cacheDisplayInRect_toBitmapImageRep(bounds, &rep);
    let row = rep.bytesPerRow() as usize;
    // SAFETY: the rep's own planes, `row` bytes for each of its `h` rows.
    let data = unsafe { std::slice::from_raw_parts(rep.bitmapData(), row * h as usize) };
    let (mut top, mut bottom, mut sum, mut weight) = (None, 0, 0.0, 0.0);
    for y in 0..h as usize {
        let alpha: f64 = (0..w as usize)
            .map(|x| f64::from(data[y * row + x * 4 + 3]) / 255.0)
            .sum();
        if alpha > 0.0 {
            top.get_or_insert(y);
            bottom = y + 1;
            sum += alpha * (y as f64 + 0.5);
            weight += alpha;
        }
    }
    let top = top.expect("no text drawn in the input");
    Ink {
        top: top as f64 / SCALE,
        bottom: bottom as f64 / SCALE,
        center: sum / weight / SCALE,
    }
}

#[derive(Debug, Clone, Copy)]
struct Ink {
    top: f64,
    bottom: f64,
    center: f64,
}

pub(super) fn run() {
    let mtm = MainThreadMarker::new().unwrap();
    let app = NSApplication::sharedApplication(mtm);
    app.finishLaunching();
    // SAFETY: window creation and ownership on the main thread.
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            NSRect::new(NSPoint::new(200.0, 100.0), NSSize::new(320.0, 640.0)),
            NSWindowStyleMask::Titled,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    // SAFETY: retained here through close.
    unsafe { window.setReleasedWhenClosed(false) };
    let surface = platform::AppView::new(
        mtm,
        platform::AppOptions {
            size: (320, 640),
            ..Default::default()
        },
    );
    let root = surface.view();
    window.setContentView(Some(&root));
    surface.load(platform::App::Rust(platform::Root::of::<Page>()));
    window.makeKeyAndOrderFront(None);
    app.activate();
    let deadline = Instant::now() + Duration::from_secs(10);
    while INPUTS.iter().any(|(id, ..)| editable(&root, id).is_none()) {
        assert!(Instant::now() < deadline, "inputs did not mount");
        settle();
    }
    settle();
    let mut failures = Vec::new();
    for (id, ..) in INPUTS {
        let view = editable(&root, id).unwrap();
        let host = host(&view);
        let idle = ink(&host);
        assert!(window.makeFirstResponder(Some(&view)));
        let editor = match view.downcast_ref::<NSTextField>() {
            Some(field) => field
                .currentEditor()
                .unwrap()
                .downcast::<NSTextView>()
                .unwrap(),
            None => view.clone().downcast::<NSTextView>().unwrap(),
        };
        // Neither the caret nor a selection: only the text's ink.
        editor.setSelectedRange(NSRange::new(editor.string().length(), 0));
        editor.setInsertionPointColor(Some(&NSColor::clearColor()));
        settle();
        let focused = ink(&host);
        let moved = focused.center - idle.center;
        println!(
            "input_baseline: {id}: idle ink {:.2}..{:.2} center {:.3}, focused {:.2}..{:.2} center {:.3}, moved {moved:+.3}",
            idle.top, idle.bottom, idle.center, focused.top, focused.bottom, focused.center
        );
        if moved.abs() > TOLERANCE {
            failures.push(format!("{id}: moved {moved:+.3} points"));
        }
        assert!(window.makeFirstResponder(None));
        settle();
        let again = ink(&host);
        assert!(
            (again.center - idle.center).abs() <= TOLERANCE,
            "{id}: idle text moved after editing: {idle:?} then {again:?}"
        );
    }
    surface.stop();
    window.close();
    assert!(
        failures.is_empty(),
        "text moved on focus:\n{}",
        failures.join("\n")
    );
}
