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

use maka_agent_facts::event::Fact;
use maka_agent_facts::event::InvocationInput;
use maka_agent_facts::event::InvocationOutcome;
use maka_agent_facts::event::LogScope;
use maka_agent_facts::model::ModelFinishReason;
use maka_agent_facts::model::ModelUsage;
use maka_agent_facts::model::recorded::{
    CompletionPart, ModelObservation, ModelPartRecord, ModelPartial,
};
use maka_agent_facts::model::{ModelPart, TextKind};
use maka_agent_facts::session::CopyPurpose;
use maka_event_log::{
    EventLog, StoreError,
    sessions::{SessionCopy, SessionRetirement},
};
use serde_json::{Value, json};

#[path = "usage/fixture.rs"]
mod fixture;
use fixture::{event, query, request};

#[tokio::test]
async fn collection_waits_for_the_last_history_owner_and_preserves_frozen_accounting() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("material.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    log.create_session("source", "create", &json!({}), 1)
        .await
        .unwrap();
    let opening = event(
        Fact::InvocationOpened {
            configuration: None,
            input: InvocationInput::Message {
                content: "private-question".repeat(10000).into(),
                source_messages: vec![],
                request_fingerprint: None,
            },
        },
        0,
    );
    log.append(&opening).await.unwrap();
    log.append(&request("observed", 1000)).await.unwrap();
    let mut frozen = query();
    frozen.through = Some(log.model_attempts(query(), 0, 100).await.unwrap().through);
    log.append(&event(
        Fact::ModelObserved {
            step_id: "observed".into(),
            event: ModelObservation::Finished {
                reason: ModelFinishReason::Stop,
                usage: ModelUsage {
                    input_tokens: Some(100),
                    output_tokens: Some(12),
                    ..Default::default()
                },
                provider_options: None,
            },
        },
        1200,
    ))
    .await
    .unwrap();
    log.append(&event(
        Fact::ModelInterrupted {
            partial: Some(ModelPartial {
                parts: vec![CompletionPart::Own(ModelPartRecord {
                    ordinal: 0,
                    message_id: "private-response-part".into(),
                    started_at: std::time::UNIX_EPOCH,
                    provider_part_id: Some("part".into()),
                    part: std::sync::Arc::new(ModelPart::Text {
                        text_kind: TextKind::Text,
                        text: "private-response".repeat(12_000).into(),
                        provider_options: None,
                    }),
                })],
                tool_inputs: Vec::new(),
                response_id: None,
                model: None,
                timestamp: None,
            }),
            model_failure: Some(
                maka_agent_facts::model::error::ModelFailureCause::Provider {
                    reason: maka_agent_facts::model::error::ProviderFailureReason::Network,
                },
            ),
            diagnostic: None,
            step_id: "observed".into(),
            status: maka_agent_facts::event::ModelInterruption::Failed,
        },
        1250,
    ))
    .await
    .unwrap();
    // Provider usage is factual even when no response was accepted.
    log.append(&event(
        Fact::InvocationEnded {
            outcome: InvocationOutcome::Failed {
                model_failure: Some(
                    maka_agent_facts::model::error::ModelFailureCause::Provider {
                        reason: maka_agent_facts::model::error::ProviderFailureReason::Network,
                    },
                ),
                class: "connection_lost".into(),
                message: None,
            },
        },
        1300,
    ))
    .await
    .unwrap();
    let before = log.usage_summary(query()).await.unwrap().summary;
    let frozen_before = log.usage_summary(frozen.clone()).await.unwrap().summary;
    let root_before_copy = log.prefix(100, 1_000_000).await.unwrap();
    let revision = log
        .get_session::<Value>("source")
        .await
        .unwrap()
        .unwrap()
        .revision;
    log.copy_session(
        SessionCopy {
            source_session_id: "source".into(),
            target_session_id: "copy".into(),
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
    let root_after_copy = log.prefix(100, 1_000_000).await.unwrap();
    assert_eq!(root_after_copy.digest, root_before_copy.digest);
    assert_eq!(root_after_copy.high_water, root_before_copy.high_water);
    let inherited = log
        .scoped_prefix(LogScope::Session { id: "copy".into() }, 100, 1_000_000)
        .await
        .unwrap()
        .digest;
    retire(&log, "source").await;
    assert_eq!(
        log.collect_session_material(None).await.unwrap(),
        maka_event_log::sessions::MaterialCollection::Retained("source".into())
    );
    assert_eq!(
        log.scoped_prefix(LogScope::Session { id: "copy".into() }, 100, 1_000_000)
            .await
            .unwrap()
            .digest,
        inherited
    );
    retire(&log, "copy").await;
    let inspect = rusqlite::Connection::open(&path).unwrap();
    let pages_before: i64 = inspect
        .query_row("PRAGMA page_count", [], |row| row.get(0))
        .unwrap();
    drop(inspect);
    assert_eq!(
        log.collect_session_material(None).await.unwrap(),
        maka_event_log::sessions::MaterialCollection::Collected
    );
    assert_eq!(
        log.usage_summary(query()).await.unwrap().summary,
        before,
        "partial collection keeps accounting exact"
    );
    log.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    while log.collect_session_material(None).await.unwrap()
        == maka_event_log::sessions::MaterialCollection::Collected
    {}
    assert_eq!(log.usage_summary(query()).await.unwrap().summary, before);
    assert_eq!(
        log.usage_summary(frozen).await.unwrap().summary,
        frozen_before
    );
    assert!(matches!(
        log.prefix(100, 1_000_000).await,
        Err(StoreError::MaterialCollected)
    ));
    assert!(matches!(
        log.prefix(0, 0).await,
        Err(StoreError::MaterialCollected)
    ));
    assert!(
        log.unfinished_invocations(0, 10)
            .await
            .unwrap()
            .invocations
            .is_empty()
    );
    assert!(
        log.append(&opening).await.is_err(),
        "collection cannot resurrect a retired invocation"
    );
    assert!(log.session_copy_receipt("copy").await.unwrap().is_some());
    let inspect = rusqlite::Connection::open(&path).unwrap();
    let (bodies, leaked, digest): (i64, i64, String) = inspect
        .query_row(
            "SELECT (SELECT COUNT(*) FROM event_log WHERE event_json IS NOT NULL),
         (SELECT COUNT(*) FROM event_log WHERE retained_json LIKE '%private-%'),
         (SELECT body_digest FROM event_log WHERE event_id=?1)",
            [&opening.event().id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!((bodies, leaked), (0, 0));
    let retained: Vec<String> = inspect.prepare(
        "SELECT json_extract(retained_json, CASE kind WHEN 'model_interrupted' THEN '$.fact.model_failure' ELSE '$.fact.outcome.model_failure' END)
         FROM event_log WHERE kind IN ('model_interrupted','invocation_ended') ORDER BY sequence"
    ).unwrap().query_map([], |row| row.get(0)).unwrap().collect::<Result<_,_>>().unwrap();
    assert_eq!(
        retained
            .iter()
            .map(|value| serde_json::from_str::<Value>(value).unwrap())
            .collect::<Vec<_>>(),
        vec![
            json!({"kind":"provider","reason":"network"}),
            json!({"kind":"provider","reason":"network"})
        ]
    );

    let pages_after: i64 = inspect
        .query_row("PRAGMA page_count", [], |row| row.get(0))
        .unwrap();
    assert!(
        pages_after < pages_before,
        "collection returns database pages, not only reusable slots"
    );
    assert_eq!(
        digest,
        maka_agent_facts::artifact::content_digest(&serde_json::to_vec(opening.event()).unwrap())
    );
    log.close().await.unwrap();
}

async fn retire(log: &EventLog, session: &str) {
    let revision = log
        .get_session::<Value>(session)
        .await
        .unwrap()
        .unwrap()
        .revision;
    log.begin_session_removal(session, revision).await.unwrap();
    assert_eq!(
        log.finish_session_retirement(session).await.unwrap(),
        SessionRetirement::Removed
    );
}
