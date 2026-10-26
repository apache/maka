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
use maka_event_log::{
    root::{RootNamespaces, RootOwner},
    root_store::RootStore,
};
use maka_host_runtime::application::{Binding, management::DEPLOYMENT_MANAGER};
use maka_plugin_core::{
    contract::binary_resource_type,
    deployment::{DeploymentRef, management::*},
    operation::{OperationCleanup, OperationOutcome, OperationReply, Receipt},
};

fn sources() -> (Input, Vec<Package>) {
    sources_for(DEPLOYMENT_MANAGER)
}
fn sources_for(implementation: &str) -> (Input, Vec<Package>) {
    let contract = deployment_manager_contract();
    let provider = package(
        "management",
        EntryDeclaration {
            scene: None,
            implementation: Implementation::Native {
                implementation: implementation.into(),
            },
            configuration: json!({"type":"object","additionalProperties":false}).into(),
            imports: BTreeMap::new(),
            exports: BTreeMap::from([(
                "Management".into(),
                Export {
                    contract: contract.clone(),
                    availability: Availability::Required,
                },
            )]),
        },
        None,
    );
    let consumer = package(
        "manager.client",
        EntryDeclaration {
            scene: None,
            implementation: Implementation::JavaScript {
                module: "host.mjs".into(),
                realm: Realm::Dedicated,
            },
            configuration: json!({"type":"object"}).into(),
            exports: BTreeMap::new(),
            imports: BTreeMap::from([(
                "management".into(),
                Import {
                    contract,
                    cardinality: Cardinality::One,
                },
            )]),
        },
        Some("export function activate(){return {}; }".into()),
    );
    let mut consumer_node = node(&consumer, 2, false);
    consumer_node.bindings = BTreeMap::from([(
        "management".into(),
        vec![Target::Instance {
            path: vec!["provider".into()],
            export: "Management".into(),
        }],
    )]);
    (
        Input {
            environment: Environment {
                location: ExecutionLocation::Host,
                presentation: None,
            },
            instances: BTreeMap::from([
                ("provider".into(), node(&provider, 1, true)),
                ("a".into(), consumer_node),
            ]),
            recovery: None,
            launch: None,
        },
        vec![provider, consumer],
    )
}
struct Fixture {
    _directory: tempfile::TempDir,
    root: std::path::PathBuf,
    namespaces: RootNamespaces,
    store: Arc<RootStore>,
    app: Application,
    issuer: Issuer,
    source: DeploymentRef,
    managed: DeploymentRef,
    binding: Binding,
}
impl Fixture {
    async fn new() -> Self {
        Self::create(None).await
    }
    async fn create(
        presentation: Option<maka_plugin_core::composition::PresentationTarget>,
    ) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("root");
        let namespaces = RootNamespaces {
            ownership: directory.path().join("owners"),
            control: directory.path().join("control"),
        };
        let store = Arc::new(
            RootStore::open(Arc::new(RootOwner::create(&root, &namespaces).unwrap()))
                .await
                .unwrap(),
        );
        let mut native = NativeRegistry::default();
        let ui = if let Some(presentation) = presentation {
            let ui = store
                .commit_application(
                    Uuid::new_v4(),
                    0,
                    Input {
                        environment: Environment {
                            location: ExecutionLocation::Ui,
                            presentation: Some(presentation),
                        },
                        instances: BTreeMap::new(),
                        recovery: None,
                        launch: None,
                    },
                    vec![],
                    vec![],
                )
                .await
                .unwrap();
            let target = maka_host_runtime::application::management::ManagementTarget::from_source(
                store.clone(),
                ui.clone(),
            )
            .await
            .unwrap();
            maka_host_runtime::application::management::provide_target(
                &mut native,
                "test.ui.management".into(),
                target,
            )
            .unwrap();
            Some(ui)
        } else {
            None
        };
        let (input, packages) = sources_for(if ui.is_some() {
            "test.ui.management"
        } else {
            DEPLOYMENT_MANAGER
        });
        let source = store
            .commit_application(Uuid::new_v4(), 0, input, vec![], packages)
            .await
            .unwrap();
        let issuer = Issuer::default();
        let app = Application::start_from_store(
            store.clone(),
            source.deployment,
            native,
            issuer.clone(),
            Arc::new(Grant(issuer.clone())),
            Some(maka_host_js::factory(Limits::default())),
        )
        .await
        .unwrap();
        app.ready().await.unwrap();
        let client = app.client();
        let binding = client
            .bind(client.activation(&id(2)).unwrap(), "management".into())
            .await
            .unwrap()
            .remove(0);
        Self {
            _directory: directory,
            root,
            namespaces,
            store,
            app,
            issuer,
            managed: ui.unwrap_or_else(|| source.clone()),
            source,
            binding,
        }
    }
    async fn mutate(&self, method: &str, input: Value, attachments: Attachments) -> OperationReply {
        let client = self.app.client();
        let prepared = client
            .prepare_mutation(
                self.binding.clone(),
                method.into(),
                input,
                scope(&self.issuer, true),
                Uuid::new_v4(),
                attachments.into(),
            )
            .await
            .unwrap();
        let intent = self
            .store
            .record_application_intent(
                prepared.reference().source.clone(),
                id(2),
                prepared.reference().clone(),
                serde_json::Value::Null,
            )
            .await
            .unwrap();
        let completed = client
            .mutate(prepared, intent)
            .await
            .unwrap()
            .completion()
            .await;
        completed.cleanup.unwrap();
        completed.reply
    }
    async fn query(&self, method: &str, input: Value) -> Result<Value> {
        let result = self
            .app
            .client()
            .start(
                self.binding.clone(),
                method.into(),
                input,
                scope(&self.issuer, true),
                Default::default(),
            )
            .await
            .unwrap()
            .completion()
            .await;
        result.cleanup.unwrap();
        result.result
    }
    async fn read(&self) -> ManagedDeployment {
        let result = self
            .app
            .client()
            .start(
                self.binding.clone(),
                "read".into(),
                json!({}),
                scope(&self.issuer, true),
                Default::default(),
            )
            .await
            .unwrap()
            .completion()
            .await;
        result.cleanup.unwrap();
        serde_json::from_value(result.result.unwrap()).unwrap()
    }
    async fn effective(&self, source: &DeploymentRef) {
        tokio::time::timeout(Duration::from_secs(10), async {
            while self.app.client().snapshot().effective.as_ref() != Some(source) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }
    async fn close(self) {
        self.app.shutdown().await.unwrap();
        drop(self.app);
        drop(self.binding);
        Arc::try_unwrap(self.store)
            .ok()
            .unwrap()
            .close()
            .await
            .unwrap();
        drop(RootOwner::open(&self.root, &self.namespaces).unwrap());
    }
}
struct Bundle(Vec<u8>);
struct Document(String);
impl ReadResource for Document {
    fn resource_type(&self) -> ResourceType {
        maka_plugin_core::contract::text_resource_type()
    }
    fn encoding(&self) -> maka_capabilities::call::ResourceEncoding {
        maka_capabilities::call::ResourceEncoding::Utf8
    }
    fn bytes(&self) -> usize {
        self.0.len()
    }
    fn metadata(&self) -> Value {
        json!({})
    }
    fn read(&self, range: std::ops::Range<usize>) -> Result<Vec<u8>> {
        self.0
            .get(range)
            .map(|s| s.as_bytes().to_vec())
            .ok_or("UTF-8 boundary".into())
    }
}
fn document_resource(document: DeploymentDocument) -> Attachments {
    BTreeMap::from([(
        "document".into(),
        Arc::new(Document(serde_json::to_string(&document).unwrap())) as Arc<dyn ReadResource>,
    )])
}
impl ReadResource for Bundle {
    fn resource_type(&self) -> ResourceType {
        binary_resource_type()
    }
    fn bytes(&self) -> usize {
        self.0.len()
    }
    fn metadata(&self) -> Value {
        json!({})
    }
    fn read(&self, range: std::ops::Range<usize>) -> Result<Vec<u8>> {
        Ok(self.0[range].to_vec())
    }
}
fn resource(bytes: Vec<u8>) -> Attachments {
    BTreeMap::from([(
        "package".into(),
        Arc::new(Bundle(bytes)) as Arc<dyn ReadResource>,
    )])
}
fn returned(reply: &OperationReply) -> Value {
    let Receipt::Recorded {
        outcome: OperationOutcome::Returned { value },
        cleanup: OperationCleanup::Confirmed,
    } = &reply.receipt
    else {
        panic!("{reply:?}")
    };
    value.clone()
}
fn extension() -> Package {
    package(
        "installed.echo",
        entry(
            true,
            Implementation::JavaScript {
                module: "host.mjs".into(),
                realm: Realm::Dedicated,
            },
            MethodMode::Query,
        ),
        Some(format!(
            "export function activate(){{return {{echo:{{contract:{},service:['service']}}}};}}; export const service={{echo(input){{return 'installed:'+input;}}}};",
            serde_json::to_string(&contract(MethodMode::Query)).unwrap(),
        )),
    )
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn complete_unicode_document_uses_fixed_source_chunks_and_recorded_native_snapshot_replace() {
    let f = Fixture::new().await;
    let mut current = f.read().await;
    let payload = extension();
    let mut packages = f
        .store
        .load_application_at(&current.source.reference)
        .await
        .unwrap()
        .unwrap()
        .into_parts()
        .1;
    packages.push(payload.clone());
    let mut payload_node = node(&payload, 77, true);
    payload_node.disabled = true;
    let original = "中🌟".repeat(90000);
    payload_node
        .configuration
        .values
        .insert("original".into(), json!(original));
    current
        .source
        .input
        .instances
        .insert("payload".into(), payload_node);
    let source = f
        .store
        .commit_application(
            f.managed.deployment,
            1,
            current.source.input.clone(),
            vec![],
            packages,
        )
        .await
        .unwrap();
    let mut offset = 0;
    let mut text = String::new();
    loop {
        let chunk: DeploymentDocumentChunk = serde_json::from_value(
            f.query("readDocument", json!({"source":source,"offset":offset}))
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(chunk.source, source);
        assert_eq!(chunk.offset, offset);
        assert!(chunk.text.len() <= 65536);
        text.push_str(&chunk.text);
        assert_eq!(text.len(), chunk.offset + chunk.text.len());
        if let Some(next) = chunk.next {
            offset = next;
        } else {
            assert_eq!(text.len(), chunk.total_bytes);
            break;
        }
    }
    assert!(text.len() > 512 * 1024);
    let mut document: DeploymentDocument = serde_json::from_str(&text).unwrap();
    assert_eq!(document.input, current.source.input);
    assert_eq!(
        document.input.instances["payload"].configuration.values["original"],
        original
    );
    // A later head must not alter the original document's continuation.
    let before = f
        .query("readDocument", json!({"source":source,"offset":0}))
        .await
        .unwrap();
    document
        .input
        .instances
        .get_mut("payload")
        .unwrap()
        .configuration
        .values
        .insert("edited".into(), json!("完整来源🙂"));
    let changed = f
        .mutate(
            "replace",
            json!({"expectedRevision":2}),
            document_resource(document.clone()),
        )
        .await;
    assert_eq!(returned(&changed)["status"], "committed");
    let next: DeploymentRef = serde_json::from_value(returned(&changed)["value"].clone()).unwrap();
    assert_eq!(
        f.query("readDocument", json!({"source":source,"offset":0}))
            .await
            .unwrap(),
        before
    );
    assert_eq!(
        f.store
            .read_application_metadata_at(&next)
            .await
            .unwrap()
            .unwrap()
            .source
            .input,
        document.input
    );
    let stale = f
        .mutate(
            "replace",
            json!({"expectedRevision":2}),
            document_resource(document.clone()),
        )
        .await;
    assert_eq!(
        returned(&stale),
        json!({"status":"conflict","currentRevision":3})
    );
    // Preserve the complete draft on a deterministically invalid edited plan,
    // and return a bounded reason usable by the advanced source editor.
    document
        .input
        .instances
        .get_mut("a")
        .unwrap()
        .bindings
        .clear();
    let bad = f
        .mutate(
            "replace",
            json!({"expectedRevision":3}),
            document_resource(document),
        )
        .await;
    assert_eq!(returned(&bad)["reason"], "invalid_source");
    let diagnostic = returned(&bad)["diagnostic"].as_str().unwrap().to_owned();
    assert!(!diagnostic.is_empty() && diagnostic.chars().count() <= 512);
    assert!(diagnostic.contains("manage"), "{diagnostic}");
    assert_eq!(
        f.store
            .application_head(f.managed.deployment)
            .await
            .unwrap(),
        Some(next)
    );
    let broken: Attachments = BTreeMap::from([(
        "document".into(),
        Arc::new(Document("{".into())) as Arc<dyn ReadResource>,
    )]);
    let rejected = f
        .mutate("replace", json!({"expectedRevision":3}), broken)
        .await;
    assert_eq!(returned(&rejected)["reason"], "invalid_document");
    assert!(
        f.query(
            "readDocument",
            json!({"source":source,"offset":text.find('中').unwrap()+1})
        )
        .await
        .is_err()
    );
    let mut foreign = source.clone();
    foreign.deployment = Uuid::new_v4();
    assert!(
        f.query("readDocument", json!({"source":foreign,"offset":0}))
            .await
            .is_err()
    );
    f.close().await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn installed_bytes_do_not_activate_until_explicit_cas_replace_and_original_receipt_survives()
{
    let f = Fixture::new().await;
    let original_epoch = f.binding.registration_epoch();
    let extension = extension();
    let install = f
        .mutate(
            "install",
            json!({"expectedRevision":1}),
            resource(extension.to_bundle()),
        )
        .await;
    let installed: PackageInstalled =
        serde_json::from_value(returned(&install)["value"].clone()).unwrap();
    assert_eq!(installed.package, extension.application_ref());
    assert_eq!(installed.source.revision, 2);
    f.effective(&installed.source).await;
    assert!(f.app.client().activation(&id(7)).is_err());
    assert_eq!(f.binding.registration_epoch(), original_epoch);
    let current = f.read().await;
    assert!(current.packages.contains(&extension.application_ref()));
    let mut input = current.source.input;
    input
        .instances
        .insert("installed".into(), node(&extension, 7, true));
    let client_node = input.instances.get_mut("a").unwrap();
    // The existing manager client intentionally keeps its old imports. A new
    // consumer gets the installed export through an explicit package/binding.
    assert_eq!(client_node.key, Uuid::from_u128(2));
    let consumer = consumer();
    let mut extra = node(&consumer, 8, false);
    extra.bindings.get_mut("echo").unwrap()[0] = Target::Instance {
        path: vec!["installed".into()],
        export: "echo".into(),
    };
    // Install that consumer's immutable bytes independently as well.
    let install_consumer = f
        .mutate(
            "install",
            json!({"expectedRevision":2}),
            resource(consumer.to_bundle()),
        )
        .await;
    let installed_consumer: PackageInstalled =
        serde_json::from_value(returned(&install_consumer)["value"].clone()).unwrap();
    f.effective(&installed_consumer.source).await;
    let current = f.read().await;
    input.instances.insert("new.client".into(), extra);
    let replacement = f
        .mutate(
            "replace",
            json!({"expectedRevision":3}),
            document_resource(DeploymentDocument {
                input,
                remote_exports: vec![],
                packages: current.packages,
            }),
        )
        .await;
    let source: DeploymentRef =
        serde_json::from_value(returned(&replacement)["value"].clone()).unwrap();
    f.effective(&source).await;
    let client = f.app.client();
    let binding = client
        .bind(client.activation(&id(8)).unwrap(), "echo".into())
        .await
        .unwrap()
        .remove(0);
    assert_eq!(
        client
            .start(
                binding,
                "echo".into(),
                json!("value"),
                scope(&f.issuer, true),
                Default::default()
            )
            .await
            .unwrap()
            .result()
            .await
            .unwrap(),
        json!("installed:value")
    );
    assert_eq!(f.read().await.source.reference, source);
    assert_eq!(
        f.store
            .operation(&install.reference)
            .unwrap()
            .operation_observation()
            .await
            .unwrap()
            .unwrap()
            .outcome,
        OperationOutcome::Returned {
            value: returned(&install)
        }
    );
    assert_eq!(
        RootOwner::open(&f.root, &f.namespaces)
            .err()
            .unwrap()
            .kind(),
        std::io::ErrorKind::WouldBlock
    );
    drop(client);
    f.close().await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rejected_bundle_cas_role_and_unknown_revision_leave_original_plan_healthy() {
    let f = Fixture::new().await;
    let invalid = f
        .mutate(
            "install",
            json!({"expectedRevision":1}),
            resource(b"{}".to_vec()),
        )
        .await;
    assert_eq!(
        returned(&invalid),
        json!({"status":"rejected","reason":"invalid_bundle"})
    );
    assert_eq!(f.read().await.source.reference, f.source);
    let current = f.read().await;
    let mut input = current.source.input;
    input.environment = Environment {
        location: ExecutionLocation::Ui,
        presentation: Some(maka_plugin_core::composition::PresentationTarget::Tui),
    };
    let refused = f
        .mutate(
            "replace",
            json!({"expectedRevision":1}),
            document_resource(DeploymentDocument {
                input,
                remote_exports: vec![],
                packages: current.packages,
            }),
        )
        .await;
    assert_eq!(
        returned(&refused),
        json!({"status":"rejected","reason":"execution_environment"})
    );
    assert_eq!(f.read().await.source.reference, f.source);
    let installed = f
        .mutate(
            "install",
            json!({"expectedRevision":1}),
            resource(extension().to_bundle()),
        )
        .await;
    let newer: PackageInstalled =
        serde_json::from_value(returned(&installed)["value"].clone()).unwrap();
    f.effective(&newer.source).await;
    let conflict = f
        .mutate(
            "install",
            json!({"expectedRevision":1}),
            resource(extension().to_bundle()),
        )
        .await;
    assert_eq!(
        returned(&conflict),
        json!({"status":"conflict","currentRevision":2})
    );
    assert_eq!(f.read().await.source.reference, newer.source);
    let mut read = f.read().await;
    read.packages.push(extension().application_ref());
    read.packages.last_mut().unwrap().revision = format!("sha256-{}", "0".repeat(64));
    let refused = f
        .mutate(
            "replace",
            json!({"expectedRevision":2}),
            document_resource(DeploymentDocument {
                input: read.source.input,
                remote_exports: vec![],
                packages: read.packages,
            }),
        )
        .await;
    assert_eq!(
        returned(&refused),
        json!({"status":"rejected","reason":"package_unavailable"})
    );
    assert_eq!(f.read().await.source.reference, newer.source);
    f.close().await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn manager_availability_and_schema_do_not_grant_authority_or_accept_guest_root() {
    let f = Fixture::new().await;
    for input in [
        json!({"expectedRevision":1,"root":"/tmp/foreign"}),
        json!({"expectedRevision":1,"deployment":Uuid::new_v4()}),
    ] {
        assert!(
            f.app
                .client()
                .prepare_mutation(
                    f.binding.clone(),
                    "install".into(),
                    input,
                    scope(&f.issuer, true),
                    Uuid::new_v4(),
                    resource(extension().to_bundle()).into()
                )
                .await
                .is_err()
        );
    }
    assert!(
        f.app
            .client()
            .prepare_mutation(
                f.binding.clone(),
                "install".into(),
                json!({"expectedRevision":1}),
                scope(&f.issuer, false),
                Uuid::new_v4(),
                resource(extension().to_bundle()).into()
            )
            .await
            .is_err()
    );
    assert_eq!(f.read().await.source.reference, f.source);
    let (input, packages) = sources();
    assert!(
        Application::start(
            input,
            packages,
            NativeRegistry::default(),
            f.issuer.clone(),
            Arc::new(Grant(f.issuer.clone())),
            Some(maka_host_js::factory(Limits::default()))
        )
        .is_err()
    );
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_installation_commits_once_and_records_the_other_cas_as_conflict() {
    let f = Fixture::new().await;
    let extension = extension();
    let (a, b) = tokio::join!(
        f.mutate(
            "install",
            json!({"expectedRevision":1}),
            resource(extension.to_bundle())
        ),
        f.mutate(
            "install",
            json!({"expectedRevision":1}),
            resource(extension.to_bundle())
        ),
    );
    let a = returned(&a);
    let b = returned(&b);
    assert!(
        (a["status"] == "committed" && b == json!({"status":"conflict","currentRevision":2}))
            || (b["status"] == "committed"
                && a == json!({"status":"conflict","currentRevision":2}))
    );
    assert_eq!(f.read().await.source.reference.revision, 2);
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ui_target_uses_original_root_but_keeps_host_journal_and_fixed_presentation() {
    use maka_plugin_core::composition::PresentationTarget;
    let presentation = PresentationTarget::Tui;
    let f = Fixture::create(Some(presentation)).await;
    let current = f.read().await;
    assert_eq!(current.source.reference, f.managed);
    assert_ne!(f.managed.deployment, f.source.deployment);
    assert!(
        f.app
            .client()
            .prepare_mutation(
                f.binding.clone(),
                "install".into(),
                json!({"expectedRevision":1}),
                scope(&f.issuer, false),
                Uuid::new_v4(),
                resource(extension().to_bundle()).into(),
            )
            .await
            .is_err()
    );
    let install = f
        .mutate(
            "install",
            json!({"expectedRevision":1}),
            resource(extension().to_bundle()),
        )
        .await;
    let installed: PackageInstalled =
        serde_json::from_value(returned(&install)["value"].clone()).unwrap();
    assert_eq!(installed.source.deployment, f.managed.deployment);
    assert_eq!(installed.source.revision, 2);
    assert_eq!(install.reference.source, f.source);
    assert_eq!(
        f.app.client().snapshot().effective.as_ref(),
        Some(&f.source)
    );
    let mut current = f.read().await;
    assert_eq!(current.source.input.instances.len(), 0);
    current.source.input.environment = Environment {
        location: ExecutionLocation::Host,
        presentation: None,
    };
    let refused = f
        .mutate(
            "replace",
            json!({"expectedRevision":2}),
            document_resource(DeploymentDocument {
                input: current.source.input,
                remote_exports: vec![],
                packages: current.packages,
            }),
        )
        .await;
    assert_eq!(
        returned(&refused),
        json!({"status":"rejected","reason":"execution_environment"})
    );
    let current = f.read().await;
    let replaced = f
        .mutate(
            "replace",
            json!({"expectedRevision":2}),
            document_resource(DeploymentDocument {
                input: current.source.input,
                remote_exports: vec![],
                packages: current.packages,
            }),
        )
        .await;
    let next: DeploymentRef = serde_json::from_value(returned(&replaced)["value"].clone()).unwrap();
    assert_eq!(next.deployment, f.managed.deployment);
    assert_eq!(next.revision, 3);
    assert_eq!(
        f.store.application_head(f.source.deployment).await.unwrap(),
        Some(f.source.clone())
    );
    assert_eq!(
        f.store
            .operation(&install.reference)
            .unwrap()
            .operation_observation()
            .await
            .unwrap()
            .unwrap()
            .outcome,
        OperationOutcome::Returned {
            value: returned(&install)
        }
    );
    let old = f
        .store
        .read_application_metadata_at(&f.managed)
        .await
        .unwrap()
        .unwrap();
    assert!(old.packages.is_empty());
    let mut foreign = f.managed.clone();
    foreign.state_domain = "0".repeat(64);
    assert!(
        maka_host_runtime::application::management::ManagementTarget::from_source(
            f.store.clone(),
            foreign
        )
        .await
        .is_err()
    );
    assert_eq!(
        RootOwner::open(&f.root, &f.namespaces)
            .err()
            .unwrap()
            .kind(),
        std::io::ErrorKind::WouldBlock
    );
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fixed_target_factory_rejects_another_original_root_owner() {
    use maka_host_runtime::application::management::{ManagementTarget, provide_target};
    let original =
        Fixture::create(Some(maka_plugin_core::composition::PresentationTarget::Tui)).await;
    let target = ManagementTarget::from_source(original.store.clone(), original.managed.clone())
        .await
        .unwrap();
    let foreign = Fixture::new().await;
    let (input, packages) = sources_for("foreign.target");
    let source = foreign
        .store
        .commit_application(Uuid::new_v4(), 0, input, vec![], packages)
        .await
        .unwrap();
    let mut native = NativeRegistry::default();
    provide_target(&mut native, "foreign.target".into(), target).unwrap();
    let issuer = Issuer::default();
    let app = Application::start_from_store(
        foreign.store.clone(),
        source.deployment,
        native,
        issuer.clone(),
        Arc::new(Grant(issuer)),
        Some(maka_host_js::factory(Limits::default())),
    )
    .await
    .unwrap();
    assert!(app.ready().await.is_err());
    assert_eq!(
        original
            .store
            .application_head(original.managed.deployment)
            .await
            .unwrap(),
        Some(original.managed.clone())
    );
    app.shutdown().await.unwrap();
    drop(app);
    foreign.close().await;
    original.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn instance_pages_freeze_source_and_nested_enabled_intents_preserve_original_overrides() {
    use maka_plugin_core::composition::{Override, Parameter, PresentationTarget, Template};
    let f = Fixture::create(Some(PresentationTarget::Tui)).await;
    let leaf = Package::new(BTreeMap::from([(MANIFEST_FILE.into(), serde_json::to_vec(&json!({
        "schemaVersion":1,"id":"nested.leaf","application":Declaration {
            entries: BTreeMap::from([(EntryTarget::Tui, EntryDeclaration {
                scene: None, implementation: Implementation::Native { implementation:"unused.ui.availability".into() },
                configuration: json!({"type":"object"}).into(), imports: BTreeMap::new(), exports: BTreeMap::new(),
            })]), composition: None,
        }
    })).unwrap())])).unwrap();
    let children = (0..10)
        .map(|at| {
            let mut child = node(&leaf, 100 + at, true);
            child
                .configuration
                .parameters
                .insert("inherited".into(), "label".into());
            (format!("child{at}"), child)
        })
        .collect();
    let product = Package::new(BTreeMap::from([(MANIFEST_FILE.into(), serde_json::to_vec(&json!({
        "schemaVersion":1,"id":"nested.product","application":Declaration {
            entries:BTreeMap::new(), composition:Some(Template {
                parameters:BTreeMap::from([("label".into(), Parameter { schema:json!({"type":"string"}).into(), default:None })]),
                imports:BTreeMap::new(), exports:BTreeMap::new(), children,
            }),
        }
    })).unwrap())])).unwrap();
    let mut root = node(&product, 10, true);
    root.use_package = PackageUse::Composition;
    root.parameters
        .values
        .insert("label".into(), json!("用户原参数🙂"));
    root.overrides.push(Override {
        path: vec!["child1".into()],
        configuration: BTreeMap::from([("keep".into(), json!("original"))]),
        ..Default::default()
    });
    let original_root = root.clone();
    let basis = f
        .store
        .commit_application(
            f.managed.deployment,
            1,
            Input {
                environment: Environment {
                    location: ExecutionLocation::Ui,
                    presentation: Some(PresentationTarget::Tui),
                },
                instances: BTreeMap::from([("product".into(), root)]),
                recovery: None,
                launch: None,
            },
            vec![],
            vec![leaf, product],
        )
        .await
        .unwrap();
    let page: ManagedInstancesPage =
        serde_json::from_value(f.query("instances", json!({"kind":"start"})).await.unwrap())
            .unwrap();
    assert_eq!(page.source, basis);
    assert_eq!(page.instances.len(), 8);
    assert!(page.next.is_some());
    assert!(serde_json::to_vec(&page).unwrap().len() < 64 * 1024);
    let child = InstanceId(vec![Uuid::from_u128(10), Uuid::from_u128(101)]);
    let change = f
        .mutate(
            "setEnabled",
            json!({"expectedRevision":2,"instance":child,"enabled":false}),
            Attachments::new(),
        )
        .await;
    let next: DeploymentRef = serde_json::from_value(returned(&change)["value"].clone()).unwrap();
    assert_eq!(next.revision, 3);
    assert_eq!(change.reference.source, f.source);
    let current = f.read().await;
    let changed = &current.source.input.instances["product"];
    assert_eq!(changed.parameters, original_root.parameters);
    assert_eq!(
        changed.overrides[0].configuration,
        original_root.overrides[0].configuration
    );
    assert_eq!(
        changed.overrides[0].bindings,
        original_root.overrides[0].bindings
    );
    assert_eq!(changed.overrides[0].disabled, Some(true));
    let frozen: ManagedInstancesPage = serde_json::from_value(
        f.query(
            "instances",
            json!({"kind":"continue","source":basis,"after":page.next}),
        )
        .await
        .unwrap(),
    )
    .unwrap();
    assert_eq!(frozen.source.revision, 2);
    assert_eq!(frozen.instances.len(), 3);
    assert!(frozen.next.is_none());
    assert!(frozen.instances.iter().all(|instance| !instance.disabled));
    let first: ManagedInstancesPage = serde_json::from_value(
        f.query(
            "instances",
            json!({"kind":"continue","source":basis,"after":null}),
        )
        .await
        .unwrap(),
    )
    .unwrap();
    assert_eq!(first.source.revision, 2);
    assert!(
        first
            .instances
            .iter()
            .find(|instance| instance.instance == child)
            .is_some_and(|instance| !instance.disabled)
    );
    assert!(
        f.query(
            "instances",
            json!({"kind":"continue","source":f.source,"after":id(10)})
        )
        .await
        .is_err()
    );
    assert!(
        f.query(
            "instances",
            json!({"kind":"continue","source":next,"after":id(999)})
        )
        .await
        .is_err()
    );
    let root_change = f
        .mutate(
            "setEnabled",
            json!({"expectedRevision":3,"instance":id(10),"enabled":false}),
            Attachments::new(),
        )
        .await;
    assert_eq!(returned(&root_change)["value"]["revision"], 4);
    let second_child = InstanceId(vec![Uuid::from_u128(10), Uuid::from_u128(102)]);
    let inherited = f
        .mutate(
            "setEnabled",
            json!({"expectedRevision":4,"instance":second_child,"enabled":false}),
            Attachments::new(),
        )
        .await;
    assert_eq!(
        returned(&inherited)["value"]["revision"],
        5,
        "own intent must persist despite inherited disabled"
    );
    let refused = f
        .mutate(
            "setEnabled",
            json!({"expectedRevision":5,"instance":second_child,"enabled":true}),
            Attachments::new(),
        )
        .await;
    assert_eq!(
        returned(&refused),
        json!({"status":"rejected","reason":"parent_disabled"})
    );
    let enabled = f
        .mutate(
            "setEnabled",
            json!({"expectedRevision":5,"instance":id(10),"enabled":true}),
            Attachments::new(),
        )
        .await;
    assert_eq!(returned(&enabled)["value"]["revision"], 6);
    let page: ManagedInstancesPage =
        serde_json::from_value(f.query("instances", json!({"kind":"start"})).await.unwrap())
            .unwrap();
    assert!(
        page.instances
            .iter()
            .find(|instance| instance.instance == second_child)
            .unwrap()
            .disabled
    );
    let conflict = f
        .mutate(
            "setEnabled",
            json!({"expectedRevision":2,"instance":child,"enabled":true}),
            Attachments::new(),
        )
        .await;
    assert_eq!(
        returned(&conflict),
        json!({"status":"conflict","currentRevision":6})
    );
    let absent = f
        .mutate(
            "setEnabled",
            json!({"expectedRevision":6,"instance":id(999),"enabled":false}),
            Attachments::new(),
        )
        .await;
    assert_eq!(
        returned(&absent),
        json!({"status":"rejected","reason":"instance_unavailable"})
    );
    assert_eq!(
        f.store.application_head(f.source.deployment).await.unwrap(),
        Some(f.source.clone())
    );
    assert_eq!(
        f.store
            .operation(&change.reference)
            .unwrap()
            .operation_observation()
            .await
            .unwrap()
            .unwrap()
            .outcome,
        OperationOutcome::Returned {
            value: returned(&change)
        }
    );
    f.close().await;
}

#[tokio::test]
async fn execution_basis_includes_cohost_manager_target_but_not_source_revision() {
    use maka_plugin_core::composition::PresentationTarget;
    let f = Fixture::create(Some(PresentationTarget::Tui)).await;
    let original = f.binding.execution_basis().to_owned();
    f.app.shutdown().await.unwrap();
    let input = Input {
        environment: Environment {
            location: ExecutionLocation::Ui,
            presentation: Some(PresentationTarget::Tui),
        },
        instances: BTreeMap::new(),
        recovery: None,
        launch: None,
    };
    let same = f
        .store
        .commit_application(
            f.managed.deployment,
            f.managed.revision,
            input.clone(),
            vec![],
            vec![],
        )
        .await
        .unwrap();
    let different = f
        .store
        .commit_application(Uuid::new_v4(), 0, input, vec![], vec![])
        .await
        .unwrap();
    for (target, equal) in [(same, true), (different, false)] {
        let mut native = NativeRegistry::default();
        let management = maka_host_runtime::application::management::ManagementTarget::from_source(
            f.store.clone(),
            target.clone(),
        )
        .await
        .unwrap();
        maka_host_runtime::application::management::provide_target(
            &mut native,
            "test.ui.management".into(),
            management,
        )
        .unwrap();
        let app = Application::start_from_store(
            f.store.clone(),
            f.source.deployment,
            native,
            f.issuer.clone(),
            Arc::new(Grant(f.issuer.clone())),
            Some(maka_host_js::factory(Limits::default())),
        )
        .await
        .unwrap();
        app.ready().await.unwrap();
        let client = app.client();
        let binding = client
            .bind(client.activation(&id(2)).unwrap(), "management".into())
            .await
            .unwrap()
            .remove(0);
        assert_eq!(original == binding.execution_basis(), equal);
        // Exercise the closure's real target, not only its declared metadata.
        let result = client
            .start(
                binding,
                "read".into(),
                json!({}),
                scope(&f.issuer, true),
                Attachments::new().into(),
            )
            .await
            .unwrap()
            .result()
            .await
            .unwrap();
        let managed: ManagedDeployment = serde_json::from_value(result).unwrap();
        assert_eq!(managed.source.reference, target);
        app.shutdown().await.unwrap();
    }
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn settings_forms_preserve_exact_numbers_unedited_sources_and_original_cas() {
    use maka_plugin_core::composition::{Parameter, PresentationTarget, Template};
    let f = Fixture::create(Some(PresentationTarget::Tui)).await;
    let schema = json!({"type":"object","additionalProperties":false,
        "properties":{
            "label":{"type":"string","title":"Display name"},
            "limit":{"type":"integer","minimum":1},
            "theme":{"type":"string","enum":["light","dark"]},
            "enabled":{"type":"boolean"},
            "details":{"$ref":"#/$defs/details"},
            "flags":{"type":"array","items":{"type":"boolean"}},
            "optional":{"type":"string"},
            "nullable":{"anyOf":[{"type":"string"},{"type":"null"}]}
        },"required":["label","limit","theme","enabled","details","flags","nullable"],
        "$defs":{"details":{"type":"object","properties":{"path":{"type":"string"},"opaque":{"type":"integer"}},"required":["path","opaque"],"additionalProperties":false}}
    });
    let leaf = Package::new(BTreeMap::from([(MANIFEST_FILE.into(), serde_json::to_vec(&json!({
        "schemaVersion":1,"id":"form.leaf","application":Declaration {
            entries:BTreeMap::from([(EntryTarget::Tui, EntryDeclaration {
                scene:None, implementation:Implementation::Native { implementation:"unused.form.availability".into() },
                configuration:schema.into(), imports:BTreeMap::new(), exports:BTreeMap::new(),
            })]),composition:None,
        }
    })).unwrap())])).unwrap();
    let values: BTreeMap<String, Value> = serde_json::from_value(json!({
        "label":"original", "limit":9007199254740993_u64, "theme":"light", "enabled":true,
        "details":{"path":"original/path","opaque":18446744073709551615_u64},
        "flags":[true,false], "nullable":null,
    }))
    .unwrap();
    let mut root = node(&leaf, 77, true);
    root.configuration.values = values.clone();
    let mut child = node(&leaf, 78, true);
    child.configuration.values = values;
    child.configuration.values.remove("label");
    child
        .configuration
        .parameters
        .insert("label".into(), "name".into());
    let template = Package::new(BTreeMap::from([(MANIFEST_FILE.into(), serde_json::to_vec(&json!({
        "schemaVersion":1,"id":"form.product","application":Declaration {
            entries:BTreeMap::new(),composition:Some(Template {
                parameters:BTreeMap::from([("name".into(),Parameter { schema:json!({"type":"string"}).into(),default:None })]),
                imports:BTreeMap::new(),exports:BTreeMap::new(),children:BTreeMap::from([("child".into(),child)]),
            }),
        }
    })).unwrap())])).unwrap();
    let mut product = node(&template, 79, true);
    product.use_package = PackageUse::Composition;
    product
        .parameters
        .values
        .insert("name".into(), json!("inherited name"));
    let original_product = product.clone();
    let source = f
        .store
        .commit_application(
            f.managed.deployment,
            1,
            Input {
                environment: Environment {
                    location: ExecutionLocation::Ui,
                    presentation: Some(PresentationTarget::Tui),
                },
                instances: BTreeMap::from([
                    ("settings".into(), root.clone()),
                    ("product".into(), product),
                ]),
                recovery: None,
                launch: None,
            },
            vec![],
            vec![leaf, template],
        )
        .await
        .unwrap();
    let read = |source: &DeploymentRef, instance: InstanceId, path: Vec<&str>| json!({"source":source,"instance":instance,"path":path,"after":null});
    let page: InstanceSettingsPage = serde_json::from_value(
        f.query("readSettings", read(&source, id(77), vec![]))
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(page.fields.len(), 8);
    assert_eq!(
        page.fields.iter().find(|f| f.key == "limit").unwrap().value,
        Some(SettingValue::Number {
            text: "9007199254740993".into()
        })
    );
    assert_eq!(
        page.fields.iter().find(|f| f.key == "label").unwrap().label,
        "Display name"
    );
    assert_eq!(
        page.fields
            .iter()
            .find(|f| f.key == "theme")
            .unwrap()
            .options
            .len(),
        2
    );
    assert!(
        !page
            .fields
            .iter()
            .find(|f| f.key == "optional")
            .unwrap()
            .present
    );
    assert!(matches!(
        page.fields
            .iter()
            .find(|f| f.key == "nullable")
            .unwrap()
            .kind,
        SettingKind::Text
    ));
    let changed = f
        .mutate(
            "configure",
            json!({"expectedRevision":2,"instance":id(77),"changes":[
                {"path":["label"],"value":{"kind":"text","text":"新名称🙂"}},
                {"path":["details","path"],"value":{"kind":"text","text":"new/path"}},
                {"path":["limit"],"value":{"kind":"number","text":"9007199254740995"}},
                {"path":["flags","1"],"value":{"kind":"boolean","value":true}}
            ]}),
            Attachments::new(),
        )
        .await;
    let next: DeploymentRef = serde_json::from_value(returned(&changed)["value"].clone()).unwrap();
    let current = f.read().await;
    let actual = &current.source.input.instances["settings"];
    assert_eq!(
        actual.configuration.values["limit"],
        json!(9007199254740995_u64)
    );
    assert_eq!(
        actual.configuration.values["details"]["opaque"],
        json!(18446744073709551615_u64)
    );
    assert_eq!(actual.configuration.values["flags"], json!([true, true]));
    assert_eq!(actual.bindings, root.bindings);
    assert_eq!(actual.package, root.package);
    assert_eq!(current.source.input.instances["product"], original_product);
    // An old form remains a frozen read, but cannot overwrite a newer source.
    assert_eq!(
        f.query("readSettings", read(&source, id(77), vec![]))
            .await
            .unwrap(),
        serde_json::to_value(page).unwrap()
    );
    let conflict = f.mutate("configure",json!({"expectedRevision":2,"instance":id(77),"changes":[{"path":["label"],"value":{"kind":"text","text":"stale"}}]}),Attachments::new()).await;
    assert_eq!(returned(&conflict)["status"], "conflict");
    let invalid = f.mutate("configure",json!({"expectedRevision":next.revision,"instance":id(77),"changes":[{"path":["theme"],"value":{"kind":"text","text":"invalid"}}]}),Attachments::new()).await;
    assert_eq!(returned(&invalid)["status"], "rejected");
    assert_eq!(f.read().await.source.reference, next);
    let nested = InstanceId(vec![Uuid::from_u128(79), Uuid::from_u128(78)]);
    let configured = f.mutate("configure",json!({"expectedRevision":next.revision,"instance":nested,"changes":[{"path":["enabled"],"value":{"kind":"boolean","value":false}}]}),Attachments::new()).await;
    assert_eq!(returned(&configured)["status"], "committed");
    let current = f.read().await;
    let product = &current.source.input.instances["product"];
    assert_eq!(product.parameters, original_product.parameters);
    assert_eq!(product.overrides.len(), 1);
    assert_eq!(
        product.overrides[0].configuration,
        BTreeMap::from([("enabled".into(), json!(false))])
    );
    let fields: InstanceSettingsPage = serde_json::from_value(
        f.query(
            "readSettings",
            read(&current.source.reference, nested, vec![]),
        )
        .await
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        fields
            .fields
            .iter()
            .find(|f| f.key == "label")
            .unwrap()
            .value,
        Some(SettingValue::Text {
            text: "inherited name".into()
        })
    );
    let mut foreign = source.clone();
    foreign.deployment = Uuid::new_v4();
    assert!(
        f.query("readSettings", read(&foreign, id(77), vec![]))
            .await
            .is_err()
    );
    assert!(
        f.query("readSettings", read(&source, id(77), vec!["missing"]))
            .await
            .is_err()
    );
    f.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn composition_choices_and_atomic_edits_preserve_source_bindings_and_original_receipts() {
    use maka_plugin_core::composition::PresentationTarget;
    let f = Fixture::create(Some(PresentationTarget::Tui)).await;
    let contract = deployment_manager_contract();
    let make = |name: &str, configuration: Value, imports, exports| {
        Package::new(BTreeMap::from([(MANIFEST_FILE.into(), serde_json::to_vec(&json!({
            "schemaVersion":1,"id":name,"application":Declaration {
                entries:BTreeMap::from([(EntryTarget::Tui, EntryDeclaration {
                    scene:None, implementation:Implementation::Native { implementation:"test.form".into() },
                    configuration: configuration.into(), imports, exports,
                })]),composition:None,
            }
        })).unwrap())])).unwrap()
    };
    let catalog = make(
        "test.catalog",
        json!({"type":"object","properties":{"entries":{"type":"array"}}}),
        BTreeMap::from([(
            "pages".into(),
            Import {
                contract: contract.clone(),
                cardinality: Cardinality::Many { min: 0, max: 20 },
            },
        )]),
        BTreeMap::new(),
    );
    let leaf = make(
        "test.extension",
        json!({"type":"object","additionalProperties":false,
        "properties":{"label":{"type":"string","default":"A new app"},"limit":{"type":"integer","default":9007199254740993_u64},"preferences":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}},"required":["label","limit"]}),
        BTreeMap::from([(
            "provider".into(),
            Import {
                contract: contract.clone(),
                cardinality: Cardinality::One,
            },
        )]),
        BTreeMap::from([(
            "Page".into(),
            Export {
                contract: contract.clone(),
                availability: Availability::Required,
            },
        )]),
    );
    let provider = make(
        "test.provider",
        json!({"type":"object"}),
        BTreeMap::new(),
        BTreeMap::from([(
            "Provider".into(),
            Export {
                contract,
                availability: Availability::Required,
            },
        )]),
    );
    let mut catalog_node = node(&catalog, 80, true);
    catalog_node
        .configuration
        .values
        .insert("entries".into(), json!([]));
    catalog_node.bindings.insert("pages".into(), vec![]);
    let source = f
        .store
        .commit_application(
            f.managed.deployment,
            1,
            Input {
                environment: Environment {
                    location: ExecutionLocation::Ui,
                    presentation: Some(PresentationTarget::Tui),
                },
                instances: BTreeMap::from([
                    ("apps".into(), catalog_node),
                    ("provider".into(), node(&provider, 81, true)),
                ]),
                recovery: None,
                launch: None,
            },
            vec![],
            vec![catalog, leaf.clone(), provider],
        )
        .await
        .unwrap();
    let query = json!({"source":source,"consumer":{"kind":"root","name":"apps"},"import":"pages","includePackages":true,"after":null});
    let choices: BindingCandidatesPage =
        serde_json::from_value(f.query("bindingCandidates", query.clone()).await.unwrap()).unwrap();
    assert!(choices.current.is_empty());
    assert_eq!(choices.configuration["entries"], json!([]));
    assert!(choices.candidates.iter().any(
        |c| matches!(c,BindingCandidate::Package {package,..} if package == &leaf.application_ref())
    ));
    let required: BindingCandidatesPage = serde_json::from_value(f.query("bindingCandidates",json!({"source":source,"consumer":{"kind":"package","package":leaf.application_ref()},"import":"provider","includePackages":false,"after":null})).await.unwrap()).unwrap();
    let provider_target = Target::Instance {
        path: vec!["provider".into()],
        export: "Provider".into(),
    };
    assert!(
        required
            .candidates
            .iter()
            .any(|c| matches!(c,BindingCandidate::Bound {target,..} if target == &provider_target))
    );
    let fields: PackageSettingsPage = serde_json::from_value(f.query("packageSettings",json!({"source":source,"package":leaf.application_ref(),"path":[],"after":null,"changes":[]})).await.unwrap()).unwrap();
    assert_eq!(fields.imports.len(), 1);
    assert_eq!(
        fields
            .fields
            .iter()
            .find(|f| f.key == "limit")
            .unwrap()
            .value,
        Some(SettingValue::Number {
            text: "9007199254740993".into()
        })
    );
    let edit = json!({"expectedRevision":source.revision,"edits":[
        {"kind":"insert","name":"custom","package":leaf.application_ref(),"settings":[{"path":["label"],"value":{"kind":"text","text":"My app"}},{"path":["preferences","path"],"value":{"kind":"text","text":"notes/local"}}],"bindings":{"provider":[provider_target]}},
        {"kind":"update","name":"apps","configuration":{"entries":[{"id":"custom","label":"My app"}]},"bindings":{"pages":[{"kind":"instance","path":["custom"],"export":"Page"}]}}
    ]});
    let mut invalid = edit.clone();
    invalid["edits"][0]["bindings"] = json!({});
    let rejected = f
        .mutate("editComposition", invalid, Attachments::new())
        .await;
    assert_eq!(returned(&rejected)["status"], "rejected");
    assert_eq!(f.read().await.source.reference, source);
    assert!(!f.read().await.source.input.instances.contains_key("custom"));
    let committed = f
        .mutate("editComposition", edit.clone(), Attachments::new())
        .await;
    assert_eq!(returned(&committed)["status"], "committed");
    let current = f.read().await;
    let custom = &current.source.input.instances["custom"];
    assert_eq!(
        custom.configuration.values["limit"],
        json!(9007199254740993_u64)
    );
    assert_eq!(custom.configuration.values["label"], json!("My app"));
    assert_eq!(custom.bindings["provider"], vec![provider_target]);
    assert_eq!(
        custom.configuration.values["preferences"],
        json!({"path":"notes/local"})
    );
    assert_eq!(
        f.query("bindingCandidates", query).await.unwrap(),
        serde_json::to_value(choices).unwrap()
    );
    let stale = f.mutate("editComposition", edit, Attachments::new()).await;
    assert_eq!(returned(&stale)["status"], "conflict");
    // Removing a gallery entry does not delete the original plugin instance.
    let removed = f.mutate("editComposition",json!({"expectedRevision":current.source.reference.revision,"edits":[{"kind":"update","name":"apps","configuration":{"entries":[]},"bindings":{"pages":[]}}]}),Attachments::new()).await;
    assert_eq!(returned(&removed)["status"], "committed");
    assert_eq!(&f.read().await.source.input.instances["custom"], custom);
    // Original durable receipts remain exact after further source revisions.
    assert_eq!(
        f.store
            .operation(&committed.reference)
            .unwrap()
            .operation_observation()
            .await
            .unwrap()
            .unwrap()
            .outcome,
        OperationOutcome::Returned {
            value: returned(&committed)
        }
    );
    f.close().await;
}
