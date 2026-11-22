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

pub(super) async fn open(base: &Path, initialize: bool) -> (RootStore, Store) {
    open_through(base, initialize, i64::MAX).await
}

async fn open_through(base: &Path, initialize: bool, through: i64) -> (RootStore, Store) {
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
        .filter(|migration| migration.version <= through)
        .copied()
        .collect();
    let root = RootStore::open(owner, &migrations).await.unwrap();
    let data = root.data_writer().unwrap();
    let store = Store::new(data.clone(), DriverDomain::new(data).unwrap()).unwrap();
    (root, store)
}

pub(crate) fn spec() -> (RunSpec, Vec<ContentBlob>) {
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
        memory_admission: Default::default(),
        memory_projection: None,
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

pub(super) async fn enqueue(
    store: &Store,
    basis: &RunSpec,
    message: &str,
    origin: Option<MessageOrigin>,
) -> PreparedRequest {
    enqueue_placed(store, basis, message, origin, Placement::Followup).await
}

async fn enqueue_placed(
    store: &Store,
    basis: &RunSpec,
    message: &str,
    origin: Option<MessageOrigin>,
    placement: Placement,
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
                    placement,
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

async fn exec_sql<F>(store: &Store, f: F)
where
    F: FnOnce(&Connection) -> Result<(), StoreError> + Send + 'static,
{
    struct Raw<F>(F);
    impl<F: FnOnce(&Connection) -> Result<(), StoreError> + Send + 'static> Statement for Raw<F> {
        type Value = ();
        type Output = ();
        fn execute(self, c: &Connection) -> Result<Prepared<()>, StoreError> {
            (self.0)(c)?;
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
    store.data.write(Raw(f)).await.unwrap();
}

fn external_spec() -> (RunSpec, Vec<ContentBlob>) {
    let (mut spec, contents) = spec();
    spec.backend = BackendSpec::Executor {
        selection: maka_agent_facts::executor::Selection {
            executor: "external".into(),
            settings: Default::default(),
        },
        descriptor: spec.input.clone(),
    };
    (spec, contents)
}

async fn write_queue(
    store: &Store,
    session: &str,
    at: i64,
    followup: Option<crate::queue::Followup>,
    edit: QueueEdit,
    contents: Vec<ContentBlob>,
) -> Result<crate::queue::QueueCommit, StoreError> {
    let expected_revision = store.queue().read(session.into()).await?.revision;
    let command = QueueCommand {
        id: FactId::new(),
        at: UnixMillis(at),
        expected_revision,
        edit,
    };
    store
        .data
        .write(crate::queue::PreparedEnqueue {
            session: session.into(),
            contents,
            work_fence: None,
            followup,
            command,
        })
        .await
}

async fn enqueue_at(store: &Store, basis: &RunSpec, msg: &str, at: i64) -> PreparedRequest {
    let (req, contents) = prepare_message(basis, msg, None);
    let edit = QueueEdit::Enqueue {
        request: Box::new(req.clone()),
        placement: Placement::Followup,
    };
    write_queue(store, &basis.session_id, at, None, edit, contents)
        .await
        .unwrap();
    req
}

async fn cancel_and_admit(
    store: &Store,
    session: &str,
    prev: RunId,
    next: PreparedRequest,
    at: i64,
) -> RunId {
    let claim = store.claim(prev).await.unwrap();
    let head = Head::from(&store.frontier(prev).await.unwrap());
    let fact = Fact::RunTerminated {
        terminal: Terminal::Cancelled,
        diagnostic: None,
    };
    store
        .append(
            &claim,
            head,
            vec![Change::new(fact, UnixMillis(at))],
            vec![],
        )
        .await
        .unwrap();
    drop(claim);
    let rev = store.queue().read(session.into()).await.unwrap().revision;
    let cut = Consume {
        session: session.into(),
        requests: vec![next.id],
        expected_revision: rev,
    };
    let admission = Admission::new(next.spec, UnixMillis(at + 1), vec![]).with_queue(cut);
    store.admit(admission.clone()).await.unwrap();
    admission.run()
}

#[tokio::test]
async fn reorder_preserves_interrupt_handoffs_and_enqueue_times() {
    use crate::queue::{Followup, SteeringTarget};

    let dir = tempfile::tempdir().unwrap();
    let (root, store) = open(dir.path(), true).await;
    let (spec, contents) = external_spec();
    let sid = &spec.session_id;
    let orig = Admission::new(spec.clone(), UnixMillis(1), contents);
    store.admit(orig.clone()).await.unwrap();

    let a = enqueue_at(&store, &spec, "ordinary-a", 10).await;
    let b = enqueue_at(&store, &spec, "ordinary-b", 20).await;
    let second = enqueue_at(&store, &spec, "promoted-interrupt", 30).await;
    let (intr, contents) = prepare_message(&spec, "interrupt", None);
    let enq = QueueEdit::Enqueue {
        request: Box::new(intr.clone()),
        placement: Placement::Followup,
    };
    let f_int = Followup::Interrupt {
        run: orig.run(),
        stop: FactId::new(),
    };
    write_queue(&store, sid, 40, Some(f_int), enq, contents)
        .await
        .unwrap();

    let q = store.queue();
    let view = store.frontier(orig.run()).await.unwrap();
    let handoff = q.interrupt_handoff(&view).await.unwrap().unwrap();
    let target = SteeringTarget {
        run: orig.run(),
        expected_head: Head::from(&view),
    };
    let promo = QueueEdit::Promote {
        request: second.id.clone(),
        target,
    };
    write_queue(
        &store,
        sid,
        50,
        Some(Followup::Resume(handoff)),
        promo,
        vec![],
    )
    .await
    .unwrap();
    assert!(
        q.pending_steer_revision(sid.clone(), second.id.clone(), orig.run())
            .await
            .unwrap()
            .is_some()
    );

    let before = q.read(sid.clone()).await.unwrap();
    for bad in [
        vec![
            b.id.clone(),
            intr.id.clone(),
            second.id.clone(),
            a.id.clone(),
        ],
        vec![
            second.id.clone(),
            intr.id.clone(),
            b.id.clone(),
            a.id.clone(),
        ],
    ] {
        let edit = QueueEdit::Reorder { requests: bad };
        assert!(
            write_queue(&store, sid, 60, None, edit, vec![])
                .await
                .is_err()
        );
    }
    assert_eq!(q.read(sid.clone()).await.unwrap(), before);

    let want = vec![
        intr.id.clone(),
        second.id.clone(),
        b.id.clone(),
        a.id.clone(),
    ];
    let reorder = QueueEdit::Reorder {
        requests: want.clone(),
    };
    write_queue(&store, sid, 60, None, reorder, vec![])
        .await
        .unwrap();
    let upd = QueueEdit::Update {
        request: Box::new(a.clone()),
    };
    write_queue(&store, sid, 65, None, upd, vec![])
        .await
        .unwrap();
    q.rebuild(sid.clone()).await.unwrap();
    let ids: Vec<_> = q
        .read(sid.clone())
        .await
        .unwrap()
        .entries
        .into_iter()
        .map(|e| e.request.id)
        .collect();
    assert_eq!(ids, want);
    for (id, at) in [(&a.id, 10), (&b.id, 20), (&second.id, 30), (&intr.id, 40)] {
        assert_eq!(
            q.entry_enqueued_at(sid.clone(), id.clone()).await.unwrap(),
            Some(UnixMillis(at))
        );
    }

    // Successor keeps original provenance; another message promoted through it survives rebuild & delivery.
    let succ = cancel_and_admit(&store, sid, orig.run(), intr, 70).await;
    let view = store.frontier(succ).await.unwrap();
    let handoff = q.interrupt_handoff(&view).await.unwrap().unwrap();
    assert_eq!(handoff.interrupted(), orig.run());
    let target = SteeringTarget {
        run: succ,
        expected_head: Head::from(&view),
    };
    let promo_b = QueueEdit::Promote {
        request: b.id.clone(),
        target,
    };
    write_queue(
        &store,
        sid,
        80,
        Some(Followup::Resume(handoff)),
        promo_b,
        vec![],
    )
    .await
    .unwrap();
    assert!(
        q.pending_steer_revision(sid.clone(), b.id.clone(), succ)
            .await
            .unwrap()
            .is_some()
    );
    q.rebuild(sid.clone()).await.unwrap();
    assert_eq!(
        q.entry_enqueued_at(sid.clone(), b.id.clone())
            .await
            .unwrap(),
        Some(UnixMillis(20))
    );
    let promoted = cancel_and_admit(&store, sid, succ, b, 90).await;
    let view = store.frontier(promoted).await.unwrap();
    assert_eq!(
        q.interrupt_handoff(&view)
            .await
            .unwrap()
            .unwrap()
            .interrupted(),
        orig.run()
    );

    // In-place steering Promote on a model session also preserves original enqueue time.
    let (mut mspec, mcontents) = self::spec();
    mspec.session_id = "timing-session".into();
    let msid = &mspec.session_id;
    let mrun = Admission::new(mspec.clone(), UnixMillis(1), mcontents);
    store.admit(mrun.clone()).await.unwrap();
    let ma = enqueue_at(&store, &mspec, "ma", 10).await;
    let mb = enqueue_at(&store, &mspec, "mb", 30).await;
    let reorder = QueueEdit::Reorder {
        requests: vec![mb.id.clone(), ma.id.clone()],
    };
    write_queue(&store, msid, 40, None, reorder, vec![])
        .await
        .unwrap();
    let head = Head::from(&store.frontier(mrun.run()).await.unwrap());
    let target = SteeringTarget {
        run: mrun.run(),
        expected_head: head,
    };
    let promo = QueueEdit::Promote {
        request: ma.id.clone(),
        target,
    };
    write_queue(&store, msid, 50, None, promo, vec![])
        .await
        .unwrap();
    q.rebuild(msid.clone()).await.unwrap();
    assert_eq!(
        q.entry_enqueued_at(msid.clone(), ma.id).await.unwrap(),
        Some(UnixMillis(10))
    );
    assert_eq!(
        q.entry_enqueued_at(msid.clone(), mb.id).await.unwrap(),
        Some(UnixMillis(30))
    );
    drop(q);
    drop(store);
    root.close().await.unwrap();
}

#[tokio::test]
async fn upgrade_repairs_old_reorder_handoff_before_queue_is_used() {
    use crate::queue::Followup;

    let dir = tempfile::tempdir().unwrap();
    let (root, store) = open_through(dir.path(), true, 53).await;
    // Seed canonical events with the current writer, then drop the v54 columns
    // to leave a genuine v53 schema before reopening.
    exec_sql(&store, |c| {
        c.execute_batch("ALTER TABLE agent_queue_items ADD COLUMN enqueued_at INTEGER NOT NULL DEFAULT 0; ALTER TABLE agent_queue_items ADD COLUMN interrupted_run TEXT;")?;
        Ok(())
    }).await;

    let (spec, contents) = external_spec();
    let sid = spec.session_id.clone();
    let orig = Admission::new(spec.clone(), UnixMillis(1), contents);
    store.admit(orig.clone()).await.unwrap();
    let a = enqueue_at(&store, &spec, "old-a", 10).await;
    let b = enqueue_at(&store, &spec, "old-b", 20).await;
    let (intr, contents) = prepare_message(&spec, "old-interrupt", None);
    let enq = QueueEdit::Enqueue {
        request: Box::new(intr.clone()),
        placement: Placement::Followup,
    };
    let f_int = Followup::Interrupt {
        run: orig.run(),
        stop: FactId::new(),
    };
    write_queue(&store, &sid, 40, Some(f_int), enq, contents)
        .await
        .unwrap();
    let valid = QueueEdit::Reorder {
        requests: vec![intr.id.clone(), b.id.clone(), a.id.clone()],
    };
    write_queue(&store, &sid, 50, None, valid, vec![])
        .await
        .unwrap();

    // Rewrite rev 4 to a historical invalid reorder that moved ordinary b ahead of interrupt.
    let old_order = vec![b.id.clone(), intr.id.clone(), a.id.clone()];
    let sid_copy = sid.clone();
    exec_sql(&store, move |c| {
        let body: Vec<u8> = c.query_row(
            "SELECT b.payload FROM agent_queue_events e JOIN contents b ON b.id=e.body_content_id WHERE e.session=? AND e.revision=4",
            [&sid_copy], |row| row.get(0),
        )?;
        let mut event: serde_json::Value = serde_json::from_slice(&body)?;
        event["edit"]["requests"] = serde_json::to_value(&old_order)?;
        let content = ContentBlob::json(&event)?.store(c)?;
        c.execute("UPDATE agent_queue_events SET body_content_id=? WHERE session=? AND revision=4", rusqlite::params![content, sid_copy])?;
        for (pos, id) in old_order.iter().enumerate() {
            c.execute("UPDATE agent_queue_items SET position=? WHERE session=? AND request=?", rusqlite::params![pos as i64, sid_copy, id.0])?;
        }
        Ok(())
    }).await;

    // A session without reorders still needs its enqueue timestamp backfilled.
    let (mut plain, _) = self::spec();
    plain.session_id = "plain-upgrade".into();
    let plain_req = enqueue_at(&store, &plain, "plain", 15).await;
    let retract = QueueEdit::Retract {
        request: plain_req.id.clone(),
    };
    write_queue(&store, &plain.session_id, 25, None, retract, vec![])
        .await
        .unwrap();

    exec_sql(&store, |c| {
        c.execute_batch("ALTER TABLE agent_queue_items DROP COLUMN enqueued_at; ALTER TABLE agent_queue_items DROP COLUMN interrupted_run;")?;
        Ok(())
    }).await;
    drop(store);
    root.close().await.unwrap();

    let (root, store) = open(dir.path(), false).await;
    let q = store.queue();
    assert_eq!(
        q.entry_enqueued_at(plain.session_id, plain_req.id)
            .await
            .unwrap(),
        Some(UnixMillis(15))
    );
    for (id, at) in [(&a.id, 10), (&b.id, 20), (&intr.id, 40)] {
        assert_eq!(
            q.entry_enqueued_at(sid.clone(), id.clone()).await.unwrap(),
            Some(UnixMillis(at))
        );
    }
    let before = q.read(sid.clone()).await.unwrap();
    let ids: Vec<_> = before.entries.iter().map(|e| &e.request.id).collect();
    assert_eq!(ids, vec![&intr.id, &b.id, &a.id]);
    let view = store.frontier(orig.run()).await.unwrap();
    assert_eq!(
        q.interrupt_handoff(&view)
            .await
            .unwrap()
            .unwrap()
            .interrupted(),
        orig.run()
    );
    q.rebuild(sid.clone()).await.unwrap();
    assert_eq!(q.read(sid).await.unwrap(), before);
    drop(q);
    drop(store);
    root.close().await.unwrap();
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
            requester: StopRequester::Internal,
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
    queue
        .recover_undelivered_steering(
            spec.owner.clone(),
            Some("another-session".into()),
            UnixMillis(4),
        )
        .await
        .unwrap();
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
            .recover_undelivered_steering(
                spec.owner.clone(),
                Some(spec.session_id.clone()),
                UnixMillis(4),
            )
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
async fn a_user_stop_cancels_what_the_user_queued_and_holds_the_rest_for_the_next_run() {
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
        "task-completed",
        Some(MessageOrigin::SessionCompletion {
            session_id: "worker".into(),
            message_id: "delegated".into(),
        }),
    )
    .await;
    enqueue(
        &store,
        &spec,
        "from-another-session",
        Some(MessageOrigin::Session {
            execution: maka_agent_facts::durable::ExecutionIdentity {
                session_id: "peer".into(),
                turn_id: "peer-turn".into(),
                run_id: older.run(),
            },
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
    let mut elsewhere = spec.clone();
    elsewhere.workspace = "/elsewhere".into();
    enqueue(
        &store,
        &elsewhere,
        "peer-elsewhere",
        from_session("peer", older.run()),
    )
    .await;
    let caller = Placement::Completion {
        caller: current.run(),
    };
    enqueue_placed(
        &store,
        &spec,
        "delegated-result",
        Some(MessageOrigin::SessionCompletion {
            session_id: "worker".into(),
            message_id: "delegated".into(),
        }),
        caller.clone(),
    )
    .await;
    enqueue_placed(
        &store,
        &spec,
        "continuation",
        Some(MessageOrigin::Session {
            execution: maka_agent_facts::durable::ExecutionIdentity {
                session_id: spec.session_id.clone(),
                turn_id: "current-turn".into(),
                run_id: current.run(),
            },
        }),
        caller,
    )
    .await;
    let stop = Change::new(
        Fact::StopRequested {
            diagnostic: "user_requested_stop".into(),
            requester: StopRequester::User,
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
    // The stopped turn's own continuation goes with it.
    assert_eq!(
        resolution(&store, "continuation").await,
        MessageResolution::Cancelled
    );
    // What others sent stays, since its sender will not send it again, and
    // waits for the next Run instead of starting one.
    let placements = |queue: crate::queue::Queue| {
        queue
            .entries
            .into_iter()
            .map(|entry| (entry.request.message_id, entry.placement))
            .collect::<Vec<_>>()
    };
    let held = |message: &str| (message.to_owned(), Placement::Held);
    assert_eq!(
        placements(store.queue().read(spec.session_id.clone()).await.unwrap()),
        [
            held("worker-finished"),
            held("task-completed"),
            held("from-another-session"),
            held("discovery-report"),
            ("scheduled".to_owned(), Placement::Followup),
            held("peer-elsewhere"),
            held("delegated-result"),
        ]
    );
    // So does what others send until then, also when the sender retries.
    let (notice, notice_contents) = prepare_message(
        &spec,
        "late-notice",
        Some(MessageOrigin::BotWorker {
            session_id: "worker".into(),
        }),
    );
    let late = QueueCommand {
        id: FactId::new(),
        at: UnixMillis(3),
        expected_revision: store
            .queue()
            .read(spec.session_id.clone())
            .await
            .unwrap()
            .revision,
        edit: QueueEdit::Enqueue {
            request: Box::new(notice),
            placement: Placement::Followup,
        },
    };
    let mut commits = Vec::new();
    for _ in 0..2 {
        commits.push(
            store
                .queue()
                .execute(
                    spec.session_id.clone(),
                    late.clone(),
                    notice_contents.clone(),
                )
                .await
                .unwrap(),
        );
    }
    assert_eq!(commits[0], commits[1]);
    let ready: Vec<_> = store
        .queue()
        .ready(spec.owner.clone(), None, 64)
        .await
        .unwrap()
        .into_iter()
        .map(|ready| ready.entry.request.message_id)
        .collect();
    assert_eq!(ready, ["scheduled"]);

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
        store.queue().read(spec.session_id.clone()).await.unwrap(),
        cut
    );
    assert_eq!(
        resolution(&store, "queued-one").await,
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
    // The next Run reads what waited, in order, after the message that
    // started it. What it may not read gets a turn of its own after it.
    let carried: Vec<_> = store
        .queue()
        .steering(spec.session_id.clone(), fresh.run())
        .await
        .unwrap()
        .entries
        .into_iter()
        .map(|entry| entry.request.message_id)
        .collect();
    assert_eq!(
        carried,
        [
            "worker-finished",
            "task-completed",
            "from-another-session",
            "discovery-report",
            "delegated-result",
            "late-notice",
        ]
    );
    let released = store.queue().read(spec.session_id.clone()).await.unwrap();
    assert_eq!(
        placements(released.clone())
            .into_iter()
            .filter(|(_, placement)| !matches!(placement, Placement::Steering { .. }))
            .collect::<Vec<_>>(),
        [
            ("scheduled".to_owned(), Placement::Followup),
            ("peer-elsewhere".to_owned(), Placement::Followup),
        ]
    );
    store
        .queue()
        .rebuild(spec.session_id.clone())
        .await
        .unwrap();
    assert_eq!(
        store.queue().read(spec.session_id.clone()).await.unwrap(),
        released
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
                    requester: StopRequester::User,
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
    let history = store.session_history(spec.owner.clone(), spec.session_id.clone());
    assert_eq!(
        store
            .session_quiescence(spec.owner.clone(), spec.session_id.clone())
            .await
            .unwrap(),
        SessionQuiescence::Busy(SessionObligation::ExternalTask)
    );
    assert!(matches!(
        history
            .fork_cut(maka_agent_facts::session::ForkPosition::End)
            .await,
        Err(StoreError::InvalidTransition(reason))
            if reason == "fork source has unresolved original effects or cleanup"
    ));
    let request = enqueue(&store, &spec, "followup-after-native-exit", None).await;
    let queue = store.queue().read(spec.session_id.clone()).await.unwrap();
    let successor = Admission::new(request.spec, UnixMillis(4), vec![]).with_queue(Consume {
        session: spec.session_id.clone(),
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
    history
        .fork_cut(maka_agent_facts::session::ForkPosition::End)
        .await
        .expect("confirmed native exit with ExternalTaskUnobservable must allow fork");
    let settled_view = store.frontier(run).await.unwrap();
    assert!(
        crate::session_catalog::run_status(&settled_view, 0).unknown_effects,
        "catalog display must preserve unknown_effects for ExternalTaskUnobservable"
    );
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
                        requester: StopRequester::Internal,
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

fn from_session(session: &str, run: RunId) -> Option<MessageOrigin> {
    Some(MessageOrigin::Session {
        execution: maka_agent_facts::durable::ExecutionIdentity {
            session_id: session.into(),
            turn_id: format!("{session}-turn"),
            run_id: run,
        },
    })
}

#[tokio::test]
async fn a_session_stop_takes_back_only_what_that_session_sent() {
    let directory = tempfile::tempdir().unwrap();
    let (root, store) = open(directory.path(), true).await;
    let (spec, contents) = spec();
    let worker = Admission::new(spec.clone(), UnixMillis(1), contents);
    store.admit(worker.clone()).await.unwrap();
    enqueue(&store, &spec, "typed-by-user", None).await;
    enqueue(
        &store,
        &spec,
        "from-stopper",
        from_session("parent", worker.run()),
    )
    .await;
    enqueue(
        &store,
        &spec,
        "from-peer",
        from_session("peer", worker.run()),
    )
    .await;
    store
        .data
        .write(store.stop_run_statement(
            worker.run(),
            FactId::new(),
            UnixMillis(2),
            StopRequester::Session {
                session_id: "parent".into(),
            },
        ))
        .await
        .unwrap();
    assert_eq!(
        resolution(&store, "from-stopper").await,
        MessageResolution::Cancelled
    );
    // Only a user Stop holds the queue; the rest stays ready to run.
    let ready: Vec<_> = store
        .queue()
        .ready(spec.owner.clone(), None, 64)
        .await
        .unwrap()
        .into_iter()
        .map(|ready| ready.entry.request.message_id)
        .collect();
    assert_eq!(ready, ["typed-by-user", "from-peer"]);
    drop(store);
    root.close().await.unwrap();
}

#[tokio::test]
async fn distinct_runs_do_not_block_and_takeover_fences_prior_claim() {
    let directory = tempfile::tempdir().unwrap();
    let (root, store) = open(directory.path(), true).await;
    let (spec1, contents1) = spec();
    let run1_admission = Admission::new(spec1.clone(), UnixMillis(1), contents1);
    let run1 = run1_admission.run();
    store.admit(run1_admission).await.unwrap();

    let mut spec2 = spec1.clone();
    spec2.session_id = "other-session".into();
    spec2.turn_id = "other-turn".into();
    spec2.trigger = Trigger::Message {
        message_id: "other-msg".into(),
    };
    let blob2 = ContentBlob::json(&"selection-2").unwrap();
    spec2.tool_selection = blob2.reference().clone();
    let run2_admission = Admission::new(spec2, UnixMillis(1), vec![blob2]);
    let run2 = run2_admission.run();
    store.admit(run2_admission).await.unwrap();

    let claim1 = store.claim(run1).await.unwrap();
    let claim2 = store.claim(run2).await.unwrap();

    // Concurrent frontier reads & appends across distinct runs succeed cleanly.
    let (r1, r2) = tokio::join!(
        async {
            let view = store.frontier(run1).await?;
            store
                .append(
                    &claim1,
                    Head::from(&view),
                    vec![Change::new(
                        Fact::StopRequested {
                            diagnostic: "r1".into(),
                            requester: StopRequester::Internal,
                        },
                        UnixMillis(2),
                    )],
                    vec![],
                )
                .await
        },
        async {
            let view = store.frontier(run2).await?;
            store
                .append(
                    &claim2,
                    Head::from(&view),
                    vec![Change::new(
                        Fact::StopRequested {
                            diagnostic: "r2".into(),
                            requester: StopRequester::Internal,
                        },
                        UnixMillis(2),
                    )],
                    vec![],
                )
                .await
        }
    );
    r1.unwrap();
    r2.unwrap();

    // Active business claim is respected by reserve_driver, and explicit claim takeover fences claim1
    // without disturbing claim2 on run2.
    assert!(
        store
            .reserve_driver(
                run1,
                crate::DriverPurpose::Business,
                tokio_util::sync::CancellationToken::new(),
            )
            .await
            .unwrap()
            .is_none()
    );
    let takeover = store.claim(run1).await.unwrap();
    let view1 = store.frontier(run1).await.unwrap();
    let fenced = store
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
        .await;
    assert!(
        fenced.is_err(),
        "stale claim1 must be fenced after takeover"
    );

    // New takeover claim on run1 and existing claim2 on run2 both remain live.
    store
        .append(
            &takeover,
            Head::from(&view1),
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
    let view2 = store.frontier(run2).await.unwrap();
    store
        .append(
            &claim2,
            Head::from(&view2),
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

    drop(store);
    root.close().await.unwrap();
}

#[tokio::test]
async fn cancelled_contested_takeover_preserves_prior_claim() {
    use std::future::Future;
    use std::task::{Context, Poll, Waker};

    let directory = tempfile::tempdir().unwrap();
    let (root, store) = open(directory.path(), true).await;
    let (spec1, contents1) = spec();
    let run1_admission = Admission::new(spec1, UnixMillis(1), contents1);
    let run1 = run1_admission.run();
    store.admit(run1_admission).await.unwrap();

    let claim1 = store.claim(run1).await.unwrap();
    let slot_read = claim1.ticket.slot.current.read().await;

    let mut pending_takeover = Box::pin(store.claim(run1));
    let mut cx = Context::from_waker(Waker::noop());
    assert!(
        matches!(pending_takeover.as_mut().poll(&mut cx), Poll::Pending),
        "takeover must wait while prior claim holds slot read lock"
    );

    // Cancel the contested takeover before releasing the read lock.
    drop(pending_takeover);
    drop(slot_read);

    // Prior claim must neither be retired nor superseded.
    assert!(
        !claim1.retirement().is_cancelled(),
        "cancelled takeover must not retire prior claim"
    );
    let view1 = store.frontier(run1).await.unwrap();
    store
        .append(
            &claim1,
            Head::from(&view1),
            vec![Change::new(
                Fact::StopRequested {
                    diagnostic: "still-current".into(),
                    requester: StopRequester::Internal,
                },
                UnixMillis(2),
            )],
            vec![],
        )
        .await
        .expect("prior claim must still own SQL writes after cancelled takeover");

    // A non-cancelled takeover must retire and fence claim1 atomically.
    let claim2 = store.claim(run1).await.unwrap();
    assert!(claim1.retirement().is_cancelled());
    let view2 = store.frontier(run1).await.unwrap();
    assert!(
        store
            .append(
                &claim1,
                Head::from(&view2),
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
            .is_err()
    );
    drop((claim1, claim2, store));
    root.close().await.unwrap();
}
