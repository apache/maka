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
async fn keyed_submissions_choose_one_winner_queue_separate_runs_and_release_retracted_keys()
-> TestResult<()> {
    let mut rig = Rig::new()?;
    let mut provider = Provider::start().await?;
    let outcome = AssertUnwindSafe(tokio::time::timeout(
        Duration::from_secs(60),
        race(&mut rig, &mut provider),
    ))
    .catch_unwind()
    .await;
    let cleanup = rig.finish().await;
    assert!(cleanup.is_empty(), "{cleanup:?}");
    match outcome {
        Ok(result) => result?,
        Err(panic) => std::panic::resume_unwind(panic),
    }
}

async fn race(rig: &mut Rig, provider: &mut Provider) -> TestResult<()> {
    let base = rig.directory.path().to_owned();
    let boot = bootstrap(&base, provider.server.base_url(), false).await?;
    attach(rig, &boot).await?;
    let client = rig.client.as_ref().unwrap();
    let model = model(client, &boot.base_url, false).await?;
    let one = create(client, &base, &model, None).await?;
    let two = create(client, &base, &model, None).await?;

    let send = |session: &Value, key: &str, text: &str| {
        json!({
            "sessionId":session["id"], "idempotencyKey":key, "message":text, "attachments":[]
        })
    };
    let lookup = |session: &Value, key: &str| {
        call(
            client,
            "agent",
            "lookupSubmission",
            json!({"sessionId":session["id"], "idempotencyKey":key}),
        )
    };

    let key = "same opaque key";
    let texts = ["left candidate", "left candidate", "right candidate"];
    let mut calls = Vec::new();
    for text in texts {
        calls.push(prepared(client, "submitMessage", send(&one, key, text)).await?);
    }
    // All three proposals exist before any confirmation is sent.
    let receipts = futures_util::future::try_join_all(calls.into_iter().map(confirm)).await?;
    let mut winners = receipts
        .iter()
        .enumerate()
        .filter(|(_, r)| r["kind"] == "queued");
    let (winner, receipt) = winners.next().ok_or("no winner")?;
    assert!(winners.next().is_none(), "{receipts:?}");
    let message = &receipt["messageId"];
    assert!(message.is_string());
    for (i, r) in receipts.iter().enumerate() {
        if i != winner {
            assert_eq!(r, &json!({"kind":"duplicate","messageId":message}));
        }
    }

    let foreign = json!({"id":"outside-this-agent-namespace"});
    assert!(lookup(&foreign, key).await.is_err());
    assert!(
        call(
            client,
            "agent",
            "submitMessage",
            send(&foreign, key, "retry")
        )
        .await
        .is_err()
    );

    let (_, turn) = provider.next().await?;
    let id = one["id"].as_str().unwrap();
    let b_key = "Same opaque key";
    let c_key = "another key";
    let (b, c) = tokio::try_join!(
        prepared(client, "submitMessage", send(&one, b_key, "retract me")),
        prepared(client, "submitMessage", send(&one, c_key, "keep me")),
    )?;
    let (b, c) = tokio::try_join!(confirm(b), confirm(c))?;
    for receipt in [&b, &c] {
        assert_eq!(receipt["kind"], "queued", "{receipt}");
    }
    assert_eq!(lookup(&one, b_key).await?, b["messageId"]);
    assert_eq!(lookup(&one, c_key).await?, c["messageId"]);

    let retry = call(
        client,
        "agent",
        "submitMessage",
        send(&one, c_key, "do not overwrite C"),
    )
    .await?;
    assert_eq!(
        retry,
        json!({"kind":"duplicate","messageId":c["messageId"]})
    );

    let queue = || call(client, "agent", "queue", json!({"sessionId":id}));
    let withdraw = |message: &Value| {
        call(
            client,
            "agent",
            "withdrawSubmission",
            json!({"sessionId":id,"messageId":message}),
        )
    };
    assert!(
        call(
            client,
            "agent",
            "withdrawSubmission",
            json!({"sessionId":two["id"], "messageId":c["messageId"]})
        )
        .await
        .is_err(),
        "a real message ID from another session is not a withdrawal capability"
    );
    let retracted = withdraw(&b["messageId"]).await?;
    assert_eq!(retracted["kind"], "cancelled", "{retracted}");
    assert_eq!(lookup(&one, b_key).await?, Value::Null);
    let replacement = call(
        client,
        "agent",
        "submitMessage",
        send(&one, b_key, "replacement"),
    )
    .await?;
    assert_eq!(replacement["kind"], "queued", "{replacement}");
    assert_ne!(replacement["messageId"], b["messageId"]);
    assert_eq!(withdraw(&b["messageId"]).await?["kind"], "cancelled");
    assert_eq!(lookup(&one, b_key).await?, replacement["messageId"]);

    let mut followups = vec![
        (c["messageId"].clone(), "keep me"),
        (replacement["messageId"].clone(), "replacement"),
    ];
    let unkeyed = json!({"sessionId":id,"message":"unkeyed"});
    for input in [
        unkeyed,
        json!({"sessionId":id,"message":"unkeyed","idempotencyKey":null}),
    ] {
        let queued = call(client, "agent", "submitMessage", input).await?;
        assert_eq!(queued["kind"], "queued", "{queued}");
        followups.push((queued["messageId"].clone(), "unkeyed"));
    }
    assert_ne!(followups[2].0, followups[3].0);
    let pending = queue().await?;
    let entries = pending["entries"].as_array().unwrap();
    assert_eq!(entries.len(), followups.len(), "{pending}");
    for (entry, (expected, _)) in entries.iter().zip(&followups) {
        assert_eq!(entry["kind"], "followup", "{entry}");
        assert_eq!(entry["messageId"], *expected);
    }

    turn.reply_text("Done.");
    let mut runs = vec![completed_message(client, id, message).await?];
    for (message, _) in &followups {
        let (_, turn) = provider.next().await?;
        turn.reply_text("Done.");
        let run = completed_message(client, id, message).await?;
        assert!(!runs.contains(&run), "follow-up shared another run");
        runs.push(run);
    }
    let mut read = json!({"sessionId":id,"position":{"kind":"start"}});
    let mut users = Vec::new();
    loop {
        let page = call(client, "agent", "history", read.clone()).await?;
        users.extend(
            page["chunks"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|row| row["role"] == "user")
                .map(|row| json!([row["messageId"], row["text"]])),
        );
        if page["after"].is_null() {
            break;
        }
        read["through"] = page["through"].clone();
        read["position"] = json!({"kind":"after","cursor":page["after"]});
    }
    let mut expected = vec![json!([message, texts[winner]])];
    expected.extend(
        followups
            .iter()
            .map(|(message, text)| json!([message, text])),
    );
    assert_eq!(users, expected);

    assert_eq!(withdraw(message).await?["kind"], "delivered");
    assert_eq!(lookup(&two, key).await?, Value::Null);
    let other = call(
        client,
        "agent",
        "submitMessage",
        send(&two, key, "another session"),
    )
    .await?;
    assert_eq!(other["kind"], "queued", "{other}");
    let (_, turn) = provider.next().await?;
    turn.reply_text("Done.");
    quiescent_message(client, two["id"].as_str().unwrap(), &other["messageId"]).await?;
    assert_eq!(lookup(&one, key).await?, *message);
    assert_eq!(lookup(&two, key).await?, other["messageId"]);
    Ok(())
}
