//! `UrlScheme` of `nsh` from JS: the links the platform reports reach the
//! `open` listener, those that came before it first, and only those of the
//! schemes the app claims; `url()` follows the core's address.

use std::time::Duration;

use nsh_core::{
    ApproxTextEngine, EventKind, EventPayload, MountItem, PayloadValue, ROOT_ID, Size, geometry::px,
};
use nsh_engine::{Bundle, Engine, EngineConfig, EngineControl};

use crate::ChannelSink;

/// Listens only after a while, so the links reported at the start wait for
/// it, as the one that launches an app does; says `done` later still.
const APP: &str = r#"
import { mount, UrlScheme, signal, Text } from "nsh";
function App() {
  const said = signal("");
  setTimeout(() => {
    UrlScheme.on("open", ({ url }) => said.set(`${said()} ${url}`));
  }, 200);
  setTimeout(() => said.set(`${said()} done`), 1000);
  return <Text>{`links:${said()}`}</Text>;
}
mount(App);
"#;

/// Reads `url()` at the start (the launch link, which reached the core
/// before the app's code ran), after a `setUrl` and after an address the
/// platform gives with no `open` (`quiet`).
const ADDRESS_APP: &str = r#"
import { mount, UrlScheme, signal, Text } from "nsh";
function App() {
  const said = signal("");
  const note = (s: string) => said.set(`${said()} ${s}`);
  note(`start:${UrlScheme.url()}`);
  UrlScheme.on("open", ({ url }) => note(`open:${url}`));
  setTimeout(() => note(`link:${UrlScheme.url()}`), 300);
  setTimeout(() => {
    UrlScheme.setUrl("myapp://set");
    note(`set:${UrlScheme.url()}`);
  }, 500);
  setTimeout(() => note(`later:${UrlScheme.url()}`), 800);
  setTimeout(() => note(`quiet:${UrlScheme.url()}`), 1200);
  setTimeout(() => note("done"), 1500);
  return <Text>{`url:${said()}`}</Text>;
}
mount(App);
"#;

fn bundle() -> Bundle {
    bundle_of(APP, "nsh-deep-links")
}

fn bundle_of(app: &str, name: &str) -> Bundle {
    let dir = crate::temporary_root().join(format!("{name}-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let entry = dir.join("App.tsx");
    std::fs::write(&entry, app).unwrap();
    let ui_sets = [nsh_base::registry()];
    let bundle = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
        entry,
        minify: false,
        split: false,
        ui_sets: ui_sets.iter().map(Into::into).collect(),
        ..Default::default()
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

fn open(control: &EngineControl, url: &str) {
    control.dispatch_event(
        ROOT_ID,
        EventKind::UrlScheme,
        EventPayload::Map(vec![(
            nsh_core::url_scheme::URL,
            PayloadValue::Str(url.into()),
        )]),
    );
}

/// Runs the app claiming `schemes`, reporting `launch` at once and `later`
/// once the app heard something; the text once it says `done`.
fn run(schemes: &[&str], launch: &[String], later: &str) -> String {
    run_app(bundle(), schemes, launch, |control| open(control, later))
}

fn run_app(
    bundle: Bundle,
    schemes: &[&str],
    launch: &[String],
    later: impl Fn(&EngineControl),
) -> String {
    run_app_with(
        bundle,
        schemes,
        |control| {
            for url in launch {
                open(control, url);
            }
        },
        later,
    )
}

/// [`run_app`] with what the platform sends before the engine starts.
fn run_app_with(
    bundle: Bundle,
    schemes: &[&str],
    setup: impl FnOnce(&EngineControl),
    later: impl Fn(&EngineControl),
) -> String {
    let config = EngineConfig {
        viewport: Size::new(px(400.0), px(600.0)),
        ui_sets: vec![nsh_base::registry()],
        ..EngineConfig::new(bundle.with_url_schemes(schemes.iter().copied()))
    };
    let (tx, rx) = crossbeam_channel::unbounded();
    // The launch links before the engine starts, as a platform sends the
    // link it was launched with.
    let engine = Engine::start_with(config, || ApproxTextEngine, ChannelSink(tx), setup).unwrap();
    let control = engine.control();
    let mut text = String::new();
    let mut sent_later = false;
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while std::time::Instant::now() < deadline {
        let Ok(batch) = rx.recv_timeout(Duration::from_millis(50)) else {
            continue;
        };
        for item in batch.items {
            if let MountItem::Text { text: t, .. } = item {
                text = t.text.to_string();
            }
        }
        if !sent_later && (text.starts_with("links: ") || text.contains("later:")) {
            sent_later = true;
            later(&control);
        }
        if text.contains("done") {
            return text;
        }
    }
    panic!("the app did not finish; last: {text}");
}

#[test]
fn links_of_the_apps_schemes_reach_the_listener_in_order() {
    let launch = [
        "myapp://launch?ref=mail".to_owned(),
        "other://x".to_owned(),
        "https://example.com".to_owned(),
        "MyApp://Second".to_owned(),
    ];
    let text = run(&["myapp"], &launch, "myapp://later");
    assert_eq!(
        text,
        "links: myapp://launch?ref=mail MyApp://Second myapp://later done"
    );
}

#[test]
fn links_wait_for_the_listener_sixteen_at_most() {
    let launch: Vec<String> = (0..20).map(|i| format!("myapp://{i}")).collect();
    let text = run(&["myapp"], &launch, "myapp://later");
    let heard: Vec<String> = (4..20).map(|i| format!("myapp://{i}")).collect();
    assert_eq!(
        text,
        format!("links: {} myapp://later done", heard.join(" "))
    );
}

#[test]
fn an_app_that_claims_no_scheme_hears_no_link() {
    let text = run(&[], &["myapp://launch".to_owned()], "myapp://later");
    assert_eq!(text, "links: done");
}

#[test]
fn url_follows_the_cores_address_and_reads_back_what_set_url_set() {
    // `quiet`: an address with no `open` (the page's on the web).
    let quiet = |control: &EngineControl| {
        control.dispatch_event(
            ROOT_ID,
            EventKind::UrlScheme,
            EventPayload::Map(vec![
                (
                    nsh_core::url_scheme::URL,
                    PayloadValue::Str("myapp://quiet".into()),
                ),
                ("quiet", PayloadValue::Bool(true)),
            ]),
        );
    };
    let text = run_app(
        bundle_of(ADDRESS_APP, "nsh-app-url"),
        &["myapp"],
        &["myapp://launch".to_owned()],
        quiet,
    );
    // `url()` reads the core's address: the launch link from the first
    // call; `setUrl` reads back at once; a quiet address opens nothing.
    assert!(
        text.starts_with(
            "url: start:myapp://launch open:myapp://launch link:myapp://launch set:myapp://set later:myapp://set quiet:myapp://quiet done"
        ),
        "{text}"
    );
}

/// Reads `url()` for the first time only later, in a timer, after a link
/// came while the app ran.
const LATE_APP: &str = r#"
import { mount, UrlScheme, signal, Text } from "nsh";
function App() {
  const said = signal("");
  setTimeout(() => said.set(`late:${UrlScheme.url()}`), 600);
  setTimeout(() => said.set(`${said()} done`), 900);
  return <Text>{`url:${said()}`}</Text>;
}
mount(App);
"#;

#[test]
fn a_late_first_url_reads_the_cores_address() {
    let text = run_app(
        bundle_of(LATE_APP, "nsh-app-url-late"),
        &["myapp"],
        &[],
        |_| {},
    );
    // Nothing launched it and no link came before the timer.
    assert_eq!(text, "url:late:null done");
    let text = run_app(
        bundle_of(LATE_APP, "nsh-app-url-late-link"),
        &["myapp"],
        &["myapp://launch".to_owned()],
        |_| {},
    );
    assert_eq!(text, "url:late:myapp://launch done");
}

/// Listens to `change` and `open` and says each; once it heard the
/// platform's last move, says what `url()` reads and `done`.
const CHANGE_APP: &str = r#"
import { mount, UrlScheme, signal, Text } from "nsh";
function App() {
  const said = signal("");
  const note = (s: string) => said.set(`${said()} ${s}`);
  note(`start:${UrlScheme.url()}`);
  UrlScheme.on("change", ({ url, reason }) => {
    note(`${reason}:${url}`);
    if (url.endsWith("last")) note(`now:${UrlScheme.url()} done`);
  });
  UrlScheme.on("open", ({ url }) => note(`open:${url}`));
  setTimeout(() => note("later:"), 300);
  return <Text>{`url:${said()}`}</Text>;
}
mount(App);
"#;

fn page_event(control: &EngineControl, url: &str, change: Option<&str>) {
    let mut payload = vec![
        (nsh_core::url_scheme::URL, PayloadValue::Str(url.into())),
        ("page", PayloadValue::Bool(true)),
    ];
    if let Some(reason) = change {
        payload.push(("change", PayloadValue::Str(reason.into())));
    }
    control.dispatch_event(ROOT_ID, EventKind::UrlScheme, EventPayload::Map(payload));
}

#[test]
fn address_moves_the_app_did_not_make_reach_change_with_their_reason() {
    let text = run_app_with(
        bundle_of(CHANGE_APP, "nsh-app-url-change"),
        &[],
        // Before anything listened: the address, but no change.
        |control| page_event(control, "https://a.test/early", Some("back")),
        |control| {
            page_event(control, "https://a.test/inbox#archive", Some("address"));
            page_event(control, "https://a.test/inbox", Some("back"));
            // A reason of a newer platform's is the address alone.
            page_event(control, "https://a.test/inbox?unknown", Some("teleport"));
            page_event(control, "https://a.test/inbox#last", Some("forward"));
        },
    );
    // A change is not an `open`, and `url()` has the address.
    assert_eq!(
        text,
        "url: start:https://a.test/early later: address:https://a.test/inbox#archive \
         back:https://a.test/inbox forward:https://a.test/inbox#last \
         now:https://a.test/inbox#last done"
    );
}

/// Sets its address with `history: "push"` and with a `history` it does
/// not know; says what `url()` reads after each.
const PUSH_APP: &str = r#"
import { mount, UrlScheme, signal, Text } from "nsh";
function App() {
  const said = signal("");
  const note = (s: string) => said.set(`${said()} ${s}`);
  UrlScheme.setUrl("myapp://tabs/live", { history: "push" });
  note(`push:${UrlScheme.url()}`);
  UrlScheme.setUrl("myapp://tabs/all", { history: "replace" });
  note(`replace:${UrlScheme.url()}`);
  try {
    UrlScheme.setUrl("myapp://tabs/mine", { history: "sideways" as never });
    note("wrong:none");
  } catch (error) {
    note(`wrong:${error instanceof TypeError ? "TypeError" : String(error)}:${UrlScheme.url()}`);
  }
  setTimeout(() => note("done"), 300);
  return <Text>{`url:${said()}`}</Text>;
}
mount(App);
"#;

#[test]
fn a_pushed_address_reads_back_at_once_and_an_unknown_history_is_a_type_error() {
    let text = run_app(
        bundle_of(PUSH_APP, "nsh-app-url-push"),
        &["myapp"],
        &[],
        |_| {},
    );
    assert_eq!(
        text,
        "url: push:myapp://tabs/live replace:myapp://tabs/all wrong:TypeError:myapp://tabs/all done"
    );
}

/// Hears links on `UrlScheme` and files on `Application.on("openFiles")`,
/// listening only after a while, so the files reported at the start wait.
const FILES_APP: &str = r#"
import { mount, UrlScheme, signal, Text } from "nsh";
import { Application } from "nsh/desktop";
function App() {
  const said = signal("");
  const note = (s: string) => said.set(`${said()} ${s}`);
  setTimeout(() => {
    UrlScheme.on("open", ({ url }) => note(`link:${url}`));
    Application.on("openFiles", ({ paths }) => note(`files:${paths.join(",")}`));
    note("later:");
  }, 200);
  setTimeout(() => note("done"), 1000);
  return <Text>{`opened:${said()}`}</Text>;
}
mount(App);
"#;

#[cfg(unix)]
#[test]
fn opened_files_come_as_paths_apart_from_links() {
    let launch = [
        "file:///home/u/a%20b.mp4".to_owned(),
        "myapp://launch".to_owned(),
        "file:///home/u/c.mov".to_owned(),
    ];
    let text = run_app(
        bundle_of(FILES_APP, "nsh-open-files"),
        &["myapp", nsh_core::file_type::FILE_SCHEME],
        &launch,
        |control| open(control, "file:///home/u/d.mp4"),
    );
    // A slow machine may report the later file before the app listens, and
    // then it waits in the same batch as the launch files.
    let apart = "opened: later: link:myapp://launch files:/home/u/a b.mp4,/home/u/c.mov files:/home/u/d.mp4 done";
    let batched =
        "opened: later: link:myapp://launch files:/home/u/a b.mp4,/home/u/c.mov,/home/u/d.mp4 done";
    assert!(text == apart || text == batched, "{text}");
}

#[test]
fn an_app_that_declares_no_file_types_hears_no_file() {
    let text = run_app(
        bundle_of(FILES_APP, "nsh-open-no-files"),
        &["myapp"],
        &["file:///home/u/a.mp4".to_owned()],
        |control| open(control, "file:///home/u/d.mp4"),
    );
    assert_eq!(text, "opened: later: done");
}
