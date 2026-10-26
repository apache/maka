//! `nativeModule`: an app built without knowing the embedding app's set
//! reaches it by name at run time; the host pushes its data to every
//! engine through a callback a task keeps (`subscribe`), and gives each
//! engine its own context, which the set's functions read.

use std::{sync::LazyLock, time::Duration};

use crossbeam_channel::Receiver;
use nsh_core::{ApproxTextEngine, MountBatch, Size, element::Registry, prelude::*};
use nsh_engine::{Bundle, Engine, EngineConfig, EngineContext, Environment};
use tokio::sync::watch;

use crate::{ChannelSink, rust_classes::shown};

/// The host's shared data: what every engine's app sees.
static NOTE: LazyLock<watch::Sender<String>> =
    LazyLock::new(|| watch::Sender::new("first".to_owned()));

/// The embedding app's functions.
#[module]
pub(crate) struct Host;

#[module]
impl Host {
    /// A price, at once.
    pub(crate) fn quote(symbol: String) -> Result<f64, String> {
        match symbol.as_str() {
            "AAPL" => Ok(227.5),
            _ => Err(format!("no quote for {symbol}")),
        }
    }

    /// `n` doubled, later.
    pub(crate) async fn later(n: u32) -> u32 {
        timer(Duration::from_millis(5)).await;
        n * 2
    }

    /// Sets the host's note, which every subscriber hears.
    pub(crate) fn publish(note: String) {
        NOTE.send_replace(note);
    }

    /// Calls `on` with the host's note now and on every change.
    pub(crate) async fn subscribe(on: Callback<String>) {
        let mut notes = NOTE.subscribe();
        loop {
            on.post(notes.borrow_and_update().clone());
            if notes.changed().await.is_err() {
                return;
            }
        }
    }
}

fn registry() -> Registry {
    let mut r = Registry::ui_set("host/test");
    r.module::<Host>();
    r
}

/// The part of the host an engine reaches: its context.
struct Desk(&'static str);

/// Which desk the engine running the call was given, read in each kind
/// of function.
#[module]
pub(crate) struct Whose;

#[module]
impl Whose {
    /// In the JS call.
    pub(crate) fn now() -> String {
        desk()
    }

    /// As an op, in order with the UI.
    pub(crate) fn op(_cx: &mut ModuleCx) -> String {
        desk()
    }

    /// As a task, after it waited.
    pub(crate) async fn later() -> String {
        timer(Duration::from_millis(5)).await;
        desk()
    }
}

fn desk() -> String {
    engine_context::<Desk>().map_or_else(|| "none".to_owned(), |desk| desk.0.to_owned())
}

fn context_registry() -> Registry {
    let mut r = Registry::ui_set("host/context");
    r.module::<Whose>();
    r
}

/// The app, bundled and compiled with no UI set, run by an engine serving
/// `ui_sets` and given `context`.
fn start(
    app: &str,
    ui_sets: Vec<Registry>,
    context: EngineContext,
) -> (Engine, Receiver<MountBatch>) {
    static APPS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let dir = std::env::temp_dir().join(format!(
        "nsh-host-modules-{}-{}",
        std::process::id(),
        APPS.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let entry = dir.join("App.tsx");
    std::fs::write(&entry, app).unwrap();
    let bundle = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
        entry,
        minify: false,
        split: false,
        ui_sets: Vec::new(),
    })
    .unwrap();
    let bytecode = nsh_js::compile_bytecode_with(&bundle.code, false, &[]).unwrap();
    let (tx, rx) = crossbeam_channel::unbounded();
    let config = EngineConfig {
        // SAFETY: compiled just now by this runtime.
        app: nsh_engine::App::Js(unsafe { Bundle::bytecode(bytecode) }),
        viewport: Size::new(px(390.0), px(844.0)),
        trace: false,
        network: None,
        websocket: None,
        filesystem: None,
        assets: None,
        environment: Environment::default(),
        header_heights: (nsh_core::Points(44.0), nsh_core::Points(96.0)),
        limits: nsh_engine::Limits::default(),
        ui_sets,
        runtime: None,
        data_dir: None,
        cache: nsh_engine::CacheOptions::off(),
        storage: None,
        clock: Default::default(),
        context,
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

const CALLS: &str = r#"import { mount, signal, Text } from "nsh";
import { nativeModule } from "nsh";

interface HostApi {
  quote(symbol: string): number;
  later(n: number): Promise<number>;
}
const { Host } = nativeModule<{ Host: HostApi }>("host/test");

const shown = signal("waiting");
setTimeout(async () => {
  const lines = [];
  lines.push(String(Host.quote("AAPL")));
  try { Host.quote("X"); } catch (e) { lines.push(e.message); }
  lines.push(String(await Host.later(21)));
  lines.push(String(nativeModule("host/test") === nativeModule("host/test")));
  try { nativeModule("host/none"); } catch (e) { lines.push(`${e.name}: ${e.message}`); }
  try { nativeModule("nsh/mobile"); } catch (e) { lines.push(e.name); }
  shown.set(`done ${lines.join("|")}`);
}, 0);

mount(() => <Text>{shown()}</Text>);
"#;

#[test]
fn an_app_calls_the_functions_its_host_registered_by_name() {
    let (_engine, rx) = start(CALLS, vec![registry()], EngineContext::default());
    assert_eq!(
        shown(&rx, "done"),
        "done 227.5|no quote for X|42|true|ReferenceError: nativeModule: nothing is registered \
         under \"host/none\"; the embedding app registers its functions as a UI set of that name \
         (`Registry::ui_set(\"host/none\")` in its engines' UI sets)|ReferenceError"
    );
}

const ALONE: &str = r#"import { mount, Text } from "nsh";
import { nativeModule } from "nsh";

let shown = "done";
try { nativeModule("host/test"); } catch (e) { shown = `done ${e.message}`; }

mount(() => <Text>{shown}</Text>);
"#;

#[test]
fn an_app_whose_host_registered_nothing_hears_which_specifier_is_missing() {
    let (_engine, rx) = start(ALONE, Vec::new(), EngineContext::default());
    assert!(
        shown(&rx, "done")
            .starts_with("done nativeModule: nothing is registered under \"host/test\"")
    );
}

const SYNC: &str = r#"import { mount, signal, Text } from "nsh";
import { nativeModule } from "nsh";

interface HostApi {
  publish(note: string): void;
  subscribe(on: (note: string) => void): Promise<void>;
}
const { Host } = nativeModule<{ Host: HostApi }>("host/test");

const note = signal("");
Host.subscribe((n) => note.set(n));
// The first engine publishes; both hear it, as they hear the host's own.
if (globalThis.publisher) setTimeout(() => Host.publish("from A"), 20);

mount(() => <Text>{`note ${note()}`}</Text>);
"#;

#[test]
fn the_host_pushes_its_data_to_every_app_that_subscribed() {
    let (_a, a) = start(
        &SYNC.replace("globalThis.publisher", "true"),
        vec![registry()],
        EngineContext::default(),
    );
    let (_b, b) = start(
        &SYNC.replace("globalThis.publisher", "false"),
        vec![registry()],
        EngineContext::default(),
    );
    assert_eq!(shown(&a, "note from A"), "note from A");
    assert_eq!(shown(&b, "note from A"), "note from A");
    // The host changes it from its own thread.
    std::thread::sleep(Duration::from_millis(20));
    NOTE.send_replace("from the host".to_owned());
    assert_eq!(shown(&a, "note from the host"), "note from the host");
    assert_eq!(shown(&b, "note from the host"), "note from the host");
}

const WHOSE: &str = r#"import { mount, signal, Text } from "nsh";
import { nativeModule } from "nsh";

interface WhoseApi {
  now(): string;
  op(): Promise<string>;
  later(): Promise<string>;
}
const { Whose } = nativeModule<{ Whose: WhoseApi }>("host/context");

const shown = signal("waiting");
setTimeout(async () => {
  shown.set(`done ${Whose.now()} ${await Whose.op()} ${await Whose.later()}`);
}, 0);

mount(() => <Text>{shown()}</Text>);
"#;

#[test]
fn each_engine_s_functions_read_the_context_its_host_gave_it() {
    let (_a, a) = start(
        WHOSE,
        vec![context_registry()],
        EngineContext::default().with(Desk("A")),
    );
    let (_b, b) = start(
        WHOSE,
        vec![context_registry()],
        EngineContext::default().with(Desk("B")),
    );
    let (_none, none) = start(WHOSE, vec![context_registry()], EngineContext::default());
    assert_eq!(shown(&a, "done"), "done A A A");
    assert_eq!(shown(&b, "done"), "done B B B");
    assert_eq!(shown(&none, "done"), "done none none none");
}
