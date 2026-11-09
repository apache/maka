//! Signed packages (`NshTrust.java`, `NshView.runPackage`): JS apps only.

use std::sync::Mutex;

use jni::{
    JNIEnv,
    objects::{JClass, JObjectArray, JString, JValue},
    sys::{jboolean, jlong},
};
use nsh_engine::Bundle;

use crate::host::host;

/// A trust store and where packages' assets are extracted
/// (`NshTrust.java`); Java may use it from any thread.
struct Trust {
    store: Mutex<nsh_engine::package::TrustStore>,
    packages: std::path::PathBuf,
}

/// A trust store kept in `dir`; 0 (logged) if its state cannot be read.
#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_Native_trustCreate(
    mut env: JNIEnv<'_>,
    _: JClass<'_>,
    dir: JString<'_>,
) -> jlong {
    let Ok(dir) = env.get_string(&dir).map(String::from) else {
        return 0;
    };
    let dir = std::path::PathBuf::from(dir);
    match nsh_engine::package::TrustStore::open(&dir) {
        Ok(store) => Box::into_raw(Box::new(Trust {
            store: Mutex::new(store),
            packages: dir.join("packages"),
        })) as jlong,
        Err(err) => {
            log::error!("cannot open the trust store in {}: {err}", dir.display());
            0
        }
    }
}

/// # Safety
///
/// `trust` must be a live handle from `trustCreate`.
unsafe fn trust<'a>(trust: jlong) -> &'a Trust {
    // SAFETY: guaranteed by the caller.
    unsafe { &*(trust as *const Trust) }
}

#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_Native_trustAddRoot(
    mut env: JNIEnv<'_>,
    _: JClass<'_>,
    handle: jlong,
    key: JString<'_>,
) -> jboolean {
    // SAFETY: Java passes its live handle.
    let trust = unsafe { trust(handle) };
    let Ok(key) = env.get_string(&key).map(String::from) else {
        return 0;
    };
    match nsh_engine::package::PublicKey::from_base64(&key) {
        Ok(key) => {
            trust.store.lock().expect("trust").add_root(key);
            1
        }
        Err(err) => {
            log::error!("invalid root key: {err}");
            0
        }
    }
}

#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_Native_trustUpdateRevocations(
    mut env: JNIEnv<'_>,
    _: JClass<'_>,
    handle: jlong,
    json: JString<'_>,
) -> jboolean {
    // SAFETY: Java passes its live handle.
    let trust = unsafe { trust(handle) };
    let Ok(json) = env.get_string(&json).map(String::from) else {
        return 0;
    };
    let result = nsh_engine::package::Revocations::from_json(&json)
        .and_then(|list| trust.store.lock().expect("trust").update_revocations(list));
    match result {
        Ok(_) => 1,
        Err(err) => {
            log::error!("revocation list refused: {err}");
            0
        }
    }
}

#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_Native_trustDestroy(
    _: JNIEnv<'_>,
    _: JClass<'_>,
    handle: jlong,
) {
    if handle != 0 {
        // SAFETY: Java passes its handle once, and never uses it again.
        drop(unsafe { Box::from_raw(handle as *mut Trust) });
    }
}

/// A verified package waiting to run (`NshPackage.java`).
struct Package {
    bundle: Bundle,
    assets: std::path::PathBuf,
}

/// Verifies and unpacks the package at `path` (any thread): a package
/// handle, or 0 with the reason in `error[0]`.
#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_Native_trustOpenPackage(
    mut env: JNIEnv<'_>,
    _: JClass<'_>,
    trust_handle: jlong,
    path: JString<'_>,
    info: JObjectArray<'_>,
) -> jlong {
    // SAFETY: Java passes its live handle.
    let trust = unsafe { trust(trust_handle) };
    let opened = env
        .get_string(&path)
        .map(String::from)
        .map_err(|e| e.to_string())
        .and_then(|path| {
            let bytes =
                std::fs::read(&path).map_err(|err| format!("cannot read package {path}: {err}"))?;
            let mut store = trust.store.lock().expect("trust");
            nsh_engine::load_package(&mut store, &bytes, &trust.packages)
                .map_err(|err| format!("refused package: {err}"))
        });
    // `info`: the error, or the app's id, name, version and build.
    let (handle, fields) = match opened {
        Ok(loaded) => {
            let app = loaded.app;
            let handle = Box::into_raw(Box::new(Package {
                bundle: loaded.bundle,
                assets: loaded.assets,
            })) as jlong;
            (
                handle,
                vec![app.id, app.name, app.version, app.build.to_string()],
            )
        }
        Err(message) => (0, vec![message]),
    };
    for (i, field) in fields.into_iter().enumerate() {
        if let Ok(s) = env.new_string(field) {
            let _ = env.set_object_array_element(&info, i as i32, s);
        }
    }
    handle
}

/// Runs a package from `trustOpenPackage` (taking it).
#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_Native_runPackage(
    mut env: JNIEnv<'_>,
    _: JClass<'_>,
    handle: jlong,
    package: jlong,
) {
    // SAFETY: Java passes its live handle and a package it never uses again.
    let (host, package) = unsafe { (host(handle), Box::from_raw(package as *mut Package)) };
    // Before the engine starts: it may read assets (fonts) at once.
    let set = env
        .new_string(package.assets.to_string_lossy())
        .and_then(|dir| {
            env.call_method(
                host.view.as_obj(),
                "usePackageAssets",
                "(Ljava/lang/String;)V",
                &[JValue::Object(&dir)],
            )
        });
    if let Err(err) = set {
        return log::error!("cannot set the package's assets: {err}");
    }
    host.load(package.bundle);
}

/// The package a packaged app (`AppActivity`) runs instead of `shipped`,
/// the bundle in its APK: a newer signed package of its code it downloaded,
/// verified against the roots `updater` (its `nsh-updater.json`) trusts
/// (`nsh_engine::updates`); the view then reads the package's assets.
/// `None`: the shipped bundle runs (it reads `updater` either way).
pub(crate) fn downloaded(
    env: &mut JNIEnv<'_>,
    host: &crate::host::Host,
    shipped: &mut Bundle,
    updater: &JString<'_>,
) -> Option<Bundle> {
    let updater = String::from(env.get_string(updater).ok()?);
    let run = nsh_engine::updates::package_to_run(
        shipped,
        Some(updater.into_bytes()),
        host.data_dir.as_deref(),
    )?;
    // Before the engine starts: it may read assets (fonts) at once.
    let set = env
        .new_string(run.assets.to_string_lossy())
        .and_then(|dir| {
            env.call_method(
                host.view.as_obj(),
                "usePackageAssets",
                "(Ljava/lang/String;)V",
                &[JValue::Object(&dir)],
            )
        });
    match set {
        Ok(_) => Some(run.bundle),
        Err(err) => {
            log::error!("cannot set the package's assets, running the app's own: {err}");
            None
        }
    }
}

/// Frees a package that will not run.
#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_Native_packageFree(
    _: JNIEnv<'_>,
    _: JClass<'_>,
    package: jlong,
) {
    if package != 0 {
        // SAFETY: Java passes a package it never uses again.
        drop(unsafe { Box::from_raw(package as *mut Package) });
    }
}
