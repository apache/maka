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
use serde_json::{Value, json};
use uuid::Uuid;

fn leaf(marker: &str, label_type: &str) -> Package {
    Package::new(BTreeMap::from([
        (
            "maka.extension.json".into(),
            serde_json::to_vec(&json!({
                "schemaVersion":1,"id":"example.bundled",
                "application":{"entries":{"host":{
                    "implementation":{"kind":"native","implementation":"example.Component"},
                    "configuration":{"type":"object","properties":{"label":{"type":label_type}},
                        "required":["label"],"additionalProperties":false},
                    "imports":{},"exports":{}
                }}}
            }))
            .unwrap(),
        ),
        ("release.txt".into(), marker.as_bytes().to_vec()),
    ]))
    .unwrap()
}
struct Fixture {
    store: RootStore,
    deployment: Uuid,
    input: Input,
    previous: Package,
    current: Package,
    template: Package,
    selection: Value,
}
impl Fixture {
    async fn new(path: &std::path::Path) -> Self {
        let store = launch::create(path.join("host")).await.unwrap();
        let deployment = Uuid::new_v4();
        let key = Uuid::new_v4();
        let previous = leaf("same-ID local fork", "string");
        let current = leaf("current bundled bytes", "string");
        let template = Package::new(BTreeMap::from([(
            "maka.extension.json".into(), serde_json::to_vec(&json!({
                "schemaVersion":1,"id":"example.custom-template",
                "application":{"composition":{"children":{
                    "child":{"key":Uuid::new_v4(),"package":{"source":"pinned","package":previous.application_ref()},
                        "usePackage":"entry","configuration":{"values":{"label":"Template default"}}}
                }}}
            })).unwrap(),
        )])).unwrap();
        let input: Input = serde_json::from_value(json!({
            "environment":{"location":"host"},"instances":{
                "direct":{"key":key,"package":{"source":"pinned","package":previous.application_ref()},
                    "usePackage":"entry","configuration":{"values":{"label":"Keep this value"}}},
                "group":{"key":Uuid::new_v4(),"package":{"source":"pinned","package":template.application_ref()},
                    "usePackage":"composition","overrides":[{"path":["child"],"package":previous.application_ref(),
                        "configuration":{"label":"Keep overridden configuration"}}]}
            }
        })).unwrap();
        let source = store
            .commit_application(
                deployment,
                0,
                input.clone(),
                vec![],
                vec![previous.clone(), template.clone()],
            )
            .await
            .unwrap();
        let selection = json!({"kind":"public_host","endpoints":{
            "service":{"consumer":[key],"import":"service","grant":{"methods":["read"],"recovery":false}}
        },"native":[]});
        serde_json::from_value::<Selection>(selection.clone())
            .unwrap()
            .validate()
            .unwrap();
        store
            .select_committed_application_launch(source, selection.clone())
            .await
            .unwrap();
        Self {
            store,
            deployment,
            input,
            previous,
            current,
            template,
            selection,
        }
    }
    fn bundled(&self) -> BTreeMap<String, Package> {
        BTreeMap::from([("current".into(), self.current.clone())])
    }
    fn target(&self) -> Input {
        let mut target = self.input.clone();
        target.instances.get_mut("direct").unwrap().package = self.current.application_ref().into();
        target.instances.get_mut("group").unwrap().overrides[0].package =
            Some(self.current.application_ref());
        target
    }
    fn expected_changes(&self) -> Vec<String> {
        [
            "/instances/direct/package",
            "/instances/group/overrides/0/package",
        ]
        .map(|path| {
            format!(
                "{path}: example.bundled@{} -> example.bundled@{}",
                self.previous.digest(),
                self.current.digest()
            )
        })
        .into()
    }
    async fn stage(&self) -> Vec<u8> {
        let preparation = Preparation {
            expected_revision: 1,
            input: self.target(),
            packages: [&self.current, &self.template]
                .into_iter()
                .map(|package| {
                    package
                        .files()
                        .iter()
                        .map(|(path, bytes)| (path.clone(), STANDARD.encode(bytes)))
                        .collect()
                })
                .collect(),
        };
        let pending = serde_json::to_vec(&preparation).unwrap();
        self.store
            .begin_application_restore(self.deployment, pending.clone())
            .await
            .unwrap();
        pending
    }
}

#[tokio::test]
async fn selected_and_override_pins_upgrade_without_reauthoring_custom_composition() {
    let directory = tempfile::tempdir().unwrap();
    let f = Fixture::new(directory.path()).await;
    let installed = leaf("Installed but not selected", "string");
    f.store
        .commit_application(
            f.deployment,
            1,
            f.input.clone(),
            vec![],
            vec![f.previous.clone(), f.template.clone(), installed.clone()],
        )
        .await
        .unwrap();
    let record = f.store.application_launch().await.unwrap().unwrap();
    let preview = synchronize_packages(&f.store, record, false, f.bundled())
        .await
        .unwrap();
    assert_eq!(preview.changes, f.expected_changes());
    assert_eq!(
        serde_json::to_value(&preview).unwrap()["scope"],
        "selected_packages"
    );
    assert!(preview.changed && !preview.applied);
    assert!(
        f.store
            .application_launch()
            .await
            .unwrap()
            .unwrap()
            .pending
            .is_none()
    );
    assert_eq!(
        f.store
            .load_application(f.deployment)
            .await
            .unwrap()
            .unwrap()
            .source()
            .input,
        f.input
    );
    let record = f.store.application_launch().await.unwrap().unwrap();
    let result = synchronize_packages(&f.store, record, true, f.bundled())
        .await
        .unwrap();
    assert!(result.applied);
    let loaded = f
        .store
        .load_application(f.deployment)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(loaded.source().input, f.target());
    assert_eq!(loaded.source().reference.revision, 3);
    assert!(
        loaded
            .packages()
            .iter()
            .any(|package| package.application_ref() == installed.application_ref())
    );
    assert!(
        !loaded
            .packages()
            .iter()
            .any(|package| package.application_ref() == f.previous.application_ref())
    );
    assert!(
        loaded
            .packages()
            .iter()
            .any(
                |package| package.application_ref() == f.template.application_ref()
                    && package.files() == f.template.files()
            )
    );
    let record = f.store.application_launch().await.unwrap().unwrap();
    assert_eq!(record.configuration, f.selection);
    assert!(record.pending.is_none());
    let again = synchronize_packages(&f.store, record, true, f.bundled())
        .await
        .unwrap();
    assert!(!again.changed && !again.applied);
    assert_eq!(
        f.store
            .load_application(f.deployment)
            .await
            .unwrap()
            .unwrap()
            .source()
            .reference
            .revision,
        3
    );
    f.store.drain().await;
}

#[tokio::test]
async fn incompatible_package_is_rejected_before_pending_or_source_changes() {
    let directory = tempfile::tempdir().unwrap();
    let f = Fixture::new(directory.path()).await;
    let pending = f.store.application_launch().await.unwrap().unwrap().pending;
    let record = f.store.application_launch().await.unwrap().unwrap();
    let error = synchronize_packages(
        &f.store,
        record,
        true,
        BTreeMap::from([(
            "bad".into(),
            leaf("incompatible new configuration", "integer"),
        )]),
    )
    .await
    .err()
    .unwrap();
    assert!(error.to_string().contains("configuration"), "{error}");
    let loaded = f
        .store
        .load_application(f.deployment)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(loaded.source().input, f.input);
    assert_eq!(loaded.source().reference.revision, 1);
    assert_eq!(
        f.store.application_launch().await.unwrap().unwrap().pending,
        pending
    );
    f.store.drain().await;
}

#[tokio::test]
async fn pending_preview_and_apply_recover_only_frozen_target_including_lost_acknowledgement() {
    for committed in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let f = Fixture::new(directory.path()).await;
        let pending = f.stage().await;
        if committed {
            launch::ensure_replacement(
                &f.store,
                f.deployment,
                1,
                &f.target(),
                &[],
                &[f.current.clone(), f.template.clone()],
            )
            .await
            .unwrap();
        }
        let original_revision = if committed { 2 } else { 1 };
        let preview = synchronize(&f.store, false).await.unwrap();
        assert_eq!(preview.changes, f.expected_changes());
        assert!(preview.changed && !preview.applied);
        assert_eq!(
            f.store.application_launch().await.unwrap().unwrap().pending,
            Some(pending)
        );
        assert_eq!(
            f.store
                .load_application(f.deployment)
                .await
                .unwrap()
                .unwrap()
                .source()
                .reference
                .revision,
            original_revision
        );
        // This path does not inspect or reauthor from the executing distribution's bundle.
        let applied = synchronize(&f.store, true).await.unwrap();
        assert_eq!(applied.changes, f.expected_changes());
        assert!(applied.applied);
        let loaded = f
            .store
            .load_application(f.deployment)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(loaded.source().input, f.target());
        assert_eq!(loaded.source().reference.revision, 2);
        let record = f.store.application_launch().await.unwrap().unwrap();
        assert_eq!(record.configuration, f.selection);
        assert!(record.pending.is_none());
        f.store.drain().await;
    }
}

#[tokio::test]
async fn pending_update_rejects_later_divergent_head_without_losing_pending() {
    let directory = tempfile::tempdir().unwrap();
    let f = Fixture::new(directory.path()).await;
    let pending = f.stage().await;
    let packages = vec![f.current.clone(), f.template.clone()];
    f.store
        .commit_application(f.deployment, 1, f.target(), vec![], packages.clone())
        .await
        .unwrap();
    let mut later = f.target();
    later
        .instances
        .get_mut("direct")
        .unwrap()
        .configuration
        .values
        .insert("label".into(), json!("Later independent edit"));
    f.store
        .commit_application(f.deployment, 2, later.clone(), vec![], packages)
        .await
        .unwrap();
    for apply in [false, true] {
        let error = synchronize(&f.store, apply).await.err().unwrap();
        assert!(
            error.to_string().contains("later source revision"),
            "{error}"
        );
        let loaded = f
            .store
            .load_application(f.deployment)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(loaded.source().input, later);
        assert_eq!(loaded.source().reference.revision, 3);
        assert_eq!(
            f.store.application_launch().await.unwrap().unwrap().pending,
            Some(pending.clone())
        );
    }
    f.store.drain().await;
}

#[tokio::test]
async fn pending_initialization_preview_and_completion_preserve_a_later_head() {
    let directory = tempfile::tempdir().unwrap();
    let f = Fixture::new(directory.path()).await;
    let packages = vec![f.previous.clone(), f.template.clone()];
    let preparation = Preparation {
        expected_revision: 0,
        input: f.input.clone(),
        packages: packages
            .iter()
            .map(|package| {
                package
                    .files()
                    .iter()
                    .map(|(path, bytes)| (path.clone(), STANDARD.encode(bytes)))
                    .collect()
            })
            .collect(),
    };
    let pending = serde_json::to_vec(&preparation).unwrap();
    f.store
        .begin_application_restore(f.deployment, pending.clone())
        .await
        .unwrap();
    let mut later = f.input.clone();
    later
        .instances
        .get_mut("direct")
        .unwrap()
        .configuration
        .values
        .insert("label".into(), json!("Later independent configuration"));
    f.store
        .commit_application(f.deployment, 1, later.clone(), vec![], packages)
        .await
        .unwrap();

    let preview = synchronize(&f.store, false).await.unwrap();
    let current = f
        .store
        .load_application(f.deployment)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(current.source().input, later);
    assert_eq!(current.source().reference.revision, 2);
    let record = f.store.application_launch().await.unwrap().unwrap();
    assert_eq!(record.configuration, f.selection);
    assert_eq!(record.pending, Some(pending));
    assert_eq!(
        serde_json::to_value(&preview).unwrap()["scope"],
        "initialization"
    );
    assert!(preview.changed && !preview.applied);
    assert_eq!(preview.changes, Vec::<String>::new());

    let applied = synchronize(&f.store, true).await.unwrap();
    assert_eq!(
        serde_json::to_value(&applied).unwrap()["scope"],
        "initialization"
    );
    assert!(applied.changed && applied.applied);
    assert_eq!(applied.changes, Vec::<String>::new());
    let current = f
        .store
        .load_application(f.deployment)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(current.source().input, later);
    assert_eq!(current.source().reference.revision, 2);
    let record = f.store.application_launch().await.unwrap().unwrap();
    assert_eq!(record.configuration, f.selection);
    assert!(record.pending.is_none());
    f.store.drain().await;
}
