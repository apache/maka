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
fn origin(id: &str, authority: Option<&str>) -> PluginSession {
    PluginSession {
        session_id: id.into(),
        creator: maka_plugin_core::storage::Namespace::new(
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
async fn history_metadata_does_not_supply_management_authority_or_reparent_dependencies() {
    use crate::sessions::{RemovalAuthority, RemoveFamilyResult};
    let directory = tempfile::tempdir().unwrap();
    let store = RootStore::open(owner(directory.path()), crate::ROOT_MIGRATIONS)
        .await
        .unwrap();
    store
        .create_session("parent", "parent", &json!({}), 1)
        .await
        .unwrap();
    let mut managed = origin("managed", None);
    managed.managed = true;
    store
        .create_plugin_session(&managed, &json!({}), 1)
        .await
        .unwrap();
    let revision = origin("revision", Some("parent"));
    store
        .create_plugin_session(
            &revision,
            &json!({"historySource":"managed","parentSessionId":"managed"}),
            2,
        )
        .await
        .unwrap();
    let managed_before = store
        .get_session::<Value>("managed")
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(
        store
            .remove_session_family(
                "managed",
                managed_before.revision,
                RemovalAuthority::Granted {
                    namespace: revision.creator.clone(),
                    sessions: ["revision".into()].into_iter().collect()
                }
            )
            .await,
        Err(StoreError::SessionConflict)
    ));
    assert_eq!(
        store.get_session::<Value>("managed").await.unwrap(),
        Some(managed_before.clone())
    );
    let expected = store
        .get_session::<Value>("parent")
        .await
        .unwrap()
        .unwrap()
        .revision;
    let RemoveFamilyResult::Accepted(plan) = store
        .remove_session_family("parent", expected, RemovalAuthority::Unmanaged)
        .await
        .unwrap()
    else {
        panic!("original Root lifecycle dependency");
    };
    assert_eq!(plan.remove, ["parent"]);
    assert_eq!(plan.archive, ["revision"]);
    assert_eq!(
        store.get_session::<Value>("managed").await.unwrap(),
        Some(managed_before)
    );
    store.close().await.unwrap();
}

#[tokio::test]
async fn creation_authority_uses_source_instead_of_target_identity() {
    let directory = tempfile::tempdir().unwrap();
    let store = RootStore::open(owner(directory.path()), crate::ROOT_MIGRATIONS)
        .await
        .unwrap();
    store
        .create_session("source", "source", &json!({}), 1)
        .await
        .unwrap();
    let targets: Vec<String> = (0..3).map(|index| format!("target-{index}")).collect();
    for target in &targets {
        store
            .create_plugin_session(&origin(target, Some("source")), &json!({}), 2)
            .await
            .unwrap();
    }
    let authority = store.preview_session_removal("source").await.unwrap();
    assert_eq!(authority.remove, ["source"]);
    assert_eq!(authority.archive, targets);
    store.close().await.unwrap();
}

#[tokio::test]
async fn pending_family_reservation_reopens_with_one_original_terminal_rejection() {
    let directory = tempfile::tempdir().unwrap();
    let owner = owner(directory.path());
    let store = RootStore::open(owner.clone(), crate::ROOT_MIGRATIONS)
        .await
        .unwrap();
    let reference = maka_sandbox::workspace::BindingRef {
        id: uuid::Uuid::new_v4(),
        permission_epoch_at_attach: 0,
        metadata_epoch_at_attach: 0,
    };
    let claim = origin("family-root", None);
    let command = Creation::Plugin {
        origin: (&claim).into(),
        configuration: json!({"workspace":reference,"boundary_revision":0}),
        created_at: 2,
    };
    store
        .reserve_family(
            "family-root",
            &claim.fingerprint,
            command,
            vec!["family-root".into(), "family-child".into()],
        )
        .await
        .unwrap();
    assert!(matches!(
        store.session("family-child").await,
        Err(StoreError::SessionNotFound)
    ));
    assert!(
        store
            .log
            .get_session::<Value>("family-root")
            .await
            .unwrap()
            .is_none()
    );
    store.close().await.unwrap();
    let store = RootStore::open(owner, crate::ROOT_MIGRATIONS)
        .await
        .unwrap();
    for id in ["family-root", "family-child"] {
        assert!(matches!(
            store.session(id).await,
            Err(StoreError::SessionNotFound)
        ));
        assert!(matches!(
            store
                .probe_session_create::<Value>(id, &claim.fingerprint)
                .await,
            Err(StoreError::SessionCreationRejected(
                CreationRejection::MissingWorkspaceBinding
            ))
        ));
        assert!(store.log.get_session::<Value>(id).await.unwrap().is_none());
    }
    store.close().await.unwrap();
}

#[tokio::test]
async fn atomic_family_reservation_cannot_leave_partial_members() {
    let directory = tempfile::tempdir().unwrap();
    let store = RootStore::open(owner(directory.path()), crate::ROOT_MIGRATIONS)
        .await
        .unwrap();
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
            .reserve_family("new", "new", command, vec!["new".into(), "occupied".into()])
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
    let store = RootStore::open(owner(directory.path()), crate::ROOT_MIGRATIONS)
        .await
        .unwrap();
    let claim = origin("rejected", Some("source"));
    let command = Creation::Plugin {
        origin: (&claim).into(),
        configuration: json!({}),
        created_at: 2,
    };
    let command = store
        .reserve_family(
            "rejected",
            &claim.fingerprint,
            command,
            vec!["rejected".into()],
        )
        .await
        .unwrap();
    let creation = store
        .gates
        .write([gates::Key::Creation("rejected".into())])
        .await
        .unwrap();
    let rejection = commit(&store, &store.log, command).await.unwrap();
    assert_eq!(rejection, Some(CreationRejection::MissingDependency));
    let mut probe = Box::pin(store.probe_session_create::<Value>("rejected", &claim.fingerprint));
    assert!(futures_util::poll!(&mut probe).is_pending());
    // The same immutable command could now succeed, but its original rejection wins.
    store
        .create_session("source", "source", &json!({}), 1)
        .await
        .unwrap();
    store
        .log
        .connection
        .write(
            creation::WritePublication {
                id: "rejected".into(),
                rejection,
            },
            store.log.commits.notice(),
        )
        .await
        .unwrap();
    drop(creation);
    assert!(matches!(
        probe.await,
        Err(StoreError::SessionCreationRejected(
            CreationRejection::MissingDependency
        ))
    ));
    let command = Creation::Plugin {
        origin: (&claim).into(),
        configuration: json!({}),
        created_at: 2,
    };
    assert!(matches!(
        store
            .finish_creation("rejected", &claim.fingerprint, command)
            .await,
        Err(StoreError::SessionCreationRejected(
            CreationRejection::MissingDependency
        ))
    ));
    assert!(
        store
            .log
            .get_session::<Value>("rejected")
            .await
            .unwrap()
            .is_none()
    );
    store.close().await.unwrap();
}

#[tokio::test]
async fn plugin_missing_binding_rejects_and_reopens() {
    let directory = tempfile::tempdir().unwrap();
    let owner = owner(directory.path());
    let store = RootStore::open(owner.clone(), crate::ROOT_MIGRATIONS)
        .await
        .unwrap();
    store
        .create_session("source", "source", &json!({}), 1)
        .await
        .unwrap();
    let reference = maka_sandbox::workspace::BindingRef {
        id: uuid::Uuid::new_v4(),
        permission_epoch_at_attach: 0,
        metadata_epoch_at_attach: 0,
    };
    let configuration = json!({"workspace":reference,"boundary_revision":0});
    assert!(matches!(
        store
            .create_plugin_session(&origin("plugin", None), &configuration, 2)
            .await,
        Err(StoreError::SessionCreationRejected(
            CreationRejection::MissingWorkspaceBinding
        ))
    ));
    store.close().await.unwrap();
    let store = RootStore::open(owner, crate::ROOT_MIGRATIONS)
        .await
        .unwrap();
    assert!(matches!(
        store.session("plugin").await,
        Err(StoreError::SessionNotFound)
    ));
    assert!(store.session("source").await.is_ok());
    store.close().await.unwrap();
}

async fn creation_blocks_relocation() {
    use crate::projects::ProjectRegistration;
    use std::time::Duration;
    let directory = tempfile::tempdir().unwrap();
    let store = Arc::new(
        RootStore::open(owner(directory.path()), crate::ROOT_MIGRATIONS)
            .await
            .unwrap(),
    );
    let registration = |path: &str| ProjectRegistration {
        identity: format!("folder:{path}"),
        path: path.into(),
        name: "Project".into(),
        is_worktree: false,
    };
    let old = directory.path().join("old");
    let new = directory.path().join("new");
    let mut workspaces = Vec::new();
    for path in [&old, &new] {
        std::fs::create_dir(path).unwrap();
        workspaces.push(
            store
                .workspace(
                    cap_std::fs::Dir::open_ambient_dir(path, cap_std::ambient_authority()).unwrap(),
                )
                .await
                .unwrap(),
        );
    }
    let fence = store.fence_workspaces(&workspaces).await.unwrap();
    let old = old.to_str().unwrap();
    let new = new.to_str().unwrap();
    let project = store
        .register_project(registration(old), true, 1)
        .await
        .unwrap();
    let binding = store
        .attach_workspace("owner", &json!({"projectId":project.id,"path":old}))
        .await
        .unwrap();
    let target = "pinned-target";
    let log = store.log.clone();
    let (entered, reached) = tokio::sync::oneshot::channel();
    let (release, gate) = std::sync::mpsc::channel();
    let blocking = tokio::spawn(async move {
        log.connection
            .run(move |_| {
                entered.send(()).unwrap();
                gate.recv_timeout(Duration::from_secs(30)).unwrap();

                Ok(())
            })
            .await
    });
    reached.await.unwrap();
    let creating = store.clone();
    let creation = tokio::spawn(async move {
        let configuration = json!({"workspace":binding,"boundary_revision":0});
        creating
            .create_session(target, "create", &configuration, 2)
            .await
            .map(|_| ())
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
    let selected = json!({"projectId":project.id,"path":new});
    assert!(matches!(
        store
            .relink_project(
                &project.id,
                "owner",
                &fence,
                registration(new),
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
        .relink_project(&project.id, "owner", &fence, registration(new), 3, selected)
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
    drop(fence);
    store.shutdown().await.unwrap();
}

#[tokio::test]
async fn ordinary_creation_holds_destination_binding_against_relocation() {
    creation_blocks_relocation().await;
}
