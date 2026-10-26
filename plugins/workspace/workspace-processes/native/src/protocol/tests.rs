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
use maka_event_log::root::{RootNamespaces, RootOwner};
use serde_json::json;

#[tokio::test]
async fn dropped_post_drain_bookkeeping_releases_process_custody() {
    let directory = tempfile::tempdir().unwrap();
    let root = maka_event_log::RootStore::open(Arc::new(
        RootOwner::create(
            &directory.path().join("root"),
            &RootNamespaces {
                ownership: directory.path().join("owners"),
                control: directory.path().join("control"),
            },
        )
        .unwrap(),
    ))
    .await
    .unwrap();
    let session = root
        .create_session("process", "process", &json!({}), 1)
        .await
        .unwrap();
    let custody = ProcessCustody {
        lease: Some(session.execution_scope(None).await.unwrap().accept()),
        phase: ProcessPhase::Active,
    };
    let mut bookkeeping = Box::pin(async move {
        let mut custody = custody;
        // This is the transition made immediately after worker::run confirms
        // exit and joins every pipe/monitor, before the cleanup SQL await.
        custody.phase = ProcessPhase::Drained;
        futures_util::future::pending::<()>().await;
        drop(custody);
    });
    assert!(futures_util::poll!(&mut bookkeeping).is_pending());
    drop(bookkeeping);
    assert!(root.session("process").await.is_ok());
    tokio::time::timeout(std::time::Duration::from_secs(2), root.shutdown())
        .await
        .expect("drained process must release Root physical custody")
        .unwrap();
}
