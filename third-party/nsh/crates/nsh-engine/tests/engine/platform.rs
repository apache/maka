//! The OS the platform reports decides `platform` and which platform-only
//! props (`ios={{…}}`, `android={{…}}`, `desktop={{…}}`, `web={{…}}`)
//! apply; on the web, the idiom decides between mobile and desktop.

use std::time::Duration;

use crossbeam_channel::Receiver;
use nsh_core::{ApproxTextEngine, MountBatch, MountItem, Size, geometry::px};
use nsh_engine::{Bundle, Engine, EngineConfig, Environment, Idiom, Os, Renderer};

use crate::ChannelSink;

const APP: &str = r#"import { mount, Text, View } from "nsh";
import { platform } from "nsh";

mount(
  () => (
    <View
      ios={{ accessibilityLabel: "ios" }}
      android={{ accessibilityLabel: "android" }}
      desktop={{ accessibilityLabel: "desktop" }}
      web={{ accessibilityHint: "web" }}
    >
      <Text>{`${platform.os} ${platform.idiom === "desktop"} ${platform.select({ ios: "i", mobile: "m", desktop: "d" })} ${platform.select({ native: "n", default: "-" })}`}</Text>
    </View>
  ),
);
"#;

/// The first frame's texts and accessibility labels and hints on `os`.
fn first_frame(os: Os, idiom: Idiom) -> (Vec<String>, Vec<String>) {
    frame_parts(first_batch(
        Environment {
            os,
            idiom,
            renderer: if os == Os::Web {
                Renderer::Web
            } else {
                Renderer::Native
            },
            ..Environment::default()
        },
        APP,
    ))
}

fn first_batch(environment: Environment, source: &str) -> MountBatch {
    let (_engine, rx) = start(environment, source, Size::new(px(320.0), px(480.0)));
    rx.recv_timeout(Duration::from_secs(5))
        .expect("first frame")
}

fn start(
    environment: Environment,
    source: &str,
    viewport: Size<nsh_core::Points>,
) -> (Engine, Receiver<MountBatch>) {
    static APPS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let Environment {
        os,
        idiom,
        renderer,
        ..
    } = environment;
    let dir = std::env::temp_dir().join(format!(
        "nsh-platform-{}-{}-{idiom:?}-{renderer:?}-{}",
        std::process::id(),
        os.name(),
        APPS.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let entry = dir.join("App.tsx");
    std::fs::write(&entry, source).unwrap();
    let bundle = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
        entry,
        minify: false,
        split: false,
        ui_sets: vec![nsh_base::registry().into()],
    })
    .unwrap();
    let (tx, rx) = crossbeam_channel::unbounded();
    let config = EngineConfig {
        app: nsh_engine::App::Js(Bundle::source(bundle.code)),
        viewport,
        trace: false,
        network: None,
        websocket: None,
        filesystem: None,
        assets: None,
        environment,
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
    };
    (
        Engine::start(config, || ApproxTextEngine, ChannelSink(tx)).unwrap(),
        rx,
    )
}

fn frame_parts(batch: MountBatch) -> (Vec<String>, Vec<String>) {
    let mut texts = Vec::new();
    let mut labels = Vec::new();
    for item in &batch.items {
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
fn pixel_ratio_changes_keep_the_window_size() {
    let app = r#"import { mount, Text } from "nsh";
import { pixelRatio, windowSize } from "nsh";

mount(() => <Text>{`${pixelRatio()} ${windowSize().width}x${windowSize().height}`}</Text>);
"#;
    let viewport = Size::new(px(390.0), px(844.0));
    let mut environment = Environment {
        window: viewport,
        pixel_ratio: 1.0,
        ..Environment::default()
    };
    let (engine, rx) = start(environment, app, viewport);
    let expect_frame = |expected: &str| {
        let batch = rx
            .recv_timeout(Duration::from_secs(5))
            .expect("rendered environment change");
        assert_eq!(frame_parts(batch).0, [expected]);
    };
    expect_frame("1 390x844");
    // Platforms report the whole environment; moving to another screen
    // changes the density, not the window's size in points.
    for (ratio, expected) in [(2.0, "2 390x844"), (1.0, "1 390x844")] {
        environment.pixel_ratio = ratio;
        engine.control().set_environment(environment);
        expect_frame(expected);
    }
}

#[test]
fn terminal_environment_keeps_the_os_and_uses_terminal_interaction() {
    let app = r#"import { mount, Text, View } from "nsh";
import { platform } from "nsh";
import { keymap } from "nsh";
import { Menu, isAvailable } from "nsh/desktop";
Menu.setApplicationMenu([]);
Menu.popup([]);
keymap.bind("mod+k", () => {});
mount(() => <View desktop={{ accessibilityLabel: "desktop" }}>
  <Text>{`${platform.os} ${platform.renderer} ${platform.isTerminal} ${isAvailable} ${keymap.label("mod+k")}`}</Text>
  <Text>{platform.select({ terminal: "terminal", macos: "macos", desktop: "desktop", native: "native" })}</Text>
  <Text>{platform.select({ macos: "macos", native: "native" })}</Text>
  <Text>{platform.select({ mobile: "mobile", desktop: "desktop", default: "default" })}</Text>
</View>);
"#;
    let batch = first_batch(
        Environment {
            os: Os::MacOs,
            idiom: Idiom::Desktop,
            renderer: Renderer::Terminal,
            ..Environment::default()
        },
        app,
    );
    let keymap = batch
        .items
        .iter()
        .find_map(|item| match item {
            MountItem::Keymap(keymap) => Some(keymap),
            _ => None,
        })
        .expect("mounted keymap");
    let control_k = nsh_core::keymap::Keystroke::parse_with("ctrl+k", false).unwrap();
    assert!(keymap.find(control_k, false, false).consumed());
    assert!(batch.items.iter().any(|item| matches!(
        item,
        MountItem::Command {
            command: nsh_core::Command::Desktop(command),
            ..
        } if matches!(**command, nsh_core::desktop::DesktopCommand::SetMenu(_))
    )));
    assert_eq!(
        frame_parts(batch),
        (
            vec![
                "macos terminal true true Ctrl+K".into(),
                "terminal".into(),
                "macos".into(),
                "default".into()
            ],
            Vec::new(),
        )
    );
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
    frame(Os::Ios, Idiom::Phone, "ios false i n", &["ios"]);
    frame(Os::Android, Idiom::Phone, "android false m n", &["android"]);
    frame(Os::MacOs, Idiom::Desktop, "macos true d n", &["desktop"]);
    // `native` is not the web, as in React Native.
    frame(Os::Web, Idiom::Phone, "web false m -", &["web"]);
    frame(Os::Web, Idiom::Pad, "web false m -", &["web"]);
    // A desktop browser behaves as a desktop.
    frame(Os::Web, Idiom::Desktop, "web true d -", &["desktop", "web"]);
}

#[test]
fn graphical_terminal_keyboard_keeps_identity_and_uses_control_shortcuts() {
    let app = r#"import { mount, Text } from "nsh";
import { platform } from "nsh";
import { keymap } from "nsh";
keymap.bind("mod+k", () => {});
mount(() => <Text>{`${platform.os} ${platform.renderer} ${platform.isTerminal} ${keymap.label("mod+k")}`}</Text>);
"#;
    for (terminal_keyboard, shortcut, label) in [(false, "cmd+k", "⌘K"), (true, "ctrl+k", "Ctrl+K")]
    {
        let batch = first_batch(
            Environment {
                os: Os::MacOs,
                renderer: Renderer::Native,
                terminal_keyboard,
                ..Environment::default()
            },
            app,
        );
        let keymap = batch
            .items
            .iter()
            .find_map(|item| match item {
                MountItem::Keymap(keymap) => Some(keymap),
                _ => None,
            })
            .expect("mounted keymap");
        let key = nsh_core::keymap::Keystroke::parse_with(shortcut, false).unwrap();
        assert!(keymap.find(key, false, false).consumed());
        assert_eq!(
            frame_parts(batch).0,
            [format!("macos native false {label}")]
        );
    }
}
