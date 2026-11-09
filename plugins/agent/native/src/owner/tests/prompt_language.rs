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

async fn settings_binding(app: &Application, consumer: u128) -> Binding {
    let client = app.client();
    client
        .bind(client.activation(&id(consumer)).unwrap(), "settings".into())
        .await
        .unwrap()
        .remove(0)
}

async fn preferences(app: &Application, issuer: &Issuer, consumer: u128) -> Value {
    app.client()
        .start(
            settings_binding(app, consumer).await,
            "assistantPreferences".into(),
            json!({}),
            scope(issuer, true),
            Attachments::new().into(),
        )
        .await
        .unwrap()
        .result()
        .await
        .unwrap()
}

async fn update_preferences(
    app: &Application,
    issuer: &Issuer,
    consumer: u128,
    revision: &Value,
    mutation: Value,
) -> Value {
    let client = app.client();
    let input = json!({"expectedRevision":revision,"mutation":mutation});
    let prepared = client
        .prepare_mutation(
            settings_binding(app, consumer).await,
            "updateAssistantPreferences".into(),
            input.clone(),
            scope(issuer, true),
            Uuid::new_v4(),
            Attachments::new().into(),
        )
        .await
        .unwrap();
    let reply = client
        .mutate_owned(prepared, input)
        .await
        .unwrap()
        .result()
        .await;
    let Receipt::Recorded {
        outcome:
            OperationOutcome::Returned {
                result: maka_plugin_core::operation::OperationResult::Success { value },
            },
        ..
    } = reply.receipt
    else {
        panic!("unexpected preference receipt: {:?}", reply.receipt)
    };
    value
}

async fn assistant_fixture(listener: &TcpListener, home: &std::path::Path) -> Fixture {
    Fixture::configured(
        &format!("http://{}/v1", listener.local_addr().unwrap()),
        None,
        None,
        None,
        |settings| {
            settings.assistant = Some(contract::AssistantConfiguration {
                home: Some(home.to_str().unwrap().into()),
            })
        },
    )
    .await
}

pub(super) async fn select_language(fixture: &Fixture, preference: &str) -> Value {
    let current = preferences(&fixture.app, &fixture.issuer, 2).await;
    update_preferences(
        &fixture.app,
        &fixture.issuer,
        2,
        &current["revision"],
        json!({"kind":"language","preference":preference}),
    )
    .await
}

async fn stored_configuration(fixture: &Fixture, started: &Value) -> Value {
    let run = fixture.delivered_run(started).await;
    let source = fixture
        .history(started["sessionId"].as_str().unwrap())
        .run_source(run)
        .await
        .unwrap();
    serde_json::to_value(source.spec).unwrap()
}

fn assert_delivered_language(request: &Value, configuration: &Value, language: &str, user: &str) {
    let messages = request["messages"].as_array().unwrap();
    assert_eq!(
        messages
            .iter()
            .rev()
            .find(|message| message["role"] == "user")
            .unwrap()["content"],
        user,
        "original user bytes must reach the provider: {request}"
    );
    let identity = match language {
        "en" => "You are [Maka](https://github.com/apache/maka), an AI agent.",
        "zh-CN" => "你是 [Maka](https://github.com/apache/maka)，一个 AI Agent。",
        "zh-TW" => "你是 [Maka](https://github.com/apache/maka)，一個 AI Agent。",
        _ => unreachable!(),
    };
    assert!(
        messages
            .iter()
            .filter(|message| message["role"] == "system")
            .any(|message| message["content"].as_str().unwrap().contains(identity)),
        "selected {language} identity must reach the provider: {request}; configuration: {configuration}"
    );
    assert_eq!(
        configuration["language"], language,
        "the accepted Run stores its exact language, including explicit English: {configuration}"
    );
}

#[tokio::test]
async fn two_existing_sessions_use_current_language_for_each_new_capture() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let home = tempfile::tempdir().unwrap();
        let fixture = assistant_fixture(&listener, home.path()).await;
        let sessions = [fixture.create("Existing first").await, fixture.create("Existing second").await];
        let mut receipts = Vec::new();
        let mut captures = Vec::new();
        for language in ["en", "zh-CN", "zh-TW"] {
            receipts.push(select_language(&fixture, language).await);
            for (index, session) in sessions.iter().enumerate() {
                let original = format!("LANGUAGE_ORIGINAL_{index}_{language}_🦀\n原样引用 \\\"untouched\\\"");
                let sent = fixture.mutation(2, "send", json!({"sessionId":session,"message":original,"backend":model_backend(&fixture.selection().await)}), Uuid::new_v4()).await.unwrap();
                let (mut socket, _) = listener.accept().await.unwrap();
                let outgoing = request(&mut socket).await;
                response(&mut socket).await;
                fixture.drained().await;
                let configuration = stored_configuration(&fixture,&sent).await;
                captures.push((outgoing, configuration, language, original));
            }
        }
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();

        for receipt in receipts { assert_eq!(receipt["kind"], "committed"); }
        for (request, configuration, language, original) in captures {
            assert_delivered_language(&request, &configuration, language, &original);
        }
    }).await.unwrap();
}
