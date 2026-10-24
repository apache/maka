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

fn main() {
    println!("cargo:rerun-if-changed=app");
    println!("cargo:rerun-if-changed=../../../plugins/shared/locale.ts");
    println!("cargo:rerun-if-changed=../../../plugins/shared/locale-messages.ts");
    println!("cargo:rerun-if-changed=../../../plugins/shared/tui-messages.ts");
    println!("cargo:rerun-if-changed=../desktop-shell/app/patch.js");
    // Describe the runtime export without constructing a Host client at build time.
    let mut host = nsh_core::ui::Registry::ui_set("maka/host");
    host.native_values(&["host", "AttachmentPicker", "TerminalGrid"]);
    let ui_sets = vec![nsh_base::registry().into(), host.into()];
    let module = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
        entry: "app/App.tsx".into(),
        minify: false,
        split: false,
        ui_sets,
    })
    .expect("bundle terminal application");
    let output = std::path::PathBuf::from(std::env::var_os("OUT_DIR").expect("build output"));
    std::fs::write(output.join("app.js"), module.code).expect("write terminal application");
    let app = std::path::PathBuf::from(
        std::env::var_os("CARGO_MANIFEST_DIR").expect("package directory"),
    )
    .join("app");
    let mut assets = String::from("&[\n");
    for path in module.assets {
        let source = app.join(&path);
        println!("cargo:rerun-if-changed={}", source.display());
        assets.push_str(&format!(
            "({:?}, include_bytes!({:?}).as_slice()),\n",
            format!("asset:/{}", path.to_string_lossy().replace('\\', "/")),
            source,
        ));
    }
    assets.push_str("]\n");
    std::fs::write(output.join("assets.rs"), assets).expect("write terminal assets");
}
