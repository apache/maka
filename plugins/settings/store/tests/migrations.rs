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

use maka_config::ConfigurationStore;
use maka_event_log::root::{RootNamespaces, RootOwner};
use rusqlite::Connection;
use std::{path::Path, sync::Arc};

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

fn root(temp: &Path) -> Arc<RootOwner> {
    Arc::new(
        RootOwner::create(
            &temp.join("root"),
            &RootNamespaces {
                ownership: temp.join("owners"),
                control: temp.join("control"),
            },
        )
        .unwrap(),
    )
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
    for _ in 0..4 {
        let temp = tempfile::tempdir().unwrap();
        let owner = root(temp.path());
        let mut opened = tokio::task::JoinSet::new();
        for _ in 0..8 {
            let owner = owner.clone();
            opened.spawn(async move { ConfigurationStore::for_root(owner).await });
        }
        let mut stores = Vec::new();
        while let Some(result) = opened.join_next().await {
            stores.push(result.unwrap().expect("concurrent owner initialization"));
        }
        for store in stores {
            assert_eq!(store.catalog().await.unwrap().revision, 0);
            assert!(store.catalog().await.unwrap().connections.is_empty());
            store.close().await.unwrap();
        }
        let reopened = ConfigurationStore::for_root(owner).await.unwrap();
        assert_eq!(reopened.catalog().await.unwrap().revision, 0);
        reopened.close().await.unwrap();
    }
}

#[test]
fn current_configuration_enforces_authority_constraints_without_content_quotas() {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch(include_str!("../migrations/0001_configuration.sql"))
        .unwrap();
    db.execute_batch(
        "INSERT INTO pricing_overrides VALUES('provider:model', X'0102', '{\"modelKey\":\"provider:model\"}');
         INSERT INTO runtime_policy VALUES(1, '{\"revision\":7}');
         INSERT INTO plugin_credentials VALUES('example','profile','key',7,NULL);
         INSERT INTO plugin_authorizations VALUES('original','example','profile','operation','{\"original\":true}',1);
         INSERT INTO oauth_login_receipts VALUES(42,'original','{}','method','digest','{\"phase\":\"authenticated\"}','{}');
         UPDATE sqlite_sequence SET seq=500 WHERE name='oauth_login_receipts';",
    ).unwrap();
    let access =
        serde_json::json!({"credentialId":"access-original","credentialHash":"a".repeat(64)})
            .to_string();
    db.execute(
        "INSERT INTO access_credentials(document) VALUES(?)",
        [&access],
    )
    .unwrap();
    db.execute("INSERT INTO oauth_login_receipts(attempt_id,target,method,request_fingerprint,phase,connection) VALUES('next','{}','method','digest','{}','{}')",[]).unwrap();
    assert_eq!(db.last_insert_rowid(), 501);
    let large = serde_json::json!({"routingNotes":"route: east\n".repeat(12_000)}).to_string();
    for query in [
        "UPDATE pricing_overrides SET record_json=?",
        "UPDATE runtime_policy SET document=?",
        "UPDATE plugin_authorizations SET document=?",
    ] {
        db.execute(query, [&large]).unwrap();
    }
    db.execute("UPDATE plugin_credentials SET secret=?", [&large])
        .unwrap();
    let large_access = serde_json::json!({"credentialId":"access-large","credentialHash":"b".repeat(64),"grants":vec!["read";150_000]}).to_string();
    db.execute(
        "INSERT INTO access_credentials(document) VALUES(?)",
        [&large_access],
    )
    .unwrap();
    assert!(
        db.execute(
            "INSERT INTO access_credentials(document) VALUES(?)",
            [&large_access]
        )
        .is_err()
    );
    assert!(
        db.execute("UPDATE plugin_credentials SET revision=0", [])
            .is_err()
    );
    assert!(
        db.execute("UPDATE plugin_authorizations SET revoked=2", [])
            .is_err()
    );
    assert!(
        db.execute("UPDATE runtime_policy SET document='invalid-json'", [])
            .is_err()
    );
}
