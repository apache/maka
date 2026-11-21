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
const CRASH_SERVER: &str = r#"
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
appendFileSync(process.argv[2], `${process.pid}\n`);
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

/// One turn that calls `echo` and finishes after reading its result.
async fn echo_turn(
    rig: &Rig,
    provider: &mut Provider,
    session: &str,
    marker: &str,
) -> TestResult<()> {
    let client = rig.client.as_ref().unwrap();
    let message = send(client, session, "Echo the marker.").await?;
    let (_, reply) = last_tool_output(provider, rig, session).await?;
    reply
        .send(tool_response(
            "mcp__fixture__echo",
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

/// A server from the global mcp.json exits during a call. The retired connection
/// is replaced by one new server process the next time a turn needs it, so the
/// next turn and a new Session can use the server again.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mcp_server_that_exits_mid_call_is_reopened_for_the_next_turn() -> TestResult<()> {
    let mut rig = Rig::new()?;
    let mut provider = Provider::start().await?;
    let base = rig.directory.path().to_path_buf();
    let starts = base.join("mcp-starts.log");
    let started = || {
        std::fs::read_to_string(&starts)
            .unwrap_or_default()
            .lines()
            .count()
    };
    let outcome = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(120), async {
        let script = base.join("crash-server.mjs");
        std::fs::write(&script, CRASH_SERVER)?;
        std::fs::create_dir_all(base.join("home/.maka"))?;
        std::fs::write(
            base.join("home/.maka/mcp.json"),
            json!({"mcpServers":{"fixture":{"command":"node","args":[script, starts],"cwd":base}}})
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

        let message = send(client, &session, "Call the server.").await?;
        let (_, reply) = last_tool_output(&mut provider, &rig, &session).await?;
        reply
            .send(tool_response("mcp__fixture__crash", json!({})))
            .map_err(|_| "crash response lost")?;
        let crashed = tokio::time::timeout(
            Duration::from_secs(20),
            terminal(client, &session, &message),
        )
        .await??;
        assert_eq!(started(), 1, "{crashed}");

        echo_turn(&rig, &mut provider, &session, "next-turn-marker").await?;
        assert_eq!(started(), 2);
        let fresh = full_access_session(&rig, &base, &model).await?;
        echo_turn(&rig, &mut provider, &fresh, "new-session-marker").await?;
        assert_eq!(started(), 2);
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
