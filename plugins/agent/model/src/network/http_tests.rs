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
