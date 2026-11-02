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
use maka_event_log::usage::{AuxiliarySource, Origin, Outcome};

async fn fixture(base: &str) -> Fixture {
    Fixture::configured(base, None, None, None, |settings| settings.recaps = true).await
}
async fn opening(f: &Fixture, listener: &TcpListener) -> String {
    let session = f.create("Recap source").await;
    f.send(&session).await.unwrap();
    let (mut socket, _) = listener.accept().await.unwrap();
    request(&mut socket).await;
    response_with_text(&mut socket, "Tests passed; deployment is still pending.").await;
    f.drained().await;
    session
}
async fn read(f: &Fixture, session: &str) -> Value {
    f.query("recap", json!({"sessionId":session}))
        .await
        .unwrap()
}
async fn attempts(f: &Fixture, session: &str) -> Vec<maka_agent_facts::accounting::ModelAttempt> {
    f.store
        .usage_activity(
            maka_event_log::root_store::UsageQuery {
                from: 0.0,
                to: 253402300799999.0,
                session_id: Some(session.into()),
                through: None,
            },
            maka_agent_facts::accounting::Selection {
                kind: Some(maka_agent_facts::accounting::ActivityKind::Model),
                ..Default::default()
            },
            None,
        )
        .await
        .unwrap()
        .attempts
        .into_iter()
        .map(|activity| match activity {
            maka_agent_facts::accounting::Activity::Model(attempt) => attempt,
            _ => panic!("model activity selection returned tool"),
        })
        .collect()
}

#[tokio::test]
async fn recap_native_original_receipt_cached_access_accounting_and_restart() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut f = fixture(&format!("http://{}/v1", listener.local_addr().unwrap())).await;
        let session = opening(&f, &listener).await;
        assert!(read(&f, &session).await.is_null());
        let operation = Uuid::new_v4();
        let input = json!({"sessionId":session,"model":f.selection().await});
        let (result, ()) = tokio::join!(f.mutation(2, "generateRecap", input.clone(), operation), async {
            let (mut socket, _) = listener.accept().await.unwrap();
            let sent = request(&mut socket).await;
            assert!(sent["messages"][0]["content"].as_str().unwrap().starts_with("The user is returning to this session"));
            assert!(sent["messages"][1]["content"].as_str().unwrap().contains("deployment is still pending"));
            assert!(sent["messages"][1]["content"].as_str().unwrap().len() <= 32 * 1024);
            assert!(sent["tools"].is_null() || sent["tools"] == json!([]));
            assert!(sent["max_tokens"] == 1024 || sent["max_completion_tokens"] == 1024);
            let pending = read(&f, &session).await;
            assert_eq!(pending["kind"], "pending");
            assert_eq!(read(&f, &session).await, pending);
            response_with_text(&mut socket, "Tests passed. Deployment is next.").await;
        });
        let result = result.unwrap();
        assert_eq!(result["kind"], "ready");
        assert_eq!(result["text"], "Tests passed. Deployment is next.");
        assert_eq!(read(&f, &session).await, result);
        assert_eq!(f.query("recap", json!({"sessionId":session,"operationId":result["operationId"]})).await.unwrap(), result);
        assert!(f.query("recap", json!({"sessionId":session,"operationId":Uuid::new_v4()})).await.unwrap().is_null());
        assert_eq!(f.mutation(2, "generateRecap", input.clone(), operation).await.unwrap(), result);
        assert!(f.mutation(2, "generateRecap", json!({"sessionId":"foreign","model":f.selection().await}), Uuid::new_v4()).await.is_err());
        assert!(f.query("recap", json!({"sessionId":"foreign"})).await.is_err());
        let other = f.create("Separate session").await;
        assert!(read(&f, &other).await.is_null());
        assert!(f.app.client().start(f.binding(2).await, "recap".into(), json!({"sessionId":session}), scope(&f.issuer, false), Attachments::new().into()).await.is_err());
        let original = attempts(&f, &session).await;
        assert_eq!(original.len(), 2);
        let auxiliary = original.iter().find(|a| matches!(a.origin, Origin::Auxiliary { .. })).unwrap();
        assert!(matches!(&auxiliary.origin, Origin::Auxiliary { source: AuxiliarySource::ApplicationOperation { operation: id, .. } } if *id == operation));
        assert_eq!(auxiliary.outcome, Outcome::Success);
        assert_eq!(auxiliary.usage.input_tokens, Some(1));
        assert_eq!(auxiliary.usage.output_tokens, Some(2));
        assert!(auxiliary.quote.is_some());
        let policy = f.config.runtime_policy().await.unwrap();
        f.config.set_privacy(policy.revision, maka_agent_facts::configuration::policy::PrivacyPolicy { incognito_active: true }).await.unwrap();
        assert!(f.query("recap", json!({"sessionId":session})).await.is_err());
        assert!(f.mutation(2, "generateRecap", input.clone(), Uuid::new_v4()).await.is_err());
        let policy = f.config.runtime_policy().await.unwrap();
        f.config.set_privacy(policy.revision, maka_agent_facts::configuration::policy::PrivacyPolicy { incognito_active: false }).await.unwrap();
        todo_tests::reopen(&mut f).await;
        assert_eq!(read(&f, &session).await, result);
        assert_eq!(f.mutation(2, "generateRecap", input, operation).await.unwrap(), result);
        assert_eq!(attempts(&f, &session).await.len(), 2);
        assert!(tokio::time::timeout(Duration::from_millis(100), listener.accept()).await.is_err(), "cached reads and original receipt recovery must not charge again");
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn recap_cancelled_owner_keeps_original_pending_cache_and_finishes_physical_worker() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut f = fixture(&format!("http://{}/v1", listener.local_addr().unwrap())).await;
        let session = opening(&f, &listener).await;
        let operation = Uuid::new_v4();
        let input = json!({"sessionId":session,"model":f.selection().await});
        let (result, pending) = tokio::join!(
            f.mutation(2, "generateRecap", input.clone(), operation),
            async {
                let (mut socket, _) = listener.accept().await.unwrap();
                request(&mut socket).await;
                let pending = read(&f, &session).await;
                assert_eq!(pending["kind"], "pending");
                f.owner.stop.cancel();
                // Holding the provider socket open must not turn request cancellation into replay.
                f.drained().await;
                pending
            }
        );
        assert!(result.is_err());
        f.owner.auxiliary.resources.finish().await.unwrap();
        let usage = attempts(&f, &session).await;
        assert_eq!(usage.len(), 2);
        assert!(matches!(
            usage
                .iter()
                .find(|a| matches!(a.origin, Origin::Auxiliary { .. }))
                .unwrap()
                .outcome,
            Outcome::Aborted
        ));
        todo_tests::reopen(&mut f).await;
        assert_eq!(read(&f, &session).await, pending);
        assert!(
            f.mutation(2, "generateRecap", input, operation)
                .await
                .is_err()
        );
        assert_eq!(attempts(&f, &session).await.len(), 2);
        assert!(
            tokio::time::timeout(Duration::from_millis(100), listener.accept())
                .await
                .is_err()
        );
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}
