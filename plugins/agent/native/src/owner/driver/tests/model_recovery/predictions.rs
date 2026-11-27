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
use maka_capabilities::call::immutable_bytes;

const INSTRUCTION: &str = "Suggest the next request.";
const SUGGESTION: &str = "Zoom in on the upper left.";

async fn provider(
    requests: tokio::sync::mpsc::UnboundedSender<Value>,
) -> std::io::Result<MockAiServer> {
    MockAiBuilder::new()
        .handler_fn(move |req, _| {
            let last =
                req.raw_body["messages"].as_array().unwrap().last().unwrap()["content"].to_string();
            let text = if last.contains(INSTRUCTION) {
                json!({"suggestion": SUGGESTION}).to_string()
            } else if last.contains("<message>") {
                "Model generated title".to_owned()
            } else {
                "The image shows a red square.".to_owned()
            };
            let _ = requests.send(req.raw_body.clone());
            TurnPlan::new()
                .push_text(text)
                .with_usage(Usage::new(100, 10))
                .finish(FinishReason::Stop)
        })
        .start()
        .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn predictions_extend_the_original_provider_request() {
    let mut rig = Rig::new().unwrap();
    let (requests, mut upstream) = tokio::sync::mpsc::unbounded_channel();
    let server = provider(requests).await.unwrap();
    let result = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(60), async {
        let base = rig.directory.path().to_path_buf();
        let boot = bootstrap(&base, server.base_url(), true).await?;
        attach(&mut rig, &boot).await?;
        let client = rig.client.as_ref().ok_or("test client missing")?;
        let catalog = call(client, "settings", "connections", json!({"kind":"start"})).await?;
        let connection = call(client, "settings", "create", json!({
            "expectedCatalogRevision":catalog["revision"],
            "connection":{
                "slug":"prediction-model","name":"Prediction model",
                "provider":{"packageId":"maka.providers","entryId":"maka.providers","scope":"profile","name":"ollama"},
                "configuration":{"baseUrl":boot.base_url},"enabled":true,"enabledModelIds":["llama3.2"],
                "modelOverrides":{"llama3.2":{"apiProtocol":"openai-chat-completions","codeMode":false,
                    "contextWindow":128000,"vision":true,"imageInput":{"maxWidth":16,"requestBytes":1000000}}}
            }
        })).await?;
        assert_eq!(connection["kind"], "committed", "{connection}");
        let preferences = call(client, "settings", "assistantPreferences", json!({})).await?;
        let configured = call(client, "settings", "updateAssistantPreferences", json!({
            "expectedRevision":preferences["revision"],
            "mutation":{"kind":"message_predictions","settings":{"enabled":true,
                "ordinarySessionsOnly":false,"liveSamplePercent":100,"catchUpSamplePercent":100,
                "prompt":INSTRUCTION}}
        })).await?;
        assert_eq!(configured["kind"], "committed", "{configured}");

        let created = call(client, "agent", "create", json!({
            "title":"Image predictions","automaticTitle":false,"labels":[],
            "workspace":{"kind":"directory","path":base.join("workspace")}
        })).await?;
        let session = created["session"]["id"].as_str().ok_or("missing Session")?;
        let mut png = std::io::Cursor::new(Vec::new());
        image::RgbImage::from_pixel(32, 16, image::Rgb([255, 0, 0]))
            .write_to(&mut png, image::ImageFormat::Png)?;
        let file = immutable_bytes("red.png".into(), png.into_inner());
        let uploaded = call_with_attachments(client, "agent", "uploadAttachment", json!({
            "sessionId":session,"name":"red.png","bytes":file.bytes(),"digest":file.metadata()["digest"]
        }), Attachments::from([("file".into(), file)])).await?;
        assert_eq!(uploaded["kind"], "uploaded", "{uploaded}");
        let sent = call(client, "agent", "send", json!({
            "sessionId":session,"message":"Describe this image.","attachments":[uploaded["attachment"]["id"]],
            "delivery":"queue",
            "backend":{"kind":"model","connectionId":connection["connection"]["connectionId"],"modelId":"llama3.2"}
        })).await?;
        assert_eq!(sent["kind"], "queued", "{sent}");
        let target = json!({"kind":"message","messageId":sent["messageId"]});
        let turn = loop {
            let work = call(client, "agent", "work", json!({"sessionId":session,"target":target})).await?;
            match work["execution"]["state"]["kind"].as_str() {
                Some("completed") => break work["execution"]["turnId"].clone(),
                Some("failed" | "cancelled") => panic!("original turn failed: {work}"),
                _ => tokio::task::yield_now().await,
            }
        };
        let original = upstream.recv().await.ok_or("original model request missing")?;
        assert!(original["messages"].to_string().contains("data:image/png;base64,"));
        assert!(original["tools"].as_array().is_some_and(|tools| !tools.is_empty()));
        let original_messages = original["messages"].as_array().unwrap();
        let before = call(client, "agent", "observe", json!({"sessionId":session})).await?;
        assert_eq!(before["lastCompletedTurnId"], turn);
        for trigger in ["live", "catch_up"] {
            let prediction = call(client, "agent", "predictNextMessage", json!({
                "sessionId":session,"expectedTurnId":turn,"trigger":trigger
            })).await?;
            assert_eq!(prediction["suggestion"], SUGGESTION, "{trigger}: {prediction}");
            assert_eq!(prediction["sourceTurnId"], turn);
            let request = upstream.recv().await.ok_or("prediction request missing")?;
            let messages = request["messages"].as_array().unwrap();
            assert_eq!(messages.len(), original_messages.len() + 2);
            assert_eq!(&messages[..original_messages.len()], original_messages);
            assert_eq!(messages[original_messages.len()]["role"], "assistant");
            assert!(messages[original_messages.len()]["content"].to_string().contains("The image shows a red square."));
            assert_eq!(messages.last().unwrap()["role"], "user");
            assert!(messages.last().unwrap()["content"].to_string().contains(INSTRUCTION));
            assert_eq!(request["tools"], original["tools"]);
            assert_eq!(request["tool_choice"], original["tool_choice"]);
        }
        let after = call(client, "agent", "observe", json!({"sessionId":session})).await?;
        assert_eq!(after["through"], before["through"]);
        assert_eq!(after["lastCompletedTurnId"], turn);

        let marker = "Apricot pinned prediction fixture";
        let pin = super::preset_acceptance::pinned_memory::enable_and_pin(client, session, marker).await?;
        let sent = call(client,"agent","send",json!({"sessionId":session,"message":"Another description",
            "backend":{"kind":"model","connectionId":connection["connection"]["connectionId"],"modelId":"llama3.2"}
        })).await?;
        let run = quiescent_message(client,session,&sent["messageId"]).await?;
        let original = upstream.recv().await.ok_or("pinned main request missing")?;
        super::preset_acceptance::pinned_memory::assert_wire(&original,marker);
        let work = call(client,"agent","work",json!({"sessionId":session,"target":{"kind":"run","runId":run}})).await?;
        let removed = call(client,"agent","changeMemory",json!({"scope":{"kind":"project","sessionId":session},
            "edit":{"kind":"delete","id":pin["id"],"expectedRevision":pin["revision"]}})).await?;
        assert_eq!(removed["kind"], "deleted");
        for trigger in ["live","catch_up"] {
            let prediction = call(client,"agent","predictNextMessage",json!({
                "sessionId":session,"expectedTurnId":work["execution"]["turnId"],"trigger":trigger
            })).await?;
            assert!(prediction["suggestion"].is_null());
            assert!(upstream.try_recv().is_err());
        }
        Ok::<_, Box<dyn Error + Send + Sync>>(())
    })).catch_unwind().await;
    server.shutdown().await;
    let cleanup = rig.finish().await;
    assert!(
        matches!(result, Ok(Ok(Ok(())))),
        "prediction fixture failed: {result:?}"
    );
    assert!(cleanup.is_empty(), "{cleanup:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn quick_questions_stream_with_explicit_history_outside_the_bot_transcript() {
    let mut rig = Rig::new().unwrap();
    let (requests, mut upstream) = tokio::sync::mpsc::unbounded_channel();
    let server = provider(requests).await.unwrap();
    let result = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(60), async {
        let base = rig.directory.path().to_path_buf();
        let boot = bootstrap_with(&base, server.base_url(), |config| config["bot"] = json!(true)).await?;
        attach(&mut rig, &boot).await?;
        let client = rig.client.as_ref().ok_or("test client missing")?;
        let catalog = call(client, "settings", "connections", json!({"kind":"start"})).await?;
        let connection = call(client, "settings", "create", json!({
            "expectedCatalogRevision":catalog["revision"],
            "connection":{
                "slug":"prediction-model","name":"Prediction model",
                "provider":{"packageId":"maka.providers","entryId":"maka.providers","scope":"profile","name":"ollama"},
                "configuration":{"baseUrl":boot.base_url},"enabled":true,"enabledModelIds":["llama3.2"],
                "modelOverrides":{"llama3.2":{"apiProtocol":"openai-chat-completions","codeMode":false,
                    "vision":true,"imageInput":{"maxWidth":16,"requestBytes":1000000}}}
            }
        })).await?;
        assert_eq!(connection["kind"], "committed", "{connection}");
        let bot = call(client, "agent", "openBot", json!({})).await?;
        let session = bot["sessionId"].as_str().ok_or("missing Bot session")?;
        let backend = json!({"kind":"model","connectionId":connection["connection"]["connectionId"],"modelId":"llama3.2"});
        call(client, "agent", "selectBackend", json!({"sessionId":session,"backend":backend})).await?;
        let before = call(client, "agent", "observe", json!({"sessionId":session})).await?;
        for (id, previous) in [("one", None), ("two", Some("one")), ("three", None), ("restored", None)] {
            let history = if id == "restored" { json!([{"question":"Saved question", "answer":"Saved answer"}]) } else { json!([]) };
            let mut question = client.call("agent", "askQuickQuestion".into(), json!({
                "sessionId":session,"requestId":id,"question":"Describe the square.","continueFrom":previous, "history":history
            }), Attachments::new()).await?;
            question.start().await?;
            assert!(matches!(question.receive().await?, Reply::Prepared { .. }));
            let mut reply = question.confirm(json!({"test":"quick-question"})).await?;
            let mut answer = Value::Null;
            while let Reply::Progress { value } = reply {
                answer = value;
                reply = question.receive().await?;
            }
            let Reply::Mutation { reply, cleanup } = reply else { return Err("missing receipt".into()); };
            cleanup?;
            let Receipt::Recorded { outcome: OperationOutcome::Returned { result: OperationResult::Success { value } }, .. } = reply.receipt else { return Err("quick question did not return its usage".into()); };
            assert!(value["modelId"].is_string(), "{value}");
            assert!(value["durationMs"].is_u64(), "{value}");
            assert_eq!(value["usage"]["input_tokens"], 100, "{value}");
            assert_eq!(value["usage"]["output_tokens"], 10, "{value}");
            assert_eq!(answer, "The image shows a red square.");
            if id == "restored" {
                let copied = call(client, "agent", "import", json!({
                    "kind":"quick_question", "thread":uuid::Uuid::new_v4(),
                    "title":"Quick reply usage", "path":base.join("workspace"), "backend":backend,
                    "turns":[{"question":"Old question","answer":"Old reply"},{"question":"Describe the square.","answer":answer,"replyInfo":value}]
                })).await?;
                let page = call(client, "agent", "history", json!({
                    "sessionId":copied["session"]["id"], "position":{"kind":"tail"}, "view":"conversation", "includeThinking":true
                })).await?;
                let rows = page["chunks"].as_array().ok_or("missing imported history")?;
                let copied_answer = rows.iter().find(|row| row["text"] == answer).ok_or("missing quick reply")?;
                assert_eq!(copied_answer["replyInfo"], value);
                assert!(rows.iter().filter(|row| row["text"] != answer).all(|row| row["replyInfo"].is_null()));
            }
            let request = upstream.recv().await.ok_or("missing model request")?;
            assert!(request["tools"].as_array().is_none_or(Vec::is_empty));
            let messages = request["messages"].as_array().unwrap();
            assert_eq!(messages.iter().any(|m| m["role"] == "assistant"), previous.is_some() || id == "restored");
            if id == "restored" {
                assert!(messages.iter().any(|m| m["role"] == "assistant" && m["content"].to_string().contains("Saved answer")));
            }
        }
        let after = call(client, "agent", "observe", json!({"sessionId":session})).await?;
        assert_eq!(before["lastCompletedTurnId"], after["lastCompletedTurnId"]);
        Ok::<_, Box<dyn Error + Send + Sync>>(())
    })).catch_unwind().await;
    server.shutdown().await;
    let cleanup = rig.finish().await;
    assert!(
        matches!(result, Ok(Ok(Ok(())))),
        "quick question fixture failed: {result:?}"
    );
    assert!(cleanup.is_empty(), "{cleanup:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn automatic_title_persists_for_model_sessions() {
    let mut rig = Rig::new().unwrap();
    let (requests, _upstream) = tokio::sync::mpsc::unbounded_channel();
    let server = provider(requests).await.unwrap();
    let result = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(60), async {
        let base = rig.directory.path().to_path_buf();
        let boot = bootstrap_with(
            &base,
            server.base_url(),
            |config| config["automaticTitles"] = json!(true),
        )
        .await?;
        attach(&mut rig, &boot).await?;
        let client = rig.client.as_ref().ok_or("test client missing")?;
        let catalog = call(client, "settings", "connections", json!({"kind":"start"})).await?;
        let connection = call(client, "settings", "create", json!({
            "expectedCatalogRevision":catalog["revision"],
            "connection":{
                "slug":"title-model","name":"Title model",
                "provider":{"packageId":"maka.providers","entryId":"maka.providers","scope":"profile","name":"ollama"},
                "configuration":{"baseUrl":boot.base_url},"enabled":true,"enabledModelIds":["llama3.2"],
                "modelOverrides":{"llama3.2":{"apiProtocol":"openai-chat-completions","codeMode":false}}
            }
        })).await?;
        assert_eq!(connection["kind"], "committed", "{connection}");

        let created = call(client, "agent", "create", json!({
            "title":"New conversation","automaticTitle":true,"labels":[],
            "workspace":{"kind":"directory","path":base.join("workspace")}
        })).await?;
        let session = created["session"]["id"].as_str().ok_or("missing Session")?;
        let sent = call(client, "agent", "send", json!({
            "sessionId":session,"message":"Explain the retry loop.","attachments":[],
            "delivery":"queue",
            "backend":{"kind":"model","connectionId":connection["connection"]["connectionId"],"modelId":"llama3.2"}
        })).await?;
        assert_eq!(sent["kind"], "queued", "{sent}");
        loop {
            let observed = call(client, "agent", "observe", json!({"sessionId":session})).await?;
            if observed["session"]["title"] == "Model generated title" {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        Ok::<_, Box<dyn Error + Send + Sync>>(())
    }))
    .catch_unwind()
    .await;
    server.shutdown().await;
    let cleanup = rig.finish().await;
    assert!(
        matches!(result, Ok(Ok(Ok(())))),
        "model automatic title fixture failed: {result:?}"
    );
    assert!(cleanup.is_empty(), "{cleanup:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn executor_title_sync_guards_normalization_refinement_and_locks() {
    let mut rig = Rig::new().unwrap();
    let result = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(60), async {
        let base = rig.directory.path().to_path_buf();
        let boot = bootstrap_with(&base, "http://127.0.0.1:1/v1".into(), |config| {
            config["automaticTitles"] = json!(true);
        })
        .await?;
        attach(&mut rig, &boot).await?;
        let client = rig.client.as_ref().ok_or("test client missing")?;
        let owner = rig.captured.lock().unwrap().clone().ok_or("captured owner missing")?;
        let cancel = CancellationToken::new();

        let create_session = |title: &str| {
            let (ws, title) = (base.join("workspace"), title.to_owned());
            async move {
                let created = call(
                    client,
                    "agent",
                    "create",
                    json!({"title": title, "automaticTitle": true, "labels": [], "workspace": {"kind": "directory", "path": ws}}),
                )
                .await?;
                Ok::<_, Box<dyn Error + Send + Sync>>((
                    created["session"]["id"].as_str().ok_or("missing session")?.to_owned(),
                    created["session"]["revision"].as_u64().ok_or("missing rev")?,
                ))
            }
        };
        let observe = |session_id: &str| {
            let session_id = session_id.to_owned();
            async move {
                let state = call(client, "agent", "observe", json!({"sessionId": session_id})).await?;
                Ok::<_, Box<dyn Error + Send + Sync>>((
                    state["session"]["title"].as_str().unwrap_or_default().to_owned(),
                    state["session"]["revision"].as_u64().unwrap(),
                ))
            }
        };
        let open_lease = |session_id: &str| {
            let (owner, session_id) = (owner.clone(), session_id.to_owned());
            async move {
                let current = owner.mutable_session(&session_id).await?;
                let scope = owner.current_work_scope(&session_id, &current.configuration).await?;
                let (lease, effects) = scope.accept(CancellationToken::new());
                let custody = lease.store().work_custody()?;
                Ok::<_, Box<dyn Error + Send + Sync>>((lease, effects, custody))
            }
        };

        // 1. Normalize, skip identical/blank without bumping revision, refine, then lock on manual rename.
        let (session, _) = create_session("New conversation").await?;
        let (lease, _effects, custody) = open_lease(&session).await?;
        owner.apply_executor_title(&session, "  First\tACP\nTitle  ", custody.as_ref(), &cancel).await;
        let (title, rev1) = observe(&session).await?;
        assert_eq!(title, "First ACP Title");

        owner.apply_executor_title(&session, "  First   ACP Title ", custody.as_ref(), &cancel).await;
        owner.apply_executor_title(&session, " \t\n\u{200b} ", custody.as_ref(), &cancel).await;
        assert_eq!(observe(&session).await?, ("First ACP Title".into(), rev1));

        owner.apply_executor_title(&session, "Refined ACP Title", custody.as_ref(), &cancel).await;
        let (title, rev2) = observe(&session).await?;
        assert_eq!(title, "Refined ACP Title");
        assert!(rev2 > rev1);

        let renamed = call(
            client,
            "agent",
            "metadata",
            json!({"sessionId": session, "expectedRevision": rev2, "title": "Manual Title", "labels": []}),
        )
        .await?;
        let rev_manual = renamed["session"]["revision"].as_u64().unwrap();
        owner.apply_executor_title(&session, "Should Not Overwrite", custody.as_ref(), &cancel).await;
        assert_eq!(observe(&session).await?, ("Manual Title".into(), rev_manual));
        lease.finish();

        // 2. Archived sessions ignore ACP title updates even when title_is_manual is false.
        let (archived_id, archived_rev) = create_session("Archive Me").await?;
        let (archived_lease, _archived_effects, archived_custody) = open_lease(&archived_id).await?;
        archived_lease.finish();
        let archived = call(
            client,
            "agent",
            "changeSession",
            json!({"sessionId": archived_id, "expectedRevision": archived_rev, "action": "archive"}),
        )
        .await?;
        let rev_archived = archived["session"]["revision"].as_u64().unwrap();
        owner.apply_executor_title(&archived_id, "Ignored While Archived", archived_custody.as_ref(), &cancel).await;
        assert_eq!(observe(&archived_id).await?, ("Archive Me".into(), rev_archived));

        Ok::<_, Box<dyn Error + Send + Sync>>(())
    }))
    .catch_unwind()
    .await;
    let cleanup = rig.finish().await;
    assert!(
        matches!(result, Ok(Ok(Ok(())))),
        "executor title sync fixture failed: {result:?}"
    );
    assert!(cleanup.is_empty(), "{cleanup:?}");
}
