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
    Fixture::configured(base, None, None, None, |settings| {
        settings.automatic_titles = true
    })
    .await
}
async fn automatic(f: &Fixture) -> String {
    let mut input = f.create_input("Untitled").await;
    input["automaticTitle"] = json!(true);
    f.mutation(2, "create", input, Uuid::new_v4())
        .await
        .unwrap()["session"]["id"]
        .as_str()
        .unwrap()
        .into()
}
fn is_title(sent: &Value) -> bool {
    sent["messages"].as_array().unwrap().iter().any(|message| {
        message["role"] == "system"
            && message["content"]
                .as_str()
                .is_some_and(|text| text.starts_with("Generate a short session title"))
    })
}
async fn pair(listener: &TcpListener) -> ((Value, TcpStream), (Value, TcpStream)) {
    let (mut first, _) = listener.accept().await.unwrap();
    let a = request(&mut first).await;
    // Both physical requests are admitted while neither response has finished.
    let (mut second, _) = listener.accept().await.unwrap();
    let b = request(&mut second).await;
    assert_ne!(is_title(&a), is_title(&b));
    if is_title(&a) {
        ((b, second), (a, first))
    } else {
        ((a, first), (b, second))
    }
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
async fn kimi_automatic_title_uses_low_without_defaulting_main_thinking() {
    tokio::time::timeout(Duration::from_secs(60), async {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let f = Fixture::configured_provider(
        &format!("http://{}/v1", listener.local_addr().unwrap()),
        None,
        None,
        None,
        |settings| settings.automatic_titles = true,
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
    let session = automatic(&f).await;
    let mut commits = f.session(&session).await.subscribe_commits().unwrap();
    let sent = f.send(&session).await.unwrap();
    let mut main_request = None;
    let mut title_request = None;
    // Baseline rejects auxiliary Low before HTTP. Observe that durable failure
    // instead of waiting for a second request which cannot arrive.
    loop {
        commits.borrow_and_update();
        let diagnostics = f
            .query(
                "diagnostics",
                json!({"sessionId":session,"position":{"kind":"latest"}}),
            )
            .await
            .unwrap();
        let failed = diagnostics["entries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["detail"]["kind"] == "session_title");
        if main_request.is_some() && (title_request.is_some() || failed) {
            break;
        }
        tokio::select! {
            accepted = listener.accept() => {
                let (mut socket, _) = accepted.unwrap();
                let body = tool_schemas::read_wire(&mut socket).await;
                if body["system"].to_string().contains("Generate a short session title") {
                    tool_schemas::anthropic_text_reply(&mut socket, "Kimi auxiliary title").await;
                    title_request = Some(body);
                } else {
                    tool_schemas::anthropic_text_reply(&mut socket, "Kimi main completed").await;
                    main_request = Some(body);
                }
            }
            changed = commits.changed() => { changed.unwrap(); }
        }
    }
    f.drained().await;
    let record = f.owner.session(&session).await.unwrap();
    let physical = attempts(&f, &session).await;
    let diagnostics = f
        .query(
            "diagnostics",
            json!({"sessionId":session,"position":{"kind":"latest"}}),
        )
        .await
        .unwrap();
    let boundary = f.session(&session).await.invocation_boundary(&session, sent["invocationId"].as_str().unwrap())
        .await
        .unwrap()
        .unwrap()
        .0;
    f.app.shutdown().await.unwrap();
    f.config.shutdown().await.unwrap();

    assert!(main_request.unwrap()["output_config"]["effort"].is_null());
    assert_eq!(
        record.configuration.title, "Kimi auxiliary title",
        "auxiliary preparation must succeed: {diagnostics}"
    );
    assert!(!record.configuration.title_is_manual);
    let title_request = title_request.expect("supported Kimi Low must reach actual Anthropic HTTP");
    assert_eq!(title_request["output_config"]["effort"], "low");
    assert_eq!(title_request["max_tokens"], 2048);
    assert!(title_request["tools"].is_null() || title_request["tools"] == json!([]));
    assert_eq!(diagnostics["entries"], json!([]));
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
        source: AuxiliarySource::SessionTitle { invocation }
    } if invocation == &boundary.invocation));
    assert_eq!(auxiliary.outcome, Outcome::Success);
    assert_eq!(auxiliary.usage.input_tokens, Some(1));
    assert_eq!(auxiliary.usage.output_tokens, Some(2));
    }).await.unwrap();
}

#[tokio::test]
async fn title_survives_main_completion_between_metadata_read_and_write() {
    verify_title_metadata_conflict(false).await;
}

#[tokio::test]
async fn title_retry_preserves_manual_placeholder_after_metadata_read() {
    verify_title_metadata_conflict(true).await;
}

async fn verify_title_metadata_conflict(manual_rename: bool) {
    tokio::time::timeout(Duration::from_secs(30), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = fixture(&format!("http://{}/v1", listener.local_addr().unwrap())).await;
        let session = automatic(&f).await;
        let sent = f.send(&session).await.unwrap();
        let ((_, mut main), (_, mut title)) = pair(&listener).await;
        let gate = Arc::new(super::super::title::WriteGate {
            entered: tokio::sync::Semaphore::new(0),
            release: tokio::sync::Semaphore::new(0),
        });
        *f.owner.title_write_gate.lock().unwrap() = Some(gate.clone());
        response_with_text(&mut title, "A title preserved across main completion").await;
        gate.entered.acquire().await.unwrap().forget();
        let before = f.owner.session(&session).await.unwrap();
        let observed_revision = before.revision;
        let mut expected = before.configuration;
        let mut commits = f.session(&session).await.subscribe_commits().unwrap();
        response(&mut main).await;
        let completed = loop {
            commits.borrow_and_update();
            let boundary = f
                .session(&session)
                .await
                .invocation_boundary(&session, sent["invocationId"].as_str().unwrap())
                .await
                .unwrap()
                .unwrap()
                .0;
            if matches!(
                boundary.state,
                maka_event_log::turns::InvocationState::Ended { .. }
            ) {
                break boundary;
            }
            commits.changed().await.unwrap();
        };
        let completed_revision = f.owner.session(&session).await.unwrap().revision;
        if manual_rename {
            // An external metadata writer can commit while this Owner holds its gate.
            let changed = f
                .session(&session)
                .await
                .update_session_metadata(
                    &session,
                    completed_revision,
                    |configuration: &mut StoredSessionConfiguration| {
                        configuration.title_is_manual = true;
                        configuration.labels = vec!["Preserved label".into()];
                        Ok(())
                    },
                )
                .await
                .unwrap();
            assert!(matches!(
                changed,
                maka_event_log::sessions::SessionMutation::Committed(_)
            ));
            expected.title_is_manual = true;
            expected.labels = vec!["Preserved label".into()];
        } else {
            expected.title = "A title preserved across main completion".into();
        }
        gate.release.add_permits(1);
        f.drained().await;
        let record = f.owner.session(&session).await.unwrap();
        let attempts = attempts(&f, &session).await;
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
        assert!(completed_revision > observed_revision);
        assert!(matches!(
            completed.state,
            maka_event_log::turns::InvocationState::Ended {
                outcome: maka_agent_facts::event::InvocationOutcome::Completed,
                ..
            }
        ));
        assert!(
            record.configuration == expected,
            "title update must preserve the expected session configuration"
        );
        let auxiliary: Vec<_> = attempts
            .iter()
            .filter(|attempt| matches!(attempt.origin, Origin::Auxiliary { .. }))
            .collect();
        assert_eq!(auxiliary.len(), 1);
        assert_eq!(auxiliary[0].outcome, Outcome::Success);
        assert_eq!(auxiliary[0].usage.input_tokens, Some(1));
        assert_eq!(auxiliary[0].usage.output_tokens, Some(2));
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn title_first_message_is_bounded_accounted_and_not_reissued_after_retry_or_restart() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut f = fixture(&format!("http://{}/v1", listener.local_addr().unwrap())).await;
        selection::thinking(&f, vec![ThinkingLevel::Off, ThinkingLevel::High], ThinkingLevel::High).await;
        let session = automatic(&f).await;
        let text = "中".repeat(5000);
        let input = json!({"sessionId":session,"message":text,"model":f.selection().await});
        let operation = Uuid::new_v4();
        let sent = f.mutation(2, "send", input.clone(), operation).await.unwrap();
        let ((main, mut main_socket), (title, mut title_socket)) = pair(&listener).await;
        assert_eq!(main["reasoning_effort"], "high");
        assert_eq!(title["reasoning_effort"], "none");
        assert_eq!(title["messages"][1]["content"], "中".repeat(4096));
        assert!(title["tools"].is_null() || title["tools"] == json!([]));
        assert!(title["max_tokens"] == 2048 || title["max_completion_tokens"] == 2048, "{title}");
        assert_eq!(f.mutation(2, "send", input, operation).await.unwrap(), sent);
        response(&mut main_socket).await;
        // An auxiliary title is owned by the Host, so main-turn completion does not cancel it.
        loop {
            let boundary = f.session(&session).await.invocation_boundary(&session, sent["invocationId"].as_str().unwrap()).await.unwrap().unwrap().0;
            if matches!(boundary.state, maka_event_log::turns::InvocationState::Ended { .. }) { break; }
            tokio::task::yield_now().await;
        }
        response_with_text(&mut title_socket, "  cafe\u{301}\n\u{202e}任务😀  ").await;
        f.drained().await;
        let record = f.owner.session(&session).await.unwrap();
        assert_eq!(record.configuration.title, "café 任务😀");
        assert!(!record.configuration.title_is_manual);
        let original = attempts(&f, &session).await;
        assert_eq!(original.len(), 2);
        let auxiliary = original.iter().find(|attempt| matches!(attempt.origin, Origin::Auxiliary { .. })).unwrap();
        assert!(matches!(&auxiliary.origin, Origin::Auxiliary { source: AuxiliarySource::SessionTitle { invocation } } if invocation.invocation_id == sent["invocationId"].as_str().unwrap()));
        assert_eq!(auxiliary.outcome, Outcome::Success);
        assert_eq!(auxiliary.usage.input_tokens, Some(1));
        assert_eq!(auxiliary.usage.output_tokens, Some(2));
        assert!(auxiliary.quote.is_some());
        todo_tests::reopen(&mut f).await;
        assert_eq!(attempts(&f, &session).await.len(), 2);
        f.send(&session).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        assert!(!is_title(&request(&mut socket).await));
        response(&mut socket).await;
        loop {
            let observation = f.query("observe", json!({"sessionId":session})).await.unwrap();
            if observation["run"].is_null() { break; }
            tokio::task::yield_now().await;
        }
        f.app.shutdown().await.unwrap();
        let current = attempts(&f, &session).await;
        assert_eq!(current.len(), 3);
        assert_eq!(current.iter().filter(|attempt| matches!(attempt.origin, Origin::Auxiliary { .. })).count(), 1);
        assert_eq!(f.session(&session).await.get_session::<StoredSessionConfiguration>(&session).await.unwrap().unwrap().configuration.title, "café 任务😀");
        f.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn title_manual_rename_even_to_placeholder_and_archive_win_in_flight() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = fixture(&format!("http://{}/v1", listener.local_addr().unwrap())).await;
        for archive in [false, true] {
            let session = automatic(&f).await;
            let sent = f.send(&session).await.unwrap();
            let ((_, mut main), (_, mut title)) = pair(&listener).await;
            response(&mut main).await;
            loop {
                let boundary = f.session(&session).await.invocation_boundary(&session, sent["invocationId"].as_str().unwrap()).await.unwrap().unwrap().0;
                if matches!(boundary.state, maka_event_log::turns::InvocationState::Ended { .. }) { break; }
                tokio::task::yield_now().await;
            }
            if archive {
                let revision = f.owner.session(&session).await.unwrap().revision;
                let result = f.mutation(2, "changeSession", json!({"sessionId":session,"expectedRevision":revision,"action":"archive"}), Uuid::new_v4()).await.unwrap();
                assert_eq!(result["kind"], "changed", "{result}");
            } else {
                let revision = f.owner.session(&session).await.unwrap().revision;
                let result = f.mutation(2, "metadata", json!({"sessionId":session,"expectedRevision":revision,"title":"Untitled","labels":[]}), Uuid::new_v4()).await.unwrap();
                assert_eq!(result["kind"], "committed", "{result}");
            }
            if archive {
                let mut byte = [0];
                assert_eq!(title.read(&mut byte).await.unwrap(), 0, "archive must await original title socket cleanup");
            } else {
                response_with_text(&mut title, "Must not replace the user's title").await;
            }
            f.drained().await;
            let record = f.owner.session(&session).await.unwrap();
            assert_eq!(record.configuration.title, "Untitled");
            assert_eq!(record.archived, archive);
            assert_eq!(record.configuration.title_is_manual, !archive);
            let original_attempts = attempts(&f, &session).await;
            assert_eq!(original_attempts.len(), 2);
            if archive {
                let title_attempt = original_attempts.iter().find(|attempt| matches!(attempt.origin, Origin::Auxiliary { .. })).unwrap();
                assert_eq!(title_attempt.outcome, Outcome::Aborted);
            }
        }
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn title_skips_manual_and_managed_sessions_before_model_dispatch() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = fixture(&format!("http://{}/v1", listener.local_addr().unwrap())).await;
        let manual = f.create("My chosen title").await;
        let mut configuration = f
            .session(&manual)
            .await
            .get_session::<StoredSessionConfiguration>(&manual)
            .await
            .unwrap()
            .unwrap()
            .configuration;
        configuration.title_is_manual = false;
        let managed = format!("{}{}", f.owner.prefix, Uuid::new_v4().simple());
        f.store
            .create_plugin_session(
                &maka_event_log::sessions::PluginSession {
                    session_id: managed.clone(),
                    creator: maka_capabilities::storage::Namespace::new(
                        "title.fixture",
                        maka_plugin_core::scope::Scope::Profile,
                    )
                    .unwrap(),
                    fingerprint: "managed-title".into(),
                    managed: true,
                    authority_session_id: None,
                },
                &configuration,
                now(),
            )
            .await
            .unwrap();
        for session in [&manual, &managed] {
            f.send(session).await.unwrap();
            let (mut socket, _) = listener.accept().await.unwrap();
            assert!(!is_title(&request(&mut socket).await));
            response(&mut socket).await;
            f.drained().await;
            assert_eq!(attempts(&f, session).await.len(), 1);
            assert_eq!(
                f.owner.session(session).await.unwrap().configuration.title,
                "My chosen title"
            );
        }
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn title_invalid_finish_keeps_observed_usage_and_never_retries() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = fixture(&format!("http://{}/v1", listener.local_addr().unwrap())).await;
        let session = automatic(&f).await;
        f.send(&session).await.unwrap();
        let ((_, mut main), (_, mut title)) = pair(&listener).await;
        response(&mut main).await;
        let end = json!({"id":"fixture","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":7,"completion_tokens":9,"total_tokens":16}});
        let body = format!("data: {end}\n\ndata: [DONE]\n\n");
        title.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
        f.drained().await;
        let attempts = attempts(&f, &session).await;
        let auxiliary = attempts.iter().find(|attempt| matches!(attempt.origin, Origin::Auxiliary { .. })).unwrap();
        assert_eq!(auxiliary.outcome, Outcome::Error);
        assert_eq!(auxiliary.usage.input_tokens, Some(7));
        assert_eq!(auxiliary.usage.output_tokens, Some(9));
        assert_eq!(f.owner.session(&session).await.unwrap().configuration.title, "Untitled");
        f.send(&session).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        assert!(!is_title(&request(&mut socket).await));
        response(&mut socket).await;
        f.drained().await;
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn title_host_shutdown_awaits_socket_cleanup_and_restart_does_not_replay() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut f = fixture(&format!("http://{}/v1", listener.local_addr().unwrap())).await;
        let session = automatic(&f).await;
        f.send(&session).await.unwrap();
        let ((_, mut main), (_, mut title)) = pair(&listener).await;
        response(&mut main).await;
        f.app.shutdown().await.unwrap();
        let mut buffer = [0; 1];
        assert_eq!(title.read(&mut buffer).await.unwrap(), 0);
        assert!(f.owner.auxiliary.resources.is_idle());
        let original = attempts(&f, &session).await;
        let auxiliary = original
            .iter()
            .find(|attempt| matches!(attempt.origin, Origin::Auxiliary { .. }))
            .unwrap();
        assert_eq!(auxiliary.outcome, Outcome::Aborted);
        todo_tests::reopen(&mut f).await;
        f.send(&session).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        assert!(!is_title(&request(&mut socket).await));
        response(&mut socket).await;
        loop {
            if f.query("observe", json!({"sessionId":session}))
                .await
                .unwrap()["run"]
                .is_null()
            {
                break;
            }
            tokio::task::yield_now().await;
        }
        f.app.shutdown().await.unwrap();
        assert_eq!(
            attempts(&f, &session)
                .await
                .iter()
                .filter(|attempt| matches!(attempt.origin, Origin::Auxiliary { .. }))
                .count(),
            1
        );
        assert_eq!(
            f.session(&session)
                .await
                .get_session::<StoredSessionConfiguration>(&session)
                .await
                .unwrap()
                .unwrap()
                .configuration
                .title,
            "Untitled"
        );
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn title_settlement_fault_fences_owner_and_preserves_original_usage_for_recovery() {
    tokio::time::timeout(Duration::from_secs(30), async {
        const SQL_SECRET: &str = "SECRET_TITLE_SETTLEMENT_SQL_PAYLOAD";
        let (mut capture, _log_guard) = log_capture();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let f = fixture(&base).await;
        let activation = f.owner.revision.activation.clone();
        let session = automatic(&f).await;
        let sent = f.send(&session).await.unwrap();
        let ((_, mut main), (_, mut title)) = pair(&listener).await;
        let raw = rusqlite::Connection::open(f.session_database(&session)).unwrap();
        raw.execute_batch(&format!("CREATE TRIGGER hold_title_settlement BEFORE INSERT ON event_log WHEN NEW.kind='auxiliary_model_settled' BEGIN SELECT RAISE(ABORT, '{SQL_SECRET}'); END;")).unwrap();
        response(&mut main).await;
        let completed = loop {
            let boundary = f.session(&session).await.invocation_boundary(&session, sent["invocationId"].as_str().unwrap()).await.unwrap().unwrap().0;
            if matches!(boundary.state, maka_event_log::turns::InvocationState::Ended { .. }) { break boundary; }
            tokio::task::yield_now().await;
        };
        response_with_text(&mut title, "Uncommitted title").await;
        f.drained().await;
        assert!(f.owner.runs.lock().await.closing);
        assert!(f.owner.stop.is_cancelled());
        assert_eq!(f.send(&session).await.unwrap_err(), "agent_closed");
        assert_eq!(f.owner.session(&session).await.unwrap().configuration.title, "Untitled");
        let count: i64 = raw.query_row("SELECT COUNT(*) FROM event_log WHERE kind='auxiliary_model_settled'", [], |row| row.get(0)).unwrap();
        assert_eq!(count, 0);
        raw.execute_batch("DROP TRIGGER hold_title_settlement").unwrap();
        f.app.shutdown().await.unwrap();
        // The exclusive startup recovery owns this transition, never plugin activation.
        f.store.recover_auxiliary_models().await.unwrap();
        let original = attempts(&f, &session).await;
        let auxiliary = original.iter().find(|attempt| matches!(attempt.origin, Origin::Auxiliary { .. })).unwrap();
        assert_eq!(auxiliary.outcome, Outcome::Unknown);
        assert_eq!(auxiliary.usage.input_tokens, Some(1));
        assert_eq!(auxiliary.usage.output_tokens, Some(2));
        f.config.shutdown().await.unwrap();
        assert!(matches!(completed.state, maka_event_log::turns::InvocationState::Ended {
            outcome: maka_agent_facts::event::InvocationOutcome::Completed, ..
        }));
        assert!(matches!(&auxiliary.origin, Origin::Auxiliary {
            source: AuxiliarySource::SessionTitle { invocation }
        } if invocation == &completed.invocation));
        let log = log_text(&mut capture);
        let settlement = log.lines().find(|line| line.contains("stage=\"auxiliary_model_settlement_failed\""))
            .expect("typed SQL settlement failure must be logged before it becomes a persistence string");
        assert!(settlement.contains("ERROR"));
        assert!(settlement.contains("cause=\"store_sqlx\""));
        assert!(settlement.contains("sql_code=1811"));
        assert!(settlement.contains("request_id=") && settlement.contains(&auxiliary.request_id));
        let fatal = log.lines().find(|line| line.contains("stage=\"title_worker_persistence_failed\""))
            .expect("title worker must log its actual owner-closing consequence");
        assert!(fatal.contains("ERROR"));
        assert!(fatal.contains("consequence=\"owner_closing\""));
        for identity in [&completed.invocation.session_id, &completed.invocation.turn_id, &completed.invocation.run_id, &completed.invocation.invocation_id, &activation] {
            assert!(fatal.contains(identity), "title fatal event must retain its triggering invocation/activation: {fatal}");
        }
        for secret in [SQL_SECRET, "private-fixture-key", "Uncommitted title", "Hello", base.as_str()] {
            assert!(!log.contains(secret), "typed cause and custody events must exclude SQL messages, credentials, input, title and URLs");
        }
    }).await.unwrap();
}

#[derive(Clone, Copy)]
enum VisibleTitleFailure {
    Http,
    OutputLimit,
    EmptyOutput,
}

#[tokio::test]
async fn title_http_failure_is_public_sanitized_and_survives_restart() {
    verify_visible_title_failure(VisibleTitleFailure::Http).await;
}

#[tokio::test]
async fn title_output_limit_is_public_without_changing_successful_physical_accounting() {
    verify_visible_title_failure(VisibleTitleFailure::OutputLimit).await;
}

#[tokio::test]
async fn title_empty_output_is_public_without_changing_successful_physical_accounting() {
    verify_visible_title_failure(VisibleTitleFailure::EmptyOutput).await;
}

async fn verify_visible_title_failure(case: VisibleTitleFailure) {
    tokio::time::timeout(Duration::from_secs(30), async {
        const SECRET: &str = "SECRET_TITLE_PROVIDER_BODY_SENTINEL";
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut f = fixture(&format!("http://{}/v1", listener.local_addr().unwrap())).await;
        let session = automatic(&f).await;
        let other = f.create("Unaffected session").await;
        let sent = f.send(&session).await.unwrap();
        let ((_,mut main),(_,mut title)) = pair(&listener).await;
        response(&mut main).await;
        let completed = loop {
            let boundary = f.session(&session).await.invocation_boundary(&session,sent["invocationId"].as_str().unwrap()).await.unwrap().unwrap().0;
            if matches!(boundary.state,maka_event_log::turns::InvocationState::Ended {..}) {break boundary;}
            tokio::task::yield_now().await;
        };
        let diagnostic_watch = if matches!(case,VisibleTitleFailure::Http) {
            let mut watch=f.app.client().subscribe(f.binding(2).await,"watchDiagnostics".into(),json!({"sessionId":session}),
                scope(&f.issuer,true),Attachments::default().into()).await.unwrap();
            let initial=watch.recv().await.unwrap();
            Some((watch,initial))
        } else {None};
        let before_failure = now();
        let (status,content_type,body,cause,physical_outcome) = match case {
            VisibleTitleFailure::Http => (
                "400 Bad Request", "application/json",
                json!({"error":{"type":"invalid_request_error","message":SECRET}}).to_string(),
                json!({"kind":"model","cause":{"kind":"http","status":400}}), Outcome::Error,
            ),
            VisibleTitleFailure::OutputLimit | VisibleTitleFailure::EmptyOutput => {
                let limited = matches!(case,VisibleTitleFailure::OutputLimit);
                let text = if limited {"A partial title"} else {" \n\t\u{0000}\u{202e} "};
                let delta = json!({"id":"title-failure","choices":[{"index":0,"delta":{"content":text},"finish_reason":null}]});
                let end = json!({"id":"title-failure","choices":[{"index":0,"delta":{},"finish_reason":if limited {"length"} else {"stop"}}],"usage":{"prompt_tokens":7,"completion_tokens":9,"total_tokens":16}});
                ("200 OK","text/event-stream",format!("data: {delta}\n\ndata: {end}\n\ndata: [DONE]\n\n"),
                    json!({"kind":if limited {"output_limit"} else {"empty_output"}}),Outcome::Success)
            }
        };
        title.write_all(format!("HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
        f.drained().await;
        let after_failure = now();
        let watched = if let Some((mut watch,initial))=diagnostic_watch {
            let late=watch.recv().await.unwrap();
            let revision=f.owner.session(&other).await.unwrap().revision;
            f.mutation(2,"metadata",json!({"sessionId":other,"expectedRevision":revision,"title":"Unrelated metadata commit","labels":[]}),Uuid::new_v4()).await.unwrap();
            let unrelated_update=tokio::time::timeout(Duration::from_millis(30),watch.recv()).await.is_ok();
            drop(watch);
            Some((initial,late,unrelated_update))
        } else {None};
        let observed = f.query("observe",json!({"sessionId":session})).await.unwrap();
        let record = f.owner.session(&session).await.unwrap();
        let original_attempts = attempts(&f,&session).await;
        let diagnostics = f.query("diagnostics",json!({"sessionId":session,"position":{"kind":"latest"}})).await;
        let scoped = f.query("diagnostics",json!({"sessionId":other,"position":{"kind":"latest"}})).await;
        let foreign = f.query("diagnostics",json!({"sessionId":"foreign_session","position":{"kind":"latest"}})).await;
        todo_tests::reopen(&mut f).await;
        let restored = f.query("diagnostics",json!({"sessionId":session,"position":{"kind":"latest"}})).await;
        let restored_attempts = attempts(&f,&session).await;
        let reconnected = if matches!(case,VisibleTitleFailure::Http) {
            let mut watch=f.app.client().subscribe(f.binding(2).await,"watchDiagnostics".into(),json!({"sessionId":session}),
                scope(&f.issuer,true),Attachments::default().into()).await.unwrap();
            let initial=watch.recv().await.unwrap();
            drop(watch);
            Some(initial)
        } else {None};
        let redispatched = tokio::time::timeout(Duration::from_millis(30),listener.accept()).await.is_ok();
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
        assert!(matches!(completed.state,maka_event_log::turns::InvocationState::Ended {
            outcome:maka_agent_facts::event::InvocationOutcome::Completed,..}));
        assert!(observed["run"].is_null());
        assert_eq!(record.configuration.title,"Untitled");
        assert!(!record.configuration.title_is_manual);
        assert_eq!(original_attempts.len(),2);
        let auxiliary = original_attempts.iter().find(|attempt|matches!(attempt.origin,Origin::Auxiliary {..})).unwrap();
        assert_eq!(auxiliary.outcome,physical_outcome);
        if !matches!(case,VisibleTitleFailure::Http) {
            assert_eq!(auxiliary.usage.input_tokens,Some(7));
            assert_eq!(auxiliary.usage.output_tokens,Some(9));
        }
        assert_eq!(restored_attempts,original_attempts);
        assert!(!redispatched);
        let diagnostics = diagnostics.expect("public diagnostics must expose the actual title failure");
        let restored = restored.expect("public diagnostics must persist across restart");
        let scoped = scoped.expect("owned-session diagnostics must be readable");
        assert_eq!(diagnostics["entries"].as_array().unwrap().len(),1);
        let failure = &diagnostics["entries"][0];
        let sequence = failure["sequence"].as_u64().expect("diagnostic must identify its durable sequence");
        assert!(sequence > 0);
        let event_id = failure["eventId"].as_str().expect("diagnostic must identify its actual event");
        assert!(!event_id.is_empty());
        let recorded_at = failure["recordedAt"].as_f64().expect("diagnostic must include its Host capture time");
        assert!((before_failure as f64..=(after_failure+1) as f64).contains(&recorded_at));
        assert_eq!(*failure,json!({"sequence":sequence,"eventId":event_id,"recordedAt":recorded_at,
            "detail":{"kind":"session_title","invocation":completed.invocation,"cause":cause}}));
        assert_eq!(restored["entries"],diagnostics["entries"]);
        if let Some((initial,late,unrelated_update))=watched {
            assert_eq!(initial,json!({"revision":0}));
            assert_eq!(late,json!({"revision":sequence}),"late title completion must notify after the main invocation ends");
            assert!(!unrelated_update,"another session's metadata commit must not emit a diagnostic revision");
            assert_eq!(reconnected,Some(json!({"revision":sequence})),"reconnect must begin with the latest diagnostic independent of transcript progress");
        }
        assert_eq!(scoped["entries"],json!([]),"failure must not leak into another owned session");
        assert!(foreign.is_err(),"foreign-session diagnostics must remain unauthorized");
        assert!(!diagnostics.to_string().contains(SECRET));
        assert!(!restored.to_string().contains(SECRET));
    }).await.unwrap();
}

#[tokio::test]
async fn title_preparation_failure_is_public_without_a_physical_title_attempt() {
    tokio::time::timeout(Duration::from_secs(30),async {
        let (mut capture, _log_guard) = log_capture();
        let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();
        // Automatic dispatch is disabled; this test calls generation once from
        // the actual first opening's frozen source after its connection changes.
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let f=Fixture::new(&base,None).await;
        let connection = f.selection().await.connection_id;
        let session=automatic(&f).await;
        let sent=f.send(&session).await.unwrap();
        let (mut socket,_)=listener.accept().await.unwrap();
        request(&mut socket).await;
        let accepted=f.owner.runs.lock().await.controls.get(&session).unwrap().basis.model.clone().unwrap();
        response(&mut socket).await;
        f.drained().await;
        let opening=f.session(&session).await.invocation_boundary(&session,sent["invocationId"].as_str().unwrap()).await.unwrap().unwrap().0;
        selection::edit(&f,|changes| changes.enabled=Some(false)).await;
        f.owner.generate_title(opening.invocation.clone(),accepted).await.unwrap();
        let diagnostics=f.query("diagnostics",json!({"sessionId":session,"position":{"kind":"latest"}})).await;
        let actual_attempts=attempts(&f,&session).await;
        let record=f.owner.session(&session).await.unwrap();
        let dispatched=tokio::time::timeout(Duration::from_millis(30),listener.accept()).await.is_ok();
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
        assert!(matches!(opening.state,maka_event_log::turns::InvocationState::Ended {
            outcome:maka_agent_facts::event::InvocationOutcome::Completed,..}));
        assert_eq!(actual_attempts.len(),1);
        assert!(matches!(actual_attempts[0].origin,Origin::Agent {..}));
        assert_eq!(actual_attempts[0].outcome,Outcome::Success);
        assert!(!dispatched,"capture failure must not invent a physical request or title attempt");
        assert_eq!(record.configuration.title,"Untitled");
        assert!(!record.configuration.title_is_manual);
        let diagnostics=diagnostics.expect("actual pre-capture title failure must be public");
        let entries=diagnostics["entries"].as_array().unwrap();
        assert_eq!(entries.len(),1);
        assert_eq!(entries[0]["detail"],json!({"kind":"session_title","invocation":opening.invocation,"cause":{"kind":"preparation"}}));
        assert!(entries[0]["sequence"].as_u64().is_some_and(|sequence|sequence>0));
        assert!(entries[0]["eventId"].as_str().is_some_and(|id|!id.is_empty()));
        assert!(entries[0]["recordedAt"].as_f64().is_some());
        let log = log_text(&mut capture);
        let cause = log.lines().find(|line| line.contains("stage=\"accepted_model_observation\"")
            && line.contains("cause=\"accepted_source_unavailable\""))
            .expect("title preparation must retain its unavailable accepted-source cause");
        assert!(cause.contains("session_id=") && cause.contains(&session));
        assert!(cause.contains("connection_id=") && cause.contains(&connection));
        for secret in ["private-fixture-key", base.as_str(), "Hello"] {
            assert!(!log.contains(secret), "title preparation warning must omit credentials, URL and original input");
        }
    }).await.unwrap();
}

#[tokio::test]
async fn independently_admitted_title_uses_current_language_after_english_main_capture() {
    tokio::time::timeout(Duration::from_secs(45), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        // Reuse the explicit generation path from title_preparation_failure:
        // automatic dispatch is disabled so Settings can change after Main capture.
        let f = Fixture::new(&format!("http://{}/v1", listener.local_addr().unwrap()), None).await;
        let english = prompt_language::select_language(&f, "en").await;
        let session = automatic(&f).await;
        let original = "Please investigate title capture 🦀 /keep-original-bytes";
        let sent = f.mutation(2, "send", json!({
            "sessionId":session,"message":original,"model":f.selection().await,
        }), Uuid::new_v4()).await.unwrap();
        let (mut main_socket, _) = listener.accept().await.unwrap();
        let main_request = request(&mut main_socket).await;
        let accepted = f.owner.runs.lock().await.controls.get(&session).unwrap().basis.model.clone().unwrap();
        let opening = f.session(&session).await.invocation_boundary(&session, sent["invocationId"].as_str().unwrap())
            .await.unwrap().unwrap().0;
        let configuration = f.session(&(opening.invocation).session_id).await.invocation_configuration(&opening.invocation).await.unwrap().unwrap();
        let chinese = prompt_language::select_language(&f, "zh-CN").await;
        let (generated, title_request) = tokio::join!(
            f.owner.generate_title(opening.invocation, accepted),
            async {
                let (mut title_socket, _) = listener.accept().await.unwrap();
                let outgoing = request(&mut title_socket).await;
                response_with_text(&mut title_socket, "Investigate title capture").await;
                outgoing
            }
        );
        response(&mut main_socket).await;
        f.drained().await;
        let title = f.owner.session(&session).await.unwrap().configuration.title;
        let physical_attempts = attempts(&f, &session).await;
        let raw = rusqlite::Connection::open_with_flags(
            f.session_database(&session),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        ).unwrap();
        let recorded_language: String = raw.query_row(
            "SELECT json_extract(event_json, '$.language') FROM event_log WHERE kind='auxiliary_model_started' AND json_extract(event_json, '$.source.kind')='session_title' AND json_extract(event_json, '$.source.invocation.session_id')=?1",
            [&session], |row| row.get(0),
        ).unwrap();
        drop(raw);
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();

        assert_eq!(english["kind"], "committed");
        assert_eq!(chinese["kind"], "committed");
        assert!(generated.is_ok(), "title generation failed: {generated:?}");
        assert_eq!(configuration.language, maka_agent_facts::language::Language::En);
        assert_eq!(main_request["messages"].as_array().unwrap().iter()
            .find(|message| message["role"] == "user").unwrap()["content"], original);
        assert_eq!(title_request["messages"][1]["content"], original);
        let instruction = title_request["messages"][0]["content"].as_str().unwrap();
        assert!(instruction.contains("会话标题"), "new title capture must use current Chinese builtin copy: {title_request}");
        assert!(instruction.contains("与消息语言相同"), "the title's output language still follows original user text: {title_request}");
        assert_eq!(recorded_language, "zh-CN");
        assert_eq!(title, "Investigate title capture");
        assert_eq!(physical_attempts.len(), 2);
        assert_eq!(physical_attempts.iter().filter(|attempt| matches!(attempt.origin, Origin::Auxiliary { .. })).count(), 1);
    }).await.unwrap();
}
