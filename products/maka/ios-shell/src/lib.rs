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

//! Native Maka iOS shell: lightweight remote Host client + NSH UIKit V7 app.

pub mod bridge;

pub use bridge::{ALLOWED_HOST_CALLS, EndpointOpener, HostBridge};

use nsh_engine::{Bundle, Capabilities, EngineConfig, HostChannel, Limits, Policy};

/// Compiled JS bundle of products/maka/ios-shell/app/Entry.tsx.
pub const IOS_SHELL_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/ios-shell.js"));

/// Construct the compiled iOS shell bundle with its explicit nsh/host capability
/// allowlist.
pub fn ios_bundle() -> Bundle {
    let mut capabilities = Capabilities::all();
    capabilities.host = ALLOWED_HOST_CALLS.iter().map(|&s| s.to_owned()).collect();
    Bundle::source(IOS_SHELL_JS.into()).with_policy(Policy {
        declared: Some(capabilities),
        ..Policy::development()
    })
}

/// Build an EngineConfig configured for the iOS shell (used by both the native
/// iOS entrypoint and headless host integration tests).
pub fn engine_config(host: HostChannel, runtime: tokio::runtime::Handle) -> EngineConfig {
    EngineConfig {
        header_heights: nsh_core::NO_NATIVE_HEADER,
        limits: Limits::standalone(),
        ui_sets: vec![nsh_base::registry()],
        network: Some(nsh_engine::net::network()),
        runtime: Some(runtime),
        host,
        ..EngineConfig::new(ios_bundle())
    }
}

/// Launch the standalone UIKit iOS application (runs until iOS terminates the app).
#[cfg(target_os = "ios")]
pub fn run() {
    use nsh_platform_ios::{AppOptions, AppSource, SurfaceOptions, run_app};

    let mut logging = nsh_platform_apple::unified_log::Options::default();
    logging.development = std::env::var_os("NSH_DEVELOPMENT").is_some();
    nsh_platform_apple::unified_log::install(logging);

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("start Maka iOS tokio runtime");

    let support_dir = SurfaceOptions::default()
        .support_dir
        .unwrap_or_else(|| std::env::temp_dir().join("maka-ios"))
        .join("maka-ios-shell");

    let host = HostChannel::new();
    let _bridge = HostBridge::attach(host.clone(), support_dir.clone(), runtime.handle().clone())
        .expect("attach Maka iOS native bridge");

    let options = AppOptions {
        runtime: Some(runtime.handle().clone()),
        support_dir: Some(support_dir),
        host,
        ..AppOptions::default()
    };

    run_app(AppSource::Bundle(ios_bundle()), options);
}
