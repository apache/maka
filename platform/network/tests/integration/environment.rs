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
use maka_agent_facts::configuration::policy::RuntimePolicy;
use maka_network::{Policy, connect_websocket, proxy::Proxy};
use maka_sandbox::{Destination, Network};
use std::{process::Command, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};
use tokio_tungstenite::tungstenite::Message;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn host_environment_routes_http_websocket_and_guarded_connect_without_fallback() {
    if std::env::var_os("MAKA_PROXY_TEST_CHILD").is_some() {
        tokio::time::timeout(Duration::from_secs(15), child())
            .await
            .unwrap();
        return;
    }
    let http = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let https = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let http_url = format!("http://user:secret@{}", http.local_addr().unwrap());
    let https_url = format!("http://user:secret@{}", https.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut socket, _) = http.accept().await.unwrap();
        let request = head(&mut socket).await;
        assert!(request.starts_with("GET http://models.maka.invalid/test "));
        assert!(
            request
                .to_lowercase()
                .contains("proxy-authorization: basic dxnlcjpzzwnyzxq=")
        );
        socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK")
            .await
            .unwrap();
        let (socket, _) = http.accept().await.unwrap();
        let mut ws = tokio_tungstenite::accept_async(socket).await.unwrap();
        assert_eq!(
            ws.next().await.unwrap().unwrap().into_text().unwrap(),
            "ping"
        );
        ws.send(Message::Text("pong".into())).await.unwrap();
        drop(ws);
        // HTTPS and guarded CONNECT must select the other proxy, even on 8443.
        for target in ["models.maka.invalid:443", "models.maka.invalid:8443"] {
            let (mut socket, _) = https.accept().await.unwrap();
            let request = head(&mut socket).await;
            assert!(request.starts_with(&format!("CONNECT {target} HTTP/1.1")));
            assert!(
                request
                    .to_lowercase()
                    .contains("proxy-authorization: basic dxnlcjpzzwnyzxq=")
            );
            socket
                .write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
                .await
                .unwrap();
        }
        // A refused proxy request must not contact the reachable origin.
        let (mut socket, _) = http.accept().await.unwrap();
        assert!(head(&mut socket).await.starts_with("GET http://127.0.0.1:"));
        socket
            .write_all(
                b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            )
            .await
            .unwrap();
    });
    // Only the child changes environment; parallel tests never race set_var.
    let output = tokio::task::spawn_blocking(move || {
        let mut command = Command::new(std::env::current_exe().unwrap());
        for name in [
            "HTTP_PROXY",
            "http_proxy",
            "HTTPS_PROXY",
            "https_proxy",
            "ALL_PROXY",
            "all_proxy",
            "NO_PROXY",
            "no_proxy",
            "REQUEST_METHOD",
        ] {
            command.env_remove(name);
        }
        command
            .args([
                "--exact",
                "environment::host_environment_routes_http_websocket_and_guarded_connect_without_fallback",
                "--nocapture",
            ])
            .env("MAKA_PROXY_TEST_CHILD", "1")
            .env("http_proxy", http_url)
            .env("https_proxy", https_url)
            .env("ALL_PROXY", "http://127.0.0.1:9")
            .env("no_proxy", "localhost")
            .output()
            .unwrap()
    })
    .await
    .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    server.await.unwrap();
}

async fn child() {
    let settings = RuntimePolicy::default().network_proxy;
    let policy = Policy::from_host_settings(&settings, None).unwrap();
    let client = policy.client_builder().build().unwrap();
    assert_eq!(
        client
            .get("http://models.maka.invalid/test")
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap(),
        "OK"
    );
    let mut ws = connect_websocket(
        &policy,
        policy.client_builder(),
        "http://models.maka.invalid/ws",
        Default::default(),
        1024,
    )
    .await
    .unwrap();
    ws.send(Message::Text("ping".into())).await.unwrap();
    assert_eq!(
        ws.next().await.unwrap().unwrap().into_text().unwrap(),
        "pong"
    );
    drop(ws);
    assert!(
        client
            .get("https://models.maka.invalid/test")
            .send()
            .await
            .is_err()
    );

    let (address, mut gateway) = Proxy::start(
        Network::destination(Destination::new("models.maka.invalid", 8443).unwrap()),
        policy.clone(),
    )
    .await
    .unwrap();
    let mut denied = TcpStream::connect(address).await.unwrap();
    denied
        .write_all(
            b"CONNECT forbidden.invalid:8443 HTTP/1.1\r\nHost: forbidden.invalid:8443\r\n\r\n",
        )
        .await
        .unwrap();
    assert!(head(&mut denied).await.starts_with("HTTP/1.1 403"));
    let mut allowed = TcpStream::connect(address).await.unwrap();
    allowed
        .write_all(
            b"CONNECT models.maka.invalid:8443 HTTP/1.1\r\nHost: models.maka.invalid:8443\r\n\r\n",
        )
        .await
        .unwrap();
    assert!(head(&mut allowed).await.starts_with("HTTP/1.1 502"));
    gateway.close().await.unwrap();

    let origin = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = origin.local_addr().unwrap().port();
    assert_eq!(
        client
            .get(format!("http://127.0.0.1:{port}/"))
            .send()
            .await
            .unwrap()
            .status(),
        502
    );
    assert!(
        origin.accept().now_or_never().is_none(),
        "refused proxy cannot fall back to origin"
    );
    let direct = tokio::spawn(async move {
        // NO_PROXY then explicit manual bypass: neither may leak proxy credentials.
        for _ in 0..2 {
            let (mut socket, _) = origin.accept().await.unwrap();
            let request = head(&mut socket).await;
            assert!(request.starts_with("GET / "));
            assert!(!request.to_lowercase().contains("proxy-authorization"));
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .await
                .unwrap();
        }
    });
    assert_eq!(
        client
            .get(format!("http://localhost:{port}/"))
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    let mut manual = settings;
    manual.enabled = true;
    manual.port = 9;
    manual.bypass_list = vec!["*".into()];
    let manual = Policy::from_host_settings(&manual, None).unwrap();
    assert_eq!(
        manual
            .client_builder()
            .build()
            .unwrap()
            .get(format!("http://127.0.0.1:{port}/"))
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    direct.await.unwrap();
}

async fn head(socket: &mut TcpStream) -> String {
    let mut bytes = Vec::new();
    while !bytes.ends_with(b"\r\n\r\n") {
        assert!(bytes.len() < 16 * 1024);
        bytes.push(socket.read_u8().await.unwrap());
    }
    String::from_utf8(bytes).unwrap()
}
