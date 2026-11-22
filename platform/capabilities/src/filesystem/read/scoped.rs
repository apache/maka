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

fn scope() -> crate::call::Scope {
    crate::call::Issuer::default()
        .issue(
            crate::call::Identity::Remote {
                request_id: uuid::Uuid::new_v4(),
            },
            CancellationToken::new(),
        )
        .unwrap()
}

#[tokio::test]
async fn application_read_preserves_root_selection_and_closes_with_the_original_call() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("allowed"), "original").unwrap();
    std::fs::write(dir.path().join("secret"), "not granted").unwrap();
    let root = ReadRoot::open(dir.path())
        .await
        .unwrap()
        .select(BTreeSet::from(["allowed".into()]))
        .unwrap();
    let scope = scope();
    let view = root.bind_scope(&scope);
    let input = |path: &str| ReadFile {
        path: path.into(),
        offset: 0,
        limit: 64,
    };
    assert_eq!(
        view.read(input("allowed")).await.unwrap().bytes,
        b"original"
    );
    assert!(view.read(input("secret")).await.is_err());
    assert!(view.read(input("../secret")).await.is_err());
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink("secret", dir.path().join("allowed-link")).unwrap();
        assert!(view.read(input("allowed-link")).await.is_err());
    }
    assert!(scope.resources.seal().unwrap());
    assert!(matches!(
        view.read(input("allowed")).await,
        Err(ReadError::Retired)
    ));
}

#[tokio::test]
async fn dropping_application_read_waiter_does_not_release_its_running_worker() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("value"), "kept").unwrap();
    let root = ReadRoot::open(dir.path()).await.unwrap();
    let scope = scope();
    let view = root.bind_scope(&scope);
    let (started, start) = tokio::sync::oneshot::channel();
    let (release, released) = std::sync::mpsc::channel();
    let waiting = tokio::spawn(async move {
        view.with_reader(move |reader| {
            let bytes = reader
                .read(ReadFile {
                    path: "value".into(),
                    offset: 0,
                    limit: 64,
                })
                .unwrap()
                .bytes;
            started.send(()).unwrap();
            released.recv().unwrap();
            bytes
        })
        .await
    });
    start.await.unwrap();
    waiting.abort();
    assert!(waiting.await.unwrap_err().is_cancelled());
    scope.cancellation.cancel();
    assert!(!scope.resources.seal().unwrap());
    release.send(()).unwrap();
    scope.finish().await.unwrap();
    assert!(scope.resources.seal().unwrap());
}

#[tokio::test]
async fn application_pinned_file_retains_custody_until_handle_close() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("value"), "pinned").unwrap();
    let root = ReadRoot::open(dir.path()).await.unwrap();
    let scope = scope();
    let view = root.bind_scope(&scope);
    let file = view.open_file("value".to_owned().into()).await.unwrap();
    assert_eq!(
        file.read(ReadRange::default()).await.unwrap().bytes,
        b"pinned"
    );
    assert!(!scope.resources.seal().unwrap());
    file.close().await.unwrap();
    assert!(file.is_released());
    scope.finish().await.unwrap();
}
