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
use hyper_util::client::proxy::matcher::Matcher;
use reqwest::Url;
use std::env::VarError;

#[derive(Clone, PartialEq, Eq, Hash)]
pub(super) struct Environment {
    http: Option<Url>,
    https: Option<Url>,
    no_proxy: String,
}

impl Environment {
    pub(super) fn capture(
        mut read: impl FnMut(&str) -> Result<String, VarError>,
    ) -> Result<Self, Error> {
        // HTTP_PROXY can be an untrusted request header in CGI. Ignore both
        // spellings there, including on Windows where names are case-insensitive.
        let cgi = !matches!(read("REQUEST_METHOD"), Err(VarError::NotPresent));
        let mut get = |upper, lower| match read(upper) {
            Ok(value) => Ok(value),
            Err(VarError::NotPresent) => match read(lower) {
                Ok(value) => Ok(value),
                Err(VarError::NotPresent) => Ok(String::new()),
                Err(_) => Err(Error::InvalidProxy),
            },
            Err(_) => Err(Error::InvalidProxy),
        };
        let all = get("ALL_PROXY", "all_proxy")?;
        let http = if cgi {
            String::new()
        } else {
            get("HTTP_PROXY", "http_proxy")?
        };
        let https = get("HTTPS_PROXY", "https_proxy")?;
        Ok(Self {
            http: parse(if http.trim().is_empty() { &all } else { &http })?,
            https: parse(if https.trim().is_empty() {
                &all
            } else {
                &https
            })?,
            no_proxy: get("NO_PROXY", "no_proxy")?,
        })
    }

    pub(super) fn is_empty(&self) -> bool {
        self.http.is_none() && self.https.is_none()
    }

    pub(super) fn proxy_for(&self, scheme: &str, host: &str) -> Option<&Url> {
        let proxy = match scheme {
            "http" => self.http.as_ref()?,
            "https" => self.https.as_ref()?,
            _ => return None,
        };
        let host = host.trim_matches(['[', ']']);
        let host = if host.contains(':') {
            format!("[{host}]")
        } else {
            host.to_owned()
        };
        let destination = format!("{scheme}://{host}/").parse().ok()?;
        // Reuse the transport's domain/IPv4/IPv6/CIDR NO_PROXY semantics for
        // both HTTP and CONNECT, without consulting ambient state again.
        Matcher::builder()
            .all(proxy.as_str())
            .no(self.no_proxy.as_str())
            .build()
            .intercept(&destination)
            .map(|_| proxy)
    }
}

pub(super) fn parse(raw: &str) -> Result<Option<Url>, Error> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(None);
    }
    if raw.chars().any(char::is_control) {
        return Err(Error::InvalidProxy);
    }
    let mut url = Url::parse(&if raw.contains("://") {
        raw.to_owned()
    } else {
        format!("http://{raw}")
    })
    .map_err(|_| Error::InvalidProxy)?;
    if !matches!(
        url.scheme(),
        "http" | "https" | "socks4" | "socks5" | "socks5h"
    ) || url.host_str().is_none()
        || !matches!(url.path(), "" | "/")
        || url.query().is_some()
        || url.fragment().is_some()
        || url.port() == Some(0)
    {
        return Err(Error::InvalidProxy);
    }
    if matches!(url.scheme(), "socks4" | "socks5" | "socks5h") && url.port().is_none() {
        url.set_port(Some(1080)).map_err(|_| Error::InvalidProxy)?;
    }
    // Matcher intentionally ignores malformed input. Reject it here instead of
    // silently turning a configured proxy into a direct connection.
    if Matcher::builder()
        .all(url.as_str())
        .build()
        .intercept(&"https://validation.invalid/".parse().expect("static URI"))
        .is_none()
    {
        return Err(Error::InvalidProxy);
    }
    Ok(Some(url))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn capture(values: &[(&str, &str)]) -> Environment {
        Environment::capture(|key| {
            values
                .iter()
                .find(|(name, _)| *name == key)
                .map(|(_, value)| value.to_string())
                .ok_or(VarError::NotPresent)
        })
        .unwrap()
    }

    #[test]
    fn environment_precedence_and_bypass_cover_both_transports() {
        let env = capture(&[
            ("HTTP_PROXY", "http://user:secret@upper:81"),
            ("http_proxy", "http://lower:82"),
            ("ALL_PROXY", "socks5h://fallback:83"),
            ("NO_PROXY", " .example.com,10.0.0.0/8,::1,fd00::/8 "),
        ]);
        assert_eq!(
            env.proxy_for("http", "remote.invalid").unwrap().host_str(),
            Some("upper")
        );
        assert_eq!(
            env.proxy_for("https", "remote.invalid").unwrap().host_str(),
            Some("fallback")
        );
        for scheme in ["http", "https"] {
            for host in [
                "example.com",
                "a.example.com",
                "10.10.0.71",
                "[::1]",
                "fd00::1234",
            ] {
                assert!(env.proxy_for(scheme, host).is_none(), "{scheme} {host}");
            }
            for host in [
                "notexample.com",
                "example.com.evil",
                "100.10.0.71",
                "fe80::1",
            ] {
                assert!(env.proxy_for(scheme, host).is_some(), "{scheme} {host}");
            }
        }
        let cgi = capture(&[
            ("REQUEST_METHOD", "GET"),
            ("HTTP_PROXY", "invalid://header"),
            ("http_proxy", "lower:82"),
        ]);
        assert!(cgi.proxy_for("http", "remote.invalid").is_none());
        assert!(cgi.proxy_for("https", "remote.invalid").is_none());
        let direct = capture(&[("ALL_PROXY", "proxy:80"), ("no_proxy", "*")]);
        assert!(direct.proxy_for("https", "remote.invalid").is_none());
    }

    #[test]
    fn invalid_proxy_is_not_silently_direct_and_errors_never_echo_credentials() {
        for raw in [
            "socks4a://user:secret@proxy",
            "http://proxy:0",
            "http://proxy/path",
            "http://proxy/?secret",
            "http://proxy/#secret",
            "http://pro\nxy",
            "http://",
        ] {
            let error = match parse(raw) {
                Err(error) => error,
                Ok(_) => panic!("invalid proxy accepted"),
            };
            assert_eq!(error.to_string(), "invalid network proxy configuration");
        }
        for raw in [
            "proxy:8080",
            "https://user:secret@proxy",
            "socks4://proxy",
            "socks5://proxy",
            "socks5h://[::1]:1080",
        ] {
            assert!(parse(raw).unwrap().is_some());
        }
    }

    #[tokio::test]
    async fn socks5_connect_resolves_locally_instead_of_sending_a_domain() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("socks5://{}", listener.local_addr().unwrap());
            let policy = super::super::Policy(Some(std::sync::Arc::new(
                super::super::Route::Environment(capture(&[("ALL_PROXY", &url)])),
            )));
            let server = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                assert_eq!(stream.read_u8().await.unwrap(), 5);
                let mut methods = vec![0; stream.read_u8().await.unwrap() as usize];
                stream.read_exact(&mut methods).await.unwrap();
                assert!(methods.contains(&0));
                stream.write_all(&[5, 0]).await.unwrap();
                let mut head = [0; 4];
                stream.read_exact(&mut head).await.unwrap();
                assert_eq!(&head[..3], &[5, 1, 0]);
                let mut ip = vec![
                    0;
                    match head[3] {
                        1 => 4,
                        4 => 16,
                        _ => panic!("SOCKS5 must send a locally resolved IP"),
                    }
                ];
                stream.read_exact(&mut ip).await.unwrap();
                assert_eq!(stream.read_u16().await.unwrap(), 8443);
                stream
                    .write_all(&[5, 0, 0, 1, 127, 0, 0, 1, 0, 0])
                    .await
                    .unwrap();
                stream.write_all(b"ready").await.unwrap();
            });
            let destination = maka_sandbox::Destination::new("localhost", 8443).unwrap();
            let mut stream = crate::tunnel::connect(&policy, &destination).await.unwrap();
            let mut bytes = [0; 5];
            stream.read_exact(&mut bytes).await.unwrap();
            assert_eq!(&bytes, b"ready");
            server.await.unwrap();
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn socks4_connect_sends_a_locally_resolved_ipv4_address() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("socks4://{}", listener.local_addr().unwrap());
            let policy = super::super::Policy(Some(std::sync::Arc::new(
                super::super::Route::Environment(capture(&[("ALL_PROXY", &url)])),
            )));
            let server = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut head = [0; 8];
                stream.read_exact(&mut head).await.unwrap();
                assert_eq!(&head[..2], &[4, 1]);
                assert_eq!(u16::from_be_bytes([head[2], head[3]]), 8443);
                assert_eq!(&head[4..], &[127, 0, 0, 1]);
                assert_eq!(stream.read_u8().await.unwrap(), 0);
                stream.write_all(&[0, 90, 0, 0, 0, 0, 0, 0]).await.unwrap();
                stream.write_all(b"ready").await.unwrap();
            });
            let destination = maka_sandbox::Destination::new("localhost", 8443).unwrap();
            let mut stream = crate::tunnel::connect(&policy, &destination).await.unwrap();
            let mut bytes = [0; 5];
            stream.read_exact(&mut bytes).await.unwrap();
            assert_eq!(&bytes, b"ready");
            server.await.unwrap();
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn socks4_http_skips_ipv6_results_listed_first() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("socks4://{}", listener.local_addr().unwrap());
            let policy = super::super::Policy(Some(std::sync::Arc::new(
                super::super::Route::Environment(capture(&[("ALL_PROXY", &url)])),
            )));
            let server = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut head = [0; 8];
                stream.read_exact(&mut head).await.unwrap();
                assert_eq!(&head[..4], &[4, 1, 0x20, 0xfb]);
                assert_eq!(&head[4..], &[127, 0, 0, 1], "SOCKS4 needs the IPv4 result");
                while stream.read_u8().await.unwrap() != 0 {}
                stream.write_all(&[0, 90, 0, 0, 0, 0, 0, 0]).await.unwrap();
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") {
                    request.push(stream.read_u8().await.unwrap());
                }
                stream
                    .write_all(b"HTTP/1.1 204 No Content\r\nconnection: close\r\n\r\n")
                    .await
                    .unwrap();
            });
            let client = policy
                .client_builder()
                .resolve_to_addrs(
                    "dual.test",
                    &[
                        "[::1]:8443".parse().unwrap(),
                        "127.0.0.1:8443".parse().unwrap(),
                    ],
                )
                .build()
                .unwrap();
            let response = client.get("http://dual.test:8443/").send().await.unwrap();
            assert_eq!(response.status(), 204);
            server.await.unwrap();
        })
        .await
        .unwrap();
    }
}
