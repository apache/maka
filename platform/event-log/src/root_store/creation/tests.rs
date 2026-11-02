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
use crate::writeback::{Pending, Request, Statement};
use serde_json::json;
use std::sync::atomic::AtomicU64;
use tokio::sync::oneshot;

fn request<S: Statement>(
    log: &EventLog,
    statement: S,
) -> (Request, oneshot::Receiver<Result<S::Output, StoreError>>)
where
    Request: From<Pending<S>>,
{
    let (reply, receipt) = oneshot::channel();
    (
        Pending::new(
            statement,
            log.commits.notice(),
            reply,
            Arc::new(AtomicU64::new(0)),
        )
        .into(),
        receipt,
    )
}
async fn group(log: &EventLog, requests: Vec<Request>) {
    let count = Arc::new(AtomicU64::new(0));
    let observed = count.clone();
    log.connection
        .run(move |connection| {
            Box::pin(async move {
                connection.lock_handle().await?.set_commit_hook(move || {
                    observed.fetch_add(1, Ordering::SeqCst);
                    true
                });
                assert!(crate::writeback::commit(connection, requests, &|| Ok(())).await);
                Ok(())
            })
        })
        .await
        .unwrap();
    assert_eq!(
        count.load(Ordering::SeqCst),
        1,
        "each creation barrier shares one durable commit"
    );
}
fn reservation(id: &str, partition: usize, configuration: Value) -> WriteReservation {
    WriteReservation {
        id: id.into(),
        fingerprint: id.into(),
        partition,
        members: vec![id.into()],
        command: super::super::routes::Creation::Session {
            configuration,
            created_at: 1,
        },
    }
}

#[tokio::test]
async fn grouped_creation_barriers_isolate_rejection_and_survive_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let owner = Arc::new(
        root::RootOwner::create(
            &directory.path().join("root"),
            &root::RootNamespaces {
                ownership: directory.path().join("ownership"),
                control: directory.path().join("control"),
            },
        )
        .unwrap(),
    );
    let store = RootStore::open(owner.clone()).await.unwrap();
    let partition = super::super::partition_for(b"session", "a");
    let ids: Vec<_> = (0..1000)
        .map(|i| format!("candidate-{i}"))
        .filter(|id| super::super::partition_for(b"session", id) == partition)
        .take(2)
        .collect();
    let [bad, other] = ids.as_slice() else {
        panic!("two same-partition Session identities")
    };
    let missing = maka_agent_facts::workspace::BindingRef {
        id: uuid::Uuid::new_v4(),
        permission_epoch_at_attach: 0,
        metadata_epoch_at_attach: 0,
    };
    let rejected_configuration = json!({"workspace":missing,"boundary_revision":0});
    let (first, first_receipt) = request(
        &store.control,
        reservation("a", partition, json!({"value":1})),
    );
    let (rejected, rejected_receipt) = request(
        &store.control,
        WriteReservation {
            id: "family".into(),
            fingerprint: "family".into(),
            partition,
            members: vec!["family".into(), "a".into()],
            command: super::super::routes::Creation::Bundle {
                stage: "stage".into(),
                digest: "digest".into(),
                binding: "binding".into(),
                configurations: std::collections::BTreeMap::from([
                    ("family".into(), json!({})),
                    ("a".into(), json!({})),
                ]),
                members: vec!["family".into(), "a".into()],
            },
        },
    );
    let (second, second_receipt) = request(
        &store.control,
        reservation(bad, partition, rejected_configuration.clone()),
    );
    let (third, third_receipt) = request(
        &store.control,
        reservation(other, partition, json!({"value":3})),
    );
    group(&store.control, vec![first, rejected, second, third]).await;
    first_receipt.await.unwrap().unwrap();
    assert!(matches!(
        rejected_receipt.await.unwrap(),
        Err(StoreError::SessionConflict)
    ));
    second_receipt.await.unwrap().unwrap();
    third_receipt.await.unwrap().unwrap();

    let log = &store.partitions[partition];
    let (first, first_receipt) = request(
        log,
        WriteCreation {
            id: "a".into(),
            fingerprint: "a".into(),
            configuration: json!({"value":1}),
            now: 1,
        },
    );
    let (second, second_receipt) = request(
        log,
        WriteCreation {
            id: bad.clone(),
            fingerprint: bad.clone(),
            configuration: rejected_configuration.clone(),
            now: 1,
        },
    );
    let (third, third_receipt) = request(
        log,
        WriteCreation {
            id: other.clone(),
            fingerprint: other.clone(),
            configuration: json!({"value":3}),
            now: 1,
        },
    );
    group(log, vec![first, second, third]).await;
    first_receipt.await.unwrap().unwrap();
    assert!(matches!(
        second_receipt.await.unwrap(),
        Err(StoreError::SessionCreationRejected(
            CreationRejection::MissingWorkspaceBinding
        ))
    ));
    third_receipt.await.unwrap().unwrap();

    let (first, first_receipt) = request(
        &store.control,
        WritePublication {
            id: "a".into(),
            rejection: None,
        },
    );
    let (second, second_receipt) = request(
        &store.control,
        WritePublication {
            id: bad.clone(),
            rejection: Some(CreationRejection::MissingWorkspaceBinding),
        },
    );
    group(&store.control, vec![first, second]).await;
    first_receipt.await.unwrap().unwrap();
    second_receipt.await.unwrap().unwrap();

    // The third Session has committed but is unpublished. Recovery must retain
    // published outcomes and finish this remaining reservation from its receipt.
    store.close().await.unwrap();
    let store = RootStore::open(owner).await.unwrap();
    for (id, value) in [("a", 1), (other.as_str(), 3)] {
        assert_eq!(
            store
                .session(id)
                .await
                .unwrap()
                .get::<Value>()
                .await
                .unwrap()
                .unwrap()
                .configuration,
            json!({"value":value})
        );
    }
    assert!(matches!(
        store
            .create_session(bad, bad, &rejected_configuration, 99)
            .await,
        Err(StoreError::SessionCreationRejected(
            CreationRejection::MissingWorkspaceBinding
        ))
    ));
    assert!(matches!(
        store.session("family").await,
        Err(StoreError::SessionNotFound)
    ));
    // No partial member reservation survives the conflicting family statement.
    store
        .create_session("family", "family", &json!({}), 1)
        .await
        .unwrap();
    store.close().await.unwrap();
}
