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
use maka_capabilities::call::{Identity, ReadResource, ResourceEncoding};
use maka_event_log::root::{RootNamespaces, RootOwner};
use maka_packages::MANIFEST_FILE;
use maka_plugin_core::{
    composition::Target,
    contract::{Availability, Cardinality, Export, Import, ResourceType, text_resource_type},
    deployment::management::{
        BindingCandidate, BindingCandidatesPage, InstanceSettingsPage, SettingValue,
    },
    package::{Declaration, EntryDeclaration},
    runtime::Runtime,
};
use serde_json::json;
use std::{ops::Range, time::Duration};

struct Fixture {
    manager: Manager,
    store: Arc<RootStore>,
    source: DeploymentRef,
    input: Input,
    _directory: tempfile::TempDir,
}
impl Fixture {
    async fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let owner = Arc::new(
            RootOwner::create(
                &directory.path().join("root"),
                &RootNamespaces {
                    ownership: directory.path().join("owners"),
                    control: directory.path().join("control"),
                },
            )
            .unwrap(),
        );
        let store = Arc::new(RootStore::open(owner).await.unwrap());
        let input = Input {
            ui: None,
            instances: BTreeMap::new(),
        };
        let source = store
            .commit_application(Uuid::new_v4(), 0, input.clone(), vec![], vec![])
            .await
            .unwrap();
        let manager = ManagementTarget::from_source(store.clone(), source.clone())
            .await
            .unwrap()
            .0;
        Self {
            manager,
            store,
            source,
            input,
            _directory: directory,
        }
    }
}

fn package(bytes: Vec<u8>) -> Package {
    Package::new(BTreeMap::from([
        (
            "maka.extension.json".into(),
            serde_json::to_vec(&json!({
                "schemaVersion":1,"id":"example.payload",
                "application":{"host":{
                    "implementation":{"kind":"native","implementation":"example.payload"},
                    "configuration":{"type":"object"},"imports":{},"exports":{}
                }}
            }))
            .unwrap(),
        ),
        ("图像.bin".into(), bytes),
    ]))
    .unwrap()
}

fn input(package: &Package) -> Input {
    serde_json::from_value(json!({
        "instances":{"payload":{
            "key":Uuid::from_u128(1),
            "package":{"source":"pinned","package":package.application_ref()},"usePackage":"host"
        }}
    }))
    .unwrap()
}

struct Snapshot {
    bytes: Vec<u8>,
    encoding: ResourceEncoding,
}
impl ReadResource for Snapshot {
    fn encoding(&self) -> ResourceEncoding {
        self.encoding
    }
    fn resource_type(&self) -> ResourceType {
        match self.encoding {
            ResourceEncoding::Utf8 => text_resource_type(),
            ResourceEncoding::Bytes => binary_resource_type(),
        }
    }
    fn bytes(&self) -> usize {
        self.bytes.len()
    }
    fn metadata(&self) -> Value {
        Value::Null
    }
    fn read(&self, range: Range<usize>) -> Result<Vec<u8>> {
        if self.encoding == ResourceEncoding::Utf8 {
            let text = std::str::from_utf8(&self.bytes).map_err(|error| error.to_string())?;
            if !text.is_char_boundary(range.start) || !text.is_char_boundary(range.end) {
                return Err("invalid UTF-8 range".into());
            }
        }
        self.bytes
            .get(range)
            .map(|bytes| bytes.to_vec())
            .ok_or("invalid range".into())
    }
}

fn attachments(document: &DeploymentDocument, packages: Option<Vec<u8>>) -> Attachments {
    let mut resources: Attachments = BTreeMap::from([(
        "document".into(),
        Arc::new(Snapshot {
            bytes: serde_json::to_vec(document).unwrap(),
            encoding: ResourceEncoding::Utf8,
        }) as Arc<dyn ReadResource>,
    )]);
    if let Some(bytes) = packages {
        resources.insert(
            "packages".into(),
            Arc::new(Snapshot {
                bytes,
                encoding: ResourceEncoding::Bytes,
            }),
        );
    }
    resources
}

fn bundles(packages: &[&Package]) -> Vec<u8> {
    let mut bytes = vec![b'['];
    for (index, package) in packages.iter().enumerate() {
        if index != 0 {
            bytes.push(b',');
        }
        bytes.extend(package.to_bundle());
    }
    bytes.push(b']');
    bytes
}

fn context(attachments: Attachments) -> Context {
    // A real kernel activation supplies the request identities without starting
    // an unrelated Application, backend or native service for this unit fixture.
    let package = package(vec![]);
    let mut packages = Packages::default();
    packages
        .insert_checked(
            package.application_ref(),
            package.manifest().application.clone().unwrap(),
        )
        .unwrap();
    let plan = Plan::prepare(&input(&package), &packages, &RemoteExports::new()).unwrap();
    let mut runtime = Runtime::<()>::new(plan);
    let activation = runtime
        .begin(&InstanceId(vec![Uuid::from_u128(1)]))
        .unwrap();
    Context {
        stream: None,
        caller: None,
        scope: Issuer::default()
            .issue(
                Identity::Remote {
                    request_id: Uuid::new_v4(),
                },
                CancellationToken::new(),
            )
            .unwrap(),
        consumer: activation.clone(),
        requester: activation,
        operation: None,
        operation_scope: None,
        attachments,
        imports: Arc::new(BTreeMap::new()),
        dispatch: Weak::new(),
    }
}

fn export(manager: Manager, source: DeploymentRef, package: PackageRef) -> (Subscription, Scope) {
    subscribe(
        manager,
        "exportPackage",
        json!({"source":source,"package":package}),
    )
}

fn subscribe(manager: Manager, method: &str, input: Value) -> (Subscription, Scope) {
    let method = method.to_owned();
    let mut context = context(Attachments::new());
    let scope = context.scope.clone();
    let (sender, receiver) = oneshot::channel();
    let contract = deployment_manager_contract();
    let Interface::Service { methods } = contract.interface else {
        unreachable!()
    };
    let validator = Arc::new(jsonschema::validator_for(&methods[&method].output).unwrap());
    let (stream, emitter) = subscriptions::channel(
        Accepted {
            id: Uuid::new_v4(),
            result: receiver,
        },
        validator.clone(),
        scope.cancellation.clone(),
    );
    context.stream = Some(emitter.clone());
    let finishing = scope.clone();
    tokio::spawn(async move {
        let result = manager
            .call(method, input, context)
            .await
            .and_then(|value| {
                if !value.is_null() {
                    validator
                        .validate(&value)
                        .map_err(|error| error.to_string())?;
                }
                Ok(value)
            });
        emitter.close();
        let cleanup = finishing.finish().await.map_err(|error| error.to_string());
        let _ = sender.send(QueryCompletion { result, cleanup });
    });
    (stream, scope)
}

#[tokio::test]
async fn ui_catalog_tracks_enabled_instances_at_the_original_revision() {
    tokio::time::timeout(Duration::from_secs(10), async {
        let fixture = Fixture::new().await;
        let installed = fixture
            .manager
            .install_source(json!({
                "expectedRevision": 1,
                "files": {
                    "maka.extension.json": json!({
                        "schemaVersion": 1, "id": "example.panel",
                        "application": {"ui": {
                            "module": "panel.js",
                            "configuration": {"type":"object", "properties": {
                                "greeting": {"type":"string", "default":"Hello"}
                            }},
                            "contributions": {
                                "panel": {"kind":"panel", "title":{"fallback":"Example panel","translations":{}}},
                                "root": {"kind":"root"}
                            }
                        }}
                    }).to_string(),
                    "panel.js": "throw new Error('UI modules must not execute in the Host');"
                }
            }))
            .await
            .unwrap();
        let package = installed["value"]["package"].clone();
        let source = installed["value"]["source"].clone();
        assert_eq!(
            fixture.manager.read_ui(json!({})).await.unwrap(),
            json!({
                "source": source, "instances": []
            })
        );
        let (mut changes, scope) =
            subscribe(fixture.manager.clone(), "watch", json!({"source":source}));
        let inserted = fixture
            .manager
            .edit_composition(json!({
                "expectedRevision": 2,
                "edits": [{"kind":"insert", "name":"example", "package":package,
                    "usePackage":"ui", "settings":[], "bindings":{}}]
            }))
            .await
            .unwrap();
        assert_eq!(inserted["status"], "committed", "{inserted}");
        let enabled = inserted["value"].clone();
        assert_eq!(changes.recv().await.unwrap(), enabled);
        let catalog = fixture
            .manager
            .read_ui(json!({"source":enabled}))
            .await
            .unwrap();
        let instance = catalog["instances"][0]["instance"].clone();
        let definition = catalog["instances"][0]["definitionBasis"].clone();
        let basis = catalog["instances"][0]["bindingBasis"].clone();
        assert_eq!(
            catalog,
            json!({"source": enabled, "instances": [{
                "instance": instance, "definitionBasis":definition, "bindingBasis":basis, "path":["example"], "package":package,
                "configuration":{"greeting":"Hello"}, "module":"panel.js", "imports":{},
                "contributions":{
                    "panel":{"kind":"panel", "title":{"fallback":"Example panel","translations":{}}},
                    "root":{"kind":"root"}
                }
            }]})
        );
        let loaded=fixture.manager.source_at(None).await.unwrap();
        let mut document=DeploymentDocument {
            input:loaded.source().input.clone(),
            remote_exports:loaded.source().remote_exports.clone(),
            packages:loaded.packages().iter().map(Package::application_ref).collect(),
        };
        document.input.ui=Some(maka_plugin_core::composition::UiTarget {path:vec!["example".into()],id:"root".into()});
        let selected=fixture.manager.replace_source(json!({"expectedRevision":3,"document":document})).await.unwrap();
        assert_eq!(selected["status"],"committed","{selected}");
        assert_eq!(changes.recv().await.unwrap(),selected["value"]);
        let selected_catalog=fixture.manager.read_ui(json!({})).await.unwrap();
        assert_eq!(selected_catalog["ui"],json!({"instance":instance,"id":"root"}));

        let original=document.input.instances.remove("example").unwrap();
        document.input.instances.insert("renamed".into(),original);
        document.input.ui.as_mut().unwrap().path=vec!["renamed".into()];
        let renamed=fixture.manager.replace_source(json!({"expectedRevision":4,"document":document})).await.unwrap();
        assert_eq!(renamed["status"],"committed","{renamed}");
        assert_eq!(changes.recv().await.unwrap(),renamed["value"]);
        let renamed_catalog=fixture.manager.read_ui(json!({})).await.unwrap();
        assert_eq!(renamed_catalog["ui"],selected_catalog["ui"]);
        assert_eq!(renamed_catalog["instances"][0]["path"],json!(["renamed"]));
        let disabled = fixture
            .manager
            .set_enabled(json!({
                "expectedRevision": 5, "instance":instance, "enabled":false
            }))
            .await
            .unwrap();
        assert_eq!(disabled["status"], "rejected", "{disabled}");
        document.input.ui=None;
        document.input.instances.get_mut("renamed").unwrap().disabled=true;
        let cleared=fixture.manager.replace_source(json!({"expectedRevision":5,"document":document})).await.unwrap();
        assert_eq!(cleared["status"],"committed","{cleared}");
        assert_eq!(changes.recv().await.unwrap(),cleared["value"]);
        assert_eq!(
            fixture.manager.read_ui(json!({})).await.unwrap(),
            json!({
                "source": cleared["value"], "instances": []
            })
        );
        assert_eq!(
            fixture
                .manager
                .read_ui(json!({"source":enabled}))
                .await
                .unwrap(),
            catalog
        );
        assert_eq!(fixture.manager.read_ui(json!({"source":selected["value"]})).await.unwrap(),selected_catalog);
        changes.cancel();
        let completion = changes.completion().await;
        completion.cleanup.unwrap();
        assert!(scope.resources.is_idle());
    })
    .await
    .expect("UI source subscription did not complete");
}

#[tokio::test]
async fn text_authoring_uses_original_source_revision_and_package_validation() {
    let fixture = Fixture::new().await;
    let Fixture {
        manager,
        store,
        source,
        input,
        ..
    } = &fixture;
    let files = json!({
        "maka.extension.json":json!({"schemaVersion":1,"id":"example.footer","application":{"host":{"implementation":{"kind":"javascript","module":"host.mjs","realm":"shared"},"configuration":{"type":"object"},"imports":{},"exports":{}}}}).to_string(),
        "host.mjs":"export function activate() { return {}; } // 界面"
    });
    let installed = manager
        .install_source(json!({"expectedRevision":1,"files":files}))
        .await
        .unwrap();
    let installed: ManagementResult<PackageInstalled> = serde_json::from_value(installed).unwrap();
    let ManagementResult::Committed { value } = installed else {
        panic!("valid package rejected")
    };
    assert_eq!(value.source.revision, 2);
    let read = manager
        .read_package(
            json!({"source":value.source,"package":value.package,"path":"host.mjs","offset":0}),
        )
        .await
        .unwrap();
    assert!(read["text"].as_str().unwrap().ends_with("界面"));
    let stale = manager
        .install_source(json!({"expectedRevision":1,"files":files}))
        .await
        .unwrap();
    assert_eq!(stale["status"], "conflict");
    let invalid = manager
        .install_source(json!({"expectedRevision":2,"files":{"../outside":"invalid"}}))
        .await
        .unwrap();
    assert_eq!(invalid["status"], "rejected");
    let mut foreign = value.source.clone();
    foreign.deployment = uuid::Uuid::new_v4();
    assert!(
        manager
            .read_package(json!({"source":foreign,"package":value.package,"path":null,"offset":0}))
            .await
            .is_err()
    );
    let replaced=manager.replace_source(json!({"expectedRevision":2,"document":{"input":input,"remoteExports":[],"packages":[value.package]}})).await.unwrap();
    assert_eq!(replaced["status"], "committed");
    assert_eq!(
        store
            .read_application_metadata(source.deployment)
            .await
            .unwrap()
            .unwrap()
            .source
            .reference
            .revision,
        3
    );
}

async fn replace(
    manager: &Manager,
    expected: u64,
    document: &DeploymentDocument,
    packages: Option<Vec<u8>>,
) -> Value {
    let context = context(attachments(document, packages));
    let scope = context.scope.clone();
    let result = manager
        .call(
            "replace".into(),
            json!({"expectedRevision":expected}),
            context,
        )
        .await
        .unwrap();
    scope.finish().await.unwrap();
    assert!(scope.resources.is_idle());
    result
}

#[tokio::test]
async fn replacement_commits_document_and_binary_packages_in_one_revision() {
    let fixture = Fixture::new().await;
    let first = package(vec![0, 255, 128, 13, 10]);
    let second = package(vec![0, 254, 129]);
    let document = DeploymentDocument {
        input: input(&first),
        remote_exports: vec![],
        packages: vec![first.application_ref(), second.application_ref()],
    };
    let result = replace(
        &fixture.manager,
        1,
        &document,
        Some(bundles(&[&first, &second])),
    )
    .await;
    assert_eq!(result["status"], "committed");
    assert_eq!(result["value"]["revision"], 2);
    let loaded = fixture
        .store
        .load_application(fixture.source.deployment)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(loaded.source().reference.revision, 2);
    assert_eq!(loaded.source().input, document.input);
    assert_eq!(loaded.packages().len(), 2);
    assert_eq!(
        loaded
            .packages()
            .iter()
            .find(|package| package.application_ref() == first.application_ref())
            .unwrap()
            .file("图像.bin"),
        first.file("图像.bin")
    );
    assert!(
        fixture
            .store
            .load_application_at(&fixture.source)
            .await
            .unwrap()
            .unwrap()
            .packages()
            .is_empty()
    );

    // Already installed bytes need no attachment, and omitted references are
    // actually removed rather than silently retained in the new source.
    let document = DeploymentDocument {
        input: input(&second),
        remote_exports: vec![],
        packages: vec![second.application_ref()],
    };
    let result = replace(&fixture.manager, 2, &document, None).await;
    assert_eq!(result["value"]["revision"], 3);
    let loaded = fixture
        .store
        .load_application(fixture.source.deployment)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(loaded.packages().len(), 1);
    assert_eq!(
        loaded.packages()[0].application_ref(),
        second.application_ref()
    );
}

#[tokio::test]
async fn invalid_bundles_documents_and_stale_replacements_leave_source_unchanged() {
    let fixture = Fixture::new().await;
    let selected = package(vec![0, 255]);
    let unrelated = package(vec![1, 254]);
    let document = DeploymentDocument {
        input: input(&selected),
        remote_exports: vec![],
        packages: vec![selected.application_ref()],
    };
    let mut duplicate_document = document.clone();
    duplicate_document.packages.push(selected.application_ref());
    let mut invalid_source = document.clone();
    // A required package differs from the document set, so full validation fails.
    invalid_source.input = input(&unrelated);
    for (document, supplied, reason) in [
        (&document, Some(b"[{}]".to_vec()), "invalid_bundle"),
        (
            &document,
            Some(bundles(&[&selected, &selected])),
            "invalid_bundle",
        ),
        (
            &document,
            Some(bundles(&[&selected, &unrelated])),
            "invalid_bundle",
        ),
        (&document, None, "package_unavailable"),
        (
            &duplicate_document,
            Some(bundles(&[&selected])),
            "invalid_document",
        ),
        (
            &invalid_source,
            Some(bundles(&[&selected])),
            "invalid_source",
        ),
    ] {
        let result = replace(&fixture.manager, 1, document, supplied).await;
        assert_eq!(result["status"], "rejected");
        assert_eq!(result["reason"], reason);
        let loaded = fixture
            .store
            .load_application(fixture.source.deployment)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(loaded.source().reference, fixture.source);
        assert_eq!(loaded.source().input, fixture.input);
        assert!(loaded.packages().is_empty());
    }
    let result = replace(&fixture.manager, 1, &document, Some(bundles(&[&selected]))).await;
    assert_eq!(result["value"]["revision"], 2);
    let stale = replace(&fixture.manager, 1, &document, Some(b"not JSON".to_vec())).await;
    assert_eq!(stale, json!({"status":"conflict","currentRevision":2}));
    assert_eq!(
        fixture
            .manager
            .metadata()
            .await
            .unwrap()
            .source
            .reference
            .revision,
        2
    );
}

#[tokio::test]
async fn historical_binary_bundle_export_round_trips_and_cancels_with_cleanup() {
    tokio::time::timeout(Duration::from_secs(10), async {
        let fixture = Fixture::new().await;
        let package = package((0..400_000).map(|index| (index % 256) as u8).collect());
        let historical = fixture
            .store
            .commit_application(
                fixture.source.deployment,
                1,
                input(&package),
                vec![],
                vec![package.clone()],
            )
            .await
            .unwrap();
        fixture
            .store
            .commit_application(
                fixture.source.deployment,
                2,
                fixture.input.clone(),
                vec![],
                vec![],
            )
            .await
            .unwrap();
        let (mut stream, scope) = export(
            fixture.manager.clone(),
            historical.clone(),
            package.application_ref(),
        );
        let mut bytes = Vec::new();
        let mut chunks = 0;
        let mut total = None;
        while let Some(value) = stream.recv().await {
            let PackageBundleExport::Chunk {
                offset,
                total_bytes,
                text,
            } = serde_json::from_value(value).unwrap()
            else {
                panic!("completion belongs to the final result");
            };
            assert_eq!(offset, bytes.len());
            assert!(text.len() <= 16 * 1024);
            assert!(total.is_none_or(|total| total == total_bytes));
            total = Some(total_bytes);
            bytes.extend_from_slice(text.as_bytes());
            chunks += 1;
        }
        assert!(chunks > 1);
        assert_eq!(total, Some(bytes.len()));
        let completion = stream.completion().await;
        assert_eq!(completion.result.unwrap(), json!({"kind":"complete"}));
        completion.cleanup.unwrap();
        assert!(scope.resources.is_idle());
        let restored = Package::from_bundle(&bytes).unwrap();
        assert_eq!(restored.application_ref(), package.application_ref());
        assert_eq!(restored.files(), package.files());

        let (mut stream, scope) = export(
            fixture.manager.clone(),
            historical.clone(),
            package.application_ref(),
        );
        assert!(stream.recv().await.is_some());
        stream.cancel();
        let completion = stream.completion().await;
        assert!(completion.result.is_err());
        completion.cleanup.unwrap();
        assert!(scope.cancellation.is_cancelled());
        assert!(scope.resources.is_idle());

        let mut foreign = historical;
        foreign.deployment = Uuid::new_v4();
        let (mut stream, _) = export(fixture.manager.clone(), foreign, package.application_ref());
        assert!(stream.recv().await.is_none());
        let completion = stream.completion().await;
        assert!(completion.result.unwrap_err().contains("foreign"));
        completion.cleanup.unwrap();
        let current = fixture.manager.metadata().await.unwrap().source.reference;
        let (mut stream, _) = export(fixture.manager.clone(), current, package.application_ref());
        assert!(stream.recv().await.is_none());
        let completion = stream.completion().await;
        assert!(completion.result.unwrap_err().contains("not installed"));
        completion.cleanup.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn immutable_document_resource_over_two_mib_roundtrips_through_validated_pages() {
    async fn read_all(manager: &Manager, source: &DeploymentRef) -> String {
        let contract = deployment_manager_contract();
        let Interface::Service { methods } = contract.interface else {
            unreachable!()
        };
        let method = &methods["readDocument"];
        let input_validator = jsonschema::validator_for(&method.input).unwrap();
        let output_validator = jsonschema::validator_for(&method.output).unwrap();
        let mut offset = 0;
        let mut text = String::new();
        let mut read_beyond_two_mib = false;
        loop {
            let input = json!({"source":source,"offset":offset});
            input_validator.validate(&input).unwrap();
            let context = context(Attachments::new());
            let scope = context.scope.clone();
            let value = manager
                .call("readDocument".into(), input, context)
                .await
                .unwrap();
            scope.finish().await.unwrap();
            assert!(scope.resources.is_idle());
            output_validator.validate(&value).unwrap();
            let chunk: DeploymentDocumentChunk = serde_json::from_value(value).unwrap();
            assert_eq!(&chunk.source, source);
            assert_eq!(chunk.offset, offset);
            assert!(chunk.text.len() <= 65536);
            read_beyond_two_mib |= chunk.offset > 2 * 1024 * 1024;
            text.push_str(&chunk.text);
            if let Some(next) = chunk.next {
                assert_eq!(next, text.len());
                assert!(next > offset);
                offset = next;
            } else {
                assert_eq!(text.len(), chunk.total_bytes);
                break;
            }
        }
        assert!(
            read_beyond_two_mib,
            "public continuation offsets must cross the old document limit"
        );
        text
    }

    let fixture = Fixture::new().await;
    let selected = package(vec![0, 255, 128]);
    let mut large_input = input(&selected);
    let padding = format!("界{}\n🙂尾", "x".repeat(2 * 1024 * 1024 + 128 * 1024));
    large_input
        .instances
        .get_mut("payload")
        .unwrap()
        .configuration
        .values
        .insert("padding".into(), json!(padding));
    let document = DeploymentDocument {
        input: large_input,
        remote_exports: vec![],
        packages: vec![selected.application_ref()],
    };
    assert!(serde_json::to_vec(&document).unwrap().len() > 2 * 1024 * 1024);
    let replaced = replace(&fixture.manager, 1, &document, Some(bundles(&[&selected]))).await;
    if replaced["status"] != "committed" {
        fixture.store.shutdown().await.unwrap();
    }
    assert_eq!(replaced["status"], "committed", "{replaced}");
    let source: DeploymentRef = serde_json::from_value(replaced["value"].clone()).unwrap();
    assert_eq!(source.revision, 2);
    let first = read_all(&fixture.manager, &source).await;
    assert!(
        serde_json::from_str::<Value>(&first).unwrap() == serde_json::to_value(&document).unwrap(),
        "paged document differs from the complete original source"
    );

    let mut foreign = source.clone();
    foreign.deployment = Uuid::new_v4();
    for (selected, offset, expected) in [
        (
            source.clone(),
            first.find('界').unwrap() + 1,
            "invalid document byte offset",
        ),
        (foreign, 0, "foreign managed deployment source"),
    ] {
        let context = context(Attachments::new());
        let scope = context.scope.clone();
        assert_eq!(
            fixture
                .manager
                .call(
                    "readDocument".into(),
                    json!({"source":selected,"offset":offset}),
                    context,
                )
                .await
                .unwrap_err(),
            expected
        );
        scope.finish().await.unwrap();
    }

    // Advancing the head cannot reinterpret any old-source continuation.
    let smaller = DeploymentDocument {
        input: fixture.input.clone(),
        remote_exports: vec![],
        packages: vec![],
    };
    let newer = replace(&fixture.manager, 2, &smaller, None).await;
    assert_eq!(newer["status"], "committed", "{newer}");
    assert_eq!(newer["value"]["revision"], 3);
    let repeated = read_all(&fixture.manager, &source).await;
    assert!(
        repeated == first,
        "later head changed the original source pages"
    );
    assert!(
        serde_json::from_str::<Value>(&repeated).unwrap()
            == serde_json::to_value(&document).unwrap(),
        "original document bytes did not survive the later head"
    );
    fixture.store.shutdown().await.unwrap();
}

#[tokio::test]
async fn settings_forms_preserve_exact_numbers_unedited_sources_and_original_cas() {
    use maka_plugin_core::composition::{PackageUse, Parameter, Template};
    let f = Fixture::new().await;
    let node = |package: &Package, key| -> maka_plugin_core::composition::Node {
        serde_json::from_value(json!({"key":Uuid::from_u128(key),"package":{"source":"pinned","package":package.application_ref()},"usePackage":"host"})).unwrap()
    };
    let schema = json!({"type":"object","additionalProperties":false,
        "properties":{
            "label":{"type":"string","title":"Display name"},
            "limit":{"type":"integer","minimum":1},
            "enabled":{"type":"boolean"},
            "details":{"$ref":"#/$defs/details"},
        },"required":["label","limit","enabled","details"],
        "$defs":{"details":{"type":"object","properties":{"path":{"type":"string"},"opaque":{"type":"integer"}},"required":["path","opaque"],"additionalProperties":false}}
    });
    let leaf = Package::new(BTreeMap::from([(MANIFEST_FILE.into(), serde_json::to_vec(&json!({
        "schemaVersion":1,"id":"form.leaf","application":Declaration {
            host: Some(EntryDeclaration { implementation:Implementation::Native { implementation:"unused.form.availability".into() },
                configuration:schema.into(), imports:BTreeMap::new(), exports:BTreeMap::new(),
            }), ui: None,composition:None,
        }
    })).unwrap())])).unwrap();
    let values: BTreeMap<String, Value> = serde_json::from_value(json!({
        "label":"original", "limit":9007199254740993_u64, "enabled":true,
        "details":{"path":"original/path","opaque":18446744073709551615_u64},
    }))
    .unwrap();
    let mut root = node(&leaf, 77);
    root.configuration.values = values.clone();
    let mut child = node(&leaf, 78);
    child.configuration.values = values;
    child.configuration.values.remove("label");
    child
        .configuration
        .parameters
        .insert("label".into(), "name".into());
    let template = Package::new(BTreeMap::from([(MANIFEST_FILE.into(), serde_json::to_vec(&json!({
        "schemaVersion":1,"id":"form.product","application":Declaration {
            host: None, ui: None,composition:Some(Template {
                parameters:BTreeMap::from([("name".into(),Parameter { schema:json!({"type":"string"}).into(),default:None })]),
                imports:BTreeMap::new(),exports:BTreeMap::new(),children:BTreeMap::from([("child".into(),child)]),
            }),
        }
    })).unwrap())])).unwrap();
    let mut product = node(&template, 79);
    product.use_package = PackageUse::Composition;
    product
        .parameters
        .values
        .insert("name".into(), json!("inherited name"));
    let original_product = product.clone();
    let source = f
        .store
        .commit_application(
            f.source.deployment,
            1,
            Input {
                ui: None,
                instances: BTreeMap::from([
                    ("settings".into(), root.clone()),
                    ("product".into(), product),
                ]),
            },
            vec![],
            vec![leaf, template],
        )
        .await
        .unwrap();
    let read = |source: &DeploymentRef, instance: InstanceId, path: Vec<&str>| json!({"source":source,"instance":instance,"path":path,"after":null});
    let page: InstanceSettingsPage = serde_json::from_value(
        f.manager
            .read_settings(read(&source, InstanceId(vec![Uuid::from_u128(77)]), vec![]))
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        page.fields.iter().find(|f| f.key == "limit").unwrap().value,
        Some(SettingValue::Number {
            text: "9007199254740993".into()
        })
    );
    let changed = f
        .manager
        .configure(
            json!({"expectedRevision":2,"instance":InstanceId(vec![Uuid::from_u128(77)]),"changes":[
                {"path":["label"],"value":{"kind":"text","text":"新名称🙂"}},
                {"path":["details","path"],"value":{"kind":"text","text":"new/path"}},
                {"path":["limit"],"value":{"kind":"number","text":"9007199254740995"}},
            ]}),
        )
        .await
        .unwrap();
    let next: DeploymentRef = serde_json::from_value(changed["value"].clone()).unwrap();
    let current = f.manager.metadata().await.unwrap();
    let actual = &current.source.input.instances["settings"];
    assert_eq!(
        actual.configuration.values["limit"],
        json!(9007199254740995_u64)
    );
    assert_eq!(
        actual.configuration.values["details"]["opaque"],
        json!(18446744073709551615_u64)
    );
    assert_eq!(actual.bindings, root.bindings);
    assert_eq!(actual.package, root.package);
    assert_eq!(current.source.input.instances["product"], original_product);
    // An old form remains a frozen read, but cannot overwrite a newer source.
    assert_eq!(
        f.manager
            .read_settings(read(&source, InstanceId(vec![Uuid::from_u128(77)]), vec![]))
            .await
            .unwrap(),
        serde_json::to_value(page).unwrap()
    );
    let conflict = f.manager.configure(json!({"expectedRevision":2,"instance":InstanceId(vec![Uuid::from_u128(77)]),"changes":[{"path":["label"],"value":{"kind":"text","text":"stale"}}]})).await.unwrap();
    assert_eq!(conflict["status"], "conflict");
    let nested = InstanceId(vec![Uuid::from_u128(79), Uuid::from_u128(78)]);
    let configured = f.manager.configure(json!({"expectedRevision":next.revision,"instance":nested,"changes":[{"path":["enabled"],"value":{"kind":"boolean","value":false}}]})).await.unwrap();
    assert_eq!(configured["status"], "committed");
    let current = f.manager.metadata().await.unwrap();
    let product = &current.source.input.instances["product"];
    assert_eq!(product.parameters, original_product.parameters);
    assert_eq!(product.overrides.len(), 1);
    assert_eq!(
        product.overrides[0].configuration,
        BTreeMap::from([("enabled".into(), json!(false))])
    );
    let fields: InstanceSettingsPage = serde_json::from_value(
        f.manager
            .read_settings(read(&current.source.reference, nested, vec![]))
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
}

#[tokio::test]
async fn composition_choices_and_atomic_edits_preserve_source_bindings_and_unrelated_instances() {
    let f = Fixture::new().await;
    let node = |package: &Package, key| -> maka_plugin_core::composition::Node {
        serde_json::from_value(json!({"key":Uuid::from_u128(key),"package":{"source":"pinned","package":package.application_ref()},"usePackage":"host"})).unwrap()
    };
    let contract = deployment_manager_contract();
    let make = |name: &str, configuration: Value, imports, exports| {
        Package::new(BTreeMap::from([(MANIFEST_FILE.into(), serde_json::to_vec(&json!({
            "schemaVersion":1,"id":name,"application":Declaration {
                host: Some(EntryDeclaration { implementation:Implementation::Native { implementation:"test.form".into() },
                    configuration: configuration.into(), imports, exports,
                }), ui: None,composition:None,
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
    let mut catalog_node = node(&catalog, 80);
    catalog_node
        .configuration
        .values
        .insert("entries".into(), json!([]));
    catalog_node.bindings.insert("pages".into(), vec![]);
    let source = f
        .store
        .commit_application(
            f.source.deployment,
            1,
            Input {
                ui: None,
                instances: BTreeMap::from([
                    ("apps".into(), catalog_node),
                    ("provider".into(), node(&provider, 81)),
                ]),
            },
            vec![],
            vec![catalog, leaf.clone(), provider],
        )
        .await
        .unwrap();
    let query = json!({"source":source,"consumer":{"kind":"root","name":"apps"},"import":"pages","includePackages":true,"after":null});
    let choices: BindingCandidatesPage =
        serde_json::from_value(f.manager.binding_candidates(query.clone()).await.unwrap()).unwrap();
    assert!(choices.current.is_empty());
    assert_eq!(choices.configuration["entries"], json!([]));
    assert!(choices.candidates.iter().any(
        |c| matches!(c,BindingCandidate::Package {package,..} if package == &leaf.application_ref())
    ));
    let required: BindingCandidatesPage = serde_json::from_value(f.manager.binding_candidates(json!({"source":source,"consumer":{"kind":"package","package":leaf.application_ref()},"import":"provider","includePackages":false,"after":null})).await.unwrap()).unwrap();
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
    let edit = json!({"expectedRevision":source.revision,"edits":[
        {"kind":"insert","usePackage":"host","name":"custom","package":leaf.application_ref(),"settings":[{"path":["label"],"value":{"kind":"text","text":"My app"}},{"path":["preferences","path"],"value":{"kind":"text","text":"notes/local"}}],"bindings":{"provider":[provider_target]}},
        {"kind":"update","name":"apps","configuration":{"entries":[{"id":"custom","label":"My app"}]},"bindings":{"pages":[{"kind":"instance","path":["custom"],"export":"Page"}]}}
    ]});
    let mut invalid = edit.clone();
    invalid["edits"][0]["bindings"] = json!({});
    let rejected = f.manager.edit_composition(invalid).await.unwrap();
    assert_eq!(rejected["status"], "rejected");
    assert_eq!(f.manager.metadata().await.unwrap().source.reference, source);
    assert!(
        !f.manager
            .metadata()
            .await
            .unwrap()
            .source
            .input
            .instances
            .contains_key("custom")
    );
    let committed = f.manager.edit_composition(edit.clone()).await.unwrap();
    assert_eq!(committed["status"], "committed");
    let current = f.manager.metadata().await.unwrap();
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
        f.manager.binding_candidates(query).await.unwrap(),
        serde_json::to_value(choices).unwrap()
    );
    let stale = f.manager.edit_composition(edit).await.unwrap();
    assert_eq!(stale["status"], "conflict");
    // Removing a gallery entry does not delete the original plugin instance.
    let removed = f.manager.edit_composition(json!({"expectedRevision":current.source.reference.revision,"edits":[{"kind":"update","name":"apps","configuration":{"entries":[]},"bindings":{"pages":[]}}]})).await.unwrap();
    assert_eq!(removed["status"], "committed");
    assert_eq!(
        &f.manager.metadata().await.unwrap().source.input.instances["custom"],
        custom
    );
}

#[tokio::test]
async fn fixed_target_factory_requires_the_original_root_owner() {
    let original = Fixture::new().await;
    let foreign = Fixture::new().await;
    let mut registry = NativeRegistry::default();
    provide_target(
        &mut registry,
        "fixed.target".into(),
        ManagementTarget(original.manager.clone()),
    )
    .unwrap();
    for (store, source, allowed) in [
        (original.store.clone(), original.source.clone(), true),
        (foreign.store.clone(), foreign.source.clone(), false),
    ] {
        let activation = context(Attachments::new()).consumer;
        let result = registry.0["fixed.target"](
            NativeContext {
                package: package(vec![]).application_ref(),
                activation: activation.clone(),
                persistence: Some(NativePersistence { source, store }),
                services: NativeServices {
                    activation,
                    imports: Arc::new(BTreeMap::new()),
                    dispatch: Weak::new(),
                    issuer: Issuer::default(),
                    preparation_resources:
                        maka_capabilities::model_preparation::ModelPreparationResources::new(
                            Default::default(),
                        )
                        .unwrap(),
                },
            },
            json!({}),
        )
        .await;
        if allowed {
            let exports = result.exports.unwrap();
            let value = exports["Management"]
                .value
                .call("read".into(), json!({}), context(Attachments::new()))
                .await
                .unwrap();
            assert_eq!(
                value["source"]["reference"],
                serde_json::to_value(&original.source).unwrap()
            );
        } else {
            assert!(
                matches!(result.exports, Err(error) if error == "management target requires the same original Root owner")
            );
        }
        result.owner.close().await.unwrap();
    }
    assert_eq!(
        foreign.manager.metadata().await.unwrap().source.reference,
        foreign.source
    );
    original.store.shutdown().await.unwrap();
    foreign.store.shutdown().await.unwrap();
}
