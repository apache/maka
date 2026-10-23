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

//! Maka's workbench: the NSH application written in TSX (`app/`) and the
//! native Host bindings it runs against. The terminal and desktop shells
//! each run it in their own backend.

pub mod bindings;
pub mod host;
pub mod markdown;

use nsh_engine::{Bundle, EngineConfig, Limits, Policy};

/// Product code compiled from TSX; the caller supplies the native Host binding.
pub const APPLICATION: &str = include_str!(concat!(env!("OUT_DIR"), "/app.js"));

/// The application's imported assets, embedded with its JavaScript bundle.
pub struct ApplicationAssets;

impl nsh_engine::Assets for ApplicationAssets {
    fn read(&self, uri: &str) -> Result<Vec<u8>, String> {
        let assets: &[(&str, &[u8])] = include!(concat!(env!("OUT_DIR"), "/assets.rs"));
        assets
            .iter()
            .find(|(name, _)| *name == uri)
            .map(|(_, bytes)| bytes.to_vec())
            .ok_or_else(|| format!("Unknown bundled asset: {uri}"))
    }
}

/// The production bundle and its declared permissions, shared with native UI tests.
pub fn application_bundle() -> Bundle {
    let capabilities = nsh_core::access::Capabilities::from_json(&serde_json::json!({
        "clipboard": true,
        "network": {"http": [{"host":"*","methods":["GET"],"schemes":["http","https"]}]}
    }))
    .expect("static workbench application capabilities");
    Bundle::source(APPLICATION.into())
        .with_app_id(Some("org.apache.maka.terminal"))
        .with_policy(Policy {
            declared: Some(capabilities),
            ..Default::default()
        })
}

/// Runs the application with `registry` (the Host bindings') on `runtime`.
/// The backend sets the viewport and environment it presents in.
pub fn configuration(
    registry: nsh_core::ui::Registry,
    runtime: tokio::runtime::Handle,
) -> EngineConfig {
    EngineConfig {
        header_heights: nsh_core::NO_NATIVE_HEADER,
        // APPLICATION is compiled into this trusted executable; only the
        // interpreter stack is bounded, as for other standalone NSH apps.
        limits: Limits::standalone(),
        ui_sets: vec![nsh_base::registry(), registry, markdown::registry()],
        runtime: Some(runtime),
        ..EngineConfig::new(application_bundle())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn application_bundle_grants_image_gets_without_other_http_methods_or_sockets() {
        let access = application_bundle().policy.access();
        for url in [
            "http://127.0.0.1:1234/image.png",
            "https://images.example.test/a.png",
        ] {
            assert!(access.allows_media(url));
            assert!(access.allows_http("GET", url));
            assert!(!access.allows_http("POST", url));
            assert!(!access.allows_http("DELETE", url));
        }
        assert!(!access.allows_media("ftp://images.example.test/a.png"));
        assert!(!access.allows_http("GET", "wss://images.example.test/a.png"));
        assert!(!access.allows_socket("127.0.0.1", 1234));
        assert!(access.declared.clipboard);
    }
}
