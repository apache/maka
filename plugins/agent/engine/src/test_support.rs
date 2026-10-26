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

use maka_event_log::root::{RootNamespaces, RootOwner};
use maka_event_log::root_store::{RootStore, SessionStore};
use std::sync::Arc;

pub(super) async fn root() -> (tempfile::TempDir, RootStore) {
    let directory = tempfile::tempdir().unwrap();
    let owner = Arc::new(
        RootOwner::create(
            &directory.path().join("root"),
            &RootNamespaces {
                ownership: directory.path().join("ownership"),
                control: directory.path().join("control"),
            },
        )
        .unwrap(),
    );
    let root = RootStore::open(owner).await.unwrap();
    (directory, root)
}

pub(super) async fn session(root: &RootStore, id: &str) -> SessionStore {
    root.create_session(id, id, &serde_json::json!({}), 1)
        .await
        .unwrap();
    root.session(id).await.unwrap()
}
