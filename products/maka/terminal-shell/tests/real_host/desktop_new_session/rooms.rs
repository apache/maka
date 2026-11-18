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

async fn room_messages(desktop: &Desktop, room: &str, count: usize) -> Vec<Value> {
    desktop
        .wait("Room posts did not arrive", async {
            loop {
                let history = desktop
                    .client
                    .query(
                        "agent",
                        "history",
                        json!({
                            "sessionId":room,"position":{"kind":"tail"}
                        }),
                    )
                    .await
                    .unwrap();
                let posts = history["page"]["items"].as_array().unwrap();
                if posts.len() >= count {
                    return posts.clone();
                }
                tokio::task::yield_now().await;
            }
        })
        .await
}

async fn focus_room(desktop: &Desktop) {
    let mention = desktop.control("Mention a session").await;
    desktop.press_at(point(mention.center().x, mention.top() - px(32.)));
    desktop.target_after(None).await;
}

async fn reply_at(desktop: &Desktop, position: nsh_terminal::Point<nsh_terminal::Pixels>) {
    let inline = desktop.controls("Reply to message");
    desktop.click_at(position, MouseButton::Right);
    let menu = desktop
        .until("message context menu did not offer Reply", || {
            desktop
                .controls("Reply to message")
                .into_iter()
                .find(|bounds| !inline.contains(bounds))
        })
        .await;
    desktop.press_at(menu.center());
}

pub(super) async fn desktop_composer_references_a_room_without_posting() {
    let mut fixture = Fixture::open_with_configuration(
        Options {
            session_tools: true,
            ..Options::default()
        },
        |config, root| {
            config["agent"]["toolDiscovery"] = json!(false);
            std::fs::write(root.join("workspace/Windows-CI.md"), "Runner checklist").unwrap();
        },
    )
    .await;
    let client = fixture.client().await;
    let workspace = json!({"kind":"session","sessionId":fixture.session});
    let room = mutate(
        &client,
        "create",
        json!({"kind":"room","title":"环境信息共享群","labels":[],"workspace":workspace}),
    )
    .await;
    let room = room["session"]["id"].as_str().unwrap();
    let context = "Windows CI uses a dedicated VM.";
    let post = mutate(&client, "send", json!({"sessionId":room,"message":context})).await;
    assert_eq!(post["kind"], "posted", "{post}");
    let backend = json!({
        "kind":"model",
        "connectionId":fixture.selection["connectionId"],
        "modelId":fixture.selection["modelId"]
    });
    let conversation = mutate(
        &client,
        "create",
        json!({"title":"review json-render","labels":[],"workspace":workspace,"backend":backend}),
    )
    .await;
    let conversation = conversation["session"]["id"].as_str().unwrap();
    let other = mutate(
        &client,
        "create",
        json!({"title":"Windows CI 验证","labels":[],"workspace":workspace,"backend":backend}),
    )
    .await;
    assert_eq!(other["kind"], "created", "{other}");
    client.close().await.unwrap();
    let desktop = Desktop::open_at(
        &fixture,
        &fixture.address,
        size(
            nsh_terminal::DevicePixels(1280),
            nsh_terminal::DevicePixels(800),
        ),
        nsh_core::platform::Appearance::Dark,
    )
    .await;
    let before = room_messages(&desktop, room, 1).await;
    assert_eq!(before.len(), 1);
    desktop.press("Open conversation review json-render").await;
    desktop.press("Focus message composer").await;
    desktop.paste("Read context from @").await;
    let file_row = desktop.control("Windows-CI.md").await;
    let room_row = desktop.control("环境信息共享群").await;
    let agent_row = desktop.control("Windows CI 验证").await;
    assert!(room_row.top() < agent_row.top() && agent_row.top() < file_row.top());
    desktop.artifact("room-reference-picker");
    desktop.press("环境信息共享群").await;
    let reference = format!("Read context from [#环境信息共享群](maka://session/{room}) ");
    desktop.expect_text(&reference).await;
    desktop.key("right", false);
    desktop.paste("and @Windows-CI").await;
    desktop.press("Windows-CI.md").await;
    let body = format!("{reference}and @Windows-CI.md");
    desktop.expect_text(&format!("{body} ")).await;
    desktop.key("right", false);
    desktop.artifact("room-reference-draft");
    assert_eq!(fixture.request_count.load(Ordering::SeqCst), 0);
    desktop.press("Send message").await;
    let request = desktop.request(&mut fixture).await;
    let message = request.body["messages"].as_array().unwrap().last().unwrap();
    assert_eq!(message["role"], "user");
    let user_content = message["content"].as_str().unwrap();
    assert!(user_content.starts_with(&body), "{user_content}");
    assert!(
        user_content.contains("<session_references>"),
        "{user_content}"
    );
    let history_tool = request.body["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|tool| tool["function"]["name"] == "SessionRead")
        .expect("the agent can use SessionRead for this reference");
    assert!(
        history_tool["function"]["description"]
            .as_str()
            .unwrap()
            .contains("[#Room](maka://session/<id>)")
    );
    request
        .tool_call("SessionRead", json!({"sessionId":room,"position":"tail"}))
        .await;
    let mut request = desktop.request(&mut fixture).await;
    let result = request.body["messages"].as_array().unwrap().last().unwrap();
    assert_eq!(result["role"], "tool");
    let result: Value = serde_json::from_str(result["content"].as_str().unwrap()).unwrap();
    assert_eq!(result["transcript"]["kind"], "room", "{result}");
    assert_eq!(result["transcript"]["items"][0]["id"], before[0]["id"]);
    assert_eq!(result["transcript"]["items"][0]["text"], context);
    request.delta(context).await;
    desktop
        .wait("the reply did not finish", request.finish())
        .await;
    desktop
        .wait(
            "the conversation did not settle",
            fixture.idle(&desktop.client, conversation),
        )
        .await;
    assert_eq!(room_messages(&desktop, room, 1).await, before);
    desktop.press("#环境信息共享群").await;
    desktop.control("Close side pane").await;
    desktop.control("Mention a session").await;
    desktop.artifact("room-reference-context-beside");
    desktop.close().await;
    fixture.finish().await;
}

pub(super) async fn desktop_room_reply_wakes_an_agent_without_mixing_drafts() {
    let mut fixture = Fixture::open_with_configuration(
        Options {
            session_tools: true,
            ..Options::default()
        },
        |config, _| config["agent"]["toolDiscovery"] = json!(false),
    )
    .await;
    let client = fixture.client().await;
    let reviewer = mutate(
        &client,
        "create",
        json!({
            "title":"Room reviewer","labels":[],
            "workspace":{"kind":"session","sessionId":fixture.session},
            "backend":{
                "kind":"model",
                "connectionId":fixture.selection["connectionId"],
                "modelId":fixture.selection["modelId"]
            }
        }),
    )
    .await;
    assert_eq!(reviewer["kind"], "created", "{reviewer}");
    fixture.session = reviewer["session"]["id"].as_str().unwrap().into();
    client.close().await.unwrap();
    let mut desktop = Desktop::open_at(
        &fixture,
        &fixture.address,
        size(
            nsh_terminal::DevicePixels(1120),
            nsh_terminal::DevicePixels(900),
        ),
        nsh_core::platform::Appearance::Dark,
    )
    .await;
    desktop.press("Open conversation Room reviewer").await;
    desktop.press("Focus message composer").await;
    desktop.type_text("PRIVATE_AGENT_DRAFT").await;
    assert!(desktop.controls("Rooms").is_empty());
    desktop.press("Show more").await;
    desktop.press("Rooms").await;
    let create = desktop
        .until("New room missing", || {
            desktop.controls("New room").first().copied()
        })
        .await;
    let previous = desktop.platform.text_input_target();
    desktop.press_at(create.center());
    desktop.target_after(previous).await;
    desktop.type_text("Release review").await;
    desktop.key("enter", false);
    desktop.control("Mention a session").await;
    let room = desktop
        .sessions()
        .await
        .into_iter()
        .find(|session| session["kind"] == "room")
        .unwrap();
    let room = room["id"].as_str().unwrap();
    focus_room(&desktop).await;
    desktop.type_text("The patch is ready.").await;
    let bytes = STANDARD.decode(PNG).unwrap();
    desktop.paste_image(&bytes).await;
    desktop.control("Remove attachment image.png").await;
    desktop.press("Send message").await;
    let first = room_messages(&desktop, room, 1).await.remove(0);
    assert_eq!(first["content"]["text"], "The patch is ready.");
    assert_eq!(
        first["content"]["attachments"],
        json!([{
            "name": "image.png",
            "mimeType": "image/png",
            "bytes": bytes.len(),
            "kind": "image",
        }])
    );
    assert_eq!(fixture.request_count.load(Ordering::SeqCst), 0);
    desktop.artifact("room-default-profile");
    desktop.press("Settings").await;
    desktop.press("Settings section General").await;
    desktop.press("Edit personalization").await;
    desktop.type_text("Ada").await;
    desktop.press("Change avatar").await;
    desktop.press("Green").await;
    desktop.artifact("room-avatar-choice");
    desktop.press("Save this preference").await;
    desktop.control("Edit personalization").await;
    let preferences = desktop
        .client
        .query("settings", "assistantPreferences", json!({}))
        .await
        .unwrap();
    assert_eq!(preferences["displayName"], "Ada");
    assert_eq!(preferences["avatar"], "green");
    desktop.press("Close settings").await;

    let reply = desktop.control("Reply to message").await;
    reply_at(
        &desktop,
        point(reply.left() - px(64.), reply.bottom() + px(16.)),
    )
    .await;
    focus_room(&desktop).await;
    desktop.paste("Please review @").await;
    desktop.press("Room reviewer").await;
    desktop.control("Remove mention Room reviewer").await;
    desktop.press("Conversations").await;
    desktop.press("Focus message composer").await;
    desktop.expect_text("PRIVATE_AGENT_DRAFT").await;
    desktop.press("Rooms").await;
    desktop = desktop
        .restart(&fixture, nsh_core::platform::Appearance::Dark)
        .await;
    desktop.press("Show more").await;
    desktop.press("Rooms").await;
    desktop.press("Release review").await;
    desktop.control("Cancel reply").await;
    desktop.control("Remove mention Room reviewer").await;
    focus_room(&desktop).await;
    desktop.expect_text("Please review ").await;
    desktop.press("Send message").await;
    let posts = room_messages(&desktop, room, 2).await;
    assert_eq!(posts[1]["author"]["kind"], "human");
    assert_eq!(posts[1]["replyTo"], first["id"]);
    assert_eq!(posts[1]["mentions"], json!([fixture.session]));
    assert_eq!(
        posts[1]["deliveries"][0]["kind"], "accepted",
        "{}",
        posts[1]
    );

    let request = desktop.request(&mut fixture).await;
    let input = request.body.to_string();
    assert!(
        input.contains("Please review") && input.contains("The patch is ready."),
        "{input}"
    );
    assert!(input.contains(room), "Room return address missing: {input}");
    assert!(
        !input.contains("PRIVATE_AGENT_DRAFT"),
        "unsubmitted draft leaked: {input}"
    );
    let read = json!({"sessionId":room,"messageId":posts[1]["id"],"anchor":"before"});
    let message = request.body["messages"].as_array().unwrap().last().unwrap()["content"]
        .as_str()
        .unwrap();
    assert!(
        message.contains("The user mentioned you in a Room."),
        "{message}"
    );
    assert!(
        message.contains(&format!("SessionRead({read})")),
        "{message}"
    );
    request.tool_call("SessionRead", read).await;
    let request = desktop.request(&mut fixture).await;
    let result = request.body["messages"].as_array().unwrap().last().unwrap();
    assert_eq!(result["role"], "tool");
    let result: Value = serde_json::from_str(result["content"].as_str().unwrap()).unwrap();
    assert_eq!(result["transcript"]["kind"], "room", "{result}");
    assert_eq!(
        result["transcript"]["items"][0]["id"], first["id"],
        "{result}"
    );
    let room_reply = format!(
        "[@Reviewer](maka://session/{}) reviewed in the room.",
        fixture.session
    );
    request
        .tool_call(
            "SessionSend",
            json!({
                "sessionId":room,"replyTo":posts[1]["id"],"message":room_reply
            }),
        )
        .await;
    let final_reply = desktop.request(&mut fixture).await;
    let posts = room_messages(&desktop, room, 3).await;
    assert_eq!(posts.len(), 3);
    assert_eq!(
        posts[2]["author"]["execution"]["sessionId"],
        fixture.session
    );
    assert_eq!(posts[2]["replyTo"], posts[1]["id"]);
    let reply = desktop
        .until("agent reply did not reach the Room timeline", || {
            let replies = desktop.controls("Reply to message");
            (replies.len() == 3).then(|| *replies.last().unwrap())
        })
        .await;
    desktop.click_at(
        point(reply.left() - px(64.), reply.bottom() + px(16.)),
        MouseButton::Right,
    );
    desktop.press("Copy message").await;
    let copied = desktop
        .until("agent reply was not readable in the Room", || {
            desktop.platform.take_clipboard_write()
        })
        .await;
    assert_eq!(copied, room_reply);
    let quote = *desktop.controls("View replied message").last().unwrap();
    desktop.press_at(point(quote.left() + px(20.), quote.bottom() + px(15.)));
    desktop.press("Focus message composer").await;
    let summary = "From Release review · Please review";
    desktop.open_group(summary).await;
    desktop.press_until(summary, "From Release review").await;
    desktop
        .press("Open source conversation beside this one")
        .await;
    let split = desktop.control("Close side pane").await;
    let mention = desktop.control("Mention a session").await;
    assert!(mention.center().x > px(560.) && mention.right() < split.right());
    desktop
        .until("Room history did not appear in the right pane", || {
            let replies = desktop.controls("Reply to message");
            (replies.len() == 3 && replies.iter().all(|reply| reply.center().x > px(560.)))
                .then_some(())
        })
        .await;
    desktop.artifact("room-source-split");
    desktop.press("Close side pane").await;
    final_reply.finish().await;
    fixture.idle(&desktop.client, &fixture.session).await;
    desktop.press("Focus message composer").await;
    desktop.expect_text("PRIVATE_AGENT_DRAFT").await;
    desktop
        .right_click("Open conversation NSH real Agent")
        .await;
    desktop.press("Open to the side").await;
    desktop
        .until("agent split did not show the conversation composer", || {
            (desktop.controls("Focus message composer").len() == 2).then_some(())
        })
        .await;
    desktop.press("Close side pane").await;
    desktop.close().await;
    fixture.finish().await;
}

pub(super) async fn desktop_context_menus_follow_the_pointer_and_manage_rooms() {
    let fixture = Fixture::open().await;
    let desktop = Desktop::open(&fixture, &fixture.address).await;
    let row = desktop.control("Open conversation NSH real Agent").await;
    let first = point(row.left() + px(16.), row.center().y - px(6.));
    let second = point(row.right() - px(16.), row.center().y + px(6.));
    desktop.click_at(first, MouseButton::Right);
    let menu = desktop.control("Rename conversation").await;
    desktop.key("escape", false);
    desktop
        .until("Escape left the menu open", || {
            desktop
                .controls("Rename conversation")
                .is_empty()
                .then_some(())
        })
        .await;
    desktop.click_at(second, MouseButton::Right);
    let moved = desktop.control("Rename conversation").await;
    assert!((moved.left() - menu.left() - (second.x - first.x)).abs() < px(1.));
    assert!((moved.top() - menu.top() - (second.y - first.y)).abs() < px(1.));
    desktop.press("Rename conversation").await;
    desktop.type_text("Reviewer").await;
    desktop.press("Save conversation title").await;
    desktop.control("Open conversation Reviewer").await;

    let created = mutate(
        &desktop.client,
        "create",
        json!({
            "kind":"room","title":"Review room","labels":[],
            "workspace":{"kind":"session","sessionId":fixture.session}
        }),
    )
    .await;
    let room = &created["session"]["id"];
    desktop.press("Show more").await;
    desktop.press("Rooms").await;
    desktop.control("Conversations").await;
    assert!(desktop.controls("Show more").is_empty());
    desktop.press("Review room").await;
    desktop.right_click("Review room").await;
    desktop.press("Rename room").await;
    desktop.type_text("Release room").await;
    desktop.press("Save").await;
    desktop.control("Release room").await;
    desktop.press("Collapse session browser").await;
    desktop.control("Expand session browser").await;
    assert!(desktop.controls("Conversations").is_empty());
    desktop.press("Expand session browser").await;
    desktop.control("Release room").await;

    let viewport = desktop.platform.viewport_size();
    let scale = desktop.platform.scale_factor();
    desktop
        .platform
        .set_viewport(
            size(nsh_terminal::DevicePixels(700), viewport.height),
            scale,
        )
        .unwrap();
    desktop.press("Expand session browser").await;
    desktop.press("Release room").await;
    desktop.control("Expand session browser").await;
    assert!(desktop.controls("Conversations").is_empty());
    desktop.platform.set_viewport(viewport, scale).unwrap();
    desktop.control("Release room").await;
    desktop.press("Room actions").await;
    desktop.press("Delete room").await;
    desktop.press("Cancel").await;
    desktop.control("Release room").await;
    desktop.right_click("Release room").await;
    desktop.press("Delete room").await;
    desktop.press("Confirm delete room").await;
    desktop.control("Conversations").await;
    let remaining = desktop.sessions().await;
    assert!(!remaining.iter().any(|session| &session["id"] == room));
    let reviewer = remaining
        .iter()
        .find(|session| session["id"] == fixture.session)
        .unwrap();
    assert_eq!(reviewer["title"], "Reviewer");
    desktop.close().await;
    fixture.finish().await;
}
