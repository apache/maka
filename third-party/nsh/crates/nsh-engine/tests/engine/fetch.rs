//! `fetch` through the engine: requests reach the platform network on its
//! own threads, responses come back to JS, aborted requests are cancelled.

use std::{
    sync::{Arc, Mutex, mpsc},
    time::Duration,
};

use nsh_core::{ApproxTextEngine, MountBatch, MountItem, Size, geometry::px};
use nsh_engine::{
    Bundle, Engine, EngineConfig, FetchEvent, FetchEvents, FetchTask, HttpBody, HttpHead,
    HttpRequest, MountSink, Network,
};

struct Sink(mpsc::Sender<MountBatch>);

impl MountSink for Sink {
    fn submit(&self, batch: MountBatch) {
        let _ = self.0.send(batch);
    }
}

/// A task that only records its cancellation.
struct Task(Option<Box<dyn FnOnce() + Send>>);

impl FetchTask for Task {
    fn send(&mut self, _: Vec<u8>) {}
    fn finish(&mut self) {}
    fn pause(&mut self, _: bool) {}
    fn cancel(mut self: Box<Self>) {
        if let Some(f) = self.0.take() {
            f();
        }
    }
}

/// Answers `response` with `body` in two chunks, on another thread.
fn answer(mut events: FetchEvents, head: HttpHead, body: Vec<u8>) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(5));
        events(FetchEvent::Head(head));
        let (a, b) = body.split_at(body.len() / 2);
        events(FetchEvent::Data(a.to_vec()));
        events(FetchEvent::Data(b.to_vec()));
        events(FetchEvent::End);
    });
}

/// Answers on a background thread, echoing the request.
#[derive(Default)]
struct EchoNetwork {
    cancelled: Arc<Mutex<Vec<String>>>,
}

impl Network for EchoNetwork {
    fn fetch(&self, request: HttpRequest, events: FetchEvents) -> Box<dyn FetchTask> {
        let url = request.url.clone();
        if url.ends_with("/slow") {
            let cancelled = self.cancelled.clone();
            return Box::new(Task(Some(Box::new(move || {
                cancelled.lock().unwrap().push(url)
            }))));
        }
        let sent = match &request.body {
            HttpBody::Bytes(b) => String::from_utf8_lossy(b).into_owned(),
            _ => String::new(),
        };
        let body = format!("{} {} {sent}", request.method, request.url);
        let head = HttpHead {
            status: 200,
            url: request.url,
            headers: vec![("content-type".into(), "text/plain".into())],
            ..HttpHead::default()
        };
        answer(events, head, body.into_bytes());
        Box::new(Task(None))
    }
}

const APP: &str = r#"
import { mount, signal, Text } from "nsh";
const text = signal("loading");
const slow = new AbortController();
fetch("https://example.com/slow", { signal: slow.signal }).catch((e) => console.log(e.name));
fetch("https://example.com/echo", { method: "PUT", body: "hi" })
  .then((r) => r.text())
  .then((t) => { text.set(t); slow.abort(); });
mount(() => <Text>{text()}</Text>);
"#;

fn texts(batch: &MountBatch) -> Vec<String> {
    batch
        .items
        .iter()
        .filter_map(|i| match i {
            MountItem::Text { text, .. } => Some(text.text.to_string()),
            _ => None,
        })
        .collect()
}

#[test]
fn fetch_round_trips_through_the_platform_network() {
    let dir = std::env::temp_dir().join(format!("nsh-fetch-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let entry = dir.join("App.tsx");
    std::fs::write(&entry, APP).unwrap();
    let bundle = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
        entry,
        minify: false,
        split: false,
        ui_sets: vec![nsh_base::registry().into()],
    })
    .unwrap();
    let network = Arc::new(EchoNetwork::default());
    let cancelled = network.cancelled.clone();
    let (tx, rx) = mpsc::channel();
    let config = EngineConfig {
        // SAFETY: compiled just now by this runtime.
        app: nsh_engine::App::Js(unsafe {
            Bundle::bytecode(nsh_js::compile_bytecode(&bundle.code, false).unwrap())
        }),
        viewport: Size::new(px(320.0), px(480.0)),
        trace: false,
        network: Some(network),
        websocket: None,
        filesystem: None,
        assets: None,
        environment: Default::default(),
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
    let _engine = Engine::start(config, || ApproxTextEngine, Sink(tx)).unwrap();
    assert_eq!(
        texts(&rx.recv_timeout(Duration::from_secs(5)).unwrap()),
        ["loading"]
    );
    assert_eq!(
        texts(&rx.recv_timeout(Duration::from_secs(5)).unwrap()),
        ["PUT https://example.com/echo hi"]
    );
    // The abort reaches the network once the engine pumps it.
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while cancelled.lock().unwrap().is_empty() {
        assert!(
            std::time::Instant::now() < deadline,
            "slow request not cancelled"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(*cancelled.lock().unwrap(), ["https://example.com/slow"]);
}

/// Redirects `/hop/<url>` to `<url>`; answers everything else.
struct RedirectNetwork {
    seen: Arc<Mutex<Vec<String>>>,
}

impl Network for RedirectNetwork {
    fn fetch(&self, request: HttpRequest, events: FetchEvents) -> Box<dyn FetchTask> {
        self.seen.lock().unwrap().push(request.url.clone());
        assert!(
            !request.follow_redirects,
            "the engine follows redirects itself"
        );
        let (head, body) = match request.url.split_once("/hop/") {
            Some((_, to)) => (
                HttpHead {
                    status: 302,
                    url: request.url.clone(),
                    headers: vec![("location".into(), to.into())],
                    ..HttpHead::default()
                },
                b"moved".to_vec(),
            ),
            None => (
                HttpHead {
                    status: 200,
                    url: request.url.clone(),
                    ..HttpHead::default()
                },
                b"ok".to_vec(),
            ),
        };
        answer(events, head, body);
        Box::new(Task(None))
    }
}

const CHECKED_APP: &str = r#"
import { mount, signal, Text } from "nsh";
const text = signal("loading");
const outcome = (p) => p.then((r) => r.text().then((t) => `${t}${r.redirected ? " (redirected)" : ""}`), (e) => e.message);
Promise.all([
  outcome(fetch("https://evil.io/")),
  outcome(fetch("https://api.example.com/hop/https://api.example.com/final")),
  outcome(fetch("https://api.example.com/hop/https://evil.io/steal")),
]).then((r) => text.set(r.join(" | ")));
mount(() => <Text>{text()}</Text>);
"#;

#[test]
fn fetch_stays_within_the_capabilities() {
    let dir = std::env::temp_dir().join(format!("nsh-fetch-caps-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let entry = dir.join("App.tsx");
    std::fs::write(&entry, CHECKED_APP).unwrap();
    let bundle = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
        entry,
        minify: false,
        split: false,
        ui_sets: vec![nsh_base::registry().into()],
    })
    .unwrap();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let (tx, rx) = mpsc::channel();
    let config = EngineConfig {
        // SAFETY: compiled just now by this runtime.
        app: nsh_engine::App::Js(
            unsafe { Bundle::bytecode(nsh_js::compile_bytecode(&bundle.code, false).unwrap()) }
                .with_capabilities_json(Some(r#"{ "network": { "hosts": ["api.example.com"] } }"#))
                .unwrap(),
        ),
        viewport: Size::new(px(320.0), px(480.0)),
        trace: false,
        network: Some(Arc::new(RedirectNetwork { seen: seen.clone() })),
        websocket: None,
        filesystem: None,
        assets: None,
        environment: Default::default(),
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
    let _engine = Engine::start(config, || ApproxTextEngine, Sink(tx)).unwrap();
    assert_eq!(
        texts(&rx.recv_timeout(Duration::from_secs(5)).unwrap()),
        ["loading"]
    );
    let result = texts(&rx.recv_timeout(Duration::from_secs(5)).unwrap()).join("");
    let parts: Vec<&str> = result.split(" | ").collect();
    assert!(
        parts[0].contains("`evil.io` to capabilities.network"),
        "{result}"
    );
    assert_eq!(parts[1], "ok (redirected)");
    assert!(
        parts[2].contains("https://evil.io/steal is not granted"),
        "{result}"
    );
    // evil.io was never contacted.
    assert!(
        seen.lock()
            .unwrap()
            .iter()
            .all(|u| !u.starts_with("https://evil.io"))
    );
}

/// A Rust component whose task fetches: the echo's text shows, and the slow
/// request is cancelled with the task that waited for it.
#[nsh_core::element::component]
fn Fetcher() -> impl nsh_core::element::IntoElement {
    use nsh_core::prelude::*;
    let shown = signal(SharedString::from("loading"));
    spawn(async move {
        let slow = spawn(fetch("https://example.com/slow"));
        let echo = fetch(HttpRequest::new("put", "https://example.com/echo").body("hi")).await;
        slow.cancel();
        shown.set(match echo {
            Ok(response) => format!("{} {}", response.status(), response.text()).into(),
            Err(error) => error.into(),
        });
    });
    text(move || shown.get())
}

#[test]
fn rust_components_fetch_through_the_platform_network() {
    let network = Arc::new(EchoNetwork::default());
    let cancelled = network.cancelled.clone();
    let (tx, rx) = mpsc::channel();
    let config = EngineConfig {
        app: nsh_engine::App::Rust(nsh_core::element::Root::of::<Fetcher>()),
        viewport: Size::new(px(320.0), px(480.0)),
        trace: false,
        network: Some(network),
        websocket: None,
        filesystem: None,
        assets: None,
        environment: Default::default(),
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
    let _engine = Engine::start(config, || ApproxTextEngine, Sink(tx)).unwrap();
    let mut shown = Vec::new();
    while !shown.iter().any(|t: &String| t.starts_with("200")) {
        let batch = rx
            .recv_timeout(Duration::from_secs(5))
            .expect("no response");
        shown.extend(texts(&batch));
    }
    assert_eq!(shown.last().unwrap(), "200 PUT https://example.com/echo hi");
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while cancelled.lock().unwrap().is_empty() {
        assert!(
            std::time::Instant::now() < deadline,
            "slow request not cancelled"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(*cancelled.lock().unwrap(), ["https://example.com/slow"]);
}
