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

use futures_util::future::BoxFuture;
use maka_agent_facts::event::Invocation;
use maka_agent_ports::execution::Submit;
use maka_capabilities::storage::Mutation;
use maka_capabilities::storage::Namespace;
use maka_capabilities::storage::Page;
use maka_capabilities::storage::Record;
use maka_capabilities::storage::Scan;
use maka_capabilities::storage::Store;
use maka_capabilities::storage::StoreError;
use maka_event_log::EventLog;
use maka_graph::{
    GraphId, Mode, OperatorId, WorkId,
    control::{Intent, Wake},
    repository::Repository,
    schedule::{Source, Target, Update, Work},
    store::Store as _,
};
use maka_plugin_core::scope::Scope;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

struct Storage {
    log: Arc<EventLog>,
    namespace: Namespace,
    lose_reply: AtomicBool,
}
impl Store for Storage {
    fn scan(&self, query: Scan) -> BoxFuture<'_, Result<Page, StoreError>> {
        Box::pin(async move {
            self.log
                .plugin_data_scan(&self.namespace, query)
                .await
                .map_err(storage_error)
        })
    }
    fn read(&self, key: String) -> BoxFuture<'_, Result<Option<Record>, StoreError>> {
        Box::pin(async move {
            self.log
                .plugin_data(&self.namespace, &key)
                .await
                .map_err(storage_error)
        })
    }
    fn batch(&self, mutations: Vec<Mutation>) -> BoxFuture<'_, Result<Vec<Record>, StoreError>> {
        Box::pin(async move {
            let result = self
                .log
                .plugin_data_batch(&self.namespace, mutations)
                .await
                .map_err(storage_error)?;
            if self.lose_reply.swap(false, Ordering::SeqCst) {
                return Err(StoreError::OutcomeUnknown("lost committed reply".into()));
            }
            Ok(result)
        })
    }
}
fn storage_error(error: maka_event_log::StoreError) -> StoreError {
    match error {
        maka_event_log::StoreError::RevisionConflict { expected, actual } => {
            StoreError::Conflict { expected, actual }
        }
        error => StoreError::Unavailable(error.to_string()),
    }
}
fn update(graph_id: GraphId) -> Update {
    Update {
        graph_id,
        source: Source {
            invocation: Invocation {
                session_id: "root".into(),
                turn_id: "turn".into(),
                run_id: "run".into(),
                invocation_id: "invocation".into(),
            },
            operation_id: "decision".into(),
        },
        // Larger than one KV value. Work records and the schedule fence commit
        // in one batch; the repository must neither truncate nor publish a prefix.
        add_work: (0..33)
            .map(|_| Work {
                work_id: WorkId::new(),
                target: Target::Agent {
                    agent_id: "general".into(),
                },
                instruction: "source\n".repeat(7000),
                input_ids: vec![],
                selected_result_inputs: vec![],
                replaces: None,
            })
            .collect(),
        stop: vec![],
        finish: None,
    }
}

#[tokio::test]
async fn decisions_recover_after_lost_reply_and_fence_intents_across_epoch_replacement() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("state.sqlite");
    let log = Arc::new(EventLog::open(&path).await.unwrap());
    let storage = Arc::new(Storage {
        log: log.clone(),
        namespace: Namespace::new("example.coordinator", Scope::Profile).unwrap(),
        lose_reply: AtomicBool::new(false),
    });
    let repository = Repository::new(storage.clone(), "planner").unwrap();
    let epoch = repository.open("root", Mode::Graph, None, 1).await.unwrap();
    let update = update(epoch.graph_id.clone());
    storage.lose_reply.store(true, Ordering::SeqCst);
    assert!(matches!(
        repository.commit_update(update.clone(), 0, 2).await,
        Err(maka_graph::Error::Storage(StoreError::OutcomeUnknown(_)))
    ));
    let committed = repository
        .commit_update(update.clone(), 0, 999)
        .await
        .unwrap();
    assert_eq!(committed.committed_at, 2);
    assert_eq!(committed.revision, 1);
    assert_eq!(committed.update, update);
    let mut changed = update.clone();
    changed.add_work[0].instruction = "different work".into();
    assert!(matches!(
        repository.commit_update(changed, 1, 3).await,
        Err(maka_graph::Error::Conflict)
    ));
    assert_eq!(
        repository.updates(&epoch.graph_id, 0, 1).await.unwrap(),
        std::slice::from_ref(&committed)
    );

    let intent = Intent {
        graph_id: epoch.graph_id.clone(),
        work_id: update.add_work[0].work_id.clone(),
        operator_id: OperatorId::new(),
        schedule_revision: 1,
        request: Submit {
            operation_id: "work".into(),
            session_id: "child".into(),
            content: "frozen task".into(),
            orchestration_mode: None,
        },
    };
    repository.commit_intent(intent.clone()).await.unwrap();
    let wake = Wake {
        graph_id: epoch.graph_id.clone(),
        snapshot_key: "snapshot".into(),
        request: Submit {
            operation_id: "wake".into(),
            session_id: "root".into(),
            content: "first observation".into(),
            orchestration_mode: None,
        },
    };
    repository.commit_wake(wake.clone()).await.unwrap();

    drop(repository);
    drop(storage);
    Arc::try_unwrap(log).ok().unwrap().close().await.unwrap();
    let log = Arc::new(EventLog::open(&path).await.unwrap());
    let storage = Arc::new(Storage {
        log: log.clone(),
        namespace: Namespace::new("example.coordinator", Scope::Profile).unwrap(),
        lose_reply: AtomicBool::new(false),
    });
    let repository = Repository::new(storage.clone(), "planner").unwrap();
    assert_eq!(
        repository.roots(None).await.unwrap(),
        (vec!["root".into()], None)
    );
    assert_eq!(
        repository
            .open("root", Mode::Graph, None, 500)
            .await
            .unwrap(),
        epoch
    );
    assert!(
        Repository::new(storage.clone(), "other-entry")
            .unwrap()
            .current("root")
            .await
            .unwrap()
            .is_none()
    );
    let target = update.source.invocation.clone();
    let stopped = repository
        .stop("root", &epoch.graph_id, Some(target.clone()))
        .await
        .unwrap();
    assert_eq!(stopped.stop_target, Some(target.clone()));
    let mut later = target.clone();
    later.invocation_id = "later-invocation".into();
    later.run_id = "later-run".into();
    later.turn_id = "later-turn".into();
    let retry = repository
        .stop("root", &epoch.graph_id, Some(later))
        .await
        .unwrap();
    assert_eq!(
        retry.stop_target,
        Some(target),
        "stop retries retain the first captured execution"
    );
    let next = repository
        .open("root", Mode::Swarm, Some(&epoch.graph_id), 4)
        .await
        .unwrap();
    assert_eq!(next.epoch, 2);
    assert_ne!(next.graph_id, epoch.graph_id);
    assert!(matches!(
        repository.stop("root", &epoch.graph_id, None).await,
        Err(maka_graph::Error::Conflict)
    ));
    assert_eq!(
        repository.commit_intent(intent.clone()).await.unwrap(),
        intent
    );
    let mut new_intent = intent.clone();
    new_intent.work_id = update.add_work[1].work_id.clone();
    new_intent.request.operation_id = "late".into();
    assert!(matches!(
        repository.commit_intent(new_intent).await,
        Err(maka_graph::Error::Closed)
    ));
    let mut changed_wake = wake.clone();
    changed_wake.request.content = "later projection".into();
    assert_eq!(repository.commit_wake(changed_wake).await.unwrap(), wake);
    assert_eq!(
        repository
            .commit_update(update.clone(), 0, 999)
            .await
            .unwrap(),
        committed
    );
    assert_eq!(
        repository
            .work("root", &epoch.graph_id, &intent.work_id)
            .await
            .unwrap(),
        Some(update.add_work[0].clone())
    );
    let page = repository.epochs("root", None).await.unwrap();
    assert_eq!(page.epochs, [next, epoch]);
    assert_eq!(
        repository
            .epochs("root", Some(2))
            .await
            .unwrap()
            .epochs
            .len(),
        1
    );
    drop(repository);
    drop(storage);
    Arc::try_unwrap(log).ok().unwrap().close().await.unwrap();
}

#[tokio::test]
async fn graph_decision_and_native_task_outbox_commit_together_without_replacement_on_replay() {
    use maka_capabilities::storage::Data;
    let temp = tempfile::tempdir().unwrap();
    let log = Arc::new(
        EventLog::open(&temp.path().join("atomic.sqlite"))
            .await
            .unwrap(),
    );
    let storage = Arc::new(Storage {
        log,
        namespace: Namespace::new("example.coordinator", Scope::Profile).unwrap(),
        lose_reply: AtomicBool::new(false),
    });
    let repository = Repository::new(storage.clone(), "planner").unwrap();
    let epoch = repository.open("root", Mode::Swarm, None, 1).await.unwrap();
    let mut decision = update(epoch.graph_id.clone());
    decision.add_work.truncate(1);
    let task = |key: &str, text: &str| Mutation {
        key: key.into(),
        expected_revision: None,
        data: Data::Present(serde_json::json!({"frozenInput":text})),
    };
    storage.lose_reply.store(true, Ordering::SeqCst);
    assert!(matches!(
        repository
            .commit_update_with(
                decision.clone(),
                0,
                2,
                vec![task("native/tasks/original", "accepted")]
            )
            .await,
        Err(maka_graph::Error::Storage(StoreError::OutcomeUnknown(_)))
    ));
    assert_eq!(
        storage
            .read("native/tasks/original".into())
            .await
            .unwrap()
            .unwrap()
            .data,
        Data::Present(serde_json::json!({"frozenInput":"accepted"}))
    );
    let recovered = repository
        .commit_update_with(
            decision.clone(),
            0,
            999,
            vec![task("native/tasks/replacement", "changed")],
        )
        .await
        .unwrap();
    assert_eq!(recovered.committed_at, 2);
    assert_eq!(recovered.revision, 1);
    assert!(
        storage
            .read("native/tasks/replacement".into())
            .await
            .unwrap()
            .is_none()
    );

    let mut stale = decision.clone();
    stale.source.operation_id = "different decision".into();
    stale.add_work[0].work_id = WorkId::new();
    assert!(matches!(
        repository
            .commit_update_with(
                stale.clone(),
                0,
                3,
                vec![task("native/tasks/stale", "stale")]
            )
            .await,
        Err(maka_graph::Error::Conflict)
    ));
    assert!(
        storage
            .read("native/tasks/stale".into())
            .await
            .unwrap()
            .is_none()
    );
    // A task conflict must also roll back the graph header and decision record.
    assert!(matches!(
        repository
            .commit_update_with(
                stale,
                1,
                3,
                vec![task("native/tasks/original", "overwrite")]
            )
            .await,
        Err(maka_graph::Error::Conflict)
    ));
    assert_eq!(
        repository
            .current("root")
            .await
            .unwrap()
            .unwrap()
            .schedule_revision,
        1
    );
    assert_eq!(
        repository.updates(&epoch.graph_id, 0, 1).await.unwrap(),
        vec![recovered]
    );
}

mod wake_language {
    use super::*;
    use maka_agent_facts::input::MessageInput;
    use maka_agent_facts::language::Language;
    use maka_agent_ports::execution::*;
    use maka_capabilities::authorization::{CommandError, SessionBoundary};
    use maka_graph::coordinator::{Coordinator, Operators};
    use std::sync::Mutex;

    fn stored_copy(
        row: &maka_agent_facts::event::StoredEvent,
    ) -> maka_agent_facts::event::StoredEvent {
        maka_agent_facts::event::StoredEvent {
            sequence: row.sequence,
            event: row.event.clone(),
        }
    }

    #[derive(Default)]
    struct Host(
        Mutex<Vec<Submit>>,
        Vec<(SessionOperation, maka_agent_facts::event::StoredEvent)>,
        AtomicBool,
    );
    #[allow(unused_variables)]
    impl Commands for Host {
        fn remove_session(
            &self,
            request: RemoveSession,
        ) -> futures_util::future::BoxFuture<'_, Result<RemovedSession, CommandError>> {
            unreachable!("this test only submits supervisor wakes")
        }
        fn removal_receipt(
            &self,
            session_id: String,
        ) -> futures_util::future::BoxFuture<'_, Result<Option<RemovalReceipt>, CommandError>>
        {
            unreachable!("this test only submits supervisor wakes")
        }
        fn preview_removal(
            &self,
            session_id: String,
        ) -> futures_util::future::BoxFuture<'_, Result<u64, CommandError>> {
            unreachable!("this test only submits supervisor wakes")
        }
        fn copy_attachment(
            &self,
            source: std::sync::Arc<dyn Commands>,
            request: CopyAttachment,
        ) -> futures_util::future::BoxFuture<
            '_,
            Result<maka_agent_facts::attachment::AttachmentRef, CommandError>,
        > {
            unreachable!("this test only submits supervisor wakes")
        }
        fn input(
            &self,
            invocation: Invocation,
        ) -> futures_util::future::BoxFuture<'_, Result<Option<MessageInput>, CommandError>>
        {
            unreachable!("this test only submits supervisor wakes")
        }
        fn resume(
            &self,
            request: Resume,
        ) -> futures_util::future::BoxFuture<'_, Result<Invocation, CommandError>> {
            unreachable!("this test only submits supervisor wakes")
        }
        fn configure(
            &self,
            input: Configure,
        ) -> futures_util::future::BoxFuture<'_, Result<Configured, CommandError>> {
            unreachable!("this test only submits supervisor wakes")
        }
        fn read_message(
            &self,
            message: SessionMessage,
        ) -> futures_util::future::BoxFuture<'_, Result<Option<MessageState>, CommandError>>
        {
            unreachable!("this test only submits supervisor wakes")
        }
        fn enqueue(
            &self,
            request: Enqueue,
        ) -> futures_util::future::BoxFuture<'_, Result<MessageReceipt, CommandError>> {
            unreachable!("this test only submits supervisor wakes")
        }
        fn message(
            &self,
            operation: SessionOperation,
        ) -> futures_util::future::BoxFuture<'_, MessageResult> {
            unreachable!("this test only submits supervisor wakes")
        }
        fn retract(
            &self,
            operation: SessionOperation,
        ) -> futures_util::future::BoxFuture<'_, MessageResult> {
            unreachable!("this test only submits supervisor wakes")
        }
        fn offer_interaction(
            &self,
            request: OfferInteraction,
        ) -> futures_util::future::BoxFuture<
            '_,
            Result<maka_agent_facts::interaction::InteractionRecord, CommandError>,
        > {
            unreachable!("this test only submits supervisor wakes")
        }
        fn interaction(
            &self,
            operation_id: String,
        ) -> futures_util::future::BoxFuture<
            '_,
            Result<Option<maka_agent_facts::interaction::InteractionRecord>, CommandError>,
        > {
            unreachable!("this test only submits supervisor wakes")
        }
        fn wait_interaction(
            &self,
            operation_id: String,
        ) -> futures_util::future::BoxFuture<
            '_,
            Result<maka_agent_facts::interaction::InteractionOutcome, CommandError>,
        > {
            unreachable!("this test only submits supervisor wakes")
        }
        fn close_interaction(
            &self,
            operation_id: String,
        ) -> futures_util::future::BoxFuture<
            '_,
            Result<maka_agent_facts::interaction::InteractionRecord, CommandError>,
        > {
            unreachable!("this test only submits supervisor wakes")
        }
        fn session(
            &self,
            session_id: String,
        ) -> futures_util::future::BoxFuture<
            '_,
            Result<maka_agent_ports::session::View, CommandError>,
        > {
            unreachable!("this test only submits supervisor wakes")
        }
        fn capabilities(
            &self,
            session_id: String,
        ) -> futures_util::future::BoxFuture<'_, Result<SessionCapabilities, CommandError>>
        {
            unreachable!("this test only submits supervisor wakes")
        }
        fn activity(
            &self,
            session_id: String,
        ) -> futures_util::future::BoxFuture<'_, Result<Activity, CommandError>> {
            unreachable!("this test only submits supervisor wakes")
        }
        fn stop(
            &self,
            invocation: Invocation,
        ) -> futures_util::future::BoxFuture<'_, Result<(), CommandError>> {
            unreachable!("this test only submits supervisor wakes")
        }
        fn validate_authority(
            &self,
        ) -> futures_util::future::BoxFuture<'_, Result<(), CommandError>> {
            unreachable!("this test only submits supervisor wakes")
        }
        fn create_root(
            &self,
            request: CreateRoot,
        ) -> futures_util::future::BoxFuture<'_, Result<ChildSession, CommandError>> {
            unreachable!("this test only submits supervisor wakes")
        }
        fn restore_root(
            &self,
            operation_id: String,
        ) -> futures_util::future::BoxFuture<'_, Result<Option<ChildSession>, CommandError>>
        {
            unreachable!("this test only submits supervisor wakes")
        }
        fn abandon_revision(
            &self,
            operation_id: String,
        ) -> futures_util::future::BoxFuture<'_, Result<RevisionDisposition, CommandError>>
        {
            unreachable!("this test only submits supervisor wakes")
        }
        fn boundaries(&self) -> Result<Vec<SessionBoundary>, CommandError> {
            unreachable!("this test only submits supervisor wakes")
        }
        fn workspace_patch(
            &self,
            operation: SessionOperation,
        ) -> futures_util::future::BoxFuture<'_, Result<Option<WorkspacePatch>, CommandError>>
        {
            unreachable!("this test only submits supervisor wakes")
        }
        fn artifact(
            &self,
            request: ReadArtifact,
        ) -> futures_util::future::BoxFuture<'_, Result<Option<ArtifactChunk>, CommandError>>
        {
            unreachable!("this test only submits supervisor wakes")
        }
        fn event(
            &self,
            operation: SessionOperation,
            event_id: String,
            through: u64,
        ) -> futures_util::future::BoxFuture<
            '_,
            Result<Option<maka_agent_facts::event::StoredEvent>, CommandError>,
        > {
            Box::pin(async move {
                if self.2.swap(false, Ordering::SeqCst) {
                    return Err(CommandError::Busy);
                }
                Ok(self
                    .1
                    .iter()
                    .find(|(accepted, row)| {
                        accepted == &operation
                            && row.event.id == event_id
                            && row.sequence <= through
                    })
                    .map(|(_, row)| stored_copy(row)))
            })
        }
        fn changes(&self) -> Result<tokio::sync::watch::Receiver<u64>, CommandError> {
            unreachable!("this test only submits supervisor wakes")
        }
        fn events(
            &self,
            operation: SessionOperation,
            after: u64,
            through: u64,
        ) -> futures_util::future::BoxFuture<'_, Result<EventPage, CommandError>> {
            unreachable!("this test only submits supervisor wakes")
        }
        fn restore_child(
            &self,
            request: CreateChild,
        ) -> futures_util::future::BoxFuture<'_, Result<Option<ChildSession>, CommandError>>
        {
            unreachable!("this test only submits supervisor wakes")
        }
        fn create_child(
            &self,
            request: CreateChild,
        ) -> futures_util::future::BoxFuture<'_, Result<ChildSession, CommandError>> {
            unreachable!("this test only submits supervisor wakes")
        }
        fn submit(
            &self,
            request: Submit,
        ) -> futures_util::future::BoxFuture<'_, Result<Receipt, CommandError>> {
            Box::pin(async move {
                self.0.lock().unwrap().push(request);
                Err(CommandError::Busy)
            })
        }
        fn query(
            &self,
            operation: SessionOperation,
        ) -> futures_util::future::BoxFuture<'_, Result<Observation, CommandError>> {
            unreachable!("this test only submits supervisor wakes")
        }
        fn cancel(
            &self,
            operation: SessionOperation,
        ) -> futures_util::future::BoxFuture<'_, Result<Observation, CommandError>> {
            unreachable!("this test only submits supervisor wakes")
        }
    }
    struct Targets;
    impl Operators for Targets {
        fn active(&self) -> BoxFuture<'_, Result<bool, maka_graph::Error>> {
            Box::pin(async { Ok(true) })
        }
        fn provision(
            &self,
            _epoch: &maka_graph::Epoch,
            _operator: &OperatorId,
            _target: &maka_graph::schedule::Target,
        ) -> BoxFuture<'_, Result<ChildSession, maka_graph::Error>> {
            unreachable!("supervisor wakes do not provision workers")
        }
    }

    #[tokio::test]
    async fn completed_model_parts_keep_order_budget_and_exact_history_after_a_read_retry() {
        use maka_agent_facts::event::{Fact, InvocationOutcome, RuntimeEvent, StoredEvent};
        use maka_agent_facts::model::recorded::{
            CompletionPart, ModelCompletion, ModelObservation, ModelPartRecord, RecordedPartRef,
        };
        use maka_agent_facts::model::{ModelFinishReason, ModelPart, TextKind};
        use maka_graph::projection::Execution;
        for (body, expected, truncated) in [
            ("中🙂".to_owned(), "head 中🙂 tail".to_owned(), false),
            (
                "中🙂".repeat(3000),
                format!("head {}中", "中🙂".repeat(2339)),
                true,
            ),
        ] {
            let invocation = Invocation {
                session_id: "child".into(),
                turn_id: "turn".into(),
                run_id: "run".into(),
                invocation_id: "invocation".into(),
            };
            let operation = SessionOperation {
                session_id: "child".into(),
                operation_id: "accepted".into(),
            };
            let text = |ordinal, value: &str, kind| ModelPartRecord {
                ordinal,
                message_id: format!("part-{ordinal}"),
                started_at: std::time::UNIX_EPOCH,
                provider_part_id: None,
                part: Arc::new(ModelPart::Text {
                    text_kind: kind,
                    text: value.into(),
                    provider_options: None,
                }),
            };
            let event = |sequence, id: &str, fact| {
                let mut event = RuntimeEvent::new(invocation.clone(), fact);
                event.id = id.into();
                StoredEvent { sequence, event }
            };
            let observed = event(
                3,
                "original",
                Fact::ModelObserved {
                    step_id: "step".into(),
                    event: ModelObservation::Part(text(1, &body, TextKind::Text)),
                },
            );
            let completed = event(
                4,
                "complete",
                Fact::ModelCompleted {
                    step_id: "step".into(),
                    output: ModelCompletion {
                        parts: vec![
                            CompletionPart::Own(text(0, "head ", TextKind::Text)),
                            CompletionPart::Ref(RecordedPartRef {
                                event_id: "original".into(),
                                ordinal: 1,
                            }),
                            CompletionPart::Own(text(2, "private", TextKind::Thinking)),
                            CompletionPart::Own(text(3, " tail", TextKind::Text)),
                        ],
                        finish_reason: ModelFinishReason::Stop,
                        usage: Default::default(),
                        provider_options: None,
                        response_id: None,
                        model: None,
                        timestamp: None,
                    },
                },
            );
            let terminal = event(
                5,
                "terminal",
                Fact::InvocationEnded {
                    outcome: InvocationOutcome::Completed,
                },
            );
            let earlier = event(
                2,
                "executor",
                Fact::ExecutorCompleted {
                    text: "earlier answer".into(),
                },
            );
            let observation = Observation {
                receipt: Receipt {
                    invocation: invocation.clone(),
                    message_id: "input".into(),
                    content_digest: "digest".into(),
                },
                progress: Progress::Ended {
                    outcome: InvocationOutcome::Completed,
                },
                through_sequence: 5,
                terminal_event_id: Some("terminal".into()),
                attention_id: None,
            };
            let host = Host(
                Mutex::new(Vec::new()),
                vec![(operation.clone(), stored_copy(&observed))],
                AtomicBool::new(true),
            );
            let work = WorkId::new();
            let operator = OperatorId::new();
            let mut projection =
                Execution::new(work.clone(), operator.clone(), observation.clone());
            assert!(
                projection
                    .apply_page(
                        EventPage {
                            events: vec![
                                earlier,
                                stored_copy(&observed),
                                stored_copy(&completed),
                                stored_copy(&terminal)
                            ],
                            through_sequence: 5,
                            next_after: None
                        },
                        &host,
                        &operation
                    )
                    .await
                    .is_err()
            );
            assert_eq!(
                projection.after, 3,
                "retry resumes after already projected facts"
            );
            projection
                .apply_page(
                    EventPage {
                        events: vec![stored_copy(&completed), terminal],
                        through_sequence: 5,
                        next_after: None,
                    },
                    &host,
                    &operation,
                )
                .await
                .unwrap();
            assert_eq!(projection.record_count, 3);
            let terminal = projection.terminal.unwrap();
            assert_eq!(terminal.text, expected);
            assert_eq!(terminal.truncated, truncated);
            let mut historical = Execution::new(work, operator, observation);
            let exact = historical
                .observe(completed, &host, &operation)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(exact.record_id, "complete");
            assert_eq!(exact.text, expected);
            assert_eq!(exact.truncated, truncated);
        }
    }

    #[tokio::test]
    async fn new_wake_uses_current_call_language_while_busy_original_replays_exactly() {
        let temp = tempfile::tempdir().unwrap();
        let log = Arc::new(
            EventLog::open(&temp.path().join("state.sqlite"))
                .await
                .unwrap(),
        );
        let storage = Arc::new(Storage {
            log,
            namespace: Namespace::new("example.coordinator", Scope::Profile).unwrap(),
            lose_reply: AtomicBool::new(false),
        });
        let repository = Arc::new(Repository::new(storage, "planner").unwrap());
        let epoch = repository.open("root", Mode::Graph, None, 1).await.unwrap();
        let host = Arc::new(Host::default());
        let mut owner =
            Coordinator::new(epoch, repository, host.clone(), Arc::new(Targets)).unwrap();
        let work = WorkId::new();
        owner
            .failures
            .insert(work.clone(), "original failure /tmp/原始.rs".into());
        owner.wake_supervisor(Language::ZhCn).await.unwrap();
        let original = host.0.lock().unwrap()[0].clone();
        assert!(original.content.text.contains("持久结果"));
        owner.wake_supervisor(Language::ZhTw).await.unwrap();
        assert_eq!(host.0.lock().unwrap()[1], original);
        owner
            .failures
            .insert(work, "new observation /tmp/原始.rs".into());
        owner.wake_supervisor(Language::ZhTw).await.unwrap();
        let next = host.0.lock().unwrap()[2].clone();
        assert!(next.content.text.contains("持久結果"));
        assert_ne!(next.operation_id, original.operation_id);
        assert_eq!(next.session_id, "root");
        assert_eq!(next.orchestration_mode.unwrap().as_str(), "graph");
    }
}
