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
use crate::connection::ReaderRole;
use crate::connection::{ConnectionAuthority, OwnedConnection};
use sqlx::{Connection, Row, sqlite::SqliteConnectOptions};
use std::{sync::Arc, time::Duration};
use tokio::sync::{Semaphore, oneshot};

async fn control(path: &Path) -> SqliteConnection {
    let mut connection = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true),
    )
    .await
    .unwrap();
    sqlx::raw_sql("PRAGMA journal_mode=WAL;
        CREATE TABLE application_sources(deployment TEXT NOT NULL,revision INTEGER NOT NULL,input_json TEXT NOT NULL,remote_exports_json TEXT NOT NULL,PRIMARY KEY(deployment,revision));
        CREATE TABLE workspace_bindings(id TEXT PRIMARY KEY,owner_scope TEXT,selection_digest TEXT,workspace_json TEXT,permission_epoch INTEGER,metadata_epoch INTEGER);
        CREATE INDEX workspace_bindings_path ON workspace_bindings(json_extract(workspace_json,'$.path'),id);
        CREATE INDEX workspace_bindings_project ON workspace_bindings(owner_scope,json_extract(workspace_json,'$.projectId'),id);
        INSERT INTO workspace_bindings VALUES('control-binding','owner','digest','{\"path\":\"/workspace\",\"projectId\":\"project\"}',1,2);")
        .execute(&mut connection).await.unwrap();
    connection
}

async fn partition(path: &Path, control: ReadOnlyControl) -> OwnedConnection {
    let lease = Arc::new(crate::root::FileLease::acquire(&path.with_extension("lock")).unwrap());
    let initialize_control = control.clone();
    OwnedConnection::open_with_cache(
        SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true),
        ConnectionAuthority::Writer { lease, root: None },
        move |connection| {
            Box::pin(async move {
                // The real schema initializer performs the attachment after migrations
                // but before rebuilding derived Session execution state.
                crate::schema::initialize_connection_with_control(
                    connection,
                    Some(&initialize_control),
                )
                .await
            })
        },
        None,
        Some(control),
    )
    .await
    .unwrap()
}

async fn verify(connection: &mut SqliteConnection) -> Result<(), StoreError> {
    let id: String = sqlx::query_scalar("SELECT id FROM workspace_bindings")
        .fetch_one(&mut *connection)
        .await?;
    assert_eq!(id, "control-binding");
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM main.workspace_bindings")
        .fetch_one(&mut *connection)
        .await?;
    assert_eq!(count, 0, "bindings must not be copied into data partitions");
    let readonly = {
        let mut handle = connection.lock_handle().await?;
        unsafe {
            rusqlite::ffi::sqlite3_db_readonly(
                handle.as_raw_handle().as_ptr(),
                c"root_control".as_ptr(),
            )
        }
    };
    assert_eq!(readonly, 1);
    let error = sqlx::query("UPDATE root_control.workspace_bindings SET permission_epoch=999")
        .execute(&mut *connection)
        .await
        .unwrap_err();
    assert_eq!(
        error.as_database_error().unwrap().code().as_deref(),
        Some("8")
    );
    assert!(
        sqlx::query("UPDATE workspace_bindings SET permission_epoch=999")
            .execute(&mut *connection)
            .await
            .is_err()
    );
    Ok(())
}

#[tokio::test]
async fn writer_and_both_readers_resolve_live_readonly_control_and_indexes() {
    let directory = tempfile::tempdir().unwrap();
    // Reserved URI characters must remain filename bytes.
    let path = directory.path().join("control ?mode=rw#%.sqlite");
    let mut control_connection = control(&path).await;
    let owner = Arc::new(
        partition(
            &directory.path().join("partition.sqlite"),
            ReadOnlyControl::new(&path).unwrap(),
        )
        .await,
    );
    owner
        .run(|connection| Box::pin(verify(connection)))
        .await
        .unwrap();
    let entered = Arc::new(Semaphore::new(0));
    let release = Arc::new(Semaphore::new(0));
    let mut readers = Vec::new();
    for role in [ReaderRole::Read, ReaderRole::Observation] {
        let owner = owner.clone();
        let entered = entered.clone();
        let release = release.clone();
        readers.push(tokio::spawn(async move {
            owner
                .read_job(
                    role,
                    move |connection| {
                        Box::pin(async move {
                            verify(connection).await?;
                            entered.add_permits(1);
                            release.acquire().await.unwrap().forget();
                            Ok(())
                        })
                    },
                    false,
                )
                .await
        }));
    }
    tokio::time::timeout(Duration::from_secs(5), entered.acquire_many(2))
        .await
        .unwrap()
        .unwrap()
        .forget();
    release.add_permits(2);
    for reader in readers {
        reader.await.unwrap().unwrap();
    }
    sqlx::query("UPDATE workspace_bindings SET permission_epoch=3")
        .execute(&mut control_connection)
        .await
        .unwrap();
    owner.run(|connection| Box::pin(async move {
        let epoch: i64 = sqlx::query_scalar("SELECT permission_epoch FROM workspace_bindings").fetch_one(&mut *connection).await?;
        assert_eq!(epoch, 3, "attachment is live, not immutable");
        for (sql, expected) in [
            ("EXPLAIN QUERY PLAN SELECT id FROM workspace_bindings WHERE json_extract(workspace_json,'$.path')='/workspace'", "workspace_bindings_path"),
            ("EXPLAIN QUERY PLAN SELECT id FROM workspace_bindings WHERE owner_scope='owner' AND json_extract(workspace_json,'$.projectId')='project'", "workspace_bindings_project"),
        ] {
            let rows = sqlx::query(sql).fetch_all(&mut *connection).await?;
            let details: Vec<String> = rows.iter().map(|row| row.get("detail")).collect();
            assert!(details.iter().any(|detail| detail.contains(expected)), "{details:?}");
        }
        Ok(())
    })).await.unwrap();
    owner
        .read(|connection| {
            Box::pin(async move {
                let epoch: i64 =
                    sqlx::query_scalar("SELECT permission_epoch FROM workspace_bindings")
                        .fetch_one(connection)
                        .await?;
                assert_eq!(epoch, 3);
                Ok(())
            })
        })
        .await
        .unwrap();
    owner.shutdown().await.unwrap();
    control_connection.close().await.unwrap();
}

#[tokio::test]
async fn two_partition_immediate_transactions_do_not_lock_control_writer() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("control.sqlite");
    let mut control_connection = control(&path).await;
    let attachment = ReadOnlyControl::new(&path).unwrap();
    let first = Arc::new(partition(&directory.path().join("a.sqlite"), attachment.clone()).await);
    let second = Arc::new(partition(&directory.path().join("b.sqlite"), attachment).await);
    let entered = Arc::new(Semaphore::new(0));
    let release = Arc::new(Semaphore::new(0));
    let mut writers = Vec::new();
    for owner in [first.clone(), second.clone()] {
        let entered = entered.clone();
        let release = release.clone();
        writers.push(tokio::spawn(async move {
            owner
                .run(move |connection| {
                    Box::pin(async move {
                        let mut tx = connection.begin_with("BEGIN IMMEDIATE").await?;
                        let epoch: i64 =
                            sqlx::query_scalar("SELECT permission_epoch FROM workspace_bindings")
                                .fetch_one(&mut *tx)
                                .await?;
                        assert_eq!(epoch, 1);
                        entered.add_permits(1);
                        release.acquire().await.unwrap().forget();
                        let same: i64 =
                            sqlx::query_scalar("SELECT permission_epoch FROM workspace_bindings")
                                .fetch_one(&mut *tx)
                                .await?;
                        assert_eq!(
                            same, epoch,
                            "binding read must remain on the same SQL snapshot"
                        );
                        tx.commit().await?;
                        Ok(())
                    })
                })
                .await
        }));
    }
    tokio::time::timeout(Duration::from_secs(5), entered.acquire_many(2))
        .await
        .unwrap()
        .unwrap()
        .forget();
    tokio::time::timeout(
        Duration::from_secs(5),
        sqlx::query("UPDATE workspace_bindings SET permission_epoch=2")
            .execute(&mut control_connection),
    )
    .await
    .unwrap()
    .unwrap();
    release.add_permits(2);
    for writer in writers {
        writer.await.unwrap().unwrap();
    }
    first.shutdown().await.unwrap();
    second.shutdown().await.unwrap();
    control_connection.close().await.unwrap();
}

#[tokio::test]
async fn invalid_attachment_fails_closed_and_releases_only_after_cleanup() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("invalid.sqlite");
    let connection = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true),
    )
    .await
    .unwrap();
    connection.close().await.unwrap();
    let attachment = ReadOnlyControl::new(&path).unwrap();
    let lock = directory.path().join("owner.lock");
    let lease = Arc::new(crate::root::FileLease::acquire(&lock).unwrap());
    let original = Arc::downgrade(&lease);
    let captured = attachment.clone();
    let result = OwnedConnection::open_with_cache(
        SqliteConnectOptions::new()
            .filename(directory.path().join("data.sqlite"))
            .create_if_missing(true),
        ConnectionAuthority::Writer { lease, root: None },
        move |connection| {
            Box::pin(async move {
                crate::schema::initialize_connection_with_control(connection, Some(&captured)).await
            })
        },
        None,
        Some(attachment),
    )
    .await;
    assert!(matches!(result, Err(StoreError::Sqlx(_))));
    assert!(original.upgrade().is_none());
    drop(crate::root::FileLease::acquire(&lock).unwrap());
    assert!(ReadOnlyControl::new(&directory.path().join("missing.sqlite")).is_err());
}

#[tokio::test]
async fn attached_reader_real_close_retains_original_root_authority() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("control.sqlite");
    let control_connection = control(&path).await;
    let root_path = directory.path().join("root");
    let namespaces = crate::root::RootNamespaces {
        ownership: directory.path().join("owners"),
        control: directory.path().join("external-control"),
    };
    let root = Arc::new(crate::root::RootOwner::create(&root_path, &namespaces).unwrap());
    let original = Arc::downgrade(&root);
    let attachment = ReadOnlyControl::new(&path).unwrap();
    let captured = attachment.clone();
    let owner = Arc::new(
        OwnedConnection::open_with_cache(
            SqliteConnectOptions::new()
                .filename(root_path.join(crate::root::ROOT_DATABASE))
                .create_if_missing(true),
            ConnectionAuthority::Root(root),
            move |connection| {
                Box::pin(async move {
                    crate::schema::initialize_connection_with_control(connection, Some(&captured))
                        .await
                })
            },
            None,
            Some(attachment),
        )
        .await
        .unwrap(),
    );
    let (entered, reached) = oneshot::channel();
    let (release, gate) = std::sync::mpsc::channel();
    owner
        .read(move |connection| {
            Box::pin(async move {
                verify(connection).await?;
                struct Closing {
                    entered: Option<oneshot::Sender<()>>,
                    gate: std::sync::mpsc::Receiver<()>,
                }
                impl Drop for Closing {
                    fn drop(&mut self) {
                        self.entered.take().unwrap().send(()).unwrap();
                        self.gate.recv_timeout(Duration::from_secs(10)).unwrap();
                    }
                }
                let closing = Closing {
                    entered: Some(entered),
                    gate,
                };
                connection
                    .lock_handle()
                    .await?
                    .set_progress_handler(1, move || {
                        let _retained = &closing;
                        true
                    });
                Ok(())
            })
        })
        .await
        .unwrap();
    let closing = owner.clone();
    let shutdown = tokio::spawn(async move { closing.shutdown().await });
    tokio::time::timeout(Duration::from_secs(5), reached)
        .await
        .unwrap()
        .unwrap();
    assert!(!shutdown.is_finished());
    assert!(original.upgrade().is_some());
    assert_eq!(
        crate::root::RootOwner::open(&root_path, &namespaces)
            .err()
            .unwrap()
            .kind(),
        std::io::ErrorKind::WouldBlock
    );
    release.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(5), shutdown)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(original.upgrade().is_none());
    drop(crate::root::RootOwner::open(&root_path, &namespaces).unwrap());
    control_connection.close().await.unwrap();
}

#[tokio::test]
async fn initialization_cannot_silently_discard_control_view() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("control.sqlite");
    let control_connection = control(&path).await;
    let attachment = ReadOnlyControl::new(&path).unwrap();
    let captured = attachment.clone();
    let lock = directory.path().join("owner.lock");
    let lease = Arc::new(crate::root::FileLease::acquire(&lock).unwrap());
    let original = Arc::downgrade(&lease);
    let result = OwnedConnection::open_with_cache(
        SqliteConnectOptions::new()
            .filename(directory.path().join("data.sqlite"))
            .create_if_missing(true),
        ConnectionAuthority::Writer { lease, root: None },
        move |connection| {
            Box::pin(async move {
                crate::schema::initialize_connection_with_control(connection, Some(&captured))
                    .await?;
                sqlx::query("PRAGMA temp_store=MEMORY")
                    .execute(connection)
                    .await?;
                Ok(())
            })
        },
        None,
        Some(attachment),
    )
    .await;
    assert!(matches!(result, Err(StoreError::Sqlx(_))));
    assert!(original.upgrade().is_none());
    drop(crate::root::FileLease::acquire(&lock).unwrap());
    control_connection.close().await.unwrap();
}
