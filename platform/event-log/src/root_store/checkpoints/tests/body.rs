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
use crate::sessions::{MaterialCollection, RemovalAuthority, RemoveFamilyResult};
use maka_agent_facts::{
    event::{
        EventWrite, Fact, Invocation, InvocationInput, InvocationOutcome, LogScope, RuntimeEvent,
    },
    tool_call::ToolCallIdentity,
    tool_output::{DurableToolProjection, ToolOutput, ToolSuccess},
};
use std::collections::BTreeMap;

#[tokio::test]
async fn checkpoint_keeps_tool_bytes_after_source_collection_and_import() {
    let directory = tempfile::tempdir().unwrap();
    let (store, handle, request) = fixture(directory.path()).await;
    let log = handle.session.scoped().await.unwrap();
    let invocation = Invocation {
        session_id: "source".into(),
        turn_id: "turn".into(),
        run_id: "run".into(),
        invocation_id: "invocation".into(),
    };
    let plain = |fact| EventWrite::plain(RuntimeEvent::new(invocation.clone(), fact)).unwrap();
    log.append(&plain(Fact::InvocationOpened {
        configuration: None,
        input: InvocationInput::Code {
            source: "fixture".into(),
        },
    }))
    .await
    .unwrap();
    log.append(&plain(Fact::ToolDispatched {
        presentation: None,
        title: None,
        operation_id: "read".into(),
        call: ToolCallIdentity::standalone("call".into()),
        name: "Read".into(),
        input: json!({}),
    }))
    .await
    .unwrap();
    let text = "checkpoint 汉🦀\n\\\"".repeat(4000);
    let result = EventWrite::tool_success(
        "result".into(),
        std::time::UNIX_EPOCH,
        invocation.clone(),
        "read".into(),
        ToolSuccess::projected(
            ToolOutput::Text(text.clone()),
            DurableToolProjection::Text { text: text.clone() },
        ),
    )
    .unwrap()
    .0;
    log.append(&result).await.unwrap();
    log.append(&plain(Fact::InvocationEnded {
        outcome: InvocationOutcome::Completed,
    }))
    .await
    .unwrap();
    let original = log
        .scoped_prefix(
            LogScope::Session {
                id: "source".into(),
            },
            usize::MAX,
            usize::MAX,
        )
        .await
        .unwrap()
        .events;
    drop(log);
    let value = handle.publish(request.clone()).await.unwrap();
    let head = published(&value);
    let log = handle.session.owner().unwrap();
    let revision = store
        .get_session::<serde_json::Value>("source")
        .await
        .unwrap()
        .unwrap()
        .revision;
    assert!(matches!(
        store
            .remove_session_family("source", revision, RemovalAuthority::Unmanaged)
            .await
            .unwrap(),
        RemoveFamilyResult::Accepted(_)
    ));
    store.finish_session_retirement("source").await.unwrap();
    while log.collect_session_material(None).await.unwrap() == MaterialCollection::Collected {}
    let bodies = log
        .connection
        .run(|db| {
            Box::pin(async move {
                Ok(
                    sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM event_bodies")
                        .fetch_one(db)
                        .await?,
                )
            })
        })
        .await
        .unwrap();
    assert_eq!(
        bodies, 0,
        "checkpoint bytes are independent of collected canonical material"
    );
    drop(log);
    store.close().await.unwrap();

    let store = RootStore::open(owner(directory.path())).await.unwrap();
    let handle = store.history_checkpoints("source", scope()).await.unwrap();
    assert_eq!(handle.receipt(request).await.unwrap(), Some(value));
    let checkout = handle.checkout_exact(head.revision).await.unwrap();
    let mut staged = StagedBundle::read(tokio::fs::File::from_std(checkout.bundle))
        .await
        .unwrap();
    staged.validate_history().await.unwrap();
    let destination_directory = tempfile::tempdir().unwrap();
    let destination = RootStore::open(owner(destination_directory.path()))
        .await
        .unwrap();
    let receipt = destination
        .import_bundle(
            staged,
            &maka_agent_facts::artifact::content_digest(b"checkpoint destination"),
            BTreeMap::from([("source".to_owned(), json!({"title":"restored"}))]),
        )
        .await
        .unwrap();
    let session = destination.session(&receipt.root_session_id).await.unwrap();
    assert_eq!(
        session
            .resolve_tool_result(&receipt.root_session_id, "result")
            .await
            .unwrap(),
        ToolOutput::Text(text)
    );
    let restored = session
        .scoped_prefix(
            LogScope::Session {
                id: receipt.root_session_id,
            },
            usize::MAX,
            usize::MAX,
        )
        .await
        .unwrap()
        .events;
    assert_eq!(
        serde_json::to_value(restored).unwrap(),
        serde_json::to_value(original).unwrap()
    );
    destination.close().await.unwrap();
    store.close().await.unwrap();
}
