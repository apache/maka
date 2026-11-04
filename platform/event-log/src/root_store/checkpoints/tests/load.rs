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
use crate::checkpoints::{LoadOperation, LoadRequest, LoadState};
use maka_agent_ports::session::history::Position;

fn request(revision: Revision) -> LoadOperation {
    LoadOperation {
        operation: Uuid::from_u128(101),
        fingerprint: "b".repeat(64),
        revision,
    }
}
#[tokio::test]
async fn exact_load_is_idempotent_isolated_and_survives_head_move() {
    let dir = tempfile::tempdir().unwrap();
    let (store, handle, publish) = fixture(dir.path()).await;
    let head = published(&handle.publish(publish.clone()).await.unwrap());
    let input = request(head.revision);
    let (a, b) = tokio::join!(
        handle.load_exact(input.clone()),
        handle.load_exact(input.clone())
    );
    let value = a.unwrap();
    assert_eq!(b.unwrap(), value);
    assert!(matches!(value.state, LoadState::Ready { .. }));
    let source = store
        .get_session::<serde_json::Value>("source")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(source.configuration["title"], "original");
    assert_eq!(source.revision, 1);
    let mut next = publish;
    next.operation = Uuid::from_u128(102);
    next.expected_revision = Some(head.revision);
    let newer = published(&handle.publish(next).await.unwrap());
    let mut conflict = input.clone();
    conflict.revision = newer.revision;
    assert!(
        handle
            .load_exact(conflict)
            .await
            .unwrap_err()
            .to_string()
            .contains("identity conflict")
    );
    let mut stale = input.clone();
    stale.operation = Uuid::from_u128(103);
    assert!(handle.load_exact(stale.clone()).await.is_err());
    assert!(handle.load_receipt(stale).await.unwrap().is_none());
    assert_eq!(handle.load_exact(input.clone()).await.unwrap(), value);
    store.close().await.unwrap();
    let store = RootStore::open(owner(dir.path())).await.unwrap();
    let handle = store.history_checkpoints("source", scope()).await.unwrap();
    assert_eq!(
        handle.load_receipt(input.clone()).await.unwrap(),
        Some(value)
    );
    handle
        .loaded_history(input.operation, "source".into(), Position::Tail, false)
        .await
        .unwrap();
    assert!(matches!(
        handle
            .loaded_history(input.operation, "foreign".into(), Position::Tail, false)
            .await,
        Err(StoreError::SessionNotFound)
    ));
    let mut foreign = scope();
    foreign.deployment = Uuid::new_v4();
    let other = store.history_checkpoints("source", foreign).await.unwrap();
    assert!(
        other
            .loaded_history(input.operation, "source".into(), Position::Tail, false)
            .await
            .is_err()
    );
    store.close().await.unwrap();
    assert!(handle.load_receipt(input).await.is_err());
}

#[tokio::test]
async fn load_reconciles_committed_import_when_receipt_write_failed() {
    let dir = tempfile::tempdir().unwrap();
    let (store, handle, publish) = fixture(dir.path()).await;
    let head = published(&handle.publish(publish.clone()).await.unwrap());
    let input = request(head.revision);
    let log = handle.session.scoped().await.unwrap();
    log.connection.run(|db|Box::pin(async move {
        sqlx::raw_sql("CREATE TRIGGER fail_load_receipt BEFORE UPDATE ON history_checkpoint_loads BEGIN SELECT RAISE(ABORT,'lost receipt'); END;").execute(db).await?; Ok(())
    })).await.unwrap();
    assert!(
        handle
            .load_exact(input.clone())
            .await
            .unwrap_err()
            .to_string()
            .contains("lost receipt")
    );
    assert_eq!(
        handle
            .load_receipt(input.clone())
            .await
            .unwrap()
            .unwrap()
            .state,
        LoadState::Preparing
    );
    log.connection
        .run(|db| {
            Box::pin(async move {
                sqlx::query("DROP TRIGGER fail_load_receipt")
                    .execute(db)
                    .await?;
                Ok(())
            })
        })
        .await
        .unwrap();
    drop(log);
    let mut newer = publish;
    newer.operation = Uuid::new_v4();
    newer.expected_revision = Some(head.revision);
    handle.publish(newer).await.unwrap();
    store.close().await.unwrap();
    let store = RootStore::open(owner(dir.path())).await.unwrap();
    let handle = store.history_checkpoints("source", scope()).await.unwrap();
    let result = handle.load_receipt(input.clone()).await.unwrap().unwrap();
    assert_eq!(result.head, head);
    assert!(matches!(result.state, LoadState::Ready { .. }));
    assert_eq!(handle.load_exact(input).await.unwrap(), result);
    store.close().await.unwrap();
}

#[tokio::test]
async fn load_rejects_corruption_and_never_adopts_occupied_destination() {
    let dir = tempfile::tempdir().unwrap();
    let (store, handle, publish) = fixture(dir.path()).await;
    let head = published(&handle.publish(publish).await.unwrap());
    let input = request(head.revision);
    let record = LoadRequest {
        scope: scope(),
        session_id: "source".into(),
        load: input.clone(),
    };
    let objects = Objects::open(store.owned_root().unwrap()).unwrap();
    let path = objects.inspection(&record.key().unwrap(), true).unwrap();
    let occupied = EventLog::open(&path).await.unwrap();
    occupied
        .create_session("intruder", "fixture", &json!({}), 1)
        .await
        .unwrap();
    occupied.close().await.unwrap();
    assert!(
        handle
            .load_exact(input.clone())
            .await
            .unwrap_err()
            .to_string()
            .contains("occupied")
    );
    let occupied = EventLog::open(&path).await.unwrap();
    assert!(
        occupied
            .get_session::<serde_json::Value>("intruder")
            .await
            .unwrap()
            .is_some()
    );
    assert!(
        occupied
            .get_session::<serde_json::Value>("source")
            .await
            .unwrap()
            .is_none()
    );
    occupied.close().await.unwrap();
    let mut corrupt = input.clone();
    corrupt.operation = Uuid::new_v4();
    let manifest = objects.manifest(&head.manifest).unwrap();
    std::fs::write(
        dir.path()
            .join("root/history-checkpoints/objects")
            .join(&manifest.bundle().digest),
        b"corrupt",
    )
    .unwrap();
    assert!(handle.load_exact(corrupt.clone()).await.is_err());
    assert!(handle.load_receipt(corrupt).await.unwrap().is_none());
    drop(objects);
    store.close().await.unwrap();
}

#[test]
fn load_crash_child() {
    let Some(path) = std::env::var_os("MAKA_LOAD_TEST_ROOT") else {
        return;
    };
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let (store, handle, publish) = fixture(Path::new(&path)).await;
        let head = published(&handle.publish(publish).await.unwrap());
        handle.load_exact(request(head.revision)).await.unwrap();
        store.close().await.unwrap();
    });
}

#[tokio::test]
async fn load_process_death_recovers_original_target_at_each_publication_boundary() {
    for phase in ["load_prepared", "load_imported", "load_recorded"] {
        let dir = tempfile::tempdir().unwrap();
        let ready = dir.path().join("ready");
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "root_store::checkpoints::tests::load::load_crash_child",
                "--nocapture",
            ])
            .env("MAKA_LOAD_TEST_ROOT", dir.path())
            .env("MAKA_CHECKPOINT_TEST_PHASE", phase)
            .env("MAKA_CHECKPOINT_TEST_READY", &ready)
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(30);
        while !ready.exists() {
            if let Some(exit) = child.try_wait().unwrap() {
                panic!("load child exited: {exit}");
            }
            if Instant::now() > deadline {
                child.kill().unwrap();
                child.wait().unwrap();
                panic!("load child timeout {phase}");
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        child.kill().unwrap();
        child.wait().unwrap();
        let store = RootStore::open(owner(dir.path())).await.unwrap();
        let handle = store.history_checkpoints("source", scope()).await.unwrap();
        let head = handle.read_head().await.unwrap().unwrap();
        let input = request(head.revision);
        let receipt = handle.load_receipt(input.clone()).await.unwrap().unwrap();
        assert!(
            matches!(receipt.state, LoadState::Ready { .. }),
            "{phase}: {receipt:?}"
        );
        assert_eq!(handle.load_exact(input).await.unwrap(), receipt);
        store.close().await.unwrap();
    }
}
