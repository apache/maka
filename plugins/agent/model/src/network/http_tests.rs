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

use super::*;
use std::{
    sync::atomic::{AtomicUsize, Ordering},
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn network() -> Arc<Network> {
    Arc::new(Network {
        tls: maka_network::TlsConfigCache::default(),
        policy: Default::default(),
        identity: 1,
    })
}
async fn line(socket: &mut tokio::net::TcpStream) -> String {
    let mut bytes = Vec::new();
    while !bytes.ends_with(b"\r\n") {
        bytes.push(socket.read_u8().await.unwrap());
    }
    String::from_utf8(bytes).unwrap()
}
async fn head(socket: &mut tokio::net::TcpStream) -> String {
    let mut header = String::new();
    loop {
        let next = line(socket).await;
        header.push_str(&next);
        if next == "\r\n" {
            break;
        }
    }
    header
}
async fn payload(socket: &mut tokio::net::TcpStream, header: &str) -> usize {
    let lower = header.to_ascii_lowercase();
    let chunked = lower.contains("transfer-encoding: chunked");
    let length = lower
        .lines()
        .find_map(|line| {
            line.strip_prefix("content-length:")
                .map(|value| value.trim().parse::<usize>().unwrap())
        })
        .unwrap_or(0);
    let mut count = 0;
    loop {
        let size = if chunked {
            usize::from_str_radix(line(socket).await.trim(), 16).unwrap()
        } else {
            length
        };
        if size == 0 {
            if chunked {
                assert_eq!(line(socket).await, "\r\n");
            }
            break;
        }
        let mut left = size;
        let mut bytes = [0; 16 * 1024];
        while left > 0 {
            let size = left.min(bytes.len());
            socket.read_exact(&mut bytes[..size]).await.unwrap();
            assert!(bytes[..size].iter().all(|byte| *byte == 7));
            left -= size;
            count += size;
        }
        if chunked {
            assert_eq!(line(socket).await, "\r\n");
        } else {
            break;
        }
    }
    count
}
async fn redirect(socket: &mut tokio::net::TcpStream, status: u16, location: &str) {
    socket.write_all(format!("HTTP/1.1 {status} Redirect\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
    socket.shutdown().await.unwrap();
}
fn replay_body(opened: Arc<AtomicUsize>) -> http::RequestBody {
    http::RequestBody::replayable(move || {
        opened.fetch_add(1, Ordering::SeqCst);
        http::RequestBody::with_length(
            futures_util::stream::iter((0..256).map(|_| Ok(http::Bytes::from(vec![7; 16 * 1024])))),
            4 * 1024 * 1024,
        )
    })
}
#[tokio::test]
async fn redirects_307_and_308_reopen_large_stream_and_preserve_bytes_and_auth() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/start", listener.local_addr().unwrap());
    let original = url.clone();
    let server = tokio::spawn(async move {
        for (hop, status) in [307, 308, 200].into_iter().enumerate() {
            let (mut socket, _) = listener.accept().await.unwrap();
            let headers = head(&mut socket).await;
            assert!(headers.starts_with("POST "));
            assert!(
                headers
                    .to_ascii_lowercase()
                    .contains("authorization: bearer secret")
            );
            assert!(
                headers
                    .to_ascii_lowercase()
                    .contains("content-type: application/json")
            );
            assert_eq!(payload(&mut socket, &headers).await, 4 * 1024 * 1024);
            if hop > 0 {
                assert!(headers.to_ascii_lowercase().contains("referer:"));
            }
            redirect(&mut socket, status, &format!("/hop{}", hop + 1)).await;
        }
    });
    let opened = Arc::new(AtomicUsize::new(0));
    let response = network()
        .request(
            http::Request {
                url,
                method: http::Method::Post,
                headers: vec![
                    ("authorization".into(), "Bearer secret".into()),
                    ("content-type".into(), "application/json".into()),
                ],
                body: replay_body(opened.clone()),
            },
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(response.head.status, 200);
    assert_eq!(response.head.url, original.replace("/start", "/hop2"));
    response.body.close().await.unwrap();
    assert_eq!(opened.load(Ordering::SeqCst), 3);
    server.await.unwrap();
}
#[tokio::test]
async fn redirect_method_conversion_drops_payload_headers_and_preserves_head() {
    for (status, method, expected) in [
        (301, http::Method::Post, "GET"),
        (302, http::Method::Post, "GET"),
        (303, http::Method::Post, "GET"),
        (303, http::Method::Head, "HEAD"),
    ] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/start", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let headers = head(&mut socket).await;
            assert_eq!(payload(&mut socket, &headers).await, 4);
            redirect(&mut socket, status, "/next").await;
            let (mut socket, _) = listener.accept().await.unwrap();
            let headers = head(&mut socket).await;
            assert!(headers.starts_with(&format!("{expected} /next ")));
            let lower = headers.to_ascii_lowercase();
            assert!(!lower.contains("content-type:"));
            assert!(!lower.contains("content-encoding:"));
            assert!(!lower.contains("transfer-encoding:"));
            assert_eq!(payload(&mut socket, &headers).await, 0);
            redirect(&mut socket, 200, "/done").await;
        });
        let response = network()
            .request(
                http::Request {
                    url,
                    method,
                    headers: vec![
                        ("content-type".into(), "application/json".into()),
                        ("content-encoding".into(), "identity".into()),
                    ],
                    body: vec![7; 4].into(),
                },
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(response.head.status, 200);
        response.body.close().await.unwrap();
        server.await.unwrap();
    }
}
#[tokio::test]
async fn cross_origin_redirect_is_returned_without_forwarding_credentials() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let other = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/start", listener.local_addr().unwrap());
    let target = format!("http://{}/other", other.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let headers = head(&mut socket).await;
        payload(&mut socket, &headers).await;
        redirect(&mut socket, 307, &target).await;
    });
    let response = network()
        .request(
            http::Request {
                url,
                method: http::Method::Post,
                headers: vec![("authorization".into(), "Bearer secret".into())],
                body: vec![7; 4].into(),
            },
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(response.head.status, 307);
    response.body.close().await.unwrap();
    server.await.unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(50), other.accept())
            .await
            .is_err()
    );
}

struct PayloadOwner {
    bytes: Vec<u8>,
    dropped: Arc<AtomicUsize>,
}
impl AsRef<[u8]> for PayloadOwner {
    fn as_ref(&self) -> &[u8] {
        &self.bytes
    }
}
impl Drop for PayloadOwner {
    fn drop(&mut self) {
        self.dropped.fetch_add(1, Ordering::SeqCst);
    }
}
struct SourceCleanup {
    dropped: Arc<AtomicUsize>,
    closed: Arc<tokio::sync::Semaphore>,
}
impl http::UploadCleanup for SourceCleanup {
    fn close(&self) -> BoxFuture<'_, Result<(), http::Error>> {
        Box::pin(async move {
            assert_eq!(self.dropped.load(Ordering::SeqCst), 1);
            self.closed.add_permits(1);
            Ok(())
        })
    }
}

#[tokio::test]
async fn held_response_headers_release_upload_source_without_closing_connection() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/held", listener.local_addr().unwrap());
    let (read, received) = tokio::sync::oneshot::channel();
    let (release, headers) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let headers_read = head(&mut socket).await;
        assert_eq!(payload(&mut socket, &headers_read).await, 128 * 1024);
        read.send(()).unwrap();
        headers.await.unwrap();
        socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
            .await
            .unwrap();
    });
    let dropped = Arc::new(AtomicUsize::new(0));
    let closed = Arc::new(tokio::sync::Semaphore::new(0));
    let bytes = http::Bytes::from_owner(PayloadOwner {
        bytes: vec![7; 128 * 1024],
        dropped: dropped.clone(),
    });
    let input = http::RequestBody::with_length(
        futures_util::stream::once(async move { Ok(bytes) }),
        128 * 1024,
    )
    .with_cleanup(Arc::new(SourceCleanup {
        dropped,
        closed: closed.clone(),
    }));
    let network = network();
    let pending = network.request(
        http::Request {
            url,
            method: http::Method::Post,
            headers: Vec::new(),
            body: input,
        },
        CancellationToken::new(),
    );
    tokio::pin!(pending);
    tokio::select! {
        read = received => read.unwrap(),
        response = &mut pending => panic!("response arrived before headers release: {}", response.is_ok()),
    }
    tokio::select! {
        permit = closed.acquire() => permit.unwrap().forget(),
        response = &mut pending => panic!("source close interrupted live connection: {}", response.is_ok()),
    }
    assert!(futures_util::poll!(pending.as_mut()).is_pending());
    release.send(()).unwrap();
    let response = pending.await.unwrap();
    assert_eq!(response.head.status, 200);
    assert_eq!(response.body.next().await.unwrap(), Some(b"ok".to_vec()));
    assert_eq!(response.body.next().await.unwrap(), None);
    response.body.close().await.unwrap();
    server.await.unwrap();
}

#[tokio::test]
async fn tls_handshake_eof_is_retryable_but_invalid_tls_is_not() {
    tokio::time::timeout(Duration::from_secs(10), async {
        for eof in [true, false] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!(
                "https://{}/?api_key=must-not-appear",
                listener.local_addr().unwrap()
            );
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut record = [0; 5];
                socket.read_exact(&mut record).await.unwrap();
                let mut hello = vec![0; usize::from(u16::from_be_bytes([record[3], record[4]]))];
                socket.read_exact(&mut hello).await.unwrap();
                if !eof {
                    socket
                        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
                        .await
                        .unwrap();
                }
                socket.shutdown().await.unwrap();
            });
            let error = network()
                .request(
                    http::Request {
                        method: http::Method::Get,
                        url,
                        headers: Vec::new(),
                        body: Default::default(),
                    },
                    CancellationToken::new(),
                )
                .await
                .err()
                .expect("TLS handshake must fail");
            server.await.unwrap();
            let message = error.to_string();
            assert!(
                !message.contains("must-not-appear"),
                "request URLs must stay private: {message}"
            );
            if eof {
                let Error::Provider(failure) = error else {
                    panic!("handshake EOF must remain a retryable network failure: {message}");
                };
                assert_eq!(failure.reason(), ProviderFailureReason::Network);
                assert!(failure.retryable() && failure.replay_safe());
                assert!(failure.message().contains("tls handshake eof"), "{message}");
            } else {
                assert!(
                    matches!(error, Error::Adapter(_)),
                    "invalid TLS must not become a retryable connection failure: {message}"
                );
                assert!(
                    message.to_ascii_lowercase().contains("invalid"),
                    "the TLS cause must be preserved: {message}"
                );
            }
        }
    })
    .await
    .unwrap();
}
