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
use maka_event_log::root::ROOT_DATABASE;
use rusqlite::Connection;

real_host_test!(
    definitions_and_original_operations_survive_restart,
    definitions_case
);

async fn definitions_case(rig: &mut Rig) -> Result<()> {
    let client = rig.start().await?;
    let description = client.describe("projectActions").await?;
    let maka_plugin_core::contract::Interface::Service { methods } = description.contract.interface
    else {
        return Err("Project Actions must expose a service".into());
    };
    assert_eq!(
        methods.keys().map(String::as_str).collect::<Vec<_>>(),
        ["create", "definitions", "remove", "update"]
    );
    let project = register(&client, &rig.sandbox.workspace).await?;
    let create_id = Uuid::new_v4();
    let reply = mutate_with_id(
        &client,
        create_id,
        "projectActions",
        "create",
        json!({"projectId": project, "name": "Dev", "command": "npm run dev"}),
    )
    .await?;
    let definition = completed(returned(&reply)?)?;
    assert_eq!(
        query(&client, "definitions", json!({"projectId": project})).await?,
        json!([definition])
    );

    client.close().await?;
    let reconnected = rig.connect().await?;
    let recovered = reconnected.recover(create_id).await?;
    assert_eq!(recovered.reference, reply.reference);
    assert_eq!(returned(&recovered)?, returned(&reply)?);
    assert_eq!(
        query(&reconnected, "definitions", json!({"projectId": project})).await?,
        json!([definition])
    );

    let update_id = Uuid::new_v4();
    let update_reply = mutate_with_id(
        &reconnected,
        update_id,
        "projectActions",
        "update",
        json!({
            "projectId":project, "id":definition["id"], "revision":definition["revision"],
            "name":"Build", "command":"npm run build"
        }),
    )
    .await?;
    let updated = completed(returned(&update_reply)?)?;
    assert_eq!(updated["id"], definition["id"]);
    assert!(updated["revision"].as_u64() > definition["revision"].as_u64());
    for (method, input) in [
        (
            "update",
            json!({"projectId":project,"id":definition["id"],"revision":definition["revision"],"name":"Stale","command":"false"}),
        ),
        (
            "remove",
            json!({"projectId":project,"id":definition["id"],"revision":definition["revision"]}),
        ),
    ] {
        let rejected = mutate_with_id(
            &reconnected,
            Uuid::new_v4(),
            "projectActions",
            method,
            input,
        )
        .await?;
        assert!(
            matches!(
                rejected.receipt,
                Receipt::Recorded {
                    outcome: OperationOutcome::Returned {
                        result: OperationResult::Failure { ref diagnostic },
                    },
                    ..
                } if diagnostic.contains("Action definition changed")
            ),
            "stale {method} overwrote configuration: {rejected:?}"
        );
    }
    assert_eq!(
        query(&reconnected, "definitions", json!({"projectId":project})).await?,
        json!([updated])
    );

    rig.quit().await?;
    let restarted = rig.start().await?;
    assert_eq!(
        query(&restarted, "definitions", json!({"projectId":project})).await?,
        json!([updated])
    );
    let remove_id = Uuid::new_v4();
    let remove_reply = mutate_with_id(
        &restarted,
        remove_id,
        "projectActions",
        "remove",
        json!({"projectId":project,"id":updated["id"],"revision":updated["revision"]}),
    )
    .await?;
    assert_eq!(completed(returned(&remove_reply)?)?, Value::Null);

    let host = rig.hosts.last_mut().ok_or("no held Host")?;
    phase("kill original Host after remove", host.process.sigkill()).await?;
    rig.clients.clear();
    let reopened = rig.start().await?;
    for (id, original) in [
        (create_id, reply),
        (update_id, update_reply),
        (remove_id, remove_reply),
    ] {
        let recovered = reopened.recover(id).await?;
        assert_eq!(recovered.reference, original.reference);
        assert_eq!(returned(&recovered)?, returned(&original)?);
    }
    assert_eq!(
        query(&reopened, "definitions", json!({"projectId":project})).await?,
        json!([])
    );
    rig.quit().await
}

real_host_test!(
    definitions_roll_back_when_returned_receipt_cannot_be_written,
    receipt_failure_case
);

real_host_test!(definitions_reject_an_oversized_configuration, capacity_case);

async fn capacity_case(rig: &mut Rig) -> Result<()> {
    let client = rig.start().await?;
    let project = register(&client, &rig.sandbox.workspace).await?;
    let large = "x".repeat(4 * 1024);
    for _ in 0..11 {
        action(
            &client,
            "create",
            json!({"projectId":project,"name":"Large","command":large}),
        )
        .await?;
    }
    let small = action(
        &client,
        "create",
        json!({"projectId":project,"name":"Small","command":"true"}),
    )
    .await?;
    let query_input = json!({"projectId":project});
    let original = query(&client, "definitions", query_input.clone()).await?;
    for (method, input) in [
        (
            "create",
            json!({"projectId":project,"name":"Overflow","command":large}),
        ),
        (
            "update",
            json!({
                "projectId":project,"id":small["id"],"revision":small["revision"],
                "name":"Overflow","command":large
            }),
        ),
    ] {
        let reply =
            mutate_with_id(&client, Uuid::new_v4(), "projectActions", method, input).await?;
        assert!(
            matches!(
                reply.receipt,
                Receipt::Recorded {
                    outcome: OperationOutcome::Returned {
                        result: OperationResult::Failure { ref diagnostic },
                    },
                    ..
                } if diagnostic.contains("exceed the configuration limit")
            ),
            "{method} did not report the capacity limit: {reply:?}"
        );
        assert_eq!(
            query(&client, "definitions", query_input.clone()).await?,
            original
        );
    }
    rig.quit().await
}

async fn receipt_failure_case(rig: &mut Rig) -> Result<()> {
    let client = rig.start().await?;
    let catalog: maka_plugin_core::deployment::management::UiCatalog =
        serde_json::from_value(client.query("management", "readUi", json!({})).await?)
            .map_err(|error| error.to_string())?;
    let instance = |name: &str| {
        catalog
            .instances
            .iter()
            .find(|ui| ui.path.last().is_some_and(|part| part == name))
            .map(|ui| ui.instance.clone())
            .ok_or_else(|| format!("missing {name}"))
    };
    let settings = instance("settings-ui")?;
    let conversations = instance("conversations-ui")?;
    let (ui, imports) = client.bind_ui(catalog.source, settings.clone()).await?;
    let [endpoint] = imports["projectActions"].as_slice() else {
        return Err("expected one Project Actions binding".into());
    };
    let project = register(&client, &rig.sandbox.workspace).await?;
    let create = json!({"projectId":project,"name":"Dev","command":"npm run dev"});
    let original = action(&client, "create", create.clone()).await?;
    let update = json!({
        "projectId":project,"id":original["id"],"revision":original["revision"],
        "name":"Build","command":"npm run build"
    });
    let remove = json!({"projectId":project,"id":original["id"],"revision":original["revision"]});
    let mut operations = Vec::new();
    for (method, input) in [("create", create), ("update", update), ("remove", remove)] {
        let id = Uuid::new_v4();
        let mutation = ui
            .mutation(
                id,
                endpoint,
                method,
                input,
                Attachments::new(),
                None,
                json!({"kind":"ui","instance":settings,"import":"projectActions","index":0}),
            )
            .await?;
        let reference = mutation
            .prepare()
            .await?
            .reference
            .ok_or("missing prepared reference")?;
        let db = Connection::open(rig.sandbox.root.join(ROOT_DATABASE))
            .map_err(|error| error.to_string())?;
        db.busy_timeout(Duration::from_secs(5))
            .map_err(|error| error.to_string())?;
        // Reject only this operation's final Returned write. Admission and
        // fallback Unknown/cleanup writes still use the real Host writer.
        db.execute_batch(&format!(
            "CREATE TRIGGER reject_action_returned BEFORE UPDATE OF outcome_json ON application_operations
             WHEN OLD.operation='{}' AND json_extract(NEW.outcome_json,'$.kind')='returned'
             BEGIN SELECT RAISE(ABORT,'fixture rejected Action Returned'); END;",
            reference.operation
        )).map_err(|error| error.to_string())?;
        let reply = phase("confirm with the receipt fault armed", mutation.confirm()).await;
        db.execute_batch("DROP TRIGGER reject_action_returned")
            .map_err(|error| error.to_string())?;
        assert_eq!(
            query(&client, "definitions", json!({"projectId":project})).await?,
            json!([original]),
            "{method} changed configuration even though its Returned write failed"
        );
        let reply = reply?;
        assert_eq!(reply.reference, reference);
        assert!(
            matches!(
                reply.receipt,
                Receipt::Recorded { outcome: OperationOutcome::Unknown { ref diagnostic }, .. }
                    if diagnostic.contains("fixture rejected Action Returned")
            ),
            "{method} did not reach the injected receipt failure: {reply:?}"
        );
        operations.push((id, reply));
    }

    rig.quit().await?;
    let reopened = rig.start().await?;
    let pending = reopened.pending_ui(&settings).await?;
    assert_eq!(pending.len(), operations.len());
    assert!(reopened.pending_ui(&conversations).await?.is_empty());
    for (id, original) in operations {
        assert!(pending.iter().any(|operation| operation.id == id));
        let saved = reopened.operation_for_ui(&settings, id).await?;
        assert_eq!(
            saved.correlation,
            json!({"kind":"ui","instance":settings,"import":"projectActions","index":0,"projectId":project})
        );
        assert!(reopened.operation_for_ui(&conversations, id).await.is_err());
        assert_eq!(reopened.recover(id).await?, original);
    }
    assert_eq!(
        query(&reopened, "definitions", json!({"projectId":project})).await?,
        json!([original])
    );
    rig.quit().await
}
