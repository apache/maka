//! The OS the platform reports decides `platform` and which platform-only
//! props (`ios={{…}}`, `android={{…}}`, `macos={{…}}`, `windows={{…}}`,
//! `desktop={{…}}`, `web={{…}}`) apply; on the web, the idiom decides between mobile and
//! desktop, and the terminal idiom behaves as a desktop. `platform.desktop`, the
//! `desktop` idiom, `select`'s `desktop` and `desktop={{…}}` all follow the
//! one definition of desktop (`Environment::desktop`), whatever idiom the
//! platform set.

use std::time::Duration;

use crossbeam_channel::Receiver;
use nsh_core::{
    ApproxTextEngine, Command, EventKind, EventPayload, MountBatch, MountItem, Size,
    desktop::{DesktopCommand, WindowEvent, WindowRequest},
    geometry::px,
};
use nsh_engine::{Bundle, Engine, EngineConfig, Environment, Idiom, Os};

use crate::ChannelSink;

const APP: &str = r#"import { mount, Text, View } from "nsh";
import { platform } from "nsh";
import { Window } from "nsh/desktop";

mount(
  () => (
    <Window id="main">
    <View
      ios={{ accessibilityLabel: "ios" }}
      android={{ accessibilityLabel: "android" }}
      desktop={{ accessibilityLabel: "desktop" }}
      web={{ accessibilityHint: "web" }}
    >
      <Text>{`${platform.os} ${platform.idiom} ${platform.desktop} ${platform.catalyst} ${platform.select({ ios: "i", mobile: "m", desktop: "d" })} ${platform.select({ native: "n", default: "-" })}`}</Text>
    </View>
    </Window>
  ),
);
"#;

/// The first frame of `app` on `os`.
fn first_frame_of(app: &str, tag: &str, os: Os, idiom: Idiom) -> Vec<MountItem> {
    let dir = std::env::temp_dir().join(format!(
        "nsh-platform-{}-{tag}-{}-{idiom:?}",
        std::process::id(),
        os.name()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let entry = dir.join("App.tsx");
    std::fs::write(&entry, app).unwrap();
    let bundle = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
        entry,
        minify: false,
        split: false,
        ui_sets: vec![nsh_base::registry().into()],
        ..Default::default()
    })
    .unwrap();
    let (tx, rx) = crossbeam_channel::unbounded();
    let config = EngineConfig {
        app: nsh_engine::App::Js(Bundle::source(bundle.code)),
        viewport: Size::new(px(320.0), px(480.0)),
        trace: false,
        content_culling: false,
        network: None,
        websocket: None,
        refuse_connections: None,
        filesystem: None,
        assets: None,
        environment: Environment {
            os,
            idiom,
            ..Environment::default()
        },
        header_heights: (nsh_core::Points(44.0), nsh_core::Points(96.0)),
        limits: nsh_engine::Limits::default(),
        ui_sets: Vec::new(),
        runtime: None,
        support_dir: None,
        cache: nsh_engine::CacheOptions::off(),
        storage: None,
        clock: Default::default(),
        context: Default::default(),
        pinned: Default::default(),
        clipboard: None,
        host: Default::default(),
        picker: None,
        chunk_loader: None,
        audio: None,
        windows: None,
        login_item: None,
        data_dir: None,
    };
    let _engine = Engine::start(config, || ApproxTextEngine, ChannelSink(tx)).unwrap();
    rx.recv_timeout(Duration::from_secs(5))
        .expect("first frame")
        .items
}

/// The first frame's texts and accessibility labels and hints on `os`.
fn first_frame(os: Os, idiom: Idiom) -> (Vec<String>, Vec<String>) {
    let mut texts = Vec::new();
    let mut labels = Vec::new();
    for item in first_frame_of(APP, "platform", os, idiom) {
        match item {
            MountItem::Text { text, .. } => texts.push(text.text.clone()),
            MountItem::ViewProps { props, .. } => {
                labels.extend(props.accessibility.label.as_deref().map(str::to_owned));
                labels.extend(props.accessibility.hint.as_deref().map(str::to_owned));
            }
            _ => {}
        }
    }
    (texts, labels)
}

#[test]
fn platform_props_and_select_follow_the_os() {
    let frame = |os, idiom, text: &str, labels: &[&str]| {
        assert_eq!(
            first_frame(os, idiom),
            (
                vec![text.to_owned()],
                labels.iter().map(|l| (*l).to_owned()).collect()
            ),
            "{os:?} {idiom:?}"
        );
    };
    frame(Os::Ios, Idiom::Phone, "ios phone false false i n", &["ios"]);
    frame(
        Os::Android,
        Idiom::Phone,
        "android phone false false m n",
        &["android"],
    );
    frame(
        Os::MacOs,
        Idiom::Desktop,
        "macos desktop true false d n",
        &["desktop"],
    );
    // A desktop OS is desktop whatever idiom it was given.
    frame(
        Os::Linux,
        Idiom::Phone,
        "linux desktop true false d n",
        &["desktop"],
    );
    // UIKit's Mac idiom (Mac Catalyst) is mobile: the iOS backend. This
    // build is not Catalyst's, so `catalyst` is false.
    frame(Os::Ios, Idiom::Mac, "ios mac false false i n", &["ios"]);
    // No mobile OS reports "desktop".
    frame(
        Os::Ios,
        Idiom::Desktop,
        "ios phone false false i n",
        &["ios"],
    );
    // `native` is not the web, as in React Native.
    frame(Os::Web, Idiom::Phone, "web phone false false m -", &["web"]);
    frame(Os::Web, Idiom::Pad, "web pad false false m -", &["web"]);
    // A desktop browser behaves as a desktop.
    frame(
        Os::Web,
        Idiom::Desktop,
        "web desktop true false d -",
        &["desktop", "web"],
    );
    // A terminal reports the real OS and behaves as a desktop, in an idiom
    // of its own.
    frame(
        Os::Linux,
        Idiom::Terminal,
        "linux terminal true false d n",
        &["desktop"],
    );
}

const WINDOW_APP: &str = r#"import { mount, Text } from "nsh";
import { Window, currentWindow, displays, windowState } from "nsh/desktop";

function App() {
  const win = currentWindow();
  // A placement saved on a display that is gone, given back before the
  // first report: NSH fits it on the display there is.
  win.setPlacement({
    mode: "maximized",
    bounds: { origin: { x: -3000, y: 0 }, size: { width: 800, height: 600 } },
  });

  // Read in the binding, which runs again when they change (the
  // component's body runs once).
  const shown = () => {
    const state = windowState();
    return state
      ? `${state.placement.mode} ${state.bounds.origin.x} ${state.minimized} ${!state.visible} ${state.display?.id}`
      : "none";
  };
  const listed = () =>
    displays().length
      ? displays()
          .map((d) => {
            const cutouts = d.cutouts.map((c) => `${c.origin.x}+${c.size.width}x${c.size.height}`);
            return `${d.id} ${d.primary} ${d.visibleBounds.size.width} [${cutouts.join(";")}]`;
          })
          .join(",")
      : "no displays";

  return <Text>{`${shown()} | ${listed()}`}</Text>;
}

mount(() => <Window id="main"><App /></Window>);
"#;

#[test]
fn js_reads_the_window_and_the_displays_and_restores_bounds() {
    use nsh_core::{
        desktop::{Display, DisplayId, WindowMode, WindowPlacement, WindowState},
        geometry::{Bounds, point, size},
    };
    /// Batches until a text starts with `until`: what the app showed so far,
    /// the placements it asked for, and the window root its `OpenWindow`
    /// named.
    fn drain(
        rx: &Receiver<MountBatch>,
        texts: &mut Vec<String>,
        restored: &mut Vec<WindowPlacement>,
        window: &mut Option<nsh_core::NodeId>,
        until: &str,
    ) -> String {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while let Ok(batch) = rx.recv_deadline(deadline) {
            for item in batch.items {
                match item {
                    MountItem::Text { text, .. } => texts.push(text.text.to_string()),
                    MountItem::Command {
                        id,
                        command: Command::Desktop(command),
                    } => match *command {
                        DesktopCommand::OpenWindow(_) => *window = Some(id),
                        DesktopCommand::Request(WindowRequest::SetPlacement(p)) => {
                            restored.push(p);
                        }
                        _ => {}
                    },
                    _ => {}
                }
            }
            if let Some(text) = texts.last().filter(|t| t.starts_with(until)) {
                return text.clone();
            }
        }
        panic!("no text {until:?} in {texts:?}");
    }
    let dir = std::env::temp_dir().join(format!("nsh-window-state-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let entry = dir.join("App.tsx");
    std::fs::write(&entry, WINDOW_APP).unwrap();
    let bundle = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
        entry,
        minify: false,
        split: false,
        ui_sets: vec![nsh_base::registry().into()],
        ..Default::default()
    })
    .unwrap();
    let rect = |x: f32, w: f32, h: f32| Bounds::new(point(px(x), px(0.0)), size(px(w), px(h)));
    let mut display = Display::new(
        DisplayId(0xab),
        rect(0.0, 1440.0, 900.0),
        rect(0.0, 1440.0, 875.0),
        true,
    );
    // A notch at the top's middle.
    display.cutouts = vec![rect(620.0, 200.0, 32.0)];
    let window = rect(100.0, 800.0, 600.0);
    let (tx, rx) = crossbeam_channel::unbounded();
    let config = EngineConfig {
        environment: Environment {
            os: Os::MacOs,
            idiom: Idiom::Desktop,
            ..Environment::default()
        },
        ..EngineConfig::new(nsh_engine::App::Js(Bundle::source(bundle.code)))
    };
    let engine = Engine::start_with(
        config,
        || ApproxTextEngine,
        ChannelSink(tx),
        |control| {
            control.set_displays(vec![display.clone()]);
        },
    )
    .unwrap();
    let mut texts = Vec::new();
    let mut restored = Vec::new();
    let mut root = None;
    // The window opened; the platform has reported no state yet.
    let text = drain(&rx, &mut texts, &mut restored, &mut root, "none |");
    assert_eq!(text, "none | 00000000000000ab true 1440 [620+200x32]");
    let window_root = root.expect("the window opens");
    let report = |state: WindowState| {
        engine.control().dispatch_event(
            window_root,
            EventKind::Window,
            EventPayload::Window(Box::new(WindowEvent::State(Box::new(state)))),
        );
    };
    // The window and the displays are there as the platform reports them.
    let mut state = WindowState::new(window, WindowPlacement::new(WindowMode::Normal, window));
    state.display = Some(display.id);
    report(state);
    let text = drain(&rx, &mut texts, &mut restored, &mut root, "normal 100");
    assert_eq!(
        text,
        "normal 100 false false 00000000000000ab | 00000000000000ab true 1440 [620+200x32]"
    );
    // The placement the app gave back before the first report is fitted on
    // the display there is (centered, the mode kept).
    assert_eq!(
        restored,
        vec![WindowPlacement::new(
            WindowMode::Maximized,
            Bounds::new(point(px(320.0), px(137.5)), size(px(800.0), px(600.0)))
        )]
    );
    // Maximized: at once.
    let mut maximized =
        WindowState::new(window, WindowPlacement::new(WindowMode::Maximized, window));
    maximized.display = Some(display.id);
    report(maximized);
    drain(&rx, &mut texts, &mut restored, &mut root, "maximized 100");
    // No display: none listed.
    engine.control().set_displays(Vec::new());
    let text = drain(&rx, &mut texts, &mut restored, &mut root, "maximized 100");
    assert!(text.ends_with(" | no displays"), "{text}");
}

const FPS_APP: &str = r#"import { fpsEnabled, mount, setFpsEnabled, Text } from "nsh";

mount(() => <Text onPress={() => setFpsEnabled(true)}>{`fps ${fpsEnabled()}`}</Text>);
"#;

#[test]
fn js_turns_the_performance_monitor_on_and_follows_it() {
    use nsh_core::{Command, EventKind, EventPayload, ROOT_ID};
    let dir = std::env::temp_dir().join(format!("nsh-fps-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let entry = dir.join("App.tsx");
    std::fs::write(&entry, FPS_APP).unwrap();
    let bundle = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
        entry,
        minify: false,
        split: false,
        ui_sets: vec![nsh_base::registry().into()],
        ..Default::default()
    })
    .unwrap();
    let (tx, rx) = crossbeam_channel::unbounded();
    let config = EngineConfig::new(nsh_engine::App::Js(Bundle::source(bundle.code)));
    let engine = Engine::start(config, || ApproxTextEngine, ChannelSink(tx)).unwrap();
    // The text's node and what it shows, and whether the app asked for the
    // monitor, until it shows `until`.
    let node = std::cell::Cell::new(None);
    let read = |until: &str| -> bool {
        let mut asked = false;
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while let Ok(batch) = rx.recv_deadline(deadline) {
            let mut shown = false;
            for item in batch.items {
                match item {
                    MountItem::Text { id, text, .. } => {
                        node.set(Some(id));
                        shown |= text.text == until;
                    }
                    MountItem::Command {
                        id: ROOT_ID,
                        command: Command::PerfMonitor(true),
                    } => asked = true,
                    _ => {}
                }
            }
            if shown || (until.is_empty() && asked) {
                return asked;
            }
        }
        panic!("never showed {until:?}");
    };
    read("fps false");
    engine
        .control()
        .dispatch_event(node.get().unwrap(), EventKind::Press, EventPayload::None);
    assert!(read(""), "the press asks the platform for the monitor");
    // The platform installs it, and removes it.
    engine.control().set_perf_monitor(Some(std::sync::Arc::new(
        nsh_engine::perf::PerfMonitor::new(),
    )));
    read("fps true");
    engine.control().set_perf_monitor(None);
    read("fps false");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_performance_monitor_reports_its_stats_once_a_second() {
    let dir = std::env::temp_dir().join(format!("nsh-perf-stats-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let entry = dir.join("App.tsx");
    std::fs::write(
        &entry,
        r#"import { mount, perfStats, Text } from "nsh";
mount(() => <Text>{`reading ${perfStats()?.fps ?? "none"}`}</Text>);
"#,
    )
    .unwrap();
    let bundle = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
        entry,
        minify: false,
        split: false,
        ui_sets: vec![nsh_base::registry().into()],
        ..Default::default()
    })
    .unwrap();
    let (tx, rx) = crossbeam_channel::unbounded();
    let config = EngineConfig::new(nsh_engine::App::Js(Bundle::source(bundle.code)));
    let engine = Engine::start(config, || ApproxTextEngine, ChannelSink(tx)).unwrap();
    // The text it shows, until `done` holds of it.
    let read = |done: &dyn Fn(&str) -> bool| -> String {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while let Ok(batch) = rx.recv_deadline(deadline) {
            for item in batch.items {
                if let MountItem::Text { text, .. } = item
                    && done(&text.text)
                {
                    return text.text.to_string();
                }
            }
        }
        panic!("the reading never showed");
    };
    read(&|t| t == "reading none");
    // The platform installs a monitor and shows frames, one a refresh,
    // until the reading has them.
    let monitor = std::sync::Arc::new(nsh_engine::perf::PerfMonitor::new());
    engine.control().set_perf_monitor(Some(monitor.clone()));
    let showing = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
    let frames = {
        let (monitor, showing) = (monitor.clone(), showing.clone());
        std::thread::spawn(move || {
            while showing.load(std::sync::atomic::Ordering::SeqCst) {
                monitor.record_work(Duration::from_millis(1), true);
                monitor.vsync(std::time::Instant::now(), Duration::from_millis(16));
                std::thread::sleep(Duration::from_millis(16));
            }
        })
    };
    let shown = read(&|t| {
        t.strip_prefix("reading ")
            .and_then(|n| n.parse::<f32>().ok())
            .is_some_and(|fps| fps > 0.0)
    });
    showing.store(false, std::sync::atomic::Ordering::SeqCst);
    frames.join().unwrap();
    assert!(shown.starts_with("reading "), "{shown}");
    // Removed, it reads none again.
    engine.control().set_perf_monitor(None);
    read(&|t| t == "reading none");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_performance_monitor_reads_what_the_app_holds_when_idle() {
    let dir = std::env::temp_dir().join(format!("nsh-fps-memory-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let entry = dir.join("App.tsx");
    std::fs::write(
        &entry,
        r#"import { mount, Text, View } from "nsh";
mount(() => <View>{Array.from({ length: 50 }, (_, i) => <Text>{`row ${i}`}</Text>)}</View>);
"#,
    )
    .unwrap();
    let bundle = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
        entry,
        minify: false,
        split: false,
        ui_sets: vec![nsh_base::registry().into()],
        ..Default::default()
    })
    .unwrap();
    let (tx, rx) = crossbeam_channel::unbounded();
    let config = EngineConfig::new(nsh_engine::App::Js(Bundle::source(bundle.code)));
    let engine = Engine::start(config, || ApproxTextEngine, ChannelSink(tx)).unwrap();
    let monitor = std::sync::Arc::new(nsh_engine::perf::PerfMonitor::new());
    engine.control().set_perf_monitor(Some(monitor.clone()));
    assert_eq!(
        monitor.snapshot().memory,
        None,
        "nothing read before a collection"
    );
    // The engine reads it after its first idle collection, a second in.
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    let memory = loop {
        while rx.try_recv().is_ok() {}
        if let Some(m) = monitor.snapshot().memory {
            break m;
        }
        assert!(std::time::Instant::now() < deadline, "never read");
        std::thread::sleep(Duration::from_millis(50));
    };
    assert!(memory.js_heap > 0 && memory.js_objects > 0, "{memory:?}");
    assert!(memory.nodes > 50, "{memory:?}");
    assert!(memory.node_ids >= memory.nodes, "{memory:?}");
    let _ = std::fs::remove_dir_all(&dir);
}

const WINDOWS_APP: &str = r#"import { mount, signal, Text, View } from "nsh";
import { Window, currentWindow, titleBar, type WindowRef } from "nsh/desktop";

const open = signal(true);
const closed = signal("open");
// `ref` gives the window's `WindowRef`.
const win = signal<WindowRef | null>(null);

function Inspector() {
  const w = currentWindow();
  return (
    <Text>{`${w.id} ${titleBar().height} ${w.titleBar().height} ${w.state()?.focused ?? "unknown"}`}</Text>
  );
}

mount(() => (
  <Window id="main">
  <View>
    <Text>{`main ${closed()}`}</Text>
    <Text>{`ref ${win()?.id ?? "none"} ${win()?.main}`}</Text>
    <Window
      ref={win}
      id="inspector"
      kind="panel"
      title="Inspector"
      open={open()}
      onOpenChange={(e) => {
        closed.set(`${e.open} ${e.reason}`);
        open.set(e.open);
      }}
    >
      <Inspector />
    </Window>
  </View>
  </Window>
));
"#;

#[test]
fn js_windows_open_with_their_kinds_defaults_and_report_back() {
    use nsh_core::{
        Command, EventKind, EventPayload, NodeId,
        desktop::{
            DesktopCommand, WindowCloseCause, WindowEvent, WindowKind, WindowLevel, WindowMode,
            WindowPlacement, WindowState,
        },
        geometry::{Bounds, Edges, point, size},
    };
    let dir = std::env::temp_dir().join(format!("nsh-windows-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let entry = dir.join("App.tsx");
    std::fs::write(&entry, WINDOWS_APP).unwrap();
    let bundle = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
        entry,
        minify: false,
        split: false,
        ui_sets: vec![nsh_base::registry().into()],
        ..Default::default()
    })
    .unwrap();
    let (tx, rx) = crossbeam_channel::unbounded();
    let config = EngineConfig {
        environment: Environment {
            os: Os::MacOs,
            idiom: Idiom::Desktop,
            ..Environment::default()
        },
        ..EngineConfig::new(nsh_engine::App::Js(Bundle::source(bundle.code)))
    };
    let engine = Engine::start_with(config, || ApproxTextEngine, ChannelSink(tx), |_| {}).unwrap();
    let mut texts = Vec::new();
    let mut opened: Vec<(NodeId, Box<nsh_core::desktop::OpenWindow>)> = Vec::new();
    let mut removed: Vec<NodeId> = Vec::new();
    let mut read = |until: &str, opened: &mut Vec<_>, removed: &mut Vec<NodeId>| {
        // Shown already, in a batch an earlier read took.
        if texts.iter().any(|t| t == until) {
            return;
        }
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while let Ok(batch) = rx.recv_deadline(deadline) {
            for item in batch.items {
                match item {
                    MountItem::Text { text, .. } => texts.push(text.text.to_string()),
                    MountItem::Command {
                        id,
                        command: Command::Desktop(command),
                    } => {
                        if let DesktopCommand::OpenWindow(open) = *command {
                            opened.push((id, open));
                        }
                    }
                    MountItem::Remove { id } => removed.push(id),
                    _ => {}
                }
            }
            if texts.iter().any(|t| t == until) {
                return;
            }
        }
        panic!("no text {until:?} in {texts:?}");
    };
    // It opens resolved: the panel's defaults, the app's title over them;
    // `currentWindow()` in it is the window, with no title bar reported
    // yet and no state.
    read("inspector 0 0 unknown", &mut opened, &mut removed);
    read("ref inspector false", &mut opened, &mut removed);
    let (id, open) = opened
        .iter()
        .find(|(_, open)| open.options.id == "inspector")
        .map(|(id, open)| (*id, open))
        .unwrap_or_else(|| panic!("the inspector opens: {opened:?}"));
    assert_eq!(open.options.id, "inspector");
    assert_eq!(open.options.kind, WindowKind::Panel);
    let a = &open.options.attributes;
    assert_eq!(a.title.as_deref(), Some("Inspector"));
    assert_eq!(a.level, Some(WindowLevel::Floating));
    assert_eq!(a.taskbar, Some(false));
    assert_eq!(a.activate, Some(false));
    // The platform reports its title bar and state: `titleBar()` in it
    // and `currentWindow()`'s follow.
    let control = engine.control();
    control.dispatch_event(
        id,
        EventKind::Window,
        EventPayload::Window(Box::new(WindowEvent::TitleBar(Edges {
            top: px(28.0),
            left: px(72.0),
            ..Default::default()
        }))),
    );
    let bounds = Bounds::new(point(px(10.0), px(20.0)), size(px(300.0), px(200.0)));
    let mut state = WindowState::new(bounds, WindowPlacement::new(WindowMode::Normal, bounds));
    state.focused = true;
    control.dispatch_event(
        id,
        EventKind::Window,
        EventPayload::Window(Box::new(WindowEvent::State(Box::new(state)))),
    );
    read("inspector 28 28 true", &mut opened, &mut removed);
    // Escape closed it (its policy): the app hears why, and its root goes.
    control.dispatch_event(
        id,
        EventKind::Window,
        EventPayload::Window(Box::new(WindowEvent::Closed {
            cause: WindowCloseCause::Escape,
        })),
    );
    read("main false escape", &mut opened, &mut removed);
    assert!(removed.contains(&id), "{removed:?}");
}

const WINDOW_POPOVER_APP: &str = r#"import { mount, Overlay, signal, Text, View, type ViewRef } from "nsh";
import { Window } from "nsh/desktop";

const placed = signal("not placed");
let anchor: ViewRef | undefined;

mount(() => (
  <Window id="main">
  <View>
    <View style={{ height: 500 }} />
    <Text>{placed()}</Text>
    <Window id="tools" defaultSize={{ width: 300, height: 100 }}>
      <View style={{ paddingLeft: 20, paddingTop: 50 }}>
        <View ref={anchor} style={{ width: 60, height: 30 }} />
        <Overlay
          anchor={anchor}
          placement="bottom"
          align="start"
          onPosition={(e) =>
            placed.set(`${e.placement} ${e.bounds.origin.x} ${e.bounds.origin.y}`)
          }
        >
          <View style={{ width: 80, height: 40 }} />
        </Overlay>
      </View>
    </Window>
  </View>
  </Window>
));
"#;

/// A popover in a window of the app's own is placed in that window: in its
/// coordinates and within its size, not the main window's.
#[test]
fn js_popovers_in_a_window_are_placed_in_it() {
    use nsh_core::{Command, NodeId, desktop::DesktopCommand};
    let dir = std::env::temp_dir().join(format!("nsh-window-popover-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let entry = dir.join("App.tsx");
    std::fs::write(&entry, WINDOW_POPOVER_APP).unwrap();
    let bundle = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
        entry,
        minify: false,
        split: false,
        ui_sets: vec![nsh_base::registry().into()],
        ..Default::default()
    })
    .unwrap();
    let (tx, rx) = crossbeam_channel::unbounded();
    let config = EngineConfig {
        environment: Environment {
            os: Os::MacOs,
            idiom: Idiom::Desktop,
            ..Environment::default()
        },
        ..EngineConfig::new(nsh_engine::App::Js(Bundle::source(bundle.code)))
    };
    let _engine = Engine::start_with(config, || ApproxTextEngine, ChannelSink(tx), |_| {}).unwrap();
    let mut texts = Vec::new();
    let mut window: Option<NodeId> = None;
    let mut inserted: Vec<(NodeId, NodeId)> = Vec::new();
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while let Ok(batch) = rx.recv_deadline(deadline) {
        for item in batch.items {
            match item {
                MountItem::Text { text, .. } => texts.push(text.text.to_string()),
                MountItem::Insert { parent, child, .. } => inserted.push((parent, child)),
                MountItem::Command {
                    id,
                    command: Command::Desktop(command),
                } if matches!(*command, DesktopCommand::OpenWindow(_)) => window = Some(id),
                _ => {}
            }
        }
        if texts
            .iter()
            .any(|t| t.starts_with("top") || t.starts_with("bottom"))
        {
            break;
        }
    }
    let window = window.expect("the window opens");
    // Above the button: the window is 100 points tall, with no room below
    // it; 20 points in, as the window's content has it, whatever is above
    // the window's node in the main window.
    assert_eq!(
        texts
            .iter()
            .rev()
            .find(|t| t.starts_with("top") || t.starts_with("bottom")),
        Some(&"top 20 10".to_owned()),
        "{texts:?}"
    );
    // Its view is in the window's root view.
    assert!(
        inserted.iter().filter(|(p, _)| *p == window).count() >= 2,
        "{inserted:?}"
    );
}

const WINDOW_RESIZE_APP: &str = r#"import { mount, View } from "nsh";
import { Window } from "nsh/desktop";

mount(() => (
  <Window id="main">
    <View />
    <Window id="tools" defaultSize={{ width: 300, height: 100 }}>
      <View style={{ flexGrow: 1 }} />
    </Window>
  </Window>
));
"#;

/// What the engine handed a [`RootResizeSink`].
#[derive(Debug)]
enum RootSent {
    Batch(MountBatch),
    RootResized(nsh_core::NodeId, Size<nsh_core::Points>),
}

/// Hands batches and root resize reports to the test, in order.
struct RootResizeSink(crossbeam_channel::Sender<RootSent>);

impl nsh_engine::MountSink for RootResizeSink {
    fn submit(&self, batch: MountBatch) {
        let _ = self.0.send(RootSent::Batch(batch));
    }

    fn root_resized(&self, id: nsh_core::NodeId, size: Size<nsh_core::Points>) {
        let _ = self.0.send(RootSent::RootResized(id, size));
    }
}

/// A window of the app's own the platform resizes is reported laid out at
/// its new size after the batch with that layout: what the macOS platform
/// waits for, to show the window's content at the size AppKit animates it
/// to (full screen, zoom).
#[test]
fn a_window_resize_is_reported_after_its_layout() {
    use nsh_core::{Command, EdgeInsets, NodeId, desktop::DesktopCommand};
    let dir = std::env::temp_dir().join(format!("nsh-window-resize-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let entry = dir.join("App.tsx");
    std::fs::write(&entry, WINDOW_RESIZE_APP).unwrap();
    let bundle = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
        entry,
        minify: false,
        split: false,
        ui_sets: vec![nsh_base::registry().into()],
        ..Default::default()
    })
    .unwrap();
    let (tx, rx) = crossbeam_channel::unbounded();
    let config = EngineConfig {
        environment: Environment {
            os: Os::MacOs,
            idiom: Idiom::Desktop,
            ..Environment::default()
        },
        ..EngineConfig::new(nsh_engine::App::Js(Bundle::source(bundle.code)))
    };
    let engine =
        Engine::start_with(config, || ApproxTextEngine, RootResizeSink(tx), |_| {}).unwrap();
    let next = || rx.recv_timeout(Duration::from_secs(5)).expect("a message");
    // The tools window (the one in the main window) and its view.
    let mut window: Option<NodeId> = None;
    let mut inserted: Vec<(NodeId, NodeId)> = Vec::new();
    while let Ok(sent) = rx.recv_timeout(Duration::from_millis(500)) {
        let RootSent::Batch(batch) = sent else {
            continue;
        };
        for item in batch.items {
            match item {
                MountItem::Command {
                    id,
                    command: Command::Desktop(command),
                } if matches!(&*command, DesktopCommand::OpenWindow(open) if open.options.id == "tools") =>
                {
                    window = Some(id);
                }
                MountItem::Insert { parent, child, .. } => inserted.push((parent, child)),
                _ => {}
            }
        }
    }
    let window = window.expect("the tools window opens");
    let content = inserted
        .iter()
        .find(|(p, _)| *p == window)
        .map(|(_, c)| *c)
        .expect("the tools window's view");

    // The layout at the new size comes first, then the report.
    let size = Size::new(px(640.0), px(480.0));
    engine
        .control()
        .set_root_size(window, size, EdgeInsets::default());
    let RootSent::Batch(batch) = next() else {
        panic!("the layout at the new size first");
    };
    assert!(
        batch.items.iter().any(|i| matches!(
            i,
            MountItem::Frame { id, frame, .. }
                if *id == content && frame.size.width.0 == 640.0 && frame.size.height.0 == 480.0
        )),
        "the window's content takes its size: {:?}",
        batch.items
    );
    assert!(
        matches!(next(), RootSent::RootResized(id, s) if id == window && s == size),
        "then the report"
    );

    // Reported even when nothing changes: the platform waits for it.
    engine
        .control()
        .set_root_size(window, size, EdgeInsets::default());
    assert!(matches!(next(), RootSent::RootResized(id, s) if id == window && s == size));
}

const WINDOW_LATE_DIALOG_APP: &str = r#"import { mount, signal, Text, View } from "nsh";
import { Dialog } from "nsh/base";
import { Window } from "nsh/desktop";

const shown = signal(false);
const asked = signal(false);

mount(() => {
  setTimeout(() => shown.set(true), 50);
  setTimeout(() => asked.set(true), 200);
  return (
    <Window id="main">
    <View>
      <Window id="settings" open={shown()} onOpenChange={(e) => shown.set(e.open)}>
        <View>
          <Text>in window</Text>
          <If when={asked()}>
            <Dialog open onOpenChange={(e) => asked.set(e.open)}>
              <Text>late dialog</Text>
            </Dialog>
          </If>
        </View>
      </Window>
    </View>
    </Window>
  );
});
"#;

/// A dialog that mounts in a window of the app's own once it is open gets
/// its config, which names that window, before its insertion: platforms
/// present a dialog when it is inserted, over the window its config names.
#[test]
fn js_dialogs_mounted_in_an_open_window_name_it_before_they_show() {
    use nsh_core::{Command, NodeId, desktop::DesktopCommand};
    let dir = std::env::temp_dir().join(format!("nsh-window-late-dialog-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let entry = dir.join("App.tsx");
    std::fs::write(&entry, WINDOW_LATE_DIALOG_APP).unwrap();
    let bundle = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
        entry,
        minify: false,
        split: false,
        ui_sets: vec![nsh_base::registry().into()],
        ..Default::default()
    })
    .unwrap();
    let (tx, rx) = crossbeam_channel::unbounded();
    let config = EngineConfig {
        environment: Environment {
            os: Os::MacOs,
            idiom: Idiom::Desktop,
            ..Environment::default()
        },
        ui_sets: vec![nsh_base::registry()],
        ..EngineConfig::new(nsh_engine::App::Js(Bundle::source(bundle.code)))
    };
    let _engine = Engine::start_with(config, || ApproxTextEngine, ChannelSink(tx), |_| {}).unwrap();
    let mut window: Option<NodeId> = None;
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while let Ok(batch) = rx.recv_deadline(deadline) {
        for item in &batch.items {
            if let MountItem::Command {
                id,
                command: Command::Desktop(command),
            } = item
                && matches!(**command, DesktopCommand::OpenWindow(_))
            {
                window = Some(*id);
            }
        }
        let Some(text) = batch.items.iter().find_map(|i| match i {
            MountItem::Text { id, text, .. } if &*text.text == "late dialog" => Some(*id),
            _ => None,
        }) else {
            continue;
        };
        let window = window.expect("the window opens before its dialog");
        // The dialog's root: the modal its text is in.
        let parent_of = |child: NodeId| {
            batch.items.iter().find_map(|i| match i {
                MountItem::Insert {
                    parent, child: c, ..
                } if *c == child => Some(*parent),
                _ => None,
            })
        };
        let modal = batch
            .items
            .iter()
            .find_map(|i| match i {
                MountItem::Create {
                    id,
                    kind: nsh_core::ViewKind::Modal,
                    ..
                } => Some(*id),
                _ => None,
            })
            .expect("the dialog's root");
        let mut node = text;
        while node != modal {
            node = parent_of(node).expect("the text is in the dialog");
        }
        let position = |wanted: &dyn Fn(&MountItem) -> bool| batch.items.iter().position(wanted);
        let config = position(&|i| matches!(i, MountItem::ModalConfig { id, .. } if *id == modal))
            .expect("the dialog's config");
        let inserted =
            position(&|i| matches!(i, MountItem::Insert { child, .. } if *child == modal))
                .expect("the dialog's insertion");
        assert!(config < inserted, "{:?}", batch.items);
        let MountItem::ModalConfig { config, .. } = &batch.items[config] else {
            unreachable!()
        };
        assert_eq!(config.window, window);
        return;
    }
    panic!("the dialog never showed");
}

const MATERIAL_APP: &str = r##"import { mount, View } from "nsh";
import { Window } from "nsh/desktop";

mount(
  () => (
    <Window id="main">
    <View
      macos={{ backdrop: { material: "sidebar", blending: "behindWindow", state: "inactive" } }}
      style={{ backdropFilter: "blur(20px)", glassEffect: "regular", glassTintColor: "#ff0000" }}
    >
      <View macos={{ backdrop: { material: "popover" } }} />
    </View>
    </Window>
  ),
);
"##;

const BACKDROPS_APP: &str = r##"import { mount, View } from "nsh";

mount(() => (
  <View
    windows={{ backdrop: { material: "blur" } }}
    macos={{ backdrop: { blending: "behindWindow" } }}
  />
));
"##;

#[test]
fn windows_props_apply_on_windows_through_the_mount() {
    use nsh_core::{MacOsBackdrop, MacOsBackdropBlending, WindowsBackdrop};
    let backdrops = |os| {
        first_frame_of(BACKDROPS_APP, "windows-props", os, Idiom::Desktop)
            .into_iter()
            .filter_map(|item| match item {
                MountItem::ViewStyle { style, .. } => {
                    Some((style.windows_backdrop, style.macos_backdrop))
                }
                _ => None,
            })
            .filter(|b| *b != (None, None))
            .collect::<Vec<_>>()
    };
    // Each platform takes its own backdrop and ignores the other's.
    assert_eq!(
        backdrops(Os::Windows),
        [(Some(WindowsBackdrop::default()), None)]
    );
    let mut mac = MacOsBackdrop::default();
    mac.blending = MacOsBackdropBlending::BehindWindow;
    assert_eq!(backdrops(Os::MacOs), [(None, Some(mac))]);
    assert!(backdrops(Os::Linux).is_empty());
}

#[test]
fn macos_props_apply_on_macos_through_the_mount() {
    use nsh_core::{
        Color, MacOsBackdrop, MacOsBackdropBlending, MacOsBackdropMaterial, MacOsBackdropState,
    };
    let styles = |os| {
        first_frame_of(MATERIAL_APP, "macos-props", os, Idiom::Desktop)
            .into_iter()
            .filter_map(|item| match item {
                MountItem::ViewStyle { style, .. } => Some(*style),
                _ => None,
            })
            .collect::<Vec<_>>()
    };
    let macos = styles(Os::MacOs);
    let mut backdrop = MacOsBackdrop::default();
    backdrop.material = MacOsBackdropMaterial::Sidebar;
    backdrop.blending = MacOsBackdropBlending::BehindWindow;
    backdrop.state = MacOsBackdropState::Inactive;
    let backdrops = macos
        .iter()
        .filter_map(|style| style.macos_backdrop)
        .collect::<Vec<_>>();
    // The JS values, in the API's camel case, reach the platform.
    assert!(backdrops.contains(&backdrop));
    // Fields left out (blending and state here) keep their defaults.
    assert!(backdrops.contains(&MacOsBackdrop::default()));
    assert_eq!(
        macos.iter().find_map(|style| style.glass_tint_color),
        Some(Color(0xff00_00ff))
    );
    // Another platform ignores `macos={{…}}`; the style itself is the same.
    let linux = styles(Os::Linux);
    assert!(linux.iter().all(|style| style.macos_backdrop.is_none()));
    assert_eq!(
        linux.iter().find_map(|style| style.glass_tint_color),
        Some(Color(0xff00_00ff))
    );
}

const CLASS_PLATFORM_APP: &str = r#"import { mount, View } from "nsh";

mount(() => (
  <View class="ios:bg-[#ff0000] android:bg-[#00ff00] web:bg-[#0000ff]" />
));
"#;

#[test]
fn platform_classes_follow_the_os() {
    use nsh_core::Color;
    let background = |os| {
        first_frame_of(CLASS_PLATFORM_APP, "class-platform", os, Idiom::Phone)
            .into_iter()
            .find_map(|item| match item {
                MountItem::ViewStyle { style, .. } => Some(style.background_color),
                _ => None,
            })
    };
    assert_eq!(background(Os::Ios), Some(Color(0xff00_00ff)));
    assert_eq!(background(Os::Android), Some(Color(0x00ff_00ff)));
    assert_eq!(background(Os::Web), Some(Color(0x0000_ffff)));
}

const SELECT_NAME_APP: &str = r##"import { mount, platform, Text } from "nsh";

let reads = 0;
const once = platform.select({
  get ios() {
    reads += 1;
    return undefined;
  },
  default: "fallback",
});

const exact = platform.select({
  example: "e",
  miniprogram: "mp",
  android: "a",
  ios: "i",
  mobile: "m",
  native: "n",
  default: "d",
});
const osFallback = platform.select({
  example: undefined,
  android: "a",
  ios: "i",
  mobile: "m",
  default: "d",
});
const kindFallback = platform.select({
  web: "w",
  mobile: "m",
  desktop: "d",
  default: "-",
});
const nativeFallback = platform.select({
  web: "w",
  native: "n",
  default: "-",
});

mount(() => (
  <Text>{`${platform.name} ${platform.os} ${exact} ${osFallback} ${kindFallback} ${nativeFallback} ${once}:${reads}`}</Text>
));
"##;

#[test]
fn platform_select_matches_the_platform_name_before_the_os() {
    let dir = std::env::temp_dir().join(format!("nsh-select-name-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let entry = dir.join("App.tsx");
    std::fs::write(&entry, SELECT_NAME_APP).unwrap();
    let bundle = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
        entry,
        minify: false,
        split: false,
        ui_sets: vec![nsh_base::registry().into()],
        ..Default::default()
    })
    .unwrap();
    let run = |environment: Environment| {
        let (tx, rx) = crossbeam_channel::unbounded();
        let config = EngineConfig {
            environment,
            ..EngineConfig::new(nsh_engine::App::Js(Bundle::source(bundle.code.clone())))
        };
        let _engine = Engine::start(config, || ApproxTextEngine, ChannelSink(tx)).unwrap();
        rx.recv_timeout(Duration::from_secs(5))
            .expect("first frame")
            .items
            .into_iter()
            .filter_map(|item| match item {
                MountItem::Text { text, .. } => Some(text.text.to_string()),
                _ => None,
            })
            .collect::<Vec<_>>()
    };
    assert_eq!(
        run(Environment {
            os: Os::Android,
            platform: Some("example"),
            idiom: Idiom::Phone,
            ..Environment::default()
        }),
        vec!["example android e a m n fallback:0"]
    );
    assert_eq!(
        run(Environment {
            os: Os::Ios,
            platform: Some("miniprogram"),
            idiom: Idiom::Phone,
            ..Environment::default()
        }),
        vec!["miniprogram ios mp i m n fallback:1"]
    );
    // Built-in platforms have `name == os`, so the OS key is read once.
    assert_eq!(
        run(Environment {
            os: Os::Ios,
            idiom: Idiom::Phone,
            ..Environment::default()
        }),
        vec!["ios ios i i m n fallback:1"]
    );
}

#[test]
fn size_classes_react_to_resize_and_native_traits_in_js() {
    use nsh_core::platform::SizeClass;
    let dir = std::env::temp_dir().join(format!("nsh-size-classes-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let entry = dir.join("App.tsx");
    std::fs::write(
        &entry,
        r#"
import { mount, Text, horizontalSizeClass, verticalSizeClass } from "nsh";
mount(() => <Text>{`${horizontalSizeClass()} ${verticalSizeClass()}`}</Text>);
"#,
    )
    .unwrap();
    let bundle = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
        entry,
        minify: false,
        split: false,
        ..Default::default()
    })
    .unwrap();
    let (tx, rx) = crossbeam_channel::unbounded();
    let mut environment = Environment {
        window: Size::new(px(390.0), px(844.0)),
        os: Os::Android,
        ..Default::default()
    };
    let config = EngineConfig {
        viewport: environment.window,
        environment,
        ..EngineConfig::new(nsh_engine::App::Js(Bundle::source(bundle.code)))
    };
    let engine = Engine::start(config, || ApproxTextEngine, ChannelSink(tx)).unwrap();
    let read =
        |expected: &str| {
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            while let Ok(batch) = rx.recv_deadline(deadline) {
                if batch.items.iter().any(
                    |item| matches!(item, MountItem::Text { text, .. } if text.text == expected),
                ) {
                    return;
                }
            }
            panic!("no text {expected:?}");
        };
    read("compact regular");
    environment.window = Size::new(px(600.0), px(599.0));
    engine.control().set_environment(environment);
    read("regular compact");
    environment.os = Os::Ios;
    environment.horizontal_size_class = Some(SizeClass::Compact);
    environment.vertical_size_class = Some(SizeClass::Regular);
    engine.control().set_environment(environment);
    read("compact regular");
    environment.horizontal_size_class = None;
    environment.vertical_size_class = None;
    engine.control().set_environment(environment);
    read("regular compact");
}

const RUST_IN_JS_WINDOWS_APP: &str = r#"import { mount, View } from "nsh";
import { Window } from "nsh/desktop";
import { WindowArea } from "test/ui";

mount(() => (
  <Window id="main">
    <View>
      <WindowArea />
      <Window id="left" title="Left"><View><WindowArea /></View></Window>
      <Window id="right" title="Right"><WindowArea /></Window>
    </View>
  </Window>
));
"#;

const RUST_IN_TOP_LEVEL_JS_WINDOWS_APP: &str = r#"import { mount, View } from "nsh";
import { Window } from "nsh/desktop";
import { HidesTitleBar, WindowArea } from "test/ui";

function Content() {
  return <View><HidesTitleBar /><WindowArea /></View>;
}

mount(() => (
  <>
    <Window id="devices" title="Devices">{() => <Content />}</Window>
  </>
));
"#;

/// An app root of windows alone has no main window: a Rust component in one
/// of them, under a JS component, reads and changes that window, and opens
/// no other.
#[test]
fn rust_components_in_top_level_js_windows_open_no_main_window() {
    use nsh_core::desktop::DesktopCommand;
    let (_engine, rx) = crate::components::start_with(
        RUST_IN_TOP_LEVEL_JS_WINDOWS_APP,
        Environment {
            os: Os::MacOs,
            idiom: Idiom::Desktop,
            ..Environment::default()
        },
        None,
        None,
    );
    let mut opened = Vec::new();
    let mut texts = Vec::new();
    for b in crate::components::until(&rx, |b| crate::components::shows(b, "devices 0 0 0")) {
        for item in b.items {
            match item {
                MountItem::Text { text, .. } => texts.push(text.text.to_string()),
                MountItem::Command {
                    command: Command::Desktop(command),
                    ..
                } => {
                    if let DesktopCommand::OpenWindow(open) = *command {
                        opened.push(open.options.id.clone());
                    }
                }
                _ => {}
            }
        }
    }
    assert!(texts.iter().any(|t| t == "hidden in devices"), "{texts:?}");
    assert!(!texts.iter().any(|t| t.starts_with("main ")), "{texts:?}");
    assert_eq!(opened, ["devices"]);
}

/// A Rust component in a window JS opened renders in that window:
/// `current_window()` is it, with its own title bar area, not the main
/// window's (#2937).
#[test]
fn rust_components_in_js_windows_read_their_window() {
    use nsh_core::{
        desktop::{DesktopCommand, WindowEvent},
        geometry::Edges,
    };
    let (engine, rx) = crate::components::start_with(
        RUST_IN_JS_WINDOWS_APP,
        Environment {
            os: Os::MacOs,
            idiom: Idiom::Desktop,
            ..Environment::default()
        },
        None,
        None,
    );
    let mut opened = Vec::new();
    let mut texts = Vec::new();
    let mut take = |batches: Vec<nsh_core::MountBatch>| {
        for b in batches {
            for item in b.items {
                match item {
                    MountItem::Text { text, .. } => texts.push(text.text.to_string()),
                    MountItem::Command {
                        id,
                        command: Command::Desktop(command),
                    } => {
                        if let DesktopCommand::OpenWindow(open) = *command {
                            opened.push((id, open.options.id.clone()));
                        }
                    }
                    _ => {}
                }
            }
        }
    };
    take(crate::components::until(&rx, |b| {
        crate::components::shows(b, "right 0 0 0")
    }));
    assert!(texts.iter().any(|t| t == "left 0 0 0"), "{texts:?}");
    let id_of = |wanted: &str| {
        opened
            .iter()
            .find(|(_, id)| id == wanted)
            .map(|(n, _)| *n)
            .unwrap_or_else(|| panic!("{wanted} opens: {opened:?}"))
    };
    let (left, right) = (id_of("left"), id_of("right"));
    let control = engine.control();
    let report = |id, top: f32, l: f32, r: f32| {
        control.dispatch_event(
            id,
            EventKind::Window,
            EventPayload::Window(Box::new(WindowEvent::TitleBar(Edges {
                top: px(top),
                left: px(l),
                right: px(r),
                ..Default::default()
            }))),
        );
    };
    // Different controls per window: each component follows its own.
    report(left, 28.0, 72.0, 0.0);
    report(right, 32.0, 0.0, 138.0);
    let mut seen = Vec::new();
    for b in crate::components::until(&rx, |b| crate::components::shows(b, "right 32 0 138")) {
        for item in b.items {
            if let MountItem::Text { text, .. } = item {
                seen.push(text.text.to_string());
            }
        }
    }
    assert!(seen.iter().any(|t| t == "left 28 72 0"), "{seen:?}");
    assert!(seen.iter().any(|t| t == "right 32 0 138"), "{seen:?}");
    assert!(!seen.iter().any(|t| t.starts_with("main ")), "{seen:?}");
}

#[test]
fn embedded_host_mounts_into_root_without_opening_os_window() {
    use nsh_core::geometry::Edges;
    let dir = std::env::temp_dir().join(format!("nsh-embedded-host-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let entry = dir.join("App.tsx");
    std::fs::write(
        &entry,
        r#"import { mount, Text } from "nsh";
import { Window, currentWindow, titleBar } from "nsh/desktop";

mount(() => {
  const w = currentWindow();
  const main = Window.get("main");
  return (
    <Text>{`${w.id} ${w.main} ${main?.id === w.id} ${titleBar().height} ${w.titleBar().height}`}</Text>
  );
});
"#,
    )
    .unwrap();
    let bundle = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
        entry,
        minify: false,
        split: false,
        ui_sets: vec![nsh_base::registry().into()],
        ..Default::default()
    })
    .unwrap();
    let (tx, rx) = crossbeam_channel::unbounded();
    let mut config = EngineConfig::new(nsh_engine::App::Js(Bundle::source(bundle.code)));
    config.environment.os = Os::Linux;
    config.environment.idiom = Idiom::Desktop;
    config.environment.title_bar = Edges {
        top: px(36.0),
        ..Default::default()
    };
    config.context = config.context.with(nsh_engine::EmbeddedHost);
    let _engine = Engine::start(config, || ApproxTextEngine, ChannelSink(tx)).unwrap();
    let mut opened = false;
    let mut texts = Vec::new();
    for batch in
        crate::components::until(&rx, |b| crate::components::shows(b, "main true true 36 36"))
    {
        for item in batch.items {
            match item {
                MountItem::Text { text, .. } => texts.push(text.text.to_string()),
                MountItem::Command {
                    command: Command::Desktop(cmd),
                    ..
                } if matches!(*cmd, DesktopCommand::OpenWindow(_)) => {
                    opened = true;
                }
                _ => {}
            }
        }
    }
    assert!(
        !opened,
        "embedded host must not emit OpenWindow for root mount"
    );
    assert!(
        texts.iter().any(|t| t == "main true true 36 36"),
        "{texts:?}"
    );
    let _ = std::fs::remove_dir_all(&dir);

    let dir2 = std::env::temp_dir().join(format!("nsh-embedded-window-{}", std::process::id()));
    std::fs::create_dir_all(&dir2).unwrap();
    let entry2 = dir2.join("App.tsx");
    std::fs::write(&entry2, r#"import { mount, Text, View } from "nsh";
import { Window, currentWindow, titleBar } from "nsh/desktop";

function Main() {
  const w = currentWindow();
  const main = Window.get("main");
  return (
    <Text>{`${w.id} ${w.main} ${main?.id === w.id} ${titleBar().height} ${w.titleBar().height}`}</Text>
  );
}

mount(() => (
  <Window id="main" title="Embedded" closeOnPress={false}>
    <View>
      <Main />
      <Window id="panel" title="Panel">
        <Text>secondary</Text>
      </Window>
    </View>
  </Window>
));
"#).unwrap();
    let bundle2 = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
        entry: entry2,
        minify: false,
        split: false,
        ui_sets: vec![nsh_base::registry().into()],
        ..Default::default()
    })
    .unwrap();
    let (tx2, rx2) = crossbeam_channel::unbounded();

    let mut config2 = EngineConfig::new(nsh_engine::App::Js(Bundle::source(bundle2.code)));
    config2.environment.os = Os::Linux;
    config2.environment.idiom = Idiom::Desktop;
    config2.environment.title_bar = Edges {
        top: px(36.0),
        ..Default::default()
    };
    config2.context = config2.context.with(nsh_engine::EmbeddedHost);
    let _engine2 = Engine::start(config2, || ApproxTextEngine, ChannelSink(tx2)).unwrap();
    let mut opened_ids = Vec::new();
    let mut root_attrs = false;
    let mut texts2 = Vec::new();
    let mut errors = Vec::new();
    for batch in crate::components::until(&rx2, |b| crate::components::shows(b, "secondary")) {
        for item in batch.items {
            match item {
                MountItem::Text { text, .. } => texts2.push(text.text.to_string()),
                MountItem::Command {
                    id,
                    command: Command::Desktop(cmd),
                } => match *cmd {
                    DesktopCommand::OpenWindow(open) => opened_ids.push(open.options.id),
                    DesktopCommand::SetAttributes(attrs)
                        if id == nsh_core::ROOT_ID
                            && attrs.title.as_deref() == Some("Embedded")
                            && attrs.close_on_press == Some(false) =>
                    {
                        root_attrs = true;
                    }
                    _ => {}
                },
                other => errors.push(format!("{other:?}")),
            }
        }
    }
    assert_eq!(
        opened_ids,
        vec!["panel".to_string()],
        "texts={texts2:?} root_attrs={root_attrs} errors={errors:?}"
    );
    assert!(
        root_attrs,
        "embedded <Window id=\"main\"> must forward attributes to ROOT_ID"
    );
    assert!(
        texts2.iter().any(|t| t == "main true true 36 36"),
        "{texts2:?}"
    );
    let _ = std::fs::remove_dir_all(&dir2);
}
