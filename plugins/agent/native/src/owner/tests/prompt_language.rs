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
    let prepared = client
        .prepare_mutation(
            settings_binding(app, consumer).await,
            "updateAssistantPreferences".into(),
            json!({"expectedRevision":revision,"mutation":mutation}),
            scope(issuer, true),
            Uuid::new_v4(),
            Attachments::new().into(),
        )
        .await
        .unwrap();
    let reply = client.mutate_owned(prepared).await.unwrap().result().await;
    let Receipt::Recorded {
        outcome: OperationOutcome::Returned { value },
        ..
    } = reply.receipt
    else {
        panic!("unexpected preference receipt: {:?}", reply.receipt)
    };
    value
}

async fn start_settings_app(fixture: &Fixture, deployment: Uuid) -> Application {
    let mut native = NativeRegistry::default();
    maka_settings_native::provide(&mut native, crate::owner::tests::bundled_catalog()).unwrap();
    provide_all(&mut native).unwrap();
    let app = Application::start_from_store(
        fixture.store.clone(),
        deployment,
        native,
        fixture.issuer.clone(),
        Arc::new(Grant(fixture.issuer.clone(), None)),
        Some(maka_host_js::factory(Default::default())),
    )
    .await
    .unwrap();
    app.ready().await.unwrap();
    app
}

async fn configured_settings_app(fixture: &Fixture, locale: &str) -> (Uuid, Application) {
    let (mut composition, mut packages) = input(&fixture.owner.settings);
    let package = packages
        .iter_mut()
        .find(|package| package.manifest().id == "settings")
        .unwrap();
    let previous = package.application_ref();
    let mut manifest = package.manifest().clone();
    let mut declaration = manifest.application.as_ref().unwrap().declaration().clone();
    declaration
        .entries
        .get_mut(&EntryTarget::Host)
        .unwrap()
        .configuration = maka_settings_native::native().configuration;
    manifest.application =
        Some(maka_plugin_core::package::CheckedDeclaration::new(declaration).unwrap());
    let mut files = package.files().clone();
    files.insert(MANIFEST_FILE.into(), serde_json::to_vec(&manifest).unwrap());
    *package = Package::new(files).unwrap();
    for node in composition
        .instances
        .values_mut()
        .filter(|node| node.package == previous.clone().into())
    {
        node.package = package.application_ref().into();
        node.configuration
            .values
            .insert("locale".into(), json!(locale));
    }
    let deployment = Uuid::new_v4();
    fixture
        .store
        .commit_application(deployment, 0, composition, vec![], packages)
        .await
        .unwrap();
    (deployment, start_settings_app(fixture, deployment).await)
}

#[tokio::test]
async fn settings_surfaces_share_saved_language_and_cas_across_activation() {
    tokio::time::timeout(Duration::from_secs(45), async {
        let fixture = Fixture::new("http://127.0.0.1:9/v1", None).await;
        let native = preferences(&fixture.app, &fixture.issuer, 2).await;
        let (deployment, configured) = configured_settings_app(&fixture, "zh-Hans-CN").await;
        let initial = preferences(&configured, &fixture.issuer, 3).await;
        let personalized = update_preferences(&configured, &fixture.issuer, 3, &initial["revision"],
            json!({"kind":"personalization","displayName":"language-authority-用户"})).await;
        let chinese = update_preferences(&fixture.app, &fixture.issuer, 2, &personalized["revision"],
            json!({"kind":"language","preference":"zh-TW"})).await;
        let shared = preferences(&configured, &fixture.issuer, 3).await;
        let stale = update_preferences(&configured, &fixture.issuer, 3, &personalized["revision"],
            json!({"kind":"language","preference":"en"})).await;
        let after_stale = preferences(&fixture.app, &fixture.issuer, 2).await;
        let english = update_preferences(&fixture.app, &fixture.issuer, 2, &shared["revision"],
            json!({"kind":"language","preference":"en"})).await;
        configured.shutdown().await.unwrap();
        let reopened = start_settings_app(&fixture, deployment).await;
        let restored = preferences(&reopened, &fixture.issuer, 3).await;
        let automatic = update_preferences(&reopened, &fixture.issuer, 3, &restored["revision"],
            json!({"kind":"language","preference":"auto"})).await;
        let auto_configured = preferences(&reopened, &fixture.issuer, 3).await;
        let auto_native = preferences(&fixture.app, &fixture.issuer, 2).await;
        reopened.shutdown().await.unwrap();
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();

        assert_eq!(native["language"], Value::Null);
        assert_eq!(initial["language"], Value::Null);
        assert_eq!(initial["resolvedLanguage"], "zh-CN");
        assert_eq!(personalized["kind"], "committed");
        assert_eq!(chinese["kind"], "committed");
        assert_eq!(shared["language"], "zh-TW");
        assert_eq!(shared["resolvedLanguage"], "zh-TW");
        assert_eq!(stale, json!({"kind":"revision_conflict","expectedRevision":personalized["revision"],"actualRevision":chinese["revision"]}));
        assert_eq!(after_stale, shared, "a stale surface cannot replace the shared policy");
        assert_eq!(english["kind"], "committed");
        assert_eq!(restored["language"], "en", "explicit English survives reopening as a saved override");
        assert_eq!(restored["resolvedLanguage"], "en");
        assert_eq!(automatic["kind"], "committed");
        assert_eq!(auto_configured["language"], "auto");
        assert_eq!(auto_configured["resolvedLanguage"], native["resolvedLanguage"], "explicit Auto bypasses the configured Chinese locale");
        assert_eq!(auto_configured, auto_native);
        assert_eq!(auto_configured["displayName"], "language-authority-用户");
    }).await.unwrap();
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

fn stored_configuration(fixture: &Fixture, invocation: &str) -> Value {
    let connection = rusqlite::Connection::open_with_flags(
        fixture.runtime_database_containing("SELECT COUNT(*) FROM runtime_events WHERE invocation_id=?1 AND kind='invocation_opened'", invocation),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let raw: String = connection.query_row(
        "SELECT json_extract(event_json, '$.fact.configuration') FROM runtime_events WHERE invocation_id=?1 AND kind='invocation_opened'",
        [invocation], |row| row.get(0),
    ).unwrap();
    serde_json::from_str(&raw).unwrap()
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
    if language == "en" {
        assert!(
            configuration.get("language").is_none(),
            "English uses canonical field omission in stored opening JSON: {configuration}"
        );
    } else {
        assert_eq!(
            configuration["language"], language,
            "full language tag must be stored in the accepted opening: {configuration}"
        );
    }
}

fn assert_delivered_static(request: &Value, accepted: &str) {
    assert!(
        request["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|message| message["role"] == "system")
            .any(|message| message["content"].as_str().unwrap().contains(accepted)),
        "actual provider request must retain accepted static instructions: {request}"
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
                let sent = fixture.mutation(2, "send", json!({"sessionId":session,"message":original,"model":fixture.selection().await}), Uuid::new_v4()).await.unwrap();
                let (mut socket, _) = listener.accept().await.unwrap();
                let outgoing = request(&mut socket).await;
                response(&mut socket).await;
                fixture.drained().await;
                let configuration = stored_configuration(&fixture, sent["invocationId"].as_str().unwrap());
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

#[tokio::test]
async fn accepted_queue_and_explicit_resume_keep_english_across_language_changes() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let home = tempfile::tempdir().unwrap();
        let fixture = assistant_fixture(&listener, home.path()).await;
        let first = fixture.create("Accepted English work").await;
        let other = fixture.create("Fresh independently captured work").await;
        let english = select_language(&fixture, "en").await;
        let held_text = "HELD_ORIGINAL_🦀 English accepted work";
        let held = fixture.mutation(2, "send", json!({"sessionId":first,"message":held_text,"model":fixture.selection().await}), Uuid::new_v4()).await.unwrap();
        let (mut held_socket, _) = listener.accept().await.unwrap();
        let held_request = request(&mut held_socket).await;
        let held_configuration = stored_configuration(&fixture, held["invocationId"].as_str().unwrap());
        let queued_text = "QUEUED_ORIGINAL_🦀 中文数据 must remain untouched";
        let queue_input = json!({"sessionId":first,"message":queued_text,"model":fixture.selection().await});
        let operation = Uuid::new_v4();
        let queued = fixture.mutation(2, "send", queue_input.clone(), operation).await.unwrap();
        let queue = fixture.session(&first).await.message_queue(&first).await.unwrap();
        let queued_basis = queue.entries.iter().find(|entry| entry.source.message.message_id == queued["messageId"])
            .unwrap().execution.basis.clone();
        let chinese = select_language(&fixture, "zh-CN").await;
        let fresh_text = "FRESH_ORIGINAL_🦀 English data after Chinese selection";
        let fresh = fixture.mutation(2, "send", json!({"sessionId":other,"message":fresh_text,"model":fixture.selection().await}), Uuid::new_v4()).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        let fresh_request = request(&mut socket).await;
        response(&mut socket).await;
        response(&mut held_socket).await;
        let (mut socket, _) = listener.accept().await.unwrap();
        let queued_request = request(&mut socket).await;
        response(&mut socket).await;
        fixture.drained().await;
        let promoted = fixture.session(&first).await.latest_turn_boundary(&first).await.unwrap().unwrap().invocation;
        let queued_configuration = stored_configuration(&fixture, &promoted.invocation_id);
        let fresh_configuration = stored_configuration(&fixture, fresh["invocationId"].as_str().unwrap());
        let queued_composition = session_context::composition(&fixture, &first).await;
        let replayed_queue = fixture.mutation(2, "send", queue_input, operation).await.unwrap();

        let reset = select_language(&fixture, "en").await;
        let stopped_text = "RESUME_ORIGINAL_🦀 原始 input stays exact";
        let stopped = fixture.mutation(2, "send", json!({"sessionId":first,"message":stopped_text,"model":fixture.selection().await}), Uuid::new_v4()).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        let stopped_request = request(&mut socket).await;
        let stopped_composition = session_context::composition(&fixture, &first).await;
        let stopped_configuration = stored_configuration(&fixture, stopped["invocationId"].as_str().unwrap());
        let stop = fixture.mutation(2, "stop", json!({"sessionId":first,"invocationId":stopped["invocationId"]}), Uuid::new_v4()).await.unwrap();
        drop(socket);
        fixture.drained().await;
        let source = fixture.query("execution", json!({"sessionId":first,"invocationId":stopped["invocationId"]})).await.unwrap()["execution"].clone();
        let traditional = select_language(&fixture, "zh-TW").await;
        let resume_input = json!({"sessionId":first,"sourceInvocationId":stopped["invocationId"],"sourceHighWater":source["highWater"],"model":fixture.selection().await});
        let resume_operation = Uuid::new_v4();
        let resumed = fixture.mutation(2, "resume", resume_input.clone(), resume_operation).await.unwrap();
        let (mut socket, _) = listener.accept().await.unwrap();
        let resumed_request = request(&mut socket).await;
        response(&mut socket).await;
        fixture.drained().await;
        let resumed_configuration = stored_configuration(&fixture, resumed["execution"]["invocationId"].as_str().unwrap());
        let resumed_composition = session_context::composition(&fixture, &first).await;
        let replayed_resume = fixture.mutation(2, "resume", resume_input, resume_operation).await.unwrap();
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();

        for receipt in [english, chinese, reset, traditional] { assert_eq!(receipt["kind"], "committed"); }
        assert_eq!(queued["kind"], "queued");
        assert_eq!(replayed_queue, queued, "the accepted operation receipt survives a language change");
        assert!(queued_basis.get("language").is_none(), "accepted English queue basis uses canonical omission: {queued_basis}");
        assert_delivered_language(&held_request, &held_configuration, "en", held_text);
        assert_delivered_language(&queued_request, &queued_configuration, "en", queued_text);
        assert_delivered_language(&fresh_request, &fresh_configuration, "zh-CN", fresh_text);
        let queued_static = queued_basis["behavior"]["text"].as_str().unwrap();
        assert_eq!(queued_composition.system_prompt.as_deref(), Some(queued_static));
        assert_delivered_static(&queued_request, queued_static);
        assert_eq!(stop["requested"], true);
        assert_eq!(source["state"], "cancelled");
        assert_eq!(resumed["kind"], "started");
        assert_eq!(replayed_resume, resumed);
        assert_delivered_language(&stopped_request, &stopped_configuration, "en", stopped_text);
        assert_delivered_language(&resumed_request, &resumed_configuration, "en", stopped_text);
        assert_eq!(resumed_composition.system_prompt, stopped_composition.system_prompt);
        assert_delivered_static(&resumed_request, stopped_composition.system_prompt.as_deref().unwrap());
    }).await.unwrap();
}

#[tokio::test]
async fn existing_workhub_coordinator_captures_each_new_selected_language() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let home = tempfile::tempdir().unwrap();
        let mut fixture = assistant_fixture(&listener, home.path()).await;
        workhub::activate(&mut fixture, true).await;
        let ready = workhub::resolve(&fixture, workhub::selection(&fixture).await, Uuid::new_v4()).await;
        let session = ready["session"]["id"].as_str().unwrap();
        let mut receipts = Vec::new();
        let mut captures = Vec::new();
        for language in ["en", "zh-CN", "zh-TW"] {
            receipts.push(select_language(&fixture, language).await);
            let original = format!("HUB_ORIGINAL_{language}_🦀 用户原文 stays exact");
            let sent = fixture.mutation(2, "send", json!({"sessionId":session,"message":original,"model":fixture.selection().await}), Uuid::new_v4()).await.unwrap();
            let (mut socket, _) = listener.accept().await.unwrap();
            let outgoing = request(&mut socket).await;
            response(&mut socket).await;
            loop {
                let execution = fixture.query("execution", json!({"sessionId":session,"invocationId":sent["invocationId"]})).await.unwrap();
                if execution["execution"]["state"] == "completed" { break; }
                tokio::task::yield_now().await;
            }
            let configuration = stored_configuration(&fixture, sent["invocationId"].as_str().unwrap());
            captures.push((outgoing, configuration, language, original));
        }
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();

        for receipt in receipts { assert_eq!(receipt["kind"], "committed"); }
        for (request, configuration, language, original) in captures {
            assert_delivered_language(&request, &configuration, language, &original);
        }
    }).await.unwrap();
}
