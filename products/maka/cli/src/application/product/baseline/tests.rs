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
async fn rebase_preserves_explicit_overrides_independent_roots_and_identity() {
    use maka_plugin_core::composition::ConfigurationField;
    let f = Fixture::new().await;
    let mut input = wrapped(&f.package);
    input
        .configure(
            &["agent".into()],
            vec![ConfigurationField {
                path: vec!["goals".into()],
                value: Some(json!(false)),
            }],
        )
        .unwrap();
    let mut extra = flat(&f.package).unwrap().instances["host-logs"].clone();
    extra.key = Uuid::new_v4();
    input.instances.insert("my-log".into(), extra);
    let before = f.prepared(input.clone(), vec![]);
    let installed: Vec<_> = f
        .bundled
        .values()
        .cloned()
        .chain([f.package.clone()])
        .collect();
    assert!(
        rebase(
            &input,
            &installed,
            &f.bundled,
            f.deployment,
            &f.source,
            &f.release
        )
        .await
        .unwrap()
        .is_none()
    );
    let (next, package) = rebase(
        &input,
        &installed,
        &f.bundled,
        f.deployment,
        &f.source,
        "next-release",
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(
        next.base.as_ref().unwrap().overrides,
        input.base.as_ref().unwrap().overrides
    );
    assert_eq!(next.instances, input.instances);
    let next = f.prepared(next, vec![package]);
    assert_eq!(next.plan().instances(), before.plan().instances());
    for id in before.plan().instances().keys() {
        assert_eq!(
            next.plan().binding_basis(id).unwrap(),
            before.plan().binding_basis(id).unwrap()
        );
    }
}

#[tokio::test]
async fn explicit_flat_sources_do_not_opt_into_product_baselines() {
    let f = Fixture::new().await;
    let input = flat(&f.package).unwrap();
    assert!(
        rebase(
            &input,
            &[],
            &f.bundled,
            f.deployment,
            &f.source,
            "next-release"
        )
        .await
        .unwrap()
        .is_none()
    );
    assert!(input.base.is_none());
}
