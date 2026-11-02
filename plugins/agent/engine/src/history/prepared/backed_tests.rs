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
use maka_agent_facts::event::{
    EventWrite, Fact, Invocation, InvocationInput, InvocationOutcome, RuntimeEvent,
};

#[tokio::test]
async fn numeric_history_preserves_resident_commitments_counts_and_direct_metadata_seek() {
    tokio::time::timeout(std::time::Duration::from_secs(20), async {
        let (_directory, root) = crate::test_support::root().await;
        let session = crate::test_support::session(&root, "session").await;
        let execution = session.execution_scope(None).await.unwrap().accept();
        let log = Arc::new(execution.store());
        let mut through = 0;
        for index in 0..64 {
            let invocation = Invocation {
                session_id: "session".into(),
                turn_id: format!("turn-{index}"),
                run_id: format!("run-{index}"),
                invocation_id: format!("invocation-{index}"),
            };
            let event = EventWrite::plain(RuntimeEvent::new(
                invocation.clone(),
                Fact::InvocationOpened {
                    input: InvocationInput::Message {
                        content: format!("selected message {index} 世界\n").into(),
                        request_fingerprint: None,
                        source_messages: Vec::new(),
                    },
                    configuration: None,
                },
            ))
            .unwrap();
            log.append(&event).await.unwrap();
            through = log
                .append(
                    &EventWrite::plain(RuntimeEvent::new(
                        invocation,
                        Fact::InvocationEnded {
                            outcome: InvocationOutcome::Completed,
                        },
                    ))
                    .unwrap(),
                )
                .await
                .unwrap();
        }
        let selection = SemanticSelection {
            session: "session".into(),
            lineage: None,
            after: 0,
            through,
            before: u64::MAX,
            captured_through: through,
            replay: None,
            prior_unknown: false,
        };
        let resources = ModelPreparationResources::new(Default::default()).unwrap();
        let cancellation = CancellationToken::new();
        let resident = super::capture(
            &log,
            selection.clone(),
            Language::En,
            false,
            &ProviderKind::Anthropic,
            &cancellation,
            resources,
            0,
        )
        .await
        .unwrap();
        assert!(matches!(resident.directory, HistoryDirectory::Resident(_)));
        let resources = ModelPreparationResources::new(maka_model::PreparationPolicy {
            staging_bytes: super::backed::metadata_bytes() * 2,
            ..Default::default()
        })
        .unwrap();
        let backed = super::capture(
            &log,
            selection,
            Language::En,
            false,
            &ProviderKind::Anthropic,
            &cancellation,
            resources,
            0,
        )
        .await
        .unwrap();
        assert!(matches!(backed.directory, HistoryDirectory::Backed(_)));
        assert_eq!(resident.prompt().identity(), backed.prompt().identity());
        assert_eq!(resident.prompt().breakdown(), backed.prompt().breakdown());
        let left_source = resident.recipes();
        let right_source = backed.recipes();
        for prefix in [0, 1, left_source.len() / 2, left_source.len()] {
            assert_eq!(
                left_source.prefix_identity(prefix).await.unwrap(),
                right_source.prefix_identity(prefix).await.unwrap()
            );
        }
        let mut left_cursor = left_source.open_metadata(left_source.len() - 1);
        let mut right_cursor = right_source.open_metadata(right_source.len() - 1);
        let left = left_cursor.next().await.unwrap().unwrap();
        let right = right_cursor.next().await.unwrap().unwrap();
        assert_eq!(left.logical_identity, right.logical_identity);
        assert_eq!(left.message_index, right.message_index);
        assert!(right.local_tool_names.is_empty());
        drop((left_source, right_source, left_cursor, right_cursor));
        resident.close().await.unwrap();
        backed.close().await.unwrap();
        drop(left);
        drop(right);
        drop(resident);
        drop(backed);
        drop(log);
        execution.finish();
        root.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}
