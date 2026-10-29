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

use maka_agent_facts::{
    event::{EventWrite, Fact, Invocation, InvocationOutcome, RuntimeEvent},
    history::semantic::Payload,
    input::InvocationInput,
    session::CopyPurpose,
};
use maka_event_log::{EventLog, bundle::StagedBundle, sessions::SessionCopy};
use serde_json::json;
use std::collections::BTreeMap;

async fn message(log: &EventLog, session: &str, run: &str, text: &str) {
    let invocation = Invocation {
        session_id: session.into(),
        turn_id: run.into(),
        run_id: run.into(),
        invocation_id: run.into(),
    };
    for fact in [
        Fact::InvocationOpened {
            configuration: None,
            input: InvocationInput::Message {
                content: text.into(),
                source_messages: Vec::new(),
                request_fingerprint: None,
            },
        },
        Fact::InvocationEnded {
            outcome: InvocationOutcome::Completed,
        },
    ] {
        log.append(&EventWrite::plain(RuntimeEvent::new(invocation.clone(), fact)).unwrap())
            .await
            .unwrap();
    }
}
async fn lineage_text(log: &EventLog) -> Vec<String> {
    let source = log
        .run_source("branch", "branch-run", None)
        .await
        .unwrap()
        .unwrap();
    let view = log.read_lineage_view(&source.boundary).await.unwrap();
    let page = log
        .context_semantic_rows(&view.selection, None, 128)
        .await
        .unwrap();
    assert!(page.next.is_none());
    log.context_semantic_resolve(&page.rows)
        .await
        .unwrap()
        .into_iter()
        .filter_map(|row| match row.payload {
            Some(Payload::User(input)) => Some(input.text),
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn imported_first_branch_message_keeps_inherited_lineage_before_and_after_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let source = EventLog::open(&dir.path().join("source.sqlite"))
        .await
        .unwrap();
    source
        .create_session("parent", "parent", &json!({}), 1)
        .await
        .unwrap();
    let parent_text = "inherited parent 漢字🙂\n\"question\" ".repeat(2048);
    let branch_text = "first branch 中文🦀\n\"question\" ".repeat(2048);
    assert!(parent_text.len() > 32 * 1024 && branch_text.len() > 32 * 1024);
    message(&source, "parent", "parent-run", &parent_text).await;
    let revision = source
        .get_session::<serde_json::Value>("parent")
        .await
        .unwrap()
        .unwrap()
        .revision;
    source
        .copy_session(
            SessionCopy {
                source_session_id: "parent".into(),
                target_session_id: "branch".into(),
                expected_source_revision: revision,
                purpose: CopyPurpose::Branch {
                    position: maka_agent_facts::session::ForkPosition::End,
                    side_conversation: false,
                },
            },
            &json!({}),
            2,
        )
        .await
        .unwrap();
    message(&source, "branch", "branch-run", &branch_text).await;
    let expected = vec![parent_text, branch_text];
    assert_eq!(lineage_text(&source).await, expected);
    let inventory = source.preview_bundle("branch").await.unwrap();
    let (bytes, _) = source
        .export_bundle("branch", &inventory.subtree_digest, Vec::new())
        .await
        .unwrap();
    source.close().await.unwrap();

    let path = dir.path().join("destination.sqlite");
    let destination = EventLog::open(&path).await.unwrap();
    // Relocation must also preserve the relationship after original positions shift.
    destination
        .create_session("local", "local", &json!({}), 1)
        .await
        .unwrap();
    message(
        &destination,
        "local",
        "local-run",
        "unrelated destination question",
    )
    .await;
    let staged = StagedBundle::read(bytes.as_slice()).await.unwrap();
    let bindings: BTreeMap<_, _> = staged
        .summary()
        .inventory
        .sessions
        .iter()
        .map(|session| (session.id.clone(), json!({})))
        .collect();
    destination
        .import_bundle(
            staged,
            &maka_agent_facts::artifact::content_digest(b"destination"),
            bindings,
        )
        .await
        .unwrap();
    assert_eq!(lineage_text(&destination).await, expected);
    destination.close().await.unwrap();
    let destination = EventLog::open(&path).await.unwrap();
    assert_eq!(lineage_text(&destination).await, expected);
    destination.close().await.unwrap();
}
