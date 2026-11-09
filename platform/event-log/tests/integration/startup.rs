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

use maka_event_log::{
    ROOT_MIGRATIONS, RootStore, StoreError,
    root::{FileLease, ROOT_DATABASE, RootNamespaces, RootOwner},
};
use std::sync::Arc;

#[tokio::test]
async fn initialization_failure_closes_the_actual_sql_owner_before_returning() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("root");
    let namespaces = RootNamespaces {
        ownership: directory.path().join("owners"),
        control: directory.path().join("control"),
    };
    let owner = Arc::new(RootOwner::create(&root, &namespaces).unwrap());
    let store = RootStore::open(owner, ROOT_MIGRATIONS).await.unwrap();
    store.close().await.unwrap();
    let database = root.join(ROOT_DATABASE);
    let raw = rusqlite::Connection::open(&database).unwrap();
    raw.execute_batch("PRAGMA application_id=123;").unwrap();
    raw.close().unwrap();
    let owner = Arc::new(RootOwner::open_existing(&root, &namespaces).unwrap());
    let original = Arc::downgrade(&owner);
    let error = RootStore::open(owner, ROOT_MIGRATIONS).await.err().unwrap();
    assert!(matches!(error, StoreError::UnsupportedDatabase));
    assert!(
        original.upgrade().is_none(),
        "the real worker and startup owner must release their Root"
    );
    let mut lock = database.as_os_str().to_os_string();
    lock.push(".writer.lock");
    drop(FileLease::acquire(std::path::Path::new(&lock)).unwrap());
    drop(RootOwner::open_existing(&root, &namespaces).unwrap());
}
