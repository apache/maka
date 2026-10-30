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
use std::path::Path;

pub(super) async fn preferences(path: &Path) -> preferences::Store {
    preferences::Store::new(
        Arc::new(
            maka_event_log::RootStore::open(Arc::new(
                maka_event_log::root::RootOwner::create(
                    &path.join(format!("preferences-{}", uuid::Uuid::new_v4())),
                    &maka_event_log::root::RootNamespaces {
                        ownership: path.join("owners"),
                        control: path.join("control"),
                    },
                )
                .unwrap(),
            ))
            .await
            .unwrap(),
        ),
        "test_".into(),
    )
}
pub(super) fn scope() -> Scope {
    maka_capabilities::call::Issuer::default()
        .issue(
            maka_capabilities::call::Identity::Remote {
                request_id: uuid::Uuid::new_v4(),
            },
            tokio_util::sync::CancellationToken::new(),
        )
        .unwrap()
}
pub(super) fn write(root: &Path, id: &str, body: &str) {
    std::fs::create_dir_all(root.join(id)).unwrap();
    std::fs::write(
        root.join(id).join("SKILL.md"),
        format!("---\nname: {id}\ndescription: Reference for {id}\n---\n{body}"),
    )
    .unwrap();
}
pub(super) fn source(id: &str, path: &Path) -> Source {
    Source {
        id: id.into(),
        label: id.into(),
        path: path.to_str().unwrap().into(),
    }
}
fn first() -> List {
    List {
        workspace: None,
        query: String::new(),
        cursor: None,
    }
}

#[tokio::test]
async fn original_discovery_paging_and_exact_body_reads_reject_stale_or_repurposed_cursors() {
    let dir = tempfile::tempdir().unwrap();
    let a = dir.path().join("a");
    let b = dir.path().join("b");
    let body = "本地 skill 说明 🦀\n".repeat(2000);
    for i in 0..40 {
        write(
            &a,
            &format!("skill-{i:02}"),
            if i == 0 { &body } else { "original" },
        );
    }
    write(&b, "skill-00", "shadowed");
    std::fs::create_dir_all(b.join("broken")).unwrap();
    std::fs::write(b.join("broken/SKILL.md"), "missing frontmatter").unwrap();
    let library = Library::open(
        Configuration {
            home: None,
            project_roots: vec![],
            bundled: false,
            manage: false,
            preferences: true,
            sources: vec![source("a", &a), source("b", &b)],
        },
        dir.path().join("private"),
        preferences(dir.path()).await,
    )
    .unwrap();
    let call = scope();
    let Page::Page {
        revision,
        entries,
        after,
        ..
    } = library
        .snapshot(&call)
        .await
        .unwrap()
        .list(first())
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(entries.len(), 32);
    let cursor = after.unwrap();
    assert!(
        library
            .snapshot(&call)
            .await
            .unwrap()
            .list(List {
                workspace: None,
                query: "other".into(),
                cursor: Some(cursor.clone())
            })
            .is_err()
    );
    let Page::Page {
        entries: remaining,
        after,
        ..
    } = library
        .snapshot(&call)
        .await
        .unwrap()
        .list(List {
            workspace: None,
            query: String::new(),
            cursor: Some(cursor),
        })
        .unwrap()
    else {
        panic!()
    };
    assert!(after.is_none());
    assert_eq!(entries.len() + remaining.len(), 42);
    assert_eq!(
        remaining
            .iter()
            .find(|entry| entry.reference == "source:b:skill-00")
            .unwrap()
            .shadowed_by
            .as_deref(),
        Some("source:a:skill-00")
    );
    assert!(
        !remaining
            .iter()
            .find(|entry| entry.reference == "source:b:broken")
            .unwrap()
            .valid
    );
    let mut text = String::new();
    let mut offset = 0;
    loop {
        let Document::Page {
            text: page,
            after,
            total_bytes,
            ..
        } = library
            .snapshot(&call)
            .await
            .unwrap()
            .read(Read {
                workspace: None,
                reference: "source:a:skill-00".into(),
                revision: revision.clone(),
                offset,
            })
            .unwrap()
        else {
            panic!()
        };
        assert!(page.len() <= TEXT_BYTES);
        assert_eq!(total_bytes, body.trim().len());
        text.push_str(&page);
        let Some(next) = after else {
            break;
        };
        assert!(next > offset);
        offset = next;
    }
    assert_eq!(text, body.trim());
    write(&a, "skill-00", "updated");
    assert!(matches!(
        library
            .snapshot(&call)
            .await
            .unwrap()
            .read(Read {
                workspace: None,
                reference: "source:a:skill-00".into(),
                revision,
                offset: 0
            })
            .unwrap(),
        Document::Changed
    ));
    call.finish().await.unwrap();
    assert!(library.snapshot(&call).await.is_err());
}

#[tokio::test]
async fn canonical_private_root_policy_allows_selected_skills_and_denies_private_skills() {
    let dir = tempfile::tempdir().unwrap();
    let selected = dir.path().join("selected");
    let private = dir.path().join("private");
    write(&selected, "allowed", "selected content");
    write(&private, "hidden", "private content");
    let library = Library::open(
        Configuration {
            home: None,
            project_roots: vec![],
            bundled: false,
            manage: false,
            preferences: true,
            sources: vec![source("selected", &selected), source("private", &private)],
        },
        private.canonicalize().unwrap(),
        preferences(dir.path()).await,
    )
    .unwrap();
    let call = scope();
    let Page::Page {
        revision,
        entries,
        diagnostics,
        ..
    } = library
        .snapshot(&call)
        .await
        .unwrap()
        .list(first())
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].reference, "source:selected:allowed");
    assert!(
        diagnostics
            .iter()
            .any(|message| message.starts_with("private:"))
    );
    let Document::Page { text, .. } = library
        .snapshot(&call)
        .await
        .unwrap()
        .read(Read {
            workspace: None,
            reference: entries[0].reference.clone(),
            revision: revision.clone(),
            offset: 0,
        })
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(text, "selected content");
    assert!(matches!(
        library
            .snapshot(&call)
            .await
            .unwrap()
            .read(Read {
                workspace: None,
                reference: "source:private:hidden".into(),
                revision,
                offset: 0,
            })
            .unwrap(),
        Document::Unavailable
    ));
    call.finish().await.unwrap();
}

#[tokio::test]
async fn execution_basis_preserves_real_captures_and_rejects_replaced_skill_directories() {
    use maka_event_log::{
        RootStore,
        root::{RootNamespaces, RootOwner},
    };
    let temporary = tempfile::tempdir().unwrap();
    let path = temporary.path();
    let root = Arc::new(
        RootOwner::create(
            &path.join("private"),
            &RootNamespaces {
                ownership: path.join("owners"),
                control: path.join("control"),
            },
        )
        .unwrap(),
    );
    let store = Arc::new(RootStore::open(root.clone()).await.unwrap());
    for name in ["home", "projects", "custom"] {
        std::fs::create_dir(path.join(name)).unwrap();
    }
    let config = || Configuration {
        home: Some(path.join("home").to_str().unwrap().into()),
        project_roots: vec![maka_host_runtime::DirectoryRootSpec {
            label: "Projects".into(),
            path: path.join("projects"),
        }],
        bundled: true,
        manage: true,
        preferences: true,
        sources: vec![source("custom", &path.join("custom"))],
    };
    let open = || {
        Library::open(
            config(),
            root.canonical_path().to_owned(),
            preferences::Store::new(store.clone(), "stable/".into()),
        )
        .unwrap()
    };
    let mut first = open();
    first.managed = Some(
        management::Managed::open(root.clone(), "stable".into())
            .await
            .unwrap(),
    );
    let basis = first.execution_basis().unwrap();
    let mut same = open();
    same.managed = Some(
        management::Managed::open(root.clone(), "stable".into())
            .await
            .unwrap(),
    );
    assert_eq!(same.execution_basis().unwrap(), basis);
    write(
        &path.join("custom"),
        "mutable",
        "live contents do not change the target",
    );
    assert_eq!(first.execution_basis().unwrap(), basis);
    let mut other_namespace = first.clone();
    other_namespace.preferences = preferences::Store::new(store.clone(), "other/".into());
    assert_ne!(other_namespace.execution_basis().unwrap(), basis);
    let mut other_managed = first.clone();
    other_managed.managed = Some(
        management::Managed::open(root.clone(), "other".into())
            .await
            .unwrap(),
    );
    assert_ne!(other_managed.execution_basis().unwrap(), basis);
    for name in ["custom", "home", "projects"] {
        if let Err(error) = std::fs::rename(path.join(name), path.join(format!("original-{name}")))
        {
            assert!(cfg!(windows) && error.raw_os_error() == Some(32), "{error}");
            assert_eq!(first.execution_basis().unwrap(), basis, "held {name}");
            continue;
        }
        std::fs::create_dir(path.join(name)).unwrap();
        let mut changed = open();
        changed.managed = first.managed.clone();
        assert_ne!(changed.execution_basis().unwrap(), basis, "{name}");
        assert_eq!(first.execution_basis().unwrap(), basis, "held {name}");
        std::fs::remove_dir(path.join(name)).unwrap();
        std::fs::rename(path.join(format!("original-{name}")), path.join(name)).unwrap();
    }
    store.shutdown().await.unwrap();
}
