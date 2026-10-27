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
use maka_plugin_core::{
    contract::{ResourceType, text_resource_type},
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
        let basis = catalog["instances"][0]["bindingBasis"].clone();
        assert_eq!(
            catalog,
            json!({"source": enabled, "instances": [{
                "instance": instance, "bindingBasis":basis, "path":["example"], "package":package,
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

async fn k64_manager_call(manager: &Manager, method: &str, input: Value) -> Value {
    let contract = deployment_manager_contract();
    let Interface::Service { methods } = contract.interface else {
        unreachable!()
    };
    let method_schema = &methods[method];
    jsonschema::validator_for(&method_schema.input)
        .unwrap()
        .validate(&input)
        .unwrap();
    let context = context(Attachments::new());
    let scope = context.scope.clone();
    let result = manager.call(method.into(), input, context).await.unwrap();
    scope.finish().await.unwrap();
    assert!(scope.resources.is_idle());
    jsonschema::validator_for(&method_schema.output)
        .unwrap()
        .validate(&result)
        .unwrap();
    result
}

#[tokio::test]
async fn k64_complete_package_files_bytes_and_long_paths_roundtrip_through_management() {
    let fixture = Fixture::new().await;
    let mut files = package(vec![]).files().clone();
    files.remove("图像.bin");
    for index in 0..253 {
        files.insert(format!("assets/{index:03}.bin"), vec![(index % 251) as u8]);
    }
    files.insert("large-a.bin".into(), vec![0x81; 8 * 1024 * 1024 + 1]);
    files.insert("large-b.bin".into(), vec![0xfe; 8 * 1024 * 1024 + 1]);
    let long_path = format!("{}last.bin", "original-segment/".repeat(33));
    assert!(long_path.len() > 512);
    files.insert(long_path.clone(), vec![0, 255, 128, 13, 10]);
    assert_eq!(files.len(), 257);
    let selected = Package::new(files).unwrap();
    let document = DeploymentDocument {
        input: input(&selected),
        remote_exports: vec![],
        packages: vec![selected.application_ref()],
    };
    let result = replace(&fixture.manager, 1, &document, Some(bundles(&[&selected]))).await;
    assert_eq!(result["status"], "committed", "{result}");
    let source: DeploymentRef = serde_json::from_value(result["value"].clone()).unwrap();
    let loaded = fixture
        .store
        .load_application_at(&source)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        loaded.packages()[0].application_ref(),
        selected.application_ref()
    );
    assert!(
        loaded.packages()[0].files() == selected.files(),
        "persisted original package bytes differ"
    );
    assert_eq!(
        loaded.packages()[0].file(&long_path),
        Some(&[0, 255, 128, 13, 10][..])
    );
    let (mut stream, scope) = export(
        fixture.manager.clone(),
        source.clone(),
        selected.application_ref(),
    );
    let mut bytes = Vec::new();
    while let Some(value) = stream.recv().await {
        let PackageBundleExport::Chunk {
            offset,
            total_bytes,
            text,
        } = serde_json::from_value(value).unwrap()
        else {
            panic!("completion belongs to the final result")
        };
        assert_eq!(offset, bytes.len());
        assert!(text.len() <= 16 * 1024);
        bytes.extend_from_slice(text.as_bytes());
        assert!(bytes.len() <= total_bytes);
    }
    let completion = stream.completion().await;
    assert_eq!(completion.result.unwrap(), json!({"kind":"complete"}));
    completion.cleanup.unwrap();
    scope.finish().await.unwrap();
    let restored = Package::from_bundle(&bytes).unwrap();
    assert_eq!(restored.application_ref(), selected.application_ref());
    assert!(
        restored.files() == selected.files(),
        "export/reimport changed original package bytes"
    );
    let target = fixture._directory.path().join("complete.maka-package.json");
    selected.export_to(&target).unwrap();
    assert!(Package::read_from(&target).unwrap().files() == selected.files());
    assert!(
        selected.export_to(&target).is_err(),
        "export must not overwrite an existing publication"
    );
    let current = replace(
        &fixture.manager,
        2,
        &DeploymentDocument {
            input: fixture.input.clone(),
            remote_exports: vec![],
            packages: vec![],
        },
        None,
    )
    .await;
    assert_eq!(current["status"], "committed");
    let historical = fixture
        .store
        .load_application_at(&source)
        .await
        .unwrap()
        .unwrap();
    assert!(
        historical.packages()[0].files() == selected.files(),
        "new head changed the original package"
    );
    fixture.store.shutdown().await.unwrap();
}

#[tokio::test]
async fn k64_settings_keep_large_singleton_all_options_deep_paths_and_atomic_edits() {
    use maka_plugin_core::deployment::management::{InstanceSettingsPage, SettingValue};
    let fixture = Fixture::new().await;
    let options: Vec<String> = (0..17)
        .map(|index| format!("{index:02}{}", "界".repeat(10_000)))
        .collect();
    let mut properties = serde_json::Map::new();
    properties.insert("aChoice".into(), json!({"type":"string","enum":options,"title":"完整标题".repeat(80),"description":"完整说明".repeat(150)}));
    for index in 0..33 {
        properties.insert(format!("field{index:02}"), json!({"type":"string"}));
    }
    let mut nested_schema = json!({"type":"object","properties":{"leaf":{"type":"string"}},"additionalProperties":false});
    let mut nested_value = json!({"leaf":"original leaf"});
    for _ in 0..16 {
        nested_schema = json!({"type":"object","properties":{"child":nested_schema},"additionalProperties":false});
        nested_value = json!({"child":nested_value});
    }
    properties.insert("nested".into(), nested_schema);
    let mut files = package(vec![]).files().clone();
    let mut manifest: Value = serde_json::from_slice(&files["maka.extension.json"]).unwrap();
    manifest["application"]["host"]["configuration"] =
        json!({"type":"object","properties":properties,"additionalProperties":false});
    files.insert(
        "maka.extension.json".into(),
        serde_json::to_vec(&manifest).unwrap(),
    );
    let selected = Package::new(files).unwrap();
    let mut original = input(&selected);
    let values = &mut original
        .instances
        .get_mut("payload")
        .unwrap()
        .configuration
        .values;
    values.insert("aChoice".into(), json!(options[0]));
    values.insert("nested".into(), nested_value);
    for index in 0..33 {
        values.insert(
            format!("field{index:02}"),
            json!(format!("original {index}")),
        );
    }
    let source = fixture
        .store
        .commit_application(
            fixture.source.deployment,
            1,
            original.clone(),
            vec![],
            vec![selected],
        )
        .await
        .unwrap();
    let instance = InstanceId(vec![Uuid::from_u128(1)]);
    let mut after = None::<String>;
    let mut fields = Vec::new();
    loop {
        let value = k64_manager_call(
            &fixture.manager,
            "readSettings",
            json!({"source":source,"instance":instance,"path":[],"after":after}),
        )
        .await;
        let page: InstanceSettingsPage = serde_json::from_value(value).unwrap();
        assert!(!page.fields.is_empty());
        if fields.is_empty() {
            assert_eq!(
                page.fields.len(),
                1,
                "oversized first field must make singleton progress"
            );
            assert_eq!(page.fields[0].key, "aChoice");
            assert_eq!(
                page.fields[0].options,
                options
                    .iter()
                    .cloned()
                    .map(|text| SettingValue::Text { text })
                    .collect::<Vec<_>>()
            );
            assert_eq!(page.fields[0].label, "完整标题".repeat(80));
            assert_eq!(page.fields[0].description, "完整说明".repeat(150));
            assert_eq!(
                page.fields[0].value,
                Some(SettingValue::Text {
                    text: options[0].clone()
                })
            );
            assert!(serde_json::to_vec(&page.fields[0]).unwrap().len() > 448 * 1024);
        }
        let next = page.next.clone();
        if let Some(next) = &next {
            assert_eq!(Some(next), page.fields.last().map(|field| &field.key));
            assert!(after.as_ref().is_none_or(|after| next > after));
        }
        fields.extend(page.fields);
        match next {
            Some(next) => after = Some(next),
            None => break,
        }
    }
    assert_eq!(fields.len(), 35);
    let mut path = vec!["nested"; 1];
    path.extend(std::iter::repeat_n("child", 16));
    let deep = k64_manager_call(
        &fixture.manager,
        "readSettings",
        json!({"source":source,"instance":instance,"path":path,"after":null}),
    )
    .await;
    assert_eq!(deep["fields"][0]["key"], "leaf");
    assert_eq!(deep["fields"][0]["editable"], true);
    let long_text = "新值🙂".repeat(1100);
    let changes: Vec<Value> = (0..33).map(|index| json!({"path":[format!("field{index:02}")],"value":{"kind":"text","text":long_text}})).collect();
    let changed = k64_manager_call(
        &fixture.manager,
        "configure",
        json!({"expectedRevision":2,"instance":instance,"changes":changes}),
    )
    .await;
    assert_eq!(changed["status"], "committed");
    assert_eq!(changed["value"]["revision"], 3);
    let loaded = fixture
        .store
        .load_application(fixture.source.deployment)
        .await
        .unwrap()
        .unwrap();
    let actual = &loaded.source().input.instances["payload"];
    for index in 0..33 {
        assert_eq!(
            actual.configuration.values[&format!("field{index:02}")],
            long_text
        );
    }
    assert_eq!(
        actual.configuration.values["nested"],
        original.instances["payload"].configuration.values["nested"]
    );
    assert_eq!(actual.package, original.instances["payload"].package);
    let stale = k64_manager_call(
        &fixture.manager,
        "configure",
        json!({"expectedRevision":2,"instance":instance,"changes":changes}),
    )
    .await;
    assert_eq!(stale, json!({"status":"conflict","currentRevision":3}));
    let frozen = fixture
        .store
        .load_application_at(&source)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(frozen.source().input, original);
    fixture.store.shutdown().await.unwrap();
}
