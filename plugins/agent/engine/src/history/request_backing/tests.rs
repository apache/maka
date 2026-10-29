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
use crate::history::capture_arena::CaptureArena;
use maka_capabilities::model_preparation::{ModelPreparationResources, PreparationPolicy};
use maka_event_log::{
    context::semantic::SemanticSelection,
    root::{RootNamespaces, RootOwner},
    root_store::{RootStore, SessionExecutionLease},
};

async fn source(path: &std::path::Path) -> (RootStore, CapturedSource, SessionExecutionLease) {
    let namespaces = RootNamespaces {
        ownership: path.join("owners"),
        control: path.join("control"),
    };
    let root = RootStore::open(Arc::new(
        RootOwner::create(&path.join("root"), &namespaces).unwrap(),
    ))
    .await
    .unwrap();
    root.create_session("session", "create", &serde_json::json!({}), 1)
        .await
        .unwrap();
    let session = root.session("session").await.unwrap();
    let lease = session.execution_scope(None).await.unwrap().accept();
    let captured = lease
        .store()
        .capture_source(SemanticSelection {
            session: "session".into(),
            lineage: None,
            after: 0,
            through: 0,
            before: 1,
            captured_through: 0,
            replay: None,
            prior_unknown: false,
        })
        .await
        .unwrap();
    (root, captured, lease)
}
async fn bound_source(
    path: &std::path::Path,
) -> (
    RootStore,
    CapturedSource,
    SessionExecutionLease,
    maka_event_log::root_store::InvocationEffects,
) {
    let namespaces = RootNamespaces {
        ownership: path.join("owners"),
        control: path.join("control"),
    };
    let root = RootStore::open(Arc::new(
        RootOwner::create(&path.join("root"), &namespaces).unwrap(),
    ))
    .await
    .unwrap();
    root.create_session("session", "create", &serde_json::json!({}), 1)
        .await
        .unwrap();
    let session = root.session("session").await.unwrap();
    let (lease, effects) = session
        .execution_scope(None)
        .await
        .unwrap()
        .accept_invocation(
            maka_agent_facts::event::Invocation {
                session_id: "session".into(),
                turn_id: "turn".into(),
                run_id: "run".into(),
                invocation_id: "invocation".into(),
            },
            tokio_util::sync::CancellationToken::new(),
        )
        .unwrap();
    let captured = lease
        .store()
        .capture_source(SemanticSelection {
            session: "session".into(),
            lineage: None,
            after: 0,
            through: 0,
            before: 1,
            captured_through: 0,
            replay: None,
            prior_unknown: false,
        })
        .await
        .unwrap();
    (root, captured, lease, effects)
}
fn resources() -> ModelPreparationResources {
    ModelPreparationResources::new(PreparationPolicy {
        staging_bytes: 32,
        resident_bytes: 32,
        progress_bytes: 64,
        work_bytes: 64,
    })
    .unwrap()
}

#[tokio::test]
async fn resident_ranges_keep_their_charge_until_the_last_output_slice_is_released() {
    let directory = tempfile::tempdir().unwrap();
    let (root, source, execution) = source(directory.path()).await;
    let resources = resources();
    let staged = resources.reserve_staging(32).await.unwrap();
    let arena = CaptureArena::new(source.clone(), Some(staged.directory(32).unwrap()))
        .await
        .unwrap();
    let selected = arena
        .with_writer(|builder| {
            builder.append_bytes(b"before")?;
            let zeros = builder.reserve_zeroed(3)?;
            let mut actual = [1; 3];
            builder.read_exact_at(zeros.start, &mut actual)?;
            assert_eq!(actual, [0; 3]);
            assert!(builder.reserve_zeroed(32).is_err());
            let selected = builder.append_bytes("中\"🦀".as_bytes())?;
            assert!(builder.write_all(&[0; 32]).is_err());
            Ok(selected)
        })
        .await
        .unwrap();
    arena.seal().await.unwrap();
    let bytes = arena.pending(selected);
    assert!(bytes.slice(0..u64::MAX).is_err());
    let work = resources.acquire_work().await.unwrap();
    let budget = work.budget();
    let mut cursor = bytes.open(budget.clone());
    let read = cursor
        .read_chunk(budget.allocate(16).await.unwrap())
        .await
        .unwrap();
    assert!(read.eof);
    let output = read.buffer.into_bytes(read.bytes_read);
    assert_eq!(&output[..], "中\"🦀".as_bytes());
    arena.close().await.unwrap();
    drop((cursor, bytes, arena));
    assert!(staged.directory(1).is_err());
    drop(output);
    assert!(staged.directory(32).is_ok());
    drop((budget, work, source));
    execution.finish();
    root.shutdown().await.unwrap();
}

#[tokio::test]
async fn file_regions_replay_from_native_offsets_and_close_before_the_resource_settles() {
    let directory = tempfile::tempdir().unwrap();
    let (root, source, execution) = source(directory.path()).await;
    let arena = CaptureArena::new(source.clone(), None).await.unwrap();
    let selected = arena
        .with_writer(|builder| {
            builder.append_bytes(b"scratch")?;
            builder.write_at(1, b"X")?;
            let mut scratch = [0; 3];
            builder.read_exact_at(0, &mut scratch)?;
            assert_eq!(&scratch, b"sXr");
            let selected = builder.append_bytes(b"payload")?;
            assert_eq!(builder.position(), 14);
            Ok(selected)
        })
        .await
        .unwrap();
    arena.seal().await.unwrap();
    let source_bytes = arena.pending(selected);
    let tail = source_bytes.slice(2..7).unwrap();
    let resources = resources();
    let work = resources.acquire_work().await.unwrap();
    let budget = work.budget();
    for _ in 0..2 {
        let mut cursor = tail.open(budget.clone());
        let mut buffer = budget.allocate(2).await.unwrap();
        let mut result = Vec::new();
        loop {
            let read = cursor.read_chunk(buffer).await.unwrap();
            result.extend_from_slice(&read.buffer.as_ref()[..read.bytes_read]);
            buffer = read.buffer;
            if read.eof {
                break;
            }
        }
        assert_eq!(result, b"yload");
    }
    arena.close().await.unwrap();
    arena.close().await.unwrap();
    assert!(
        source_bytes
            .open(budget.clone())
            .read_chunk(budget.allocate(2).await.unwrap())
            .await
            .is_err()
    );
    drop((tail, source_bytes, arena, budget, work, source));
    execution.finish();
    root.shutdown().await.unwrap();
}

async fn reopen(path: &std::path::Path) {
    let namespaces = RootNamespaces {
        ownership: path.join("owners"),
        control: path.join("control"),
    };
    let reopened = RootStore::open(Arc::new(
        RootOwner::open(&path.join("root"), &namespaces).unwrap(),
    ))
    .await
    .unwrap();
    reopened.shutdown().await.unwrap();
}

#[tokio::test]
async fn failed_append_and_normal_cancellation_abort_on_the_original_worker_and_permit_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let (root, source, execution) = source(directory.path()).await;
    let arena = CaptureArena::new(source.clone(), None).await.unwrap();
    let readonly_path = directory.path().join("readonly");
    arena
        .with_writer(move |builder| {
            std::fs::write(&readonly_path, b"readonly")?;
            let readonly = File::open(readonly_path)?;
            let Some(Building::File { file, .. }) = builder.storage.as_mut() else {
                unreachable!()
            };
            close_request_file(std::mem::replace(file, readonly))?;
            assert!(builder.append_bytes(b"cannot write").is_err());
            Ok(())
        })
        .await
        .unwrap();
    arena.close().await.unwrap();
    drop(arena);
    let arena = CaptureArena::new(source.clone(), None).await.unwrap();
    arena
        .with_writer(|builder| builder.append_bytes(b"unfinished capture"))
        .await
        .unwrap();
    arena.close().await.unwrap();
    drop((arena, source));
    execution.finish();
    root.shutdown().await.unwrap();
    drop(root);
    reopen(directory.path()).await;
}

#[tokio::test]
async fn dropped_publish_observer_keeps_the_original_owner_able_to_close_and_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let (root, source, execution, effects) = bound_source(directory.path()).await;
    let arena = CaptureArena::new(source.clone(), None).await.unwrap();
    let (entered, accepted) = tokio::sync::oneshot::channel();
    let (release, released) = tokio::sync::oneshot::channel();
    let (settled, complete) = tokio::sync::oneshot::channel();
    let mut observer = Box::pin(arena.with_writer(move |builder| {
        let range = builder.append_bytes(b"complete captured bytes")?;
        entered.send(()).unwrap();
        released.blocking_recv().unwrap();
        settled.send(()).unwrap();
        Ok(range)
    }));
    tokio::select! {
        result = &mut observer => panic!("writer observer finished before release: {result:?}"),
        result = accepted => result.unwrap(),
    }
    drop(observer);
    let mut close_observer = Box::pin(arena.close());
    assert!(futures_util::poll!(&mut close_observer).is_pending());
    drop(close_observer);
    release.send(()).unwrap();
    complete.await.unwrap();
    // A lost reply must not discard the writer or release physical serialization.
    arena.seal().await.unwrap();
    arena.close().await.unwrap();
    drop((arena, source));
    effects.settle().await.unwrap();
    execution.finish();
    root.shutdown().await.unwrap();
    drop(root);
    reopen(directory.path()).await;
}

#[tokio::test]
async fn abandoned_file_material_stays_owned_by_original_quarantine_instead_of_claiming_close() {
    let directory = tempfile::tempdir().unwrap();
    let (root, source, execution) = source(directory.path()).await;
    let arena = CaptureArena::new(source.clone(), None).await.unwrap();
    arena
        .with_writer(|builder| builder.append_bytes(b"retained material"))
        .await
        .unwrap();
    drop(arena);
    drop(source);
    execution.finish();
    assert!(
        root.shutdown().await.is_err(),
        "missing close receipt cannot acknowledge shutdown"
    );
    drop(root);
    let namespaces = RootNamespaces {
        ownership: directory.path().join("owners"),
        control: directory.path().join("control"),
    };
    assert!(RootOwner::open(&directory.path().join("root"), &namespaces).is_err());
}

#[tokio::test]
async fn arena_sealed_ranges_survive_append_conversion_and_last_resident_slice() {
    let directory = tempfile::tempdir().unwrap();
    let (root, source, execution) = source(directory.path()).await;
    let resources = resources();
    let staged = resources.reserve_staging(32).await.unwrap();
    let arena = CaptureArena::new(source.clone(), Some(staged.directory(32).unwrap()))
        .await
        .unwrap();
    let first = arena
        .with_writer(|builder| builder.append_bytes("中\"🦀".as_bytes()))
        .await
        .unwrap();
    let first_source = arena.pending(first.clone());
    let work = resources.acquire_work().await.unwrap();
    let budget = work.budget();
    let mut old_cursor = first_source.open(budget.clone());
    assert_eq!(
        old_cursor
            .read_chunk(budget.allocate(16).await.unwrap())
            .await
            .unwrap_err()
            .kind(),
        io::ErrorKind::WouldBlock
    );
    arena.seal().await.unwrap();
    let read = old_cursor
        .read_chunk(budget.allocate(16).await.unwrap())
        .await
        .unwrap();
    let last_slice = read.buffer.into_bytes(read.bytes_read);
    let tail = arena
        .with_writer(|builder| {
            assert!(builder.write_at(0, b"X").is_err());
            let tail = builder.append_bytes(b"later")?;
            builder.write_at(tail.start, b"L")?;
            Ok(tail)
        })
        .await
        .unwrap();
    let tail_source = arena.pending(tail.clone());
    let mut tail_cursor = tail_source.open(budget.clone());
    assert!(
        tail_cursor
            .read_chunk(budget.allocate(16).await.unwrap())
            .await
            .is_err()
    );
    arena.promote_to_file().await.unwrap();
    // The bytes returned before conversion still own their original reservation.
    assert!(staged.directory(1).is_err());
    assert_eq!(&last_slice[..], "中\"🦀".as_bytes());
    arena.seal().await.unwrap();
    let read = tail_cursor
        .read_chunk(budget.allocate(16).await.unwrap())
        .await
        .unwrap();
    assert_eq!(&read.buffer.as_ref()[..read.bytes_read], b"Later");
    drop(read);
    let mut replay = first_source.open(budget.clone());
    let read = replay
        .read_chunk(budget.allocate(16).await.unwrap())
        .await
        .unwrap();
    assert_eq!(
        &read.buffer.as_ref()[..read.bytes_read],
        "中\"🦀".as_bytes()
    );
    drop(read);
    arena
        .with_writer(|builder| {
            assert!(builder.write_at(0, b"X").is_err());
            builder.append_bytes(b"third")?;
            Ok(())
        })
        .await
        .unwrap();
    arena.seal().await.unwrap();
    let copy_resources = ModelPreparationResources::new(PreparationPolicy {
        staging_bytes: 1,
        resident_bytes: 1,
        progress_bytes: 32 * 1024,
        work_bytes: 32 * 1024,
    })
    .unwrap();
    let copy_work = copy_resources.acquire_work().await.unwrap();
    let cancel = tokio_util::sync::CancellationToken::new();
    let recipes = crate::history::arena_recipes::ArenaRecipes::new(arena.clone(), Arc::new(()));
    let list = recipes.begin_list(1).await.unwrap();
    let leaf = recipes
        .text(
            maka_agent_facts::model::prompt_source::source::TextSource::new(
                first_source.clone(),
                maka_agent_facts::model::prompt_source::source::TextEncoding::Utf8,
            ),
            copy_work.budget(),
            &cancel,
        )
        .await
        .unwrap();
    recipes.put(list, 0, leaf).await.unwrap();
    arena.seal().await.unwrap();
    let numeric_text = maka_agent_facts::model::prompt_source::source::text::concat(
        recipes.texts(list),
        copy_work.budget(),
    );
    let copied = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        arena.append(
            maka_agent_facts::model::prompt_source::source::text::bytes(
                numeric_text,
                copy_work.budget(),
            ),
            copy_work.budget(),
            &cancel,
        ),
    )
    .await;
    let copied = match copied {
        Ok(result) => result.unwrap(),
        Err(error) => {
            arena.close().await.unwrap();
            panic!("reading a sealed prefix while appending to the same arena deadlocked: {error}");
        }
    };
    drop((recipes, copy_work));
    arena.seal().await.unwrap();
    let copied_source = arena.pending(copied);
    let mut copied_cursor = copied_source.open(budget.clone());
    let read = copied_cursor
        .read_chunk(budget.allocate(16).await.unwrap())
        .await
        .unwrap();
    assert_eq!(
        &read.buffer.as_ref()[..read.bytes_read],
        "中\"🦀".as_bytes()
    );
    drop((read, copied_cursor, copied_source));
    arena.close().await.unwrap();
    arena.close().await.unwrap();
    drop(last_slice);
    assert!(staged.directory(32).is_ok());
    drop((
        old_cursor,
        tail_cursor,
        replay,
        first_source,
        tail_source,
        arena,
    ));
    drop((budget, work, source));
    execution.finish();
    root.shutdown().await.unwrap();
    drop(root);
    let namespaces = RootNamespaces {
        ownership: directory.path().join("owners"),
        control: directory.path().join("control"),
    };
    let reopened = RootStore::open(Arc::new(
        RootOwner::open(&directory.path().join("root"), &namespaces).unwrap(),
    ))
    .await
    .unwrap();
    reopened.shutdown().await.unwrap();
}

#[tokio::test]
async fn failed_file_conversion_keeps_the_captured_prefix_and_can_retry() {
    let directory = tempfile::tempdir().unwrap();
    let (root, source, execution) = source(directory.path()).await;
    let resources = resources();
    let staged = resources.reserve_staging(32).await.unwrap();
    let lease = staged.directory(32).unwrap();
    let captured = source.clone();
    let resource = source.reserve_local_resource().unwrap();
    let retry_resource = source.reserve_local_resource().unwrap();
    let readonly_path = directory.path().join("readonly");
    std::fs::write(&readonly_path, b"unchanged").unwrap();
    source
        .with_local_io(move || {
            let mut builder = RequestBackingBuilder::resident(captured.clone(), lease)?;
            let range = builder.append_bytes("captured 🦀".as_bytes())?;
            builder.seal_prefix()?;
            let mut candidate = RequestBackingBuilder::file(captured, resource)?;
            let Some(Building::File { file, .. }) = candidate.storage.as_mut() else {
                unreachable!()
            };
            let readonly = File::open(readonly_path)?;
            close_request_file(std::mem::replace(file, readonly))?;
            assert!(builder.copy_to_file(candidate).is_err());
            let mut original = [0; 13];
            builder.read_exact_at(0, &mut original)?;
            assert_eq!(&original, "captured 🦀".as_bytes());
            assert!(builder.write_at(0, b"X").is_err());
            builder.promote_to_file(retry_resource)?;
            assert!(builder.write_at(0, b"X").is_err());
            builder.append_bytes(b" appended")?;
            let mut preserved = [0; 13];
            builder.read_exact_at(range.start, &mut preserved)?;
            assert_eq!(&preserved, "captured 🦀".as_bytes());
            builder.abort_in_worker()?;
            Ok(())
        })
        .await
        .unwrap();
    drop(source);
    execution.finish();
    root.shutdown().await.unwrap();
}

#[tokio::test]
async fn append_session_keeps_chunked_output_contiguous_and_allows_control_reads() {
    let directory = tempfile::tempdir().unwrap();
    let (root, source, execution) = source(directory.path()).await;
    let arena = CaptureArena::new(source.clone(), None).await.unwrap();
    let append = arena.begin_append().await;
    let table = append
        .with_writer(|builder| builder.reserve_zeroed(16))
        .await
        .unwrap();
    assert_eq!(
        arena
            .read_control_owned::<16>(table.start, Arc::new(source.clone()))
            .await
            .unwrap(),
        [0; 16]
    );
    let first = append
        .with_writer(|builder| builder.append_bytes(b"alpha"))
        .await
        .unwrap();
    let mut competing = Box::pin(arena.with_writer(|builder| builder.append_bytes(b"other")));
    assert!(futures_util::poll!(&mut competing).is_pending());
    let second = append
        .with_writer(|builder| builder.append_bytes(b"beta"))
        .await
        .unwrap();
    assert_eq!(second.start, first.end);
    append
        .with_writer(move |builder| builder.write_at(table.start, &9_u64.to_le_bytes()))
        .await
        .unwrap();
    assert_eq!(
        u64::from_le_bytes(
            arena
                .read_control_owned::<8>(table.start, Arc::new(source.clone()))
                .await
                .unwrap()
        ),
        9
    );
    assert!(futures_util::poll!(&mut competing).is_pending());
    drop(append);
    let competing = competing.await.unwrap();
    assert_eq!(competing.start, second.end);
    arena.seal().await.unwrap();
    let resources = resources();
    let work = resources.acquire_work().await.unwrap();
    let budget = work.budget();
    let mut cursor = arena.pending(first.start..second.end).open(budget.clone());
    let read = cursor
        .read_chunk(budget.allocate(16).await.unwrap())
        .await
        .unwrap();
    assert_eq!(&read.buffer.as_ref()[..read.bytes_read], b"alphabeta");
    drop((read, cursor, budget, work));
    arena.close().await.unwrap();
    drop((arena, source));
    execution.finish();
    root.shutdown().await.unwrap();
    drop(root);
    reopen(directory.path()).await;
}

#[tokio::test]
async fn metadata_read_keeps_its_owner_on_the_worker_after_observer_is_dropped() {
    struct ReadOwner {
        charge: Option<DirectoryLease>,
        observer_thread: std::thread::ThreadId,
        entered: Option<tokio::sync::oneshot::Sender<bool>>,
        release: Option<tokio::sync::oneshot::Receiver<()>>,
        finished: Option<tokio::sync::oneshot::Sender<()>>,
    }
    impl Drop for ReadOwner {
        fn drop(&mut self) {
            let on_observer = std::thread::current().id() == self.observer_thread;
            let _ = self.entered.take().unwrap().send(on_observer);
            // Only the original SQL worker may wait at this test gate. A bad
            // observer-side drop reports failure without blocking the executor.
            if !on_observer {
                let _ = self.release.take().unwrap().blocking_recv();
            }
            drop(self.charge.take());
            let _ = self.finished.take().unwrap().send(());
        }
    }
    let directory = tempfile::tempdir().unwrap();
    let (root, source, execution) = source(directory.path()).await;
    let arena = CaptureArena::new(source.clone(), None).await.unwrap();
    let table = arena
        .with_writer(|builder| builder.reserve_zeroed(8))
        .await
        .unwrap();
    arena.seal().await.unwrap();
    let resources = resources();
    let active = resources
        .reserve_staging(32)
        .await
        .unwrap()
        .promote(32)
        .await
        .unwrap();
    let (entered, in_worker) = tokio::sync::oneshot::channel();
    let (release, released) = tokio::sync::oneshot::channel();
    let (finished, complete) = tokio::sync::oneshot::channel();
    let owner = Arc::new(ReadOwner {
        charge: Some(active.directory(32).unwrap()),
        observer_thread: std::thread::current().id(),
        entered: Some(entered),
        release: Some(released),
        finished: Some(finished),
    });
    drop(active);
    let mut competing = Box::pin(resources.reserve_staging(32).await.unwrap().promote(32));
    let (previous_entered, previous_started) = tokio::sync::oneshot::channel();
    let (previous_release, previous_released) = tokio::sync::oneshot::channel();
    let mut previous = Box::pin(source.with_local_io(move || {
        let _ = previous_entered.send(());
        previous_released
            .blocking_recv()
            .map_err(io::Error::other)?;
        Ok(())
    }));
    tokio::select! {
        result = &mut previous => panic!("preceding callback finished before release: {result:?}"),
        result = previous_started => result.unwrap(),
    }
    let mut observer = Box::pin(arena.read_control_owned::<8>(table.start, owner));
    // The preceding callback holds read admission, so Pending cannot mean accepted.
    assert!(futures_util::poll!(&mut observer).is_pending());
    previous_release.send(()).unwrap();
    previous.await.unwrap();
    let on_observer = tokio::select! {
        result = &mut observer => panic!("metadata observer finished before owner release: {result:?}"),
        result = tokio::time::timeout(std::time::Duration::from_secs(5), in_worker) => {
            result.expect("metadata owner must reach the original worker").unwrap()
        }
    };
    assert!(!on_observer);
    assert!(futures_util::poll!(&mut competing).is_pending());
    drop(observer);
    assert!(futures_util::poll!(&mut competing).is_pending());
    release.send(()).unwrap();
    complete.await.unwrap();
    drop(competing.await.unwrap());
    arena.close().await.unwrap();
    drop((arena, source));
    execution.finish();
    root.shutdown().await.unwrap();
    drop(root);
    reopen(directory.path()).await;
}
