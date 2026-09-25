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

use super::super::{
    Command, Error as PlanError, Phase, Progress, ProposalStatus, Request, Snapshot, owner::Owner,
};
use futures_util::future::BoxFuture;
use maka_plugins::{
    authorization::{Capability, Id, Request as Authorization, Target},
    contributions::Staged,
    remote::{Caller, Endpoint, Error, Handler, Method, key},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::Arc;

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Input {
    Read,
    History {
        through_revision: Option<u64>,
        #[serde(default)]
        after: u64,
    },
    Artifact {
        revision: Option<u64>,
        source: ArtifactSource,
    },
    Control {
        operation_id: String,
        expected_revision: u64,
        action: Control,
    },
}
#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum ArtifactSource {
    Proposal,
    Execution,
}
#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Control {
    Approve {
        proposal_id: String,
        proposal_revision: u64,
        grant: Id,
    },
    Revise {
        proposal_id: String,
    },
    Abandon {
        proposal_id: String,
    },
    Resume {
        execution_id: String,
        grant: Id,
    },
    Reconcile {
        execution_id: String,
        grant: Id,
    },
    Cancel {
        execution_id: String,
        reason: String,
        grant: Option<Id>,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct View {
    revision: u64,
    proposal: Option<Proposal>,
    execution: Option<Execution>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Proposal {
    id: String,
    plan_id: String,
    revision: u64,
    turn_id: String,
    status: ProposalStatus,
    supersedes: Option<String>,
    source_execution_id: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Execution {
    id: String,
    proposal_id: String,
    steps: Vec<Progress>,
    phase: Phase,
    cancellation: Option<String>,
    updated_at: u64,
}
impl From<Snapshot> for View {
    fn from(snapshot: Snapshot) -> Self {
        Self {
            revision: snapshot.revision,
            proposal: snapshot.proposal.map(|proposal| Proposal {
                id: proposal.id,
                plan_id: proposal.plan_id,
                revision: proposal.revision,
                turn_id: proposal.turn_id,
                status: proposal.status,
                supersedes: proposal.supersedes,
                source_execution_id: proposal.source_execution_id,
            }),
            execution: snapshot.execution.map(|execution| Execution {
                id: execution.id,
                proposal_id: execution.proposal_id,
                steps: execution.steps,
                phase: execution.phase,
                cancellation: execution.cancellation,
                updated_at: execution.updated_at,
            }),
        }
    }
}

pub(super) fn publish(owner: Arc<Owner>, package: &str, staged: &mut Staged) -> Result<(), String> {
    staged
        .insert(
            key(package, "manage").map_err(super::message)?,
            Endpoint::standalone(Handler::Method(Arc::new(Service(owner)))),
        )
        .map_err(super::message)
}
struct Service(Arc<Owner>);
impl Method for Service {
    fn call(&self, input: Value, caller: Caller) -> BoxFuture<'static, Result<Value, Error>> {
        let owner = self.0.clone();
        Box::pin(async move {
            let input: Input =
                serde_json::from_value(input).map_err(|error| Error::Invalid(error.to_string()))?;
            let session = caller
                .session_id
                .as_deref()
                .ok_or_else(|| Error::Invalid("Bind Plan to a Session".into()))?;
            caller.views.session().await?;
            let repo = owner.repository(session).map_err(failed)?;
            let value = match input {
                Input::Read => json!(View::from(repo.current().await.map_err(failed)?)),
                Input::Artifact { revision, source } => {
                    let snapshot = match revision {
                        Some(revision) => repo.at(revision).await,
                        None => repo.current().await,
                    }
                    .map_err(failed)?;
                    let artifact = match source {
                        ArtifactSource::Proposal => {
                            snapshot.proposal.map(|proposal| proposal.artifact)
                        }
                        ArtifactSource::Execution => {
                            snapshot.execution.map(|execution| execution.artifact)
                        }
                    };
                    json!({ "revision": snapshot.revision, "artifact": artifact })
                }
                Input::History {
                    through_revision,
                    after,
                } => {
                    let current = repo.current().await.map_err(failed)?.revision;
                    let through = through_revision.unwrap_or(current);
                    if after > through || through > current {
                        return Err(Error::Invalid(
                            "Plan history cursor is outside committed revisions".into(),
                        ));
                    }
                    let snapshot = if after < through {
                        Some(View::from(repo.at(after + 1).await.map_err(failed)?))
                    } else {
                        None
                    };
                    json!({
                        "throughRevision": through,
                        "snapshots": snapshot.into_iter().collect::<Vec<_>>(),
                        "nextAfter": (after + 1 < through).then_some(after + 1),
                    })
                }
                Input::Control {
                    operation_id,
                    expected_revision,
                    action,
                } => {
                    let owned = caller
                        .views
                        .authorize(Authorization {
                            operation_id: uuid::Uuid::new_v4(),
                            title: "Control Session Plan".into(),
                            target: Target::Session {
                                session_id: session.into(),
                            },
                            capabilities: [Capability::Executions].into(),
                        })
                        .await?;
                    let result = async {
                        let commands = owner.executions.acquire(owned.scope()).await?;
                        commands.session(session.into()).await?;
                        let command = match action {
                            Control::Approve {
                                proposal_id,
                                proposal_revision,
                                grant,
                            } => Command::Approve {
                                proposal_id,
                                proposal_revision,
                                behavior: super::EXECUTION
                                    .to_owned()
                                    .try_into()
                                    .map_err(super::super::invalid)?,
                                grant,
                            },
                            Control::Revise { proposal_id } => Command::Revise { proposal_id },
                            Control::Abandon { proposal_id } => Command::Abandon { proposal_id },
                            Control::Resume {
                                execution_id,
                                grant,
                            } => Command::Resume {
                                execution_id,
                                grant,
                            },
                            Control::Reconcile {
                                execution_id,
                                grant,
                            } => Command::Reconcile {
                                execution_id,
                                grant,
                            },
                            Control::Cancel {
                                execution_id,
                                reason,
                                grant,
                            } => Command::Cancel {
                                execution_id,
                                reason,
                                grant,
                            },
                        };
                        let request = Request {
                            operation_id,
                            expected_revision,
                            command,
                        };
                        // Reading an accepted decision requires current Session
                        // access, not renewal of its former background grant.
                        if let Some(receipt) = repo.receipt(&request).await? {
                            return Ok(receipt);
                        }
                        match &request.command {
                            Command::Approve { grant, .. }
                            | Command::Resume { grant, .. }
                            | Command::Reconcile { grant, .. }
                            | Command::Cancel {
                                grant: Some(grant), ..
                            } => owner.grant(*grant, session).await?,
                            _ => {}
                        }
                        owner.apply(session, &request).await
                    }
                    .await;
                    owned
                        .finish()
                        .await
                        .map_err(|_| Error::CleanupUnconfirmed)?;
                    json!(View::from(result.map_err(failed)?))
                }
            };
            maka_plugins::remote::validate_payload(&value)?;
            Ok(value)
        })
    }
}
fn failed(error: PlanError) -> Error {
    match error {
        PlanError::Storage(maka_plugins::storage::StoreError::OutcomeUnknown(message))
        | PlanError::Execution(maka_plugins::execution::CommandError::OutcomeUnknown(message)) => {
            Error::OutcomeUnknown(message)
        }
        other => Error::Provider(other.to_string()),
    }
}
