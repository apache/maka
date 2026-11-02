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

#[tokio::test]
async fn project_registration_preserves_preference_archival_and_identity_across_reopen() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("events.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    let input = registration("git:/repo/.git", "/repo", false);
    let (first, concurrent) = tokio::join!(
        log.register_project(input.clone(), true, 10),
        log.register_project(input, true, 11),
    );
    let project = first.unwrap();
    assert_eq!(project.id, concurrent.unwrap().id);
    let updated = log
        .register_project(registration("git:/repo/.git", "/worktree", true), false, 20)
        .await
        .unwrap();
    assert_eq!(updated.locations.len(), 2);
    let (_, selected) = log
        .select_project(&project.id, vec!["/repo".into(), "/worktree".into()], 21)
        .await
        .unwrap();
    assert_eq!(selected, "/repo");
    let renamed = log
        .mutate_project(
            &project.id,
            ProjectMutation::Rename("  Renamed  ".into()),
            22,
        )
        .await
        .unwrap();
    assert_eq!(renamed.name, "Renamed");
    let (_, fallback) = log
        .select_project(&project.id, vec!["/worktree".into()], 23)
        .await
        .unwrap();
    assert_eq!(fallback, "/worktree");
    let archived = log
        .mutate_project(&project.id, ProjectMutation::Archive, 24)
        .await
        .unwrap();
    assert_eq!(archived.archived_at, Some(24));
    assert!(matches!(
        log.select_project(&project.id, vec!["/worktree".into()], 25)
            .await,
        Err(StoreError::Project(ProjectError::Archived))
    ));
    // Registration does not silently restore an archived project or replace its name.
    let registered = log
        .register_project(registration("git:/repo/.git", "/repo", false), true, 1)
        .await
        .unwrap();
    assert_eq!(registered.archived_at, Some(24));
    assert_eq!(registered.last_used_at, 23);
    assert_eq!(registered.name, "Renamed");
    let restored = log
        .mutate_project(&project.id, ProjectMutation::Restore, 26)
        .await
        .unwrap();
    assert_eq!(restored.archived_at, None);
    assert!(matches!(
        log.touch_project(&project.id, "/unregistered", 27).await,
        Err(StoreError::Project(ProjectError::PathMismatch))
    ));
    let (stable, preferred) = log
        .select_project(&project.id, vec!["/repo".into(), "/worktree".into()], 28)
        .await
        .unwrap();
    assert_eq!(preferred, "/worktree");
    log.close().await.unwrap();
    let reopened = EventLog::open(&path).await.unwrap();
    assert_eq!(reopened.list_projects().await.unwrap(), vec![stable]);
    assert!(matches!(
        reopened
            .select_project(&project.id, vec!["/outside".into()], 29)
            .await,
        Err(StoreError::Project(ProjectError::Unavailable))
    ));
    reopened.close().await.unwrap();
}
