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
    root::{RootNamespaces, RootOwner},
    root_store::{RootStore, SessionWorkLease, WorkEffects},
};

async fn source(
    path: &std::path::Path,
) -> (RootStore, PreparationIo, SessionWorkLease, WorkEffects) {
    let namespaces = RootNamespaces {
        ownership: path.join("owners"),
        control: path.join("control"),
    };
    let root = RootStore::open(
        Arc::new(RootOwner::create(&path.join("root"), &namespaces).unwrap()),
        &crate::history::test_support::catalog(),
    )
    .await
    .unwrap();
    root.create_session("session", "create", &serde_json::json!({}), 1)
        .await
        .unwrap();
    let session = root.session("session").await.unwrap();
    let (lease, effects) = session
        .work_scope(None)
        .await
        .unwrap()
        .accept(tokio_util::sync::CancellationToken::new());
    let io = PreparationIo::new(&lease.store()).unwrap();
    (root, io, lease, effects)
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
async fn file_regions_replay_from_native_offsets_and_close_before_the_resource_settles() {
    let directory = tempfile::tempdir().unwrap();
    let (root, source, execution, effects) = source(directory.path()).await;
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
    effects.settle().await.unwrap();
    execution.finish();
    root.shutdown().await.unwrap();
}

async fn reopen(path: &std::path::Path) {
    let namespaces = RootNamespaces {
        ownership: path.join("owners"),
        control: path.join("control"),
    };
    let reopened = RootStore::open(
        Arc::new(RootOwner::open_existing(&path.join("root"), &namespaces).unwrap()),
        &crate::history::test_support::catalog(),
    )
    .await
    .unwrap();
    reopened.shutdown().await.unwrap();
}

#[tokio::test]
async fn failed_append_and_normal_cancellation_abort_on_the_original_worker_and_permit_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let (root, source, execution, effects) = source(directory.path()).await;
    let arena = CaptureArena::new(source.clone(), None).await.unwrap();
    let readonly_path = directory.path().join("readonly");
    arena
        .with_writer(move |builder| {
            std::fs::write(&readonly_path, b"readonly")?;
            let readonly = File::open(readonly_path)?;
            let Some(Building::File { file, .. }) = builder.storage.as_mut() else {
                unreachable!()
            };
            maka_event_log::root_store::close_request_file(std::mem::replace(file, readonly))
                .map_err(io::Error::other)?;
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
    effects.settle().await.unwrap();
    execution.finish();
    root.shutdown().await.unwrap();
    drop(root);
    reopen(directory.path()).await;
}

#[tokio::test]
async fn last_derived_file_owner_closes_on_the_original_worker_and_permits_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let (root, original_io, execution, effects) = source(directory.path()).await;
    let workers = tokio_util::task::TaskTracker::new();
    let physical = crate::cleanup::Evidence::default();
    let io =
        PreparationIo::new_tracked(&execution.store(), workers.clone(), physical.clone()).unwrap();
    drop(original_io);
    let arena = CaptureArena::new(io.clone(), None).await.unwrap();
    let range = arena
        .with_writer(|builder| builder.append_bytes(b"original material"))
        .await
        .unwrap();
    arena.seal().await.unwrap();
    let bytes = arena.pending(range);
    drop(arena);
    let resources = resources();
    let work = resources.acquire_work().await.unwrap();
    let budget = work.budget();
    let mut cursor = bytes.open(budget.clone());
    let read = cursor
        .read_chunk(budget.allocate(32).await.unwrap())
        .await
        .unwrap();
    assert_eq!(
        &read.buffer.as_ref()[..read.bytes_read],
        b"original material"
    );
    assert!(read.eof);
    drop((read, cursor, bytes, budget, work, io));
    workers.close();
    tokio::time::timeout(std::time::Duration::from_secs(5), workers.wait())
        .await
        .expect("original source must await its last file close");
    assert!(physical.confirmed());
    tokio::time::timeout(std::time::Duration::from_secs(5), effects.settle())
        .await
        .expect("original cleanup must settle")
        .unwrap();
    execution.finish();
    root.shutdown().await.unwrap();
    drop(root);
    reopen(directory.path()).await;
}

#[tokio::test]
async fn append_session_keeps_chunked_output_contiguous_and_allows_control_reads() {
    let directory = tempfile::tempdir().unwrap();
    let (root, source, execution, effects) = source(directory.path()).await;
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
    effects.settle().await.unwrap();
    execution.finish();
    root.shutdown().await.unwrap();
    drop(root);
    reopen(directory.path()).await;
}

#[tokio::test]
async fn resident_limits_survive_promotion_and_read_buffers_retain_the_original_charge() {
    let directory = tempfile::tempdir().unwrap();
    let (root, io, execution, effects) = source(directory.path()).await;
    let resources = resources();
    let staged = resources.reserve_staging(32).await.unwrap();
    let arena = CaptureArena::new(io.clone(), Some(staged.directory(32).unwrap()))
        .await
        .unwrap();
    let error = arena
        .with_writer(|builder| builder.append_bytes(&[0; 33]))
        .await
        .unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::OutOfMemory);
    let range = arena
        .with_writer(|builder| builder.append_bytes(b"alpha"))
        .await
        .unwrap();
    assert_eq!(range, 0..5);
    arena.seal().await.unwrap();
    let work = resources.acquire_work().await.unwrap();
    let budget = work.budget();
    let mut cursor = arena.pending(range).open(budget.clone());
    let read = cursor
        .read_chunk(budget.allocate(5).await.unwrap())
        .await
        .unwrap();
    assert_eq!(&read.buffer.as_ref()[..read.bytes_read], b"alpha");
    drop(cursor);

    arena.promote_to_file().await.unwrap();
    assert!(staged.directory(32).is_err());
    drop(read);
    drop(staged.directory(32).unwrap());
    arena
        .with_writer(|builder| builder.append_bytes(b"beta"))
        .await
        .unwrap();
    arena.seal().await.unwrap();
    let mut cursor = arena.pending(0..9).open(budget.clone());
    let read = cursor
        .read_chunk(budget.allocate(9).await.unwrap())
        .await
        .unwrap();
    assert_eq!(&read.buffer.as_ref()[..read.bytes_read], b"alphabeta");
    arena.close().await.unwrap();
    drop((read, cursor, budget, work, staged, arena, io));
    effects.settle().await.unwrap();
    execution.finish();
    root.shutdown().await.unwrap();
}
