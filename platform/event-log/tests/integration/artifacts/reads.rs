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
use std::{
    sync::{Arc, mpsc},
    time::Duration,
};

#[tokio::test]
async fn full_artifact_snapshot_preserves_maximum_payload_empty_and_business_error() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("runtime.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    log.create_session("session", "create", &json!({}), 1)
        .await
        .unwrap();
    let bytes = vec![0x5a; 50 * 1024 * 1024];
    let expected = artifact("maximum", &bytes);
    log.commit_artifact(expected.clone(), bytes).await.unwrap();
    let observed = log
        .with_artifact(
            ArtifactReadScope::Session("session"),
            "maximum",
            |record, reader| {
                let mut buffer = [0u8; 64 * 1024];
                let mut total = 0;
                loop {
                    let count = reader.read(&mut buffer).unwrap();
                    if count == 0 {
                        break;
                    }
                    assert!(buffer[..count].iter().all(|&byte| byte == 0x5a));
                    total += count;
                }
                (record.clone(), total)
            },
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(observed, (expected, 50 * 1024 * 1024));
    let empty = artifact("empty", b"");
    log.commit_artifact(empty.clone(), Vec::new())
        .await
        .unwrap();
    assert_eq!(
        log.with_artifact(
            ArtifactReadScope::Session("session"),
            "empty",
            |record, reader| {
                let mut byte = [0u8; 1];
                assert_eq!(reader.read(&mut byte).unwrap(), 0);
                record.clone()
            }
        )
        .await
        .unwrap(),
        Some(empty)
    );
    assert!(
        log.with_artifact(
            ArtifactReadScope::Session("session"),
            "missing",
            |_, _| panic!("missing callback")
        )
        .await
        .unwrap()
        .is_none()
    );
    assert!(matches!(
        log.with_artifact(ArtifactReadScope::Session("missing"), "maximum", |_, _| ())
            .await,
        Err(StoreError::SessionNotFound)
    ));
    assert_eq!(
        log.with_artifact(
            ArtifactReadScope::Session("session"),
            "maximum",
            |_, reader| {
                let mut byte = [0];
                reader.read_exact(&mut byte).unwrap();
                assert_eq!(byte, [0x5a]);
                Err::<(), _>("domain refused")
            }
        )
        .await
        .unwrap(),
        Some(Err("domain refused"))
    );
    assert_eq!(
        log.read_artifact_chunk("session", "maximum", 49 * 1024 * 1024, 1)
            .await
            .unwrap()
            .unwrap()
            .bytes,
        [0x5a]
    );
    assert!(
        log.read_artifact_chunk("session", "maximum", 0, 0)
            .await
            .is_err()
    );
    let full = log
        .read_artifact_chunk("session", "maximum", 0, 50 * 1024 * 1024 + 1)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(full.bytes, vec![0x5a; 50 * 1024 * 1024]);
    assert_eq!(full.total_bytes, 50 * 1024 * 1024);
    assert!(
        log.read_artifact_chunk("session", "maximum", 1 << 53, 1)
            .await
            .is_err()
    );
    log.close().await.unwrap();
}

#[tokio::test]
async fn dropped_artifact_waiter_retains_snapshot_capture_and_drains_queued_deletion() {
    #[derive(Debug)]
    struct Capture(Option<tokio::sync::oneshot::Sender<()>>);
    impl Drop for Capture {
        fn drop(&mut self) {
            let _ = self.0.take().unwrap().send(());
        }
    }
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("runtime.sqlite");
    let log = Arc::new(EventLog::open(&path).await.unwrap());
    log.create_session("session", "create", &json!({}), 1)
        .await
        .unwrap();
    log.commit_artifact(
        artifact("held", b"original bytes"),
        b"original bytes".to_vec(),
    )
    .await
    .unwrap();
    let (entered, waiting) = tokio::sync::oneshot::channel();
    let (release, gate) = mpsc::channel();
    let (dropped, mut capture_dropped) = tokio::sync::oneshot::channel();
    let capture = Capture(Some(dropped));
    let reader = log.clone();
    let waiter = tokio::spawn(async move {
        reader
            .with_artifact(
                ArtifactReadScope::Session("session"),
                "held",
                move |record, reader| {
                    assert_eq!(record.name, "file.bin");
                    entered.send(()).unwrap();
                    gate.recv_timeout(Duration::from_secs(10)).unwrap();
                    let mut bytes = Vec::new();
                    reader.read_to_end(&mut bytes).unwrap();
                    assert_eq!(bytes, b"original bytes");
                    capture
                },
            )
            .await
    });
    tokio::time::timeout(Duration::from_secs(10), waiting)
        .await
        .unwrap()
        .unwrap();
    waiter.abort();
    assert!(waiter.await.unwrap_err().is_cancelled());
    assert!(matches!(
        capture_dropped.try_recv(),
        Err(tokio::sync::oneshot::error::TryRecvError::Empty)
    ));
    let deletion = log.delete_user_artifact("session", "held");
    tokio::pin!(deletion);
    assert!(futures_util::poll!(&mut deletion).is_pending());
    let shutdown = log.shutdown();
    tokio::pin!(shutdown);
    assert!(futures_util::poll!(&mut shutdown).is_pending());
    assert!(matches!(
        EventLog::open(&path).await,
        Err(StoreError::WriterBusy)
    ));
    // The test's executor thread is distinct from the blocked store owner.
    release.send(()).unwrap();
    assert_eq!(deletion.await.unwrap(), ArtifactDeletion::Deleted);
    shutdown.await.unwrap();
    capture_dropped.await.unwrap();
    let reopened = EventLog::open(&path).await.unwrap();
    assert!(
        reopened
            .get_artifact("session", "held")
            .await
            .unwrap()
            .record
            .is_none()
    );
    reopened.close().await.unwrap();
}

#[tokio::test]
async fn artifact_callback_panic_closes_original_owner_instead_of_reusing_it() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("runtime.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    log.create_session("session", "create", &json!({}), 1)
        .await
        .unwrap();
    log.commit_artifact(artifact("panic", b"durable"), b"durable".to_vec())
        .await
        .unwrap();
    assert!(matches!(
        log.with_artifact::<()>(
            ArtifactReadScope::Session("session"),
            "panic",
            |_, reader| {
                let mut byte = [0];
                reader.read_exact(&mut byte).unwrap();
                assert_eq!(byte, [b'd']);
                panic!("controlled artifact callback panic");
            }
        )
        .await,
        Err(StoreError::OperationUnknown)
    ));
    log.shutdown().await.unwrap();
    assert!(matches!(
        log.get_artifact("session", "panic").await,
        Err(StoreError::ConnectionClosed)
    ));
    let reopened = EventLog::open(&path).await.unwrap();
    assert_eq!(
        reopened
            .read_artifact_chunk("session", "panic", 0, 7)
            .await
            .unwrap()
            .unwrap()
            .bytes,
        b"durable"
    );
    reopened.close().await.unwrap();
}
