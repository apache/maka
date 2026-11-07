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

use std::path::PathBuf;

// Nextest remaps these paths when replaying an archived build.
fn maka_executable() -> PathBuf {
    std::env::var_os("CARGO_BIN_EXE_maka")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_BIN_EXE_maka")))
}

fn executable_tempdir() -> tempfile::TempDir {
    let executable = maka_executable();
    tempfile::tempdir_in(
        executable
            .parent()
            .expect("the Maka test executable has a parent directory"),
    )
    .expect("create fixture on the same filesystem as the actual Maka executable")
}

fn product_bundle() -> PathBuf {
    std::env::var_os("OUT_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("OUT_DIR")))
        .join("product")
}

mod application;
mod candidate;
mod code_command;
#[cfg(unix)]
mod desktop;
mod initialize;
#[allow(dead_code)]
#[path = "../../../../../platform/transport/tests/integration/support/mod.rs"]
mod local_fixture;
#[cfg(target_os = "linux")]
mod network_sandbox;
mod product_composition;
mod sandbox;
mod startup;
mod terminal_shell;

#[path = "../../../terminal-shell/tests/real_host/mod.rs"]
mod terminal;
