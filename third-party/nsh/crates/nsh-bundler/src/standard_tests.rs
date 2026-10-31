//! Real npm-package imports must keep standard modules external to app bundles.

use std::{
    path::PathBuf,
    sync::atomic::{AtomicUsize, Ordering},
};

use crate::{BundleOptions, bundle};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let home = std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .expect("home directory for test cache");
        let directory = PathBuf::from(home)
            .join(".cache/nsh-test-tmp")
            .join(format!(
                "standard-bundler-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
        std::fs::create_dir_all(&directory).unwrap();
        Self(directory)
    }
    fn write(&self, name: &str, text: &str) {
        let file = self.0.join(name);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, text).unwrap();
    }
    fn build(&self) -> Result<crate::Bundle, crate::BundleError> {
        bundle(&BundleOptions {
            entry: self.0.join("App.ts"),
            minify: false,
            split: false,
            ui_sets: vec![],
        })
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn npm_package_esm_imports_native_standard_modules_without_polyfill_bundles() {
    let fixture = Fixture::new();
    fixture.write(
        "App.ts",
        "import { sample } from 'standard-consumer'; console.log(sample('你好'));\n",
    );
    fixture.write(
        "node_modules/standard-consumer/package.json",
        r#"{"name":"standard-consumer","type":"module","exports":"./index.js"}"#,
    );
    fixture.write("node_modules/standard-consumer/index.js", "import {Buffer} from 'buffer'; import path from 'path'; export const sample = value => path.join('native-standard-marker',Buffer.from(value).toString('hex'));\n");
    let bundled = fixture
        .build()
        .expect("bundle npm dependency importing native standards");
    assert!(
        bundled.code.contains("native-standard-marker"),
        "npm implementation must be bundled: {}",
        bundled.code
    );
    assert!(
        bundled.code.contains("from \"buffer\""),
        "Buffer must remain a native import: {}",
        bundled.code
    );
    assert!(
        bundled.code.contains("from \"path\""),
        "path must remain a native import: {}",
        bundled.code
    );
    assert!(
        !bundled.code.contains("class Buffer"),
        "no Buffer polyfill in an app bundle"
    );
}

#[test]
fn unsupported_node_and_private_type_modules_do_not_silently_bundle() {
    for name in [
        "node:vm",
        "node:buffer",
        "node:fs/promises",
        "events",
        "assert",
        "util",
        "string_decoder",
        "fs",
        "@nsh/llrt-types/buffer",
        "node:crypto/private",
    ] {
        let fixture = Fixture::new();
        fixture.write(
            "App.ts",
            &format!("import * as module from '{name}'; console.log(module);\n"),
        );
        assert!(
            fixture.build().is_err(),
            "{name} must not masquerade as a supported builtin"
        );
    }
}

/// A module named as nsh's that nsh does not have (the primitives' former
/// homes among them: they are `nsh`'s) fails to bundle, naming the ones
/// there are.
#[test]
fn modules_nsh_does_not_have_do_not_bundle() {
    for name in [
        "nsh/list",
        "nsh/image",
        "nsh/canvas",
        "nsh/webview",
        "nsh/video",
        "nsh/device",
    ] {
        let fixture = Fixture::new();
        fixture.write(
            "App.ts",
            &format!("import * as module from '{name}'; console.log(module);\n"),
        );
        let message = fixture.build().expect_err(name).to_string();
        assert!(
            message.contains(&format!("nsh has no module `{name}`")),
            "{message}"
        );
        assert!(
            message.contains("`nsh`, `nsh/desktop`, `nsh/mobile`"),
            "{message}"
        );
    }
}
