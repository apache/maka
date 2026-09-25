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

use crate::presentation::{OAuthPresentation, Presentation};
use crate::subscription::{PendingObservation, Subscriptions};
use crate::{Notification, notification};
use maka_protocol::{
    COMPATIBILITY_EPOCH, COMPOSITION_ID, MAX_IN_FLIGHT_DOMAIN_REQUESTS, Operation,
    OperationRegistry, Outcome, PROTOCOL_VERSION, Request,
    handshake::{ClientHello, HostHandshake, Lifecycle, decode_host_handshake},
};
use serde_json::Value;
use std::{collections::HashMap, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncRead, AsyncWrite},
    sync::{OwnedSemaphorePermit, Semaphore, mpsc, oneshot, watch},
};
use tokio_util::sync::CancellationToken;

const QUEUE_CAPACITY: usize = 32;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostIdentity {
    pub root_id: String,
    pub host_epoch: String,
    pub connection_id: String,
}

#[derive(Clone, Debug, thiserror::Error)]
pub enum ClientError {
    #[error("Host connection closed: {0}")]
    Closed(String),
    #[error("Invalid Host protocol: {0}")]
    Protocol(String),
    #[error("Host rejected the operation: {0}")]
    Rejected(maka_protocol::OperationError),
    #[error("Host request timed out")]
    Timeout,
    #[error("Host identity, compatibility or ready state differs from discovery")]
    Incompatible,
}

/// Unknown means bytes may have reached the Host. It is never a retry signal.
#[derive(Clone, Debug, thiserror::Error)]
pub enum RequestFailure {
    #[error("Request was not dispatched: {0}")]
    NotDispatched(ClientError),
    #[error("Request outcome is unknown: {0}")]
    Unknown(ClientError),
    #[error("{0}")]
    Rejected(ClientError),
}

enum Admission {
    Ordinary,
    Control,
    Observation,
}
impl Admission {
    fn operation(operation: Operation) -> Self {
        if matches!(
            operation,
            Operation::SubscriptionReady | Operation::SubscriptionClose
        ) {
            Self::Control
        } else {
            Self::Ordinary
        }
    }
}

struct Command {
    request: Request,
    reply: oneshot::Sender<Result<Value, ClientError>>,
    permit: Option<OwnedSemaphorePermit>,
    presentation: Option<mpsc::Sender<OAuthPresentation>>,
}

pub(crate) struct PendingRequest {
    received: oneshot::Receiver<Result<Value, ClientError>>,
}

impl PendingRequest {
    pub(crate) async fn settle(self) -> Result<Value, RequestFailure> {
        // A retained receiver keeps the exact queued request observable after a
        // caller's response deadline. Only that caller chooses when to stop waiting.
        match self.received.await {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(error @ ClientError::Rejected(_))) => Err(RequestFailure::Rejected(error)),
            Ok(Err(error)) => Err(RequestFailure::Unknown(error)),
            Err(error) => Err(RequestFailure::Unknown(closed(error))),
        }
    }
}

struct Pending {
    operation: Operation,
    observation: PendingObservation,
    reply: oneshot::Sender<Result<Value, ClientError>>,
    _permit: Option<OwnedSemaphorePermit>,
    presentation: Option<String>,
}

struct Shared {
    cancel: CancellationToken,
}
impl Drop for Shared {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

/// Clones share one reader/writer and admission limit. Last handle drop closes
/// the connection; the actor cannot keep its own client handle alive.
#[derive(Clone)]
pub struct Client {
    pub identity: HostIdentity,
    commands: mpsc::Sender<Command>,
    capacity: Arc<Semaphore>,
    control_capacity: Arc<Semaphore>,
    shared: Arc<Shared>,
    registry: Arc<dyn OperationRegistry + Send + Sync>,
    closed: watch::Receiver<Option<ClientError>>,
}

impl Client {
    pub async fn connect<S, R>(
        stream: S,
        expected_root: &str,
        expected_epoch: &str,
        registry: R,
    ) -> Result<(Self, mpsc::Receiver<Notification>), ClientError>
    where
        S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
        R: OperationRegistry + Send + Sync + 'static,
    {
        let cancel = CancellationToken::new();
        let (mut reader, mut writer) = maka_transport::ndjson::split(stream, cancel.clone());
        let identity = tokio::time::timeout(Duration::from_secs(5), async {
            writer
                .write(&ClientHello {
                    client_instance_id: format!("maka-tui-{}", uuid::Uuid::new_v4()),
                    protocol_min: PROTOCOL_VERSION,
                    protocol_max: PROTOCOL_VERSION,
                    compatibility_epoch: COMPATIBILITY_EPOCH,
                    composition_id: COMPOSITION_ID.into(),
                    generation: None,
                    takeover: None,
                })
                .await
                .map_err(closed)?;
            let value = reader
                .read()
                .await
                .map_err(closed)?
                .ok_or_else(|| closed("EOF during handshake"))?;
            match decode_host_handshake(&value).map_err(protocol)? {
                HostHandshake::Accepted {
                    root_id,
                    host_epoch,
                    connection_id,
                    selected_protocol,
                    compatibility_epoch,
                    composition_id,
                    state: Lifecycle::Ready,
                    ..
                } if root_id == expected_root
                    && host_epoch == expected_epoch
                    && selected_protocol == PROTOCOL_VERSION
                    && compatibility_epoch == COMPATIBILITY_EPOCH
                    && composition_id == COMPOSITION_ID =>
                {
                    Ok(HostIdentity {
                        root_id,
                        host_epoch,
                        connection_id,
                    })
                }
                _ => Err(ClientError::Incompatible),
            }
        })
        .await
        .map_err(|_| ClientError::Timeout)??;

        let registry: Arc<dyn OperationRegistry + Send + Sync> = Arc::new(registry);
        let (commands, mut commands_rx) = mpsc::channel::<Command>(QUEUE_CAPACITY);
        let (notices, notifications) = mpsc::channel(QUEUE_CAPACITY);
        let (closed_tx, closed_rx) = watch::channel(None);
        // Observation setup/teardown must remain admissible under domain load.
        let capacity = Arc::new(Semaphore::new(MAX_IN_FLIGHT_DOMAIN_REQUESTS - 4));
        let client = Self {
            identity,
            commands,
            capacity,
            control_capacity: Arc::new(Semaphore::new(4)),
            shared: Arc::new(Shared {
                cancel: cancel.clone(),
            }),
            registry: registry.clone(),
            closed: closed_rx,
        };
        let epoch = client.identity.host_epoch.clone();
        tokio::spawn(async move {
            let (outbound, mut outbound_rx) =
                mpsc::channel::<Value>(MAX_IN_FLIGHT_DOMAIN_REQUESTS + 2);
            let mut writer_task = tokio::spawn(async move {
                while let Some(request) = outbound_rx.recv().await {
                    // This task alone owns writes. A stalled write cannot stop
                    // the independent reader from draining Host events/replies.
                    tokio::time::timeout(REQUEST_TIMEOUT, writer.write(&request))
                        .await
                        .map_err(|_| closed("Host write timed out"))?
                        .map_err(closed)?;
                }
                Ok::<(), ClientError>(())
            });
            let mut pending = HashMap::<String, Pending>::new();
            let mut subscriptions = Subscriptions::default();
            let mut presentation = Presentation::default();
            let mut queued_command: Option<Command> = None;
            let mut control_frame: Option<Value> = None;
            let failure = loop {
                let presentation_consumer = presentation.consumer();
                tokio::select! {
                    _ = cancel.cancelled() => break closed("client disconnected"),
                    _ = notices.closed() => break closed("notification consumer dropped"),
                    _ = async {
                        match presentation_consumer {
                            Some(sender) => sender.closed().await,
                            None => std::future::pending().await,
                        }
                    } => break closed("OAuth presentation consumer dropped"),
                    frame = presentation.completion(), if control_frame.is_none() => {
                        control_frame = Some(frame);
                    },
                    result = &mut writer_task => break match result {
                        Ok(Err(error)) => error,
                        Ok(Ok(())) => closed("Host writer ended"),
                        Err(error) => closed(error),
                    },
                    frame = reader.read() => {
                        let value = match frame {
                            Ok(Some(value)) => value,
                            Ok(None) => break closed("Host reached EOF"),
                            Err(error) => break closed(error),
                        };
                        if value.get("kind").and_then(Value::as_str)
                            .is_some_and(maka_protocol::capability::is_host_frame_kind)
                        {
                            let produced = match presentation.frame(&value) {
                                Ok(produced) => produced,
                                Err(error) => break error,
                            };
                            if control_frame.as_ref().is_some_and(|frame| !presentation.current_control(frame)) {
                                control_frame = None;
                            }
                            if let Some(frame) = produced
                                && control_frame.replace(frame).is_some() {
                                break protocol("Host presentation exceeded pending control flow");
                            }
                            continue;
                        }
                        if value.get("kind").is_some() {
                            let notice = match notification::decode(&value) {
                                Ok(notice) => notice,
                                Err(error) => break protocol(error),
                            };
                            if let Notification::Observation(frame) = &notice
                                && let Err(error) = subscriptions.accept(frame, &epoch) {
                                break protocol(error);
                            }
                            // Backpressure cannot deadlock replies. Close and rebuild
                            // observation explicitly rather than silently losing events.
                            if notices.try_send(notice).is_err() {
                                break closed("notification consumer is too slow");
                            }
                        } else {
                            let response = match maka_protocol::decode_response(&value, &RegistryRef(registry.as_ref())) {
                                Ok(response) => response,
                                Err(error) => break protocol(error),
                            };
                            let Some(waiter) = pending.remove(&response.request_id) else {
                                break protocol("unmatched response");
                            };
                            if response.operation != waiter.operation {
                                let failure = protocol("response operation mismatch");
                                let _ = waiter.reply.send(Err(failure.clone()));
                                break failure;
                            }
                            if let Some(id) = &waiter.presentation
                                && let Err(failure) = presentation.complete(id, &response.outcome) {
                                let _ = waiter.reply.send(Err(failure.clone()));
                                break failure;
                            }
                            let result = match response.outcome {
                                Outcome::Success { result } => {
                                    if let Err(error) = subscriptions.complete(&waiter.observation, &result, &epoch) {
                                        let failure = protocol(error);
                                        let _ = waiter.reply.send(Err(failure.clone()));
                                        break failure;
                                    }
                                    Ok(result)
                                },
                                Outcome::Failure { error } => Err(ClientError::Rejected(error)),
                            };
                            // Even a timed-out receiver retains the slot until this
                            // exact response arrives (or the connection closes).
                            let opened = waiter.observation.opens_subscription() && result.is_ok();
                            if waiter.reply.send(result).is_err() && opened {
                                // No consumer owns this snapshot. Disconnect to release
                                // the observation, never retry or leak it on the Host.
                                break closed("subscription opener disappeared");
                            }
                        }
                    }
                    command = commands_rx.recv(), if queued_command.is_none() => {
                        let Some(command) = command else { break closed("client disconnected"); };
                        queued_command = Some(command);
                    }
                    ready = outbound.reserve(), if control_frame.is_some() || queued_command.is_some() => {
                        let permit = match ready {
                            Ok(permit) => permit,
                            Err(_) => break closed("Host writer unavailable"),
                        };
                        if let Some(frame) = control_frame.take() {
                            permit.send(frame);
                            continue;
                        }
                        let command = queued_command.take().expect("pending outbound command");
                        if command.reply.is_closed() {
                            continue;
                        }
                        let observation = match subscriptions.prepare(command.request.operation, &command.request.input) {
                            Ok(observation) => observation,
                            Err(error) => {
                                let _ = command.reply.send(Err(protocol(error)));
                                continue;
                            }
                        };
                        let registration = match command.presentation {
                            Some(sender) => match presentation.prepare(&command.request.input, sender) {
                                Ok(id) => Some(id),
                                Err(error) => {
                                    let _ = command.reply.send(Err(error));
                                    continue;
                                }
                            },
                            None => None,
                        };
                        let id = command.request.request_id.clone();
                        pending.insert(id, Pending {
                            operation: command.request.operation,
                            observation,
                            reply: command.reply,
                            _permit: command.permit,
                            presentation: registration,
                        });
                        // Only a writer reservation admits this frame. While
                        // waiting, the same select continues draining replies.
                        permit.send(serde_json::to_value(command.request).expect("wire request"));
                    }
                }
            };
            cancel.cancel();
            writer_task.abort();
            commands_rx.close();
            if let Some(command) = queued_command {
                let _ = command.reply.send(Err(failure.clone()));
            }
            for (_, waiter) in pending {
                let _ = waiter.reply.send(Err(failure.clone()));
            }
            while let Ok(command) = commands_rx.try_recv() {
                let _ = command.reply.send(Err(failure.clone()));
            }
            let _ = closed_tx.send(Some(failure));
        });
        Ok((client, notifications))
    }

    pub async fn request(
        &self,
        operation: Operation,
        input: Value,
    ) -> Result<Value, RequestFailure> {
        self.request_with_timeout(operation, input, REQUEST_TIMEOUT)
            .await
    }

    pub async fn request_with_timeout(
        &self,
        operation: Operation,
        input: Value,
        timeout: Duration,
    ) -> Result<Value, RequestFailure> {
        self.request_inner(
            operation,
            input,
            timeout,
            None,
            Admission::operation(operation),
        )
        .await
    }

    pub(crate) async fn request_presentation(
        &self,
        input: Value,
        sender: mpsc::Sender<OAuthPresentation>,
    ) -> Result<Value, RequestFailure> {
        self.request_inner(
            Operation::ClientCapabilityReplace,
            input,
            REQUEST_TIMEOUT,
            Some(sender),
            Admission::Ordinary,
        )
        .await
    }

    /// Typed stream waits consume owned observation lifetimes, not finite RPC
    /// slots. Raw requests cannot select this admission path.
    pub(crate) async fn request_remote(
        &self,
        input: &maka_protocol::plugin::RemoteRequest,
    ) -> Result<Value, RequestFailure> {
        use maka_protocol::plugin::RemoteRequest;
        let admission = match input {
            RemoteRequest::Next { .. } => Admission::Observation,
            RemoteRequest::Close { .. } | RemoteRequest::CloseDocument { .. } => Admission::Control,
            _ => Admission::Ordinary,
        };
        self.request_inner(
            Operation::PluginRemote,
            serde_json::to_value(input).expect("wire input"),
            REQUEST_TIMEOUT,
            None,
            admission,
        )
        .await
    }

    async fn request_inner(
        &self,
        operation: Operation,
        input: Value,
        timeout: Duration,
        presentation: Option<mpsc::Sender<OAuthPresentation>>,
        admission: Admission,
    ) -> Result<Value, RequestFailure> {
        let deadline = tokio::time::Instant::now() + timeout;
        let pending = self
            .enqueue(operation, input, deadline, presentation, admission)
            .await?;
        tokio::time::timeout_at(deadline, pending.settle())
            .await
            .map_err(|_| RequestFailure::Unknown(ClientError::Timeout))?
    }

    pub(crate) async fn request_pending(
        &self,
        operation: Operation,
        input: Value,
    ) -> Result<PendingRequest, RequestFailure> {
        self.enqueue(
            operation,
            input,
            tokio::time::Instant::now() + REQUEST_TIMEOUT,
            None,
            Admission::operation(operation),
        )
        .await
    }

    async fn enqueue(
        &self,
        operation: Operation,
        input: Value,
        deadline: tokio::time::Instant,
        presentation: Option<mpsc::Sender<OAuthPresentation>>,
        admission: Admission,
    ) -> Result<PendingRequest, RequestFailure> {
        if operation == Operation::ClientCapabilityReplace && presentation.is_none() {
            return Err(RequestFailure::NotDispatched(protocol(
                "Use the OAuth presentation publisher",
            )));
        }
        let input = self
            .registry
            .decode_input(operation, &input)
            .map_err(|error| RequestFailure::NotDispatched(protocol(error)))?;
        // Waiting for both admission and queue space is cancellable and bounded.
        let admitted = tokio::time::timeout_at(deadline, async {
            let capacity = match admission {
                Admission::Ordinary => Some(&self.capacity),
                Admission::Control => Some(&self.control_capacity),
                Admission::Observation => None,
            };
            let permit = match capacity {
                Some(capacity) => Some(capacity.clone().acquire_owned().await.map_err(closed)?),
                None => None,
            };
            let queue = self.commands.reserve().await.map_err(closed)?;
            Ok::<_, ClientError>((permit, queue))
        })
        .await
        .map_err(|_| RequestFailure::NotDispatched(ClientError::Timeout))?
        .map_err(RequestFailure::NotDispatched)?;
        let (reply, received) = oneshot::channel();
        admitted.1.send(Command {
            request: Request {
                request_id: uuid::Uuid::new_v4().to_string(),
                operation,
                input,
            },
            reply,
            permit: admitted.0,
            presentation,
        });
        Ok(PendingRequest { received })
    }

    pub fn disconnect(&self) {
        self.shared.cancel.cancel();
    }

    pub async fn closed(&self) -> ClientError {
        let mut state = self.closed.clone();
        loop {
            if let Some(error) = state.borrow().clone() {
                return error;
            }
            if state.changed().await.is_err() {
                return closed("connection task ended");
            }
        }
    }
}

fn closed(error: impl std::fmt::Display) -> ClientError {
    ClientError::Closed(error.to_string())
}
fn protocol(error: impl std::fmt::Display) -> ClientError {
    ClientError::Protocol(error.to_string())
}

// The protocol's registry API currently takes a sized implementor.
struct RegistryRef<'a>(&'a (dyn OperationRegistry + Send + Sync));
impl OperationRegistry for RegistryRef<'_> {
    fn decode_input(&self, op: Operation, value: &Value) -> maka_protocol::Result<Value> {
        self.0.decode_input(op, value)
    }
    fn decode_output(&self, op: Operation, value: &Value) -> maka_protocol::Result<Value> {
        self.0.decode_output(op, value)
    }
    fn error_codes(&self, op: Operation) -> Option<&[maka_protocol::OperationErrorCode]> {
        self.0.error_codes(op)
    }
}

#[cfg(test)]
mod receipt_tests {
    use super::*;

    #[tokio::test]
    async fn response_deadline_does_not_discard_a_retained_receipt() {
        let (reply, received) = oneshot::channel();
        let pending = PendingRequest { received };
        let settled = pending.settle();
        tokio::pin!(settled);
        assert!(
            tokio::time::timeout(Duration::ZERO, &mut settled)
                .await
                .is_err()
        );
        let receipt = serde_json::json!({"kind":"started","turnId":"exact-turn"});
        reply.send(Ok(receipt.clone())).unwrap();
        assert_eq!(settled.await.unwrap(), receipt);
    }

    #[tokio::test]
    async fn disconnected_retained_receipt_has_unknown_outcome() {
        let (reply, received) = oneshot::channel();
        let pending = PendingRequest { received };
        drop(reply);
        assert!(matches!(
            pending.settle().await,
            Err(RequestFailure::Unknown(ClientError::Closed(_)))
        ));
    }
}

#[cfg(test)]
mod observation_tests {
    use super::*;
    use std::{
        pin::Pin,
        sync::{
            Mutex,
            atomic::{AtomicBool, Ordering},
        },
        task::{Context, Poll, Waker},
    };
    use tokio::io::{AsyncRead, AsyncWrite, DuplexStream, ReadBuf};

    const ROOT: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    #[derive(Default)]
    struct Gate {
        blocked: AtomicBool,
        entered: tokio::sync::Notify,
        writer: Mutex<Option<Waker>>,
    }
    struct HeldWriter {
        stream: DuplexStream,
        gate: Arc<Gate>,
    }
    impl AsyncRead for HeldWriter {
        fn poll_read(
            mut self: Pin<&mut Self>,
            cx: &mut Context<'_>,
            buf: &mut ReadBuf<'_>,
        ) -> Poll<std::io::Result<()>> {
            Pin::new(&mut self.stream).poll_read(cx, buf)
        }
    }
    impl AsyncWrite for HeldWriter {
        fn poll_write(
            mut self: Pin<&mut Self>,
            cx: &mut Context<'_>,
            bytes: &[u8],
        ) -> Poll<std::io::Result<usize>> {
            if self.gate.blocked.load(Ordering::Acquire) {
                *self.gate.writer.lock().unwrap() = Some(cx.waker().clone());
                self.gate.entered.notify_one();
                if self.gate.blocked.load(Ordering::Acquire) {
                    return Poll::Pending;
                }
            }
            Pin::new(&mut self.stream).poll_write(cx, bytes)
        }
        fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
            Pin::new(&mut self.stream).poll_flush(cx)
        }
        fn poll_shutdown(
            mut self: Pin<&mut Self>,
            cx: &mut Context<'_>,
        ) -> Poll<std::io::Result<()>> {
            Pin::new(&mut self.stream).poll_shutdown(cx)
        }
    }

    #[tokio::test]
    async fn saturated_observation_writer_keeps_reading_replies_and_notifications() {
        tokio::time::timeout(Duration::from_secs(3), async {
            use serde_json::json;
            let (local, remote) = tokio::io::duplex(4096);
            let gate = Arc::new(Gate::default());
            let (mut reader, mut writer) = maka_transport::ndjson::split(remote, CancellationToken::new());
            let server = tokio::spawn(async move {
                reader.read().await.unwrap().unwrap();
                writer.write(&json!({"kind":"accepted","rootId":ROOT,"hostEpoch":"epoch","connectionId":"test", "selectedProtocol":PROTOCOL_VERSION,"compatibilityEpoch":COMPATIBILITY_EPOCH,"compositionId":COMPOSITION_ID,"compositionRevision":"test","state":"ready"})).await.unwrap();
                (reader, writer)
            });
            let (client, mut notices) = Client::connect(HeldWriter { stream: local, gate: gate.clone() }, ROOT, "epoch", crate::Operations).await.unwrap();
            let (mut reader, mut writer) = server.await.unwrap();
            let publishing = tokio::spawn({
                let client = client.clone();
                async move { client.publish_oauth_presentation().await }
            });
            let registration = reader.read().await.unwrap().unwrap();
            writer.write(&json!({"requestId":registration["requestId"],"operation":registration["operation"],"ok":true,
                "result":{"registrationId":registration["input"]["registrationId"],"revision":1}})).await.unwrap();
            let mut service = publishing.await.unwrap().unwrap();
            let registration_id = service.registration_id.clone();
            let call = |id: &str| json!({"kind":"client.capability.service_call","registrationId":registration_id,
                "invocationId":id,"serviceId":"oauth_presentation","version":"1","method":"open_external",
                "input":{"url":"https://login.example/device","stateHint":id}});
            let finite = client.request_pending(Operation::HostWake, json!({})).await.unwrap();
            let original = reader.read().await.unwrap().unwrap();
            gate.blocked.store(true, Ordering::Release);
            let mut waiting = Vec::new();
            // One active write, the bounded outbound channel, one staged
            // command and the bounded producer channel are now all occupied.
            let count = 1 + MAX_IN_FLIGHT_DOMAIN_REQUESTS + 2 + 1 + QUEUE_CAPACITY;
            for _ in 0..count {
                waiting.push(client.enqueue(Operation::PluginRemote,
                    json!({"kind":"next","document":uuid::Uuid::new_v4(),"stream":uuid::Uuid::new_v4()}),
                    tokio::time::Instant::now() + REQUEST_TIMEOUT, None, Admission::Observation).await.unwrap());
            }
            gate.entered.notified().await;
            assert_eq!(client.commands.capacity(), 0);
            writer.write(&json!({"requestId":original["requestId"],"operation":"host.wake","ok":true,"result":{}})).await.unwrap();
            writer.write(&json!({"kind":"configuration.changed","revision":7})).await.unwrap();
            assert_eq!(finite.settle().await.unwrap(), json!({}));
            assert!(matches!(notices.recv().await, Some(Notification::Catalog(notice)) if notice.revision == 7));
            assert_eq!(client.capacity.available_permits(), MAX_IN_FLIGHT_DOMAIN_REQUESTS - 4);
            writer.write(&call("original")).await.unwrap();
            writer.write(&json!({"kind":"configuration.changed","revision":8})).await.unwrap();
            assert!(matches!(notices.recv().await, Some(Notification::Catalog(notice)) if notice.revision == 8));
            // A's accepted frame is now staged behind the full writer. A
            // cancellation/release allows B without making A's frame B's own.
            writer.write(&json!({"kind":"client.capability.cancel","invocationId":"original"})).await.unwrap();
            writer.write(&json!({"kind":"client.capability.release","invocationId":"original"})).await.unwrap();
            writer.write(&call("replacement")).await.unwrap();
            writer.write(&json!({"kind":"configuration.changed","revision":9})).await.unwrap();
            assert!(matches!(notices.recv().await, Some(Notification::Catalog(notice)) if notice.revision == 9));
            gate.blocked.store(false, Ordering::Release);
            if let Some(waker) = gate.writer.lock().unwrap().take() { waker.wake(); }
            let mut accepted = 0;
            for _ in 0..count + 1 {
                let frame = reader.read().await.unwrap().unwrap();
                if frame.get("kind").is_some() {
                    assert_eq!(frame["kind"], "client.capability.accepted");
                    assert_eq!(frame["invocationId"], "replacement", "cancelled A must never leave staging");
                    accepted += 1;
                } else {
                    writer.write(&json!({"requestId":frame["requestId"],"operation":"plugin.remote","ok":true,"result":{"kind":"end"}})).await.unwrap();
                }
            }
            assert_eq!(accepted, 1);
            for pending in waiting { assert_eq!(pending.settle().await.unwrap(), json!({"kind":"end"})); }
            writer.write(&json!({"kind":"client.capability.admitted","invocationId":"replacement"})).await.unwrap();
            let shown = service.recv().await.unwrap();
            assert_eq!(shown.state_hint.as_deref(), Some("replacement"));
            assert!(shown.acknowledge_presented());
            let result = reader.read().await.unwrap().unwrap();
            assert_eq!(result["kind"], "client.capability.result");
            assert_eq!(result["invocationId"], "replacement");
            client.disconnect();
        }).await.expect("writer backpressure blocked the independent reader");
    }
}
