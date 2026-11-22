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
use maka_app_client::SubscriptionEvent;

real_host_test!(
    session_terminal_launches_keep_their_original_receipts,
    terminal_launches
);

async fn terminal_launches(rig: &mut Rig) -> Result<()> {
    let client = rig.start().await?;
    let session = create_session(&client, &rig.sandbox.workspace).await?;
    let session = session.as_str();

    let plain = mutate_terminal(&client, session, "start", json!({"sessionId":session})).await?;
    let plain = completed(returned(&plain)?)?;
    assert_eq!(plain["result"]["mode"], "pty");
    assert_eq!(plain["visibility"], "model");

    let pipe = mutate_terminal(
        &client,
        session,
        "start",
        json!({"sessionId":session,"command":"printf 'pipe output'"}),
    )
    .await?;
    let pipe = completed(returned(&pipe)?)?;
    assert_eq!(pipe["result"]["mode"], "pipes");
    let watch = client
        .subscribe("terminal", "watch", target(session, &pipe))
        .await?;
    let output = phase("pipe completion", async {
        while let Some(event) = watch.next().await? {
            let value = match event {
                SubscriptionEvent::Item(value) | SubscriptionEvent::Finished(value) => value,
            };
            let observed = completed(value)?;
            if observed["result"]["status"] == "completed" {
                return Ok(observed);
            }
        }
        Err("pipe ended without a completed snapshot".into())
    })
    .await?;
    watch.close().await?;
    assert_eq!(output["result"]["output"]["stdout"], "pipe output");

    std::fs::create_dir(rig.sandbox.workspace.join("nested")).map_err(|error| error.to_string())?;
    let id = Uuid::new_v4();
    let second_id = Uuid::new_v4();
    let start = |id| client.terminal_mutation(id, "start", json!({"sessionId":session}), session);
    let (action, second) = tokio::try_join!(start(id), start(second_id))?;
    let (prepared, _) = tokio::try_join!(action.prepare(), second.prepare())?;
    let pending = client.pending_terminals(session).await?;
    assert_eq!(pending.len(), 2);
    assert!(pending.iter().any(|item| item.id == id));
    assert!(pending.iter().any(|item| item.id == second_id));
    assert_eq!(
        client.operation_for_terminal(id, session).await?.reference,
        prepared.reference
    );
    assert!(
        client
            .operation_for_terminal(id, "another-session")
            .await
            .is_err()
    );
    let (reply, second_reply) = tokio::try_join!(action.confirm(), second.confirm())?;
    action.close().await?;
    second.close().await?;
    let entry = completed(returned(&reply)?)?;
    let second_entry = completed(returned(&second_reply)?)?;
    assert_ne!(entry["result"]["ref"], second_entry["result"]["ref"]);
    assert_eq!(entry["result"]["mode"], "pty");
    assert_eq!(entry["visibility"], "model");

    client.close().await?;
    let reconnected = rig.connect().await?;
    let original = reconnected.operation_for_terminal(id, session).await?;
    assert_eq!(original.reference.as_ref(), Some(&reply.reference));
    let recovered = reconnected.recover(id).await?;
    assert_eq!(recovered.reference, reply.reference);
    assert_eq!(returned(&recovered)?, returned(&reply)?);
    assert!(reconnected.pending_terminals(session).await?.is_empty());

    let original_terminal = target(session, &entry);
    send_command(
        &reconnected,
        session,
        &original_terminal,
        "cd nested; export ACTION_TEST_STATE=inside; printf '%s\\n' 'quotes ! $ 中文' >> ../launches",
    )
    .await?;
    let launches = rig.sandbox.workspace.join("launches");
    phase("first command ran", async {
        while !launches.is_file() {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        Ok(())
    })
    .await?;
    send_command(
        &reconnected,
        session,
        &original_terminal,
        "test \"$ACTION_TEST_STATE\" = inside && printf 'retained output\\n' | tee ordinary-marker; exit",
    )
    .await?;
    let ended = finished_terminal(&reconnected, original_terminal).await?;
    assert_eq!(ended["result"]["exitCode"], 0);
    assert!(
        rig.sandbox
            .workspace
            .join("nested/ordinary-marker")
            .is_file()
    );
    assert!(!rig.sandbox.workspace.join("ordinary-marker").exists());
    assert!(terminal_text(&ended).contains("retained output"), "{ended}");
    assert_eq!(
        std::fs::read_to_string(launches).unwrap(),
        "quotes ! $ 中文\n"
    );

    let second_terminal = target(session, &second_entry);
    send_command(
        &reconnected,
        session,
        &second_terminal,
        "printf second > second-launch; exit 9",
    )
    .await?;
    let ended = finished_terminal(&reconnected, second_terminal).await?;
    assert_eq!(ended["result"]["exitCode"], 9);
    assert_eq!(
        std::fs::read_to_string(rig.sandbox.workspace.join("second-launch")).unwrap(),
        "second"
    );

    completed(returned(
        &mutate_terminal(&reconnected, session, "stop", target(session, &plain)).await?,
    )?)?;
    rig.quit().await
}

async fn create_session(client: &Client, workspace: &Path) -> Result<String> {
    let created = returned(
        &mutate_with_id(
            client,
            Uuid::new_v4(),
            "agent",
            "create",
            json!({
                "backend": null, "automaticTitle": false, "tools": [], "labels": [],
                "title": "Terminal launch contracts",
                "workspace": {"kind":"directory", "path":workspace}
            }),
        )
        .await?,
    )?;
    created["session"]["id"]
        .as_str()
        .map(str::to_owned)
        .ok_or("missing Session id".into())
}

async fn send_command(client: &Client, session: &str, target: &Value, command: &str) -> Result<()> {
    let stream = client
        .subscribe("terminal", "acquire", target.clone())
        .await?;
    let Some(SubscriptionEvent::Item(lease)) =
        phase("acquire terminal", async { Ok(stream.next().await?) }).await?
    else {
        return Err("Terminal ended before accepting input".into());
    };
    let lease = completed(lease)?;
    assert_eq!(lease["held"], true);
    let controller = json!({"target":target,"controllerId":lease["controllerId"]});
    let reply = mutate_terminal(
        client,
        session,
        "control",
        json!({
            "controller":controller,
            "sequence":lease["nextSequence"],
            "actions":[{"type":"paste","text":format!(" {command}")},{"type":"key","key":"enter"}],
        }),
    )
    .await?;
    completed(returned(&reply)?)?;
    completed(returned(
        &mutate_terminal(client, session, "release", controller).await?,
    )?)?;
    stream.close().await?;
    Ok(())
}

async fn finished_terminal(client: &Client, target: Value) -> Result<Value> {
    let watch = client.subscribe("terminal", "watch", target).await?;
    let result = phase("terminal completion", async {
        while let Some(event) = watch.next().await? {
            if let SubscriptionEvent::Finished(value) = event {
                let value = completed(value)?;
                assert!(!matches!(
                    value["result"]["status"].as_str(),
                    Some("starting" | "running")
                ));
                return Ok(value);
            }
        }
        Err("terminal ended without its settled snapshot".into())
    })
    .await;
    watch.close().await?;
    result
}

fn terminal_text(value: &Value) -> &str {
    value["result"]["output"]["screen"]
        .as_str()
        .unwrap_or_default()
}

fn target(session: &str, entry: &Value) -> Value {
    json!({"sessionId":session,"ref":entry["result"]["ref"]})
}

async fn mutate_terminal(
    client: &Client,
    session: &str,
    method: &str,
    input: Value,
) -> Result<OperationReply> {
    let mutation = client
        .terminal_mutation(Uuid::new_v4(), method, input, session)
        .await?;
    mutation.prepare().await?;
    let reply = mutation.confirm().await?;
    mutation.close().await?;
    Ok(reply)
}

#[cfg(target_os = "macos")]
mod action_input {
    use super::*;

    real_host_test!(action_stays_with_the_original_shell_and_receipt, recovery);
    real_host_test!(action_sends_input_before_the_shell_prompt, direct_input);

    fn put(path: &Path, source: &str) -> Result<()> {
        std::fs::write(path, source).map_err(|error| error.to_string())
    }

    fn profile(home: &Path, source: &str) -> Result<()> {
        for name in [".zshrc", ".bash_profile"] {
            put(&home.join(name), source)?;
        }
        Ok(())
    }

    async fn resource_where(
        client: &Client,
        session: &str,
        predicate: impl Fn(&Value) -> bool,
    ) -> Result<Value> {
        phase("matching original terminal state", async {
            loop {
                let list = completed(
                    client
                        .query("terminal", "list", json!({"sessionId":session}))
                        .await?,
                )?;
                if let Some(entry) = list["resources"]
                    .as_array()
                    .and_then(|rows| rows.iter().find(|entry| predicate(entry)))
                {
                    return Ok(entry.clone());
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
    }

    async fn visible_text(client: &Client, target: &Value, text: &str) -> Result<()> {
        phase("original terminal output", async {
            loop {
                let value = completed(client.query("terminal", "read", target.clone()).await?)?;
                if terminal_text(&value).contains(text) {
                    return Ok(());
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
    }

    async fn file(path: &Path, expected: &str) -> Result<()> {
        phase("file written by the actual shell", async {
            while std::fs::read_to_string(path).as_deref().ok() != Some(expected) {
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
            Ok(())
        })
        .await
    }

    async fn recovery(rig: &mut Rig) -> Result<()> {
        let project = rig.sandbox.workspace.clone();
        profile(&rig.sandbox.home, "HISTFILE=/dev/null\n")?;
        std::fs::create_dir(project.join("nested")).map_err(|error| error.to_string())?;
        let client = rig.start().await?;
        let session = create_session(&client, &project).await?;
        let id = Uuid::new_v4();
        let mutation = client
            .terminal_mutation(
                id,
                "startWithCommand",
                json!({
                    "sessionId":session,
                    "initialCommand":"cd nested\nexport ACTION_TEST_STATE=inside\nprintf '%s\\n' 'quotes ! $ 中文' >> ../deliveries"
                }),
                &session,
            )
            .await?;
        let prepared = mutation.prepare().await?;
        let reference = prepared.reference.ok_or("missing original reference")?;
        let journal =
            rusqlite::Connection::open(&rig.sandbox.journal).map_err(|error| error.to_string())?;
        journal
            .execute_batch(&format!(
                "CREATE TRIGGER lose_action_receipt BEFORE UPDATE OF receipt ON operations
             WHEN NEW.id = '{id}' BEGIN SELECT RAISE(ABORT, 'fixture lost Action receipt'); END;"
            ))
            .map_err(|error| error.to_string())?;
        let confirmation = mutation.confirm().await;
        assert!(confirmation.is_err(), "{confirmation:?}");
        let _ = mutation.close().await;
        journal
            .execute_batch("DROP TRIGGER lose_action_receipt")
            .map_err(|error| error.to_string())?;
        let original = rig.connect().await?;
        assert!(
            original
                .pending_terminals(&session)
                .await?
                .iter()
                .any(|item| item.id == id)
        );
        let entry = resource_where(&original, &session, |row| {
            row["correlation"]["operationId"] == reference.operation.to_string()
                && row["correlation"]["initialCommandDelivery"] == "submitted"
        })
        .await?;
        let receipt = original.recover(id).await?;
        assert_eq!(receipt.reference, reference);
        let recovered = completed(returned(&receipt)?)?;
        assert_eq!(recovered["result"]["ref"], entry["result"]["ref"]);
        assert!(
            !original
                .pending_terminals(&session)
                .await?
                .iter()
                .any(|item| item.id == id)
        );

        let shell = target(&session, &entry);
        send_command(
            &original,
            &session,
            &shell,
            "test \"$ACTION_TEST_STATE\" = inside && printf same-shell > same-shell; exit",
        )
        .await?;
        let ended = finished_terminal(&original, shell).await?;
        assert_eq!(ended["result"]["exitCode"], 0);
        file(&project.join("nested/same-shell"), "same-shell").await?;
        file(&project.join("deliveries"), "quotes ! $ 中文\n").await?;
        rig.quit().await
    }

    async fn direct_input(rig: &mut Rig) -> Result<()> {
        let project = rig.sandbox.workspace.clone();
        profile(
            &rig.sandbox.home,
            "/bin/sh -c 'read -r answer; printf \"%s\\n\" \"$answer\" > startup-answer'\nPS1='maka-prompt> '\n",
        )?;
        let client = rig.start().await?;
        let session = create_session(&client, &project).await?;
        let command = "printf action > action-ran";
        let entry = completed(returned(
            &mutate_terminal(
                &client,
                &session,
                "startWithCommand",
                json!({"sessionId":session,"initialCommand":command}),
            )
            .await?,
        )?)?;
        let delivery = resource_where(&client, &session, |row| {
            row["result"]["ref"] == entry["result"]["ref"]
                && row["correlation"]["initialCommandDelivery"] != "pending"
        })
        .await?;
        assert_eq!(
            delivery["correlation"]["initialCommandDelivery"],
            "submitted"
        );
        file(&project.join("startup-answer"), &format!("{command}\n")).await?;
        let shell = target(&session, &entry);
        visible_text(&client, &shell, "maka-prompt>").await?;
        send_command(
            &client,
            &session,
            &shell,
            "printf manual > manual-ran; exit",
        )
        .await?;
        let ended = finished_terminal(&client, shell).await?;
        assert_eq!(ended["correlation"]["initialCommandDelivery"], "submitted");
        file(&project.join("manual-ran"), "manual").await?;
        assert!(!project.join("action-ran").exists());
        rig.quit().await
    }
}
