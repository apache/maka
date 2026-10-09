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

//! Runs the sidecar's own Node tests (`sidecars/bots/test/*.test.mjs`): the
//! chat routing, the Session adapter, and the Telegram conflict handling,
//! against the real Maka modules of the checkout.
//!
//! They need a Maka checkout with the bots package built (`$MAKA_REPO`,
//! default `~/code/maka-pin`) and a Node discovered as the app discovers it;
//! without either this test says so and passes, as CI has neither. Run them
//! directly with
//!
//! ```sh
//! MAKA_REPO=~/code/maka-pin node --test 'sidecars/bots/test/*.test.mjs'
//! ```
#![allow(clippy::disallowed_methods)]

use std::path::Path;
use std::process::Command;

use bots::BOTS_BUILD_MARKER;
use futures_lite::future::block_on;
use host_client::{NodeRuntime, configured_maka_checkout};

#[test]
fn the_sidecar_node_tests_pass() {
    let Some(checkout) = configured_maka_checkout() else {
        eprintln!("skipped: no Maka checkout");
        return;
    };
    if !checkout.join(BOTS_BUILD_MARKER).is_file() {
        eprintln!("skipped: {} has no built bots package", checkout.display());
        return;
    }
    let node = match block_on(NodeRuntime::discover()) {
        Ok(node) => node,
        Err(error) => {
            eprintln!("skipped: {error}");
            return;
        }
    };
    let tests = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../sidecars/bots/test");
    let mut files: Vec<_> = std::fs::read_dir(&tests)
        .expect("sidecars/bots/test")
        .map(|entry| entry.expect("entry").path())
        .filter(|path| path.to_string_lossy().ends_with(".test.mjs"))
        .collect();
    files.sort();
    assert!(!files.is_empty(), "no Node tests in {}", tests.display());
    let output = Command::new(node.path())
        .arg("--test")
        .args(&files)
        .env("MAKA_REPO", &checkout)
        .output()
        .expect("node --test");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(output.status.success(), "node --test failed:\n{stdout}\n{stderr}");
    eprintln!(
        "{}",
        stdout.lines().filter(|line| line.starts_with('ℹ')).collect::<Vec<_>>().join("\n")
    );
}
