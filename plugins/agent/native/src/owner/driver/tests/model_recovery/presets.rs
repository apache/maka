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

async fn lost_reply(
    rig: &Rig,
    method: &str,
    input: Value,
) -> TestResult<(maka_plugin_core::operation::RecoveryRef, Value)> {
    let mut pending = rig
        .client
        .as_ref()
        .unwrap()
        .call("agent", method.into(), input, Attachments::new())
        .await?;
    pending.start().await?;
    assert!(matches!(pending.receive().await?, Reply::Prepared { .. }));
    // Discard the committed reply; recovery must use the original journal.
    let _ = pending.confirm(json!({"test":"preset-lost-reply"})).await?;
    let reference = pending
        .reference()
        .ok_or("missing recovery reference")?
        .clone();
    pending.close().await?;
    let observation = rig
        .store
        .as_ref()
        .unwrap()
        .operation(&reference)?
        .operation_observation()
        .await?
        .ok_or("missing operation")?;
    let OperationOutcome::Returned {
        result: OperationResult::Success { value },
    } = observation.outcome
    else {
        return Err(format!("unexpected observation: {observation:?}").into());
    };
    Ok((reference, value))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn preset_management_survives_conflicts_lost_replies_and_restart() {
    let mut rig = Rig::new().unwrap();
    let result = AssertUnwindSafe(tokio::time::timeout(
        Duration::from_secs(120),
        exercise(&mut rig),
    ))
    .catch_unwind()
    .await;

    let cleanup = rig.finish().await;
    assert!(matches!(result, Ok(Ok(Ok(())))), "{result:?}");
    assert!(cleanup.is_empty(), "{cleanup:?}");
}

async fn exercise(rig: &mut Rig) -> TestResult<()> {
    let base = rig.directory.path().to_path_buf();
    let boot = bootstrap(&base, "http://127.0.0.1:1/v1".into(), false).await?;
    attach(rig, &boot).await?;
    let client = rig.client.as_ref().unwrap();
    assert_eq!(
        call(client, "agent", "presets", json!({})).await?,
        json!([])
    );
    let catalog = call(client, "settings", "connections", json!({"kind":"start"})).await?;
    let connection=call(client,"settings","create",json!({
            "expectedCatalogRevision":catalog["revision"],
            "connection":{"slug":"presets","name":"Presets",
            "provider":{"packageId":"maka.providers","entryId":"maka.providers","scope":"profile","name":"ollama"},
            "configuration":{"baseUrl":boot.base_url},"enabled":true,"enabledModelIds":["llama3.2"],
            "modelOverrides":{"llama3.2":{"codeMode":false,"apiProtocol":"openai-chat-completions","thinkingLevels":["high"]}}}
        })).await?;
    assert_eq!(connection["kind"], "committed");
    let model =
        json!({"connectionId":connection["connection"]["connectionId"],"modelId":"llama3.2"});
    let instruction = "  # Role\n\n- Preserve **Markdown**\n中文\n";
    let create = json!({"name":"  Reviewer  ","description":"Review changes","instruction":instruction,"model":model,"thinkingLevel":"high"});
    assert_eq!(
        call(
            client,
            "agent",
            "createPreset",
            json!({"name":" ","description":"review","model":model})
        )
        .await?["kind"],
        "invalidInput"
    );
    assert_eq!(
        call(
            client,
            "agent",
            "createPreset",
            json!({"name":"bad","description":" ","model":model})
        )
        .await?["kind"],
        "invalidInput"
    );
    assert_eq!(
        call(
            client,
            "agent",
            "createPreset",
            json!({"name":"bad","description":"review","model":model,"thinkingLevel":"ultra"})
        )
        .await?["kind"],
        "thinkingLevelUnavailable"
    );
    let (created_ref, created) = lost_reply(rig, "createPreset", create.clone()).await?;
    assert_eq!(created["kind"], "saved");
    let id = created["preset"]["id"].clone();
    assert_eq!(created["preset"]["name"], "Reviewer");
    assert_eq!(created["preset"]["instruction"], instruction);
    let list = call(client, "agent", "presets", json!({})).await?;
    assert_eq!(list.as_array().unwrap().len(), 1);
    assert!(list[0].get("instruction").is_none());
    assert_eq!(list[0]["availability"]["kind"], "available");
    let mut concurrent = create.clone();
    concurrent["name"] = json!("Writer");
    concurrent["instruction"] = json!("");
    let (a, b) = tokio::join!(
        call(client, "agent", "createPreset", concurrent.clone()),
        call(client, "agent", "createPreset", concurrent)
    );
    let (a, b) = (a?, b?);
    assert!(matches!(
        (a["kind"].as_str(), b["kind"].as_str()),
        (Some("saved"), Some("nameConflict")) | (Some("nameConflict"), Some("saved"))
    ));
    let other = if a["kind"] == "saved" { a } else { b };
    let other_id = other["preset"]["id"].clone();
    let (a, b) = tokio::join!(
        call(
            client,
            "agent",
            "updatePreset",
            json!({"id":id,"expectedRevision":1,"name":"Shared"})
        ),
        call(
            client,
            "agent",
            "updatePreset",
            json!({"id":other_id,"expectedRevision":1,"name":"Shared"})
        )
    );
    let (a, b) = (a?, b?);
    assert!(matches!(
        (a["kind"].as_str(), b["kind"].as_str()),
        (Some("saved"), Some("nameConflict")) | (Some("nameConflict"), Some("saved"))
    ));
    let detail = call(client, "agent", "preset", json!({"id":id})).await?;
    let revision = detail["preset"]["revision"].as_u64().unwrap();
    let (updated_ref, updated) = lost_reply(
        rig,
        "updatePreset",
        json!({"id":id,"expectedRevision":revision,"enabled":false}),
    )
    .await?;
    assert_eq!(updated["preset"]["instruction"], instruction);
    assert_eq!(updated["preset"]["model"], model);
    assert_eq!(
        call(
            client,
            "agent",
            "updatePreset",
            json!({"id":id,"expectedRevision":revision,"instruction":"lost"})
        )
        .await?["kind"],
        "conflict"
    );
    assert_eq!(
        call(
            client,
            "agent",
            "deletePreset",
            json!({"id":id,"expectedRevision":revision})
        )
        .await?["kind"],
        "conflict"
    );
    assert_eq!(
        call(client, "agent", "preset", json!({"id":id})).await?["availability"]["kind"],
        "disabled"
    );
    assert_eq!(updated["preset"]["thinkingLevel"], "high");
    let other_detail = call(client, "agent", "preset", json!({"id":other_id})).await?;
    let other_revision = other_detail["preset"]["revision"].as_u64().unwrap();
    let (a, b) = tokio::join!(
        call(
            client,
            "agent",
            "updatePreset",
            json!({"id":other_id,"expectedRevision":other_revision,"thinkingLevel":{"kind":"default"}})
        ),
        call(
            client,
            "agent",
            "updatePreset",
            json!({"id":other_id,"expectedRevision":other_revision,"description":"Concurrent edit"})
        )
    );
    let (a, b) = (a?, b?);
    assert!(matches!(
        (a["kind"].as_str(), b["kind"].as_str()),
        (Some("saved"), Some("conflict")) | (Some("conflict"), Some("saved"))
    ));
    let reset=call(client,"agent","updatePreset",json!({"id":other_id,"expectedRevision":other_revision+1,"thinkingLevel":{"kind":"default"}})).await?;
    assert_eq!(reset["kind"], "saved");
    assert_eq!(reset["preset"]["thinkingLevel"], Value::Null);
    let saved_instruction = call(
        client,
        "agent",
        "updatePreset",
        json!({
            "id": other_id, "expectedRevision": other_revision + 2, "instruction": instruction
        }),
    )
    .await?;
    assert_eq!(saved_instruction["kind"], "saved");
    // Removing the connection must not prevent ordinary configuration repairs.
    let owner = rig.captured.lock().unwrap().clone().unwrap();
    owner.configuration.remove_connection(serde_json::from_value(json!({"expected":{"connectionId":connection["connection"]["connectionId"],"revision":connection["connection"]["revision"]}}))?).await.map_err(|e|e.to_string())?;
    let changed=call(client,"agent","updatePreset",json!({"id":id,"expectedRevision":revision+1,"instruction":"","thinkingLevel":null,"enabled":true})).await?;
    assert_eq!(changed["kind"], "saved");
    assert_eq!(changed["preset"]["instruction"], "");
    assert_eq!(
        call(client, "agent", "preset", json!({"id":id})).await?["availability"]["kind"],
        "modelUnavailable"
    );
    assert_eq!(
        call(
            client,
            "agent",
            "updatePreset",
            json!({"id":id,"expectedRevision":revision+2,"model":model})
        )
        .await?["kind"],
        "modelUnavailable"
    );
    drop(owner);
    assert!(rig.finish().await.is_empty());
    rig.client = None;
    rig.host = None;
    rig.store = None;
    rig.captured.lock().unwrap().take();
    rig.stop_serving = CancellationToken::new();
    attach(rig, &boot).await?;
    let client = rig.client.as_ref().unwrap();
    let detail = call(client, "agent", "preset", json!({"id":id})).await?;
    assert_eq!(detail["preset"], changed["preset"]);
    assert_eq!(
        call(client, "agent", "preset", json!({"id": other_id})).await?["preset"]["instruction"],
        instruction
    );
    for (reference, expected) in [(created_ref, created), (updated_ref, updated)] {
        let observed = rig
            .store
            .as_ref()
            .unwrap()
            .operation(&reference)?
            .operation_observation()
            .await?
            .unwrap();
        assert_eq!(
            observed.outcome,
            OperationOutcome::Returned {
                result: OperationResult::Success { value: expected }
            }
        );
    }
    assert_eq!(
        call(client, "agent", "presets", json!({}))
            .await?
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        call(
            client,
            "agent",
            "deletePreset",
            json!({"id":id,"expectedRevision":revision+2})
        )
        .await?["kind"],
        "deleted"
    );
    assert_eq!(
        call(client, "agent", "preset", json!({"id":id})).await?,
        Value::Null
    );
    assert_eq!(
        call(
            client,
            "agent",
            "deletePreset",
            json!({"id":id,"expectedRevision":revision+2})
        )
        .await?["kind"],
        "notFound"
    );
    Ok::<_, Box<dyn Error + Send + Sync>>(())
}
