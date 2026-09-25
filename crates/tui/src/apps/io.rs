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
mod document;
mod watches;
pub use document::Document;
pub use watches::{Change, Watch, Watches};
pub mod transcript;
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
pub async fn execute(
    client: &Client,
    request: &Request,
    document: Option<Document>,
) -> Result<Output, Failure> {
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
            let Output::Reply(reply) = call(
                client,
                &entry,
                input,
                session(&entry, request),
                document.as_ref(),
            )
            .await?
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
        Work::Call { entry, input } => {
            call(
                client,
                entry,
                input,
                session(entry, request),
                document.as_ref(),
            )
            .await
        }
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
            call(
                client,
                entry,
                &input,
                session(entry, request),
                document.as_ref(),
            )
            .await
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
    owner: Option<&Document>,
) -> Result<Output, Failure> {
    input.validate().map_err(|_| Failure { unknown: false })?;
    let owner = owner.ok_or(Failure { unknown: false })?;
    let _call = owner.lock().await;
    let document = owner.id().await?;
    if !owner.accepts(&entry.target) {
        return Err(Failure { unknown: false });
    }
    let result = call_document(client, entry, input, session, document).await;
    if result.is_ok() {
        owner.initialized();
    } else {
        owner.retire();
    }
    result
}

async fn call_document(
    client: &Client,
    entry: &TerminalViewProjection,
    input: &Input,
    session: Option<String>,
    document: uuid::Uuid,
) -> Result<Output, Failure> {
    let result = client
        .plugin_remote(RemoteRequest::Call {
            binding: binding(entry, session),
            target: entry.target.clone(),
            document,
            input: serde_json::to_value(input).expect("terminal request"),
        })
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
    Ok(Output::Reply(reply))
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
