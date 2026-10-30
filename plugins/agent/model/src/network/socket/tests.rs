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
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::Notify,
};

async fn client(address: std::net::SocketAddr) -> Arc<Connection> {
    let policy = maka_network::Policy::default();
    let socket = maka_network::connect_websocket(
        &policy,
        policy.client_builder(),
        &format!("http://{address}/socket"),
        Default::default(),
        1024 * 1024,
    )
    .await
    .unwrap();
    Arc::new(Connection::new(socket))
}
async fn accept(listener: &TcpListener) -> TcpStream {
    let (mut socket, _) = listener.accept().await.unwrap();
    let mut head = Vec::new();
    while !head.ends_with(b"\r\n\r\n") {
        head.push(socket.read_u8().await.unwrap());
    }
    let head = String::from_utf8(head).unwrap();
    let key = head
        .lines()
        .find_map(|line| {
            let (key, value) = line.split_once(':')?;
            key.eq_ignore_ascii_case("sec-websocket-key")
                .then(|| value.trim())
        })
        .unwrap();
    let accept = tokio_tungstenite::tungstenite::handshake::derive_accept_key(key.as_bytes());
    socket.write_all(format!("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: {accept}\r\n\r\n").as_bytes()).await.unwrap();
    socket
}
struct Raw {
    final_: bool,
    opcode: u8,
    bytes: Vec<u8>,
}
async fn raw(socket: &mut TcpStream) -> Raw {
    let flags = socket.read_u8().await.unwrap();
    let length = socket.read_u8().await.unwrap();
    assert_eq!(flags & 0x70, 0, "extensions were not negotiated");
    assert_ne!(length & 0x80, 0, "client fragments must be masked");
    let length = match length & 0x7f {
        126 => usize::from(socket.read_u16().await.unwrap()),
        127 => usize::try_from(socket.read_u64().await.unwrap()).unwrap(),
        length => usize::from(length),
    };
    assert!(length <= FRAGMENT, "a wire frame must remain bounded");
    let mut mask = [0; 4];
    socket.read_exact(&mut mask).await.unwrap();
    let mut bytes = vec![0; length];
    socket.read_exact(&mut bytes).await.unwrap();
    for (index, byte) in bytes.iter_mut().enumerate() {
        *byte ^= mask[index % 4];
    }
    Raw {
        final_: flags & 0x80 != 0,
        opcode: flags & 0xf,
        bytes,
    }
}
async fn message(socket: &mut TcpStream) -> Vec<u8> {
    let mut bytes = Vec::new();
    let mut first = true;
    loop {
        let frame = raw(socket).await;
        assert_eq!(frame.opcode, if first { 1 } else { 0 });
        bytes.extend_from_slice(&frame.bytes);
        first = false;
        if frame.final_ {
            return bytes;
        }
    }
}
struct Allocation {
    bytes: Vec<u8>,
    dropped: Arc<AtomicBool>,
}
impl AsRef<[u8]> for Allocation {
    fn as_ref(&self) -> &[u8] {
        &self.bytes
    }
}
impl Drop for Allocation {
    fn drop(&mut self) {
        self.dropped.store(true, Ordering::SeqCst);
    }
}
struct ObservedStream {
    stream: TextStream,
    dropped: Arc<AtomicBool>,
}
impl futures_util::Stream for ObservedStream {
    type Item = Result<Bytes, Error>;
    fn poll_next(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        self.stream.as_mut().poll_next(cx)
    }
}
impl Drop for ObservedStream {
    fn drop(&mut self) {
        self.dropped.store(true, Ordering::SeqCst);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fragments_control_and_concurrent_messages_keep_exact_utf8_order() {
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let received_pong = Arc::new(Notify::new());
        let pong = received_pong.clone();
        let mut expected = format!("{{\"text\":\"{}😀tail\"}}", "x".repeat(40_000)).into_bytes();
        let expected_wire = expected.clone();
        let server = tokio::spawn(async move {
            let mut socket = accept(&listener).await;
            let first = raw(&mut socket).await;
            assert_eq!(first.opcode, 1);
            assert!(!first.final_);
            let mut bytes = first.bytes;
            socket.write_all(&[0x89, 1, b'p']).await.unwrap();
            let mut saw_pong = false;
            loop {
                let frame = raw(&mut socket).await;
                if frame.opcode == 10 {
                    assert!(frame.final_);
                    assert_eq!(frame.bytes, b"p");
                    saw_pong = true;
                    // Early application data must be delivered later, not
                    // consumed by the sender's control-frame service.
                    socket
                        .write_all(&[0x81, 6, b'n', b'o', b't', b'i', b'c', b'e'])
                        .await
                        .unwrap();
                    pong.notify_one();
                } else {
                    assert_eq!(
                        frame.opcode, 0,
                        "concurrent messages cannot interleave fragments"
                    );
                    bytes.extend_from_slice(&frame.bytes);
                    if frame.final_ {
                        break;
                    }
                }
            }
            assert!(saw_pong, "a stalled source must not stall control replies");
            assert_eq!(bytes, expected_wire);
            assert_eq!(message(&mut socket).await, b"second");
            let mut byte = [0];
            assert_eq!(socket.read(&mut byte).await.unwrap(), 0);
        });
        let socket = client(address).await;
        // Split a Unicode scalar between source chunks as RFC 6455 permits.
        let split = expected.len() - b"tail\"}".len() - 2;
        let tail = expected.split_off(split);
        let allocation_dropped = Arc::new(AtomicBool::new(false));
        let bytes = Bytes::from_owner(Allocation {
            bytes: expected,
            dropped: allocation_dropped.clone(),
        });
        let ready = Arc::new(Notify::new());
        let waiting = ready.clone();
        let release = Arc::new(Notify::new());
        let resume = release.clone();
        let source = futures_util::stream::once(async move { Ok(bytes) }).chain(
            futures_util::stream::once(async move {
                assert!(
                    allocation_dropped.load(Ordering::SeqCst),
                    "the preceding source allocation is released before pulling another chunk"
                );
                waiting.notify_one();
                resume.notified().await;
                Ok(Bytes::from(tail))
            }),
        );
        let sender_socket = socket.clone();
        let sender = tokio::spawn(async move { sender_socket.send_text(Box::pin(source)).await });
        ready.notified().await;
        let second_socket = socket.clone();
        let second =
            tokio::spawn(async move { second_socket.send(Frame::Text("second".into())).await });
        received_pong.notified().await;
        release.notify_one();
        sender.await.unwrap().unwrap();
        second.await.unwrap().unwrap();
        assert!(
            matches!(socket.receive().await.unwrap(), Some(Frame::Text(text)) if text == "notice")
        );
        socket.close().await.unwrap();
        server.await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dropping_partial_send_releases_custody_and_retry_uses_a_fresh_socket() {
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let partial = Arc::new(Notify::new());
        let observed = partial.clone();
        let server = tokio::spawn(async move {
            let mut first = accept(&listener).await;
            let frame = raw(&mut first).await;
            assert_eq!(frame.opcode, 1);
            assert!(!frame.final_);
            assert_eq!(frame.bytes, b"{\"text\":");
            observed.notify_one();
            let mut byte = [0];
            assert_eq!(
                first.read(&mut byte).await.unwrap(),
                0,
                "cancelled JSON cannot receive a FIN or a later request"
            );
            let mut retry = accept(&listener).await;
            assert_eq!(message(&mut retry).await, b"{\"text\":\"same fixed view\"}");
        });
        let socket = client(address).await;
        let source_dropped = Arc::new(AtomicBool::new(false));
        let allocation_dropped = Arc::new(AtomicBool::new(false));
        let bytes = Bytes::from_owner(Allocation {
            bytes: b"{\"text\":".to_vec(),
            dropped: allocation_dropped.clone(),
        });
        let stream = futures_util::stream::once(async move { Ok(bytes) })
            .chain(futures_util::stream::pending());
        let source = ObservedStream {
            stream: Box::pin(stream),
            dropped: source_dropped.clone(),
        };
        let sending_socket = socket.clone();
        let sending = tokio::spawn(async move { sending_socket.send_text(Box::pin(source)).await });
        partial.notified().await;
        sending.abort();
        assert!(sending.await.unwrap_err().is_cancelled());
        socket.close().await.unwrap();
        assert!(source_dropped.load(Ordering::SeqCst));
        assert!(allocation_dropped.load(Ordering::SeqCst));
        assert!(matches!(
            socket.send(Frame::Text("must not send".into())).await,
            Err(Error::Cancelled)
        ));
        // Only the caller may authorize a retry; the socket never resends a
        // partial message. A new source is opened on a new connection here.
        let retry = client(address).await;
        retry
            .send_text(Box::pin(futures_util::stream::iter([
                Ok(Bytes::from_static(b"{\"text\":")),
                Ok(Bytes::from_static(b"\"same fixed view\"}")),
            ])))
            .await
            .unwrap();
        retry.close().await.unwrap();
        server.await.unwrap();
    })
    .await
    .unwrap();
}
