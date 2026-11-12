//! The platform's services for Rust components on the engine: the fonts
//! the UI sets' crates ship are registered before the first render, tasks
//! wait for display frames, components set the layout direction and read
//! the pixel ratio, the device, the locale and whether the app is in use;
//! they speak, move the screen reader and set the status bar with their
//! dialogs; they read the desktop window's state, a move once it stops,
//! and the displays.

use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

use crossbeam_channel::{Receiver, Sender};
use nsh_base::dialog;
use nsh_core::{
    ApproxTextEngine, AttributedText, Command, EventKind, EventPayload, MountBatch, MountItem,
    Points, ROOT_ID, Size, StatusBarSetting, StatusBarStyle, TextEngine, TextLayout,
    desktop::{Display, DisplayId, WindowMode, WindowPlacement, WindowState},
    element::{AssetFile, AssetKind, Registry, Root},
    geometry::{Bounds, point, size},
    platform::{
        Idiom, Languages, Lifecycle, Locale, LocaleSettings, Os, TemperatureUnit, TimeZone,
    },
    prelude::*,
};
use nsh_engine::{App, Assets, Engine, EngineConfig, Environment, MountSink};

/// Hands the batches to the test and counts the frames asked for.
struct FrameSink {
    batches: Sender<MountBatch>,
    frames: Arc<AtomicUsize>,
}

impl MountSink for FrameSink {
    fn submit(&self, batch: MountBatch) {
        let _ = self.batches.send(batch);
    }

    fn request_frame(&self) {
        self.frames.fetch_add(1, Ordering::SeqCst);
    }
}

fn config(app: App) -> EngineConfig {
    EngineConfig {
        app,
        viewport: Size::new(px(390.0), px(844.0)),
        trace: false,
        content_culling: false,
        network: None,
        websocket: None,
        refuse_connections: None,
        filesystem: None,
        assets: None,
        environment: Environment::default(),
        header_heights: (nsh_core::Points(44.0), nsh_core::Points(96.0)),
        limits: nsh_engine::Limits::default(),
        ui_sets: Vec::new(),
        runtime: None,
        data_dir: None,
        cache: nsh_engine::CacheOptions::off(),
        storage: None,
        clock: Default::default(),
        context: Default::default(),
        pinned: Default::default(),
        clipboard: None,
        host: Default::default(),
        picker: None,
        speech: None,
        chunk_loader: None,
        audio: None,
        windows: None,
    }
}

/// A Rust app of `C`, its batches and the count of frames it asked for.
fn start<C: Component>(environment: Environment) -> (Engine, Receiver<MountBatch>, Arc<AtomicUsize>)
where
    C::Props: Default,
{
    let (tx, rx) = crossbeam_channel::unbounded();
    let frames = Arc::new(AtomicUsize::new(0));
    let config = EngineConfig {
        environment,
        ..config(App::Rust(Root::of::<C>()))
    };
    let sink = FrameSink {
        batches: tx,
        frames: frames.clone(),
    };
    let engine = Engine::start(config, || ApproxTextEngine, sink).unwrap();
    (engine, rx, frames)
}

/// The texts and layout directions the batches carry, until one shows
/// `until` (or 5 seconds passed).
fn until(rx: &Receiver<MountBatch>, until: &str) -> (Vec<String>, Vec<bool>, Option<u32>) {
    let deadline = Instant::now() + Duration::from_secs(5);
    let (mut texts, mut directions, mut host) = (Vec::new(), Vec::new(), None);
    while let Ok(batch) = rx.recv_deadline(deadline) {
        for item in &batch.items {
            match item {
                MountItem::Text { text, .. } => texts.push(text.text.clone()),
                MountItem::LayoutDirection { rtl } => directions.push(*rtl),
                MountItem::Insert {
                    parent: nsh_core::ROOT_ID,
                    child,
                    ..
                } => host = Some(*child),
                _ => {}
            }
        }
        if texts.iter().any(|t| t == until) {
            break;
        }
    }
    (texts, directions, host)
}

/// Records the fonts registered.
struct Fonts(ApproxTextEngine, Arc<Mutex<Vec<Vec<u8>>>>);

impl TextEngine for Fonts {
    type Prepared = <ApproxTextEngine as TextEngine>::Prepared;

    fn prepare(&self, text: &AttributedText) -> Self::Prepared {
        self.0.prepare(text)
    }

    fn measure(&self, prepared: &Self::Prepared, max_width: Option<Points>) -> Size<Points> {
        self.0.measure(prepared, max_width)
    }

    fn layout(&self, prepared: &Self::Prepared, size: Size<Points>) -> TextLayout {
        self.0.layout(prepared, size)
    }

    fn register_font(&self, data: &[u8]) -> Result<(), String> {
        self.1.lock().unwrap().push(data.to_vec());
        Ok(())
    }
}

/// The files of a crate: a font, an image.
static FILES: &[AssetFile] = &[
    AssetFile {
        uri: "asset:/@app/fonts/Script.ttf",
        source: "/nowhere/fonts/Script.ttf",
        kind: AssetKind::Font,
    },
    AssetFile {
        uri: "asset:/@app/logo.png",
        source: "/nowhere/logo.png",
        kind: AssetKind::Image,
    },
];

/// Reads the font, and records what was read.
struct CrateAssets(Arc<Mutex<Vec<String>>>);

impl Assets for CrateAssets {
    fn read(&self, uri: &str) -> Result<Vec<u8>, String> {
        self.0.lock().unwrap().push(uri.to_owned());
        Ok(uri.as_bytes().to_vec())
    }
}

#[component]
fn Label() -> impl IntoElement {
    view().child(text("ready").font_family("Script"))
}

#[test]
fn the_fonts_ui_sets_ship_are_registered_before_the_first_render() {
    let (tx, rx) = crossbeam_channel::unbounded();
    let read = Arc::new(Mutex::new(Vec::new()));
    let fonts = Arc::new(Mutex::new(Vec::new()));
    let mut set = Registry::ui_set("app/native");
    set.assets(FILES);
    let config = EngineConfig {
        assets: Some(Arc::new(CrateAssets(read.clone()))),
        ui_sets: vec![set],
        ..config(App::Rust(Root::of::<Label>()))
    };
    let registered = fonts.clone();
    let _engine = Engine::start(
        config,
        move || Fonts(ApproxTextEngine, registered),
        FrameSink {
            batches: tx,
            frames: Arc::default(),
        },
    )
    .unwrap();
    until(&rx, "ready");
    // Only the font is read (images load where they show).
    assert_eq!(*read.lock().unwrap(), ["asset:/@app/fonts/Script.ttf"]);
    assert_eq!(
        *fonts.lock().unwrap(),
        [b"asset:/@app/fonts/Script.ttf".to_vec()]
    );
}

/// A font the embedding app registers is in place before the first render.
#[test]
fn a_font_the_host_registers_is_registered_before_the_first_render() {
    let (tx, rx) = crossbeam_channel::unbounded();
    let fonts = Arc::new(Mutex::new(Vec::new()));
    let registered = fonts.clone();
    let _engine = Engine::start_with(
        config(App::Rust(Root::of::<Label>())),
        move || Fonts(ApproxTextEngine, registered),
        FrameSink {
            batches: tx,
            frames: Arc::default(),
        },
        |control| control.register_font(b"host-font".to_vec()),
    )
    .unwrap();
    until(&rx, "ready");
    assert_eq!(*fonts.lock().unwrap(), [b"host-font".to_vec()]);
}

/// Counts display frames while a task awaits them.
#[component]
fn Frames() -> impl IntoElement {
    let frames = signal(0);
    // The frame `request_animation_frame` called back with.
    let called = signal(false);
    let start = Instant::now();
    request_animation_frame(move |at| called.set(at >= start));
    spawn(async move {
        for _ in 0..3 {
            next_frame().await;
            frames.update(|f| *f += 1);
        }
    });
    view().child(text(move || {
        format!("{} frames, called {}", frames.get(), called.get())
    }))
}

#[test]
fn tasks_wait_for_display_frames() {
    let (engine, rx, frames) = start::<Frames>(Environment::default());
    until(&rx, "0 frames, called false");
    // The engine asked the platform for a frame (once until it comes).
    let deadline = Instant::now() + Duration::from_secs(5);
    while frames.load(Ordering::SeqCst) == 0 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(frames.load(Ordering::SeqCst), 1);
    for n in 1..=3 {
        engine.control().frame();
        let (texts, ..) = until(&rx, &format!("{n} frames, called true"));
        assert_eq!(
            texts.last().map(String::as_str),
            Some(format!("{n} frames, called true").as_str())
        );
    }
    // Each frame asked for the next; none is asked for once the task ended.
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(frames.load(Ordering::SeqCst), 3);
}

/// What a platform's UI thread gets, in the order the engine sends it.
enum ToMain {
    Batch(MountBatch),
    Task(nsh_engine::MainThreadTask),
}

/// Sends batches and the app's functions for the main thread down one
/// channel, as a platform's UI thread gets them.
struct MainThreadSink(Sender<ToMain>);

impl MountSink for MainThreadSink {
    fn submit(&self, batch: MountBatch) {
        let _ = self.0.send(ToMain::Batch(batch));
    }

    fn run_on_main_thread(&self, task: nsh_engine::MainThreadTask) {
        let _ = self.0.send(ToMain::Task(task));
    }
}

/// Asks the main thread for its name, and for a function that panics.
#[component]
fn OnMain() -> impl IntoElement {
    let shown = signal(String::from("asking"));
    spawn(async move {
        shown.set("calling".into());
        let name = run_on_main_thread(|| std::thread::current().name().map(str::to_owned))
            .await
            .ok()
            .flatten()
            .unwrap_or_default();
        let failed = run_on_main_thread(|| -> u8 { panic!("no AppKit here") }).await;
        shown.set(format!("{name} {}", failed.is_err()));
    });
    text(move || shown.get())
}

#[test]
fn functions_run_on_the_platforms_main_thread_and_answer_the_engine() {
    let (tx, rx) = crossbeam_channel::unbounded();
    let (main_tx, main_rx) = crossbeam_channel::unbounded::<ToMain>();
    let order = Arc::new(Mutex::new(Vec::new()));
    let seen = order.clone();
    std::thread::Builder::new()
        .name("ui".into())
        .spawn(move || {
            for message in main_rx {
                match message {
                    ToMain::Batch(batch) => {
                        for item in &batch.items {
                            if let MountItem::Text { text, .. } = item {
                                seen.lock().unwrap().push(text.text.clone());
                            }
                        }
                        let _ = tx.send(batch);
                    }
                    ToMain::Task(task) => {
                        seen.lock().unwrap().push("task".into());
                        task.run();
                    }
                }
            }
        })
        .unwrap();
    let engine = Engine::start(
        config(App::Rust(Root::of::<OnMain>())),
        || ApproxTextEngine,
        MainThreadSink(main_tx),
    )
    .unwrap();
    let (texts, ..) = until(&rx, "ui true");
    assert_eq!(texts.last().map(String::as_str), Some("ui true"));
    // The batch of the turn that asked reaches the UI thread before the function.
    let order = order.lock().unwrap();
    let calling = order.iter().position(|t| t == "calling").unwrap();
    let task = order.iter().position(|t| t == "task").unwrap();
    assert!(calling < task, "{order:?}");
    drop(engine);
}

/// A Rust app's root, laid out in the surface's direction.
#[component]
fn Direction() -> impl IntoElement {
    view().flex_1().child(text("direction"))
}

#[test]
fn the_layout_direction_follows_the_language() {
    let (engine, rx, _) = start::<Direction>(Environment::default());
    // A Rust app's surface takes the platform's direction...
    let (_, directions, _) = until(&rx, "direction");
    assert_eq!(directions, [false]);
    // ...and a right-to-left language lays it out right to left, at once.
    let directions_after = |environment: Environment| {
        engine.control().set_environment(environment);
        let deadline = Instant::now() + Duration::from_secs(5);
        while let Ok(batch) = rx.recv_deadline(deadline) {
            let found = batch.items.iter().find_map(|item| match item {
                MountItem::LayoutDirection { rtl } => Some(*rtl),
                _ => None,
            });
            if found.is_some() {
                return found;
            }
        }
        None
    };
    let rtl = Environment {
        rtl: true,
        ..Environment::default()
    };
    assert_eq!(directions_after(rtl), Some(true));
    assert_eq!(directions_after(Environment::default()), Some(false));
}

/// Shows the pixel ratio, the device and the locale.
#[component]
fn Device() -> impl IntoElement {
    view().child(text(|| {
        let (major, minor) = os_version();
        format!(
            "{} {major}.{minor} {:?} ×{} {} {}",
            os().name(),
            idiom(),
            pixel_ratio(),
            round_to_nearest_pixel(px(10.3)).0,
            locale(),
        )
    }))
}

#[test]
fn components_read_the_pixel_ratio_the_device_and_the_locale() {
    let environment = Environment {
        pixel_ratio: 3.0,
        os: Os::Android,
        os_version: (34, 0),
        idiom: Idiom::Pad,
        locale: Locale::parse("de_DE").unwrap(),
        ..Environment::default()
    };
    let (engine, rx, _) = start::<Device>(environment);
    let shown = "android 34.0 Pad ×3 10.333333 de-DE";
    let (texts, ..) = until(&rx, shown);
    assert!(texts.iter().any(|t| t == shown), "{texts:?}");
    // The window moved to another screen: what reads the pixel ratio
    // follows.
    engine.control().set_environment(Environment {
        pixel_ratio: 2.0,
        ..environment
    });
    let shown = "android 34.0 Pad ×2 10.5 de-DE";
    let (texts, ..) = until(&rx, shown);
    assert!(texts.iter().any(|t| t == shown), "{texts:?}");
    // The user changed the language: what reads the locale follows.
    engine.control().set_environment(Environment {
        pixel_ratio: 2.0,
        locale: Locale::parse("zh-Hans_CN").unwrap(),
        ..environment
    });
    let shown = "android 34.0 Pad ×2 10.5 zh-Hans-CN";
    let (texts, ..) = until(&rx, shown);
    assert!(texts.iter().any(|t| t == shown), "{texts:?}");
}

/// Counts its effect's runs while it shows whether the app is in use, as
/// work that pauses in the background does.
#[component]
fn InUse() -> impl IntoElement {
    let runs = signal(0);
    effect(move || {
        let _ = lifecycle();
        runs.update(|r| *r += 1);
    });
    view().child(text(move || {
        format!("{} after {} runs", lifecycle().name(), runs.get())
    }))
}

#[test]
fn components_follow_whether_the_app_is_in_use() {
    let (engine, rx, _) = start::<InUse>(Environment::default());
    until(&rx, "active after 1 runs");
    for (state, shown) in [
        (Lifecycle::Inactive, "inactive after 2 runs"),
        (Lifecycle::Background, "background after 3 runs"),
        (Lifecycle::Active, "active after 4 runs"),
    ] {
        engine.control().set_environment(Environment {
            lifecycle: state,
            ..Environment::default()
        });
        let (texts, ..) = until(&rx, shown);
        assert_eq!(texts.last().map(|t| t.as_ref()), Some(shown));
    }
    // Another part of the environment changing runs nothing that read only
    // the lifecycle.
    engine.control().set_environment(Environment {
        font_scale: 1.5,
        ..Environment::default()
    });
    std::thread::sleep(Duration::from_millis(100));
    let texts: Vec<_> = rx
        .try_iter()
        .flat_map(|batch| batch.items)
        .filter_map(|item| match item {
            MountItem::Text { text, .. } => Some(text.text.clone()),
            _ => None,
        })
        .collect();
    assert!(
        texts.iter().all(|t| t == "active after 4 runs"),
        "{texts:?}"
    );
}

/// Registers a font it was given while the app runs and shows its family,
/// as an app that downloads its fonts does.
#[component]
fn Downloaded() -> impl IntoElement {
    let family = signal(String::from("none"));
    spawn(async move {
        let data =
            include_bytes!("../../../../tests/compat/cases/layout/fonts/Pacifico-Regular.woff2");
        let shown = match register_font(data.to_vec()).await {
            Ok(name) => name,
            Err(e) => format!("failed: {e}"),
        };
        family.set(shown);
    });
    view().child(text(move || format!("Family: {}", family.get())))
}

#[test]
fn a_component_registers_a_font_while_the_app_runs() {
    let (_engine, rx, _) = start::<Downloaded>(Environment::default());
    until(&rx, "Family: Pacifico");
}

/// Greets in the first of the user's languages it has, as an app's
/// translated text does.
#[component]
fn Greeting() -> impl IntoElement {
    view().child(text(move || {
        let languages = locale_settings().languages;
        let words = languages
            .iter()
            .find_map(|l| match l.as_str().split('-').next() {
                Some("de") => Some("Willkommen"),
                Some("fr") => Some("Bienvenue"),
                _ => None,
            })
            .unwrap_or("Welcome");
        format!("{words} ({})", languages.as_slice().len())
    }))
}

#[test]
fn components_follow_the_preferred_languages() {
    let (engine, rx, _) = start::<Greeting>(Environment::default());
    until(&rx, "Welcome (1)");
    for (tags, shown) in [
        (&["ja-JP", "fr-FR", "de-DE"][..], "Bienvenue (3)"),
        (&["de_AT", "en-US"][..], "Willkommen (2)"),
    ] {
        let mut env = Environment::default();
        env.locale_settings.languages = Languages::parse(tags.iter().copied()).unwrap();
        engine.control().set_environment(env);
        let (texts, ..) = until(&rx, shown);
        assert_eq!(texts.last().map(|t| t.as_ref()), Some(shown));
    }
}

/// Shows a time, a temperature and the week as the user reads them, and
/// counts the runs of an effect that reads the hour cycle alone through a
/// `computed`, as a clock's does.
#[component]
fn Forecast() -> impl IntoElement {
    let clock_runs = signal(0);
    let hour_cycle = computed(|| locale_settings().hour_cycle);
    effect(move || {
        let _ = hour_cycle.get();
        clock_runs.update(|r| *r += 1);
    });
    view().child(text(move || {
        let settings = locale_settings();
        let time = if settings.hour_cycle.twelve_hour() {
            "3 PM"
        } else {
            "15:00"
        };
        let temperature = match settings.temperature_unit {
            TemperatureUnit::Celsius => "20 °C",
            TemperatureUnit::Fahrenheit => "68 °F",
        };
        format!(
            "{time}, {temperature}, weeks from {}, {} units, clock ran {}",
            settings.first_day_of_week.number(),
            settings.measurement_system.name(),
            clock_runs.get()
        )
    }))
}

#[test]
fn components_follow_the_regional_preferences() {
    let (engine, rx, _) = start::<Forecast>(Environment::default());
    until(&rx, "3 PM, 68 °F, weeks from 7, us units, clock ran 1");
    let mut celsius = LocaleSettings::default();
    celsius.temperature_unit = TemperatureUnit::Celsius;
    let germany = LocaleSettings::of(Locale::parse("de-DE").unwrap());
    for (settings, shown) in [
        // Only the unit changes: the clock's effect does not run again.
        (celsius, "3 PM, 20 °C, weeks from 7, us units, clock ran 1"),
        (
            germany,
            "15:00, 20 °C, weeks from 1, metric units, clock ran 2",
        ),
    ] {
        engine.control().set_environment(Environment {
            locale_settings: settings,
            ..Environment::default()
        });
        let (texts, ..) = until(&rx, shown);
        assert_eq!(texts.last().map(|t| t.as_ref()), Some(shown));
    }
}

/// Shows the time zone and counts its effect's runs, as a clock that
/// shows times in it does.
#[component]
fn Zoned() -> impl IntoElement {
    let runs = signal(0);
    effect(move || {
        let _ = locale_settings().time_zone;
        runs.update(|r| *r += 1);
    });
    view().child(text(move || {
        format!("{} after {} runs", locale_settings().time_zone, runs.get())
    }))
}

#[test]
fn components_follow_the_time_zone() {
    let (engine, rx, _) = start::<Zoned>(Environment::default());
    until(&rx, "UTC after 1 runs");
    for (zone, shown) in [
        ("Europe/Berlin", "Europe/Berlin after 2 runs"),
        (
            "America/Argentina/Buenos_Aires",
            "America/Argentina/Buenos_Aires after 3 runs",
        ),
    ] {
        let mut env = Environment::default();
        env.locale_settings.time_zone = TimeZone::parse(zone).unwrap();
        engine.control().set_environment(env);
        let (texts, ..) = until(&rx, shown);
        assert_eq!(texts.last().map(|t| t.as_ref()), Some(shown));
    }
}

/// Speaks, moves the screen reader and opens a dialog
/// that sets the status bar.
#[component]
fn Services() -> impl IntoElement {
    let note = element_ref();
    let open = signal(false);
    view()
        .flex_1()
        .child(text("Announce").on_press(|_: &()| announce_for_accessibility("Saved")))
        .child(text("Focus").on_press(move |_: &()| note.set_accessibility_focus()))
        .child(text("Open").on_press(move |_: &()| open.set(true)))
        .child(text("The note").element_ref(&note))
        .child(dynamic(move || {
            open.get().then(|| {
                dialog()
                    .status_bar(|| {
                        StatusBarSetting::default()
                            .foreground(StatusBarStyle::Light)
                            .hidden(true)
                    })
                    .child(text("Close").on_press(move |_: &()| open.set(false)))
            })
        }))
}

#[test]
fn components_speak_move_the_reader_and_set_the_status_bar() {
    let (engine, rx, _) = start::<Services>(Environment::default());
    let mut texts = HashMap::new();
    // Presses the text `label` (none: only the first render) and returns
    // the commands that follow.
    let mut step = |press: Option<&str>| {
        if let Some(label) = press {
            engine
                .control()
                .dispatch_event(texts[label], EventKind::Press, EventPayload::None);
        }
        let mut commands = Vec::new();
        while let Ok(batch) = rx.recv_timeout(Duration::from_millis(300)) {
            for item in batch.items {
                match item {
                    MountItem::Text { id, text, .. } => {
                        texts.insert(text.text.clone(), id);
                    }
                    MountItem::Command { id, command } => commands.push((id, command)),
                    _ => {}
                }
            }
        }
        commands
    };
    let status_bars = |commands: &[(u32, Command)]| -> Vec<(StatusBarStyle, bool)> {
        commands
            .iter()
            .filter_map(|(_, c)| match c {
                Command::StatusBar(config) => Some((config.style, config.hidden)),
                _ => None,
            })
            .collect()
    };
    // Nothing sets the status bar until the dialog opens.
    assert_eq!(status_bars(&step(None)), []);
    assert_eq!(
        step(Some("Announce")),
        [(ROOT_ID, Command::Announce("Saved".into()))]
    );
    let focused = step(Some("Focus"));
    assert_eq!(
        focused.iter().map(|c| &c.1).collect::<Vec<_>>(),
        [&Command::AccessibilityFocus]
    );
    // The dialog's setting while it shows; the default again once it
    // closed.
    assert_eq!(
        status_bars(&step(Some("Open"))),
        [(StatusBarStyle::Light, true)]
    );
    assert_eq!(
        status_bars(&step(Some("Close"))),
        [(StatusBarStyle::Default, false)]
    );
    // The reader's focus went to the note's view.
    assert_eq!(focused[0].0, texts["The note"]);
}

/// Shows the window's x, mode and whether it is minimized, and how many
/// displays there are.
#[component]
fn WindowInfo() -> impl IntoElement {
    view().child(text(move || {
        let displays = nsh_core::element::desktop::displays().len();
        match nsh_core::element::desktop::window_state() {
            Some(state) => {
                let mode = match state.mode {
                    WindowMode::Normal => "windowed",
                    WindowMode::Maximized => "maximized",
                    WindowMode::FullScreen => "fullscreen",
                };
                format!(
                    "x {} {mode} minimized {} displays {displays}",
                    state.bounds.origin.x.0, state.minimized
                )
            }
            None => format!("no window, displays {displays}"),
        }
    }))
}

/// A window at `x`, 800 × 600, in `mode`'s mode.
fn window_at(x: f32, mode: WindowMode) -> Environment {
    let bounds = Bounds::new(point(px(x), px(0.0)), size(px(800.0), px(600.0)));
    Environment {
        window_state: Some(WindowState::new(bounds, WindowPlacement::new(mode, bounds))),
        ..Environment::default()
    }
}

fn display(id: u64, x: f32) -> Display {
    let bounds = Bounds::new(point(px(x), px(0.0)), size(px(1440.0), px(900.0)));
    Display::new(DisplayId(id), bounds, bounds, x == 0.0)
}

/// The last text the batches so far showed.
fn last_text(rx: &Receiver<MountBatch>, last: &mut String) -> String {
    while let Ok(batch) = rx.try_recv() {
        for item in &batch.items {
            if let MountItem::Text { text, .. } = item {
                last.clone_from(&text.text);
            }
        }
    }
    last.clone()
}

/// Moves `engine`'s manual clock by `ms`, then waits until it got there.
fn advance(engine: &Engine, ms: u64) {
    let (tx, rx) = crossbeam_channel::bounded(1);
    engine
        .control()
        .advance_clock(Duration::from_millis(ms), move || {
            let _ = tx.send(());
        });
    rx.recv_timeout(Duration::from_secs(10)).unwrap();
}

#[test]
fn components_read_the_window_once_it_stops_and_the_displays() {
    let (tx, rx) = crossbeam_channel::unbounded();
    let config = EngineConfig {
        environment: window_at(0.0, WindowMode::Normal),
        clock: nsh_core::time::Clock::manual(
            std::time::SystemTime::UNIX_EPOCH + Duration::from_secs(1_767_225_600),
        ),
        ..config(App::Rust(Root::of::<WindowInfo>()))
    };
    let sink = FrameSink {
        batches: tx,
        frames: Arc::new(AtomicUsize::new(0)),
    };
    // The displays sent before the start are there as the app first renders.
    let engine = Engine::start_with(
        config,
        || ApproxTextEngine,
        sink,
        |control| {
            control.set_displays(vec![display(1, 0.0), display(2, 1440.0)]);
        },
    )
    .unwrap();
    let mut last = String::new();
    advance(&engine, 0);
    assert_eq!(
        last_text(&rx, &mut last),
        "x 0 windowed minimized false displays 2"
    );
    // A drag: held back while the window moves, reported 150 ms after it
    // stopped.
    engine
        .control()
        .set_environment(window_at(10.0, WindowMode::Normal));
    advance(&engine, 100);
    engine
        .control()
        .set_environment(window_at(20.0, WindowMode::Normal));
    advance(&engine, 100);
    assert_eq!(
        last_text(&rx, &mut last),
        "x 0 windowed minimized false displays 2"
    );
    advance(&engine, 60);
    assert_eq!(
        last_text(&rx, &mut last),
        "x 20 windowed minimized false displays 2"
    );
    // Another part of the environment while the window moves does not
    // hold it longer.
    engine
        .control()
        .set_environment(window_at(30.0, WindowMode::Normal));
    advance(&engine, 100);
    engine.control().set_environment(Environment {
        font_scale: 1.5,
        ..window_at(30.0, WindowMode::Normal)
    });
    advance(&engine, 60);
    assert_eq!(
        last_text(&rx, &mut last),
        "x 30 windowed minimized false displays 2"
    );
    // A change of mode or minimizing comes at once, with the bounds of then.
    engine
        .control()
        .set_environment(window_at(0.0, WindowMode::Maximized));
    advance(&engine, 0);
    assert_eq!(
        last_text(&rx, &mut last),
        "x 0 maximized minimized false displays 2"
    );
    let mut minimized = window_at(0.0, WindowMode::Maximized);
    if let Some(state) = &mut minimized.window_state {
        state.minimized = true;
    }
    engine.control().set_environment(minimized);
    advance(&engine, 0);
    assert_eq!(
        last_text(&rx, &mut last),
        "x 0 maximized minimized true displays 2"
    );
    // A display unplugged.
    engine.control().set_displays(vec![display(1, 0.0)]);
    advance(&engine, 0);
    assert_eq!(
        last_text(&rx, &mut last),
        "x 0 maximized minimized true displays 1"
    );
    // Off desktops there is no window and no display.
    engine.control().set_environment(Environment::default());
    engine.control().set_displays(Vec::new());
    advance(&engine, 0);
    assert_eq!(last_text(&rx, &mut last), "no window, displays 0");
}

/// Shows whether the performance monitor measures and turns it on.
#[component]
fn FpsSwitch() -> impl IntoElement {
    view()
        .child(text(move || format!("fps {}", fps_enabled())))
        .child(text("Measure").on_press(|_: &()| set_fps_enabled(true)))
}

#[test]
fn components_turn_the_performance_monitor_on_and_follow_it() {
    let (engine, rx, _) = start::<FpsSwitch>(Environment::default());
    let mut press = None;
    let deadline = Instant::now() + Duration::from_secs(5);
    while press.is_none() {
        let batch = rx.recv_deadline(deadline).expect("the first render");
        for item in batch.items {
            if let MountItem::Text { id, text, .. } = item
                && text.text == "Measure"
            {
                press = Some(id);
            }
        }
    }
    // The app asks; the platform turns its monitor on.
    engine
        .control()
        .dispatch_event(press.unwrap(), EventKind::Press, EventPayload::None);
    let mut asked = false;
    while !asked {
        let batch = rx.recv_deadline(deadline).expect("the command");
        asked = batch.items.iter().any(|item| {
            matches!(
                item,
                MountItem::Command {
                    id: ROOT_ID,
                    command: Command::PerfMonitor(true)
                }
            )
        });
    }
    // What the app reads follows the monitor the platform installs, and
    // removes.
    engine
        .control()
        .set_perf_monitor(Some(Arc::new(nsh_engine::perf::PerfMonitor::new())));
    until(&rx, "fps true");
    engine.control().set_perf_monitor(None);
    let (texts, ..) = until(&rx, "fps false");
    assert_eq!(texts.last().map(String::as_str), Some("fps false"));
}

/// A Rust app's `nsh.json` `"window"` (its root's, as the generated code
/// sets it) reaches the main window as a TSX app's bundle's does: its
/// attributes with the first frame, the options for the runners.
#[test]
fn a_rust_apps_main_window_takes_its_launch_options() {
    use nsh_core::desktop::DesktopCommand;
    let root = Root::of::<Label>().main_window_json(
        r#"{"title":"Notes","defaultSize":{"width":900,"height":600},"restoreBounds":true}"#,
    );
    let options = root
        .main_window_ref()
        .cloned()
        .expect("the window's options");
    assert_eq!(options.attributes.title.as_deref(), Some("Notes"));
    assert!(options.restore_bounds);
    let config = EngineConfig {
        environment: Environment {
            os: Os::MacOs,
            idiom: Idiom::Desktop,
            ..Environment::default()
        },
        ..config(App::Rust(root))
    };
    // What the runners read before they make the window.
    assert_eq!(config.app.main_window(), Some(&options));
    let (tx, rx) = crossbeam_channel::unbounded();
    let _engine = Engine::start(
        config,
        || ApproxTextEngine,
        FrameSink {
            batches: tx,
            frames: Arc::default(),
        },
    )
    .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut set = None;
    while set.is_none()
        && let Ok(batch) = rx.recv_deadline(deadline)
    {
        set = batch.items.into_iter().find_map(|item| match item {
            MountItem::Command {
                id: ROOT_ID,
                command: Command::Desktop(command),
            } => match *command {
                DesktopCommand::SetAttributes(attributes) => Some(attributes),
                _ => None,
            },
            _ => None,
        });
    }
    let set = set.expect("the main window's attributes");
    assert_eq!(set.title.as_deref(), Some("Notes"));
}
