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

//! Faults occur at the actual provider socket boundary, before any model output.
use super::*;
use crate::support::store::SessionFixture;
use futures_util::future::BoxFuture;
use maka_agent_ports::model::{
    self, Binding, Context, Frame, Lifetime, ProviderAdapter, Request, Session, Socket, Transport,
};
use maka_capabilities::http;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

#[derive(Clone, Copy, PartialEq, Eq)]
enum Fault {
    Send,
    Idle,
    OpaqueIdle,
    Protocol,
}

struct Injected {
    inner: Binding,
    fault: Fault,
    sent: Arc<std::sync::Mutex<Vec<serde_json::Value>>>,
    closed: Arc<AtomicBool>,
    requests: Arc<AtomicUsize>,
}
impl ProviderAdapter for Injected {
    fn supports_item_acceptance(&self) -> bool {
        self.inner.supports_item_acceptance()
    }
    fn enforces_idle_timeout(&self) -> bool {
        self.inner.enforces_idle_timeout()
    }
    fn open(
        &self,
        lifetime: Lifetime,
        cancellation: CancellationToken,
    ) -> BoxFuture<'_, Result<Arc<dyn Session>, ModelError>> {
        Box::pin(async move {
            Ok(Arc::new(InjectedSession {
                inner: self.inner.open(lifetime, cancellation).await?,
                fault: self.fault,
                sent: self.sent.clone(),
                closed: self.closed.clone(),
                requests: self.requests.clone(),
            }) as Arc<dyn Session>)
        })
    }
}
struct InjectedSession {
    inner: Arc<dyn Session>,
    fault: Fault,
    sent: Arc<std::sync::Mutex<Vec<serde_json::Value>>>,
    closed: Arc<AtomicBool>,
    requests: Arc<AtomicUsize>,
}
impl Session for InjectedSession {
    fn try_switch_fallback_transport(&self) -> bool {
        self.inner.try_switch_fallback_transport()
    }
    fn stream(
        &self,
        request: Request,
        mut context: Context,
    ) -> BoxFuture<'static, Result<(), ModelError>> {
        context.transport = Arc::new(InjectedNetwork {
            inner: context.transport,
            fault: self.fault,
            sent: self.sent.clone(),
            closed: self.closed.clone(),
            requests: self.requests.clone(),
        });
        self.inner.stream(request, context)
    }
}
struct InjectedNetwork {
    inner: Arc<dyn Transport>,
    fault: Fault,
    sent: Arc<std::sync::Mutex<Vec<serde_json::Value>>>,
    closed: Arc<AtomicBool>,
    requests: Arc<AtomicUsize>,
}
impl Transport for InjectedNetwork {
    fn identity(&self) -> u64 {
        self.inner.identity()
    }
    fn request(
        &self,
        request: http::Request,
        cancellation: tokio_util::sync::CancellationToken,
    ) -> BoxFuture<'_, Result<http::Response, ModelError>> {
        assert!(
            self.closed.load(Ordering::SeqCst),
            "the failed socket must close before recovery"
        );
        self.requests.fetch_add(1, Ordering::SeqCst);
        self.inner.request(request, cancellation)
    }
    fn connect(&self, _: model::Connect) -> BoxFuture<'_, Result<Arc<dyn Socket>, ModelError>> {
        let socket = FaultSocket {
            fault: self.fault,
            sent: self.sent.clone(),
            closed: self.closed.clone(),
            received: AtomicBool::new(false),
        };
        Box::pin(async move { Ok(Arc::new(socket) as Arc<dyn Socket>) })
    }
}
struct FaultSocket {
    fault: Fault,
    sent: Arc<std::sync::Mutex<Vec<serde_json::Value>>>,
    closed: Arc<AtomicBool>,
    received: AtomicBool,
}
impl Drop for FaultSocket {
    fn drop(&mut self) {
        self.closed.store(true, Ordering::SeqCst);
    }
}
impl Socket for FaultSocket {
    fn send_text(&self, mut chunks: model::TextStream) -> BoxFuture<'_, Result<(), ModelError>> {
        Box::pin(async move {
            use futures_util::StreamExt;
            let mut bytes = Vec::new();
            while let Some(chunk) = chunks.next().await {
                bytes.extend_from_slice(&chunk?);
            }
            self.send(Frame::Text(String::from_utf8(bytes).unwrap()))
                .await
        })
    }

    fn send(&self, frame: Frame) -> BoxFuture<'_, Result<(), ModelError>> {
        let Frame::Text(text) = frame else {
            panic!("expected model request")
        };
        self.sent
            .lock()
            .unwrap()
            .push(serde_json::from_str(&text).unwrap());
        Box::pin(async move {
            match self.fault {
                Fault::Send => Err(ModelError::Provider(maka_model::ProviderFailure::new(
                    maka_model::ProviderFailureReason::Network,
                    "Broken pipe",
                    false,
                    None,
                ))),
                Fault::Protocol => Err(ModelError::Adapter("invalid WebSocket message".into())),
                Fault::Idle | Fault::OpaqueIdle => Ok(()),
            }
        })
    }
    fn receive(&self) -> BoxFuture<'_, Result<Option<Frame>, ModelError>> {
        Box::pin(async move {
            if self.fault == Fault::OpaqueIdle && !self.received.swap(true, Ordering::SeqCst) {
                return Ok(Some(Frame::Text(
                    json!({"type":"response.future_call.in_progress"}).to_string(),
                )));
            }
            std::future::pending().await
        })
    }
    fn close(&self) -> BoxFuture<'_, Result<(), ModelError>> {
        Box::pin(async { Ok(()) })
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn send_and_idle_faults_recover_the_original_request_but_opaque_effects_and_protocol_errors_stop()
 {
    tokio::time::timeout(Duration::from_secs(15), async {
        for fault in [Fault::Send, Fault::Idle, Fault::OpaqueIdle, Fault::Protocol] {
            let recover = matches!(fault, Fault::Send | Fault::Idle);
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}/v1", listener.local_addr().unwrap());
            let sent = Arc::new(std::sync::Mutex::new(Vec::<serde_json::Value>::new()));
            let closed = Arc::new(AtomicBool::new(false));
            let requests = Arc::new(AtomicUsize::new(0));
            let server_sent = sent.clone();
            let server = tokio::spawn(async move {
                if !recover { return; }
                let (mut socket, _) = listener.accept().await.unwrap();
                let body = read_request(&mut socket).await;
                assert_eq!(body["input"], server_sent.lock().unwrap()[0]["input"]);
                assert!(body.get("previous_response_id").is_none());
                let completed = json!({"type":"response.completed","response":{"id":"recovered","output":[{"type":"message","id":"answer","content":[{"type":"output_text","text":"recovered answer"}]}]}});
                let body = format!("data: {completed}\n\n");
                socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
            });
            let directory = tempfile::tempdir().unwrap();
            let log = Arc::new(SessionFixture::open(&directory.path().join("events.sqlite")).await.unwrap());
            let mut input = input(&base, "recovery");
            input.provider.kind = ProviderKind::OpenaiResponses;
            // Exercise the subscription adapter, including timeout ownership forwarding.
            input.provider.adapter = Some("codex-responses".into());
            let executor = ModelExecutor::new(Duration::from_millis(150)).unwrap();
            let inner = executor.binding(&input.provider).unwrap();
            let binding = Binding::new(Arc::new(Injected { inner: inner.clone(), fault, sent: sent.clone(), closed: closed.clone(), requests: requests.clone() }), inner.source().clone());
            let engine = Engine::new(executor.with_adapters(BTreeMap::from([("codex-responses".into(), binding)])), CodeExecutor::new(CellLimits::default()).unwrap()).unwrap();
            let result = engine.run(log.store(), input, CancellationToken::new()).await;
            engine.drain().await;
            server.await.unwrap();
            assert!(closed.load(Ordering::SeqCst));
            assert_eq!(sent.lock().unwrap().len(), 1, "transport never replays a failed send");
            assert_eq!(requests.load(Ordering::SeqCst), usize::from(recover));
            let prefix = log.prefix(100, 128 * 1024).await.unwrap();
            let expected_interruption = match fault {
                Fault::Send | Fault::Idle => maka_agent_facts::event::ModelInterruption::RetryableFailure,
                Fault::OpaqueIdle => maka_agent_facts::event::ModelInterruption::TimedOut,
                Fault::Protocol => maka_agent_facts::event::ModelInterruption::Failed,
            };
            assert!(prefix.events.iter().any(|event| matches!(&event.event.fact, Fact::ModelInterrupted { status, .. } if *status == expected_interruption)));
            let attempts: Vec<_> = prefix.events.iter().filter_map(|event| match &event.event.fact {
                Fact::ModelRequested { input_digest, source_high_water, .. } => Some((input_digest, source_high_water)), _ => None,
            }).collect();
            if recover {
                result.unwrap();
                assert_eq!(attempts.len(), 2);
                assert_eq!(attempts[0], attempts[1], "no accepted progress preserves the frozen source");
                assert!(prefix.events.iter().any(|event| matches!(&event.event.fact, Fact::ModelCompleted { output, .. } if output.parts.iter().filter_map(|part| match part { maka_agent_facts::model::ModelPart::Text { text_kind: maka_agent_facts::model::TextKind::Text, text, .. } => Some(text.as_str()), _ => None }).collect::<Vec<_>>() == ["recovered answer"])));
                assert!(matches!(&prefix.events.last().unwrap().event.fact, Fact::InvocationEnded { outcome: InvocationOutcome::Completed }));
            } else {
                assert!(result.is_err());
                assert_eq!(attempts.len(), 1);
                let expected = if fault == Fault::OpaqueIdle { "model_timeout" } else { "model_adapter" };
                assert!(matches!(&prefix.events.last().unwrap().event.fact, Fact::InvocationEnded { outcome: InvocationOutcome::Failed { class, .. } } if class == expected));
            }
        }
    }).await.expect("recovery and terminal boundaries must settle");
}
