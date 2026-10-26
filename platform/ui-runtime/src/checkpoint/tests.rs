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
use crate::editor::{EditorTextRef, TextRange};
use maka_event_log::root::{RootNamespaces, RootOwner};
use maka_packages::MANIFEST_FILE;
use maka_packages::Package;
use maka_plugin_core::deployment::DeploymentRef;
use maka_plugin_core::{
    composition::{
        Configuration, Environment, ExecutionLocation, Input, Node, PackageUse, PresentationTarget,
    },
    package::{Declaration, EntryDeclaration, EntryTarget, Implementation},
};
use serde_json::json;
use std::{collections::BTreeMap, time::Duration};
use uuid::Uuid;

async fn store() -> (tempfile::TempDir, Arc<RootStore>) {
    let dir = tempfile::tempdir().unwrap();
    let root =
        Arc::new(RootOwner::create(&dir.path().join("root"), &namespaces(dir.path())).unwrap());
    let store = Arc::new(RootStore::open(root).await.unwrap());
    (dir, store)
}
fn namespaces(dir: &std::path::Path) -> RootNamespaces {
    RootNamespaces {
        ownership: dir.join("owners"),
        control: dir.join("control"),
    }
}
// Hold the real data writers, without depending on private deployment routing.
fn block_data_writers(dir: &std::path::Path) -> Vec<rusqlite::Connection> {
    std::fs::read_dir(dir.join("root/runtime-partitions"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "sqlite"))
        .map(|path| {
            let connection = rusqlite::Connection::open(path).unwrap();
            connection.execute_batch("BEGIN IMMEDIATE").unwrap();
            connection
        })
        .collect()
}
fn policy() -> EditorPersistence {
    EditorPersistence {
        key: "conversation".into(),
        format: "test@1".into(),
        data_source: json!({"host":"original"}),
        metadata: json!({"attachments":["artifact"]}),
        restore: None,
        retry: 0,
    }
}
async fn scope(store: &Arc<RootStore>, source: &DeploymentRef) -> Scope {
    Scope {
        store: Arc::downgrade(store),
        source: store
            .load_application_at(source)
            .await
            .unwrap()
            .unwrap()
            .snapshot(),
        instance: instance(),
        scheduler: tokio::runtime::Handle::current(),
    }
}
fn snapshot(owner: &str, revision: u64, text: &str) -> EditorSnapshot {
    EditorSnapshot {
        text: EditorTextRef {
            owner: owner.into(),
            revision,
            bytes: text.len(),
        },
        selection: TextRange { start: 1, end: 6 },
        reversed: true,
        marked: None,
    }
}
async fn until(
    editor: &mut EditorCheckpoint,
    policy: &EditorPersistence,
    check: impl Fn(&EditorCheckpoint) -> bool,
) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            editor.poll(policy);
            if check(editor) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .unwrap();
}
async fn source(store: &RootStore, deployment: Uuid, expected: u64) -> DeploymentRef {
    let package = Package::new(BTreeMap::from([(MANIFEST_FILE.into(),serde_json::to_vec(&json!({"schemaVersion":1,"id":"ui.checkpoint","application":Declaration {entries:BTreeMap::from([(EntryTarget::Tui,EntryDeclaration {scene:None,implementation:Implementation::Native {implementation:"test.checkpoint".into()},configuration:json!({"type":"object"}).into(),imports:BTreeMap::new(),exports:BTreeMap::new()})]),composition:None}})).unwrap())])).unwrap();
    store
        .commit_application(
            deployment,
            expected,
            Input {
                environment: Environment {
                    location: ExecutionLocation::Ui,
                    presentation: Some(PresentationTarget::Tui),
                },
                instances: BTreeMap::from([(
                    "editor".into(),
                    Node {
                        key: Uuid::from_u128(42),
                        package: package.application_ref().into(),
                        use_package: PackageUse::Entry,
                        configuration: Configuration::default(),
                        parameters: Configuration::default(),
                        bindings: BTreeMap::new(),
                        disabled: false,
                        overrides: vec![],
                    },
                )]),
                recovery: None,
                launch: None,
            },
            vec![],
            vec![package],
        )
        .await
        .unwrap()
}
fn instance() -> InstanceId {
    InstanceId(vec![Uuid::from_u128(42)])
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn final_coalesced_snapshot_flushes_before_cleanup_and_restores_after_root_reopen() {
    let (dir, store) = store().await;
    let source = source(&store, Uuid::new_v4(), 0).await;
    let policy = policy();
    let resources = Arc::new(Resources::default());
    let budget = NativeBudget::default();
    let recipe_scope = scope(&store, &source).await;
    let mut editor = EditorCheckpoint::new(
        Some(recipe_scope.clone()),
        &policy,
        &resources,
        budget.clone(),
    );
    assert!(!editor.accepts_input());
    until(&mut editor, &policy, EditorCheckpoint::writable).await;
    assert!(
        !editor.accepts_input(),
        "new lineage must be committed before input"
    );
    let text = "甲👩‍💻z";
    editor.save(&snapshot("old-owner", 1, text), text, &policy.metadata);
    until(&mut editor, &policy, EditorCheckpoint::accepts_input).await;
    let blocker = block_data_writers(dir.path());
    let final_body = format!(
        "{text}100\n{}FINAL COMPLETE DRAFT",
        "保留中文😀 draft bytes.\n".repeat(50_000)
    );
    assert!(final_body.len() > 1024 * 1024);
    for revision in 2..=100 {
        let body = if revision == 100 {
            final_body.clone()
        } else {
            format!("{text}{revision}")
        };
        editor.save(
            &snapshot("old-owner", revision, &body),
            &body,
            &policy.metadata,
        );
    }
    editor.close();
    assert!(
        !resources.seal().unwrap(),
        "close must retain the actual pending writer"
    );
    drop(editor);
    let retained = Arc::downgrade(&store);
    drop(store);
    assert!(retained.upgrade().is_some(), "worker retains original Root");
    assert!(RootOwner::open(&dir.path().join("root"), &namespaces(dir.path())).is_err());
    for connection in &blocker {
        connection.execute_batch("COMMIT").unwrap();
    }
    drop(blocker);
    resources.finish().await.unwrap();
    assert_eq!(budget.usage(), (0, 0, 0));
    // RootStore drop starts asynchronous SQL shutdown. Reacquire the actual lease
    // to prove that its independent connection owner has finished releasing it.
    let root = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match RootOwner::open(&dir.path().join("root"), &namespaces(dir.path())) {
                Ok(root) => break Arc::new(root),
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    tokio::task::yield_now().await;
                }
                Err(error) => panic!("reopen original Root after checkpoint cleanup: {error}"),
            }
        }
    })
    .await
    .unwrap();
    assert!(retained.upgrade().is_none());
    let store = Arc::new(RootStore::open(root).await.unwrap());
    assert!(
        recipe_scope.open(&store).is_err(),
        "old evidence cannot cross a Root lease reopen"
    );
    let resources = Arc::new(Resources::default());
    let mut editor = EditorCheckpoint::new(
        Some(scope(&store, &source).await),
        &policy,
        &resources,
        budget.clone(),
    );
    until(&mut editor, &policy, |e| {
        matches!(e.phase, Phase::Restore(_))
    })
    .await;
    let Phase::Restore(loaded) = &editor.phase else {
        unreachable!()
    };
    assert!(
        loaded.text.as_bytes() == final_body.as_bytes(),
        "reopened checkpoint differs: got {} bytes, expected {}",
        loaded.text.len(),
        final_body.len()
    );
    assert_eq!(loaded.saved.metadata, policy.metadata);
    assert_eq!(loaded.saved.snapshot.text.revision, 100);
    assert_eq!(
        selection_bytes(&loaded.text, Some(&loaded.saved.snapshot)),
        Some((14, 3))
    );
    let mut policy = policy;
    policy.restore = Some(EditorRestoration {
        owner: "new-owner".into(),
        version: loaded.version,
        clear_text: false,
    });
    assert!(editor.restoration("other-owner", &policy).is_none());
    assert!(
        editor
            .restoration("new-owner", &policy)
            .unwrap()
            .text()
            .as_bytes()
            == final_body.as_bytes(),
        "restoration must retain every original draft byte"
    );
    editor.restored();
    assert!(!editor.accepts_input());
    editor.save(
        &snapshot("new-owner", 1, &final_body),
        &final_body,
        &policy.metadata,
    );
    until(&mut editor, &policy, EditorCheckpoint::accepts_input).await;
    editor.close();
    drop(editor);
    resources.finish().await.unwrap();
    let (saved, ()) = store
        .ui_checkpoints(&source, &instance())
        .await
        .unwrap()
        .read(&policy.key, |_| Ok(()))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(saved.metadata["snapshot"]["text"]["owner"], "new-owner");
    assert!(
        saved.content.as_slice() == final_body.as_bytes(),
        "new owner must persist the complete restored draft"
    );
    assert_eq!(budget.usage(), (0, 0, 0));
    store.shutdown().await.unwrap();
}

#[tokio::test]
async fn checkpoint_load_admits_actual_content_and_preserves_records_when_budget_is_exhausted() {
    let (_dir, store) = store().await;
    let source = source(&store, Uuid::new_v4(), 0).await;
    let mut policy = policy();
    policy.metadata = json!({"complete": "保留 metadata ".repeat(3000)});
    policy.data_source = json!({"original": "source".repeat(1000)});
    let checkpoints = store.ui_checkpoints(&source, &instance()).await.unwrap();
    let large = format!("甲👩‍💻z{}COMPLETE END", "保留中文😀。\n".repeat(70_000));
    assert!(large.len() > 1024 * 1024);
    let mut version = None;
    for (body, fits) in [("甲👩‍💻z", true), (large.as_str(), false)] {
        let saved = Saved {
            snapshot: snapshot("stored-owner", 1, body),
            metadata: policy.metadata.clone(),
        };
        version = Some(
            checkpoints
                .write(
                    &policy.key,
                    version,
                    &policy.stored_format(),
                    &policy.data_source,
                    &serde_json::to_value(&saved).unwrap(),
                    body.as_bytes().to_vec(),
                )
                .await
                .unwrap(),
        );
        let resources = Arc::new(Resources::default());
        let budget = NativeBudget::new(crate::budget::BudgetLimits {
            encoded_bytes: 128 * 1024,
            ..Default::default()
        });
        let mut editor = EditorCheckpoint::new(
            Some(scope(&store, &source).await),
            &policy,
            &resources,
            budget.clone(),
        );
        until(&mut editor, &policy, |e| !matches!(e.phase, Phase::Loading)).await;
        let loaded = match &editor.phase {
            Phase::Restore(value) => {
                Some((value.text.as_bytes() == body.as_bytes(), value.version))
            }
            _ => None,
        };
        let failed = match &editor.phase {
            Phase::Failed {
                writing,
                diagnostic,
            } => Some((*writing, diagnostic.clone())),
            _ => None,
        };
        let retained_bytes = budget.usage().0;
        editor.close();
        drop(editor);
        resources.finish().await.unwrap();
        assert_eq!(budget.usage(), (0, 0, 0));
        if fits {
            assert_eq!(
                loaded,
                Some((true, version.unwrap())),
                "a small checkpoint must not reserve the former whole-content ceiling"
            );
            assert_eq!(failed, None);
            assert_eq!(
                retained_bytes,
                body.len() + maka_plugin_core::json::encoded_size(&saved, usize::MAX).unwrap()
            );
        } else {
            assert_eq!(loaded, None);
            assert!(
                matches!(failed, Some((false, ref diagnostic))
                if diagnostic.contains("native resource budget exhausted")),
                "large checkpoint load must fail its actual native admission: {failed:?}"
            );
            assert_eq!(retained_bytes, 0);
        }
        let (record, ()) = checkpoints
            .read(&policy.key, |_| Ok(()))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(record.revision, version.unwrap());
        assert!(
            record.content.as_slice() == body.as_bytes(),
            "load admission changed stored draft bytes"
        );
        assert_eq!(record.metadata, serde_json::to_value(&saved).unwrap());
    }
    store.shutdown().await.unwrap();
}

#[tokio::test]
async fn an_older_ack_cannot_hide_a_newer_capture_failure_and_retry_accounts_for_it() {
    let (_dir, store) = store().await;
    let source = source(&store, Uuid::new_v4(), 0).await;
    let mut policy = policy();
    let resources = Arc::new(Resources::default());
    let budget = NativeBudget::default();
    let mut editor = EditorCheckpoint::new(
        Some(scope(&store, &source).await),
        &policy,
        &resources,
        budget.clone(),
    );
    until(&mut editor, &policy, EditorCheckpoint::writable).await;
    let body = "甲👩‍💻z";
    editor.save(&snapshot("owner", 1, body), body, &policy.metadata);
    let mut invalid = snapshot("owner", 2, body);
    invalid.text.bytes = body.len() + 1;
    editor.save(&invalid, body, &policy.metadata);
    until(&mut editor, &policy, |e| e.saved_sequence == 1).await;
    assert!(!editor.accepts_input());
    assert!(matches!(editor.phase, Phase::Failed { writing: true, .. }));
    policy.retry = 1;
    editor.poll(&policy);
    editor.save(&snapshot("owner", 2, body), body, &policy.metadata);
    until(&mut editor, &policy, |e| e.saved_sequence == 2).await;
    editor.close();
    drop(editor);
    resources.finish().await.unwrap();
    assert_eq!(budget.usage(), (0, 0, 0));
}

#[tokio::test]
async fn source_mismatch_and_conflicting_writers_cannot_overwrite_saved_content() {
    let (_dir, store) = store().await;
    let source = source(&store, Uuid::new_v4(), 0).await;
    let policy = policy();
    let a = Arc::new(Resources::default());
    let b = Arc::new(Resources::default());
    let mut first = EditorCheckpoint::new(
        Some(scope(&store, &source).await),
        &policy,
        &a,
        NativeBudget::default(),
    );
    let mut second = EditorCheckpoint::new(
        Some(scope(&store, &source).await),
        &policy,
        &b,
        NativeBudget::default(),
    );
    until(&mut first, &policy, EditorCheckpoint::writable).await;
    until(&mut second, &policy, EditorCheckpoint::writable).await;
    let body = "甲👩‍💻z";
    first.save(&snapshot("first", 1, body), body, &policy.metadata);
    until(&mut first, &policy, EditorCheckpoint::accepts_input).await;
    second.save(&snapshot("second", 1, body), body, &policy.metadata);
    until(&mut second, &policy, |e| {
        matches!(e.phase, Phase::Failed { .. })
    })
    .await;
    second.close();
    drop(second);
    assert!(b.finish().await.is_err());
    first.close();
    drop(first);
    a.finish().await.unwrap();
    let mut foreign = policy.clone();
    foreign.data_source = json!({"host":"replacement"});
    let c = Arc::new(Resources::default());
    let mut replacement = EditorCheckpoint::new(
        Some(scope(&store, &source).await),
        &foreign,
        &c,
        NativeBudget::default(),
    );
    until(&mut replacement, &foreign, |e| {
        matches!(e.phase, Phase::Failed { .. })
    })
    .await;
    assert!(!replacement.accepts_input());
    replacement.close();
    drop(replacement);
    c.finish().await.unwrap();
    assert_eq!(
        store
            .ui_checkpoints(&source, &instance())
            .await
            .unwrap()
            .read(&policy.key, |_| Ok(()))
            .await
            .unwrap()
            .unwrap()
            .0
            .metadata["snapshot"]["text"]["owner"],
        "first"
    );
}

#[test]
fn restored_selections_require_exact_graphemes_and_preserve_direction() {
    let body = "甲👩‍💻z";
    let mut saved = snapshot("owner", 1, body);
    assert_eq!(selection_bytes(body, Some(&saved)), Some((14, 3)));
    saved.selection.start = 2;
    assert_eq!(selection_bytes(body, Some(&saved)), None);
    assert_eq!(selection_bytes("", None), Some((0, 0)));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_preference_reads_are_not_rejected_by_a_worker_count() {
    use super::value::{ValueCheckpoint, ValueCheckpointProps, ValueCheckpointState};
    let (_dir, store) = store().await;
    let source = source(&store, Uuid::new_v4(), 0).await;
    let recipe_scope = scope(&store, &source).await;
    let resources = Arc::new(Resources::default());
    let budget = NativeBudget::new(crate::budget::BudgetLimits {
        encoded_bytes: 128 * 1024,
        ..Default::default()
    });
    let mut preferences: Vec<_> = (0..16)
        .map(|index| {
            ValueCheckpoint::new(
                Some(recipe_scope.clone()),
                &ValueCheckpointProps {
                    key: format!("panel-{index}"),
                    format: "test/v1".into(),
                    command: None,
                },
                &resources,
                budget.clone(),
            )
        })
        .collect();
    let mut ready = std::collections::BTreeSet::new();
    tokio::time::timeout(Duration::from_secs(5), async {
        while ready.len() < preferences.len() {
            for (index, preference) in preferences.iter_mut().enumerate() {
                if let Some(observed) = preference.observe() {
                    match observed.state {
                        ValueCheckpointState::Ready { .. } => {
                            ready.insert(index);
                        }
                        ValueCheckpointState::Failed { diagnostic } => panic!("{diagnostic}"),
                        _ => {}
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .unwrap();
    for preference in &mut preferences {
        preference.close();
    }
    tokio::time::timeout(Duration::from_secs(5), async {
        while !resources.seal().unwrap() {
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(budget.usage(), (0, 0, 0));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn preference_busy_keeps_the_original_write_result_and_retirement_drains_it() {
    use super::value::{
        ValueCheckpoint, ValueCheckpointCommand, ValueCheckpointProps, ValueCheckpointState,
    };
    let (dir, store) = store().await;
    let source = source(&store, Uuid::new_v4(), 0).await;
    let scope = scope(&store, &source).await;
    let resources = Arc::new(Resources::default());
    let budget = NativeBudget::default();
    let mut props = ValueCheckpointProps {
        key: "preferences".into(),
        format: "test@1".into(),
        command: None,
    };
    let mut preferences =
        ValueCheckpoint::new(Some(scope.clone()), &props, &resources, budget.clone());
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if preferences
                .observe()
                .is_some_and(|value| matches!(value.state, ValueCheckpointState::Ready { .. }))
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let original_payload = json!({"original": "完整 preference ".repeat(3000)});
    let original_bytes = maka_plugin_core::json::value_size(&original_payload, usize::MAX).unwrap();
    let blocker = block_data_writers(dir.path());
    props.command = Some(ValueCheckpointCommand::Write {
        sequence: 1,
        expected_revision: None,
        value: original_payload.clone(),
    });
    preferences.update(&props);
    assert_eq!(
        budget.usage().0,
        original_bytes,
        "accepted queued value retains its reservation"
    );
    let saving = preferences.observe().unwrap();
    assert_eq!(saving.sequence, 1);
    assert!(matches!(saving.state, ValueCheckpointState::Saving));
    props.command = Some(ValueCheckpointCommand::Write {
        sequence: 2,
        expected_revision: None,
        value: json!({"replacement": true}),
    });
    preferences.update(&props);
    for connection in &blocker {
        connection.execute_batch("COMMIT").unwrap();
    }
    let busy = preferences.observe().unwrap();
    assert_eq!(busy.sequence, 2);
    assert!(
        matches!(busy.state, ValueCheckpointState::Failed { diagnostic } if diagnostic.contains("busy"))
    );
    let original = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(value) = preferences.observe() {
                break value;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(original.sequence, 1);
    let ValueCheckpointState::Ready {
        revision: Some(revision),
        value,
    } = original.state
    else {
        panic!("the original accepted write must finish");
    };
    assert_eq!(value, Some(original_payload.clone()));
    assert_eq!(
        budget.usage().0,
        original_bytes,
        "ready observation retains its original reservation"
    );
    let checkpoints = scope.open(&store).unwrap();
    let (saved, ()) = checkpoints
        .read(&props.key, |_| Ok(()))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(saved.revision, revision);
    assert_eq!(
        serde_json::from_slice::<Value>(&saved.content).unwrap(),
        original_payload
    );

    for connection in &blocker {
        connection.execute_batch("BEGIN IMMEDIATE").unwrap();
    }
    props.command = Some(ValueCheckpointCommand::Write {
        sequence: 3,
        expected_revision: Some(revision),
        value: json!({"retired": true}),
    });
    preferences.update(&props);
    preferences.close();
    assert!(!resources.seal().unwrap());
    drop(preferences);
    for connection in &blocker {
        connection.execute_batch("COMMIT").unwrap();
    }
    resources.finish().await.unwrap();
    assert_eq!(budget.usage(), (0, 0, 0));
    let (saved, ()) = checkpoints
        .read(&props.key, |_| Ok(()))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&saved.content).unwrap(),
        json!({"retired": true})
    );
}
