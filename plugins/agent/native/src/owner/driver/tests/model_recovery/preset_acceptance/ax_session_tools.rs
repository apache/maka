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
async fn universal_read_and_human_symmetric_session_tools_coordinate_rooms_and_workers()
-> TestResult<()> {
    let mut rig = Rig::new()?;
    let mut provider = Provider::start().await?;
    let outcome = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(120), async {
        let base = rig.directory.path().to_path_buf();
        std::fs::create_dir_all(base.join("workspace"))?;
        std::fs::write(
            base.join("workspace/checklist.txt"),
            "TOOL_OUTPUT_EVIDENCE: verify snap-back threshold on page boundary.\n",
        )?;

        let root = std::env::current_dir()?.join("../../..");
        let output = tokio::process::Command::new("node")
            .current_dir(root)
            .args([
                "--input-type=module",
                "-e",
                "import {installation} from './products/maka/bundle/src/installation.ts'; \
                 console.log(JSON.stringify(installation({workspace:process.cwd(),helper:'test'}).agent.tools.filter(\
                   t => (t.target.kind === 'export' && t.target.name === 'agent') || \
                        (t.target.kind === 'import' && t.target.name === 'files' && t.name === 'Read')\
                 )))",
            ])
            .output()
            .await?;
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let tools: Value = serde_json::from_slice(&output.stdout)?;
        let boot = bootstrap_with(&base, provider.url.clone(), |config| {
            config["tools"] = tools;
            config["toolDiscovery"] = json!(true);
            config["goals"] = json!(true);
        })
        .await?;
        attach(&mut rig, &boot).await?;
        let client = rig.client.as_ref().unwrap();
        let model = model_options(
            client,
            &provider.url,
            false,
            json!({"contextWindow": 128000, "compactionThreshold": 100000}),
        )
        .await?;

        let room = call(
            client,
            "agent",
            "create",
            json!({
                "kind": "room",
                "title": "Reviewers需要关注的事项",
                "labels": [],
                "workspace": {"kind": "directory", "path": base.join("workspace")}
            }),
        )
        .await?["session"]["id"]
            .as_str()
            .ok_or("missing room id")?
            .to_owned();
        let room_post = call(
            client,
            "agent",
            "send",
            json!({
                "sessionId": room,
                "message": "ROOM_GUIDELINE: Always verify zero-length snap-back on huge lines."
            }),
        )
        .await?;
        assert_eq!(room_post["kind"], "posted", "{room_post}");

        let parent = create(client, &base, &model, None).await?;
        let parent_id = parent["id"].as_str().unwrap();

        // 1. Send user message with [#Room](maka://session/<id>) -> verify <session_references>,
        //    deferred Goal tools, and zero-discovery Read({ path: "maka://session/<room>" }).
        let sent = call(
            client,
            "agent",
            "send",
            json!({
                "sessionId": parent_id,
                "message": format!("Check [#Reviewers需要关注的事项](maka://session/{room}) first.")
            }),
        )
        .await?;
        let (req1, reply1) = provider.next().await?;
        let direct_tool_names: Vec<&str> = req1["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|t| t["function"]["name"].as_str())
            .collect();
        assert!(direct_tool_names.contains(&"Read"), "{direct_tool_names:?}");
        let user_prompt = text_messages(&req1);
        assert!(user_prompt.contains("<session_references>"), "{user_prompt}");
        assert!(
            user_prompt.contains(&format!("maka://session/{room}")),
            "{user_prompt}"
        );
        reply1
            .send(tool_response(
                "Read",
                json!({"path": format!("maka://session/{room}")}),
            ))
            .map_err(|_| "reply1 lost")?;

        let (req2, reply2) = provider.next().await?;
        let room_digest = text_messages(&req2);
        assert!(
            room_digest.contains("ROOM_GUIDELINE: Always verify zero-length snap-back on huge lines."),
            "{room_digest}"
        );
        reply2
            .send(completion(
                json!({"role": "assistant", "content": "Read room guidelines."}),
                "stop",
            ))
            .map_err(|_| "reply2 lost")?;
        quiescent_message(client, parent_id, &sent["messageId"]).await?;

        // 2. Discover Session* tools via tool_search
        tool_round(
            &rig,
            &mut provider,
            parent_id,
            false,
            "tool_search",
            json!({"query": "Session", "limit": 20}),
        )
        .await?;

        // 3. SessionCreate with minimal args (defaults to caller's workspace & model)
        let created_raw = tool_round(
            &rig,
            &mut provider,
            parent_id,
            false,
            "SessionCreate",
            json!({"title": "Audit page snap-back"}),
        )
        .await?;
        assert!(created_raw.contains("created") && created_raw.contains("Audit page snap-back"), "{created_raw}");

        // 4. SessionList with scope="children" (defaults parentSessionId to caller)
        let list_raw = tool_round(
            &rig,
            &mut provider,
            parent_id,
            false,
            "SessionList",
            json!({"scope": "children"}),
        )
        .await?;
        assert!(list_raw.contains("Audit page snap-back"), "{list_raw}");
        let listed = call(
            client,
            "agent",
            "sessionList",
            json!({"scope": "children", "parentSessionId": parent_id}),
        )
        .await?;
        let child_id = listed["sessions"][0]["id"]
            .as_str()
            .ok_or("missing child session id")?
            .to_owned();

        // 5. SessionSend without onComplete -> defaults to notify_caller, child runs Read("checklist.txt"),
        //    and parent automatically wakes up with inline <worker_result>!
        let _delegate_msg = call(
            client,
            "agent",
            "send",
            json!({"sessionId": parent_id, "message": "Delegate checklist audit to child"}),
        )
        .await?;
        let (_, parent_send_reply) = provider.next().await?;
        parent_send_reply
            .send(tool_response(
                "SessionSend",
                json!({"sessionId": child_id, "message": "Inspect checklist.txt and report"}),
            ))
            .map_err(|_| "parent send lost")?;

        let mut child_tool_step_done = false;
        let mut child_finished = false;
        let mut parent_turn_done = false;
        let mut saw_inline_worker_result = false;
        while !saw_inline_worker_result {
            let (req, reply) = provider.next().await?;
            let msgs = text_messages(&req);
            if msgs.contains("<worker_result>") {
                assert!(
                    msgs.contains("WORKER_FINAL_SUMMARY: snap-back check passed."),
                    "Parent wake-up must inline <worker_result>: {msgs}"
                );
                saw_inline_worker_result = true;
                reply
                    .send(completion(
                        json!({"role": "assistant", "content": "Received worker result."}),
                        "stop",
                    ))
                    .map_err(|_| "wakeup reply lost")?;
            } else if msgs.contains("Inspect checklist.txt and report")
                && !msgs.contains("Delegate checklist audit to child")
            {
                if !child_tool_step_done {
                    child_tool_step_done = true;
                    reply
                        .send(tool_response("Read", json!({"path": "checklist.txt"})))
                        .map_err(|_| "child Read lost")?;
                } else if !child_finished {
                    child_finished = true;
                    reply
                        .send(completion(
                            json!({"role": "assistant", "content": "WORKER_FINAL_SUMMARY: snap-back check passed."}),
                            "stop",
                        ))
                        .map_err(|_| "child final lost")?;
                }
            } else if !parent_turn_done {
                assert!(
                    msgs.contains("registered"),
                    "SessionSend should register completion by default for Agent callers: {msgs}"
                );
                parent_turn_done = true;
                reply
                    .send(completion(
                        json!({"role": "assistant", "content": "Delegated and waiting for callback."}),
                        "stop",
                    ))
                    .map_err(|_| "parent turn finish lost")?;
            }
        }

        // Wait for parent wake-up run to become quiescent
        for _ in 0..100 {
            let status = call(
                client,
                "agent",
                "sessionRead",
                json!({"sessionId": parent_id, "view": "status_only"}),
            )
            .await?;
            if status["session"]["activity"] == "idle"
                && status["queuedMessages"].as_array().is_none_or(Vec::is_empty)
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }

        // 6. Read("maka://session/<child_id>") and drill into maka://session/<child_id>/tool-results/<event_id>
        let child_md = tool_round(
            &rig,
            &mut provider,
            parent_id,
            false,
            "Read",
            json!({"path": format!("maka://session/{child_id}")}),
        )
        .await?;
        assert!(
            child_md.contains("WORKER_FINAL_SUMMARY: snap-back check passed."),
            "{child_md}"
        );

        let child_structured = call(
            client,
            "agent",
            "sessionRead",
            json!({"sessionId": child_id}),
        )
        .await?;
        let result_path = child_structured["transcript"]["items"]
            .as_array()
            .ok_or("missing agent transcript items")?
            .iter()
            .find_map(|item| item["resultPath"].as_str())
            .ok_or_else(|| format!("missing resultPath on tool entry: {child_structured}"))?
            .to_owned();
        assert!(
            result_path.starts_with(&format!("maka://session/{child_id}/tool-results/")),
            "{result_path}"
        );

        let drilled_tool_output = tool_round(
            &rig,
            &mut provider,
            parent_id,
            false,
            "Read",
            json!({"path": result_path}),
        )
        .await?;
        assert!(
            drilled_tool_output.contains("TOOL_OUTPUT_EVIDENCE: verify snap-back threshold"),
            "{drilled_tool_output}"
        );

        // 7. Self-inspection via SessionRead({}) and lifecycle management via SessionManage without expectedRevision
        let self_read = tool_round(&rig, &mut provider, parent_id, false, "SessionRead", json!({})).await?;
        assert!(self_read.contains(parent_id), "{self_read}");

        let updated = tool_round(
            &rig,
            &mut provider,
            parent_id,
            false,
            "SessionManage",
            json!({
                "sessionId": child_id,
                "action": {"kind": "update", "title": "Snap-back verified", "pinned": true}
            }),
        )
        .await?;
        assert!(updated.contains("Snap-back verified"), "{updated}");

        let archived = tool_round(
            &rig,
            &mut provider,
            parent_id,
            false,
            "SessionManage",
            json!({"sessionId": child_id, "action": {"kind": "archive"}}),
        )
        .await?;
        let archived_msgs: Vec<Value> = serde_json::from_str(&archived)?;
        let archived_payload: Value = serde_json::from_str(archived_msgs[0]["content"].as_str().unwrap())?;
        assert_eq!(archived_payload["session"]["archived"], true, "{archived_payload}");

        Ok::<_, Box<dyn Error + Send + Sync>>(())
    }))
    .catch_unwind()
    .await;
    drop(provider);
    let cleanup = rig.finish().await;
    assert!(matches!(outcome, Ok(Ok(Ok(())))), "{outcome:?}");
    assert!(cleanup.is_empty(), "{cleanup:?}");
    Ok(())
}
