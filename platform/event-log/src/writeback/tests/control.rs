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
use crate::projects::{ProjectError, ProjectMutation, ProjectRegistration};

fn registration(identity: &str, path: &str, is_worktree: bool) -> ProjectRegistration {
    ProjectRegistration {
        identity: identity.into(),
        name: "  project  ".into(),
        path: path.into(),
        is_worktree,
    }
}

#[tokio::test]
async fn control_rows_and_receipts_share_one_confirmed_full_commit() {
    let (_directory, log) = store().await;
    let count = Arc::new(AtomicUsize::new(0));
    let observed = count.clone();
    let (entered, reached) = oneshot::channel();
    let mut entered = Some(entered);
    let (release_commit, wait_commit) = std::sync::mpsc::channel();
    hook(&log, move || {
        observed.fetch_add(1, Ordering::SeqCst);
        entered.take().unwrap().send(()).unwrap();
        wait_commit.recv_timeout(Duration::from_secs(10)).unwrap();
        true
    })
    .await;
    let (release, blocked) = gate(&log).await;
    let mut project = Box::pin(log.register_project_if(
        registration("mixed-project", "/preferred", false),
        true,
        9,
        None,
    ));
    let workspace = json!({"path":"/preferred","selection":{"z":2,"a":1}});
    let mut attachment = Box::pin(log.attach_workspace("mixed-owner", &workspace));
    let mut repeated = Box::pin(log.attach_workspace("mixed-owner", &workspace));
    let mut location =
        Box::pin(log.register_project(registration("mixed-project", "/worktree", true), false, 3));
    assert!(futures_util::poll!(&mut project).is_pending());
    assert!(futures_util::poll!(&mut attachment).is_pending());
    assert!(futures_util::poll!(&mut repeated).is_pending());
    assert!(futures_util::poll!(&mut location).is_pending());
    release.send(()).unwrap();
    blocked.await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), reached)
        .await
        .unwrap()
        .unwrap();
    assert!(futures_util::poll!(&mut project).is_pending());
    assert!(futures_util::poll!(&mut attachment).is_pending());
    assert!(futures_util::poll!(&mut repeated).is_pending());
    assert!(futures_util::poll!(&mut location).is_pending());
    let db = rusqlite::Connection::open(
        log.owned_root()
            .unwrap()
            .canonical_path()
            .join(ROOT_DATABASE),
    )
    .unwrap();
    let before: (i64, i64) = db
        .query_row(
            "SELECT (SELECT count(*) FROM projects), (SELECT count(*) FROM workspace_bindings)",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(before, (0, 0), "unconfirmed rows must remain invisible");
    release_commit.send(()).unwrap();
    let first = project.await.unwrap();
    let binding = attachment.await.unwrap();
    assert_eq!(repeated.await.unwrap(), binding);
    let final_record = location.await.unwrap();
    assert_eq!(count.load(Ordering::SeqCst), 1);
    assert_eq!(first.id, final_record.id);
    assert_eq!(final_record.name, "project");
    assert!(final_record.aliases.is_empty());
    assert_eq!(final_record.last_used_at, 9);
    let mut locations: Vec<_> = final_record
        .locations
        .iter()
        .map(|location| {
            (
                location.path.as_str(),
                location.is_worktree,
                location.last_used_at,
            )
        })
        .collect();
    locations.sort();
    assert_eq!(
        locations,
        vec![("/preferred", false, 9), ("/worktree", true, 0)]
    );
    assert_eq!(
        log.get_project(&first.id).await.unwrap(),
        Some(final_record)
    );
    assert_eq!(
        log.workspace_binding::<serde_json::Value>(binding.id)
            .await
            .unwrap()
            .unwrap()
            .workspace,
        workspace
    );
}

#[tokio::test]
async fn repeated_attachment_returns_current_epochs_without_phantom_change() {
    let (_directory, log) = store().await;
    let workspace = json!({"path":"/shared","nested":{"z":2,"a":1}});
    let original = log.attach_workspace("owner", &workspace).await.unwrap();
    log.connection
        .run(move |db| {
            Box::pin(async move {
                sqlx::query(
                    "UPDATE workspace_bindings SET permission_epoch=4,metadata_epoch=7 WHERE id=?",
                )
                .bind(original.id.to_string())
                .execute(db)
                .await?;
                Ok(())
            })
        })
        .await
        .unwrap();
    let count = Arc::new(AtomicUsize::new(0));
    let observed = count.clone();
    hook(&log, move || {
        observed.fetch_add(1, Ordering::SeqCst);
        true
    })
    .await;
    let mut changes = log.connection.subscribe_changes();
    changes.borrow_and_update();
    let reordered: serde_json::Value =
        serde_json::from_str(r#"{"nested":{"a":1,"z":2},"path":"/shared"}"#).unwrap();
    let repeated = log.attach_workspace("owner", &reordered).await.unwrap();
    assert_eq!(repeated.id, original.id);
    assert_eq!(
        (
            repeated.permission_epoch_at_attach,
            repeated.metadata_epoch_at_attach
        ),
        (4, 7)
    );
    assert_eq!(
        count.load(Ordering::SeqCst),
        0,
        "reuse must not issue a physical commit"
    );
    assert!(
        !changes.has_changed().unwrap(),
        "reuse must not manufacture a database change"
    );
    let db = rusqlite::Connection::open(
        log.owned_root()
            .unwrap()
            .canonical_path()
            .join(ROOT_DATABASE),
    )
    .unwrap();
    assert_eq!(
        db.query_row("SELECT count(*) FROM workspace_bindings", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[tokio::test]
async fn guarded_project_rejections_preserve_independent_control_members() {
    let (_directory, log) = store().await;
    let observed = log
        .register_project(registration("archived", "/original", false), true, 5)
        .await
        .unwrap();
    let archived = log
        .mutate_project(&observed.id, ProjectMutation::Archive, 6)
        .await
        .unwrap();
    let count = Arc::new(AtomicUsize::new(0));
    let seen = count.clone();
    hook(&log, move || {
        seen.fetch_add(1, Ordering::SeqCst);
        true
    })
    .await;
    let (release, blocked) = gate(&log).await;
    let mut unavailable =
        Box::pin(log.register_available_project(registration("archived", "/forbidden", false), 8));
    let mut stale = Box::pin(log.register_project_if(
        registration("archived", "/stale", false),
        true,
        8,
        Some(observed),
    ));
    let mut valid =
        Box::pin(log.register_available_project(registration("independent", "/valid", false), 8));
    let workspace = json!({"path":"/valid"});
    let mut attachment = Box::pin(log.attach_workspace("independent", &workspace));
    assert!(futures_util::poll!(&mut unavailable).is_pending());
    assert!(futures_util::poll!(&mut stale).is_pending());
    assert!(futures_util::poll!(&mut valid).is_pending());
    assert!(futures_util::poll!(&mut attachment).is_pending());
    release.send(()).unwrap();
    blocked.await.unwrap();
    assert!(matches!(
        unavailable.await,
        Err(StoreError::Project(ProjectError::Archived))
    ));
    assert!(matches!(
        stale.await,
        Err(StoreError::Project(ProjectError::Changed))
    ));
    let valid = valid.await.unwrap();
    let attached = attachment.await.unwrap();
    assert_eq!(count.load(Ordering::SeqCst), 1);
    assert_eq!(log.get_project(&archived.id).await.unwrap(), Some(archived));
    assert_eq!(log.get_project(&valid.id).await.unwrap(), Some(valid));
    assert_eq!(
        log.workspace_binding::<serde_json::Value>(attached.id)
            .await
            .unwrap()
            .unwrap()
            .workspace,
        workspace
    );
}
