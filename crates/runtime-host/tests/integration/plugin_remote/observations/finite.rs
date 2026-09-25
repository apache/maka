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
use maka_transport::{MessageReader, MessageWriter, TransportError};
use std::sync::atomic::AtomicBool;
use tokio::sync::mpsc;

struct Reader(mpsc::UnboundedReceiver<Value>);
impl MessageReader for Reader {
    async fn read(&mut self) -> Result<Option<Value>, TransportError> {
        Ok(self.0.recv().await)
    }
}
struct Writer {
    frames: mpsc::UnboundedSender<Value>,
    pause: Arc<AtomicBool>,
    entered: CancellationToken,
}
impl MessageWriter for Writer {
    async fn write(&mut self, frame: &Value) -> Result<(), TransportError> {
        if self.pause.load(Ordering::SeqCst) && frame["requestId"] == "owned-observation" {
            self.entered.cancel();
            std::future::pending::<()>().await;
        }
        self.frames
            .send(frame.clone())
            .map_err(|_| TransportError::Closed)
    }
    async fn close_after_flush(&mut self) -> Result<(), TransportError> {
        Ok(())
    }
}
fn send(sender: &mpsc::UnboundedSender<Value>, id: &str, input: Value) {
    sender
        .send(json!({"requestId":id,"operation":"plugin.remote","input":input}))
        .unwrap();
}
async fn rpc(
    sender: &mpsc::UnboundedSender<Value>,
    receiver: &mut mpsc::UnboundedReceiver<Value>,
    input: Value,
) -> Value {
    send(sender, "setup", input);
    loop {
        let frame = receiver.recv().await.unwrap();
        if frame["requestId"] == "setup" {
            return success(frame);
        }
        assert!(frame.get("requestId").is_none());
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
async fn invalid_and_duplicate_next_requests_cannot_bypass_the_finite_flush_budget() {
    tokio::time::timeout(Duration::from_secs(15), async {
        for (duplicate, unflushed) in [(false, false), (true, false), (true, true)] {
            let (fixture, host, state, _) = fixture().await;
            let (sender, frames) = mpsc::unbounded_channel();
            let (replies, mut receiver) = mpsc::unbounded_channel();
            let pause = Arc::new(AtomicBool::new(false));
            let entered = CancellationToken::new();
            let connection = tokio::spawn({
                let host = host.clone();
                let pause = pause.clone();
                let entered = entered.clone();
                async move { host.local_owner_connection(Reader(frames), Writer { frames: replies, pause, entered }).await }
            });
            sender.send(json!({"kind":"hello","clientInstanceId":"observation-overload", "protocolMin":0,"protocolMax":0,"compatibilityEpoch":maka_protocol::COMPATIBILITY_EPOCH,"compositionId":maka_protocol::COMPOSITION_ID})).unwrap();
            let hello = receiver.recv().await.unwrap();
            assert_eq!(hello["kind"], "accepted");
            let documents = [
                rpc(&sender, &mut receiver, json!({"kind":"open_document"})).await["document"].clone(),
                rpc(&sender, &mut receiver, json!({"kind":"open_document"})).await["document"].clone(),
            ];
            let call_binding = json!({"packageId":"example.remote","method":"echo","sessionId":null});
            let call_target = rpc(&sender, &mut receiver, json!({"kind":"bind","binding":call_binding})).await["target"].clone();
            let next = if duplicate {
                let document = &documents[0];
                let binding = json!({"packageId":"example.remote","method":"events","sessionId":null});
                let target = rpc(&sender, &mut receiver, json!({"kind":"bind","binding":binding})).await["target"].clone();
                let stream = rpc(&sender, &mut receiver, json!({"kind":"open","binding":binding,"target":target,"document":document,"input":null})).await["stream"].clone();
                let next = json!({"kind":"next","document":document,"stream":stream});
                if unflushed {
                    pause.store(true, Ordering::SeqCst);
                } else {
                    for _ in 0..2 { rpc(&sender, &mut receiver, next.clone()).await; }
                }
                send(&sender, "owned-observation", next.clone());
                if unflushed {
                    entered.cancelled().await;
                } else {
                    loop {
                        let changed = state.reads_changed.notified();
                        if state.reads.load(Ordering::SeqCst) == 1 { break; }
                        changed.await;
                    }
                }
                next
            } else {
                json!({"kind":"next","document":uuid::Uuid::new_v4(),"stream":uuid::Uuid::new_v4()})
            };
            // Occupy finite work without producing replies: response capacity
            // must not race the connection's independent in-flight limit.
            for index in 0..maka_protocol::MAX_IN_FLIGHT_DOMAIN_REQUESTS {
                send(&sender, &format!("finite-{index}"), json!({
                    "kind":"call","binding":call_binding,"target":call_target,
                    "document":documents[index % documents.len()],"input":"blocked"
                }));
            }
            loop {
                let changed = state.calls_changed.notified();
                if state.calls.load(Ordering::SeqCst) == maka_protocol::MAX_IN_FLIGHT_DOMAIN_REQUESTS { break; }
                changed.await;
            }
            send(&sender, "excess", next);
            let error = tokio::time::timeout(Duration::from_secs(2), connection).await
                .expect("invalid Next escaped the ordinary request budget")
                .unwrap().unwrap_err();
            assert!(error.to_string().contains("in-flight request limit"), "{error}");
            assert_eq!(state.live.load(Ordering::SeqCst), 0);
            drop(sender);
            drain(&fixture, host).await;
        }
    }).await.expect("overload test failed to drain");
}
