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
use maka_agent_facts::configuration::policy::NetworkProxy;
use maka_agent_facts::configuration::policy::ProxyProtocol;
use maka_network::{Policy, connect_websocket};
use reqwest::{
    Certificate,
    header::{AUTHORIZATION, HeaderMap, HeaderValue},
};
use std::{sync::Arc, time::Duration};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::TcpListener,
};
use tokio_rustls::{
    TlsAcceptor,
    rustls::{
        ServerConfig,
        crypto::aws_lc_rs,
        pki_types::{CertificateDer, PrivateKeyDer, pem::PemObject},
    },
};
use tokio_tungstenite::{
    accept_hdr_async,
    tungstenite::{
        Message,
        handshake::server::{Request, Response},
    },
};

const CA: &[u8] = include_bytes!("fixtures/ca.pem");
const CERT: &[u8] = include_bytes!("fixtures/localhost.pem");
const KEY: &[u8] = include_bytes!("fixtures/localhost.key");

trait Io: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Io for T {}

fn acceptor() -> TlsAcceptor {
    let config = ServerConfig::builder_with_provider(Arc::new(aws_lc_rs::default_provider()))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(
            vec![CertificateDer::from_pem_slice(CERT).unwrap()],
            PrivateKeyDer::from_pem_slice(KEY).unwrap(),
        )
        .unwrap();
    TlsAcceptor::from(Arc::new(config))
}

async fn headers(stream: &mut (impl AsyncRead + Unpin)) -> String {
    let mut bytes = Vec::new();
    while !bytes.ends_with(b"\r\n\r\n") {
        assert!(bytes.len() < 16 * 1024);
        bytes.push(stream.read_u8().await.unwrap());
    }
    String::from_utf8(bytes).unwrap().to_ascii_lowercase()
}

#[derive(Clone, Copy, PartialEq)]
enum Trust {
    Valid,
    Untrusted,
    WrongName,
}

#[expect(
    clippy::result_large_err,
    reason = "tungstenite fixes its handshake callback error type"
)]
async fn exchange(protocol: ProxyProtocol, websocket: bool, trust: Trust) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let policy = Policy::from_settings(
        &NetworkProxy {
            enabled: true,
            protocol,
            host: "localhost".into(),
            port: listener.local_addr().unwrap().port(),
            auth_enabled: true,
            username: "user".into(),
            bypass_list: vec![],
            auto_bypass_domains: vec![],
        },
        Some("proxy-password"),
    )
    .unwrap();
    let destination = if trust == Trust::WrongName {
        "wrong.maka.invalid"
    } else {
        "models.maka.invalid"
    };
    let server = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let tls = acceptor();
        let mut proxy: Box<dyn Io> = if protocol == ProxyProtocol::Https {
            match tls.accept(tcp).await {
                Ok(stream) => Box::new(stream),
                Err(_) => {
                    assert!(trust == Trust::Untrusted);
                    return;
                }
            }
        } else {
            Box::new(tcp)
        };
        let connect = headers(&mut proxy).await;
        assert!(connect.starts_with(&format!("connect {destination}:443 http/1.1\r\n")));
        assert!(
            connect.contains("\r\nproxy-authorization: basic dxnlcjpwcm94es1wyxnzd29yza==\r\n")
        );
        assert!(
            !connect.contains("\r\nauthorization:"),
            "model key must not reach CONNECT headers"
        );
        proxy
            .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            .await
            .unwrap();
        let stream = tls.accept(proxy).await;
        if trust != Trust::Valid {
            assert!(stream.is_err(), "invalid origin certificate accepted");
            return;
        }
        let mut stream = stream.unwrap();
        if websocket {
            let mut socket = accept_hdr_async(stream, |request: &Request, response: Response| {
                assert_eq!(request.headers()[AUTHORIZATION], "Bearer model-key");
                assert!(!request.headers().contains_key("proxy-authorization"));
                Ok(response)
            })
            .await
            .unwrap();
            assert_eq!(
                socket.next().await.unwrap().unwrap().into_text().unwrap(),
                "request"
            );
            socket
                .send(Message::Text("secure response".into()))
                .await
                .unwrap();
            let _ = socket.next().await;
        } else {
            let request = headers(&mut stream).await;
            assert!(request.starts_with("get /responses http/1.1\r\n"));
            assert!(request.contains("\r\nauthorization: bearer model-key\r\n"));
            assert!(!request.contains("\r\nproxy-authorization:"));
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK")
                .await
                .unwrap();
            stream.shutdown().await.unwrap();
        }
    });
    // Trust is scoped to this client. The production policy still uses platform roots;
    // no process environment, OS trust store, hostname or chain verification is disabled.
    let mut builder = policy.client_builder();
    if trust != Trust::Untrusted {
        builder = builder.tls_certs_only([Certificate::from_pem(CA).unwrap()]);
    }
    let url = format!("https://{destination}/responses");
    if websocket {
        let result = connect_websocket(
            &policy,
            builder,
            &url,
            HeaderMap::from_iter([(AUTHORIZATION, HeaderValue::from_static("Bearer model-key"))]),
            1024,
        )
        .await;
        if trust == Trust::Valid {
            let mut socket = result.unwrap();
            socket.send(Message::Text("request".into())).await.unwrap();
            assert_eq!(
                socket.next().await.unwrap().unwrap().into_text().unwrap(),
                "secure response"
            );
            drop(socket);
        } else {
            assert!(result.is_err());
        }
    } else {
        let result = builder
            .build()
            .unwrap()
            .get(url)
            .bearer_auth("model-key")
            .send()
            .await;
        if trust == Trust::Valid {
            assert_eq!(result.unwrap().text().await.unwrap(), "OK");
        } else {
            assert!(result.is_err());
        }
    }
    server.await.unwrap();
}

#[tokio::test]
async fn connect_and_nested_tls_verify_proxy_and_origin_without_credential_leakage() {
    tokio::time::timeout(Duration::from_secs(30), async {
        for protocol in [ProxyProtocol::Http, ProxyProtocol::Https] {
            for websocket in [false, true] {
                for trust in [Trust::Valid, Trust::Untrusted, Trust::WrongName] {
                    exchange(protocol, websocket, trust).await;
                }
            }
        }
    })
    .await
    .expect("TLS proxy acceptance must settle");
}
