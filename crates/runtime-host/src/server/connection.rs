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

use super::{
    ConnectionCount, Host, HostError, authority, operations, outbound::Outbound, subscriptions,
};
use futures_util::{StreamExt, future::BoxFuture, stream::FuturesUnordered};
use maka_protocol::handshake::{HostHandshake, decode_hello};
use maka_protocol::{
    Operation, OperationError, OperationErrorCode, OperationRegistry, Outcome, Response,
    decode_request_envelope,
};
use maka_transport::{MessageReader, MessageWriter};
use std::{
    collections::HashMap,
    sync::{Arc, atomic::Ordering},
    time::Duration,
};
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

type PendingReply = (Response, Option<RequestResidency>);

/// The full request stays resident through response flush. Only mutations
/// block cooperative maintenance; a concurrent status query is not work.
pub(super) struct RequestResidency {
    _request: tokio_util::task::task_tracker::TaskTrackerToken,
    _command: Option<tokio_util::task::task_tracker::TaskTrackerToken>,
}

struct InFlight {
    operation: Operation,
    observation: Option<(Uuid, Uuid)>,
}

enum CompletedRequest {
    Reply(PendingReply),
    Subscription { active: bool },
}

impl Host {
    pub(super) async fn authorized_connection(
        self: Arc<Self>,
        mut reader: impl MessageReader,
        mut writer: impl MessageWriter,
        authority: authority::Authority,
        closed: CancellationToken,
    ) -> Result<(), HostError> {
        let _close_on_exit = closed.clone().drop_guard();
        self.connections.fetch_add(1, Ordering::SeqCst);
        let _registration = ConnectionCount(&self.connections);
        let mut changes = self.changes.subscribe();
        let mut commits = self.log.subscribe_commits();
        let mut shell_changes = self.log.subscribe_shell_changes();
        let mut pty_changes = self.shells.subscribe_output();
        let mut pty_pending = false;
        let subscriptions = Arc::new(tokio::sync::Mutex::new(subscriptions::Subscriptions::new(
            self.subscriptions.clone(),
        )));
        let mut observing = false;
        let mut shell_change = None;
        let mut pending = false;
        let value = timeout(self.options.handshake_timeout, reader.read())
            .await??
            .ok_or("connection ended before hello")?;
        let hello = decode_hello(&value)?;
        self.root.validate_current()?;
        authority
            .validate_client(&self.configuration, &hello.client_instance_id)
            .await?;
        let connection_id = Uuid::new_v4();
        let mut plugin_remotes = Some(self.plugin_remotes.connection(connection_id));
        let _uploads = self.uploads.connection(connection_id);
        let (handshake, _accepted, _retirement) =
            self.admit_handshake(&hello, &authority, connection_id)?;
        let accepted = matches!(handshake, HostHandshake::Accepted { .. });
        timeout(
            Duration::from_secs(5),
            writer.write(&serde_json::to_value(handshake)?),
        )
        .await??;
        if !accepted {
            timeout(Duration::from_secs(2), writer.close_after_flush()).await??;
            return Ok(());
        }
        self.accepted_connection_revision
            .fetch_add(1, Ordering::SeqCst);
        let outbound = Outbound::default();
        let delivery = outbound.run(writer, &closed);
        let connection = async {
            let mut refresh: Option<BoxFuture<'_, Result<bool, HostError>>> = None;
            let provider_closed = closed.child_token();
            let mut controllers = Some(self.controllers.connection(connection_id));
            let (endpoint, mut reverse) =
                maka_client_capability::Endpoint::channel_with_cancellation(
                    64,
                    provider_closed.clone(),
                );
            let mut capability_connection = authority
                .capability_identity(hello.client_instance_id.clone())
                .map(|identity| self.capabilities.attach(connection_id, identity, endpoint))
                .transpose()?;
            let mut requests: FuturesUnordered<BoxFuture<'_, Result<CompletedRequest, HostError>>> =
                FuturesUnordered::new();
            let mut in_flight = HashMap::<String, InFlight>::new();
            let mut input_open = true;
            let result = async {
        loop {
            if closed.is_cancelled() || (input_open && capability_connection.is_some() && provider_closed.is_cancelled()) {
                closed.cancel();
                break;
            }
            if !input_open && requests.is_empty() {
                break;
            }
            let value = tokio::select! {
                // Fair readiness selection also covers producers: ready RPCs
                // must not starve a PTY before its frame reaches the writer.
                _ = closed.cancelled() => break,
                _ = provider_closed.cancelled(), if input_open && capability_connection.is_some() => {
                    closed.cancel();
                    break;
                }
                Some(reply) = requests.next(), if !requests.is_empty() => {
                    match reply? {
                        CompletedRequest::Reply(reply) => enqueue_reply(&self, &outbound, reply).await?,
                        CompletedRequest::Subscription { active } => observing = active,
                    }
                    pending = true;
                    pty_pending = true;
                    continue;
                }
                frame = reverse.recv(), if capability_connection.is_some() => {
                    let Some(frame) = frame else { break };
                    self.root.validate_current()?;
                    outbound.enqueue(serde_json::to_value(frame)?).await?;
                    continue;
                }
                id = outbound.flushed(), if !in_flight.is_empty() => {
                    in_flight.remove(&id);
                    continue;
                }
                value = reader.read(), if input_open => match value? {
                    Some(value) => value,
                    None => {
                        input_open = false;
                        capability_connection.take();
                        controllers.take();
                        plugin_remotes.take();
                        continue;
                    }
                },
                notice = changes.recv(), if input_open => {
                    let notice = notice?;
                    if authority.receives(&notice) {
                        outbound.enqueue(notice).await?;
                    }
                    pending = true;
                    continue;
                }
                result = commits.changed(), if input_open => {
                    result?;
                    pending = true;
                    continue;
                }
                change = shell_changes.recv(), if input_open && observing && shell_change.is_none() => {
                    // Lag cannot be silently skipped: reconnect reconstructs the
                    // resource view from SQL. Only this observer is abandoned.
                    shell_change = Some(change?);
                    continue;
                }
                mut subscriptions = subscriptions.lock(), if shell_change.is_some() => {
                    subscriptions.resource_changed(&self, &shell_change.take().unwrap())?;
                    pending = true;
                    pty_pending = true;
                    continue;
                }
                refreshed = async { refresh.as_mut().unwrap().await }, if refresh.is_some() => {
                    pending |= refreshed?;
                    refresh = None;
                    continue;
                }
                _ = std::future::ready(()), if input_open && pending && refresh.is_none() && changes.is_empty() => {
                    let through = *commits.borrow_and_update();
                    pending = false;
                    let (host, outbound, subscriptions) = (&self, &outbound, subscriptions.clone());
                    // Keep this future alive across select iterations: refresh
                    // awaits must not suspend reading or cancel a partial cut.
                    refresh = Some(Box::pin(async move {
                        let catalog_pending = host.session_catalog.publish_commits(&host.log, through).await?;
                        let mut subscriptions = subscriptions.lock().await;
                        let (frames, subscription_pending) = subscriptions.poll(host, outbound).await?;
                        // Delivery state and queue order have one owner. Open,
                        // close and resource frames cannot overtake this cut.
                        for frame in frames { outbound.enqueue(frame).await?; }
                        Ok(catalog_pending || subscription_pending)
                    }));
                    continue;
                }
                changed = pty_changes.changed(), if input_open && observing => {
                    changed?;
                    pty_pending = true;
                    continue;
                }
                _ = outbound.pty_flushed(), if input_open && observing => {
                    pty_pending = true;
                    continue;
                }
                mut subscriptions = subscriptions.lock(), if input_open && pty_pending => {
                    if let Some(frame) = subscriptions.poll_pty(&self, &outbound)? {
                        outbound.enqueue(frame).await?;
                    } else {
                        pty_pending = false;
                    }
                    continue;
                }
            };
            // Cancellation wins admission even if read and revocation became
            // ready together. Already accepted operations still settle below.
            if closed.is_cancelled() || (input_open && capability_connection.is_some() && provider_closed.is_cancelled()) {
                closed.cancel();
                break;
            }
            self.root.validate_current()?;
            if value["kind"]
                .as_str()
                .is_some_and(|kind| kind.starts_with("client.capability."))
            {
                if !authority.can_publish_capabilities() {
                    return Err("Client Capability publication is not authorized".into());
                }
                let frame = maka_protocol::capability::decode_client_frame(&value)?;
                self.capabilities.broker.accept(connection_id, frame)?;
                continue;
            }
            let mut request = decode_request_envelope(&value)?;
            let implemented = operations::Operations.error_codes(request.operation).is_some();
            if implemented {
                request.input = operations::Operations
                    .decode_input(request.operation, &request.input)
                    .map_err(|error| format!("invalid {} input: {error}", request.operation))?;
            }
            // The client may immediately reuse an ID after seeing its reply.
            // Fair read selection must not mistake a pending flush ack for an
            // unfinished request or consume its already released admission slot.
            while let Some(id) = outbound.try_flushed() {
                in_flight.remove(&id);
            }
            if in_flight.contains_key(&request.request_id) {
                return Err("Client reused an active request id".into());
            }
            let authorized = authority.authorizes(&request);
            let observation = if authorized && request.operation == Operation::PluginRemote {
                match serde_json::from_value::<maka_protocol::plugin::RemoteRequest>(request.input.clone()) {
                    Ok(maka_protocol::plugin::RemoteRequest::Next { document, stream })
                        if self.plugin_remotes.owns_stream(connection_id, document, stream)
                            && !in_flight.values().any(|active| active.observation == Some((document, stream))) => Some((document, stream)),
                    _ => None,
                }
            } else { None };
            // Owned, unique stream waits do not occupy the finite request lane.
            // Invalid/duplicate Next requests retain ordinary overload behavior.
            let finite = in_flight.values().filter(|active| active.observation.is_none()).count();
            let reserve = finite == maka_protocol::MAX_IN_FLIGHT_DOMAIN_REQUESTS && (request.operation == Operation::HostStatus
                || in_flight.values().any(|active| active.operation == Operation::HostStatus));
            if observation.is_none() && finite >= maka_protocol::MAX_IN_FLIGHT_DOMAIN_REQUESTS && !reserve {
                return Err("Client exceeded the in-flight request limit".into());
            }
            // Register before checking admission, with no await between them:
            // drain cannot observe zero while an admitted request is untracked.
            // A Remote next only awaits delivery from an already owned stream.
            // Keep its flush resident, but let retirement cancel idle observers.
            let is_observation = request.operation.mode() == maka_protocol::operation::OperationMode::Query
                || observation.is_some();
            let mut residency = Some(RequestResidency {
                _request: self.requests.token(),
                _command: (!is_observation).then(|| self.commands.token()),
            });
            in_flight.insert(request.request_id.clone(), InFlight { operation: request.operation, observation });
            let phase = *self.retirement.lock().unwrap_or_else(|e| e.into_inner());
            let draining = phase == super::retirement::Phase::Retiring || self.draining.is_cancelled();
            if draining {
                residency.take();
            }
            let outcome = if !authorized {
                Outcome::failure(OperationError {
                    code: OperationErrorCode::Unauthorized,
                    message: "Runtime Host operation is not authorized".into(),
                })
            } else if draining && !matches!(request.operation, Operation::HostStatus | Operation::HostDiagnosticsQuery) {
                Outcome::failure(OperationError {
                    code: OperationErrorCode::HostDraining,
                    message: "Host is draining".into(),
                })
            } else if phase == super::retirement::Phase::Preparing
                && !super::retirement::allows_preparing(request.operation)
            {
                Outcome::failure(OperationError {
                    code: OperationErrorCode::HostDraining,
                    message: "Host is preparing a cooperative handoff".into(),
                })
            } else if !implemented {
                Outcome::failure(OperationError {
                    code: request.operation.unavailable_error(),
                    message: format!("{} is not implemented by this Rust Host", request.operation),
                })
            } else if maka_protocol::subscription::errors(request.operation).is_some() {
                if request.operation == Operation::SubscriptionOpen && !observing {
                    // Old invalidations cannot affect a newly bootstrapped view.
                    shell_changes = self.log.subscribe_shell_changes();
                    observing = true;
                }
                let (host, outbound, subscriptions) = (&self, &outbound, subscriptions.clone());
                requests.push(Box::pin(async move {
                    let mut subscriptions = subscriptions.lock().await;
                    let outcome = subscriptions.dispatch(host, request.operation, request.input, outbound).await?;
                    enqueue_reply(host, outbound, (Response {
                        request_id: request.request_id,
                        operation: request.operation,
                        outcome,
                    }, residency)).await?;
                    Ok(CompletedRequest::Subscription { active: !subscriptions.is_empty() })
                }));
                continue;
            } else {
                let (host, authority, client, closed) = (&self, &authority, &hello.client_instance_id, &closed);
                requests.push(Box::pin(async move {
                    if closed.is_cancelled() { return Err("Connection closed before dispatch".into()); }
                    let outcome = host
                        .dispatch(
                            request.operation,
                            request.input,
                            connection_id,
                            authority,
                            client,
                        )
                        .await?;
                    Ok(CompletedRequest::Reply((
                        Response {
                            request_id: request.request_id,
                            operation: request.operation,
                            outcome,
                        },
                        residency,
                    )))
                }));
                continue;
            };
            let response = Response {
                request_id: request.request_id,
                operation: request.operation,
                outcome,
            };
            enqueue_reply(&self, &outbound, (response, residency)).await?;
            // The outbound open barrier precedes every resulting stream frame.
            // Commits during bootstrap remain visible through the installed watch.
            pending = true;
            pty_pending = true;
        }
        Ok(())
        }.await;
            if result.is_err() {
                closed.cancel();
            }
            drop(controllers);
            drop(plugin_remotes.take());
            drop(capability_connection);
            // Drop observation-only work before draining accepted operations;
            // otherwise a paused refresh could retain their subscription lock.
            drop(refresh.take());
            // Revocation/error stops transport delivery, not accepted dispatch. Its
            // durable/effect boundary retains request/root residency until settled.
            while requests.next().await.is_some() {}
            drop(subscriptions);
            outbound.close();
            result
        };
        let (result, delivered) = tokio::join!(connection, delivery);
        result.and(delivered)
    }
}

async fn enqueue_reply(
    host: &Host,
    outbound: &Outbound,
    (response, residency): PendingReply,
) -> Result<(), HostError> {
    host.root.validate_current()?;
    // Admission remains tracked through the one connection writer's flush.
    let fatal = matches!(&response.outcome, Outcome::Failure { error }
        if error.code == OperationErrorCode::CommitOutcomeUnknown);
    if fatal {
        host.draining.cancel();
    }
    outbound.reply(response, residency, fatal).await
}
