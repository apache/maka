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
