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
use maka_agent_facts::event::InvocationInput;
use maka_agent_facts::event::InvocationOutcome;
use maka_agent_facts::event::RuntimeEvent;
use maka_agent_facts::event::ToolOutcome;
use maka_agent_facts::tool_call::ToolCallIdentity;
use maka_agent_facts::tool_call::ToolRejection;
use maka_event_log::{
    EventLog, StoreError,
    observation::{StoreStreamEvent, StreamFact, ToolSettlement},
};
use serde_json::json;
use std::time::{Duration, UNIX_EPOCH};

#[tokio::test]
async fn tool_delivery_excludes_payloads_and_preserves_factual_order_time_and_fences() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("events.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    let invocation = Invocation {
        session_id: "session".into(),
        turn_id: "turn".into(),
        run_id: "run".into(),
        invocation_id: "invocation".into(),
    };
    let payload = "not-live-秘密".repeat(200_000);
    let success = EventWrite::tool_success(
        "success-outcome".into(),
        UNIX_EPOCH + Duration::from_millis(9998),
        invocation.clone(),
        "success".into(),
        json!({"privateOutput":payload}).into(),
    )
    .unwrap()
    .0;
    let facts = [
        Fact::InvocationOpened {
            configuration: None,
            input: InvocationInput::Code {
                source: "fixture".into(),
            },
        },
        Fact::ToolDispatched {
            presentation: None,
            title: Some(maka_agent_facts::display::Text::localized(
                "Inspect application",
                "查看应用",
                "查看應用程式",
            )),
            operation_id: "success".into(),
            call: ToolCallIdentity::standalone("call-success".into()),
            name: "Read".into(),
            input: json!({"privateInput":payload}),
        },
        success.event().fact.clone(),
        Fact::ToolRejected {
            operation_id: "rejected".into(),
            call: ToolCallIdentity::standalone("call-rejected".into()),
            name: "Write".into(),
            input: json!({"privateInput":payload}).into(),
            reason: ToolRejection::PolicyDenied {
                message: payload.clone(),
            },
        },
        Fact::ToolDispatched {
            presentation: None,
            title: None,
            operation_id: "failure".into(),
            call: ToolCallIdentity::standalone("call-failure".into()),
            name: "Read".into(),
            input: json!({}),
        },
        Fact::ToolSettled {
            operation_id: "failure".into(),
            outcome: ToolOutcome::Failed { message: payload },
        },
        Fact::InvocationEnded {
            outcome: InvocationOutcome::Completed,
        },
    ];
    let events: Vec<_> = facts
        .into_iter()
        .enumerate()
        .map(|(index, fact)| {
            if index == 2 {
                return success.event().clone();
            }
            let mut event = RuntimeEvent::new(invocation.clone(), fact);
            // Clock rollback is intentional: ordering follows the log, not time.
            event.recorded_at = UNIX_EPOCH + Duration::from_millis(10_000 - index as u64);
            event
        })
        .collect();
    let writes: Vec<_> = events
        .iter()
        .enumerate()
        .map(|(index, event)| {
            if index == 2 {
                success.clone()
            } else {
                EventWrite::plain(event.clone()).unwrap()
            }
        })
        .collect();
    let sequences = log.append_batch(&writes).await.unwrap();
    let fence = *sequences.last().unwrap();
    let mut unrelated = RuntimeEvent::new(
        Invocation {
            session_id: "other".into(),
            invocation_id: "other".into(),
            ..invocation
        },
        Fact::InvocationOpened {
            configuration: None,
            input: InvocationInput::Code {
                source: "outside fence".into(),
            },
        },
    );
    log.append(&EventWrite::plain((unrelated).clone()).unwrap())
        .await
        .unwrap();
    unrelated.id = "other-terminal".into();
    unrelated.fact = Fact::InvocationEnded {
        outcome: InvocationOutcome::Completed,
    };
    let later_fence = log
        .append(&EventWrite::plain((unrelated).clone()).unwrap())
        .await
        .unwrap();

    assert!(matches!(
        log.prefix(128, 1024 * 1024).await,
        Err(StoreError::PrefixTooLarge)
    ));
    let soft = log
        .session_stream_events("session", 0, fence, 8, 1)
        .await
        .unwrap();
    assert_eq!(soft.events.len(), 1);
    assert_eq!(soft.events[0].sequence, sequences[0]);
    assert_eq!(soft.next_after, Some(sequences[0]));
    let old = log
        .session_stream_events("session", 0, sequences[1], 8, 4096)
        .await
        .unwrap();
    assert_eq!(
        old.events.len(),
        2,
        "the historical fence excludes all later outcomes"
    );
    assert!(matches!(
        old.events[1].fact,
        StreamFact::ToolDispatched { .. }
    ));
    assert!(old.next_after.is_none());

    let mut after = 0;
    let mut delivered: Vec<StoreStreamEvent> = Vec::new();
    loop {
        let page = log
            .session_stream_events("session", after, later_fence, 1, 1024)
            .await
            .unwrap();
        assert_eq!(page.through_sequence, later_fence);
        assert_eq!(page.events.len(), 1);
        delivered.extend(page.events);
        match page.next_after {
            Some(next) => {
                assert!(next > after);
                after = next;
            }
            None => break,
        }
    }
    assert_eq!(delivered.len(), 7);
    assert!(
        matches!(&delivered[1].fact, StreamFact::ToolDispatched { title: Some(title), .. } if title.resolve("zh-CN") == "查看应用")
    );
    for (projected, (canonical, sequence)) in delivered.iter().zip(events.iter().zip(&sequences)) {
        assert_eq!(projected.sequence, *sequence);
        assert_eq!(projected.id, canonical.id);
        assert_eq!(projected.recorded_at, canonical.recorded_at);
        assert_eq!(projected.invocation, canonical.invocation);
    }
    assert!(matches!(
        delivered[2].fact,
        StreamFact::ToolSettled {
            outcome: ToolSettlement::Succeeded,
            ..
        }
    ));
    assert!(matches!(delivered[3].fact, StreamFact::ToolRejected { .. }));
    assert!(matches!(
        delivered[5].fact,
        StreamFact::ToolSettled {
            outcome: ToolSettlement::Failed,
            ..
        }
    ));
    let serialized = serde_json::to_string(&delivered).unwrap();
    assert!(serialized.len() < 4096);
    for forbidden in [
        "privateInput",
        "privateOutput",
        "not-live",
        "parent_operation_id",
        "tool_call_id",
    ] {
        assert!(
            !serialized.contains(forbidden),
            "{forbidden} entered live delivery"
        );
    }
    log.close().await.unwrap();
    let reopened = EventLog::open(&path).await.unwrap();
    let page = reopened
        .session_stream_events("session", 0, later_fence, 8, 4096)
        .await
        .unwrap();
    assert_eq!(page.events, delivered);
    assert!(page.next_after.is_none());
}
