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
use crate::root::{RootNamespaces, RootOwner};
use serde_json::{Value, json};
use std::sync::Arc;

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
    let root = RootStore::open(owner, crate::ROOT_MIGRATIONS)
        .await
        .unwrap();
    (dir, root)
}
fn filter() -> CatalogFilter {
    CatalogFilter {
        roots_only: false,
        archived_only: false,
        include_archived: true,
    }
}
fn session_ids() -> Vec<String> {
    (0..8).map(|index| format!("owner-{index}-001")).collect()
}
async fn hidden(root: &RootStore, id: &str) {
    let id = id.to_owned();
    root.log
        .connection
        .run(move |db| {
            let tx =
                rusqlite::Transaction::new_unchecked(db, rusqlite::TransactionBehavior::Deferred)?;
            tx.execute(
                "UPDATE session_creations SET visible=0 WHERE session_id=?",
                rusqlite::params![id],
            )?;
            crate::sessions::advance_catalog(&tx)?;
            tx.commit()?;
            Ok(())
        })
        .await
        .unwrap();
}
fn page_ids<T>(page: &SessionPage<T>) -> Vec<String> {
    page.sessions.iter().map(|s| s.id.clone()).collect()
}

#[tokio::test]
async fn keyset_paging_preserves_forward_reverse_and_resets_missing_anchor() {
    let (_dir, root) = fixture().await;
    let mut ids = session_ids();
    ids.extend((0..31).map(|n| format!("owner-extra-{n:03}")));
    ids.sort();
    for id in &ids {
        root.create_session(id, id, &json!({"title":id}), 1)
            .await
            .unwrap();
    }
    let first = root.list_sessions::<Value>(None, None, 5).await.unwrap();
    assert_eq!(page_ids(&first), ids[..5]);
    assert!(first.previous_cursor.is_none());
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
    let missing = root
        .root_session_page::<Value>(
            CatalogScope::Profile,
            None,
            SessionPosition::At("missing"),
            5,
            filter(),
        )
        .await
        .unwrap();
    assert_eq!(page_ids(&missing), ids[..5]);
    assert!(missing.previous_cursor.is_none());
    root.close().await.unwrap();
}

#[tokio::test]
async fn revision_binds_root_counter_metadata_visibility_and_query() {
    let (_dir, root) = fixture().await;
    let ids = session_ids();
    for id in &ids {
        root.create_session(id, id, &json!({"title":id}), 1)
            .await
            .unwrap();
    }
    let page = root.list_sessions::<Value>(None, None, 1).await.unwrap();
    root.log
        .connection
        .run(|db| crate::sessions::advance_catalog(db))
        .await
        .unwrap();
    assert!(matches!(
        root.list_sessions::<Value>(Some(&page.revision), page.next_cursor.as_deref(), 1)
            .await,
        Err(StoreError::RevisionConflict { .. })
    ));

    let before = root.catalog_version().await.unwrap();
    let record = root.get_session::<Value>(&ids[0]).await.unwrap().unwrap();
    root.update_session_metadata(&ids[0], record.revision, |value: &mut Value| {
        value["title"] = json!("updated canonical Root metadata");
        Ok(())
    })
    .await
    .unwrap();
    let after = root.catalog_version().await.unwrap();
    assert_ne!(before.revision, after.revision);
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
async fn pinned_sessions_lead_cross_session_pages_and_unpin_invalidates_cursors() {
    let (_dir, root) = fixture().await;
    let mut ids = session_ids();
    ids.extend((0..65).map(|n| format!("owner-extra-{n:03}")));
    ids.sort();
    for (n, id) in ids.iter().enumerate() {
        root.create_session(id, id, &json!({"title":id}), (n / 2 + 1) as u64)
            .await
            .unwrap();
    }
    let recent = ids.chunks(2).rev().flatten().cloned().collect::<Vec<_>>();
    let pinned = ids.first().unwrap();
    let old = root.list_sessions::<Value>(None, None, 5).await.unwrap();
    let record = root.get_session::<Value>(pinned).await.unwrap().unwrap();
    root.update_session_metadata(pinned, record.revision, |value: &mut Value| {
        value["pinned"] = json!(true);
        Ok(())
    })
    .await
    .unwrap();
    let stale = root
        .list_sessions::<Value>(Some(&old.revision), old.next_cursor.as_deref(), 5)
        .await;
    assert!(matches!(stale, Err(StoreError::RevisionConflict { .. })));
    let mut expected = vec![pinned.clone()];
    expected.extend(recent.iter().filter(|id| *id != pinned).cloned());
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
            SessionPosition::At(pinned),
            5,
            filter(),
        )
        .await
        .unwrap();
    assert_eq!(page_ids(&anchor), expected[..5]);
    let record = root.get_session::<Value>(pinned).await.unwrap().unwrap();
    root.update_session_metadata(pinned, record.revision, |value: &mut Value| {
        value["pinned"] = json!(false);
        Ok(())
    })
    .await
    .unwrap();
    assert_eq!(
        page_ids(&root.list_sessions::<Value>(None, None, 5).await.unwrap()),
        recent[..5]
    );
    assert!(
        matches!(
            root.list_sessions::<Value>(Some(&anchor.revision), Some(pinned), 5)
                .await,
            Err(StoreError::RevisionConflict { .. })
        ),
        "unpinning invalidates the original pinned catalog snapshot"
    );
    root.close().await.unwrap();
}

#[tokio::test]
async fn root_sidebar_filters_owned_visible_roots_and_archived_children() {
    use crate::sessions::CatalogSelection;
    let (_dir, root) = fixture().await;
    for (id, parent, archived) in [
        ("owned_root", None, false),
        ("owned_child", Some("owned_root"), false),
        ("owned_archived", Some("owned_root"), true),
        ("owned_hidden", Some("owned_root"), false),
        ("foreign_child", Some("owned_root"), false),
    ] {
        root.create_session(id, id, &json!({"title":id,"parentSessionId":parent}), 1)
            .await
            .unwrap();
        if archived {
            root.session(id)
                .await
                .unwrap()
                .change_session_archived::<Value>(id, None, true, 3)
                .await
                .unwrap();
        }
    }
    hidden(&root, "owned_hidden").await;
    let scope = |title_query: &str| CatalogScope::Owned {
        id_prefix: "owned_".into(),
        selection: CatalogSelection::All,
        title_query: title_query.into(),
    };
    let sidebar = CatalogFilter {
        roots_only: true,
        include_archived: false,
        ..filter()
    };
    let page = root
        .scoped_sessions::<Value>(scope(""), None, SessionPosition::Start, sidebar)
        .await
        .unwrap();
    assert_eq!(page_ids(&page), ["owned_root"]);
    let children_and_roots = CatalogFilter {
        roots_only: false,
        ..sidebar
    };
    let page = root
        .scoped_sessions::<Value>(scope(""), None, SessionPosition::Start, children_and_roots)
        .await
        .unwrap();
    assert_eq!(page_ids(&page), ["owned_child", "owned_root"]);
    for (title, expected) in [
        ("owned_root", vec!["owned_root"]),
        ("owned_child", vec![]),
        ("missing", vec![]),
    ] {
        let page = root
            .scoped_sessions::<Value>(scope(title), None, SessionPosition::Start, sidebar)
            .await
            .unwrap();
        assert_eq!(page_ids(&page), expected);
    }
    let archived = CatalogFilter {
        roots_only: false,
        include_archived: true,
        archived_only: true,
    };
    let page = root
        .scoped_sessions::<Value>(scope(""), None, SessionPosition::Start, archived)
        .await
        .unwrap();
    assert_eq!(page_ids(&page), ["owned_archived"]);
    root.close().await.unwrap();
}

#[tokio::test]
async fn child_pages_sessions_and_keep_archived_parents_traversable() {
    use crate::sessions::CatalogSelection;
    let (_dir, root) = fixture().await;
    for (id, parent, archived) in [
        ("owned_root", None, false),
        ("owned_child_a", Some("owned_root"), false),
        ("owned_child_b", Some("owned_root"), true),
        ("owned_child_c", Some("owned_root"), false),
        ("owned_grandchild", Some("owned_child_b"), false),
        ("owned_unrelated", None, false),
        ("foreign_child", Some("owned_root"), false),
    ] {
        root.create_session(id, id, &json!({"title":id,"parentSessionId":parent}), 1)
            .await
            .unwrap();
        if archived {
            root.session(id)
                .await
                .unwrap()
                .change_session_archived::<Value>(id, None, true, 2)
                .await
                .unwrap();
        }
    }
    let scope = |parent: &str| CatalogScope::Owned {
        id_prefix: "owned_".into(),
        selection: CatalogSelection::Children(parent.into()),
        title_query: String::new(),
    };
    let first = root
        .root_session_page::<Value>(
            scope("owned_root"),
            None,
            SessionPosition::Start,
            2,
            filter(),
        )
        .await
        .unwrap();
    assert_eq!(page_ids(&first), ["owned_child_a", "owned_child_b"]);
    let next = root
        .root_session_page::<Value>(
            scope("owned_root"),
            Some(&first.revision),
            SessionPosition::After(first.next_cursor.as_deref().unwrap()),
            2,
            filter(),
        )
        .await
        .unwrap();
    assert_eq!(page_ids(&next), ["owned_child_c"]);
    let grandchild = root
        .root_session_page::<Value>(
            scope("owned_child_b"),
            None,
            SessionPosition::Start,
            2,
            filter(),
        )
        .await
        .unwrap();
    assert_eq!(page_ids(&grandchild), ["owned_grandchild"]);
    root.drain().await;
}
