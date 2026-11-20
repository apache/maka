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
use crate::{
    OpenPurpose, ROOT_MIGRATIONS,
    applications::operations::{Dispatch, OperationRequest},
    root::{ROOT_DATABASE, RootNamespaces, RootOwner},
};
use maka_plugin_core::{
    composition::{Configuration, InstanceId, Node, PackageUse},
    contract::{Contract, Interface, Method, MethodMode, Transport},
    operation::{OperationCleanup, OperationOutcome, OperationResult},
    package::PackageSelection,
};
use serde_json::json;
use std::sync::Arc;

fn package(id: &str, body: &str) -> Package {
    let manifest = format!(
        r#"{{"schemaVersion":1,"id":"{id}","application":{{"host":{{"implementation":{{"kind":"javascript","module":"host.mjs","realm":"shared"}},"configuration":{{"type":"object"}},"imports":{{}},"exports":{{}}}}}}}}"#
    );
    Package::new(BTreeMap::from([
        ("maka.extension.json".into(), manifest.into_bytes()),
        ("host.mjs".into(), body.as_bytes().to_vec()),
    ]))
    .unwrap()
}

fn op_request(source: DeploymentRef, consumer: InstanceId) -> OperationRequest {
    OperationRequest {
        source,
        namespace: InstanceId(vec![Uuid::new_v4()]),
        consumer,
        export: "ledger".into(),
        method: "write".into(),
        contract: Contract {
            name: "test.ReceiptLedger".into(),
            version: 1,
            transport: Transport::Local,
            interface: Interface::Service {
                methods: BTreeMap::from([(
                    "write".into(),
                    Method {
                        mode: MethodMode::Mutation,
                        input: json!({"type": "object"}).into(),
                        output: json!({}).into(),
                        progress: None,
                        resources: BTreeMap::new(),
                    },
                )]),
            },
        },
        operation: Uuid::new_v4(),
        input: json!({"value": 1}),
        capture: None,
        origin: json!({"kind": "release-test"}),
    }
}

async fn count(log: &EventLog, sql: &'static str) -> i64 {
    log.connection
        .read(move |connection| Ok(connection.query_row(sql, [], |row| row.get(0))?))
        .await
        .unwrap()
}

#[tokio::test]
async fn release_retains_non_terminal_operations_and_reclaims_settled_revisions() {
    let directory = tempfile::tempdir().unwrap();
    let base = directory.path();
    let owner = Arc::new(
        RootOwner::create(
            &base.join("root"),
            &RootNamespaces {
                ownership: base.join("owners"),
                control: base.join("control"),
            },
        )
        .unwrap(),
    );
    let log = EventLog::open_owned(
        &owner.canonical_path().join(ROOT_DATABASE),
        Some(owner),
        OpenPurpose::Execution,
        ROOT_MIGRATIONS,
    )
    .await
    .unwrap();

    let deployment = Uuid::new_v4();
    let shared = package("example.shared", "export const shared = 1;");
    let consumer_key = Uuid::new_v4();
    let consumer = InstanceId(vec![consumer_key]);
    let app_input = || Input {
        base: None,
        instances: BTreeMap::from([(
            "shared".into(),
            Node {
                key: consumer_key,
                package: PackageSelection::Pinned {
                    package: shared.application_ref(),
                },
                use_package: PackageUse::Host,
                configuration: Configuration::default(),
                parameters: Configuration::default(),
                bindings: BTreeMap::new(),
                disabled: false,
                overrides: vec![],
            },
        )]),
        ui: None,
    };
    let mut sources = Vec::new();
    for expected in 0..7u64 {
        let body = format!("export const v = {};", expected + 1);
        sources.push(
            log.commit_application(
                deployment,
                expected,
                app_input(),
                vec![],
                vec![package("example.app", &body), shared.clone()],
            )
            .await
            .unwrap(),
        );
    }
    // No-op when nothing is older than rev 1.
    log.release_superseded_application_sources(&sources[0])
        .await
        .unwrap();
    assert_eq!(
        count(&log, "SELECT count(*) FROM application_packages").await,
        8
    );

    let returned = OperationOutcome::Returned {
        result: OperationResult::Success {
            value: json!({"ok": true}),
        },
    };
    // rev 1: intent recorded without any operation row yet.
    let intent_only = op_request(sources[0].clone(), consumer.clone());
    log.record_application_intent(
        sources[0].clone(),
        intent_only.consumer.clone(),
        intent_only.reference().unwrap(),
        serde_json::Value::Null,
    )
    .await
    .unwrap();

    // rev 2: operation Unresolved + Unconfirmed.
    let unresolved = match log
        .dispatch_operation(op_request(sources[1].clone(), consumer.clone()))
        .await
        .unwrap()
    {
        Dispatch::New(claim) => claim,
        Dispatch::Existing(_) => unreachable!(),
    };

    // rev 3: operation Unknown outcome + Confirmed cleanup (still recoverable).
    let unknown = match log
        .dispatch_operation(op_request(sources[2].clone(), consumer.clone()))
        .await
        .unwrap()
    {
        Dispatch::New(claim) => claim,
        Dispatch::Existing(_) => unreachable!(),
    };
    log.start_operation(&unknown).unwrap();
    log.record_operation_outcome(
        &unknown,
        OperationOutcome::Unknown {
            diagnostic: "lost".into(),
        },
    )
    .await
    .unwrap();
    log.record_operation_cleanup(&unknown, OperationCleanup::Confirmed)
        .await
        .unwrap();

    // rev 4: operation Returned + Failed cleanup (still recoverable).
    let failed_cleanup = match log
        .dispatch_operation(op_request(sources[3].clone(), consumer.clone()))
        .await
        .unwrap()
    {
        Dispatch::New(claim) => claim,
        Dispatch::Existing(_) => unreachable!(),
    };
    log.start_operation(&failed_cleanup).unwrap();
    log.record_operation_outcome(&failed_cleanup, returned.clone())
        .await
        .unwrap();
    log.record_operation_cleanup(
        &failed_cleanup,
        OperationCleanup::Failed {
            diagnostic: "retry".into(),
        },
    )
    .await
    .unwrap();

    // rev 5: intent + fully settled operation (Returned + Confirmed) -> releasable.
    let settled_req = op_request(sources[4].clone(), consumer.clone());
    log.record_application_intent(
        sources[4].clone(),
        settled_req.consumer.clone(),
        settled_req.reference().unwrap(),
        serde_json::Value::Null,
    )
    .await
    .unwrap();
    let settled = match log.dispatch_operation(settled_req).await.unwrap() {
        Dispatch::New(claim) => claim,
        Dispatch::Existing(_) => unreachable!(),
    };
    log.start_operation(&settled).unwrap();
    log.record_operation_outcome(&settled, returned.clone())
        .await
        .unwrap();
    log.record_operation_cleanup(&settled, OperationCleanup::Confirmed)
        .await
        .unwrap();
    // rev 6: no operations or intents -> releasable; rev 7: launched.

    let contents_before = count(&log, "SELECT count(*) FROM contents").await;
    for _ in 0..2 {
        log.release_superseded_application_sources(&sources[6])
            .await
            .unwrap();
    }

    for retained in [0, 1, 2, 3, 6] {
        assert!(
            log.load_application_at(&sources[retained])
                .await
                .unwrap()
                .is_some(),
            "revision {} must remain available",
            retained + 1
        );
    }
    for dropped in [4, 5] {
        assert!(
            log.load_application_at(&sources[dropped])
                .await
                .unwrap()
                .is_none(),
            "revision {} should be released",
            dropped + 1
        );
    }
    // 5 remaining app revisions + 1 shared package.
    assert_eq!(
        count(&log, "SELECT count(*) FROM application_packages").await,
        6
    );
    assert!(count(&log, "SELECT count(*) FROM contents").await < contents_before);

    // Once Unknown and Failed operations settle, their revisions release too.
    log.record_operation_outcome(&unknown, returned)
        .await
        .unwrap();
    log.record_operation_cleanup(&failed_cleanup, OperationCleanup::Confirmed)
        .await
        .unwrap();
    log.release_superseded_application_sources(&sources[6])
        .await
        .unwrap();
    assert!(
        log.load_application_at(&sources[2])
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        log.load_application_at(&sources[3])
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        count(&log, "SELECT count(*) FROM application_packages").await,
        4
    );

    drop((unresolved, unknown, failed_cleanup, settled));
    log.close().await.unwrap();
}
