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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn measured_prefix_outweighs_a_large_raw_estimate_for_main_progress_and_output_capacity() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let directory = tempfile::tempdir().unwrap();
        let effects = Arc::new(Effects::default());
        let f = open(directory.path(), effects.clone()).await;
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let model = f.configure_model(&base, "test", "fixture").await.unwrap();
        override_model(
            &f,
            &model,
            ModelOverride {
                code_mode: Some(false),
                max_output_tokens: Some(200_000),
                ..Default::default()
            },
        )
        .await;
        let session = f
            .create(
                "Measured large prefix",
                directory.path(),
                Some(backend(&model)),
            )
            .await
            .unwrap();
        let server = tokio::spawn(async move {
            let (mut first, _) = incoming(&listener).await;
            respond_with_usage(
                &mut first,
                "accepted large history",
                "stop",
                json!({
                    "prompt_tokens":40_000,"completion_tokens":100,
                    "prompt_tokens_details":{"cached_tokens":30_000},
                    "completion_tokens_details":{"reasoning_tokens":80}
                }),
            )
            .await;
            let (mut next, request) = incoming(&listener).await;
            assert!(!is_summary(&request), "Main progresses without a Summary");
            let messages = request["messages"].to_string();
            assert!(
                messages.contains("question-next") && messages.contains("accepted large history")
            );
            let output = request["max_tokens"].as_u64().unwrap();
            assert!(
                (159_000..160_000).contains(&output),
                "measured retained prefix leaves real output capacity: {output}"
            );
            respond(&mut next, "continued", "stop").await;
        });
        let old = message(&f, &session, &"large history ".repeat(70_000)).await;
        let original = requests(&f, old.run).await;
        let raw: RequestContextEvidence = decode(&f, old.run, &original[0].provenance).await;
        assert!(
            raw.breakdown.estimated_tokens() > 200_000,
            "real accepted history exceeds the raw capacity estimate"
        );
        override_model(&f, &model, limits(Some(170_000), false)).await;
        let next = message(&f, &session, "question-next").await;
        server.await.unwrap();
        let prepared = requests(&f, next.run).await;
        assert_eq!(prepared.len(), 1);
        assert_eq!(prepared[0].accounting.purpose, ModelPurpose::Main);
        let evidence: RequestContextEvidence = decode(&f, next.run, &prepared[0].provenance).await;
        assert!(evidence.breakdown.estimated_tokens() > 200_000);
        assert!((40_000..41_000).contains(&evidence.estimated_input_tokens));
        assert!(next.baseline.is_none());
        assert!(effects.inputs.lock().unwrap().is_empty());
        f.shutdown().await.unwrap();
    })
    .await
    .expect("measured history must not trigger foreground compaction");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn failed_prepared_summary_does_not_block_compaction_after_main_progress() {
    for reactive_overflow in [false, true] {
        tokio::time::timeout(Duration::from_secs(60), async {
            let directory = tempfile::tempdir().unwrap();
            let effects = Arc::new(Effects::default());
            let f = open(directory.path(), effects.clone()).await;
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}/v1", listener.local_addr().unwrap());
            let model = f.configure_model(&base, "test", "fixture").await.unwrap();
            override_model(&f, &model, limits(Some(110_000), false)).await;
            let session = f
                .create("Failed prepare", directory.path(), Some(backend(&model)))
                .await
                .unwrap();
            let server = tokio::spawn(async move {
                let (mut old, _) = incoming(&listener).await;
                respond_with_usage(
                    &mut old,
                    "old-answer",
                    "stop",
                    json!({"prompt_tokens":100_000,"completion_tokens":50}),
                )
                .await;
                let (mut summary, request) = incoming(&listener).await;
                assert!(is_summary(&request));
                failure(
                    &mut summary,
                    "400 Bad Request",
                    r#"{"error":{"message":"invalid summary request"}}"#,
                )
                .await;
                let (mut main, request) = incoming(&listener).await;
                assert!(!is_summary(&request));
                assert!(request["messages"].to_string().contains("old-answer"));
                background::respond_tail_call_with_usage(
                    &mut main,
                    "step-1",
                    7,
                    if reactive_overflow { 90_000 } else { 110_000 },
                )
                .await;
                if reactive_overflow {
                    let (mut step, request) = incoming(&listener).await;
                    assert!(!is_summary(&request));
                    assert!(request["messages"].to_string().contains("old-answer"));
                    overflow(&mut step).await;
                }
                let (mut summary, request) = incoming(&listener).await;
                assert!(
                    is_summary(&request),
                    "real Main progress renews the failed preparation budget"
                );
                assert!(request["messages"].to_string().contains("step-1"));
                respond(&mut summary, SUMMARY, "stop").await;
                let (mut adopted, request) = incoming(&listener).await;
                let wire = request["messages"].to_string();
                assert!(wire.contains("summary-marker") && !wire.contains("old-answer"));
                respond(&mut adopted, "recovered", "stop").await;
            });
            message(&f, &session, "question-old").await;
            let next = message(&f, &session, "question-next").await;
            server.await.unwrap();
            assert_eq!(
                effects.inputs.lock().unwrap().as_slice(),
                [json!({"value":7})]
            );
            let prepared = requests(&f, next.run).await;
            let summaries: Vec<_> = prepared
                .iter()
                .filter(|request| request.accounting.purpose == ModelPurpose::Summary)
                .collect();
            assert_eq!(summaries.len(), 2);
            let failed = next
                .attempts
                .values()
                .find(|attempt| attempt.step == summaries[0].step)
                .unwrap();
            assert!(
                failed
                    .closed
                    .as_ref()
                    .is_some_and(|closed| closed.diagnostic.is_some())
            );
            let fresh = next
                .attempts
                .values()
                .find(|attempt| attempt.step == summaries[1].step)
                .unwrap();
            let protocol: ModelClosureProtocol =
                serde_json::from_value(fresh.closed.as_ref().unwrap().protocol.clone()).unwrap();
            assert!(matches!(protocol.summary, Some(SummaryResult::Text { .. })));
            let body = compacted(&f, &next).await;
            assert_eq!(body.checkpoint.summary_step_id, fresh.step);
            assert_eq!(next.tools.len(), 1);
            assert!(
                next.tools
                    .values()
                    .all(|tool| tool.admitted && tool.accepted.is_some())
            );
            f.shutdown().await.unwrap();
        })
        .await
        .expect("renewed compaction budget must survive a failed Prepare");
    }
}
