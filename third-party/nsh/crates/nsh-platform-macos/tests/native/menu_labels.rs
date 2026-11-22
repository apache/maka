//! Menu labels changed while the app runs (`nsh/i18n`'s `set_locale`): the items of
//! the app's menu bar that have a role and no label of their own take them
//! at once.

use std::{
    sync::atomic::{AtomicU8, Ordering},
    time::{Duration, Instant},
};

use nsh_core::{
    desktop::MenuRole,
    element::desktop::{MenuItem, set_application_menu},
    prelude::*,
};
use nsh_platform_macos as platform;
use platform::{
    objc2::{MainThreadMarker, MainThreadOnly, sel},
    objc2_app_kit::{
        NSAccessibility, NSApplication, NSBackingStoreType, NSMenu, NSView, NSWindow,
        NSWindowStyleMask,
    },
    objc2_foundation::{NSDate, NSPoint, NSRect, NSRunLoop, NSSize, NSString},
};

/// The test sets it for the app to label its menus in Japanese.
static LANGUAGE: AtomicU8 = AtomicU8::new(0);

/// An Edit menu of roles only, labelled in Japanese once asked.
#[component]
fn Menus() -> impl IntoElement {
    nsh_core::i18n::set_locale(Some(nsh_core::platform::Locale::parse("en").unwrap()));
    set_application_menu(vec![
        MenuItem::submenu("App", [MenuItem::role(MenuRole::Quit)]),
        MenuItem::submenu(
            "Edit",
            [
                MenuItem::role(MenuRole::Copy),
                MenuItem::role(MenuRole::Paste),
            ],
        ),
    ]);
    set_interval(Duration::from_millis(10), || {
        let language = match LANGUAGE.swap(0, Ordering::SeqCst) {
            1 => "ja",
            2 => "en",
            _ => return,
        };
        nsh_core::i18n::set_locale(Some(nsh_core::platform::Locale::parse(language).unwrap()));
    });
    view().flex_1().child(text(|| {
        format!("Menu language {}", nsh_core::element::locale().as_str())
    }))
}

#[component]
fn OtherMenus() -> impl IntoElement {
    nsh_core::i18n::set_locale(Some(nsh_core::platform::Locale::EN_US));
    set_application_menu(vec![
        MenuItem::submenu("App", [MenuItem::role(MenuRole::Quit)]),
        MenuItem::submenu(
            "Other",
            [
                MenuItem::role(MenuRole::Copy),
                MenuItem::role(MenuRole::Paste),
            ],
        ),
    ]);
    view().flex_1()
}

fn shows(view: &NSView, text: &str) -> bool {
    view.accessibilityValue()
        .and_then(
            |value: platform::objc2::rc::Retained<platform::objc2::runtime::AnyObject>| {
                value.downcast::<NSString>().ok()
            },
        )
        .is_some_and(|value| value.to_string() == text)
        || view.subviews().iter().any(|child| shows(&child, text))
}

/// The title of the item of `menu`'s submenus whose action is `action`.
fn title_of(menu: &NSMenu, action: platform::objc2::runtime::Sel) -> Option<String> {
    menu.itemArray().iter().find_map(|item| {
        if item.action() == Some(action) {
            return Some(item.title().to_string());
        }
        item.submenu().and_then(|sub| title_of(&sub, action))
    })
}

fn titles(mtm: MainThreadMarker) -> (Option<String>, Option<String>) {
    let Some(menu) = NSApplication::sharedApplication(mtm).mainMenu() else {
        return (None, None);
    };
    (title_of(&menu, sel!(copy:)), title_of(&menu, sel!(paste:)))
}

/// Runs the main run loop until `done` holds, for at most 5 s.
fn until(what: &str, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !done() {
        assert!(Instant::now() < deadline, "{what} never happened");
        NSRunLoop::currentRunLoop().runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(0.01));
    }
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
    surface.load(platform::App::Rust(platform::Root::of::<Menus>()));
    window.makeKeyAndOrderFront(None);

    until("the app's menu", || {
        titles(mtm) == (Some("Copy".into()), Some("Paste".into()))
    });
    LANGUAGE.store(1, Ordering::SeqCst);
    until("the Japanese label", || {
        titles(mtm) == (Some("コピー".into()), Some("ペースト".into()))
    });

    until("the Japanese content", || {
        shows(&surface.view(), "Menu language ja")
    });
    let other = platform::AppView::new(mtm, options);
    surface.view().addSubview(&other.view());
    other.load(platform::App::Rust(platform::Root::of::<OtherMenus>()));
    until("the other surface's menu", || {
        app.mainMenu().is_some_and(|menu| {
            menu.itemArray()
                .iter()
                .any(|item| item.title().to_string() == "Other")
        })
    });
    let other_menu = app.mainMenu().unwrap();
    LANGUAGE.store(2, Ordering::SeqCst);
    until("the first surface's English content", || {
        shows(&surface.view(), "Menu language en")
    });
    assert!(app.mainMenu().is_some_and(|menu| menu == other_menu));
    assert_eq!(titles(mtm), (Some("Copy".into()), Some("Paste".into())));

    println!(
        "menu labels: locale changes relabel the owning surface without replacing another's menu"
    );
    other.stop();
    surface.stop();
    app.setMainMenu(saved_menu.as_deref());
    window.close();
}
