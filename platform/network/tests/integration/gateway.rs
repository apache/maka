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

use futures_util::FutureExt;
use maka_network::{Policy, proxy::Proxy};
use maka_sandbox::{Destination, Network};
use std::time::Duration;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};

async fn head(socket: &mut TcpStream) -> String {
    let mut value = Vec::new();
    while !value.ends_with(b"\r\n\r\n") {
        assert!(value.len() < 16 * 1024);
        value.push(socket.read_u8().await.unwrap());
    }
    String::from_utf8(value).unwrap()
}

#[tokio::test]
async fn gateway_checks_each_destination_and_closing_revokes_open_tunnels() {
    tokio::time::timeout(Duration::from_secs(10), async {
        let origin = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let denied = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = origin.local_addr().unwrap();
        let denied_address = denied.local_addr().unwrap();
        let (gateway_address, mut gateway) = Proxy::start(Network::destination(Destination::new("127.0.0.1", address.port()).unwrap()), Policy::default()).await.unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = origin.accept().await.unwrap();
            let request = head(&mut socket).await.to_lowercase();
            assert!(request.starts_with("get /redirect "));
            assert!(!request.contains("proxy-authorization:"));
            assert!(!request.contains("x-hop-secret:"));
            socket.write_all(format!("HTTP/1.1 302 Found\r\nLocation: http://{denied_address}/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
            let (mut tunnel, _) = origin.accept().await.unwrap();
            let mut ping = [0; 4];
            tunnel.read_exact(&mut ping).await.unwrap();
            assert_eq!(&ping, b"ping");
            tunnel.write_all(b"pong").await.unwrap();
            assert_eq!(tunnel.read(&mut ping).await.unwrap(), 0, "gateway close must close upstream");
        });
        let client = reqwest::Client::builder().no_proxy().proxy(reqwest::Proxy::all(format!("http://{gateway_address}")).unwrap()).redirect(reqwest::redirect::Policy::none()).build().unwrap();
        let response = client.get(format!("http://{address}/redirect"))
            .header("proxy-authorization", "Basic do-not-forward")
            .header("connection", "x-hop-secret")
            .header("x-hop-secret", "do-not-forward")
            .send().await.unwrap();
        assert_eq!(response.status(), 302);
        assert_eq!(client.get(response.headers()["location"].to_str().unwrap()).send().await.unwrap().status(), 403);
        let mut rejected = TcpStream::connect(gateway_address).await.unwrap();
        rejected.write_all(format!("CONNECT {denied_address} HTTP/1.1\r\nHost: {address}\r\n\r\n").as_bytes()).await.unwrap();
        assert!(head(&mut rejected).await.starts_with("HTTP/1.1 403"));
        assert!(denied.accept().now_or_never().is_none(), "rejected destinations must not receive a connection");
        let mut accepted = TcpStream::connect(gateway_address).await.unwrap();
        accepted.write_all(format!("CONNECT {address} HTTP/1.1\r\nHost: {address}\r\n\r\nping").as_bytes()).await.unwrap();
        assert!(head(&mut accepted).await.starts_with("HTTP/1.1 200"));
        let mut pong = [0; 4];
        accepted.read_exact(&mut pong).await.unwrap();
        assert_eq!(&pong, b"pong", "bytes pipelined after CONNECT must survive upgrade");
        gateway.close().await.unwrap();
        gateway.close().await.unwrap();
        assert_eq!(accepted.read(&mut pong).await.unwrap(), 0);
        assert!(TcpStream::connect(gateway_address).await.is_err());
        server.await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn gateway_tunnels_use_the_captured_authenticated_upstream_and_never_fall_back() {
    use maka_agent_facts::configuration::policy::NetworkProxy;
    use maka_agent_facts::configuration::policy::ProxyProtocol;
    for protocol in [ProxyProtocol::Http, ProxyProtocol::Socks5] {
        tokio::time::timeout(Duration::from_secs(10), async {
        let upstream = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let settings = NetworkProxy {
            enabled: true, protocol, host: "127.0.0.1".into(),
            port: upstream.local_addr().unwrap().port(), auth_enabled: true, username: "user".into(),
            bypass_list: vec![], auto_bypass_domains: vec![],
        };
        let route = Policy::from_settings(&settings, Some("secret")).unwrap();
        let (gateway_address, mut gateway) = Proxy::start(Network::destination(Destination::new("models.maka.invalid", 443).unwrap()), route).await.unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = upstream.accept().await.unwrap();
            if protocol == ProxyProtocol::Http {
                let request = head(&mut socket).await;
                assert!(request.starts_with("CONNECT models.maka.invalid:443 HTTP/1.1"));
                assert!(request.contains("Proxy-Authorization: Basic dXNlcjpzZWNyZXQ="));
                socket.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\nready").await.unwrap();
            } else {
                assert_eq!(socket.read_u8().await.unwrap(), 5);
                let mut methods = vec![0; socket.read_u8().await.unwrap() as usize];
                socket.read_exact(&mut methods).await.unwrap();
                assert!(methods.contains(&2));
                socket.write_all(&[5, 2]).await.unwrap();
                assert_eq!(socket.read_u8().await.unwrap(), 1);
                let mut user = vec![0; socket.read_u8().await.unwrap() as usize];
                socket.read_exact(&mut user).await.unwrap();
                let mut password = vec![0; socket.read_u8().await.unwrap() as usize];
                socket.read_exact(&mut password).await.unwrap();
                assert_eq!(user, b"user");
                assert_eq!(password, b"secret");
                socket.write_all(&[1, 0]).await.unwrap();
                let mut request = [0; 4];
                socket.read_exact(&mut request).await.unwrap();
                assert_eq!(request, [5, 1, 0, 3], "SOCKS must resolve the hostname remotely");
                let mut host = vec![0; socket.read_u8().await.unwrap() as usize];
                socket.read_exact(&mut host).await.unwrap();
                assert_eq!(host, b"models.maka.invalid");
                assert_eq!(socket.read_u16().await.unwrap(), 443);
                socket.write_all(&[5, 0, 0, 1, 127, 0, 0, 1, 0, 0]).await.unwrap();
                socket.write_all(b"ready").await.unwrap();
            }
            let mut value = [0; 4];
            socket.read_exact(&mut value).await.unwrap();
            assert_eq!(&value, b"ping");
        });
        let mut socket = TcpStream::connect(gateway_address).await.unwrap();
        socket.write_all(b"CONNECT models.maka.invalid:443 HTTP/1.1\r\nHost: models.maka.invalid:443\r\n\r\n").await.unwrap();
        assert!(head(&mut socket).await.starts_with("HTTP/1.1 200"));
        let mut ready = [0; 5];
        socket.read_exact(&mut ready).await.unwrap();
        assert_eq!(&ready, b"ready");
        socket.write_all(b"ping").await.unwrap();
        server.await.unwrap();
        let mut rejected = TcpStream::connect(gateway_address).await.unwrap();
        rejected.write_all(b"CONNECT models.maka.invalid:443 HTTP/1.1\r\nHost: models.maka.invalid:443\r\n\r\n").await.unwrap();
        assert!(head(&mut rejected).await.starts_with("HTTP/1.1 502"));
        gateway.close().await.unwrap();
    }).await.unwrap();
    }
}
