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
    for path in [
        "../graph/src/client.tsx",
        "../graph/src/client",
        "../../packages/workhub/src",
        "../skills/src/client",
        "../skills/src/client.tsx",
        "../jev/src/client.tsx",
        "../jev/src/client",
        "../external-agent/src/client.tsx",
        "../external-agent/src/client",
        "../session-recap/src/client.tsx",
        "../session-recap/src/client",
        "../goal/src/client.tsx",
        "../goal/src/client",
        "../web/src/client.tsx",
        "../web/src/client",
        "../insights/src/client.tsx",
        "../insights/src/client",
        "../session-import/src/client.tsx",
        "../session-import/src/client",
        "../assistant/src/todo",
        "../scheduler/src/client",
        "../scheduler/src/client.tsx",
        "../../packages/plugin-sdk/src",
        "../../scripts/rust/bundle-plugin-clients.mjs",
        "../../package-lock.json",
    ] {
        println!("cargo:rerun-if-changed={path}");
    }
    println!("cargo:rerun-if-env-changed=MAKA_JS_DEPS");
    let dependencies = std::env::var_os("MAKA_JS_DEPS")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| "../..".into());
    for source in ["package-lock.json", "node_modules/.package-lock.json"] {
        println!(
            "cargo:rerun-if-changed={}",
            dependencies.join(source).display()
        );
    }
    let status = std::process::Command::new("node")
        .arg("../../scripts/rust/bundle-plugin-clients.mjs")
        .arg(std::env::var_os("OUT_DIR").expect("Cargo OUT_DIR"))
        .stdin(std::process::Stdio::null())
        .status()
        .expect("Node is required to build built-in Client plugins");
    assert!(
        status.success(),
        "Client plugin build failed; install repository npm dependencies first"
    );
}
