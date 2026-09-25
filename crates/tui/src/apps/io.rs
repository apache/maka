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

use super::{Request, Work};
use maka_client::{Client, ClientError, RequestFailure};
use maka_plugins::terminal_ui::view::{Reply, Request as Input};
use maka_protocol::plugin::{
    Page, Query, QueryResult, RemoteBinding, RemoteKind, RemoteRequest, RemoteResult,
    TerminalViewProjection, View,
};

pub enum Output {
    Directory(Page<TerminalViewProjection>),
    Reply(Reply),
    Rebound {
        entry: Box<TerminalViewProjection>,
        reply: Reply,
    },
}
pub struct Failure {
    pub unknown: bool,
}
fn failure(error: RequestFailure, writing: bool) -> Failure {
    let unknown = matches!(&error, RequestFailure::Unknown(_))
        || matches!(&error,
        RequestFailure::Rejected(ClientError::Rejected(error)) if matches!(error.code,
        maka_protocol::OperationErrorCode::OutcomeUnknown | maka_protocol::OperationErrorCode::CommitOutcomeUnknown));
    Failure {
        unknown: writing && unknown,
    }
}
pub async fn execute(client: &Client, request: &Request) -> Result<Output, Failure> {
    match &request.work {
        Work::Rebind { entry, input } => {
            if !matches!(input, Input::Read { .. } | Input::Recover { .. }) {
                return Err(Failure { unknown: false });
            }
            let RemoteResult::Bound {
                target,
                handler: RemoteKind::Method,
            } = client
                .plugin_remote(RemoteRequest::Bind {
                    binding: binding(entry, session(entry, request)),
                })
                .await
                .map_err(|error| failure(error, false))?
            else {
                return Err(Failure { unknown: false });
            };
            // A fresh registration may serve the original entry, never a replacement owner.
            if target.entry_id != entry.target.entry_id {
                return Err(Failure { unknown: false });
            }
            let mut entry = entry.clone();
            entry.target = target;
            let Output::Reply(reply) =
                call(client, &entry, input, session(&entry, request)).await?
            else {
                return Err(Failure { unknown: false });
            };
            Ok(Output::Rebound { entry, reply })
        }
        Work::Directory(cursor) => {
            let result = client
                .plugin_query(Query {
                    view: View::TerminalViews,
                    root_id: Some(maka_plugins::composition::Scope::Profile),
                    cursor: cursor.clone(),
                    limit: Some(super::PAGE),
                })
                .await
                .map_err(|error| failure(error, false))?;
            match result {
                QueryResult::TerminalViews(page) => Ok(Output::Directory(page)),
                _ => Err(Failure { unknown: false }),
            }
        }
        Work::Call { entry, input } => call(client, entry, input, session(entry, request)).await,
        Work::Authorize {
            entry,
            input,
            proposal,
        } => {
            let result = client
                .plugin_authorization(maka_protocol::plugin::AuthorizationInput::Remote {
                    binding: binding(entry, session(entry, request)),
                    target: entry.target.clone(),
                    command: maka_protocol::plugin::AuthorizationCommand::Approve {
                        request: proposal.clone(),
                    },
                })
                .await
                .map_err(|error| failure(error, true))?;
            let maka_protocol::plugin::AuthorizationResult::Grant { grant: Some(grant) } = result
            else {
                return Err(Failure { unknown: true });
            };
            if grant.revoked {
                return Err(Failure { unknown: false });
            }
            let mut input = input.clone();
            let Input::Submit { grant: receipt, .. } = &mut input else {
                return Err(Failure { unknown: false });
            };
            *receipt = Some(grant.id);
            call(client, entry, &input, session(entry, request)).await
        }
    }
}

fn session(entry: &TerminalViewProjection, request: &Request) -> Option<String> {
    match entry.descriptor.context {
        maka_plugins::terminal_ui::Context::Application => None,
        maka_plugins::terminal_ui::Context::Session => {
            request.key.as_ref().and_then(|key| key.session.clone())
        }
    }
}
fn binding(entry: &TerminalViewProjection, session_id: Option<String>) -> RemoteBinding {
    RemoteBinding::Package {
        package_id: entry.package_id.clone(),
        method: entry.method.clone(),
        session_id,
    }
}
async fn call(
    client: &Client,
    entry: &TerminalViewProjection,
    input: &Input,
    session: Option<String>,
) -> Result<Output, Failure> {
    input.validate().map_err(|_| Failure { unknown: false })?;
    let RemoteResult::Document { document } = client
        .plugin_remote(RemoteRequest::OpenDocument)
        .await
        .map_err(|error| failure(error, false))?
    else {
        return Err(Failure { unknown: false });
    };
    let result = client
        .plugin_remote(RemoteRequest::Call {
            binding: binding(entry, session),
            target: entry.target.clone(),
            document,
            input: serde_json::to_value(input).expect("terminal request"),
        })
        .await;
    // The finite call always owns cleanup, even after navigation. Do not
    // replace a known write receipt with a CloseDocument failure.
    let closed = client
        .plugin_remote(RemoteRequest::CloseDocument { document })
        .await;
    let writing = matches!(input, Input::Submit { .. });
    let RemoteResult::Value { value } = result.map_err(|error| failure(error, writing))? else {
        return Err(Failure { unknown: writing });
    };
    let reply: Reply = serde_json::from_value(value).map_err(|_| Failure { unknown: writing })?;
    reply.validate().map_err(|_| Failure { unknown: writing })?;
    if !(matches!(
        (&input, &reply),
        (
            Input::Read { .. },
            Reply::View { .. } | Reply::Conflict | Reply::Rejected { .. }
        ) | (
            Input::Recover { .. },
            Reply::Applied { .. } | Reply::Unrecorded | Reply::Conflict | Reply::Rejected { .. }
        ) | (
            Input::Submit { .. },
            Reply::Applied { .. } | Reply::Conflict | Reply::Rejected { .. }
        )
    ) || matches!(
        (input, &reply),
        (Input::Submit { grant: None, .. }, Reply::Consent { .. })
    )) {
        return Err(Failure { unknown: writing });
    }
    if !writing {
        closed.map_err(|error| failure(error, false))?;
    }
    Ok(Output::Reply(reply))
}

/// A changes stream a view declared: the package's stream method, for one
/// session or for the application.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Watch {
    pub package: String,
    pub method: String,
    pub session: Option<String>,
    /// Replacing a plugin restarts its stream even when its method name stays.
    pub activation: String,
}

pub enum Change {
    /// The stream said its views are stale.
    Stale(Watch),
    /// The stream ended or failed; it may start again when still wanted.
    Ended(Watch),
}

/// Changes streams kept open while a view that declared one is on screen.
/// Each runs in its own task; dropping its sender cancels it, and it closes
/// its stream and document on the way out.
pub struct Watches {
    running: std::collections::HashMap<Watch, tokio::sync::oneshot::Sender<()>>,
    changes: tokio::sync::mpsc::UnboundedSender<Change>,
}

/// A stream that ends or fails waits this long before it may start again.
const RESTART: std::time::Duration = std::time::Duration::from_secs(10);

impl Watches {
    pub fn new() -> (Self, tokio::sync::mpsc::UnboundedReceiver<Change>) {
        let (changes, receiver) = tokio::sync::mpsc::unbounded_channel();
        (
            Self {
                running: Default::default(),
                changes,
            },
            receiver,
        )
    }
    /// Starts what is wanted and not running; stops what no longer is.
    pub fn reconcile(&mut self, client: &Client, wanted: std::collections::BTreeSet<Watch>) {
        self.running.retain(|watch, _| wanted.contains(watch));
        for watch in wanted {
            if self.running.contains_key(&watch) {
                continue;
            }
            let (stop, stopped) = tokio::sync::oneshot::channel();
            self.running.insert(watch.clone(), stop);
            tokio::spawn(follow(client.clone(), watch, self.changes.clone(), stopped));
        }
    }
    pub fn ended(&mut self, watch: &Watch) {
        self.running.remove(watch);
    }
    pub fn stop(&mut self) {
        self.running.clear();
    }
}

async fn follow(
    client: Client,
    watch: Watch,
    changes: tokio::sync::mpsc::UnboundedSender<Change>,
    mut stopped: tokio::sync::oneshot::Receiver<()>,
) {
    let binding = RemoteBinding::Package {
        package_id: watch.package.clone(),
        method: watch.method.clone(),
        session_id: watch.session.clone(),
    };
    let bound = async {
        let RemoteResult::Bound {
            target,
            handler: RemoteKind::Stream,
        } = client
            .plugin_remote(RemoteRequest::Bind {
                binding: binding.clone(),
            })
            .await
            .ok()?
        else {
            return None;
        };
        (target.activation == watch.activation).then_some(target)
    };
    let target = tokio::select! {
        _ = &mut stopped => return,
        target = bound => target,
    };
    // Once a document is allocated, retain its identity through cancellation
    // so a pending Open/Next cannot strand Host resources.
    let document = if target.is_some() {
        match client.plugin_remote(RemoteRequest::OpenDocument).await {
            Ok(RemoteResult::Document { document }) => Some(document),
            _ => None,
        }
    } else {
        None
    };
    let stopped_early = if let (Some(target), Some(document)) = (target, document) {
        let observe = async {
            let Ok(RemoteResult::Opened { stream }) = client
                .plugin_remote(RemoteRequest::Open {
                    binding,
                    target,
                    document,
                    input: serde_json::Value::Null,
                })
                .await
            else {
                return false;
            };
            // Subscribe before the authoritative reread: a write between the
            // first rendered view and this Open must not be missed forever.
            if changes.send(Change::Stale(watch.clone())).is_err() {
                return true;
            }
            loop {
                match client
                    .plugin_remote(RemoteRequest::Next { document, stream })
                    .await
                {
                    Ok(RemoteResult::Item { .. }) => {
                        if changes.send(Change::Stale(watch.clone())).is_err() {
                            break true;
                        }
                    }
                    Ok(RemoteResult::Pending) => {}
                    _ => break false,
                }
            }
        };
        let stopped_early = tokio::select! {
            _ = &mut stopped => true,
            ended = observe => ended,
        };
        let _ = client
            .plugin_remote(RemoteRequest::CloseDocument { document })
            .await;
        stopped_early
    } else {
        false
    };
    if stopped_early {
        return;
    }
    tokio::select! {
        _ = &mut stopped => {}
        _ = tokio::time::sleep(RESTART) => {
            let _ = changes.send(Change::Ended(watch));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_protocol::{OperationError, OperationErrorCode};

    #[test]
    fn host_unknown_write_receipts_and_transport_loss_are_not_rejections() {
        for (code, unknown) in [
            (OperationErrorCode::OutcomeUnknown, true),
            (OperationErrorCode::CommitOutcomeUnknown, true),
            (OperationErrorCode::OperationConflict, false),
            (OperationErrorCode::InvalidRequest, false),
        ] {
            let error = RequestFailure::Rejected(ClientError::Rejected(OperationError {
                code,
                message: "detail".into(),
            }));
            assert_eq!(failure(error.clone(), true).unknown, unknown);
            assert!(!failure(error, false).unknown);
        }
        assert!(failure(RequestFailure::Unknown(ClientError::Timeout), true).unknown);
        assert!(!failure(RequestFailure::NotDispatched(ClientError::Timeout), true).unknown);
    }
}
