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

use maka_capabilities::storage::Namespace;
use maka_event_log::{EventLog, StoreError, sessions::PluginSession};
use maka_plugin_core::scope::Scope;
use serde_json::{Value, json};

#[tokio::test]
async fn plugin_creation_is_atomic_and_cannot_adopt_or_reassign_existing_sessions() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("events.sqlite");
    let claim = PluginSession {
        session_id: "example-inbox".into(),
        creator: Namespace::new("example.workflow", Scope::Profile).unwrap(),
        fingerprint: "owned-creation".into(),
        managed: true,
        authority_session_id: None,
    };
    let log = EventLog::open(&path).await.unwrap();
    let configuration = json!({"name":"inbox"});
    let record = log
        .create_plugin_session(&claim, &configuration, 1)
        .await
        .unwrap();
    assert_eq!(
        log.create_plugin_session(&claim, &configuration, 2)
            .await
            .unwrap(),
        record
    );
    assert!(matches!(
        log.create_session(&claim.session_id, &claim.fingerprint, &configuration, 2)
            .await,
        Err(StoreError::SessionConflict)
    ));
    for creator in [
        Namespace::new("other.workflow", Scope::Profile).unwrap(),
        Namespace::new("example.workflow", Scope::Session("other".into())).unwrap(),
    ] {
        let wrong = PluginSession {
            creator,
            ..claim.clone()
        };
        assert!(matches!(
            log.create_plugin_session(&wrong, &configuration, 2).await,
            Err(StoreError::SessionConflict)
        ));
    }
    let ordinary = PluginSession {
        session_id: "ordinary".into(),
        ..claim.clone()
    };
    log.create_session("ordinary", &ordinary.fingerprint, &configuration, 1)
        .await
        .unwrap();
    assert!(matches!(
        log.create_plugin_session(&ordinary, &configuration, 2)
            .await,
        Err(StoreError::SessionConflict)
    ));
    assert_eq!(log.session_manager("ordinary").await.unwrap(), None);
    assert_eq!(log.session_creator("ordinary").await.unwrap(), None);
    let delegated = PluginSession {
        session_id: "delegated".into(),
        managed: false,
        ..claim.clone()
    };
    log.create_plugin_session(&delegated, &configuration, 2)
        .await
        .unwrap();
    for conflicting in [
        PluginSession {
            managed: true,
            ..delegated.clone()
        },
        PluginSession {
            fingerprint: "changed".into(),
            ..delegated.clone()
        },
        PluginSession {
            creator: Namespace::new("other", Scope::Profile).unwrap(),
            ..delegated.clone()
        },
    ] {
        assert!(matches!(
            log.create_plugin_session(&conflicting, &configuration, 3)
                .await,
            Err(StoreError::SessionConflict)
        ));
    }
    let request = maka_agent_facts::session::CopyRequest {
        source_session_id: claim.session_id.clone(),
        target_session_id: "owned-copy".into(),
        expected_source_revision: record.revision,
        purpose: maka_agent_facts::session::CopyPurpose::EmptySideConversation,
    };
    let owner = PluginSession {
        session_id: request.target_session_id.clone(),
        fingerprint: "copy-with-settings".into(),
        authority_session_id: Some(claim.session_id.clone()),
        ..claim.clone()
    };
    let other = PluginSession {
        creator: Namespace::new("another.workflow", Scope::Profile).unwrap(),
        ..owner.clone()
    };
    assert!(
        log.copy_plugin_session(request.clone(), &configuration, 4, other)
            .await
            .is_err(),
        "reading a managed Session does not authorize escaping its owner lifecycle"
    );
    assert!(log.session_creator("owned-copy").await.unwrap().is_none());
    let maka_event_log::sessions::SessionCopyResult::Committed(copied) = log
        .copy_plugin_session(request.clone(), &configuration, 4, owner.clone())
        .await
        .unwrap()
    else {
        panic!("unexpected revision conflict")
    };
    assert!(
        matches!(
            log.copy_session(request.clone(), &configuration, 4).await,
            Err(StoreError::SessionConflict)
        ),
        "native copy retries cannot adopt a plugin's creation"
    );
    assert!(matches!(
        log.copy_plugin_session(
            request.clone(),
            &configuration,
            4,
            PluginSession {
                fingerprint: "changed-settings".into(),
                ..owner.clone()
            }
        )
        .await,
        Err(StoreError::SessionConflict)
    ));
    log.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    let maka_event_log::sessions::SessionCopyResult::Committed(replayed) = log
        .copy_plugin_session(
            request,
            &json!({"ignored": "freshly resolved defaults"}),
            5,
            owner.clone(),
        )
        .await
        .unwrap()
    else {
        panic!("exact copy was not replayed")
    };
    assert_eq!(replayed, copied);
    assert_eq!(
        log.session_manager("owned-copy").await.unwrap(),
        Some(owner.creator)
    );
    assert_eq!(
        log.session_manager(&claim.session_id).await.unwrap(),
        Some(claim.creator.clone())
    );
    assert_eq!(log.session_manager("delegated").await.unwrap(), None);
    assert_eq!(
        log.session_creator("delegated").await.unwrap(),
        Some(claim.creator)
    );
    assert_eq!(
        log.get_session::<Value>(&claim.session_id).await.unwrap(),
        Some(record)
    );
    log.close().await.unwrap();
}
