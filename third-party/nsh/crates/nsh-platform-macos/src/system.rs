//! Surface-wide commands and the environment: dialogs, announcements,
//! the clipboard, exiting; the system's settings followed into
//! [`Environment`].
//!
//! Dialogs are `NSAlert`s ([`show_dialog`]). One is a sheet of the window
//! the user is in while they see that window. A sheet of a window out of
//! sight (a tray app's hidden main window, the app hidden, the window
//! minimized or off every screen) would stay out of sight with it, its
//! answer waiting for the window to show, so the alert then shows on its
//! own, in front, the app activated first: the open and save panels' rule
//! ([`crate::window::panel_window`]). AppKit shows an alert on its own only
//! app-modal, in a modal loop of its own (`runModal`), which
//! [`run_alone`] enters from a turn of the main run loop, never from the
//! batch that raised the alert or from a main-queue block. Neither form
//! blocks the main thread: the modal loop runs the main queue (the app's
//! batches, the test agent's calls), the display link and the surface's
//! timers, so the app goes on while the alert shows; only input to the
//! app's other windows waits for the answer.
//!
//! The environment follows:
//! - the color scheme: the app's appearance (`nsh.json` `"appearance"`,
//!   `setColorScheme`; [`set_appearance`]) when it forces one, else the
//!   root view's effective appearance (the window's, the system's), live;
//! - the locale (`Intl`'s default): `NSLocale.currentLocale` (the region
//!   format of System Settings), live;
//! - the locale settings (`localeSettings()`), read together with the other
//!   settings, as on `NSCurrentLocaleDidChangeNotification`: the preferred
//!   languages, `NSLocale.preferredLanguages` (System Settings' list, the
//!   app's own language first when the user chose one for it); the regional
//!   preferences, System Settings' time format (the hours of
//!   `NSDateFormatter`'s format for the `j` template, which 24-hour time
//!   changes), `NSCalendar`'s first weekday, `NSLocale`'s measurement system
//!   and the `AppleTemperatureUnit` default, over the region's; the time
//!   zone, `NSTimeZone.systemTimeZone`'s name, live
//!   (`NSSystemTimeZoneDidChangeNotification`, after which Foundation's
//!   cached zone is reset);
//! - right to left: the user's first preferred language;
//! - reduce motion and VoiceOver: `NSWorkspace`'s accessibility settings,
//!   live;
//! - whether the app is in use (`lifecycle()`): `background` while none of
//!   it shows (hidden, or `NSApplication.occlusionState` without
//!   `visible`: its windows minimized or covered), `active` while it is the
//!   active app, `inactive` otherwise; live, from `NSApplication`'s
//!   activation, hiding and occlusion notifications. An embedded surface
//!   follows the embedding app's, which is the application;
//! - the wake count (`wakeCount()`): one more on every
//!   `NSWorkspaceDidWakeNotification`, for every surface;
//! - the pixel ratio: the window's backing scale factor;
//! - the window's bounds, mode and display ([`crate::window_state`]), and
//!   the displays, sent again when they change;
//! - the OS version: `NSProcessInfo.operatingSystemVersion`.
//!
//! The font scale is 1 (macOS has no text size setting apps follow), the
//! safe area and keyboard height are zero: desktop windows have neither.
//!
//! The app's appearance is set on the root view too, so the AppKit views
//! it hosts (text fields, scroll bars) match the app. The surface's
//! background, under the root view (which has none of its own), is the
//! app's: the opaque background of its top view when that fills the root,
//! else, in the standalone runner's window, white / neutral-950 by the
//! scheme (as the Linux backend's), and in a host app's view none: an
//! embedded `AppView` shows its host through, as on iOS. It shows where
//! the app has not drawn yet, as in the area a window grows by before the
//! layout at its new size arrives. A see-through surface
//! ([`crate::AppOptions::transparent`]) has none: what the app leaves
//! unpainted shows what is behind the window.
//!
//! The status bar has no desktop equivalent. The clipboard is the general
//! pasteboard; `hasText` only looks at the types on offer.

use std::{
    cell::{Cell, RefCell},
    ptr::NonNull,
    rc::{Rc, Weak},
};

use block2::RcBlock;
use dispatch2::DispatchQueue;
use nsh_core::{
    Command, Dialog, DialogButtonStyle, EventKind, EventPayload, NodeId, PayloadValue, ROOT_ID,
    geometry::px, platform::clipboard,
};
use nsh_engine::{
    ColorScheme, Edges, Environment, HourCycle, Idiom, Languages, Lifecycle, Locale,
    LocaleSettings, MeasurementSystem, Os, TemperatureUnit, TimeZone, Weekday,
};
use objc2::{
    AllocAnyThread, MainThreadMarker, MainThreadOnly, define_class, msg_send,
    rc::Retained,
    runtime::{AnyObject, ProtocolObject},
};
use objc2_app_kit::{
    NSAccessibilityPriorityLevel, NSAlert, NSAlertFirstButtonReturn, NSAlertStyle, NSAppearance,
    NSAppearanceCustomization, NSAppearanceNameAqua, NSAppearanceNameDarkAqua, NSApplication,
    NSApplicationDidBecomeActiveNotification, NSApplicationDidChangeOcclusionStateNotification,
    NSApplicationDidChangeScreenParametersNotification, NSApplicationDidHideNotification,
    NSApplicationDidResignActiveNotification, NSApplicationDidUnhideNotification,
    NSApplicationOcclusionState, NSAttributedStringAppKitDocumentFormats,
    NSAttributedStringDocumentFormats, NSBitmapImageFileType, NSBitmapImageRep,
    NSDocumentTypeDocumentAttribute, NSEvent, NSEventModifierFlags, NSEventType,
    NSExcludedElementsDocumentAttribute, NSHTMLTextDocumentType, NSModalPanelRunLoopMode,
    NSModalResponse, NSModalResponseAbort, NSPasteboard, NSPasteboardItem, NSPasteboardTypeHTML,
    NSPasteboardTypeRTF, NSPasteboardTypeRTFD, NSPasteboardTypeString, NSScreen, NSTextField,
    NSWorkspace, NSWorkspaceAccessibilityDisplayOptionsDidChangeNotification,
    NSWorkspaceDidWakeNotification,
};
use objc2_foundation::{
    NSArray, NSAttributedString, NSCalendar, NSCurrentLocaleDidChangeNotification, NSData,
    NSDateFormatter, NSDefaultRunLoopMode, NSDictionary, NSKeyValueObservingOptions, NSLocale,
    NSLocaleLanguageDirection, NSLocaleMeasurementSystem, NSNotification, NSNotificationCenter,
    NSObject, NSObjectNSKeyValueObserverRegistration, NSObjectProtocol, NSOperationQueue, NSPoint,
    NSProcessInfo, NSPropertyListReadOptions, NSPropertyListSerialization, NSRange, NSRunLoop,
    NSString, NSSystemTimeZoneDidChangeNotification, NSTimeZone, NSURL, NSUserDefaults, ns_string,
};

use crate::surface::Surface;

/// A dialog of a surface: its `NSAlert` ([`show_dialog`]).
struct Shown {
    surface: Weak<Surface>,
    alert: Retained<NSAlert>,
    answer: Rc<DialogAnswer>,
    /// The dialog's index of the alert's button n (see `show_dialog`).
    order: Vec<usize>,
    /// Where it shows.
    shows: Shows,
}

/// Where an alert shows ([`show_dialog`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Shows {
    /// As a sheet of a window the user sees.
    Sheet,
    /// On its own, after the alert shown on its own now ([`run_alone`]).
    Waiting,
    /// On its own: its modal loop runs ([`run_alone`]).
    Alone,
}

#[derive(Default)]
struct System {
    installed: bool,
    surfaces: Vec<Weak<Surface>>,
    /// Notification observers, kept for as long as the thread runs.
    observers: Vec<Retained<ProtocolObject<dyn NSObjectProtocol>>>,
    /// Observes `NSWorkspace.voiceOverEnabled`.
    voice_over: Option<Retained<Observer>>,
    /// The dialogs shown or waiting to show, oldest first.
    dialogs: Vec<Shown>,
}

thread_local! {
    static SYSTEM: RefCell<System> = RefCell::default();
}

define_class!(
    /// Hears key-value changes of the system's settings.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "NshSystemObserver"]
    struct Observer;

    unsafe impl NSObjectProtocol for Observer {}

    impl Observer {
        #[unsafe(method(observeValueForKeyPath:ofObject:change:context:))]
        fn observe(
            &self,
            _key_path: Option<&NSString>,
            _object: Option<&AnyObject>,
            _change: Option<&AnyObject>,
            _context: *mut std::ffi::c_void,
        ) {
            system_changed();
        }
    }
);

/// The window or its screen changed (scale, ...).
pub(crate) fn window_changed(surface: &Rc<Surface>) {
    crate::chrome::window_changed(surface);
    crate::window_state::watch(surface);
    update(surface);
}

/// The root view's effective appearance changed (the system's, the
/// window's).
pub(crate) fn appearance_changed(surface: &Rc<Surface>) {
    update(surface);
}

/// The color scheme: the app's appearance, else the root view's.
pub(crate) fn color_scheme(surface: &Surface) -> ColorScheme {
    let system = if surface
        .root
        .ns()
        .effectiveAppearance()
        .name()
        .to_string()
        .contains("Dark")
    {
        ColorScheme::Dark
    } else {
        ColorScheme::Light
    };
    surface.appearance.get().resolve(system)
}

/// Starts following the system's settings.
pub(crate) fn watch_environment(surface: &Rc<Surface>) {
    install(surface.mtm);
    SYSTEM.with(|s| {
        let mut s = s.borrow_mut();
        s.surfaces.retain(|w| w.strong_count() > 0);
        s.surfaces.push(Rc::downgrade(surface));
    });
    update(surface);
    environment_applied(surface);
}

/// Installs the watchers of the system's settings (once per thread).
fn install(mtm: MainThreadMarker) {
    if SYSTEM.with(|s| std::mem::replace(&mut s.borrow_mut().installed, true)) {
        return;
    }
    let workspace = NSWorkspace::sharedWorkspace();
    let block = RcBlock::new(|_: NonNull<NSNotification>| system_changed());
    let wake = RcBlock::new(|_: NonNull<NSNotification>| woke());
    let queue = NSOperationQueue::mainQueue();
    // SAFETY: immutable constants; the block is called on the main queue,
    // and the observers are kept (and never removed) while the thread runs.
    let observers = unsafe {
        vec![
            // The system woke from sleep (`wakeCount()`): posted to the
            // workspace's center only.
            workspace
                .notificationCenter()
                .addObserverForName_object_queue_usingBlock(
                    Some(NSWorkspaceDidWakeNotification),
                    None,
                    Some(&queue),
                    &wake,
                ),
            workspace
                .notificationCenter()
                .addObserverForName_object_queue_usingBlock(
                    Some(NSWorkspaceAccessibilityDisplayOptionsDidChangeNotification),
                    None,
                    Some(&queue),
                    &block,
                ),
            NSNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(
                Some(NSCurrentLocaleDidChangeNotification),
                None,
                Some(&queue),
                &block,
            ),
        ]
    };
    // The time zone: Foundation caches the system's until it is reset.
    let zone_changed = RcBlock::new(|_: NonNull<NSNotification>| {
        NSTimeZone::resetSystemTimeZone();
        system_changed();
    });
    // SAFETY: as above.
    let zone_observer = unsafe {
        NSNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(
            Some(NSSystemTimeZoneDidChangeNotification),
            None,
            Some(&queue),
            &zone_changed,
        )
    };
    // Whether the app is in use (`lifecycle`).
    // SAFETY: as above.
    let observers = observers.into_iter().chain([zone_observer]).chain(
        unsafe {
            [
                NSApplicationDidBecomeActiveNotification,
                NSApplicationDidResignActiveNotification,
                NSApplicationDidHideNotification,
                NSApplicationDidUnhideNotification,
                NSApplicationDidChangeOcclusionStateNotification,
            ]
        }
        .into_iter()
        .map(|name| {
            // SAFETY: as above.
            unsafe {
                NSNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(
                    Some(name),
                    None,
                    Some(&queue),
                    &block,
                )
            }
        }),
    );
    // The displays: plugged in, unplugged, arranged again.
    let screens = RcBlock::new(|_: NonNull<NSNotification>| screens_changed());
    // Another app came in front (or this one hid): the keys held are no
    // longer held, and their releases may never come. No release is made
    // up for them.
    let resigned = RcBlock::new(|_: NonNull<NSNotification>| {
        for surface in surfaces() {
            crate::keyboard::deactivated(&surface);
        }
    });
    // SAFETY: as above.
    let observers = observers
        .chain([
            unsafe {
                NSNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(
                    Some(NSApplicationDidResignActiveNotification),
                    None,
                    Some(&queue),
                    &resigned,
                )
            },
            unsafe {
                NSNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(
                    Some(NSApplicationDidChangeScreenParametersNotification),
                    None,
                    Some(&queue),
                    &screens,
                )
            },
        ])
        .collect();
    // VoiceOver posts no notification: its setting is observed.
    // SAFETY: NSObject's initializer.
    let observer: Retained<Observer> = unsafe { msg_send![Observer::alloc(mtm), init] };
    // SAFETY: the observer is kept (and never removed) while the thread
    // runs; `voiceOverEnabled` is a KVO-compliant property of the
    // workspace.
    unsafe {
        workspace.addObserver_forKeyPath_options_context(
            &observer,
            ns_string!("voiceOverEnabled"),
            NSKeyValueObservingOptions::New,
            std::ptr::null_mut(),
        );
    }
    SYSTEM.with(|s| {
        let mut s = s.borrow_mut();
        s.observers = observers;
        s.voice_over = Some(observer);
    });
}

/// This thread's surfaces.
fn surfaces() -> Vec<Rc<Surface>> {
    SYSTEM.with(|s| {
        let mut s = s.borrow_mut();
        s.surfaces.retain(|w| w.strong_count() > 0);
        s.surfaces.iter().filter_map(Weak::upgrade).collect()
    })
}

/// A system setting changed: tells every surface.
fn system_changed() {
    for surface in surfaces() {
        update(&surface);
    }
}

/// The system woke from sleep: every surface counts it (`wakeCount()`).
fn woke() {
    for surface in surfaces() {
        let mut env: Environment = surface.environment.get();
        env.wake_count = env.wake_count.wrapping_add(1);
        surface.set_environment(env);
    }
}

/// The displays changed: every surface's engine gets them, and its
/// window's state (its display's visible bounds) is read again.
fn screens_changed() {
    for surface in surfaces() {
        let displays = crate::window_state::displays(surface.mtm);
        surface.control(|c| c.set_displays(displays));
        crate::window_state::changed(&surface);
        crate::window::screens_changed(&surface);
    }
}

/// The embedding app set its locale or text size
/// ([`crate::AppView::set_locale`]): the system's settings are read again,
/// with the host's over them.
pub(crate) fn host_environment_changed(surface: &Surface) {
    update(surface);
}

/// `nsh test --target macos` started driving the surface: its lifecycle
/// no longer follows a locked screen (`lifecycle`).
#[cfg(feature = "dev")]
pub(crate) fn testing_started(surface: &Surface) {
    update(surface);
}

/// Writes the system's settings and the surface's own values into its
/// environment.
fn update(surface: &Surface) {
    let workspace = NSWorkspace::sharedWorkspace();
    let mut env: Environment = surface.environment.get();
    env.color_scheme = color_scheme(surface);
    env.locale = current_locale();
    env.locale_settings = locale_settings(env.locale);
    env.font_scale = 1.0;
    env.reduce_motion = workspace.accessibilityDisplayShouldReduceMotion();
    env.screen_reader = workspace.isVoiceOverEnabled();
    env.rtl = preferred_language_rtl();
    env.pixel_ratio = pixel_ratio(surface);
    env.os = Os::MacOs;
    env.os_version = os_version();
    env.idiom = Idiom::Desktop;
    env.safe_area = Edges::default();
    env.keyboard_height = px(0.0);
    if !surface.terminal.get() {
        env.lifecycle = lifecycle(surface.mtm, surface.testing());
        env.window_state = crate::window_state::read(surface);
    }
    surface.set_environment(env);
}

/// The system's time zone: its IANA name.
fn time_zone() -> TimeZone {
    TimeZone::parse(&NSTimeZone::systemTimeZone().name().to_string()).unwrap_or_default()
}

/// Whether the app is in use: `background` while none of it shows (hidden,
/// or its windows minimized or covered), `active` while it is the active
/// app, `inactive` otherwise. A test's app (`testing`) is not in the
/// background because the screen is locked: it runs as it does on screen
/// (`Surface::keep_deadline`), so its tests see what they see unlocked.
fn lifecycle(mtm: MainThreadMarker, testing: bool) -> Lifecycle {
    let app = NSApplication::sharedApplication(mtm);
    let occluded = !app
        .occlusionState()
        .contains(NSApplicationOcclusionState::Visible);
    if app.isHidden() || (occluded && !(testing && screen_locked())) {
        Lifecycle::Background
    } else if app.isActive() {
        Lifecycle::Active
    } else {
        Lifecycle::Inactive
    }
}

/// Whether the user's session cannot show windows now: the screen is
/// locked, or the session is not the console's (another user switched in).
/// The window server then draws no window, the display link stops and the
/// app cannot become active, while its windows, posted events and
/// in-process drawing still work. One call to the window server; without
/// a session at all, it counts as locked.
pub(crate) fn screen_locked() -> bool {
    use objc2_core_foundation::{CFBoolean, CFDictionary, CFRetained, CFString, CFType};

    // Declared here: `objc2-core-graphics` has it behind its `CGSession`
    // feature, which the workspace does not turn on.
    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGSessionCopyCurrentDictionary() -> Option<NonNull<CFDictionary>>;
    }
    // SAFETY: CoreGraphics' public function: no arguments, and it returns
    // a dictionary the caller owns (the Copy rule), or null without a
    // window server session.
    let Some(raw) = (unsafe { CGSessionCopyCurrentDictionary() }) else {
        return true;
    };
    // SAFETY: an owned reference, as the Copy rule hands it over.
    let session = unsafe { CFRetained::from_raw(raw) };
    let flag = |name: &'static str| -> Option<bool> {
        let key = CFString::from_static_str(name);
        // SAFETY: the dictionary's keys are `CFString`s, as `key` is.
        let value = unsafe { session.value((&*key as *const CFString).cast()) };
        // SAFETY: a value of the dictionary (a CF object) or null; it
        // lives as long as the dictionary, which outlives this use.
        let value = unsafe { value.cast::<CFType>().as_ref() }?;
        value.downcast_ref::<CFBoolean>().map(CFBoolean::value)
    };
    // The first key is there only while the screen is locked.
    flag("CGSSessionScreenIsLocked") == Some(true) || flag("kCGSSessionOnConsoleKey") == Some(false)
}

/// The surface's environment changed: its background follows the scheme.
pub(crate) fn environment_applied(surface: &Surface) {
    follow_background(surface);
}

/// Sets the surface's background (see the module doc), if it changed. A
/// see-through window ([`crate::AppOptions::transparent`]) has none: what
/// the app leaves unpainted shows what is behind the window.
fn follow_background(surface: &Surface) {
    if surface.transparent.get() {
        if surface.background.replace(None).is_some()
            && let Some(layer) = crate::view::superview(surface.root.ns()).and_then(|v| v.layer())
        {
            crate::surface::quiet(|| layer.setBackgroundColor(None));
        }
        return;
    }
    let app = surface
        .root
        .container()
        .subviews()
        .firstObject()
        .and_then(|v| crate::view::NshView::from_ns(&v))
        .and_then(|top| {
            let root = surface.root.state().frame;
            let s = top.state();
            let fills = s.frame.origin.x.0 <= 0.0
                && s.frame.origin.y.0 <= 0.0
                && s.frame.origin.x.0 + s.frame.size.width.0 >= root.size.width.0
                && s.frame.origin.y.0 + s.frame.size.height.0 >= root.size.height.0;
            let color = s.background();
            (fills && color.0 & 0xff == 0xff).then_some(color)
        });
    let color = app.unwrap_or(if !surface.standalone.get() {
        nsh_core::Color::rgba(0, 0, 0, 0)
    } else if surface.environment.get().color_scheme == ColorScheme::Dark {
        nsh_core::Color::rgba(10, 10, 10, 255)
    } else {
        nsh_core::Color::rgba(255, 255, 255, 255)
    });
    if surface.background.replace(Some(color)) == Some(color) {
        return;
    }
    crate::window::set_background(surface, color);
    // The root's own layer is the app's (its style); the view holding it
    // is the surface's. A main window that shows through keeps it clear.
    let Some(layer) = crate::view::superview(surface.root.ns()).and_then(|v| v.layer()) else {
        surface.background.set(None);
        return;
    };
    if surface.main_window.transparent() {
        return;
    }
    crate::surface::quiet(|| layer.setBackgroundColor(Some(&crate::text::cg_color(color))));
}

/// Device pixels per point of the surface's window (or the main screen's).
fn pixel_ratio(surface: &Surface) -> f32 {
    if surface.terminal.get() {
        return surface.terminal_scale.get();
    }
    let root = surface.root.ns();
    let scale = match root.window() {
        Some(window) => window.backingScaleFactor(),
        None => NSScreen::mainScreen(surface.mtm).map_or(2.0, |s| s.backingScaleFactor()),
    };
    scale as f32
}

/// The user's region format (`NSLocale.currentLocale`), `Intl`'s default.
fn current_locale() -> Locale {
    let identifier = NSLocale::currentLocale().localeIdentifier().to_string();
    Locale::parse(&identifier).unwrap_or_default()
}

/// The user's preferred languages, most preferred first; `locale` alone
/// when the list names none.
fn preferred_languages(locale: Locale) -> Languages {
    let tags: Vec<String> = NSLocale::preferredLanguages()
        .iter()
        .map(|tag| tag.to_string())
        .collect();
    Languages::parse(tags.iter().map(String::as_str)).unwrap_or(Languages::one(locale))
}

/// The user's locale settings (`localeSettings()`): the preferred languages
/// (`locale` alone when the list names none), the time zone, and System
/// Settings' time format, first day of the week, measurement system and
/// temperature unit, over the region's.
fn locale_settings(user_locale: Locale) -> LocaleSettings {
    let locale = NSLocale::currentLocale();
    let mut preferences = LocaleSettings::parse(&locale.localeIdentifier().to_string());
    preferences.languages = preferred_languages(user_locale);
    preferences.time_zone = time_zone();
    // The hours of the user's time format, which 24-hour time changes.
    let hours =
        NSDateFormatter::dateFormatFromTemplate_options_locale(ns_string!("j"), 0, Some(&locale));
    if let Some(cycle) = hours.and_then(|format| HourCycle::of_pattern(&format.to_string())) {
        preferences.hour_cycle = cycle;
    }
    // From 1 for Sunday to 7 for Saturday.
    let first = match NSCalendar::currentCalendar().firstWeekday() {
        1 => Some(Weekday::Sunday),
        n => u8::try_from(n)
            .ok()
            .and_then(|n| Weekday::from_number(n.wrapping_sub(1))),
    };
    if let Some(day) = first {
        preferences.first_day_of_week = day;
    }
    // SAFETY: a key Foundation defines.
    let system = locale.objectForKey(unsafe { NSLocaleMeasurementSystem });
    match system
        .and_then(|s| s.downcast::<NSString>().ok())
        .map(|s| s.to_string())
        .as_deref()
    {
        Some("Metric") => preferences.measurement_system = MeasurementSystem::Metric,
        Some("U.S.") => preferences.measurement_system = MeasurementSystem::Us,
        Some("U.K.") => preferences.measurement_system = MeasurementSystem::Uk,
        _ => {}
    }
    // Set once the user picks one.
    let unit =
        NSUserDefaults::standardUserDefaults().stringForKey(ns_string!("AppleTemperatureUnit"));
    match unit.map(|u| u.to_string()).as_deref() {
        Some("Celsius") => preferences.temperature_unit = TemperatureUnit::Celsius,
        Some("Fahrenheit") => preferences.temperature_unit = TemperatureUnit::Fahrenheit,
        _ => {}
    }
    preferences
}

/// Whether the user's first language is written right to left (as React
/// Native decides; the app's own localizations do not matter).
fn preferred_language_rtl() -> bool {
    NSLocale::preferredLanguages()
        .firstObject()
        .is_some_and(|language| {
            NSLocale::characterDirectionForLanguage(&language)
                == NSLocaleLanguageDirection::RightToLeft
        })
}

/// The macOS version, read once.
fn os_version() -> (u16, u16) {
    static VERSION: std::sync::OnceLock<(u16, u16)> = std::sync::OnceLock::new();
    *VERSION.get_or_init(|| {
        let v = NSProcessInfo::processInfo().operatingSystemVersion();
        (v.majorVersion as u16, v.minorVersion as u16)
    })
}

/// A command not addressed to a kind of view.
pub(crate) fn command(surface: &Rc<Surface>, id: NodeId, command: &Command) {
    match command {
        Command::Dialog(dialog) => show_dialog(surface, dialog),
        Command::CloseDialog(dialog) => close_dialog(surface, *dialog),
        Command::Desktop(command) => crate::chrome::command(surface, command),
        Command::PerfMonitor(show) => {
            if let Some(toggle) = &*surface.perf_toggle.borrow() {
                toggle(*show);
            }
        }
        Command::PerfMonitorMode(mode) => {
            if let Some(set) = &*surface.perf_mode.borrow() {
                set(*mode);
            }
        }
        Command::SetAppUrl(url) | Command::PushAppUrl(url) if id == nsh_core::ROOT_ID => {
            if let Some(activity) = surface.handoff.borrow_mut().as_mut() {
                activity.publish(url);
            }
        }
        Command::Announce(text) => crate::access::announce(
            crate::window::key_root(surface).ns(),
            text,
            NSAccessibilityPriorityLevel::Medium,
        ),
        Command::SetClipboard(text) => write_clipboard(surface, text),
        Command::SetClipboardItem(item) => {
            if surface.terminal.get() {
                write_clipboard(surface, &item.text);
                return;
            }
            let pasteboard = NSPasteboard::generalPasteboard();
            pasteboard.clearContents();
            // SAFETY: immutable AppKit constants.
            let (string, kind_html) = unsafe { (NSPasteboardTypeString, NSPasteboardTypeHTML) };
            pasteboard.setString_forType(&NSString::from_str(&item.text), string);
            if let Some(html) = &item.html {
                pasteboard.setString_forType(&NSString::from_str(html), kind_html);
            }
        }
        Command::ReadClipboard { id, has_only } => read_clipboard(surface, *id, *has_only),
        Command::SetClipboardImage(uri) => set_clipboard_image(uri),
        Command::ReadClipboardImage { id, has_only } => {
            read_clipboard_image(surface, *id, *has_only)
        }
        Command::ReadClipboardFiles { id } => read_clipboard_files(surface, *id),
        Command::PickImages { id, request } => crate::picker::pick_images(surface, *id, *request),
        Command::PickFiles { id, request } => {
            crate::file_requests::pick_files(surface, *id, request);
        }
        Command::PickScreenColor { id } => crate::screen_color::pick_screen_color(surface, *id),
        Command::Share { id, sheet } => crate::share::schedule(surface, *id, sheet),
        Command::RenderCanvas {
            id,
            drawing,
            width,
            height,
            scale,
            format,
        } => crate::canvas::render_offscreen(
            surface,
            *id,
            drawing.clone(),
            (*width, *height),
            *scale,
            *format,
        ),
        Command::Speech(command) => surface.control(|c| crate::speech::command(c, command)),
        Command::Audio(command) => surface.control(|c| {
            let base = surface.asset_base.borrow().clone();
            crate::audio::command(&surface.audio, c, command, base.as_ref())
        }),
        Command::Notification(command) => {
            surface.control(|c| crate::notifications::command(c, command))
        }
        Command::FileRequest { id, request } => {
            crate::file_requests::request(surface, *id, request)
        }
        Command::OpenUrl { id, url } => {
            let opened = open_url(url);
            surface.event(
                ROOT_ID,
                EventKind::OpenUrl,
                EventPayload::Map(vec![
                    ("id", PayloadValue::Number(*id as f64)),
                    ("opened", PayloadValue::Bool(opened)),
                ]),
            );
        }
        Command::Back => crate::navigation::default_back(surface),
        Command::ExitApp if surface.terminal.get() => surface.terminal_quit.set(true),
        Command::ExitApp => {
            // Closing calls the window delegate synchronously, which stops
            // the surface and clears its mounter. Wait until this batch has
            // released the mounter's mutable borrow.
            let key = surface.key();
            DispatchQueue::main().exec_async(move || {
                if let Some(surface) = Surface::with_key(key)
                    && let Some(window) = surface.root.ns().window()
                {
                    window.close();
                }
            });
        }
        // The status bar is a phone's; layout animations arrive as mount
        // items.
        Command::StatusBar(_)
        | Command::SetStatusBar(_)
        | Command::LayoutAnimation(_)
        | Command::CancelPress => {}
        other => log::debug!("macos: command {other:?} is not supported"),
    }
}

/// A batch was applied.
pub(crate) fn end_batch(surface: &Surface) {
    follow_background(surface);
}

/// The app stopped, or the surface went: its dialogs go too, unanswered
/// (and those of surfaces gone before). A sheet ends; an alert shown on
/// its own ends its modal loop ([`stop_alone`]) and stays listed until the
/// loop is over ([`run_alone`]), so the next one does not show inside it;
/// one waiting to show never shows.
pub(crate) fn clear(surface: &Surface) {
    end_dialogs(surface, None);
}

/// Takes back the dialog [`show_dialog`] showed on `surface` as `id`
/// (`Command::CloseDialog`), as [`clear`] does, reporting nothing: the core
/// answered it.
fn close_dialog(surface: &Surface, id: u32) {
    end_dialogs(surface, Some(id));
}

/// Ends `surface`'s dialogs unanswered (and those of surfaces gone), or
/// only its dialog `only`: see [`clear`].
fn end_dialogs(surface: &Surface, only: Option<u32>) {
    // `try_with`: also as the surface drops, which may be as the thread
    // ends.
    let ended = SYSTEM.try_with(|s| {
        let Ok(mut s) = s.try_borrow_mut() else {
            return Vec::new();
        };
        let mut ended = Vec::new();
        s.dialogs.retain(|d| {
            let shown_on = d.surface.upgrade();
            let ours = match only {
                None => shown_on.is_none_or(|s| std::ptr::eq(&*s, surface)),
                Some(id) => {
                    d.answer.id == id && shown_on.is_some_and(|s| std::ptr::eq(&*s, surface))
                }
            };
            // Answered: an alert on its own already told to stop.
            if !ours || d.answer.answered.replace(true) {
                return true;
            }
            d.answer.stop_following();
            ended.push((d.alert.clone(), d.shows));
            d.shows == Shows::Alone
        });
        ended
    });
    for (alert, shows) in ended.unwrap_or_default() {
        match shows {
            Shows::Sheet => {
                let sheet = alert.window();
                if let Some(parent) = sheet.sheetParent() {
                    parent.endSheet(&sheet);
                }
            }
            Shows::Alone => {
                if !stop_alone(&alert, NSModalResponseAbort) {
                    log::warn!("macos: an alert stays up under another app-modal window");
                }
            }
            Shows::Waiting => {}
        }
    }
}

/// The app's appearance (`setColorScheme`, `nsh.json`): the environment,
/// the hosted AppKit views and the dialogs follow.
pub(crate) fn set_appearance(surface: &Rc<Surface>, appearance: nsh_core::platform::Appearance) {
    if surface.appearance.replace(appearance) == appearance {
        return;
    }
    surface
        .root
        .ns()
        .setAppearance(ns_appearance(appearance).as_deref());
    crate::window::set_appearance(surface, ns_appearance(appearance).as_deref());
    update(surface);
}

/// The AppKit appearance of `appearance` (`None`: the system's).
pub(crate) fn ns_appearance(
    appearance: nsh_core::platform::Appearance,
) -> Option<Retained<NSAppearance>> {
    use nsh_core::platform::Appearance;
    // SAFETY: immutable AppKit constants.
    let name = match appearance {
        Appearance::Light => unsafe { NSAppearanceNameAqua },
        Appearance::Dark => unsafe { NSAppearanceNameDarkAqua },
        Appearance::System => return None,
    };
    NSAppearance::appearanceNamed(name)
}

/// Gives a new window the app's appearance (`nsh.json`), so it opens in
/// it rather than flashing the system's.
pub(crate) fn open_window(
    window: &objc2_app_kit::NSWindow,
    appearance: nsh_core::platform::Appearance,
) {
    if let Some(appearance) = ns_appearance(appearance) {
        window.setAppearance(Some(&appearance));
    }
}

/// Reports one dialog's answer, once.
struct DialogAnswer {
    id: u32,
    surface: Weak<Surface>,
    answered: Cell<bool>,
    /// The alert's text field (`Dialog::input`, its accessory view), whose
    /// text goes with the answer.
    field: Option<Retained<NSTextField>>,
    /// Follow the field ([`add_text_field`]) until the alert closes.
    observers: RefCell<Vec<Retained<ProtocolObject<dyn NSObjectProtocol>>>>,
}

impl DialogAnswer {
    fn answer(&self, index: i32) {
        if self.answered.replace(true) {
            return;
        }
        self.stop_following();
        let Some(surface) = self.surface.upgrade() else {
            return;
        };
        let mut payload = vec![
            ("id", PayloadValue::Number(self.id as f64)),
            ("index", PayloadValue::Number(index as f64)),
        ];
        if let Some(field) = &self.field {
            payload.push(("value", PayloadValue::Str(field.stringValue().to_string())));
        }
        surface.event(ROOT_ID, EventKind::Dialog, EventPayload::Map(payload));
    }

    /// Stops following the field, once the alert closed.
    fn stop_following(&self) {
        let center = NSNotificationCenter::defaultCenter();
        for observer in self.observers.take() {
            // SAFETY: an observer `addObserverForName…` returned.
            unsafe { center.removeObserver(observer.as_ref()) };
        }
    }
}

/// The text field of `dialog`'s input, made to be `alert`'s accessory view
/// (an alert's only), focused as it shows.
fn text_field(alert: &NSAlert, dialog: &Dialog) -> Option<Retained<NSTextField>> {
    let input = dialog.input.as_ref().filter(|_| !dialog.sheet)?;
    let mtm = MainThreadMarker::from(alert);
    let field = NSTextField::textFieldWithString(&NSString::from_str(&input.text), mtm);
    if let Some(placeholder) = &input.placeholder {
        field.setPlaceholderString(Some(&NSString::from_str(placeholder)));
    }
    // NSAlert's text column is this wide.
    field.setFrame(objc2_foundation::NSRect::new(
        NSPoint::new(0.0, 0.0),
        objc2_foundation::NSSize::new(230.0, 24.0),
    ));
    alert.setAccessoryView(Some(&field));
    alert.window().setInitialFirstResponder(Some(&field));
    Some(field)
}

/// Follows `answer`'s text field in `alert`: AppKit selects a field's
/// text as it takes the focus, so without `select_all` the caret goes
/// after it once the alert shows; while a required field is empty only
/// the cancel buttons are enabled (`order` as in [`Shown::order`]).
fn follow_text_field(alert: &NSAlert, dialog: &Dialog, order: &[usize], answer: &DialogAnswer) {
    let (Some(field), Some(input)) = (&answer.field, &dialog.input) else {
        return;
    };
    let center = NSNotificationCenter::defaultCenter();
    let mut observers = answer.observers.borrow_mut();
    if !input.select_all {
        let weak = objc2::rc::Weak::from_retained(field);
        let block = RcBlock::new(move |_: NonNull<NSNotification>| {
            if let Some(field) = weak.load()
                && let Some(editor) = field.currentEditor()
            {
                let end = field.stringValue().length();
                editor.setSelectedRange(NSRange::new(end, 0));
            }
        });
        // SAFETY: the block runs on the main queue it is delivered on, and
        // `stop_following` removes the observer.
        observers.push(unsafe {
            center.addObserverForName_object_queue_usingBlock(
                Some(objc2_app_kit::NSWindowDidBecomeKeyNotification),
                Some(&alert.window()),
                Some(&NSOperationQueue::mainQueue()),
                &block,
            )
        });
    }
    if !input.required {
        return;
    }
    let enable = {
        let alert = objc2::rc::Weak::new(alert);
        let buttons = dialog.buttons.clone();
        let order = order.to_vec();
        let input = input.clone();
        move |text: &str| {
            let Some(alert) = alert.load() else { return };
            for (button, &index) in alert.buttons().iter().zip(&order) {
                button.setEnabled(input.enables(&buttons[index], text));
            }
        }
    };
    enable(&input.text);
    let weak = objc2::rc::Weak::from_retained(field);
    let block = RcBlock::new(move |_: NonNull<NSNotification>| {
        if let Some(field) = weak.load() {
            enable(&field.stringValue().to_string());
        }
    });
    // SAFETY: as above.
    observers.push(unsafe {
        center.addObserverForName_object_queue_usingBlock(
            Some(objc2_app_kit::NSControlTextDidChangeNotification),
            Some(field),
            Some(&NSOperationQueue::mainQueue()),
            &block,
        )
    });
}

/// Shows `dialog` as an `NSAlert`, its buttons in the dialog's order (see
/// the comment on `order`); the cancel button answers Escape. It is a sheet
/// of the window the user is in while they see that window; else it shows
/// on its own, in front, the app activated first
/// ([`crate::window::panel_window`]), after any alert shown on its own now
/// ([`run_alone`]). A surface in no window (an embedded `AppView` out of
/// its window) shows its alert on its own too, app-modal in the app that
/// embeds it, as the open and save panels do. Answers the button's index;
/// -1 when it closes without one.
fn show_dialog(surface: &Rc<Surface>, dialog: &Dialog) {
    let mtm = surface.mtm;
    let alert = NSAlert::new(mtm);
    let answer = Rc::new(DialogAnswer {
        id: dialog.id,
        surface: Rc::downgrade(surface),
        answered: Cell::new(false),
        field: text_field(&alert, dialog),
        observers: RefCell::new(Vec::new()),
    });
    alert.setAlertStyle(NSAlertStyle::Informational);
    match (&dialog.title, &dialog.message) {
        (Some(title), message) => {
            alert.setMessageText(&NSString::from_str(title));
            if let Some(message) = message {
                alert.setInformativeText(&NSString::from_str(message));
            }
        }
        (None, Some(message)) => alert.setMessageText(&NSString::from_str(message)),
        (None, None) => {}
    }
    // `AlertDialog` always brings the app's actions (it rejects none): no
    // label of NSH's own.
    let buttons = &dialog.buttons[..];
    let cancel = buttons
        .iter()
        .position(|b| b.style == DialogButtonStyle::Cancel);
    // NSAlert lays two buttons out in a row, its first button rightmost,
    // and stacks three or more, its first button on top, except that it
    // moves the Return button to the top. As on iOS, buttons in a row read
    // in order with the cancel button leftmost, stacked ones (and an
    // action sheet's options) in order with the cancel button last. Only
    // an alert in a row has a default button (Return): its last regular
    // one, rightmost; Return would reorder a stack. `order[n]` is the
    // index of the alert's button n.
    let stacked = dialog.sheet || buttons.len() >= 3;
    let mut order: Vec<usize> = (0..buttons.len()).filter(|i| Some(*i) != cancel).collect();
    if !stacked {
        order.reverse();
    }
    order.extend(cancel);
    let default = (0..buttons.len())
        .rev()
        .find(|i| buttons[*i].style == DialogButtonStyle::Default)
        .filter(|_| !stacked);
    for &index in &order {
        let b = &buttons[index];
        let button = alert.addButtonWithTitle(&NSString::from_str(&b.text));
        let key = if Some(index) == default {
            ns_string!("\r")
        } else if b.style == DialogButtonStyle::Cancel {
            ns_string!("\u{1b}")
        } else {
            ns_string!("")
        };
        button.setKeyEquivalent(key);
        if b.style == DialogButtonStyle::Destructive {
            button.setHasDestructiveAction(true);
        }
    }
    follow_text_field(&alert, dialog, &order, &answer);
    // The alert takes the surface's appearance, which the app may force.
    alert
        .window()
        .setAppearance(Some(&surface.root.ns().effectiveAppearance()));
    // The window the user is in (a window of the app's own when it has the
    // keyboard) while they see it; `None`: on its own, the app activated.
    let window = crate::window::panel_window(surface);
    SYSTEM.with(|s| {
        s.borrow_mut().dialogs.push(Shown {
            surface: Rc::downgrade(surface),
            alert: alert.clone(),
            answer,
            order,
            shows: if window.is_some() {
                Shows::Sheet
            } else {
                Shows::Waiting
            },
        })
    });
    match window {
        Some(window) => {
            let handler = {
                let alert = alert.clone();
                RcBlock::new(move |response: NSModalResponse| closed(&alert, response))
            };
            alert.beginSheetModalForWindow_completionHandler(&window, Some(&handler));
        }
        None => schedule_alone(),
    }
}

/// `alert` closed with `response` (`NSAlertFirstButtonReturn` and up for
/// its buttons): it leaves the list, and its dialog gets the button's
/// index (-1 for none), unless the app stopped meanwhile.
fn closed(alert: &NSAlert, response: NSModalResponse) {
    let shown = SYSTEM.with(|s| {
        let mut s = s.borrow_mut();
        let at = s
            .dialogs
            .iter()
            .position(|d| std::ptr::eq(&*d.alert, alert))?;
        Some(s.dialogs.remove(at))
    });
    if let Some(shown) = shown {
        shown.answer.answer(answered_index(&shown.order, response));
    }
}

/// The dialog's index of the button an alert closed with: `response` is
/// `NSAlertFirstButtonReturn` for its button 0 and up from there, its
/// button n the dialog's `order[n]`; -1 for any other response (an alert
/// closed without a button, stopped or aborted).
fn answered_index(order: &[usize], response: NSModalResponse) -> i32 {
    usize::try_from(response - NSAlertFirstButtonReturn)
        .ok()
        .and_then(|n| order.get(n))
        .map_or(-1, |i| *i as i32)
}

/// Shows the alerts waiting to show on their own ([`run_alone`]) on a
/// later turn of the main run loop.
///
/// Not now: the batch that raised the alert holds the surface's mounter,
/// which the batches applied in the alert's modal loop borrow again. Not
/// from a main-queue block either: CFRunLoop drains the main queue only
/// outside its blocks (the queue is serial), so a modal loop run in one
/// would hold the queue, and the app's batches and the test agent's calls,
/// which come through it, would wait for the answer. A block of the run
/// loop's own runs the modal loop where the queue drains. In the default
/// and modal modes only: not while a menu or a drag tracks the mouse, or
/// a window resizes live, which the alert waits for.
fn schedule_alone() {
    let block = RcBlock::new(run_alone);
    // SAFETY: immutable constants of Foundation and AppKit.
    let (default, modal) = unsafe { (NSDefaultRunLoopMode, NSModalPanelRunLoopMode) };
    let modes = NSArray::from_slice(&[default, modal]);
    // SAFETY: the block runs on the main thread, where it was made.
    unsafe { NSRunLoop::mainRunLoop().performInModes_block(&modes, &block) };
}

/// Shows the alerts waiting to show on their own, the oldest first, each
/// in a modal loop of its own (`runModal`: app-modal; its loop runs in
/// `NSModalPanelRunLoopMode`, one of the common modes, where the main
/// queue, the display link and the surface's timers run too). One at a
/// time: an alert raised while one shows waits for it, as sheets of one
/// window wait for each other, so the alert a modal loop shows is always
/// the innermost one, the one `stopModalWithCode:` ends. No borrow is held
/// while a loop runs: the batches it applies (raising alerts too), the
/// app stopping and the test agent's calls go on in it.
fn run_alone() {
    loop {
        let next = SYSTEM.with(|s| {
            let mut s = s.borrow_mut();
            // The waiting alerts of a surface gone have no one to answer.
            s.dialogs
                .retain(|d| d.shows != Shows::Waiting || d.surface.strong_count() > 0);
            let at = next_alone(s.dialogs.iter().map(|d| d.shows))?;
            let d = &mut s.dialogs[at];
            d.shows = Shows::Alone;
            Some(d.alert.clone())
        });
        let Some(alert) = next else {
            return;
        };
        let response = alert.runModal();
        alert.window().orderOut(None);
        closed(&alert, response);
    }
}

/// The alert to show on its own next ([`run_alone`]), given where each
/// listed alert shows, oldest first: the oldest one waiting, unless one
/// shows on its own now (its loop shows the next when it closes).
fn next_alone(shows: impl IntoIterator<Item = Shows>) -> Option<usize> {
    let mut next = None;
    for (i, shows) in shows.into_iter().enumerate() {
        match shows {
            Shows::Alone => return None,
            Shows::Waiting if next.is_none() => next = Some(i),
            _ => {}
        }
    }
    next
}

/// Ends the modal loop of `alert`, shown on its own, with `code`, from
/// outside the loop's own events (the app stopping, the test agent):
/// AppKit ends a loop told to stop only after an event, so one is posted
/// ([`wake`]). Only the innermost modal loop ends: false, and nothing
/// done, while another app-modal window shows over the alert (an
/// embedding app's).
fn stop_alone(alert: &NSAlert, code: NSModalResponse) -> bool {
    let app = NSApplication::sharedApplication(MainThreadMarker::from(alert));
    if app.modalWindow().is_some_and(|w| w != alert.window()) {
        return false;
    }
    app.stopModalWithCode(code);
    wake(&app);
    true
}

/// Posts an application-defined event, which wakes the app's event loop or
/// a modal loop told to stop from outside its events (`stop:`,
/// `stopModalWithCode:`): AppKit looks at the request only after an event.
pub(crate) fn wake(app: &NSApplication) {
    if let Some(event) = NSEvent::otherEventWithType_location_modifierFlags_timestamp_windowNumber_context_subtype_data1_data2(
        NSEventType::ApplicationDefined,
        NSPoint::new(0.0, 0.0),
        NSEventModifierFlags::empty(),
        0.0,
        0,
        None,
        0,
        0,
        0,
    ) {
        app.postEvent_atStart(&event, true);
    }
}

/// Answers the oldest dialog shown on `surface` as a user would: presses
/// its button titled `button`, or closes it without one (`None`). An
/// alert shown on its own ends its modal loop on the click's
/// `stopModalWithCode:` once an event comes, which is posted ([`wake`]);
/// one still waiting for its turn is answered without showing.
#[cfg(feature = "dev")]
pub(crate) fn answer_dialog(surface: &Rc<Surface>, button: Option<&str>) -> Result<(), String> {
    let (alert, shows) = SYSTEM
        .with(|s| {
            s.borrow()
                .dialogs
                .iter()
                .filter(|d| !d.answer.answered.get())
                .find(|d| d.surface.upgrade().is_some_and(|x| Rc::ptr_eq(&x, surface)))
                .map(|d| (d.alert.clone(), d.shows))
        })
        .ok_or("no dialog is shown")?;
    let app = NSApplication::sharedApplication(surface.mtm);
    if shows == Shows::Alone && app.modalWindow().is_some_and(|w| w != alert.window()) {
        return Err("another modal window shows over the dialog".into());
    }
    let pressed = match button {
        Some(text) => Some(
            alert
                .buttons()
                .iter()
                .enumerate()
                .find(|(_, b)| b.title().to_string() == text)
                .map(|(n, b)| (b, n))
                .ok_or_else(|| format!("the dialog has no button {text:?}"))?,
        ),
        None => None,
    };
    match (shows, pressed) {
        (Shows::Waiting, pressed) => {
            let response = pressed.map_or(objc2_app_kit::NSModalResponseCancel, |(_, n)| {
                NSAlertFirstButtonReturn + n as NSModalResponse
            });
            closed(&alert, response);
        }
        (shows, Some((button, _))) => {
            // SAFETY: a button of a live alert, clicked on the main thread
            // with no sender, as a user's click has none to hand over.
            unsafe { button.performClick(None) };
            if shows == Shows::Alone {
                wake(&app);
            }
        }
        (Shows::Sheet, None) => {
            let window = alert.window().sheetParent().ok_or("the window is gone")?;
            window.endSheet_returnCode(&alert.window(), objc2_app_kit::NSModalResponseCancel);
        }
        (Shows::Alone, None) => {
            stop_alone(&alert, objc2_app_kit::NSModalResponseCancel);
        }
    }
    Ok(())
}

/// The pasteboard types of images NSH reads and writes, by MIME type, in
/// the order they are read: the first one the pasteboard holds wins.
const IMAGE_TYPES: [(&str, &str); 6] = [
    ("image/png", "public.png"),
    ("image/jpeg", "public.jpeg"),
    ("image/gif", "com.compuserve.gif"),
    ("image/webp", "org.webmproject.webp"),
    ("image/bmp", "com.microsoft.bmp"),
    ("image/tiff", "public.tiff"),
];

/// `Clipboard.writeImage`: the image of a `data:` URI on the pasteboard,
/// under its own type (and TIFF too, which every AppKit app reads, unless
/// it is TIFF already).
fn set_clipboard_image(uri: &str) {
    let Some((mime, bytes)) = clipboard::decode_data_uri(uri) else {
        log::warn!("Clipboard.writeImage: not a base64 data: URI");
        return;
    };
    let Some((_, kind)) = IMAGE_TYPES.iter().find(|(m, _)| *m == mime) else {
        log::warn!("Clipboard.writeImage: unsupported image type {mime}");
        return;
    };
    let pasteboard = NSPasteboard::generalPasteboard();
    pasteboard.clearContents();
    let data = NSData::with_bytes(&bytes);
    pasteboard.setData_forType(Some(&data), &NSString::from_str(kind));
    if *kind != "public.tiff"
        && let Some(tiff) =
            NSBitmapImageRep::imageRepWithData(&data).and_then(|r| r.TIFFRepresentation())
    {
        pasteboard.setData_forType(Some(&tiff), &NSString::from_str("public.tiff"));
    }
}

/// `Clipboard.readImage` / `hasImage`: answers read `id` with the
/// pasteboard's first image of [`IMAGE_TYPES`]; a TIFF becomes PNG (an
/// image source of any platform), off the main thread.
fn read_clipboard_image(surface: &Rc<Surface>, id: u32, has_only: bool) {
    let pasteboard = NSPasteboard::generalPasteboard();
    // The types on offer: reading them is no paste (no privacy notice).
    let kind = pasteboard.types().and_then(|types| {
        IMAGE_TYPES
            .iter()
            .map(|(_, kind)| NSString::from_str(kind))
            .find(|kind| types.containsObject(kind))
    });
    let data = kind
        .as_ref()
        .filter(|_| !has_only)
        .and_then(|kind| pasteboard.dataForType(kind));
    let Some(data) = data else {
        let payload = clipboard::image_answer(id, kind.is_some(), None);
        surface.event(ROOT_ID, EventKind::Clipboard, payload);
        return;
    };
    let bytes = data.to_vec();
    let key = surface.key();
    DispatchQueue::global_queue(dispatch2::GlobalQueueIdentifier::Priority(
        dispatch2::DispatchQueueGlobalPriority::Default,
    ))
    .exec_async(move || {
        let png = clipboard::Image::sniff(&bytes)
            .filter(|i| i.mime != "image/tiff")
            .is_none()
            .then(|| to_png(&bytes))
            .flatten();
        let bytes = png.as_deref().unwrap_or(&bytes);
        let payload = clipboard::image_answer(id, true, clipboard::Image::sniff(bytes));
        DispatchQueue::main().exec_async(move || {
            if let Some(surface) = Surface::with_key(key) {
                surface.event(ROOT_ID, EventKind::Clipboard, payload);
            }
        });
    });
}

/// What `pasteboard` holds, read as the user pastes into an input
/// (`onPaste`): its text, the same content as HTML ([`pasted_html`]), each
/// item's image (as it is in [`IMAGE_TYPES`], a TIFF or BMP as PNG) and
/// local files' `file:` URLs (a file copied in the Finder is its URL, not
/// the icon it carries).
pub(crate) fn pasted(pasteboard: &NSPasteboard) -> nsh_core::PasteEvent {
    // SAFETY: an immutable AppKit constant.
    let string = unsafe { NSPasteboardTypeString };
    let mut paste = nsh_core::PasteEvent::new(
        pasteboard
            .stringForType(string)
            .map(|s| s.to_string())
            .unwrap_or_default(),
    );
    paste.html = pasted_html(pasteboard).unwrap_or_default();
    let file_url = NSString::from_str("public.file-url");
    for item in pasteboard
        .pasteboardItems()
        .map(|i| i.to_vec())
        .unwrap_or_default()
    {
        if let Some(uri) = item.stringForType(&file_url) {
            let Some((path, resolved)) = crate::file_drop::local_file_path_and_uri(&uri) else {
                continue;
            };
            if has_fallback_inline_image(&item)
                && is_unreadable_file_url(&path)
                && let Some(bytes) = pasted_inline_image(&item, false)
            {
                paste.files.push(nsh_core::PastedFile::image(bytes));
                continue;
            }
            paste.uris.push(resolved);
            continue;
        }
        if let Some(bytes) = pasted_inline_image(&item, true) {
            paste.files.push(nsh_core::PastedFile::image(bytes));
        }
    }
    paste
}

fn is_unreadable_file_url(path: &std::path::Path) -> bool {
    use std::os::unix::fs::OpenOptionsExt;
    let mut options = std::fs::OpenOptions::new();
    options.read(true).custom_flags(libc::O_NONBLOCK);
    matches!(
        options.open(path),
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::NotFound
            )
    )
}

fn has_fallback_inline_image(item: &NSPasteboardItem) -> bool {
    let types = item.types();
    IMAGE_TYPES.iter().any(|(mime, kind)| {
        *mime != "image/tiff" && types.containsObject(&NSString::from_str(kind))
    })
}

fn pasted_inline_image(item: &NSPasteboardItem, allow_tiff: bool) -> Option<Vec<u8>> {
    let (mime, bytes) = IMAGE_TYPES.iter().find_map(|(mime, kind)| {
        if !allow_tiff && *mime == "image/tiff" {
            return None;
        }
        item.dataForType(&NSString::from_str(kind))
            .map(|data| (*mime, data.to_vec()))
    })?;
    Some(match mime {
        "image/tiff" | "image/bmp" => to_png(&bytes).unwrap_or(bytes),
        _ => bytes,
    })
}

/// The pasteboard's formatted content as HTML: `public.html` as browsers,
/// office suites and most editors copy it; else the main resource of a web
/// archive (Safari, Mail); else RTF (TextEdit, Notes, Pages), written as
/// HTML by AppKit with its styles inline, as the editors' parsers read
/// them.
fn pasted_html(pasteboard: &NSPasteboard) -> Option<String> {
    if let Some(html) = pasteboard.stringForType(&NSString::from_str("public.html")) {
        return Some(html.to_string());
    }
    if let Some(archive) = pasteboard.dataForType(&NSString::from_str("com.apple.webarchive"))
        && let Some(html) = web_archive_html(&archive)
    {
        return Some(html);
    }
    // SAFETY: immutable AppKit constants.
    let (rtfd, rtf) = unsafe { (NSPasteboardTypeRTFD, NSPasteboardTypeRTF) };
    let text = if let Some(data) = pasteboard.dataForType(rtfd) {
        // SAFETY: `data` is the pasteboard's RTFD; no document attributes
        // are asked for.
        unsafe {
            NSAttributedString::initWithRTFD_documentAttributes(
                NSAttributedString::alloc(),
                &data,
                None,
            )
        }
    } else if let Some(data) = pasteboard.dataForType(rtf) {
        // SAFETY: as above, with RTF.
        unsafe {
            NSAttributedString::initWithRTF_documentAttributes(
                NSAttributedString::alloc(),
                &data,
                None,
            )
        }
    } else {
        None
    }?;
    attributed_html(&text)
}

/// The HTML of a web archive's main resource (`WebMainResource`'s
/// `WebResourceData`), decoded as its `WebResourceTextEncodingName` says
/// (UTF-8 when it names none).
fn web_archive_html(archive: &NSData) -> Option<String> {
    // SAFETY: `archive` is plist data; a null format is allowed.
    let plist = unsafe {
        NSPropertyListSerialization::propertyListWithData_options_format_error(
            archive,
            NSPropertyListReadOptions::Immutable,
            std::ptr::null_mut(),
        )
    }
    .ok()?;
    let archive = plist.downcast_ref::<NSDictionary>()?;
    let main = archive.objectForKey(&NSString::from_str("WebMainResource"))?;
    let main = main.downcast_ref::<NSDictionary>()?;
    let data = main.objectForKey(&NSString::from_str("WebResourceData"))?;
    let encoding = main
        .objectForKey(&NSString::from_str("WebResourceTextEncodingName"))
        .and_then(|e| e.downcast_ref::<NSString>().map(|e| e.to_string()));
    Some(decode_text(
        &data.downcast_ref::<NSData>()?.to_vec(),
        encoding.as_deref(),
    ))
}

/// Text `bytes` in `encoding` (an IANA name): UTF-16 as it names it or as
/// a byte order mark says, else UTF-8.
fn decode_text(bytes: &[u8], encoding: Option<&str>) -> String {
    let encoding = encoding.map(str::to_ascii_lowercase);
    let big_endian = match (encoding.as_deref(), bytes) {
        (Some("utf-16be"), _) | (_, [0xfe, 0xff, ..]) => true,
        (Some("utf-16" | "utf-16le"), _) | (_, [0xff, 0xfe, ..]) => false,
        _ => return String::from_utf8_lossy(bytes).into_owned(),
    };
    let units: Vec<u16> = bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|c| {
            if big_endian {
                u16::from_be_bytes(*c)
            } else {
                u16::from_le_bytes(*c)
            }
        })
        .collect();
    String::from_utf16_lossy(&units)
        .trim_start_matches('\u{feff}')
        .to_owned()
}

/// `text` written as HTML by AppKit, without the document around it (its
/// head and style sheet), so its styles are inline.
fn attributed_html(text: &NSAttributedString) -> Option<String> {
    let excluded = NSArray::from_retained_slice(
        &[
            "doctype", "html", "head", "body", "xml", "style", "meta", "title",
        ]
        .map(NSString::from_str),
    );
    // SAFETY: immutable AppKit constants.
    let (kind, html, excluded_key) = unsafe {
        (
            NSDocumentTypeDocumentAttribute,
            NSHTMLTextDocumentType,
            NSExcludedElementsDocumentAttribute,
        )
    };
    let attributes = NSDictionary::<NSString, AnyObject>::from_slices(
        &[kind, excluded_key],
        &[html.as_ref(), excluded.as_ref()],
    );
    let range = NSRange::new(0, text.length());
    // SAFETY: the attributes are the document type and an array of strings,
    // as AppKit takes them.
    let data = unsafe { text.dataFromRange_documentAttributes_error(range, &attributes) }.ok()?;
    Some(String::from_utf8_lossy(&data.to_vec()).into_owned())
}

/// Whether `pasteboard` holds what a text view's own paste leaves out:
/// images or local files (reading the types is no paste: no privacy
/// notice).
pub(crate) fn has_pasted_files(pasteboard: &NSPasteboard) -> bool {
    pasteboard.types().is_some_and(|types| {
        IMAGE_TYPES
            .iter()
            .map(|(_, kind)| *kind)
            .chain(["public.file-url"])
            .any(|kind| types.containsObject(&NSString::from_str(kind)))
    })
}

/// Encoded image `bytes` (a TIFF) encoded again as PNG.
fn to_png(bytes: &[u8]) -> Option<Vec<u8>> {
    let rep = NSBitmapImageRep::imageRepWithData(&NSData::with_bytes(bytes))?;
    // SAFETY: an empty dictionary of properties is valid for every type.
    let png = unsafe {
        rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new())
    }?;
    Some(png.to_vec())
}

/// `Clipboard.readFiles`: the local files' `file:` URLs on the pasteboard
/// (one item each, as Finder copies them).
fn read_clipboard_files(surface: &Rc<Surface>, id: u32) {
    let pasteboard = NSPasteboard::generalPasteboard();
    let kind = NSString::from_str("public.file-url");
    let files: Vec<String> = pasteboard
        .pasteboardItems()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.stringForType(&kind))
                .filter_map(|uri| crate::file_drop::local_file_uri(&uri))
                .collect()
        })
        .unwrap_or_default();
    surface.event(
        ROOT_ID,
        EventKind::Clipboard,
        clipboard::files_answer(id, &files),
    );
}

/// `Clipboard.readText` / `hasText`: answers read `id` with whether the
/// clipboard holds text and, unless `has_only`, the text.
/// Opens `url` in the app that handles its scheme (`NSWorkspace`): whether
/// one took it.
pub(crate) fn open_url(url: &str) -> bool {
    let Some(url) = NSURL::URLWithString(&NSString::from_str(url)) else {
        return false;
    };
    NSWorkspace::sharedWorkspace().openURL(&url)
}

pub(crate) fn write_clipboard(surface: &Surface, text: &str) {
    if surface.terminal.get() {
        let mut clipboard = surface.terminal_clipboard.borrow_mut();
        clipboard.text = Some(text.to_owned());
        clipboard.pending = Some(text.to_owned());
        return;
    }
    let pasteboard = NSPasteboard::generalPasteboard();
    pasteboard.clearContents();
    // SAFETY: an immutable AppKit constant.
    pasteboard.setString_forType(&NSString::from_str(text), unsafe { NSPasteboardTypeString });
}

fn read_clipboard(surface: &Rc<Surface>, id: u32, has_only: bool) {
    let (has, text) = if surface.terminal.get()
        && let Some(text) = surface.terminal_clipboard.borrow().text.clone()
    {
        (true, (!has_only).then_some(text))
    } else {
        let pasteboard = NSPasteboard::generalPasteboard();
        // SAFETY: an immutable AppKit constant.
        let string = unsafe { NSPasteboardTypeString };
        // The types on offer: reading them is no paste (no privacy notice).
        let has = pasteboard
            .types()
            .is_some_and(|types| types.containsObject(string));
        let text = (has && !has_only)
            .then(|| pasteboard.stringForType(string))
            .flatten()
            .map(|s| s.to_string());
        (has, text)
    };
    let mut fields = vec![
        ("id", PayloadValue::Number(id as f64)),
        ("has", PayloadValue::Bool(has)),
    ];
    if let Some(text) = text {
        fields.push(("text", PayloadValue::Str(text)));
    }
    surface.event(ROOT_ID, EventKind::Clipboard, EventPayload::Map(fields));
}

#[cfg(test)]
mod tests {
    use objc2::runtime::{AnyObject, ProtocolObject};
    use objc2_app_kit::{NSPasteboard, NSPasteboardItem, NSPasteboardWriting};
    use objc2_foundation::{
        NSArray, NSData, NSDictionary, NSPropertyListFormat, NSPropertyListSerialization, NSString,
        NSURL,
    };

    use super::{Shows, answered_index, next_alone, pasted, pasted_html};

    #[test]
    fn alerts_on_their_own_show_one_at_a_time_oldest_first() {
        use Shows::{Alone, Sheet, Waiting};
        // The oldest waiting one shows; sheets are no turn of theirs.
        assert_eq!(next_alone([Sheet, Waiting, Waiting]), Some(1));
        assert_eq!(next_alone([Waiting, Sheet, Waiting]), Some(0));
        // While one shows on its own (also one told to stop, until its
        // loop is over), the others wait for it: never a modal loop in
        // another.
        assert_eq!(next_alone([Alone, Waiting]), None);
        assert_eq!(next_alone([Sheet, Alone, Waiting, Waiting]), None);
        // Nothing to show.
        assert_eq!(next_alone([Sheet, Sheet]), None);
        assert_eq!(next_alone([]), None);
    }

    #[test]
    fn an_alert_answers_the_dialogs_index_of_its_button() {
        use objc2_app_kit::{
            NSAlertFirstButtonReturn, NSModalResponseAbort, NSModalResponseCancel,
            NSModalResponseStop,
        };
        // Two buttons in a row are added in reverse, the cancel button
        // (the dialog's 0) last: the alert's buttons are the dialog's 1, 0.
        let order = [1, 0];
        assert_eq!(answered_index(&order, NSAlertFirstButtonReturn), 1);
        assert_eq!(answered_index(&order, NSAlertFirstButtonReturn + 1), 0);
        // No such button, or closed without one: the test agent's
        // dismissal (`Cancel`), the app stopping (`Abort`), `stopModal`.
        for response in [
            NSAlertFirstButtonReturn + 2,
            NSModalResponseCancel,
            NSModalResponseAbort,
            NSModalResponseStop,
        ] {
            assert_eq!(answered_index(&order, response), -1, "{response}");
        }
    }

    /// A private pasteboard holding `bytes` as `kind`.
    fn board(kind: &str, bytes: &[u8]) -> objc2::rc::Retained<NSPasteboard> {
        let board = NSPasteboard::pasteboardWithUniqueName();
        board.clearContents();
        board.setData_forType(Some(&NSData::with_bytes(bytes)), &NSString::from_str(kind));
        board
    }

    #[test]
    fn html_as_browsers_copy_it() {
        let board = board("public.html", b"<p>a <b>b</b></p>");
        assert_eq!(pasted_html(&board).as_deref(), Some("<p>a <b>b</b></p>"));
    }

    #[test]
    fn web_archive_main_resource() {
        let html = "<p>caf\u{e9} <b>b</b></p>";
        let main = NSDictionary::<NSString, AnyObject>::from_slices(
            &[
                &*NSString::from_str("WebResourceData"),
                &*NSString::from_str("WebResourceTextEncodingName"),
            ],
            &[
                NSData::with_bytes(html.as_bytes()).as_ref(),
                NSString::from_str("UTF-8").as_ref(),
            ],
        );
        let archive = NSDictionary::<NSString, AnyObject>::from_slices(
            &[&*NSString::from_str("WebMainResource")],
            &[main.as_ref()],
        );
        // SAFETY: a dictionary of strings and data is a property list.
        let plist = unsafe {
            NSPropertyListSerialization::dataWithPropertyList_format_options_error(
                &archive,
                NSPropertyListFormat::BinaryFormat_v1_0,
                0,
            )
        }
        .unwrap()
        .to_vec();
        let board = board("com.apple.webarchive", &plist);
        assert_eq!(pasted_html(&board).as_deref(), Some(html));
    }

    #[test]
    fn rtf_as_html_with_inline_styles() {
        let rtf = br"{\rtf1\ansi{\fonttbl\f0 Helvetica;}\f0 a \b bold\b0  \i it\i0\par}";
        let board = board("public.rtf", rtf);
        let html = pasted_html(&board).unwrap();
        assert!(html.contains("<b>bold</b>"), "{html}");
        assert!(html.contains("<i>it</i>"), "{html}");
        assert!(!html.contains("<style"), "{html}");
    }

    #[test]
    fn no_formatted_content() {
        let board = board("public.utf8-plain-text", b"plain");
        assert_eq!(pasted_html(&board), None);
    }

    #[test]
    fn pasted_falls_back_to_inline_image_when_file_url_is_unreadable() {
        let board_of = |entries: &[(&str, &[u8])]| {
            let board = NSPasteboard::pasteboardWithUniqueName();
            board.clearContents();
            let item = NSPasteboardItem::new();
            for (kind, bytes) in entries {
                let _ = item.setData_forType(&NSData::with_bytes(bytes), &NSString::from_str(kind));
            }
            let objects = NSArray::from_retained_slice(&[
                ProtocolObject::<dyn NSPasteboardWriting>::from_retained(item),
            ]);
            let _ = board.writeObjects(&objects);
            board
        };
        let uri_of = |path: &std::path::Path| {
            NSURL::fileURLWithPath(&NSString::from_str(path.to_str().unwrap()))
                .absoluteString()
                .unwrap()
                .to_string()
        };

        let existing =
            std::env::temp_dir().join(format!("nsh-paste-ok-{}.png", std::process::id()));
        std::fs::write(&existing, b"png").unwrap();
        let existing_uri = uri_of(&existing);
        let missing_uri = uri_of(&std::env::temp_dir().join("nsh-paste-missing-image.png"));

        let ok = pasted(&board_of(&[
            ("public.file-url", existing_uri.as_bytes()),
            ("public.png", b"inline"),
        ]));
        assert_eq!(ok.uris, vec![existing_uri]);
        assert!(ok.files.is_empty());

        let fallback = pasted(&board_of(&[
            ("public.file-url", missing_uri.as_bytes()),
            ("public.png", b"inline"),
        ]));
        assert!(fallback.uris.is_empty());
        assert_eq!(fallback.files.len(), 1);
        assert_eq!(fallback.files[0].data, b"inline");

        let icon_only = pasted(&board_of(&[
            ("public.file-url", missing_uri.as_bytes()),
            ("public.tiff", b"icon"),
        ]));
        assert_eq!(icon_only.uris, vec![missing_uri]);
        assert!(icon_only.files.is_empty());

        let _ = std::fs::remove_file(existing);
    }
}
