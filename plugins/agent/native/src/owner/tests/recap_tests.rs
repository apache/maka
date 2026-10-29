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
async fn kimi_recap_uses_low_and_retains_original_session_operation() {
    tokio::time::timeout(Duration::from_secs(60), async {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let f = Fixture::configured_provider(
        &format!("http://{}/v1", listener.local_addr().unwrap()),
        None,
        None,
        None,
        |settings| settings.recaps = true,
        "kimi-coding-plan",
    )
    .await;
    selection::edit(&f, |changes| {
        changes.model_overrides = Patch::Set(BTreeMap::from([(
            "fixture-model".into(),
            ModelOverride {
                thinking_levels: Some(vec![
                    ThinkingLevel::Low,
                    ThinkingLevel::High,
                    ThinkingLevel::Max,
                ]),
                ..Default::default()
            },
        )]));
    })
    .await;
    let session = f.create("Kimi recap source").await;
    let sent = f.send(&session).await.unwrap();
    let (mut socket, _) = listener.accept().await.unwrap();
    let main_request = tool_schemas::read_wire(&mut socket).await;
    tool_schemas::anthropic_text_reply(&mut socket, "Tests passed; deployment is still pending.")
        .await;
    f.drained().await;
    let operation = Uuid::new_v4();
    let input = json!({"sessionId":session,"model":f.selection().await});
    let generation = f.mutation(2, "generateRecap", input.clone(), operation);
    tokio::pin!(generation);
    // A preparation rejection completes the real mutation without sending HTTP.
    // Collect either branch so baseline RED still settles every original resource.
    let (result, recap_request) = tokio::select! {
        result = &mut generation => (result, None),
        accepted = listener.accept() => {
            let (mut socket, _) = accepted.unwrap();
            let body = tool_schemas::read_wire(&mut socket).await;
            let pending = read(&f, &session).await;
            tool_schemas::anthropic_text_reply(&mut socket, "Tests passed. Deployment is next.").await;
            (generation.await, Some((body, pending)))
        }
    };
    f.drained().await;
    let cached = read(&f, &session).await;
    let recovered = if result.is_ok() {
        Some(f.mutation(2, "generateRecap", input, operation).await)
    } else {
        None
    };
    let by_id = match &result {
        Ok(receipt) => Some(f.query("recap", json!({"sessionId":session,"operationId":receipt["operationId"]})).await.unwrap()),
        Err(_) => None,
    };
    let physical = attempts(&f, &session).await;
    let boundary = f.session(&session).await.invocation_boundary(&session, sent["invocationId"].as_str().unwrap())
        .await
        .unwrap()
        .unwrap()
        .0;
    f.app.shutdown().await.unwrap();
    f.config.shutdown().await.unwrap();

    assert!(main_request["output_config"]["effort"].is_null());
    let result = result.expect("supported Kimi auxiliary Low must prepare and complete recap");
    let (outgoing, pending) = recap_request.expect("recap must reach actual Anthropic HTTP");
    assert_eq!(outgoing["output_config"]["effort"], "low");
    assert_eq!(outgoing["max_tokens"], 1024);
    assert!(
        outgoing["system"]
            .to_string()
            .contains("The user is returning to this session")
    );
    assert!(
        outgoing["messages"]
            .to_string()
            .contains("deployment is still pending")
    );
    assert_eq!(result["kind"], "ready");
    assert_eq!(result["text"], "Tests passed. Deployment is next.");
    assert_eq!(pending["kind"], "pending");
    assert_eq!(result["operationId"], pending["operationId"]);
    assert_eq!(by_id.unwrap(), result);
    assert_eq!(cached, result);
    assert_eq!(recovered.unwrap().unwrap(), result);
    assert!(matches!(
        boundary.state,
        maka_event_log::turns::InvocationState::Ended {
            outcome: maka_agent_facts::event::InvocationOutcome::Completed,
            ..
        }
    ));
    assert_eq!(physical.len(), 2);
    let auxiliary = physical
        .iter()
        .find(|attempt| matches!(attempt.origin, Origin::Auxiliary { .. }))
        .unwrap();
    assert_eq!(auxiliary.session_id.as_deref(), Some(session.as_str()));
    assert!(matches!(&auxiliary.origin, Origin::Auxiliary {
        source: AuxiliarySource::ApplicationOperation { operation: original, .. }
    } if *original == operation));
    assert_eq!(auxiliary.outcome, Outcome::Success);
    assert_eq!(auxiliary.usage.input_tokens, Some(1));
    assert_eq!(auxiliary.usage.output_tokens, Some(2));
    }).await.unwrap();
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

#[tokio::test]
async fn native_recap_captures_current_language_and_replays_original_receipt_after_change() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut f = fixture(&format!("http://{}/v1", listener.local_addr().unwrap())).await;
        let english = prompt_language::select_language(&f, "en").await;
        let session = opening(&f, &listener).await;
        let main = f.session(&session).await.latest_turn_boundary(&session).await.unwrap().unwrap().invocation;
        let main_configuration = f.session(&(main).session_id).await.invocation_configuration(&main).await.unwrap().unwrap();
        let chinese = prompt_language::select_language(&f, "zh-CN").await;
        let operation = Uuid::new_v4();
        let input = json!({"sessionId":session,"model":f.selection().await});
        let (result, (sent, pending, traditional)) = tokio::join!(
            f.mutation(2, "generateRecap", input.clone(), operation),
            async {
                let (mut socket, _) = listener.accept().await.unwrap();
                let sent = request(&mut socket).await;
                let pending = read(&f, &session).await;
                // The request is already physically admitted under Chinese.
                let traditional = prompt_language::select_language(&f, "zh-TW").await;
                response_with_text(&mut socket, "Tests passed. Deployment is next.").await;
                (sent, pending, traditional)
            }
        );
        let result = result.unwrap();
        f.drained().await;
        let original_attempts = attempts(&f, &session).await;
        let repeated = f.mutation(2, "generateRecap", input.clone(), operation).await.unwrap();
        let raw = rusqlite::Connection::open_with_flags(
            f.runtime_database_containing("SELECT COUNT(*) FROM event_log WHERE kind='auxiliary_model_started' AND json_extract(event_json, '$.source.operation')=?1", &operation.to_string()),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        ).unwrap();
        let original_admission: String = raw.query_row(
            "SELECT event_json FROM event_log WHERE kind='auxiliary_model_started' AND json_extract(event_json, '$.source.operation')=?1",
            [operation.to_string()], |row| row.get(0),
        ).unwrap();
        todo_tests::reopen(&mut f).await;
        let restored = read(&f, &session).await;
        let replayed = f.mutation(2, "generateRecap", input, operation).await.unwrap();
        let current_attempts = attempts(&f, &session).await;
        let restored_admissions: Vec<String> = raw.prepare(
            "SELECT event_json FROM event_log WHERE kind='auxiliary_model_started' AND json_extract(event_json, '$.source.operation')=?1",
        ).unwrap().query_map([operation.to_string()], |row| row.get(0))
            .unwrap().collect::<Result<_, _>>().unwrap();
        drop(raw);
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();

        for receipt in [english, chinese, traditional] { assert_eq!(receipt["kind"], "committed"); }
        assert_eq!(main_configuration.language, maka_agent_facts::language::Language::En);
        let instruction = sent["messages"][0]["content"].as_str().unwrap();
        assert!(instruction.contains("已确认的进展"), "independent recap must capture current Chinese instructions: {sent}");
        assert!(instruction.contains("最新一条实质性用户消息的语言"), "recap output still follows original user language: {sent}");
        let history = sent["messages"][1]["content"].as_str().unwrap();
        assert!(history.contains("Hello"), "original English user text must be retained: {sent}");
        assert!(history.contains("Tests passed; deployment is still pending."), "original model history must be retained: {sent}");
        assert_eq!(pending["kind"], "pending");
        assert_eq!(result["kind"], "ready");
        assert_eq!(result["text"], "Tests passed. Deployment is next.");
        assert_eq!(repeated, result);
        assert_eq!(restored, result);
        assert_eq!(replayed, result);
        let admission: Value = serde_json::from_str(&original_admission).unwrap();
        assert_eq!(admission["language"], "zh-CN");
        assert_eq!(admission["source"]["operation"], operation.to_string());
        assert_eq!(restored_admissions, vec![original_admission], "restart/retry must retain the exact original physical admission");
        assert_eq!(original_attempts.len(), 2);
        assert_eq!(current_attempts, original_attempts, "language change and receipt replay must not add another model attempt");
        assert_eq!(current_attempts.iter().filter(|attempt| matches!(attempt.origin, Origin::Auxiliary { .. })).count(), 1);
    }).await.unwrap();
}
