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

pub(in crate::owner::driver::tests::model_recovery) async fn enable_and_pin(
    client: &HostClient,
    session: &str,
    body: &str,
) -> TestResult<Value> {
    let preferences = call(client, "settings", "assistantPreferences", json!({})).await?;
    call(client,"settings","updateAssistantPreferences",json!({
        "expectedRevision":preferences["revision"],"mutation":{"kind":"memory","value":{"enabled":true,"agentReadEnabled":true}}
    })).await?;
    let scope = json!({"kind":"project","sessionId":session});
    let saved = call(
        client,
        "agent",
        "changeMemory",
        json!({"scope":scope,"edit":{"kind":"create","body":body}}),
    )
    .await?;
    assert_eq!(saved["kind"], "saved", "{saved}");
    let result=call(client,"agent","changeMemory",json!({"scope":scope,"edit":{"kind":"set_always","id":saved["id"],"expectedRevision":saved["revision"],"always":true}})).await?;
    assert_eq!(result["kind"], "saved", "{result}");
    Ok(result)
}

pub(in crate::owner::driver::tests::model_recovery) fn assert_wire(request: &Value, marker: &str) {
    let messages = request["messages"].as_array().unwrap();
    let matches: Vec<_> = messages
        .iter()
        .filter(|m| m["content"].to_string().contains(marker))
        .collect();
    assert_eq!(matches.len(), 1, "memory block count");
    assert_eq!(matches[0]["role"], "user");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn registered_bot_skips_pins_after_the_feature_is_disabled() -> TestResult<()> {
    let mut rig = Rig::new()?;
    let mut provider = Provider::start().await?;
    let base = rig.directory.path().to_owned();
    let mut boot = bootstrap_with(&base, provider.server.base_url(), |cfg| {
        cfg["bot"] = json!(true)
    })
    .await?;
    attach(&mut rig, &boot).await?;
    let client = rig.client.as_ref().unwrap();
    let model = model_options(
        client,
        &provider.server.base_url(),
        false,
        json!({"contextWindow":128000}),
    )
    .await?;
    let ordinary = create(client, &base, &model, None).await?;
    let ordinary = ordinary["id"].as_str().unwrap();
    let bot = call(
        client,
        "agent",
        "openBot",
        json!({"workspace":{"kind":"directory","path":base.join("workspace")}}),
    )
    .await?;
    let bot = bot["sessionId"].as_str().ok_or("missing Bot session")?;
    let marker = "Only ordinary conversations should receive this pin.";
    enable_and_pin(client, ordinary, marker).await?;

    assert!(rig.finish().await.is_empty());
    let directory = std::mem::replace(&mut rig.directory, TestDirectory::Borrowed(PathBuf::new()));
    drop(rig);
    let store = root(&base, false).await?;
    let loaded = store
        .load_application(boot.deployment)
        .await?
        .ok_or("missing deployment")?;
    let mut input = loaded.source().input.clone();
    input
        .instances
        .get_mut("agent")
        .unwrap()
        .configuration
        .values
        .insert("bot".into(), json!(false));
    store
        .commit_application(
            boot.deployment,
            loaded.source().reference.revision,
            input,
            vec![],
            loaded.packages().to_vec(),
        )
        .await?;
    boot.source = serde_json::to_value(
        store
            .load_application(boot.deployment)
            .await?
            .unwrap()
            .source(),
    )?;
    store.shutdown().await?;
    drop(store);
    let mut rig = Rig::new()?;
    rig.directory = directory;
    attach(&mut rig, &boot).await?;
    let client = rig.client.as_ref().unwrap();
    let state = call(client, "agent", "botOutbox", json!({"sessionId":bot})).await?;
    assert_eq!(state["enabled"], false);
    assert_eq!(state["isBot"], true);
    let mut records = Vec::new();
    for session in [bot, ordinary] {
        let sent = call(client, "agent", "send", json!({
            "sessionId":session, "message":"Reply briefly.",
            "backend":{"kind":"model","connectionId":model["connectionId"],"modelId":model["modelId"]}
        })).await?;
        assert_eq!(sent["kind"], "queued", "{sent}");
        let (wire, reply) = provider.next().await?;
        records.push(text_messages(&wire).contains(marker));
        reply.reply_text("Done");
        quiescent_message(client, session, &sent["messageId"]).await?;
    }
    assert!(rig.finish().await.is_empty());
    assert_eq!(records, [false, true]);
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pinned_memory_freezes_per_run_and_revokes_before_next_send() -> TestResult<()> {
    let mut rig = Rig::new()?;
    let mut provider = Provider::start().await?;
    let result = AssertUnwindSafe(tokio::time::timeout(
        Duration::from_secs(90),
        freeze_and_reopen(&mut rig, &mut provider),
    ))
    .catch_unwind()
    .await;
    let cleanup = rig.finish().await;
    match result {
        Ok(result) => result??,
        Err(panic) => std::panic::resume_unwind(panic),
    }
    assert!(cleanup.is_empty(), "{cleanup:?}");
    Ok(())
}

async fn freeze_and_reopen(rig: &mut Rig, provider: &mut Provider) -> TestResult<()> {
    let base = rig.directory.path().to_owned();
    let boot = bootstrap_with(&base, provider.server.base_url(), |cfg| {
        cfg["recall"] = json!(true);
    })
    .await?;
    attach(rig, &boot).await?;
    let client = rig.client.as_ref().unwrap();
    let model = model_options(
        client,
        &provider.server.base_url(),
        false,
        json!({"contextWindow":128000}),
    )
    .await?;
    let selected = create(client, &base, &model, None).await?;
    let session = selected["id"].as_str().unwrap();
    let scope = json!({"kind":"project","sessionId":session});
    let marker = "Apricot pinned fixture";
    for name in ["MEMORY.md", "PENDING.md"] {
        tokio::fs::write(base.join("workspace").join(name), "Legacy file fixture").await?;
    }
    let pin = enable_and_pin(client, session, marker).await?;
    let private = call(client,"agent","create",json!({
        "title":"Private","labels":[],"incognito":true,
        "workspace":{"kind":"directory","path":base.join("workspace")},
        "backend":{"kind":"model","connectionId":model["connectionId"],"modelId":model["modelId"]}
    })).await?;
    let private_id = private["session"]["id"]
        .as_str()
        .ok_or("missing private session")?;
    let private_turn = call(
        client,
        "agent",
        "send",
        json!({"sessionId":private_id,"message":"Private turn"}),
    )
    .await?;
    let (private_wire, reply) = provider.next().await?;
    assert!(!text_messages(&private_wire).contains(marker));
    assert!(!text_messages(&private_wire).contains("Legacy file fixture"));
    reply.reply_text("Done");
    quiescent_message(client, private_id, &private_turn["messageId"]).await?;
    let send = async |message: &str| {
        call(
            client,
            "agent",
            "send",
            json!({"sessionId":session,"message":message}),
        )
        .await
    };
    let sent = send("First turn").await?;
    let (request, reply) = provider.next().await?;
    assert_wire(&request, marker);
    assert!(!text_messages(&request).contains("Legacy file fixture"));
    let oversized = "a".repeat(4100);
    let rejected = call(
        client,
        "agent",
        "changeMemory",
        json!({"scope":scope,"edit":{"kind":"correct","body":oversized,
            "expectedRevision":pin["revision"],"id":pin["id"]}}),
    )
    .await
    .unwrap_err();
    assert!(rejected.to_string().contains("budget"), "{rejected}");
    let changed = call(
        client,
        "agent",
        "changeMemory",
        json!({"scope":scope,"edit":{"kind":"correct","body":"Banana updated fixture",
            "expectedRevision":pin["revision"],"id":pin["id"]}}),
    )
    .await?;
    assert_eq!(changed["kind"], "saved", "{changed}");
    reply.send_plan(tool_response("Recall", json!({"terms":["no-match-xyz"]})));
    let (next, reply) = provider.next().await?;
    assert_wire(&next, marker);
    assert!(!text_messages(&next).contains("Banana updated fixture"));
    reply.reply_text("Done");
    let run = quiescent_message(client, session, &sent["messageId"]).await?;
    let report = call(
        client,
        "agent",
        "loadedMemories",
        json!({"sessionId":session,"runId":run}),
    )
    .await?;
    assert_eq!(report[0]["id"], pin["id"]);
    assert_eq!(report[0]["revision"], pin["revision"]);
    let next_turn = send("Another turn").await?;
    let (request, reply) = provider.next().await?;
    assert_wire(&request, "Banana updated fixture");
    assert!(!text_messages(&request).contains(marker));
    let removed=call(client,"agent","changeMemory",json!({"scope":scope,"edit":{"kind":"delete","expectedRevision":changed["revision"],"id":pin["id"]}})).await?;
    assert_eq!(removed["kind"], "deleted");
    reply.send_plan(tool_response("Recall", json!({"terms":["no-match-xyz"]})));
    expect_revoked(
        client,
        provider,
        session,
        &next_turn["messageId"],
        "admitted memory revoked",
    )
    .await?;
    assert!(rig.finish().await.is_empty());
    rig.client = None;
    rig.host = None;
    rig.store = None;
    rig.captured.lock().unwrap().take();
    rig.stop_serving = CancellationToken::new();
    attach(rig, &boot).await?;
    let restored = call(
        rig.client.as_ref().unwrap(),
        "agent",
        "loadedMemories",
        json!({"sessionId":session,"runId":run}),
    )
    .await?;
    assert_eq!(report, restored);
    assert!(!restored.to_string().contains(marker));
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn recall_revocation_and_recap_visibility_follow_the_source_session() -> TestResult<()> {
    let mut rig = Rig::new()?;
    let mut provider = Provider::start().await?;
    let result = AssertUnwindSafe(tokio::time::timeout(
        Duration::from_secs(90),
        recall_and_recap(&mut rig, &mut provider),
    ))
    .catch_unwind()
    .await;
    let cleanup = rig.finish().await;
    match result {
        Ok(result) => result??,
        Err(panic) => std::panic::resume_unwind(panic),
    }
    assert!(cleanup.is_empty(), "{cleanup:?}");
    Ok(())
}

async fn recall_and_recap(rig: &mut Rig, provider: &mut Provider) -> TestResult<()> {
    let base = rig.directory.path().to_owned();
    let boot = bootstrap_with(&base, provider.server.base_url(), |cfg| {
        cfg["recall"] = json!(true);
        cfg["recaps"] = json!(true);
        cfg["tools"] = json!([{"name":"GetRecap","description":"Read a saved recap.","result":"json",
            "confirmation":"preapproved","target":{"kind":"export","name":"agent"},"method":"recap"}]);
    })
    .await?;
    attach(rig, &boot).await?;
    let client = rig.client.as_ref().unwrap();
    let model = model_options(
        client,
        &provider.server.base_url(),
        false,
        json!({"contextWindow":128000}),
    )
    .await?;
    let owner = rig.captured.lock().unwrap().clone().unwrap();
    let preferences = call(client, "settings", "assistantPreferences", json!({})).await?;
    call(
        client,
        "settings",
        "updateAssistantPreferences",
        json!({
            "expectedRevision": preferences["revision"],
            "mutation":{"kind":"memory","value":{"enabled":true,"agentReadEnabled":true}}
        }),
    )
    .await?;
    let selected = create(client, &base, &model, None).await?;
    let session = selected["id"].as_str().unwrap();
    let saved = call(
        client,
        "agent",
        "changeMemory",
        json!({
            "scope":{"kind":"personal"},"edit":{"kind":"create","body":"Nectarine recall fixture"}
        }),
    )
    .await?;
    assert_eq!(saved["kind"], "saved", "{saved}");
    let sent = call(
        client,
        "agent",
        "send",
        json!({"sessionId":session,"message":"Look up the note"}),
    )
    .await?;
    let (wire, reply) = provider.next().await?;
    assert!(!wire.to_string().contains("Nectarine recall fixture"));
    reply.send_plan(tool_response("Recall", json!({"terms":["nectarine"]})));
    let (wire, reply) = provider.next().await?;
    assert!(wire["messages"].as_array().unwrap().iter().any(|m| {
        m["role"] == "tool"
            && m["content"]
                .to_string()
                .contains("Nectarine recall fixture")
    }));
    let preferences = call(client, "settings", "assistantPreferences", json!({})).await?;
    call(client,"settings","updateAssistantPreferences",json!({
        "expectedRevision":preferences["revision"],"mutation":{"kind":"memory","value":{"enabled":true,"agentReadEnabled":false}}
    })).await?;
    reply.send_plan(TurnPlan::http_error(
        HttpErrorSpec::plain(429, "rate limited").with_header("retry-after", "0"),
    ));
    expect_revoked(
        client,
        provider,
        session,
        &sent["messageId"],
        "admitted memory read permission revoked",
    )
    .await?;

    let marker = "Nectarine recall fixture";
    let original = call(
        client,
        "agent",
        "history",
        json!({
            "sessionId":session, "position":{"kind":"tail"}, "view":"text"
        }),
    )
    .await?;
    assert!(
        original["chunks"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["text"]
                .as_str()
                .is_some_and(|text| text.contains(marker))),
        "{original}"
    );
    let generate = || {
        call(
            client,
            "agent",
            "generateRecap",
            json!({"sessionId":session,"model":model}),
        )
    };
    let (receipt, ()) = tokio::try_join!(generate(), async {
        let (wire, reply) = provider.next().await?;
        assert!(text_messages(&wire).contains("Look up the note"), "{wire}");
        assert!(!wire["messages"].to_string().contains(marker), "{wire}");
        reply.reply_text("Reviewed the note.");
        Ok(())
    })?;
    assert_eq!(receipt["kind"], "ready", "{receipt}");
    let unrelated = create(client, &base, &model, None).await?;
    let (retried, ()) = tokio::try_join!(generate(), async {
        let (first, reply) = provider.next().await?;
        assert_eq!(first["stream_options"]["include_usage"], true, "{first}");
        let archived = call(client, "agent", "changeSession", json!({
            "sessionId":unrelated["id"], "expectedRevision":unrelated["revision"], "action":"archive"
        })).await?;
        assert_eq!(archived["kind"], "changed", "{archived}");
        reply.send_plan(fatal("unsupported stream_options"));
        let (wire, reply) = provider.next().await?;
        assert!(wire.get("stream_options").is_none(), "{wire}");
        assert!(text_messages(&wire).contains("Look up the note"), "{wire}");
        reply.reply_text("Retried the recap.");
        Ok(())
    })?;
    assert_eq!(retried["kind"], "ready", "{retried}");
    assert!(provider.requests.try_recv().is_err());
    let recap_turn = call(
        client,
        "agent",
        "send",
        json!({"sessionId":session,"message":"Find the saved recap"}),
    )
    .await?;
    let (_, reply) = provider.next().await?;
    reply.send_plan(tool_response(
        "GetRecap",
        json!({"sessionId":session,"operationId":receipt["operationId"]}),
    ));
    let (wire, reply) = provider.next().await?;
    assert!(
        wire["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|message| message["role"] == "tool"
                && message["content"]
                    .to_string()
                    .contains("Reviewed the note.")),
        "{wire}"
    );
    reply.reply_text("Finished reading.");
    quiescent_message(client, session, &recap_turn["messageId"]).await?;
    assert_eq!(
        call(
            client,
            "agent",
            "recap",
            json!({"sessionId":session,
        "operationId":receipt["operationId"]})
        )
        .await?,
        receipt
    );
    let replay_turn = call(
        client,
        "agent",
        "send",
        json!({"sessionId":session,"message":"Continue the task"}),
    )
    .await?;
    let (wire, reply) = provider.next().await?;
    assert!(text_messages(&wire).contains("Finished reading."), "{wire}");
    assert!(
        !wire["messages"].to_string().contains("Reviewed the note."),
        "{wire}"
    );
    reply.reply_text("Done");
    quiescent_message(client, session, &replay_turn["messageId"]).await?;
    let fork = call(
        client,
        "agent",
        "fork",
        json!({
            "sessionId":session, "expectedRevision":owner.session(session).await?.revision,
            "position":{"kind":"end"}, "title":"Archive copy", "labels":[]
        }),
    )
    .await?;
    let fork_id = fork["session"]["id"].as_str().ok_or("missing fork")?;
    let removed = call(client, "agent", "changeSession", json!({
        "sessionId":session, "expectedRevision":owner.session(session).await?.revision, "action":"remove"
    })).await?;
    assert_eq!(removed["kind"], "removed", "{removed}");
    while owner
        .durable
        .latest_run(session.to_owned())
        .await?
        .is_some()
    {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let human = call(
        client,
        "agent",
        "history",
        json!({
            "sessionId":fork_id,"position":{"kind":"tail"},"view":"text"
        }),
    )
    .await?;
    assert!(
        human["chunks"].to_string().contains("Reviewed the note."),
        "{human}"
    );
    let (recap, ()) = tokio::try_join!(
        call(
            client,
            "agent",
            "generateRecap",
            json!({"sessionId":fork_id,"model":model})
        ),
        async {
            let (wire, reply) = provider.next().await?;
            assert!(text_messages(&wire).contains("Finished reading."), "{wire}");
            assert!(
                !text_messages(&wire).contains("Reviewed the note."),
                "{wire}"
            );
            reply.reply_text("Fork summary");
            Ok(())
        }
    )?;
    assert_eq!(recap["kind"], "ready", "{recap}");
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn queued_and_promoted_messages_load_their_runs_projection() -> TestResult<()> {
    let mut rig = Rig::new()?;
    let mut provider = Provider::start().await?;
    let base = rig.directory.path().to_owned();
    let boot = bootstrap_with(&base, provider.server.base_url(), |cfg| {
        cfg["recall"] = json!(true)
    })
    .await?;
    attach(&mut rig, &boot).await?;
    let client = rig.client.as_ref().unwrap();
    let model = model_options(
        client,
        &provider.server.base_url(),
        false,
        json!({"contextWindow":128000}),
    )
    .await?;
    let selected = create(client, &base, &model, None).await?;
    let session = selected["id"].as_str().unwrap();
    let old = "Old queued pin fixture";
    let new = "Updated queued pin fixture";
    let pin = enable_and_pin(client, session, old).await?;
    let send = async |message: &str, delivery: &str| {
        call(
            client,
            "agent",
            "send",
            json!({"sessionId":session, "message":message, "delivery":delivery}),
        )
        .await
    };
    let active = send("Start a turn", "steer").await?;
    let (wire, _initial_reply) = provider.next().await?;
    assert_wire(&wire, old);
    let queued = send("Start the next turn", "queue").await?;
    let updated = call(client, "agent", "changeMemory", json!({
        "scope":{"kind":"project","sessionId":session}, "edit":{"kind":"correct", "id":pin["id"], "expectedRevision":pin["revision"], "body":new}
    })).await?;
    assert_eq!(updated["kind"], "saved", "{updated}");
    let promoted = send("Promote this message", "queue").await?;
    let edit = call(client, "agent", "editQueue", json!({
        "sessionId":session, "expectedRevision":promoted["revision"], "edit":{"kind":"promote","messageId":promoted["messageId"]}
    })).await?;
    assert_eq!(edit["kind"], "committed", "{edit}");
    let (wire, _promoted_reply) = provider.next().await?;
    assert_wire(&wire, old);
    assert!(
        text_messages(&wire).contains("Promote this message"),
        "{wire}"
    );
    let steer = send("Steer this turn", "steer").await?;
    let (wire, reply) = provider.next().await?;
    assert_wire(&wire, old);
    let prompt = text_messages(&wire);
    assert!(
        prompt.contains("Promote this message") && prompt.contains("Steer this turn"),
        "{wire}"
    );
    assert!(!prompt.contains(new), "{wire}");
    reply.reply_text("Done");
    let (wire, reply) = provider.next().await?;
    assert_wire(&wire, new);
    assert!(!text_messages(&wire).contains(old), "{wire}");
    reply.reply_text("Done");
    let first_run = quiescent_message(client, session, &active["messageId"]).await?;
    let second_run = quiescent_message(client, session, &queued["messageId"]).await?;
    assert_ne!(first_run, second_run);
    for same in [steer, promoted] {
        assert_eq!(
            quiescent_message(client, session, &same["messageId"]).await?,
            first_run
        );
    }
    for (run, revision) in [
        (first_run, &pin["revision"]),
        (second_run, &updated["revision"]),
    ] {
        let loaded = call(
            client,
            "agent",
            "loadedMemories",
            json!({"sessionId":session, "runId":run}),
        )
        .await?;
        assert_eq!(&loaded[0]["revision"], revision);
    }
    assert!(rig.finish().await.is_empty());
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pinned_window_accounts_for_tool_schemas_at_send() -> TestResult<()> {
    let mut rig = Rig::new()?;
    let provider = Provider::start().await?;
    let base = rig.directory.path().to_owned();
    let boot = bootstrap_with(&base, provider.server.base_url(), |config| {
        config["tools"] = json!([{
            "name":"Read","description":"Read a workspace file.","input":"json","result":"image",
            "confirmation":"preapproved","target":{"kind":"import","name":"files"},"method":"read"
        }]);
    })
    .await?;
    attach(&mut rig, &boot).await?;
    let client = rig.client.as_ref().unwrap();
    let model = model_options(
        client,
        &provider.server.base_url(),
        false,
        json!({"contextWindow":500}),
    )
    .await?;
    let selected = create(client, &base, &model, None).await?;
    let session = selected["id"].as_str().unwrap();
    enable_and_pin(client, session, &"a".repeat(850)).await?;
    let result = call(
        client,
        "agent",
        "send",
        json!({"sessionId":session, "message":"Hello"}),
    )
    .await
    .unwrap_err();
    assert!(
        result
            .to_string()
            .contains("pinned memory exceeds the selected model input window"),
        "{result}"
    );
    let queue = call(client, "agent", "queue", json!({"sessionId":session})).await?;
    assert_eq!(queue["entries"], json!([]));
    assert!(rig.finish().await.is_empty());
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn standalone_compaction_skips_pins_with_an_unknown_window() -> TestResult<()> {
    let mut rig = Rig::new()?;
    let mut provider = Provider::start().await?;
    let base = rig.directory.path().to_owned();
    let boot = bootstrap_with(&base, provider.server.base_url(), |_| {}).await?;
    attach(&mut rig, &boot).await?;
    let client = rig.client.as_ref().unwrap();
    let model = model(client, &provider.server.base_url(), false).await?;
    let selected = create(client, &base, &model, None).await?;
    let session = selected["id"].as_str().unwrap();
    let sent = call(
        client,
        "agent",
        "send",
        json!({"sessionId":session, "message":"Seed history"}),
    )
    .await?;
    let (_, reply) = provider.next().await?;
    reply.reply_text("Ready");
    quiescent_message(client, session, &sent["messageId"]).await?;
    let marker = "Skip this pin during manual summary";
    enable_and_pin(client, session, marker).await?;
    let compact = call(
        client,
        "agent",
        "compact",
        json!({"sessionId":session, "model":model}),
    )
    .await?;
    assert_eq!(compact["kind"], "started", "{compact}");
    let (wire, reply) = provider.next().await?;
    assert!(!text_messages(&wire).contains(marker), "{wire}");
    let loaded = call(
        client,
        "agent",
        "loadedMemories",
        json!({"sessionId":session, "runId":compact["execution"]["runId"]}),
    )
    .await?;
    assert_eq!(loaded, json!([]));
    reply.reply_text("The user seeded history.");
    assert!(rig.finish().await.is_empty());
    Ok(())
}

async fn expect_revoked(
    client: &HostClient,
    provider: &mut Provider,
    session: &str,
    message: &Value,
    reason: &str,
) -> TestResult<()> {
    let settled = async {
        loop {
            let work = call(
                client,
                "agent",
                "work",
                json!({"sessionId":session,"target":{"kind":"message","messageId":message}}),
            )
            .await?;
            match work["execution"]["state"]["kind"].as_str() {
                Some("failed") => {
                    let history = call(
                        client,
                        "agent",
                        "history",
                        json!({
                            "sessionId":session, "position":{"kind":"tail"}, "view":"text"
                        }),
                    )
                    .await?;
                    assert!(
                        history["chunks"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .any(|row| row["text"]
                                .as_str()
                                .is_some_and(|text| text.contains(reason))),
                        "{history}"
                    );
                    assert!(
                        !history["chunks"].to_string().contains(
                            "adapter supplied no safe interrupted-attempt recovery evidence"
                        ),
                        "{history}"
                    );
                    return Ok(());
                }
                Some("cancelled") => return Err(format!("revoked Run cancelled: {work}").into()),
                Some("completed") => return Err(format!("revoked Run completed: {work}").into()),
                _ => tokio::time::sleep(Duration::from_millis(20)).await,
            }
        }
    };
    tokio::select! {
        wire = provider.requests.recv() => Err(format!("revoked request reached the provider: {:?}",wire.map(|r| r.request.raw_body)).into()),
        result = settled => result,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn recall_without_memory_only_revokes_a_returned_source() -> TestResult<()> {
    let mut rig = Rig::new()?;
    let mut provider = Provider::start().await?;
    let base = rig.directory.path().to_owned();
    let boot = bootstrap_with(&base, provider.server.base_url(), |cfg| {
        cfg["recall"] = json!(true)
    })
    .await?;
    attach(&mut rig, &boot).await?;
    let client = rig.client.as_ref().unwrap();
    let prefs = call(client, "settings", "assistantPreferences", json!({})).await?;
    call(
        client,
        "settings",
        "updateAssistantPreferences",
        json!({
            "expectedRevision":prefs["revision"],
            "mutation":{"kind":"memory","value":{"enabled":false,"agentReadEnabled":false}}
        }),
    )
    .await?;
    let model = model_options(
        client,
        &provider.server.base_url(),
        false,
        json!({"contextWindow":128000}),
    )
    .await?;
    let source = create(client, &base, &model, None).await?;
    let reader = create(client, &base, &model, None).await?;
    let unrelated = create(client, &base, &model, None).await?;
    let source = source["id"].as_str().unwrap();
    let reader = reader["id"].as_str().unwrap();
    let marker = "Clementine field notes";
    let sent = call(
        client,
        "agent",
        "send",
        json!({"sessionId":source,"message":marker}),
    )
    .await?;
    let (_, reply) = provider.next().await?;
    reply.reply_text("Filed.");
    quiescent_message(client, source, &sent["messageId"]).await?;
    let sent = call(
        client,
        "agent",
        "send",
        json!({"sessionId":reader,"message":"Find the field notes"}),
    )
    .await?;
    let (_, reply) = provider.next().await?;
    reply.send_plan(tool_response("Recall", json!({"terms":["clementine"]})));
    let (wire, reply) = provider.next().await?;
    assert!(wire["messages"].to_string().contains(marker), "{wire}");
    let archived=call(client,"agent","changeSession",json!({
        "sessionId":unrelated["id"], "expectedRevision":unrelated["revision"], "action":"archive"
    })).await?;
    assert_eq!(archived["kind"], "changed", "{archived}");
    reply.send_plan(TurnPlan::http_error(
        HttpErrorSpec::plain(429, "rate limited").with_header("retry-after", "0"),
    ));
    let (retry, reply) = provider.next().await?;
    assert_eq!(retry["messages"], wire["messages"]);
    let owner = rig.captured.lock().unwrap().clone().unwrap();
    let archived=call(client,"agent","changeSession",json!({
        "sessionId":source, "expectedRevision":owner.session(source).await?.revision, "action":"archive"
    })).await?;
    assert_eq!(archived["kind"], "changed", "{archived}");
    reply.reply_tool_call(
        "lookup-again",
        "Recall",
        json!({"terms":["unmatchedsecondlookup"]}),
    );
    expect_revoked(
        client,
        &mut provider,
        reader,
        &sent["messageId"],
        "memory tool input revoked",
    )
    .await?;
    assert!(rig.finish().await.is_empty());
    Ok(())
}
