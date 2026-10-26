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

use crate::Error;
use maka_agent_facts::configuration::policy::NetworkProxy;
use maka_agent_facts::configuration::policy::ProxyProtocol;
use reqwest::{ClientBuilder, Proxy, Url};
use std::{
    net::{Ipv4Addr, Ipv6Addr},
    sync::Arc,
    time::Duration,
};

mod environment;
use environment::Environment;

/// Secret-bearing immutable routing snapshot. No Debug or serialization:
/// configuration/vault own persistence, not transport or conversation logs.
#[derive(Clone, Default, PartialEq, Eq, Hash)]
pub struct Policy(Option<Arc<Route>>);

#[derive(Clone, PartialEq, Eq, Hash)]
enum Route {
    Manual(ProxyRoute),
    Environment(Environment),
}

#[derive(Clone, PartialEq, Eq, Hash)]
struct ProxyRoute {
    url: Url,
    bypass: Vec<String>,
}

impl Policy {
    pub(crate) fn proxy_for(&self, scheme: &str, host: &str) -> Option<&Url> {
        match self.0.as_deref()? {
            Route::Manual(route) => (!bypasses(host, &route.bypass)).then_some(&route.url),
            Route::Environment(route) => route.proxy_for(scheme, host),
        }
    }

    /// Check the finite header fields owned by our configured HTTP stack.
    /// This is conservative physical representation admission, without changing
    /// caller values, default precedence or proxy authentication behavior.
    pub fn check_request_headers(
        &self,
        url: &Url,
        headers: &reqwest::header::HeaderMap,
        has_body: bool,
        follows_redirects: bool,
    ) -> Result<(), Error> {
        use reqwest::header::{
            ACCEPT, ACCEPT_ENCODING, AUTHORIZATION, CONTENT_LENGTH, HOST, HeaderValue,
            PROXY_AUTHORIZATION, REFERER, TRANSFER_ENCODING,
        };
        let mut fields = vec![ACCEPT, ACCEPT_ENCODING, HOST];
        if has_body {
            fields.extend([TRANSFER_ENCODING, CONTENT_LENGTH]);
        }
        if follows_redirects {
            fields.push(REFERER);
        }
        if !url.username().is_empty() || url.password().is_some() {
            fields.push(AUTHORIZATION);
        }
        if url.scheme() == "http"
            && self
                .proxy_for(url.scheme(), url.host_str().unwrap_or_default())
                .is_some_and(|proxy| {
                    matches!(proxy.scheme(), "http" | "https")
                        && (!proxy.username().is_empty() || proxy.password().is_some())
                })
        {
            fields.push(PROXY_AUTHORIZATION);
        }
        let mut complete = headers.clone();
        for field in fields {
            if !complete.contains_key(&field) {
                complete
                    .try_insert(field, HeaderValue::from_static(""))
                    .map_err(|_| Error::InvalidHeaders)?;
            }
        }
        // Pinned HeaderMap::entry reserves before lookup, including occupied
        // entries used by reqwest defaults, decompression and HTTP/1 Host.
        complete.try_reserve(1).map_err(|_| Error::InvalidHeaders)?;
        Ok(())
    }

    /// Host routing: an enabled manual proxy wins; otherwise capture the Host's
    /// environment. Credentials stay in this immutable, non-serializable value.
    pub fn from_host_settings(
        settings: &NetworkProxy,
        password: Option<&str>,
    ) -> Result<Self, Error> {
        if settings.enabled {
            Self::from_settings(settings, password)
        } else {
            let route = Environment::capture(|name| std::env::var(name))?;
            Ok(Self(Some(Arc::new(Route::Environment(route)))))
        }
    }
    pub fn from_settings(settings: &NetworkProxy, password: Option<&str>) -> Result<Self, Error> {
        if !settings.enabled {
            return Ok(Self::default());
        }
        let scheme = match settings.protocol {
            ProxyProtocol::Http => "http",
            ProxyProtocol::Https => "https",
            // Both HTTP and WS let the proxy resolve the destination hostname.
            ProxyProtocol::Socks5 => "socks5h",
        };
        let host = settings.host.trim();
        let host = if host.parse::<Ipv6Addr>().is_ok() {
            format!("[{host}]")
        } else {
            host.to_owned()
        };
        let mut url = Url::parse(&format!("{scheme}://{host}:{}/", settings.port))
            .map_err(|_| Error::InvalidProxy)?;
        if settings.port == 0
            || url.host_str().is_none()
            || url.path() != "/"
            || url.query().is_some()
            || url.fragment().is_some()
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err(Error::InvalidProxy);
        }
        if settings.auth_enabled {
            let password = password.ok_or(Error::MissingCredentials)?;
            if settings.username.is_empty() {
                return Err(Error::MissingCredentials);
            }
            url.set_username(&settings.username)
                .map_err(|_| Error::InvalidProxy)?;
            url.set_password(Some(password))
                .map_err(|_| Error::InvalidProxy)?;
        }
        Ok(Self(Some(Arc::new(Route::Manual(ProxyRoute {
            url,
            bypass: settings
                .bypass_list
                .iter()
                .chain(&settings.auto_bypass_domains)
                .cloned()
                .collect(),
        })))))
    }

    /// The same redirect authority used by the reqwest policy. Streaming
    /// transports reopen a source themselves only after this check and drain.
    pub fn follow_redirect(
        &self,
        original: &Url,
        next: &Url,
        previous_count: usize,
    ) -> Result<bool, Error> {
        redirect_allowed(original, next, previous_count)
    }

    /// Captured routing, independent of subsequent environment changes. Redirects
    /// retain authority only within the same origin and therefore the same route.
    pub fn client_builder(&self) -> ClientBuilder {
        let mut builder = reqwest::Client::builder()
            .no_proxy()
            .retry(reqwest::retry::never())
            .connect_timeout(Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::custom(
                |attempt| match redirect_allowed(
                    attempt.previous().first().unwrap_or(attempt.url()),
                    attempt.url(),
                    attempt.previous().len(),
                ) {
                    Ok(true) => attempt.follow(),
                    Ok(false) => attempt.stop(),
                    Err(error) => attempt.error(error),
                },
            ));
        if self.0.is_some() {
            let policy = self.clone();
            builder = builder.proxy(Proxy::custom(move |url| {
                policy
                    .proxy_for(url.scheme(), url.host_str().unwrap_or_default())
                    .cloned()
            }));
        }
        builder
    }
}

fn redirect_allowed(original: &Url, next: &Url, previous_count: usize) -> Result<bool, Error> {
    if previous_count >= 20 {
        Err(Error::RedirectLimit)
    } else {
        Ok(original.origin() == next.origin())
    }
}

fn bypasses(host: &str, patterns: &[String]) -> bool {
    let host = host.trim_matches(['[', ']']).to_lowercase();
    patterns.iter().any(|raw| {
        let pattern = raw.trim().to_lowercase();
        if pattern.is_empty() {
            return false;
        }
        if pattern == "*" || pattern.trim_matches(['[', ']']) == host {
            return true;
        }
        if let Some(suffix) = pattern.strip_prefix("*.") {
            return host.ends_with(&format!(".{suffix}"));
        }
        if let Some(prefix) = pattern.strip_suffix(".*") {
            return host.starts_with(&format!("{prefix}."));
        }
        let Some((base, prefix)) = pattern.split_once('/') else {
            return false;
        };
        if prefix.is_empty() || !prefix.bytes().all(|byte| byte.is_ascii_digit()) {
            return false;
        }
        let (Ok(host), Ok(base), Ok(prefix)) = (
            host.parse::<Ipv4Addr>(),
            base.parse::<Ipv4Addr>(),
            prefix.parse::<u32>(),
        ) else {
            return false;
        };
        if prefix > 32 {
            return false;
        }
        let mask = u32::MAX.checked_shl(32 - prefix).unwrap_or(0);
        u32::from(host) & mask == u32::from(base) & mask
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn generated_request_fields_are_checked_without_changing_header_precedence() {
        use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
        let policy = Policy::default();
        let url = Url::parse("https://example.com/").unwrap();
        let headers = HeaderMap::from_iter([(
            reqwest::header::ACCEPT,
            HeaderValue::from_static("application/custom"),
        )]);
        let original = headers.clone();
        policy
            .check_request_headers(&url, &headers, true, true)
            .unwrap();
        assert_eq!(headers, original);
        assert_eq!(headers[reqwest::header::ACCEPT], "application/custom");
        let mut full = HeaderMap::new();
        for field in [
            "accept",
            "accept-encoding",
            "host",
            "transfer-encoding",
            "content-length",
            "referer",
            "authorization",
        ] {
            full.try_insert(field, HeaderValue::from_static("kept"))
                .unwrap();
        }
        for index in 0..32_768 {
            if full
                .try_insert(
                    HeaderName::from_bytes(format!("x-field-{index}").as_bytes()).unwrap(),
                    HeaderValue::from_static("kept"),
                )
                .is_err()
            {
                break;
            }
        }
        assert!(matches!(
            policy.check_request_headers(&url, &full, true, true),
            Err(Error::InvalidHeaders)
        ));
    }

    #[test]
    fn bypass_patterns_do_not_expand_destination_authority() {
        let cases = [
            ("a.example.com", "*.example.com", true),
            ("example.com", "*.example.com", false),
            ("a.example.com", "example.com", false),
            ("example.com.evil", "*.example.com", false),
            ("10.2.3.4", "10.*", true),
            ("100.2.3.4", "10.*", false),
            ("192.168.1.42", "192.168.1.0/24", true),
            ("192.168.2.42", "192.168.1.0/24", false),
            ("192.168.2.42", "192.168.1.0/33", false),
            ("127.0.0.1", "0.0.0.0/0", true),
            ("[::1]", "::1", true),
            ("EXAMPLE.com", " example.COM ", true),
        ];
        for (host, pattern, expected) in cases {
            assert_eq!(
                bypasses(host, &[pattern.into()]),
                expected,
                "{host} {pattern}"
            );
        }
    }
}
