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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn room_overhaul_roster_context_attachments_reactions_pins_edits_search_and_guards()
-> TestResult<()> {
    use maka_capabilities::call::immutable_bytes;
    let mut rig = Rig::new()?;
    let mut provider = Provider::start().await?;
    let outcome = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(90), async {
        let base = rig.directory.path().to_path_buf();
        std::fs::create_dir_all(base.join("workspace"))?;
        let tools = product_agent_tools(true).await?;
        let boot = bootstrap_with(&base, provider.url.clone(), |config| {
            config["tools"] = tools;
            config["toolDiscovery"] = json!(false);
        })
        .await?;
        attach(&mut rig, &boot).await?;
        let client = rig.client.as_ref().unwrap();
        let model = model_options(client, &provider.url, false, json!({"vision":true})).await?;

        let room = create_room(client, &base).await?;
        let alice = create(client, &base, &model, None).await?;
        let bob = create(client, &base, &model, None).await?;
        let alice_id = alice["id"].as_str().unwrap().to_owned();
        let bob_id = bob["id"].as_str().unwrap().to_owned();

        // A worker explicitly restricted to Read-only tools cannot reply in a Room.
        let mut ro_backend = model.clone();
        ro_backend["kind"] = json!("model");
        let readonly_res = call(
            client,
            "agent",
            "create",
            json!({
                "kind": "agent",
                "title": "Readonly observer",
                "automaticTitle": false,
                "labels": [],
                "tools": ["Read"],
                "workspace": {"kind": "directory", "path": base.join("workspace")},
                "backend": ro_backend
            }),
        )
        .await?;
        assert_eq!(readonly_res["kind"], "created", "{readonly_res}");
        let readonly_id = readonly_res["session"]["id"].as_str().unwrap().to_owned();

        // 1. Set topic & manage members explicitly.
        let topic_res = call(
            client,
            "agent",
            "roomManage",
            json!({
                "sessionId": room,
                "action": {"kind": "set_topic", "topic": "Ship v2 safely"}
            }),
        )
        .await?;
        assert_eq!(topic_res["kind"], "topic_updated");
        assert_eq!(topic_res["topic"], "Ship v2 safely");

        let add_res = call(
            client,
            "agent",
            "roomManage",
            json!({
                "sessionId": room,
                "action": {"kind": "add_members", "memberSessionIds": [alice_id, bob_id]}
            }),
        )
        .await?;
        assert_eq!(add_res["kind"], "members_added");

        // 2. Upload an image attachment on the Room and post a background note with it.
        let mut png = std::io::Cursor::new(Vec::new());
        image::RgbImage::from_pixel(2, 2, image::Rgb([0, 128, 255]))
            .write_to(&mut png, image::ImageFormat::Png)?;
        let file = immutable_bytes("diagram.png".into(), png.into_inner());
        let upload = call_with_attachments(
            client,
            "agent",
            "uploadAttachment",
            json!({
                "sessionId": room,
                "name": "diagram.png",
                "bytes": file.bytes(),
                "digest": file.metadata()["digest"]
            }),
            Attachments::from([("file".into(), file)]),
        )
        .await?;
        let room_att_id = upload["attachment"]["id"].as_str().unwrap().to_owned();

        let seed = call(
            client,
            "agent",
            "send",
            json!({
                "sessionId": room,
                "message": "架构图已上传，请留意缓存边界",
                "attachments": [room_att_id]
            }),
        )
        .await?;
        assert_eq!(seed["kind"], "posted");
        let seed_id = seed["messageId"].as_str().unwrap().to_owned();

        // Pin & react to the seed message.
        let pin = call(
            client,
            "agent",
            "roomManage",
            json!({"sessionId": room, "action": {"kind": "pin", "messageId": seed_id}}),
        )
        .await?;
        assert_eq!(pin["pinned"], true);
        let react = call(
            client,
            "agent",
            "roomManage",
            json!({"sessionId": room, "action": {"kind": "react", "messageId": seed_id, "emoji": "📌"}}),
        )
        .await?;
        assert_eq!(react["present"], true);

        // 3. Post with inline [@Alice] & [@Bob] + restricted readonly target; verify inline extraction + pre-flight tool guard.
        let dispatch_text = format!(
            "请 [@Alice](maka://session/{alice_id}) 看前端，[@Bob](maka://session/{bob_id}) 看后端，还有 [@RO](maka://session/{readonly_id})"
        );
        let posted = call(
            client,
            "agent",
            "send",
            json!({
                "sessionId": room,
                "replyTo": seed_id,
                "message": dispatch_text
            }),
        )
        .await?;
        assert_eq!(posted["kind"], "posted");
        let dispatch_id = posted["messageId"].as_str().unwrap().to_owned();
        let deliveries = posted["deliveries"].as_array().unwrap();
        assert_eq!(deliveries.len(), 3, "{posted}");
        assert_eq!(deliveries[0]["kind"], "accepted");
        assert_eq!(deliveries[1]["kind"], "accepted");
        assert_eq!(deliveries[2]["kind"], "rejected");
        assert_eq!(deliveries[2]["reason"], "agent_room_reply_tool_unavailable");

        // 4. Both Alice & Bob wake up with <room_context> containing topic, co-mentions, pinned note,
        //    and the Room attachment URI.
        let (req1, resp1) = provider.next().await?;
        let (req2, resp2) = provider.next().await?;
        let ((alice_req, alice_resp), (_bob_req, bob_resp)) =
            if req1["messages"].to_string().contains(&format!("{alice_id}) (you)")) {
                ((req1, resp1), (req2, resp2))
            } else {
                ((req2, resp2), (req1, resp1))
            };
        let alice_prompt = alice_req["messages"]
            .as_array()
            .unwrap()
            .last()
            .unwrap()["content"]
            .to_string();
        assert!(alice_prompt.contains("Ship v2 safely"), "{alice_prompt}");
        assert!(alice_prompt.contains(&bob_id), "{alice_prompt}");
        assert!(alice_prompt.contains("缓存边界"), "{alice_prompt}");
        let att_uri = format!("maka://session/{room}/attachments/{room_att_id}");
        assert!(alice_prompt.contains(&att_uri), "{alice_prompt}");

        // Bob acknowledges via SessionManage(room_react) without posting a prose reply ->
        // commits atomically and resolves deliveryState to "reacted" (NOT "silent")!
        bob_resp
            .send(completion(
                json!({
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [{
                        "index": 0,
                        "id": "call_bob_react",
                        "type": "function",
                        "function": {
                            "name": "SessionManage",
                            "arguments": json!({
                                "sessionId": room,
                                "action": {
                                    "kind": "room_react",
                                    "messageId": dispatch_id,
                                    "emoji": "👀"
                                }
                            })
                            .to_string()
                        }
                    }]
                }),
                "tool_calls",
            ))
            .map_err(|_| "bob react tool call lost")?;
        let (bob_step2, bob_resp2) = provider.next().await?;
        let bob_tool_res: Value = serde_json::from_str(
            bob_step2["messages"]
                .as_array()
                .unwrap()
                .last()
                .unwrap()["content"]
                .as_str()
                .unwrap(),
        )?;
        assert_eq!(bob_tool_res["kind"], "room_updated", "{bob_tool_res}");
        assert_eq!(bob_tool_res["result"]["kind"], "reaction_updated", "{bob_tool_res}");
        assert_eq!(bob_tool_res["result"]["present"], true, "{bob_tool_res}");
        bob_resp2
            .send(completion(
                json!({"role": "assistant", "content": "Reacted."}),
                "stop",
            ))
            .map_err(|_| "bob final lost")?;
        quiescent_message(client, &bob_id, &deliveries[1]["messageId"]).await?;

        // Alice first reads the Room attachment via Read({ path: "maka://session/<room>/attachments/<id>" })!
        alice_resp
            .send(completion(
                json!({
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [{
                        "index": 0,
                        "id": "call_read_att",
                        "type": "function",
                        "function": {
                            "name": "Read",
                            "arguments": json!({"path": att_uri}).to_string()
                        }
                    }]
                }),
                "tool_calls",
            ))
            .map_err(|_| "alice read att lost")?;
        let (alice_step2, alice_resp2) = provider.next().await?;
        let read_tool_reply = alice_step2["messages"]
            .as_array()
            .unwrap()
            .last()
            .unwrap()["content"]
            .to_string();
        assert!(
            read_tool_reply.contains("data:image/png;base64,"),
            "Room attachment Read tool result should return real PNG image bytes: {read_tool_reply}"
        );

        // Alice replies in the Room (also testing self-mention rejection!).
        alice_resp2
            .send(completion(
                json!({
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [{
                        "index": 0,
                        "id": "call_reply",
                        "type": "function",
                        "function": {
                            "name": "SessionSend",
                            "arguments": json!({
                                "sessionId": room,
                                "replyTo": dispatch_id,
                                "message": "前端部分已确认",
                                "mentions": [alice_id]
                            })
                            .to_string()
                        }
                    }]
                }),
                "tool_calls",
            ))
            .map_err(|_| "alice send lost")?;
        let (alice_after, alice_after_resp) = provider.next().await?;
        let tool_res_str = alice_after["messages"]
            .as_array()
            .unwrap()
            .last()
            .unwrap()["content"]
            .as_str()
            .unwrap();
        let tool_res: Value = serde_json::from_str(tool_res_str)?;
        assert_eq!(tool_res["kind"], "posted", "{tool_res}");
        assert_eq!(tool_res["deliveries"][0]["kind"], "rejected");
        assert_eq!(
            tool_res["deliveries"][0]["reason"],
            "agent_room_self_mention"
        );
        alice_after_resp
            .send(completion(
                json!({"role": "assistant", "content": "Done."}),
                "stop",
            ))
            .map_err(|_| "alice final lost")?;
        quiescent_message(client, &alice_id, &deliveries[0]["messageId"]).await?;

        // 5. Inspect Room history: verify derived deliveryStates (alice=replied, bob=reacted, readonly=rejected),
        //    Bob's 👀 reaction on dispatch_id, and plain links not waking Agents.
        let history = call(
            client,
            "agent",
            "history",
            json!({"sessionId": room, "position": {"kind": "around_message", "messageId": dispatch_id}}),
        )
        .await?;
        let items = history["page"]["items"].as_array().unwrap();
        let dispatch_row = items
            .iter()
            .find(|m| m["id"] == dispatch_id)
            .expect("dispatch message present in around window");
        let states = dispatch_row["deliveryStates"].as_array().unwrap();
        assert_eq!(states.len(), 3, "{dispatch_row}");
        assert_eq!(states[0]["kind"], "replied", "{dispatch_row}");
        assert_eq!(states[1]["kind"], "reacted", "{dispatch_row}");
        assert_eq!(states[1]["emoji"], "👀", "{dispatch_row}");
        assert_eq!(states[2]["kind"], "rejected", "{dispatch_row}");
        let reactions = dispatch_row["reactions"].as_array().unwrap();
        assert!(
            reactions.iter().any(|r| {
                r["emoji"] == "👀"
                    && r["actors"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|a| a["kind"] == "session" && a["sessionId"] == bob_id)
            }),
            "Bob's 👀 reaction should be visible on dispatch_id: {dispatch_row}"
        );

        // Plain [Details](maka://session/<id>) link (without '@') must NOT wake Agents.
        let plain_link_post = call(
            client,
            "agent",
            "send",
            json!({
                "sessionId": room,
                "message": format!("Reference only: [Alice logs](maka://session/{alice_id})")
            }),
        )
        .await?;
        assert_eq!(plain_link_post["kind"], "posted");
        assert!(
            plain_link_post["deliveries"].as_array().unwrap().is_empty(),
            "Plain markdown link without '@' must not wake Agent: {plain_link_post}"
        );
        assert!(
            !history["page"]["participants"].as_array().unwrap().is_empty(),
            "{history}"
        );

        // 6. Test full-text search (both 2-char CJK fallback and >=3-char trigram FTS5).
        let cjk_hits = call(
            client,
            "agent",
            "roomSearch",
            json!({"sessionId": room, "query": "前端"}),
        )
        .await?;
        assert!(
            !cjk_hits["items"].as_array().unwrap().is_empty(),
            "{cjk_hits}"
        );
        let trigram_hits = call(
            client,
            "agent",
            "roomSearch",
            json!({"sessionId": room, "query": "缓存边界"}),
        )
        .await?;
        assert_eq!(trigram_hits["items"].as_array().unwrap().len(), 1);

        // 7. Edit & soft-delete a message, verifying reply FK integrity and search exclusion.
        let edited = call(
            client,
            "agent",
            "roomManage",
            json!({
                "sessionId": room,
                "action": {"kind": "edit_message", "messageId": seed_id, "text": "架构图已更新 v2"}
            }),
        )
        .await?;
        assert_eq!(edited["kind"], "message_updated");
        assert!(edited["message"]["editedAt"].is_u64());

        let deleted = call(
            client,
            "agent",
            "roomManage",
            json!({
                "sessionId": room,
                "action": {"kind": "delete_message", "messageId": seed_id}
            }),
        )
        .await?;
        assert!(deleted["message"]["deletedAt"].is_u64());
        let after_delete_search = call(
            client,
            "agent",
            "roomSearch",
            json!({"sessionId": room, "query": "架构图已更新"}),
        )
        .await?;
        assert_eq!(after_delete_search["items"].as_array().unwrap().len(), 0);

        // 8. Verify SessionRead with room overview.
        let sr = call(
            client,
            "agent",
            "sessionRead",
            json!({"sessionId": room, "position": "tail"}),
        )
        .await?;
        assert_eq!(sr["room"]["topic"], "Ship v2 safely", "{sr}");
        assert!(
            !sr["room"]["members"].as_array().unwrap().is_empty(),
            "{sr}"
        );

        // 9. Ensure backend on Room send is rejected cleanly.
        let mut bad_backend = model.clone();
        bad_backend["kind"] = json!("model");
        let bad = call(
            client,
            "agent",
            "send",
            json!({
                "sessionId": room,
                "message": "should reject backend",
                "backend": bad_backend
            }),
        )
        .await;
        assert!(
            bad.is_err() && format!("{bad:?}").contains("agent_room_has_no_backend"),
            "expected agent_room_has_no_backend, got: {bad:?}"
        );

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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn room_hop_limit_circuit_breaker_and_cross_session_attachment_forwarding() -> TestResult<()>
{
    use maka_capabilities::call::immutable_bytes;
    let mut rig = Rig::new()?;
    let mut provider = Provider::start().await?;
    let outcome = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(90), async {
        let base = rig.directory.path().to_path_buf();
        std::fs::create_dir_all(base.join("workspace"))?;
        let tools = product_agent_tools(true).await?;
        let boot = bootstrap_with(&base, provider.url.clone(), |config| {
            config["tools"] = tools;
            config["toolDiscovery"] = json!(false);
        })
        .await?;
        attach(&mut rig, &boot).await?;
        let client = rig.client.as_ref().unwrap();
        let model = model_options(client, &provider.url, false, json!({"vision":true})).await?;

        let room = create_room(client, &base).await?;
        let alice = create(client, &base, &model, None).await?;
        let bob = create(client, &base, &model, None).await?;
        let alice_id = alice["id"].as_str().unwrap().to_owned();
        let bob_id = bob["id"].as_str().unwrap().to_owned();

        // 1. Cross-session attachment forwarding: upload an image on Alice, have Alice post it
        //    into the Room mentioning Bob, and verify Bob can Read the Room-copied attachment.
        let mut png = std::io::Cursor::new(Vec::new());
        image::RgbImage::from_pixel(2, 2, image::Rgb([255, 64, 0]))
            .write_to(&mut png, image::ImageFormat::Png)?;
        let file = immutable_bytes("evidence.png".into(), png.into_inner());
        let upload = call_with_attachments(
            client,
            "agent",
            "uploadAttachment",
            json!({
                "sessionId": alice_id,
                "name": "evidence.png",
                "bytes": file.bytes(),
                "digest": file.metadata()["digest"]
            }),
            Attachments::from([("file".into(), file)]),
        )
        .await?;
        let alice_att_id = upload["attachment"]["id"].as_str().unwrap().to_owned();

        let seed = call(
            client,
            "agent",
            "send",
            json!({
                "sessionId": alice_id,
                "message": "Forward this attachment to the room",
                "attachments": [alice_att_id]
            }),
        )
        .await?;
        assert_eq!(seed["kind"], "queued", "{seed}");

        let (_, alice_req) = provider.next().await?;
        alice_req
            .send(completion(
                json!({
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [{
                        "index": 0,
                        "id": "call_forward_att",
                        "type": "function",
                        "function": {
                            "name": "SessionSend",
                            "arguments": json!({
                                "sessionId": room,
                                "message": "Sharing screenshot from my private session",
                                "attachments": [alice_att_id],
                                "mentions": [bob_id]
                            })
                            .to_string()
                        }
                    }]
                }),
                "tool_calls",
            ))
            .map_err(|_| "alice forward lost")?;

        let mut alice_done = false;
        let mut bob_done = false;
        let mut bob_msg_id: Option<Value> = None;
        let mut room_att_uri: Option<String> = None;
        while !alice_done || !bob_done {
            let (req, resp) = provider.next().await?;
            let msgs = req["messages"].as_array().unwrap();
            let last = msgs.last().unwrap();
            let is_alice_tool =
                last["role"] == "tool" && last["tool_call_id"] == "call_forward_att";
            let is_bob_read_tool = msgs
                .iter()
                .any(|m| m["role"] == "tool" && m["tool_call_id"] == "call_bob_read_att");
            if is_alice_tool {
                let tool_json: Value = serde_json::from_str(last["content"].as_str().unwrap())?;
                assert_eq!(tool_json["kind"], "posted", "{tool_json}");
                assert_eq!(
                    tool_json["deliveries"][0]["kind"], "accepted",
                    "{tool_json}"
                );
                bob_msg_id = Some(tool_json["deliveries"][0]["messageId"].clone());
                resp.send(completion(
                    json!({"role": "assistant", "content": "Forwarded."}),
                    "stop",
                ))
                .map_err(|_| "alice done lost")?;
                alice_done = true;
            } else if is_bob_read_tool && !bob_done {
                let content_str = last["content"].to_string();
                assert!(
                    content_str.contains("data:image/png;base64,"),
                    "Bob Read tool result should return copied PNG bytes: {content_str}"
                );
                resp.send(completion(
                    json!({"role": "assistant", "content": "Seen."}),
                    "stop",
                ))
                .map_err(|_| "bob done lost")?;
                bob_done = true;
            } else if last["role"] == "user" && !bob_done {
                let body = last["content"].to_string();
                assert!(
                    body.contains("evidence.png") && body.contains("data:image/png;base64,"),
                    "Bob should receive forwarded image inline from Alice private session: {body}"
                );
                let sr = call(
                    client,
                    "agent",
                    "sessionRead",
                    json!({"sessionId": room, "position": "tail"}),
                )
                .await?;
                let uri = sr["transcript"]["items"][0]["attachments"][0]["resourcePath"]
                    .as_str()
                    .expect("Room post should expose resourcePath for copied attachment")
                    .to_owned();
                assert!(
                    uri.starts_with(&format!("maka://session/{room}/attachments/")),
                    "{uri}"
                );
                room_att_uri = Some(uri.clone());
                resp.send(completion(
                    json!({
                        "role": "assistant",
                        "content": "",
                        "tool_calls": [{
                            "index": 0,
                            "id": "call_bob_read_att",
                            "type": "function",
                            "function": {
                                "name": "Read",
                                "arguments": json!({ "path": uri }).to_string()
                            }
                        }]
                    }),
                    "tool_calls",
                ))
                .map_err(|_| "bob read lost")?;
            } else {
                return Err(format!("unexpected provider request: {req}").into());
            }
        }
        assert!(room_att_uri.is_some());
        quiescent_message(client, &alice_id, &seed["messageId"]).await?;
        quiescent_message(client, &bob_id, bob_msg_id.as_ref().unwrap()).await?;

        // 2. Hop-limit circuit breaker: 6 consecutive Agent-to-Agent hops succeed; 7th is rejected.
        let human_start = call(
            client,
            "agent",
            "send",
            json!({
                "sessionId": room,
                "message": "Start ping pong",
                "mentions": [alice_id]
            }),
        )
        .await?;
        assert_eq!(human_start["kind"], "posted", "{human_start}");
        assert_eq!(human_start["deliveries"][0]["kind"], "accepted");

        let mut active_sender = alice_id.clone();
        let mut active_target = bob_id.clone();
        let mut carried_req = None;
        for hop in 1..=7u8 {
            let (_, req_resp) = match carried_req.take() {
                Some(pair) => pair,
                None => provider.next().await?,
            };
            let call_id = format!("call_hop_{hop}");
            req_resp
                .send(completion(
                    json!({
                        "role": "assistant",
                        "content": "",
                        "tool_calls": [{
                            "index": 0,
                            "id": call_id,
                            "type": "function",
                            "function": {
                                "name": "SessionSend",
                                "arguments": json!({
                                    "sessionId": room,
                                    "message": format!("hop {hop}"),
                                    "mentions": [active_target]
                                })
                                .to_string()
                            }
                        }]
                    }),
                    "tool_calls",
                ))
                .map_err(|_| "hop tool call lost")?;

            loop {
                let (req, resp) = provider.next().await?;
                let last = req["messages"].as_array().unwrap().last().unwrap();
                if last["role"] == "tool" && last["tool_call_id"] == call_id {
                    let res: Value = serde_json::from_str(last["content"].as_str().unwrap())?;
                    assert_eq!(res["kind"], "posted", "hop {hop}: {res}");
                    if hop <= 6 {
                        assert_eq!(
                            res["deliveries"][0]["kind"], "accepted",
                            "hop {hop} should be accepted: {res}"
                        );
                    } else {
                        assert_eq!(
                            res["deliveries"][0]["kind"], "rejected",
                            "hop 7 should be circuit-broken: {res}"
                        );
                        assert_eq!(
                            res["deliveries"][0]["reason"], "agent_room_hop_limit_reached",
                            "hop 7 reason: {res}"
                        );
                    }
                    resp.send(completion(
                        json!({"role": "assistant", "content": format!("sent hop {hop}")}),
                        "stop",
                    ))
                    .map_err(|_| "hop finish lost")?;
                    break;
                } else {
                    assert!(
                        hop <= 6,
                        "hop 7 target must NOT wake up after circuit breaker: {req}"
                    );
                    carried_req = Some((req, resp));
                }
            }
            std::mem::swap(&mut active_sender, &mut active_target);
        }

        // 3. A human mention resets the hop counter back to 0 so Agents can collaborate again.
        let human_reset = call(
            client,
            "agent",
            "send",
            json!({
                "sessionId": room,
                "message": "Human reset — please continue",
                "mentions": [alice_id]
            }),
        )
        .await?;
        assert_eq!(human_reset["deliveries"][0]["kind"], "accepted");
        let (_, reset_resp) = provider.next().await?;
        reset_resp
            .send(completion(
                json!({
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [{
                        "index": 0,
                        "id": "call_after_reset",
                        "type": "function",
                        "function": {
                            "name": "SessionSend",
                            "arguments": json!({
                                "sessionId": room,
                                "message": "fresh hop 1 after human reset",
                                "mentions": [bob_id]
                            })
                            .to_string()
                        }
                    }]
                }),
                "tool_calls",
            ))
            .map_err(|_| "reset call lost")?;

        let mut reset_alice_done = false;
        let mut reset_bob_done = false;
        let mut reset_bob_msg: Option<Value> = None;
        while !reset_alice_done || !reset_bob_done {
            let (req, resp) = provider.next().await?;
            let last = req["messages"].as_array().unwrap().last().unwrap();
            if last["role"] == "tool" && last["tool_call_id"] == "call_after_reset" {
                let res: Value = serde_json::from_str(last["content"].as_str().unwrap())?;
                assert_eq!(res["deliveries"][0]["kind"], "accepted", "{res}");
                reset_bob_msg = Some(res["deliveries"][0]["messageId"].clone());
                resp.send(completion(
                    json!({"role": "assistant", "content": "Reset ok."}),
                    "stop",
                ))
                .map_err(|_| "reset alice finish lost")?;
                reset_alice_done = true;
            } else if last["role"] == "user" && !reset_bob_done {
                resp.send(completion(
                    json!({"role": "assistant", "content": "Bob awake after reset."}),
                    "stop",
                ))
                .map_err(|_| "reset bob finish lost")?;
                reset_bob_done = true;
            }
        }
        quiescent_message(
            client,
            &alice_id,
            &human_reset["deliveries"][0]["messageId"],
        )
        .await?;
        quiescent_message(client, &bob_id, reset_bob_msg.as_ref().unwrap()).await?;

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
