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
use futures_util::future::BoxFuture;
use maka_plugins::{
    composition::Scope,
    fiber::Fiber,
    filesystem::{ReadRoot, entries::ReadFile},
    remote::{self, Caller, Error},
};

struct UnusedViews;
impl remote::Views for UnusedViews {
    fn authorize(
        &self,
        _: maka_plugins::authorization::Request,
    ) -> BoxFuture<'_, Result<maka_plugins::call::Owned, Error>> {
        unreachable!()
    }
    fn session(&self) -> BoxFuture<'_, Result<remote::SessionView, Error>> {
        unreachable!()
    }
    fn workspace(
        &self,
        _: remote::WorkspaceViewInput,
    ) -> BoxFuture<'_, Result<remote::SessionView, Error>> {
        unreachable!()
    }
    fn query_database(
        &self,
        _: maka_plugins::filesystem::database::Read,
    ) -> BoxFuture<
        '_,
        Result<
            Vec<maka_plugins::filesystem::database::Table>,
            maka_plugins::filesystem::database::Error,
        >,
    > {
        unreachable!()
    }
}
fn caller() -> Caller {
    Caller {
        connection_id: uuid::Uuid::new_v4(),
        client_instance_id: "read-handle-test".into(),
        document_id: uuid::Uuid::new_v4(),
        session_id: None,
        access: remote::Access::Granted,
        views: Arc::new(UnusedViews),
        resources: Arc::default(),
        cancellation: CancellationToken::new(),
    }
}

#[tokio::test]
async fn read_handles_follow_their_borrower_or_remote_owner_without_inventory_limit() {
    let directory = tempfile::tempdir().unwrap();
    std::fs::write(directory.path().join("allowed"), b"contents").unwrap();
    std::fs::write(directory.path().join("private"), b"secret").unwrap();
    let owner = Fiber::new("example.views", "read-test", Scope::Profile).unwrap();
    owner.begin_loading().unwrap();
    owner.ready().unwrap();
    owner.publish().unwrap();
    let root = ReadRoot::open(directory.path())
        .await
        .unwrap()
        .select(["allowed".into()].into())
        .unwrap();
    let calls = Arc::new(Calls::new(Default::default()));
    let first = calls.enter_remote(caller()).unwrap();
    let second = calls.enter_remote(caller()).unwrap();
    let first_view = root.bind(owner.context(), first.cancellation.clone());
    let second_view = root.bind(owner.context(), second.cancellation.clone());
    let first_handles = (0..130)
        .map(|_| calls.remote_read(&first.id, first_view.clone()).unwrap())
        .collect::<Vec<_>>();
    let second_handle = calls.remote_read(&second.id, second_view.clone()).unwrap();
    let borrowed = (0..130)
        .map(|_| {
            calls
                .borrow_read(root.bind(owner.context(), CancellationToken::new()))
                .unwrap()
        })
        .collect::<Vec<_>>();
    let all = first_handles
        .iter()
        .cloned()
        .chain([second_handle.clone()])
        .chain(borrowed.iter().map(|guard| guard.id.clone()))
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(
        all.len(),
        261,
        "every retained capability has its own identity"
    );
    for id in &all {
        assert!(calls.read(id).is_ok());
    }
    let read = |path: &str, limit| ReadFile {
        path: path.into(),
        offset: 0,
        limit,
    };
    assert!(
        calls
            .read(&first_handles[0])
            .unwrap()
            .read(read("allowed", 1))
            .await
            .is_ok()
    );
    assert!(
        calls
            .read(&first_handles[0])
            .unwrap()
            .read(read("private", 1))
            .await
            .is_err()
    );
    assert!(
        calls
            .read(&first_handles[0])
            .unwrap()
            .read(read("allowed", 1024 * 1024 + 1))
            .await
            .is_err()
    );
    first.cancellation.cancel();
    assert!(calls.remote_read(&first.id, first_view.clone()).is_err());
    assert!(
        calls
            .remote_read("foreign-authority", second_view.clone())
            .is_err()
    );
    assert!(calls.remote(&first.id).is_err());
    assert!(
        calls
            .read(&first_handles[0])
            .unwrap()
            .read(read("allowed", 1))
            .await
            .is_err()
    );
    let first_authority = first.id.clone();
    drop(first);
    for id in &first_handles {
        assert!(calls.read(id).is_err());
    }
    assert!(calls.remote_read(&first_authority, first_view).is_err());
    assert!(calls.remote(&second.id).is_ok());
    assert!(
        calls
            .read(&second_handle)
            .unwrap()
            .read(read("allowed", 1))
            .await
            .is_ok()
    );
    for guard in &borrowed {
        assert!(calls.read(&guard.id).is_ok());
    }
    let borrowed_ids = borrowed
        .iter()
        .map(|guard| guard.id.clone())
        .collect::<Vec<_>>();
    drop(borrowed);
    for id in &borrowed_ids {
        assert!(calls.read(id).is_err());
    }
    assert!(calls.read(&second_handle).is_ok());
    drop(second);
    assert!(calls.read(&second_handle).is_err());
    assert!(calls.reads.lock().unwrap().is_empty());
    assert!(calls.remotes.lock().unwrap().is_empty());
}
