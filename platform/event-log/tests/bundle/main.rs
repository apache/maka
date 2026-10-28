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

use maka_agent_facts::session::CopyPurpose;
use maka_capabilities::storage::Namespace;
use maka_event_log::{
    EventLog,
    bundle::BundleError,
    sessions::{PluginSession, SessionCopy},
};
use maka_plugin_core::scope::Scope;
use serde_json::json;
use sqlx::{Connection, SqliteConnection, sqlite::SqliteConnectOptions};

mod export;

#[tokio::test]
async fn declared_huge_bundle_frame_without_payload_is_an_eof() {
    let mut bytes = b"MAKA-SESSION\0\x02".to_vec();
    bytes.extend_from_slice(&u32::MAX.to_be_bytes());
    let result = maka_event_log::bundle::inspect(bytes.as_slice()).await;
    assert!(matches!(
        result,
        Err(BundleError::Store(maka_event_log::StoreError::Io(error)))
            if error.kind() == std::io::ErrorKind::UnexpectedEof
    ));
}

#[tokio::test]
async fn inventory_confirms_only_selected_descendants_across_history_and_host_parent_edges() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("events.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    for id in ["root", "unrelated"] {
        log.create_session(id, id, &json!({}), 1).await.unwrap();
    }
    let first = log.preview_bundle("root").await.unwrap();
    assert_eq!(first.sessions.len(), 1);
    let request = SessionCopy {
        source_session_id: "root".into(),
        target_session_id: "branch".into(),
        expected_source_revision: first.sessions[0].revision,
        purpose: CopyPurpose::Branch {
            turn_id: None,
            side_conversation: true,
        },
    };
    // A plugin-created branch has both history and authority-parent edges.
    log.copy_plugin_session(
        request,
        &json!({}),
        2,
        PluginSession {
            session_id: "branch".into(),
            creator: Namespace::new("example.orchestrator", Scope::Profile).unwrap(),
            fingerprint: "branch".into(),
            managed: false,
            authority_session_id: Some("root".into()),
        },
    )
    .await
    .unwrap();
    log.create_plugin_session(
        &PluginSession {
            session_id: "child".into(),
            creator: Namespace::new("example.orchestrator", Scope::Profile).unwrap(),
            fingerprint: "child".into(),
            managed: true,
            authority_session_id: Some("branch".into()),
        },
        &json!({}),
        3,
    )
    .await
    .unwrap();
    let complete = log.preview_bundle("root").await.unwrap();
    assert_eq!(
        complete
            .sessions
            .iter()
            .map(|s| s.id.as_str())
            .collect::<Vec<_>>(),
        ["branch", "child", "root"]
    );
    assert!(matches!(
        complete.verify_confirmation(&first.subtree_digest),
        Err(BundleError::CandidateSetStale)
    ));
    complete
        .verify_confirmation(&complete.subtree_digest)
        .unwrap();
    assert_eq!(log.preview_bundle("child").await.unwrap().sessions.len(), 1);
    assert_eq!(
        log.preview_bundle("branch").await.unwrap().sessions.len(),
        2
    );
    assert!(matches!(
        log.preview_bundle("missing").await,
        Err(BundleError::Store(
            maka_event_log::StoreError::SessionNotFound
        ))
    ));
    log.close().await.unwrap();

    // Seed a wide catalog without thousands of unrelated admission transactions.
    let mut db = SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&path))
        .await
        .unwrap();
    sqlx::raw_sql(
        "WITH RECURSIVE numbers(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM numbers WHERE n<4094)
         INSERT INTO session_control SELECT 'wide-'||n,'fixture',1,1,1,0,'{}' FROM numbers;
         INSERT INTO plugin_sessions SELECT id,'example.orchestrator','profile','fixture',0,'root'
         FROM session_control WHERE id LIKE 'wide-%';",
    )
    .execute(&mut db)
    .await
    .unwrap();
    db.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    let complete = log.preview_bundle("root").await;
    let unrelated = log.preview_bundle("unrelated").await;
    log.close().await.unwrap();
    let complete = complete.expect("complete owned subtree must be available for transfer");
    assert_eq!(complete.sessions.len(), 4097);
    assert_eq!(
        complete
            .sessions
            .iter()
            .filter(|session| session.id.starts_with("wide-"))
            .count(),
        4094
    );
    assert_eq!(unrelated.unwrap().sessions.len(), 1);
}
