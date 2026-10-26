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

use maka_event_log::{
    EventLog, StoreError,
    projects::{ProjectError, ProjectMutation, ProjectRegistration, ProjectRelinkGuard},
};
use serde_json::{Value, json};
use sqlx::Connection;

fn registration(identity: &str, path: &str, worktree: bool) -> ProjectRegistration {
    ProjectRegistration {
        identity: identity.into(),
        path: path.into(),
        name: "Repository".into(),
        is_worktree: worktree,
    }
}
#[path = "projects/registration.rs"]
mod registration;

async fn member(log: &EventLog, owner: &str, id: &str, project: Option<&str>, path: &str) {
    let workspace = json!({"projectId":project,"path":path,"worktree":{"original":path}});
    let reference = log.attach_workspace(owner, &workspace).await.unwrap();
    log.create_session(
        id,
        &format!("original-{id}"),
        &json!({"workspace":reference,"boundary_revision":4,"title":id}),
        10,
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn relink_merges_aliases_and_bindings_atomically_without_rewriting_sessions_or_facts() {
    use maka_agent_facts::{
        event::{EventWrite, Fact, Invocation, RuntimeEvent},
        input::InvocationInput,
    };
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("events.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    let first = log
        .register_project(registration("folder:/old", "/old", false), true, 1)
        .await
        .unwrap();
    let second = log
        .register_project(registration("git:/new/.git", "/new", false), true, 2)
        .await
        .unwrap();
    log.register_project(registration("git:/new/.git", "/linked", true), false, 3)
        .await
        .unwrap();
    let third = log
        .register_project(registration("folder:/third", "/third", false), true, 4)
        .await
        .unwrap();
    member(&log, "owner_", "a", Some(&first.id), "/old").await;
    member(&log, "owner_", "b", Some(&second.id), "/linked").await;
    member(&log, "owner_", "c", Some(&third.id), "/third").await;
    member(&log, "owner_", "unrelated", None, "/old").await;
    let opening = RuntimeEvent::new(
        Invocation {
            session_id: "a".into(),
            turn_id: "turn".into(),
            run_id: "run".into(),
            invocation_id: "invocation".into(),
        },
        Fact::InvocationOpened {
            configuration: None,
            input: InvocationInput::Message {
                source_messages: vec![],
                content: "immutable opening".into(),
                request_fingerprint: None,
            },
        },
    );
    log.append(&EventWrite::plain(opening).unwrap())
        .await
        .unwrap();
    let facts = serde_json::to_value(log.prefix(32, 65536).await.unwrap()).unwrap();
    let projects_before = log.list_projects().await.unwrap();
    let before = log.list_sessions::<Value>(None, None, 32).await.unwrap();
    let selected = json!({"path":"/new","projectId":first.id,"worktree":{"replacement":"new"}});
    let mut fault = sqlx::SqliteConnection::connect_with(
        &sqlx::sqlite::SqliteConnectOptions::new().filename(&path),
    )
    .await
    .unwrap();
    sqlx::query("CREATE TRIGGER fail_project_relink BEFORE UPDATE OF identity ON projects BEGIN SELECT RAISE(ABORT,'project-relink-fault'); END").execute(&mut fault).await.unwrap();
    let failure = log
        .relink_project(
            &first.id,
            "owner_",
            registration("git:/new/.git", "/new", false),
            30,
            selected.clone(),
        )
        .await
        .unwrap_err();
    assert!(failure.to_string().contains("project-relink-fault"));
    assert_eq!(log.list_projects().await.unwrap(), projects_before);
    let rollback = log.list_sessions::<Value>(None, None, 32).await.unwrap();
    assert_eq!(rollback.revision, before.revision);
    assert_eq!(rollback.sessions, before.sessions);
    sqlx::query("DROP TRIGGER fail_project_relink")
        .execute(&mut fault)
        .await
        .unwrap();
    sqlx::query("CREATE TRIGGER forbid_session_rewrite BEFORE UPDATE ON session_control BEGIN SELECT RAISE(ABORT,'Session rows must not change'); END").execute(&mut fault).await.unwrap();
    let merged = log
        .relink_project(
            &first.id,
            "owner_",
            registration("git:/new/.git", "/new", false),
            31,
            selected.clone(),
        )
        .await
        .unwrap();
    assert_eq!(merged.updated_bindings, 2);
    assert_eq!(merged.project.id, first.id);
    assert_eq!(merged.project.aliases, vec![second.id.clone()]);
    assert_eq!(
        merged
            .project
            .locations
            .iter()
            .map(|location| location.path.as_str())
            .collect::<Vec<_>>(),
        vec!["/linked", "/new"]
    );
    let after = log.list_sessions::<Value>(None, None, 32).await.unwrap();
    for (before, after) in before.sessions.iter().zip(&after.sessions) {
        assert_eq!(after.configuration, before.configuration);
        assert_eq!(after.configuration_digest, before.configuration_digest);
        match after.id.as_str() {
            "a" => {
                assert_eq!(after.revision, before.revision + 1);
                let binding = after.workspace_binding.as_ref().unwrap();
                assert_eq!(binding.workspace, selected);
                assert_eq!((binding.permission_epoch, binding.metadata_epoch), (1, 1));
            }
            "b" => {
                assert_eq!(after.revision, before.revision + 1);
                let binding = after.workspace_binding.as_ref().unwrap();
                assert_eq!(binding.workspace["projectId"], first.id);
                assert_eq!(binding.workspace["path"], "/linked");
                assert_eq!(binding.workspace["worktree"], json!({"original":"/linked"}));
                assert_eq!((binding.permission_epoch, binding.metadata_epoch), (0, 1));
            }
            _ => assert_eq!(after, before),
        }
    }
    assert_eq!(
        serde_json::to_value(log.prefix(32, 65536).await.unwrap()).unwrap(),
        facts
    );
    let again = log
        .relink_project(
            &second.id,
            "owner_",
            registration("folder:/third", "/third", false),
            32,
            json!({"path":"/third","projectId":first.id,"worktree":{"replacement":"third"}}),
        )
        .await
        .unwrap();
    assert_eq!(again.updated_bindings, 3);
    assert!(again.project.aliases.contains(&second.id));
    assert!(again.project.aliases.contains(&third.id));
    let expected = log.list_sessions::<Value>(None, None, 32).await.unwrap();
    sqlx::query("DROP TRIGGER forbid_session_rewrite")
        .execute(&mut fault)
        .await
        .unwrap();
    fault.close().await.unwrap();
    log.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    assert_eq!(
        log.list_sessions::<Value>(None, None, 32)
            .await
            .unwrap()
            .sessions,
        expected.sessions
    );
    assert_eq!(
        serde_json::to_value(log.prefix(32, 65536).await.unwrap()).unwrap(),
        facts
    );
    log.close().await.unwrap();
}

#[tokio::test]
async fn guarded_project_changes_compare_exact_observations_and_only_relink_owned_bindings() {
    let temp = tempfile::tempdir().unwrap();
    let log = EventLog::open(&temp.path().join("projects.sqlite"))
        .await
        .unwrap();
    let first = log
        .register_project_if(
            registration("owner:folder:/first", "/first", false),
            true,
            1,
            None,
        )
        .await
        .unwrap();
    assert!(matches!(
        log.register_project_if(
            registration("owner:folder:/first", "/first", false),
            true,
            2,
            None
        )
        .await,
        Err(StoreError::Project(ProjectError::Changed))
    ));
    let renamed = log
        .mutate_project_if(first.clone(), ProjectMutation::Rename("Renamed".into()), 2)
        .await
        .unwrap();
    assert!(matches!(
        log.mutate_project_if(first.clone(), ProjectMutation::Archive, 3)
            .await,
        Err(StoreError::Project(ProjectError::Changed))
    ));
    assert!(matches!(
        log.select_project_if(first, vec!["/first".into()], 3).await,
        Err(StoreError::Project(ProjectError::Changed))
    ));
    let target = log
        .register_project_if(
            registration("owner:folder:/target", "/target", false),
            true,
            3,
            None,
        )
        .await
        .unwrap();
    let other = log
        .register_project(
            registration("foreign:folder:/hidden", "/hidden", false),
            true,
            3,
        )
        .await
        .unwrap();
    assert_eq!(
        log.projects_with_identity_prefix("owner:")
            .await
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        log.projects_with_identity_prefix("foreign:").await.unwrap(),
        vec![other]
    );
    member(&log, "own_", "own_session", Some(&renamed.id), "/first").await;
    member(&log, "own_", "own_shared", Some(&renamed.id), "/first").await;
    member(
        &log,
        "foreign_",
        "foreign_session",
        Some(&renamed.id),
        "/first",
    )
    .await;
    let before = log
        .get_session::<Value>("own_session")
        .await
        .unwrap()
        .unwrap();
    let foreign = log
        .get_session::<Value>("foreign_session")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        before.configuration["workspace"],
        log.get_session::<Value>("own_shared")
            .await
            .unwrap()
            .unwrap()
            .configuration["workspace"]
    );
    let stale = ProjectRelinkGuard {
        source: renamed.clone(),
        destination: Some(target.clone()),
        owner_scope: "own_".into(),
    };
    let target = log
        .mutate_project_if(
            target,
            ProjectMutation::Rename("Destination changed".into()),
            4,
        )
        .await
        .unwrap();
    let selected = json!({"path":"/target","projectId":renamed.id});
    assert!(matches!(
        log.relink_project_if(
            stale,
            registration("owner:folder:/target", "/target", false),
            5,
            selected.clone()
        )
        .await,
        Err(StoreError::Project(ProjectError::Changed))
    ));
    assert_eq!(
        log.get_session::<Value>("own_session")
            .await
            .unwrap()
            .unwrap(),
        before
    );
    let mut own_notice = log.subscribe_session_commits("own_session");
    let foreign_notice = log.subscribe_session_commits("foreign_session");
    let merged = log
        .relink_project_if(
            ProjectRelinkGuard {
                source: renamed,
                destination: Some(target),
                owner_scope: "own_".into(),
            },
            registration("owner:folder:/target", "/target", false),
            6,
            selected.clone(),
        )
        .await
        .unwrap();
    assert_eq!(
        merged.updated_bindings, 1,
        "shared selection must not be allocated per Session"
    );
    let after = log
        .get_session::<Value>("own_session")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(after.configuration, before.configuration);
    assert_eq!(after.workspace_binding.unwrap().workspace, selected);
    assert_eq!(
        log.get_session::<Value>("foreign_session")
            .await
            .unwrap()
            .unwrap(),
        foreign
    );
    tokio::time::timeout(std::time::Duration::from_secs(1), own_notice.changed())
        .await
        .unwrap()
        .unwrap();
    assert!(!foreign_notice.has_changed().unwrap());
    drop(own_notice);
    drop(foreign_notice);
    log.close().await.unwrap();
}
