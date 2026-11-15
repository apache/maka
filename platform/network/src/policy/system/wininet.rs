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

/// `host:port` applies to every scheme; `http=a;https=b;socks=c` selects by
/// destination scheme, with `socks=` as the fallback. The `https=` proxy is
/// still reached over plain HTTP. A scheme with no entry connects directly.
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
    named("socks").and_then(|address| super::endpoint("socks5h", address))
}

/// `<local>` matches names without a dot; other entries are `*` wildcards
/// matched case-insensitively against the host.
pub(super) fn bypassed(list: &str, host: &str) -> bool {
    let host = host.trim_matches(['[', ']']).to_ascii_lowercase();
    list.split([';', ' ', '\t', '\r', '\n'])
        .map(str::trim)
        .filter(|pattern| !pattern.is_empty())
        .any(|pattern| {
            if pattern.eq_ignore_ascii_case("<local>") {
                return !host.contains(['.', ':']);
            }
            let pattern = pattern
                .split_once("://")
                .map_or(pattern, |(_, rest)| rest)
                .to_ascii_lowercase();
            wildcard(pattern.as_bytes(), host.as_bytes())
        })
}

fn wildcard(pattern: &[u8], text: &[u8]) -> bool {
    match pattern.split_first() {
        None => text.is_empty(),
        Some((b'*', rest)) => (0..=text.len()).any(|skip| wildcard(rest, &text[skip..])),
        Some((first, rest)) => text
            .split_first()
            .is_some_and(|(head, tail)| head == first && wildcard(rest, tail)),
    }
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
            Some("socks5h://10.0.0.3:1080")
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
        let list = "<local>;*.corp.example; 10.*;192.168.1.*;*internal*";
        for host in [
            "intranet",
            "a.corp.example",
            "10.1.2.3",
            "192.168.1.20",
            "my-internal-host.example",
            "A.CORP.EXAMPLE",
        ] {
            assert!(bypassed(list, host), "{host}");
        }
        for host in [
            "corp.example",
            "100.1.2.3",
            "192.168.2.1",
            "example.com",
            "[fd00::1]",
        ] {
            assert!(!bypassed(list, host), "{host}");
        }
    }
}
