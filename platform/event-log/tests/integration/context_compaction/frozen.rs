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
use maka_event_log::context::{ContextEvent, LatestMainContext, SourceEvidence};

fn invocation(id: &str) -> Invocation {
    Invocation {
        session_id: "session".into(),
        turn_id: id.into(),
        run_id: id.into(),
        invocation_id: id.into(),
    }
}

fn assert_same_base(actual: &ModelContextSource, expected: &ModelContextSource) {
    assert_eq!(actual.source_evidence.scope, expected.source_evidence.scope);
    assert_eq!(
        actual.source_evidence.high_water,
        expected.source_evidence.high_water
    );
    assert_eq!(
        actual.source_evidence.digest,
        expected.source_evidence.digest
    );
    assert_eq!(
        actual.effective_source_digest,
        expected.effective_source_digest
    );
    assert_eq!(
        actual
            .baseline
            .as_ref()
            .map(|b| (&b.event_id, serde_json::to_value(&b.checkpoint).unwrap())),
        expected
            .baseline
            .as_ref()
            .map(|b| (&b.event_id, serde_json::to_value(&b.checkpoint).unwrap())),
    );
    let canonical = |source: &ModelContextSource| {
        source
            .tail
            .iter()
            .map(|event| match event {
                ContextEvent::Canonical(event) => serde_json::to_value(event).unwrap(),
                ContextEvent::Archived(_) => panic!("fixture has no archived tools"),
                ContextEvent::ModelItems(items) => serde_json::to_value(items).unwrap(),
            })
            .collect::<Vec<_>>()
    };
    assert_eq!(canonical(actual), canonical(expected));
    let (LatestMainContext::Selected(actual), LatestMainContext::Selected(expected)) =
        (&actual.latest_main, &expected.latest_main)
    else {
        panic!("expected completed Main evidence")
    };
    assert_eq!(actual.sequence, expected.sequence);
    assert_eq!(actual.finished_at, expected.finished_at);
    assert_eq!(actual.requested_at, expected.requested_at);
    assert_eq!(actual.model_id, expected.model_id);
    assert_eq!(actual.connection_id, expected.connection_id);
    assert_eq!(actual.checkpoint_event_id, expected.checkpoint_event_id);
    assert_eq!(actual.projection_current, expected.projection_current);
    assert_eq!(actual.usage, expected.usage);
}

#[tokio::test]
async fn frozen_base_preserves_original_checkpoint_tail_and_diagnostics_across_later_work() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("frozen.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    closed(&log, "first", 32, 1).await;
    let empty = log
        .context_before_run(&invocation("first"), 0, 0)
        .await
        .unwrap();
    assert_eq!(empty.source_evidence.high_water, 0);
    assert!(empty.tail.is_empty());
    let checkpoint = prepared(&log, "baseline").await;
    log.append_batch(&checkpoint).await.unwrap();
    let _hidden_evidence = closed(&log, "prior", 32, 1).await;
    let expected = log
        .capture_model_context("session", None, 100_000, 64 * 1024 * 1024)
        .await
        .unwrap();
    closed(&log, "source", 64, 1).await;
    let actual = log
        .context_before_run(&invocation("source"), 100, 32768)
        .await
        .unwrap();
    assert_same_base(&actual, &expected);
    assert!(
        actual.tail.iter().all(
            |e| matches!(e, ContextEvent::Canonical(e) if e.event.invocation.run_id != "source")
        )
    );
    let second_checkpoint = prepared(&log, "later-baseline").await;
    log.append_batch(&second_checkpoint).await.unwrap();
    closed(&log, "later-message", 128, 1).await;
    let mut other = fixtures::event(
        "other",
        Fact::InvocationOpened {
            configuration: None,
            input: InvocationInput::Message {
                content: "other Session".into(),
                request_fingerprint: None,
                source_messages: Vec::new(),
            },
        },
    )
    .event()
    .clone();
    other.invocation.session_id = "unrelated".into();
    log.append(&EventWrite::plain(other).unwrap())
        .await
        .unwrap();
    log.append(&fixtures::event(
        "unfinished-later",
        Fact::InvocationOpened {
            configuration: None,
            input: InvocationInput::Message {
                content: "later incomplete work".into(),
                request_fingerprint: None,
                source_messages: Vec::new(),
            },
        },
    ))
    .await
    .unwrap();
    assert!(
        log.capture_model_context("session", None, 100_000, 64 * 1024 * 1024)
            .await
            .is_err()
    );
    assert_same_base(
        &log.read_frozen_model_context(&expected.source_evidence, 100, 32768)
            .await
            .unwrap(),
        &expected,
    );
    assert_same_base(
        &log.context_before_run(&invocation("source"), 100, 32768)
            .await
            .unwrap(),
        &expected,
    );
    let mut wrong = invocation("source");
    wrong.turn_id = "different-turn".into();
    assert!(log.context_before_run(&wrong, 100, 32768).await.is_err());
    for (events, bytes) in [(0, 32768), (100, 1)] {
        assert!(matches!(
            log.read_frozen_model_context(&expected.source_evidence, events, bytes)
                .await,
            Err(StoreError::PrefixTooLarge)
        ));
    }
    for changed in 0..3 {
        let mut forged = expected.source_evidence.clone();
        match changed {
            0 => forged.digest = "sha256:changed".into(),
            1 => forged.high_water = u64::MAX,
            _ => {
                forged.scope = LogScope::Session {
                    id: "unrelated".into(),
                }
            }
        }
        assert!(
            log.read_frozen_model_context(&forged, 100, 32768)
                .await
                .is_err()
        );
    }
    log.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    assert_same_base(
        &log.read_frozen_model_context(&expected.source_evidence, 100, 32768)
            .await
            .unwrap(),
        &expected,
    );
    assert!(
        log.read_frozen_model_context(&empty.source_evidence, 0, 0)
            .await
            .unwrap()
            .tail
            .is_empty()
    );
    log.close().await.unwrap();
}

#[tokio::test]
async fn a_closed_frozen_boundary_preserves_unknown_tool_effects() {
    let directory = tempfile::tempdir().unwrap();
    let log = EventLog::open(&directory.path().join("safety.sqlite"))
        .await
        .unwrap();
    log.append(&fixtures::event(
        "live",
        Fact::InvocationOpened {
            configuration: None,
            input: InvocationInput::Message {
                content: "unfinished tool".into(),
                request_fingerprint: None,
                source_messages: Vec::new(),
            },
        },
    ))
    .await
    .unwrap();
    log.append(&fixtures::event(
        "live",
        Fact::ToolDispatched {
            presentation: None,
            title: None,
            operation_id: "write".into(),
            call: ToolCallIdentity::standalone("write-call".into()),
            name: "write".into(),
            input: json!({}),
        },
    ))
    .await
    .unwrap();
    let scope = LogScope::Session {
        id: "session".into(),
    };
    let partial = log.scoped_prefix(scope.clone(), 100, 32768).await.unwrap();
    log.append(&fixtures::event(
        "live",
        Fact::InvocationEnded {
            outcome: InvocationOutcome::Failed {
                model_failure: None,
                class: "outcome_unknown".into(),
                message: None,
            },
        },
    ))
    .await
    .unwrap();
    let partial = SourceEvidence {
        scope: partial.scope,
        high_water: partial.high_water,
        digest: partial.digest,
    };
    assert!(
        log.read_frozen_model_context(&partial, 100, 32768)
            .await
            .unwrap_err()
            .to_string()
            .contains("closed Session boundary")
    );
    let sealed = log.scoped_prefix(scope, 100, 32768).await.unwrap();
    let sealed = SourceEvidence {
        scope: sealed.scope,
        high_water: sealed.high_water,
        digest: sealed.digest,
    };
    let frozen = log
        .read_frozen_model_context(&sealed, 100, 32768)
        .await
        .unwrap();
    assert!(frozen.tail.iter().any(|row| matches!(row,
        ContextEvent::Canonical(stored) if matches!(&stored.event.fact,
            Fact::ToolDispatched { operation_id, .. } if operation_id == "write"))));
    log.close().await.unwrap();
}
