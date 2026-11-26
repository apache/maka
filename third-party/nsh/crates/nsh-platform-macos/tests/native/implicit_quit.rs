//! Standalone macOS close checks for implicit and explicit main windows.
//! Each case runs in its own process with a real `NSApplication` and `NSWindow`.

use std::{
    process::Command,
    sync::atomic::{AtomicBool, Ordering::SeqCst},
    time::Duration,
};

use nsh_platform_macos::{
    self as platform, Bundle,
    objc2::{MainThreadMarker, rc::Retained},
    objc2_app_kit::{NSApplication, NSEvent, NSEventModifierFlags, NSEventType, NSWindow},
    objc2_foundation::{NSPoint, NSString},
};

const TITLE: &str = "Implicit quit check";
static STAYED_ALIVE: AtomicBool = AtomicBool::new(false);

fn case() -> String {
    std::env::var("NSH_IMPLICIT_QUIT_CASE").unwrap()
}

fn app_window(app: &NSApplication) -> Option<Retained<NSWindow>> {
    app.windows()
        .iter()
        .find(|w| w.isVisible() && w.title().to_string() == TITLE)
}

fn visible_app_windows(app: &NSApplication) -> usize {
    app.windows()
        .iter()
        .filter(|w| w.isVisible() && w.title().to_string() == TITLE)
        .count()
}

fn schedule(delay_ms: u64, f: impl FnOnce() + Send + 'static) {
    dispatch2::DispatchQueue::main()
        .after(
            dispatch2::DispatchTime::NOW.time((delay_ms * 1_000_000) as i64),
            f,
        )
        .unwrap();
}

fn send_cmd_w(app: &NSApplication, window: &NSWindow) {
    let chars = NSString::from_str("w");
    let event = NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(
        NSEventType::KeyDown,
        NSPoint::new(0.0, 0.0),
        NSEventModifierFlags::Command,
        0.0,
        window.windowNumber(),
        None,
        &chars,
        &chars,
        false,
        13,
    )
    .expect("Cmd+W key event");
    let handled = app
        .mainMenu()
        .is_some_and(|menu| menu.performKeyEquivalent(&event));
    assert!(handled, "main menu should handle Cmd+W");
}

fn drive(attempt: usize) {
    let mtm = MainThreadMarker::new().unwrap();
    let app = NSApplication::sharedApplication(mtm);
    let Some(window) = app_window(&app) else {
        assert!(attempt < 50, "app window never became visible");
        schedule(100, move || drive(attempt + 1));
        return;
    };
    let name = case();
    if name == "implicit-cmd-w" {
        if !window.isKeyWindow() {
            assert!(attempt < 50, "app window never became key for Cmd+W");
            #[allow(deprecated)]
            app.activateIgnoringOtherApps(true);
            window.makeKeyAndOrderFront(None);
            schedule(100, move || drive(attempt + 1));
            return;
        }
        send_cmd_w(&app, &window);
    } else {
        // Red close button action (`performClose:`).
        window.performClose(None);
    }
    if matches!(
        name.as_str(),
        "implicit-platform" | "implicit-runtime-platform" | "explicit-window"
    ) {
        schedule(600, move || {
            let mtm = MainThreadMarker::new().unwrap();
            let app = NSApplication::sharedApplication(mtm);
            assert_eq!(
                visible_app_windows(&app),
                0,
                "window should be closed while app stays alive in Dock"
            );
            STAYED_ALIVE.store(true, SeqCst);
            platform::quit_app();
        });
    }
}

pub(super) fn run_case() {
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_secs(12));
        eprintln!("implicit_quit case `{}` timed out", case());
        std::process::exit(2);
    });
    schedule(100, || drive(0));

    let name = case();
    let source = match name.as_str() {
        "implicit-close" | "implicit-cmd-w" => Bundle::source(format!(
            r#"
            import {{ mount }} from "nsh";
            import {{ currentWindow }} from "nsh/desktop";
            import {{ element }} from "nsh:rt";
            mount(() => {{
                currentWindow().set({{ title: {TITLE:?} }});
                return element("view");
            }});
            "#
        )),
        "implicit-platform" => Bundle::source(format!(
            r#"
            import {{ mount }} from "nsh";
            import {{ currentWindow }} from "nsh/desktop";
            import {{ element }} from "nsh:rt";
            mount(() => {{
                currentWindow().set({{ title: {TITLE:?} }});
                return element("view");
            }});
            "#
        ))
        .with_application(Some(r#"{"quitMode":"platform"}"#)),
        "implicit-runtime-platform" => Bundle::source(format!(
            r#"
            import {{ mount }} from "nsh";
            import {{ Application, currentWindow }} from "nsh/desktop";
            import {{ element }} from "nsh:rt";
            mount(() => {{
                Application.setQuitMode("platform");
                currentWindow().set({{ title: {TITLE:?} }});
                return element("view");
            }});
            "#
        )),
        "explicit-window" => Bundle::source(format!(
            r#"
            import {{ mount, signal }} from "nsh";
            import {{ Window }} from "nsh/desktop";
            import {{ element }} from "nsh:rt";
            mount(() => {{
                const open = signal(true);
                return Window({{
                    id: "main",
                    title: {TITLE:?},
                    get open() {{ return open(); }},
                    onOpenChange: ({{ open: now }}) => open.set(now),
                    get children() {{ return element("view"); }},
                }});
            }});
            "#
        )),
        other => panic!("unknown case: {other}"),
    };

    let options = platform::AppOptions {
        title: TITLE.into(),
        ..platform::AppOptions::default()
    };
    assert_eq!(
        platform::run_app(platform::AppSource::Bundle(source), options),
        std::process::ExitCode::SUCCESS
    );
    println!("returned stayed_alive={}", STAYED_ALIVE.load(SeqCst));
}

pub(super) fn run() {
    for (name, expected) in [
        ("implicit-close", "returned stayed_alive=false"),
        ("implicit-cmd-w", "returned stayed_alive=false"),
        ("implicit-platform", "returned stayed_alive=true"),
        ("implicit-runtime-platform", "returned stayed_alive=true"),
        ("explicit-window", "returned stayed_alive=true"),
    ] {
        let output = Command::new(std::env::current_exe().unwrap())
            .arg("--ignored")
            .env("NSH_IMPLICIT_QUIT_CASE", name)
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(output.status.success(), "{name}: {stdout}\n{stderr}");
        assert!(stdout.contains(expected), "{name}: {stdout}\n{stderr}");
        println!("implicit_quit: {name}: {expected}");
    }
}
