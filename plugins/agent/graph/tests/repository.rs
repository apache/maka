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
