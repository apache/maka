//! Signed packages end to end: publish the counter example, verify and run
//! it, and refuse older builds afterwards.

use std::{path::PathBuf, time::Duration};

use nsh_core::{ApproxTextEngine, MountItem, Size, geometry::px};
use nsh_engine::{
    Engine, EngineConfig,
    package::{App, Contents, SecretKey, TrustStore, build, certify},
};

use crate::ChannelSink;

fn counter(build_number: u64, bytecode_version: &str) -> Contents {
    let entry = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../examples/counter/App.tsx");
    let bundle = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
        entry,
        minify: true,
        split: false,
        ui_sets: vec![nsh_base::registry().into()],
    })
    .unwrap();
    let bytecode = nsh_js::compile_bytecode(&bundle.code, true).unwrap();
    Contents {
        app: App {
            id: "com.example.counter".into(),
            name: "Counter".into(),
            version: "1.0.0".into(),
            build: build_number,
        },
        capabilities: Some(serde_json::json!({ "network": { "hosts": ["api.example.com"] } })),
        source: bundle.code,
        bytecode: Some((bytecode, bytecode_version.into())),
        source_map: bundle.source_map,
        assets: vec![("img/dot.png".into(), vec![1, 2, 3])],
        min_runtime: None,
    }
}

fn first_texts(bundle: nsh_engine::Bundle) -> Vec<String> {
    let (tx, rx) = crossbeam_channel::unbounded();
    let config = EngineConfig {
        app: nsh_engine::App::Js(bundle),
        viewport: Size::new(px(390.0), px(844.0)),
        trace: false,
        network: None,
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
    let _engine = Engine::start(config, || ApproxTextEngine, ChannelSink(tx)).unwrap();
    let first = rx
        .recv_timeout(Duration::from_secs(5))
        .expect("first frame");
    first
        .items
        .iter()
        .filter_map(|i| match i {
            MountItem::Text { text, .. } => Some(text.text.clone()),
            _ => None,
        })
        .collect()
}

#[test]
fn a_verified_package_runs_and_older_builds_are_refused() {
    let dir = std::env::temp_dir().join(format!("nsh-package-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let root = SecretKey::generate().unwrap();
    let release = SecretKey::generate().unwrap();
    let cert = certify(
        &root,
        &release.public(),
        &["com.example.*".into()],
        0,
        u64::MAX,
    );
    let mut trust = TrustStore::open(dir.join("trust")).unwrap();
    trust.add_root(root.public());

    // Bytecode for this runtime.
    let v2 = build(&counter(2, nsh_js::BYTECODE_VERSION), &release, &cert).unwrap();
    let loaded = nsh_engine::load_package(&mut trust, &v2, &dir.join("packages")).unwrap();
    assert_eq!(loaded.app.build, 2);
    // Its errors name it.
    let info = loaded.bundle.package.clone().expect("the package");
    assert_eq!((info.id.as_str(), info.build), ("com.example.counter", 2));
    assert_eq!(info.sha256.len(), 64);
    let (bundle, assets) = (loaded.bundle, loaded.assets);
    assert!(matches!(bundle.code, nsh_engine::BundleCode::Bytecode(_)));
    let access = bundle.policy.access();
    assert!(access.allows_http("GET", "https://api.example.com/x"));
    assert!(!access.allows_http("GET", "https://evil.example.org/x"));
    assert_eq!(
        std::fs::read(assets.join("img/dot.png")).unwrap(),
        [1, 2, 3]
    );
    assert!(first_texts(bundle).contains(&"0".to_owned()));

    // Bytecode for another runtime: the source runs.
    let other = build(&counter(2, "another"), &release, &cert).unwrap();
    let bundle = nsh_engine::load_package(&mut trust, &other, &dir.join("packages"))
        .unwrap()
        .bundle;
    assert!(matches!(bundle.code, nsh_engine::BundleCode::Source(_)));
    assert!(first_texts(bundle).contains(&"0".to_owned()));

    // Build 1 after build 2, also after a restart.
    let v1 = build(&counter(1, nsh_js::BYTECODE_VERSION), &release, &cert).unwrap();
    let err = nsh_engine::load_package(&mut trust, &v1, &dir.join("packages")).unwrap_err();
    assert!(err.contains("older"), "{err}");
    let mut reopened = TrustStore::open(dir.join("trust")).unwrap();
    reopened.add_root(root.public());
    assert!(nsh_engine::load_package(&mut reopened, &v1, &dir.join("packages")).is_err());

    // A tampered package never runs.
    let mut tampered = v2.clone();
    let at = tampered.len() / 2;
    tampered[at] ^= 1;
    assert!(nsh_engine::load_package(&mut trust, &tampered, &dir.join("packages")).is_err());
    let _ = std::fs::remove_dir_all(&dir);
}

/// A package declaring capabilities of a newer runtime still runs: what
/// this runtime does not know is not granted, the rest is.
#[test]
fn capabilities_of_newer_runtimes_are_not_granted() {
    let dir = std::env::temp_dir().join(format!("nsh-package-newer-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let root = SecretKey::generate().unwrap();
    let release = SecretKey::generate().unwrap();
    let cert = certify(&root, &release.public(), &["*".into()], 0, u64::MAX);
    let mut trust = TrustStore::new();
    trust.add_root(root.public());
    let newer = Contents {
        capabilities: Some(serde_json::json!({
            "bluetooth": { "devices": ["*"] },
            "clipboard": true,
            "network": {
                "hosts": ["api.example.com"],
                "http": [{ "host": "quotes.example.com", "ports": [8443] }]
            }
        })),
        ..counter(1, nsh_js::BYTECODE_VERSION)
    };
    let bytes = build(&newer, &release, &cert).unwrap();
    let bundle = nsh_engine::load_package(&mut trust, &bytes, &dir)
        .unwrap()
        .bundle;
    let access = bundle.policy.access();
    assert!(access.allows_clipboard());
    assert!(access.allows_http("GET", "https://api.example.com/x"));
    // The grant restricted by a key this runtime cannot apply is dropped.
    assert!(!access.allows_http("GET", "https://quotes.example.com/x"));
    assert!(first_texts(bundle).contains(&"0".to_owned()));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_package_accepted_once_healthy_lets_the_app_go_back_before() {
    let dir = std::env::temp_dir().join(format!("nsh-package-accept-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let root = SecretKey::generate().unwrap();
    let release = SecretKey::generate().unwrap();
    let cert = certify(
        &root,
        &release.public(),
        &["com.example.*".into()],
        0,
        u64::MAX,
    );
    let open = || {
        let mut trust = TrustStore::open(dir.join("trust")).unwrap();
        trust.add_root(root.public());
        trust
    };
    let packages = dir.join("packages");
    let v1 = build(&counter(1, nsh_js::BYTECODE_VERSION), &release, &cert).unwrap();
    let v2 = build(&counter(2, nsh_js::BYTECODE_VERSION), &release, &cert).unwrap();
    let mut trust = open();
    nsh_engine::load_package(&mut trust, &v1, &packages).unwrap();

    // Build 2 runs before it is accepted.
    let v2_loaded = nsh_engine::verify_package(&trust, &v2, &packages).unwrap();
    assert_eq!(v2_loaded.receipt.app.build, 2);
    assert!(first_texts(v2_loaded.bundle.clone()).contains(&"0".to_owned()));
    // It failed (or the app quit) before it was accepted: build 1 still
    // loads, also after a restart.
    drop(trust);
    let mut trust = open();
    assert_eq!(trust.accepted_build("com.example.counter"), Some(1));
    assert!(nsh_engine::verify_package(&trust, &v1, &packages).is_ok());

    // Healthy: accepted, and build 1 is refused from now on.
    nsh_engine::accept_package(&mut trust, &v2_loaded).unwrap();
    let err = nsh_engine::verify_package(&trust, &v1, &packages).unwrap_err();
    assert!(err.contains("older"), "{err}");
    drop(trust);
    let trust = open();
    assert!(nsh_engine::verify_package(&trust, &v1, &packages).is_err());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn bytecode_files_are_refused_by_read() {
    let dir = std::env::temp_dir().join(format!("nsh-read-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("bundle.nshc"), [0u8; 16]).unwrap();
    std::fs::write(dir.join("bundle.js"), "1").unwrap();
    assert!(nsh_engine::Bundle::read(&dir.join("bundle.nshc")).is_err());
    assert!(nsh_engine::Bundle::read(&dir.join("bundle.js")).is_ok());
    let _ = std::fs::remove_dir_all(&dir);
}
