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
use std::path::Path;

const PACKAGE: &str = "example.workhub-notes";

pub(super) async fn install(client: &maka_client::Client, directory: &Path) {
    let package = directory.join("workhub-notes-plugin");
    std::fs::create_dir(&package).unwrap();
    std::fs::write(
        package.join("host.mjs"),
        include_str!("../../../fixtures/workhub-notes-plugin/host.mjs"),
    )
    .unwrap();
    std::fs::write(
        package.join("maka.extension.json"),
        json!({"schemaVersion":1,"id":PACKAGE,"runtime":{"entry":"host.mjs","sdkVersion":1}})
            .to_string(),
    )
    .unwrap();
    client
        .request(
            Operation::PluginPackageInstall,
            json!({"sourcePath":package}),
        )
        .await
        .unwrap();
    client.request(Operation::PluginCompositionApply, json!({"operations":[{"type":"insert","rootId":"profile","entry":{"id":"workhub-notes","packageId":PACKAGE}}]})).await.unwrap();
}

pub(super) async fn context(client: &maka_client::Client, assignment: &str, source: &str) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let value = readback::remote(client, PACKAGE, "stats", Value::Null).await;
            if value["contexts"]
                .as_array()
                .unwrap()
                .contains(&json!({"assignmentId":assignment,"sourceSessionId":source}))
                && value["liveStreams"].as_u64().unwrap() > 0
            {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("exact task context and independent child observation");
}

pub(super) async fn notify(client: &maka_client::Client, assignment: &str) {
    let before = readback::remote(client, PACKAGE, "stats", Value::Null).await;
    readback::remote(
        client,
        PACKAGE,
        "review",
        json!({"assignmentId":assignment}),
    )
    .await;
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let after = readback::remote(client, PACKAGE, "stats", Value::Null).await;
            if after["reads"].as_u64().unwrap() > before["reads"].as_u64().unwrap() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("child changes stream did not refresh its view");
}

pub(super) async fn saved(client: &maka_client::Client, alpha: &str, beta: &str) {
    let notes = readback::remote(client, PACKAGE, "notes", Value::Null).await;
    assert_eq!(notes[alpha]["note"], "alpha private draft");
    assert_eq!(notes[beta]["note"], "beta private draft");
}

pub(super) async fn disable(client: &maka_client::Client, assignment: &str, source: &str) {
    // Pin an old action target. Retirement must revoke it, as well as remove
    // the visible controls and settle all child observation streams.
    let binding = RemoteBinding::Package {
        package_id: PACKAGE.into(),
        method: "notes-view".into(),
        session_id: None,
    };
    let RemoteResult::Bound { target, .. } = client
        .plugin_remote(RemoteRequest::Bind {
            binding: binding.clone(),
        })
        .await
        .unwrap()
    else {
        panic!("bound filler")
    };
    let RemoteResult::Document { document } = client
        .plugin_remote(RemoteRequest::OpenDocument)
        .await
        .unwrap()
    else {
        panic!("document")
    };
    client.request(Operation::PluginCompositionApply, json!({"operations":[{"type":"update","entryId":"workhub-notes","patch":{"disabled":true}}]})).await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let status = client
                .request(Operation::PluginPlatformQuery, json!({"view":"status"}))
                .await
                .unwrap();
            let entries = client
                .request(
                    Operation::PluginPlatformQuery,
                    json!({"view":"entries","rootId":"profile","limit":64}),
                )
                .await
                .unwrap();
            let entry = entries["items"]
                .as_array()
                .unwrap()
                .iter()
                .find(|entry| entry["id"] == "workhub-notes");
            if status["convergence"] == "converged"
                && entry.is_some_and(|entry| entry["status"] == "disabled")
            {
                break;
            }
            assert_ne!(
                status["phase"], "fenced",
                "filler retirement failed: {status}"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("filler retirement did not settle");
    let retired = client.plugin_remote(RemoteRequest::Call {
        binding, target, document,
        input: json!({"kind":"read","route":{"assignmentId":assignment,"sourceSessionId":source},"locale":"en"}),
    }).await.unwrap_err();
    assert!(
        matches!(retired, maka_client::RequestFailure::Rejected(maka_client::ClientError::Rejected(ref error))
        if error.code == maka_protocol::OperationErrorCode::OperationConflict),
        "retired filler must reject the pinned target, not fail its input: {retired:?}"
    );
    client
        .plugin_remote(RemoteRequest::CloseDocument { document })
        .await
        .unwrap();
}
