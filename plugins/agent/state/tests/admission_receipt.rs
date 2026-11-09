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
    durable::*,
    input::{DeliveredMessage, MessageInput},
    message::{MessageDisposition, Placement as SubmittedPlacement, RootSourceMessage},
};
use maka_agent_state::{
    Admission, AdmissionGuard,
    queue::{Consume, Placement, RequestId},
};
use maka_event_log::{
    StoreError,
    writeback::{Notification, Prepared, Statement},
};
use rusqlite::{Connection, params};
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};

struct Guard {
    calls: AtomicUsize,
    allowed: AtomicBool,
}
impl AdmissionGuard for Guard {
    fn validate(&self, _: &Connection, _: RunId, _: &RunSpec) -> Result<(), StoreError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if self.allowed.load(Ordering::SeqCst) {
            Ok(())
        } else {
            Err(StoreError::InvalidTransition(
                "policy changed after original admission".into(),
            ))
        }
    }
}

#[tokio::test]
async fn original_receipt_survives_run_progress_without_reauthorizing_or_admitting_again() {
    let directory = tempfile::tempdir().unwrap();
    let root = support::open(directory.path(), false).await;
    support::create(&root, "session").await;
    let state = support::state(&root);
    let (spec, contents) = support::spec("session", "turn", "question");
    let guard = Arc::new(Guard {
        calls: AtomicUsize::new(0),
        allowed: AtomicBool::new(true),
    });
    let admission = Admission::new(spec, UnixMillis(42), contents).with_guard(guard.clone());
    assert!(!state.admission_recorded(&admission).await.unwrap());
    let commit = state.admit(admission.clone()).await.unwrap();
    guard.allowed.store(false, Ordering::SeqCst);
    support::complete(&state, admission.run()).await;
    assert!(state.admission_recorded(&admission).await.unwrap());
    assert_eq!(guard.calls.load(Ordering::SeqCst), 1);
    let original = state
        .fact(admission.run(), admission.fact_id())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(original, commit.facts[0]);
    assert!(state.frontier(admission.run()).await.unwrap().revision > 1);
    root.close().await.unwrap();
}

#[tokio::test]
async fn spec_and_fact_metadata_conflicts_are_not_missing_receipts() {
    for kind in [
        MetadataFault::At,
        MetadataFault::Schema,
        MetadataFault::Owner,
        MetadataFault::SpecRef,
    ] {
        let directory = tempfile::tempdir().unwrap();
        let root = support::open(directory.path(), false).await;
        support::create(&root, "session").await;
        let state = support::state(&root);
        let (spec, contents) = support::spec("session", "turn", "question");
        let admission = Admission::new(spec, UnixMillis(7), contents);
        state.admit(admission.clone()).await.unwrap();
        root.data_writer()
            .unwrap()
            .write(Fault::Metadata {
                run: admission.run(),
                kind,
            })
            .await
            .unwrap();
        assert!(matches!(
            state.admission_recorded(&admission).await,
            Err(StoreError::EventConflict)
        ));
        root.close().await.unwrap();
    }
}

#[tokio::test]
async fn partial_spec_and_same_fact_uuid_in_foreign_run_are_conflicts_not_absence() {
    let directory = tempfile::tempdir().unwrap();
    let root = support::open(directory.path(), false).await;
    support::create(&root, "session").await;
    let state = support::state(&root);
    let foreign = support::admit(&state, "session", "foreign", "other").await;
    let (spec, contents) = support::spec("session", "partial", "question");
    let partial = Admission::new(spec.clone(), UnixMillis(1), contents);
    assert!(!state.admission_recorded(&partial).await.unwrap());
    root.data_writer()
        .unwrap()
        .write(Fault::PartialSpec {
            run: partial.run(),
            spec,
        })
        .await
        .unwrap();
    assert!(matches!(
        state.admission_recorded(&partial).await,
        Err(StoreError::EventConflict)
    ));
    let (spec, contents) = support::spec("session", "foreign-id", "question");
    let original = Admission::new(spec, UnixMillis(1), contents);
    root.data_writer()
        .unwrap()
        .write(Fault::ForeignFact {
            foreign,
            id: original.fact_id(),
        })
        .await
        .unwrap();
    assert!(matches!(
        state.admission_recorded(&original).await,
        Err(StoreError::EventConflict)
    ));
    root.close().await.unwrap();
}

#[tokio::test]
async fn exact_consumed_queue_cut_is_only_observed_and_omitted_or_changed_receipts_conflict() {
    let directory = tempfile::tempdir().unwrap();
    let root = support::open(directory.path(), false).await;
    support::create(&root, "session").await;
    let state = support::state(&root);
    let content = MessageInput::from("queued question");
    let source = RootSourceMessage {
        message: DeliveredMessage {
            message_id: "queued-message".into(),
            content: content.clone(),
            origin: None,
            submitted_content_digest: content.content_digest().unwrap(),
        },
        unprepared_content: content,
        submitted_placement: SubmittedPlacement::NextTurn,
        disposition: MessageDisposition::Followup,
        submitted_intent: None,
    };
    let original_source = source.clone();
    let request = support::enqueue(&state, source.clone(), vec![source], Placement::Followup).await;
    let source_ref = request.source;
    let resources_ref = request.resources;
    let input_ref = request.spec.input.clone();
    let history = state.session_history(support::owner(), "session".into());
    let old_cut = history.capture().await.unwrap();
    let queue = state.queue();
    let cut = Consume {
        session: "session".into(),
        requests: vec![request.id],
        expected_revision: queue.read("session".into()).await.unwrap().revision,
    };
    let admission = Admission::new(request.spec, UnixMillis(8), vec![]).with_queue(cut.clone());
    state.admit(admission.clone()).await.unwrap();
    let source_cut = history.capture().await.unwrap();
    let source_sequence = history
        .run_source(admission.run())
        .await
        .unwrap()
        .admission_sequence;
    let (spec, contents) = support::spec("session", "not-queued", "another question");
    let not_queued = Admission::new(spec, UnixMillis(9), contents);
    state.admit(not_queued.clone()).await.unwrap();
    let after = queue.read("session".into()).await.unwrap();
    assert!(after.entries.is_empty());
    assert!(state.admission_recorded(&admission).await.unwrap());
    assert_eq!(queue.read("session".into()).await.unwrap(), after);
    let mut changed = cut.clone();
    changed.requests = vec![RequestId("another-message".into())];
    assert!(matches!(
        state
            .admission_recorded(&admission.clone().with_queue(changed))
            .await,
        Err(StoreError::EventConflict)
    ));
    let mut changed = cut;
    changed.expected_revision += 1;
    assert!(matches!(
        state
            .admission_recorded(&admission.clone().with_queue(changed))
            .await,
        Err(StoreError::EventConflict)
    ));
    assert!(matches!(
        history
            .with_content(&source_cut, admission.run(), &source_ref, |_| Ok(()))
            .await,
        Err(StoreError::InvalidTransition(_))
    ));
    let live = maka_agent_state::session_history::source_tree::HistoryDataSource::Live {
        history: history.clone(),
        cut: source_cut.clone(),
    };
    let decoded = live
        .with_source::<RootSourceMessage>(source_sequence, 0, &source_ref, |reader| {
            serde_json::from_reader(std::io::BufReader::new(reader)).map_err(StoreError::Json)
        })
        .await;
    let Ok(decoded) = decoded else {
        panic!("original queued source read failed");
    };
    assert!(decoded == original_source, "original queued source changed");
    let resources = live
        .with_source::<Vec<String>>(source_sequence, 0, &resources_ref, |reader| {
            serde_json::from_reader(std::io::BufReader::new(reader)).map_err(StoreError::Json)
        })
        .await;
    let Ok(resources) = resources else {
        panic!("original queued resources read failed");
    };
    assert!(resources.is_empty());
    assert!(matches!(
        live.with_source(source_sequence, 1, &source_ref, |_| Ok(()))
            .await,
        Err(StoreError::InvalidTransition(_))
    ));
    assert!(matches!(
        live.with_source(source_sequence, 0, &input_ref, |_| Ok(()))
            .await,
        Err(StoreError::InvalidTransition(_))
    ));
    let other = maka_agent_state::session_history::source_tree::HistoryDataSource::Live {
        history: state.session_history(support::owner(), "other".into()),
        cut: source_cut,
    };
    assert!(matches!(
        other
            .with_source(source_sequence, 0, &source_ref, |_| Ok(()))
            .await,
        Err(StoreError::InvalidTransition(_))
    ));
    let old = maka_agent_state::session_history::source_tree::HistoryDataSource::Live {
        history,
        cut: old_cut,
    };
    assert!(matches!(
        old.with_source(source_sequence, 0, &source_ref, |_| Ok(()))
            .await,
        Err(StoreError::InvalidTransition(_))
    ));
    root.data_writer()
        .unwrap()
        .write(Fault::ConsumedFootprint {
            source: admission.fact_id(),
            target: not_queued.fact_id(),
        })
        .await
        .unwrap();
    assert!(matches!(
        state.admission_recorded(&not_queued).await,
        Err(StoreError::EventConflict)
    ));
    root.data_writer()
        .unwrap()
        .write(Fault::QueueAt(admission.fact_id()))
        .await
        .unwrap();
    assert!(matches!(
        state.admission_recorded(&admission).await,
        Err(StoreError::EventConflict)
    ));
    root.close().await.unwrap();
}

enum MetadataFault {
    At,
    Schema,
    Owner,
    SpecRef,
}
// These deliberate corrupt/partial rows are negative read-boundary inputs,
// never an alternative admission, execution grant or Root receipt implementation.
enum Fault {
    Metadata { run: RunId, kind: MetadataFault },
    PartialSpec { run: RunId, spec: RunSpec },
    ForeignFact { foreign: RunId, id: FactId },
    QueueAt(FactId),
    ConsumedFootprint { source: FactId, target: FactId },
}
impl Statement for Fault {
    type Value = ();
    type Output = ();
    fn execute(self, c: &Connection) -> Result<Prepared<()>, StoreError> {
        match self {
            Self::Metadata { run, kind } => {
                match kind {
                    MetadataFault::At => {
                        c.execute(
                            "UPDATE agent_facts SET at=at+1 WHERE run=? AND revision=1",
                            [run.to_string()],
                        )?;
                    }
                    MetadataFault::Schema => {
                        c.execute("UPDATE agent_run_specs SET schema_version=schema_version+1 WHERE run=?",[run.to_string()])?;
                    }
                    MetadataFault::Owner => {
                        let mut owner = support::owner();
                        owner.deployment = uuid::Uuid::from_u128(999);
                        c.execute(
                            "UPDATE agent_run_specs SET owner=? WHERE run=?",
                            params![serde_json::to_string(&owner)?, run.to_string()],
                        )?;
                    }
                    MetadataFault::SpecRef => {
                        c.execute("UPDATE agent_run_specs SET spec_content_id=(SELECT body_content_id FROM agent_facts WHERE run=?1 AND revision=1) WHERE run=?1",[run.to_string()])?;
                    }
                }
            }
            Self::PartialSpec { run, spec } => {
                let bytes = serde_json::to_vec(&spec)?;
                let content = maka_event_log::content::put(
                    c,
                    &maka_agent_facts::artifact::content_digest(&bytes),
                    &bytes,
                )?;
                c.execute("INSERT INTO agent_run_specs(run,schema_version,owner,session,spec_content_id) VALUES(?,?,?,?,?)",params![run.to_string(),SCHEMA_VERSION,serde_json::to_string(&spec.owner)?,spec.session_id,content])?;
            }
            Self::ForeignFact { foreign, id } => {
                c.execute("INSERT INTO agent_facts(id,run,revision,schema_version,at,body_content_id) SELECT ?1,run,2,schema_version,at,body_content_id FROM agent_facts WHERE run=?2 AND revision=1",params![id.to_string(),foreign.to_string()])?;
            }
            Self::QueueAt(id) => {
                c.execute(
                    "UPDATE agent_queue_events SET at=at+1 WHERE session='session' AND id=?",
                    [id.to_string()],
                )?;
            }
            Self::ConsumedFootprint { source, target } => {
                c.execute("INSERT INTO agent_queue_events(session,revision,id,at,body_content_id) SELECT session,(SELECT MAX(revision)+1 FROM agent_queue_events WHERE session='session'),?1,at,body_content_id FROM agent_queue_events WHERE session='session' AND id=?2",params![target.to_string(),source.to_string()])?;
            }
        }
        Ok(Prepared {
            value: (),
            changed: true,
            notification: Notification::METADATA,
        })
    }
    fn committed(_: ()) {}
    fn isolated_rejection(_: &StoreError) -> bool {
        false
    }
}

fn queued_request(
    session: &str,
    message: &str,
) -> (
    maka_agent_state::queue::PreparedRequest,
    Vec<maka_agent_state::ContentBlob>,
) {
    use maka_agent_facts::input::RunInput;
    use maka_agent_state::{ContentBlob, queue::PreparedRequest};
    let content = MessageInput::from(format!("question for {session}"));
    let source = RootSourceMessage {
        message: DeliveredMessage {
            message_id: message.into(),
            content: content.clone(),
            origin: None,
            submitted_content_digest: content.content_digest().unwrap(),
        },
        unprepared_content: content.clone(),
        submitted_placement: SubmittedPlacement::NextTurn,
        disposition: MessageDisposition::Followup,
        submitted_intent: None,
    };
    let input = ContentBlob::json(&RunInput::Message {
        content,
        request_fingerprint: None,
        source_messages: vec![source.clone()],
    })
    .unwrap();
    let (mut spec, mut contents) = support::spec(session, "queued-turn", "");
    let old_input = spec.input.clone();
    contents.retain(|blob| blob.reference() != &old_input);
    spec.input = input.reference().clone();
    spec.trigger = Trigger::Message {
        message_id: message.into(),
    };
    let source = ContentBlob::json(&source).unwrap();
    let resources = ContentBlob::json(&Vec::<String>::new()).unwrap();
    let request = PreparedRequest {
        id: RequestId(message.into()),
        message_id: message.into(),
        spec,
        source: source.reference().clone(),
        resources: resources.reference().clone(),
        required_tools: Default::default(),
    };
    contents.extend([input, source, resources]);
    (request, contents)
}

struct QueueFacts(String);

#[tokio::test]
async fn queued_goal_keeps_original_message_and_requires_matching_source_and_budget() {
    use maka_agent_facts::{input::RunInput, message::MessageOrigin};
    use maka_agent_state::{
        ContentBlob, Head,
        queue::{QueueCommand, QueueEdit},
    };

    let directory = tempfile::tempdir().unwrap();
    let root = support::open(directory.path(), false).await;
    support::create(&root, "session").await;
    let state = support::state(&root);
    let queue = state.queue();
    let (mut request, mut contents) = queued_request("session", "original-goal-message");
    let mut wrong_message = request.clone();
    wrong_message.spec.trigger = Trigger::Message {
        message_id: "different-message".into(),
    };
    let goal_id = uuid::Uuid::new_v4();
    let content = MessageInput::from("question for session");
    let source = RootSourceMessage {
        message: DeliveredMessage {
            message_id: request.message_id.clone(),
            content: content.clone(),
            origin: Some(MessageOrigin::Goal {
                goal_id: goal_id.to_string(),
                objective: "queue structure only".into(),
            }),
            submitted_content_digest: content.content_digest().unwrap(),
        },
        unprepared_content: content.clone(),
        submitted_placement: SubmittedPlacement::CurrentTurn,
        disposition: MessageDisposition::TurnStarted,
        submitted_intent: None,
    };
    let input = ContentBlob::json(&RunInput::Message {
        content,
        request_fingerprint: None,
        source_messages: vec![source.clone()],
    })
    .unwrap();
    let source = ContentBlob::json(&source).unwrap();
    // Queue retains opaque provenance; real budget authority is checked by Native at admission.
    let budget = ContentBlob::json(&"queue-only budget provenance").unwrap();
    request.source = source.reference().clone();
    request.spec.input = input.reference().clone();
    request.spec.trigger = Trigger::Goal { goal_id };
    request.spec.budget_basis = Some(budget.reference().clone());
    contents.extend([source, input, budget]);
    let mut wrong_goal = request.clone();
    wrong_goal.spec.trigger = Trigger::Goal {
        goal_id: uuid::Uuid::new_v4(),
    };
    let mut missing_budget = request.clone();
    missing_budget.spec.budget_basis = None;
    for invalid in [wrong_message, wrong_goal, missing_budget] {
        let error = queue
            .execute(
                "session".into(),
                QueueCommand {
                    id: FactId::new(),
                    at: UnixMillis(2),
                    expected_revision: 0,
                    edit: QueueEdit::Enqueue {
                        request: Box::new(invalid),
                        placement: Placement::Followup,
                    },
                },
                contents.clone(),
            )
            .await
            .unwrap_err();
        assert!(
            matches!(error.underlying(), StoreError::InvalidTransition(diagnostic)
            if diagnostic == "queue RunSpec trigger differs from original message"),
            "{error:?}"
        );
    }
    assert_eq!(queue.read("session".into()).await.unwrap().revision, 0);
    let steering = queue
        .execute(
            "session".into(),
            QueueCommand {
                id: FactId::new(),
                at: UnixMillis(2),
                expected_revision: 0,
                edit: QueueEdit::Enqueue {
                    request: Box::new(request.clone()),
                    placement: Placement::Steering {
                        run: RunId::new(),
                        expected_head: Head {
                            revision: 0,
                            control_version: 0,
                        },
                    },
                },
            },
            contents.clone(),
        )
        .await
        .unwrap_err();
    assert!(
        matches!(steering.underlying(), StoreError::InvalidTransition(diagnostic)
        if diagnostic == "only interactive queue messages can be steered or edited"),
        "{steering:?}"
    );
    assert_eq!(queue.read("session".into()).await.unwrap().revision, 0);
    let committed = queue
        .execute(
            "session".into(),
            QueueCommand {
                id: FactId::new(),
                at: UnixMillis(2),
                expected_revision: 0,
                edit: QueueEdit::Enqueue {
                    request: Box::new(request.clone()),
                    placement: Placement::Followup,
                },
            },
            contents,
        )
        .await
        .unwrap();
    assert_eq!(committed.revision, 1);
    let queued = queue.read("session".into()).await.unwrap();
    assert_eq!(queued.entries.len(), 1);
    assert_eq!(queued.entries[0].request, request);
    let edit = queue
        .execute(
            "session".into(),
            QueueCommand {
                id: FactId::new(),
                at: UnixMillis(3),
                expected_revision: 1,
                edit: QueueEdit::Update {
                    request: Box::new(request),
                },
            },
            vec![],
        )
        .await
        .unwrap_err();
    assert!(
        matches!(edit.underlying(), StoreError::InvalidTransition(diagnostic)
        if diagnostic == "only interactive queue messages can be steered or edited"),
        "{edit:?}"
    );
    assert_eq!(queue.read("session".into()).await.unwrap(), queued);
    root.close().await.unwrap();
}

impl maka_event_log::connection::Query for QueueFacts {
    type Output = Vec<(i64, String, i64, String, Vec<u8>)>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        Ok(c.prepare("SELECT e.revision,e.id,e.at,b.content_sha256,b.payload FROM agent_queue_events e JOIN contents b ON b.id=e.body_content_id WHERE e.session=? ORDER BY e.revision")?
            .query_map([self.0], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)))?
            .collect::<Result<_, _>>()?)
    }
}

#[tokio::test]
async fn accepted_queue_identity_is_session_qualified_and_not_a_canonical_run_receipt() {
    use maka_agent_state::queue::{MessageResolution, QueueCommand, QueueEdit};

    let directory = tempfile::tempdir().unwrap();
    let root = support::open(directory.path(), false).await;
    for session in ["session", "other"] {
        support::create(&root, session).await;
    }
    let state = support::state(&root);
    let queue = state.queue();
    let (request, contents) = queued_request("session", "shared-raw-id");
    let command = QueueCommand {
        id: FactId::new(),
        at: UnixMillis(2),
        expected_revision: 0,
        edit: QueueEdit::Enqueue {
            request: Box::new(request.clone()),
            placement: Placement::Followup,
        },
    };
    drop(queue.prepare("session".into(), command.clone(), contents.clone()));
    assert_eq!(queue.read("session".into()).await.unwrap().revision, 0);
    assert!(
        queue
            .read("session".into())
            .await
            .unwrap()
            .entries
            .is_empty()
    );
    assert_eq!(
        queue
            .resolve_message("session".into(), request.message_id.clone())
            .await
            .unwrap(),
        MessageResolution::Missing
    );
    assert!(
        root.data_writer()
            .unwrap()
            .query(QueueFacts("session".into()))
            .await
            .unwrap()
            .is_empty()
    );

    let original_commit = queue
        .execute("session".into(), command.clone(), contents)
        .await
        .unwrap();
    let before = queue.read("session".into()).await.unwrap();
    assert_eq!(original_commit.revision, 1);
    assert_eq!(before.entries.len(), 1);
    assert_eq!(before.entries[0].request, request);
    let original_facts = root
        .data_writer()
        .unwrap()
        .query(QueueFacts("session".into()))
        .await
        .unwrap();
    let source_bytes = queue
        .content("session".into(), request.id.clone(), request.source.clone())
        .await
        .unwrap();
    let input_bytes = queue
        .content(
            "session".into(),
            request.id.clone(),
            request.spec.input.clone(),
        )
        .await
        .unwrap();
    let cut = Consume {
        session: "session".into(),
        requests: vec![request.id.clone()],
        expected_revision: 0,
    };
    let stale = Admission::new(request.spec.clone(), UnixMillis(8), vec![]).with_queue(cut.clone());
    assert!(!state.admission_recorded(&stale).await.unwrap());
    assert!(state.find_run(stale.run()).await.unwrap().is_none());
    assert_eq!(
        queue
            .resolve_message("session".into(), request.message_id.clone())
            .await
            .unwrap(),
        MessageResolution::Pending
    );
    assert_eq!(
        queue
            .execute("session".into(), command.clone(), vec![])
            .await
            .unwrap(),
        original_commit
    );
    assert_eq!(queue.read("session".into()).await.unwrap(), before);

    let (other, other_contents) = queued_request("other", &request.message_id);
    assert_eq!(other.id, request.id);
    let other_command = QueueCommand {
        edit: QueueEdit::Enqueue {
            request: Box::new(other.clone()),
            placement: Placement::Followup,
        },
        ..command.clone()
    };
    let other_commit = queue
        .execute("other".into(), other_command.clone(), other_contents)
        .await
        .unwrap();
    assert_eq!(other_commit, original_commit);
    let other_before = queue.read("other".into()).await.unwrap();
    assert_eq!(other_before.entries[0].request, other);
    let other_source_bytes = queue
        .content("other".into(), other.id.clone(), other.source.clone())
        .await
        .unwrap();
    let wrong_scope = QueueCommand {
        id: FactId::new(),
        expected_revision: before.revision,
        ..other_command.clone()
    };
    assert!(
        matches!(queue.execute("session".into(), wrong_scope, vec![]).await,
        Err(StoreError::InvalidTransition(reason)) if reason == "queue request is not a local request for this session/schema")
    );
    let mut duplicate = request.clone();
    duplicate.id = RequestId("another-request-for-the-same-message".into());
    assert!(matches!(
        queue
            .execute(
                "session".into(),
                QueueCommand {
                    id: FactId::new(),
                    at: UnixMillis(3),
                    expected_revision: before.revision,
                    edit: QueueEdit::Enqueue {
                        request: Box::new(duplicate),
                        placement: Placement::Followup
                    },
                },
                vec![]
            )
            .await,
        Err(StoreError::EventConflict)
    ));
    assert!(matches!(state.admit(stale.clone()).await,
        Err(StoreError::RevisionConflict { expected, actual }) if expected == "0" && actual == "1"));
    assert!(!state.admission_recorded(&stale).await.unwrap());
    assert!(state.find_run(stale.run()).await.unwrap().is_none());
    assert!(state.history(stale.run(), 0, 32).await.unwrap().is_empty());
    assert_eq!(queue.read("session".into()).await.unwrap(), before);
    assert_eq!(queue.read("other".into()).await.unwrap(), other_before);
    assert_eq!(
        root.data_writer()
            .unwrap()
            .query(QueueFacts("session".into()))
            .await
            .unwrap(),
        original_facts
    );
    assert_eq!(
        queue
            .content("session".into(), request.id.clone(), request.source.clone())
            .await
            .unwrap(),
        source_bytes
    );

    let admitted = stale.clone().with_queue(Consume {
        expected_revision: before.revision,
        ..cut
    });
    assert_eq!(admitted.run(), stale.run());
    assert_eq!(admitted.fact_id(), stale.fact_id());
    let committed = state.admit(admitted.clone()).await.unwrap();
    assert!(state.admission_recorded(&admitted).await.unwrap());
    assert_eq!(
        queue
            .resolve_message("session".into(), request.message_id.clone())
            .await
            .unwrap(),
        MessageResolution::Delivered {
            run: admitted.run(),
            shared: false
        }
    );
    assert_eq!(
        queue
            .execute("session".into(), command.clone(), vec![])
            .await
            .unwrap(),
        original_commit
    );
    assert_eq!(
        queue
            .execute("other".into(), other_command.clone(), vec![])
            .await
            .unwrap(),
        other_commit
    );
    support::complete(&state, admitted.run()).await;
    let history = state.history(admitted.run(), 0, 32).await.unwrap();
    let delivered = queue.read("session".into()).await.unwrap();
    let delivered_facts = root
        .data_writer()
        .unwrap()
        .query(QueueFacts("session".into()))
        .await
        .unwrap();
    let other_facts = root
        .data_writer()
        .unwrap()
        .query(QueueFacts("other".into()))
        .await
        .unwrap();
    assert!(delivered.entries.is_empty());
    assert_eq!(delivered.revision, before.revision + 1);
    assert_eq!(delivered_facts.len(), 2);
    assert_eq!(delivered_facts[0], original_facts[0]);
    assert_eq!(delivered_facts[1].1, admitted.fact_id().to_string());
    root.close().await.unwrap();

    let root = support::open(directory.path(), true).await;
    let state = support::state(&root);
    let queue = state.queue();
    state.rebuild(admitted.run()).await.unwrap();
    queue.rebuild("session".into()).await.unwrap();
    queue.rebuild("other".into()).await.unwrap();
    assert!(state.admission_recorded(&admitted).await.unwrap());
    assert_eq!(
        state
            .fact(admitted.run(), admitted.fact_id())
            .await
            .unwrap(),
        Some(committed.facts[0].clone())
    );
    assert_eq!(state.history(admitted.run(), 0, 32).await.unwrap(), history);
    assert_eq!(queue.read("session".into()).await.unwrap(), delivered);
    assert_eq!(
        queue
            .entry("session".into(), request.id.clone())
            .await
            .unwrap(),
        Some(before.entries[0].clone())
    );
    assert_eq!(
        queue
            .resolve_message("session".into(), request.message_id.clone())
            .await
            .unwrap(),
        MessageResolution::Delivered {
            run: admitted.run(),
            shared: false
        }
    );
    assert_eq!(queue.read("other".into()).await.unwrap(), other_before);
    assert_eq!(
        root.data_writer()
            .unwrap()
            .query(QueueFacts("session".into()))
            .await
            .unwrap(),
        delivered_facts
    );
    assert_eq!(
        root.data_writer()
            .unwrap()
            .query(QueueFacts("other".into()))
            .await
            .unwrap(),
        other_facts
    );
    assert_eq!(
        queue
            .content("session".into(), request.id.clone(), request.source.clone())
            .await
            .unwrap(),
        source_bytes
    );
    assert_eq!(
        queue
            .content("other".into(), other.id.clone(), other.source.clone())
            .await
            .unwrap(),
        other_source_bytes
    );
    assert_eq!(
        state
            .content(admitted.run(), request.spec.input)
            .await
            .unwrap(),
        input_bytes
    );
    assert_eq!(
        queue
            .execute("session".into(), command, vec![])
            .await
            .unwrap(),
        original_commit
    );
    assert_eq!(
        queue
            .execute("other".into(), other_command, vec![])
            .await
            .unwrap(),
        other_commit
    );
    root.close().await.unwrap();
}

#[tokio::test]
async fn steering_prefix_and_consumed_queue_identity_roll_back_on_a_later_attempt_conflict() {
    use maka_agent_state::{
        Change, Head,
        queue::{MessageResolution, QueueCommand, QueueEdit, SteeringTarget},
    };

    let directory = tempfile::tempdir().unwrap();
    let root = support::open(directory.path(), false).await;
    support::create(&root, "session").await;
    let state = support::state(&root);
    let foreign = support::admit(&state, "session", "registered-attempt", "other actual run").await;
    let (foreign_step, foreign_request, foreign_contents) = support::request(vec![]);
    let registered = ModelAttemptId::new();
    support::append(
        &state,
        foreign,
        vec![
            Fact::StepPrepared {
                step: foreign_step,
                request: foreign_request.reference().clone(),
                adjudications: vec![],
            },
            Fact::ModelAttemptPrepared {
                attempt: registered,
                step: foreign_step,
            },
        ],
        foreign_contents,
    )
    .await;
    let foreign_history = state.history(foreign, 0, 32).await.unwrap();
    let run = support::admit(&state, "session", "steering-target", "active question").await;
    let claim = state.claim(run).await.unwrap();
    let before = state.driver_frontier(&claim).await.unwrap();
    let queue = state.queue();
    let (request, request_contents) = queued_request("session", "actual-steering-source");
    let command = QueueCommand {
        id: FactId::new(),
        at: UnixMillis(2),
        expected_revision: 0,
        edit: QueueEdit::Enqueue {
            request: Box::new(request.clone()),
            placement: Placement::Followup,
        },
    };
    let original_receipt = queue
        .execute("session".into(), command.clone(), request_contents)
        .await
        .unwrap();
    queue
        .execute(
            "session".into(),
            QueueCommand {
                id: FactId::new(),
                at: UnixMillis(2),
                expected_revision: original_receipt.revision,
                edit: QueueEdit::Promote {
                    request: request.id.clone(),
                    target: SteeringTarget {
                        run,
                        expected_head: Head::from(&before),
                    },
                },
            },
            vec![],
        )
        .await
        .unwrap();
    let queued = queue.read("session".into()).await.unwrap();
    let queued_facts = root
        .data_writer()
        .unwrap()
        .query(QueueFacts("session".into()))
        .await
        .unwrap();
    let source_bytes = queue
        .content("session".into(), request.id.clone(), request.source.clone())
        .await
        .unwrap();
    let canonical_before = state.history(run, 0, 32).await.unwrap();
    let (step, frozen, contents) = support::request(vec![request.source.clone()]);
    let prefix = Change::new(
        Fact::StepPrepared {
            step,
            request: frozen.reference().clone(),
            adjudications: vec![],
        },
        UnixMillis(3),
    );
    // Attempt registration is checked after this StepPrepared has consumed the cut;
    // a reused FactId would instead be rejected by the whole-batch preflight.
    let conflicting = Change::new(
        Fact::ModelAttemptPrepared {
            attempt: registered,
            step,
        },
        UnixMillis(3),
    );
    let cut = Consume {
        session: "session".into(),
        requests: vec![request.id.clone()],
        expected_revision: queued.revision,
    };
    let rejected = state
        .append_steering(
            &claim,
            Head::from(&before),
            vec![prefix.clone(), conflicting.clone()],
            contents.clone(),
            cut.clone(),
        )
        .await;
    assert!(matches!(rejected, Err(StoreError::EventConflict)));
    assert_eq!(
        Head::from(&state.driver_frontier(&claim).await.unwrap()),
        Head::from(&before)
    );
    assert_eq!(state.history(run, 0, 32).await.unwrap(), canonical_before);
    assert_eq!(
        state.history(foreign, 0, 32).await.unwrap(),
        foreign_history
    );
    assert!(state.fact(run, prefix.id).await.unwrap().is_none());
    assert!(state.fact(run, conflicting.id).await.unwrap().is_none());
    let missing = state.request(run, step).await.unwrap_err();
    assert!(matches!(
        missing.underlying(),
        StoreError::Sqlite(rusqlite::Error::QueryReturnedNoRows)
    ));
    assert_eq!(queue.read("session".into()).await.unwrap(), queued);
    assert_eq!(
        root.data_writer()
            .unwrap()
            .query(QueueFacts("session".into()))
            .await
            .unwrap(),
        queued_facts
    );
    assert_eq!(
        queue
            .resolve_message("session".into(), request.message_id.clone())
            .await
            .unwrap(),
        MessageResolution::Pending
    );
    assert_eq!(
        queue
            .content("session".into(), request.id.clone(), request.source.clone())
            .await
            .unwrap(),
        source_bytes
    );
    assert_eq!(
        queue
            .execute("session".into(), command, vec![])
            .await
            .unwrap(),
        original_receipt
    );

    let fresh = ModelAttemptId::new();
    let committed = state
        .append_steering(
            &claim,
            Head::from(&before),
            vec![
                prefix.clone(),
                Change::new(
                    Fact::ModelAttemptPrepared {
                        attempt: fresh,
                        step,
                    },
                    UnixMillis(3),
                ),
            ],
            contents,
            cut,
        )
        .await
        .unwrap();
    assert_eq!(committed.facts[0].id, prefix.id);
    assert_eq!(committed.head.revision, before.revision + 2);
    assert_eq!(
        state.request(run, step).await.unwrap().steering,
        vec![request.source]
    );
    assert_eq!(
        queue
            .resolve_message("session".into(), request.message_id)
            .await
            .unwrap(),
        MessageResolution::Delivered { run, shared: true }
    );
    assert_eq!(
        queue.read("session".into()).await.unwrap().revision,
        queued.revision + 1
    );
    assert_eq!(
        state.history(foreign, 0, 32).await.unwrap(),
        foreign_history
    );
    root.close().await.unwrap();
}
