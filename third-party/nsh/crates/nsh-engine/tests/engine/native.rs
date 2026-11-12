//! Registered native components end to end: `nsh/native`'s props reach the
//! platform as JSON, events come back to the handlers, commands go out.

use std::time::Duration;

use crossbeam_channel::Receiver;
use nsh_core::{
    ApproxTextEngine, Command, EventKind, EventPayload, JsonValue, MountBatch, MountItem, Size,
    ViewKind, geometry::px,
};
use nsh_engine::{Bundle, Engine, EngineConfig};
use serde_json::json;

use crate::ChannelSink;

const APP: &str = r#"import { mount, signal, Text, View } from "nsh";
import { nativeComponent } from "nsh";

const Map = nativeComponent<
  { center: { lat: number; lng: number }; zoom?: number; title?: string },
  { regionChange: { zoom: number } }
>("com.example.map", { props: ["center", "zoom", "title"], events: ["regionChange"] });

function App() {
  const zoom = signal(3);
  let map: any;
  return (
    <View>
      <Map
        ref={(n: any) => (map = n)}
        center={{ lat: 1.5, lng: 2 }}
        zoom={zoom()}
        style={{ height: 100 }}
        onRegionChange={(e: { zoom: number }) => {
          zoom.set(e.zoom);
          map?.command("flyTo", { zoom: e.zoom, animated: true });
        }}
      />
      <Text>{`zoom ${zoom()}`}</Text>
    </View>
  );
}

mount(App);
"#;

fn start(app: &str) -> (Engine, Receiver<MountBatch>) {
    start_with(app, None)
}

fn start_with(
    app: &str,
    declared: Option<nsh_core::access::Capabilities>,
) -> (Engine, Receiver<MountBatch>) {
    start_in(app, declared, Default::default())
}

fn start_in(
    app: &str,
    declared: Option<nsh_core::access::Capabilities>,
    environment: nsh_core::platform::Environment,
) -> (Engine, Receiver<MountBatch>) {
    // One directory per app started: the tests run in parallel.
    static STARTED: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let n = STARTED.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("nsh-native-{}-{n}", std::process::id()));
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
    let mut app = Bundle::source(bundle.code);
    app.policy.declared = declared;
    let (tx, rx) = crossbeam_channel::unbounded();
    let config = EngineConfig {
        app: nsh_engine::App::Js(app),
        viewport: Size::new(px(320.0), px(480.0)),
        trace: false,
        content_culling: false,
        network: None,
        websocket: None,
        refuse_connections: None,
        filesystem: None,
        assets: None,
        chunk_loader: None,
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
        speech: None,
        audio: None,
        windows: None,
    };
    (
        Engine::start(config, || ApproxTextEngine, ChannelSink(tx)).unwrap(),
        rx,
    )
}

fn texts(batch: &MountBatch) -> Vec<String> {
    batch
        .items
        .iter()
        .filter_map(|i| match i {
            MountItem::Text { text, .. } => Some(text.text.clone()),
            _ => None,
        })
        .collect()
}

#[test]
fn props_events_and_commands_cross_as_json() {
    cross_as_json(start(APP));
}

fn cross_as_json((engine, rx): (Engine, Receiver<MountBatch>)) {
    let first = rx
        .recv_timeout(Duration::from_secs(5))
        .expect("first frame");
    let id = first
        .items
        .iter()
        .find_map(|i| match i {
            MountItem::Create {
                id,
                kind: ViewKind::Native,
            } => Some(*id),
            _ => None,
        })
        .expect("a native container");
    assert!(first.items.iter().any(
        |i| matches!(i, MountItem::Component { id: c, name } if *c == id && &**name == "com.example.map")
    ));
    let props: Vec<(String, Option<JsonValue>)> = first
        .items
        .iter()
        .filter_map(|i| match i {
            MountItem::ComponentProps { id: c, props } if *c == id => Some(props.clone()),
            _ => None,
        })
        .flatten()
        .map(|(k, v)| (k.to_string(), v))
        .collect();
    assert!(props.contains(&("center".into(), Some(json!({ "lat": 1.5, "lng": 2 })))));
    assert!(props.contains(&("zoom".into(), Some(json!(3)))));
    // Unset props are not sent.
    assert!(!props.iter().any(|(k, _)| k == "title"));
    assert!(texts(&first).contains(&"zoom 3".to_owned()));

    // The component emits; the handler re-renders and calls a command.
    engine.control().dispatch_event(
        id,
        EventKind::NativeEvent,
        EventPayload::Native {
            name: "regionChange".into(),
            data: json!({ "zoom": 7 }),
        },
    );
    let batch = rx.recv_timeout(Duration::from_secs(5)).expect("a batch");
    assert!(texts(&batch).contains(&"zoom 7".to_owned()));
    assert!(batch.items.iter().any(|i| matches!(
        i,
        MountItem::ComponentProps { id: c, props } if *c == id && props == &[("zoom".into(), Some(json!(7)))]
    )));
    assert!(batch.items.iter().any(|i| matches!(
        i,
        MountItem::Command { id: c, command: Command::Native { name, args } }
            if *c == id && &**name == "flyTo" && *args == json!({ "zoom": 7, "animated": true })
    )));
}

const ANIMATED_APP: &str = r#"import { mount, signal, View } from "nsh";
import { createAnimatedValue } from "nsh";
import { nativeComponent } from "nsh";

const Thing = nativeComponent<{ progress?: number }, { mode: { animated: boolean; tick: number } }>(
  "com.example.thing",
  { props: ["progress"], events: ["mode"] },
);

function App() {
  const v = createAnimatedValue(36);
  const animated = signal(true);
  const tick = signal(0);
  return (
    <View>
      <Thing
        progress={(tick(), animated() ? v.interpolate({ inputRange: [0, 72], outputRange: [0, 1] }) : 0.3)}
        style={{ height: 100 }}
        onMode={(e: { animated: boolean; tick: number }) => {
          tick.set(e.tick);
          animated.set(e.animated);
        }}
      />
    </View>
  );
}

mount(App);
"#;

fn native_id(batch: &MountBatch) -> u32 {
    batch
        .items
        .iter()
        .find_map(|i| match i {
            MountItem::Create {
                id,
                kind: ViewKind::Native,
            } => Some(*id),
            _ => None,
        })
        .expect("a native container")
}

fn component_props(batch: &MountBatch, id: u32) -> Vec<(String, Option<JsonValue>)> {
    batch
        .items
        .iter()
        .filter_map(|i| match i {
            MountItem::ComponentProps { id: c, props } if *c == id => Some(props.clone()),
            _ => None,
        })
        .flatten()
        .map(|(k, v)| (k.to_string(), v))
        .collect()
}

fn bound_slots(batch: &MountBatch, id: u32) -> Option<Vec<nsh_core::animation::AnimationProp>> {
    batch.items.iter().rev().find_map(|i| match i {
        MountItem::AnimationBindings { id: c, bindings } if *c == id => {
            Some(bindings.iter().map(|(p, _)| *p).collect())
        }
        _ => None,
    })
}

fn set_mode(engine: &Engine, id: u32, animated: bool, tick: u32) {
    engine.control().dispatch_event(
        id,
        EventKind::NativeEvent,
        EventPayload::Native {
            name: "mode".into(),
            data: json!({ "animated": animated, "tick": tick }),
        },
    );
}

#[test]
fn animated_props_bind_instead_of_crossing_as_json() {
    let (engine, rx) = start(ANIMATED_APP);
    let first = rx
        .recv_timeout(Duration::from_secs(5))
        .expect("first frame");
    let id = native_id(&first);
    assert!(first.items.iter().any(|i| matches!(
        i,
        MountItem::ComponentPropSlots { id: c, names } if *c == id && names.len() == 1 && &*names[0] == "progress"
    )));
    assert_eq!(
        bound_slots(&first, id),
        Some(vec![nsh_core::animation::AnimationProp::ComponentSlot(0)])
    );
    // Never as `{ "__av": n }`.
    assert!(
        component_props(&first, id)
            .iter()
            .all(|(k, _)| k != "progress")
    );

    // A plain number again: sent as JSON, the slot unbound.
    set_mode(&engine, id, false, 1);
    let batch = rx.recv_timeout(Duration::from_secs(5)).expect("a batch");
    assert_eq!(
        component_props(&batch, id),
        vec![("progress".to_owned(), Some(json!(0.3)))]
    );
    assert_eq!(bound_slots(&batch, id), Some(vec![]));
}

#[test]
fn animated_component_prop_survives_rerender() {
    let (engine, rx) = start(ANIMATED_APP);
    let first = rx
        .recv_timeout(Duration::from_secs(5))
        .expect("first frame");
    let id = native_id(&first);
    // The prop is read again; the same interpolation is the same node.
    set_mode(&engine, id, true, 1);
    if let Ok(batch) = rx.recv_timeout(Duration::from_secs(2)) {
        assert!(
            !batch.items.iter().any(|i| matches!(
                i,
                MountItem::AnimationBindings { id: c, .. } | MountItem::ComponentPropSlots { id: c, .. } if *c == id
            )),
            "{:?}",
            batch.items
        );
    }
}

const WEB_INPUT_APP: &str = r#"import { mount, View, WebView } from "nsh";

function App() {
  return (
    <View>
      <WebView
        src="https://example.com/"
        style={{ height: 100 }}
        ref={(page: any) =>
          page &&
          queueMicrotask(() => {
            page.sendInput({ type: "click", x: 12.5, y: 40 });
            page.sendInput({ type: "text", text: "a b!" });
            page.sendInput({ type: "key", key: "Enter" });
            // Not one of its forms: nothing is sent.
            page.sendInput({ type: "key", key: "F13" });
            page.sendInput({ type: "click", x: 1 });
          })
        }
      />
    </View>
  );
}

mount(App);
"#;

/// The web view's id and the input the app sent it, within `wait`.
fn sent_input(
    declared: Option<nsh_core::access::Capabilities>,
    wait: Duration,
) -> (
    nsh_core::NodeId,
    Vec<(nsh_core::NodeId, nsh_core::WebInput)>,
) {
    let (_engine, rx) = start_with(WEB_INPUT_APP, declared);
    let mut web = None;
    let mut sent = Vec::new();
    let deadline = std::time::Instant::now() + wait;
    while sent.len() < 3 && std::time::Instant::now() < deadline {
        let Ok(batch) = rx.recv_timeout(Duration::from_millis(200)) else {
            continue;
        };
        for item in &batch.items {
            match item {
                MountItem::Create {
                    id,
                    kind: ViewKind::WebView,
                } => web = Some(*id),
                MountItem::Command {
                    id,
                    command: Command::SendInput(input),
                } => sent.push((*id, input.clone())),
                _ => {}
            }
        }
    }
    (web.expect("a web view"), sent)
}

#[test]
fn a_web_view_ref_sends_trusted_input_to_its_view() {
    use nsh_core::{WebInput, WebKey, access::Capabilities};
    let declared =
        Capabilities::from_json(&json!({ "webview": { "hosts": ["example.com"], "input": true } }))
            .unwrap();
    let (web, sent) = sent_input(Some(declared), Duration::from_secs(5));
    assert_eq!(
        sent,
        [
            (
                web,
                WebInput::Click {
                    x: nsh_core::Points(12.5),
                    y: nsh_core::Points(40.0)
                }
            ),
            (web, WebInput::Text("a b!".into())),
            (web, WebInput::Key(WebKey::Enter)),
        ]
    );
    // Not declared (also with no declaration at all): the core sends none.
    let hosts =
        Capabilities::from_json(&json!({ "webview": { "hosts": ["example.com"] } })).unwrap();
    for declared in [Some(hosts), None] {
        let (_, sent) = sent_input(declared, Duration::from_secs(1));
        assert_eq!(sent, []);
    }
}

const WEB_INPUT_AVAILABLE_APP: &str = r#"import { mount, signal, Text, WebView } from "nsh";

function App() {
  const available = signal("asking");
  WebView.inputAvailable().then((v: boolean) => available.set(`web input ${v}`));
  return <Text>{available()}</Text>;
}

mount(App);
"#;

/// What `WebView.inputAvailable()` resolves with on a platform that does
/// (`platform`) or does not deliver trusted web input, with the
/// capabilities `declared`.
fn web_input_available(platform: bool, declared: Option<nsh_core::access::Capabilities>) -> String {
    let environment = nsh_core::platform::Environment {
        web_input: platform,
        ..Default::default()
    };
    let (_engine, rx) = start_in(WEB_INPUT_AVAILABLE_APP, declared, environment);
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while std::time::Instant::now() < deadline {
        let Ok(batch) = rx.recv_timeout(Duration::from_millis(200)) else {
            continue;
        };
        if let Some(shown) = texts(&batch)
            .into_iter()
            .find(|t| t.starts_with("web input"))
        {
            return shown;
        }
    }
    panic!("WebView.inputAvailable() did not resolve");
}

#[test]
fn web_view_input_available_needs_the_platform_and_the_grant() {
    use nsh_core::access::Capabilities;
    let granted = || {
        Some(
            Capabilities::from_json(&json!({ "webview": { "hosts": [], "input": true } })).unwrap(),
        )
    };
    assert_eq!(web_input_available(true, granted()), "web input true");
    assert_eq!(web_input_available(false, granted()), "web input false");
    let hosts = Capabilities::from_json(&json!({ "webview": { "hosts": [] } })).unwrap();
    assert_eq!(web_input_available(true, Some(hosts)), "web input false");
    assert_eq!(web_input_available(true, None), "web input false");
}

const WEB_VIEW_AVAILABLE_APP: &str = r#"import { mount, signal, Text, View, WebView } from "nsh";

function App() {
  const available = signal("asking");
  const error = signal("no error");
  WebView.available().then((v: boolean) => available.set(`web views ${v}`));
  return (
    <View>
      <Text>{available()}</Text>
      <Text>{error()}</Text>
      <WebView html="<p>hi</p>" onError={(e) => error.set(`error ${e.code}`)} />
    </View>
  );
}

mount(App);
"#;

/// What the app above shows once `WebView.available()` resolved (and,
/// where web views do not show, its web view's `onError` came), on a
/// platform that does (`platform`) or does not show web views.
fn web_view_available(platform: bool) -> Vec<String> {
    let environment = nsh_core::platform::Environment {
        web_views: platform,
        ..Default::default()
    };
    let (_engine, rx) = start_in(WEB_VIEW_AVAILABLE_APP, None, environment);
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    let mut shown = Vec::new();
    while std::time::Instant::now() < deadline {
        let Ok(batch) = rx.recv_timeout(Duration::from_millis(200)) else {
            continue;
        };
        shown.extend(texts(&batch));
        let answered = shown.iter().any(|t| t.starts_with("web views"));
        if answered && (platform || shown.iter().any(|t| t.starts_with("error"))) {
            return shown;
        }
    }
    panic!("not answered: {shown:?}");
}

#[test]
fn web_views_say_when_the_platform_shows_none() {
    let shown = web_view_available(true);
    assert!(shown.contains(&"web views true".to_owned()), "{shown:?}");
    assert!(!shown.iter().any(|t| t.starts_with("error")), "{shown:?}");
    let shown = web_view_available(false);
    assert!(shown.contains(&"web views false".to_owned()), "{shown:?}");
    assert!(
        shown.contains(&"error ERR_FEATURE_UNAVAILABLE_ON_PLATFORM".to_owned()),
        "{shown:?}"
    );
}

const SHADERS_AVAILABLE_APP: &str = r#"import { mount, shadersAvailable, Text } from "nsh";

function App() {
  return <Text>{`shaders ${shadersAvailable()}`}</Text>;
}

mount(App);
"#;

/// The texts the app above shows within `time`.
fn shown_within(rx: &Receiver<MountBatch>, time: Duration) -> Vec<String> {
    let deadline = std::time::Instant::now() + time;
    let mut shown = Vec::new();
    while let Ok(batch) = rx.recv_deadline(deadline) {
        shown.extend(texts(&batch));
    }
    shown
}

#[test]
fn shaders_are_available_until_the_platform_finds_no_gpu() {
    let (engine, rx) = start_in(SHADERS_AVAILABLE_APP, None, Default::default());
    assert_eq!(
        shown_within(&rx, Duration::from_secs(2)),
        ["shaders true"],
        "the default environment draws shaders"
    );
    let control = engine.control();
    control.shaders_unavailable();
    assert_eq!(shown_within(&rx, Duration::from_secs(2)), ["shaders false"]);
    // Whatever the platform reports later, and however often it says so.
    control.set_environment(nsh_core::platform::Environment {
        color_scheme: nsh_core::platform::ColorScheme::Dark,
        ..Default::default()
    });
    control.shaders_unavailable();
    let later = shown_within(&rx, Duration::from_millis(500));
    assert!(!later.iter().any(|t| t == "shaders true"), "{later:?}");
}

#[test]
fn shaders_are_unavailable_where_the_platform_draws_none() {
    for environment in [
        // Built without a renderer.
        nsh_core::platform::Environment {
            shaders: false,
            ..Default::default()
        },
        // A terminal's Cells.
        nsh_core::platform::Environment {
            cell: Some(Size::new(px(8.0), px(16.0))),
            ..Default::default()
        },
    ] {
        let (_engine, rx) = start_in(SHADERS_AVAILABLE_APP, None, environment);
        assert_eq!(shown_within(&rx, Duration::from_secs(2)), ["shaders false"]);
    }
}

const WEB_LOAD_APP: &str = r#"import { mount, View, WebView } from "nsh";

function App() {
  return (
    <View>
      <WebView
        style={{ height: 100 }}
        ref={(page: any) =>
          page &&
          queueMicrotask(() => {
            page.load({
              src: "https://example.com/signed-in",
              headers: { Authorization: "DPoP token", DPoP: "proof" },
            });
            // A host the capability does not allow: the core sends nothing.
            page.load({ src: "https://elsewhere.test/", headers: { Authorization: "DPoP token" } });
            // Headers that could start another header throw.
            for (const headers of [{ "Bad Name": "x" }, { Authorization: "a\r\nX-Evil: 1" }, { A: 1 }]) {
              try {
                page.load({ src: "https://example.com/", headers });
              } catch (e) {
                if (e instanceof TypeError) page.load({ src: "https://example.com/threw" });
              }
            }
          })
        }
      />
    </View>
  );
}

mount(App);
"#;

#[test]
fn a_web_view_ref_loads_a_page_with_headers() {
    use nsh_core::{WebLoad, access::Capabilities};
    let declared =
        Capabilities::from_json(&json!({ "webview": { "hosts": ["example.com"] } })).unwrap();
    let (_engine, rx) = start_with(WEB_LOAD_APP, Some(declared));
    let mut web = None;
    let mut loads = Vec::new();
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while loads.len() < 4 && std::time::Instant::now() < deadline {
        let Ok(batch) = rx.recv_timeout(Duration::from_millis(200)) else {
            continue;
        };
        for item in &batch.items {
            match item {
                MountItem::Create {
                    id,
                    kind: ViewKind::WebView,
                } => web = Some(*id),
                MountItem::Command {
                    id,
                    command: Command::Load(load),
                } => loads.push((*id, load.clone())),
                _ => {}
            }
        }
    }
    let web = web.expect("a web view");
    let load = |src: &str, headers: &[(&str, &str)]| {
        let headers = headers
            .iter()
            .map(|(n, v)| (n.to_string(), v.to_string()))
            .collect();
        (web, WebLoad::new(src, headers).unwrap())
    };
    assert_eq!(
        loads,
        [
            load(
                "https://example.com/signed-in",
                &[("Authorization", "DPoP token"), ("DPoP", "proof")]
            ),
            load("https://example.com/threw", &[]),
            load("https://example.com/threw", &[]),
            load("https://example.com/threw", &[]),
        ]
    );
    // Its debug form, what logs would show, names the headers only.
    let shown = format!("{:?}", loads[0].1);
    assert!(
        shown.contains("Authorization") && !shown.contains("token"),
        "{shown}"
    );
}
