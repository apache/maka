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
use maka_agent_facts::session::CopyPurpose;
use serde_json::json;

fn owner(path: &std::path::Path) -> Arc<root::RootOwner> {
    Arc::new(
        root::RootOwner::create(
            &path.join("root"),
            &root::RootNamespaces {
                ownership: path.join("ownership"),
                control: path.join("control"),
            },
        )
        .unwrap(),
    )
}
fn copy(source: &str, target: &str, purpose: CopyPurpose) -> SessionCopy {
    SessionCopy {
        source_session_id: source.into(),
        target_session_id: target.into(),
        expected_source_revision: 1,
        purpose,
    }
}
fn origin(id: &str, authority: Option<&str>) -> PluginSession {
    PluginSession {
        session_id: id.into(),
        creator: maka_capabilities::storage::Namespace::new(
            "test",
            maka_plugin_core::scope::Scope::try_from("profile".to_owned()).unwrap(),
        )
        .unwrap(),
        fingerprint: format!("create-{id}"),
        managed: false,
        authority_session_id: authority.map(Into::into),
    }
}

#[tokio::test]
async fn copy_and_authority_inherit_source_instead_of_target_hash() {
    let directory = tempfile::tempdir().unwrap();
    let store = RootStore::open(owner(directory.path())).await.unwrap();
    store
        .create_session("source", "source", &json!({}), 1)
        .await
        .unwrap();
    let source = store.route_partition("source").await.unwrap();
    let targets: Vec<_> = (0..100)
        .map(|n| format!("child-{n}"))
        .filter(|id| partition_for(b"session", id) != source)
        .take(3)
        .collect();
    for (target, purpose) in targets.iter().zip([
        CopyPurpose::Branch {
            position: maka_agent_facts::session::ForkPosition::End,
            side_conversation: false,
        },
        CopyPurpose::EmptySideConversation,
    ]) {
        assert!(matches!(
            store
                .copy_session(copy("source", target, purpose), &json!({}), 2)
                .await
                .unwrap(),
            SessionCopyResult::Committed(_)
        ));
        assert_eq!(store.route_partition(target).await.unwrap(), source);
    }
    store
        .create_plugin_session(&origin(&targets[2], Some("source")), &json!({}), 2)
        .await
        .unwrap();
    assert_eq!(store.route_partition(&targets[2]).await.unwrap(), source);
    let authority = store.partitions[source]
        .preview_bundle("source")
        .await
        .unwrap();
    assert_eq!(authority.sessions.len(), 4);
    store.close().await.unwrap();
}

async fn exported() -> Vec<u8> {
    exported_from("bundle-root").await
}

async fn exported_from(root: &str) -> Vec<u8> {
    let directory = tempfile::tempdir().unwrap();
    let source = EventLog::open(&directory.path().join("source.sqlite"))
        .await
        .unwrap();
    source
        .create_session("bundle-root", "bundle-root", &json!({}), 1)
        .await
        .unwrap();
    source
        .copy_session(
            copy(
                "bundle-root",
                "bundle-child",
                CopyPurpose::EmptySideConversation,
            ),
            &json!({}),
            2,
        )
        .await
        .unwrap();
    let inventory = source.preview_bundle(root).await.unwrap();
    let (bytes, _) = source
        .export_bundle(root, &inventory.subtree_digest, Vec::new())
        .await
        .unwrap();
    source.close().await.unwrap();
    bytes
}

#[tokio::test]
async fn durable_bundle_pending_reservation_recovers_all_members() {
    let bytes = exported().await;
    let directory = tempfile::tempdir().unwrap();
    let owner = owner(directory.path());
    let store = RootStore::open(owner.clone()).await.unwrap();
    let mut staged = crate::bundle::StagedBundle::read(bytes.as_slice())
        .await
        .unwrap();
    staged.validate_history().await.unwrap();
    let members = staged.family_members().await.unwrap();
    let stage = uuid::Uuid::new_v4().to_string();
    let directory = owner.canonical_path().join("runtime-stages");
    root::private_directory(&directory).unwrap();
    let path = stage_path(&directory, &stage).unwrap();
    let digest = staged.summary().digest.clone();
    staged
        .persist(&path, store.stage_owner().unwrap())
        .await
        .unwrap();
    let binding = maka_agent_facts::artifact::content_digest(b"binding");
    let command = Creation::Bundle {
        stage,
        digest,
        binding: binding.clone(),
        configurations: std::collections::BTreeMap::from([
            ("bundle-root".into(), json!({})),
            ("bundle-child".into(), json!({})),
        ]),
        members: members.clone(),
    };
    store
        .reserve_family("bundle-root", &binding, command, 3, members)
        .await
        .unwrap();
    assert!(matches!(
        store.session("bundle-child").await,
        Err(StoreError::SessionNotFound)
    ));
    store.close().await.unwrap();
    let store = RootStore::open(owner).await.unwrap();
    assert_eq!(store.route_partition("bundle-root").await.unwrap(), 3);
    assert_eq!(store.route_partition("bundle-child").await.unwrap(), 3);
    assert!(!path.exists());
    store.close().await.unwrap();
}

#[tokio::test]
async fn atomic_family_reservation_cannot_leave_partial_members() {
    let directory = tempfile::tempdir().unwrap();
    let store = RootStore::open(owner(directory.path())).await.unwrap();
    store
        .create_session("occupied", "occupied", &json!({}), 1)
        .await
        .unwrap();
    let command = Creation::Session {
        configuration: json!({}),
        created_at: 2,
    };
    assert!(matches!(
        store
            .reserve_family(
                "new",
                "new",
                command,
                2,
                vec!["new".into(), "occupied".into()]
            )
            .await,
        Err(StoreError::SessionConflict)
    ));
    store
        .create_session("new", "different", &json!({}), 2)
        .await
        .unwrap();
    store.close().await.unwrap();
}

#[tokio::test]
async fn terminal_rejection_cannot_be_reexecuted_by_a_waiting_probe() {
    let directory = tempfile::tempdir().unwrap();
    let store = RootStore::open(owner(directory.path())).await.unwrap();
    store
        .create_session("source", "source", &json!({}), 1)
        .await
        .unwrap();
    let partition = store.route_partition("source").await.unwrap();
    let mut request = copy("source", "rejected", CopyPurpose::EmptySideConversation);
    request.expected_source_revision = 2;
    let command = Creation::Copy {
        request: request.clone(),
        origin: None,
        configuration: json!({}),
        created_at: 2,
    };
    let (partition, command) = store
        .reserve_family(
            "rejected",
            "copy",
            command,
            partition,
            vec!["rejected".into()],
        )
        .await
        .unwrap();
    let creation = store
        .gates
        .write([gates::Key::Creation("rejected".into())])
        .await
        .unwrap();
    let rejection = commit(&store, &store.partitions[partition], command)
        .await
        .unwrap();
    assert!(matches!(
        rejection,
        Some(CreationRejection::SourceRevisionConflict { actual: 1, .. })
    ));
    let mut probe = Box::pin(store.session_copy_receipt("rejected"));
    assert!(futures_util::poll!(&mut probe).is_pending());
    // The immutable request would succeed now, but its original rejection wins.
    store.partitions[partition]
        .connection
        .run(|db| {
            Box::pin(async move {
                sqlx::query("UPDATE session_control SET revision=2 WHERE id='source'")
                    .execute(db)
                    .await?;
                Ok(())
            })
        })
        .await
        .unwrap();
    store
        .control
        .connection
        .write(
            creation::WritePublication {
                id: "rejected".into(),
                rejection,
            },
            store.control.commits.notice(),
        )
        .await
        .unwrap();
    drop(creation);
    assert!(matches!(
        probe.await,
        Err(StoreError::SessionCreationRejected(
            CreationRejection::SourceRevisionConflict { actual: 1, .. }
        ))
    ));
    let command = Creation::Copy {
        request,
        origin: None,
        configuration: json!({}),
        created_at: 2,
    };
    assert!(matches!(
        store
            .finish_creation("rejected", "copy", partition, command)
            .await,
        Err(StoreError::SessionCreationRejected(
            CreationRejection::SourceRevisionConflict { actual: 1, .. }
        ))
    ));
    assert!(
        store.partitions[partition]
            .get_session::<Value>("rejected")
            .await
            .unwrap()
            .is_none()
    );
    store.close().await.unwrap();
}

#[tokio::test]
async fn every_family_missing_binding_rejects_and_reopens() {
    use maka_agent_facts::import::{Content, Record, Source};
    let directory = tempfile::tempdir().unwrap();
    let owner = owner(directory.path());
    let store = RootStore::open(owner.clone()).await.unwrap();
    store
        .create_session("source", "source", &json!({}), 1)
        .await
        .unwrap();
    let reference = maka_agent_facts::workspace::BindingRef {
        id: uuid::Uuid::new_v4(),
        permission_epoch_at_attach: 0,
        metadata_epoch_at_attach: 0,
    };
    let configuration = json!({"workspace": reference, "boundary_revision": 0});
    let missing = |result: Result<SessionRecord<Value>, StoreError>| {
        assert!(matches!(
            result,
            Err(StoreError::SessionCreationRejected(
                CreationRejection::MissingWorkspaceBinding
            ))
        ));
    };
    missing(
        store
            .create_plugin_session(&origin("plugin", None), &configuration, 2)
            .await,
    );
    assert!(matches!(
        store
            .copy_session(
                copy("source", "copy", CopyPurpose::EmptySideConversation),
                &configuration,
                2
            )
            .await,
        Err(StoreError::SessionCreationRejected(
            CreationRejection::MissingWorkspaceBinding
        ))
    ));
    missing(
        store
            .import_session(
                &origin("import", None),
                &Source {
                    adapter: "test".into(),
                    session_id: "foreign".into(),
                },
                &configuration,
                vec![Record {
                    source_message_id: "message".into(),
                    source_turn_id: "turn".into(),
                    timestamp: None,
                    content: Content::User {
                        text: "Hello".into(),
                    },
                }],
                2,
            )
            .await,
    );
    let bytes = exported().await;
    let staged = crate::bundle::StagedBundle::read(bytes.as_slice())
        .await
        .unwrap();
    let fingerprint = maka_agent_facts::artifact::content_digest(b"binding");
    assert!(matches!(
        store
            .import_bundle(
                staged,
                &fingerprint,
                std::collections::BTreeMap::from([
                    ("bundle-root".into(), json!({})),
                    ("bundle-child".into(), configuration)
                ])
            )
            .await,
        Err(crate::bundle::BundleError::Store(
            StoreError::SessionCreationRejected(CreationRejection::MissingWorkspaceBinding)
        ))
    ));
    store.close().await.unwrap();
    let store = RootStore::open(owner).await.unwrap();
    for id in ["plugin", "copy", "import", "bundle-root", "bundle-child"] {
        assert!(matches!(
            store.session(id).await,
            Err(StoreError::SessionNotFound)
        ));
    }
    assert!(store.session("source").await.is_ok());
    store.close().await.unwrap();
}

async fn creation_blocks_relocation(import: bool) {
    use crate::projects::ProjectRegistration;
    use maka_agent_facts::import::{Content, Record, Source};
    use std::time::Duration;
    let directory = tempfile::tempdir().unwrap();
    let store = Arc::new(RootStore::open(owner(directory.path())).await.unwrap());
    let registration = |path: &str| ProjectRegistration {
        identity: format!("folder:{path}"),
        path: path.into(),
        name: "Project".into(),
        is_worktree: false,
    };
    let project = store
        .register_project(registration("/old"), true, 1)
        .await
        .unwrap();
    let binding = store
        .attach_workspace("owner", &json!({"projectId":project.id,"path":"/old"}))
        .await
        .unwrap();
    let target = "pinned-target";
    let partition = store.partitions[partition_for(b"session", target)].clone();
    let (entered, reached) = tokio::sync::oneshot::channel();
    let (release, gate) = std::sync::mpsc::channel();
    let blocking = tokio::spawn(async move {
        partition
            .connection
            .run(move |db| {
                Box::pin(async move {
                    db.run_with_connection(move |_| {
                        entered.send(()).unwrap();
                        gate.recv_timeout(Duration::from_secs(30)).unwrap();
                    })
                    .await?;
                    Ok(())
                })
            })
            .await
    });
    reached.await.unwrap();
    let creating = store.clone();
    let creation = tokio::spawn(async move {
        let configuration = json!({"workspace":binding,"boundary_revision":0});
        if import {
            creating
                .import_session(
                    &origin(target, None),
                    &Source {
                        adapter: "test".into(),
                        session_id: "foreign".into(),
                    },
                    &configuration,
                    vec![Record {
                        source_message_id: "message".into(),
                        source_turn_id: "turn".into(),
                        timestamp: None,
                        content: Content::User {
                            text: "Hello".into(),
                        },
                    }],
                    2,
                )
                .await
                .map(|_| ())
        } else {
            creating
                .create_session(target, "create", &configuration, 2)
                .await
                .map(|_| ())
        }
    });
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if store
                .gates
                .try_write([super::super::gates::Key::Binding(binding.id)])
                .unwrap()
                .is_none()
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let selected = json!({"projectId":project.id,"path":"/new"});
    assert!(matches!(
        store
            .relink_project(
                &project.id,
                "owner",
                registration("/new"),
                3,
                selected.clone()
            )
            .await,
        Err(StoreError::SessionBusy)
    ));
    release.send(()).unwrap();
    blocking.await.unwrap().unwrap();
    creation.await.unwrap().unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if store
                .gates
                .try_write([super::super::gates::Key::Binding(binding.id)])
                .unwrap()
                .is_some()
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    store
        .relink_project(&project.id, "owner", registration("/new"), 3, selected)
        .await
        .unwrap();
    assert_eq!(
        store
            .workspace_binding::<Value>(binding.id)
            .await
            .unwrap()
            .unwrap()
            .permission_epoch,
        1
    );
    store.shutdown().await.unwrap();
}

#[tokio::test]
async fn ordinary_creation_holds_destination_binding_against_relocation() {
    creation_blocks_relocation(false).await;
}

#[tokio::test]
async fn complete_import_holds_destination_binding_against_relocation() {
    creation_blocks_relocation(true).await;
}
