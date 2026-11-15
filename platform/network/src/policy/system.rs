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

//! The operating system's proxy configuration. macOS and Windows resolve each
//! destination through their own resolvers (exceptions, PAC and WPAD included);
//! Linux has no OS resolver, so the desktop's settings are the authority.

use crate::Error;
use reqwest::Url;
use std::{net::IpAddr, sync::Arc};

// The Linux and WinINet rules are plain parsing, so every host tests them.
#[cfg(any(target_os = "linux", test))]
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;
#[cfg(any(windows, test))]
mod wininet;

#[cfg(target_os = "linux")]
use linux as platform;
#[cfg(target_os = "macos")]
use macos as platform;
#[cfg(windows)]
use windows as platform;
#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
mod platform {
    #[derive(PartialEq, Eq, Hash)]
    pub(super) enum Config {}
    pub(super) fn capture() -> Result<Option<Config>, crate::Error> {
        Ok(None)
    }
    pub(super) fn resolve(config: &Config, _: &reqwest::Url) -> Option<reqwest::Url> {
        match *config {}
    }
}

/// Equality is the captured configuration, so routes reuse TLS and gateway
/// state exactly while the system settings are unchanged.
#[derive(Clone, PartialEq, Eq, Hash)]
pub(super) struct System(Arc<platform::Config>);

impl System {
    /// `None` when the platform has no proxy configuration to consult.
    pub(super) fn capture() -> Result<Option<Self>, Error> {
        Ok(blocking(platform::capture)?.map(|config| Self(Arc::new(config))))
    }

    pub(super) fn proxy_for(&self, scheme: &str, host: &str, port: u16) -> Option<Url> {
        let host = host.trim_matches(['[', ']']);
        if is_loopback(host) {
            return None;
        }
        let host = if host.contains(':') {
            format!("[{host}]")
        } else {
            host.to_owned()
        };
        let target = Url::parse(&format!("{scheme}://{host}:{port}/")).ok()?;
        // The platform resolvers cache PAC scripts and results themselves.
        blocking(|| platform::resolve(&self.0, &target))
    }
}

/// PAC downloads, WPAD discovery and desktop queries may block; keep them off
/// the async worker that polls the connection.
fn blocking<T>(work: impl FnOnce() -> T) -> T {
    match tokio::runtime::Handle::try_current() {
        Ok(runtime) if runtime.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread => {
            tokio::task::block_in_place(work)
        }
        _ => work(),
    }
}

/// Browsers never send loopback traffic to a system proxy, whatever its
/// exception list says; local model servers and MCP endpoints rely on that.
fn is_loopback(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    host == "localhost"
        || host.ends_with(".localhost")
        || host.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

/// Proxy endpoint reported by the platform. `scheme` names the protocol spoken
/// to the proxy itself, not the destination's scheme.
fn endpoint(scheme: &str, address: &str) -> Option<Url> {
    let address = address.trim();
    let address = address
        .split_once("://")
        .map_or(address, |(_, rest)| rest)
        .trim_end_matches('/');
    if address.is_empty() {
        return None;
    }
    super::environment::parse(&format!("{scheme}://{address}"))
        .ok()
        .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_is_never_proxied() {
        for host in [
            "localhost",
            "LOCALHOST.",
            "api.localhost",
            "127.0.0.1",
            "127.8.9.10",
            "::1",
        ] {
            assert!(is_loopback(host), "{host}");
        }
        for host in ["localhost.example.com", "10.0.0.1", "::2", "example.com"] {
            assert!(!is_loopback(host), "{host}");
        }
    }

    #[test]
    fn endpoint_names_the_protocol_spoken_to_the_proxy() {
        assert_eq!(
            endpoint("http", "https://proxy.example:8443/")
                .unwrap()
                .as_str(),
            "http://proxy.example:8443/"
        );
        assert_eq!(
            endpoint("socks5h", "127.0.0.1:7897").unwrap().as_str(),
            "socks5h://127.0.0.1:7897"
        );
        assert!(endpoint("http", " ").is_none());
        assert!(endpoint("http", "proxy:0").is_none());
    }
}
