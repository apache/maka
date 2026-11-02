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
    sync::atomic::{AtomicBool, Ordering},
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
            source: None,
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

struct CountClose(Arc<std::sync::atomic::AtomicUsize>);
impl http::UploadCleanup for CountClose {
    fn close(&self) -> BoxFuture<'_, Result<(), http::Error>> {
        Box::pin(async move {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })
    }
}
struct ReopenOriginal {
    opened: Arc<std::sync::atomic::AtomicUsize>,
    closed: Arc<std::sync::atomic::AtomicUsize>,
}
impl maka_agent_ports::model::FrozenPrompt for ReopenOriginal {
    fn open(
        &self,
        cancellation: CancellationToken,
    ) -> BoxFuture<'_, Result<maka_agent_ports::model::MaterializedPrompt, ModelError>> {
        Box::pin(async move {
            if cancellation.is_cancelled() {
                return Err(ModelError::Cancelled);
            }
            self.opened.fetch_add(1, Ordering::SeqCst);
            Ok(maka_agent_ports::model::MaterializedPrompt {
                prompt: vec![crate::prompt::Message::user("original frozen input")].into(),
                cleanup: Arc::new(CountClose(self.closed.clone())),
            })
        })
    }
}
struct RejectBody(Mutex<Option<Vec<u8>>>);
impl http::Body for RejectBody {
    fn next(&self) -> BoxFuture<'_, Result<Option<Vec<u8>>, http::Error>> {
        Box::pin(async move { Ok(self.0.lock().unwrap().take()) })
    }
    fn cancel(&self) {}
    fn close(&self) -> BoxFuture<'_, Result<(), http::Error>> {
        Box::pin(async { Ok(()) })
    }
}
struct UsageRejection(Arc<Mutex<Vec<serde_json::Value>>>);
impl Transport for UsageRejection {
    fn identity(&self) -> u64 {
        7
    }
    fn connect(&self, _: Connect) -> BoxFuture<'_, Result<Arc<dyn Socket>, ModelError>> {
        Box::pin(async { panic!("HTTP usage negotiation cannot open a socket") })
    }
    fn request(
        &self,
        request: http::Request,
        cancellation: CancellationToken,
    ) -> BoxFuture<'_, Result<http::Response, ModelError>> {
        Box::pin(async move {
            let (mut upload, mut receipt) = http::upload::track(request.body, cancellation);
            let mut bytes = Vec::new();
            while let Some(chunk) = upload.next().await {
                bytes.extend_from_slice(&chunk.unwrap());
            }
            receipt.close_source().await.unwrap();
            drop(upload);
            receipt.finish().await.unwrap();
            let count = {
                let mut requests = self.0.lock().unwrap();
                requests.push(serde_json::from_slice(&bytes).unwrap());
                requests.len()
            };
            Ok(http::Response {
                head: http::Head {
                    status: 400,
                    url: request.url,
                    headers: vec![("content-type".into(), b"application/json".to_vec())],
                },
                body: Arc::new(RejectBody(Mutex::new(Some(if count == 1 {
                    br#"{"error":{"message":"stream_options include_usage unsupported","type":"invalid_request_error"}}"#.to_vec()
                } else {
                    br#"{"error":{"message":"request rejected after usage negotiation","type":"invalid_request_error"}}"#.to_vec()
                })))),
            })
        })
    }
}

#[tokio::test]
async fn usage_rejection_reopens_frozen_input_once_with_the_exact_header_variant() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let opened = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let closed = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let context = Context {
        transport: Arc::new(UsageRejection(requests.clone())),
        events: Arc::new(NoEvents),
        cancellation: CancellationToken::new(),
        idle_timeout: Duration::from_secs(30),
        source: Some(maka_agent_ports::model::RequestSource {
            cleanup: Arc::new(CountClose(closed.clone())),
            frozen: Arc::new(ReopenOriginal {
                opened: opened.clone(),
                closed: closed.clone(),
            }),
        }),
    };
    let result = run(
        Request {
            language: Default::default(),
            provider: maka_agent_ports::model::Provider {
                kind: crate::ProviderKind::OpenaiCompatible {
                    name: "fixture".into(),
                },
                model: "fixture".into(),
                base_url: "https://fixture.test/v1".into(),
                auth: maka_agent_ports::model::Credentials::ApiKey("fixture".into()),
                headers: Default::default(),
                body_overlay: None,
            },
            prompt: vec![crate::prompt::Message::user("original frozen input")].into(),
            tools: Vec::new(),
            provider_options: serde_json::Value::Null,
            max_output_tokens: None,
        },
        &context,
        Arc::new(Shared::default()),
    )
    .await;
    assert!(
        matches!(
            &result,
            Err(ModelError::Http { status: 400, message: Some(message) })
                if message.as_str() == "request rejected after usage negotiation"
        ),
        "{result:?}"
    );
    assert_eq!(opened.load(Ordering::SeqCst), 1);
    assert_eq!(closed.load(Ordering::SeqCst), 2);
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(
        requests[0]["messages"],
        serde_json::json!([{"role":"user","content":"original frozen input"}])
    );
    let mut expected = requests[0].clone();
    assert_eq!(
        expected.as_object_mut().unwrap().remove("stream_options"),
        Some(serde_json::json!({"include_usage": true}))
    );
    assert_eq!(requests[1], expected);
}
