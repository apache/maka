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
use maka_agent_facts::workspace::BindingRef;
use serde_json::json;

#[tokio::test]
async fn concurrent_project_use_preserves_identity_and_cannot_overtake_archive() {
    use futures_util::poll;

    let (_directory, store) = fixture().await;
    let (first, second) = tokio::join!(
        store.register_available_project(registration("physical", "/workspace"), 1),
        store.register_available_project(registration("physical", "/workspace"), 2),
    );
    let first = first.unwrap();
    let second = second.unwrap();
    assert_eq!(first.id, second.id);
    assert_eq!(second.last_used_at, 2);

    let gate = store.project_mutations.clone().lock_owned().await;
    let mut archive = Box::pin(store.mutate_project(&first.id, ProjectMutation::Archive, 3));
    assert!(poll!(archive.as_mut()).is_pending());
    let mut use_project =
        Box::pin(store.register_available_project(registration("physical", "/new-location"), 4));
    assert!(poll!(use_project.as_mut()).is_pending());
    drop(gate);
    let archived = archive.await.unwrap();
    assert!(matches!(
        use_project.await,
        Err(StoreError::Project(ProjectError::Archived))
    ));
    assert_eq!(
        store.get_project(&first.id).await.unwrap().unwrap(),
        archived
    );
    assert_eq!(archived.locations.len(), 1);
    store.close().await.unwrap();
}

async fn fixture() -> (tempfile::TempDir, RootStore) {
    let directory = tempfile::tempdir().unwrap();
    let p = directory.path();
    let owner = Arc::new(
        root::RootOwner::create(
            &p.join("root"),
            &root::RootNamespaces {
                ownership: p.join("ownership"),
                control: p.join("control"),
            },
        )
        .unwrap(),
    );
    let store = RootStore::open(owner).await.unwrap();
    (directory, store)
}
fn registration(identity: &str, path: &str) -> ProjectRegistration {
    ProjectRegistration {
        identity: identity.into(),
        name: identity.into(),
        path: path.into(),
        is_worktree: false,
    }
}
async fn attach(store: &RootStore, project: &ProjectRecord, path: &str) -> BindingRef {
    store
        .attach_workspace(
            "owner",
            &json!({"projectId":project.id,"path":path,"identity":project.identity}),
        )
        .await
        .unwrap()
}
async fn create(store: &RootStore, id: &str, binding: BindingRef) -> SessionStore {
    store
        .create_session(
            id,
            id,
            &json!({"workspace":binding,"boundary_revision":0}),
            1,
        )
        .await
        .unwrap()
}
async fn raw(session: &SessionStore) -> (i64, String) {
    let id = session.id.to_string();
    session
        .owner()
        .unwrap()
        .connection
        .read(move |connection| {
            Box::pin(async move {
                Ok(
                    sqlx::query_as("SELECT revision,configuration FROM session_control WHERE id=?")
                        .bind(id)
                        .fetch_one(connection)
                        .await?,
                )
            })
        })
        .await
        .unwrap()
}

#[tokio::test]
async fn relink_updates_control_and_effective_cas_across_partitions_without_rewriting_sessions() {
    let (_directory, store) = fixture().await;
    let source = store
        .register_project(registration("source", "/old"), true, 1)
        .await
        .unwrap();
    let binding = attach(&store, &source, "/old").await;
    let first = create(&store, "one", binding).await;
    let second_id = (0..100)
        .map(|n| format!("other-{n}"))
        .find(|id| partition_for(b"session", id) != partition_for(b"session", "one"))
        .unwrap();
    let second = create(&store, &second_id, binding).await;
    let before = first.get::<Value>().await.unwrap().unwrap();
    let basis = crate::workspace_bindings::effective_boundary(
        &before.configuration,
        before.workspace_binding.as_ref().unwrap(),
    )
    .unwrap();
    let raw_first = raw(&first).await;
    let raw_second = raw(&second).await;
    store
        .relink_project(
            &source.id,
            "owner",
            registration("new", "/new"),
            2,
            json!({"path":"/new","identity":"new"}),
        )
        .await
        .unwrap();
    assert_eq!(raw(&first).await, raw_first);
    assert_eq!(raw(&second).await, raw_second);
    for session in [&first, &second] {
        let after = session.get::<Value>().await.unwrap().unwrap();
        assert_eq!(after.revision, before.revision + 1);
        assert_eq!(after.workspace_binding.unwrap().workspace["path"], "/new");
        assert!(matches!(
            session.execution_scope(Some(basis)).await,
            Err(StoreError::PermissionRevoked)
        ));
    }
    assert!(matches!(
        first
            .update_session_metadata::<Value, _>("one", before.revision, |_| Ok(()))
            .await
            .unwrap(),
        crate::sessions::SessionMutation::RevisionConflict { .. }
    ));
    store.close().await.unwrap();
}

#[tokio::test]
async fn source_execution_blocks_relink_but_unrelated_execution_does_not() {
    let (_directory, store) = fixture().await;
    let source = store
        .register_project(registration("source", "/old"), true, 1)
        .await
        .unwrap();
    let other = store
        .register_project(registration("other", "/other"), true, 1)
        .await
        .unwrap();
    let session = create(&store, "one", attach(&store, &source, "/old").await).await;
    let unrelated = create(&store, "other", attach(&store, &other, "/other").await).await;
    let record = session.get::<Value>().await.unwrap().unwrap();
    let basis = crate::workspace_bindings::effective_boundary(
        &record.configuration,
        record.workspace_binding.as_ref().unwrap(),
    )
    .unwrap();
    let active = session.execution_scope(Some(basis)).await.unwrap();
    assert!(matches!(
        store
            .relink_project(
                &source.id,
                "owner",
                registration("new", "/new"),
                2,
                json!({"path":"/new"})
            )
            .await,
        Err(StoreError::SessionBusy)
    ));
    drop(active);
    let record = unrelated.get::<Value>().await.unwrap().unwrap();
    let basis = crate::workspace_bindings::effective_boundary(
        &record.configuration,
        record.workspace_binding.as_ref().unwrap(),
    )
    .unwrap();
    let unrelated_active = unrelated.execution_scope(Some(basis)).await.unwrap();
    store
        .relink_project(
            &source.id,
            "owner",
            registration("new", "/new"),
            2,
            json!({"path":"/new"}),
        )
        .await
        .unwrap();
    drop(unrelated_active);
    store.close().await.unwrap();
}

#[tokio::test]
async fn absorbed_locations_keep_independent_paths_and_permission_epochs() {
    let (_directory, store) = fixture().await;
    let source = store
        .register_project(registration("source", "/old"), true, 1)
        .await
        .unwrap();
    let destination = store
        .register_project(registration("destination", "/dest"), true, 1)
        .await
        .unwrap();
    let a = attach(&store, &destination, "/dest").await;
    let b = attach(&store, &destination, "/worktree").await;
    store
        .relink_project(
            &source.id,
            "owner",
            registration("destination", "/dest"),
            2,
            json!({"path":"/dest"}),
        )
        .await
        .unwrap();
    for (binding, path) in [(a, "/dest"), (b, "/worktree")] {
        let current = store
            .workspace_binding::<Value>(binding.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(current.workspace["path"], path);
        assert_eq!(current.workspace["projectId"], source.id);
        assert_eq!(current.permission_epoch, binding.permission_epoch_at_attach);
        assert_eq!(current.metadata_epoch, binding.metadata_epoch_at_attach + 1);
    }
    store.close().await.unwrap();
}

#[tokio::test]
async fn partition_revision_exhaustion_rejects_entire_control_mutation() {
    let (_directory, store) = fixture().await;
    let source = store
        .register_project(registration("source", "/old"), true, 1)
        .await
        .unwrap();
    let binding = attach(&store, &source, "/old").await;
    let session = create(&store, "full", binding).await;
    session
        .owner()
        .unwrap()
        .connection
        .run(|connection| {
            Box::pin(async move {
                sqlx::query("UPDATE session_control SET revision=? WHERE id='full'")
                    .bind(MAX as i64)
                    .execute(connection)
                    .await?;
                Ok(())
            })
        })
        .await
        .unwrap();
    assert!(
        store
            .relink_project(
                &source.id,
                "owner",
                registration("new", "/new"),
                2,
                json!({"path":"/new"})
            )
            .await
            .is_err()
    );
    assert_eq!(
        store.get_project(&source.id).await.unwrap().unwrap(),
        source
    );
    let current = store
        .workspace_binding::<Value>(binding.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(current.metadata_epoch, binding.metadata_epoch_at_attach);
    assert_eq!(current.workspace["path"], "/old");
    store.close().await.unwrap();
}

#[tokio::test]
async fn cancelled_relink_commit_retains_binding_and_project_custody_until_sql_cleanup() {
    use std::{future::Future, task::Poll};
    use tokio::sync::oneshot;
    let (_directory, store) = fixture().await;
    let source = store
        .register_project(registration("source", "/old"), true, 1)
        .await
        .unwrap();
    let binding = attach(&store, &source, "/old").await;
    let registration = registration("new", "/new");
    let (control, guard) = store
        .prepare_relink(&source.id, "owner", &registration, None)
        .await
        .unwrap();
    let (entered, started) = oneshot::channel();
    let (release, released) = oneshot::channel();
    let owner = store.control.clone();
    let blocker = tokio::spawn(async move {
        owner
            .connection
            .run(move |_| {
                Box::pin(async move {
                    entered.send(()).unwrap();
                    released.await.unwrap();
                    Ok(())
                })
            })
            .await
            .unwrap();
    });
    started.await.unwrap();
    let mut operation =
        Box::pin(control.relink_project_if(guard, registration, 2, json!({"path":"/new"})));
    std::future::poll_fn(|cx| {
        assert!(operation.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
    drop(operation);
    drop(control);
    assert!(store.project_mutations.try_lock().is_err());
    assert!(
        store
            .gates
            .try_write([gates::Key::Binding(binding.id)])
            .unwrap()
            .is_none()
    );
    release.send(()).unwrap();
    blocker.await.unwrap();
    // This queued barrier completes only after the cancelled commit's job exits.
    store
        .control
        .connection
        .run(|_| Box::pin(async { Ok(()) }))
        .await
        .unwrap();
    assert!(store.project_mutations.try_lock().is_ok());
    assert!(
        store
            .gates
            .try_write([gates::Key::Binding(binding.id)])
            .unwrap()
            .is_some()
    );
    assert_eq!(
        store
            .workspace_binding::<Value>(binding.id)
            .await
            .unwrap()
            .unwrap()
            .workspace["path"],
        "/new"
    );
    store.close().await.unwrap();
}
