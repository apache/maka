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
use maka_protocol::OperationErrorCode;

#[tokio::test]
async fn reviewed_package_mutations_reject_changed_source_generation_and_digest_before_effects() {
    let host = Running::new(Arc::new(Loader)).await;
    let source = host._directory.path().join("source.maka-extension");
    package().export_to(&source).unwrap();
    let value = host
        .execute(
            WireOperation::PluginPackagePreview,
            json!({"sourcePath":source}),
        )
        .await
        .unwrap();
    let preview: PackagePreview = serde_json::from_value(value).unwrap();
    assert_eq!(preview.package.content_digest, package().digest());
    assert!(preview.package.has_runtime && preview.package.has_composition);
    assert!(!preview.package.has_client);
    assert_eq!(preview.expected.base_generation, 0);
    assert!(preview.expected.content_digest.is_none());
    assert!(host.log.plugin_packages().await.unwrap().is_empty());
    assert_eq!(host.platform.snapshot().ledger.generation, 0);
    assert!(!WireOperation::PluginPackagePreview.allows_remote_owner());

    let mut files = package().files().clone();
    files.insert("index.mjs".into(), b"replacement bytes".to_vec());
    let replacement = Package::new(files).unwrap();
    std::fs::write(&source, replacement.to_bundle()).unwrap();
    let install = json!({"sourcePath":source,"sourceDigest":preview.package.content_digest,"expected":preview.expected});
    let error = host
        .execute(WireOperation::PluginPackageInstall, install.clone())
        .await
        .unwrap_err();
    assert_eq!(error.code, OperationErrorCode::OperationConflict);
    assert!(host.log.plugin_packages().await.unwrap().is_empty());
    assert_eq!(host.log.plugin_composition().await.unwrap().generation, 0);

    // Restoring bytes to the reviewed content makes the original source review
    // valid; neither file path nor mtime substitutes for content identity.
    std::fs::write(&source, package().to_bundle()).unwrap();
    host.execute(WireOperation::PluginPackageInstall, install.clone())
        .await
        .unwrap();
    let error = host
        .execute(WireOperation::PluginPackageInstall, install)
        .await
        .unwrap_err();
    assert_eq!(error.code, OperationErrorCode::OperationConflict);
    assert_eq!(host.platform.snapshot().ledger.generation, 1);
    let mut updates = host.platform.subscribe();
    tokio::time::timeout(Duration::from_secs(2), async {
        while !host.platform.snapshot().runtime.converged {
            updates.changed().await.unwrap();
        }
    })
    .await
    .unwrap();
    let before = host.platform.snapshot();
    for operation in [
        WireOperation::PluginPackageReload,
        WireOperation::PluginPackageUninstall,
    ] {
        for expected in [
            json!({"baseGeneration":0,"contentDigest":package().digest()}),
            json!({"baseGeneration":1,"contentDigest":replacement.digest()}),
            json!({"baseGeneration":1,"contentDigest":null}),
        ] {
            let error = host
                .execute(
                    operation,
                    json!({"extensionId":"example","expected":expected}),
                )
                .await
                .unwrap_err();
            assert_eq!(error.code, OperationErrorCode::OperationConflict);
            assert_eq!(host.platform.snapshot().ledger, before.ledger);
            assert_eq!(host.platform.snapshot().runtime, before.runtime);
            assert_eq!(host.log.plugin_composition().await.unwrap(), before.ledger);
            assert_eq!(
                host.log
                    .plugin_package("example")
                    .await
                    .unwrap()
                    .unwrap()
                    .digest(),
                package().digest()
            );
        }
    }
    // Correct-generation install still rejects the wrong installed target.
    let error = host
        .execute(
            WireOperation::PluginPackageInstall,
            json!({
                "sourcePath":source,"sourceDigest":package().digest(),
                "expected":{"baseGeneration":1,"contentDigest":replacement.digest()}
            }),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, OperationErrorCode::OperationConflict);
    assert_eq!(host.platform.snapshot().ledger, before.ledger);

    // Restart is based only on stored bytes and intentionally does not advance
    // durable intent. The current source can change without updating the package.
    std::fs::write(&source, replacement.to_bundle()).unwrap();
    let restarted = host.execute(WireOperation::PluginPackageReload, json!({
        "extensionId":"example","expected":{"baseGeneration":1,"contentDigest":package().digest()}
    })).await.unwrap();
    assert_eq!(restarted["authorityEpoch"], 1);
    assert_eq!(restarted["durability"], "committed");
    assert_eq!(
        host.log
            .plugin_package("example")
            .await
            .unwrap()
            .unwrap()
            .digest(),
        package().digest()
    );
    host.uninstall("example").await.unwrap();
    assert!(host.log.plugin_packages().await.unwrap().is_empty());
    host.finish().await;
}
