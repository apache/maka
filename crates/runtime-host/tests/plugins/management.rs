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
use maka_protocol::{Operation as WireOperation, OperationError, plugin::*};

#[path = "management/preconditions.rs"]
mod preconditions;

struct Running {
    platform: Platform,
    log: Arc<EventLog>,
    shutdown: CancellationToken,
    owner: tokio::task::JoinHandle<Result<(), maka_runtime_host::plugins::Error>>,
    _directory: tempfile::TempDir,
}
impl Running {
    async fn new(loader: Arc<dyn PackageLoader>) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let log = Arc::new(
            EventLog::open(&directory.path().join("platform.sqlite"))
                .await
                .unwrap(),
        );
        let shutdown = CancellationToken::new();
        let (platform, owner) = Platform::open(
            log.clone(),
            loader,
            BTreeMap::new(),
            BTreeMap::new(),
            maka_plugins::kernel::Kernel::new(Services::default(), Catalog::default()),
            shutdown.clone(),
        )
        .await
        .unwrap();
        Self {
            platform,
            log,
            shutdown,
            owner: tokio::spawn(owner),
            _directory: directory,
        }
    }
    async fn install(&self, package: Package) {
        self.platform
            .mutate(Mutation::Install {
                package,
                expected: None,
            })
            .await
            .unwrap();
    }
    async fn apply(&self, operations: Value) {
        self.platform
            .mutate(Mutation::Apply {
                base_generation: Some(self.platform.snapshot().ledger.generation),
                operations: serde_json::from_value(operations).unwrap(),
            })
            .await
            .unwrap();
    }
    async fn execute(
        &self,
        operation: WireOperation,
        value: Value,
    ) -> Result<Value, OperationError> {
        let result = self
            .platform
            .execute(decode_input(operation, &value).unwrap())
            .await?;
        decode_output(operation, &result).unwrap();
        Ok(result)
    }
    async fn uninstall(&self, id: &str) -> Result<Value, OperationError> {
        let snapshot = self.platform.snapshot();
        self.execute(
            WireOperation::PluginPackageUninstall,
            json!({
                "extensionId":id,"expected":{"baseGeneration":snapshot.ledger.generation,
                "contentDigest":snapshot.packages.get(id).map(|package| package.digest())}
            }),
        )
        .await
    }
    async fn finish(self) {
        self.shutdown.cancel();
        self.owner.await.unwrap().unwrap();
        self.log.shutdown().await.unwrap();
    }
}

fn other_package(id: &str, dependencies: Value) -> Package {
    Package::new(BTreeMap::from([
        (
            MANIFEST_FILE.into(),
            serde_json::to_vec(&json!({
                "schemaVersion":1,"id":id,"runtime":{"entry":"index.mjs","sdkVersion":1},
                "dependencies":dependencies
            }))
            .unwrap(),
        ),
        ("index.mjs".into(), b"fixed code".to_vec()),
    ]))
    .unwrap()
}

#[tokio::test]
async fn package_layer_uninstall_removes_only_its_obsolete_overlays() {
    let host = Running::new(Arc::new(Loader)).await;
    host.install(package()).await;
    host.apply(json!([
        {"type":"insert","entry":{"id":"unrelated","config":{"keep":true}}},
        {"type":"update","entryId":"example","patch":{"disabled":true,"config":{"changed":true}}}
    ]))
    .await;
    host.uninstall("example").await.unwrap();
    let snapshot = host.platform.snapshot();
    assert!(snapshot.packages.is_empty());
    assert!(snapshot.desired.find("example").is_none());
    assert_eq!(
        snapshot.desired.find("unrelated").unwrap().1.config,
        json!({"keep":true})
    );
    assert_eq!(snapshot.ledger.overlays.len(), 1);
    assert_eq!(
        host.log.plugin_composition().await.unwrap(),
        snapshot.ledger
    );
    assert!(host.log.plugin_package("example").await.unwrap().is_none());
    // Remove overlays were the other permanent MissingEntry failure, including
    // a preceding update separated from it by the structural operation.
    host.install(package()).await;
    host.apply(json!([
        {"type":"update","entryId":"example","patch":{"config":"changed"}},
        {"type":"remove","entryId":"example"}
    ]))
    .await;
    host.uninstall("example").await.unwrap();
    assert_eq!(host.platform.snapshot().desired, snapshot.desired);
    assert_eq!(
        host.platform.snapshot().ledger.overlays,
        snapshot.ledger.overlays
    );
    host.finish().await;
}

#[tokio::test]
async fn package_removal_rejects_dependents_and_foreign_structural_intent_atomically() {
    for scenario in ["child", "retarget", "dependent"] {
        let host = Running::new(Arc::new(Loader)).await;
        host.install(package()).await;
        host.install(other_package("other", json!([]))).await;
        match scenario {
            "child" => {
                host.apply(json!([{"type":"insert","parentId":"example",
                "entry":{"id":"foreign","packageId":"other"}}]))
                    .await
            }
            "retarget" => {
                host.apply(json!([{"type":"update","entryId":"example",
                "patch":{"packageId":"other"}}]))
                    .await
            }
            "dependent" => {
                host.install(other_package("dependent", json!([{"id":"example"}])))
                    .await
            }
            _ => unreachable!(),
        }
        let before = host.platform.snapshot();
        assert!(host.uninstall("example").await.is_err(), "{scenario}");
        assert_eq!(host.platform.snapshot().ledger, before.ledger, "{scenario}");
        assert_eq!(
            host.platform.snapshot().desired,
            before.desired,
            "{scenario}"
        );
        assert_eq!(
            host.log.plugin_composition().await.unwrap(),
            before.ledger,
            "{scenario}"
        );
        assert_eq!(
            host.log
                .plugin_package("example")
                .await
                .unwrap()
                .unwrap()
                .digest(),
            package().digest(),
            "{scenario}"
        );
        assert!(host.log.plugin_package("other").await.unwrap().is_some());
        if scenario == "dependent" {
            assert!(
                host.log
                    .plugin_package("dependent")
                    .await
                    .unwrap()
                    .is_some()
            );
        }
        host.finish().await;
    }
}

struct RequirementsLoader;
impl PackageLoader for RequirementsLoader {
    fn definition(&self, package: &Package) -> Result<Arc<Definition>, maka_plugins::Error> {
        if package.manifest().id == "unavailable" {
            return Err(maka_plugins::Error::Invalid(
                "definition unavailable".into(),
            ));
        }
        Ok(Arc::new(Definition {
            id: package.manifest().id.clone(),
            revision: package.digest().into(),
            dependencies: Vec::new(),
            inject: vec!["clock".into()],
            plugin: Arc::new(Example),
        }))
    }
}

#[tokio::test]
async fn entry_management_projection_keeps_local_and_effective_intent_at_one_generation() {
    let host = Running::new(Arc::new(RequirementsLoader)).await;
    host.install(other_package("known", json!([]))).await;
    host.install(other_package("unavailable", json!([]))).await;
    host.apply(json!([{"type":"insert","entry":{"id":"parent","disabled":true,"children":[
        {"id":"known","packageId":"known","inject":["extra"],"isolate":{"clock":"team"},"intercept":{"clock":{"mode":"x"}}},
        {"id":"unavailable","packageId":"unavailable"}
    ]}}])).await;
    let result = host
        .execute(
            WireOperation::PluginPlatformQuery,
            json!({"view":"entries"}),
        )
        .await
        .unwrap();
    let QueryResult::Entries(page) = serde_json::from_value(result).unwrap() else {
        panic!("entries");
    };
    let known = page.items.iter().find(|entry| entry.id == "known").unwrap();
    assert!(!known.local_disabled);
    assert!(known.disabled);
    assert_eq!(
        known.required_services.as_deref(),
        Some(["clock".to_string()].as_slice())
    );
    assert_eq!(known.inject.names().collect::<Vec<_>>(), ["extra"]);
    assert_eq!(
        serde_json::to_value(&known.isolate).unwrap(),
        json!({"clock":"team"})
    );
    assert_eq!(
        serde_json::to_value(&known.intercept).unwrap(),
        json!({"clock":{"mode":"x"}})
    );
    assert!(page.items.iter().all(|entry| entry.base_generation == 3));
    assert!(
        page.items
            .iter()
            .find(|entry| entry.id == "unavailable")
            .unwrap()
            .required_services
            .is_none()
    );
    host.apply(json!([
        {"type":"update","entryId":"unavailable","patch":{"disabled":true}},
        {"type":"update","entryId":"parent","patch":{"disabled":false}}
    ]))
    .await;
    let result = host
        .execute(
            WireOperation::PluginPlatformQuery,
            json!({"view":"entries"}),
        )
        .await
        .unwrap();
    let QueryResult::Entries(page) = serde_json::from_value(result).unwrap() else {
        panic!("entries");
    };
    let known = page.items.iter().find(|entry| entry.id == "known").unwrap();
    assert!(!known.disabled && !known.local_disabled);
    assert_eq!(known.base_generation, 4);
    host.finish().await;
}
