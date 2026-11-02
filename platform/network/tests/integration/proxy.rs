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

use futures_util::{FutureExt, SinkExt, StreamExt};
use maka_agent_facts::configuration::policy::NetworkProxy;
use maka_agent_facts::configuration::policy::ProxyProtocol;
use maka_agent_facts::configuration::policy::RuntimePolicy;
use maka_network::{Policy, connect_websocket};
use reqwest::header::{AUTHORIZATION, HeaderMap, HeaderValue};
use std::time::Duration;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};
use tokio_tungstenite::{
    accept_hdr_async,
    tungstenite::{
        Message,
        handshake::server::{Request, Response},
    },
};

async fn socks(socket: &mut TcpStream) {
    let mut hello = [0; 2];
    socket.read_exact(&mut hello).await.unwrap();
    assert_eq!(hello[0], 5);
    let mut methods = vec![0; hello[1] as usize];
    socket.read_exact(&mut methods).await.unwrap();
    assert!(methods.contains(&2));
    socket.write_all(&[5, 2]).await.unwrap();
    assert_eq!(socket.read_u8().await.unwrap(), 1);
    assert_eq!(short_string(socket).await, "user");
    assert_eq!(short_string(socket).await, "secret");
    socket.write_all(&[1, 0]).await.unwrap();
    let mut command = [0; 4];
    socket.read_exact(&mut command).await.unwrap();
    assert_eq!(
        command,
        [5, 1, 0, 3],
        "destination DNS must remain with the proxy"
    );
    assert_eq!(short_string(socket).await, "models.maka.invalid");
    assert_eq!(socket.read_u16().await.unwrap(), 80);
    socket
        .write_all(&[5, 0, 0, 1, 127, 0, 0, 1, 0, 0])
        .await
        .unwrap();
}
async fn short_string(socket: &mut TcpStream) -> String {
    let len = socket.read_u8().await.unwrap() as usize;
    let mut value = vec![0; len];
    socket.read_exact(&mut value).await.unwrap();
    String::from_utf8(value).unwrap()
}
#[tokio::test]
async fn diagnostic_forces_proxy_bounds_bodies_and_covers_headers_and_body_with_one_deadline() {
    for (response, expected_ok, expected_error) in [
        (
            Some("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n".to_owned()),
            true,
            None,
        ),
        (
            Some(
                "HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n"
                    .to_owned(),
            ),
            false,
            Some("HTTP 407"),
        ),
        (
            Some(format!(
                "HTTP/1.1 200 OK\r\nContent-Length: 2048\r\n\r\n{}",
                "x".repeat(2048)
            )),
            false,
            Some("exceeds limit"),
        ),
        (None, false, Some("timeout")),
        (
            Some("HTTP/1.1 200 OK\r\nContent-Length: 12\r\n\r\n203.0.113.1\n".to_owned()),
            true,
            None,
        ),
        (
            Some("HTTP/1.1 200 OK\r\nContent-Length: 20\r\n\r\n".to_owned()),
            false,
            Some("timeout"),
        ),
    ] {
        let lookup = response
            .as_ref()
            .is_some_and(|s| s.ends_with("203.0.113.1\n"));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut config = settings(ProxyProtocol::Http, listener.local_addr().unwrap().port());
        config.bypass_list = vec!["*".into()];
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let head = headers(&mut socket).await;
            assert!(head.starts_with("get http://models.maka.invalid/probe "));
            assert!(head.contains("proxy-authorization: basic dxnlcjpzzwnyzxq="));
            if let Some(response) = response {
                let _ = socket.write_all(response.as_bytes()).await;
            }
            // A completed, timed-out or rejected diagnostic must release its socket.
            let mut remainder = Vec::new();
            tokio::time::timeout(Duration::from_secs(3), socket.read_to_end(&mut remainder))
                .await
                .expect("probe socket released")
                .unwrap();
            assert!(remainder.is_empty());
            if lookup {
                let (mut country, _) = listener.accept().await.unwrap();
                let head = headers(&mut country).await;
                assert!(head.starts_with("connect api.country.is:443 "));
                assert!(head.contains("proxy-authorization: basic dxnlcjpzzwnyzxq="));
                // Optional country lookup shares the deadline and cannot retain a tunnel.
                tokio::time::timeout(Duration::from_secs(3), country.read_to_end(&mut remainder))
                    .await
                    .expect("country socket released")
                    .unwrap();
                assert!(remainder.is_empty());
            }
        });
        let started = std::time::Instant::now();
        let result = maka_network::probe(
            &config,
            Some("secret"),
            Some("http://models.maka.invalid/probe"),
            Some(300),
        )
        .await;
        assert_eq!(result.ok, expected_ok, "{result:?}");
        if lookup {
            assert_eq!(result.ip.as_deref(), Some("203.0.113.1"));
            assert!(result.country_code.is_none());
        }
        if let Some(error) = expected_error {
            assert!(
                result.error.as_deref().unwrap().contains(error),
                "{result:?}"
            );
        }
        assert!(started.elapsed() < Duration::from_secs(3));
        server.await.unwrap();
    }
}
async fn headers(socket: &mut TcpStream) -> String {
    let mut value = Vec::new();
    while !value.ends_with(b"\r\n\r\n") {
        assert!(value.len() < 16 * 1024);
        value.push(socket.read_u8().await.unwrap());
    }
    String::from_utf8(value).unwrap().to_lowercase()
}
fn settings(protocol: ProxyProtocol, port: u16) -> NetworkProxy {
    NetworkProxy {
        enabled: true,
        protocol,
        host: "127.0.0.1".into(),
        port,
        auth_enabled: true,
        username: "user".into(),
        bypass_list: vec![],
        auto_bypass_domains: vec![],
    }
}

#[expect(
    clippy::result_large_err,
    reason = "tungstenite handshake callback fixes its error type"
)]
async fn roundtrip(protocol: Option<ProxyProtocol>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (policy, url) = if let Some(protocol) = protocol {
        (
            Policy::from_settings(&settings(protocol, port), Some("secret")).unwrap(),
            "http://models.maka.invalid/responses".to_owned(),
        )
    } else {
        let mut bypass = settings(ProxyProtocol::Http, 9);
        bypass.bypass_list = vec!["127.0.0.1".into()];
        (
            Policy::from_settings(&bypass, Some("secret")).unwrap(),
            format!("http://127.0.0.1:{port}/responses"),
        )
    };
    let server = tokio::spawn(async move {
        for websocket in [false, true] {
            let (mut socket, _) = listener.accept().await.unwrap();
            if protocol == Some(ProxyProtocol::Socks5) {
                socks(&mut socket).await;
            }
            if websocket {
                let mut socket =
                    accept_hdr_async(socket, |request: &Request, response: Response| {
                        assert_eq!(request.headers()[AUTHORIZATION], "Bearer model-key");
                        if protocol == Some(ProxyProtocol::Http) {
                            assert_eq!(request.uri().host(), Some("models.maka.invalid"));
                            assert_eq!(
                                request.headers()["proxy-authorization"],
                                "Basic dXNlcjpzZWNyZXQ="
                            );
                        } else {
                            assert!(!request.headers().contains_key("proxy-authorization"));
                        }
                        Ok(response)
                    })
                    .await
                    .unwrap();
                assert_eq!(
                    socket.next().await.unwrap().unwrap().into_text().unwrap(),
                    "request"
                );
                socket
                    .send(Message::Text("through selected route".into()))
                    .await
                    .unwrap();
                let _ = socket.next().await;
            } else {
                let head = headers(&mut socket).await;
                assert!(head.contains("authorization: bearer model-key\r\n"));
                if protocol == Some(ProxyProtocol::Http) {
                    assert!(head.starts_with("get http://models.maka.invalid/responses "));
                    assert!(head.contains("proxy-authorization: basic dxnlcjpzzwnyzxq=\r\n"));
                } else {
                    assert!(!head.contains("proxy-authorization:"));
                }
                socket
                    .write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK",
                    )
                    .await
                    .unwrap();
            }
        }
    });
    let client = policy.client_builder().build().unwrap();
    assert_eq!(
        client
            .get(&url)
            .bearer_auth("model-key")
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap(),
        "OK"
    );
    let mut socket = connect_websocket(
        &policy,
        policy.client_builder(),
        &url,
        HeaderMap::from_iter([(AUTHORIZATION, HeaderValue::from_static("Bearer model-key"))]),
        1024,
    )
    .await
    .unwrap();
    socket.send(Message::Text("request".into())).await.unwrap();
    assert_eq!(
        socket.next().await.unwrap().unwrap().into_text().unwrap(),
        "through selected route"
    );
    drop(socket);
    server.await.unwrap();
}

#[tokio::test]
async fn http_and_websocket_share_auth_bypass_and_remote_socks_dns() {
    tokio::time::timeout(Duration::from_secs(15), async {
        for protocol in [Some(ProxyProtocol::Http), Some(ProxyProtocol::Socks5), None] {
            roundtrip(protocol).await;
        }
        let origin = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/responses", origin.local_addr().unwrap());
        let proxy = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = proxy.local_addr().unwrap().port();
        drop(proxy);
        let policy =
            Policy::from_settings(&settings(ProxyProtocol::Http, port), Some("secret")).unwrap();
        assert!(
            policy
                .client_builder()
                .build()
                .unwrap()
                .get(&url)
                .send()
                .await
                .is_err()
        );
        assert!(
            connect_websocket(
                &policy,
                policy.client_builder(),
                &url,
                HeaderMap::new(),
                1024
            )
            .await
            .is_err()
        );
        assert!(
            origin.accept().now_or_never().is_none(),
            "failed proxy must never fall back to direct"
        );
    })
    .await
    .unwrap();
}

#[test]
fn ambient_proxy_variables_cannot_override_the_explicit_policy() {
    // Poison only a subprocess, never the multithreaded test runner's environment.
    let executable = std::env::current_exe().unwrap();
    let output = std::process::Command::new(executable)
        .args([
            "--exact",
            "proxy::http_and_websocket_share_auth_bypass_and_remote_socks_dns",
            "--nocapture",
        ])
        .env("HTTP_PROXY", "http://127.0.0.1:9")
        .env("http_proxy", "http://127.0.0.1:9")
        .env("HTTPS_PROXY", "http://127.0.0.1:9")
        .env("ALL_PROXY", "http://127.0.0.1:9")
        .env("NO_PROXY", "*")
        .env("no_proxy", "*")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let mut direct = RuntimePolicy::default().network_proxy;
    direct.enabled = false;
    assert!(Policy::from_settings(&direct, None).is_ok());
}
