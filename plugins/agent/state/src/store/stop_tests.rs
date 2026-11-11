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
    message::{MessageDisposition, RootSourceMessage},
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
    scheduled: bool,
) -> PreparedRequest {
    let content = MessageInput::from(message);
    let source = ContentBlob::json(&RootSourceMessage {
        message: DeliveredMessage {
            message_id: message.into(),
            submitted_content_digest: content.content_digest().unwrap(),
            content: content.clone(),
            origin: None,
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
    spec.trigger = if scheduled {
        Trigger::Schedule {
            schedule_id: "schedule".into(),
        }
    } else {
        Trigger::Message {
            message_id: message.into(),
        }
    };
    if scheduled {
        spec.budget_basis = Some(resources.reference().clone());
    }
    let request = PreparedRequest {
        id: RequestId(format!("request-{message}")),
        message_id: message.into(),
        spec,
        source: source.reference().clone(),
        resources: resources.reference().clone(),
        required_tools: Default::default(),
    };
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
            vec![source, resources],
        )
        .await
        .unwrap();
    request
}

async fn resolution(store: &Store, message: &str) -> MessageResolution {
    store
        .queue()
        .resolve_message("stop-queue".into(), message.into())
        .await
        .unwrap()
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
    enqueue(&store, &spec, "queued-one", false).await;
    enqueue(&store, &spec, "queued-two", false).await;
    enqueue(&store, &spec, "scheduled", true).await;
    let stop = Change::new(
        Fact::StopRequested {
            diagnostic: "user_requested_stop".into(),
        },
        UnixMillis(3),
    );
    let original_cut = store.queue().read(spec.session_id.clone()).await.unwrap();
    store
        .data
        .write(StopLatest {
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
        .write(StopLatest {
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
        .write(StopLatest {
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
        resolution(&store, "queued-two").await,
        MessageResolution::Cancelled
    );
    assert_eq!(
        resolution(&store, "scheduled").await,
        MessageResolution::Pending
    );

    let later = enqueue(&store, &spec, "after-stop", false).await;
    let cut = store.queue().read(spec.session_id.clone()).await.unwrap();
    store
        .data
        .write(StopLatest {
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
    store
        .data
        .write(StopLatest {
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
    enqueue(&store, &spec, "after-terminal", false).await;
    let cut = store.queue().read(spec.session_id.clone()).await.unwrap();
    store
        .data
        .write(StopLatest {
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
