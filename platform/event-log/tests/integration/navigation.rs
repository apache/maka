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
use maka_agent_facts::history::RowPosition;
use maka_event_log::{EventLog, StoreError};
use maka_presentation::navigation::{TurnContribution, TurnStatus};
use serde_json::json;

fn position(source_sequence: u64, item_index: u64) -> RowPosition {
    RowPosition {
        source_sequence,
        item_index,
    }
}

fn event(run: &str, turn: &str, fact: Fact) -> EventWrite {
    EventWrite::plain(RuntimeEvent::new(
        Invocation {
            session_id: "session".into(),
            turn_id: turn.into(),
            run_id: run.into(),
            invocation_id: run.into(),
        },
        fact,
    ))
    .unwrap()
}
async fn open(log: &EventLog, run: &str, turn: &str, text: &str) -> u64 {
    log.append(&event(
        run,
        turn,
        Fact::InvocationOpened {
            configuration: None,
            input: InvocationInput::Message {
                content: text.into(),
                request_fingerprint: None,
                source_messages: Vec::new(),
            },
        },
    ))
    .await
    .unwrap()
}
async fn end(log: &EventLog, run: &str, turn: &str) -> u64 {
    log.append(&event(
        run,
        turn,
        Fact::InvocationEnded {
            outcome: InvocationOutcome::Completed,
        },
    ))
    .await
    .unwrap()
}
async fn pages(log: &EventLog, through: u64, limit: usize) -> Vec<TurnContribution> {
    let mut position = None;
    let mut all = Vec::new();
    loop {
        let page = log
            .navigation_turns("session", through, position, limit)
            .await
            .unwrap();
        let size = serde_json::to_vec(&json!({"sessionId":"session","throughSequence":through,
            "contributions":page.contributions,"nextPosition":page.next_position}))
        .unwrap()
        .len();
        assert!(size <= 192 * 1024, "{size}");
        all.extend(page.contributions);
        match page.next_position {
            Some(next) => {
                assert!(position.is_none_or(|position| next > position));
                position = Some(next);
            }
            None => break,
        }
    }
    all
}

#[tokio::test]
async fn interleaved_turns_keep_full_extents_and_do_not_create_false_page_boundaries() {
    let temp = tempfile::tempdir().unwrap();
    let log = EventLog::open(&temp.path().join("events.sqlite"))
        .await
        .unwrap();
    log.create_session("session", "fingerprint", &json!({}), 1)
        .await
        .unwrap();
    let first = open(&log, "parent", "parent", "parent").await;
    end(&log, "parent", "parent").await;
    let child = open(&log, "child", "child", "child").await;
    let child_end = end(&log, "child", "child").await;
    open(&log, "parent-continuation", "parent", "continued").await;
    let last = end(&log, "parent-continuation", "parent").await;
    // A Session copy must resolve logical history before any UI index exists.
    let revision = log
        .get_session::<serde_json::Value>("session")
        .await
        .unwrap()
        .unwrap()
        .revision;
    use maka_event_log::context::{HistoryCapture, HistoryCut};
    for cut in [
        HistoryCut::BeforeTurn("child".into()),
        HistoryCut::ThroughTurn("child".into()),
    ] {
        assert!(matches!(
            log.capture_session_history("session", revision, cut, 100, 65536)
                .await,
            Err(StoreError::HistoryTurnSplit)
        ));
    }
    let HistoryCapture::Captured(history) = log
        .capture_session_history(
            "session",
            revision,
            HistoryCut::ThroughTurn("parent".into()),
            100,
            65536,
        )
        .await
        .unwrap()
    else {
        panic!("unchanged source revision");
    };
    assert_eq!(history.context.source_evidence.high_water, last);
    assert_eq!(history.context.tail.len(), 6);
    assert_eq!(history.observed_through, last);
    let HistoryCapture::Captured(empty) = log
        .capture_session_history(
            "session",
            revision,
            HistoryCut::BeforeTurn("parent".into()),
            100,
            65536,
        )
        .await
        .unwrap()
    else {
        panic!("unchanged source revision");
    };
    assert_eq!(empty.context.source_evidence.high_water, 0);
    assert!(empty.context.tail.is_empty());

    let fence = last;
    for cut in [
        position(first, 0),
        position(child, 0),
        position(child_end, 0),
    ] {
        assert!(
            !log.transcript_between_turns("session", fence, cut)
                .await
                .unwrap()
        );
    }
    assert!(
        log.transcript_between_turns("session", fence, position(last, 0))
            .await
            .unwrap()
    );
    let parent = log
        .navigation_landmarks("session", fence, 1, Some("parent"))
        .await
        .unwrap();
    assert_eq!(
        (parent[0].position, parent[0].last_position),
        (position(first, 0), position(last, 0))
    );
    assert!(
        log.navigation_landmarks("session", fence, 1, Some("missing"))
            .await
            .unwrap()
            .is_empty()
    );
    open(&log, "resumed-parent", "parent", "continued").await;
    let last = end(&log, "resumed-parent", "parent").await;

    let sampled = log
        .navigation_landmarks("session", last, 64, None)
        .await
        .unwrap();
    assert_eq!(
        sampled.iter().filter(|row| row.turn_id == "parent").count(),
        1
    );
    log.close().await.unwrap();
}

#[tokio::test]
async fn navigation_anchors_fixed_fence_byte_pages_and_reopen() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("events.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    assert!(matches!(
        log.navigation_fence("session").await,
        Err(StoreError::SessionNotFound)
    ));
    log.create_session("session", "fingerprint", &json!({}), 1)
        .await
        .unwrap();
    assert_eq!(log.navigation_fence("session").await.unwrap(), None);
    let first = open(
        &log,
        "first",
        "shared",
        &format!("\u{feff}  {}  ", "😀".repeat(100)),
    )
    .await;
    assert_eq!(log.navigation_fence("session").await.unwrap(), Some(first));
    end(&log, "first", "shared").await;
    let second = open(&log, "middle", "middle", "middle").await;
    end(&log, "middle", "middle").await;

    let fence = log.navigation_fence("session").await.unwrap().unwrap();
    let initial = pages(&log, fence, 1).await;
    assert_eq!(initial.len(), 2);
    assert_eq!(initial[0].first_position, position(first, 0));
    assert_eq!(initial[1].first_position, position(second, 0));
    assert!(
        initial
            .iter()
            .all(|c| c.latest_state.as_ref().unwrap().message.status == TurnStatus::Completed)
    );
    assert_eq!(
        initial[0].user_prompt_preview.as_deref(),
        Some("😀".repeat(64).as_str())
    );
    let landmarks = log
        .navigation_landmarks("session", fence, 64, None)
        .await
        .unwrap();
    assert_eq!(landmarks.len(), 2);
    assert_eq!(landmarks[0].label, "😀".repeat(24));
    assert_eq!(landmarks[0].position, position(first, 0));
    assert_eq!(
        log.navigation_landmarks("session", fence, 1, None)
            .await
            .unwrap()[0]
            .turn_id,
        "middle"
    );
    let mid = log
        .navigation_turns("session", fence, Some(position(first, 1)), 1)
        .await
        .unwrap();
    assert_eq!(mid.contributions[0].user_prompt_preview, None);
    assert!(mid.contributions[0].latest_state.is_some());

    let active = open(&log, "active", "active", "not settled").await;

    let active_fence = active;
    assert_eq!(
        log.navigation_fence("session").await.unwrap(),
        Some(active_fence)
    );
    let active_landmark = log
        .navigation_landmarks("session", active_fence, 1, Some("active"))
        .await
        .unwrap();
    assert_eq!(active_landmark.len(), 1);
    assert_eq!(active_landmark[0].position, position(active, 0));
    assert_eq!(active_landmark[0].last_position, position(active, 1));
    let active_turn = pages(&log, active_fence, 128)
        .await
        .into_iter()
        .find(|turn| turn.turn_id == "active")
        .unwrap();
    assert_eq!(
        active_turn.latest_state.unwrap().message.status,
        maka_presentation::navigation::TurnStatus::Running
    );
    assert_eq!(pages(&log, fence, 1).await, initial);
    let active_end = end(&log, "active", "active").await;
    open(&log, "successor", "shared", "successor").await;
    end(&log, "successor", "shared").await;
    // Deliberately adversarial JSON escaping: byte length is not encoded length.
    for n in 0..128 {
        let run = format!("escaped-{n}");
        open(&log, &run, &run, &"\u{1}".repeat(256)).await;
        end(&log, &run, &run).await;
    }
    let current = log.navigation_fence("session").await.unwrap().unwrap();

    assert_eq!(
        pages(&log, fence, 1).await,
        initial,
        "later settlement must not alter the old fence"
    );
    // The final ordinal resets at a later source fact: bounds must use actual ordered pairs.
    let settled_active = log
        .navigation_landmarks("session", current, 1, Some("active"))
        .await
        .unwrap();
    assert_eq!(settled_active[0].position, position(active, 0));
    assert_eq!(settled_active[0].last_position, position(active_end, 0));
    assert_eq!(
        log.navigation_landmarks("session", active_fence, 1, Some("active"))
            .await
            .unwrap()[0]
            .last_position,
        position(active, 1)
    );
    let all = pages(&log, current, 128).await;
    assert!(all.iter().any(|c| c.first_position == position(active, 0)));
    assert_eq!(all.iter().filter(|c| c.turn_id == "shared").count(), 1);
    assert_eq!(
        all.iter()
            .filter(|c| c.turn_id.starts_with("escaped-") && c.user_prompt_preview.is_some())
            .count(),
        128
    );
    let first_page = log
        .navigation_turns("session", current, None, 128)
        .await
        .unwrap();
    assert!(first_page.next_position.is_some());
    // Every landmark is an actual persisted user row, not an opening/header guess.
    for landmark in log
        .navigation_landmarks("session", current, 64, None)
        .await
        .unwrap()
    {
        let header = log
            .transcript_headers(
                "session",
                &maka_event_log::transcript::TranscriptRead {
                    through: current,
                    position: Some(landmark.position),
                    direction: maka_event_log::transcript::TranscriptDirection::Newer,
                    limit: 1,
                },
            )
            .await
            .unwrap()
            .remove(0);
        assert_eq!(header.position, landmark.position);
        let payload = log
            .transcript_fragment("session", header.position, 0, header.total_bytes)
            .await
            .unwrap();
        let row: serde_json::Value = serde_json::from_slice(&payload).unwrap();
        assert_eq!(row["type"], "user");
        assert_eq!(row["turnId"], landmark.turn_id);
    }
    log.close().await.unwrap();
    let reopened = EventLog::open(&path).await.unwrap();
    assert_eq!(pages(&reopened, fence, 1).await, initial);
    assert_eq!(pages(&reopened, current, 128).await, all);
    reopened.close().await.unwrap();
}
