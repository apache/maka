//! Packages through the trust model: certificates, signatures, hashes,
//! revocation, rollback and persistence.

use nsh_package::{
    App, Contents, Error, PublicKey, SecretKey, TrustStore, build, certify, resign, revoke,
};

const BYTECODE: &str = "bc-1";

fn contents(id: &str, build: u64) -> Contents {
    Contents {
        app: App {
            id: id.into(),
            name: "Demo".into(),
            version: "1.0.0".into(),
            build,
        },
        capabilities: Some(serde_json::json!({ "network": { "hosts": ["api.example.com"] } })),
        source: "console.log('hi')".into(),
        bytecode: Some((vec![1, 2, 3], BYTECODE.into())),
        source_map: Some("{}".into()),
        assets: vec![("img/logo.png".into(), vec![9; 100])],
        min_runtime: None,
    }
}

struct Keys {
    root: SecretKey,
    release: SecretKey,
    cert: nsh_package::Certificate,
}

fn keys(apps: &[&str]) -> Keys {
    let root = SecretKey::generate().unwrap();
    let release = SecretKey::generate().unwrap();
    let apps: Vec<String> = apps.iter().map(|s| s.to_string()).collect();
    let cert = certify(&root, &release.public(), &apps, 0, u64::MAX);
    Keys {
        root,
        release,
        cert,
    }
}

fn store(roots: &[PublicKey]) -> TrustStore {
    let mut store = TrustStore::new();
    for r in roots {
        store.add_root(*r);
    }
    store
}

#[test]
fn a_package_verifies_against_its_root() {
    let k = keys(&["com.longbridge.*"]);
    let bytes = build(&contents("com.longbridge.demo", 3), &k.release, &k.cert).unwrap();
    let store = store(&[k.root.public()]);
    let package = store.verify(&bytes, BYTECODE).unwrap();
    assert_eq!(package.app.id, "com.longbridge.demo");
    assert_eq!(package.source, "console.log('hi')");
    assert_eq!(package.bytecode(), Some(&[1u8, 2, 3][..]));
    assert_eq!(package.assets, [("img/logo.png".to_owned(), vec![9; 100])]);
    assert_eq!(package.key_id, k.release.public().id());
    assert!(package.capabilities.is_some());
    // Bytecode for another runtime is dropped; the source still runs.
    let other = store.verify(&bytes, "bc-2").unwrap();
    assert!(other.bytecode().is_none());
}

#[test]
fn tools_read_the_source_map_of_a_signed_package() {
    let k = keys(&["*"]);
    let bytes = build(&contents("a.b", 1), &k.release, &k.cert).unwrap();
    assert_eq!(
        nsh_package::source_map(&bytes).unwrap().as_deref(),
        Some("{}")
    );
    // Published without it.
    let without = Contents {
        source_map: None,
        ..contents("a.b", 1)
    };
    let bytes = build(&without, &k.release, &k.cert).unwrap();
    assert_eq!(nsh_package::source_map(&bytes).unwrap(), None);
    // Only from a package its own key signed.
    let mut tampered = bytes.clone();
    let last = tampered.len() - 1;
    tampered[last] ^= 1;
    assert!(nsh_package::source_map(&tampered).is_err());
}

#[test]
fn every_byte_is_covered() {
    let k = keys(&["*"]);
    let bytes = build(&contents("a.b", 1), &k.release, &k.cert).unwrap();
    let store = store(&[k.root.public()]);
    // Flipping any byte (header, files, signature) is refused.
    for i in (0..bytes.len()).step_by(37) {
        let mut tampered = bytes.clone();
        tampered[i] ^= 0x40;
        assert!(
            store.verify(&tampered, BYTECODE).is_err(),
            "byte {i} not covered"
        );
    }
    // Trailing bytes too.
    let mut longer = bytes.clone();
    longer.push(0);
    assert!(store.verify(&longer, BYTECODE).is_err());
}

#[test]
fn only_trusted_roots_and_certified_apps() {
    let k = keys(&["com.longbridge.*"]);
    let bytes = build(&contents("com.longbridge.demo", 1), &k.release, &k.cert).unwrap();
    let stranger = SecretKey::generate().unwrap();
    assert!(matches!(
        store(&[stranger.public()]).verify(&bytes, BYTECODE),
        Err(Error::UntrustedKey(_))
    ));
    // A release key certified for other apps cannot sign for them.
    assert!(matches!(
        build(&contents("com.evil.app", 1), &k.release, &k.cert),
        Err(Error::Certificate(m)) if m.contains("com.evil.app")
    ));
    // `com.longbridge.*` is not `com.longbridgex`.
    assert!(build(&contents("com.longbridgex.app", 1), &k.release, &k.cert).is_err());
    // A certificate for another key cannot be used.
    let thief = SecretKey::generate().unwrap();
    assert!(matches!(
        build(&contents("com.longbridge.demo", 1), &thief, &k.cert),
        Err(Error::Certificate(_))
    ));
}

#[test]
fn packages_name_the_lowest_runtime_they_need() {
    let k = keys(&["*"]);
    // By default, the runtime that built it.
    let bytes = build(&contents("a.b", 1), &k.release, &k.cert).unwrap();
    let header = nsh_package::verify_signature(&bytes).unwrap();
    assert_eq!(header.min_runtime(), nsh_package::RUNTIME_VERSION);
    // An older one, so that older runtimes run it too.
    let older = Contents {
        min_runtime: Some("0.0.1".into()),
        ..contents("a.b", 2)
    };
    let bytes = build(&older, &k.release, &k.cert).unwrap();
    assert_eq!(
        nsh_package::verify_signature(&bytes).unwrap().min_runtime(),
        "0.0.1"
    );
    assert!(store(&[k.root.public()]).verify(&bytes, BYTECODE).is_ok());
    // Not a version, or newer than the signer: refused before signing.
    for bad in ["0.1", "latest", "999.0.0"] {
        let bad = Contents {
            min_runtime: Some(bad.into()),
            ..contents("a.b", 3)
        };
        assert!(
            matches!(build(&bad, &k.release, &k.cert), Err(Error::Format(_))),
            "{:?}",
            bad.min_runtime
        );
    }
}

#[test]
fn certificates_have_a_validity_window() {
    let root = SecretKey::generate().unwrap();
    let release = SecretKey::generate().unwrap();
    // Expired a second after the epoch: signing refuses it.
    let expired = certify(&root, &release.public(), &["*".into()], 0, 1);
    assert!(matches!(
        build(&contents("a.b", 1), &release, &expired),
        Err(Error::Certificate(m)) if m.contains("outside")
    ));
}

#[test]
fn release_keys_rotate_under_the_same_root() {
    let k = keys(&["*"]);
    let next = SecretKey::generate().unwrap();
    let next_cert = certify(&k.root, &next.public(), &["*".into()], 0, u64::MAX);
    let store = store(&[k.root.public()]);
    let old = build(&contents("a.b", 1), &k.release, &k.cert).unwrap();
    let new = build(&contents("a.b", 2), &next, &next_cert).unwrap();
    assert!(store.verify(&old, BYTECODE).is_ok());
    assert!(store.verify(&new, BYTECODE).is_ok());
}

/// A package CI signed with its own keys, signed again with a platform's
/// key: devices that trust only the platform's root run it, unchanged.
#[test]
fn a_resigned_package_runs_under_the_new_root_only() {
    let ci = keys(&["*"]);
    let platform = keys(&["com.longbridge.*"]);
    let original = build(&contents("com.longbridge.demo", 3), &ci.release, &ci.cert).unwrap();
    let bytes = resign(&original, &platform.release, &platform.cert).unwrap();

    let package = store(&[platform.root.public()])
        .verify(&bytes, BYTECODE)
        .unwrap();
    assert_eq!(package.key_id, platform.release.public().id());
    assert_eq!(
        package.app,
        App {
            id: "com.longbridge.demo".into(),
            name: "Demo".into(),
            version: "1.0.0".into(),
            build: 3,
        }
    );
    assert_eq!(
        package.capabilities,
        Some(serde_json::json!({ "network": { "hosts": ["api.example.com"] } }))
    );
    assert_eq!(package.source, "console.log('hi')");
    assert_eq!(package.bytecode(), Some(&[1u8, 2, 3][..]));
    assert_eq!(package.source_map.as_deref(), Some("{}"));
    assert_eq!(package.assets, [("img/logo.png".to_owned(), vec![9; 100])]);
    // CI's root no longer vouches for it.
    assert!(matches!(
        store(&[ci.root.public()]).verify(&bytes, BYTECODE),
        Err(Error::UntrustedKey(_))
    ));
}

/// The minimum runtime is the one the package was built for, not the
/// version of the tool that signs it again.
#[test]
fn resigning_keeps_the_minimum_runtime() {
    let ci = keys(&["*"]);
    let platform = keys(&["*"]);
    let older = Contents {
        min_runtime: Some("0.0.1".into()),
        ..contents("a.b", 1)
    };
    let original = build(&older, &ci.release, &ci.cert).unwrap();
    let bytes = resign(&original, &platform.release, &platform.cert).unwrap();
    let header = nsh_package::verify_signature(&bytes).unwrap();
    assert_eq!(header.min_runtime(), "0.0.1");
}

/// The new key may only sign what devices trusting it would accept.
#[test]
fn resigning_checks_the_new_certificate() {
    let ci = keys(&["*"]);
    let original = build(&contents("com.longbridge.demo", 1), &ci.release, &ci.cert).unwrap();
    let other_apps = keys(&["com.other.*"]);
    assert!(matches!(
        resign(&original, &other_apps.release, &other_apps.cert),
        Err(Error::Certificate(m)) if m.contains("com.longbridge.demo")
    ));
    let expired_root = SecretKey::generate().unwrap();
    let expired_key = SecretKey::generate().unwrap();
    let expired = certify(&expired_root, &expired_key.public(), &["*".into()], 0, 1);
    assert!(matches!(
        resign(&original, &expired_key, &expired),
        Err(Error::Certificate(_))
    ));
    let thief = SecretKey::generate().unwrap();
    assert!(matches!(
        resign(&original, &thief, &other_apps.cert),
        Err(Error::Certificate(_))
    ));
}

/// What changed after CI signed it is not signed again.
#[test]
fn resigning_refuses_a_changed_package() {
    let ci = keys(&["*"]);
    let platform = keys(&["*"]);
    let bytes = build(&contents("a.b", 1), &ci.release, &ci.cert).unwrap();
    // A byte of the assets, near the end of the data.
    let mut tampered = bytes.clone();
    let i = bytes.len() - 70;
    tampered[i] ^= 1;
    assert!(matches!(
        resign(&tampered, &platform.release, &platform.cert),
        Err(Error::BadSignature)
    ));
}

#[test]
fn revocations_are_signed_newer_and_enforced() {
    let k = keys(&["*"]);
    let bytes = build(&contents("a.b", 1), &k.release, &k.cert).unwrap();
    let mut store = store(&[k.root.public()]);
    let sha = store.verify(&bytes, BYTECODE).unwrap().sha256;

    // A list from an untrusted key is refused.
    let stranger = SecretKey::generate().unwrap();
    assert!(
        store
            .update_revocations(revoke(&stranger, 9, &[], std::slice::from_ref(&sha)))
            .is_err()
    );

    // Revoking the package.
    assert_eq!(
        store
            .update_revocations(revoke(&k.root, 1, &[], std::slice::from_ref(&sha)))
            .unwrap(),
        1
    );
    assert!(matches!(
        store.verify(&bytes, BYTECODE),
        Err(Error::Revoked(_))
    ));

    // An older list (or the same one again) cannot replace it.
    assert!(matches!(
        store.update_revocations(revoke(&k.root, 1, &[], &[])),
        Err(Error::StaleRevocations { got: 1, have: 1 })
    ));
    assert!(matches!(
        store.verify(&bytes, BYTECODE),
        Err(Error::Revoked(_))
    ));

    // Revoking the release key refuses everything it signed.
    let other = build(&contents("a.b", 2), &k.release, &k.cert).unwrap();
    store
        .update_revocations(revoke(&k.root, 2, &[k.release.public().id()], &[]))
        .unwrap();
    assert!(
        matches!(store.verify(&other, BYTECODE), Err(Error::Revoked(m)) if m.contains("release key"))
    );
}

#[test]
fn older_builds_are_refused_once_a_newer_one_was_accepted() {
    let k = keys(&["*"]);
    let v1 = build(&contents("a.b", 1), &k.release, &k.cert).unwrap();
    let v2 = build(&contents("a.b", 2), &k.release, &k.cert).unwrap();
    let mut store = store(&[k.root.public()]);
    let p2 = store.verify(&v2, BYTECODE).unwrap();
    store.accept(&p2).unwrap();
    assert!(matches!(
        store.verify(&v1, BYTECODE),
        Err(Error::Rollback {
            build: 1,
            accepted: 2,
            ..
        })
    ));
    // The same build again is fine (a reinstall); other apps are separate.
    assert!(store.verify(&v2, BYTECODE).is_ok());
    let other = build(&contents("c.d", 1), &k.release, &k.cert).unwrap();
    assert!(store.verify(&other, BYTECODE).is_ok());
}

#[test]
fn a_verified_build_is_not_accepted_until_its_receipt_is() {
    let k = keys(&["*"]);
    let v1 = build(&contents("a.b", 1), &k.release, &k.cert).unwrap();
    let v2 = build(&contents("a.b", 2), &k.release, &k.cert).unwrap();
    let v0 = build(&contents("a.b", 0), &k.release, &k.cert).unwrap();
    let mut store = store(&[k.root.public()]);
    store.accept(&store.verify(&v1, BYTECODE).unwrap()).unwrap();

    // Build 2 verifies (and would run); build 1 still verifies: the app
    // can go back to it. Below what was accepted stays refused.
    let receipt = store.verify(&v2, BYTECODE).unwrap().receipt();
    assert_eq!(store.accepted_build("a.b"), Some(1));
    assert!(store.verify(&v1, BYTECODE).is_ok());
    assert!(matches!(
        store.verify(&v0, BYTECODE),
        Err(Error::Rollback { accepted: 1, .. })
    ));

    // Accepted: build 1 is refused from now on. Accepting again, or an
    // older receipt, changes nothing.
    store.accept_receipt(&receipt).unwrap();
    assert_eq!(store.accepted_build("a.b"), Some(2));
    assert!(matches!(
        store.verify(&v1, BYTECODE),
        Err(Error::Rollback { accepted: 2, .. })
    ));
    store.accept_receipt(&receipt).unwrap();
    let mut other = TrustStore::new();
    other.add_root(k.root.public());
    let older = other.verify(&v1, BYTECODE).unwrap().receipt();
    store.accept_receipt(&older).unwrap();
    assert_eq!(store.accepted_build("a.b"), Some(2));
    other.accept_receipt(&receipt).unwrap();
    assert_eq!(other.accepted_build("a.b"), Some(2));
}

#[test]
fn a_package_revoked_after_it_was_verified_is_not_accepted() {
    let k = keys(&["*"]);
    let v1 = build(&contents("a.b", 1), &k.release, &k.cert).unwrap();
    let v2 = build(&contents("a.b", 2), &k.release, &k.cert).unwrap();
    let mut store = store(&[k.root.public()]);
    store.accept(&store.verify(&v1, BYTECODE).unwrap()).unwrap();
    let receipt = store.verify(&v2, BYTECODE).unwrap().receipt();
    store
        .update_revocations(revoke(
            &k.root,
            1,
            &[],
            std::slice::from_ref(&receipt.sha256),
        ))
        .unwrap();
    assert!(matches!(
        store.accept_receipt(&receipt),
        Err(Error::Revoked(_))
    ));
    // The app can still go back to build 1.
    assert_eq!(store.accepted_build("a.b"), Some(1));
    assert!(store.verify(&v1, BYTECODE).is_ok());

    // Its release key revoked: refused too.
    let v3 = build(&contents("a.b", 3), &k.release, &k.cert).unwrap();
    let receipt = store.verify(&v3, BYTECODE).unwrap().receipt();
    store
        .update_revocations(revoke(
            &k.root,
            2,
            std::slice::from_ref(&receipt.key_id),
            &[],
        ))
        .unwrap();
    assert!(matches!(
        store.accept_receipt(&receipt),
        Err(Error::Revoked(_))
    ));
    assert_eq!(store.accepted_build("a.b"), Some(1));
}

#[test]
fn state_persists() {
    let dir = std::env::temp_dir().join(format!("nsh-trust-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let k = keys(&["*"]);
    let v1 = build(&contents("a.b", 1), &k.release, &k.cert).unwrap();
    let v5 = build(&contents("a.b", 5), &k.release, &k.cert).unwrap();
    {
        let mut store = TrustStore::open(&dir).unwrap();
        store.add_root(k.root.public());
        let p = store.verify(&v5, BYTECODE).unwrap();
        store.accept(&p).unwrap();
        store
            .update_revocations(revoke(&k.root, 7, &[], &[]))
            .unwrap();
    }
    let mut store = TrustStore::open(&dir).unwrap();
    store.add_root(k.root.public());
    assert!(matches!(
        store.verify(&v1, BYTECODE),
        Err(Error::Rollback { accepted: 5, .. })
    ));
    assert!(matches!(
        store.update_revocations(revoke(&k.root, 3, &[], &[])),
        Err(Error::StaleRevocations { have: 7, .. })
    ));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn asset_paths_stay_inside_the_assets_directory() {
    let k = keys(&["*"]);
    // Each would escape the directory assets are written to on some system
    // (`C:/x` and `a\b` on Windows) or write somewhere else (`a:b` is an
    // NTFS alternate data stream).
    for path in [
        "/etc/x",
        "../x",
        "a/../../x",
        "a//b",
        "./a",
        "a\\b",
        "C:/x",
        "C:x",
        "a:b",
    ] {
        let mut c = contents("a.b", 1);
        c.assets = vec![(path.into(), vec![1])];
        assert!(
            matches!(build(&c, &k.release, &k.cert), Err(Error::Format(_))),
            "`{path}` accepted"
        );
    }
}

#[test]
fn keys_round_trip_through_base64() {
    let key = SecretKey::generate().unwrap();
    let again = SecretKey::from_base64(&key.to_base64()).unwrap();
    assert_eq!(again.public(), key.public());
    let public = PublicKey::from_base64(&key.public().to_base64()).unwrap();
    assert_eq!(public.id(), key.public().id());
    assert_eq!(public.id().len(), 16);
    assert!(PublicKey::from_base64("not base64!").is_err());
}
