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
use maka_agent_facts::event::InvocationOutcome;
use maka_agent_facts::event::RuntimeEvent;
use maka_event_log::EventLog;
use serde_json::json;

#[tokio::test]
async fn catalog_changes_page_committed_facts_without_replaying_duplicates_or_crossing_fence() {
    let directory = tempfile::tempdir().unwrap();
    let log = EventLog::open(&directory.path().join("events.sqlite"))
        .await
        .unwrap();
    for index in 0..17 {
        let id = format!("session-{index}");
        log.create_session(&id, &id, &json!({}), 1).await.unwrap();
        let invocation = Invocation {
            session_id: id,
            turn_id: format!("turn-{index}"),
            run_id: format!("run-{index}"),
            invocation_id: format!("invocation-{index}"),
        };
        let opened = RuntimeEvent::new(
            invocation.clone(),
            Fact::InvocationOpened {
                configuration: None,
                input: maka_agent_facts::input::InvocationInput::Message {
                    source_messages: Vec::new(),
                    content: "".into(),
                    request_fingerprint: None,
                },
            },
        );
        log.append(&EventWrite::plain((opened).clone()).unwrap())
            .await
            .unwrap();
        log.append(&EventWrite::plain((opened).clone()).unwrap())
            .await
            .unwrap();
        log.append(
            &EventWrite::plain(
                (RuntimeEvent::new(
                    invocation,
                    Fact::InvocationEnded {
                        outcome: InvocationOutcome::Completed,
                    },
                ))
                .clone(),
            )
            .unwrap(),
        )
        .await
        .unwrap();
    }
    let through = *log.subscribe_commits().borrow();
    assert_eq!(through, 34);
    let first = log.session_catalog_changes(0, through, 32).await.unwrap();
    assert_eq!(first.len(), 32);
    for (index, (sequence, id)) in first.iter().enumerate() {
        assert_eq!(*sequence, index as u64 + 1);
        assert_eq!(id, &format!("session-{}", index / 2));
    }
    assert_eq!(
        log.session_catalog_changes(32, 33, 32).await.unwrap(),
        vec![(33, "session-16".into())]
    );
    assert_eq!(
        log.session_catalog_changes(32, through, 32).await.unwrap(),
        vec![(33, "session-16".into()), (34, "session-16".into())]
    );
    assert!(
        log.session_catalog_changes(through, through, 32)
            .await
            .unwrap()
            .is_empty()
    );
}
