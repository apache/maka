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

mod registry;
mod views;
mod worker;
pub(super) use registry::Registry;

use super::Host;
use futures_util::FutureExt;
use maka_plugins::remote::{Caller, Error, Handler};
use maka_protocol::{
    OperationError, OperationErrorCode as Code,
    plugin::{RemoteKind, RemoteRequest, RemoteResult},
};
use std::sync::Arc;
use uuid::Uuid;

pub(super) async fn execute(
    host: &Arc<Host>,
    connection: Uuid,
    client: &str,
    authority: &super::authority::Authority,
    request: RemoteRequest,
) -> Result<RemoteResult, OperationError> {
    match request {
        RemoteRequest::OpenDocument => Ok(RemoteResult::Document {
            document: host.plugin_remotes.open(connection)?,
        }),
        RemoteRequest::CloseDocument { document } => {
            if let Some(owner) = host.plugin_remotes.close_document(connection, document)? {
                owner.drained().await?;
                host.plugin_remotes.forget_document(connection, document);
            }
            Ok(RemoteResult::Closed)
        }
        RemoteRequest::Next { document, stream } => {
            let stream = host
                .plugin_remotes
                .get(connection, document)?
                .stream(stream)?;
            Ok(match stream.next().await.map_err(failure)? {
                worker::Item::Value(item) => RemoteResult::Item { item },
                worker::Item::End => RemoteResult::End,
                worker::Item::Pending => RemoteResult::Pending,
            })
        }
        RemoteRequest::Close { document, stream } => {
            let document = host.plugin_remotes.get(connection, document)?;
            if let Ok(stream) = document.stream(stream) {
                stream.close().await.map_err(failure)?;
            }
            document.check_cleanup()?;
            Ok(RemoteResult::Closed)
        }
        request => {
            let (binding, target, call) = match request {
                RemoteRequest::Bind { binding } => (binding, None, None),
                RemoteRequest::Call {
                    binding,
                    target,
                    document,
                    input,
                } => (
                    binding,
                    Some(target),
                    Some((document, input, RemoteKind::Method)),
                ),
                RemoteRequest::Open {
                    binding,
                    target,
                    document,
                    input,
                } => (
                    binding,
                    Some(target),
                    Some((document, input, RemoteKind::Stream)),
                ),
                _ => unreachable!(),
            };
            // Session identity is canonical Host-local, not a Desktop projection.
            let gate = host.executions.lock_admission().await;
            if let Some(session) = binding.session_id() {
                host.log
                    .get_session::<crate::session::SessionConfiguration>(session)
                    .await
                    .map_err(|error| failure(Error::Provider(error.to_string())))?
                    .ok_or_else(|| {
                        failure(Error::Invalid("Remote Session does not exist".into()))
                    })?;
            }
            let bound = host.plugins.bind_remote(&binding, target.as_ref())?;
            if bound.endpoint.value.access == maka_plugins::remote::Access::HostPaths
                && !authority.can_use_host_paths()
            {
                return Err(OperationError {
                    code: Code::Unauthorized,
                    message: "Remote endpoint requires Host path access".into(),
                });
            }
            let Some((document, input, stream)) = call else {
                return Ok(RemoteResult::Bound {
                    target: bound.target,
                    handler: match bound.endpoint.value.handler {
                        Handler::Method(_) => RemoteKind::Method,
                        Handler::Stream(_) => RemoteKind::Stream,
                    },
                });
            };
            let reservation = host.plugin_remotes.get(connection, document)?.reserve(
                &binding,
                &bound.target,
                stream,
                &input,
            )?;
            let cancellation = reservation.document.cancellation.child_token();
            let resources = Arc::new(maka_plugins::call::Resources::default());
            let caller = Caller {
                connection_id: connection,
                client_instance_id: client.into(),
                document_id: document,
                session_id: binding.session_id().map(str::to_owned),
                access: bound.endpoint.value.access,
                views: Arc::new(views::SessionViews {
                    host: Arc::downgrade(host),
                    owner: bound.endpoint.owner.clone(),
                    session_id: binding.session_id().map(str::to_owned),
                    connection_id: connection,
                    client_instance_id: client.into(),
                    authority: authority.clone(),
                    access: bound.endpoint.value.access,
                    cancellation: cancellation.clone(),
                    resources: resources.clone(),
                }),
                resources,
                cancellation,
            };
            match (&bound.endpoint.value.handler, stream) {
                (Handler::Stream(provider), RemoteKind::Stream) => {
                    let provider = provider.clone();
                    let (stream, opened) = worker::start(
                        reservation,
                        bound,
                        provider,
                        input,
                        caller,
                        &host.plugin_tasks,
                    )?;
                    drop(gate);
                    opened
                        .await
                        .map_err(|_| failure(Error::CleanupUnconfirmed))?
                        .map_err(failure)?;
                    Ok(RemoteResult::Opened { stream })
                }
                (Handler::Method(method), RemoteKind::Method) => {
                    let (submitting, settling) = if bound.endpoint.value.terminal_view().is_some() {
                        use maka_plugins::terminal_ui::view::Request;
                        let request: Request = serde_json::from_value(input.clone())
                            .map_err(|error| failure(Error::Invalid(error.to_string())))?;
                        request
                            .validate()
                            .map_err(|error| failure(Error::Invalid(error.to_string())))?;
                        (
                            matches!(request, Request::Submit { .. }),
                            matches!(request, Request::Submit { .. } | Request::Recover { .. }),
                        )
                    } else {
                        (false, false)
                    };
                    let method = method.clone();
                    let leases = bound.admit()?;
                    let bound = Arc::new(bound);
                    let method = reservation.document.method(
                        &binding,
                        bound.clone(),
                        method,
                        &host.plugin_tasks,
                        &input,
                    )?;
                    let preserve_receipt = method.isolated() && settling;
                    let resources = caller.resources.clone();
                    let cancellation = caller.cancellation.clone();
                    let (send, receive) = tokio::sync::oneshot::channel();
                    host.plugin_tasks.spawn(async move {
                        let _leases = leases;
                        let mut result = std::panic::AssertUnwindSafe(method.run(
                            &bound,
                            input,
                            caller,
                            preserve_receipt,
                        ))
                        .catch_unwind()
                        .await
                        .unwrap_or_else(|_| {
                            Err(if method.isolated() {
                                Error::Provider("Terminal page panicked".into())
                            } else {
                                Error::CleanupUnconfirmed
                            })
                        });
                        cancellation.cancel();
                        let mut cleanup_failed = result.is_err()
                            && method
                                .close_failed_page(&reservation.document)
                                .await
                                .is_err();
                        cleanup_failed |= resources.finish().await.is_err();
                        cleanup_failed |= matches!(result, Err(Error::CleanupUnconfirmed));
                        if cleanup_failed {
                            reservation.document.cleanup_failed();
                            bound
                                .endpoint
                                .owner
                                .cleanup_failed("Remote method cleanup is unconfirmed".into());
                            if !(preserve_receipt && result.as_ref().is_ok_and(registry::receipt)) {
                                result = Err(Error::CleanupUnconfirmed);
                            }
                        }
                        let _ = send.send(result);
                        drop(reservation);
                    });
                    drop(gate);
                    let value = receive
                        .await
                        .unwrap_or(Err(Error::CleanupUnconfirmed))
                        .map_err(|error| {
                            // An admitted Submit may have committed before its
                            // callback failed. Cleanup fences above are independent
                            // of the missing business result; only recovery can settle it.
                            let mut error = failure(error);
                            if submitting {
                                error.code = Code::OutcomeUnknown;
                            }
                            error
                        })?;
                    Ok(RemoteResult::Value { value })
                }
                _ => Err(failure(Error::Invalid(
                    "Remote handler kind does not match request".into(),
                ))),
            }
        }
    }
}

fn failure(error: Error) -> OperationError {
    OperationError {
        code: match error {
            Error::Invalid(_) => Code::InvalidRequest,
            Error::Retired | Error::Cancelled => Code::OperationConflict,
            Error::OutcomeUnknown(_) => Code::OutcomeUnknown,
            Error::Provider(_) | Error::CleanupUnconfirmed => Code::OperationUnavailable,
        },
        message: error.to_string(),
    }
}
