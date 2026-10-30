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

use super::super::*;
use maka_capabilities::call::Attachments;
use maka_capabilities::call::Identity;
use maka_capabilities::call::Issuer;
use maka_event_log::{RootStore, root::RootNamespaces};
use maka_host_runtime::application::{
    Application, Binding, Invocation, Policy, RecoveryInvocation,
};
use maka_packages::MANIFEST_FILE;
use maka_packages::Package;
use maka_plugin_core::{
    composition::{
        Configuration as NodeConfiguration, Input, InstanceId, Node, PackageUse, Target,
    },
    operation::{OperationCleanup, OperationOutcome, Receipt, RecoveryRef},
};
use serde_json::json;
use std::{
    path::Path,
    time::{Duration, Instant},
};
use uuid::Uuid;

const DEPLOYMENT: Uuid = Uuid::from_u128(91);
struct Grant(Issuer);
impl Policy for Grant {
    fn admit(&self, invocation: Invocation<'_>) -> Result<(), String> {
        if invocation.method == "setPreference"
            && self.0.evidence::<bool>(invocation.scope) != Some(&true)
        {
            return Err("preference mutation denied".into());
        }
        self.0
            .owns(invocation.scope)
            .then_some(())
            .ok_or("foreign scope".into())
    }
    fn recover(&self, invocation: RecoveryInvocation<'_>) -> Result<(), String> {
        (self.0.evidence::<bool>(invocation.scope) == Some(&true))
            .then_some(())
            .ok_or("recovery denied".into())
    }
}
fn id(value: u128) -> InstanceId {
    InstanceId(vec![Uuid::from_u128(value)])
}
fn packages(source: &Path) -> (Input, Vec<Package>) {
    let provider = Package::new(BTreeMap::from([(
        MANIFEST_FILE.into(),
        serde_json::to_vec(&json!({
            "schemaVersion":1,"id":"skills","application":{"host":{
                "implementation":{"kind":"native","implementation":IMPLEMENTATION},
                "configuration":configuration_schema(),"imports":{},
                "exports":{EXPORT:{"contract":contract(),"availability":"required"}}
            }}
        }))
        .unwrap(),
    )]))
    .unwrap();
    let consumer = Package::new(BTreeMap::from([
        (
            MANIFEST_FILE.into(),
            serde_json::to_vec(&json!({
                "schemaVersion":1,"id":"consumer","application":{"host":{
                    "implementation":{"kind":"javascript","module":"main.mjs","realm":"shared"},
                    "configuration":{"type":"object","additionalProperties":false},
                    "imports":{EXPORT:{"contract":contract(),"cardinality":maka_plugin_core::contract::Cardinality::One}},"exports":{}
                }}
            }))
            .unwrap(),
        ),
        (
            "main.mjs".into(),
            b"export function activate() { return {}; }".to_vec(),
        ),
    ]))
    .unwrap();
    let reader = Package::new(BTreeMap::from([(MANIFEST_FILE.into(), serde_json::to_vec(&json!({
        "schemaVersion":1,"id":"outcomes","application":{"host":{
            "implementation":{"kind":"native","implementation":maka_skills_api::outcomes::IMPLEMENTATION},
            "configuration":{"type":"object","additionalProperties":false},"imports":{},
            "exports":{maka_skills_api::outcomes::EXPORT:{"contract":maka_skills_api::outcomes::contract(),"availability":"required"}}
        }}
    })).unwrap())])).unwrap();
    let mut files = consumer.files().clone();
    let mut manifest = consumer.manifest().clone();
    let mut manifest_application = manifest.application.as_ref().unwrap().declaration().clone();
    manifest.id = "recovery-consumer".into();
    manifest_application.host.as_mut().unwrap().imports = BTreeMap::from([(
        "outcomes".into(),
        maka_plugin_core::contract::Import {
            contract: maka_skills_api::outcomes::contract(),
            cardinality: maka_plugin_core::contract::Cardinality::One,
        },
    )]);
    files.insert(MANIFEST_FILE.into(), {
        manifest.application =
            Some(maka_plugin_core::package::CheckedDeclaration::new(manifest_application).unwrap());
        serde_json::to_vec(&manifest).unwrap()
    });
    let recovery_consumer = Package::new(files).unwrap();
    let node = |key, package: &Package, configuration, bindings| Node {
        key: Uuid::from_u128(key),
        package: package.application_ref().into(),
        use_package: PackageUse::Host,
        configuration,
        bindings,
        parameters: Default::default(),
        disabled: false,
        overrides: vec![],
    };
    let input = Input {
        ui: None,
        instances: BTreeMap::from([
            (
                "outcomes".into(),
                node(4, &reader, Default::default(), BTreeMap::new()),
            ),
            (
                "recovery".into(),
                node(
                    3,
                    &recovery_consumer,
                    Default::default(),
                    BTreeMap::from([(
                        "outcomes".into(),
                        vec![Target::Instance {
                            path: vec!["outcomes".into()],
                            export: maka_skills_api::outcomes::EXPORT.into(),
                        }],
                    )]),
                ),
            ),
            (
                "skills".into(),
                node(
                    1,
                    &provider,
                    NodeConfiguration {
                        parameters: Default::default(),
                        values: BTreeMap::from([
                            ("manage".into(), json!(true)),
                            (
                                "sources".into(),
                                json!([{"id":"local","label":"Local","path":source}]),
                            ),
                        ]),
                    },
                    BTreeMap::new(),
                ),
            ),
            (
                "caller".into(),
                node(
                    2,
                    &consumer,
                    Default::default(),
                    BTreeMap::from([(
                        EXPORT.into(),
                        vec![Target::Instance {
                            path: vec!["skills".into()],
                            export: EXPORT.into(),
                        }],
                    )]),
                ),
            ),
        ]),
    };
    (input, vec![provider, consumer, reader, recovery_consumer])
}
struct Pause {
    inner: Arc<dyn Handler>,
    ready: PathBuf,
    after: bool,
}
impl Handler for Pause {
    fn call(
        &self,
        method: String,
        input: Value,
        context: Context,
    ) -> BoxFuture<'static, Result<Value, String>> {
        let original = context.operation().cloned();
        let wait =
            method == std::env::var("MAKA_SKILL_CRASH_METHOD").unwrap_or_else(|_| "apply".into());
        let after = self.after;
        let ready = self.ready.clone();
        let inner = self.inner.clone();
        Box::pin(async move {
            if !wait {
                return inner.call(method, input, context).await;
            }
            if after {
                inner.call(method, input, context).await?;
            }
            let bytes = serde_json::to_vec(&original.unwrap()).unwrap();
            // The parent kills this actual Host process only after the selected
            // callback cut. No Host result/cleanup is returned or synthesized.
            std::fs::write(&ready, bytes).unwrap();
            futures_util::future::pending().await
        })
    }
}
struct Fixture {
    store: Arc<RootStore>,
    app: Application,
    issuer: Issuer,
}
impl Fixture {
    async fn open(dir: &Path, cut: Option<bool>) -> Self {
        let acquire = if cut.is_some() {
            RootOwner::create
        } else {
            RootOwner::open
        };
        let root = Arc::new(
            acquire(
                &dir.join("host"),
                &RootNamespaces {
                    ownership: dir.join("owners"),
                    control: dir.join("control"),
                },
            )
            .unwrap(),
        );
        let store = Arc::new(RootStore::open(root).await.unwrap());
        if store.load_application(DEPLOYMENT).await.unwrap().is_none() {
            let (input, packages) = packages(&dir.join("source"));
            store
                .commit_application(DEPLOYMENT, 0, input, vec![], packages)
                .await
                .unwrap();
        }
        let mut native = NativeRegistry::default();
        if let Some(after) = cut {
            let ready = dir.join("ready.json");
            native
                .insert(
                    IMPLEMENTATION.into(),
                    Arc::new(move |context, configuration| {
                        let ready = ready.clone();
                        Box::pin(async move {
                            let mut activation = activate(context, configuration).await;
                            let export = activation
                                .exports
                                .as_mut()
                                .unwrap()
                                .get_mut(EXPORT)
                                .unwrap();
                            export.value = Arc::new(Pause {
                                inner: export.value.clone(),
                                ready,
                                after,
                            });
                            activation
                        })
                    }),
                )
                .unwrap();
            outcomes::provide(&mut native).unwrap();
        } else {
            provide(&mut native).unwrap();
        }
        let issuer = Issuer::default();
        let app = Application::start_from_store(
            store.clone(),
            DEPLOYMENT,
            native,
            issuer.clone(),
            Arc::new(Grant(issuer.clone())),
            Some(maka_host_js::factory(Default::default())),
        )
        .await
        .unwrap();
        app.ready().await.unwrap();
        Self { store, app, issuer }
    }
    fn scope(&self, recovery: bool) -> Scope {
        self.issuer
            .issue_with(
                Identity::Remote {
                    request_id: Uuid::new_v4(),
                },
                recovery,
                CancellationToken::new(),
            )
            .unwrap()
    }
    async fn binding(&self) -> Binding {
        let client = self.app.client();
        client
            .bind(client.activation(&id(2)).unwrap(), EXPORT.into())
            .await
            .unwrap()
            .remove(0)
    }
    async fn query(&self, method: &str, input: Value, recovery: bool) -> Result<Value, String> {
        let client = self.app.client();
        let (binding, method) = if method == "outcome" {
            (
                client
                    .bind(client.activation(&id(3)).unwrap(), "outcomes".into())
                    .await?
                    .remove(0),
                "read",
            )
        } else {
            (self.binding().await, method)
        };
        client
            .start(
                binding,
                method.into(),
                input,
                self.scope(recovery),
                Attachments::new().into(),
            )
            .await?
            .result()
            .await
    }
    async fn close(self) {
        self.app.shutdown().await.unwrap();
        drop(self.app);
        self.store.shutdown().await.unwrap();
    }
}
#[tokio::test]
#[ignore = "subprocess crash fixture; invoked by publication_results_survive_host_process_loss"]
async fn crash_worker() {
    let dir = PathBuf::from(std::env::var_os("MAKA_SKILL_CRASH_ROOT").expect("subprocess root"));
    let after = std::env::var("MAKA_SKILL_CRASH_CUT").unwrap() == "after";
    let fixture = Fixture::open(&dir, Some(after)).await;
    let method = std::env::var("MAKA_SKILL_CRASH_METHOD").unwrap();
    let (input, resources) = if method == "importSource" {
        let (input, resources, _) = super::imported("review", super::document("original"));
        (json!(input), resources)
    } else {
        let page = fixture
            .query("list", json!({"query":"","cursor":null}), false)
            .await
            .unwrap();
        let preview = fixture.query("preview", json!({"kind":"install","reference":"source:local:review","revision":page["revision"]}), false).await.unwrap();
        (preview["review"].clone(), Attachments::new())
    };
    let prepared = fixture
        .app
        .client()
        .prepare_mutation(
            fixture.binding().await,
            method,
            input,
            fixture.scope(false),
            Uuid::new_v4(),
            resources.into(),
        )
        .await
        .unwrap();
    let reference = prepared.reference().clone();
    let intent = fixture
        .store
        .record_application_intent(
            reference.source.clone(),
            prepared.consumer().instance().clone(),
            reference,
            Value::Null,
        )
        .await
        .unwrap();
    fixture
        .app
        .client()
        .mutate(prepared, intent)
        .await
        .unwrap()
        .result()
        .await;
    panic!("crash cut must not return");
}
struct Child(std::process::Child);
impl Drop for Child {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
#[tokio::test]
async fn publication_results_survive_host_process_loss_without_replaying_or_weakening_authority() {
    for (method, cut) in [("apply", "before"), ("importSource", "after")] {
        let directory = tempfile::tempdir().unwrap();
        let dir = directory.path();
        std::fs::create_dir_all(dir.join("source/review")).unwrap();
        std::fs::write(
            dir.join("source/review/SKILL.md"),
            super::document("original"),
        )
        .unwrap();
        let log = std::fs::File::create(dir.join("child.log")).unwrap();
        let mut child = Child(
            std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--ignored",
                    "--exact",
                    "management::tests::recovery::crash_worker",
                    "--nocapture",
                ])
                .env("MAKA_SKILL_CRASH_ROOT", dir)
                .env("MAKA_SKILL_CRASH_CUT", cut)
                .env("MAKA_SKILL_CRASH_METHOD", method)
                .stdout(log.try_clone().unwrap())
                .stderr(log)
                .spawn()
                .unwrap(),
        );
        let deadline = Instant::now() + Duration::from_secs(45);
        let reference: RecoveryRef = loop {
            if let Ok(bytes) = std::fs::read(dir.join("ready.json"))
                && let Ok(reference) = serde_json::from_slice(&bytes)
            {
                break reference;
            }
            assert!(
                child.0.try_wait().unwrap().is_none() && Instant::now() < deadline,
                "crash worker stopped or timed out: {}",
                std::fs::read_to_string(dir.join("child.log")).unwrap()
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        };
        child.0.kill().unwrap();
        assert!(!child.0.wait().unwrap().success());
        let fixture = Fixture::open(dir, None).await;
        let observation = fixture
            .store
            .operation(&reference)
            .unwrap()
            .operation_observation()
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(observation.outcome, OperationOutcome::Unresolved));
        assert!(matches!(observation.cleanup, OperationCleanup::Unconfirmed));
        let namespace = maka_host_runtime::storage::instance_prefix(
            &reference.source.state_domain,
            reference.source.deployment,
            &reference.namespace,
        );
        let data = dir.join("host/skill-libraries").join(namespace);
        let data = if method == "importSource" {
            data.join("imported")
        } else {
            data
        };
        let installed = data.join("skills/review");
        assert_eq!(installed.exists(), cut == "after");
        if installed.exists() {
            std::fs::remove_dir_all(&installed).unwrap();
        }
        // Recovery must survive removal of the business provider and caller.
        let loaded = fixture
            .store
            .load_application(DEPLOYMENT)
            .await
            .unwrap()
            .unwrap();
        let (mut loaded_source, loaded_packages, _, _) = loaded.into_parts();
        loaded_source.input.instances.remove("skills");
        loaded_source.input.instances.remove("caller");
        let next = fixture
            .store
            .commit_application(
                DEPLOYMENT,
                loaded_source.reference.revision,
                loaded_source.input,
                vec![],
                loaded_packages,
            )
            .await
            .unwrap();
        fixture.app.adopt_committed(next).await.unwrap();
        fixture.app.ready().await.unwrap();
        if cut == "before" {
            std::fs::remove_dir_all(dir.join("host/skill-libraries")).unwrap();
        }
        assert!(
            fixture
                .query("outcome", json!(reference), false)
                .await
                .is_err(),
            "method access is not recovery authority"
        );
        let value: contract::Outcome = serde_json::from_value(
            fixture
                .query("outcome", json!(reference), true)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(value.original.reference, reference);
        assert!(matches!(
            value.original.receipt,
            Receipt::Recorded {
                outcome: OperationOutcome::Unresolved,
                cleanup: OperationCleanup::Unconfirmed
            }
        ));
        assert_eq!(value.published.is_some(), cut == "after");
        if let Some(result) = value.published {
            assert!(
                matches!(result,ChangeResult::Applied {reference} if reference == if method == "importSource" { "imported:review" } else { "installed:review" })
            );
        }
        assert!(
            !installed.exists(),
            "outcome lookup cannot reinstall a removed result"
        );
        if cut == "before" {
            assert!(
                !dir.join("host/skill-libraries").exists(),
                "read must not initialize a missing collection"
            );
        }
        #[cfg(unix)]
        if cut == "after" {
            std::fs::rename(data.join("receipts"), data.join("saved-receipts")).unwrap();
            std::os::unix::fs::symlink("saved-receipts", data.join("receipts")).unwrap();
            assert!(
                fixture
                    .query("outcome", json!(reference), true)
                    .await
                    .is_err(),
                "private receipt directories must not follow links"
            );
            std::fs::remove_file(data.join("receipts")).unwrap();
            std::fs::rename(data.join("saved-receipts"), data.join("receipts")).unwrap();
        }
        for field in ["stateDomain", "deployment", "namespace", "fingerprint"] {
            let mut wrong = json!(reference);
            match field {
                "stateDomain" => wrong["source"][field] = json!("b".repeat(64)),
                "deployment" => wrong["source"][field] = json!(Uuid::new_v4()),
                "namespace" => wrong[field] = json!([Uuid::new_v4()]),
                _ => wrong[field] = json!("sha256-".to_owned() + &"b".repeat(64)),
            }
            if let Ok(value) = fixture.query("outcome", wrong, true).await {
                let outcome: contract::Outcome = serde_json::from_value(value).unwrap();
                assert!(matches!(outcome.original.receipt, Receipt::NotRecorded));
                assert!(
                    outcome.published.is_none(),
                    "changed {field} cannot release another receipt"
                );
            }
        }
        let after = fixture
            .store
            .operation(&reference)
            .unwrap()
            .operation_observation()
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            after, observation,
            "domain evidence must not rewrite Host result or cleanup"
        );
        fixture.close().await;
        std::fs::remove_dir_all(dir.join("source")).unwrap();
        let reopened = Fixture::open(dir, None).await;
        let value: contract::Outcome = serde_json::from_value(
            reopened
                .query("outcome", json!(reference), true)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(value.published.is_some(), cut == "after");
        assert!(!installed.exists());
        reopened.close().await;
    }
}

#[tokio::test]
async fn preference_mutations_require_independent_authority_and_keep_instance_state_across_activation()
 {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("source/review")).unwrap();
    std::fs::write(
        dir.path().join("source/review/SKILL.md"),
        super::document("original"),
    )
    .unwrap();
    let fixture = Fixture::open(dir.path(), Some(false)).await;
    let input = json!({"reference":"source:local:review","revision":0,"preference":{"enabled":false,"pinned":true}});
    let client = fixture.app.client();
    assert!(
        client
            .prepare_mutation(
                fixture.binding().await,
                "setPreference".into(),
                input.clone(),
                fixture.scope(false),
                Uuid::new_v4(),
                Attachments::new().into()
            )
            .await
            .is_err()
    );
    async fn mutate(
        fixture: &Fixture,
        input: Value,
    ) -> maka_plugin_core::operation::OperationReply {
        let client = fixture.app.client();
        let prepared = client
            .prepare_mutation(
                fixture.binding().await,
                "setPreference".into(),
                input,
                fixture.scope(true),
                Uuid::new_v4(),
                Attachments::new().into(),
            )
            .await
            .unwrap();
        let intent = fixture
            .store
            .record_application_intent(
                prepared.reference().source.clone(),
                prepared.consumer().instance().clone(),
                prepared.reference().clone(),
                Value::Null,
            )
            .await
            .unwrap();
        client
            .mutate(prepared, intent)
            .await
            .unwrap()
            .result()
            .await
    }
    let denied = mutate(&fixture, input.clone()).await;
    assert!(
        matches!(denied.receipt, Receipt::Recorded { outcome: OperationOutcome::Returned { ref value }, cleanup: OperationCleanup::Confirmed } if value["kind"] == "rejected" && value["reason"] == "read_only_preferences")
    );
    async fn configure(fixture: &Fixture, enabled: bool) {
        let loaded = fixture
            .store
            .load_application(DEPLOYMENT)
            .await
            .unwrap()
            .unwrap();
        let (mut loaded_source, loaded_packages, _, _) = loaded.into_parts();
        loaded_source
            .input
            .instances
            .get_mut("skills")
            .unwrap()
            .configuration
            .values
            .insert("preferences".into(), json!(enabled));
        let next = fixture
            .store
            .commit_application(
                DEPLOYMENT,
                loaded_source.reference.revision,
                loaded_source.input,
                vec![],
                loaded_packages,
            )
            .await
            .unwrap();
        fixture.app.adopt_committed(next).await.unwrap();
        fixture.app.ready().await.unwrap();
    }
    configure(&fixture, true).await;
    let before = fixture
        .query("list", json!({"query":"","cursor":null}), false)
        .await
        .unwrap();
    let applied = mutate(&fixture, input.clone()).await;
    assert!(
        matches!(applied.receipt, Receipt::Recorded { outcome: OperationOutcome::Returned { ref value }, cleanup: OperationCleanup::Confirmed } if value["kind"] == "applied")
    );
    let changed = fixture
        .query(
            "read",
            json!({"reference":"source:local:review","revision":before["revision"],"offset":0}),
            false,
        )
        .await
        .unwrap();
    assert_eq!(changed["kind"], "changed");
    let stale = mutate(&fixture, input).await;
    assert!(
        matches!(stale.receipt, Receipt::Recorded { outcome: OperationOutcome::Returned { ref value }, .. } if value["kind"] == "changed")
    );
    configure(&fixture, false).await;
    let page = fixture
        .query("list", json!({"query":"","cursor":null}), false)
        .await
        .unwrap();
    assert_eq!(page["preferencesWritable"], false);
    assert_eq!(page["preferenceRevision"], 1);
    assert_eq!(
        page["entries"][0]["preference"],
        json!({"enabled":false,"pinned":true})
    );
    let body = fixture
        .query(
            "read",
            json!({"reference":"source:local:review","revision":page["revision"],"offset":0}),
            false,
        )
        .await
        .unwrap();
    assert_eq!(body["text"], "original");
    fixture.close().await;
    let reopened = Fixture::open(dir.path(), None).await;
    let page = reopened
        .query("list", json!({"query":"","cursor":null}), false)
        .await
        .unwrap();
    assert_eq!(
        page["entries"][0]["preference"],
        json!({"enabled":false,"pinned":true})
    );
    reopened.close().await;
}

#[tokio::test]
async fn imported_source_operations_recover_through_the_original_host_after_library_removal() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join("source")).unwrap();
    let fixture = Fixture::open(dir.path(), Some(false)).await;
    async fn mutate(
        fixture: &Fixture,
        method: &str,
        input: Value,
        resources: Attachments,
    ) -> maka_plugin_core::operation::OperationReply {
        let client = fixture.app.client();
        let prepared = client
            .prepare_mutation(
                fixture.binding().await,
                method.into(),
                input,
                fixture.scope(false),
                Uuid::new_v4(),
                resources.into(),
            )
            .await
            .unwrap();
        let intent = fixture
            .store
            .record_application_intent(
                prepared.reference().source.clone(),
                prepared.consumer().instance().clone(),
                prepared.reference().clone(),
                Value::Null,
            )
            .await
            .unwrap();
        client
            .mutate(prepared, intent)
            .await
            .unwrap()
            .result()
            .await
    }
    let bytes = super::document("IMPORTED THROUGH ACTUAL HOST");
    let file = dir.path().join("chosen.md");
    std::fs::write(&file, &bytes).unwrap();
    let (input, mut resources, _) = super::imported("review", bytes);
    resources.insert(
        "file".into(),
        maka_ui_support::file::read_selected(&file).unwrap(),
    );
    let imported = mutate(&fixture, "importSource", json!(input), resources).await;
    assert!(
        matches!(&imported.receipt, Receipt::Recorded { outcome: OperationOutcome::Returned { value }, cleanup: OperationCleanup::Confirmed } if value["reference"]=="imported:review")
    );
    let page = fixture
        .query("list", json!({"query":"","cursor":null}), false)
        .await
        .unwrap();
    assert_eq!(page["entries"][0]["imported"], true);
    let preview = fixture
        .query(
            "preview",
            json!({"kind":"delete","reference":"imported:review","revision":page["revision"]}),
            false,
        )
        .await
        .unwrap();
    let deleted = mutate(
        &fixture,
        "deleteSource",
        preview["review"].clone(),
        Attachments::new(),
    )
    .await;
    assert!(
        matches!(&deleted.receipt, Receipt::Recorded { outcome: OperationOutcome::Returned { value }, cleanup: OperationCleanup::Confirmed } if value["reference"]=="imported:review")
    );
    let root = fixture
        .store
        .owned_root()
        .unwrap()
        .canonical_path()
        .to_owned();
    let namespace = maka_host_runtime::storage::instance_prefix(
        &imported.reference.source.state_domain,
        imported.reference.source.deployment,
        &imported.reference.namespace,
    );
    let collection = root
        .join("skill-libraries")
        .join(namespace)
        .join("imported");
    let loaded = fixture
        .store
        .load_application(DEPLOYMENT)
        .await
        .unwrap()
        .unwrap();
    let (loaded_source, loaded_packages, _, _) = loaded.into_parts();
    let mut input = loaded_source.input;
    input.instances.remove("skills");
    input.instances.remove("caller");
    fixture
        .store
        .commit_application(
            DEPLOYMENT,
            loaded_source.reference.revision,
            input,
            vec![],
            loaded_packages,
        )
        .await
        .unwrap();
    fixture.close().await;
    std::fs::remove_dir_all(dir.path().join("source")).unwrap();
    std::fs::remove_dir_all(collection.join("skills")).unwrap();
    let reopened = Fixture::open(dir.path(), None).await;
    for original in [imported, deleted] {
        assert!(
            reopened
                .query("outcome", json!(original.reference), false)
                .await
                .is_err()
        );
        let recovered = reopened
            .query("outcome", json!(original.reference), true)
            .await
            .unwrap();
        assert_eq!(recovered["original"], json!(original));
        assert_eq!(
            recovered["published"],
            json!({"kind":"applied","reference":"imported:review"})
        );
        let mut wrong = original.reference;
        wrong.method = "apply".into();
        if let Ok(value) = reopened.query("outcome", json!(wrong), true).await {
            assert!(value["published"].is_null());
        }
    }
    assert!(!collection.join("skills").exists());
    reopened.close().await;
}
