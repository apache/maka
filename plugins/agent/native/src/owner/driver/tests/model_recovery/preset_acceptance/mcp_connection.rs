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
