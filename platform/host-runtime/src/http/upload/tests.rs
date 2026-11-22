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
    let source = RequestBody::replayable(|| {
        RequestBody::stream(futures_util::stream::iter(vec![
            Ok(Bytes::from_static(b"prefix")),
            Ok(Bytes::from(vec![42; 128 * 1024])),
            Ok(Bytes::from_static(b"suffix")),
        ]))
    });
    let replay = source.replay_source().unwrap();
    for source in [source, replay.open(CancellationToken::new()).await.unwrap()] {
        let (url, server) = sink(None).await;
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
    let settlement = receipt.finish();
    tokio::pin!(settlement);
    assert!(futures_util::poll!(settlement.as_mut()).is_pending());
    drop(frame);
    settlement.await.unwrap();
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

#[tokio::test]
async fn source_receipt_releases_payload_while_response_headers_are_held() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/upload", listener.local_addr().unwrap());
    let (read, received) = oneshot::channel();
    let (release, headers) = oneshot::channel();
    let server = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        let state = Arc::new(tokio::sync::Mutex::new(Some((read, headers))));
        let service = service_fn(move |request: hyper::Request<hyper::body::Incoming>| {
            let state = state.clone();
            async move {
                let (read, headers) = state.lock().await.take().unwrap();
                let bytes = request.into_body().collect().await.unwrap().to_bytes();
                read.send(bytes.to_vec()).unwrap();
                headers.await.unwrap();
                Ok::<_, Infallible>(Response::new(Full::new(Bytes::from_static(b"ok"))))
            }
        });
        hyper::server::conn::http1::Builder::new()
            .keep_alive(false)
            .serve_connection(TokioIo::new(socket), service)
            .await
            .unwrap();
    });
    let dropped = Arc::new(AtomicUsize::new(0));
    let bytes = Bytes::from_owner(Allocation {
        bytes: vec![7; 1024 * 1024],
        dropped: dropped.clone(),
    });
    let source = RequestBody::with_length(
        futures_util::stream::once(async move { Ok(bytes) }),
        1024 * 1024,
    );
    let (body, mut receipt) = body(source, CancellationToken::new());
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let response = client.post(url).body(body).send();
    tokio::pin!(response);
    let received = tokio::select! {
        result = received => result.unwrap(),
        result = &mut response => panic!("headers arrived before release: {result:?}"),
    };
    assert_eq!(received, vec![7; 1024 * 1024]);
    receipt.source_released().await.unwrap();
    assert_eq!(dropped.load(Ordering::SeqCst), 1);
    assert!(futures_util::poll!(response.as_mut()).is_pending());
    release.send(()).unwrap();
    let response = response.await.unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(response.bytes().await.unwrap(), b"ok".as_slice());
    server.await.unwrap();
    assert_eq!(receipt.finish().await.unwrap()["bodyComplete"], true);
}

#[tokio::test]
async fn source_receipt_waits_for_final_chunk_without_requiring_wrapper_drop() {
    let dropped = Arc::new(AtomicUsize::new(0));
    let bytes = Bytes::from_owner(Allocation {
        bytes: vec![9; 8],
        dropped: dropped.clone(),
    });
    let source = RequestBody::with_length(futures_util::stream::once(async move { Ok(bytes) }), 8);
    let (mut body, mut receipt) = body(source, CancellationToken::new());
    let chunk = body.frame().await.unwrap().unwrap().into_data().unwrap();
    assert_eq!(chunk.as_ref(), &[9; 8]);
    {
        let released = receipt.source_released();
        tokio::pin!(released);
        assert!(futures_util::poll!(released.as_mut()).is_pending());
        assert_eq!(dropped.load(Ordering::SeqCst), 0);
        drop(chunk);
        released.await.unwrap();
    }
    assert_eq!(dropped.load(Ordering::SeqCst), 1);
    assert!(body.frame().await.is_none());
    {
        let finished = receipt.finish();
        tokio::pin!(finished);
        assert!(futures_util::poll!(finished.as_mut()).is_pending());
        drop(body);
        assert_eq!(finished.await.unwrap()["bodyComplete"], true);
    }
}
