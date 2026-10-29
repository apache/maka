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

use crate::support::root;
use maka_config::ConfigurationStore;
use rusqlite::Connection;
use std::path::Path;

fn private_database(root: &Path) -> Connection {
    let path = root.join("configuration-rust.sqlite");
    #[cfg(windows)]
    maka_event_log::root::windows::create_private_file(&path).unwrap();
    #[cfg(not(windows))]
    {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options.open(&path).unwrap();
    }
    Connection::open(path).unwrap()
}

#[tokio::test]
async fn invalid_databases_are_rejected_without_mutation_and_interrupted_initialization_resumes() {
    for corruption in [
        "UPDATE _sqlx_migrations SET checksum = X'00'",
        "UPDATE _sqlx_migrations SET version = version + 999",
        "PRAGMA application_id = 123",
        "PRAGMA user_version = 999",
        "DROP TABLE _sqlx_migrations",
        "DELETE FROM _sqlx_migrations",
        "PRAGMA user_version = 0",
    ] {
        let temp = tempfile::tempdir().unwrap();
        let owner = root(temp.path());
        let store = ConfigurationStore::for_root(owner.clone()).await.unwrap();
        store.close().await.unwrap();
        let path = owner.canonical_path().join("configuration-rust.sqlite");
        let database = Connection::open(&path).unwrap();
        database.execute_batch(corruption).unwrap();
        database
            .execute_batch("PRAGMA journal_mode = DELETE")
            .unwrap();
        drop(database);
        let before = std::fs::read(&path).unwrap();
        assert!(
            ConfigurationStore::for_root(owner.clone()).await.is_err(),
            "{corruption}"
        );
        assert!(std::fs::read(&path).unwrap() == before, "{corruption}");
    }
    let temp = tempfile::tempdir().unwrap();
    let owner = root(temp.path());
    let database = private_database(owner.canonical_path());
    database
        .execute_batch("PRAGMA application_id = 1296124739;")
        .unwrap();
    drop(database);
    let store = ConfigurationStore::for_root(owner).await.unwrap();
    assert_eq!(store.catalog().await.unwrap().revision, 0);
    assert!(store.catalog().await.unwrap().connections.is_empty());
    store.close().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_plugin_owners_initialize_one_fresh_configuration_database() {
    let temp = tempfile::tempdir().unwrap();
    let owner = root(temp.path());
    let ready = std::sync::Arc::new(tokio::sync::Barrier::new(8));
    let mut opened = tokio::task::JoinSet::new();
    for _ in 0..8 {
        let owner = owner.clone();
        let ready = ready.clone();
        opened.spawn(async move {
            ready.wait().await;
            ConfigurationStore::for_root(owner).await
        });
    }
    while let Some(result) = opened.join_next().await {
        let store = result.unwrap().expect("concurrent owner initialization");
        assert_eq!(store.catalog().await.unwrap().revision, 0);
        assert!(store.catalog().await.unwrap().connections.is_empty());
        store.close().await.unwrap();
    }
    let reopened = ConfigurationStore::for_root(owner).await.unwrap();
    assert_eq!(reopened.catalog().await.unwrap().revision, 0);
    reopened.close().await.unwrap();
}
