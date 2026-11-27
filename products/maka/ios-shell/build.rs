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
    let output = std::path::PathBuf::from(std::env::var_os("OUT_DIR").expect("build output"));
    let crate_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let repo = crate_dir
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap();
    let compiler = maka_ui_build::compiler_identity().expect("UI build script identity");
    let mut entries = vec![("app/Entry.tsx", "ios-shell")];
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("ios") {
        entries.push(("tests/fixtures/parse-diff.ts", "parse-diff"));
    }
    for (entry, name) in entries {
        println!("cargo:rerun-if-changed={entry}");
        let module = maka_ui_build::compile_cached(
            std::path::Path::new(entry),
            &output.join(name),
            Some(repo),
            &compiler,
        )
        .unwrap_or_else(|error| panic!("bundle {entry}: {error}"));
        for input in &module.inputs {
            println!("cargo:rerun-if-changed={}", input.display());
        }
        maka_ui_build::write_if_changed(
            &output.join(format!("{name}.js")),
            &std::fs::read(module.module).expect("read compiled iOS shell UI"),
        )
        .expect("write compiled iOS shell UI");
    }
}
