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

use maka_capabilities::authorization::Id;
use maka_capabilities::call::Identity;
use maka_capabilities::filesystem;
use maka_capabilities::storage::Namespace;
use maka_event_log::{
    EventLog, StoreError,
    effects::{Operation, Outcome, Request},
};
use maka_plugin_core::scope::Scope;
use serde_json::json;
use uuid::Uuid;

#[tokio::test]
async fn recovery_preserves_completed_effects_and_fences_uncertain_late_results() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("log.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    let request = || Request {
        source: Identity::Background {
            grant: Id(Uuid::new_v4()),
        },
        owner: maka_event_log::effects::Owner::Resource(maka_event_log::effects::ResourceOwner {
            package_id: "example.external".into(),
            entry_id: "instance".into(),
            scope: Scope::Profile,
            activation: "original".into(),
            generation: 1,
        }),
        boundary: maka_capabilities::authorization::Boundary::Profile,
        operation: Operation::File(filesystem::Operation::Write(filesystem::Write {
            path: "file".into(),
            content: "prepared".into(),
        })),
    };
    let uncertain = log.begin_host_effect(request()).await.unwrap();
    let complete = log.begin_host_effect(request()).await.unwrap();
    let bytes = vec![0, 255, 42];
    let outcome = || Outcome::Image {
        mime_type: "image/png".into(),
        digest: maka_agent_facts::artifact::content_digest(&bytes),
    };
    log.settle_host_effect(complete, outcome(), Some(bytes.clone()))
        .await
        .unwrap();
    log.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    log.recover_host_effects().await.unwrap();
    let namespace = Namespace::new("example.external", Scope::Profile).unwrap();
    let record = log
        .host_effect(namespace.clone(), uncertain)
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(record.outcome, Some(Outcome::Unknown { .. })));
    assert!(matches!(
        log.settle_host_effect(uncertain, Outcome::Completed { value: json!(true) }, None)
            .await,
        Err(StoreError::EventConflict)
    ));
    let record = log.host_effect(namespace, complete).await.unwrap().unwrap();
    assert_eq!(record.outcome, Some(outcome()));
    assert_eq!(record.payload, Some(bytes));
    assert!(
        log.host_effect(
            Namespace::new("another.package", Scope::Profile).unwrap(),
            complete
        )
        .await
        .unwrap()
        .is_none()
    );
    log.close().await.unwrap();
}

#[test]
fn resource_owner_json_is_preserved_and_mixed_native_provenance_is_rejected() {
    let legacy = json!({"packageId":"example.external", "entryId":"instance", "scope":"profile",
        "activation":"original", "generation":1});
    let owner: maka_event_log::effects::Owner = serde_json::from_value(legacy.clone()).unwrap();
    assert!(matches!(owner, maka_event_log::effects::Owner::Resource(_)));
    assert_eq!(serde_json::to_value(owner).unwrap(), legacy);
    let mut mixed = legacy;
    mixed["source"] =
        json!({"stateDomain":"a".repeat(64), "deployment":Uuid::new_v4(), "revision":1});
    mixed["epoch"] = json!(Uuid::new_v4());
    assert!(
        serde_json::from_value::<maka_event_log::effects::Owner>(mixed).is_err(),
        "native provenance cannot silently fall back to fabricated resource generation"
    );
}
