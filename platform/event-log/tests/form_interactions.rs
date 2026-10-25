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
use sqlx::Connection;

#[tokio::test]
async fn form_answers_survive_reopen_without_grants_and_match_semantically() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("runtime.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    log.create_session("session", "create", &json!({}), 1)
        .await
        .unwrap();
    let authored_text = "Complete authored response. ".repeat(160);
    let mut fields = vec![json!({"kind":"number","name":"n","label":"N","required":true})];
    let mut values = serde_json::Map::from_iter([("n".into(), json!(1.0))]);
    for index in 0..40 {
        let name = format!("field_{index}");
        fields.push(
            json!({"kind":"string","name":name,"label":format!("Field {index}"),
            "required":true,"maxLength":6000}),
        );
        values.insert(name, json!(authored_text));
    }
    let record: InteractionRecord = serde_json::from_value(json!({
        "sessionId":"session","turnId":"turn","runId":"run","requestId":"form","createdAt":2,
        "request":{"kind":"form","toolUseId":"tool","message":authored_text,"requester":{"name":"Tool"},
        "fields":fields},"outcome":null
    }))
    .unwrap();
    assert!(log.establish_interaction(&record).await.unwrap().matches);
    assert!(
        log.commit_interaction_outcome(
            "form",
            InteractionOutcome::Closure {
                reason: ClosureReason::TimedOut,
                committed_at: 3,
            }
        )
        .await
        .is_err(),
        "a Form has no human-response deadline"
    );
    let invocation = maka_agent_facts::event::Invocation {
        session_id: "session".into(),
        turn_id: "turn".into(),
        run_id: "run".into(),
        invocation_id: "invocation".into(),
    };
    assert!(
        log.close_run_interactions(&invocation, ClosureReason::TimedOut, 3)
            .await
            .is_err(),
        "batch closure must enforce the same request contract"
    );
    assert!(
        log.interaction("form")
            .await
            .unwrap()
            .unwrap()
            .outcome
            .is_none()
    );
    let answer: InteractionAnswer =
        serde_json::from_value(json!({"kind":"form","action":"accept","values":values})).unwrap();
    let outcome = answer.clone().into_outcome(3);
    let committed = log
        .commit_interaction_outcome("form", outcome.clone())
        .await
        .unwrap();
    assert!(committed.matches);
    assert!(
        log.commit_interaction_outcome("form", answer.into_outcome(4))
            .await
            .unwrap()
            .matches
    );
    values.insert("n".into(), json!(1));
    let equivalent: InteractionAnswer =
        serde_json::from_value(json!({"kind":"form","action":"accept","values":values})).unwrap();
    assert!(
        log.commit_interaction_outcome("form", equivalent.into_outcome(5))
            .await
            .unwrap()
            .matches
    );
    values.insert("n".into(), json!(2));
    let different: InteractionAnswer =
        serde_json::from_value(json!({"kind":"form","action":"accept","values":values})).unwrap();
    assert!(
        !log.commit_interaction_outcome("form", different.into_outcome(6))
            .await
            .unwrap()
            .matches
    );
    let conflicting: InteractionAnswer =
        serde_json::from_value(json!({"kind":"form","action":"decline"})).unwrap();
    assert!(
        !log.commit_interaction_outcome("form", conflicting.into_outcome(7))
            .await
            .unwrap()
            .matches
    );
    let mut connection = sqlx::SqliteConnection::connect_with(
        &sqlx::sqlite::SqliteConnectOptions::new().filename(&path),
    )
    .await
    .unwrap();
    let raw: String = sqlx::query_scalar("SELECT outcome_json FROM interaction_outcomes")
        .fetch_one(&mut connection)
        .await
        .unwrap();
    assert!(raw.contains("\"n\":1}"));
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM client_capability_session_grants")
            .fetch_one(&mut connection)
            .await
            .unwrap(),
        0
    );
    connection.close().await.unwrap();
    log.close().await.unwrap();
    let reopened = EventLog::open(&path).await.unwrap();
    assert_eq!(
        reopened.interaction("form").await.unwrap().unwrap(),
        committed.record
    );
    reopened.close().await.unwrap();
}
