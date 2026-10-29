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
use crate::{
    root::{RootNamespaces, RootOwner},
    root_store::{partition_for, routes::Creation},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{collections::BTreeSet, sync::Arc};

async fn fixture() -> (tempfile::TempDir, RootStore) {
    let dir = tempfile::tempdir().unwrap();
    let owner = Arc::new(
        RootOwner::create(
            &dir.path().join("root"),
            &RootNamespaces {
                ownership: dir.path().join("owners"),
                control: dir.path().join("control"),
            },
        )
        .unwrap(),
    );
    let root = RootStore::open(owner).await.unwrap();
    (dir, root)
}
fn filter() -> CatalogFilter {
    CatalogFilter {
        archived_only: false,
        include_archived: true,
        pending_only: false,
    }
}
fn ids_for_partitions() -> Vec<String> {
    (0..PARTITION_COUNT)
        .map(|part| {
            (0..1000)
                .map(|n| format!("owner-{part}-{n:03}"))
                .find(|id| partition_for(b"session", id) == part)
                .unwrap()
        })
        .collect()
}
async fn hidden(root: &RootStore, id: &str) {
    let id = id.to_owned();
    root.control
        .connection
        .run(move |db| {
            Box::pin(async move {
                use sqlx::Connection;
                let mut tx = db.begin().await?;
                sqlx::query("UPDATE session_routes SET visible=0 WHERE session_id=?")
                    .bind(id)
                    .execute(&mut *tx)
                    .await?;
                crate::sessions::advance_catalog(&mut tx).await?;
                tx.commit().await?;
                Ok(())
            })
        })
        .await
        .unwrap();
}
fn page_ids<T>(page: &SessionPage<T>) -> Vec<String> {
    page.sessions.iter().map(|s| s.id.clone()).collect()
}

#[tokio::test]
async fn eight_partition_keyset_merge_preserves_forward_reverse_and_tail_anchor() {
    let (_dir, root) = fixture().await;
    let mut ids = ids_for_partitions();
    ids.extend((0..31).map(|n| format!("owner-extra-{n:03}")));
    ids.sort();
    assert_eq!(
        ids.iter()
            .map(|id| partition_for(b"session", id))
            .collect::<BTreeSet<_>>()
            .len(),
        8
    );
    for id in &ids {
        root.create_session(id, id, &json!({"title":id}), 1)
            .await
            .unwrap();
    }
    for (n, id) in [ids.first().unwrap(), ids.last().unwrap()]
        .into_iter()
        .enumerate()
    {
        let request=serde_json::from_value(json!({"sessionId":id,"turnId":"turn","runId":"run","requestId":format!("request-{n}"),"createdAt":2,
            "request":{"kind":"form","toolUseId":"tool","message":"Answer","requester":{"name":"Tool"},"fields":[]},"outcome":null})).unwrap();
        root.session(id)
            .await
            .unwrap()
            .establish_interaction(&request)
            .await
            .unwrap();
    }
    let first = root.list_sessions::<Value>(None, None, 5).await.unwrap();
    assert_eq!(page_ids(&first), ids[..5]);
    assert_eq!(first.pending_session_count, 2);
    assert!(first.previous_cursor.is_none());
    let encoded = first.revision.rsplit(':').next().unwrap();
    let vector: Value = serde_json::from_slice(&hex::decode(encoded).unwrap()).unwrap();
    assert_eq!(vector["partitions"].as_array().unwrap().len(), 8);
    assert!(vector["control"].as_i64().unwrap() > 0);
    let second = root
        .list_sessions::<Value>(Some(&first.revision), first.next_cursor.as_deref(), 5)
        .await
        .unwrap();
    assert_eq!(page_ids(&second), ids[5..10]);
    let previous = root
        .root_session_page::<Value>(
            CatalogScope::Profile,
            Some(&second.revision),
            SessionPosition::Before(second.previous_cursor.as_deref().unwrap()),
            5,
            filter(),
        )
        .await
        .unwrap();
    assert_eq!(page_ids(&previous), ids[..5]);
    let anchor = root
        .root_session_page::<Value>(
            CatalogScope::Profile,
            None,
            SessionPosition::At(&ids[13]),
            5,
            filter(),
        )
        .await
        .unwrap();
    assert_eq!(page_ids(&anchor), ids[13..18]);
    let tail = root
        .root_session_page::<Value>(
            CatalogScope::Profile,
            None,
            SessionPosition::At("zz-tail"),
            5,
            filter(),
        )
        .await
        .unwrap();
    assert_eq!(page_ids(&tail), ids[ids.len() - 5..]);
    assert!(tail.next_cursor.is_none());
    assert_eq!(tail.pending_session_count, 2);
    root.close().await.unwrap();
}

#[derive(Deserialize)]
struct Named {
    title: String,
}

#[tokio::test]
async fn sql_excludes_pending_hidden_orphan_and_wrong_partition_rows_before_decoding() {
    let (_dir, root) = fixture().await;
    root.create_session("visible", "visible", &json!({"title":"Visible"}), 1)
        .await
        .unwrap();
    let visible_part = partition_for(b"session", "visible");
    root.partitions[(visible_part + 1) % 8]
        .create_session("visible", "rogue", &json!({"title":13}), 1)
        .await
        .unwrap();
    root.create_session("hidden", "hidden", &json!({"title":13}), 1)
        .await
        .unwrap();
    hidden(&root, "hidden").await;
    let command = Creation::Session {
        configuration: json!({"title":13}),
        created_at: 1,
    };
    let (pending_part, _) = root
        .reserve_creation("pending", "pending", command)
        .await
        .unwrap();
    root.partitions[pending_part]
        .create_session("pending", "pending", &json!({"title":13}), 1)
        .await
        .unwrap();
    root.partitions[0]
        .create_session("orphan", "orphan", &json!({"title":13}), 1)
        .await
        .unwrap();
    let page = root
        .scoped_sessions::<Named>(
            CatalogScope::Profile,
            None,
            SessionPosition::Start,
            filter(),
        )
        .await
        .unwrap();
    assert_eq!(page_ids(&page), vec!["visible"]);
    assert_eq!(page.sessions[0].configuration.title, "Visible");
    for id in ["hidden", "pending", "orphan"] {
        assert!(root.get_session::<Named>(id).await.unwrap().is_none());
        assert!(!root.session_is_available(id).await.unwrap());
        assert!(root.observe_session::<Named>(id).await.unwrap().is_none());
    }
    let hidden_part = partition_for(b"session", "hidden");
    assert!(
        root.partitions[hidden_part]
            .root_catalog_records::<Named>(hidden_part, vec!["hidden".into()], None)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        root.get_session::<Named>("visible")
            .await
            .unwrap()
            .is_some()
    );
    assert!(
        root.session_projection::<Named>("visible")
            .await
            .unwrap()
            .is_some()
    );
    assert!(
        root.observe_session::<Named>("visible")
            .await
            .unwrap()
            .is_some()
    );
    root.close().await.unwrap();
}

#[tokio::test]
async fn revision_binds_all_data_counters_control_visibility_and_query_without_turn_control_writes()
{
    use maka_agent_facts::event::{EventWrite, Fact, Invocation, InvocationInput, RuntimeEvent};
    let (_dir, root) = fixture().await;
    let ids = ids_for_partitions();
    for id in &ids {
        root.create_session(id, id, &json!({"title":id}), 1)
            .await
            .unwrap();
    }
    for part in 0..8 {
        let page = root.list_sessions::<Value>(None, None, 1).await.unwrap();
        root.partitions[part]
            .connection
            .run(|db| Box::pin(async move { crate::sessions::advance_catalog(db).await }))
            .await
            .unwrap();
        assert!(matches!(
            root.list_sessions::<Value>(Some(&page.revision), page.next_cursor.as_deref(), 1)
                .await,
            Err(StoreError::RevisionConflict { .. })
        ));
    }
    let before = root.catalog_vector().await.unwrap();
    let session = root.session(&ids[0]).await.unwrap();
    session
        .append(
            &EventWrite::plain(RuntimeEvent::new(
                Invocation {
                    session_id: ids[0].clone(),
                    turn_id: "turn".into(),
                    run_id: "run".into(),
                    invocation_id: "invocation".into(),
                },
                Fact::InvocationOpened {
                    configuration: None,
                    input: InvocationInput::Message {
                        content: "message".into(),
                        source_messages: Vec::new(),
                        request_fingerprint: None,
                    },
                },
            ))
            .unwrap(),
        )
        .await
        .unwrap();
    let after = root.catalog_vector().await.unwrap();
    assert_eq!(before.control, after.control);
    assert_ne!(before.partitions, after.partitions);
    let page = root.list_sessions::<Value>(None, None, 1).await.unwrap();
    hidden(&root, &ids[7]).await;
    assert!(matches!(
        root.list_sessions::<Value>(Some(&page.revision), page.next_cursor.as_deref(), 1)
            .await,
        Err(StoreError::RevisionConflict { .. })
    ));
    let page = root.list_sessions::<Value>(None, None, 1).await.unwrap();
    assert!(matches!(
        root.scoped_sessions::<Value>(
            CatalogScope::IdPrefix("owner-0".into()),
            Some(&page.revision),
            SessionPosition::After(&page.sessions[0].id),
            filter()
        )
        .await,
        Err(StoreError::RevisionConflict { .. })
    ));
    root.close().await.unwrap();
}

#[tokio::test]
async fn imports_pending_messages_and_workspace_fence_merge_only_published_routes() {
    let (_dir, root) = fixture().await;
    let binding = root
        .attach_workspace("owner", &json!({"path":"/workspace","identity":"identity"}))
        .await
        .unwrap();
    let ids = ids_for_partitions();
    for (index, id) in ids.iter().enumerate() {
        root.create_session(
            id,
            id,
            &json!({"title":id,"workspace":binding,"boundary_revision":0}),
            1,
        )
        .await
        .unwrap();
        let id = id.clone();
        root.partitions[index]
            .connection
            .run(move |db| {
                Box::pin(async move {
                    sqlx::query(
                        "INSERT INTO session_imports VALUES(?,'{}','{}',?,'published',1,1,1)",
                    )
                    .bind(&id)
                    .bind(index as i64)
                    .execute(&mut *db)
                    .await?;
                    sqlx::query("INSERT INTO message_admissions VALUES(?,'message',0,?)")
                        .bind(id)
                        .bind(json!({"execution":{"owner":"owner"}}).to_string())
                        .execute(db)
                        .await?;
                    Ok(())
                })
            })
            .await
            .unwrap();
    }
    hidden(&root, &ids[7]).await;
    let (imports, next) = root
        .imported_sessions::<Value>("owner-", None, 3)
        .await
        .unwrap();
    assert_eq!(
        imports.iter().map(|r| r.id.clone()).collect::<Vec<_>>(),
        vec![ids[6].clone(), ids[5].clone(), ids[4].clone()]
    );
    assert_eq!(next.as_deref(), Some(ids[4].as_str()));
    let (imports, next) = root
        .imported_sessions::<Value>("owner-", next.as_deref(), 3)
        .await
        .unwrap();
    assert_eq!(
        imports.iter().map(|r| r.id.clone()).collect::<Vec<_>>(),
        vec![ids[3].clone(), ids[2].clone(), ids[1].clone()]
    );
    assert_eq!(next.as_deref(), Some(ids[1].as_str()));
    let mut expected = ids[..7].to_vec();
    expected.sort();
    assert_eq!(
        root.pending_message_sessions("owner", None).await.unwrap(),
        expected
    );
    assert!(
        root.pending_message_sessions("different", None)
            .await
            .unwrap()
            .is_empty()
    );
    let fence = root.workspace_fence("/workspace").await.unwrap();
    assert_eq!(
        fence
            .0
            .iter()
            .map(|r| r.session_id.clone())
            .collect::<Vec<_>>(),
        expected
    );
    assert!(
        root.workspace_has_other_session("/workspace", &ids[0])
            .await
            .unwrap()
    );
    assert!(
        !root
            .workspace_has_other_session("/missing", &ids[0])
            .await
            .unwrap()
    );
    root.close().await.unwrap();
}

#[tokio::test]
async fn shared_binding_relocation_invalidates_vector_without_touching_partition_counters() {
    use crate::projects::ProjectRegistration;
    let (_dir, root) = fixture().await;
    let registration = |identity: &str, path: &str| ProjectRegistration {
        identity: identity.into(),
        path: path.into(),
        name: "Repository".into(),
        is_worktree: false,
    };
    let project = root
        .register_project(registration("old-identity", "/old"), true, 1)
        .await
        .unwrap();
    let binding = root
        .attach_workspace(
            "owner",
            &json!({"path":"/old","projectId":project.id,"identity":"identity"}),
        )
        .await
        .unwrap();
    let ids = ids_for_partitions();
    for id in &ids {
        root.create_session(
            id,
            id,
            &json!({"title":id,"workspace":binding,"boundary_revision":0}),
            1,
        )
        .await
        .unwrap();
    }
    let first = root.list_sessions::<Value>(None, None, 2).await.unwrap();
    let before = root.catalog_vector().await.unwrap();
    let relocation = root
        .relink_project(
            &project.id,
            "owner",
            registration("new-identity", "/new"),
            2,
            json!({"path":"/new","identity":"new-identity"}),
        )
        .await
        .unwrap();
    assert_eq!(relocation.updated_bindings, 1);
    let after = root.catalog_vector().await.unwrap();
    assert_eq!(before.partitions, after.partitions);
    assert_ne!(before.control, after.control);
    assert!(matches!(
        root.list_sessions::<Value>(Some(&first.revision), first.next_cursor.as_deref(), 2)
            .await,
        Err(StoreError::RevisionConflict { .. })
    ));
    let old = root
        .scoped_sessions::<Value>(
            CatalogScope::Workspace("/old".into()),
            None,
            SessionPosition::Start,
            filter(),
        )
        .await
        .unwrap();
    assert!(old.sessions.is_empty());
    let relocated = root
        .scoped_sessions::<Value>(
            CatalogScope::Workspace("/new".into()),
            None,
            SessionPosition::Start,
            filter(),
        )
        .await
        .unwrap();
    assert_eq!(relocated.sessions.len(), 8);
    for record in relocated.sessions {
        assert_eq!(
            record.configuration["workspace"],
            serde_json::to_value(binding).unwrap()
        );
        assert_eq!(record.revision, 2);
        assert_eq!(record.workspace_binding.unwrap().workspace["path"], "/new");
    }
    assert_eq!(root.workspace_fence("/new").await.unwrap().0.len(), 8);
    root.close().await.unwrap();
}

#[tokio::test]
async fn pinned_sessions_lead_cross_partition_pages_and_unpin_invalidates_cursors() {
    let (_dir, root) = fixture().await;
    let mut ids = ids_for_partitions();
    ids.extend((0..65).map(|n| format!("owner-extra-{n:03}")));
    ids.sort();
    for id in &ids {
        root.create_session(id, id, &json!({"title":id}), 1)
            .await
            .unwrap();
    }
    let last = ids.last().unwrap();
    let old = root.list_sessions::<Value>(None, None, 5).await.unwrap();
    let record = root.get_session::<Value>(last).await.unwrap().unwrap();
    root.update_session_metadata(last, record.revision, |value: &mut Value| {
        value["pinned"] = json!(true);
        Ok(())
    })
    .await
    .unwrap();
    let stale = root
        .list_sessions::<Value>(Some(&old.revision), old.next_cursor.as_deref(), 5)
        .await;
    assert!(matches!(stale, Err(StoreError::RevisionConflict { .. })));
    let mut expected = vec![last.clone()];
    expected.extend(ids[..ids.len() - 1].iter().cloned());
    let first = root.list_sessions::<Value>(None, None, 5).await.unwrap();
    assert_eq!(page_ids(&first), expected[..5]);
    let second = root
        .list_sessions::<Value>(Some(&first.revision), first.next_cursor.as_deref(), 5)
        .await
        .unwrap();
    let previous = root
        .root_session_page::<Value>(
            CatalogScope::Profile,
            Some(&second.revision),
            SessionPosition::Before(second.previous_cursor.as_deref().unwrap()),
            5,
            filter(),
        )
        .await
        .unwrap();
    assert_eq!(page_ids(&previous), expected[..5]);
    let mut all = page_ids(&first);
    let mut cursor = first.next_cursor;
    while let Some(after) = cursor {
        let page = root
            .list_sessions::<Value>(Some(&first.revision), Some(&after), 5)
            .await
            .unwrap();
        all.extend(page_ids(&page));
        cursor = page.next_cursor;
    }
    assert_eq!(all, expected);
    let anchor = root
        .root_session_page::<Value>(
            CatalogScope::Profile,
            None,
            SessionPosition::At(last),
            5,
            filter(),
        )
        .await
        .unwrap();
    assert_eq!(page_ids(&anchor), expected[..5]);
    let record = root.get_session::<Value>(last).await.unwrap().unwrap();
    root.update_session_metadata(last, record.revision, |value: &mut Value| {
        value["pinned"] = json!(false);
        Ok(())
    })
    .await
    .unwrap();
    assert_eq!(
        page_ids(&root.list_sessions::<Value>(None, None, 5).await.unwrap()),
        ids[..5]
    );
    root.close().await.unwrap();
}
