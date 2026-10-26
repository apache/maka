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

//! A second, native-only product: Web plus a caller, with the original Root journal.
use maka_capabilities::call::Attachments;
use maka_capabilities::call::Identity;
use maka_capabilities::call::Issuer;
use maka_capabilities::call::Scope;
use maka_event_log::{
    RootStore,
    root::{RootNamespaces, RootOwner},
};
use maka_host_runtime::application::{
    Application, Binding, Invocation, NativeActivation, NativeRegistry, Policy,
};
use maka_packages::MANIFEST_FILE;
use maka_packages::Package;
use maka_plugin_core::{
    composition::{
        Configuration, Environment, ExecutionLocation, Input, InstanceId, Node, PackageUse, Target,
    },
    contract::{Availability, Cardinality, Export, Import},
    operation::{OperationCleanup, OperationOutcome, OperationReply, Receipt},
    package::{Declaration, EntryDeclaration, EntryTarget, Implementation},
};
use serde_json::{Value, json};
use std::{collections::BTreeMap, sync::Arc};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

struct Grant(Issuer);
impl Policy for Grant {
    fn admit(&self, invocation: Invocation<'_>) -> Result<(), String> {
        if self.0.evidence::<bool>(invocation.scope) == Some(&true) {
            Ok(())
        } else {
            Err("fixture grant denied".into())
        }
    }
}
fn scope(issuer: &Issuer, allowed: bool) -> Scope {
    issuer
        .issue_with(
            Identity::Remote {
                request_id: Uuid::new_v4(),
            },
            allowed,
            CancellationToken::new(),
        )
        .unwrap()
}
fn package(provider: bool) -> Package {
    let definition = maka_web_api::native();
    let entry = EntryDeclaration {
        implementation: Implementation::Native {
            implementation: if provider {
                definition.implementation
            } else {
                "fixture.caller".into()
            },
        },
        scene: None,
        configuration: if provider {
            definition.configuration
        } else {
            json!({"type":"object", "additionalProperties":false}).into()
        },
        imports: if provider {
            BTreeMap::new()
        } else {
            BTreeMap::from([(
                "web".into(),
                Import {
                    contract: maka_web_api::contract(),
                    cardinality: Cardinality::One,
                },
            )])
        },
        exports: if provider {
            BTreeMap::from([(
                "web".into(),
                Export {
                    contract: maka_web_api::contract(),
                    availability: Availability::Required,
                },
            )])
        } else {
            BTreeMap::new()
        },
    };
    Package::new(BTreeMap::from([(MANIFEST_FILE.into(), serde_json::to_vec(&json!({
        "schemaVersion":1, "id": if provider { "independent.web" } else { "independent.caller" },
        "application": Declaration { entries: BTreeMap::from([(EntryTarget::Host, entry)]), composition: None }
    })).unwrap())])).unwrap()
}
fn input(web: &Package, caller: &Package) -> Input {
    let node = |package: &Package, key, provider| Node {
        key: Uuid::from_u128(key),
        package: package.application_ref().into(),
        use_package: PackageUse::Entry,
        configuration: Configuration {
            values: if provider {
                BTreeMap::from([("network".into(), json!("denied"))])
            } else {
                BTreeMap::new()
            },
            parameters: BTreeMap::new(),
        },
        parameters: Configuration::default(),
        bindings: if provider {
            BTreeMap::new()
        } else {
            BTreeMap::from([(
                "web".into(),
                vec![Target::Instance {
                    path: vec!["web".into()],
                    export: "web".into(),
                }],
            )])
        },
        disabled: false,
        overrides: vec![],
    };
    Input {
        environment: Environment {
            location: ExecutionLocation::Host,
            presentation: None,
        },
        instances: BTreeMap::from([
            ("web".into(), node(web, 1, true)),
            ("caller".into(), node(caller, 2, false)),
        ]),
        recovery: None,
        launch: None,
    }
}
async fn open(store: Arc<RootStore>, deployment: Uuid, issuer: &Issuer) -> Application {
    let mut registry = NativeRegistry::default();
    maka_web::provide(&mut registry).unwrap();
    registry
        .insert(
            "fixture.caller".into(),
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
    let app = Application::start_from_store(
        store,
        deployment,
        registry,
        issuer.clone(),
        Arc::new(Grant(issuer.clone())),
        None,
    )
    .await
    .unwrap();
    app.ready().await.unwrap();
    app
}
async fn binding(app: &Application) -> Binding {
    let client = app.client();
    client
        .bind(
            client
                .activation(&InstanceId(vec![Uuid::from_u128(2)]))
                .unwrap(),
            "web".into(),
        )
        .await
        .unwrap()
        .remove(0)
}
async fn query(app: &Application, issuer: &Issuer, method: &str) -> Value {
    app.client()
        .start(
            binding(app).await,
            method.into(),
            json!({}),
            scope(issuer, true),
            Attachments::new().into(),
        )
        .await
        .unwrap()
        .result()
        .await
        .unwrap()
}
async fn mutate(
    app: &Application,
    store: &RootStore,
    issuer: &Issuer,
    method: &str,
    input: Value,
) -> OperationReply {
    let client = app.client();
    let prepared = client
        .prepare_mutation(
            binding(app).await,
            method.into(),
            input,
            scope(issuer, true),
            Uuid::new_v4(),
            Attachments::new().into(),
        )
        .await
        .unwrap();
    let reference = prepared.reference().clone();
    let recorded = store
        .record_application_intent(
            reference.source.clone(),
            prepared.consumer().instance().clone(),
            reference,
            Value::Null,
        )
        .await
        .unwrap();
    client
        .mutate(prepared, recorded)
        .await
        .unwrap()
        .result()
        .await
}
#[tokio::test]
async fn native_web_keeps_root_settings_receipts_and_agent_admission_without_an_agent_plugin() {
    tokio::time::timeout(std::time::Duration::from_secs(20), async {
        let dir=tempfile::tempdir().unwrap();
        let namespaces=RootNamespaces { ownership:dir.path().join("owners"), control:dir.path().join("control") };
        let path=dir.path().join("root");
        let root=Arc::new(RootOwner::create(&path,&namespaces).unwrap());
        let store=Arc::new(RootStore::open(root).await.unwrap());
        let web=package(true); let caller=package(false); let deployment=Uuid::new_v4();
        let source=store.commit_application(deployment,0,input(&web,&caller),vec![],vec![web,caller]).await.unwrap();
        let issuer=Issuer::default(); let app=open(store.clone(),deployment,&issuer).await;
        assert_eq!(app.source(),Some(&source));
        assert!(app.client().start(binding(&app).await,"snapshot".into(),json!({}),scope(&issuer,false),Attachments::new().into()).await.is_err());
        let before=query(&app,&issuer,"snapshot").await;
        let saved=mutate(&app,&store,&issuer,"save",json!({"revision":before["revision"],"settings":{"enabled":true,"source":"model"}})).await;
        let Receipt::Recorded { outcome:OperationOutcome::Returned { value }, cleanup:OperationCleanup::Confirmed } = saved.receipt else { panic!("save must settle on the original journal") };
        assert_eq!(value["kind"],"updated");
        let capture=query(&app,&issuer,"capture").await;
        assert_eq!(capture["available"],true);
        let denied=mutate(&app,&store,&issuer,"fetch",json!({"basis":capture["basis"],"input":{"url":"https://example.test/"}})).await;
        assert!(matches!(denied.receipt, Receipt::Recorded { outcome:OperationOutcome::Unknown { ref diagnostic }, cleanup:OperationCleanup::Confirmed } if diagnostic.contains("web_requires_agent")));
        assert_eq!(saved.reference.source, source);
        assert_eq!(RootOwner::open(&path,&namespaces).err().unwrap().kind(), std::io::ErrorKind::WouldBlock);
        app.shutdown().await.unwrap(); drop(app);
        let app=open(store.clone(),deployment,&issuer).await;
        assert_eq!(query(&app,&issuer,"snapshot").await,value["snapshot"]);
        app.shutdown().await.unwrap(); drop(app);
        Arc::try_unwrap(store).ok().expect("all Web storage owners closed").close().await.unwrap();
        let reopened=RootOwner::open(&path,&namespaces).unwrap(); drop(reopened);
    }).await.unwrap();
}
