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

use maka_agent_facts::event::EventWrite;
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::Invocation;
use maka_agent_facts::event::LogScope;
use maka_agent_facts::event::RuntimeEvent;
use maka_event_log::{EventLog, StoreError};
use serde_json::json;

fn scope(id: &str) -> LogScope {
    LogScope::Session { id: id.into() }
}

fn opening(session: &str, invocation: &str, message: &str) -> RuntimeEvent {
    RuntimeEvent::new(
        Invocation {
            session_id: session.into(),
            turn_id: invocation.into(),
            run_id: invocation.into(),
            invocation_id: invocation.into(),
        },
        Fact::InvocationOpened {
            configuration: None,
            input: maka_agent_facts::input::InvocationInput::Message {
                source_messages: Vec::new(),
                content: message.into(),
                request_fingerprint: None,
            },
        },
    )
}

#[tokio::test]
async fn session_bounds_and_evidence_exclude_unrelated_history() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("events.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    let first = opening("wanted", "first", "small");
    let exact_bytes = serde_json::to_vec(&first).unwrap().len();
    log.append(&EventWrite::plain((first).clone()).unwrap())
        .await
        .unwrap();
    let before = log
        .scoped_prefix(scope("wanted"), 1, exact_bytes)
        .await
        .unwrap();
    let global = log.prefix(1, exact_bytes).await.unwrap();
    assert_eq!(global.high_water, before.high_water);
    assert_eq!(global.scope, LogScope::Root);
    assert_ne!(
        global.digest, before.digest,
        "scope binds otherwise identical events"
    );

    log.append(
        &EventWrite::plain((opening("other", "large", &"x".repeat(16_384))).clone()).unwrap(),
    )
    .await
    .unwrap();
    assert!(matches!(
        log.prefix(1, usize::MAX).await,
        Err(StoreError::PrefixTooLarge)
    ));
    assert!(matches!(
        log.prefix(10, exact_bytes).await,
        Err(StoreError::PrefixTooLarge)
    ));
    let after = log
        .scoped_prefix(scope("wanted"), 1, exact_bytes)
        .await
        .unwrap();
    assert_eq!(after.scope, scope("wanted"));
    assert_eq!(after.high_water, before.high_water);
    assert_eq!(after.digest, before.digest);
    assert_eq!(after.events.len(), 1);
    assert_eq!(after.events[0].event, first);
    assert!(matches!(
        log.scoped_prefix(scope("wanted"), 0, exact_bytes).await,
        Err(StoreError::PrefixTooLarge)
    ));
    assert!(matches!(
        log.scoped_prefix(scope("wanted"), 1, exact_bytes - 1).await,
        Err(StoreError::PrefixTooLarge)
    ));

    let second = RuntimeEvent::new(
        first.invocation.clone(),
        Fact::ToolDispatched {
            presentation: None,
            title: None,
            operation_id: "tool-1".into(),
            call: maka_agent_facts::tool_call::ToolCallIdentity::standalone("tool-1-call".into()),
            name: "read_file".into(),
            input: json!({}),
        },
    );
    let sequence = log
        .append(&EventWrite::plain((second).clone()).unwrap())
        .await
        .unwrap();
    let updated = log.scoped_prefix(scope("wanted"), 2, 16_384).await.unwrap();
    assert_eq!(updated.high_water, sequence);
    assert_eq!(
        updated
            .events
            .iter()
            .map(|event| event.sequence)
            .collect::<Vec<_>>(),
        vec![1, 3]
    );
    assert_ne!(updated.digest, before.digest);
    assert!(matches!(
        log.scoped_prefix(scope("wanted"), 1, 16_384).await,
        Err(StoreError::PrefixTooLarge)
    ));
    log.close().await.unwrap();
    let reopened = EventLog::open(&path)
        .await
        .unwrap()
        .scoped_prefix(scope("wanted"), 2, 16_384)
        .await
        .unwrap();
    assert_eq!(updated.digest, reopened.digest);
    assert_eq!(updated.high_water, reopened.high_water);
}

#[tokio::test]
async fn empty_scopes_remain_distinct_and_invalid_session_ids_are_rejected() {
    let directory = tempfile::tempdir().unwrap();
    let log = EventLog::open(&directory.path().join("events.sqlite"))
        .await
        .unwrap();
    let first = log.scoped_prefix(scope("first"), 0, 0).await.unwrap();
    let second = log.scoped_prefix(scope("second"), 0, 0).await.unwrap();
    let root = log.prefix(0, 0).await.unwrap();
    assert_eq!(first.high_water, 0);
    assert!(first.events.is_empty());
    assert_ne!(first.digest, second.digest);
    assert_ne!(first.digest, root.digest);
    log.append(&EventWrite::plain((opening("other", "other", "unrelated")).clone()).unwrap())
        .await
        .unwrap();
    assert_eq!(
        first.digest,
        log.scoped_prefix(scope("first"), 0, 0)
            .await
            .unwrap()
            .digest
    );
    let long_id = "a".repeat(129);
    let long = log
        .scoped_prefix(scope(&long_id), 10, 16_384)
        .await
        .unwrap();
    assert_eq!(long.high_water, 0);
    assert!(long.events.is_empty());
    assert_ne!(long.digest, first.digest);
    assert_eq!(
        long.digest,
        log.scoped_prefix(scope(&long_id), 10, 16_384)
            .await
            .unwrap()
            .digest
    );
    for id in ["", "bad/id"] {
        assert!(matches!(
            log.scoped_prefix(scope(id), 10, 16_384).await,
            Err(StoreError::InvalidTransition(_))
        ));
    }
}
