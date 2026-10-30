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
use crate::applications::tests::store;
use maka_packages::MANIFEST_FILE;
use maka_packages::Package;
use maka_plugin_core::{
    composition::{Configuration, Input, Node, PackageUse},
    contract::{Contract, Interface, Method, MethodMode, Transport},
    operation::RecoveryProtocol,
    package::{Declaration, EntryDeclaration, Implementation},
};
use serde_json::json;
use std::collections::BTreeMap;

fn reference() -> RecoveryRef {
    RecoveryRef {
        source: DeploymentRef {
            state_domain: "a".repeat(64),
            deployment: Uuid::from_u128(900),
            revision: 1,
        },
        namespace: InstanceId(vec![Uuid::from_u128(11)]),
        export: "Service".into(),
        method: "change".into(),
        operation: Uuid::new_v4(),
        fingerprint: format!("sha256-{}", "b".repeat(64)),
        contract: maka_plugin_core::operation::RecoveryContract::for_method(
            &Contract {
                name: "test.Change".into(),
                version: 1,
                transport: Transport::Remote,
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
            "change",
        )
        .unwrap(),
        recovery: RecoveryProtocol::JournalV1,
    }
}
async fn source(store: &EventLog, deployment: Uuid, expected: u64) -> DeploymentRef {
    let package = Package::new(BTreeMap::from([(MANIFEST_FILE.into(),serde_json::to_vec(&json!({"schemaVersion":1,"id":"caller","application":Declaration {host: Some(EntryDeclaration { implementation:Implementation::Native {implementation:"test.caller".into()},configuration:json!({"type":"object"}).into(),imports:BTreeMap::new(),exports:BTreeMap::new()}), ui: None,composition:None}})).unwrap())])).unwrap();
    store
        .commit_application(
            deployment,
            expected,
            Input {
                ui: None,
                instances: BTreeMap::from([(
                    "caller".into(),
                    Node {
                        key: Uuid::from_u128(42),
                        package: package.application_ref().into(),
                        use_package: PackageUse::Host,
                        configuration: Configuration::default(),
                        parameters: Configuration::default(),
                        bindings: BTreeMap::new(),
                        disabled: false,
                        overrides: vec![],
                    },
                )]),
            },
            vec![],
            vec![package],
        )
        .await
        .unwrap()
}
fn consumer() -> InstanceId {
    InstanceId(vec![Uuid::from_u128(42)])
}

#[tokio::test]
async fn corrupted_history_is_never_overwritten_as_a_fresh_intent() {
    let (_dir, store) = store().await;
    let deployment = Uuid::new_v4();
    let caller = source(&store, deployment, 0).await;
    let original = reference();
    let token = store
        .record_application_intent(
            caller.clone(),
            consumer(),
            original.clone(),
            serde_json::Value::Null,
        )
        .await
        .unwrap();
    let cursor = token.intent().cursor;
    drop(token);
    let operation = original.operation.to_string();
    store
        .connection
        .run(move |connection| {
            Box::pin(async move {
                sqlx::query("UPDATE application_intents SET operation=? WHERE cursor=?")
                    .bind(format!("{operation}\0extra"))
                    .bind(cursor as i64)
                    .execute(&mut *connection)
                    .await?;
                Ok(())
            })
        })
        .await
        .unwrap();
    assert!(
        store
            .application_intents(deployment, consumer(), 0, 128)
            .await
            .is_err()
    );
    let operation = original.operation.to_string();
    store
        .connection
        .run(move |connection| {
            Box::pin(async move {
                sqlx::query(
                    "UPDATE application_intents SET operation=?, reference_json=? WHERE cursor=?",
                )
                .bind(operation)
                .bind("{}")
                .bind(cursor as i64)
                .execute(&mut *connection)
                .await?;
                Ok(())
            })
        })
        .await
        .unwrap();
    assert!(
        store
            .application_intents(deployment, consumer(), 0, 128)
            .await
            .is_err()
    );
    assert!(
        store
            .record_application_intent(caller, consumer(), original, serde_json::Value::Null)
            .await
            .is_err()
    );
    let rows: i64 = store
        .connection
        .run(|connection| {
            Box::pin(async move {
                Ok(
                    sqlx::query_scalar("SELECT COUNT(*) FROM application_intents")
                        .fetch_one(connection)
                        .await?,
                )
            })
        })
        .await
        .unwrap();
    assert_eq!(rows, 1);
}
