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
use maka_agent_facts::model::{ModelPart, recorded::CompletionPart};
use maka_event_log::context::ContextEvent;

#[tokio::test]
async fn next_message_inherits_complete_continuation_checkpoint_without_losing_other_branches() {
    for other_branch in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("inheritance.sqlite");
        let log = EventLog::open(&path).await.unwrap();
        log.create_session("session", "session", &json!({}), 1)
            .await
            .unwrap();
        closed(&log, "prior", 32, 1).await;
        let prior = prepared(&log, "prior-summary").await;
        log.append_batch(&prior).await.unwrap();
        let root = continuation::opening("root", None);
        continuation::append(&log, &root).await;
        continuation::close(&log, &root).await;
        let base = log
            .context_before_run(&root.invocation, 100, 65536)
            .await
            .unwrap()
            .source_evidence;
        let base = SessionBase {
            high_water: base.high_water,
            digest: base.digest,
        };
        let claim = continuation::claim(&log, "first-resume", &root, base.clone()).await;
        let parent = continuation::opening("parent", Some(claim));
        continuation::append(&log, &parent).await;
        continuation::close(&log, &parent).await;
        let claim = continuation::claim(&log, "second-resume", &parent, base).await;
        if other_branch {
            let other = continuation::opening("other-user-requirement", None);
            continuation::append(&log, &other).await;
            continuation::close(&log, &other).await;
        }
        let child = continuation::opening("child", Some(claim));
        continuation::append(&log, &child).await;
        let source = log
            .capture_model_context("session", Some("child"), 100, 65536)
            .await
            .unwrap();
        log.append(&lineage_request("work", ModelPurpose::Main, &source))
            .await
            .unwrap();
        log.append(&completion("child", "work", "covered work"))
            .await
            .unwrap();
        let checkpoint = checkpoint(
            &log,
            "child",
            CheckpointMode::MidTurn {
                anchor_event_id: child.id.clone(),
            },
        )
        .await;
        log.append(&checkpoint).await.unwrap();
        let source = log
            .capture_model_context("session", Some("child"), 100, 65536)
            .await
            .unwrap();
        log.append(&lineage_request(
            "after-checkpoint",
            ModelPurpose::Main,
            &source,
        ))
        .await
        .unwrap();
        log.append(&completion(
            "child",
            "after-checkpoint",
            "new result after checkpoint",
        ))
        .await
        .unwrap();
        continuation::close(&log, &child).await;
        let next = continuation::opening("next-user-question", None);
        continuation::append(&log, &next).await;
        let source = log
            .capture_model_context("session", Some("next-user-question"), 100, 65536)
            .await
            .unwrap();
        let expected = if other_branch { &prior[0] } else { &checkpoint };
        assert_eq!(
            source.baseline.as_ref().unwrap().event_id,
            expected.event().id,
            "reuse the resumed summary only when it covers the entire conversation prefix"
        );
        let messages: Vec<_> = source
            .tail
            .iter()
            .filter_map(|event| match event {
                ContextEvent::Canonical(event) => match &event.event.fact {
                    Fact::InvocationOpened {
                        input: InvocationInput::Message { content, .. },
                        ..
                    } => Some(content.text.as_str()),
                    _ => None,
                },
                _ => None,
            })
            .collect();
        assert_eq!(messages.contains(&"other-user-requirement"), other_branch);
        assert_eq!(messages.contains(&"root"), other_branch);
        assert_eq!(
            messages
                .iter()
                .filter(|text| **text == "next-user-question")
                .count(),
            1
        );
        let new_results = source
            .tail
            .iter()
            .filter_map(|event| match event {
                ContextEvent::Canonical(event) => match &event.event.fact {
                    Fact::ModelCompleted { output, .. } => Some(output),
                    _ => None,
                },
                _ => None,
            })
            .flat_map(|output| &output.parts)
            .filter_map(|part| match part {
                CompletionPart::Own(record) => Some(record.part.as_ref()),
                CompletionPart::Ref(_) => None,
            })
            .filter(|part| {
                matches!(part, ModelPart::Text { text, .. }
                if text.to_string() == "new result after checkpoint")
            })
            .count();
        assert_eq!(
            new_results, 1,
            "results after the summary cut must remain available exactly once"
        );
        log.append(&request(
            "next-user-question",
            "next-main",
            ModelPurpose::Main,
            &source,
        ))
        .await
        .unwrap();
        log.append(&completion(
            "next-user-question",
            "next-main",
            "answered next question",
        ))
        .await
        .unwrap();
        continuation::close(&log, &next).await;
        let persisted = log
            .capture_model_context("session", None, 100, 65536)
            .await
            .unwrap();
        let revision = log
            .get_session::<serde_json::Value>("session")
            .await
            .unwrap()
            .unwrap()
            .revision;
        log.copy_session(
            maka_event_log::sessions::SessionCopy {
                source_session_id: "session".into(),
                target_session_id: "copy".into(),
                expected_source_revision: revision,
                purpose: maka_agent_facts::session::CopyPurpose::Branch {
                    position: maka_agent_facts::session::ForkPosition::End,
                    side_conversation: false,
                },
            },
            &json!({}),
            2,
        )
        .await
        .unwrap();
        let copied = log
            .capture_model_context("copy", None, 100, 65536)
            .await
            .unwrap();
        assert_eq!(
            copied.baseline.as_ref().unwrap().event_id,
            expected.event().id,
            "copying a conversation must retain the same complete checkpoint"
        );
        log.close().await.unwrap();
        let log = EventLog::open(&path).await.unwrap();
        let frozen = log
            .read_frozen_model_context(&persisted.source_evidence, 100, 65536)
            .await
            .unwrap();
        assert_eq!(
            frozen.baseline.as_ref().unwrap().event_id,
            expected.event().id
        );
        assert_eq!(
            frozen.effective_source_digest,
            persisted.effective_source_digest
        );
        log.close().await.unwrap();
    }
}
