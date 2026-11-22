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
use std::io::Write;
use tokio::sync::mpsc;

fn fixture_source(temp: &tempfile::TempDir, digit: char) -> Source {
    Source::for_root(
        &digit.to_string().repeat(64),
        &RootNamespaces {
            ownership: temp.path().join("owners"),
            control: temp.path().join("control"),
        },
    )
    .unwrap()
}
fn tail() -> HostLogRequest {
    HostLogRequest {
        position: HostLogPosition::Tail,
    }
}
fn after(cursor: HostLogCursor) -> HostLogRequest {
    HostLogRequest {
        position: HostLogPosition::After { cursor },
    }
}
fn data(page: HostLogPage) -> (HostLogCursor, Vec<u8>, Option<HostLogReset>, bool, bool) {
    match page {
        HostLogPage::Data {
            cursor,
            bytes,
            reset,
            truncated,
            has_more,
        } => (
            cursor,
            STANDARD.decode(bytes).unwrap(),
            reset,
            truncated,
            has_more,
        ),
        HostLogPage::Missing => panic!("expected captured file"),
    }
}

#[tokio::test]
async fn bounded_binary_tail_and_forward_cursor_preserve_exact_bytes() {
    let temp = tempfile::tempdir().unwrap();
    let source = fixture_source(&temp, 'a');
    assert_eq!(source.read(tail()).await.unwrap(), HostLogPage::Missing);
    assert!(
        !source.path().parent().unwrap().exists(),
        "read must not create a directory"
    );
    let mut writer = source.open_capture().unwrap();
    let (_, empty, reset, truncated, more) = data(source.read(tail()).await.unwrap());
    assert!(empty.is_empty());
    assert_eq!((reset, truncated, more), (None, false, false));
    let initial: Vec<_> = (0..RAW_LIMIT + 17).map(|i| i as u8).collect();
    writer.write_all(&initial).unwrap();
    let page = source.read(tail()).await.unwrap();
    assert!(serde_json::to_vec(&page).unwrap().len() <= 48 * 1024);
    let (cursor, bytes, reset, truncated, more) = data(page);
    assert_eq!(bytes, initial[17..]);
    assert_eq!((reset, truncated, more), (None, true, false));
    let later: Vec<_> = (0..RAW_LIMIT + 9).map(|i| (i % 251) as u8).collect();
    writer.write_all(&later).unwrap();
    let serialized = serde_json::to_string(&after(cursor)).unwrap();
    let request = serde_json::from_str(&serialized).unwrap();
    let (cursor, bytes, reset, truncated, more) = data(source.read(request).await.unwrap());
    assert_eq!(bytes, later[..RAW_LIMIT]);
    assert_eq!((reset, truncated, more), (None, false, true));
    let (cursor, bytes, reset, truncated, more) = data(source.read(after(cursor)).await.unwrap());
    assert_eq!(bytes, later[RAW_LIMIT..]);
    assert_eq!((reset, truncated, more), (None, false, false));
    // Deliberately split a UTF-8 sequence and include invalid UTF-8. Cursors
    // address raw bytes, not independently decoded text chunks.
    writer.write_all(&[0xe4, 0xb8]).unwrap();
    let (cursor, bytes, ..) = data(source.read(after(cursor)).await.unwrap());
    assert_eq!(bytes, [0xe4, 0xb8]);
    writer.write_all(&[0xad, 0xff, 0]).unwrap();
    let (_, bytes, ..) = data(source.read(after(cursor)).await.unwrap());
    assert_eq!(bytes, [0xad, 0xff, 0]);
}

#[tokio::test]
async fn replacement_shrink_and_foreign_or_invalid_requests_are_explicit() {
    let temp = tempfile::tempdir().unwrap();
    let source = fixture_source(&temp, 'b');
    source
        .open_capture()
        .unwrap()
        .write_all(b"original-long")
        .unwrap();
    let (cursor, ..) = data(source.read(tail()).await.unwrap());
    let parked = source.path().with_extension("old");
    std::fs::rename(source.path(), &parked).unwrap();
    assert_eq!(
        source.read(after(cursor.clone())).await.unwrap(),
        HostLogPage::Missing
    );
    source
        .open_capture()
        .unwrap()
        .write_all(b"replacement")
        .unwrap();
    let (cursor, bytes, reset, _, _) = data(source.read(after(cursor)).await.unwrap());
    assert_eq!(bytes, b"replacement");
    assert_eq!(reset, Some(HostLogReset::Replaced));
    let mut writer = std::fs::OpenOptions::new()
        .write(true)
        .open(source.path())
        .unwrap();
    writer.set_len(0).unwrap();
    writer.write_all(b"new").unwrap();
    let (cursor, bytes, reset, _, _) = data(source.read(after(cursor)).await.unwrap());
    assert_eq!(bytes, b"new");
    assert_eq!(reset, Some(HostLogReset::Truncated));
    let other = fixture_source(&temp, 'c');
    assert_eq!(
        other.read(after(cursor)).await.unwrap_err().kind(),
        io::ErrorKind::InvalidInput
    );
    for input in ["bad".to_owned(), "a".repeat(513)] {
        assert!(input.parse::<HostLogCursor>().is_err());
    }
    assert!(
        serde_json::from_value::<HostLogRequest>(
            serde_json::json!({"position":{"kind":"tail"},"path":"/tmp/secret"})
        )
        .is_err()
    );
    assert!(
        Source::for_root(
            "../other",
            &RootNamespaces {
                ownership: temp.path().into(),
                control: temp.path().into()
            }
        )
        .is_err()
    );
}

#[tokio::test]
async fn watch_retains_cursor_across_missing_and_settles_idle_cancellation() {
    let temp = tempfile::tempdir().unwrap();
    let source = fixture_source(&temp, 'd');
    source.open_capture().unwrap().write_all(b"before").unwrap();
    let (cursor, ..) = data(source.read(tail()).await.unwrap());
    let parked = source.path().with_extension("parked");
    std::fs::rename(source.path(), &parked).unwrap();
    let cancel = CancellationToken::new();
    let watching = source.clone();
    let cancellation = cancel.clone();
    // A bounded delivery lane proves watch does not rely on unbounded buffering.
    let (send, mut receive) = mpsc::channel(1);
    let task = tokio::spawn(async move {
        watching
            .watch(after(cursor), cancellation, |page| {
                let send = send.clone();
                async move { send.send(page).await.map_err(io::Error::other) }
            })
            .await
    });
    let first = tokio::time::timeout(Duration::from_secs(3), receive.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(first, HostLogPage::Missing);
    let mut writer = std::fs::OpenOptions::new()
        .append(true)
        .open(&parked)
        .unwrap();
    writer.write_all(b"after").unwrap();
    std::fs::rename(&parked, source.path()).unwrap();
    let next = tokio::time::timeout(Duration::from_secs(3), receive.recv())
        .await
        .unwrap()
        .unwrap();
    let (_, bytes, reset, _, _) = data(next);
    assert_eq!(
        bytes, b"after",
        "missing must not discard the original byte cursor"
    );
    assert_eq!(reset, None);
    cancel.cancel();
    tokio::time::timeout(Duration::from_secs(3), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(receive.recv().await.is_none());
}

#[tokio::test]
async fn source_does_not_keep_root_ownership_alive() {
    let temp = tempfile::tempdir().unwrap();
    let namespaces = RootNamespaces {
        ownership: temp.path().join("owners"),
        control: temp.path().join("control"),
    };
    let root_path = temp.path().join("root");
    let owner = RootOwner::create(&root_path, &namespaces).unwrap();
    let source = Source::from_owner(&owner).unwrap();
    drop(owner);
    let reopened = RootOwner::open(&root_path, &namespaces).unwrap();
    source
        .open_capture()
        .unwrap()
        .write_all(b"still readable")
        .unwrap();
    assert_eq!(
        data(source.read(tail()).await.unwrap()).1,
        b"still readable"
    );
    drop(reopened);
}

#[cfg(unix)]
#[tokio::test]
async fn reads_reject_nonprivate_files_links_and_symlink_directories() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let temp = tempfile::tempdir().unwrap();
    let source = fixture_source(&temp, 'e');
    source
        .open_capture()
        .unwrap()
        .write_all(b"private")
        .unwrap();
    std::fs::set_permissions(source.path(), std::fs::Permissions::from_mode(0o644)).unwrap();
    assert!(source.read(tail()).await.is_err());
    assert_eq!(
        std::fs::metadata(source.path())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o644,
        "reader must not chmod"
    );
    std::fs::set_permissions(source.path(), std::fs::Permissions::from_mode(0o600)).unwrap();
    let link = source.path().with_extension("link");
    std::fs::hard_link(source.path(), &link).unwrap();
    assert!(source.read(tail()).await.is_err());
    assert!(source.open_capture().is_err());
    std::fs::remove_file(&link).unwrap();
    std::fs::rename(source.path(), &link).unwrap();
    symlink(&link, source.path()).unwrap();
    assert!(source.read(tail()).await.is_err());
    assert!(source.open_capture().is_err());
    std::fs::remove_file(source.path()).unwrap();
    std::fs::rename(&link, source.path()).unwrap();
    let parent = source.path().parent().unwrap();
    std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(source.read(tail()).await.is_err());
    assert_eq!(
        std::fs::metadata(parent).unwrap().permissions().mode() & 0o777,
        0o755
    );
    std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700)).unwrap();
    let moved = parent.with_extension("old");
    std::fs::rename(parent, &moved).unwrap();
    symlink(&moved, parent).unwrap();
    assert!(source.read(tail()).await.is_err());
}
