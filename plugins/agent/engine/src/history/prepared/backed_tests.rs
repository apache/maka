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

use crate::{history::test_support as canonical, preparation};
use maka_agent_facts::{
    durable::{Fact, Terminal, UnixMillis},
    input::RunInput,
    language::Language,
};
use maka_agent_state::{Admission, Change, ContentBlob, artifacts::SessionScope};
use maka_model::{ModelPreparationResources, PreparationPolicy};
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn numeric_history_preserves_resident_commitments_counts_and_direct_metadata_seek() {
    tokio::time::timeout(std::time::Duration::from_secs(20), async {
        let directory = tempfile::tempdir().unwrap();
        let root = canonical::open(directory.path(), false).await;
        root.create_session("session", "numeric history", &serde_json::json!({}), 1)
            .await
            .unwrap();
        let state = canonical::state(&root);
        for index in 0..64 {
            let input = ContentBlob::json(&RunInput::Message {
                content: format!("selected message {index} 世界\n").into(),
                request_fingerprint: None,
                source_messages: Vec::new(),
            })
            .unwrap();
            let (mut spec, contents) = canonical::spec(input, &format!("message-{index}"));
            spec.turn_id = format!("turn-{index}");
            let admission = Admission::new(spec, UnixMillis(2 * index + 1), contents);
            let run = admission.run();
            let committed = state.admit(admission).await.unwrap();
            let claim = state.claim(run).await.unwrap();
            state
                .append(
                    &claim,
                    committed.head,
                    vec![Change::new(
                        Fact::RunTerminated {
                            terminal: Terminal::Completed,
                            diagnostic: None,
                        },
                        UnixMillis(2 * index + 2),
                    )],
                    vec![],
                )
                .await
                .unwrap();
        }
        drop(state);
        root.shutdown().await.unwrap();
        drop(root);

        let root = canonical::open(directory.path(), true).await;
        let state = canonical::state(&root);
        let history = state.session_history(canonical::owner(), "session".into());
        let cut = history.capture().await.unwrap();
        let artifacts = state.artifacts();
        let scope = SessionScope {
            owner: cut.owner.clone(),
            session: cut.session.clone(),
        };
        let (log, work, effects) = canonical::work(&root).await;
        let cancellation = CancellationToken::new();
        let mut captured = Vec::with_capacity(2);
        for policy in [
            PreparationPolicy::default(),
            PreparationPolicy {
                staging_bytes: 64 * 1024,
                resident_bytes: 64 * 1024,
                progress_bytes: 256 * 1024,
                work_bytes: 256 * 1024,
            },
        ] {
            let resources = ModelPreparationResources::new(policy).unwrap();
            let mut messages = Vec::with_capacity(64);
            let mut after = 0;
            loop {
                let page = history.page(&cut, after, 16).await.unwrap();
                for item in page.items {
                    if !matches!(&item.recorded.fact, Fact::RunAdmitted { .. }) {
                        continue;
                    }
                    let source = history.run_source(item.recorded.run).await.unwrap();
                    let input: RunInput = history
                        .with_content(&cut, source.run, &source.spec.input, |reader| {
                            Ok(serde_json::from_reader(reader))
                        })
                        .await
                        .unwrap()
                        .unwrap();
                    let RunInput::Message { content, .. } = input else {
                        panic!("original message opening required")
                    };
                    assert_eq!(
                        content.text,
                        format!("selected message {} 世界\n", messages.len())
                    );
                    messages.push(
                        preparation::project_input(
                            &artifacts,
                            &scope,
                            &content,
                            Language::En,
                            false,
                            false,
                            None,
                            &resources,
                            &cancellation,
                        )
                        .await
                        .unwrap(),
                    );
                }
                match page.next {
                    Some(next) => after = next,
                    None => break,
                }
            }
            assert_eq!(messages.len(), 64);
            captured.push(canonical::capture(&log, messages, resources).await);
        }
        let small = captured.pop().unwrap();
        let large = captured.pop().unwrap();
        let left_prompt = large.model();
        let right_prompt = small.model();
        assert_eq!(left_prompt.len(), 64);
        assert_eq!(right_prompt.len(), 64);
        assert_eq!(left_prompt.breakdown().counts.messages, 64);
        assert_eq!(left_prompt.identity(), right_prompt.identity());
        assert_eq!(left_prompt.breakdown(), right_prompt.breakdown());
        let left_source = large.recipes().unwrap();
        let right_source = small.recipes().unwrap();
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
        assert_eq!(right.message_index, 63);
        assert!(right.local_tool_names.is_empty());
        drop((
            left_source,
            right_source,
            left_cursor,
            right_cursor,
            left_prompt,
            right_prompt,
        ));
        large.close().await.unwrap();
        small.close().await.unwrap();
        drop((left, right, large, small, captured, log));
        effects.settle().await.unwrap();
        work.finish();
        drop((scope, artifacts, history, state));
        root.shutdown().await.unwrap();
        drop(root);
        let reopened = canonical::open(directory.path(), true).await;
        reopened.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}
