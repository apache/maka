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

        let tools = product_agent_tools(true).await?;
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
                assert!(
                    !msgs.contains("WORKER_EARLY_NARRATION"),
                    "Only the worker's last message is its result: {msgs}"
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
                        .send(narrated_tool_response(
                            "WORKER_EARLY_NARRATION: opening the checklist.",
                            "Read",
                            json!({"path": "checklist.txt"}),
                        ))
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
        let self_read =
            tool_round(&rig, &mut provider, parent_id, false, "SessionRead", json!({})).await?;
        let self_read_msgs: Vec<Value> = serde_json::from_str(&self_read)?;
        let self_read_output: Value = serde_json::from_str(
            self_read_msgs[0]["content"]
                .as_str()
                .ok_or("missing SessionRead tool content")?,
        )?;
        assert_eq!(
            self_read_output["session"]["id"], parent_id,
            "{self_read_output}"
        );
        let self_items = self_read_output["transcript"]["items"]
            .as_array()
            .ok_or("missing Agent transcript")?;
        assert!(
            self_items
                .iter()
                .any(|item| item["role"] == "user" && item["text"] == "Execute Read"),
            "{self_read_output}"
        );
        assert!(
            self_items
                .iter()
                .any(|item| item["toolName"] == "Read" && item["resultPath"].is_string()),
            "{self_read_output}"
        );

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

#[test]
fn session_tools_cover_fork_worktree_stop_failure_pagination_and_self_read_continuation()
-> TestResult<()> {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .thread_stack_size(16 * 1024 * 1024)
        .enable_all()
        .build()?
        .block_on(async { tokio::spawn(run_session_tools_edge_cases()).await? })
}

async fn run_session_tools_edge_cases() -> TestResult<()> {
    let mut rig = Rig::new()?;
    let mut provider = Provider::start().await?;
    let outcome = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(240), async {
        let base = rig.directory.path().to_path_buf();
        let ws = base.join("workspace");
        std::fs::create_dir_all(&ws)?;
        let large_tail = "CROSS_SESSION_TOOL_RESULT_TAIL_MARKER";
        std::fs::write(
            ws.join("large_evidence.txt"),
            format!("{}\n{large_tail}\n", "LINE_DATA_1234567890\n".repeat(120)),
        )?;

        // Initialize workspace as a Git repo so { kind: "worktree" } creates a real Git worktree.
        for args in [
            vec!["init"],
            vec!["config", "user.email", "test@example.com"],
            vec!["config", "user.name", "Test"],
            vec!["add", "."],
            vec!["commit", "-m", "initial"],
        ] {
            let st = std::process::Command::new("git")
                .current_dir(&ws)
                .args(&args)
                .output()?;
            assert!(st.status.success(), "git {args:?} failed: {:?}", st);
        }

        let root = std::env::current_dir()?.join("../../..");
        let output = tokio::process::Command::new("node")
            .current_dir(root)
            .args([
                "--input-type=module",
                "-e",
                "import {installation} from './products/maka/bundle/src/installation.ts';                  console.log(JSON.stringify(installation({workspace:process.cwd(),helper:'test'}).agent.tools.filter(                   t => (t.target.kind === 'export' && t.target.name === 'agent') ||                         (t.target.kind === 'import' && t.target.name === 'files' && t.name === 'Read')                 )))",
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
            config["isolatedWorkspaces"] = json!(true);
            config["permissions"] = json!({"access": "workspace_write", "requestPermissions": false});
            config["recall"] = json!(true);
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

        let parent = create(client, &base, &model, None).await?;
        let parent_id = parent["id"].as_str().unwrap();

        // Discover Session* tools once
        tool_round(
            &rig,
            &mut provider,
            parent_id,
            false,
            "tool_search",
            json!({"query": "Session", "limit": 20}),
        )
        .await?;

        // A. Create source worker, run Read("large_evidence.txt") so it archives a tool projection, then fork it!
        let src_raw = tool_round(
            &rig,
            &mut provider,
            parent_id,
            false,
            "SessionCreate",
            json!({"title": "Source worker for fork"}),
        )
        .await?;
        let src_msgs: Vec<Value> = serde_json::from_str(&src_raw)?;
        let src_created: Value = serde_json::from_str(src_msgs[0]["content"].as_str().unwrap())?;
        assert_eq!(src_created["kind"], "created", "{src_created}");
        let src_id = src_created["session"]["id"].as_str().unwrap().to_owned();

        let src_sent = call(
            client,
            "agent",
            "send",
            json!({"sessionId": src_id, "message": "Read large_evidence.txt"}),
        )
        .await?;
        let (_, r1) = provider.next().await?;
        r1.send(tool_response("Read", json!({"path": "large_evidence.txt"})))
            .map_err(|_| "src r1")?;
        let (_, r2) = provider.next().await?;
        r2.send(completion(
            json!({"role": "assistant", "content": "Source worker read large evidence."}),
            "stop",
        ))
        .map_err(|_| "src r2")?;
        quiescent_message(client, &src_id, &src_sent["messageId"]).await?;

        // Reject forkFrom combined with conflicting creation parameters (no silent drop!)
        let conflict_fork = tool_round(
            &rig,
            &mut provider,
            parent_id,
            false,
            "SessionCreate",
            json!({
                "title": "Conflicting fork",
                "forkFrom": {"sessionId": src_id},
                "workspace": {"kind": "worktree"}
            }),
        )
        .await?;
        assert!(
            conflict_fork.contains("forkFrom clones"),
            "Conflicting fork params must be rejected: {conflict_fork}"
        );

        // Clean fork via SessionCreate({ title, forkFrom: { sessionId } })
        let fork_raw = tool_round(
            &rig,
            &mut provider,
            parent_id,
            false,
            "SessionCreate",
            json!({
                "title": "Forked worker",
                "forkFrom": {"sessionId": src_id}
            }),
        )
        .await?;
        let fork_msgs: Vec<Value> = serde_json::from_str(&fork_raw)?;
        let fork_out: Value = serde_json::from_str(fork_msgs[0]["content"].as_str().unwrap())?;
        assert_eq!(fork_out["kind"], "forked", "{fork_out}");
        let forked_id = fork_out["session"]["id"].as_str().unwrap().to_owned();

        // Verify cross-session multi-page Read of src_id's tool-results/<event_id> reaches large_tail!
        let src_read = call(
            client,
            "agent",
            "sessionRead",
            json!({"sessionId": src_id}),
        )
        .await?;
        let src_tool_path = src_read["transcript"]["items"]
            .as_array()
            .ok_or("missing src transcript items")?
            .iter()
            .find_map(|item| item["resultPath"].as_str())
            .ok_or_else(|| format!("missing src resultPath: {src_read}"))?
            .to_owned();
        let src_tr_raw = tool_round(
            &rig,
            &mut provider,
            parent_id,
            false,
            "Read",
            json!({"path": src_tool_path}),
        )
        .await?;
        let src_tr_msgs: Vec<Value> = serde_json::from_str(&src_tr_raw)?;
        let mut src_tr_page =
            serde_json::from_str::<Value>(src_tr_msgs[0]["content"].as_str().unwrap())?["value"]
                .clone();
        let mut src_tr_combined = src_tr_page["content"].as_str().unwrap_or_default().to_owned();
        while !src_tr_page["next"].is_null() {
            let next_req = src_tr_page["next"].clone();
            let next_raw = tool_round(&rig, &mut provider, parent_id, false, "Read", next_req).await?;
            let next_msgs: Vec<Value> = serde_json::from_str(&next_raw)?;
            src_tr_page =
                serde_json::from_str::<Value>(next_msgs[0]["content"].as_str().unwrap())?["value"]
                    .clone();
            src_tr_combined.push_str(src_tr_page["content"].as_str().unwrap_or_default());
        }
        assert!(
            src_tr_combined.contains(large_tail),
            "Cross-session tool-result Read must reach tail marker"
        );

        // Verify forked_id preserved the full pre-fork conversation snapshot!
        let forked_read = call(
            client,
            "agent",
            "sessionRead",
            json!({"sessionId": forked_id}),
        )
        .await?;
        let forked_items = forked_read["transcript"]["items"]
            .as_array()
            .ok_or("missing forked transcript items")?;
        assert!(
            forked_items
                .iter()
                .any(|item| item["role"] == "assistant"
                    && item["text"] == "Source worker read large evidence."),
            "Forked worker must inherit source history: {forked_read}"
        );

        // Verify SessionRead row lookup succeeds even when optional through is omitted!
        let raw_src_hist = call(
            client,
            "agent",
            "history",
            json!({
                "sessionId": src_id,
                "position": {"kind": "tail"},
                "includeThinking": false
            }),
        )
        .await?;
        let anchor_pos = raw_src_hist["chunks"]
            .as_array()
            .unwrap()
            .last()
            .unwrap()["position"]
            .clone();
        let row_lookup = call(
            client,
            "agent",
            "sessionRead",
            json!({
                "sessionId": src_id,
                "row": {
                    "position": anchor_pos,
                    "field": "body"
                }
            }),
        )
        .await?;
        assert!(
            !row_lookup["transcript"]["items"].as_array().unwrap().is_empty(),
            "Row lookup without explicit through must return target entry: {row_lookup}"
        );

        // B. SessionCreate with workspace: { kind: "worktree" } + SessionStop returning runId
        let wt_raw = tool_round(
            &rig,
            &mut provider,
            parent_id,
            false,
            "SessionCreate",
            json!({
                "title": "Worktree worker",
                "workspace": {"kind": "worktree"}
            }),
        )
        .await?;
        let wt_msgs: Vec<Value> = serde_json::from_str(&wt_raw)?;
        let wt_out: Value = serde_json::from_str(wt_msgs[0]["content"].as_str().unwrap())?;
        assert_eq!(wt_out["kind"], "created", "{wt_out}");
        assert!(
            wt_out["session"]["workspace"]["worktree"].is_object(),
            "Expected managed Git worktree: {wt_out}"
        );
        let wt_id = wt_out["session"]["id"].as_str().unwrap().to_owned();

        // Start a run on wt_id and hold its model request open while parent calls SessionStop
        let _wt_send = call(
            client,
            "agent",
            "send",
            json!({"sessionId": wt_id, "message": "Long running task to stop"}),
        )
        .await?;
        let (_held_wt_req, held_wt_reply) = provider.next().await?;
        let wt_live = call(
            client,
            "agent",
            "sessionRead",
            json!({"sessionId": wt_id, "view": "status_only"}),
        )
        .await?;
        let active_run_id = wt_live["run"]["runId"]
            .as_str()
            .ok_or_else(|| format!("missing wt active runId: {wt_live}"))?
            .to_owned();

        let stop_raw = tool_round(
            &rig,
            &mut provider,
            parent_id,
            false,
            "SessionStop",
            json!({"sessionId": wt_id}),
        )
        .await?;
        let stop_msgs: Vec<Value> = serde_json::from_str(&stop_raw)?;
        let stop_out: Value = serde_json::from_str(stop_msgs[0]["content"].as_str().unwrap())?;
        assert_eq!(stop_out["requested"], true, "{stop_out}");
        assert_eq!(
            stop_out["runId"].as_str(),
            Some(active_run_id.as_str()),
            "SessionStop must preserve runId on Computed commit: {stop_out}"
        );
        drop(held_wt_reply);
        for _ in 0..100 {
            let st = call(
                client,
                "agent",
                "sessionRead",
                json!({"sessionId": wt_id, "view": "status_only"}),
            )
            .await?;
            if st["session"]["activity"] == "idle" {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }

        // C. Failed worker Run observability (Role::Failure + run.error + Read markdown + <worker_result>)
        let fail_raw = tool_round(
            &rig,
            &mut provider,
            parent_id,
            false,
            "SessionCreate",
            json!({"title": "Failing worker"}),
        )
        .await?;
        let fail_msgs: Vec<Value> = serde_json::from_str(&fail_raw)?;
        let fail_out: Value = serde_json::from_str(fail_msgs[0]["content"].as_str().unwrap())?;
        let fail_id = fail_out["session"]["id"].as_str().unwrap().to_owned();

        let _ = call(
            client,
            "agent",
            "send",
            json!({"sessionId": parent_id, "message": "Dispatch failing worker"}),
        )
        .await?;
        let (_, p_reply) = provider.next().await?;
        p_reply
            .send(tool_response(
                "SessionSend",
                json!({"sessionId": fail_id, "message": "Trigger fatal error"}),
            ))
            .map_err(|_| "p_reply")?;

        let mut parent_closed = false;
        let mut saw_failed_wakeup = false;
        let mut worker_reported = false;
        while !saw_failed_wakeup {
            let (req, reply) = provider.next().await?;
            let msgs = text_messages(&req);
            if msgs.contains("<worker_result>") && msgs.contains("FATAL_UPSTREAM_DIAGNOSTIC_400") {
                // A failed worker's notice keeps what it said last beside why it failed.
                assert!(
                    msgs.contains("WORKER_PARTIAL_FINDINGS: two of three checks passed.")
                        && msgs.contains("<failure_reason>"),
                    "{msgs}"
                );
                saw_failed_wakeup = true;
                reply
                    .send(completion(
                        json!({"role": "assistant", "content": "Observed worker failure."}),
                        "stop",
                    ))
                    .map_err(|_| "fail wakeup")?;
            } else if msgs.contains("Trigger fatal error")
                && !msgs.contains("Dispatch failing worker")
                && !worker_reported
            {
                worker_reported = true;
                reply
                    .send(narrated_tool_response(
                        "WORKER_PARTIAL_FINDINGS: two of three checks passed.",
                        "Read",
                        json!({"path": "checklist.txt"}),
                    ))
                    .map_err(|_| "worker report")?;
            } else if msgs.contains("Trigger fatal error") && !msgs.contains("Dispatch failing worker") {
                reply
                    .send(ModelReply::Fatal(
                        "FATAL_UPSTREAM_DIAGNOSTIC_400: invalid schema parameter".into(),
                    ))
                    .map_err(|_| "fatal send")?;
            } else if !parent_closed {
                parent_closed = true;
                reply
                    .send(completion(
                        json!({"role": "assistant", "content": "Waiting for failing worker."}),
                        "stop",
                    ))
                    .map_err(|_| "parent close")?;
            }
        }
        for _ in 0..100 {
            let st = call(
                client,
                "agent",
                "sessionRead",
                json!({"sessionId": parent_id, "view": "status_only"}),
            )
            .await?;
            if st["session"]["activity"] == "idle"
                && st["queuedMessages"].as_array().is_none_or(Vec::is_empty)
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }

        let fail_read = call(
            client,
            "agent",
            "sessionRead",
            json!({"sessionId": fail_id}),
        )
        .await?;
        assert_eq!(fail_read["run"]["state"], "failed", "{fail_read}");
        assert!(
            fail_read["run"]["error"]
                .as_str()
                .is_some_and(|e| e.contains("FATAL_UPSTREAM_DIAGNOSTIC_400")),
            "SessionRunOverview.error must expose failure diagnostic: {fail_read}"
        );
        assert!(
            fail_read["transcript"]["items"]
                .as_array()
                .unwrap()
                .iter()
                .any(|item| item["role"] == "failure"
                    && item["text"]
                        .as_str()
                        .is_some_and(|t| t.contains("FATAL_UPSTREAM_DIAGNOSTIC_400"))),
            "Transcript must retain Role::Failure entry: {fail_read}"
        );

        let fail_md = tool_round(
            &rig,
            &mut provider,
            parent_id,
            false,
            "Read",
            json!({"path": format!("maka://session/{fail_id}")}),
        )
        .await?;
        assert!(
            fail_md.contains("### Failure") && fail_md.contains("FATAL_UPSTREAM_DIAGNOSTIC_400"),
            "{fail_md}"
        );

        // D. SessionList pagination with limit=1 across all children never repeats a session
        let mut seen_ids = std::collections::HashSet::new();
        let mut cursor: Option<String> = None;
        loop {
            let mut req = json!({"scope": "children", "parentSessionId": parent_id, "limit": 1});
            if let Some(c) = &cursor {
                req["cursor"] = json!(c);
            }
            let page = call(client, "agent", "sessionList", req).await?;
            let items = page["sessions"].as_array().unwrap();
            for item in items {
                let id = item["id"].as_str().unwrap().to_owned();
                assert!(
                    seen_ids.insert(id.clone()),
                    "Duplicate session returned across SessionList pages: {id}"
                );
            }
            match page["nextCursor"].as_str() {
                Some(next) => cursor = Some(next.to_owned()),
                None => break,
            }
        }
        for expected in [&src_id, &forked_id, &wt_id, &fail_id] {
            assert!(
                seen_ids.contains(expected),
                "Missing child {expected} in {seen_ids:?}"
            );
        }

        // E. SessionRead rejects conflicting locators, and row lookup without through succeeds
        let bad_read = call(
            client,
            "agent",
            "sessionRead",
            json!({"sessionId": src_id, "position": "tail", "messageId": "m_1"}),
        )
        .await;
        assert!(bad_read.is_err(), "Conflicting SessionRead locators must error: {bad_read:?}");

        // F. Multi-page Read("maka://session/<parent_id>") self-continuation never hits ContentChanged!
        //    Pad parent_id with a > 9,000-char assistant message so its rendered markdown spans >= 2 pages.
        let pad_msg = call(
            client,
            "agent",
            "send",
            json!({"sessionId": parent_id, "message": "Emit long report for self-read pagination"}),
        )
        .await?;
        let (_, pad_reply) = provider.next().await?;
        let long_body = format!(
            "SELF_READ_START_MARKER\n{}\nSELF_READ_END_MARKER",
            "Long section line for multi-page self-inspection test. ".repeat(220)
        );
        pad_reply
            .send(completion(
                json!({"role": "assistant", "content": long_body}),
                "stop",
            ))
            .map_err(|_| "pad_reply")?;
        quiescent_message(client, parent_id, &pad_msg["messageId"]).await?;

        let self_page1_raw = tool_round(
            &rig,
            &mut provider,
            parent_id,
            false,
            "Read",
            json!({"path": format!("maka://session/{parent_id}")}),
        )
        .await?;
        let sp1_msgs: Vec<Value> = serde_json::from_str(&self_page1_raw)?;
        let sp_env: Value = serde_json::from_str(sp1_msgs[0]["content"].as_str().unwrap())?;
        let mut sp_page = sp_env["value"].clone();
        assert!(
            !sp_page["next"].is_null(),
            "Expected multi-page self-session Read: {sp_env}"
        );
        let mut combined_self = sp_page["content"].as_str().unwrap_or_default().to_owned();
        let mut page_count = 1usize;
        while !sp_page["next"].is_null() {
            page_count += 1;
            let next_arg = sp_page["next"].clone();
            let next_raw = tool_round(&rig, &mut provider, parent_id, false, "Read", next_arg).await?;
            assert!(
                !next_raw.contains("The content changed since the previous page"),
                "Self-session Read continuation hit ContentChanged on page {page_count}: {next_raw}"
            );
            let next_msgs: Vec<Value> = serde_json::from_str(&next_raw)?;
            let next_env: Value = serde_json::from_str(next_msgs[0]["content"].as_str().unwrap())?;
            sp_page = next_env["value"].clone();
            combined_self.push_str(sp_page["content"].as_str().unwrap_or_default());
        }
        assert!(page_count >= 2, "Expected >= 2 pages, got {page_count}");
        assert!(
            combined_self.contains("SELF_READ_END_MARKER"),
            "Combined self-session markdown missing tail marker"
        );

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

fn narrated_tool_response(text: &str, name: &str, input: Value) -> ModelReply {
    ModelReply::Stream(super::super::bot_tools::completion(
        json!({"role":"assistant","content":text,"tool_calls":[{
            "index":0,"id":format!("call-{name}"),"type":"function",
            "function":{"name":name,"arguments":input.to_string()}
        }]}),
        "tool_calls",
    ))
}
