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

async fn create_room(client: &HostClient, base: &Path) -> TestResult<String> {
    let result = call(
        client,
        "agent",
        "create",
        json!({
            "kind":"room", "title":"Review room", "labels":[],
            "workspace":{"kind":"directory","path":base.join("workspace")}
        }),
    )
    .await?;
    assert_eq!(result["kind"], "created", "{result}");
    Ok(result["session"]["id"]
        .as_str()
        .ok_or("Room ID missing")?
        .into())
}

async fn reopen(rig: &mut Rig, boot: &Boot) -> TestResult<()> {
    assert_eq!(rig.finish().await, Vec::<String>::new());
    let directory = std::mem::replace(&mut rig.directory, TestDirectory::Borrowed(PathBuf::new()));
    *rig = Rig::new()?;
    rig.directory = directory;
    attach(rig, boot).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn room_interrupted_send_delivers_each_recipient_once_after_reopen() -> TestResult<()> {
    use base64::Engine as _;
    use maka_capabilities::call::immutable_bytes;
    let mut rig = Rig::new()?;
    let mut provider = Provider::start().await?;
    let outcome = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(60), async {
        let base = rig.directory.path().to_path_buf();
        let boot = bootstrap(&base, provider.url.clone(), false).await?;
        attach(&mut rig, &boot).await?;
        let client = rig.client.as_ref().unwrap();
        let model = model_options(client, &provider.url, false, json!({"vision":true})).await?;
        let room = create_room(client, &base).await?;
        let first = create(client, &base, &model, None).await?;
        let second = create(client, &base, &model, None).await?;
        let mut png = std::io::Cursor::new(Vec::new());
        image::RgbImage::from_pixel(1, 1, image::Rgb([255, 0, 0]))
            .write_to(&mut png, image::ImageFormat::Png)?;
        let image_url = format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png.get_ref()));
        let file = immutable_bytes("red.png".into(), png.into_inner());
        let upload = call_with_attachments(client, "agent", "uploadAttachment", json!({
            "sessionId":room,"name":"red.png","bytes":file.bytes(),"digest":file.metadata()["digest"]
        }), Attachments::from([("file".into(), file)])).await?;
        assert_eq!(upload["kind"], "uploaded", "{upload}");

        let committed = rig.completion_gate.arm("send");
        let pending = prepared(client, "send", json!({
            "sessionId":room,"message":"Review the red marker.",
            "attachments":[upload["attachment"]["id"]],
            "mentions":[first["id"],second["id"],first["id"],"missing-session"]
        })).await?;
        let reference = pending.reference().ok_or("send reference missing")?.clone();
        let caller = tokio::spawn(confirm(pending));
        let release = committed.await?;
        caller.abort();
        assert!(caller.await.unwrap_err().is_cancelled());
        release.send(()).map_err(|_| "commit gate lost")?;
        let receipt = recovered(&rig, &reference).await?;
        assert_eq!(receipt["kind"], "posted", "{receipt}");
        let deliveries = receipt["deliveries"].as_array().unwrap();
        assert_eq!(deliveries.len(), 3);
        for (delivery, recipient) in deliveries.iter().zip([&first["id"], &second["id"]]) {
            assert_eq!(delivery["kind"], "accepted");
            assert_eq!(&delivery["sessionId"], recipient);
        }
        assert_eq!(deliveries[2]["kind"], "rejected");
        assert_eq!(deliveries[2]["sessionId"], "missing-session");
        for _ in 0..2 {
            let (request, respond) = provider.next().await?;
            let input = request["messages"].to_string();
            assert!(input.contains("Review the red marker."), "{input}");
            assert!(input.contains(&image_url), "image changed or missing: {input}");
            assert!(input.contains(&room) && input.contains(receipt["messageId"].as_str().unwrap()), "return address missing: {input}");
            respond.send(completion(json!({"role":"assistant","content":"Reviewed."}), "stop"))
                .map_err(|_| "model response lost")?;
        }
        for delivery in &deliveries[..2] {
            quiescent_message(client, delivery["sessionId"].as_str().unwrap(), &delivery["messageId"]).await?;
        }
        reopen(&mut rig, &boot).await?;
        assert_eq!(recovered(&rig, &reference).await?, receipt);
        let client = rig.client.as_ref().unwrap();
        let history = call(client, "agent", "history", json!({"sessionId":room,"position":{"kind":"tail"}})).await?;
        let posts = history["page"]["items"].as_array().unwrap();
        assert_eq!(posts.len(), 1, "the interrupted send was lost or duplicated");
        assert_eq!(posts[0]["id"], receipt["messageId"]);
        assert_eq!(posts[0]["content"]["text"], "Review the red marker.");
        assert_eq!(posts[0]["content"]["attachments"][0]["name"], "red.png");
        assert_eq!(posts[0]["deliveries"], receipt["deliveries"]);
        for delivery in &deliveries[..2] {
            let observed = call(client, "agent", "observe", json!({"sessionId":delivery["sessionId"]})).await?;
            assert_eq!(observed["session"]["activity"], "idle");
        }
        let observed = call(client, "agent", "observe", json!({"sessionId":room})).await?;
        assert_eq!(observed["run"], Value::Null);
        assert!(provider.requests.try_recv().is_err(), "delivery or Room started another model request");
        Ok::<_, Box<dyn Error + Send + Sync>>(())
    })).catch_unwind().await;
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(30), rig.finish()).await?,
        Vec::<String>::new()
    );
    match outcome {
        Ok(result) => result??,
        Err(panic) => std::panic::resume_unwind(panic),
    }
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn room_history_pages_and_read_position_survive_new_posts_and_reopen() -> TestResult<()> {
    let mut rig = Rig::new()?;
    let provider = Provider::start().await?;
    let outcome = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(60), async {
        let base = rig.directory.path().to_path_buf();
        let boot = bootstrap(&base, provider.url.clone(), false).await?;
        attach(&mut rig, &boot).await?;
        let client = rig.client.as_ref().unwrap();
        let room = create_room(client, &base).await?;
        for n in 0..50 {
            let sent = call(
                client,
                "agent",
                "send",
                json!({"sessionId":room,"message":format!("Review note {n}")}),
            )
            .await?;
            assert_eq!(sent["kind"], "posted", "{sent}");
        }
        let tail = call(
            client,
            "agent",
            "history",
            json!({"sessionId":room,"position":{"kind":"tail"}}),
        )
        .await?;
        let items = tail["page"]["items"].as_array().unwrap();
        assert!(
            tail["page"]["before"].is_string(),
            "fixture must span pages"
        );
        let newest = &items.last().unwrap()["id"];
        let late = call(
            client,
            "agent",
            "send",
            json!({"sessionId":room,"message":"A late reply","replyTo":newest}),
        )
        .await?;
        let older = call(
            client,
            "agent",
            "history",
            json!({
                "sessionId":room,"through":tail["page"]["through"],
                "position":{"kind":"before_message","messageId":tail["page"]["before"]}
            }),
        )
        .await?;
        assert_eq!(
            older["page"]["items"]
                .as_array()
                .unwrap()
                .iter()
                .chain(items)
                .map(|item| item["content"]["text"].as_str().unwrap())
                .collect::<Vec<_>>(),
            (0..50)
                .map(|n| format!("Review note {n}"))
                .collect::<Vec<_>>(),
            "paging across a new post lost, duplicated or reordered history"
        );
        let frozen = call(
            client,
            "agent",
            "history",
            json!({"sessionId":room,"through":tail["page"]["through"],"position":{"kind":"tail"}}),
        )
        .await?;
        assert_eq!(frozen, tail, "new posts changed the reader's frozen page");
        let read = call(
            client,
            "agent",
            "markRead",
            json!({"sessionId":room,"messageId":newest}),
        )
        .await?;
        assert_eq!(
            read["session"]["hasUnread"], true,
            "reading an older tail hid a new reply"
        );
        let read = call(
            client,
            "agent",
            "markRead",
            json!({"sessionId":room,"messageId":late["messageId"]}),
        )
        .await?;
        assert_eq!(read["session"]["hasUnread"], false);

        reopen(&mut rig, &boot).await?;
        let client = rig.client.as_ref().unwrap();
        let listed = call(
            client,
            "agent",
            "list",
            json!({"kind":"room","filter":"all","position":{"kind":"start"}}),
        )
        .await?;
        assert_eq!(listed["sessions"].as_array().unwrap().len(), 1);
        assert_eq!(listed["sessions"][0]["id"], room);
        assert_eq!(listed["sessions"][0]["hasUnread"], false);
        let next = call(
            client,
            "agent",
            "history",
            json!({"sessionId":room,"position":{"kind":"after_message","messageId":newest}}),
        )
        .await?;
        let replies = next["page"]["items"].as_array().unwrap();
        assert_eq!(replies.len(), 1);
        assert_eq!(replies[0]["content"]["text"], "A late reply");
        assert_eq!(&replies[0]["replyTo"], newest);
        let sent = call(
            client,
            "agent",
            "send",
            json!({"sessionId":room,"message":"New after restart"}),
        )
        .await?;
        assert_eq!(sent["kind"], "posted");
        let observed = call(client, "agent", "observe", json!({"sessionId":room})).await?;
        assert_eq!(observed["session"]["hasUnread"], true);
        Ok::<_, Box<dyn Error + Send + Sync>>(())
    }))
    .catch_unwind()
    .await;
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(30), rig.finish()).await?,
        Vec::<String>::new()
    );
    match outcome {
        Ok(result) => result??,
        Err(panic) => std::panic::resume_unwind(panic),
    }
    Ok(())
}
