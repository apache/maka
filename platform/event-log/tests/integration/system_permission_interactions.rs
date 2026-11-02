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

use maka_agent_facts::interaction::ClosureReason;
use maka_agent_facts::interaction::InteractionAnswer;
use maka_agent_facts::interaction::InteractionOutcome;
use maka_agent_facts::interaction::InteractionRecord;
use maka_event_log::EventLog;
use serde_json::json;

fn record(request_id: &str) -> InteractionRecord {
    serde_json::from_value(json!({
        "sessionId":"session","turnId":"turn","runId":"run","requestId":request_id,"createdAt":2,
        "request":{"kind":"system_permission","toolUseId":"tool",
        "grants":["accessibility","screen_recording"],"application":"Maka Host"},
        "outcome":null
    }))
    .unwrap()
}

#[tokio::test]
async fn system_permission_grant_is_producer_committed_once_and_survives_reopen() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("runtime.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    log.create_session("session", "create", &json!({}), 1)
        .await
        .unwrap();
    assert!(
        log.establish_interaction(&record("granted"))
            .await
            .unwrap()
            .matches
    );
    assert!(
        log.commit_interaction_outcome(
            "granted",
            InteractionOutcome::QuestionAnswer {
                answers: vec![Some("yes".into())],
                committed_at: 3,
            }
        )
        .await
        .is_err(),
        "only the system permission outcome or a closure can settle the request"
    );
    let committed = log
        .commit_interaction_outcome(
            "granted",
            InteractionOutcome::SystemPermissionGranted { committed_at: 3 },
        )
        .await
        .unwrap();
    assert!(committed.matches);
    assert!(
        log.commit_interaction_outcome(
            "granted",
            InteractionOutcome::SystemPermissionGranted { committed_at: 4 },
        )
        .await
        .unwrap()
        .matches,
        "a repeated grant observation is idempotent"
    );
    assert!(
        !log.commit_interaction_outcome(
            "granted",
            InteractionAnswer::SystemPermissionCancel {}.into_outcome(5),
        )
        .await
        .unwrap()
        .matches,
        "first outcome wins over a late cancel"
    );

    assert!(
        log.establish_interaction(&record("cancelled"))
            .await
            .unwrap()
            .matches
    );
    let cancel = InteractionAnswer::SystemPermissionCancel {};
    let cancelled = log
        .commit_interaction_outcome("cancelled", cancel.clone().into_outcome(6))
        .await
        .unwrap();
    assert!(cancelled.matches);
    assert!(cancel.matches_outcome(cancelled.record.outcome.as_ref().unwrap()));
    assert!(
        !log.commit_interaction_outcome(
            "cancelled",
            InteractionOutcome::SystemPermissionGranted { committed_at: 7 },
        )
        .await
        .unwrap()
        .matches
    );
    assert!(
        log.commit_interaction_outcome(
            "cancelled",
            InteractionOutcome::Closure {
                reason: ClosureReason::TimedOut,
                committed_at: 8,
            }
        )
        .await
        .is_err(),
        "the card has no response deadline"
    );

    log.close().await.unwrap();
    let reopened = EventLog::open(&path).await.unwrap();
    assert_eq!(
        reopened.interaction("granted").await.unwrap().unwrap(),
        committed.record
    );
    assert_eq!(
        reopened.interaction("cancelled").await.unwrap().unwrap(),
        cancelled.record
    );
    reopened.close().await.unwrap();
}
