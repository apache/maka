/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */
#[path = "build/product.rs"]
mod product;

fn main() {
    product::bundle();
    terminal_fixture();
    println!("cargo:rerun-if-env-changed=MAKA_NATIVE_PACKAGE_VERSION");
    if let Ok(version) = std::env::var("MAKA_NATIVE_PACKAGE_VERSION") {
        assert!(
            !version.is_empty()
                && version.len() <= 256
                && version
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-')),
            "invalid native package version"
        );
        println!("cargo:rustc-env=MAKA_NATIVE_PACKAGE_VERSION={version}");
    }
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
    }
}

// The real terminal integration target belongs to this package so its PTY
// launches the same `maka` executable that users run.
fn terminal_fixture() {
    let source = std::path::PathBuf::from(
        std::env::var_os("CARGO_MANIFEST_DIR").expect("package directory"),
    )
    .join("../terminal-shell");
    let fixture = source.join("tests/fixtures/attachment-draft.tsx");
    println!("cargo:rerun-if-changed={}", fixture.display());
    println!(
        "cargo:rerun-if-changed={}",
        source.join("../workbench/app").display()
    );
    let mut host = nsh_core::element::Registry::ui_set("maka/host");
    host.native_values(&["host", "AttachmentPicker", "TerminalGrid"]);
    let module = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
        entry: fixture,
        minify: false,
        split: false,
        ui_sets: vec![nsh_base::registry().into(), host.into()],
    })
    .expect("bundle attachment draft fixture");
    let output = std::path::PathBuf::from(std::env::var_os("OUT_DIR").expect("build output"));
    std::fs::write(output.join("attachment-draft-fixture.js"), module.code)
        .expect("write attachment draft fixture");
}
