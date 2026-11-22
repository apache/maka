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
) -> TestResult<(String, oneshot::Sender<ModelReply>)> {
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
    reply
        .send(tool_response(
            &format!("mcp__{server}__echo"),
            json!({"marker":marker}),
        ))
        .map_err(|_| "echo response lost")?;
    let (output, reply) = last_tool_output(provider, rig, session).await?;
    assert!(output.contains(marker), "{output}");
    reply
        .send(completion(
            json!({"role":"assistant","content":"Done."}),
            "stop",
        ))
        .map_err(|_| "final response lost")?;
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
    let boot = bootstrap_with(base, provider.url.clone(), |config| {
        config["assistant"] = json!({"home":base.join("home")});
    })
    .await?;
    attach(rig, &boot).await?;
    let client = rig.client.as_ref().unwrap();
    let model = model(client, &provider.url, false).await?;
    let session = full_access_session(rig, base, &model).await?;
    let message = send(client, &session, "Call the server.").await?;
    let (_, reply) = last_tool_output(provider, rig, &session).await?;
    reply
        .send(tool_response("mcp__fixture__crash", json!({})))
        .map_err(|_| "crash response lost")?;
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
        let boot = bootstrap_with(&base, provider.url.clone(), |config| {
            config["assistant"] = json!({"home":base.join("home")});
        })
        .await?;
        attach(&mut rig, &boot).await?;
        let client = rig.client.as_ref().unwrap();
        let model = model(client, &provider.url, false).await?;
        let session = full_access_session(&rig, &base, &model).await?;

        let first = send(client, &session, "Start with empty tool list.").await?;
        let (_, reply) = last_tool_output(&mut provider, &rig, &session).await?;
        reply
            .send(completion(
                json!({"role":"assistant","content":"Done."}),
                "stop",
            ))
            .map_err(|_| "first response lost")?;
        tokio::time::timeout(
            Duration::from_secs(20),
            completed_message(client, &session, &first),
        )
        .await??;
        echo_turn(&rig, &mut provider, &session, "dynamic", "zero-tool-reopened").await?;
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
