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
use futures_util::FutureExt;
use maka_agent_facts::event::{EventWrite, Fact, Invocation, InvocationInput, RuntimeEvent};
use sqlx::Connection;

#[tokio::test]
async fn prepared_owner_reads_canonical_and_writes_only_its_attached_cache() {
    let directory = tempfile::tempdir().unwrap();
    let root = RootStore::open(owner(directory.path())).await.unwrap();
    let session = root
        .create_session("prepared", "prepared", &serde_json::json!({}), 1)
        .await
        .unwrap();
    let log = session.owner().unwrap();
    log.prepared_store()
        .unwrap()
        .run(|connection, _| {
            Box::pin(async move {
                let id: String = sqlx::query_scalar("SELECT id FROM main.session_control")
                    .fetch_one(&mut *connection)
                    .await?;
                assert_eq!(id, "prepared");
                let error = sqlx::query("UPDATE main.session_control SET updated_at=2")
                    .execute(&mut *connection)
                    .await
                    .unwrap_err();
                assert_eq!(
                    error.as_database_error().and_then(|error| error.code()).as_deref(),
                    Some("8"),
                    "canonical writes must fail with SQLITE_READONLY: {error}"
                );
                sqlx::raw_sql("CREATE TABLE prepared_cache.owner_probe(value INTEGER NOT NULL); INSERT INTO prepared_cache.owner_probe VALUES(7);")
                    .execute(&mut *connection)
                    .await?;
                Ok(())
            })
        })
        .await
        .unwrap();
    let value: i64 = log
        .prepared_store()
        .unwrap()
        .read_interruptible(|connection| {
            Box::pin(async move {
                Ok(
                    sqlx::query_scalar("SELECT value FROM prepared_cache.owner_probe")
                        .fetch_one(connection)
                        .await?,
                )
            })
        })
        .await
        .unwrap();
    assert_eq!(value, 7);
    assert_eq!(
        session
            .get::<serde_json::Value>()
            .await
            .unwrap()
            .unwrap()
            .updated_at,
        1
    );
    root.shutdown().await.unwrap();
}

#[tokio::test]
async fn prepared_transaction_does_not_block_its_canonical_partition_and_shutdown_drains_it() {
    let directory = tempfile::tempdir().unwrap();
    let root = RootStore::open(owner(directory.path())).await.unwrap();
    let session = root
        .create_session("prepared", "prepared", &serde_json::json!({}), 1)
        .await
        .unwrap();
    let log = session.owner().unwrap();
    let prepared = log.prepared_store().unwrap().clone();
    prepared
        .run(|connection, _| {
            Box::pin(async move {
                sqlx::query("CREATE TABLE prepared_cache.owner_probe(value INTEGER NOT NULL)")
                    .execute(connection)
                    .await?;
                Ok(())
            })
        })
        .await
        .unwrap();
    let (entered, started) = oneshot::channel();
    // Dropping the sender on a failed assertion also releases the real SQL owner.
    let (release, released) = oneshot::channel();
    let writer = tokio::spawn(async move {
        prepared
            .run(move |connection, _| {
                Box::pin(async move {
                    let mut transaction = connection.begin_with("BEGIN IMMEDIATE").await?;
                    let before: i64 =
                        sqlx::query_scalar("SELECT COUNT(*) FROM main.session_control")
                            .fetch_one(&mut *transaction)
                            .await?;
                    sqlx::query("INSERT INTO prepared_cache.owner_probe VALUES(9)")
                        .execute(&mut *transaction)
                        .await?;
                    let _ = entered.send(());
                    let _ = released.await;
                    let snapshot: i64 =
                        sqlx::query_scalar("SELECT COUNT(*) FROM main.session_control")
                            .fetch_one(&mut *transaction)
                            .await?;
                    assert_eq!(
                        snapshot, before,
                        "the held canonical snapshot must remain stable"
                    );
                    transaction.commit().await?;
                    Ok(())
                })
            })
            .await
    });
    tokio::time::timeout(Duration::from_secs(10), started)
        .await
        .expect("prepared transaction must enter its gate")
        .unwrap();
    let partition = partition_for(b"session", session.id());
    let peer_id = (0..)
        .map(|index| format!("same-partition-{index}"))
        .find(|id| partition_for(b"session", id) == partition)
        .unwrap();
    let peer = tokio::time::timeout(
        Duration::from_secs(10),
        root.create_session(&peer_id, &peer_id, &serde_json::json!({}), 2),
    )
    .await
    .expect("same-partition canonical creation must bypass the prepared owner")
    .unwrap();
    assert!(Arc::ptr_eq(&log, &peer.owner().unwrap()));
    let event = EventWrite::plain(RuntimeEvent::new(
        Invocation {
            session_id: peer_id.clone(),
            turn_id: "turn".into(),
            run_id: "run".into(),
            invocation_id: "invocation".into(),
        },
        Fact::InvocationOpened {
            configuration: None,
            input: InvocationInput::Message {
                content: "canonical progress".to_owned().into(),
                source_messages: vec![],
                request_fingerprint: None,
            },
        },
    ))
    .unwrap();
    let sequence = tokio::time::timeout(Duration::from_secs(10), peer.append(&event))
        .await
        .expect("same-partition canonical append must bypass the prepared owner")
        .unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        assert_eq!(peer.get::<serde_json::Value>().await.unwrap().unwrap().created_at, 2);
        let observed: (i64, String) = log.connection.read(move |connection| Box::pin(async move {
            Ok(sqlx::query_as("SELECT sequence,event_session FROM event_log WHERE kind='invocation_opened'")
                .fetch_one(connection).await?)
        })).await.unwrap();
        assert_eq!(observed.0, i64::try_from(sequence).unwrap());
        assert_eq!(observed.1, peer_id);
    }).await.expect("independent canonical readers must observe the committed facts");

    let canonical_closed = log.connection.close_receipt();
    let prepared_closed = log.prepared_store().unwrap().close_receipt();
    let independent_closed = root.control.close_receipt();
    let mut shutdown = Box::pin(root.shutdown());
    assert!(
        shutdown.as_mut().now_or_never().is_none(),
        "shutdown must wait for the accepted prepared transaction"
    );
    tokio::time::timeout(Duration::from_secs(10), independent_closed)
        .await
        .expect("shutdown must close independent owners while prepared work is blocked")
        .unwrap();
    assert!(shutdown.as_mut().now_or_never().is_none());
    assert!(prepared_closed.clone().now_or_never().is_none());
    assert!(
        root::RootOwner::open(
            &directory.path().join("root"),
            &namespaces(directory.path())
        )
        .is_err(),
        "the original Root lease must prevent reopening while its prepared owner is blocked"
    );
    release.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(10), writer)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(10), shutdown)
        .await
        .unwrap()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        canonical_closed.await.unwrap();
        prepared_closed.await.unwrap();
    })
    .await
    .expect("both original SQLite owners must acknowledge actual close");
    drop(log);
    drop(root);
    let reopened = Arc::new(
        root::RootOwner::open(
            &directory.path().join("root"),
            &namespaces(directory.path()),
        )
        .unwrap(),
    );
    let reopened = RootStore::open(reopened).await.unwrap();
    let recovered = reopened.session(&peer_id).await.unwrap();
    assert_eq!(recovered.committed_sequence().await.unwrap(), sequence);
    reopened.shutdown().await.unwrap();
}

#[tokio::test]
async fn shutdown_does_not_wait_for_prepared_observers_to_consume_completed_replies() {
    for mode in ["writer", "reader"] {
        let directory = tempfile::tempdir().unwrap();
        let root = RootStore::open(owner(directory.path())).await.unwrap();
        let session = root
            .create_session("prepared", "prepared", &serde_json::json!({}), 1)
            .await
            .unwrap();
        let log = session.owner().unwrap();
        let prepared = log.prepared_store().unwrap();
        let canonical_closed = log.connection.close_receipt();
        let prepared_closed = prepared.close_receipt();
        let (entered, started) = oneshot::channel();
        let (release, released) = oneshot::channel();
        let (finished, completed) = oneshot::channel();
        let mut observer = if mode == "writer" {
            prepared
                .run(move |connection, _| {
                    Box::pin(async move {
                        let _ = entered.send(());
                        let _ = released.await;
                        let mut transaction = connection.begin().await?;
                        sqlx::raw_sql("CREATE TABLE prepared_cache.observer_probe(value INTEGER NOT NULL); INSERT INTO prepared_cache.observer_probe VALUES(7);")
                            .execute(&mut *transaction)
                            .await?;
                        transaction.commit().await?;
                        let _ = finished.send(());
                        Ok(7_i64)
                    })
                })
                .boxed()
        } else {
            prepared
                .read_interruptible(move |connection| {
                    Box::pin(async move {
                        let count: i64 =
                            sqlx::query_scalar("SELECT COUNT(*) FROM main.session_control")
                                .fetch_one(connection)
                                .await?;
                        let _ = entered.send(());
                        let _ = released.await;
                        let _ = finished.send(());
                        Ok(count)
                    })
                })
                .boxed()
        };
        assert!(observer.as_mut().now_or_never().is_none());
        tokio::time::timeout(Duration::from_secs(10), started)
            .await
            .expect("the manually polled observer must submit its SQL job")
            .unwrap();
        release.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(10), completed)
            .await
            .expect("SQL must finish without polling its observer again")
            .unwrap();

        // Keep the observer alive and unpolled until both actual owners close.
        tokio::time::timeout(Duration::from_secs(10), root.shutdown())
            .await
            .unwrap_or_else(|_| {
                panic!("{mode} reply consumption must not retain shutdown admission")
            })
            .unwrap();
        tokio::time::timeout(Duration::from_secs(10), async {
            canonical_closed.await.unwrap();
            prepared_closed.await.unwrap();
        })
        .await
        .expect("both SQL owners must close before the observer consumes its reply");
        assert_eq!(
            observer.await.unwrap(),
            if mode == "writer" { 7 } else { 1 }
        );
        drop(log);
        drop(root);
        let reopened = Arc::new(
            root::RootOwner::open(
                &directory.path().join("root"),
                &namespaces(directory.path()),
            )
            .unwrap(),
        );
        let reopened = RootStore::open(reopened).await.unwrap();
        reopened.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn shutdown_does_not_wait_for_a_prepared_reader_that_has_not_obtained_capacity() {
    let directory = tempfile::tempdir().unwrap();
    let root = RootStore::open(owner(directory.path())).await.unwrap();
    let session = root
        .create_session("prepared", "prepared", &serde_json::json!({}), 1)
        .await
        .unwrap();
    let log = session.owner().unwrap();
    let prepared = log.prepared_store().unwrap().clone();
    let canonical_closed = log.connection.close_receipt();
    let prepared_closed = prepared.close_receipt();
    let (entered, started) = oneshot::channel();
    let (release, released) = oneshot::channel();
    let active = tokio::spawn(async move {
        prepared
            .read_interruptible(move |connection| {
                Box::pin(async move {
                    let count: i64 =
                        sqlx::query_scalar("SELECT COUNT(*) FROM main.session_control")
                            .fetch_one(connection)
                            .await?;
                    let _ = entered.send(());
                    let _ = released.await;
                    Ok(count)
                })
            })
            .await
    });
    tokio::time::timeout(Duration::from_secs(10), started)
        .await
        .expect("the first actual reader must hold its capacity before the second call")
        .unwrap();
    let prepared = log.prepared_store().unwrap();
    let mut waiting = Box::pin(prepared.read_interruptible(|connection| {
        Box::pin(async move {
            Ok(
                sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM main.session_control")
                    .fetch_one(connection)
                    .await?,
            )
        })
    }));
    assert!(waiting.as_mut().now_or_never().is_none());
    release.send(()).unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(10), active)
            .await
            .unwrap()
            .unwrap()
            .unwrap(),
        1
    );

    // The second observer stays unpolled after capacity becomes available.
    tokio::time::timeout(Duration::from_secs(10), root.shutdown())
        .await
        .expect("a capacity waiter must not count as accepted prepared work")
        .unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        canonical_closed.await.unwrap();
        prepared_closed.await.unwrap();
    })
    .await
    .expect("both actual SQL owners must close while the capacity waiter is paused");
    assert!(matches!(
        tokio::time::timeout(Duration::from_secs(10), waiting)
            .await
            .expect("the resumed capacity waiter must observe closed admission"),
        Err(StoreError::ConnectionClosed)
    ));
    drop(log);
    drop(root);
    let reopened = Arc::new(
        root::RootOwner::open(
            &directory.path().join("root"),
            &namespaces(directory.path()),
        )
        .unwrap(),
    );
    let reopened = RootStore::open(reopened).await.unwrap();
    reopened.shutdown().await.unwrap();
}

#[tokio::test]
async fn standalone_prepared_callback_panic_releases_the_cleanly_closed_writer_lease() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("standalone.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    let closed = log.close_receipt();
    let result = tokio::time::timeout(
        Duration::from_secs(10),
        log.prepared_store()
            .unwrap()
            .run::<()>(|_, _| Box::pin(async { panic!("prepared callback unwound") })),
    )
    .await
    .expect("the prepared owner must isolate the callback panic");
    assert!(matches!(result, Err(StoreError::OperationUnknown)));
    tokio::time::timeout(Duration::from_secs(10), closed)
        .await
        .expect("both standalone SQL owners must acknowledge actual close")
        .unwrap();
    // The old observer handle remains alive across reacquiring the writer lease.
    let reopened = tokio::time::timeout(Duration::from_secs(10), EventLog::open(&path))
        .await
        .expect("a cleanly closed standalone owner must permit reopening")
        .unwrap();
    tokio::time::timeout(Duration::from_secs(10), log.close())
        .await
        .unwrap()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(10), reopened.close())
        .await
        .unwrap()
        .unwrap();
}
