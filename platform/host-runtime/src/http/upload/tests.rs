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
use maka_capabilities::http::Bytes;
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
const CHUNK_BYTES: usize = 16 * 1024;
use http_body_util::{BodyExt, Full};
use hyper::{Response, service::service_fn};
use hyper_util::rt::TokioIo;
use std::{
    convert::Infallible,
    sync::atomic::{AtomicUsize, Ordering},
};
use tokio::{net::TcpListener, sync::oneshot};

async fn sink(delay: Option<oneshot::Receiver<()>>) -> (String, tokio::task::JoinHandle<Vec<u8>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/upload", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        let delay = Arc::new(tokio::sync::Mutex::new(delay));
        let received = Arc::new(Mutex::new(Vec::new()));
        let output = received.clone();
        let service = service_fn(move |mut request: hyper::Request<hyper::body::Incoming>| {
            let delay = delay.clone();
            let received = received.clone();
            async move {
                if let Some(delay) = delay.lock().await.take() {
                    let _ = delay.await;
                }
                while let Some(frame) = request.body_mut().frame().await {
                    match frame {
                        Ok(frame) => {
                            if let Ok(bytes) = frame.into_data() {
                                received.lock().unwrap().extend_from_slice(&bytes);
                            }
                        }
                        Err(_) => break,
                    }
                }
                Ok::<_, Infallible>(Response::new(Full::new(Bytes::from_static(b"ok"))))
            }
        });
        let _ = hyper::server::conn::http1::Builder::new()
            .keep_alive(false)
            .serve_connection(TokioIo::new(socket), service)
            .await;
        Arc::try_unwrap(output).unwrap().into_inner().unwrap()
    });
    (url, task)
}

#[tokio::test]
async fn real_http_stream_has_exact_bytes_and_reopens_for_replay() {
    let expected = [b"prefix".as_slice(), &vec![42; 128 * 1024], b"suffix"].concat();
    for _ in 0..2 {
        let (url, server) = sink(None).await;
        // A fresh cursor is opened for each attempt; no transport replay buffer.
        let source = RequestBody::stream(futures_util::stream::iter(vec![
            Ok(Bytes::from_static(b"prefix")),
            Ok(Bytes::from(vec![42; 128 * 1024])),
            Ok(Bytes::from_static(b"suffix")),
        ]));
        let (body, mut receipt) = body(source, CancellationToken::new());
        let response = reqwest::Client::builder()
            .no_proxy()
            .build()
            .unwrap()
            .post(url)
            .body(body)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        drop(response);
        let upload = receipt.finish().await.unwrap();
        assert_eq!(upload["bodyBytes"], expected.len());
        assert_eq!(
            upload["bodyDigest"],
            maka_agent_facts::artifact::content_digest(&expected)
        );
        assert_eq!(upload["bodyComplete"], true);
        assert_eq!(server.await.unwrap(), expected);
    }
}

struct Allocation {
    bytes: Vec<u8>,
    dropped: Arc<AtomicUsize>,
}
impl AsRef<[u8]> for Allocation {
    fn as_ref(&self) -> &[u8] {
        &self.bytes
    }
}
impl Drop for Allocation {
    fn drop(&mut self) {
        self.dropped.fetch_add(1, Ordering::SeqCst);
    }
}

#[tokio::test]
async fn cancellation_keeps_giant_allocation_owned_until_last_transport_slice_drops() {
    let dropped = Arc::new(AtomicUsize::new(0));
    let bytes = Bytes::from_owner(Allocation {
        bytes: vec![7; 1024 * 1024],
        dropped: dropped.clone(),
    });
    let source = RequestBody::stream(futures_util::stream::once(async move { Ok(bytes) }));
    let (mut body, mut receipt) = body(source, CancellationToken::new());
    let frame = body.frame().await.unwrap().unwrap().into_data().unwrap();
    assert_eq!(frame.len(), CHUNK_BYTES);
    drop(body);
    assert_eq!(dropped.load(Ordering::SeqCst), 0);
    let settlement = tokio::spawn(async move { receipt.finish().await });
    tokio::task::yield_now().await;
    assert!(!settlement.is_finished());
    drop(frame);
    settlement.await.unwrap().unwrap();
    assert_eq!(dropped.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn delayed_real_http_sink_backpressures_source_and_cancel_releases_it() {
    let (release, delayed) = oneshot::channel();
    let (url, server) = sink(Some(delayed)).await;
    let pulls = Arc::new(AtomicUsize::new(0));
    let generated = pulls.clone();
    let source = RequestBody::stream(futures_util::stream::unfold(0_usize, move |index| {
        let generated = generated.clone();
        async move {
            if index == 8192 {
                return None;
            }
            generated.fetch_add(1, Ordering::SeqCst);
            Some((Ok(Bytes::from(vec![0; CHUNK_BYTES])), index + 1))
        }
    }));
    let stop = CancellationToken::new();
    let (body, mut receipt) = body(source, stop.clone());
    let connections = maka_network::ConnectionTasks::default();
    let client = connections
        .client_builder(reqwest::Client::builder().no_proxy())
        .build()
        .unwrap();
    let request = tokio::spawn(async move { client.post(url).body(body).send().await });
    tokio::time::timeout(Duration::from_secs(5), async {
        while pulls.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(
        pulls.load(Ordering::SeqCst) < 8192,
        "unread sink must not consume the full 128 MiB source"
    );
    stop.cancel();
    request.abort();
    let _ = request.await;
    connections.close().await;
    let upload = receipt.finish().await.unwrap();
    assert_eq!(upload["bodyComplete"], false);
    drop(release);
    server.abort();
    let _ = server.await;
}
