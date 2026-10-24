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

#[tokio::test]
async fn observe_exposes_last_known_context_only_for_an_active_matching_backend() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let fixture = Fixture::new(
            &format!("http://{}/v1", listener.local_addr().unwrap()),
            None,
        )
        .await;
        let session = fixture.create("Context metrics").await;
        fixture.send(&session).await.unwrap();
        let (mut first, _) = listener.accept().await.unwrap();
        request(&mut first).await;
        response(&mut first).await;
        fixture.drained().await;

        let uploaded = attachments::upload(
            &fixture,
            &session,
            "context.txt",
            b"new context whose token count is unknown",
            Uuid::new_v4(),
        )
        .await
        .unwrap();
        let sent = fixture
            .mutation(
                2,
                "send",
                json!({"sessionId":session,"message":"Read this","attachments":[uploaded["attachment"]["id"]],"model":fixture.selection().await}),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        let (mut second, _) = listener.accept().await.unwrap();
        request(&mut second).await;
        let active = fixture.query("observe", json!({"sessionId":session})).await.unwrap();
        assert_eq!(active["run"]["invocationId"], sent["invocationId"]);
        assert_eq!(active["metrics"]["contextTokens"], 3);
        assert_eq!(active["metrics"]["contextLastKnown"], true);

        let record = fixture.session(&session).await.get_session::<StoredSessionConfiguration>(&session).await.unwrap().unwrap();
        let original_backend = record.configuration.backend.clone();
        fixture.session(&session).await.update_session_metadata::<StoredSessionConfiguration, _>(&session, record.revision, |configuration| {
            configuration.backend = Some(contract::BackendPreference::Model {
                connection_id: "different-connection".into(),
                model_id: "different-model".into(),
                thinking_level: None,
            });
            Ok(())
        }).await.unwrap();
        let mismatch = fixture.query("observe", json!({"sessionId":session})).await.unwrap();
        assert!(mismatch["metrics"]["contextTokens"].is_null());
        assert_eq!(mismatch["metrics"]["contextLastKnown"], false);

        let record = fixture.session(&session).await.get_session::<StoredSessionConfiguration>(&session).await.unwrap().unwrap();
        fixture.session(&session).await.update_session_metadata::<StoredSessionConfiguration, _>(&session, record.revision, move |configuration| {
            configuration.backend = original_backend;
            Ok(())
        }).await.unwrap();
        fixture.mutation(2, "stop", json!({"sessionId":session,"invocationId":sent["invocationId"]}), Uuid::new_v4()).await.unwrap();
        fixture.drained().await;
        assert!(fixture.session(&session).await.context_usage(&session).await.unwrap().1.unwrap().last_known);
        let idle = fixture.query("observe", json!({"sessionId":session})).await.unwrap();
        assert!(idle["run"].is_null());
        assert!(idle["metrics"]["contextTokens"].is_null());
        assert_eq!(idle["metrics"]["contextLastKnown"], false);
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn context_reports_original_prepared_request_across_completion_failure_fence_and_restart() {
    use maka_agent_facts::event::Fact;
    tokio::time::timeout(Duration::from_secs(45), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut f = Fixture::new(&format!("http://{}/v1", listener.local_addr().unwrap()), None).await;
        selection::edit(&f, |changes| {
            changes.model_overrides = Patch::Set(BTreeMap::from([("fixture-model".into(), ModelOverride {
                context_window: Some(1_000_000), input_limit: Some(900_000), ..Default::default()
            })]));
        }).await;
        let session = f.create("Context report").await;
        let empty = f.query("context", json!({"sessionId":session,"through":null})).await.unwrap();
        assert_eq!(empty["request"], Value::Null);
        let started = f.send(&session).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        let sent = request(&mut socket).await;
        let pending = f.query("context", json!({"sessionId":session,"through":null})).await.unwrap();
        let original = &pending["request"];
        assert_eq!(original["invocationId"], started["invocationId"]);
        assert_eq!(original["state"], "requested");
        assert_eq!(original["modelId"], "fixture-model");
        assert_eq!(original["contextWindow"], 1_000_000);
        assert_eq!(original["inputLimit"], 900_000);
        assert_eq!(original["reportedInputTokens"], Value::Null);
        let facts = service_tools::facts(&f, &session).await;
        let measured = facts.iter().find_map(|fact| match fact {
            Fact::ModelRequested { step_id, context_breakdown: Some(measured), .. }
                if original["stepId"].as_str() == Some(step_id.as_str()) => Some(measured),
            _ => None,
        }).expect("the actual HTTP request has a canonical prepared-input measurement");
        assert_eq!(original["breakdown"], serde_json::to_value(measured).unwrap());
        assert_eq!(original["breakdown"]["counts"]["tools"], sent["tools"].as_array().map_or(0, Vec::len));
        assert_eq!(original["breakdown"]["counts"]["messages"], sent["messages"].as_array().unwrap().len());
        assert!(!pending.to_string().contains("private-fixture-key"));

        response(&mut socket).await;
        f.drained().await;
        let completed = f.query("context", json!({"sessionId":session,"through":null})).await.unwrap();
        assert_eq!(completed["request"]["state"], "completed");
        assert_eq!(completed["request"]["reportedInputTokens"], 1);
        assert_eq!(completed["request"]["stepId"], original["stepId"]);
        assert_eq!(completed["request"]["breakdown"], original["breakdown"]);
        assert_eq!(f.query("context", json!({"sessionId":session,"through":pending["through"]})).await.unwrap(), pending);

        let record = f.session(&session).await.get_session::<StoredSessionConfiguration>(&session).await.unwrap().unwrap();
        f.session(&session).await.update_session_metadata::<StoredSessionConfiguration, _>(&session, record.revision, |configuration| {
            configuration.backend = Some(contract::BackendPreference::Model {
                connection_id: "different-connection".into(), model_id: "different-model".into(), thinking_level: None,
            });
            Ok(())
        }).await.unwrap();
        let changed = f.query("context", json!({"sessionId":session,"through":null})).await.unwrap();
        assert_eq!(changed["request"], completed["request"], "current backend metadata cannot rewrite the original request");

        let second = f.send(&session).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        request(&mut socket).await;
        socket.write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}").await.unwrap();
        f.drained().await;
        let failed = f.query("context", json!({"sessionId":session,"through":null})).await.unwrap();
        assert_eq!(failed["request"]["invocationId"], second["invocationId"]);
        assert_eq!(failed["request"]["state"], "interrupted");
        assert_eq!(failed["request"]["reportedInputTokens"], Value::Null, "failed latest request must not borrow the previous successful usage");
        assert_ne!(failed["request"]["stepId"], original["stepId"]);
        assert_eq!(f.query("context", json!({"sessionId":session,"through":completed["through"]})).await.unwrap(), completed);

        todo_tests::reopen(&mut f).await;
        assert_eq!(f.query("context", json!({"sessionId":session,"through":failed["through"]})).await.unwrap(), failed);
        assert_eq!(f.query("context", json!({"sessionId":"wh_not-owned","through":null})).await.unwrap_err(), "agent_session_unavailable");
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    }).await.unwrap();
}
