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
    println!("cargo:rerun-if-changed=app/Bootstrap.tsx");
    // Describe the runtime export without constructing a Host client at build time.
    let mut host = nsh_core::element::Registry::ui_set("maka/host");
    host.native_values(&["host", "AttachmentPicker", "TerminalGrid", "UploadIntake"]);
    let ui_sets = vec![nsh_base::registry().into(), host.into()];
    let module = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
        entry: "app/Bootstrap.tsx".into(),
        minify: false,
        split: false,
        ui_sets,
    })
    .expect("bundle shared UI bootstrap");
    assert!(
        module.assets.is_empty(),
        "UI bootstrap assets belong in ordinary UI packages"
    );
    for input in &module.watch_files {
        println!("cargo:rerun-if-changed={}", input.display());
    }
    let output = std::path::PathBuf::from(std::env::var_os("OUT_DIR").expect("build output"));
    std::fs::write(output.join("bootstrap.js"), module.code).expect("write shared UI bootstrap");
}
