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
use maka_code_runtime::{CellContext, CellLimits};
use serde_json::json;
use std::time::Duration;

async fn engine() -> (
    tempfile::TempDir,
    Engine,
    maka_event_log::root_store::RootStore,
) {
    let (directory, root) = crate::test_support::root().await;
    let engine = Engine::new(
        ModelExecutor::new(Duration::from_secs(10)).unwrap(),
        CodeExecutor::new(CellLimits::default()).unwrap(),
    )
    .unwrap();
    (directory, engine, root)
}

// Exercise the worker admission boundary without provider I/O.
async fn settle(engine: &Engine, root: &maka_event_log::root_store::RootStore, session: &str) {
    let store = crate::test_support::session(root, session).await;
    let execution = store.execution_scope(None).await.unwrap();
    let invocation = Invocation {
        session_id: session.into(),
        turn_id: "turn".into(),
        run_id: "run".into(),
        invocation_id: "invocation".into(),
    };
    let context = RunContext::new(engine.0.clone(), execution.store(), &invocation).unwrap();
    let completed = context
        .start_owned(
            execution,
            invocation.clone(),
            Arc::default(),
            None,
            CancellationToken::new(),
            move |_, admitted, _| async move {
                admitted.send(()).unwrap();
                Ok(invocation)
            },
        )
        .await
        .unwrap()
        .completion()
        .await;
    assert!(completed.cleanup.is_ok());
}

#[tokio::test]
async fn nonempty_idle_sessions_restore_from_shared_backend() {
    let (_directory, engine, root) = engine().await;
    for index in 0..64 {
        let session = format!("session-{index}");
        let state = engine.0.session_backend.session(&session);
        let cell =
            CellContext::new(maka_code_runtime::CellStore::new(state.clone()), vec![]).unwrap();
        cell.store("answer".into(), json!(index)).unwrap();
        cell.commit().unwrap();
        state
            .update_loaded(|names| {
                names.insert("search-result".into());
            })
            .unwrap();
        drop(cell);
        drop(state);
        settle(&engine, &root, &session).await;
        assert!(engine.0.active.lock().unwrap().is_empty());
    }
    let state = engine.0.session_backend.session("session-32");
    let cell = CellContext::new(maka_code_runtime::CellStore::new(state), vec![]).unwrap();
    assert_eq!(cell.load("answer").unwrap(), Some(json!(32)));
    assert!(
        engine
            .0
            .loaded_snapshot("session-32")
            .unwrap()
            .contains("search-result")
    );
}

#[tokio::test]
async fn active_snapshot_and_late_commit_survive_worker_settlement() {
    let (_directory, engine, root) = engine().await;
    let store = maka_code_runtime::CellStore::new(engine.0.session_backend.session("cell"));
    let cell = CellContext::new(store.clone(), vec![]).unwrap();
    settle(&engine, &root, "cell").await;
    let concurrent = CellContext::new(store.clone(), vec![]).unwrap();
    concurrent.store("answer".into(), json!(7)).unwrap();
    concurrent.commit().unwrap();
    assert_eq!(cell.load("answer").unwrap(), None);
    cell.store("later".into(), json!(42)).unwrap();
    cell.commit().unwrap();
    drop(cell);
    drop(concurrent);
    settle(&engine, &root, "cell").await;
    let next = CellContext::new(store, vec![]).unwrap();
    assert_eq!(next.load("answer").unwrap(), Some(json!(7)));
    assert_eq!(next.load("later").unwrap(), Some(json!(42)));
}

#[tokio::test]
async fn clearing_discovery_preserves_scratch_and_retirement_fences_late_handles() {
    let (_directory, engine, _root) = engine().await;
    let session = engine.0.session_backend.session("s");
    let loaded = engine.0.loaded("s");
    session
        .update_loaded(|names| {
            names.insert("discovered".into());
        })
        .unwrap();
    let cell = CellContext::new(maka_code_runtime::CellStore::new(session), vec![]).unwrap();
    cell.store("answer".into(), json!(42)).unwrap();
    cell.commit().unwrap();
    engine.0.clear_loaded("s").unwrap();
    assert!(loaded.snapshot().unwrap().is_empty());
    assert_eq!(cell.load("answer").unwrap(), Some(json!(42)));
    engine.release_session_state("s").unwrap();
    assert!(loaded.snapshot().is_err());
    assert!(cell.commit().is_err());
    assert!(engine.0.loaded_snapshot("s").is_err());
}

fn invocation(session: &str, run: &str) -> Invocation {
    Invocation {
        session_id: session.into(),
        turn_id: run.into(),
        run_id: run.into(),
        invocation_id: run.into(),
    }
}

#[tokio::test]
async fn selected_contexts_share_state_but_keep_each_session_journal_bound() {
    use maka_agent_facts::artifact::{Artifact, ArtifactKind, ArtifactSource};
    let (_directory, engine, root) = engine().await;
    let a = crate::test_support::session(&root, "a").await;
    let b = crate::test_support::session(&root, "b").await;
    let first = RunContext::new(engine.0.clone(), a.clone(), &invocation("a", "first")).unwrap();
    let second = RunContext::new(engine.0.clone(), b, &invocation("b", "second")).unwrap();
    let resumed =
        RunContext::new(engine.0.clone(), a.clone(), &invocation("a", "resumed")).unwrap();
    first
        .shared
        .session_backend
        .session("a")
        .update_loaded(|loaded| {
            loaded.insert("discovered".into());
        })
        .unwrap();
    assert!(
        resumed
            .shared
            .loaded_snapshot("a")
            .unwrap()
            .contains("discovered")
    );
    assert!(second.shared.loaded_snapshot("b").unwrap().is_empty());
    for (context, bytes) in [(&first, b"first".to_vec()), (&second, b"second".to_vec())] {
        context
            .log
            .commit_artifact(
                Artifact {
                    id: "same-artifact-id".into(),
                    session_id: context.log.id().into(),
                    turn_id: "turn".into(),
                    created_at: 1,
                    name: "upload.txt".into(),
                    kind: ArtifactKind::File,
                    size_bytes: bytes.len() as u64,
                    mime_type: Some("text/plain".into()),
                    source: ArtifactSource::UserUpload,
                    summary: Some(maka_agent_facts::artifact::content_digest(&bytes)),
                },
                bytes,
            )
            .await
            .unwrap();
    }
    assert_eq!(
        first
            .log
            .get_artifact("a", "same-artifact-id")
            .await
            .unwrap()
            .record
            .unwrap()
            .size_bytes,
        5
    );
    assert_eq!(
        second
            .log
            .get_artifact("b", "same-artifact-id")
            .await
            .unwrap()
            .record
            .unwrap()
            .size_bytes,
        6
    );
    assert!(
        first
            .log
            .get_artifact("b", "same-artifact-id")
            .await
            .is_err()
    );
    assert!(matches!(
        RunContext::new(engine.0.clone(), a, &invocation("b", "foreign")),
        Err(RunError::InvalidInput(_))
    ));
    root.close().await.unwrap();
}

#[tokio::test]
async fn selected_stores_keep_one_active_admission_after_observer_drop() {
    let (_directory, engine, root) = engine().await;
    let a = crate::test_support::session(&root, "a").await;
    let b = crate::test_support::session(&root, "b").await;
    let (release, wait) = tokio::sync::oneshot::channel();
    let first_execution = a.execution_scope(None).await.unwrap();
    let first_context = RunContext::new(
        engine.0.clone(),
        first_execution.store(),
        &invocation("a", "first"),
    )
    .unwrap();
    let first = first_context
        .start_owned(
            first_execution,
            invocation("a", "first"),
            Arc::default(),
            None,
            CancellationToken::new(),
            move |_, admitted, _| async move {
                admitted.send(()).unwrap();
                wait.await.unwrap();
                Ok(invocation("a", "first"))
            },
        )
        .await
        .unwrap();
    drop(first);
    let collision_execution = a.execution_scope(None).await.unwrap();
    let collision_context = RunContext::new(
        engine.0.clone(),
        collision_execution.store(),
        &invocation("a", "collision"),
    )
    .unwrap();
    assert!(matches!(
        collision_context
            .start_owned(
                collision_execution,
                invocation("a", "collision"),
                Arc::default(),
                None,
                CancellationToken::new(),
                |_, _, _| async { panic!("same Session admitted twice") }
            )
            .await,
        Err(RunError::Busy)
    ));
    let other_execution = b.execution_scope(None).await.unwrap();
    let other_context = RunContext::new(
        engine.0.clone(),
        other_execution.store(),
        &invocation("b", "parallel"),
    )
    .unwrap();
    let other = other_context
        .start_owned(
            other_execution,
            invocation("b", "parallel"),
            Arc::default(),
            None,
            CancellationToken::new(),
            |_, admitted, _| async move {
                admitted.send(()).unwrap();
                Ok(invocation("b", "parallel"))
            },
        )
        .await
        .unwrap()
        .completion()
        .await;
    assert!(other.cleanup.is_ok());
    assert_eq!(other.result.unwrap().session_id, "b");
    assert!(engine.0.active.lock().unwrap().contains("a"));
    release.send(()).unwrap();
    engine.drain().await;
    assert!(engine.0.active.lock().unwrap().is_empty());
    root.close().await.unwrap();
}

#[tokio::test]
async fn unconfirmed_worker_cleanup_keeps_original_root_authority_after_completion() {
    use maka_event_log::{
        root::{RootNamespaces, RootOwner},
        root_store::RootStore,
    };
    for panics in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let root_path = directory.path().join("root");
        let namespaces = RootNamespaces {
            ownership: directory.path().join("owners"),
            control: directory.path().join("control"),
        };
        let owner = Arc::new(RootOwner::create(&root_path, &namespaces).unwrap());
        let original = Arc::downgrade(&owner);
        let root = RootStore::open(owner).await.unwrap();
        let store = crate::test_support::session(&root, "failed").await;
        let engine = Engine::new(
            ModelExecutor::new(Duration::from_secs(5)).unwrap(),
            CodeExecutor::new(CellLimits::default()).unwrap(),
        )
        .unwrap();
        let execution = store.execution_scope(None).await.unwrap();
        let context = RunContext::new(
            engine.0.clone(),
            execution.store(),
            &invocation("failed", "run"),
        )
        .unwrap();
        let completion = context
            .start_owned(
                execution,
                invocation("failed", "run"),
                Arc::default(),
                None,
                CancellationToken::new(),
                move |_, admitted, _| async move {
                    admitted.send(()).unwrap();
                    assert!(!panics, "physical worker panic");
                    Err(RunError::CleanupUnconfirmed)
                },
            )
            .await
            .unwrap()
            .completion()
            .await;
        assert!(completion.cleanup.is_err());
        engine.drain().await;
        assert!(
            tokio::time::timeout(Duration::from_secs(5), root.close())
                .await
                .unwrap()
                .is_err()
        );
        drop(store);
        drop(engine);
        assert!(
            original.upgrade().is_some(),
            "physical failure cannot release the original Root"
        );
        assert_eq!(
            RootOwner::open(&root_path, &namespaces)
                .err()
                .unwrap()
                .kind(),
            std::io::ErrorKind::WouldBlock
        );
    }
}

#[tokio::test]
async fn worker_completion_retains_admission_until_invocation_effect_settles() {
    tokio::time::timeout(Duration::from_secs(10), async {
        for unconfirmed in [false, true] {
            let (_directory, engine, root) = engine().await;
            let root = Arc::new(root);
            let store = crate::test_support::session(&root, "effect").await;
            let execution = store.execution_scope(None).await.unwrap();
            let selected = execution.store();
            let effect_root = root.clone();
            let (send_effect, effect) = tokio::sync::oneshot::channel();
            let context = RunContext::new(
                engine.0.clone(),
                execution.store(),
                &invocation("effect", "run"),
            )
            .unwrap();
            let running = context
                .start_owned(
                    execution,
                    invocation("effect", "run"),
                    Arc::default(),
                    None,
                    CancellationToken::new(),
                    move |_, admitted, _| async move {
                        let invocation = invocation("effect", "run");
                        let custody = selected.execution_custody().unwrap();
                        let effect = effect_root
                            .fork_invocation_effect(custody.as_ref(), &invocation)
                            .unwrap();
                        send_effect
                            .send(effect)
                            .unwrap_or_else(|_| panic!("effect observer disappeared"));
                        admitted.send(()).unwrap();
                        Ok(invocation)
                    },
                )
                .await
                .unwrap();
            let effect = effect.await.unwrap();
            let mut completion = Box::pin(running.completion());
            assert!(futures_util::poll!(completion.as_mut()).is_pending());
            let collision_execution = store.execution_scope(None).await.unwrap();
            let collision_context = RunContext::new(
                engine.0.clone(),
                collision_execution.store(),
                &invocation("effect", "collision"),
            )
            .unwrap();
            assert!(matches!(
                collision_context
                    .start_owned(
                        collision_execution,
                        invocation("effect", "collision"),
                        Arc::default(),
                        None,
                        CancellationToken::new(),
                        |_, _, _| async { panic!("pending effect lost Run admission") },
                    )
                    .await,
                Err(RunError::Busy)
            ));

            if unconfirmed {
                effect.retain_unconfirmed("late native cleanup is unconfirmed".into());
            } else {
                effect.finish(Ok(()));
            }
            let completed = completion.await;
            if unconfirmed {
                assert!(completed.cleanup.is_err());
                assert!(
                    completed
                        .result
                        .as_ref()
                        .is_err_and(RunError::is_cleanup_unconfirmed)
                );
                assert!(root.shutdown().await.is_err());
            } else {
                assert!(completed.cleanup.is_ok());
                assert_eq!(completed.result.unwrap().invocation_id, "run");
                root.shutdown().await.unwrap();
            }
            engine.drain().await;
            assert!(engine.0.active.lock().unwrap().is_empty());
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn worker_panic_cancels_and_drains_its_original_invocation_effect() {
    tokio::time::timeout(Duration::from_secs(10), async {
        let (_directory, engine, root) = engine().await;
        let root = Arc::new(root);
        let store = crate::test_support::session(&root, "panicking-effect").await;
        let execution = store.execution_scope(None).await.unwrap();
        let selected = execution.store();
        let effect_root = root.clone();
        let (send_effect, effect) = tokio::sync::oneshot::channel();
        let context = RunContext::new(
            engine.0.clone(),
            execution.store(),
            &invocation("panicking-effect", "run"),
        )
        .unwrap();
        let running = context
            .start_owned(
                execution,
                invocation("panicking-effect", "run"),
                Arc::default(),
                None,
                CancellationToken::new(),
                move |_, admitted, _| async move {
                    let invocation = invocation("panicking-effect", "run");
                    let custody = selected.execution_custody().unwrap();
                    let effect = effect_root
                        .fork_invocation_effect(custody.as_ref(), &invocation)
                        .unwrap();
                    send_effect
                        .send(effect)
                        .unwrap_or_else(|_| panic!("effect observer disappeared"));
                    admitted.send(()).unwrap();
                    panic!("physical worker panic with an admitted effect");
                },
            )
            .await
            .unwrap();
        let effect = effect.await.unwrap();
        effect.cancellation().cancelled().await;
        let mut completion = Box::pin(running.completion());
        assert!(futures_util::poll!(completion.as_mut()).is_pending());
        effect.finish(Ok(()));
        let completed = completion.await;
        assert!(completed.cleanup.is_err());
        assert!(
            completed
                .result
                .as_ref()
                .is_err_and(RunError::is_cleanup_unconfirmed)
        );
        engine.drain().await;
        assert!(engine.0.active.lock().unwrap().is_empty());
        assert!(root.shutdown().await.is_err());
    })
    .await
    .unwrap();
}
