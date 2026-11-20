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

use super::*;
use crate::queue::{
    Consume, MessageResolution, Placement, PreparedRequest, QueueCommand, QueueEdit, RequestId,
};
use maka_agent_facts::{
    execution::ModelBinding,
    input::{DeliveredMessage, MessageInput, RunInput},
    message::{MessageDisposition, MessageOrigin, RootSourceMessage},
};
use maka_event_log::{
    RootStore,
    root::{RootNamespaces, RootOwner},
};
use maka_plugin_core::composition::InstanceId;
use maka_sandbox::workspace::{BindingStamp, PermissionBasis};
use std::{path::Path, sync::Arc};
use uuid::Uuid;

async fn open(base: &Path, initialize: bool) -> (RootStore, Store) {
    let namespaces = RootNamespaces {
        ownership: base.join("owners"),
        control: base.join("control"),
    };
    let owner = Arc::new(
        if initialize {
            RootOwner::create(&base.join("root"), &namespaces)
        } else {
            RootOwner::open_existing(&base.join("root"), &namespaces)
        }
        .unwrap(),
    );
    let migrations: Vec<_> = maka_event_log::ROOT_MIGRATIONS
        .iter()
        .chain(crate::MIGRATIONS)
        .copied()
        .collect();
    let root = RootStore::open(owner, &migrations).await.unwrap();
    let data = root.data_writer().unwrap();
    let store = Store::new(data.clone(), DriverDomain::new(data).unwrap()).unwrap();
    (root, store)
}

fn spec() -> (RunSpec, Vec<ContentBlob>) {
    let blob = ContentBlob::json(&RunInput::Message {
        content: MessageInput::from("fixture"),
        request_fingerprint: None,
        source_messages: vec![],
    })
    .unwrap();
    let reference = blob.reference().clone();
    let spec = RunSpec {
        schema_version: SCHEMA_VERSION,
        owner: RunOwner {
            deployment: Uuid::new_v4(),
            namespace: InstanceId(vec![Uuid::new_v4()]),
        },
        session_id: "stop-queue".into(),
        turn_id: "original-turn".into(),
        origin: RunOrigin::Local,
        trigger: Trigger::Message {
            message_id: "original-message".into(),
        },
        workspace: "/".into(),
        permission_basis: PermissionBasis {
            boundary_revision: 0,
            binding: BindingStamp {
                id: Uuid::new_v4(),
                permission_epoch: 0,
            },
        },
        permission_ceiling: maka_sandbox::Permissions {
            sandbox: maka_sandbox::Sandbox::Disabled,
            approval: maka_sandbox::Approval::Never,
        },
        network_approval_ceiling: None,
        filesystem_approval_ceiling: None,
        backend: BackendSpec::Model {
            binding: ModelBinding {
                connection_id: "fixture".into(),
                connection_slug: "fixture".into(),
                model: "fixture".into(),
            },
            descriptor: reference.clone(),
        },
        collaboration: Default::default(),
        language: Default::default(),
        tool_discovery: false,
        allowed_tools: None,
        mcp_revision: None,
        compaction_prompt: None,
        system_prompt: reference.clone(),
        tool_selection: reference.clone(),
        input: reference,
        budget: Budget {
            tokens: None,
            retries: 0,
            deadline: None,
        },
        budget_basis: None,
    };
    (spec, vec![blob])
}

async fn enqueue(
    store: &Store,
    basis: &RunSpec,
    message: &str,
    origin: Option<MessageOrigin>,
) -> PreparedRequest {
    let (request, contents) = prepare_message(basis, message, origin);
    let queue = store.queue().read(basis.session_id.clone()).await.unwrap();
    store
        .queue()
        .execute(
            basis.session_id.clone(),
            QueueCommand {
                id: FactId::new(),
                at: UnixMillis(1),
                expected_revision: queue.revision,
                edit: QueueEdit::Enqueue {
                    request: Box::new(request.clone()),
                    placement: Placement::Followup,
                },
            },
            contents,
        )
        .await
        .unwrap();
    request
}

fn prepare_message(
    basis: &RunSpec,
    message: &str,
    origin: Option<MessageOrigin>,
) -> (PreparedRequest, Vec<ContentBlob>) {
    let content = MessageInput::from(message);
    let schedule = match &origin {
        Some(MessageOrigin::Automation { automation_id, .. }) => Some(automation_id.clone()),
        _ => None,
    };
    let source = ContentBlob::json(&RootSourceMessage {
        message: DeliveredMessage {
            message_id: message.into(),
            submitted_content_digest: content.content_digest().unwrap(),
            content: content.clone(),
            origin,
        },
        unprepared_content: content,
        submitted_placement: maka_agent_facts::message::Placement::NextTurn,
        disposition: MessageDisposition::Followup,
        submitted_intent: None,
    })
    .unwrap();
    let resources = ContentBlob::json(&Vec::<serde_json::Value>::new()).unwrap();
    let mut spec = basis.clone();
    spec.turn_id = format!("turn-{message}");
    spec.trigger = if let Some(schedule_id) = schedule {
        spec.budget_basis = Some(resources.reference().clone());
        Trigger::Schedule { schedule_id }
    } else {
        Trigger::Message {
            message_id: message.into(),
        }
    };
    let request = PreparedRequest {
        id: RequestId(format!("request-{message}")),
        message_id: message.into(),
        spec,
        source: source.reference().clone(),
        resources: resources.reference().clone(),
        required_tools: Default::default(),
    };
    (request, vec![source, resources])
}

async fn resolution(store: &Store, message: &str) -> MessageResolution {
    store
        .queue()
        .resolve_message("stop-queue".into(), message.into())
        .await
        .unwrap()
}

#[tokio::test]
async fn interrupted_steer_precedes_worker_completions_after_queue_rebuild() {
    use crate::queue::{Followup, PreparedEnqueue};
    let directory = tempfile::tempdir().unwrap();
    let (_root, store) = open(directory.path(), true).await;
    let (spec, contents) = spec();
    let caller = Admission::new(spec.clone(), UnixMillis(1), contents.clone());
    store.admit(caller.clone()).await.unwrap();
    let mut current = spec.clone();
    current.turn_id = "busy".into();
    current.trigger = Trigger::Message {
        message_id: "busy-message".into(),
    };
    let run = Admission::new(current, UnixMillis(2), contents);
    store.admit(run.clone()).await.unwrap();
    let queue = store.queue();
    for (index, msg) in ["worker-1", "worker-2", "steer"].into_iter().enumerate() {
        let interrupt = msg == "steer";
        let origin = (!interrupt).then(|| MessageOrigin::SessionCompletion {
            session_id: "worker".into(),
            message_id: msg.into(),
        });
        let (request, contents) = prepare_message(&spec, msg, origin);
        store
            .data
            .write(PreparedEnqueue {
                session: spec.session_id.clone(),
                contents,
                work_fence: None,
                followup: interrupt.then(|| Followup::Interrupt {
                    run: run.run(),
                    stop: FactId::new(),
                }),
                command: QueueCommand {
                    id: FactId::new(),
                    at: UnixMillis(3),
                    expected_revision: index as u64,
                    edit: QueueEdit::Enqueue {
                        request: Box::new(request),
                        placement: if interrupt {
                            Placement::Followup
                        } else {
                            Placement::Completion {
                                caller: caller.run(),
                            }
                        },
                    },
                },
            })
            .await
            .unwrap();
    }
    assert!(store.frontier(run.run()).await.unwrap().stopped);
    let rebuilt = queue.rebuild(spec.session_id.clone()).await.unwrap();
    let entries = queue.read(spec.session_id.clone()).await.unwrap().entries;
    assert_eq!(
        entries
            .iter()
            .map(|e| e.request.message_id.as_str())
            .collect::<Vec<_>>(),
        ["steer", "worker-1", "worker-2"]
    );
    let pending = queue
        .pending_steer_revision(
            spec.session_id.clone(),
            entries[0].request.id.clone(),
            run.run(),
        )
        .await
        .unwrap();
    assert_eq!(pending, Some(rebuilt.revision));
    let first = queue.ready(spec.owner.clone(), None, 1).await.unwrap();
    assert_eq!(first[0].entry, entries[0]);
    let rest = queue
        .ready(spec.owner, Some(first[0].cursor.clone()), 2)
        .await
        .unwrap();
    assert!(rest.iter().map(|e| &e.entry).eq(&entries[1..]));
}

#[tokio::test]
async fn pausing_a_goal_preserves_pending_steering_as_an_independent_turn() {
    use crate::queue::{GOAL_CONTROL_STOP, SteeringTarget};

    let directory = tempfile::tempdir().unwrap();
    let (root, store) = open(directory.path(), true).await;
    let (mut spec, contents) = spec();
    spec.trigger = Trigger::Goal {
        goal_id: Uuid::new_v4(),
    };
    let goal = Admission::new(spec.clone(), UnixMillis(1), contents);
    store.admit(goal.clone()).await.unwrap();

    let request = enqueue(&store, &spec, "keep-this-message", None).await;
    let view = store.frontier(goal.run()).await.unwrap();
    let head = Head::from(&view);
    let queue = store.queue();
    let before = queue.read(spec.session_id.clone()).await.unwrap();
    queue
        .execute(
            spec.session_id.clone(),
            QueueCommand {
                id: FactId::new(),
                at: UnixMillis(2),
                expected_revision: before.revision,
                edit: QueueEdit::Promote {
                    request: request.id.clone(),
                    target: SteeringTarget {
                        run: goal.run(),
                        expected_head: head,
                    },
                },
            },
            vec![],
        )
        .await
        .unwrap();
    let steering_revision =
        || queue.pending_steer_revision(spec.session_id.clone(), request.id.clone(), goal.run());
    assert_eq!(
        steering_revision().await.unwrap(),
        Some(before.revision + 1)
    );
    let stop = Change::new(
        Fact::StopRequested {
            diagnostic: GOAL_CONTROL_STOP.into(),
        },
        UnixMillis(3),
    );
    store
        .control(goal.run(), head, vec![stop.clone()], vec![])
        .await
        .unwrap();
    store
        .control(goal.run(), head, vec![stop], vec![])
        .await
        .unwrap();
    let pending = queue.read(spec.session_id.clone()).await.unwrap();
    assert_eq!(pending.revision, before.revision + 2);
    assert_eq!(
        pending.entries,
        vec![crate::queue::QueueEntry {
            request: request.clone(),
            placement: Placement::Followup
        }]
    );
    queue.rebuild(spec.session_id.clone()).await.unwrap();
    assert_eq!(steering_revision().await.unwrap(), None);
    assert_eq!(queue.read(spec.session_id.clone()).await.unwrap(), pending);

    // Before the handoff existed, the Stop fact was committed without the last queue event.
    struct LegacyQueue(String, u64);
    impl Statement for LegacyQueue {
        type Value = ();
        type Output = ();

        fn execute(self, c: &Connection) -> Result<Prepared<()>, StoreError> {
            assert_eq!(
                c.execute(
                    "DELETE FROM agent_queue_events WHERE session=? AND revision=?",
                    rusqlite::params![self.0, i64::try_from(self.1).unwrap()],
                )?,
                1
            );
            Ok(Prepared {
                value: (),
                changed: true,
                notification: Notification::NONE,
            })
        }

        fn committed(_: ()) {}
        fn isolated_rejection(_: &StoreError) -> bool {
            false
        }
    }
    store
        .data
        .write(LegacyQueue(spec.session_id.clone(), pending.revision))
        .await
        .unwrap();
    queue.rebuild(spec.session_id.clone()).await.unwrap();
    assert_eq!(
        queue
            .steering(spec.session_id.clone(), goal.run())
            .await
            .unwrap()
            .entries
            .len(),
        1
    );
    for _ in 0..2 {
        queue
            .recover_undelivered_steering(spec.owner.clone(), UnixMillis(4))
            .await
            .unwrap();
        assert_eq!(queue.read(spec.session_id.clone()).await.unwrap(), pending);
    }

    let claim = store.claim(goal.run()).await.unwrap();
    let stopped = store.frontier(goal.run()).await.unwrap();
    store
        .append(
            &claim,
            Head::from(&stopped),
            vec![Change::new(
                Fact::RunTerminated {
                    terminal: Terminal::Cancelled,
                    diagnostic: None,
                },
                UnixMillis(4),
            )],
            vec![],
        )
        .await
        .unwrap();
    drop(claim);
    let followup = Admission::new(request.spec, UnixMillis(5), vec![]).with_queue(Consume {
        session: spec.session_id,
        requests: vec![request.id],
        expected_revision: pending.revision,
    });
    store.admit(followup.clone()).await.unwrap();
    assert_eq!(
        resolution(&store, "keep-this-message").await,
        MessageResolution::Delivered {
            run: followup.run(),
            shared: false
        },
    );
    drop(queue);
    drop(store);
    root.close().await.unwrap();
}

#[tokio::test]
async fn stop_cancels_only_current_interactive_cut_atomically_and_survives_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let (root, store) = open(directory.path(), true).await;
    let (spec, contents) = spec();
    let older = Admission::new(spec.clone(), UnixMillis(1), contents.clone());
    store.admit(older.clone()).await.unwrap();
    let mut current_spec = spec.clone();
    current_spec.turn_id = "current-turn".into();
    current_spec.trigger = Trigger::Message {
        message_id: "current-message".into(),
    };
    let current = Admission::new(current_spec, UnixMillis(2), contents);
    store.admit(current.clone()).await.unwrap();
    enqueue(&store, &spec, "queued-one", None).await;
    enqueue(
        &store,
        &spec,
        "worker-finished",
        Some(MessageOrigin::BotWorker {
            session_id: "worker".into(),
        }),
    )
    .await;
    enqueue(
        &store,
        &spec,
        "discovery-report",
        Some(MessageOrigin::DiscoveryReport {
            session_id: "investigation".into(),
        }),
    )
    .await;
    enqueue(
        &store,
        &spec,
        "scheduled",
        Some(MessageOrigin::Automation {
            automation_id: "schedule".into(),
            title: "Scheduled follow-up".into(),
        }),
    )
    .await;
    let stop = Change::new(
        Fact::StopRequested {
            diagnostic: "user_requested_stop".into(),
        },
        UnixMillis(3),
    );
    let original_cut = store.queue().read(spec.session_id.clone()).await.unwrap();
    store
        .data
        .write(StopRun {
            retract_pending: true,
            run: older.run(),
            change: Change::new(stop.fact.clone(), stop.at),
        })
        .await
        .unwrap();
    assert!(store.frontier(older.run()).await.unwrap().stopped);
    assert_eq!(
        store.queue().read(spec.session_id.clone()).await.unwrap(),
        original_cut
    );
    assert_eq!(
        resolution(&store, "queued-one").await,
        MessageResolution::Pending
    );

    // A conflicting canonical fact rejects Stop after its staged retractions: neither may commit.
    let conflicting = Change {
        id: current.id,
        ..stop.clone()
    };
    let rejected = store
        .data
        .write(StopRun {
            retract_pending: true,
            run: current.run(),
            change: conflicting,
        })
        .await
        .unwrap_err();
    assert!(
        matches!(rejected.underlying(), StoreError::EventConflict),
        "{rejected}"
    );
    assert_eq!(
        store.queue().read(spec.session_id.clone()).await.unwrap(),
        original_cut
    );
    assert!(!store.frontier(current.run()).await.unwrap().stopped);
    assert_eq!(
        resolution(&store, "queued-one").await,
        MessageResolution::Pending
    );
    store
        .data
        .write(StopRun {
            retract_pending: true,
            run: current.run(),
            change: stop.clone(),
        })
        .await
        .unwrap();
    let stopped = store.frontier(current.run()).await.unwrap();
    assert_eq!(stopped.run, current.run());
    assert!(stopped.stopped);
    assert_eq!(
        resolution(&store, "queued-one").await,
        MessageResolution::Cancelled
    );
    assert_eq!(
        resolution(&store, "worker-finished").await,
        MessageResolution::Cancelled
    );
    assert_eq!(
        resolution(&store, "discovery-report").await,
        MessageResolution::Pending
    );
    assert_eq!(
        resolution(&store, "scheduled").await,
        MessageResolution::Pending
    );

    let later = enqueue(&store, &spec, "after-stop", None).await;
    let cut = store.queue().read(spec.session_id.clone()).await.unwrap();
    store
        .data
        .write(StopRun {
            retract_pending: true,
            run: current.run(),
            change: stop.clone(),
        })
        .await
        .unwrap();
    assert_eq!(
        store.queue().read(spec.session_id.clone()).await.unwrap(),
        cut
    );
    assert_eq!(
        resolution(&store, "after-stop").await,
        MessageResolution::Pending
    );
    drop(store);
    root.close().await.unwrap();

    let (root, store) = open(directory.path(), false).await;
    assert!(store.frontier(current.run()).await.unwrap().stopped);
    store
        .queue()
        .rebuild(spec.session_id.clone())
        .await
        .unwrap();
    assert_eq!(
        resolution(&store, "queued-one").await,
        MessageResolution::Cancelled
    );
    assert_eq!(
        resolution(&store, "scheduled").await,
        MessageResolution::Pending
    );
    assert_eq!(
        resolution(&store, "discovery-report").await,
        MessageResolution::Pending
    );
    assert_eq!(
        resolution(&store, "worker-finished").await,
        MessageResolution::Cancelled
    );
    store
        .data
        .write(StopRun {
            retract_pending: true,
            run: current.run(),
            change: stop,
        })
        .await
        .unwrap();
    assert_eq!(
        resolution(&store, "after-stop").await,
        MessageResolution::Pending
    );
    {
        let claim = store.claim(current.run()).await.unwrap();
        let view = store.frontier(current.run()).await.unwrap();
        store
            .append(
                &claim,
                Head::from(&view),
                vec![Change::new(
                    Fact::RunTerminated {
                        terminal: Terminal::Cancelled,
                        diagnostic: None,
                    },
                    UnixMillis(4),
                )],
                vec![],
            )
            .await
            .unwrap();
    }
    let queue = store.queue().read(spec.session_id.clone()).await.unwrap();
    let fresh = Admission::new(later.spec, UnixMillis(4), vec![]).with_queue(Consume {
        session: spec.session_id.clone(),
        requests: vec![later.id],
        expected_revision: queue.revision,
    });
    store.admit(fresh.clone()).await.unwrap();
    assert_ne!(fresh.run(), current.run());
    assert_eq!(
        resolution(&store, "after-stop").await,
        MessageResolution::Delivered {
            run: fresh.run(),
            shared: false
        }
    );
    {
        let claim = store.claim(fresh.run()).await.unwrap();
        let view = store.frontier(fresh.run()).await.unwrap();
        store
            .append(
                &claim,
                Head::from(&view),
                vec![Change::new(
                    Fact::RunTerminated {
                        terminal: Terminal::Completed,
                        diagnostic: None,
                    },
                    UnixMillis(5),
                )],
                vec![],
            )
            .await
            .unwrap();
    }
    enqueue(&store, &spec, "after-terminal", None).await;
    let cut = store.queue().read(spec.session_id.clone()).await.unwrap();
    store
        .data
        .write(StopRun {
            retract_pending: true,
            run: fresh.run(),
            change: Change::new(
                Fact::StopRequested {
                    diagnostic: "user_requested_stop".into(),
                },
                UnixMillis(6),
            ),
        })
        .await
        .unwrap();
    assert!(!store.frontier(fresh.run()).await.unwrap().stopped);
    assert_eq!(store.queue().read(spec.session_id).await.unwrap(), cut);
    assert_eq!(
        resolution(&store, "after-terminal").await,
        MessageResolution::Pending
    );
    drop(store);
    root.close().await.unwrap();
}

#[tokio::test]
async fn confirmed_native_exit_unblocks_a_previously_failed_conversation() {
    use maka_plugin_core::operation::OperationCleanup;

    let directory = tempfile::tempdir().unwrap();
    let (root, store) = open(directory.path(), true).await;
    let (mut spec, contents) = spec();
    let descriptor = spec.input.clone();
    spec.backend = BackendSpec::Executor {
        selection: maka_agent_facts::executor::Selection {
            executor: "external".into(),
            settings: Default::default(),
        },
        descriptor: descriptor.clone(),
    };
    let original = Admission::new(spec.clone(), UnixMillis(1), contents);
    store.admit(original.clone()).await.unwrap();
    let run = original.run();
    let task = ExternalTaskId::new();
    let unobservable = BlockerKind::ExternalTaskUnobservable {
        descriptor: descriptor.clone(),
    };
    let claim = store.claim(run).await.unwrap();
    let view = store.frontier(run).await.unwrap();
    store
        .append(
            &claim,
            Head::from(&view),
            [
                Fact::ExternalTaskPrepared {
                    task,
                    descriptor,
                    live_workspace: true,
                },
                Fact::ExternalTaskAdmitted { task },
                Fact::Blocked {
                    blocker: BlockerId::new(),
                    reason: unobservable,
                },
                Fact::RunTerminated {
                    terminal: Terminal::Failed,
                    diagnostic: None,
                },
            ]
            .into_iter()
            .map(|fact| Change::new(fact, UnixMillis(2)))
            .collect(),
            vec![],
        )
        .await
        .unwrap();
    let request = enqueue(&store, &spec, "followup-after-native-exit", None).await;
    let queue = store.queue().read(spec.session_id.clone()).await.unwrap();
    let successor = Admission::new(request.spec, UnixMillis(4), vec![]).with_queue(Consume {
        session: spec.session_id,
        requests: vec![request.id],
        expected_revision: queue.revision,
    });
    assert!(matches!(
        store.admit(successor.clone()).await,
        Err(StoreError::InvalidTransition(reason)) if reason == "previous Run has unsettled original operations"
    ));
    store
        .observe(
            run,
            vec![Change::new(
                Fact::ExternalTaskCleanupObserved {
                    task,
                    cleanup: OperationCleanup::Confirmed,
                },
                UnixMillis(3),
            )],
            vec![],
        )
        .await
        .unwrap();
    store.admit(successor.clone()).await.unwrap();
    assert_eq!(
        resolution(&store, "followup-after-native-exit").await,
        MessageResolution::Delivered {
            run: successor.run(),
            shared: false
        }
    );
    drop((claim, store));
    root.close().await.unwrap();
}

#[tokio::test]
async fn verify_owned_content_and_run_revision_through_respect_pins_and_boundaries() {
    let directory = tempfile::tempdir().unwrap();
    let (root, store) = open(directory.path(), true).await;
    let (spec1, contents1) = spec();
    let run1_admission = Admission::new(spec1.clone(), UnixMillis(1), contents1);
    let run1 = run1_admission.run();
    store.admit(run1_admission).await.unwrap();

    let mut foreign_spec = spec1.clone();
    foreign_spec.session_id = "other-session".into();
    foreign_spec.turn_id = "foreign-turn".into();
    foreign_spec.trigger = Trigger::Message {
        message_id: "foreign-message".into(),
    };
    let foreign_blob = ContentBlob::json(&"foreign-selection").unwrap();
    foreign_spec.tool_selection = foreign_blob.reference().clone();
    let foreign_admission = Admission::new(foreign_spec, UnixMillis(1), vec![foreign_blob]);
    let foreign_run = foreign_admission.run();
    store.admit(foreign_admission).await.unwrap();

    // Pinned content passes; unpinned digest and wrong length fail.
    store
        .verify_owned_content(run1, spec1.tool_selection.clone())
        .await
        .unwrap();
    let mut wrong_len = spec1.tool_selection.clone();
    wrong_len.bytes += 1;
    assert!(store.verify_owned_content(run1, wrong_len).await.is_err());

    let extra_blob = ContentBlob::json(&"other-run-only").unwrap();
    let extra_ref = extra_blob.reference().clone();
    let mut spec2 = spec1.clone();
    spec2.turn_id = "second-turn".into();
    spec2.trigger = Trigger::Message {
        message_id: "second-message".into(),
    };
    spec2.tool_selection = extra_ref.clone();
    let run2_admission = Admission::new(spec2, UnixMillis(2), vec![extra_blob]);
    let run2 = run2_admission.run();

    // Append a second fact to run1 before run2 is admitted, then terminate run1 after run2.
    {
        let claim1 = store.claim(run1).await.unwrap();
        let view1 = store.frontier(run1).await.unwrap();
        store
            .append(
                &claim1,
                Head::from(&view1),
                vec![Change::new(
                    Fact::StopRequested {
                        diagnostic: "mid-run".into(),
                    },
                    UnixMillis(2),
                )],
                vec![],
            )
            .await
            .unwrap();
        store.admit(run2_admission).await.unwrap();
        let view1 = store.frontier(run1).await.unwrap();
        store
            .append(
                &claim1,
                Head::from(&view1),
                vec![Change::new(
                    Fact::RunTerminated {
                        terminal: Terminal::Cancelled,
                        diagnostic: None,
                    },
                    UnixMillis(3),
                )],
                vec![],
            )
            .await
            .unwrap();
    }

    // Foreign run cannot pass pin check for run2's content.
    assert!(
        store
            .verify_owned_content(run1, extra_ref.clone())
            .await
            .is_err()
    );
    store.verify_owned_content(run2, extra_ref).await.unwrap();

    let history = store.session_history(spec1.owner.clone(), spec1.session_id.clone());
    let cut = history.capture().await.unwrap();
    let items = history.page(&cut, 0, 16).await.unwrap().items;
    assert_eq!(items.len(), 4);
    let seq_r1_adm = items[0].sequence;
    let seq_r1_stop = items[1].sequence;
    let seq_r2_adm = items[2].sequence;
    let seq_r1_term = items[3].sequence;

    assert_eq!(
        history.run_revision_through(&cut, run1, 0).await.unwrap(),
        0
    );
    assert_eq!(
        history
            .run_revision_through(&cut, run1, seq_r1_adm)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        history
            .run_revision_through(&cut, run1, seq_r1_stop)
            .await
            .unwrap(),
        2
    );
    assert_eq!(
        history
            .run_revision_through(&cut, run1, seq_r2_adm)
            .await
            .unwrap(),
        2
    );
    assert_eq!(
        history
            .run_revision_through(&cut, run1, seq_r1_term)
            .await
            .unwrap(),
        3
    );
    assert_eq!(
        history
            .run_revision_through(&cut, run2, seq_r1_stop)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        history
            .run_revision_through(&cut, run2, seq_r2_adm)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        history
            .run_revision_through(&cut, foreign_run, cut.through_sequence)
            .await
            .unwrap(),
        0
    );
    assert!(
        history
            .run_revision_through(&cut, run1, cut.through_sequence + 1)
            .await
            .is_err()
    );

    drop(store);
    root.close().await.unwrap();
}
