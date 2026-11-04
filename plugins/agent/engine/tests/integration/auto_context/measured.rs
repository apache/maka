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
use serde_json::json;
use std::time::Duration;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn measured_prefix_outweighs_a_large_raw_estimate_for_main_progress_and_output_capacity() {
    tokio::time::timeout(Duration::from_secs(20), async {
        let directory = tempfile::tempdir().unwrap();
        let log = Arc::new(
            SessionFixture::open(&directory.path().join("events.sqlite"))
                .await
                .unwrap(),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut first, _) = listener.accept().await.unwrap();
            fixture::read_request(&mut first).await;
            fixture::respond_with_usage(
                &mut first,
                "accepted large history",
                "stop",
                json!({
                    "prompt_tokens":40_000, "completion_tokens":100,
                    "prompt_tokens_details":{"cached_tokens":30_000},
                    "completion_tokens_details":{"reasoning_tokens":80}
                }),
            )
            .await;
            let (mut next, _) = listener.accept().await.unwrap();
            let request = fixture::read_request(&mut next).await;
            assert!(
                request["messages"].to_string().contains("question-next"),
                "Main must continue without waiting for a summary"
            );
            assert!(
                request["messages"]
                    .to_string()
                    .contains("accepted large history")
            );
            let output = request["max_tokens"].as_u64().unwrap();
            assert!(
                (159_000..160_000).contains(&output),
                "the measured prefix leaves room for useful output: {output}"
            );
            fixture::respond(&mut next, "continued", "stop").await;
        });
        let worker = fixture::engine();
        let mut old = fixture::input(&base, "old", false);
        old.context = context(None);
        if let RunWork::Message { message, .. } = &mut old.work {
            message.text = "large history ".repeat(70_000);
        }
        worker
            .run(log.store(), old, CancellationToken::new())
            .await
            .unwrap();
        let mut next = fixture::input(&base, "next", false);
        next.context = context(Some(170_000));
        next.main_output_limit = Some(200_000);
        worker
            .run(log.store(), next, CancellationToken::new())
            .await
            .unwrap();
        worker.drain().await;
        server.await.unwrap();
        let prefix = log.prefix(100, 4 * 1024 * 1024).await.unwrap();
        assert!(!prefix.events.iter().any(|event| matches!(
            event.event.fact,
            Fact::ModelRequested {
                purpose: ModelPurpose::Summary,
                ..
            }
        )));
        let raw = prefix
            .events
            .iter()
            .find_map(|event| match &event.event.fact {
                Fact::ModelRequested {
                    context_breakdown: Some(size),
                    ..
                } => Some(size.estimated_tokens()),
                _ => None,
            })
            .unwrap();
        assert!(
            raw > 200_000,
            "the fixture exercises the reported raw-estimate overrun"
        );
    })
    .await
    .expect("measured history must not trigger foreground compaction");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn failed_prepared_summary_does_not_block_compaction_after_main_progress() {
    use crate::support::agent_loop;
    use tokio::io::AsyncWriteExt;

    for reactive_overflow in [false, true] {
        tokio::time::timeout(Duration::from_secs(20), async move {
            let directory = tempfile::tempdir().unwrap();
            let log = Arc::new(
                SessionFixture::open(&directory.path().join("events.sqlite"))
                    .await
                    .unwrap(),
            );
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}/v1", listener.local_addr().unwrap());
            let count = Arc::new(AtomicUsize::new(0));
            let effect = Arc::new(agent_loop::Effect {
                log: log.clone(),
                count: count.clone(),
            });
            let prompt_prefix = maka_agent_facts::context::default_compaction_prompt(
                maka_agent_facts::language::Language::En,
            )
            .lines()
            .next()
            .unwrap()
            .to_owned();
            let server = tokio::spawn(async move {
                let (mut old, _) = listener.accept().await.unwrap();
                fixture::read_request(&mut old).await;
                fixture::respond_with_usage(
                    &mut old,
                    "old-answer",
                    "stop",
                    json!({"prompt_tokens":100_000,"completion_tokens":50}),
                )
                .await;

                let mut summary = None;
                let mut main = None;
                for _ in 0..2 {
                    let (mut socket, _) = listener.accept().await.unwrap();
                    let request = fixture::read_request(&mut socket).await;
                    if request["messages"].to_string().contains(&prompt_prefix) {
                        summary = Some(socket);
                    } else {
                        main = Some(socket);
                    }
                }
                let mut summary = summary.unwrap();
                let mut main = main.unwrap();
                let bad = r#"{"error":{"message":"invalid summary request"}}"#;
                if reactive_overflow {
                    // Keep the failed Prepare pending across the Main step to exercise
                    // fallback when adopt() observes the failure during overflow recovery.
                    super::background::respond_tail_call_with_usage(&mut main, "step-1", 7, 90_000)
                        .await;
                    let (mut step2, _) = listener.accept().await.unwrap();
                    let uncompacted = fixture::read_request(&mut step2).await;
                    assert!(uncompacted["messages"].to_string().contains("old-answer"));
                    let overflow = r#"{"error":{"code":"context_length_exceeded","message":"prompt is too long"}}"#;
                    step2
                        .write_all(
                            format!(
                                "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{overflow}",
                                overflow.len()
                            )
                            .as_bytes(),
                        )
                        .await
                        .unwrap();
                    summary
                        .write_all(
                            format!(
                                "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{bad}",
                                bad.len()
                            )
                            .as_bytes(),
                        )
                        .await
                        .unwrap();
                } else {
                    summary
                        .write_all(
                            format!(
                                "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{bad}",
                                bad.len()
                            )
                            .as_bytes(),
                        )
                        .await
                        .unwrap();
                    super::background::respond_tail_call_with_usage(&mut main, "step-1", 7, 110_000)
                        .await;
                }

                let (mut fresh_summary, _) = listener.accept().await.unwrap();
                let fresh_request = fixture::read_request(&mut fresh_summary).await;
                assert!(fresh_request["messages"].to_string().contains(&prompt_prefix));
                assert!(fresh_request["messages"].to_string().contains("step-1"));
                fixture::respond(&mut fresh_summary, fixture::SUMMARY, "stop").await;

                let (mut adopted_main, _) = listener.accept().await.unwrap();
                let adopted = fixture::read_request(&mut adopted_main).await;
                let messages = adopted["messages"].to_string();
                assert!(messages.contains("summary-marker"));
                assert!(!messages.contains("old-answer"));
                fixture::respond(&mut adopted_main, "recovered", "stop").await;
            });

            let worker = fixture::engine();
            let mut old = fixture::input(&base, "old", false);
            old.context = context(None);
            worker
                .run(log.store(), old, CancellationToken::new())
                .await
                .unwrap();

            let mut next = agent_loop::input(&base, "next", effect);
            next.configuration.model = fixture::input(&base, "unused", false).configuration.model;
            next.provider.auth = maka_model::ProviderAuth::ApiKey("fixture".into());
            next.context = context(Some(110_000));
            worker
                .run(log.store(), next, CancellationToken::new())
                .await
                .unwrap();
            worker.drain().await;
            server.await.unwrap();
            assert_eq!(count.load(Ordering::SeqCst), 1);
            assert!(log.read_model_view("session", None).await.unwrap().baseline.is_some());
        })
        .await
        .expect("renewed compaction budget must survive a failed background Prepare");
    }
}
