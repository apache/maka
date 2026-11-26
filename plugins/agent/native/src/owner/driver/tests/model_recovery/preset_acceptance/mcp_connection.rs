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

/// Logs each process start, answers `echo`, and exits in the middle of `crash`.
/// With `once`, every later process exits before it answers `initialize`.
const CRASH_SERVER: &str = r#"
import { createInterface } from 'node:readline';
import { appendFileSync, existsSync } from 'node:fs';
const restarted = existsSync(process.argv[2]);
appendFileSync(process.argv[2], `${process.pid}\n`);
if (restarted && process.argv[3] === 'once') process.exit(1);
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const tool = (name) => ({ name, description: `Fixture ${name}`, inputSchema: { type: 'object' } });
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  const reply = (result) => send({ jsonrpc: '2.0', id: message.id, result });
  if (message.method === 'initialize')
    reply({
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'crash', version: '1' },
    });
  else if (message.method === 'tools/list') reply({ tools: [tool('echo'), tool('crash')] });
  else if (message.method === 'tools/call') {
    if (message.params.name === 'crash') process.exit(1);
    reply({ content: [{ type: 'text', text: JSON.stringify(message.params.arguments) }], isError: false });
  }
});
"#;

async fn full_access_session(rig: &Rig, base: &Path, model: &Value) -> TestResult<String> {
    let client = rig.client.as_ref().unwrap();
    let id = create(client, base, model, None).await?["id"]
        .as_str()
        .ok_or("missing session id")?
        .to_owned();
    let owner = rig.captured.lock().unwrap().clone().unwrap();
    let revision = owner.mutable_session(&id).await?.revision;
    let changed = call(client, "agent", "metadata", json!({
        "sessionId":id,"expectedRevision":revision,"title":"MCP session","labels":[],
        "permissions":{"settings":{"access":"danger_full_access","requestPermissions":false},"revokeGrants":true}
    }))
    .await?;
    assert_eq!(changed["kind"], "committed", "{changed}");
    Ok(id)
}

async fn send(client: &HostClient, session: &str, text: &str) -> TestResult<Value> {
    let sent = call(
        client,
        "agent",
        "send",
        json!({"sessionId":session,"message":text}),
    )
    .await?;
    assert_eq!(sent["kind"], "queued", "{sent}");
    Ok(sent["messageId"].clone())
}

async fn last_tool_output(
    provider: &mut Provider,
    rig: &Rig,
    session: &str,
) -> TestResult<(String, TurnHandle)> {
    let (request, reply) = match provider.next().await {
        Ok(next) => next,
        Err(error) => {
            return Err(format!("{error}; {}", diagnostic(rig, session).await?).into());
        }
    };
    let output = request["messages"]
        .as_array()
        .and_then(|messages| messages.iter().rev().find(|m| m["role"] == "tool"))
        .map(Value::to_string)
        .unwrap_or_default();
    Ok((output, reply))
}

/// One turn that calls `echo` on `server` and finishes after reading its result.
async fn echo_turn(
    rig: &Rig,
    provider: &mut Provider,
    session: &str,
    server: &str,
    marker: &str,
) -> TestResult<()> {
    let client = rig.client.as_ref().unwrap();
    let message = send(client, session, "Echo the marker.").await?;
    let (_, reply) = last_tool_output(provider, rig, session).await?;
    reply.send_plan(tool_response(
        &format!("mcp__{server}__echo"),
        json!({"marker":marker}),
    ));
    let (output, reply) = last_tool_output(provider, rig, session).await?;
    assert!(output.contains(marker), "{output}");
    reply.reply_text("Done.");
    tokio::time::timeout(
        Duration::from_secs(20),
        completed_message(client, session, &message),
    )
    .await??;
    Ok(())
}

async fn terminal(client: &HostClient, session: &str, message: &Value) -> TestResult<Value> {
    loop {
        let work = call(
            client,
            "agent",
            "work",
            json!({"sessionId":session,"target":{"kind":"message","messageId":message}}),
        )
        .await?;
        if matches!(
            work["execution"]["state"]["kind"].as_str(),
            Some("completed" | "failed" | "cancelled")
        ) {
            return Ok(work);
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
}

/// Starts the global mcp.json servers `fixture` and `steady`, then runs one turn whose
/// call makes `fixture` exit. `steady` logs its starts to `steady-starts.log`.
async fn crashed_session(
    rig: &mut Rig,
    provider: &mut Provider,
    base: &Path,
    args: Value,
) -> TestResult<(Value, String)> {
    std::fs::write(base.join("crash-server.mjs"), CRASH_SERVER)?;
    std::fs::create_dir_all(base.join("home/.maka"))?;
    std::fs::write(
        base.join("home/.maka/mcp.json"),
        json!({"mcpServers":{
            "fixture":{"command":"node","args":args,"cwd":base},
            "steady":{"command":"node","cwd":base,
                "args":[base.join("crash-server.mjs"), base.join("steady-starts.log")]}
        }})
        .to_string(),
    )?;
    let boot = bootstrap_with(base, provider.server.base_url(), |config| {
        config["assistant"] = json!({"home":base.join("home")});
    })
    .await?;
    attach(rig, &boot).await?;
    let client = rig.client.as_ref().unwrap();
    let model = model(client, &provider.server.base_url(), false).await?;
    let session = full_access_session(rig, base, &model).await?;
    let message = send(client, &session, "Call the server.").await?;
    let (_, reply) = last_tool_output(provider, rig, &session).await?;
    reply.send_plan(tool_response("mcp__fixture__crash", json!({})));
    tokio::time::timeout(
        Duration::from_secs(20),
        terminal(client, &session, &message),
    )
    .await??;
    Ok((model, session))
}

fn started(starts: &Path) -> usize {
    std::fs::read_to_string(starts)
        .unwrap_or_default()
        .lines()
        .count()
}

/// A server from the global mcp.json exits during a call. The retired connection
/// is replaced by one new server process the next time a turn needs it, so the
/// next turn and a new Session can use the server again. The other server of the
/// same file keeps its process.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mcp_server_that_exits_mid_call_is_reopened_for_the_next_turn() -> TestResult<()> {
    let mut rig = Rig::new()?;
    let mut provider = Provider::start().await?;
    let base = rig.directory.path().to_path_buf();
    let starts = base.join("mcp-starts.log");
    let outcome = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(120), async {
        let args = json!([base.join("crash-server.mjs"), starts]);
        let (model, session) = crashed_session(&mut rig, &mut provider, &base, args).await?;
        assert_eq!(started(&starts), 1);

        echo_turn(&rig, &mut provider, &session, "fixture", "next-turn-marker").await?;
        assert_eq!(started(&starts), 2);
        let fresh = full_access_session(&rig, &base, &model).await?;
        echo_turn(&rig, &mut provider, &fresh, "fixture", "new-session-marker").await?;
        assert_eq!(started(&starts), 2);
        echo_turn(&rig, &mut provider, &fresh, "steady", "steady-marker").await?;
        assert_eq!(started(&base.join("steady-starts.log")), 1);
        Ok::<_, Box<dyn Error + Send + Sync>>(())
    }))
    .catch_unwind()
    .await;
    let cleanup = tokio::time::timeout(Duration::from_secs(30), rig.finish()).await?;
    assert!(cleanup.is_empty(), "{cleanup:?}");
    match outcome {
        Ok(result) => result??,
        Err(panic) => std::panic::resume_unwind(panic),
    };
    Ok(())
}

/// When the retired server cannot start again, each message is rejected with the
/// server's startup error, and each message starts the server only once.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mcp_server_that_cannot_restart_rejects_each_message_with_its_startup_error()
-> TestResult<()> {
    let mut rig = Rig::new()?;
    let mut provider = Provider::start().await?;
    let base = rig.directory.path().to_path_buf();
    let starts = base.join("mcp-starts.log");
    let outcome = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(120), async {
        let args = json!([base.join("crash-server.mjs"), starts, "once"]);
        let (_, session) = crashed_session(&mut rig, &mut provider, &base, args).await?;
        assert_eq!(started(&starts), 1);

        let client = rig.client.as_ref().unwrap();
        for attempt in 2..=3 {
            let sent = call(
                client,
                "agent",
                "send",
                json!({"sessionId":session,"message":"Echo the marker."}),
            )
            .await;
            let error = match sent {
                Ok(sent) => return Err(format!("send was accepted: {sent}").into()),
                Err(error) => error.to_string(),
            };
            assert!(
                error.contains("MCP server fixture: MCP initialization failed"),
                "{error}"
            );
            assert_eq!(started(&starts), attempt, "{error}");
        }
        Ok::<_, Box<dyn Error + Send + Sync>>(())
    }))
    .catch_unwind()
    .await;
    let cleanup = tokio::time::timeout(Duration::from_secs(30), rig.finish()).await?;
    assert!(cleanup.is_empty(), "{cleanup:?}");
    match outcome {
        Ok(result) => result??,
        Err(panic) => std::panic::resume_unwind(panic),
    };
    Ok(())
}

/// Logs each start. First start exposes zero tools, notifies `tools/list_changed`,
/// and closes its transport; subsequent starts expose `echo`.
const DYNAMIC_SERVER: &str = r#"
import { createInterface } from 'node:readline';
import { appendFileSync, existsSync } from 'node:fs';
const restarted = existsSync(process.argv[2]);
appendFileSync(process.argv[2], `${process.pid}\n`);
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const tool = (name) => ({ name, description: `Fixture ${name}`, inputSchema: { type: 'object' } });
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  const reply = (result) => send({ jsonrpc: '2.0', id: message.id, result });
  if (message.method === 'initialize')
    reply({
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: 'dynamic', version: '1' },
    });
  else if (message.method === 'tools/list') {
    if (!restarted) {
      send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
      reply({ tools: [] });
      process.stdout.end();
    } else {
      reply({ tools: [tool('echo')] });
    }
  } else if (message.method === 'tools/call') {
    reply({ content: [{ type: 'text', text: JSON.stringify(message.params.arguments) }], isError: false });
  }
});
"#;

/// A server that starts with zero tools still reopens once its connection retires,
/// exposing tools added on restart without reopening sibling servers.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mcp_zero_tool_server_reopens_after_retiring() -> TestResult<()> {
    let mut rig = Rig::new()?;
    let mut provider = Provider::start().await?;
    let base = rig.directory.path().to_path_buf();
    let starts = base.join("dynamic-starts.log");
    let outcome = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(120), async {
        std::fs::write(base.join("dynamic-server.mjs"), DYNAMIC_SERVER)?;
        std::fs::write(base.join("crash-server.mjs"), CRASH_SERVER)?;
        std::fs::create_dir_all(base.join("home/.maka"))?;
        std::fs::write(
            base.join("home/.maka/mcp.json"),
            json!({"mcpServers":{
                "dynamic":{"command":"node","cwd":base,"args":[base.join("dynamic-server.mjs"), &starts]},
                "steady":{"command":"node","cwd":base,
                    "args":[base.join("crash-server.mjs"), base.join("steady-starts.log")]}
            }})
            .to_string(),
        )?;
        let boot = bootstrap_with(&base, provider.server.base_url(), |config| {
            config["assistant"] = json!({"home":base.join("home")});
        })
        .await?;
        attach(&mut rig, &boot).await?;
        let client = rig.client.as_ref().unwrap();
        let model = model(client, &provider.server.base_url(), false).await?;
        let session = full_access_session(&rig, &base, &model).await?;

        let first = send(client, &session, "Start with empty tool list.").await?;
        let (_, reply) = last_tool_output(&mut provider, &rig, &session).await?;
        reply
            .reply_text("Done.");
        tokio::time::timeout(
            Duration::from_secs(20),
            completed_message(client, &session, &first),
        )
        .await??;
        let second = send(client, &session, "Echo the marker.").await?;
        let (req2, reply) = next_request(&mut provider, &rig, &session).await?;
        let req2_user = last_message_text(&req2, "user");
        assert!(
            req2_user.contains("<mcp_servers>") && req2_user.contains("mcp__dynamic__echo"),
            "runtime tool list expansion with unchanged config digest must append updated <mcp_servers>: {req2_user}"
        );
        reply.send_plan(tool_response(
            "mcp__dynamic__echo",
            json!({"marker": "zero-tool-reopened"}),
        ));
        let (output, reply) = last_tool_output(&mut provider, &rig, &session).await?;
        assert!(output.contains("zero-tool-reopened"), "{output}");
        reply.reply_text("Done.");
        tokio::time::timeout(
            Duration::from_secs(20),
            completed_message(client, &session, &second),
        )
        .await??;
        assert_eq!(started(&starts), 2);
        assert_eq!(started(&base.join("steady-starts.log")), 1);
        Ok::<_, Box<dyn Error + Send + Sync>>(())
    }))
    .catch_unwind()
    .await;
    let cleanup = tokio::time::timeout(Duration::from_secs(30), rig.finish()).await?;
    assert!(cleanup.is_empty(), "{cleanup:?}");
    match outcome {
        Ok(result) => result??,
        Err(panic) => std::panic::resume_unwind(panic),
    };
    Ok(())
}

async fn set_permissions(
    rig: &Rig,
    session: &str,
    access: &str,
    request_permissions: bool,
) -> TestResult<()> {
    let client = rig.client.as_ref().unwrap();
    let owner = rig.captured.lock().unwrap().clone().unwrap();
    let revision = owner.mutable_session(session).await?.revision;
    let changed = call(
        client,
        "agent",
        "metadata",
        json!({
            "sessionId": session,
            "expectedRevision": revision,
            "title": "MCP session",
            "labels": [],
            "permissions": {
                "settings": {"access": access, "requestPermissions": request_permissions},
                "revokeGrants": true
            }
        }),
    )
    .await?;
    assert_eq!(changed["kind"], "committed", "{changed}");
    Ok(())
}

async fn next_request(
    provider: &mut Provider,
    rig: &Rig,
    session: &str,
) -> TestResult<(Value, TurnHandle)> {
    match provider.next().await {
        Ok(next) => Ok(next),
        Err(error) => {
            let diag = diagnostic(rig, session).await?;
            let owner = rig.captured.lock().unwrap().clone().unwrap();
            let latest_facts = if let Some(run_id) = diag["observation"]["latestRunId"].as_str() {
                facts(&owner.durable, serde_json::from_value(json!(run_id))?).await?
            } else {
                vec![]
            };
            Err(format!("{error}; {diag}; latest_facts={latest_facts:?}").into())
        }
    }
}

fn last_message_text(request: &Value, role: &str) -> String {
    request["messages"]
        .as_array()
        .and_then(|messages| messages.iter().rev().find(|m| m["role"] == role))
        .map(Value::to_string)
        .unwrap_or_default()
}

fn exec_js(code: impl Into<String>) -> TurnPlan {
    tool_response(
        "exec",
        json!({ "code": code.into(), "yield_time_ms": 30000 }),
    )
}

async fn finish_turn(
    client: &HostClient,
    session: &str,
    message: &Value,
    reply: TurnHandle,
    text: &str,
) -> TestResult<()> {
    reply.reply_text(text);
    tokio::time::timeout(
        Duration::from_secs(20),
        completed_message(client, session, message),
    )
    .await??;
    Ok(())
}

fn write_mcp_json(path: &Path, servers: Value) -> TestResult<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(
        path,
        serde_json::to_vec_pretty(&json!({ "mcpServers": servers }))?,
    )?;
    Ok(())
}

fn stdio_entry(script: &Path, log: &Path, tool: Option<&str>, cwd: &Path) -> Value {
    let mut args = vec![json!(script), json!(log)];
    if let Some(tool) = tool {
        args.push(json!(tool));
    }
    json!({ "command": "node", "args": args, "cwd": cwd })
}

async fn manage_mcp_server(
    client: &HostClient,
    workspace: Option<&Value>,
    location: &str,
    name: &str,
    change: Value,
) -> TestResult<()> {
    let query = match workspace {
        Some(ws) => json!({ "workspace": ws }),
        None => json!({}),
    };
    let cfgs = call(client, "agent", "mcpConfigurations", query).await?;
    let revision = cfgs["locations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|loc| loc["location"] == location)
        .ok_or_else(|| format!("missing location {location}: {cfgs}"))?["revision"]
        .as_str()
        .unwrap()
        .to_owned();
    let mut payload = json!({
        "location": location,
        "name": name,
        "revision": revision,
        "change": change
    });
    if let Some(ws) = workspace {
        payload["workspace"] = ws.clone();
    }
    let saved = call(client, "agent", "manageMcpServer", payload).await?;
    assert_eq!(saved["kind"], "saved", "{saved}");
    Ok(())
}

async fn set_project_decision(
    client: &HostClient,
    workspace: &Value,
    revision: &str,
    decision: &str,
) -> TestResult<()> {
    let saved = call(
        client,
        "agent",
        "setProjectMcpDecision",
        json!({ "workspace": workspace, "revision": revision, "decision": decision }),
    )
    .await?;
    assert_eq!(saved["kind"], "saved", "{saved}");
    Ok(())
}

async fn enqueue_followup(client: &HostClient, session: &str, message: &str) -> TestResult<String> {
    let queued = call(
        client,
        "agent",
        "send",
        json!({ "sessionId": session, "message": message, "delivery": "queue" }),
    )
    .await?;
    assert_eq!(queued["kind"], "queued", "{queued}");
    Ok(queued["messageId"].as_str().unwrap().to_owned())
}

async fn edit_queue(client: &HostClient, session: &str, edit: Value) -> TestResult<()> {
    let state = call(client, "agent", "queue", json!({"sessionId": session})).await?;
    let rev = state["revision"].as_u64().ok_or("missing queue revision")?;
    let res = call(
        client,
        "agent",
        "editQueue",
        json!({ "sessionId": session, "expectedRevision": rev, "edit": edit }),
    )
    .await?;
    assert_eq!(res["kind"], "committed", "{res}");
    Ok(())
}

async fn attach_session_mcp(
    client: &HostClient,
    session: &str,
    servers: Value,
) -> TestResult<(LocalCall, Value)> {
    let mut sub = client
        .call(
            "agent",
            "sessionMcp".into(),
            json!({ "sessionId": session, "servers": servers }),
            Attachments::new(),
        )
        .await?;
    sub.start().await?;
    match sub.receive().await? {
        Reply::Subscribed => {}
        other => return Err(format!("expected Subscribed for sessionMcp, got {other:?}").into()),
    }
    match sub.pull().await? {
        Reply::Item { value } => Ok((sub, value)),
        other => Err(format!("expected Item for sessionMcp, got {other:?}").into()),
    }
}

#[cfg(unix)]
fn read_pids(path: &Path) -> TestResult<Vec<i32>> {
    Ok(std::fs::read_to_string(path)?
        .lines()
        .filter_map(|line| line.trim().parse::<i32>().ok())
        .collect())
}

#[cfg(unix)]
fn any_pid_alive(pids: &[i32]) -> bool {
    pids.iter().any(|&pid| {
        // SAFETY: kill with signal 0 only probes process existence.
        unsafe { libc::kill(pid, 0) == 0 }
    })
}

#[cfg(unix)]
async fn wait_pids_exited(pids: &[i32], context: &str) {
    assert!(!pids.is_empty(), "{context}: expected recorded pids");
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while any_pid_alive(pids) {
        assert!(
            std::time::Instant::now() < deadline,
            "{context}: PIDs {pids:?} stayed alive"
        );
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
}

/// Logs process PID to argv[2] and advertises a single tool named argv[3] (or zero tools if empty).
const NAMED_TOOL_SERVER: &str = r#"
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
appendFileSync(process.argv[2], `${process.pid}\n`);
const toolName = process.argv[3] || '';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  const reply = (result) => send({ jsonrpc: '2.0', id: message.id, result });
  if (message.method === 'initialize')
    reply({
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: toolName || 'zero', version: '1' },
    });
  else if (message.method === 'tools/list')
    reply({ tools: toolName ? [{ name: toolName, description: `Fixture ${toolName}`, inputSchema: { type: 'object' } }] : [] });
  else if (message.method === 'tools/call')
    reply({ content: [{ type: 'text', text: toolName }], isError: false });
});
"#;

/// WorkspaceWrite loads user MCP directly while preserving byte-identical static tool definitions
/// (KV prefix cache), supports project MCP Trust/Decline and Settings decisions (including legacy
/// merged-digest re-confirmation), skips corrupt project configs in ReadOnly, and filters
/// disallowed MCP tools out of <mcp_servers> for restricted sessions.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn workspace_write_mcp_consent_prefix_cache_and_read_only_isolation() -> TestResult<()> {
    let mut rig = Rig::new()?;
    let mut provider = Provider::start().await?;
    let base = rig.directory.path().to_path_buf();
    let outcome = AssertUnwindSafe(Box::pin(async {
        let script = base.join("crash-server.mjs");
        std::fs::write(&script, CRASH_SERVER)?;
        std::fs::create_dir_all(base.join("home/.maka"))?;
        let boot = bootstrap_with(&base, provider.server.base_url(), |config| {
            config["assistant"] = json!({"home": base.join("home")});
            config["toolDiscovery"] = json!(true);
        })
        .await?;
        attach(&mut rig, &boot).await?;
        let client = rig.client.as_ref().unwrap();
        let model = model(client, &provider.server.base_url(), true).await?;
        let session = create(client, &base, &model, None).await?["id"]
            .as_str()
            .ok_or("missing session id")?
            .to_owned();
        set_permissions(&rig, &session, "workspace_write", true).await?;
        let workspace_json = call(client, "agent", "observe", json!({"sessionId": session})).await?["session"]["workspace"].clone();

        // Turn 1: no MCP connected -> baseline static tools, no <mcp_servers>.
        let t1 = send(client, &session, "Baseline turn.").await?;
        let (req1, reply) = next_request(&mut provider, &rig, &session).await?;
        let baseline_tools = req1["tools"].clone();
        assert!(!last_message_text(&req1, "user").contains("<mcp_servers>"));
        finish_turn(client, &session, &t1, reply, "Baseline done.").await?;

        // Add globaldemo via Settings -> Turn 2 keeps static tools byte-identical, injects
        // <mcp_servers> append-only without polluting displayed history, and calls globaldemo directly.
        manage_mcp_server(
            client,
            None,
            "user:maka",
            "globaldemo",
            json!({"kind": "save", "configuration": stdio_entry(&script, &base.join("global-starts.log"), None, &base)}),
        )
        .await?;
        let t2 = send(client, &session, "Use globaldemo now.").await?;
        let (req2, reply) = next_request(&mut provider, &rig, &session).await?;
        assert_eq!(req2["tools"], baseline_tools, "adding MCP must not mutate static tool definitions");
        let t2_user = last_message_text(&req2, "user");
        assert!(t2_user.contains("<mcp_servers>") && t2_user.contains("mcp__globaldemo__echo"), "{t2_user}");
        reply.send_plan(exec_js("text(await tools.mcp__globaldemo__echo({ marker: 'ws-write-ok' }));"));
        let (req2_done, reply) = next_request(&mut provider, &rig, &session).await?;
        assert!(last_message_text(&req2_done, "tool").contains("ws-write-ok"));
        finish_turn(client, &session, &t2, reply, "Echoed.").await?;

        let history = call(
            client,
            "agent",
            "history",
            json!({"sessionId": session, "position": {"kind": "tail"}, "includeThinking": false, "view": "conversation"}),
        )
        .await?;
        let history_str = history.to_string();
        assert!(history_str.contains("Use globaldemo now.") && !history_str.contains("<mcp_servers>"));

        // Turn 3: unchanged MCP injects nothing.
        let t3 = send(client, &session, "Unchanged MCP turn.").await?;
        let (req3, reply) = next_request(&mut provider, &rig, &session).await?;
        assert_eq!(req3["tools"], baseline_tools);
        assert!(!last_message_text(&req3, "user").contains("<mcp_servers>"));
        finish_turn(client, &session, &t3, reply, "Done.").await?;

        // Project MCP consent: legacy merged proposal.revision requires one-time re-confirmation;
        // undecided blocks send; declineProjectMcp skips project without starting it; global edits
        // do not invalidate project decision; Settings setProjectMcpDecision flips to trusted.
        let proj_starts = base.join("proj-starts.log");
        let proj_path = base.join("workspace/.maka/mcp.json");
        write_mcp_json(&proj_path, json!({"http": {
            "type": "http", "url": "https://example.test/mcp?token=fixture-secret"
        }}))?;
        let http_view = call(client, "agent", "projectMcp", json!({"sessionId": session})).await?;
        assert_eq!(http_view["servers"][0]["launch"], "https://example.test/mcp");
        write_mcp_json(&proj_path, json!({ "proj": stdio_entry(&script, &proj_starts, None, &base) }))?;
        {
            let owner = rig.captured.lock().unwrap().clone().unwrap();
            let ws: crate::contract::Workspace = serde_json::from_value(workspace_json.clone())?;
            let proposal = owner.mcp_projects.proposal(&ws).await?;
            assert_ne!(Some(proposal.revision.as_str()), proposal.project_revision.as_deref());
            owner.mcp_projects.trust_project_revision(&ws, proposal.revision).await?;
        }
        let view = call(client, "agent", "projectMcp", json!({"sessionId": session})).await?;
        assert_eq!((&view["kind"], &view["trusted"], &view["declined"]), (&json!("configuration"), &json!(false), &json!(false)));
        let revision = view["revision"].as_str().unwrap().to_owned();
        assert!(
            call(client, "agent", "send", json!({"sessionId": session, "message": "Blocked."}))
                .await
                .is_err(),
            "undecided project MCP must require consent"
        );
        let declined = call(client, "agent", "declineProjectMcp", json!({"sessionId": session, "revision": revision})).await?;
        assert_eq!(declined["kind"], "declined", "{declined}");
        let cfg_list = call(client, "agent", "mcpConfigurations", json!({"workspace": workspace_json})).await?;
        assert_eq!((&cfg_list["projectTrust"]["decision"], &cfg_list["projectTrust"]["revision"]), (&json!("declined"), &json!(revision)));

        let mut global_touched = stdio_entry(&script, &base.join("global-starts.log"), None, &base);
        global_touched["env"] = json!({"TOUCHED": "1"});
        manage_mcp_server(client, None, "user:maka", "globaldemo", json!({"kind": "save", "configuration": global_touched})).await?;
        let view_after_global = call(client, "agent", "projectMcp", json!({"sessionId": session})).await?;
        assert_eq!((&view_after_global["declined"], &view_after_global["revision"]), (&json!(true), &json!(revision)));
        assert_eq!(started(&proj_starts), 0, "declined project MCP must not start");

        set_project_decision(client, &workspace_json, &revision, "trusted").await?;
        let t4 = send(client, &session, "Use trusted project MCP.").await?;
        let (req4, reply) = next_request(&mut provider, &rig, &session).await?;
        assert_eq!(req4["tools"], baseline_tools);
        assert!(last_message_text(&req4, "user").contains("mcp__proj__echo"));
        reply.send_plan(exec_js("text(await tools.mcp__proj__echo({ marker: 'proj-ok' }));"));
        let (req4_done, reply) = next_request(&mut provider, &rig, &session).await?;
        assert!(last_message_text(&req4_done, "tool").contains("proj-ok"));
        finish_turn(client, &session, &t4, reply, "Used proj.").await?;

        // Restricted session with empty tool allowlist must never leak disallowed mcp__* into <mcp_servers>.
        let restricted = call(
            client,
            "agent",
            "create",
            json!({
                "title": "Restricted empty tools",
                "labels": [],
                "tools": [],
                "backend": {"kind": "model", "connectionId": model["connectionId"], "modelId": model["modelId"]},
                "workspace": {"kind": "directory", "path": base.join("workspace")}
            }),
        )
        .await?["session"]["id"]
            .as_str()
            .ok_or("missing restricted session id")?
            .to_owned();
        set_permissions(&rig, &restricted, "workspace_write", false).await?;
        for msg in ["Restricted turn 1.", "Restricted turn 2."] {
            let msg_id = send(client, &restricted, msg).await?;
            let (req, reply) = next_request(&mut provider, &rig, &restricted).await?;
            let user_text = last_message_text(&req, "user");
            assert!(!user_text.contains("<mcp_servers>") && !user_text.contains("mcp__globaldemo__"), "{user_text}");
            finish_turn(client, &restricted, &msg_id, reply, "Done.").await?;
        }

        // ReadOnly skips corrupt project mcp.json cleanly so ordinary turns still succeed.
        set_permissions(&rig, &session, "read_only", false).await?;
        std::fs::write(&proj_path, "{corrupt-json")?;
        assert_eq!(call(client, "agent", "projectMcp", json!({"sessionId": session})).await?["kind"], "absent");
        let t5 = send(client, &session, "ReadOnly turn with corrupt mcp.json.").await?;
        let (_, reply) = next_request(&mut provider, &rig, &session).await?;
        finish_turn(client, &session, &t5, reply, "ReadOnly ok.").await?;
        Ok::<_, Box<dyn Error + Send + Sync>>(())
    }))
    .catch_unwind()
    .await;
    let cleanup = tokio::time::timeout(Duration::from_secs(30), rig.finish()).await?;
    match outcome {
        Ok(result) => result?,
        Err(panic) => std::panic::resume_unwind(panic),
    };
    assert!(cleanup.is_empty(), "{cleanup:?}");
    Ok(())
}

/// Deleting global or project MCP servers retires dependent idle project and ACP client snapshots
/// so superseded stdio processes exit promptly without dropping active sessionMcp subscriptions;
/// model-input <mcp_servers> projection stays accurate across queued follow-ups, editQueue(update),
/// and editQueue(retract).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mcp_snapshot_retirement_and_queued_followup_context() -> TestResult<()> {
    let mut rig = Rig::new()?;
    let mut provider = Provider::start().await?;
    let base = rig.directory.path().to_path_buf();
    let outcome = AssertUnwindSafe(Box::pin(async {
        let script = base.join("named-tool-server.mjs");
        std::fs::write(&script, NAMED_TOOL_SERVER)?;
        let global_pids = base.join("global-pids.log");
        let proj_pids = base.join("proj-pids.log");
        let client_pids = base.join("client-pids.log");

        write_mcp_json(
            &base.join("home/.maka/mcp.json"),
            json!({ "demo": stdio_entry(&script, &global_pids, Some("user_echo"), &base) }),
        )?;
        write_mcp_json(
            &base.join("workspace/.maka/mcp.json"),
            json!({ "demo": stdio_entry(&script, &proj_pids, Some("project_echo"), &base) }),
        )?;

        let boot = bootstrap_with(&base, provider.server.base_url(), |config| {
            config["assistant"] = json!({"home": base.join("home")});
            config["toolDiscovery"] = json!(false);
        })
        .await?;
        attach(&mut rig, &boot).await?;
        let client = rig.client.as_ref().unwrap();
        let model = model(client, &provider.server.base_url(), false).await?;
        let session = create(client, &base, &model, None).await?["id"]
            .as_str()
            .ok_or("missing session id")?
            .to_owned();
        set_permissions(&rig, &session, "danger_full_access", false).await?;
        let workspace_json = call(client, "agent", "observe", json!({"sessionId": session})).await?["session"]["workspace"].clone();
        let proj_rev = call(client, "agent", "projectMcp", json!({"sessionId": session}))
            .await?["revision"]
            .as_str()
            .unwrap()
            .to_owned();
        set_project_decision(client, &workspace_json, &proj_rev, "trusted").await?;

        let (mut session_mcp_sub, attached) = attach_session_mcp(
            client,
            &session,
            json!([{
                "name": "acpclient",
                "transport": { "type": "stdio", "command": "node", "args": [&script, &client_pids, "client_echo"], "cwd": &base }
            }]),
        )
        .await?;
        assert!(attached["tools"].as_array().is_some_and(|t| t.iter().any(|v| v == "mcp__acpclient__client_echo")));

        // Turn 1 starts project override + global parent + client overlay.
        let t1 = send(client, &session, "Initial turn with project override and client MCP.").await?;
        let (req1, reply) = next_request(&mut provider, &rig, &session).await?;
        let req1_user = last_message_text(&req1, "user");
        assert!(req1_user.contains("mcp__demo__project_echo") && req1_user.contains("mcp__acpclient__client_echo"));
        finish_turn(client, &session, &t1, reply, "Turn 1 done.").await?;

        // Delete project override while sessionMcp subscription stays open -> project PID must exit,
        // acpclient stays alive, and next turn switches to user_echo + client_echo.
        manage_mcp_server(client, Some(&workspace_json), "project:maka", "demo", json!({ "kind": "delete" })).await?;
        #[cfg(unix)]
        {
            wait_pids_exited(&read_pids(&proj_pids)?, "sessionMcp pinned project demo").await;
            assert!(any_pid_alive(&read_pids(&client_pids)?), "acpclient must stay alive while subscribed");
        }
        let proj_rev_after_del =
            call(client, "agent", "projectMcp", json!({"sessionId": session}))
                .await?["revision"]
                .as_str()
                .unwrap()
                .to_owned();
        set_project_decision(client, &workspace_json, &proj_rev_after_del, "trusted").await?;
        let t2 = send(client, &session, "Turn 2 after removing project override.").await?;
        let (req2, reply) = next_request(&mut provider, &rig, &session).await?;
        let req2_user = last_message_text(&req2, "user");
        assert!(
            req2_user.contains("<mcp_servers>")
                && req2_user.contains("mcp__demo__user_echo")
                && req2_user.contains("mcp__acpclient__client_echo")
                && !req2_user.contains("mcp__demo__project_echo"),
            "{req2_user}"
        );
        finish_turn(client, &session, &t2, reply, "Turn 2 done.").await?;

        // Detach ACP subscription, then delete global demo -> idle project + global snapshots retire.
        let _ = session_mcp_sub.cancel().await;
        session_mcp_sub.close().await?;
        manage_mcp_server(client, None, "user:maka", "demo", json!({ "kind": "delete" })).await?;
        #[cfg(unix)]
        wait_pids_exited(&read_pids(&global_pids)?, "idle project pinned global demo").await;

        // Queued follow-up with editQueue(update) preserves <mcp_servers> for newly added extra1.
        let t_active = send(client, &session, "Active turn before adding extra1.").await?;
        let (_, active_reply) = next_request(&mut provider, &rig, &session).await?;
        manage_mcp_server(
            client,
            None,
            "user:maka",
            "extra1",
            json!({"kind": "save", "configuration": stdio_entry(&script, &base.join("extra1-pids.log"), Some("extra1_tool"), &base)}),
        )
        .await?;
        let q_edit_id = enqueue_followup(client, &session, "Original queued message.").await?;
        edit_queue(client, &session, json!({"kind": "update", "messageId": q_edit_id, "message": "Edited queued message."})).await?;
        finish_turn(client, &session, &t_active, active_reply, "Active done.").await?;

        let (req_edited, reply_edited) = next_request(&mut provider, &rig, &session).await?;
        let edited_user = last_message_text(&req_edited, "user");
        assert!(
            edited_user.contains("Edited queued message.")
                && edited_user.contains("<mcp_servers>")
                && edited_user.contains("mcp__extra1__extra1_tool"),
            "{edited_user}"
        );

        // Retracting the first of two queued follow-ups still delivers <mcp_servers> to the survivor.
        manage_mcp_server(
            client,
            None,
            "user:maka",
            "extra2",
            json!({"kind": "save", "configuration": stdio_entry(&script, &base.join("extra2-pids.log"), Some("extra2_tool"), &base)}),
        )
        .await?;
        let q_first_id = enqueue_followup(client, &session, "First queued (retracted).").await?;
        let q_second_id = json!(enqueue_followup(client, &session, "Second queued (surviving).").await?);
        edit_queue(client, &session, json!({"kind": "retract", "messageId": q_first_id})).await?;
        finish_turn(client, &session, &json!(q_edit_id), reply_edited, "Edited done.").await?;

        let (req_second, reply_second) = next_request(&mut provider, &rig, &session).await?;
        let second_user = last_message_text(&req_second, "user");
        assert!(
            second_user.contains("Second queued (surviving).")
                && second_user.contains("<mcp_servers>")
                && second_user.contains("mcp__extra2__extra2_tool"),
            "{second_user}"
        );
        finish_turn(client, &session, &q_second_id, reply_second, "Second done.").await?;
        Ok::<_, Box<dyn Error + Send + Sync>>(())
    }))
    .catch_unwind()
    .await;
    let cleanup = tokio::time::timeout(Duration::from_secs(30), rig.finish()).await?;
    match outcome {
        Ok(result) => result?,
        Err(panic) => std::panic::resume_unwind(panic),
    };
    assert!(cleanup.is_empty(), "{cleanup:?}");
    Ok(())
}

fn parse_tool_json(request: &Value) -> TestResult<Value> {
    let msg: Value = serde_json::from_str(&last_message_text(request, "tool"))?;
    Ok(serde_json::from_str(
        msg["content"]
            .as_str()
            .ok_or("missing tool content string")?,
    )?)
}

fn read_json_file(path: &Path) -> TestResult<Value> {
    Ok(serde_json::from_str(&std::fs::read_to_string(path)?)?)
}

async fn await_service_approval(client: &HostClient, session: &str) -> TestResult<Value> {
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let pending = call(
                client,
                "agent",
                "pendingInteractions",
                json!({"sessionId": session}),
            )
            .await?;
            if let Some(entry) = pending["entries"]
                .as_array()
                .and_then(|entries| entries.first())
            {
                assert_eq!(entry["kind"], "service_approval", "{entry}");
                return Ok::<_, Box<dyn Error + Send + Sync>>(entry.clone());
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await?
}

async fn verify_approval_source(
    client: &HostClient,
    session: &str,
    request_id: &str,
    tool_name: &str,
    needle: &str,
) -> TestResult<()> {
    let detail = call(
        client,
        "agent",
        "interaction",
        json!({"sessionId": session, "requestId": request_id}),
    )
    .await?;
    assert_eq!(detail["request"]["toolName"], tool_name, "{detail}");
    assert_eq!(detail["request"]["service"], "mcp", "{detail}");
    let args_page = call(
        client,
        "agent",
        "source",
        json!({
            "sessionId": session,
            "through": detail["request"]["through"],
            "source": { "kind": "tool_use", "toolUseId": detail["request"]["toolUseId"] },
            "field": "arguments",
            "position": {"kind": "start"}
        }),
    )
    .await?;
    assert_eq!(args_page["kind"], "ready", "{args_page}");
    assert_eq!(
        args_page["source"]["tool"]["call"]["name"], tool_name,
        "{args_page}"
    );
    assert!(
        args_page["source"]["text"]
            .as_str()
            .is_some_and(|text| text.contains(needle)),
        "service_approval must resolve original tool arguments containing {needle:?}: {args_page}"
    );
    Ok(())
}

async fn allow_service_approval(
    client: &HostClient,
    session: &str,
    request_id: &str,
) -> TestResult<()> {
    let responded = call(
        client,
        "agent",
        "respond",
        json!({
            "sessionId": session,
            "requestId": request_id,
            "answer": {"kind": "service_approval", "decision": "allow"}
        }),
    )
    .await?;
    assert_eq!(responded["kind"], "recorded", "{responded}");
    Ok(())
}

/// Full-access sessions can install, list (masked), update (preserving secrets),
/// and uninstall MCP servers via Agent tools without approval prompts, live-verifying
/// before saving while keeping static tool definitions byte-identical (prefix cache).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn agent_mcp_crud_tools_preserve_prefix_cache_and_apply_on_next_turn() -> TestResult<()> {
    let mut rig = Rig::new()?;
    let mut provider = Provider::start().await?;
    let base = rig.directory.path().to_path_buf();
    let outcome = AssertUnwindSafe(Box::pin(async {
        std::fs::write(base.join("crash-server.mjs"), CRASH_SERVER)?;
        std::fs::create_dir_all(base.join("home/.maka"))?;
        let boot = bootstrap_with(&base, provider.server.base_url(), |config| {
            config["assistant"] = json!({"home": base.join("home")});
            config["toolDiscovery"] = json!(true);
        })
        .await?;
        attach(&mut rig, &boot).await?;
        let client = rig.client.as_ref().unwrap();
        let model = model(client, &provider.server.base_url(), true).await?;
        let session = full_access_session(&rig, &base, &model).await?;

        // Turn 1: broken command fails verification without writing; valid server installs cleanly.
        let t1 = send(client, &session, "Install demo MCP server.").await?;
        let (req1, reply) = next_request(&mut provider, &rig, &session).await?;
        let baseline_tools = req1["tools"].clone();
        assert!(!last_message_text(&req1, "user").contains("<mcp_servers>"), "{req1}");
        reply.send_plan(exec_js(
            "text(await tools.McpInstall({ name: 'broken', command: '/nonexistent/maka-mcp-missing-bin' }));",
        ));
        let (req1_broken, reply) = next_request(&mut provider, &rig, &session).await?;
        assert!(last_message_text(&req1_broken, "tool").contains("verification failed (not saved)"));
        assert!(!base.join("home/.maka/mcp.json").exists());

        reply.send_plan(exec_js(format!(
            "text(await tools.McpInstall({{ name: 'demo', command: 'node', args: [{:?}, {:?}], cwd: {:?}, env: {{ SECRET_TOKEN: 'top-secret-42' }} }}));",
            base.join("crash-server.mjs").to_string_lossy(),
            base.join("demo-starts.log").to_string_lossy(),
            base.to_string_lossy(),
        )));
        let (req1_installed, reply) = next_request(&mut provider, &rig, &session).await?;
        let install_out = last_message_text(&req1_installed, "tool");
        assert!(
            install_out.contains("installed")
                && install_out.contains("mcp__demo__echo")
                && install_out.contains("next_turn"),
            "{install_out}"
        );
        finish_turn(client, &session, &t1, reply, "Installed demo.").await?;

        // Turn 2: static tool prefix stays byte-identical; newly installed MCP tool is callable.
        let t2 = send(client, &session, "Use demo MCP now.").await?;
        let (req2, reply) = next_request(&mut provider, &rig, &session).await?;
        assert_eq!(req2["tools"], baseline_tools);
        let t2_user = last_message_text(&req2, "user");
        assert!(t2_user.contains("<mcp_servers>") && t2_user.contains("mcp__demo__echo"), "{t2_user}");
        reply.send_plan(exec_js("text(await tools.mcp__demo__echo({ marker: 'dynamic-ok' }));"));
        let (req2_call, reply) = next_request(&mut provider, &rig, &session).await?;
        assert!(last_message_text(&req2_call, "tool").contains("dynamic-ok"));
        finish_turn(client, &session, &t2, reply, "Echoed.").await?;

        // Turn 3: McpList masks secrets/args; McpUpdate preserves secret; McpUninstall retires PID.
        let t3 = send(client, &session, "Inspect, update, and uninstall demo.").await?;
        let (req3, reply) = next_request(&mut provider, &rig, &session).await?;
        assert_eq!(req3["tools"], baseline_tools);
        assert!(!last_message_text(&req3, "user").contains("<mcp_servers>"));
        reply.send_plan(exec_js("text(await tools.McpList({}));"));
        let (req3_list, reply) = next_request(&mut provider, &rig, &session).await?;
        let list_out = last_message_text(&req3_list, "tool");
        assert!(
            list_out.contains("SECRET_TOKEN")
                && !list_out.contains("top-secret-42")
                && !list_out.contains("crash-server.mjs")
                && list_out.contains("argCount")
                && list_out.contains("mcp__demo__echo"),
            "{list_out}"
        );
        reply.send_plan(exec_js("text(await tools.McpUpdate({ name: 'demo', env: { EXTRA_FLAG: '1' } }));"));
        let (req3_upd, reply) = next_request(&mut provider, &rig, &session).await?;
        assert!(last_message_text(&req3_upd, "tool").contains("updated"));
        let disk_upd = read_json_file(&base.join("home/.maka/mcp.json"))?;
        assert_eq!(disk_upd["mcpServers"]["demo"]["env"]["SECRET_TOKEN"], "top-secret-42");
        assert_eq!(disk_upd["mcpServers"]["demo"]["env"]["EXTRA_FLAG"], "1");

        reply.send_plan(exec_js("text(await tools.McpUninstall({ name: 'demo' }));"));
        let (req3_del, reply) = next_request(&mut provider, &rig, &session).await?;
        assert!(last_message_text(&req3_del, "tool").contains("uninstalled"));
        finish_turn(client, &session, &t3, reply, "Uninstalled.").await?;

        #[cfg(unix)]
        wait_pids_exited(&read_pids(&base.join("demo-starts.log"))?, "uninstalled demo").await;

        // Turn 4: clean project install without .maka/cwd and HTTP query token redaction in McpList.
        let t4 = send(client, &session, "Install into clean project.").await?;
        let (req4, reply) = next_request(&mut provider, &rig, &session).await?;
        assert_eq!(req4["tools"], baseline_tools);
        assert!(last_message_text(&req4, "user").contains("No external MCP servers are currently connected"));
        reply.send_plan(exec_js(format!(
            "const r1 = await tools.McpInstall({{ name: 'cleanproj', scope: 'project', command: 'node', args: [{:?}, {:?}] }}); const r2 = await tools.McpInstall({{ name: 'secrethttp', url: 'https://mcp.example.test:8443/v1?api_key=leak-me', skipVerify: true }}); const r3 = await tools.McpList({{}}); text({{ r1, r2, r3 }});",
            base.join("crash-server.mjs").to_string_lossy(),
            base.join("cleanproj-starts.log").to_string_lossy(),
        )));
        let (req4_done, reply) = next_request(&mut provider, &rig, &session).await?;
        let t4_out = last_message_text(&req4_done, "tool");
        assert!(t4_out.contains("cleanproj") && t4_out.contains("mcp__cleanproj__echo"), "{t4_out}");
        assert!(t4_out.contains("https://mcp.example.test:8443") && !t4_out.contains("leak-me"), "{t4_out}");
        finish_turn(client, &session, &t4, reply, "Confirmed.").await?;
        assert!(read_json_file(&base.join("home/.maka/mcp.json"))?["mcpServers"]["demo"].is_null());
        Ok::<_, Box<dyn Error + Send + Sync>>(())
    }))
    .catch_unwind()
    .await;
    let cleanup = tokio::time::timeout(Duration::from_secs(30), rig.finish()).await?;
    assert!(cleanup.is_empty(), "{cleanup:?}");
    match outcome {
        Ok(result) => result?,
        Err(panic) => std::panic::resume_unwind(panic),
    };
    Ok(())
}

/// Verifies WorkspaceWrite service_approval (single-turn & multi-turn source args), declined
/// workspace non-auto-trust & non-shadowing in McpList, atomic trust advancement (no inheritance
/// after mid-approval revoke), Code Mode and Direct-mode CAS protection, ReadOnly denial, and
/// read-only recovery Run floor enforcement on DangerFullAccess Sessions.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn workspace_write_mcp_tool_approvals_cas_and_read_only_floor() -> TestResult<()> {
    let mut rig = Rig::new()?;
    let mut provider = Provider::start().await?;
    let base = rig.directory.path().to_path_buf();
    let outcome = AssertUnwindSafe(Box::pin(async {
        let script = base.join("crash-server.mjs");
        std::fs::write(&script, CRASH_SERVER)?;
        std::fs::create_dir_all(base.join("home/.maka"))?;
        let boot = bootstrap_with(&base, provider.server.base_url(), |config| {
            config["assistant"] = json!({"home": base.join("home")});
            config["toolDiscovery"] = json!(false);
        })
        .await?;
        attach(&mut rig, &boot).await?;
        let client = rig.client.as_ref().unwrap();
        let code_model = model(client, &provider.server.base_url(), true).await?;
        let catalog = call(client, "settings", "connections", json!({"kind": "start"})).await?;
        let direct_conn = call(
            client,
            "settings",
            "create",
            json!({
                "expectedCatalogRevision": catalog["revision"],
                "connection": {
                    "slug": "acceptance-direct",
                    "name": "Acceptance direct fixture",
                    "provider": {"packageId": "maka.providers", "entryId": "maka.providers", "scope": "profile", "name": "ollama"},
                    "configuration": {"baseUrl": provider.server.base_url()},
                    "enabled": true,
                    "enabledModelIds": ["llama3.2"],
                    "modelOverrides": {"llama3.2": {"codeMode": false, "apiProtocol": "openai-chat-completions"}}
                }
            }),
        )
        .await?;
        assert_eq!(direct_conn["kind"], "committed", "{direct_conn}");
        let direct_model = json!({"connectionId": direct_conn["connection"]["connectionId"], "modelId": "llama3.2"});
        let session = create(client, &base, &code_model, None).await?["id"]
            .as_str()
            .ok_or("missing session id")?
            .to_owned();
        set_permissions(&rig, &session, "workspace_write", true).await?;
        let ws_obj = call(client, "agent", "observe", json!({"sessionId": session})).await?["session"]["workspace"].clone();

        // 1. WorkspaceWrite McpInstall prompts service_approval and resolves original arguments.
        let t1 = send(client, &session, "Install globaldemo.").await?;
        let (_, reply) = next_request(&mut provider, &rig, &session).await?;
        reply.send_plan(exec_js(format!(
            "text(await tools.McpInstall({{ name: 'globaldemo', command: 'node', args: [{:?}, {:?}], cwd: {:?} }}));",
            script.to_string_lossy(),
            base.join("global-starts.log").to_string_lossy(),
            base.to_string_lossy(),
        )));
        let ap1 = await_service_approval(client, &session).await?;
        let ap1_id = ap1["requestId"].as_str().unwrap();
        verify_approval_source(client, &session, ap1_id, "McpInstall", "globaldemo").await?;
        allow_service_approval(client, &session, ap1_id).await?;
        let (req1_done, reply) = next_request(&mut provider, &rig, &session).await?;
        assert!(last_message_text(&req1_done, "tool").contains("installed"));
        finish_turn(client, &session, &t1, reply, "Installed.").await?;

        // 2. Declined project: disabled same-name entry must not shadow user globaldemo in McpList,
        // and approving one project McpInstall must NOT auto-trust the declined workspace.
        let proj_starts = base.join("proj-starts.log");
        let proj_path = base.join("workspace/.maka/mcp.json");
        let mut disabled_global = stdio_entry(&script, &proj_starts, None, &base);
        disabled_global["disabled"] = json!(true);
        write_mcp_json(&proj_path, json!({
            "proj": stdio_entry(&script, &proj_starts, None, &base),
            "globaldemo": disabled_global,
        }))?;
        let rev0 = call(client, "agent", "projectMcp", json!({"sessionId": session}))
            .await?["revision"]
            .as_str()
            .unwrap()
            .to_owned();
        call(client, "agent", "declineProjectMcp", json!({"sessionId": session, "revision": rev0})).await?;

        let t2 = send(client, &session, "Check McpList and install safe server.").await?;
        let (_, reply) = next_request(&mut provider, &rig, &session).await?;
        reply.send_plan(exec_js("text(await tools.McpList({}));"));
        let (req2_list, reply) = next_request(&mut provider, &rig, &session).await?;
        let t2_content = req2_list["messages"]
            .as_array()
            .and_then(|msgs| msgs.iter().rev().find(|m| m["role"] == "tool"))
            .and_then(|m| m["content"].as_str())
            .ok_or("missing tool content")?;
        let list_payload: Value = serde_json::from_str(t2_content.lines().nth(1).ok_or("missing payload line")?)?;
        let user_global = list_payload["servers"]
            .as_array()
            .and_then(|s| s.iter().find(|e| e["name"] == "globaldemo" && e["scope"] == "user"))
            .ok_or("missing user globaldemo")?;
        assert_eq!((&user_global["active"], &user_global["connected"]), (&json!(true), &json!(true)));
        assert!(user_global["shadowedBy"].is_null());

        reply.send_plan(exec_js(format!(
            "text(await tools.McpInstall({{ name: 'safe', scope: 'project', command: 'node', args: [{:?}, {:?}], cwd: {:?} }}));",
            script.to_string_lossy(),
            base.join("safe-starts.log").to_string_lossy(),
            base.to_string_lossy(),
        )));
        let ap_safe = await_service_approval(client, &session).await?;
        allow_service_approval(client, &session, ap_safe["requestId"].as_str().unwrap()).await?;
        let (req2_safe, reply) = next_request(&mut provider, &rig, &session).await?;
        assert!(last_message_text(&req2_safe, "tool").contains("installed"));
        finish_turn(client, &session, &t2, reply, "Installed safe.").await?;
        assert_eq!(started(&proj_starts), 0, "declined project MCP must not start");
        assert_eq!(call(client, "agent", "projectMcp", json!({"sessionId": session})).await?["trusted"], false);

        // 3. Multi-turn service_approval resolves original arguments via session-wide sequence,
        // and Code Mode McpUpdate CAS rejects concurrent disk edits during approval.
        let rev_safe = call(client, "agent", "projectMcp", json!({"sessionId": session}))
            .await?["revision"]
            .as_str()
            .unwrap()
            .to_owned();
        set_project_decision(client, &ws_obj, &rev_safe, "declined").await?;
        let t3 = send(client, &session, "Multi-turn update.").await?;
        let (_, reply) = next_request(&mut provider, &rig, &session).await?;
        reply.send_plan(exec_js("text(await tools.McpUpdate({ name: 'globaldemo', scope: 'user', env: { MULTI_TURN: 'ok' } }));"));
        let ap3 = await_service_approval(client, &session).await?;
        let ap3_id = ap3["requestId"].as_str().unwrap();
        verify_approval_source(client, &session, ap3_id, "McpUpdate", "MULTI_TURN").await?;
        allow_service_approval(client, &session, ap3_id).await?;
        let (req3_done, reply) = next_request(&mut provider, &rig, &session).await?;
        assert!(last_message_text(&req3_done, "tool").contains("updated"));
        finish_turn(client, &session, &t3, reply, "Updated.").await?;

        let global_path = base.join("home/.maka/mcp.json");
        let global_starts = base.join("global-starts.log");
        let t3b = send(client, &session, "Code Mode CAS test.").await?;
        let (_, reply) = next_request(&mut provider, &rig, &session).await?;
        reply.send_plan(exec_js("text(await tools.McpUpdate({ name: 'globaldemo', scope: 'user', env: { CAS_TRY: '1' } }));"));
        let ap3b = await_service_approval(client, &session).await?;
        let starts_before_cas = started(&global_starts);
        let mut gdoc = read_json_file(&global_path)?;
        gdoc["mcpServers"]["globaldemo"]["env"]["CONCURRENT"] = json!("from-settings");
        std::fs::write(&global_path, gdoc.to_string())?;
        allow_service_approval(client, &session, ap3b["requestId"].as_str().unwrap()).await?;
        let (req3b_done, reply) = next_request(&mut provider, &rig, &session).await?;
        assert!(last_message_text(&req3b_done, "tool").contains("changed on disk"));
        assert_eq!(
            started(&global_starts),
            starts_before_cas,
            "Code Mode pre-probe CAS must reject BEFORE spawning verify_server"
        );
        let disk_cas = read_json_file(&global_path)?;
        assert!(disk_cas["mcpServers"]["globaldemo"]["env"]["CAS_TRY"].is_null());
        assert_eq!(disk_cas["mcpServers"]["globaldemo"]["env"]["CONCURRENT"], "from-settings");
        finish_turn(client, &session, &t3b, reply, "CAS rejected.").await?;

        // 4. ReadOnly denies McpInstall; DangerFullAccess recovery Run floor denies all 3 mutations.
        set_permissions(&rig, &session, "read_only", false).await?;
        let t4 = send(client, &session, "ReadOnly install denied.").await?;
        let (_, reply) = next_request(&mut provider, &rig, &session).await?;
        reply.send_plan(exec_js(
            "text(await tools.McpInstall({ name: 'nope', command: 'node', args: ['-v'], skipVerify: true }));",
        ));
        let (req4_done, reply) = next_request(&mut provider, &rig, &session).await?;
        assert!(last_message_text(&req4_done, "tool").contains("read-only"));
        finish_turn(client, &session, &t4, reply, "Denied.").await?;

        std::fs::remove_file(&proj_path)?;
        set_permissions(&rig, &session, "danger_full_access", false).await?;
        let _t5 = send(client, &session, "Baseline for recovery floor.").await?;
        let (_, t5_reply) = next_request(&mut provider, &rig, &session).await?;
        let prepared_recovery = {
            let owner = rig.captured.lock().unwrap().clone().unwrap();
            let latest = owner.latest_session_run(&session).await?.ok_or("missing latest run")?;
            let source = maka_agent_facts::durable::ExecutionIdentity {
                session_id: latest.spec.session_id.clone(),
                turn_id: latest.spec.turn_id.clone(),
                run_id: latest.run,
            };
            let route = owner.return_route(&source).await?;
            let req_id = crate::owner::external_recovery::recovery_request_id(latest.run);
            owner
                .prepare_notification_checked(
                    &session,
                    &route,
                    &req_id,
                    |_| "Continue after recovery.".into(),
                    maka_agent_facts::message::MessageOrigin::Session { execution: source.clone() },
                    maka_agent_state::queue::Placement::Followup,
                    None,
                    maka_agent_facts::durable::UnixMillis(crate::owner::now() as i64),
                )
                .await
                .map_err(String::from)?
                .ok_or("missing prepared recovery request")?
        };
        assert!(!crate::mcp::floor_allows_mcp(&prepared_recovery.spec.permission_ceiling.sandbox));
        t5_reply.reply_text("Ready.");
        let (_, reply) = next_request(&mut provider, &rig, &session).await?;
        reply.send_plan(exec_js(
            "const out = []; for (const [k, fn] of [['install', () => tools.McpInstall({ name: 'escaped', command: 'node', args: ['-v'], skipVerify: true })], ['update', () => tools.McpUpdate({ name: 'globaldemo', env: { ESC: '1' }, skipVerify: true })], ['uninstall', () => tools.McpUninstall({ name: 'globaldemo' })]]) { try { const r = await fn(); out.push(k + ':ok:' + JSON.stringify(r)); } catch (e) { out.push(k + ':err:' + String(e)); } } text(out);",
        ));
        let (req5_done, reply) = next_request(&mut provider, &rig, &session).await?;
        let rec_out = last_message_text(&req5_done, "tool");
        assert!(
            rec_out.contains("install:")
                && rec_out.contains("update:")
                && rec_out.contains("uninstall:")
                && !rec_out.contains(":ok")
                && rec_out.contains("read-only run"),
            "{rec_out}"
        );
        reply.reply_text("Recovery read-only enforced.");
        tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                let obs = call(client, "agent", "observe", json!({"sessionId": session})).await?;
                if obs["session"]["activity"] == "idle" && obs["run"].is_null() {
                    return Ok::<_, Box<dyn Error + Send + Sync>>(());
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await??;

        // 5. Direct-mode session: revoking trust mid-approval blocks post-write trust inheritance,
        // and concurrent Settings edit during approval fails Direct resume via approval identity binding.
        let mut disabled_proj = stdio_entry(&script, &proj_starts, None, &base);
        disabled_proj["disabled"] = json!(true);
        write_mcp_json(&proj_path, json!({ "projdemo": disabled_proj }))?;
        let direct_session = create(client, &base, &direct_model, None).await?["id"]
            .as_str()
            .ok_or("missing direct session id")?
            .to_owned();
        set_permissions(&rig, &direct_session, "workspace_write", true).await?;
        let proj_rev_1 = call(client, "agent", "projectMcp", json!({"sessionId": direct_session}))
            .await?["revision"]
            .as_str()
            .unwrap()
            .to_owned();
        set_project_decision(client, &ws_obj, &proj_rev_1, "trusted").await?;

        let t_rev = send(client, &direct_session, "Update projdemo while trust gets revoked.").await?;
        let (_, reply) = next_request(&mut provider, &rig, &direct_session).await?;
        reply.send_plan(tool_response(
            "McpUpdate",
            json!({"name": "projdemo", "scope": "project", "env": {"REVOKE_TEST": "1"}, "skipVerify": true}),
        ));
        let rev_ap = await_service_approval(client, &direct_session).await?;
        set_project_decision(client, &ws_obj, &proj_rev_1, "declined").await?;
        allow_service_approval(client, &direct_session, rev_ap["requestId"].as_str().unwrap()).await?;
        let (req_rev, reply) = next_request(&mut provider, &rig, &direct_session).await?;
        assert!(last_message_text(&req_rev, "tool").contains("updated"));
        finish_turn(client, &direct_session, &t_rev, reply, "Updated.").await?;
        let post_rev = call(client, "agent", "projectMcp", json!({"sessionId": direct_session})).await?;
        assert_eq!((&post_rev["trusted"], &post_rev["declined"]), (&json!(false), &json!(false)));
        let proj_rev_2 = post_rev["revision"].as_str().unwrap().to_owned();
        set_project_decision(client, &ws_obj, &proj_rev_2, "trusted").await?;

        let t_dcas = send(client, &direct_session, "Direct McpUpdate CAS conflict.").await?;
        let (_, reply) = next_request(&mut provider, &rig, &direct_session).await?;
        reply.send_plan(tool_response(
            "McpUpdate",
            json!({"name": "projdemo", "scope": "project", "env": {"DIRECT_CAS": "nope"}, "skipVerify": true}),
        ));
        let dcas_ap = await_service_approval(client, &direct_session).await?;
        let mut settings_proj = stdio_entry(&script, &proj_starts, None, &base);
        settings_proj["disabled"] = json!(true);
        settings_proj["env"] = json!({"SETTINGS_WINS": "yes"});
        manage_mcp_server(client, Some(&ws_obj), "project:maka", "projdemo", json!({"kind": "save", "configuration": settings_proj})).await?;
        let proj_rev_3 = call(client, "agent", "projectMcp", json!({"sessionId": direct_session}))
            .await?["revision"]
            .as_str()
            .unwrap()
            .to_owned();
        set_project_decision(client, &ws_obj, &proj_rev_3, "trusted").await?;
        allow_service_approval(client, &direct_session, dcas_ap["requestId"].as_str().unwrap()).await?;
        let (req_dcas, reply) = next_request(&mut provider, &rig, &direct_session).await?;
        assert!(last_message_text(&req_dcas, "tool").contains("differs from the original approval"));
        let disk_proj = read_json_file(&proj_path)?;
        assert!(disk_proj["mcpServers"]["projdemo"]["env"]["DIRECT_CAS"].is_null());
        assert_eq!(disk_proj["mcpServers"]["projdemo"]["env"]["SETTINGS_WINS"], "yes");
        finish_turn(client, &direct_session, &t_dcas, reply, "Direct CAS rejected.").await?;
        Ok::<_, Box<dyn Error + Send + Sync>>(())
    }))
    .catch_unwind()
    .await;
    let cleanup = tokio::time::timeout(Duration::from_secs(30), rig.finish()).await?;
    match outcome {
        Ok(result) => result?,
        Err(panic) => std::panic::resume_unwind(panic),
    };
    assert!(cleanup.is_empty(), "{cleanup:?}");
    Ok(())
}

/// Verifies McpList per-server config-digest attribution across in-place McpUpdate, same-name
/// project/user layer override uninstall, zero-tool file & ACP client servers, and retiringServers.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mcp_list_attribution_and_retiring_servers() -> TestResult<()> {
    let mut rig = Rig::new()?;
    let mut provider = Provider::start().await?;
    let base = rig.directory.path().to_path_buf();
    let outcome = AssertUnwindSafe(Box::pin(async {
        let script = base.join("named-tool-server.mjs");
        std::fs::write(&script, NAMED_TOOL_SERVER)?;
        let user_pids = base.join("user-demo-pids.log");
        let proj_pids = base.join("proj-demo-pids.log");
        let zero_file_pids = base.join("zero-file-pids.log");
        let client_pids = base.join("client-acp-pids.log");
        let zero_client_pids = base.join("zero-client-pids.log");

        write_mcp_json(
            &base.join("home/.maka/mcp.json"),
            json!({ "demo": stdio_entry(&script, &user_pids, Some("user_echo"), &base) }),
        )?;
        write_mcp_json(
            &base.join("workspace/.maka/mcp.json"),
            json!({
                "demo": stdio_entry(&script, &proj_pids, Some("project_echo"), &base),
                "zerofile": stdio_entry(&script, &zero_file_pids, Some(""), &base),
            }),
        )?;

        let boot = bootstrap_with(&base, provider.server.base_url(), |config| {
            config["assistant"] = json!({"home": base.join("home")});
            config["toolDiscovery"] = json!(false);
        })
        .await?;
        attach(&mut rig, &boot).await?;
        let client = rig.client.as_ref().unwrap();
        let model = model(client, &provider.server.base_url(), false).await?;
        let session = create(client, &base, &model, None).await?["id"]
            .as_str()
            .ok_or("missing session id")?
            .to_owned();
        set_permissions(&rig, &session, "danger_full_access", false).await?;
        let proj_rev = call(client, "agent", "projectMcp", json!({"sessionId": session}))
            .await?["revision"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_eq!(
            call(client, "agent", "trustProjectMcp", json!({"sessionId": session, "revision": proj_rev})).await?["kind"],
            "trusted"
        );

        let (mut session_mcp_sub, _) = attach_session_mcp(
            client,
            &session,
            json!([
                { "name": "acpclient", "transport": { "type": "stdio", "command": "node", "args": [&script, &client_pids, "client_echo"], "cwd": &base } },
                { "name": "zeroclient", "transport": { "type": "stdio", "command": "node", "args": [&script, &zero_client_pids, ""], "cwd": &base } }
            ]),
        )
        .await?;

        let t1 = send(client, &session, "Update then uninstall project demo override and list.").await?;
        let (_, reply) = next_request(&mut provider, &rig, &session).await?;
        let updated_cwd = base.join("workspace").to_string_lossy().into_owned();
        reply.send_plan(tool_response(
            "McpUpdate",
            json!({
                "name": "demo",
                "scope": "project",
                "args": [&script, base.join("proj-demo-updated-pids.log"), "new_echo"],
                "cwd": &updated_cwd
            }),
        ));
        let (req1_upd, reply) = next_request(&mut provider, &rig, &session).await?;
        let upd_out = last_message_text(&req1_upd, "tool");
        assert!(upd_out.contains("updated") && upd_out.contains("new_echo"), "{upd_out}");

        reply.send_plan(tool_response("McpList", json!({})));
        let (req1_list1, reply) = next_request(&mut provider, &rig, &session).await?;
        let list1 = parse_tool_json(&req1_list1)?;
        let proj_row = list1["servers"].as_array().unwrap().iter().find(|s| s["location"] == "project:maka" && s["name"] == "demo").unwrap();
        assert_eq!((&proj_row["active"], &proj_row["connected"], &proj_row["tools"]), (&json!(true), &json!(false), &json!([])));
        assert_eq!(proj_row["transport"]["cwd"], updated_cwd);
        let zerofile_row = list1["servers"].as_array().unwrap().iter().find(|s| s["location"] == "project:maka" && s["name"] == "zerofile").unwrap();
        assert_eq!((&zerofile_row["connected"], &zerofile_row["tools"]), (&json!(true), &json!([])));
        assert!(list1["retiringServers"].as_array().unwrap().iter().any(|e| {
            e["name"] == "demo" && e["scope"] == "project" && e["location"] == "project:maka" && e["retiring"] == true && e["tools"] == json!(["mcp__demo__project_echo"])
        }));
        assert!(list1["clientServers"].as_array().unwrap().iter().any(|e| {
            e["name"] == "zeroclient" && e["scope"] == "client" && e["connected"] == true && e["tools"] == json!([])
        }));

        reply.send_plan(tool_response("McpUninstall", json!({"name": "demo", "scope": "project"})));
        let (req1_del, reply) = next_request(&mut provider, &rig, &session).await?;
        assert!(last_message_text(&req1_del, "tool").contains("uninstalled"));
        reply.send_plan(tool_response("McpList", json!({})));
        let (req1_list2, reply) = next_request(&mut provider, &rig, &session).await?;
        let list2 = parse_tool_json(&req1_list2)?;
        let user_row = list2["servers"].as_array().unwrap().iter().find(|s| s["location"] == "user:maka" && s["name"] == "demo").unwrap();
        assert_eq!((&user_row["active"], &user_row["connected"], &user_row["tools"]), (&json!(true), &json!(false), &json!([])));
        assert!(list2["retiringServers"].as_array().unwrap().iter().any(|e| {
            e["name"] == "demo" && e["location"] == "project:maka" && e["tools"] == json!(["mcp__demo__project_echo"])
        }));
        assert!(list2["clientServers"].as_array().unwrap().iter().any(|e| {
            e["name"] == "acpclient" && e["connected"] == true && e["tools"] == json!(["mcp__acpclient__client_echo"])
        }));
        assert_eq!(list2["installationServers"], json!([]));
        finish_turn(client, &session, &t1, reply, "Done.").await?;

        #[cfg(unix)]
        {
            wait_pids_exited(&read_pids(&proj_pids)?, "sessionMcp pinned project demo").await;
            assert!(any_pid_alive(&read_pids(&client_pids)?));
        }

        let _ = session_mcp_sub.cancel().await;
        session_mcp_sub.close().await?;
        Ok::<_, Box<dyn Error + Send + Sync>>(())
    }))
    .catch_unwind()
    .await;
    let cleanup = tokio::time::timeout(Duration::from_secs(30), rig.finish()).await?;
    match outcome {
        Ok(result) => result?,
        Err(panic) => std::panic::resume_unwind(panic),
    };
    assert!(cleanup.is_empty(), "{cleanup:?}");
    Ok(())
}

/// McpList checks live Connection::available() so exited zero-tool File, ACP Client, and
/// Installation servers stop reporting connected: true in the current and next Runs.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mcp_list_omits_exited_zero_tool_servers_across_layers() -> TestResult<()> {
    let mut rig = Rig::new()?;
    let mut provider = Provider::start().await?;
    let base = rig.directory.path().to_path_buf();
    let outcome = AssertUnwindSafe(Box::pin(async {
        let script = base.join("named-tool-server.mjs");
        std::fs::write(&script, NAMED_TOOL_SERVER)?;
        std::fs::create_dir_all(base.join("workspace"))?;
        let file_pids = base.join("zero-file-exit.log");
        let client_pids = base.join("zero-client-exit.log");
        let install_pids = base.join("zero-install-exit.log");

        write_mcp_json(
            &base.join("home/.maka/mcp.json"),
            json!({ "zerofile": stdio_entry(&script, &file_pids, Some(""), &base) }),
        )?;
        let boot = bootstrap_with(&base, provider.server.base_url(), |config| {
            config["assistant"] = json!({"home": base.join("home")});
            config["toolDiscovery"] = json!(false);
            config["mcpServers"] = json!([{
                "name": "zeroinstall",
                "transport": { "type": "stdio", "command": "node", "args": [&script, &install_pids, ""], "cwd": &base }
            }]);
        })
        .await?;
        attach(&mut rig, &boot).await?;
        let client = rig.client.as_ref().unwrap();
        let model = model(client, &provider.server.base_url(), false).await?;
        let session = create(client, &base, &model, None).await?["id"]
            .as_str()
            .ok_or("missing session id")?
            .to_owned();
        set_permissions(&rig, &session, "danger_full_access", false).await?;

        let (mut session_mcp_sub, _) = attach_session_mcp(
            client,
            &session,
            json!([{
                "name": "zeroclient",
                "transport": { "type": "stdio", "command": "node", "args": [&script, &client_pids, ""], "cwd": &base }
            }]),
        )
        .await?;

        let t1 = send(client, &session, "List online then after disconnect.").await?;
        let (_, reply) = next_request(&mut provider, &rig, &session).await?;
        reply.send_plan(tool_response("McpList", json!({})));
        let (req1_online, reply) = next_request(&mut provider, &rig, &session).await?;
        let online = parse_tool_json(&req1_online)?;
        assert_eq!((&online["servers"][0]["connected"], &online["servers"][0]["tools"]), (&json!(true), &json!([])));
        assert!(online["clientServers"].as_array().unwrap().iter().any(|s| s["name"] == "zeroclient" && s["connected"] == true));
        assert!(online["installationServers"].as_array().unwrap().iter().any(|s| s["name"] == "zeroinstall" && s["connected"] == true));

        let all_pids: Vec<i32> = [&file_pids, &client_pids, &install_pids]
            .into_iter()
            .flat_map(|path| read_pids(path).unwrap())
            .collect();
        assert_eq!(all_pids.len(), 3, "{all_pids:?}");
        for &pid in &all_pids {
            // SAFETY: terminating our own test fixture child process.
            unsafe { libc::kill(pid, libc::SIGTERM); }
        }
        wait_pids_exited(&all_pids, "terminated zero-tool fixtures").await;
        tokio::time::sleep(Duration::from_millis(150)).await;

        reply.send_plan(tool_response("McpList", json!({})));
        let (req1_off, reply) = next_request(&mut provider, &rig, &session).await?;
        let offline = parse_tool_json(&req1_off)?;
        assert_eq!(offline["servers"][0]["connected"], false, "{offline}");
        assert_eq!((&offline["retiringServers"], &offline["clientServers"], &offline["installationServers"]), (&json!([]), &json!([]), &json!([])));
        finish_turn(client, &session, &t1, reply, "Observed disconnects.").await?;

        let t2 = send(client, &session, "List on next turn.").await?;
        let (_, reply) = next_request(&mut provider, &rig, &session).await?;
        reply.send_plan(tool_response("McpList", json!({})));
        let (req2, reply) = next_request(&mut provider, &rig, &session).await?;
        let next_list = parse_tool_json(&req2)?;
        assert_eq!(next_list["servers"][0]["connected"], true, "{next_list}");
        assert_eq!((read_pids(&file_pids)?.len(), read_pids(&client_pids)?.len(), read_pids(&install_pids)?.len()), (2, 1, 1));
        assert_eq!((&next_list["clientServers"], &next_list["installationServers"]), (&json!([]), &json!([])));
        finish_turn(client, &session, &t2, reply, "Next turn listed.").await?;

        let _ = session_mcp_sub.cancel().await;
        session_mcp_sub.close().await?;
        Ok::<_, Box<dyn Error + Send + Sync>>(())
    }))
    .catch_unwind()
    .await;
    let cleanup = tokio::time::timeout(Duration::from_secs(30), rig.finish()).await?;
    match outcome {
        Ok(result) => result?,
        Err(panic) => std::panic::resume_unwind(panic),
    };
    assert!(cleanup.is_empty(), "{cleanup:?}");
    Ok(())
}

/// Stdio MCP server that logs its PID and writes a ready marker on `initialize`, then waits
/// until a release gate file appears before replying so handshake races are deterministic.
const GATED_HANDSHAKE_SERVER: &str = r#"
import { createInterface } from 'node:readline';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
const [pidLog, readyPath, releasePath] = process.argv.slice(2);
appendFileSync(pidLog, `${process.pid}\n`);
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  const reply = (result) => send({ jsonrpc: '2.0', id: message.id, result });
  if (message.method === 'initialize') {
    writeFileSync(readyPath, `${process.pid}\n`);
    const finish = () => {
      if (existsSync(releasePath)) {
        reply({
          protocolVersion: message.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'gated', version: '1' },
        });
      } else {
        setTimeout(finish, 10);
      }
    };
    finish();
  } else if (message.method === 'tools/list') {
    reply({ tools: [{ name: 'echo', description: 'Gated echo', inputSchema: { type: 'object' } }] });
  } else if (message.method === 'tools/call') {
    reply({ content: [{ type: 'text', text: JSON.stringify(message.params.arguments) }], isError: false });
  }
});
"#;

async fn wait_file_exists(path: &Path, label: &str) -> TestResult<()> {
    tokio::time::timeout(Duration::from_secs(10), async {
        while !path.exists() {
            tokio::time::sleep(Duration::from_millis(15)).await;
        }
    })
    .await
    .map_err(|_| format!("timed out waiting for {label} at {}", path.display()))?;
    Ok(())
}

/// Verifies McpUpdate credential isolation on url/command change, unambiguous multi-location
/// target rejection, pre-probe CAS (zero probe on stale approval), cancel-mid-probe (no disk
/// write), user-level retirement despite corrupt project mcp.json, and ReadOnly McpList.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mcp_update_credential_isolation_disambiguation_pre_probe_cas_and_read_only_list()
-> TestResult<()> {
    let mut rig = Rig::new()?;
    let mut provider = Provider::start().await?;
    let base = rig.directory.path().to_path_buf();
    let outcome = AssertUnwindSafe(Box::pin(async {
        let crash_script = base.join("crash-server.mjs");
        std::fs::write(&crash_script, CRASH_SERVER)?;
        let gated_script = base.join("gated-server.mjs");
        std::fs::write(&gated_script, GATED_HANDSHAKE_SERVER)?;
        let steady_pids = base.join("steady-pids.log");
        let user_path = base.join("home/.maka/mcp.json");
        let proj_path = base.join("workspace/.maka/mcp.json");
        write_mcp_json(
            &user_path,
            json!({
                "steady": stdio_entry(&crash_script, &steady_pids, None, &base),
                "dup": { "url": "https://user-dup.example/mcp", "disabled": true },
            }),
        )?;
        write_mcp_json(
            &proj_path,
            json!({
                "dup": { "url": "https://proj-dup.example/mcp", "disabled": true },
            }),
        )?;

        let boot = bootstrap_with(&base, provider.server.base_url(), |config| {
            config["assistant"] = json!({"home": base.join("home")});
            config["toolDiscovery"] = json!(false);
        })
        .await?;
        attach(&mut rig, &boot).await?;
        let client = rig.client.as_ref().unwrap();
        let model = model(client, &provider.server.base_url(), false).await?;
        let session = create(client, &base, &model, None).await?["id"]
            .as_str()
            .ok_or("missing session id")?
            .to_owned();
        set_permissions(&rig, &session, "danger_full_access", false).await?;
        let proj_rev =
            call(client, "agent", "projectMcp", json!({"sessionId": session})).await?["revision"]
                .as_str()
                .unwrap()
                .to_owned();
        call(
            client,
            "agent",
            "trustProjectMcp",
            json!({"sessionId": session, "revision": proj_rev}),
        )
        .await?;

        // 1. Credential isolation on URL & command changes, plus multi-location disambiguation.
        let t1 = send(
            client,
            &session,
            "Test credential clearing and disambiguation.",
        )
        .await?;
        let (_, reply) = next_request(&mut provider, &rig, &session).await?;
        reply.send_plan(tool_response(
            "McpInstall",
            json!({
                "name": "apiserver",
                "url": "https://origin-a.example/mcp",
                "headers": { "Authorization": "Bearer secret-header" },
                "headerEnv": { "X-Api-Key": "HOST_SECRET" },
                "disabled": true,
                "skipVerify": true
            }),
        ));
        let (_, reply) = next_request(&mut provider, &rig, &session).await?;
        reply.send_plan(tool_response(
            "McpUpdate",
            json!({
                "name": "apiserver",
                "url": "https://origin-b.example/mcp",
                "skipVerify": true
            }),
        ));
        let (req_url_upd, reply) = next_request(&mut provider, &rig, &session).await?;
        let url_upd = parse_tool_json(&req_url_upd)?;
        assert_eq!(
            url_upd["clearedCredentials"],
            json!(["Authorization", "X-Api-Key"]),
            "{url_upd}"
        );
        let disk = read_json_file(&user_path)?;
        assert!(disk["mcpServers"]["apiserver"]["headers"].is_null());
        assert!(disk["mcpServers"]["apiserver"]["headerEnv"].is_null());

        let runner_pids = base.join("runner-pids.log");
        reply.send_plan(tool_response(
            "McpInstall",
            json!({
                "name": "runner",
                "command": "node",
                "args": [&crash_script, &runner_pids],
                "cwd": &base,
                "env": { "API_KEY": "top-secret-env" },
                "passEnv": ["HOME"],
                "skipVerify": true
            }),
        ));
        // Args-only change on a launcher-based (node) stdio server must clear inherited
        // env/passEnv while still allowing credentials explicitly supplied in the update.
        let (_, reply) = next_request(&mut provider, &rig, &session).await?;
        reply.send_plan(tool_response(
            "McpUpdate",
            json!({
                "name": "runner",
                "args": [&gated_script, &runner_pids],
                "env": { "FRESH_KEY": "explicit-new" },
                "skipVerify": true
            }),
        ));
        let (req_args_upd, reply) = next_request(&mut provider, &rig, &session).await?;
        let args_upd = parse_tool_json(&req_args_upd)?;
        assert_eq!(
            args_upd["clearedCredentials"],
            json!(["API_KEY", "HOME"]),
            "{args_upd}"
        );
        let disk = read_json_file(&user_path)?;
        assert_eq!(
            disk["mcpServers"]["runner"]["env"],
            json!({ "FRESH_KEY": "explicit-new" })
        );
        assert!(disk["mcpServers"]["runner"]["passEnv"].is_null());

        // Cwd-only change also clears inherited env.
        reply.send_plan(tool_response(
            "McpUpdate",
            json!({
                "name": "runner",
                "cwd": base.join("workspace"),
                "skipVerify": true
            }),
        ));
        let (req_cwd_upd, reply) = next_request(&mut provider, &rig, &session).await?;
        let cwd_upd = parse_tool_json(&req_cwd_upd)?;
        assert_eq!(
            cwd_upd["clearedCredentials"],
            json!(["FRESH_KEY"]),
            "{cwd_upd}"
        );
        let disk = read_json_file(&user_path)?;
        assert!(disk["mcpServers"]["runner"]["env"].is_null());

        // Ambiguous same-name update & uninstall without scope/location must be rejected.
        reply.send_plan(tool_response(
            "McpUpdate",
            json!({ "name": "dup", "disabled": false, "skipVerify": true }),
        ));
        let (req_amb_upd, reply) = next_request(&mut provider, &rig, &session).await?;
        assert!(
            last_message_text(&req_amb_upd, "tool").contains("exists in multiple locations"),
            "{}",
            last_message_text(&req_amb_upd, "tool")
        );
        reply.send_plan(tool_response("McpUninstall", json!({ "name": "dup" })));
        let (req_amb_del, reply) = next_request(&mut provider, &rig, &session).await?;
        assert!(
            last_message_text(&req_amb_del, "tool").contains("exists in multiple locations"),
            "{}",
            last_message_text(&req_amb_del, "tool")
        );

        // Corrupt project mcp.json must NOT block retiring an uninstalled user-level MCP server.
        assert_eq!(read_pids(&steady_pids)?.len(), 1);
        std::fs::write(&proj_path, "{corrupt-project-json")?;
        reply.send_plan(tool_response(
            "McpUninstall",
            json!({ "name": "steady", "scope": "user" }),
        ));
        let (req_uninst, reply) = next_request(&mut provider, &rig, &session).await?;
        assert_eq!(parse_tool_json(&req_uninst)?["status"], "uninstalled");
        finish_turn(client, &session, &t1, reply, "Done turn 1.").await?;

        #[cfg(unix)]
        wait_pids_exited(&read_pids(&steady_pids)?, "uninstalled user steady server").await;

        // 2. ReadOnly McpList succeeds even while project mcp.json is corrupt.
        set_permissions(&rig, &session, "read_only", false).await?;
        let t2 = send(
            client,
            &session,
            "List MCP in read_only with corrupt project file.",
        )
        .await?;
        let (_, reply) = next_request(&mut provider, &rig, &session).await?;
        reply.send_plan(tool_response("McpList", json!({})));
        let (req_ro_list, reply) = next_request(&mut provider, &rig, &session).await?;
        let ro_list = parse_tool_json(&req_ro_list)?;
        assert_eq!(
            ro_list["projectMcpStatus"], "disabled_in_read_only",
            "{ro_list}"
        );
        assert!(
            ro_list["servers"]
                .as_array()
                .unwrap()
                .iter()
                .all(|s| s["scope"] == "user"),
            "{ro_list}"
        );
        finish_turn(client, &session, &t2, reply, "Listed in read-only.").await?;

        // 3. WorkspaceWrite: pre-probe CAS skips verify_server completely (zero probe),
        // and approval method exposes target + inherited credential names (never values).
        std::fs::remove_file(&proj_path)?;
        let mut user_doc = read_json_file(&user_path)?;
        let probe_cas_log = base.join("probe-cas-must-stay-absent.log");
        user_doc["mcpServers"]["runner"] = json!({
            "command": "node",
            "args": [&crash_script, &probe_cas_log],
            "cwd": &base,
            "disabled": true,
            "env": { "KEPT_KEY": "never-leak-this-value" }
        });
        std::fs::write(&user_path, serde_json::to_vec_pretty(&user_doc)?)?;
        set_permissions(&rig, &session, "workspace_write", true).await?;

        let t3 = send(client, &session, "Test pre-probe CAS and approval summary.").await?;
        let (_, reply) = next_request(&mut provider, &rig, &session).await?;
        reply.send_plan(tool_response(
            "McpUpdate",
            json!({
                "name": "runner",
                "scope": "user",
                "disabled": false,
                "env": { "ADDED_KEY": "1" }
            }),
        ));
        let ap_cas = await_service_approval(client, &session).await?;
        let ap_detail = call(
            client,
            "agent",
            "interaction",
            json!({"sessionId": session, "requestId": ap_cas["requestId"]}),
        )
        .await?;
        let ap_method = ap_detail["request"]["method"].as_str().unwrap_or("");
        assert!(
            ap_method.contains("user:maka")
                && ap_method.contains("verify")
                && ap_method.contains("KEPT_KEY")
                && !ap_method.contains("never-leak-this-value"),
            "approval method must show location, verify, and inherited key name only: {ap_detail}"
        );
        // Simulate concurrent edit before approving.
        let mut concurrent = read_json_file(&user_path)?;
        concurrent["mcpServers"]["runner"]["env"]["CONCURRENT"] = json!("settings");
        std::fs::write(&user_path, serde_json::to_vec_pretty(&concurrent)?)?;
        allow_service_approval(client, &session, ap_cas["requestId"].as_str().unwrap()).await?;
        let (req_cas_done, reply) = next_request(&mut provider, &rig, &session).await?;
        assert!(
            last_message_text(&req_cas_done, "tool").contains("differs from the original approval"),
            "{}",
            last_message_text(&req_cas_done, "tool")
        );
        assert!(
            !probe_cas_log.exists(),
            "stale CAS approval must reject BEFORE running verify_server"
        );
        finish_turn(client, &session, &t3, reply, "Pre-probe CAS rejected.").await?;

        // 4. Stopping a Run mid-probe cancels verify_server and does NOT write to disk.
        let probe_cancel_pids = base.join("probe-cancel-pids.log");
        let probe_ready = base.join("probe-cancel.ready");
        let probe_release = base.join("probe-cancel.release");
        set_permissions(&rig, &session, "danger_full_access", false).await?;
        let t4 = send(client, &session, "Update runner with blocking probe.").await?;
        let (_, reply) = next_request(&mut provider, &rig, &session).await?;
        reply.send_plan(tool_response(
            "McpUpdate",
            json!({
                "name": "runner",
                "scope": "user",
                "disabled": false,
                "args": [&gated_script, &probe_cancel_pids, &probe_ready, &probe_release],
                "env": { "SHOULD_NOT_SAVE": "1" }
            }),
        ));
        wait_file_exists(&probe_ready, "probe ready marker").await?;
        let obs = call(client, "agent", "observe", json!({"sessionId": session})).await?;
        let run_id = obs["latestRunId"].as_str().ok_or("missing active run id")?;
        let stopped = call(
            client,
            "agent",
            "stop",
            json!({"sessionId": session, "runId": run_id}),
        )
        .await?;
        assert_eq!(stopped["requested"], true, "{stopped}");
        let work = tokio::time::timeout(Duration::from_secs(20), terminal(client, &session, &t4))
            .await??;
        assert_eq!(work["execution"]["state"]["kind"], "cancelled", "{work}");
        let disk_after_cancel = read_json_file(&user_path)?;
        assert!(
            disk_after_cancel["mcpServers"]["runner"]["env"]["SHOULD_NOT_SAVE"].is_null(),
            "cancelled probe must never commit to disk: {disk_after_cancel}"
        );
        #[cfg(unix)]
        wait_pids_exited(&read_pids(&probe_cancel_pids)?, "cancelled probe server").await;
        Ok::<_, Box<dyn Error + Send + Sync>>(())
    }))
    .catch_unwind()
    .await;
    let cleanup = tokio::time::timeout(Duration::from_secs(30), rig.finish()).await?;
    match outcome {
        Ok(result) => result?,
        Err(panic) => std::panic::resume_unwind(panic),
    };
    assert!(cleanup.is_empty(), "{cleanup:?}");
    Ok(())
}

/// Verifies that declining a project MCP configuration while a slow initial handshake is
/// in flight aborts snapshot publication, closes the newly opened process, and does not
/// leak the declined server into `snapshots.current` or later turns.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn slow_project_mcp_startup_aborts_when_declined_mid_handshake() -> TestResult<()> {
    let mut rig = Rig::new()?;
    let mut provider = Provider::start().await?;
    let base = rig.directory.path().to_path_buf();
    let outcome = AssertUnwindSafe(Box::pin(async {
        let gated_script = base.join("gated-server.mjs");
        std::fs::write(&gated_script, GATED_HANDSHAKE_SERVER)?;
        std::fs::create_dir_all(base.join("home/.maka"))?;
        let slow_pids = base.join("slow-proj-pids.log");
        let ready_file = base.join("slow-proj.ready");
        let release_file = base.join("slow-proj.release");
        write_mcp_json(
            &base.join("workspace/.maka/mcp.json"),
            json!({
                "slowproj": {
                    "command": "node",
                    "args": [&gated_script, &slow_pids, &ready_file, &release_file],
                    "cwd": &base
                }
            }),
        )?;

        let boot = bootstrap_with(&base, provider.server.base_url(), |config| {
            config["assistant"] = json!({"home": base.join("home")});
            config["toolDiscovery"] = json!(false);
        })
        .await?;
        attach(&mut rig, &boot).await?;
        let client = rig.client.as_ref().unwrap();
        let model = model(client, &provider.server.base_url(), false).await?;
        let session = create(client, &base, &model, None).await?["id"]
            .as_str()
            .ok_or("missing session id")?
            .to_owned();
        set_permissions(&rig, &session, "workspace_write", true).await?;
        let ws_obj = call(client, "agent", "observe", json!({"sessionId": session})).await?
            ["session"]["workspace"]
            .clone();
        let proj_rev =
            call(client, "agent", "projectMcp", json!({"sessionId": session})).await?["revision"]
                .as_str()
                .unwrap()
                .to_owned();
        set_project_decision(client, &ws_obj, &proj_rev, "trusted").await?;

        // Kick off Turn 1 concurrently: agent.send awaits Projects::start, which spawns slowproj
        // and blocks inside initialize before anything is published into snapshots.current.
        let send_fut = call(
            client,
            "agent",
            "send",
            json!({"sessionId": session, "message": "Start slow project MCP."}),
        );
        let decline_fut = async {
            wait_file_exists(&ready_file, "slowproj handshake ready").await?;
            set_project_decision(client, &ws_obj, &proj_rev, "declined").await?;
            std::fs::write(&release_file, "go")?;
            Ok::<_, Box<dyn Error + Send + Sync>>(())
        };
        let (send_res, decline_res) = tokio::join!(send_fut, decline_fut);
        decline_res?;
        let send_err = send_res
            .expect_err("declining mid-handshake must abort slow startup instead of admitting Run");
        assert!(
            send_err.to_string().contains("agent_mcp_trust_required"),
            "unexpected abort error: {send_err}"
        );
        #[cfg(unix)]
        wait_pids_exited(&read_pids(&slow_pids)?, "aborted slowproj server").await;

        // Turn 2 proceeds cleanly with zero project MCP tools and never restarts slowproj.
        let t2 = send(client, &session, "Proceed after decline.").await?;
        let (req2, reply) = next_request(&mut provider, &rig, &session).await?;
        let tool_names: Vec<&str> = req2["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|t| t["function"]["name"].as_str())
            .collect();
        assert!(
            !tool_names
                .iter()
                .any(|name| name.starts_with("mcp__slowproj__")),
            "declined slowproj must not leak into subsequent turns: {tool_names:?}"
        );
        assert_eq!(started(&slow_pids), 1, "declined slowproj must not restart");
        finish_turn(client, &session, &t2, reply, "Clean without slowproj.").await?;
        Ok::<_, Box<dyn Error + Send + Sync>>(())
    }))
    .catch_unwind()
    .await;
    let cleanup = tokio::time::timeout(Duration::from_secs(30), rig.finish()).await?;
    match outcome {
        Ok(result) => result?,
        Err(panic) => std::panic::resume_unwind(panic),
    };
    assert!(cleanup.is_empty(), "{cleanup:?}");
    Ok(())
}
