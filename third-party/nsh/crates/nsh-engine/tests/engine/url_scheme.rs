//! `UrlScheme` of `nsh` from JS: the links the platform reports reach the
//! `open` listener, those that came before it first, and only those of the
//! schemes the app claims.

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

fn bundle() -> Bundle {
    let dir = crate::temporary_root().join(format!("nsh-deep-links-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let entry = dir.join("App.tsx");
    std::fs::write(&entry, APP).unwrap();
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
    let config = EngineConfig {
        viewport: Size::new(px(400.0), px(600.0)),
        ui_sets: vec![nsh_base::registry()],
        ..EngineConfig::new(bundle().with_url_schemes(schemes.iter().copied()))
    };
    let (tx, rx) = crossbeam_channel::unbounded();
    let engine = Engine::start(config, || ApproxTextEngine, ChannelSink(tx)).unwrap();
    let control = engine.control();
    for url in launch {
        open(&control, url);
    }
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
        if !sent_later && text != "links:" {
            sent_later = true;
            open(&control, later);
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
