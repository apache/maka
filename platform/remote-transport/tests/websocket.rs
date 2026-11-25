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

use futures_util::{SinkExt, StreamExt};
use maka_remote_transport::{TlsTrust, websocket::WebSocketEndpoint};
use rustls::{ServerConfig, pki_types::PrivatePkcs8KeyDer};
use sha2::{Digest, Sha256};
use std::{sync::Arc, time::Duration};
use tokio::net::TcpListener;
use tokio_rustls::TlsAcceptor;
use tokio_tungstenite::{
    accept_hdr_async,
    tungstenite::{
        Message,
        handshake::server::{Request, Response},
    },
};

struct TraceCapture(std::sync::Mutex<Vec<String>>);

impl log::Log for TraceCapture {
    fn enabled(&self, _: &log::Metadata<'_>) -> bool {
        true
    }

    fn log(&self, record: &log::Record<'_>) {
        self.0.lock().unwrap().push(record.args().to_string());
    }

    fn flush(&self) {}
}

static TRACE: TraceCapture = TraceCapture(std::sync::Mutex::new(Vec::new()));
const BEARER: &str = "maka-unique-trace-regression-secret";

#[tokio::test]
#[expect(
    clippy::result_large_err,
    reason = "tungstenite owns the handshake callback signature"
)]
async fn websocket_uses_real_tls_sni_http_authority_and_target() {
    log::set_logger(&TRACE).unwrap();
    log::set_max_level(log::LevelFilter::Trace);
    log::trace!("maka websocket trace capture enabled");
    tokio::time::timeout(Duration::from_secs(5), async {
        let cert = rcgen::generate_simple_self_signed(vec!["localhost".to_owned()]).unwrap();
        let der = cert.cert.der().clone();
        let pin: [u8; 32] = Sha256::digest(&der).into();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let authority = format!("localhost:{}", listener.local_addr().unwrap().port());
        let url = format!("wss://{authority}/proxy/maka?name=a%2Fb");
        let acceptor = tls_acceptor(&cert.cert, &cert.signing_key);

        for (url, trust, success) in [
            (url.clone(), TlsTrust::System, false),
            (url.clone(), TlsTrust::LeafSha256([0; 32]), false),
            (
                url.replace("localhost", "127.0.0.1"),
                TlsTrust::LeafSha256(pin),
                false,
            ),
            (url.clone(), TlsTrust::LeafSha256(pin), true),
            (url, TlsTrust::CaDer(der.to_vec()), true),
        ] {
            let serve = async {
                let (stream, _) = listener.accept().await.unwrap();
                let stream = acceptor.accept(stream).await;
                if !success {
                    assert!(stream.is_err(), "untrusted client reached HTTP");
                    return;
                }
                let stream = stream.unwrap();
                assert_eq!(stream.get_ref().1.server_name(), Some("localhost"));
                let mut socket =
                    accept_hdr_async(stream, |request: &Request, response: Response| {
                        assert_eq!(request.headers()["host"], authority);
                        assert_eq!(
                            request.headers()["authorization"],
                            format!("Bearer {BEARER}")
                        );
                        assert_eq!(
                            request.uri().path_and_query().unwrap().as_str(),
                            "/proxy/maka?name=a%2Fb"
                        );
                        Ok(response)
                    })
                    .await
                    .unwrap();
                assert_eq!(
                    socket.next().await.unwrap().unwrap(),
                    Message::Binary(b"client".as_slice().into())
                );
                socket
                    .send(Message::Binary(b"server".as_slice().into()))
                    .await
                    .unwrap();
            };
            let dial = async {
                let opened = WebSocketEndpoint::new(&url, trust)
                    .unwrap()
                    .open(Some(BEARER))
                    .await;
                if success {
                    let mut socket = opened.unwrap();
                    socket
                        .send(Message::Binary(b"client".as_slice().into()))
                        .await
                        .unwrap();
                    assert_eq!(
                        socket.next().await.unwrap().unwrap(),
                        Message::Binary(b"server".as_slice().into())
                    );
                } else {
                    let error = opened.unwrap_err();
                    assert!(error.downcast_ref::<std::io::Error>().is_some(), "{error}");
                }
            };
            tokio::join!(serve, dial);
        }
    })
    .await
    .expect("local WebSocket test did not finish");
    let logs = TRACE.0.lock().unwrap();
    assert!(
        logs.iter()
            .any(|line| line == "maka websocket trace capture enabled")
    );
    assert!(
        !logs.iter().any(|line| line.contains(BEARER)),
        "TRACE exposed the Authorization token"
    );
}

#[test]
fn cleartext_websocket_is_loopback_only_and_userinfo_is_rejected() {
    for url in ["ws://127.0.0.1:57", "ws://[::1]:57", "ws://localhost:57"] {
        assert!(
            WebSocketEndpoint::new(url, TlsTrust::System).is_ok(),
            "{url}"
        );
    }
    for url in [
        "ws://127.1:57",
        "ws://2130706433:57",
        "ws://example.org",
        "wss://user:pass@localhost",
        "wss://@localhost",
        "wss://localhost/path#fragment",
    ] {
        assert!(
            WebSocketEndpoint::new(url, TlsTrust::System).is_err(),
            "{url}"
        );
    }
}

fn tls_acceptor(cert: &rcgen::Certificate, key: &rcgen::KeyPair) -> TlsAcceptor {
    let config = ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::aws_lc_rs::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .unwrap()
    .with_no_client_auth()
    .with_single_cert(
        vec![cert.der().clone()],
        PrivatePkcs8KeyDer::from(key.serialize_der()).into(),
    )
    .unwrap();
    TlsAcceptor::from(Arc::new(config))
}

#[tokio::test]
async fn pinned_wss_leaf_must_be_currently_valid() {
    use rcgen::{CertificateParams, KeyPair, date_time_ymd};
    use rustls::{CertificateError, Error};
    tokio::time::timeout(Duration::from_secs(5), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("wss://{}", listener.local_addr().unwrap());
        for (start, end, expected) in [
            (2000, 2001, CertificateError::Expired),
            (2999, 3000, CertificateError::NotValidYet),
        ] {
            let mut params = CertificateParams::new(vec!["127.0.0.1".into()]).unwrap();
            params.not_before = date_time_ymd(start, 1, 1);
            params.not_after = date_time_ymd(end, 1, 1);
            let key = KeyPair::generate().unwrap();
            let cert = params.self_signed(&key).unwrap();
            let pin = Sha256::digest(cert.der()).into();
            let acceptor = tls_acceptor(&cert, &key);
            let endpoint = WebSocketEndpoint::new(&url, TlsTrust::LeafSha256(pin)).unwrap();
            let serve = async {
                let (tcp, _) = listener.accept().await.unwrap();
                assert!(acceptor.accept(tcp).await.is_err());
            };
            let (opened, ()) = tokio::join!(endpoint.open(Some(BEARER)), serve);
            let error = opened.unwrap_err();
            let tls = error
                .downcast_ref::<std::io::Error>()
                .unwrap()
                .get_ref()
                .unwrap()
                .downcast_ref::<Error>()
                .unwrap();
            assert_eq!(*tls, Error::InvalidCertificate(expected));
        }
    })
    .await
    .expect("pinned WSS validity check timed out");
}

#[tokio::test]
#[expect(
    clippy::result_large_err,
    reason = "tungstenite owns the handshake callback signature"
)]
async fn websocket_wss_supports_bracketed_ipv6() {
    tokio::time::timeout(Duration::from_secs(5), async {
        let listener = TcpListener::bind("[::1]:0").await.unwrap();
        let authority = listener.local_addr().unwrap().to_string();
        let cert = rcgen::generate_simple_self_signed(vec!["::1".into()]).unwrap();
        let tls = tls_acceptor(&cert.cert, &cert.signing_key);
        let pin = Sha256::digest(cert.cert.der()).into();
        let endpoint =
            WebSocketEndpoint::new(&format!("wss://{authority}"), TlsTrust::LeafSha256(pin))
                .unwrap();
        let server = async {
            let (tcp, _) = listener.accept().await.unwrap();
            let stream = tls.accept(tcp).await.unwrap();
            assert_eq!(
                stream.get_ref().1.server_name(),
                None,
                "IP literals are not sent in SNI"
            );
            let mut ws = accept_hdr_async(stream, |request: &Request, response: Response| {
                assert_eq!(request.headers()["host"], authority);
                Ok(response)
            })
            .await
            .unwrap();
            ws.send(Message::text("IPv6")).await.unwrap();
        };
        let client = async {
            let mut ws = endpoint.open(None).await.unwrap();
            assert_eq!(ws.next().await.unwrap().unwrap(), Message::text("IPv6"));
        };
        tokio::join!(server, client);
    })
    .await
    .expect("IPv6 WSS handshake timed out");
}

#[tokio::test]
async fn upgrade_checks_accept_and_preserves_a_pipelined_frame() {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio_tungstenite::tungstenite::handshake::derive_accept_key;
    tokio::time::timeout(Duration::from_secs(5), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = WebSocketEndpoint::new(&format!("ws://{}", listener.local_addr().unwrap()), TlsTrust::System).unwrap();
        for (status, upgrade, connection, valid_key, success) in [
            (200, "websocket", "upgrade", true, false),
            (101, "h2c", "upgrade", true, false),
            (101, "websocket, h2c", "upgrade", true, false),
            (101, "websocket", "keep-alive", true, false),
            (101, "websocket", "upgrade", false, false),
            (101, "WebSocket", "keep-alive, UpGrAdE", true, true),
        ] {
            let server = async {
                let (tcp, _) = listener.accept().await.unwrap();
                let mut tcp = BufReader::new(tcp);
                let mut line = String::new();
                let mut accept = String::new();
                loop {
                    line.clear();
                    assert_ne!(tcp.read_line(&mut line).await.unwrap(), 0);
                    if let Some(key) = line.strip_prefix("Sec-WebSocket-Key: ") {
                        accept = derive_accept_key(key.trim_end().as_bytes());
                    }
                    if line == "\r\n" {
                        break;
                    }
                }
                assert!(!accept.is_empty());
                if !valid_key {
                    accept = "wrong".into();
                }
                let mut response = format!("HTTP/1.1 {status} Test\r\nUpgrade: {upgrade}\r\nConnection: {connection}\r\nSec-WebSocket-Accept: {accept}\r\n\r\n").into_bytes();
                response.extend_from_slice(b"\x81\x03hey");
                tcp.write_all(&response).await.unwrap();
            };
            let client = async {
                let opened = endpoint.open(None).await;
                if success {
                    let mut ws = opened.unwrap();
                    assert_eq!(ws.next().await.unwrap().unwrap(), Message::text("hey"));
                } else {
                    assert!(opened.is_err());
                }
            };
            tokio::join!(server, client);
        }
    }).await.expect("WebSocket response validation timed out");
}

#[tokio::test]
async fn websocket_open_times_out_waiting_for_upgrade() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = WebSocketEndpoint::new(
        &format!("ws://{}", listener.local_addr().unwrap()),
        TlsTrust::System,
    )
    .unwrap();
    let (result, ()) = tokio::time::timeout(Duration::from_secs(5), async {
        tokio::join!(
            endpoint.open_with_timeout(None, Duration::from_millis(250)),
            async {
                let (mut stream, _) = listener.accept().await.unwrap();
                // Hold the upgrade response and wait until the dialer closes.
                tokio::io::copy(&mut stream, &mut tokio::io::sink())
                    .await
                    .unwrap();
            },
        )
    })
    .await
    .expect("the stalled upgrade did not finish");
    let error = result.unwrap_err();
    assert_eq!(
        error.downcast_ref::<std::io::Error>().unwrap().kind(),
        std::io::ErrorKind::TimedOut
    );
}
