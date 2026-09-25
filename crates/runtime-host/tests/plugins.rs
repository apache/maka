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

use futures_util::{FutureExt, future::BoxFuture};
use maka_event_log::EventLog;
use maka_plugins::{
    composition::{Operation, Scope},
    contributions::{Catalog, Staged},
    kernel::{Definition, Plugin, PluginContext},
    package::{MANIFEST_FILE, Package},
    services::Services,
};
use maka_runtime_host::plugins::{Mutation, PackageLoader, Platform};
use serde_json::{Value, json};
use std::{collections::BTreeMap, sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;

#[path = "plugins/management.rs"]
mod management;

struct Loader;
impl PackageLoader for Loader {
    fn definition(&self, package: &Package) -> Result<Arc<Definition>, maka_plugins::Error> {
        Ok(Arc::new(Definition {
            id: package.manifest().id.clone(),
            revision: package.digest().into(),
            dependencies: package
                .manifest()
                .dependencies
                .iter()
                .map(|dependency| dependency.id.clone())
                .collect(),
            inject: Vec::new(),
            plugin: Arc::new(Example),
        }))
    }
}
struct Example;
impl Plugin for Example {
    fn activate(
        &self,
        _: PluginContext,
        config: Value,
    ) -> BoxFuture<'static, Result<Staged, String>> {
        Box::pin(async move {
            if config == "fail" {
                return Err("activation deliberately rejected".into());
            }
            let mut staged = Staged::default();
            staged
                .insert("example", config)
                .map_err(|error| error.to_string())?;
            Ok(staged)
        })
    }
}
fn package() -> Package {
    Package::new(BTreeMap::from([
        (
            MANIFEST_FILE.into(),
            serde_json::to_vec(&json!({
                "schemaVersion":1, "id":"example", "runtime":{"entry":"index.mjs","sdkVersion":1},
                "composition":{"patch":"maka.composition.yml"}
            }))
            .unwrap(),
        ),
        ("index.mjs".into(), b"fixed code".to_vec()),
        (
            "maka.composition.yml".into(),
            b"- type: insert\n  entry:\n    id: example\n    packageId: example\n".to_vec(),
        ),
    ]))
    .unwrap()
}

#[tokio::test]
async fn accepted_plugin_mutations_survive_lost_waiters_and_activation_failure_is_not_rollback() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("platform.sqlite");
    let log = Arc::new(EventLog::open(&path).await.unwrap());
    let catalog = Catalog::default();
    let shutdown = CancellationToken::new();
    let (platform, owner) = Platform::open(
        log.clone(),
        Arc::new(Loader),
        BTreeMap::new(),
        BTreeMap::new(),
        maka_plugins::kernel::Kernel::new(Services::default(), catalog.clone()),
        shutdown.clone(),
    )
    .await
    .unwrap();
    let owner = tokio::spawn(owner);
    let mut updates = platform.subscribe();
    // Queue accepted, response receiver lost: the owner still commits and publishes.
    assert!(
        platform
            .mutate(Mutation::Install {
                package: package(),
                expected: None
            })
            .now_or_never()
            .is_none()
    );
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let snapshot = updates.borrow().clone();
            if snapshot.ledger.generation == 1 && snapshot.runtime.converged {
                break;
            }
            updates.changed().await.unwrap();
        }
    })
    .await
    .unwrap();
    let original = catalog.snapshot::<Value>(&Scope::Profile);
    for view in [
        "status",
        "packages",
        "entries",
        "tools",
        "commands",
        "executors",
        "failures",
    ] {
        let operation = maka_protocol::Operation::PluginPlatformQuery;
        let input =
            maka_protocol::plugin::decode_input(operation, &json!({ "view": view })).unwrap();
        let output = platform.execute(input).await.unwrap();
        maka_protocol::plugin::decode_output(operation, &output).unwrap();
        if view == "entries" {
            assert_eq!(output["items"][0]["status"], "active");
            assert!(output["items"][0]["generation"].as_u64().is_some());
        }
    }
    let activation = original.entries["example"]
        .owner
        .identity()
        .unwrap()
        .activation;
    let update: Operation = serde_json::from_value(
        json!({"type":"update","entryId":"example","patch":{"config":"fail"}}),
    )
    .unwrap();
    let committed = platform
        .mutate(Mutation::Apply {
            base_generation: Some(1),
            operations: vec![update],
        })
        .await
        .unwrap();
    assert_eq!(committed.ledger.generation, 2);
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if platform
                .snapshot()
                .runtime
                .entries
                .iter()
                .any(|entry| entry.error.is_some())
            {
                break;
            }
            updates.changed().await.unwrap();
        }
    })
    .await
    .unwrap();
    assert_eq!(log.plugin_composition().await.unwrap().generation, 2);
    assert!(original.entries["example"].admit().is_err());
    assert!(
        platform
            .mutate(Mutation::Apply {
                base_generation: Some(1),
                operations: vec![]
            })
            .await
            .is_err()
    );
    shutdown.cancel();
    owner.await.unwrap().unwrap();
    log.shutdown().await.unwrap();

    let log = Arc::new(EventLog::open(&path).await.unwrap());
    let shutdown = CancellationToken::new();
    let catalog = Catalog::default();
    let (platform, owner) = Platform::open(
        log.clone(),
        Arc::new(Loader),
        BTreeMap::new(),
        BTreeMap::new(),
        maka_plugins::kernel::Kernel::new(Services::default(), catalog.clone()),
        shutdown.clone(),
    )
    .await
    .unwrap();
    let owner = tokio::spawn(owner);
    let mut updates = platform.subscribe();
    let update = serde_json::from_value(
        json!({"type":"update","entryId":"example","patch":{"config":"restored"}}),
    )
    .unwrap();
    platform
        .mutate(Mutation::Apply {
            base_generation: Some(2),
            operations: vec![update],
        })
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        while !platform.snapshot().runtime.converged {
            updates.changed().await.unwrap();
        }
    })
    .await
    .unwrap();
    let restored = catalog.snapshot::<Value>(&Scope::Profile);
    assert_ne!(
        restored.entries["example"]
            .owner
            .identity()
            .unwrap()
            .activation,
        activation
    );
    assert_eq!(*restored.entries["example"].value, json!("restored"));
    shutdown.cancel();
    owner.await.unwrap().unwrap();
    log.shutdown().await.unwrap();
}
