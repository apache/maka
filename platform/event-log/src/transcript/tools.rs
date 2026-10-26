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

use super::evidence;
use crate::StoreError;
use maka_agent_facts::tool_call::ToolOrigin;
use maka_presentation::ProjectionError;
use rusqlite::{Connection as RawConnection, OptionalExtension, params};
use std::collections::BTreeSet;

const TOOL_KIND: &str =
    r#"SELECT operation_id, kind FROM runtime_events WHERE sequence = ? AND invocation_id = ?"#;
const TOOL_HEADER: &str = r#"SELECT sequence, json_extract(accounting_tool, '$.call.origin')
             FROM runtime_events
             WHERE invocation_id = ?1 AND operation_id = ?2 AND operation_id IS NOT NULL
               AND kind = ?3 AND sequence <= ?4 LIMIT 1"#;
const TOOL_MAIN: &str = r#"SELECT EXISTS(SELECT 1 FROM runtime_events request
             JOIN runtime_events opening ON opening.invocation_id = request.invocation_id
             AND opening.kind = 'invocation_opened'
             WHERE request.invocation_id = ?1 AND request.operation_id = ?2
             AND request.kind = 'model_requested'
             AND json_extract(opening.event_json, '$.fact.input.kind') IN ('message', 'continuation', 'handoff')
             AND json_extract(request.event_json, '$.fact.purpose') = 'main')"#;

/// Reconstruct one tool boundary, its actual dispatch ancestry and accepted
/// provider step. Exclude sibling outcomes and unrelated raw payloads.
pub(super) fn selection(
    db: &RawConnection,
    invocation: &str,
    through: i64,
) -> Result<evidence::Selection, StoreError> {
    let ancestry = ancestry(db, invocation, through)?;
    Ok(evidence::Selection::Step {
        invocation: invocation.to_owned(),
        step: ancestry.step,
        through,
        boundaries: serde_json::to_string(&ancestry.boundaries)?,
        completed: true,
    })
}

struct Ancestry {
    step: Option<String>,
    boundaries: BTreeSet<i64>,
    dispatch: i64,
}

fn ancestry(db: &RawConnection, invocation: &str, through: i64) -> Result<Ancestry, StoreError> {
    let (operation, kind): (String, String) = db
        .prepare_cached(TOOL_KIND)?
        .query_row(params![through, invocation], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })?;
    let mut ids = BTreeSet::from([through]);
    let mut current = operation;
    let mut before = through;
    let mut rejected = kind == "tool_rejected";
    let mut dispatch = None;
    let step = loop {
        let header: Option<(i64, String)> = db
            .prepare_cached(TOOL_HEADER)?
            .query_row(
                params![
                    invocation,
                    &current,
                    if rejected {
                        "tool_rejected"
                    } else {
                        "tool_dispatched"
                    },
                    before
                ],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let Some((sequence, origin)) = header else {
            return Err(
                ProjectionError::Invalid("tool presentation has no dispatch provenance").into(),
            );
        };
        dispatch.get_or_insert(sequence);
        ids.insert(sequence);
        match serde_json::from_str::<ToolOrigin>(&origin)? {
            ToolOrigin::Provider { step_id } => break Some(step_id),
            ToolOrigin::Standalone | ToolOrigin::HostSdk { parent: None, .. } => break None,
            ToolOrigin::CodeMode {
                parent_operation_id,
                ..
            }
            | ToolOrigin::CodeCell {
                parent_operation_id,
                ..
            } => {
                current = parent_operation_id;
                before = sequence - 1;
                rejected = false;
            }
            ToolOrigin::HostSdk {
                parent: Some(parent),
                ..
            } => {
                current = parent.operation_id().to_owned();
                before = sequence - 1;
                rejected = false;
            }
        }
    };
    if let Some(step) = &step {
        let main: bool = db
            .prepare_cached(TOOL_MAIN)?
            .query_row(params![invocation, step], |row| row.get(0))?;
        if !main {
            return Err(ProjectionError::Invalid("tool belongs to a non-main step").into());
        }
    }
    Ok(Ancestry {
        step,
        boundaries: ids,
        dispatch: dispatch.expect("tool ancestry contains original boundary"),
    })
}

pub(super) fn project(
    db: &RawConnection,
    stored: &maka_agent_facts::event::StoredEvent,
) -> Result<Vec<maka_presentation::Row>, StoreError> {
    let ancestry = ancestry(
        db,
        &stored.event.invocation.invocation_id,
        stored.sequence as i64,
    )?;
    let dispatch = matches!(
        stored.event.fact,
        maka_agent_facts::event::Fact::ToolSettled { .. }
    )
    .then(|| evidence::fact_on_handle(db, ancestry.dispatch))
    .transpose()?;
    let resolved = if matches!(
        stored.event.fact,
        maka_agent_facts::event::Fact::ToolSettled {
            outcome: maka_agent_facts::event::ToolOutcome::Succeeded { .. },
            ..
        }
    ) {
        Some(crate::tool_payloads::resolve_in_transaction(
            db,
            &stored.event,
        )?)
    } else {
        None
    };
    Ok(maka_presentation::project_tool_boundary(
        stored,
        dispatch.as_ref().map(|event| &event.event),
        resolved.as_ref(),
    )?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_agent_facts::{
        event::{Fact, Invocation, InvocationInput, LogScope, RuntimeEvent, ToolOutcome},
        model::{ModelEvent, ModelFinishReason, ModelPart, ModelStep, ModelToolCall},
        tool_call::{HostSdkParent, ToolCallIdentity},
    };
    use serde_json::json;
    use sqlx::{Connection, SqliteConnection};
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    #[test]
    fn typed_host_sdk_ancestry_projects_beyond_the_former_depth_limit() {
        let db = RawConnection::open_in_memory().unwrap();
        db.execute_batch(&crate::schema::fixture(|kind, _| kind != "trigger"))
            .unwrap();
        let invocation = Invocation {
            session_id: "session".into(),
            turn_id: "turn".into(),
            run_id: "run".into(),
            invocation_id: "invocation".into(),
        };
        // Forty dispatches exceed the former 33-boundary guard. Both typed
        // relationships must lead to the same original HostSdk root.
        for index in 0..40 {
            let parent = (index > 0).then(|| {
                let operation_id = format!("host-{}", index - 1);
                if index % 2 == 0 {
                    HostSdkParent::NestedEffect { operation_id }
                } else {
                    HostSdkParent::EvaluationObserver {
                        operation_id,
                        epoch: format!("epoch-{index}"),
                    }
                }
            });
            let event = RuntimeEvent::new(
                invocation.clone(),
                Fact::ToolDispatched {
                    operation_id: format!("host-{index}"),
                    call: ToolCallIdentity {
                        tool_call_id: format!("call-{index}"),
                        origin: ToolOrigin::HostSdk {
                            package_id: "package".into(),
                            entry_id: "entry".into(),
                            activation: "activation".into(),
                            parent,
                        },
                    },
                    name: "Read".into(),
                    input: json!({}),
                    presentation: None,
                    title: None,
                },
            );
            db.execute(
                "INSERT INTO event_log(sequence,event_id,invocation_id,kind,operation_id,event_json) VALUES(?,?,?,?,?,?)",
                params![index + 1, event.id, "invocation", event.fact.kind(), event.fact.operation_id(), serde_json::to_string(&event).unwrap()],
            ).unwrap();
        }
        let mut event = RuntimeEvent::new(
            invocation,
            Fact::ToolSettled {
                operation_id: "host-39".into(),
                outcome: ToolOutcome::Failed {
                    message: "original host failure".into(),
                },
            },
        );
        event.id = "settlement".into();
        let stored = maka_agent_facts::event::StoredEvent {
            sequence: 41,
            event,
        };
        db.execute(
            "INSERT INTO event_log(sequence,event_id,invocation_id,kind,operation_id,event_json) VALUES(?,?,?,?,?,?)",
            params![41, stored.event.id, "invocation", stored.event.fact.kind(), stored.event.fact.operation_id(), serde_json::to_string(&stored.event).unwrap()],
        ).unwrap();

        let result = ancestry(&db, "invocation", 41).unwrap();
        assert_eq!(result.step, None);
        assert_eq!(result.dispatch, 40);
        assert_eq!(result.boundaries, (1..=41).collect::<BTreeSet<_>>());
        let rows = project(&db, &stored).unwrap();
        assert_eq!(rows.len(), 1);
        let message = serde_json::to_value(&rows[0].message).unwrap();
        assert_eq!(message["id"], "settlement");
        assert_eq!(message["origin"], "host_sdk");
        assert_eq!(message["parentOperationId"], "host-38");
        assert_eq!(message["isError"], true);
        assert_eq!(
            message["content"],
            json!({"kind":"text","text":"original host failure"})
        );
    }

    async fn boundary_work(siblings: usize) -> usize {
        let mut connection = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        // Exercise the production lookup schema without admission/projection
        // triggers: the counter measures only reconstruction of admitted facts.
        sqlx::raw_sql(sqlx::AssertSqlSafe(crate::schema::fixture(|kind, _| {
            kind != "trigger"
        })))
        .execute(&mut connection)
        .await
        .unwrap();
        let invocation = Invocation {
            session_id: "session".into(),
            turn_id: "turn".into(),
            run_id: "run".into(),
            invocation_id: "invocation".into(),
        };
        let calls: Vec<_> = (0..siblings)
            .map(|index| ModelToolCall {
                id: format!("call-{index}"),
                name: "Read".into(),
                input: if index + 1 == siblings {
                    json!({"own":true})
                } else {
                    json!({"sibling":"x".repeat(64*1024)})
                }
                .into(),
                provider_options: None,
                provider_executed: false,
            })
            .collect();
        let mut facts = vec![
            Fact::InvocationOpened {
                configuration: None,
                input: InvocationInput::Message {
                    source_messages: Vec::new(),
                    content: "read".into(),
                    request_fingerprint: None,
                },
            },
            Fact::ModelRequested {
                context_breakdown: None,
                item_acceptance: false,
                purpose: maka_agent_facts::context::ModelPurpose::Main,
                context: None,
                checkpoint_event_id: None,
                step_id: "step".into(),
                model_id: "model".into(),
                source_scope: LogScope::Root,
                source_high_water: 0,
                source_digest: "".into(),
                effective_source_digest: None,
                input_digest: "".into(),
                route_identity: "".into(),
            },
        ];
        facts.extend(calls.iter().cloned().map(|call| Fact::ModelObserved {
            step_id: "step".into(),
            event: ModelEvent::ToolCall(call),
        }));
        facts.push(Fact::ModelCompleted {
            step_id: "step".into(),
            output: ModelStep {
                parts: calls
                    .iter()
                    .cloned()
                    .map(|call| ModelPart::ToolCall { call })
                    .collect(),
                finish_reason: ModelFinishReason::ToolCalls,
                usage: Default::default(),
                provider_options: None,
                response_id: None,
                model: None,
                timestamp: None,
            },
        });
        facts.extend(calls.iter().map(|call| Fact::ToolDispatched {
            presentation: None,
            title: None,
            operation_id: format!("step:{}", call.id),
            call: ToolCallIdentity::provider("step".into(), call.id.clone()),
            name: call.name.clone(),
            input: call.input.as_json().unwrap().clone(),
        }));
        let dispatch = facts.len() as i64;
        facts.push(Fact::ToolSettled {
            operation_id: format!("step:call-{}", siblings - 1),
            outcome: ToolOutcome::Failed {
                message: "original failure".into(),
            },
        });
        for (index, fact) in facts.into_iter().enumerate() {
            let event = RuntimeEvent::new(invocation.clone(), fact);
            sqlx::query("INSERT INTO event_log(sequence,event_id,invocation_id,kind,operation_id,event_json) VALUES(?,?,?,?,?,?)")
                .bind(index as i64+1).bind(&event.id).bind(&invocation.invocation_id)
                .bind(event.fact.kind()).bind(event.fact.operation_id())
                .bind(serde_json::to_string(&event).unwrap()).execute(&mut connection).await.unwrap();
        }
        let steps = Arc::new(AtomicUsize::new(0));
        let observed = steps.clone();
        connection
            .lock_handle()
            .await
            .unwrap()
            .set_progress_handler(1, move || {
                observed.fetch_add(1, Ordering::Relaxed);
                true
            });
        let rows = connection
            .run_on_worker(move |handle| {
                // SAFETY: the worker exclusively lends this handle; all statements
                // and the non-owning wrapper are dropped before the callback returns.
                let db = unsafe { RawConnection::from_handle(handle.as_ptr()) }?;
                let activity = super::super::emit::source_on_handle(&db, "session", dispatch)?;
                let result = super::super::emit::source_on_handle(&db, "session", dispatch + 1)?;
                Ok::<_, StoreError>((activity, result))
            })
            .await
            .unwrap()
            .unwrap();
        connection
            .lock_handle()
            .await
            .unwrap()
            .remove_progress_handler();
        assert_eq!(rows.0.len(), 1);
        assert_eq!(rows.1.len(), 1);
        let result = serde_json::to_value(&rows.1[0].message).unwrap();
        assert_eq!(
            result["content"],
            json!({"kind":"text","text":"original failure"})
        );
        assert_eq!(
            result["toolUseId"],
            maka_presentation::tool_message_id(
                "invocation",
                &format!("step:call-{}", siblings - 1)
            )
        );
        steps.load(Ordering::Relaxed)
    }

    #[tokio::test]
    async fn own_boundary_work_does_not_replay_accepted_siblings() {
        let small = boundary_work(16).await;
        let large = boundary_work(128).await;
        eprintln!("own tool boundary VM steps: N16={small}, N128={large}");
        assert!(
            small > 0 && large < small * 2,
            "eight times more 64KiB siblings must not cause a sibling sweep: {small} -> {large}"
        );
    }
}
