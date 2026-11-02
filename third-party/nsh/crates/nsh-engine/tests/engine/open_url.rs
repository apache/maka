//! `openUrl` of `nsh/device`: the platform opens what the embedding app's
//! URL handler does not take, what the handler takes never reaches the
//! platform, and refused URLs and capabilities reject; a `TextView` with
//! `links="open"` opens its links, and a `Link` its `href`.

use std::time::Duration;

use crossbeam_channel::Receiver;
use nsh_core::{
    ApproxTextEngine, Command, EventKind, EventPayload, MountBatch, MountItem, PayloadValue,
    ROOT_ID, Size, geometry::px,
};
use nsh_engine::{Bundle, Capabilities, Engine, EngineConfig, HostChannel};

use crate::ChannelSink;

fn bundle(app: &str) -> Bundle {
    static APPS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let dir = crate::temporary_root().join(format!(
        "nsh-open-url-{}-{}",
        std::process::id(),
        APPS.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let entry = dir.join("App.tsx");
    std::fs::write(&entry, app).unwrap();
    let ui_sets = [nsh_base::registry()];
    let bundle = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
        entry,
        minify: false,
        split: false,
        ui_sets: ui_sets.iter().map(Into::into).collect(),
    })
    .unwrap();
    let bytecode = nsh_js::compile_bytecode_with(
        &bundle.code,
        false,
        &ui_sets.iter().map(Into::into).collect::<Vec<_>>(),
    )
    .unwrap();
    // SAFETY: compiled just now by this runtime.
    unsafe { Bundle::bytecode(bytecode) }
}

fn start(bundle: Bundle, host: &HostChannel) -> (Engine, Receiver<MountBatch>) {
    let (tx, rx) = crossbeam_channel::unbounded();
    let config = EngineConfig {
        viewport: Size::new(px(400.0), px(600.0)),
        host: host.clone(),
        ui_sets: vec![nsh_base::registry()],
        ..EngineConfig::new(bundle)
    };
    (
        Engine::start(config, || ApproxTextEngine, ChannelSink(tx)).unwrap(),
        rx,
    )
}

/// Plays the platform until a shown text contains every one of `parts`:
/// each URL it is asked to open is recorded and answered with `opened`.
/// Returns the text and the URLs.
fn run(
    engine: &Engine,
    rx: &Receiver<MountBatch>,
    opened: bool,
    parts: &[&str],
) -> (String, Vec<String>) {
    let mut last = String::new();
    let mut urls = Vec::new();
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while std::time::Instant::now() < deadline {
        let Ok(batch) = rx.recv_timeout(Duration::from_millis(100)) else {
            continue;
        };
        for item in batch.items {
            match item {
                MountItem::Text { text, .. } => last = text.text.to_string(),
                MountItem::Command {
                    id,
                    command: Command::OpenUrl { id: request, url },
                } => {
                    assert_eq!(id, ROOT_ID);
                    urls.push(url);
                    engine.control().dispatch_event(
                        ROOT_ID,
                        EventKind::OpenUrl,
                        EventPayload::Map(vec![
                            ("id", PayloadValue::Number(f64::from(request))),
                            ("opened", PayloadValue::Bool(opened)),
                        ]),
                    );
                }
                _ => {}
            }
        }
        if parts.iter().all(|p| last.contains(p)) {
            return (last, urls);
        }
    }
    panic!("no text with {parts:?}; last: {last}");
}

const APP: &str = r#"import { mount, signal, Text } from "nsh";
import { openUrl } from "nsh";

const log = signal<string[]>([]);
const say = (s: string) => log.set([...log(), s]);

openUrl("https://example.com/a?b=1").then(({ opened }) => say(`web ${opened}`));
openUrl("mailto:ada@example.com").then(({ opened }) => say(`mail ${opened}`));
for (const url of ["javascript:alert(1)", "example.com", "file:///etc/passwd"]) {
  openUrl(url).catch((e: Error) => say(`refused ${e.name}`));
}

mount(() => <Text>{log().join(" | ")}</Text>);
"#;

#[test]
fn the_platform_opens_urls() {
    let (engine, rx) = start(bundle(APP), &HostChannel::new());
    let (text, urls) = run(&engine, &rx, true, &["web true", "mail true"]);
    assert_eq!(text.matches("refused TypeError").count(), 3, "{text}");
    assert_eq!(
        urls,
        ["https://example.com/a?b=1", "mailto:ada@example.com"]
    );
    drop(engine);

    // No app for the scheme: false.
    let (engine, rx) = start(bundle(APP), &HostChannel::new());
    run(&engine, &rx, false, &["web false", "mail false"]);
    drop(engine);
}

#[test]
fn the_embedding_app_takes_urls_first() {
    let host = HostChannel::new();
    let (seen_tx, seen) = crossbeam_channel::unbounded();
    host.handle_open_url(move |request| {
        let _ = seen_tx.send(request.url().to_owned());
        // The host's router takes web pages and leaves the rest (answered
        // from another thread, or dropped) to the system.
        if request.url().starts_with("https:") {
            std::thread::spawn(move || request.handled());
        } else {
            drop(request);
        }
    });
    let (engine, rx) = start(bundle(APP), &host);
    let (_, urls) = run(&engine, &rx, true, &["web true", "mail true"]);
    assert_eq!(urls, ["mailto:ada@example.com"]);
    let seen: Vec<String> = seen.try_iter().collect();
    assert_eq!(
        seen,
        ["https://example.com/a?b=1", "mailto:ada@example.com"]
    );
    drop(engine);

    // Without the handler, the system opens both.
    host.remove_open_url_handler();
    let (engine, rx) = start(bundle(APP), &host);
    let (_, urls) = run(&engine, &rx, true, &["web true", "mail true"]);
    assert_eq!(urls.len(), 2);
    drop(engine);
}

const LINKS: &str = r#"import { mount, signal, Text, View } from "nsh";
import { TextView } from "nsh/base";

const pressed = signal<string[]>([]);
mount(() => (
  <View>
    <TextView
      markdown="See [the docs](https://example.com/docs) or [the top](#top)."
      links="open"
      onLinkPress={({ url }) => pressed.set([...pressed(), url])}
    />
    <Text>{`pressed ${pressed().join(" ")}`}</Text>
  </View>
));
"#;

#[test]
fn a_text_view_opens_its_links_when_asked() {
    let (engine, rx) = start(bundle(LINKS), &HostChannel::new());
    // The links of the paragraph's text, as the platform presses them.
    let mut links = Vec::new();
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while links.len() < 2 && std::time::Instant::now() < deadline {
        if let Ok(batch) = rx.recv_timeout(Duration::from_millis(100)) {
            for item in batch.items {
                if let MountItem::Text { text, .. } = item
                    && text.links.len() == 2
                {
                    links = text.links.iter().map(|l| l.node).collect();
                }
            }
        }
    }
    assert_eq!(links.len(), 2, "no text with two links");
    for link in links {
        engine
            .control()
            .dispatch_event(link, EventKind::Press, EventPayload::None);
    }
    // The page opens; the anchor is only reported.
    let (_, urls) = run(
        &engine,
        &rx,
        true,
        &["pressed https://example.com/docs #top"],
    );
    assert_eq!(urls, ["https://example.com/docs"]);
    drop(engine);
}

const LINK: &str = r#"import { mount, signal, Text, View } from "nsh";
import { Link } from "nsh/base";

const log = signal<string[]>([]);
const say = (s: string) => log.set([...log(), s]);
mount(() => (
  <View>
    <Link testID="docs" href="https://example.com/docs" onOpen={({ href }) => say(`open ${href}`)} onPress={() => say("press")}>
      <Text>Docs</Text>
    </Link>
    <Link testID="order" href="/orders/42" openWith="app" accessibilityLabel="Order 42" onOpen={({ href }) => say(`route ${href}`)}>
      <Text>#42</Text>
    </Link>
    <Link testID="home" current disabled href="https://example.com" class="disabled:opacity-50">
      <Text>Home</Text>
    </Link>
    <Text>{`log ${log().join(" | ")}`}</Text>
  </View>
));
"#;

/// `nsh/base`'s `Link` through its JS face: the link role, its label and
/// the current page for screen readers, no style of its own; a press opens
/// a site through the system after `onOpen`, and `openWith="app"` leaves
/// the opening to the app.
#[test]
fn a_link_opens_its_href_through_the_system_or_the_app() {
    use nsh_core::{AccessibilityCurrent, AccessibilityRole, ViewProps};
    let (engine, rx) = start(bundle(LINK), &HostChannel::new());
    let first = rx
        .recv_timeout(Duration::from_secs(5))
        .expect("first frame");
    let props = |test_id: &str| -> (u32, ViewProps) {
        first
            .items
            .iter()
            .find_map(|i| match i {
                MountItem::ViewProps { id, props } if props.test_id.as_deref() == Some(test_id) => {
                    Some((*id, (**props).clone()))
                }
                _ => None,
            })
            .expect(test_id)
    };
    let (docs, docs_props) = props("docs");
    let (order, order_props) = props("order");
    let (home, home_props) = props("home");
    for p in [&docs_props, &order_props, &home_props] {
        assert_eq!(p.accessibility.role, AccessibilityRole::Link);
    }
    assert_eq!(order_props.accessibility.label.as_deref(), Some("Order 42"));
    assert_eq!(docs_props.accessibility.state.current, None);
    assert_eq!(
        home_props.accessibility.state.current,
        Some(AccessibilityCurrent::Page)
    );
    assert!(home_props.accessibility.state.disabled);
    // No look of its own: only the app's `disabled:` class styles a link.
    for id in [docs, order] {
        assert!(
            !first
                .items
                .iter()
                .any(|i| matches!(i, MountItem::ViewStyle { id: v, .. } if *v == id)),
            "no style of its own"
        );
    }
    // A disabled link takes no presses.
    assert!(!first.items.iter().any(|i| matches!(
        i,
        MountItem::Events { id, events } if *id == home && events.contains(EventKind::Press)
    )));

    engine
        .control()
        .dispatch_event(docs, EventKind::Press, EventPayload::None);
    let (_, urls) = run(
        &engine,
        &rx,
        true,
        &["open https://example.com/docs | press"],
    );
    assert_eq!(urls, ["https://example.com/docs"]);
    engine
        .control()
        .dispatch_event(order, EventKind::Press, EventPayload::None);
    let (_, urls) = run(&engine, &rx, true, &["route /orders/42"]);
    assert!(urls.is_empty(), "the app routes it: {urls:?}");
    drop(engine);
}

const GUARDED: &str = r#"import { mount, signal, Text } from "nsh";
import { openUrl } from "nsh";

const log = signal("start");
openUrl("https://example.com").catch((e: Error & { code?: string; permission?: string; resource?: string }) =>
  log.set(`denied ${e.name} ${e.code} ${e.permission} ${e.resource} ${e.message}`),
);
mount(() => <Text>{log()}</Text>);
"#;

#[test]
fn opening_urls_is_a_capability() {
    let mut app = bundle(GUARDED);
    app.policy.declared = Some(
        Capabilities::from_json(&serde_json::json!({ "network": { "hosts": ["*"] } })).unwrap(),
    );
    let (engine, rx) = start(app, &HostChannel::new());
    let (text, urls) = run(
        &engine,
        &rx,
        true,
        &["denied Error ERR_ACCESS_DENIED openUrl https://example.com "],
    );
    assert!(text.contains("\"openUrl\": true"), "{text}");
    assert!(urls.is_empty());
    drop(engine);

    let mut app = bundle(GUARDED);
    app.policy.declared =
        Some(Capabilities::from_json(&serde_json::json!({ "openUrl": true })).unwrap());
    let (engine, rx) = start(app, &HostChannel::new());
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    let mut urls = Vec::new();
    while urls.is_empty() && std::time::Instant::now() < deadline {
        if let Ok(batch) = rx.recv_timeout(Duration::from_millis(100)) {
            for item in batch.items {
                if let MountItem::Command {
                    command: Command::OpenUrl { url, .. },
                    ..
                } = item
                {
                    urls.push(url);
                }
            }
        }
    }
    assert_eq!(urls, ["https://example.com"]);
    drop(engine);
}
