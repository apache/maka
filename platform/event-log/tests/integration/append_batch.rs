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

use maka_agent_facts::event::CommitError;
use maka_agent_facts::event::EventWrite;
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::Invocation;
use maka_agent_facts::event::InvocationOutcome;
use maka_agent_facts::event::RuntimeEvent;
use maka_agent_facts::event::ToolOutcome;
use maka_event_log::EventLog;
use serde_json::{Value, json};

#[tokio::test]
async fn batch_rolls_back_every_fact_and_catalog_change_then_replays_exactly_after_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("events.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    let commits = log.subscribe_commits();
    log.create_session("session", "request", &json!({}), 1)
        .await
        .unwrap();
    let catalog = log.list_sessions::<Value>(None, None, 10).await.unwrap();
    let session = log.get_session::<Value>("session").await.unwrap();
    let invocation = Invocation {
        session_id: "session".into(),
        turn_id: "turn".into(),
        run_id: "run".into(),
        invocation_id: "invocation".into(),
    };
    let event = |fact| RuntimeEvent::new(invocation.clone(), fact);
    let opening = event(Fact::InvocationOpened {
        configuration: None,
        input: maka_agent_facts::input::InvocationInput::Message {
            source_messages: Vec::new(),
            content: "".into(),
            request_fingerprint: None,
        },
    });
    let settled = event(Fact::ToolSettled {
        operation_id: "call".into(),
        outcome: ToolOutcome::Failed {
            message: "not executed".into(),
        },
    });
    assert!(matches!(
        log.append_batch(
            &([opening.clone(), settled.clone()])
                .iter()
                .cloned()
                .map(EventWrite::plain)
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        )
        .await,
        Err(CommitError::Rejected(_))
    ));
    assert!(!commits.has_changed().unwrap());
    log.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    assert!(log.prefix(10, 16_384).await.unwrap().events.is_empty());
    assert_eq!(log.get_session::<Value>("session").await.unwrap(), session);
    assert_eq!(
        log.list_sessions::<Value>(None, None, 10)
            .await
            .unwrap()
            .revision,
        catalog.revision
    );

    log.append(&EventWrite::plain((opening).clone()).unwrap())
        .await
        .unwrap();
    let mut commits = log.subscribe_commits();
    let dispatched = event(Fact::ToolDispatched {
        presentation: None,
        title: None,
        operation_id: "call".into(),
        call: maka_agent_facts::tool_call::ToolCallIdentity::standalone("call-call".into()),
        name: "write_file".into(),
        input: json!({}),
    });
    let mut conflicting = opening.clone();
    conflicting.fact = Fact::InvocationOpened {
        configuration: None,
        input: maka_agent_facts::input::InvocationInput::Code {
            source: "different".into(),
        },
    };
    assert!(matches!(
        log.append_batch(
            &([dispatched.clone(), conflicting])
                .iter()
                .cloned()
                .map(EventWrite::plain)
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        )
        .await,
        Err(CommitError::Rejected(_))
    ));
    assert_eq!(log.prefix(10, 16_384).await.unwrap().events.len(), 1);
    assert!(!commits.has_changed().unwrap());
    let pair = [dispatched, settled];
    let sequences = log
        .append_batch(
            &(pair)
                .iter()
                .cloned()
                .map(EventWrite::plain)
                .collect::<Result<Vec<_>, _>>()
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(sequences.len(), 2);
    assert_eq!(sequences[1], sequences[0] + 1);
    assert!(commits.has_changed().unwrap());
    assert_eq!(*commits.borrow_and_update(), sequences[1]);
    // A replay mixed with a new terminal still validates and commits in order.
    let terminal = event(Fact::InvocationEnded {
        outcome: InvocationOutcome::Failed {
            model_failure: None,
            class: "host_interrupted".into(),
            message: None,
        },
    });
    let mixed = log
        .append_batch(
            &([pair[1].clone(), terminal])
                .iter()
                .cloned()
                .map(EventWrite::plain)
                .collect::<Result<Vec<_>, _>>()
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(mixed[0], sequences[1]);
    assert_eq!(mixed[1], sequences[1] + 1);
    let committed = log.prefix(10, 16_384).await.unwrap();
    let catalog = log.list_sessions::<Value>(None, None, 10).await.unwrap();
    log.close().await.unwrap();

    let log = EventLog::open(&path).await.unwrap();
    let commits = log.subscribe_commits();
    assert_eq!(
        log.append_batch(
            &(pair)
                .iter()
                .cloned()
                .map(EventWrite::plain)
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        )
        .await
        .unwrap(),
        sequences
    );
    assert_eq!(
        log.append_batch(
            &([pair[0].clone(), pair[0].clone()])
                .iter()
                .cloned()
                .map(EventWrite::plain)
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        )
        .await
        .unwrap(),
        vec![sequences[0]; 2]
    );
    assert!(log.append_batch(&[]).await.unwrap().is_empty());
    assert!(!commits.has_changed().unwrap());
    let reopened = log.prefix(10, 16_384).await.unwrap();
    assert_eq!(reopened.digest, committed.digest);
    assert_eq!(reopened.high_water, committed.high_water);
    assert!(
        reopened
            .project_invocation("invocation")
            .uncertain_operations
            .is_empty()
    );
    assert_eq!(
        log.list_sessions::<Value>(None, None, 10)
            .await
            .unwrap()
            .revision,
        catalog.revision
    );
    log.close().await.unwrap();
}
