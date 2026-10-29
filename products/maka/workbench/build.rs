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
    let output = std::path::PathBuf::from(std::env::var_os("OUT_DIR").expect("build output"));
    let compiler = maka_ui_build::compiler_identity().expect("UI build script identity");
    let module = maka_ui_build::compile_cached(
        std::path::Path::new("app/Bootstrap.tsx"),
        &output.join("bootstrap"),
        &compiler,
    )
    .expect("bundle shared UI bootstrap");
    assert!(
        module.assets.is_empty(),
        "UI bootstrap assets belong in ordinary UI packages"
    );
    for input in &module.inputs {
        println!("cargo:rerun-if-changed={}", input.display());
    }
    maka_ui_build::write_if_changed(
        &output.join("bootstrap.js"),
        &std::fs::read(module.module).expect("read shared UI bootstrap"),
    )
    .expect("write shared UI bootstrap");
}
