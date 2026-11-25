//! An app's application menu lives as long as the app: another app loaded
//! in its view starts without it (the menu it replaced comes back), and
//! another view's `setApplicationMenu(null)` leaves it alone.

use std::{
    sync::atomic::{AtomicU32, Ordering},
    time::{Duration, Instant},
};

use nsh_core::{
    element::desktop::{MenuItem, set_application_menu},
    prelude::*,
};
use nsh_platform_macos as platform;
use platform::{
    objc2::{MainThreadMarker, MainThreadOnly, Message, rc::Retained},
    objc2_app_kit::{NSApplication, NSBackingStoreType, NSMenu, NSWindow, NSWindowStyleMask},
    objc2_foundation::{NSDate, NSPoint, NSRect, NSRunLoop, NSSize},
};

use super::menu_labels::shows;

/// The times the new app's selection menu item ran.
static MARKED: AtomicU32 = AtomicU32::new(0);

/// Sets a menu bar with one item of its own: the engine's first menu id.
#[component]
fn OldMenu() -> impl IntoElement {
    set_application_menu(vec![MenuItem::submenu(
        "Old",
        [MenuItem::new("Old action").on_select(|| {})],
    )]);
    view().flex_1()
}

/// Sets no menu bar; its selection menu's item has the engine's first menu
/// id, the old app's item's.
#[component]
fn Marked() -> impl IntoElement {
    view()
        .flex_1()
        .selectable(true)
        .selection_menu(vec![MenuItem::new("Mark").on_select(|| {
            MARKED.fetch_add(1, Ordering::SeqCst);
        })])
        .child(text("New app"))
}

/// Gives the platform's menu back, having set none.
#[component]
fn NoMenu() -> impl IntoElement {
    set_application_menu(None::<Vec<MenuItem>>);
    view().flex_1().child(text("No menu"))
}

/// The menu holding the item titled `title` among `menu`'s, and its index.
fn find(menu: &NSMenu, title: &str) -> Option<(Retained<NSMenu>, isize)> {
    menu.itemArray()
        .iter()
        .enumerate()
        .find_map(|(index, item)| {
            if item.title().to_string() == title {
                return Some((menu.retain(), index as isize));
            }
            item.submenu().and_then(|sub| find(&sub, title))
        })
}

fn main_menu_has(mtm: MainThreadMarker, title: &str) -> bool {
    NSApplication::sharedApplication(mtm)
        .mainMenu()
        .is_some_and(|menu| find(&menu, title).is_some())
}

/// Runs the main run loop until `done` holds, for at most 5 s.
fn until(what: &str, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !done() {
        assert!(Instant::now() < deadline, "{what} never happened");
        NSRunLoop::currentRunLoop().runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(0.01));
    }
}

/// Runs the main run loop for `seconds`.
fn pump(seconds: f64) {
    NSRunLoop::currentRunLoop().runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(seconds));
}

/// Runs after `window_press::run`, which launched the application.
// `AppOptions` is non-exhaustive: its fields are set after `default()`.
#[allow(clippy::field_reassign_with_default)]
pub(super) fn run() {
    let mtm = MainThreadMarker::new().unwrap();
    let app = NSApplication::sharedApplication(mtm);
    let saved_menu = app.mainMenu();
    // SAFETY: The window is created on the process main thread.
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            NSRect::new(NSPoint::new(700.0, 300.0), NSSize::new(300.0, 200.0)),
            NSWindowStyleMask::Titled,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    // SAFETY: This scope retains the window until after it closes.
    unsafe {
        window.setReleasedWhenClosed(false);
    }
    let mut options = platform::AppOptions::default();
    options.size = (300, 200);
    let surface = platform::AppView::new(mtm, options.clone());
    window.setContentView(Some(&surface.view()));
    surface.load(platform::App::Rust(platform::Root::of::<OldMenu>()));
    window.makeKeyAndOrderFront(None);
    until("the old app's menu", || main_menu_has(mtm, "Old action"));

    // Another app in the same view: the old one's bar goes with it.
    surface.load(platform::App::Rust(platform::Root::of::<Marked>()));
    until("the new app", || shows(&surface.view(), "New app"));
    // Whatever bar still shows is what the user can choose from.
    if let Some((menu, index)) = app.mainMenu().and_then(|menu| find(&menu, "Old action")) {
        menu.performActionForItemAtIndex(index);
    }
    pump(0.3);
    assert_eq!(
        MARKED.load(Ordering::SeqCst),
        0,
        "the old app's menu item ran the new app's action of the same id"
    );
    assert!(
        app.mainMenu() == saved_menu,
        "the old app's menu bar stayed after another app loaded"
    );

    // Another view gives the platform's menu back, having set none.
    surface.load(platform::App::Rust(platform::Root::of::<OldMenu>()));
    until("the old app's menu again", || {
        main_menu_has(mtm, "Old action")
    });
    let other = platform::AppView::new(mtm, options);
    surface.view().addSubview(&other.view());
    other.load(platform::App::Rust(platform::Root::of::<NoMenu>()));
    until("the other app", || shows(&other.view(), "No menu"));
    pump(0.3);
    assert!(
        main_menu_has(mtm, "Old action"),
        "another view's setApplicationMenu(null) removed this view's menu bar"
    );
    // The original was kept for the bar that shows.
    surface.stop();
    assert!(
        app.mainMenu() == saved_menu,
        "the original menu did not come back with the last bar"
    );
    println!(
        "menu lifetime: an app's menu bar goes with the app, and only its own view's null removes it"
    );
    other.stop();
    app.setMainMenu(saved_menu.as_deref());
    window.close();
}
