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
use crate::applications::operations::{Dispatch, DispatchClaim, OperationRequest};
use maka_plugin_core::{
    composition::{Input, InstanceId},
    contract::{Contract, Interface, Method, MethodMode, Transport},
    operation::{OperationCleanup, OperationOutcome, OperationResult},
    scope::Scope,
    storage::Namespace,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use uuid::Uuid;

async fn open() -> (tempfile::TempDir, RootStore) {
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
    let store = RootStore::open(owner, crate::ROOT_MIGRATIONS)
        .await
        .unwrap();
    (directory, store)
}

fn origin(target: &str, fingerprint: String) -> PluginSession {
    PluginSession {
        session_id: target.into(),
        creator: Namespace::new("test", Scope::Profile).unwrap(),
        fingerprint,
        managed: false,
        authority_session_id: None,
    }
}

async fn dispatch(root: &RootStore, target: &str) -> (OperationStore, DispatchClaim) {
    let request = OperationRequest {
        source: root
            .commit_application(
                Uuid::new_v4(),
                0,
                Input {
                    base: None,
                    ui: None,
                    instances: BTreeMap::new(),
                },
                vec![],
                vec![],
            )
            .await
            .unwrap(),
        namespace: InstanceId(vec![Uuid::new_v4()]),
        consumer: InstanceId(vec![Uuid::new_v4()]),
        export: "service".into(),
        method: "change".into(),
        contract: Contract {
            name: "changes".into(),
            version: 1,
            transport: Transport::Local,
            interface: Interface::Service {
                methods: BTreeMap::from([(
                    "change".into(),
                    Method {
                        progress: None,
                        mode: MethodMode::Mutation,
                        input: json!({}).into(),
                        output: json!({}).into(),
                        resources: BTreeMap::new(),
                    },
                )]),
            },
        },
        operation: Uuid::new_v4(),
        input: json!({"target": target}),
        capture: None,
        origin: json!({"kind": "composition_test"}),
    };
    let operation = root.operation(&request.reference().unwrap()).unwrap();
    let Dispatch::New(claim) = operation.dispatch_operation(request).await.unwrap() else {
        panic!("original request must obtain one real claim");
    };
    operation.start_operation(&claim).unwrap();
    (operation, claim)
}

struct Payload {
    target: String,
    bytes: Vec<u8>,
    digest: String,
    reject: bool,
}
impl Payload {
    fn new(target: &str, operation: Uuid, reject: bool) -> Self {
        let bytes = serde_json::to_vec(&json!({"target":target,"operation":operation})).unwrap();
        let digest = format!("sha256:{}", hex::encode(Sha256::digest(&bytes)));
        Self {
            target: target.into(),
            bytes,
            digest,
            reject,
        }
    }
}
impl Statement for Payload {
    type Value = ();
    type Output = ();
    fn execute(self, db: &SqliteConnection) -> Result<Prepared<()>, StoreError> {
        let metadata: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM session_control WHERE id=?)",
            [&self.target],
            |row| row.get(0),
        )?;
        if !metadata {
            return Err(invalid("payload requires its target metadata"));
        }
        crate::content::put(db, &self.digest, &self.bytes)?;
        if self.reject {
            return Err(invalid("payload rejected"));
        }
        Ok(Prepared {
            value: (),
            changed: true,
            notification: Notification::NONE,
        })
    }
    fn committed(value: ()) {
        value
    }
    fn isolated_rejection(error: &StoreError) -> bool {
        matches!(error, StoreError::InvalidTransition(_))
    }
}

async fn persisted(root: &RootStore, target: &str, digest: &str) -> (i64, Option<Vec<u8>>) {
    let target = target.to_owned();
    let digest = digest.to_owned();
    root.log
        .connection
        .read(move |db| {
            let records = db.query_row(
                "SELECT (SELECT count(*) FROM session_control WHERE id=?1)
                  + (SELECT count(*) FROM plugin_sessions WHERE session_id=?1)
                  + (SELECT count(*) FROM session_creations WHERE session_id=?1)",
                [target],
                |row| row.get(0),
            )?;
            Ok((records, crate::content::read(db, &digest)?))
        })
        .await
        .unwrap()
}

#[tokio::test]
async fn abandoned_prepare_and_payload_rejection_leave_no_empty_session() {
    let (_directory, root) = open().await;
    let writer = root.data_writer().unwrap();
    let (operation, claim) = dispatch(&root, "target").await;
    let origin = origin("target", claim.reference().fingerprint.clone());
    let payload = Payload::new("target", claim.reference().operation, false);
    let digest = payload.digest.clone();
    let (_, change) = root
        .prepare_plugin_session(&origin, &json!({}), 7, &writer, payload)
        .await
        .unwrap();
    assert!(!root.session_is_available("target").await.unwrap());
    assert_eq!(persisted(&root, "target", &digest).await, (0, None));
    drop(change);
    assert!(root.get_session::<Value>("target").await.unwrap().is_none());

    let (_, change) = root
        .prepare_plugin_session(
            &origin,
            &json!({}),
            7,
            &writer,
            Payload::new("target", claim.reference().operation, true),
        )
        .await
        .unwrap();
    let returned = OperationResult::Success {
        value: json!({"target":"target"}),
    };
    assert!(
        matches!(change.commit(&claim, returned).await, Err(StoreError::InvalidTransition(reason)) if reason == "payload rejected")
    );
    assert_eq!(persisted(&root, "target", &digest).await, (0, None));
    assert!(!root.session_is_available("target").await.unwrap());
    assert_eq!(
        operation
            .operation_observation()
            .await
            .unwrap()
            .unwrap()
            .outcome,
        OperationOutcome::Unresolved
    );
    operation
        .record_operation_outcome(
            &claim,
            OperationOutcome::Returned {
                result: OperationResult::Failure {
                    diagnostic: "payload rejected".into(),
                },
            },
        )
        .await
        .unwrap();
    operation
        .record_operation_cleanup(&claim, OperationCleanup::Confirmed)
        .await
        .unwrap();
    drop(claim);
    root.close().await.unwrap();
}

#[tokio::test]
async fn publication_payload_and_returned_share_the_original_creation() {
    let (_directory, root) = open().await;
    let writer = root.data_writer().unwrap();
    let (operation, claim) = dispatch(&root, "target").await;
    let origin = origin("target", claim.reference().fingerprint.clone());
    let configuration = json!({"title":"prepared"});
    let payload = Payload::new("target", claim.reference().operation, false);
    let digest = payload.digest.clone();
    let bytes = payload.bytes.clone();
    let (expected, change) = root
        .prepare_plugin_session(&origin, &configuration, 7, &writer, payload)
        .await
        .unwrap();
    let returned = OperationResult::Success {
        value: serde_json::to_value(&expected).unwrap(),
    };
    let observation = change.commit(&claim, returned.clone()).await.unwrap();
    assert_eq!(observation.reference, *claim.reference());
    assert_eq!(
        observation.outcome,
        OperationOutcome::Returned {
            result: returned.clone()
        }
    );
    assert_eq!(
        root.get_session::<Value>("target").await.unwrap(),
        Some(expected.clone())
    );
    assert!(root.session_is_available("target").await.unwrap());
    assert_eq!(persisted(&root, "target", &digest).await, (3, Some(bytes)));
    let fingerprint = origin.fingerprint.clone();
    let receipt = root
        .log
        .connection
        .read(move |db| {
            let receipt: (String, String, String, i64) = db.query_row(
                "SELECT s.fingerprint,p.fingerprint,r.fingerprint,r.ready
             FROM session_control s JOIN plugin_sessions p ON p.session_id=s.id
             JOIN session_creations r ON r.session_id=s.id WHERE s.id='target'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?;
            Ok(receipt)
        })
        .await
        .unwrap();
    assert_eq!(
        receipt,
        (fingerprint.clone(), fingerprint.clone(), fingerprint, 1)
    );

    let (retried, change) = root
        .prepare_plugin_session(
            &origin,
            &configuration,
            99,
            &writer,
            Payload::new("target", claim.reference().operation, true),
        )
        .await
        .unwrap();
    assert_eq!(retried, expected);
    assert_eq!(retried.created_at, 7);
    assert_eq!(change.commit(&claim, returned).await.unwrap(), observation);
    operation
        .record_operation_cleanup(&claim, OperationCleanup::Confirmed)
        .await
        .unwrap();
    drop(claim);
    root.close().await.unwrap();
}

#[tokio::test]
async fn foreign_actual_writer_cannot_compose_target_metadata() {
    let (_directory, root) = open().await;
    let (_foreign_directory, foreign) = open().await;
    let origin = origin("target", "original".into());
    let writer = foreign.data_writer().unwrap();
    let payload = Payload::new("target", Uuid::new_v4(), false);
    let digest = payload.digest.clone();
    assert!(
        matches!(root.prepare_plugin_session(&origin, &json!({}), 7, &writer, payload).await,
        Err(StoreError::InvalidTransition(reason)) if reason == "foreign Root data writer")
    );
    assert_eq!(persisted(&root, "target", &digest).await, (0, None));
    assert_eq!(persisted(&foreign, "target", &digest).await, (0, None));
    foreign.close().await.unwrap();
    root.close().await.unwrap();
}
