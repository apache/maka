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
use maka_sandbox::workspace::BindingRef;
use serde_json::json;

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
    let store = RootStore::open(owner, crate::ROOT_MIGRATIONS)
        .await
        .unwrap();
    (directory, store)
}
async fn workspace(store: &RootStore, path: &std::path::Path) -> RootWorkspace {
    std::fs::create_dir_all(path).unwrap();
    store
        .workspace(cap_std::fs::Dir::open_ambient_dir(path, cap_std::ambient_authority()).unwrap())
        .await
        .unwrap()
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
            {
                Ok(connection.query_row(
                    "SELECT revision,configuration FROM session_control WHERE id=?",
                    rusqlite::params![id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )?)
            }
        })
        .await
        .unwrap()
}

#[tokio::test]
async fn relink_updates_control_and_effective_cas_across_sessions_without_rewriting_sessions() {
    let (directory, store) = fixture().await;
    let old = directory.path().join("old").to_str().unwrap().to_owned();
    let new = directory.path().join("new").to_str().unwrap().to_owned();
    let source_workspace = workspace(&store, std::path::Path::new(&old)).await;
    let target_workspace = workspace(&store, std::path::Path::new(&new)).await;
    let source = store
        .register_project(registration("source", &old), true, 1)
        .await
        .unwrap();
    let binding = attach(&store, &source, &old).await;
    let first = create(&store, "one", binding).await;
    let second_id = "other".to_owned();
    let second = create(&store, &second_id, binding).await;
    let before = first.get::<Value>().await.unwrap().unwrap();
    let basis = crate::workspace_bindings::effective_boundary(
        &before.configuration,
        before.workspace_binding.as_ref().unwrap(),
    )
    .unwrap();
    let raw_first = raw(&first).await;
    let raw_second = raw(&second).await;
    let fence = store
        .fence_workspaces(&[source_workspace, target_workspace])
        .await
        .unwrap();
    store
        .relink_project(
            &source.id,
            "owner",
            &fence,
            registration("new", &new),
            2,
            json!({"path":new,"identity":"new"}),
        )
        .await
        .unwrap();
    drop(fence);
    assert_eq!(raw(&first).await, raw_first);
    assert_eq!(raw(&second).await, raw_second);
    for session in [&first, &second] {
        let after = session.get::<Value>().await.unwrap().unwrap();
        assert_eq!(after.revision, before.revision + 1);
        assert_eq!(after.workspace_binding.unwrap().workspace["path"], new);
        assert!(matches!(
            session.work_scope(Some(basis)).await,
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
    let (directory, store) = fixture().await;
    let old = directory.path().join("old").to_str().unwrap().to_owned();
    let new = directory.path().join("new").to_str().unwrap().to_owned();
    let source_workspace = workspace(&store, std::path::Path::new(&old)).await;
    let target_workspace = workspace(&store, std::path::Path::new(&new)).await;
    let source = store
        .register_project(registration("source", &old), true, 1)
        .await
        .unwrap();
    let other_path = directory.path().join("other");
    let other_workspace = workspace(&store, &other_path).await;
    let other_path = other_path.to_str().unwrap();
    let other = store
        .register_project(registration("other", other_path), true, 1)
        .await
        .unwrap();
    let session = create(&store, "one", attach(&store, &source, &old).await).await;
    let unrelated = create(&store, "other", attach(&store, &other, other_path).await).await;
    let record = session.get::<Value>().await.unwrap().unwrap();
    let basis = crate::workspace_bindings::effective_boundary(
        &record.configuration,
        record.workspace_binding.as_ref().unwrap(),
    )
    .unwrap();
    let (active, effects) = session
        .work_scope_in(Some(basis), &source_workspace)
        .await
        .unwrap()
        .accept(tokio_util::sync::CancellationToken::new());
    assert!(matches!(
        store
            .fence_workspaces(&[source_workspace.clone(), target_workspace.clone()])
            .await,
        Err(StoreError::SessionBusy)
    ));
    effects.settle().await.unwrap();
    active.finish();
    let record = unrelated.get::<Value>().await.unwrap().unwrap();
    let basis = crate::workspace_bindings::effective_boundary(
        &record.configuration,
        record.workspace_binding.as_ref().unwrap(),
    )
    .unwrap();
    let (unrelated_active, unrelated_effects) = unrelated
        .work_scope_in(Some(basis), &other_workspace)
        .await
        .unwrap()
        .accept(tokio_util::sync::CancellationToken::new());
    let fence = store
        .fence_workspaces(&[source_workspace, target_workspace])
        .await
        .unwrap();
    store
        .relink_project(
            &source.id,
            "owner",
            &fence,
            registration("new", &new),
            2,
            json!({"path":new}),
        )
        .await
        .unwrap();
    drop(fence);
    unrelated_effects.settle().await.unwrap();
    unrelated_active.finish();
    store.close().await.unwrap();
}

#[tokio::test]
async fn cancelled_relink_commit_retains_binding_and_project_custody_until_sql_cleanup() {
    use std::task::Poll;
    use tokio::sync::oneshot;
    let (directory, store) = fixture().await;
    let old = directory.path().join("old").to_str().unwrap().to_owned();
    let new = directory.path().join("new").to_str().unwrap().to_owned();
    let source_workspace = workspace(&store, std::path::Path::new(&old)).await;
    let target_workspace = workspace(&store, std::path::Path::new(&new)).await;
    let source = store
        .register_project(registration("source", &old), true, 1)
        .await
        .unwrap();
    let binding = attach(&store, &source, &old).await;
    let registration = registration("new", &new);
    let workspaces = [source_workspace, target_workspace];
    let fence = store.fence_workspaces(&workspaces).await.unwrap();
    let (control, guard) = store
        .prepare_relink(&source.id, "owner", &registration, None, &fence)
        .await
        .unwrap();
    let (entered, started) = oneshot::channel();
    let (release, released) = oneshot::channel();
    let owner = store.log.clone();
    let blocker = tokio::spawn(async move {
        owner
            .connection
            .run(move |_| {
                entered.send(()).unwrap();
                released.blocking_recv().unwrap();
                Ok(())
            })
            .await
            .unwrap();
    });
    started.await.unwrap();
    let mut operation =
        Box::pin(control.relink_project_if(guard, registration, 2, json!({"path":new})));
    std::future::poll_fn(|cx| {
        assert!(operation.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
    drop(operation);
    drop(control);
    drop(fence);
    assert!(matches!(
        store.fence_workspaces(&workspaces).await,
        Err(StoreError::SessionBusy)
    ));
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
    store.log.connection.run(|_| Ok(())).await.unwrap();
    assert!(store.project_mutations.try_lock().is_ok());
    drop(store.fence_workspaces(&workspaces).await.unwrap());
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
        new
    );
    store.close().await.unwrap();
}
