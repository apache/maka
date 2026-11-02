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
use maka_event_log::applications::PreparedApplication;
use maka_plugin_core::composition::Target;

struct Fixture {
    _directory: tempfile::TempDir,
    bundled: BTreeMap<String, Package>,
    package: Package,
    source: String,
    release: String,
    deployment: Uuid,
}
impl Fixture {
    async fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let bundled = super::super::packages().unwrap();
        let source = super::super::authoring().unwrap();
        let release = super::super::bundle_fingerprint().unwrap();
        let deployment = Uuid::new_v4();
        let (_, package) = generate(
            Environment {
                workspace: directory.path().into(),
                roots: vec![DirectoryRootSpec {
                    label: "Workspace".into(),
                    path: directory.path().into(),
                }],
                home: None,
                helper: std::env::current_exe().unwrap(),
                locale: "auto".into(),
            },
            deployment,
            BTreeMap::new(),
            &bundled,
            &source,
            &release,
        )
        .await
        .unwrap();
        Self {
            _directory: directory,
            bundled,
            package,
            source,
            release,
            deployment,
        }
    }
    fn prepared(&self, input: Input, extras: Vec<Package>) -> PreparedApplication {
        PreparedApplication::new(
            input,
            vec![],
            self.bundled
                .values()
                .cloned()
                .chain([self.package.clone()])
                .chain(extras)
                .collect(),
        )
        .unwrap()
    }
    fn legacy(&self) -> Input {
        let mut input = flat(&self.package).unwrap();
        for name in ["agent", "workhub"] {
            let mut values =
                serde_json::to_value(&input.instances[name].configuration.values).unwrap();
            let agent = if name == "workhub" {
                &mut values["agent"]
            } else {
                &mut values
            };
            agent["tools"]
                .as_array_mut()
                .unwrap()
                .retain(|tool| tool["name"] != "ModelList");
            agent["plans"] = json!(true);
            input
                .instances
                .get_mut(name)
                .unwrap()
                .bindings
                .remove("settings");
            input.instances.get_mut(name).unwrap().configuration.values =
                serde_json::from_value(values).unwrap();
        }
        input
    }
}

#[tokio::test]
async fn generation_is_repeatable_and_adds_no_instance_namespace() {
    let f = Fixture::new().await;
    let metadata = metadata(&f.package).unwrap();
    let (_, next) = generate(
        metadata.environment,
        f.deployment,
        metadata.identities,
        &f.bundled,
        &f.source,
        &f.release,
    )
    .await
    .unwrap();
    assert_eq!(next.application_ref(), f.package.application_ref());
    let old = f.prepared(flat(&f.package).unwrap(), vec![]);
    let inherited = f.prepared(wrapped(&f.package), vec![]);
    assert_eq!(inherited.plan().instances(), old.plan().instances());
    assert_eq!(inherited.plan().ui(), old.plan().ui());
    assert!(inherited.input().instances.is_empty());
    for id in old.plan().instances().keys() {
        assert_eq!(
            old.plan().binding_basis(id).unwrap(),
            inherited.plan().binding_basis(id).unwrap()
        );
    }
}

#[tokio::test]
async fn missed_default_updates_migrate_without_losing_nested_customizations_or_renamed_identities()
{
    let f = Fixture::new().await;
    let original = f.legacy();
    // Pins have already advanced; only source configuration was stranded by the old updater.
    let mut current = original.clone();
    current
        .instances
        .get_mut("agent")
        .unwrap()
        .configuration
        .values
        .insert("goals".into(), json!(false));
    current
        .instances
        .get_mut("agent")
        .unwrap()
        .configuration
        .values
        .remove("recaps");
    current
        .instances
        .get_mut("workhub")
        .unwrap()
        .configuration
        .values
        .get_mut("agent")
        .unwrap()["goals"] = json!(false);
    let mut extra = current.instances["host-logs"].clone();
    extra.key = Uuid::new_v4();
    current.instances.insert("my-log".into(), extra.clone());
    let settings = current.instances.remove("settings").unwrap();
    let settings_key = settings.key;
    current.instances.insert("my-settings".into(), settings);
    for node in current.instances.values_mut() {
        for targets in node.bindings.values_mut() {
            for target in targets {
                if let Target::Instance { path, .. } = target
                    && path.first().is_some_and(|name| name == "settings")
                {
                    path[0] = "my-settings".into();
                }
            }
        }
    }
    current.instances.remove("workbench-ui");
    current.ui = None;
    let migrated = migrate(&original, &current, &f.package).unwrap();
    let prepared = f.prepared(migrated.clone(), vec![]);
    assert_eq!(migrated.instances["my-log"], extra);
    assert!(prepared.plan().ui().is_none());
    let instance = |name: &str| {
        prepared
            .plan()
            .instances()
            .values()
            .find(|node| node.path == [name])
            .unwrap()
    };
    assert_eq!(instance("agent").configuration["goals"], json!(false));
    assert!(instance("agent").configuration.get("recaps").is_none());
    assert_eq!(
        instance("workhub").configuration["agent"]["goals"],
        json!(false)
    );
    assert_eq!(instance("my-settings").identity.0, vec![settings_key]);
    for name in ["agent", "workhub"] {
        let config = if name == "workhub" {
            &instance(name).configuration["agent"]
        } else {
            &instance(name).configuration
        };
        assert_eq!(
            config["tools"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|tool| tool["name"] == "ModelList")
                .count(),
            1
        );
        assert_eq!(
            instance(name).identity.0,
            vec![original.instances[name].key]
        );
        assert!(!config.as_object().unwrap().contains_key("plans"));
        assert_eq!(
            instance(name).bindings["settings"][0].provider,
            maka_plugin_core::plan::Provider::Local {
                instance: instance("my-settings").identity.clone(),
                export: "Settings".into()
            }
        );
    }
    let installed: Vec<_> = f
        .bundled
        .values()
        .cloned()
        .chain([f.package.clone()])
        .collect();
    assert!(
        rebase(
            &migrated,
            &installed,
            None,
            &f.bundled,
            f.deployment,
            &f.source,
            &f.release
        )
        .await
        .unwrap()
        .is_none()
    );
    let (rebased, next) = rebase(
        &migrated,
        &installed,
        None,
        &f.bundled,
        f.deployment,
        &f.source,
        "another-release",
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(
        rebased.base.as_ref().unwrap().overrides,
        migrated.base.as_ref().unwrap().overrides
    );
    assert_eq!(rebased.instances, migrated.instances);
    let next = f.prepared(rebased, vec![next]);
    assert_eq!(next.plan().instances(), prepared.plan().instances());
}

#[tokio::test]
async fn component_substitutions_and_explicit_tool_selections_remain_independent_user_intent() {
    let f = Fixture::new().await;
    let original = f.legacy();
    let mut current = original.clone();
    let tools = current
        .instances
        .get_mut("agent")
        .unwrap()
        .configuration
        .values
        .get_mut("tools")
        .unwrap()
        .as_array_mut()
        .unwrap();
    tools.retain(|tool| tool["name"] != "Shell");
    let selected = tools.clone();
    let mut files = f.bundled["settings"].files().clone();
    let mut manifest: Value = serde_json::from_slice(&files["maka.extension.json"]).unwrap();
    manifest["id"] = json!("user.settings");
    files.insert(
        "maka.extension.json".into(),
        serde_json::to_vec(&manifest).unwrap(),
    );
    let custom = Package::new(files).unwrap();
    let settings = current.instances.get_mut("settings").unwrap();
    settings.package = custom.application_ref().into();
    settings.configuration.values.clear();
    let expected = settings.clone();
    let migrated = migrate(&original, &current, &f.package).unwrap();
    assert_eq!(migrated.instances["settings"], expected);
    let prepared = f.prepared(migrated, vec![custom]);
    let agent = prepared
        .plan()
        .instances()
        .values()
        .find(|node| node.path == ["agent"])
        .unwrap();
    assert_eq!(agent.configuration["tools"], json!(selected));
    let settings = prepared
        .plan()
        .instances()
        .values()
        .find(|node| node.path == ["settings"])
        .unwrap();
    assert_eq!(settings.package.id, "user.settings");
    assert_eq!(settings.configuration, json!({}));
}
