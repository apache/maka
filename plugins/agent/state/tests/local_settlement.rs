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

mod support;

use maka_agent_facts::{
    artifact::ToolReturn,
    cells::{CellEvent, CellId, CellOwner, CellVmBinding},
    durable::*,
    tool_call::ToolSettlement,
    tool_output::{DurableToolProjection, ReturnedToolResult, ToolOutput},
    tools::ToolSemantics,
};
use maka_agent_state::{Change, ContentBlob, Store};
use maka_event_log::{
    StoreError,
    root_store::{DataWriter, RootStore, SessionWorkLease, WorkEffects},
    writeback::{Notification, Prepared, Statement},
};
use maka_plugin_core::{
    scope::Scope,
    storage::{Data, Mutation, Namespace},
};
use rusqlite::Connection;
use serde_json::json;
use std::{
    future::{Future, poll_fn},
    sync::mpsc,
    task::Poll,
};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

fn namespace() -> Namespace {
    Namespace::new("local-settlement-test", Scope::Profile).unwrap()
}

fn mutation(key: &str, expected_revision: Option<u64>, value: u64) -> Mutation {
    Mutation {
        key: key.into(),
        expected_revision,
        data: Data::Present(json!(value)),
    }
}

async fn accepted_writer(root: &RootStore) -> (SessionWorkLease, WorkEffects, DataWriter) {
    let session = root.session("session").await.unwrap();
    let (work, effects) = session
        .work_scope(None)
        .await
        .unwrap()
        .accept(CancellationToken::new());
    let selected = work.store();
    let custody = selected.work_custody().unwrap();
    let writer = root
        .data_writer_for_work(custody.as_ref(), "session")
        .unwrap();
    (work, effects, writer)
}

fn returned() -> ContentBlob {
    ContentBlob::json(&ToolReturn {
        schema_version: SCHEMA_VERSION,
        artifacts: vec![],
        body: ReturnedToolResult {
            output: ToolOutput::Text("original local result".into()),
            projection: DurableToolProjection::Text {
                text: "original local result".into(),
            },
            is_error: false,
            loaded_tools: Default::default(),
        },
    })
    .unwrap()
}

async fn local_result(
    store: &Store,
    child: bool,
    semantics: ToolSemantics,
) -> (RunId, Change, ContentBlob) {
    let (run, tool) = support::admitted_tool(store).await;
    let result = returned();
    let fact = if child {
        let view = store.frontier(run).await.unwrap();
        let link = AgentStepLink {
            run,
            step: view.attempts[&tool.attempt].step,
            attempt: tool.attempt,
        };
        let cell = CellId::for_agent(link, &tool.call);
        let operation = Uuid::new_v4();
        let source = ContentBlob::json(&"local child program").unwrap();
        let descriptor =
            ContentBlob::json(&json!({"runtime":"local-test","generation":1})).unwrap();
        let input = ContentBlob::json(&json!({"local":true})).unwrap();
        let claim = store.claim(run).await.unwrap();
        store
            .append(
                &claim,
                (&view).into(),
                vec![
                    Change {
                        id: cell.started_fact_id(),
                        at: UnixMillis(3),
                        fact: Fact::Cell {
                            event: CellEvent::Started {
                                cell,
                                owner: CellOwner::Agent {
                                    link,
                                    call: tool.call,
                                },
                                source: source.reference().clone(),
                            },
                        },
                    },
                    Change::new(
                        Fact::Cell {
                            event: CellEvent::VmBound {
                                cell,
                                binding: CellVmBinding {
                                    runtime: "local-test".into(),
                                    version: 1,
                                    descriptor: descriptor.reference().clone(),
                                },
                            },
                        },
                        UnixMillis(3),
                    ),
                    Change::new(
                        Fact::Cell {
                            event: CellEvent::ChildPrepared {
                                semantics,
                                cell,
                                operation,
                                name: "local".into(),
                                input: input.reference().clone(),
                                resources: vec![],
                            },
                        },
                        UnixMillis(3),
                    ),
                    Change::new(
                        Fact::Cell {
                            event: CellEvent::ChildAdmitted { cell, operation },
                        },
                        UnixMillis(3),
                    ),
                ],
                vec![source, descriptor, input],
            )
            .await
            .unwrap();
        Fact::Cell {
            event: CellEvent::LocalChildReturned {
                cell,
                operation,
                result: result.reference().clone(),
                is_error: false,
                settlement: ToolSettlement::Returned,
            },
        }
    } else {
        Fact::LocalToolReturned {
            tool,
            result: result.reference().clone(),
            is_error: false,
            settlement: ToolSettlement::Returned,
        }
    };
    (run, Change::new(fact, UnixMillis(4)), result)
}

#[tokio::test]
async fn assessed_stop_reobserves_running_cell_but_respects_typed_recovery_blocker() {
    let directory = tempfile::tempdir().unwrap();
    let root = support::open(directory.path(), false).await;
    support::create(&root, "session").await;
    let store = support::state(&root);
    let (run, pending_return, _) = local_result(&store, true, ToolSemantics::Parallel).await;
    let Fact::Cell {
        event: CellEvent::LocalChildReturned { cell, .. },
    } = pending_return.fact
    else {
        unreachable!();
    };
    support::append(
        &store,
        run,
        vec![Fact::StopRequested {
            diagnostic: "user stop".into(),
        }],
        vec![],
    )
    .await;
    let request = store.frontier(run).await.unwrap().stop_request.unwrap();
    support::append(&store, run, vec![Fact::StopAssessed { request }], vec![]).await;
    let view = store.frontier(run).await.unwrap();
    assert_eq!(view.stop_assessed, Some(request));
    assert!(matches!(
        view.cells[&cell].status,
        maka_agent_facts::cells::CellStatus::Running
    ));
    assert_eq!(
        store
            .ready_runs(support::owner(), UnixMillis(10), None, 32)
            .await
            .unwrap()
            .into_iter()
            .map(|ready| ready.run)
            .collect::<Vec<_>>(),
        vec![run],
    );
    support::append(
        &store,
        run,
        vec![Fact::Blocked {
            blocker: BlockerId::new(),
            reason: BlockerKind::CodeCellRecoveryUnavailable {
                cell: cell.to_string(),
            },
        }],
        vec![],
    )
    .await;
    assert!(
        store
            .ready_runs(support::owner(), UnixMillis(10), None, 32)
            .await
            .unwrap()
            .is_empty()
    );
    root.close().await.unwrap();
}

#[tokio::test]
async fn same_local_fact_replay_does_not_repeat_business() {
    let directory = tempfile::tempdir().unwrap();
    let root = support::open(directory.path(), false).await;
    support::create(&root, "session").await;
    let store = support::state(&root);
    let (work, effects, writer) = accepted_writer(&root).await;
    let (run, original, result) = local_result(&store, false, ToolSemantics::Parallel).await;
    let claim = store.claim(run).await.unwrap();
    let view = store.frontier(run).await.unwrap();
    let Fact::LocalToolReturned { tool, .. } = &original.fact else {
        unreachable!()
    };
    let own = BlockerId::new();
    let unrelated = BlockerId::new();
    store
        .append(
            &claim,
            (&view).into(),
            vec![
                Change::new(
                    Fact::Blocked {
                        blocker: own,
                        reason: BlockerKind::OriginalAdmissionUnknown { tool: tool.clone() },
                    },
                    UnixMillis(5),
                ),
                Change::new(
                    Fact::Blocked {
                        blocker: unrelated,
                        reason: BlockerKind::CurrentAuthorityUnavailable {
                            stage: AuthorityStage::ToolBindings,
                            diagnostic: "current binding unavailable".into(),
                        },
                    },
                    UnixMillis(5),
                ),
            ],
            vec![],
        )
        .await
        .unwrap();
    let ns = namespace();
    let business = root
        .prepare_plugin_data_statement(&ns, vec![mutation("once", None, 1)], &writer)
        .unwrap();
    let blocked = store.frontier(run).await.unwrap();
    let rejected = store
        .append_local_with(
            &claim,
            (&blocked).into(),
            original.clone(),
            vec![result.clone()],
            vec![],
            business.clone(),
            &writer,
        )
        .await;
    assert!(
        matches!(rejected, Err(StoreError::StatementRejected { diagnostic, .. }) if diagnostic == Store::LOCAL_ADMISSION_FENCED)
    );
    let after = store.frontier(run).await.unwrap();
    assert_eq!(after.revision, blocked.revision);
    assert_eq!(after.tools, blocked.tools);
    assert_eq!(after.blockers, blocked.blockers);
    assert!(store.fact(run, original.id).await.unwrap().is_none());
    assert!(root.plugin_data(&ns, "once").await.unwrap().is_none());
    let evidence = ContentBlob::json(&json!({"currentBinding":"restored"})).unwrap();
    store
        .append(
            &claim,
            (&after).into(),
            vec![Change::new(
                Fact::BlockerResolved {
                    blocker: unrelated,
                    evidence: evidence.reference().clone(),
                },
                UnixMillis(6),
            )],
            vec![evidence],
        )
        .await
        .unwrap();
    let view = store.frontier(run).await.unwrap();
    assert!(view.blockers[&own].resolved_by.is_none());
    let head = (&view).into();
    let first = store
        .append_local_with(
            &claim,
            head,
            original.clone(),
            vec![result.clone()],
            Vec::new(),
            business.clone(),
            &writer,
        )
        .await
        .unwrap();
    let replay = store
        .append_local_with(
            &claim,
            head,
            original.clone(),
            vec![result],
            Vec::new(),
            business.clone(),
            &writer,
        )
        .await
        .unwrap();
    assert_eq!(replay.head, first.head);
    assert_eq!(replay.facts[0].id, original.id);
    assert_eq!(
        store.frontier(run).await.unwrap().blockers[&own].resolved_by,
        Some(original.id)
    );
    let record = root.plugin_data(&ns, "once").await.unwrap().unwrap();
    assert_eq!(record.revision, 1);
    assert_eq!(record.data, Data::Present(json!(1)));
    assert_eq!(
        store.frontier(run).await.unwrap().revision,
        first.head.revision
    );
    let (stopped_run, stopped_original, stopped_result) =
        local_result(&store, false, ToolSemantics::Parallel).await;
    let stopped_claim = store.claim(stopped_run).await.unwrap();
    let before = store.frontier(stopped_run).await.unwrap();
    store
        .append(
            &stopped_claim,
            (&before).into(),
            vec![Change::new(
                Fact::StopRequested {
                    diagnostic: "stop before local settlement".into(),
                },
                UnixMillis(5),
            )],
            vec![],
        )
        .await
        .unwrap();
    let stopped = store.frontier(stopped_run).await.unwrap();
    let stopped_business = root
        .prepare_plugin_data_statement(&ns, vec![mutation("stopped", None, 1)], &writer)
        .unwrap();
    let rejected = store
        .append_local_with(
            &stopped_claim,
            (&stopped).into(),
            stopped_original.clone(),
            vec![stopped_result],
            vec![],
            stopped_business,
            &writer,
        )
        .await;
    assert!(
        matches!(rejected, Err(StoreError::StatementRejected { diagnostic, .. }) if diagnostic == Store::LOCAL_ADMISSION_FENCED)
    );
    assert_eq!(
        store.frontier(stopped_run).await.unwrap().revision,
        stopped.revision
    );
    assert!(
        store
            .fact(stopped_run, stopped_original.id)
            .await
            .unwrap()
            .is_none()
    );
    assert!(root.plugin_data(&ns, "stopped").await.unwrap().is_none());
    let (finish_run, finish_original, finish_result) =
        local_result(&store, true, ToolSemantics::FinishTurn).await;
    let finish_claim = store.claim(finish_run).await.unwrap();
    let before = store.frontier(finish_run).await.unwrap();
    let (cell, operation) = match &finish_original.fact {
        Fact::Cell {
            event: CellEvent::LocalChildReturned {
                cell, operation, ..
            },
        } => (*cell, *operation),
        _ => unreachable!(),
    };
    let input = before.cells[&cell].children[&operation].input.clone();
    let sibling = Uuid::new_v4();
    store
        .append(
            &finish_claim,
            (&before).into(),
            vec![
                Change::new(
                    Fact::Cell {
                        event: CellEvent::ChildPrepared {
                            cell,
                            operation: sibling,
                            name: "local".into(),
                            semantics: ToolSemantics::Parallel,
                            input: input.clone(),
                            resources: vec![],
                        },
                    },
                    UnixMillis(5),
                ),
                Change::new(
                    Fact::Cell {
                        event: CellEvent::ChildAdmitted {
                            cell,
                            operation: sibling,
                        },
                    },
                    UnixMillis(5),
                ),
            ],
            vec![],
        )
        .await
        .unwrap();
    let before = store.frontier(finish_run).await.unwrap();
    assert!(!before.finish_requested());
    let finish_head = (&before).into();
    let finish_business = root
        .prepare_plugin_data_statement(&ns, vec![mutation("finish", None, 1)], &writer)
        .unwrap();
    let finish_commit = store
        .append_local_with(
            &finish_claim,
            finish_head,
            finish_original.clone(),
            vec![finish_result.clone()],
            vec![],
            finish_business.clone(),
            &writer,
        )
        .await
        .unwrap();
    let finished = store.frontier(finish_run).await.unwrap();
    assert!(finished.finish_requested());
    assert!(
        store
            .fact(finish_run, finish_original.id)
            .await
            .unwrap()
            .is_some()
    );
    let replay = store
        .append_local_with(
            &finish_claim,
            finish_head,
            finish_original,
            vec![finish_result.clone()],
            vec![],
            finish_business.clone(),
            &writer,
        )
        .await
        .unwrap();
    assert_eq!(replay.head, finish_commit.head);
    let record = root.plugin_data(&ns, "finish").await.unwrap().unwrap();
    assert_eq!(record.revision, 1);
    assert_eq!(record.data, Data::Present(json!(1)));
    let fresh = Uuid::new_v4();
    let fresh_prepared = Change::new(
        Fact::Cell {
            event: CellEvent::ChildPrepared {
                cell,
                operation: fresh,
                name: "local".into(),
                semantics: ToolSemantics::Parallel,
                input,
                resources: vec![],
            },
        },
        UnixMillis(6),
    );
    let fresh_id = fresh_prepared.id;
    let rejected = store
        .append(
            &finish_claim,
            (&finished).into(),
            vec![
                fresh_prepared,
                Change::new(
                    Fact::Cell {
                        event: CellEvent::ChildAdmitted {
                            cell,
                            operation: fresh,
                        },
                    },
                    UnixMillis(6),
                ),
            ],
            vec![],
        )
        .await;
    assert!(
        matches!(rejected, Err(StoreError::InvalidTransition(reason)) if reason == "successful finish tool fenced fresh Run admission")
    );
    assert!(store.fact(finish_run, fresh_id).await.unwrap().is_none());
    let sibling_return = Change::new(
        Fact::Cell {
            event: CellEvent::LocalChildReturned {
                cell,
                operation: sibling,
                result: finish_result.reference().clone(),
                is_error: false,
                settlement: ToolSettlement::Returned,
            },
        },
        UnixMillis(6),
    );
    let sibling_id = sibling_return.id;
    let sibling_business = root
        .prepare_plugin_data_statement(&ns, vec![mutation("after_finish", None, 1)], &writer)
        .unwrap();
    let rejected = store
        .append_local_with(
            &finish_claim,
            (&finished).into(),
            sibling_return,
            vec![finish_result],
            vec![],
            sibling_business,
            &writer,
        )
        .await;
    assert!(
        matches!(rejected, Err(StoreError::StatementRejected { diagnostic, cause, .. })
        if diagnostic == Store::LOCAL_ADMISSION_FENCED
            && matches!(cause.as_ref(), StoreError::InvalidTransition(reason) if reason == "successful finish tool fenced fresh Run admission"))
    );
    let after = store.frontier(finish_run).await.unwrap();
    assert!(after.finish_requested());
    assert_eq!(after.revision, finished.revision);
    assert_eq!(after.cells, finished.cells);
    assert!(store.fact(finish_run, sibling_id).await.unwrap().is_none());
    assert!(
        root.plugin_data(&ns, "after_finish")
            .await
            .unwrap()
            .is_none()
    );
    drop(finish_business);
    drop(business);
    effects.settle().await.unwrap();
    work.finish();
    drop(writer);
    root.close().await.unwrap();
}

#[tokio::test]
async fn artifact_copy_and_local_return_share_refusal_commit_and_original_replay() {
    use maka_agent_facts::{
        artifact::{
            Artifact, ArtifactKind, ArtifactSource, PublishedArtifact, content_digest,
            upload_artifact_id,
        },
        tool_output::ToolSuccess,
    };
    use maka_agent_state::artifacts::{ArtifactScope, CopyArtifact, SessionScope, Upload};
    use std::time::{Duration, UNIX_EPOCH};

    let directory = tempfile::tempdir().unwrap();
    let root = support::open(directory.path(), false).await;
    support::create(&root, "session").await;
    support::create(&root, "source-session").await;
    let store = support::state(&root);
    let artifacts = store.artifacts();
    let source_scope = SessionScope {
        owner: support::owner(),
        session: "source-session".into(),
    };
    let destination = SessionScope {
        owner: support::owner(),
        session: "session".into(),
    };
    let bytes = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x01\0\0\0\x01\x08\x04\0\0\0\xb5\x1c\x0c\x02\0\0\0\x0bIDAT\x78\xda\x63\xfc\xff\x1f\0\x03\x03\x02\0\xef\x9a\x2d\x77\0\0\0\0IEND\xaeB\x60\x82".to_vec();
    let published = artifacts
        .upload(Upload::new(
            source_scope.clone(),
            "upload-source".into(),
            "source-image".into(),
            Artifact {
                id: upload_artifact_id("source-session", "source-image"),
                session_id: "source-session".into(),
                turn_id: "source-turn".into(),
                created_at: 1,
                name: "source.png".into(),
                kind: ArtifactKind::Image,
                size_bytes: bytes.len() as u64,
                mime_type: Some("image/png".into()),
                source: ArtifactSource::UserUpload,
                summary: Some(content_digest(&bytes)),
            },
            bytes.clone(),
        ))
        .await
        .unwrap();
    let source = artifacts
        .copy_source(source_scope.clone(), published.artifact.id.clone())
        .await
        .unwrap()
        .unwrap();
    let copy = CopyArtifact::new(source.clone(), destination.clone(), "local-copy".into(), 4);
    let copy_id = copy.artifact().id.clone();
    let (work, effects, writer) = accepted_writer(&root).await;
    let (run, tool) = support::admitted_tool(&store).await;
    let claim = store.claim(run).await.unwrap();
    let view = store.frontier(run).await.unwrap();
    let head: maka_agent_state::Head = (&view).into();
    // Recall's media result is a Run projection, separate from the session copy.
    let normalized = ToolSuccess::image(bytes.clone(), "image/png".into(), None)
        .unwrap()
        .into_durable(
            &format!("{run}:{}:{}", tool.attempt, tool.call),
            UNIX_EPOCH + Duration::from_millis(4),
            &ExecutionIdentity {
                session_id: view.spec.session_id.clone(),
                turn_id: view.spec.turn_id.clone(),
                run_id: run,
            },
        )
        .unwrap();
    assert_eq!(normalized.artifacts.len(), 1);
    let evidence = normalized.artifacts[0].evidence();
    let projection = PublishedArtifact {
        artifact: normalized.artifacts[0].artifact().clone(),
        payload: ContentRef {
            digest: evidence.digest,
            bytes: evidence.bytes,
        },
    };
    let result = ContentBlob::json(&ToolReturn {
        schema_version: SCHEMA_VERSION,
        artifacts: vec![projection.clone()],
        body: ReturnedToolResult {
            output: normalized.output,
            projection: normalized.projection,
            is_error: normalized.is_error,
            loaded_tools: normalized.loaded_tools,
        },
    })
    .unwrap();
    let original = Change::new(
        Fact::LocalToolReturned {
            tool,
            result: result.reference().clone(),
            is_error: false,
            settlement: ToolSettlement::Returned,
        },
        UnixMillis(4),
    );
    let first = store
        .append_local_copy(
            &claim,
            head,
            original.clone(),
            vec![result.clone()],
            normalized.artifacts.clone(),
            copy.clone(),
            &writer,
        )
        .await
        .unwrap();
    assert_eq!(first.head.revision, head.revision + 1);
    assert_eq!(first.facts.len(), 1);
    assert_eq!(first.facts[0].id, original.id);
    assert_eq!(first.facts[0].fact, original.fact);
    let copied = artifacts
        .chunk(destination.clone(), copy_id.clone(), 0, 1024)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(&copied.record.artifact, copy.artifact());
    assert_eq!(copied.record.payload, published.payload);
    assert_eq!(copied.record.payload.digest, content_digest(&bytes));
    assert_eq!(copied.total_bytes, bytes.len() as u64);
    assert_eq!(copied.bytes, bytes);
    let run_scope = ArtifactScope {
        owner: support::owner(),
        session: "session".into(),
        run,
        through: first.head.revision,
    };
    assert_eq!(
        artifacts
            .get(run_scope, projection.artifact.id.clone())
            .await
            .unwrap(),
        Some(projection)
    );
    let replay = store
        .append_local_copy(
            &claim,
            head,
            original.clone(),
            vec![result.clone()],
            normalized.artifacts.clone(),
            copy,
            &writer,
        )
        .await
        .unwrap();
    assert_eq!(replay.head, first.head);
    assert_eq!(replay.facts[0].id, original.id);
    assert_eq!(
        artifacts.get(destination.clone(), copy_id).await.unwrap(),
        Some(copied.record)
    );
    let observed = store
        .publication(run, vec![original.id], Some(&claim))
        .await
        .unwrap();
    assert_eq!(observed.head, first.head);
    assert_eq!(observed.facts.len(), 1);
    assert_eq!(observed.facts[0].fact, original.fact);

    // Occupy the exact target through the real copy API, using another source.
    let other_bytes = b"different original attachment".to_vec();
    let other = artifacts
        .upload(Upload::new(
            source_scope.clone(),
            "upload-other".into(),
            "other-source".into(),
            Artifact {
                id: upload_artifact_id("source-session", "other-source"),
                session_id: "source-session".into(),
                turn_id: "source-turn".into(),
                created_at: 1,
                name: "other.bin".into(),
                kind: ArtifactKind::File,
                size_bytes: other_bytes.len() as u64,
                mime_type: Some("application/octet-stream".into()),
                source: ArtifactSource::UserUpload,
                summary: Some(content_digest(&other_bytes)),
            },
            other_bytes.clone(),
        ))
        .await
        .unwrap();
    let other_source = artifacts
        .copy_source(source_scope, other.artifact.id)
        .await
        .unwrap()
        .unwrap();
    let occupied = artifacts
        .copy(CopyArtifact::new(
            other_source,
            destination.clone(),
            "conflicted-copy".into(),
            5,
        ))
        .await
        .unwrap();
    let conflicting = CopyArtifact::new(source, destination.clone(), "conflicted-copy".into(), 5);
    assert_eq!(conflicting.artifact().id, occupied.artifact.id);
    let (run, tool) = support::admitted_tool(&store).await;
    let claim = store.claim(run).await.unwrap();
    let view = store.frontier(run).await.unwrap();
    let head: maka_agent_state::Head = (&view).into();
    let normalized = ToolSuccess::image(bytes, "image/png".into(), None)
        .unwrap()
        .into_durable(
            &format!("{run}:{}:{}", tool.attempt, tool.call),
            UNIX_EPOCH + Duration::from_millis(5),
            &ExecutionIdentity {
                session_id: view.spec.session_id.clone(),
                turn_id: view.spec.turn_id.clone(),
                run_id: run,
            },
        )
        .unwrap();
    assert_eq!(normalized.artifacts.len(), 1);
    let evidence = normalized.artifacts[0].evidence();
    let projection = PublishedArtifact {
        artifact: normalized.artifacts[0].artifact().clone(),
        payload: ContentRef {
            digest: evidence.digest,
            bytes: evidence.bytes,
        },
    };
    let result = ContentBlob::json(&ToolReturn {
        schema_version: SCHEMA_VERSION,
        artifacts: vec![projection.clone()],
        body: ReturnedToolResult {
            output: normalized.output,
            projection: normalized.projection,
            is_error: normalized.is_error,
            loaded_tools: normalized.loaded_tools,
        },
    })
    .unwrap();
    let original = Change::new(
        Fact::LocalToolReturned {
            tool,
            result: result.reference().clone(),
            is_error: false,
            settlement: ToolSettlement::Returned,
        },
        UnixMillis(5),
    );
    // Correct Head and a valid result pass Append; the following copy statement
    // conflicts with the occupied registration, rolling back T2 and projection.
    let error = store
        .append_local_copy(
            &claim,
            head,
            original.clone(),
            vec![result],
            normalized.artifacts,
            conflicting,
            &writer,
        )
        .await
        .unwrap_err();
    match error {
        StoreError::StatementRejected { diagnostic, cause } => {
            assert_eq!(diagnostic, maka_agent_state::artifacts::COPY_REJECTED);
            assert!(
                matches!(cause.as_ref(), StoreError::EventConflict),
                "{cause:?}"
            );
        }
        other => panic!("expected the real copy registration conflict, got {other:?}"),
    }
    assert_eq!(store.frontier(run).await.unwrap().revision, head.revision);
    assert!(
        store
            .publication(run, vec![original.id], Some(&claim))
            .await
            .unwrap()
            .facts
            .is_empty()
    );
    assert!(
        artifacts
            .get(destination.clone(), projection.artifact.id)
            .await
            .unwrap()
            .is_none()
    );
    let unchanged = artifacts
        .chunk(destination, occupied.artifact.id.clone(), 0, 1024)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(unchanged.record, occupied);
    assert_eq!(unchanged.record.payload, other.payload);
    assert_eq!(
        unchanged.record.payload.digest,
        content_digest(&other_bytes)
    );
    assert_eq!(unchanged.bytes, other_bytes);
    effects.settle().await.unwrap();
    work.finish();
    drop(writer);
    root.close().await.unwrap();
}

#[tokio::test]
async fn new_fact_cannot_repeat_tool_or_cell_business_or_upgrade_unknown_atomically() {
    let directory = tempfile::tempdir().unwrap();
    let root = support::open(directory.path(), false).await;
    support::create(&root, "session").await;
    let store = support::state(&root);
    let (work, effects, writer) = accepted_writer(&root).await;
    let ns = namespace();
    for (key, child, unknown) in [
        ("tool", false, false),
        ("cell", true, false),
        ("unknown-tool", false, true),
        ("unknown-cell", true, true),
    ] {
        let (run, original, result) = local_result(&store, child, ToolSemantics::Parallel).await;
        let claim = store.claim(run).await.unwrap();
        let view = store.frontier(run).await.unwrap();
        let business = root
            .prepare_plugin_data_statement(&ns, vec![mutation(key, None, 1)], &writer)
            .unwrap();
        if unknown {
            writer.write(business).await.unwrap();
            let mut observation = original.clone();
            match &mut observation.fact {
                Fact::LocalToolReturned { settlement, .. }
                | Fact::Cell {
                    event: CellEvent::LocalChildReturned { settlement, .. },
                } => *settlement = ToolSettlement::Unknown,
                _ => unreachable!(),
            }
            store
                .append(
                    &claim,
                    (&view).into(),
                    vec![observation],
                    vec![result.clone()],
                )
                .await
                .unwrap();
        } else {
            store
                .append_local_with(
                    &claim,
                    (&view).into(),
                    original.clone(),
                    vec![result.clone()],
                    Vec::new(),
                    business,
                    &writer,
                )
                .await
                .unwrap();
        }
        let before = store.frontier(run).await.unwrap();
        let second_business = root
            .prepare_plugin_data_statement(&ns, vec![mutation(key, Some(1), 2)], &writer)
            .unwrap();
        let duplicate = Change {
            id: FactId::new(),
            ..original
        };
        let rejected = store
            .append_local_with(
                &claim,
                (&before).into(),
                duplicate,
                vec![result],
                Vec::new(),
                second_business,
                &writer,
            )
            .await;
        assert!(matches!(rejected, Err(StoreError::EventConflict)));
        let after = store.frontier(run).await.unwrap();
        assert_eq!(after.revision, before.revision);
        assert_eq!(after.tools, before.tools);
        assert_eq!(after.cells, before.cells);
        let record = root.plugin_data(&ns, key).await.unwrap().unwrap();
        assert_eq!(record.revision, 1);
        assert_eq!(record.data, Data::Present(json!(1)));
    }
    effects.settle().await.unwrap();
    work.finish();
    drop(writer);
    root.close().await.unwrap();
}

struct PauseWriter {
    entered: oneshot::Sender<()>,
    release: mpsc::Receiver<()>,
}
impl Statement for PauseWriter {
    type Value = ();
    type Output = ();
    fn execute(self, _: &Connection) -> Result<Prepared<()>, StoreError> {
        self.entered.send(()).unwrap();
        self.release.recv().unwrap();
        Ok(Prepared {
            value: (),
            changed: false,
            notification: Notification::NONE,
        })
    }
    fn committed(_: ()) {}
    fn isolated_rejection(_: &StoreError) -> bool {
        false
    }
}

#[tokio::test]
async fn foreign_run_fact_id_is_an_isolated_conflict_not_a_batch_sql_failure() {
    let directory = tempfile::tempdir().unwrap();
    let root = support::open(directory.path(), false).await;
    support::create(&root, "session").await;
    let store = support::state(&root);
    let (work, effects, writer) = accepted_writer(&root).await;
    let ns = namespace();
    let (first_run, first, result) = local_result(&store, false, ToolSemantics::Parallel).await;
    let first_claim = store.claim(first_run).await.unwrap();
    let first_view = store.frontier(first_run).await.unwrap();
    let business = root
        .prepare_plugin_data_statement(&ns, vec![mutation("original", None, 1)], &writer)
        .unwrap();
    store
        .append_local_with(
            &first_claim,
            (&first_view).into(),
            first.clone(),
            vec![result],
            Vec::new(),
            business,
            &writer,
        )
        .await
        .unwrap();
    let (second_run, mut conflicting, second_result) =
        local_result(&store, false, ToolSemantics::Parallel).await;
    assert_ne!(second_run, first_run);
    conflicting.id = first.id;
    let second_claim = store.claim(second_run).await.unwrap();
    let second_view = store.frontier(second_run).await.unwrap();
    let forbidden = root
        .prepare_plugin_data_statement(&ns, vec![mutation("forbidden", None, 1)], &writer)
        .unwrap();
    let sibling = root
        .prepare_plugin_data_statement(&ns, vec![mutation("sibling", None, 1)], &writer)
        .unwrap();
    let (entered_tx, entered) = oneshot::channel();
    let (release, wait) = mpsc::channel();
    let paused_writer = writer.clone();
    let pause = tokio::spawn(async move {
        paused_writer
            .write(PauseWriter {
                entered: entered_tx,
                release: wait,
            })
            .await
    });
    entered.await.unwrap();
    let mut collision = Box::pin(store.append_local_with(
        &second_claim,
        (&second_view).into(),
        conflicting,
        vec![second_result],
        Vec::new(),
        forbidden,
        &writer,
    ));
    let mut sibling = Box::pin(writer.write(sibling));
    // Both jobs enter the same original FIFO before its blocking lane is released.
    assert!(
        poll_fn(|cx| Poll::Ready(collision.as_mut().poll(cx)))
            .await
            .is_pending()
    );
    assert!(
        poll_fn(|cx| Poll::Ready(sibling.as_mut().poll(cx)))
            .await
            .is_pending()
    );
    release.send(()).unwrap();
    pause.await.unwrap().unwrap();
    assert!(matches!(collision.await, Err(StoreError::EventConflict)));
    let written = sibling.await.unwrap();
    assert_eq!(written[0].revision, 1);
    assert_eq!(
        store.frontier(second_run).await.unwrap().revision,
        second_view.revision
    );
    assert!(root.plugin_data(&ns, "forbidden").await.unwrap().is_none());
    assert_eq!(
        root.plugin_data(&ns, "sibling")
            .await
            .unwrap()
            .unwrap()
            .data,
        Data::Present(json!(1))
    );
    assert_eq!(
        root.plugin_data(&ns, "original")
            .await
            .unwrap()
            .unwrap()
            .revision,
        1
    );
    effects.settle().await.unwrap();
    work.finish();
    drop(writer);
    root.close().await.unwrap();
}

#[tokio::test]
async fn accepted_local_business_settles_during_root_drain_with_a_fresh_state_store() {
    let directory = tempfile::tempdir().unwrap();
    let root = support::open(directory.path(), false).await;
    support::create(&root, "session").await;
    let store = support::state(&root);
    let (work, effects, writer) = accepted_writer(&root).await;
    let (run, original, result) = local_result(&store, false, ToolSemantics::Parallel).await;
    let claim = store.claim(run).await.unwrap();
    let before = store.frontier(run).await.unwrap();
    let ns = namespace();
    let business = root
        .prepare_plugin_data_statement(&ns, vec![mutation("drain", None, 1)], &writer)
        .unwrap();
    let mut shutdown = Box::pin(root.shutdown());
    assert!(
        poll_fn(|cx| Poll::Ready(shutdown.as_mut().poll(cx)))
            .await
            .is_pending()
    );
    assert!(matches!(
        root.data_writer(),
        Err(StoreError::ConnectionClosed)
    ));
    assert!(matches!(
        store.frontier(run).await,
        Err(StoreError::ConnectionClosed)
    ));
    let committed = store
        .append_local_with(
            &claim,
            (&before).into(),
            original.clone(),
            vec![result],
            Vec::new(),
            business,
            &writer,
        )
        .await
        .unwrap();
    assert_eq!(committed.facts[0].id, original.id);
    assert_eq!(committed.head.revision, before.revision + 1);
    assert!(
        poll_fn(|cx| Poll::Ready(shutdown.as_mut().poll(cx)))
            .await
            .is_pending()
    );
    effects.settle().await.unwrap();
    work.finish();
    drop(writer);
    shutdown.await.unwrap();
    drop(root);
    let reopened = support::open(directory.path(), true).await;
    let record = reopened.plugin_data(&ns, "drain").await.unwrap().unwrap();
    assert_eq!(record.revision, 1);
    assert_eq!(record.data, Data::Present(json!(1)));
    assert_eq!(
        support::state(&reopened)
            .frontier(run)
            .await
            .unwrap()
            .revision,
        committed.head.revision
    );
    reopened.close().await.unwrap();
}
