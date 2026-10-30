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
async fn title_http_failure_is_public_sanitized_and_survives_restart() {
    tokio::time::timeout(Duration::from_secs(30), async {
        const SECRET: &str = "SECRET_TITLE_PROVIDER_BODY_SENTINEL";
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut f = fixture(&format!("http://{}/v1", listener.local_addr().unwrap())).await;
        let session = automatic(&f).await;
        f.send(&session).await.unwrap();
        let ((_, mut main), (_, mut title)) = pair(&listener).await;
        response(&mut main).await;
        let body = json!({"error":{"type":"invalid_request_error","message":SECRET}}).to_string();
        title.write_all(format!(
            "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len(),
        ).as_bytes()).await.unwrap();
        f.drained().await;
        let input = json!({"sessionId":session,"position":{"kind":"latest"}});
        let diagnostics = f.query("diagnostics", input.clone()).await.unwrap();
        assert_eq!(diagnostics["entries"].as_array().unwrap().len(), 1);
        assert_eq!(diagnostics["entries"][0]["detail"]["cause"],
            json!({"kind":"model","cause":{"kind":"http","status":400}}));
        assert!(!diagnostics.to_string().contains(SECRET));
        let original_attempts = attempts(&f, &session).await;
        let auxiliary = original_attempts.iter()
            .find(|attempt| matches!(attempt.origin, Origin::Auxiliary { .. })).unwrap();
        assert_eq!(auxiliary.outcome, Outcome::Error);
        todo_tests::reopen(&mut f).await;
        assert_eq!(f.query("diagnostics", input).await.unwrap()["entries"], diagnostics["entries"]);
        assert_eq!(attempts(&f, &session).await, original_attempts);
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
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
