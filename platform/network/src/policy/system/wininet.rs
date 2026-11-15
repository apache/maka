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

//! WinINet proxy-list and bypass-list semantics, shared by the per-user
//! settings and by WinHTTP's PAC/WPAD results.

use reqwest::Url;
use std::net::IpAddr;

/// `host:port` applies to every scheme; `http=a;https=b;socks=c` selects by
/// destination scheme, with `socks=` (SOCKS4 in WinINet) as the fallback. The
/// `https=` proxy is still reached over plain HTTP. A scheme with no entry
/// connects directly.
pub(super) fn select(list: &str, scheme: &str) -> Option<Url> {
    let entries: Vec<_> = list
        .split([';', ' ', '\t', '\r', '\n'])
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(|entry| match entry.split_once('=') {
            Some((protocol, address)) => (Some(protocol.trim().to_ascii_lowercase()), address),
            None => (None, entry),
        })
        .collect();
    let named = |wanted: &str| {
        entries
            .iter()
            .find(|(protocol, _)| protocol.as_deref() == Some(wanted))
            .map(|(_, address)| *address)
    };
    if let Some(address) = named(scheme) {
        return super::endpoint("http", address);
    }
    if let Some((_, address)) = entries.iter().find(|(protocol, _)| protocol.is_none()) {
        return (!address.eq_ignore_ascii_case("DIRECT"))
            .then(|| super::endpoint("http", address))
            .flatten();
    }
    named("socks").and_then(|address| super::endpoint("socks4", address))
}

/// `<local>` matches names without a dot. Other entries are
/// `[scheme://]host[:port]`, where the host may use `*` wildcards and is
/// compared case-insensitively; scheme and port restrict the match.
pub(super) fn bypassed(list: &str, target: &Url) -> bool {
    let host = target
        .host_str()
        .unwrap_or_default()
        .trim_matches(['[', ']'])
        .to_ascii_lowercase();
    let port = target.port_or_known_default();
    list.split([';', ' ', '\t', '\r', '\n'])
        .map(str::trim)
        .filter(|pattern| !pattern.is_empty())
        .any(|pattern| {
            if pattern.eq_ignore_ascii_case("<local>") {
                return !host.contains(['.', ':']);
            }
            let pattern = pattern.to_ascii_lowercase();
            let (scheme, rest) = match pattern.split_once("://") {
                Some((scheme, rest)) => (Some(scheme), rest),
                None => (None, pattern.as_str()),
            };
            let (pattern_host, pattern_port) = super::split_port(rest);
            let same_host = match (pattern_host.parse::<IpAddr>(), host.parse::<IpAddr>()) {
                (Ok(pattern), Ok(host)) => pattern == host,
                _ => wildcard(pattern_host.as_bytes(), host.as_bytes()),
            };
            scheme.is_none_or(|scheme| scheme == target.scheme())
                && pattern_port
                    .is_none_or(|wanted| wanted == "*" || wanted.parse::<u16>().ok() == port)
                && same_host
        })
}

/// Linear-time `*` matching, so a hostile pattern cannot stall routing.
fn wildcard(pattern: &[u8], text: &[u8]) -> bool {
    let (mut p, mut t) = (0, 0);
    let mut resume = None;
    while t < text.len() {
        if p < pattern.len() && pattern[p] == b'*' {
            resume = Some((p, t));
            p += 1;
        } else if p < pattern.len() && pattern[p] == text[t] {
            p += 1;
            t += 1;
        } else if let Some((star, matched)) = resume {
            p = star + 1;
            t = matched + 1;
            resume = Some((star, matched + 1));
        } else {
            return false;
        }
    }
    pattern[p..].iter().all(|byte| *byte == b'*')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn selected(list: &str, scheme: &str) -> Option<String> {
        select(list, scheme).map(String::from)
    }

    #[test]
    fn proxy_lists_select_by_destination_scheme() {
        assert_eq!(
            selected("127.0.0.1:7897", "https").as_deref(),
            Some("http://127.0.0.1:7897/")
        );
        let list = "http=10.0.0.1:8080;https=10.0.0.2:443;socks=10.0.0.3:1080";
        assert_eq!(
            selected(list, "http").as_deref(),
            Some("http://10.0.0.1:8080/")
        );
        assert_eq!(
            selected(list, "https").as_deref(),
            Some("http://10.0.0.2:443/")
        );
        assert_eq!(
            selected("http=10.0.0.1:8080;socks=10.0.0.3:1080", "https").as_deref(),
            Some("socks4://10.0.0.3:1080")
        );
        assert_eq!(selected("http=10.0.0.1:8080", "https"), None);
        assert_eq!(
            selected("HTTPS=http://10.0.0.2:443", "https").as_deref(),
            Some("http://10.0.0.2:443/")
        );
        // WinHTTP PAC results list alternates; the first one wins.
        assert_eq!(
            selected("10.0.0.4:3128; 10.0.0.5:3128", "https").as_deref(),
            Some("http://10.0.0.4:3128/")
        );
        assert_eq!(selected("DIRECT", "https"), None);
        assert_eq!(selected("", "https"), None);
    }

    #[test]
    fn bypass_lists_follow_wininet_patterns() {
        let bypassed = |list: &str, url: &str| bypassed(list, &Url::parse(url).unwrap());
        let list = "<local>;*.corp.example; 10.*;192.168.1.*;*internal*";
        for host in [
            "intranet",
            "a.corp.example",
            "10.1.2.3",
            "192.168.1.20",
            "my-internal-host.example",
            "A.CORP.EXAMPLE",
        ] {
            assert!(bypassed(list, &format!("https://{host}/")), "{host}");
        }
        for host in [
            "corp.example",
            "100.1.2.3",
            "192.168.2.1",
            "example.com",
            "[fd00::1]",
        ] {
            assert!(!bypassed(list, &format!("https://{host}/")), "{host}");
        }
    }

    #[test]
    fn bypass_entries_keep_their_scheme_port_and_ipv6_scope() {
        let bypassed = |list: &str, url: &str| bypassed(list, &Url::parse(url).unwrap());
        assert!(bypassed(
            "https://api.corp.example",
            "https://api.corp.example/"
        ));
        assert!(!bypassed(
            "https://api.corp.example",
            "http://api.corp.example/"
        ));
        assert!(bypassed(
            "api.corp.example:8443",
            "https://api.corp.example:8443/"
        ));
        assert!(!bypassed(
            "api.corp.example:8443",
            "https://api.corp.example/"
        ));
        assert!(bypassed("[fd00::1]", "https://[fd00::1]/"));
        assert!(bypassed("[fd00:0:0:0:0:0:0:1]", "https://[fd00::1]/"));
        assert!(bypassed("fd00::1", "https://[fd00::1]/"));
        assert!(bypassed("[fd00::1]:443", "https://[fd00::1]/"));
        assert!(!bypassed("[fd00::1]:8443", "https://[fd00::1]/"));
        assert!(!bypassed(
            "*a*a*a*a*a*a*a*a*b",
            &format!("https://{}/", "a".repeat(60))
        ));
    }
}
