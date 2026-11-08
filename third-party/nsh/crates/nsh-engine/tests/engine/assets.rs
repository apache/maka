//! The app's bundled files over `fetch`: requests of `asset:/` URLs, from
//! JS and from Rust components' tasks, are answered from the host's assets
//! on the runtime's blocking pool, without the app's network capabilities;
//! a host that serves files it does not hold has them downloaded.

use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use crossbeam_channel::Receiver;
use nsh_core::{
    ApproxTextEngine, MountBatch, MountItem, Size, element::Root, geometry::px, prelude::*,
};
use nsh_engine::{
    App, Assets, Bundle, Engine, EngineConfig, FetchEvent, FetchEvents, FetchTask, HttpHead,
    HttpRequest, Network,
};

use crate::ChannelSink;

fn config(app: App) -> EngineConfig {
    EngineConfig {
        app,
        viewport: Size::new(px(390.0), px(844.0)),
        trace: false,
        network: None,
        refuse_connections: None,
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
        speech: None,
        chunk_loader: None,
        audio: None,
        windows: None,
    }
}

/// The app on `config` with `assets` and `network`, and its batches.
fn start(
    app: App,
    assets: Option<Arc<dyn Assets>>,
    network: Option<Arc<dyn Network>>,
) -> (Engine, Receiver<MountBatch>) {
    let (tx, rx) = crossbeam_channel::unbounded();
    let config = EngineConfig {
        assets,
        network,
        ..config(app)
    };
    let engine = Engine::start(config, || ApproxTextEngine, ChannelSink(tx)).unwrap();
    (engine, rx)
}

/// The texts the batches carry until one is `shown` (or 5 seconds passed).
fn until(rx: &Receiver<MountBatch>, shown: &str) -> Vec<String> {
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut texts = Vec::new();
    while let Ok(batch) = rx.recv_deadline(deadline) {
        for item in &batch.items {
            if let MountItem::Text { text, .. } = item {
                texts.push(text.text.to_string());
            }
        }
        if texts.iter().any(|t| t == shown) {
            break;
        }
    }
    texts
}

/// The files of a crate `app` (`locales/en.json`), recording each read
/// with the thread it was made on.
struct LocaleAssets(Arc<Mutex<Vec<String>>>);

impl Assets for LocaleAssets {
    fn read(&self, uri: &str) -> Result<Vec<u8>, String> {
        let thread = std::thread::current();
        self.0
            .lock()
            .unwrap()
            .push(format!("{uri} on {}", thread.name().unwrap_or("?")));
        match uri {
            "asset:/@app/locales/en.json" => Ok(br#"{"hello":"Hello"}"#.to_vec()),
            _ => Err(format!("{uri} is not bundled")),
        }
    }
}

/// What a request gave, as the apps show it.
async fn shown(request: impl Into<HttpRequest>) -> String {
    match fetch(request).await {
        Ok(response) if response.ok() => format!("read {}", response.text()),
        Ok(response) => format!("HTTP {}", response.status()),
        Err(error) => format!("failed: {error}"),
    }
}

/// Reads a file the app ships, then one it does not.
#[component]
fn ReadFiles() -> impl IntoElement {
    let text_shown = signal(String::from("reading"));
    spawn(async move {
        let found = shown("asset:/@app/locales/en.json").await;
        let missing = shown("asset:/@app/missing.json").await;
        text_shown.set(format!("{found}; {missing}"));
    });
    view().child(text(move || text_shown.get()))
}

fn rust_app() -> App {
    App::Rust(Root::of::<ReadFiles>())
}

#[test]
fn tasks_read_the_files_the_app_ships() {
    let read = Arc::new(Mutex::new(Vec::new()));
    let (_engine, rx) = start(rust_app(), Some(Arc::new(LocaleAssets(read.clone()))), None);
    let expected = r#"read {"hello":"Hello"}; failed: asset:/@app/missing.json is not bundled"#;
    let texts = until(&rx, expected);
    assert_eq!(texts.last().map(String::as_str), Some(expected));
    // Off the engine's thread, on the runtime's blocking pool, with no
    // network stack: bundled files need none.
    assert_eq!(
        *read.lock().unwrap(),
        [
            "asset:/@app/locales/en.json on nsh-tasks",
            "asset:/@app/missing.json on nsh-tasks"
        ]
    );
}

/// Asks for a file and drops the answer at once, then reads another.
#[component]
fn ReadDropped() -> impl IntoElement {
    let text_shown = signal(String::from("reading"));
    spawn(async move {
        drop(fetch("asset:/@app/missing.json"));
        text_shown.set(shown("asset:/@app/locales/en.json").await);
    });
    view().child(text(move || text_shown.get()))
}

#[test]
fn files_nothing_waits_for_are_not_read() {
    let read = Arc::new(Mutex::new(Vec::new()));
    let (_engine, rx) = start(
        App::Rust(Root::of::<ReadDropped>()),
        Some(Arc::new(LocaleAssets(read.clone()))),
        None,
    );
    until(&rx, r#"read {"hello":"Hello"}"#);
    assert_eq!(
        *read.lock().unwrap(),
        ["asset:/@app/locales/en.json on nsh-tasks"]
    );
}

#[test]
fn a_host_without_assets_reads_none() {
    let (_engine, rx) = start(rust_app(), None, None);
    let expected = "failed: this host cannot load assets; failed: this host cannot load assets";
    let texts = until(&rx, expected);
    assert_eq!(texts.last().map(String::as_str), Some(expected));
}

/// Reads `asset:/<path>` as `<dir>/<path>`, joined as it comes (as iOS's
/// reader does: an absolute path replaces the directory), recording each
/// path it is asked for.
struct DirectoryAssets(std::path::PathBuf, Arc<Mutex<Vec<String>>>);

impl Assets for DirectoryAssets {
    fn read(&self, uri: &str) -> Result<Vec<u8>, String> {
        let path = uri.strip_prefix("asset:/").ok_or("not an asset URI")?;
        self.1.lock().unwrap().push(path.to_owned());
        std::fs::read(self.0.join(path)).map_err(|e| e.to_string())
    }
}

/// The file beside the assets directory, by its absolute path.
static OUTSIDE: std::sync::OnceLock<String> = std::sync::OnceLock::new();

/// Reads a file inside the assets, then tries ways out of them.
#[component]
fn ReadOutside() -> impl IntoElement {
    let text_shown = signal(String::from("reading"));
    spawn(async move {
        let mut lines = vec![shown("asset:/inside.txt").await];
        let escapes = [
            "asset:/../outside.txt".to_owned(),
            "asset:/sub/../../outside.txt".to_owned(),
            "asset:/%2E%2e/outside.txt".to_owned(),
            "asset:/..%2Foutside.txt".to_owned(),
            format!("asset://{}", OUTSIDE.get().unwrap()),
        ];
        for uri in escapes {
            lines.push(shown(uri).await);
        }
        text_shown.set(lines.join("; "));
    });
    view().child(text(move || text_shown.get()))
}

#[test]
fn files_outside_the_assets_are_refused() {
    let root = crate::temporary_root().join(format!("nsh-assets-outside-{}", std::process::id()));
    std::fs::create_dir_all(root.join("assets")).unwrap();
    std::fs::write(root.join("assets/inside.txt"), "inside").unwrap();
    let outside = root.join("outside.txt");
    std::fs::write(&outside, "outside").unwrap();
    OUTSIDE.set(outside.to_string_lossy().into_owned()).unwrap();
    let read = Arc::new(Mutex::new(Vec::new()));
    let assets = DirectoryAssets(root.join("assets"), read.clone());
    let (_engine, rx) = start(
        App::Rust(Root::of::<ReadOutside>()),
        Some(Arc::new(assets)),
        None,
    );
    let refused = |uri: &str| {
        format!("failed: {uri}: bundled files are named by a path inside the app's files")
    };
    let expected = [
        "read inside".to_owned(),
        refused("asset:/../outside.txt"),
        refused("asset:/sub/../../outside.txt"),
        refused("asset:/%2E%2e/outside.txt"),
        refused("asset:/..%2Foutside.txt"),
        refused(&format!("asset://{}", outside.display())),
    ]
    .join("; ");
    let texts = until(&rx, &expected);
    assert_eq!(texts.last(), Some(&expected));
    // The host never saw a path out of its directory.
    assert_eq!(*read.lock().unwrap(), ["inside.txt"]);
    std::fs::remove_dir_all(&root).ok();
}

/// Holds no file, and serves each under `https://assets.test/` (as the web
/// page does the files it did not preload), recording the URIs it is asked
/// where it serves.
struct ServedAssets(Arc<Mutex<Vec<String>>>);

impl Assets for ServedAssets {
    fn read(&self, uri: &str) -> Result<Vec<u8>, String> {
        Err(format!("{uri} is not at hand"))
    }

    fn url(&self, uri: &str) -> Option<String> {
        self.0.lock().unwrap().push(uri.to_owned());
        let path = uri.strip_prefix("asset:/")?;
        Some(format!("https://assets.test/{path}"))
    }
}

/// A request that answered at once.
struct Answered;

impl FetchTask for Answered {
    fn send(&mut self, _: Vec<u8>) {}
    fn finish(&mut self) {}
    fn pause(&mut self, _: bool) {}
    fn cancel(self: Box<Self>) {}
}

/// Serves `@app/locales/en.json` in two chunks and 404 for the rest;
/// records the URLs asked for.
struct AssetServer(Arc<Mutex<Vec<String>>>);

impl Network for AssetServer {
    fn fetch(&self, request: HttpRequest, mut events: FetchEvents) -> Box<dyn FetchTask> {
        self.0.lock().unwrap().push(request.url.clone());
        let found = request.url.ends_with("/@app/locales/en.json");
        events(FetchEvent::Head(HttpHead {
            status: if found { 200 } else { 404 },
            url: request.url,
            ..HttpHead::default()
        }));
        if found {
            events(FetchEvent::Data(br#"{"hello":"#.to_vec()));
            events(FetchEvent::Data(br#""Hi"}"#.to_vec()));
        }
        events(FetchEvent::End);
        Box::new(Answered)
    }
}

#[test]
fn files_the_host_does_not_hold_are_downloaded_from_where_it_serves_them() {
    let urls = Arc::new(Mutex::new(Vec::new()));
    let (_engine, rx) = start(
        rust_app(),
        Some(Arc::new(ServedAssets(Default::default()))),
        Some(Arc::new(AssetServer(urls.clone()))),
    );
    // A file the host serves nowhere fails as a missing one does.
    let expected = r#"read {"hello":"Hi"}; failed: asset:/@app/missing.json: HTTP 404"#;
    let texts = until(&rx, expected);
    assert_eq!(texts.last().map(String::as_str), Some(expected));
    assert_eq!(
        *urls.lock().unwrap(),
        [
            "https://assets.test/@app/locales/en.json",
            "https://assets.test/@app/missing.json"
        ]
    );
}

/// Shows the URL and the type a file of the app answers with.
#[component]
fn ReadHead() -> impl IntoElement {
    let text_shown = signal(String::from("reading"));
    spawn(async move {
        let line = match fetch("asset:/@app/locales/en.json").await {
            Ok(response) => format!(
                "{} {}",
                response.head.url,
                response.header("content-type").unwrap_or("none")
            ),
            Err(error) => format!("failed: {error}"),
        };
        text_shown.set(line);
    });
    view().child(text(move || text_shown.get()))
}

#[test]
fn a_file_answers_with_its_url_and_type_however_it_arrives() {
    let expected = "asset:/@app/locales/en.json application/json";
    // Read from the host's files.
    let (_engine, rx) = start(
        App::Rust(Root::of::<ReadHead>()),
        Some(Arc::new(LocaleAssets(Default::default()))),
        None,
    );
    assert_eq!(
        until(&rx, expected).last().map(String::as_str),
        Some(expected)
    );
    // Downloaded from where the host serves it, by a server that names no
    // type: still its `asset:/` URL and its type.
    let (_engine, rx) = start(
        App::Rust(Root::of::<ReadHead>()),
        Some(Arc::new(ServedAssets(Default::default()))),
        Some(Arc::new(AssetServer(Default::default()))),
    );
    assert_eq!(
        until(&rx, expected).last().map(String::as_str),
        Some(expected)
    );
}

/// Asks for one file by URLs that spell its scheme in other cases and add a
/// query or a fragment, showing the URL, the type and the text each answers
/// with.
#[component]
fn ReadSpellings() -> impl IntoElement {
    let text_shown = signal(String::from("reading"));
    spawn(async move {
        let mut lines = Vec::new();
        for uri in [
            "ASSET:/@app/locales/en.json",
            "asset:/@app/locales/en.json?v=2#top",
            "Asset:/@app/locales/en.json#top",
        ] {
            lines.push(match fetch(uri).await {
                Ok(response) => format!(
                    "{} {} {}",
                    response.head.url,
                    response.header("content-type").unwrap_or("none"),
                    response.text()
                ),
                Err(error) => format!("failed: {error}"),
            });
        }
        text_shown.set(lines.join("; "));
    });
    view().child(text(move || text_shown.get()))
}

/// What [`ReadSpellings`] shows when the file holds `text`.
fn spellings_read(text: &str) -> String {
    [
        format!("asset:/@app/locales/en.json application/json {text}"),
        format!("asset:/@app/locales/en.json?v=2 application/json {text}"),
        format!("asset:/@app/locales/en.json application/json {text}"),
    ]
    .join("; ")
}

#[test]
fn urls_name_one_file_whatever_their_scheme_case_query_or_fragment() {
    // Read from the host's files: it is asked for the file by its path
    // alone, as every host reads it, and the response answers at the URL
    // asked for without its fragment, the scheme in lower case.
    let read = Arc::new(Mutex::new(Vec::new()));
    let (_engine, rx) = start(
        App::Rust(Root::of::<ReadSpellings>()),
        Some(Arc::new(LocaleAssets(read.clone()))),
        None,
    );
    let expected = spellings_read(r#"{"hello":"Hello"}"#);
    assert_eq!(until(&rx, &expected).last(), Some(&expected));
    assert_eq!(
        *read.lock().unwrap(),
        ["asset:/@app/locales/en.json on nsh-tasks"; 3]
    );
    // Downloaded from where the host serves it: the same file, the same
    // answers.
    let (looked_up, urls) = (
        Arc::new(Mutex::new(Vec::new())),
        Arc::new(Mutex::new(Vec::new())),
    );
    let (_engine, rx) = start(
        App::Rust(Root::of::<ReadSpellings>()),
        Some(Arc::new(ServedAssets(looked_up.clone()))),
        Some(Arc::new(AssetServer(urls.clone()))),
    );
    let expected = spellings_read(r#"{"hello":"Hi"}"#);
    assert_eq!(until(&rx, &expected).last(), Some(&expected));
    assert_eq!(
        *looked_up.lock().unwrap(),
        ["asset:/@app/locales/en.json"; 3]
    );
    assert_eq!(
        *urls.lock().unwrap(),
        ["https://assets.test/@app/locales/en.json"; 3]
    );
}

/// Asks a host that serves its files for one outside them and for one by
/// another method than GET, then for one it serves.
#[component]
fn ReadRefused() -> impl IntoElement {
    let text_shown = signal(String::from("reading"));
    spawn(async move {
        let lines = [
            shown("asset:/../outside.txt").await,
            shown(HttpRequest::new("POST", "asset:/@app/locales/en.json")).await,
            shown("asset:/@app/locales/en.json").await,
        ];
        text_shown.set(lines.join("; "));
    });
    view().child(text(move || text_shown.get()))
}

#[test]
fn refused_files_are_neither_looked_up_nor_downloaded() {
    let looked_up = Arc::new(Mutex::new(Vec::new()));
    let urls = Arc::new(Mutex::new(Vec::new()));
    let (_engine, rx) = start(
        App::Rust(Root::of::<ReadRefused>()),
        Some(Arc::new(ServedAssets(looked_up.clone()))),
        Some(Arc::new(AssetServer(urls.clone()))),
    );
    let expected = [
        "failed: asset:/../outside.txt: bundled files are named by a path inside the app's files",
        "failed: POST asset:/@app/locales/en.json: bundled files are read with GET",
        r#"read {"hello":"Hi"}"#,
    ]
    .join("; ");
    let texts = until(&rx, &expected);
    assert_eq!(texts.last(), Some(&expected));
    // Only the file it may have: the refused ones never reached the host's
    // URLs or the network.
    assert_eq!(*looked_up.lock().unwrap(), ["asset:/@app/locales/en.json"]);
    assert_eq!(
        *urls.lock().unwrap(),
        ["https://assets.test/@app/locales/en.json"]
    );
}

const JS_APP: &str = r#"
import { mount, signal, Text } from "nsh";
const shown = signal("reading");
const read = (url) =>
  fetch(url).then(
    async (r) =>
      `${r.status} ${r.headers.get("content-length")} ${r.headers.get("content-type")} ${r.url} ${await r.text()}`,
    (e) => `${e.name}: ${e.message}`,
  );
Promise.all([
  read("asset:/@app/locales/en.json"),
  read("Asset:/@app/locales/en.json?v=2#top"),
  read("asset:/@app/missing.json"),
]).then((lines) => shown.set(lines.join("; ")));
mount(() => <Text>{shown()}</Text>);
"#;

#[test]
fn js_reads_the_files_the_app_ships_with_fetch() {
    let dir = crate::temporary_root().join(format!("nsh-assets-fetch-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let entry = dir.join("App.tsx");
    std::fs::write(&entry, JS_APP).unwrap();
    let bundle = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
        entry,
        minify: false,
        split: false,
        ui_sets: vec![nsh_base::registry().into()],
    })
    .unwrap();
    // SAFETY: compiled just now by this runtime.
    let app = App::Js(unsafe {
        Bundle::bytecode(nsh_js::compile_bytecode(&bundle.code, false).unwrap())
    });
    let read = Arc::new(Mutex::new(Vec::new()));
    let (_engine, rx) = start(app, Some(Arc::new(LocaleAssets(read.clone()))), None);
    let expected = concat!(
        r#"200 17 application/json asset:/@app/locales/en.json {"hello":"Hello"}; "#,
        r#"200 17 application/json asset:/@app/locales/en.json?v=2 {"hello":"Hello"}; "#,
        "TypeError: Network request failed: asset:/@app/missing.json is not bundled"
    );
    let texts = until(&rx, expected);
    assert_eq!(texts.last().map(String::as_str), Some(expected));
    let read = read.lock().unwrap();
    assert_eq!(read.len(), 3);
    assert_eq!(
        read.iter()
            .filter(|r| r.starts_with("asset:/@app/locales/en.json on "))
            .count(),
        2
    );
}
