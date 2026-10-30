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
use maka_event_log::root::RootNamespaces;

fn scope() -> Scope {
    maka_capabilities::call::Issuer::default()
        .issue(
            maka_capabilities::call::Identity::Remote {
                request_id: uuid::Uuid::new_v4(),
            },
            CancellationToken::new(),
        )
        .unwrap()
}
fn document(body: &str) -> Vec<u8> {
    format!("---\nname: review\ndescription: Review a change\n---\n{body}").into_bytes()
}
fn operation(review: &Review) -> Operation {
    Operation {
        id: uuid::Uuid::new_v4(),
        fingerprint: maka_agent_facts::artifact::content_digest(
            &serde_json::to_vec(review).unwrap(),
        ),
        binding: maka_agent_facts::artifact::content_digest(b"original native binding"),
    }
}
async fn review(library: &Library, kind: ChangeKind, reference: &str, scope: &Scope) -> Review {
    let change = Change {
        workspace: library.workspace.clone(),
        kind,
        reference: reference.into(),
        revision: library.snapshot(scope).await.unwrap().revision,
    };
    match library.preview(change, scope).await.unwrap() {
        Preview::Ready { review, .. } => *review,
        _ => panic!("expected bounded change preview"),
    }
}
async fn library(root: Arc<RootOwner>, source: &std::path::Path, namespace: &str) -> Library {
    let mut library = Library::open(
        Configuration {
            home: None,
            project_roots: vec![],
            bundled: false,
            manage: true,
            preferences: false,
            sources: vec![Source {
                id: "local".into(),
                label: "Local".into(),
                path: source.to_str().unwrap().into(),
            }],
        },
        root.canonical_path().to_owned(),
        preferences::Store::new(
            Arc::new(maka_event_log::RootStore::open(root.clone()).await.unwrap()),
            "test_".into(),
        ),
    )
    .unwrap();
    library.managed = Some(Managed::open(root, namespace.into()).await.unwrap());
    library
}
#[tokio::test]
async fn management_rejects_external_deletion_disabled_access_and_links_into_private_records() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("sources");
    std::fs::create_dir_all(source.join("review")).unwrap();
    std::fs::write(source.join("review/SKILL.md"), document("original")).unwrap();
    let root = Arc::new(
        RootOwner::create(
            &dir.path().join("host"),
            &RootNamespaces {
                ownership: dir.path().join("owners"),
                control: dir.path().join("control"),
            },
        )
        .unwrap(),
    );
    let call = scope();
    let mut library = library(root.clone(), &source, "one").await;
    let change = Change {
        workspace: None,
        kind: ChangeKind::Delete,
        reference: "source:local:review".into(),
        revision: library.snapshot(&call).await.unwrap().revision,
    };
    assert!(
        matches!(library.preview(change, &call).await.unwrap(), Preview::Rejected { reason } if reason == "read_only_source")
    );
    let install = review(&library, ChangeKind::Install, "source:local:review", &call).await;
    let managed = library.managed.take().unwrap();
    assert!(
        matches!(library.apply_operation(install.clone(), &operation(&install), &call).await.unwrap(), ChangeResult::Rejected { reason } if reason == "management_disabled")
    );
    assert!(
        !root
            .canonical_path()
            .join("skill-libraries/one/skills/review")
            .exists()
    );
    #[cfg(unix)]
    {
        let data = root.canonical_path().join("skill-libraries/one");
        std::fs::write(data.join("receipts/private.json"), "private receipt").unwrap();
        std::os::unix::fs::symlink("../receipts", data.join("skills/leak")).unwrap();
        let read = managed.read.bind_scope(&call);
        assert!(
            read.read(maka_capabilities::filesystem::entries::ReadFile {
                path: "skills/leak/private.json".into(),
                offset: 0,
                limit: 1024
            })
            .await
            .is_err()
        );
        assert!(
            read.read(maka_capabilities::filesystem::entries::ReadFile {
                path: "receipts/private.json".into(),
                offset: 0,
                limit: 1024
            })
            .await
            .is_err()
        );
    }
    call.finish().await.unwrap();
}

#[tokio::test]
async fn project_installation_keeps_its_reviewed_workspace_and_relative_resource_tree() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("sources");
    std::fs::create_dir_all(&source).unwrap();
    let project = dir.path().join("project");
    super::super::tests::write(
        &project.join(".agents/skills"),
        "review",
        "project instructions",
    );
    std::fs::create_dir_all(project.join(".agents/skills/review/references")).unwrap();
    std::fs::write(
        project.join(".agents/skills/review/references/guide"),
        "project resource",
    )
    .unwrap();
    let (project, directory_identity) = maka_fs_tools::directory::capture(&project).unwrap();
    let private = tempfile::tempdir().unwrap();
    let control = tempfile::tempdir().unwrap();
    let identity = maka_fs_tools::workspace::ensure_directory_identity(
        project.clone(),
        maka_fs_tools::directory::open(&project, &directory_identity).unwrap(),
        private.path().to_owned(),
        control.path().to_owned(),
        None,
    )
    .await
    .unwrap();
    let workspace = maka_agent_api::contract::Workspace {
        worktree: None,
        project_id: None,
        path: maka_fs_tools::workspace::project::host_path(&project)
            .unwrap()
            .into(),
        directory_identity,
        identity,
    };
    let root = Arc::new(
        RootOwner::create(
            &dir.path().join("host"),
            &RootNamespaces {
                ownership: dir.path().join("owners"),
                control: dir.path().join("control"),
            },
        )
        .unwrap(),
    );
    let mut library = library(root.clone(), &source, "project").await;
    library.projects = vec![Arc::new(
        maka_fs_tools::workspace::directory::PublishedDirectory::open(&project).unwrap(),
    )];
    let call = scope();
    let scoped = library
        .for_workspace(Some(workspace.clone()), &call)
        .await
        .unwrap();
    let reference = scoped.snapshot(&call).await.unwrap().entries[0]
        .0
        .reference
        .clone();
    let install = review(&scoped, ChangeKind::Install, &reference, &call).await;
    let resource = project.join(".agents/skills/review/references/guide");
    std::fs::write(&resource, "changed after review").unwrap();
    assert!(matches!(
        scoped
            .apply_operation(install.clone(), &operation(&install), &call)
            .await
            .unwrap(),
        ChangeResult::Changed
    ));
    assert!(
        !root
            .canonical_path()
            .join("skill-libraries/project/skills/review")
            .exists()
    );
    std::fs::write(&resource, "project resource").unwrap();
    assert_eq!(install.change.workspace, Some(workspace));
    let original = library
        .for_workspace(install.change.workspace.clone(), &call)
        .await
        .unwrap();
    assert!(matches!(
        original
            .apply_operation(install.clone(), &operation(&install), &call)
            .await
            .unwrap(),
        ChangeResult::Applied { .. }
    ));
    assert_eq!(
        std::fs::read_to_string(
            root.canonical_path()
                .join("skill-libraries/project/skills/review/references/guide")
        )
        .unwrap(),
        "project resource"
    );
    let snapshot = original.snapshot(&call).await.unwrap();
    assert!(
        snapshot
            .entries
            .iter()
            .any(|(e, _, _)| e.installed && e.shadowed_by.as_deref() == Some(reference.as_str()))
    );
    std::fs::remove_dir_all(project.join(".agents/skills/review")).unwrap();
    let snapshot = original.snapshot(&call).await.unwrap();
    assert!(
        snapshot
            .entries
            .iter()
            .all(|(e, _, _)| e.installed && e.shadowed_by.is_none())
    );
    call.finish().await.unwrap();
}

#[derive(Clone)]
struct ImportResource {
    bytes: Vec<u8>,
    text: bool,
}
impl maka_capabilities::call::ReadResource for ImportResource {
    fn encoding(&self) -> maka_capabilities::call::ResourceEncoding {
        if self.text {
            maka_capabilities::call::ResourceEncoding::Utf8
        } else {
            maka_capabilities::call::ResourceEncoding::Bytes
        }
    }
    fn resource_type(&self) -> maka_plugin_core::contract::ResourceType {
        if self.text {
            maka_plugin_core::contract::text_resource_type()
        } else {
            maka_plugin_core::contract::binary_resource_type()
        }
    }
    fn bytes(&self) -> usize {
        self.bytes.len()
    }
    fn metadata(&self) -> Value {
        serde_json::json!({"path":"/not/a/grant","id":"untrusted"})
    }
    fn read(&self, range: std::ops::Range<usize>) -> Result<Vec<u8>, String> {
        self.bytes
            .get(range)
            .map(|v| v.to_vec())
            .ok_or("bad range".into())
    }
}
fn imported(
    id: &str,
    bytes: Vec<u8>,
) -> (
    ImportSource,
    maka_capabilities::call::Attachments,
    Operation,
) {
    let input = ImportSource {
        bytes: bytes.len(),
        digest: maka_agent_facts::artifact::content_digest(&bytes),
    };
    let fingerprint =
        maka_agent_facts::artifact::content_digest(&serde_json::to_vec(&input).unwrap());
    (
        input,
        BTreeMap::from([
            (
                "file".into(),
                Arc::new(ImportResource { bytes, text: false })
                    as Arc<dyn maka_capabilities::call::ReadResource>,
            ),
            (
                "id".into(),
                Arc::new(ImportResource {
                    bytes: id.as_bytes().to_vec(),
                    text: true,
                }) as Arc<dyn maka_capabilities::call::ReadResource>,
            ),
        ]),
        Operation {
            id: uuid::Uuid::new_v4(),
            fingerprint,
            binding: maka_agent_facts::artifact::content_digest(b"original resource-bound call"),
        },
    )
}
#[tokio::test]
async fn imported_sources_require_explicit_install_and_keep_original_publication_receipts() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("sources");
    std::fs::create_dir(&source).unwrap();
    let root = Arc::new(
        RootOwner::create(
            &dir.path().join("host"),
            &RootNamespaces {
                ownership: dir.path().join("owners"),
                control: dir.path().join("control"),
            },
        )
        .unwrap(),
    );
    let library = library(root.clone(), &source, "import-test").await;
    let call = scope();
    let (input, resources, original) = imported("review", document("Imported original"));
    let result = library
        .import_operation(input, &original, &call, resources)
        .await
        .unwrap();
    assert!(
        matches!(result,ChangeResult::Applied { ref reference } if reference=="imported:review")
    );
    let listed = library.snapshot(&call).await.unwrap();
    assert_eq!(listed.entries.len(), 1);
    assert!(listed.entries[0].0.imported);
    assert!(!listed.entries[0].0.preference.enabled);
    assert!(library.discover(&call).await.unwrap().inventory.is_empty());
    let (input, resources, other) = imported("REVIEW", document("must not replace"));
    assert!(
        matches!(library.import_operation(input,&other,&call,resources).await.unwrap(), ChangeResult::Rejected {reason} if reason=="source_exists")
    );
    let install = review(&library, ChangeKind::Install, "imported:review", &call).await;
    assert!(
        matches!(library.apply_operation(install.clone(),&operation(&install),&call).await.unwrap(),ChangeResult::Applied {reference} if reference=="installed:review")
    );
    let active = library.discover(&call).await.unwrap();
    assert_eq!(active.inventory.len(), 1);
    assert_eq!(active.inventory[0].location.reference, "installed:review");
    assert!(
        active.inventory[0]
            .document
            .body
            .contains("Imported original")
    );
    let removal = review(&library, ChangeKind::Delete, "imported:review", &call).await;
    assert!(
        matches!(library.apply_operation(removal.clone(),&operation(&removal),&call).await.unwrap(),ChangeResult::Rejected {reason} if reason=="read_only_source")
    );
    let deletion = operation(&removal);
    assert!(
        matches!(library.delete_source(removal,&deletion,&call).await.unwrap(),ChangeResult::Applied {reference} if reference=="imported:review")
    );
    assert_eq!(library.snapshot(&call).await.unwrap().entries.len(), 1);
    assert_eq!(library.discover(&call).await.unwrap().inventory.len(), 1);
    // Replaying the original domain operation after deletion does not recreate it,
    // and uses its original result without asking for new resource bytes.
    let (input, _, _) = imported("wrong", document("new"));
    assert!(
        matches!(library.import_operation(input,&original,&call,BTreeMap::new()).await.unwrap(),ChangeResult::Applied {reference} if reference=="imported:review")
    );
    assert!(
        !root
            .canonical_path()
            .join("skill-libraries/import-test/imported/skills/review")
            .exists()
    );
    call.resources.finish().await.unwrap();
}
#[tokio::test]
async fn source_import_checks_actual_resources_and_never_accepts_path_or_metadata_authority() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("sources");
    std::fs::create_dir(&source).unwrap();
    let root = Arc::new(
        RootOwner::create(
            &dir.path().join("host"),
            &RootNamespaces {
                ownership: dir.path().join("owners"),
                control: dir.path().join("control"),
            },
        )
        .unwrap(),
    );
    let library = library(root, &source, "import-test").await;
    let call = scope();
    for case in 0..7 {
        let (mut input, mut resources, operation) = imported("review", document("valid"));
        match case {
            0 => {
                input.digest = maka_agent_facts::artifact::content_digest(b"different");
            }
            1 => {
                input.bytes += 1;
            }
            2 => {
                resources.insert(
                    "id".into(),
                    Arc::new(ImportResource {
                        bytes: b"../escape".to_vec(),
                        text: true,
                    }),
                );
            }
            3 => {
                resources.insert(
                    "file".into(),
                    Arc::new(ImportResource {
                        bytes: document("valid"),
                        text: true,
                    }),
                );
            }
            4 => {
                let bytes = b"not a skill".to_vec();
                input.bytes = bytes.len();
                input.digest = maka_agent_facts::artifact::content_digest(&bytes);
                resources.insert(
                    "file".into(),
                    Arc::new(ImportResource { bytes, text: false }),
                );
            }
            5 => {
                let bytes = vec![0xff; 1024 * 1024 + 1];
                input.bytes = bytes.len();
                input.digest = maka_agent_facts::artifact::content_digest(&bytes);
                resources.insert(
                    "file".into(),
                    Arc::new(ImportResource { bytes, text: false }),
                );
            }
            _ => {
                resources.remove("file");
            }
        }
        assert!(
            matches!(
                library
                    .import_operation(input, &operation, &call, resources)
                    .await
                    .unwrap(),
                ChangeResult::Rejected { .. }
            ),
            "case {case}"
        );
        assert!(library.snapshot(&call).await.unwrap().entries.is_empty());
    }
    call.resources.finish().await.unwrap();
}
