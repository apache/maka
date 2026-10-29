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
use maka_capabilities::call::{Attachments, Identity, Issuer};
use maka_event_log::{
    RootStore,
    root::{RootNamespaces, RootOwner},
};
use maka_host_runtime::application::{
    Application, Binding, Invocation, NativeActivation, NativeRegistry, Policy,
};
use maka_packages::Package;
use maka_plugin_core::composition::InstanceId;
use serde_json::json;
use std::collections::BTreeMap;
use tokio_util::sync::CancellationToken;

struct Grant(Issuer);
impl Policy for Grant {
    fn admit(&self, invocation: Invocation<'_>) -> Result<(), String> {
        self.0
            .owns(invocation.scope)
            .then_some(())
            .ok_or("foreign scope".into())
    }
}

struct Fixture {
    _directory: tempfile::TempDir,
    configuration: Arc<maka_config::ConfigurationStore>,
    log: Arc<RootStore>,
    app: Application,
    issuer: Issuer,
    binding: Binding,
}
impl Fixture {
    async fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let root = Arc::new(
            RootOwner::create(
                &directory.path().join("root"),
                &RootNamespaces {
                    ownership: directory.path().join("owners"),
                    control: directory.path().join("control"),
                },
            )
            .unwrap(),
        );
        let configuration = Arc::new(
            maka_config::ConfigurationStore::for_root(root.clone())
                .await
                .unwrap(),
        );
        let log = Arc::new(RootStore::open(root).await.unwrap());
        let package = |id, implementation, imports, exports| {
            Package::new(BTreeMap::from([(
                "maka.extension.json".into(),
                serde_json::to_vec(&json!({
                    "schemaVersion":1,"id":id,"application":{"host":{
                        "implementation":{"kind":"native","implementation":implementation},
                        "configuration":{"type":"object","additionalProperties":false},
                        "imports":imports,"exports":exports
                    }}
                }))
                .unwrap(),
            )]))
            .unwrap()
        };
        let contract = crate::contract::contract();
        let settings = package(
            "test.settings",
            crate::IMPLEMENTATION,
            json!({}),
            json!({
                crate::EXPORT:{"contract":contract,"availability":"required"}
            }),
        );
        let caller = package(
            "test.caller",
            "test.caller",
            json!({
                "settings":{"contract":contract,"cardinality":{"kind":"one"}}
            }),
            json!({}),
        );
        let caller_key = "00000000-0000-4000-8000-000000000002";
        let deployment = "00000000-0000-4000-8000-000000000003".parse().unwrap();
        log.commit_application(deployment, 0, serde_json::from_value(json!({"instances":{
            "settings":{"key":"00000000-0000-4000-8000-000000000001","package":{"source":"pinned","package":settings.application_ref()},"usePackage":"host"},
            "caller":{"key":caller_key,"package":{"source":"pinned","package":caller.application_ref()},"usePackage":"host",
                "bindings":{"settings":[{"kind":"instance","path":["settings"],"export":crate::EXPORT}]}}
        }})).unwrap(), vec![], vec![settings, caller]).await.unwrap();
        let mut registry = NativeRegistry::default();
        crate::provide(
            &mut registry,
            Arc::new(maka_providers::catalog::Catalog::new(
                maka_providers::catalog::Snapshot::bundled().unwrap(),
            )),
        )
        .unwrap();
        registry
            .insert(
                "test.caller".into(),
                Arc::new(|_, _| {
                    Box::pin(async {
                        NativeActivation {
                            exports: Ok(BTreeMap::new()),
                            owner: Arc::new(()),
                        }
                    })
                }),
            )
            .unwrap();
        let issuer = Issuer::default();
        let app = Application::start_from_store(
            log.clone(),
            deployment,
            registry,
            issuer.clone(),
            Arc::new(Grant(issuer.clone())),
            None,
        )
        .await
        .unwrap();
        app.ready().await.unwrap();
        let client = app.client();
        let caller_id: InstanceId = serde_json::from_value(json!([caller_key])).unwrap();
        let binding = client
            .bind(client.activation(&caller_id).unwrap(), "settings".into())
            .await
            .unwrap()
            .remove(0);
        Self {
            _directory: directory,
            configuration,
            log,
            app,
            issuer,
            binding,
        }
    }
    async fn add(
        &self,
        slug: &str,
        name: &str,
        ids: Vec<String>,
        overrides: Value,
    ) -> ConnectionVersionBasis {
        let revision = self.configuration.catalog().await.unwrap().revision;
        let CatalogMutationResult::Committed { connection:Some(basis), .. } = self.configuration.create_connection(
            serde_json::from_value(json!({"expectedCatalogRevision":revision,"connection":{
                "slug":slug,"name":name,"provider":{"packageId":maka_providers::api::ID,"entryId":maka_providers::api::ID,"scope":"profile","name":"openai-compatible"},
                "configuration":{"baseUrl":"https://private.example/v1"},"enabled":true,"enabledModelIds":ids,
                "modelOverrides":overrides,"requestBodyOverlay":{"privateMarker":"private-fixture-key"}
            }})).unwrap()).await.unwrap() else { panic!("connection commit"); };
        basis
    }
    async fn models(&self, input: Value) -> Result<Value, String> {
        let scope = self
            .issuer
            .issue(
                Identity::Remote {
                    request_id: Default::default(),
                },
                CancellationToken::new(),
            )
            .unwrap();
        self.app
            .client()
            .start(
                self.binding.clone(),
                "models".into(),
                input,
                scope,
                Attachments::new().into(),
            )
            .await?
            .result()
            .await
    }
    async fn set_default(&self, target: ConnectionTarget) {
        let expected_catalog_revision = self.configuration.catalog().await.unwrap().revision;
        assert!(matches!(
            self.configuration
                .set_default_target(SetDefaultConnectionTargetInput {
                    expected_catalog_revision,
                    target: Some(target),
                })
                .await
                .unwrap(),
            CatalogMutationResult::Committed { .. }
        ));
    }
    async fn finish(self) {
        self.app.shutdown().await.unwrap();
        self.configuration.shutdown().await.unwrap();
        self.log.drain().await;
    }
}

#[tokio::test]
async fn pages_keep_the_root_default_independent_of_the_visible_page_and_fence_old_cursors() {
    let first = Fixture::new().await;
    first
        .add(
            "first",
            "First",
            (0..20).map(|i| format!("model-{i:02}")).collect(),
            json!({}),
        )
        .await;
    let page = first.models(json!({"kind":"start"})).await.unwrap();
    assert_eq!(page["defaultModel"], json!({"kind":"none"}));
    assert_eq!(page["choices"].as_array().unwrap().len(), 16);
    assert!(!page.to_string().contains("private-fixture-key"));
    assert!(!page.to_string().contains("baseUrl"));
    let continuation = json!({"kind":"continue","revision":page["revision"],"cursor":page["next"]});
    let last = first.models(continuation.clone()).await.unwrap();
    assert_eq!(last["choices"].as_array().unwrap().len(), 4);
    assert!(last["next"].is_null());
    first
        .set_default(ConnectionTarget {
            connection_id: page["choices"][0]["selection"]["connectionId"]
                .as_str()
                .unwrap()
                .into(),
            model_id: "model-19".into(),
        })
        .await;
    assert_eq!(first.models(continuation).await.unwrap()["kind"], "changed");
    let updated = first.models(json!({"kind":"start"})).await.unwrap();
    assert_eq!(
        updated["defaultModel"]["choice"]["selection"]["modelId"],
        "model-19"
    );
    assert_eq!(
        updated["defaultModel"]["choice"]["selection"]["revision"],
        updated["choices"][0]["selection"]["revision"]
    );
    assert!(
        !updated["choices"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["selection"]["modelId"] == "model-19")
    );
    assert!(first.models(json!({"kind":"continue","revision":updated["revision"],"cursor":{"connection":0,"model":4000}})).await.is_err());
    let revision = first.configuration.catalog().await.unwrap().revision;
    let CatalogMutationResult::Committed { connection:Some(unsupported), .. } = first.configuration.create_connection(serde_json::from_value(json!({
        "expectedCatalogRevision":revision,"connection":{"slug":"unsupported","name":"Unsupported","provider":{"packageId":"example.models","entryId":"models","scope":"profile","name":"custom"},"configuration":{},"enabled":true,"enabledModelIds":["unavailable"]}
    })).unwrap()).await.unwrap() else { panic!("unsupported provider commit"); };
    let target = ConnectionTarget {
        connection_id: unsupported.connection_id,
        model_id: "unavailable".into(),
    };
    first.set_default(target.clone()).await;
    assert_eq!(
        first.models(json!({"kind":"start"})).await.unwrap()["defaultModel"],
        json!({"kind":"unavailable","target":target})
    );
    assert_eq!(
        first.configuration.catalog().await.unwrap().default_target,
        Some(target)
    );
    first.finish().await;
}

#[tokio::test]
async fn search_reaches_sparse_matches_and_eof_and_keeps_its_query_under_revision_fences() {
    let f = Fixture::new().await;
    let term = format!("{}終", "界".repeat(257));
    let basis = f
        .add(
            "research",
            &format!("Research {term}"),
            (0..300).map(|i| format!("model-{i:03}")).collect(),
            json!({}),
        )
        .await;
    let page = f
        .models(json!({"kind":"start","query":format!("RESEARCH {term}")}))
        .await
        .unwrap();
    assert_eq!(page["choices"].as_array().unwrap().len(), 16);
    assert_eq!(page["next"]["query"], format!("RESEARCH {term}"));
    let continuation = json!({"kind":"continue","revision":page["revision"],"cursor":page["next"]});
    let found = f
        .models(json!({"kind":"start","query":format!("RESEARCH {term} model-299")}))
        .await
        .unwrap();
    assert_eq!(found["choices"].as_array().unwrap().len(), 1);
    assert_eq!(found["choices"][0]["selection"]["modelId"], "model-299");
    assert!(found["next"].is_null());
    for query in [
        format!("RESEARCH {}異 model-299", "界".repeat(257)),
        "research missing-token".into(),
    ] {
        let missing = f
            .models(json!({"kind":"start","query":query}))
            .await
            .unwrap();
        assert_eq!(missing["choices"], json!([]));
        assert!(missing["next"].is_null());
    }
    let matches = f
        .models(json!({"kind":"start","query":"MoDeL-29"}))
        .await
        .unwrap();
    assert_eq!(
        matches["choices"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["selection"]["modelId"].as_str().unwrap())
            .collect::<Vec<_>>(),
        (290..300).map(|i| format!("model-{i}")).collect::<Vec<_>>()
    );
    assert!(matches["next"].is_null());
    assert!(
        f.models(json!({"kind":"start","query":null}))
            .await
            .is_err()
    );
    f.configuration
        .update_connection(UpdateCatalogConnectionInput {
            expected: basis,
            changes: ConnectionCatalogEntryUpdate {
                name: Some("Renamed".into()),
                ..Default::default()
            },
        })
        .await
        .unwrap();
    assert_eq!(f.models(continuation).await.unwrap()["kind"], "changed");
    f.finish().await;
}

#[tokio::test]
async fn connection_filter_keeps_identical_model_ids_and_the_unfiltered_default_across_pages() {
    let f = Fixture::new().await;
    let ids: Vec<_> = (0..20).map(|i| format!("family/shared.{i:02}")).collect();
    let first = f.add("first", "OpenRouter", ids.clone(), json!({
        "family/shared.00":{"contextWindow":8192}, "family/shared.01":{"contextWindow":16384}
    })).await;
    let custom = f
        .add("custom", "Custom connection", ids.clone(), json!({}))
        .await;
    f.set_default(ConnectionTarget {
        connection_id: first.connection_id.clone(),
        model_id: ids[0].clone(),
    })
    .await;
    let summaries = f.configuration.connection_summaries().await.unwrap();
    assert_eq!(
        summaries
            .connections
            .iter()
            .map(|row| (row.name.as_str(), row.enabled_model_count))
            .collect::<Vec<_>>(),
        [("OpenRouter", 20), ("Custom connection", 20)]
    );
    let scoped = f
        .configuration
        .model_catalog(Some(&custom.connection_id))
        .await
        .unwrap();
    let default = scoped
        .connections
        .iter()
        .find(|row| row.connection_id == first.connection_id)
        .unwrap();
    assert_eq!(default.enabled_model_ids, ["family/shared.00"]);
    assert_eq!(
        default
            .model_overrides
            .as_ref()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        ["family/shared.00"]
    );
    let all = f
        .models(json!({"kind":"start","query":"family/shared.00"}))
        .await
        .unwrap();
    assert_eq!(
        all["choices"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["connectionName"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["OpenRouter", "Custom connection"]
    );
    let page = f
        .models(json!({"kind":"start","query":"shared","connectionId":custom.connection_id}))
        .await
        .unwrap();
    assert_eq!(page["choices"].as_array().unwrap().len(), 16);
    assert_eq!(page["next"]["connectionId"], custom.connection_id);
    assert_eq!(page["next"]["query"], "shared");
    assert_eq!(
        page["defaultModel"]["choice"]["limits"]["contextWindow"],
        8192
    );
    assert_eq!(
        page["defaultModel"]["choice"]["selection"]["connectionId"],
        first.connection_id
    );
    assert_eq!(
        page["defaultModel"]["choice"]["selection"]["modelId"],
        "family/shared.00"
    );
    let last = f
        .models(json!({"kind":"continue","revision":page["revision"],"cursor":page["next"]}))
        .await
        .unwrap();
    let choices: Vec<_> = page["choices"]
        .as_array()
        .unwrap()
        .iter()
        .chain(last["choices"].as_array().unwrap())
        .collect();
    assert_eq!(
        choices
            .iter()
            .map(|row| row["selection"]["modelId"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ids
    );
    assert!(
        choices
            .iter()
            .all(|row| row["selection"]["connectionId"] == custom.connection_id)
    );
    assert!(last["next"].is_null());
    let missing = f
        .models(json!({"kind":"start","query":"absent","connectionId":custom.connection_id}))
        .await
        .unwrap();
    assert_eq!(missing["choices"], json!([]));
    assert!(missing["next"].is_null());
    f.set_default(ConnectionTarget {
        connection_id: first.connection_id,
        model_id: "family/shared.02".into(),
    })
    .await;
    let inherited = f
        .models(
            json!({"kind":"start","query":"family/shared.00","connectionId":custom.connection_id}),
        )
        .await
        .unwrap();
    assert_eq!(
        inherited["defaultModel"]["choice"]["selection"]["modelId"],
        "family/shared.02"
    );
    f.finish().await;
}
