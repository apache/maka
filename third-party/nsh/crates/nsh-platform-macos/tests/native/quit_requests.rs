//! Standalone exit checks. Each case owns a process because approving a
//! system quit lets AppKit exit it. The Apple event targets only this test
//! process; it never asks the computer to log out or shut down.

use std::{
    process::Command,
    sync::atomic::{AtomicBool, AtomicUsize, Ordering::SeqCst},
    time::{Duration, Instant},
};

use nsh_core::{
    desktop::{QuitRequestOptions, WindowAttributes},
    element::{
        Owner, create_root,
        desktop::{
            cancel_quit_request, current_window, on_app_quit, on_quit_request, quit,
            set_quit_request_options,
        },
    },
    prelude::*,
};
use nsh_platform_macos::{
    self as platform,
    objc2::{
        MainThreadMarker, msg_send,
        rc::Retained,
        runtime::{AnyClass, AnyObject},
    },
    objc2_app_kit::{NSApplication, NSWindow},
    objc2_foundation::{NSArray, NSRunLoop},
};

static READY: AtomicBool = AtomicBool::new(false);
static REQUESTS: AtomicUsize = AtomicUsize::new(0);
static CLOSES: AtomicUsize = AtomicUsize::new(0);
static ACTION: AtomicUsize = AtomicUsize::new(0);
static LOADS: AtomicUsize = AtomicUsize::new(0);
static REPLACED: AtomicBool = AtomicBool::new(false);
static TIMEOUT_START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();

#[cfg(feature = "dev")]
thread_local! {
    static SERVER: std::cell::RefCell<Option<nsh_dev::DevServer>> = const { std::cell::RefCell::new(None) };
}

fn case() -> String {
    std::env::var("NSH_QUIT_CHECK_CASE").unwrap()
}

#[component]
#[allow(clippy::field_reassign_with_default)]
fn Guarded() -> impl IntoElement {
    let case = case();
    let load = LOADS.fetch_add(1, SeqCst);
    let mut options = QuitRequestOptions::default()
        .system(case.starts_with("system-") && case != "system-default")
        .main_window_close(
            case.starts_with("close-") && case != "close-default"
                || case == "system-upgrade"
                || case == "system-timeout",
        );
    if case == "close-system-only" {
        options = options.system(true).main_window_close(false);
    } else if case == "system-close-only" {
        options = options.system(false).main_window_close(true);
    } else if case.starts_with("reload-") {
        options = options.system(true).main_window_close(true);
    }
    // The replacement app registers a listener without setting a policy.
    if !case.starts_with("reload-") || load == 0 {
        set_quit_request_options(options);
    }
    if case == "close-guard" || case == "system-guard-close" {
        let mut attributes = WindowAttributes::default();
        attributes.close_on_press = Some(false);
        current_window().set(attributes);
    }
    current_window().on_close_press(|_| {
        CLOSES.fetch_add(1, SeqCst);
    });
    let replaced_listener = case.starts_with("close-listener-replaced").then(|| {
        create_root(|| {
            on_quit_request(|| {
                REQUESTS.fetch_add(1, SeqCst);
            });
        })
        .0
    });
    if !case.ends_with("no-listener") && replaced_listener.is_none() {
        let owner = Owner::current();
        on_quit_request(move || {
            let n = REQUESTS.fetch_add(1, SeqCst) + 1;
            println!("quit request {n}");
            if case == "system-cancel" {
                cancel_quit_request();
            } else if case == "system-approve" {
                quit();
            } else if case == "system-remove" || case == "system-remove-approve" {
                owner.dispose();
                if case == "system-remove-approve" {
                    quit();
                }
            }
        });
    }
    on_app_quit(|| async {
        println!(
            "cleanup requests={} closes={}",
            REQUESTS.load(SeqCst),
            CLOSES.load(SeqCst)
        );
    });
    set_interval(Duration::from_millis(5), move || {
        match ACTION.swap(0, SeqCst) {
            1 => cancel_quit_request(),
            2 => quit(),
            3 => {
                replaced_listener.unwrap().dispose();
                drop(run_on_main_thread(|| {
                    // Hold the main queue while the engine commits its new
                    // listener. Its batch then lands between cancellation's
                    // two queue hops, as during a busy native callback.
                    ACTION.store(4, SeqCst);
                    let deadline = Instant::now() + Duration::from_secs(2);
                    while !REPLACED.load(SeqCst) {
                        assert!(Instant::now() < deadline, "replacement never committed");
                        std::thread::sleep(Duration::from_millis(1));
                    }
                }));
            }
            4 => {
                on_quit_request(|| {
                    REQUESTS.fetch_add(1, SeqCst);
                });
                cancel_quit_request();
                drop(run_on_main_thread(|| {
                    let app = NSApplication::sharedApplication(MainThreadMarker::new().unwrap());
                    main_window(&app).performClose(None);
                }));
                // A later engine turn acknowledges that the batch above was
                // submitted, without waiting for the blocked main queue.
                set_timeout(Duration::from_millis(20), || REPLACED.store(true, SeqCst));
            }
            _ => {}
        }
    });
    // Waiting for a timer turn also lets the initial policy mount.
    set_timeout(Duration::from_millis(100), || READY.store(true, SeqCst));
    text("Quit request check")
}

/// Sends a quit Apple event with `keyAEQuitReason` to this process only.
fn system_quit() {
    // Sending to ourselves may dispatch synchronously. AppKit's
    // TerminateLater loop must start outside the serial main queue, so
    // the engine's batches and our driver can run while it waits.
    let block = block2::RcBlock::new(send_system_quit);
    // SAFETY: Foundation's immutable run loop mode constant.
    let modes = NSArray::from_slice(&[unsafe {
        nsh_platform_macos::objc2_foundation::NSDefaultRunLoopMode
    }]);
    // SAFETY: the block is made and run on the main thread.
    unsafe { NSRunLoop::mainRunLoop().performInModes_block(&modes, &block) };
}

fn send_system_quit() {
    let class = AnyClass::get(c"NSAppleEventDescriptor").unwrap();
    // SAFETY: Foundation's descriptor constructors, on the main thread.
    let event: Retained<AnyObject> = unsafe {
        let target: Retained<AnyObject> = msg_send![class, currentProcessDescriptor];
        let event: Retained<AnyObject> = msg_send![class,
            appleEventWithEventClass: u32::from_be_bytes(*b"aevt"),
            eventID: u32::from_be_bytes(*b"quit"),
            targetDescriptor: &*target,
            returnID: -1i16,
            transactionID: 0i32
        ];
        let reason: Retained<AnyObject> =
            msg_send![class, descriptorWithTypeCode: u32::from_be_bytes(*b"shut")];
        let _: () = msg_send![&*event,
            setAttributeDescriptor: &*reason,
            forKeyword: u32::from_be_bytes(*b"why?")
        ];
        event
    };
    // SAFETY: Sending to our own process, with kAENoReply. There is no
    // session-wide logout event and no other application is addressed.
    unsafe {
        let mut error: *mut AnyObject = std::ptr::null_mut();
        let _: Option<Retained<AnyObject>> = msg_send![&*event,
            sendEventWithOptions: 1usize, timeout: 1.0f64, error: &mut error
        ];
        assert!(error.is_null(), "could not send the test quit event");
    }
}

fn later(stage: usize) {
    dispatch2::DispatchQueue::main()
        .after(dispatch2::DispatchTime::NOW.time(200_000_000), move || {
            drive(stage)
        })
        .unwrap();
}

fn main_window(app: &NSApplication) -> Retained<NSWindow> {
    app.windows()
        .iter()
        .find(|w| w.title().to_string() == "Quit request check")
        .unwrap()
}

fn drive(stage: usize) {
    if !READY.load(SeqCst) {
        later(stage);
        return;
    }
    let app = NSApplication::sharedApplication(MainThreadMarker::new().unwrap());
    let window = main_window(&app);
    let case = case();
    if stage == 0 {
        if case == "system-timeout" {
            TIMEOUT_START.set(Instant::now()).unwrap();
        }
        if case == "close-listener-replaced" {
            ACTION.store(3, SeqCst);
        } else if (case.starts_with("system-") && case != "system-upgrade")
            || case == "reload-system"
        {
            system_quit();
        } else if case == "reload-local" {
            app.terminate(None);
        } else {
            window.performClose(None);
        }
    } else if case.starts_with("close-listener-replaced") {
        let pending = case.ends_with("pending");
        if pending && stage == 1 {
            assert_eq!(REQUESTS.load(SeqCst), 1);
            ACTION.store(3, SeqCst);
        } else {
            assert!(REPLACED.load(SeqCst));
            assert_eq!(
                REQUESTS.load(SeqCst),
                if pending { 2 } else { 1 },
                "the replacement confirmation remains shared"
            );
            assert_eq!(CLOSES.load(SeqCst), 0);
            if stage == if pending { 2 } else { 1 } {
                window.performClose(None);
            } else {
                ACTION.store(2, SeqCst);
                return;
            }
        }
    } else if case == "system-timeout" {
        assert!(window.isVisible(), "the timeout keeps the app alive");
        match stage {
            1 => {
                assert_eq!(REQUESTS.load(SeqCst), 1);
                dispatch2::DispatchQueue::main()
                    .after(dispatch2::DispatchTime::NOW.time(90_000_000_000), || {
                        drive(2)
                    })
                    .unwrap();
                return;
            }
            2 => {
                assert_eq!(REQUESTS.load(SeqCst), 1);
                assert!(
                    TIMEOUT_START.get().unwrap().elapsed() < Duration::from_secs(110),
                    "the pre-timeout check was delayed beyond its boundary"
                );
                println!(
                    "confirmation still shared at {:?}",
                    TIMEOUT_START.get().unwrap().elapsed()
                );
                window.performClose(None);
            }
            3 => {
                // Dispatch timers may coalesce. Probe with an eligible
                // close until expiry rather than sending terminate: a
                // second terminate while AppKit waits forces its exit.
                if REQUESTS.load(SeqCst) == 1 {
                    assert!(
                        TIMEOUT_START.get().unwrap().elapsed() < Duration::from_secs(125),
                        "the pending request did not expire"
                    );
                    window.performClose(None);
                    later(3);
                    return;
                }
                assert_eq!(REQUESTS.load(SeqCst), 2);
                assert!(TIMEOUT_START.get().unwrap().elapsed() >= Duration::from_secs(110));
                println!(
                    "new confirmation after expiry at {:?}",
                    TIMEOUT_START.get().unwrap().elapsed()
                );
                ACTION.store(1, SeqCst);
            }
            4 => system_quit(),
            5 => {
                assert_eq!(
                    REQUESTS.load(SeqCst),
                    3,
                    "the system request can be retried"
                );
                ACTION.store(1, SeqCst);
            }
            6 => {
                ACTION.store(2, SeqCst);
                return;
            }
            _ => unreachable!(),
        }
    } else if case == "system-guard-close" || case == "system-retained-close" {
        assert_eq!(REQUESTS.load(SeqCst), 1);
        match stage {
            1 => window.performClose(None),
            2 => {
                assert_eq!(CLOSES.load(SeqCst), 1, "the close handler still runs");
                assert_eq!(window.isVisible(), case == "system-guard-close");
                ACTION.store(1, SeqCst);
            }
            3 => {
                ACTION.store(2, SeqCst);
                return;
            }
            _ => unreachable!(),
        }
    } else if case == "system-default-close" {
        assert_eq!(REQUESTS.load(SeqCst), 1);
        assert_eq!(stage, 1, "a close without opting in must end the runner");
        window.performClose(None);
    } else if case.starts_with("reload-") {
        #[cfg(feature = "dev")]
        match stage {
            1 => {
                assert_eq!(REQUESTS.load(SeqCst), 1);
                READY.store(false, SeqCst);
                SERVER.with(|server| server.borrow().as_ref().unwrap().publish_root());
            }
            2 => {
                assert_eq!(LOADS.load(SeqCst), 2);
                assert_eq!(REQUESTS.load(SeqCst), 1);
                app.terminate(None);
            }
            3 => {
                assert_eq!(
                    REQUESTS.load(SeqCst),
                    2,
                    "the replacement listener hears Quit"
                );
                assert!(window.isVisible());
                if case == "reload-system" {
                    system_quit();
                } else {
                    window.performClose(None);
                }
            }
            _ => panic!("the replacement app must use the default exit policy"),
        }
    } else if case == "close-guard" || case == "close-retained" {
        assert_eq!(REQUESTS.load(SeqCst), 0);
        assert_eq!(CLOSES.load(SeqCst), 1);
        assert_eq!(window.isVisible(), case == "close-guard");
        ACTION.store(2, SeqCst);
        return;
    } else if case == "system-remove" {
        assert_eq!(REQUESTS.load(SeqCst), 1);
        assert!(window.isVisible());
        // With the listener gone the next system request follows the
        // default stop-and-return path, rather than a pending reply.
        system_quit();
        return;
    } else if case == "system-cancel" {
        assert_eq!(REQUESTS.load(SeqCst), stage);
        assert_eq!(CLOSES.load(SeqCst), 0);
        assert!(window.isVisible(), "cancelling keeps the window alive");
        if stage == 1 {
            system_quit();
        } else {
            ACTION.store(2, SeqCst);
            return;
        }
    } else if case == "system-upgrade" {
        assert_eq!(REQUESTS.load(SeqCst), 1, "one shared confirmation");
        assert_eq!(CLOSES.load(SeqCst), 0);
        if stage == 1 {
            system_quit();
        } else {
            ACTION.store(2, SeqCst);
            return;
        }
    } else if case == "close-enabled" {
        assert_eq!(CLOSES.load(SeqCst), 0, "no duplicate closePress prompt");
        assert!(window.isVisible());
        match stage {
            1 => {
                assert_eq!(REQUESTS.load(SeqCst), 1);
                window.performClose(None);
                app.terminate(None);
            }
            2 => {
                assert_eq!(REQUESTS.load(SeqCst), 1, "repeated exits share the prompt");
                ACTION.store(1, SeqCst);
            }
            3 => window.performClose(None),
            4 => {
                assert_eq!(REQUESTS.load(SeqCst), 2, "a cancelled close can be retried");
                ACTION.store(2, SeqCst);
                return;
            }
            _ => unreachable!(),
        }
    } else {
        panic!("{case} should have terminated before stage {stage}");
    }
    later(stage + 1);
}

#[allow(clippy::field_reassign_with_default)]
pub(super) fn run_case() {
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_secs(if case() == "system-timeout" {
            130
        } else {
            15
        }));
        eprintln!("quit check timed out");
        std::process::exit(2);
    });
    later(0);
    let mut options = platform::AppOptions::default();
    options.title = "Quit request check".into();
    options.keep_alive_on_close = case() == "close-retained" || case() == "system-retained-close";
    let source = platform::AppSource::Rust(platform::Root::of::<Guarded>());
    #[cfg(feature = "dev")]
    let source = if case().starts_with("reload-") {
        platform::set_root(platform::Root::of::<Guarded>);
        let server =
            nsh_dev::DevServer::start("127.0.0.1:0".parse().unwrap(), "", None, |_| {}).unwrap();
        server.publish_root();
        let url = format!("ws://{}/ws", server.local_addr());
        SERVER.with(|slot| *slot.borrow_mut() = Some(server));
        platform::AppSource::DevServer(url)
    } else {
        source
    };
    assert_eq!(
        platform::run_app(source, options),
        std::process::ExitCode::SUCCESS
    );
    println!(
        "returned requests={} closes={}",
        REQUESTS.load(SeqCst),
        CLOSES.load(SeqCst)
    );
}

pub(super) fn run() {
    for (case, expected) in [
        ("close-default", "returned requests=0 closes=1"),
        ("close-no-listener", "returned requests=0 closes=1"),
        ("close-system-only", "returned requests=0 closes=1"),
        ("close-enabled", "returned requests=2 closes=0"),
        ("close-guard", "returned requests=0 closes=1"),
        ("close-retained", "returned requests=0 closes=1"),
        ("system-default", "returned requests=0 closes=0"),
        ("system-no-listener", "returned requests=0 closes=0"),
        ("system-close-only", "returned requests=0 closes=0"),
        ("system-cancel", "returned requests=2 closes=0"),
        ("system-remove", "returned requests=1 closes=0"),
        ("system-remove-approve", "quit request 1"),
        ("system-approve", "cleanup requests=1 closes=0"),
        ("system-upgrade", "cleanup requests=1 closes=0"),
        ("system-guard-close", "returned requests=1 closes=1"),
        ("system-retained-close", "returned requests=1 closes=1"),
        ("system-default-close", "returned requests=1 closes=1"),
        ("close-listener-replaced", "returned requests=1 closes=0"),
        (
            "close-listener-replaced-pending",
            "returned requests=2 closes=0",
        ),
        ("system-timeout", "returned requests=3 closes=0"),
        #[cfg(feature = "dev")]
        ("reload-local", "returned requests=2 closes=1"),
        #[cfg(feature = "dev")]
        ("reload-system", "returned requests=2 closes=0"),
    ] {
        if case == "system-timeout" && std::env::var_os("NSH_QUIT_TIMEOUT_CHECK").is_none() {
            continue;
        }
        let output = Command::new(std::env::current_exe().unwrap())
            .arg("--ignored")
            .env("NSH_QUIT_CHECK_CASE", case)
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(output.status.success(), "{case}: {stdout}\n{stderr}");
        assert!(stdout.contains(expected), "{case}: {stdout}\n{stderr}");
        if case == "system-approve" || case == "system-upgrade" || case == "system-remove-approve" {
            assert!(
                !stdout.contains("returned"),
                "AppKit owns approved system termination"
            );
        }
        println!("quit_requests: {case}: {expected}");
    }
}
