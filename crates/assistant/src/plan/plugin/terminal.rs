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

mod view;

use super::{
    ID,
    remote::{self, ControlError},
};
use crate::plan::{Command, Error as PlanError, Request, Snapshot, owner::Owner};
use futures_util::future::BoxFuture;
use maka_plugins::{
    authorization::{Capability, Request as Authorization, Target},
    contributions::Staged,
    remote::{Endpoint, Error, Handler, key},
    terminal_ui::{
        Context, Descriptor, Placement, Text,
        app::{self, App, Cx, Submission},
        view::{Reply, View},
    },
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;
use uuid::Uuid;

fn invalid(error: impl ToString) -> Error {
    Error::Invalid(error.to_string())
}
fn failed(error: PlanError) -> Error {
    ControlError::Domain(error).into_remote()
}
fn title() -> Text {
    Text::localized("Plan", "计划", "計畫")
}

pub(super) fn publish(owner: Arc<Owner>, staged: &mut Staged) -> Result<(), String> {
    for (name, placement, status) in [
        ("terminal", Placement::Page, false),
        ("panel", Placement::Panel, false),
        ("status", Placement::Status, true),
    ] {
        let descriptor = Descriptor::new(title(), Context::Session)
            .placement(placement)
            .icon("▤", "P")
            .changes("terminal_changes");
        staged
            .insert(
                key(ID, name).map_err(super::message)?,
                app::endpoint(
                    Plans {
                        owner: owner.clone(),
                        status,
                    },
                    descriptor,
                )
                .map_err(super::message)?,
            )
            .map_err(super::message)?;
    }
    let revisions = owner.revisions.clone();
    staged
        .insert(
            key(ID, "terminal_changes").map_err(super::message)?,
            Endpoint::standalone(Handler::Stream(app::changes(move |_| {
                revisions.subscribe()
            }))),
        )
        .map_err(super::message)
}

struct Plans {
    owner: Arc<Owner>,
    status: bool,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Source {
    Proposal,
    Execution,
}
impl Source {
    fn current(snapshot: &Snapshot) -> Self {
        if snapshot.execution.is_some()
            && snapshot.proposal.as_ref().is_none_or(|proposal| {
                matches!(
                    proposal.status,
                    crate::plan::ProposalStatus::Approved | crate::plan::ProposalStatus::Abandoned
                )
            })
        {
            Self::Execution
        } else {
            Self::Proposal
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Route {
    Current {
        source: Source,
    },
    History {
        through: u64,
        before: u64,
    },
    Revision {
        revision: u64,
        source: Source,
    },
    Step {
        revision: u64,
        source: Source,
        id: String,
    },
    Details {
        revision: u64,
        source: Source,
    },
}
fn route(value: Value) -> Result<Option<Route>, Error> {
    if value.is_null() {
        Ok(None)
    } else {
        serde_json::from_value(value).map(Some).map_err(invalid)
    }
}

/// The immutable reviewed revision and a fresh decision nonce travel with the
/// view. Identities are resolved there, never from the latest proposal.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Stamp {
    revision: u64,
    operation: Uuid,
}
impl Stamp {
    fn new(snapshot: &Snapshot) -> Self {
        Self {
            revision: snapshot.revision,
            operation: Uuid::new_v4(),
        }
    }
    fn operation(&self, action: &str) -> String {
        format!("tui_{}_{}", self.operation.simple(), action)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Recovery {
    operation: String,
    route: Value,
}

impl App for Plans {
    fn read(&self, target: Value, cx: Cx) -> BoxFuture<'static, Result<View, Error>> {
        let (owner, status) = (self.owner.clone(), self.status);
        Box::pin(async move {
            cx.caller.views.session().await?;
            let repo = owner.repository(cx.session()?).map_err(failed)?;
            let current = repo.current().await.map_err(failed)?;
            let route = route(target)?;
            if status {
                if route.is_some() {
                    return Err(invalid("Plan status has no routes"));
                }
                return Ok(view::status(&current, &cx.words));
            }
            match route {
                Some(Route::History { through, before }) => {
                    if before > through || through > current.revision {
                        return Err(invalid("Plan history is outside committed revisions"));
                    }
                    let mut rows = vec![];
                    // Neighboring immutable snapshots identify what changed without
                    // retaining a page of complete artifacts.
                    if before > 0 {
                        let mut snapshot = repo.at(before).await.map_err(failed)?;
                        for revision in (before.saturating_sub(8) + 1..=before).rev() {
                            let previous = if revision > 1 {
                                repo.at(revision - 1).await.map_err(failed)?
                            } else {
                                Snapshot::default()
                            };
                            rows.push(view::history_row(&snapshot, &previous, &cx.words));
                            snapshot = previous;
                        }
                    }
                    Ok(view::history(&current, through, before, rows, &cx.words))
                }
                Some(Route::Details { revision, source }) => {
                    if revision == 0 || revision > current.revision {
                        return Err(invalid("Invalid Plan revision"));
                    }
                    let snapshot = repo.at(revision).await.map_err(failed)?;
                    view::details(&snapshot, source, &cx.words)
                }
                Some(Route::Step {
                    revision,
                    source,
                    id,
                }) => {
                    if revision == 0 || revision > current.revision {
                        return Err(invalid("Invalid Plan revision"));
                    }
                    let snapshot = repo.at(revision).await.map_err(failed)?;
                    view::step(&snapshot, source, &id, &cx.words)
                }
                Some(Route::Revision { revision, source }) => {
                    if revision == 0 || revision > current.revision {
                        return Err(invalid("Invalid Plan revision"));
                    }
                    let snapshot = repo.at(revision).await.map_err(failed)?;
                    Ok(view::page(
                        &snapshot,
                        source,
                        true,
                        &cx.words,
                        cx.session()?,
                    ))
                }
                other => {
                    let source = match other {
                        Some(Route::Current { source }) => source,
                        _ => Source::current(&current),
                    };
                    Ok(view::page(
                        &current,
                        source,
                        false,
                        &cx.words,
                        cx.session()?,
                    ))
                }
            }
        })
    }
    fn submit(&self, submission: Submission, cx: Cx) -> BoxFuture<'static, Result<Reply, Error>> {
        let (owner, status) = (self.owner.clone(), self.status);
        Box::pin(async move {
            if status
                || !matches!(
                    route(submission.route.clone())?,
                    None | Some(Route::Current { .. })
                )
                || !submission.fields.is_empty()
            {
                return Err(invalid("This Plan view is read-only"));
            }
            let stamp: Stamp = serde_json::from_str(&submission.revision).map_err(invalid)?;
            let session = cx.session()?;
            cx.caller.views.session().await?;
            let reviewed = owner
                .repository(session)
                .map_err(failed)?
                .at(stamp.revision)
                .await
                .map_err(failed)?;
            let source = match route(submission.route.clone())? {
                Some(Route::Current { source }) => source,
                _ => Source::current(&reviewed),
            };
            if !view::offered(&reviewed, source, &submission.action) {
                return Err(invalid("Action unavailable for the reviewed Plan"));
            }
            let needs_grant = matches!(
                submission.action.as_str(),
                "approve" | "resume" | "reconcile"
            );
            if needs_grant && submission.grant.is_none() {
                let current = owner
                    .repository(session)
                    .map_err(failed)?
                    .current()
                    .await
                    .map_err(failed)?;
                if current.revision != stamp.revision {
                    return Ok(Reply::Conflict);
                }
                return Ok(Reply::Consent {
                    request: Authorization {
                        operation_id: stamp.operation,
                        title: cx.t(
                            "Allow this Plan to run in this Session",
                            "允许此计划在本会话中执行",
                            "允許此計畫在本對話中執行",
                        ),
                        target: Target::Session {
                            session_id: session.into(),
                        },
                        capabilities: [Capability::Executions].into(),
                    },
                });
            }
            let proposal = || {
                reviewed
                    .proposal
                    .as_ref()
                    .map(|p| (p.id.clone(), p.revision))
                    .ok_or_else(|| invalid("No reviewed proposal"))
            };
            let execution = || {
                reviewed
                    .execution
                    .as_ref()
                    .map(|e| e.id.clone())
                    .ok_or_else(|| invalid("No reviewed execution"))
            };
            let grant = || {
                submission
                    .grant
                    .ok_or_else(|| invalid("Plan execution requires consent"))
            };
            let command = match submission.action.as_str() {
                "approve" => {
                    let (proposal_id, proposal_revision) = proposal()?;
                    Command::Approve {
                        proposal_id,
                        proposal_revision,
                        grant: grant()?,
                        behavior: super::EXECUTION.to_owned().try_into().map_err(invalid)?,
                    }
                }
                "revise" => Command::Revise {
                    proposal_id: proposal()?.0,
                },
                "abandon" => Command::Abandon {
                    proposal_id: proposal()?.0,
                },
                "resume" => Command::Resume {
                    execution_id: execution()?,
                    grant: grant()?,
                },
                "reconcile" => Command::Reconcile {
                    execution_id: execution()?,
                    grant: grant()?,
                },
                "cancel" => Command::Cancel {
                    execution_id: execution()?,
                    reason: "Cancelled by the user".into(),
                    grant: submission.grant,
                },
                _ => return Err(invalid("Unknown Plan action")),
            };
            let request = Request {
                operation_id: stamp.operation(&submission.action),
                expected_revision: stamp.revision,
                command,
            };
            match remote::control(&owner, &cx.caller, session, &request).await {
                Ok(_) => Ok(Reply::Applied {
                    route: view::destination(&submission.action),
                }),
                Err(ControlError::Domain(PlanError::Conflict)) => Ok(Reply::Conflict),
                Err(error) => Err(error.into_remote()),
            }
        })
    }
    fn recover(&self, target: Value, cx: Cx) -> BoxFuture<'static, Result<Reply, Error>> {
        let owner = self.owner.clone();
        Box::pin(async move {
            let recovery: Recovery = serde_json::from_value(target).map_err(invalid)?;
            if !matches!(
                route(recovery.route.clone())?,
                None | Some(Route::Current { .. })
            ) {
                return Err(invalid("Invalid Plan recovery destination"));
            }
            cx.caller.views.session().await?;
            let recorded = owner
                .repository(cx.session()?)
                .map_err(failed)?
                .outcome(&recovery.operation)
                .await
                .map_err(failed)?;
            Ok(if recorded.is_some() {
                Reply::Applied {
                    route: recovery.route,
                }
            } else {
                Reply::Unrecorded
            })
        })
    }
}
