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
    let mut boot =
        bootstrap_with(&base, provider.url.clone(), |cfg| cfg["bot"] = json!(true)).await?;
    attach(&mut rig, &boot).await?;
    let client = rig.client.as_ref().unwrap();
    let model = model_options(
        client,
        &provider.url,
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
        reply
            .send(completion(
                json!({"role":"assistant","content":"Done"}),
                "stop",
            ))
            .map_err(|_| "provider lost")?;
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
        exercise(&mut rig, &mut provider),
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

async fn exercise(rig: &mut Rig, provider: &mut Provider) -> TestResult<()> {
    let base = rig.directory.path().to_owned();
    let boot = bootstrap_with(&base, provider.url.clone(), |cfg| {
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
        &provider.url,
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
    reply
        .send(completion(
            json!({"role":"assistant","content":"Done"}),
            "stop",
        ))
        .map_err(|_| "provider lost")?;
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
    reply
        .send(tool_response("Recall", json!({"terms":["no-match-xyz"]})))
        .map_err(|_| "provider lost")?;
    let (next, reply) = provider.next().await?;
    assert_wire(&next, marker);
    assert!(!text_messages(&next).contains("Banana updated fixture"));
    reply
        .send(completion(
            json!({"role":"assistant","content":"Done"}),
            "stop",
        ))
        .map_err(|_| "provider lost")?;
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
    reply
        .send(tool_response("Recall", json!({"terms":["no-match-xyz"]})))
        .map_err(|_| "provider lost")?;
    expect_revoked(client, provider, session, &next_turn["messageId"]).await?;
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
    let owner = rig.captured.lock().unwrap().clone().unwrap();
    let view = owner.durable.frontier(run).await?;
    let (basis, _) = owner
        .restored_data(&view)
        .await
        .map_err(|error| error.cause)?;
    assert_eq!(basis.memory.as_ref().unwrap().entries[0].body, marker);
    let client = rig.client.as_ref().unwrap();
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
    reply
        .send(tool_response("Recall", json!({"terms":["nectarine"]})))
        .map_err(|_| "provider lost")?;
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
    reply
        .send(ModelReply::RateLimited)
        .map_err(|_| "provider lost")?;
    expect_revoked(client, provider, session, &sent["messageId"]).await?;

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
        reply
            .send(completion(
                json!({"role":"assistant","content":"Reviewed the note."}),
                "stop",
            ))
            .map_err(|_| "provider lost")?;
        Ok(())
    })?;
    assert_eq!(receipt["kind"], "ready", "{receipt}");
    let recap_turn = call(
        client,
        "agent",
        "send",
        json!({"sessionId":session,"message":"Find the saved recap"}),
    )
    .await?;
    let (_, reply) = provider.next().await?;
    reply
        .send(tool_response(
            "GetRecap",
            json!({"sessionId":session,"operationId":receipt["operationId"]}),
        ))
        .map_err(|_| "provider lost")?;
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
    reply
        .send(completion(
            json!({"role":"assistant","content":"Finished reading."}),
            "stop",
        ))
        .map_err(|_| "provider lost")?;
    quiescent_message(client, session, &recap_turn["messageId"]).await?;
    let unrelated = create(client, &base, &model, None).await?;
    let (refused, ()) = tokio::try_join!(generate(), async {
        let (_, reply) = provider.next().await?;
        let archived = call(client, "agent", "changeSession", json!({
            "sessionId":unrelated["id"], "expectedRevision":unrelated["revision"], "action":"archive"
        })).await?;
        assert_eq!(archived["kind"], "changed", "{archived}");
        reply
            .send(ModelReply::RateLimited)
            .map_err(|_| "provider lost")?;
        Ok(())
    })?;
    assert_eq!(refused["kind"], "failed", "{refused}");
    assert!(provider.requests.try_recv().is_err());
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
    reply
        .send(completion(
            json!({"role":"assistant","content":"Done"}),
            "stop",
        ))
        .map_err(|_| "provider lost")?;
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
            reply
                .send(completion(
                    json!({"role":"assistant","content":"Fork summary"}),
                    "stop",
                ))
                .map_err(|_| "provider lost")?;
            Ok(())
        }
    )?;
    assert_eq!(recap["kind"], "ready", "{recap}");
    let preferences = call(client, "settings", "assistantPreferences", json!({})).await?;
    call(
        client,
        "settings",
        "updateAssistantPreferences",
        json!({"expectedRevision":preferences["revision"],
        "mutation":{"kind":"memory","value":{"enabled":true,"agentReadEnabled":true}}}),
    )
    .await?;
    let pinned = call(
        client,
        "agent",
        "changeMemory",
        json!({"scope":{"kind":"personal"},"edit":{
        "kind":"set_always","id":saved["id"],"expectedRevision":saved["revision"],"always":true}}),
    )
    .await?;
    assert_eq!(pinned["kind"], "saved", "{pinned}");
    let selected = create(client, &base, &model, None).await?;
    let session = selected["id"].as_str().unwrap();
    let active = call(
        client,
        "agent",
        "send",
        json!({"sessionId":session,"message":"Start steering fixture"}),
    )
    .await?;
    let (wire, _pending) = provider.next().await?;
    assert_wire(&wire, marker);
    let steer = call(
        client,
        "agent",
        "send",
        json!({"sessionId":session,"message":"Pending steer","delivery":"steer"}),
    )
    .await?;
    let queue = owner.durable.queue();
    let entry = queue
        .message_entry(
            session.into(),
            steer["messageId"].as_str().ok_or("missing steer")?.into(),
        )
        .await?
        .ok_or("missing steer entry")?;
    let reference = entry
        .request
        .spec
        .memory_projection
        .ok_or("steer has no independent projection")?;
    let bytes = queue
        .content(session.into(), entry.request.id, reference)
        .await?;
    let memory: maka_agent_facts::memory::MemoryProjection = serde_json::from_slice(&bytes)?;
    assert!(memory.entries.iter().any(|entry| entry.body == marker));
    let work = call(
        client,
        "agent",
        "work",
        json!({"sessionId":session,"target":{"kind":"message","messageId":active["messageId"]}}),
    )
    .await?;
    call(
        client,
        "agent",
        "stop",
        json!({"sessionId":session,"runId":work["execution"]["runId"]}),
    )
    .await?;
    Ok(())
}

async fn expect_revoked(
    client: &HostClient,
    provider: &mut Provider,
    session: &str,
    message: &Value,
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
                Some("failed" | "blocked" | "cancelled") => return Ok(()),
                Some("completed") => return Err(format!("revoked Run completed: {work}").into()),
                _ => tokio::time::sleep(Duration::from_millis(20)).await,
            }
        }
    };
    tokio::select! {
        wire = provider.requests.recv() => Err(format!("revoked request reached the provider: {:?}",wire.map(|r| r.0)).into()),
        result = settled => result,
    }
}
