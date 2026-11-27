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

mod attachments;
pub mod bridge;
mod identity;
#[cfg(any(target_os = "ios", test))]
mod scanner;

use nsh_engine::{Bundle, Capabilities, EngineConfig, HostChannel, Limits, Policy};

pub const IOS_SHELL_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/ios-shell.js"));

pub fn ios_bundle() -> Bundle {
    let mut caps = Capabilities::default();
    caps.clipboard = true;
    caps.picker = true;
    caps.status_bar = true;
    let mut open_url = nsh_core::access::OpenUrlGrant::default();
    open_url.schemes.push("https".into());
    caps.open_url = Some(open_url);
    caps.host = bridge::ALLOWED_HOST_CALLS
        .iter()
        .map(|name| (*name).to_owned())
        .collect();
    Bundle::source(IOS_SHELL_JS.into())
        .with_url_schemes(["maka"])
        .with_policy(Policy {
            declared: Some(caps),
            ..Policy::default()
        })
}

fn ui_sets(bridge: Option<&bridge::HostBridge>) -> Vec<nsh_core::element::Registry> {
    vec![
        nsh_base::registry(),
        attachments::registry(bridge.map(bridge::HostBridge::attachment_host)),
    ]
}

pub fn engine_config(host: HostChannel, runtime: tokio::runtime::Handle) -> EngineConfig {
    shell_config(host, runtime, None)
}

pub fn engine_config_with_bridge(
    host: HostChannel,
    runtime: tokio::runtime::Handle,
    bridge: &bridge::HostBridge,
) -> EngineConfig {
    shell_config(host, runtime, Some(bridge))
}

fn shell_config(
    host: HostChannel,
    runtime: tokio::runtime::Handle,
    bridge: Option<&bridge::HostBridge>,
) -> EngineConfig {
    EngineConfig {
        header_heights: nsh_core::NO_NATIVE_HEADER,
        limits: Limits::standalone(),
        ui_sets: ui_sets(bridge),
        runtime: Some(runtime),
        host,
        ..EngineConfig::new(ios_bundle())
    }
}

#[cfg(target_os = "ios")]
pub fn run() {
    use nsh_platform_ios::{AppOptions, AppSource, run_app};
    nsh_platform_apple::unified_log::install(Default::default());
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("start iOS shell runtime");
    let support_dir = std::env::var_os("MAKA_IOS_SUPPORT_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            nsh_engine::support_dir()
                .expect("iOS Application Support")
                .join("Maka")
        });
    let host = HostChannel::new();
    let bridge =
        bridge::HostBridge::attach(host.clone(), support_dir.clone(), runtime.handle().clone())
            .expect("start iOS Host bridge");
    if let Ok(uri) = std::env::var("MAKA_IOS_PAIR_URI") {
        bridge.queue_pairing_uri(uri);
    }
    nsh_platform_ios::set_ui_sets(ui_sets(Some(&bridge)));
    nsh_platform_ios::set_components(scanner::register);
    run_app(
        AppSource::Bundle(ios_bundle()),
        AppOptions {
            host,
            runtime: Some(runtime.handle().clone()),
            support_dir: Some(support_dir),
            ..AppOptions::default()
        },
    );
}
