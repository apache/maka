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
use futures_util::{StreamExt, future::BoxFuture};
use maka_agent_ports::model::{Connect, Events, Socket, Transport};
use std::{
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
    time::Duration,
};
use tokio::time::Instant;

struct NoEvents;
impl Events for NoEvents {
    fn emit(&self, _: Emission) -> BoxFuture<'_, Result<(), ModelError>> {
        Box::pin(async { Ok(()) })
    }
}
struct EmptyBody;
impl http::Body for EmptyBody {
    fn next(&self) -> BoxFuture<'_, Result<Option<Vec<u8>>, http::Error>> {
        Box::pin(async { Ok(None) })
    }
    fn cancel(&self) {}
    fn close(&self) -> BoxFuture<'_, Result<(), http::Error>> {
        Box::pin(async { Ok(()) })
    }
}
struct PullTransport {
    wait_for_headers: bool,
    settled: Arc<AtomicBool>,
}
impl Transport for PullTransport {
    fn identity(&self) -> u64 {
        1
    }
    fn connect(&self, _: Connect) -> BoxFuture<'_, Result<Arc<dyn Socket>, ModelError>> {
        Box::pin(async { panic!("HTTP fixture must not connect a socket") })
    }
    fn request(
        &self,
        request: http::Request,
        cancellation: CancellationToken,
    ) -> BoxFuture<'_, Result<http::Response, ModelError>> {
        Box::pin(async move {
            let mut source = request.body.into_stream();
            loop {
                tokio::select! {
                    biased;
                    _ = cancellation.cancelled() => break,
                    chunk = source.next() => match chunk {
                        Some(chunk) => { chunk.unwrap(); }
                        None if self.wait_for_headers => cancellation.cancelled().await,
                        None => return Ok(http::Response {
                            head: http::Head { status: 200, url: request.url, headers: Vec::new() },
                            body: Arc::new(EmptyBody),
                        }),
                    },
                }
            }
            drop(source);
            // Confirm dispatch awaits the original upload's settlement.
            tokio::time::sleep(Duration::from_secs(7)).await;
            self.settled.store(true, Ordering::SeqCst);
            Err(ModelError::Cancelled)
        })
    }
}
fn context(wait_for_headers: bool) -> (Context, Arc<AtomicBool>) {
    let settled = Arc::new(AtomicBool::new(false));
    (
        Context {
            transport: Arc::new(PullTransport {
                wait_for_headers,
                settled: settled.clone(),
            }),
            events: Arc::new(NoEvents),
            cancellation: CancellationToken::new(),
            idle_timeout: Duration::from_secs(30),
        },
        settled,
    )
}
fn upload(chunks: Vec<(u64, &'static [u8])>) -> http::Request {
    let stream = futures_util::stream::iter(chunks).then(|(delay, bytes)| async move {
        tokio::time::sleep(Duration::from_secs(delay)).await;
        Ok(http::Bytes::from_static(bytes))
    });
    http::Request {
        method: http::Method::Post,
        url: "https://fixture.test/".into(),
        headers: Vec::new(),
        body: http::RequestBody::stream(stream),
    }
}
#[tokio::test(start_paused = true)]
async fn positive_upload_progress_outlives_the_total_idle_interval() {
    let (context, _) = context(false);
    let start = Instant::now();
    dispatch(
        &context,
        upload(vec![(20, b"first"), (20, b"second"), (20, b"last")]),
    )
    .await
    .unwrap();
    assert_eq!(start.elapsed(), Duration::from_secs(60));
}
#[tokio::test(start_paused = true)]
async fn empty_chunks_and_completed_uploads_do_not_extend_header_wait() {
    for chunks in [
        vec![(20, b"first".as_slice())],
        vec![(20, b"first".as_slice()), (20, b"".as_slice())],
        vec![(20, b"first".as_slice()), (40, b"stalled".as_slice())],
    ] {
        let (context, settled) = context(true);
        let start = Instant::now();
        assert!(matches!(
            dispatch(&context, upload(chunks)).await,
            Err(ModelError::TimedOut)
        ));
        assert!(settled.load(Ordering::SeqCst));
        assert_eq!(
            start.elapsed(),
            Duration::from_secs(57),
            "30s idle after last positive upload plus 7s settlement"
        );
    }
}

#[tokio::test(start_paused = true)]
async fn another_upload_cannot_keep_a_stalled_attempt_alive() {
    let (active, _) = context(false);
    let (stalled, settled) = context(false);
    let start = Instant::now();
    let active_request = upload(vec![(20, b"first"), (20, b"second"), (20, b"last")]);
    let stalled_request = upload(vec![(100, b"pending")]);
    let stalled_attempt = async {
        let result = dispatch(&stalled, stalled_request).await;
        assert!(matches!(result, Err(ModelError::TimedOut)));
        assert!(settled.load(Ordering::SeqCst));
        assert_eq!(start.elapsed(), Duration::from_secs(37));
    };
    let (result, ()) = tokio::join!(dispatch(&active, active_request), stalled_attempt);
    result.unwrap();
}
#[tokio::test(start_paused = true)]
async fn cancellation_during_upload_preserves_its_cause_and_waits_for_settlement() {
    let (context, settled) = context(false);
    let cancellation = context.cancellation.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(5)).await;
        cancellation.cancel();
    });
    let start = Instant::now();
    assert!(matches!(
        dispatch(&context, upload(vec![(20, b"pending")])).await,
        Err(ModelError::Cancelled)
    ));
    assert!(settled.load(Ordering::SeqCst));
    assert_eq!(start.elapsed(), Duration::from_secs(12));
}
#[tokio::test(start_paused = true)]
async fn replay_retains_exact_length_and_observes_each_transport_pull() {
    let (activity, mut progress) = tokio::sync::watch::channel(Instant::now());
    let opens = Arc::new(AtomicUsize::new(0));
    let source_opens = opens.clone();
    let original = http::RequestBody::replayable(move || {
        source_opens.fetch_add(1, Ordering::SeqCst);
        http::RequestBody::with_length(
            futures_util::stream::iter([
                Ok(http::Bytes::from_static(b"pay")),
                Ok(http::Bytes::from_static(b"load")),
            ]),
            7,
        )
    });
    assert_eq!(opens.load(Ordering::SeqCst), 1);
    let original = observe_upload(original, activity);
    assert_eq!(
        opens.load(Ordering::SeqCst),
        1,
        "observation preserves the initial cursor"
    );
    assert_eq!(original.length(), Some(7));
    let replay = original.replay_source().unwrap();
    let mut original = Some(original);
    for expected_opens in 1..=2 {
        let body = original.take().unwrap_or_else(|| replay.open());
        assert_eq!(opens.load(Ordering::SeqCst), expected_opens);
        assert_eq!(body.length(), Some(7));
        assert!(body.replay_source().is_some());
        let mut source = body.into_stream();
        let mut received = Vec::new();
        for expected in [b"pay".as_slice(), b"load".as_slice()] {
            tokio::time::advance(Duration::from_secs(20)).await;
            let chunk = source.next().await.unwrap().unwrap();
            assert_eq!(chunk.as_ref(), expected);
            received.extend_from_slice(&chunk);
            assert_eq!(*progress.borrow_and_update(), Instant::now());
        }
        assert_eq!(received, b"payload");
        assert!(source.next().await.is_none());
    }
}
