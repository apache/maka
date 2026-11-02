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
async fn progress_cancellation_and_scope_drain_preserve_saved_business_receipts() {
    for (finish, cleanup_failure) in [
        ("next", false),
        ("mutation", false),
        ("client", false),
        ("next", true),
    ] {
        tokio::time::timeout(Duration::from_secs(30), async {
            let fixture = Fixture::new().await;
            fixture.counter.blocked.store(true, Ordering::SeqCst);
            let client = fixture.client().await;
            let id = Uuid::new_v4();
            let mutation = client.settings_mutation(id, "authentication", "loginCredential", json!({"progress":true,"cleanupFailure":cleanup_failure}), Attachments::new()).await.unwrap();
            let prepared = mutation.prepare().await.unwrap();
            match mutation.next().await.unwrap().unwrap() {
                MutationEvent::Progress(value) => assert_eq!(value, json!({"url":"https://auth.openai.com/codex/device","userCode":"ABCD-EFGH"})),
                other => panic!("the original Host must publish its progress first: {other:?}"),
            }
            assert_eq!(client.query("agent", "read", Value::Null).await.unwrap(), json!({"sent":1}));
            mutation.request_cancel();
            fixture.counter.release.notify_one();
            match finish {
                "next" => {
                    match mutation.next().await.unwrap().unwrap() {
                        MutationEvent::Finished { reply, cleanup } => {
                            assert_eq!(reply.reference, prepared.reference.clone().unwrap());
                            assert!(matches!(reply.receipt, Receipt::Recorded { outcome: OperationOutcome::Returned { ref value }, .. } if value == &json!({"kind":"saved"})));
                            assert_eq!(cleanup, if cleanup_failure { Err("tool cleanup unconfirmed: counter cleanup failure".into()) } else { Ok(()) });
                        }
                        other => panic!("cancellation must retain the original terminal reply: {other:?}"),
                    }
                    assert!(mutation.next().await.unwrap().is_none());
                }
                "mutation" => mutation.close().await.unwrap(),
                "client" => client.close().await.unwrap(),
                _ => unreachable!(),
            }
            let original = client.operation_for_settings(id).await.unwrap();
            assert!(!original.abandoned, "finish={finish}, cleanup_failure={cleanup_failure}");
            assert_eq!(original.reference, prepared.reference);
            assert!(matches!(&original.receipt, Some(Receipt::Recorded { outcome: OperationOutcome::Returned { value }, .. }) if value == &json!({"kind":"saved"})), "finish={finish}, cleanup_failure={cleanup_failure}, original={original:?}");
            assert_eq!(fixture.counter.effects.load(Ordering::SeqCst), 1);
            if cleanup_failure {
                assert_eq!(client.pending_requests().await, 1, "a business receipt does not release unconfirmed physical custody");
                let _ = client.close().await;
                // This injected resource group explicitly reports failed cleanup.
                // Retiring this local fixture does not assert successful cleanup.
                let _ = fixture.host.shutdown().await;
                let _ = fixture.serving.await;
            } else {
                assert_eq!(client.pending_requests().await, 0);
                client.close().await.unwrap();
                fixture.finish().await;
            }
        }).await.unwrap();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn proven_undispatched_preparation_releases_settings_even_when_physical_cleanup_is_unknown() {
    for finish in ["next", "mutation", "client", "disconnect"] {
        tokio::time::timeout(Duration::from_secs(30), async {
            let fixture = Fixture::new().await;
            let client = fixture.client().await;
            let observer = fixture.client().await;
            let id = Uuid::new_v4();
            let mutation = client
                .settings_mutation(
                    id,
                    "authentication",
                    "loginCredential",
                    Value::Null,
                    Attachments::new(),
                )
                .await
                .unwrap();
            let prepared = mutation.prepare().await.unwrap();
            assert!(!observer.abandon_unprepared(id).await.unwrap().abandoned);
            match finish {
                "next" => {
                    mutation.request_cancel();
                    assert!(matches!(
                        mutation.next().await.unwrap(),
                        Some(MutationEvent::NotDispatched)
                    ));
                    assert!(mutation.next().await.unwrap().is_none());
                }
                "mutation" => mutation.close().await.unwrap(),
                "client" => client.close().await.unwrap(),
                "disconnect" => {
                    mutation.disconnect().await.unwrap();
                    assert!(mutation.close().await.is_err());
                    client.close().await.unwrap();
                }
                _ => unreachable!(),
            }
            let original = observer.operation_for_settings(id).await.unwrap();
            assert_eq!(original.reference, prepared.reference);
            assert!(
                original.receipt.is_none(),
                "no business receipt is fabricated: {original:?}"
            );
            assert!(original.abandoned, "finish={finish}, original={original:?}");
            assert_eq!(fixture.counter.effects.load(Ordering::SeqCst), 0);
            let pending = observer.pending_settings().await.unwrap();
            let replacement = observer
                .settings_mutation(
                    Uuid::new_v4(),
                    "setup",
                    "discoverModels",
                    Value::Null,
                    Attachments::new(),
                )
                .await;
            assert!(pending.is_empty());
            let replacement = replacement.unwrap();
            assert!(
                observer
                    .abandon_unprepared(replacement.id())
                    .await
                    .unwrap()
                    .abandoned
            );
            replacement.close().await.unwrap();
            client.close().await.unwrap();
            observer.close().await.unwrap();
            fixture.finish().await;
        })
        .await
        .unwrap();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn confirmed_business_result_is_usable_while_original_cleanup_is_retained() {
    tokio::time::timeout(Duration::from_secs(20), async {
        let fixture = Fixture::new().await;
        let client = fixture.client().await;
        let mutation = client
            .settings_mutation(
                Uuid::new_v4(),
                "setup",
                "discoverModels",
                json!({"cleanupFailure":true}),
                Attachments::new(),
            )
            .await
            .unwrap();
        mutation.prepare().await.unwrap();
        let reply = mutation.confirm().await.unwrap();
        assert!(matches!(reply.receipt, Receipt::Recorded {
            outcome: OperationOutcome::Returned { ref value },
            cleanup: OperationCleanup::Failed { .. },
        } if value == &json!({"sent":1})));
        assert!(client.pending_settings().await.unwrap().is_empty());
        assert_eq!(client.pending_requests().await, 1);
        let next = client
            .settings_mutation(
                Uuid::new_v4(),
                "setup",
                "discoverModels",
                Value::Null,
                Attachments::new(),
            )
            .await
            .unwrap();
        next.prepare().await.unwrap();
        assert!(
            matches!(next.confirm().await.unwrap().receipt, Receipt::Recorded {
            outcome: OperationOutcome::Returned { ref value }, ..
        } if value == &json!({"sent":2}))
        );
        assert_eq!(client.pending_requests().await, 1);
        client.close().await.unwrap();
        let _ = fixture.host.shutdown().await;
        let _ = fixture.serving.await;
    })
    .await
    .unwrap();
}
