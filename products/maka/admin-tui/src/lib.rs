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

pub mod backend;
pub mod model;
pub mod terminal;
pub mod ui;

pub use backend::{ControlPlane, ControlPlaneConfig};
pub use ui::AdminApp;

use nsh_engine::{HostChannel, Limits, Root};
use nsh_platform_tui::AppOptions;
use std::path::PathBuf;

/// Builds AppOptions configured for AdminApp with the supplied HostChannel.
pub fn app_options(host: HostChannel) -> AppOptions {
    let mut options = AppOptions::default();
    options.limits = Limits::standalone();
    options.host = host;
    options
}

/// Builds the NSH Root for AdminApp with its required host, clipboard, and app capabilities.
pub fn admin_root() -> Root {
    let caps = serde_json::json!({
        "host": ["command"],
        "application": true,
        "clipboard": true,
    });
    let (capabilities, _) = nsh_core::access::Capabilities::from_json_lenient(&caps)
        .expect("static admin-tui capabilities JSON is valid");
    Root::of::<AdminApp>()
        .app_id("org.apache.maka.admin")
        .capabilities(capabilities)
}

/// Resolves the maka CLI binary sibling to maka-admin, or falls back to maka on PATH.
pub fn resolve_maka_binary(explicit: Option<PathBuf>) -> PathBuf {
    if let Some(path) = explicit {
        return path;
    }
    if let Ok(exe) = std::env::current_exe() {
        let bin_name = if cfg!(windows) { "maka.exe" } else { "maka" };
        let sibling = exe.with_file_name(bin_name);
        if sibling.is_file() {
            return sibling;
        }
        if let Some(parent) = exe
            .parent()
            .and_then(|p| p.parent())
            .and_then(|p| p.parent())
        {
            let beside_bundle = parent.with_file_name(bin_name);
            if beside_bundle.is_file() {
                return beside_bundle;
            }
        }
    }
    PathBuf::from(if cfg!(windows) { "maka.exe" } else { "maka" })
}
