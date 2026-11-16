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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn memory_management_cas_sources_deletion_and_restart() {
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
    let preferences = call(client, "settings", "assistantPreferences", json!({})).await?;
    assert_eq!(
        preferences["memory"],
        json!({"enabled":true,"agentReadEnabled":false})
    );
    let disabled=call(client,"settings","updateAssistantPreferences",json!({"expectedRevision":preferences["revision"],"mutation":{"kind":"memory","value":{"enabled":false,"agentReadEnabled":false}}})).await?;
    assert_eq!(disabled["kind"], "committed");
    let conflict=call(client,"settings","updateAssistantPreferences",json!({"expectedRevision":preferences["revision"],"mutation":{"kind":"memory","value":{"enabled":true,"agentReadEnabled":true}}})).await?;
    assert_eq!(conflict["kind"], "revision_conflict");

    let mut sessions = Vec::new();
    for title in ["Memory A", "Memory B"] {
        let created=call(client,"agent","create",json!({"title":title,"automaticTitle":false,"labels":[],"workspace":{"kind":"directory","path":base.join("workspace")}})).await?;
        assert_eq!(created["kind"], "created", "{created}");
        sessions.push(created["session"]["id"].clone());
    }
    let project_scope = json!({"kind":"project","sessionId":sessions[0]});
    let project_memory = call(
        client,
        "agent",
        "changeMemory",
        json!({"scope":project_scope,"edit":{"kind":"create","body":"Project only"}}),
    )
    .await?;
    assert_eq!(project_memory["kind"], "saved");
    assert_eq!(
        call(
            client,
            "agent",
            "memory",
            json!({"scope":{"kind":"project","sessionId":sessions[1]},"id":project_memory["id"]})
        )
        .await?["body"],
        "Project only"
    );
    assert_eq!(
        call(
            client,
            "agent",
            "memory",
            json!({"scope":{"kind":"personal"},"id":project_memory["id"]})
        )
        .await?,
        Value::Null
    );
    std::fs::create_dir_all(base.join("workspace/sub"))?;
    let child=call(client,"agent","create",json!({"title":"Subdirectory","automaticTitle":false,"labels":[],"workspace":{"kind":"directory","path":base.join("workspace/sub")}})).await?;
    assert_eq!(call(client,"agent","memory",json!({"scope":{"kind":"project","sessionId":child["session"]["id"]},"id":project_memory["id"]})).await?,Value::Null);
    let scope = json!({"kind":"personal"});
    let mut pending = client
        .call(
            "agent",
            "changeMemory".into(),
            json!({"scope":scope,"edit":{"kind":"create","body":"Prefer Chinese"}}),
            Attachments::new(),
        )
        .await?;
    pending.start().await?;
    assert!(matches!(pending.receive().await?, Reply::Prepared { .. }));
    let _ = pending.confirm(json!({"test":"memory-lost-reply"})).await?;
    let reference = pending.reference().unwrap().clone();
    pending.close().await?;
    let observation = rig
        .store
        .as_ref()
        .unwrap()
        .operation(&reference)?
        .operation_observation()
        .await?
        .unwrap();
    let OperationOutcome::Returned {
        result: OperationResult::Success { value: created },
    } = observation.outcome
    else {
        return Err("memory commit failed".into());
    };
    assert_eq!(created["kind"], "saved");
    assert!(created.get("body").is_none());
    let id = created["id"].clone();
    let read = json!({"scope":scope,"id":id});
    assert_eq!(
        call(client, "agent", "memory", read.clone()).await?["body"],
        "Prefer Chinese"
    );
    let (a, b) = tokio::join!(
        call(
            client,
            "agent",
            "changeMemory",
            json!({"scope":scope,"edit":{"kind":"correct","id":id,"expectedRevision":1,"body":"Prefer English"}})
        ),
        call(
            client,
            "agent",
            "changeMemory",
            json!({"scope":scope,"edit":{"kind":"correct","id":id,"expectedRevision":1,"body":"Prefer French"}})
        )
    );
    let (a, b) = (a?, b?);
    assert!(matches!(
        (a["kind"].as_str(), b["kind"].as_str()),
        (Some("saved"), Some("conflict")) | (Some("conflict"), Some("saved"))
    ));
    let history = call(
        client,
        "agent",
        "memoryHistory",
        json!({"scope":scope,"id":id,"limit":10}),
    )
    .await?;
    assert_eq!(history["versions"].as_array().unwrap().len(), 2);
    assert_eq!(history["versions"][0]["body"], "Prefer Chinese");
    assert_eq!(
        history["versions"][0]["source"]["operationId"],
        serde_json::to_value(reference.operation)?
    );
    assert_eq!(history["versions"][1]["corrects"], 1);
    for (revision, always) in [(2, true), (3, false)] {
        assert_eq!(call(client,"agent","changeMemory",json!({"scope":scope,"edit":{"kind":"set_always","id":id,"expectedRevision":revision,"always":always}})).await?["kind"],"saved");
    }
    assert_eq!(
        call(client, "agent", "memory", read.clone()).await?["mode"],
        "user_recall"
    );
    assert_eq!(
        call(
            client,
            "agent",
            "changeMemory",
            json!({"scope":scope,"edit":{"kind":"delete","id":id,"expectedRevision":4}})
        )
        .await?["kind"],
        "deleted"
    );
    assert_eq!(
        call(client, "agent", "memory", read.clone()).await?,
        Value::Null
    );
    assert!(
        call(
            client,
            "agent",
            "memories",
            json!({"scope":scope,"limit":1})
        )
        .await?["records"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(
        call(
            client,
            "agent",
            "memoryHistory",
            json!({"scope":scope,"id":id,"limit":10})
        )
        .await?["versions"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(call(client,"agent","changeMemory",json!({"scope":scope,"edit":{"kind":"correct","id":id,"expectedRevision":5,"body":"silent resurrection"}})).await?["kind"],"invalid_state");
    assert!(rig.finish().await.is_empty());
    rig.client = None;
    rig.host = None;
    rig.store = None;
    rig.captured.lock().unwrap().take();
    rig.stop_serving = CancellationToken::new();
    attach(rig, &boot).await?;
    let client = rig.client.as_ref().unwrap();
    assert_eq!(
        call(client, "agent", "memory", read.clone()).await?,
        Value::Null
    );
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
            result: OperationResult::Success { value: created }
        }
    );
    assert_eq!(call(client,"agent","changeMemory",json!({"scope":scope,"edit":{"kind":"restore","id":id,"expectedRevision":5,"body":"Explicitly restored"}})).await?["revision"],6);
    assert_eq!(
        call(client, "agent", "memory", read).await?["body"],
        "Explicitly restored"
    );
    Ok(())
}
