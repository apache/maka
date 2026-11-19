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

/// A parent Session with the Session tools discovered, and a worker it created.
async fn parent_and_worker(rig: &mut Rig, provider: &mut Provider) -> TestResult<(String, String)> {
    let base = rig.directory.path().to_path_buf();
    std::fs::create_dir_all(base.join("workspace"))?;
    let root = std::env::current_dir()?.join("../../..");
    let output = tokio::process::Command::new("node")
        .current_dir(root)
        .args([
            "--input-type=module",
            "-e",
            "import {installation} from './products/maka/bundle/src/installation.ts'; \
             console.log(JSON.stringify(installation({workspace:process.cwd(),helper:'test'}).agent.tools.filter(\
               t => t.target.kind === 'export' && t.target.name === 'agent')))",
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
    })
    .await?;
    attach(rig, &boot).await?;
    let client = rig.client.as_ref().unwrap();
    let model = model_options(
        client,
        &provider.url,
        false,
        json!({"contextWindow": 128000, "compactionThreshold": 100000}),
    )
    .await?;
    let parent = create(client, &base, &model, None).await?["id"]
        .as_str()
        .ok_or("missing parent id")?
        .to_owned();
    tool_round(
        rig,
        provider,
        &parent,
        false,
        "tool_search",
        json!({"query": "Session", "limit": 20}),
    )
    .await?;
    let created = tool_round(
        rig,
        provider,
        &parent,
        false,
        "SessionCreate",
        json!({"title": "Stop queue worker"}),
    )
    .await?;
    let messages: Vec<Value> = serde_json::from_str(&created)?;
    let created: Value = serde_json::from_str(messages[0]["content"].as_str().unwrap())?;
    let worker = created["session"]["id"]
        .as_str()
        .ok_or_else(|| format!("missing worker id: {created}"))?
        .to_owned();
    Ok((parent, worker))
}

/// The scheduler admits a ready follow-up within milliseconds; a second of
/// silence means nothing started.
async fn no_new_turn(provider: &mut Provider) -> TestResult<()> {
    match tokio::time::timeout(Duration::from_millis(1500), provider.requests.recv()).await {
        Err(_) => Ok(()),
        Ok(request) => Err(format!(
            "a turn started without the user: {}",
            request
                .map(|(body, _)| text_messages(&body))
                .unwrap_or_default()
        )
        .into()),
    }
}

async fn queued(client: &HostClient, session: &str) -> TestResult<Vec<String>> {
    let queue = call(client, "agent", "queue", json!({"sessionId": session})).await?;
    Ok(queue["entries"]
        .as_array()
        .ok_or_else(|| format!("missing queue entries: {queue}"))?
        .iter()
        .map(|entry| entry["preview"].as_str().unwrap_or_default().to_owned())
        .collect())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_session_stop_takes_back_what_that_session_sent_and_keeps_the_users_message()
-> TestResult<()> {
    let mut rig = Rig::new()?;
    let mut provider = Provider::start().await?;
    let outcome = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(120), async {
        let (parent, worker) = parent_and_worker(&mut rig, &mut provider).await?;
        let client = rig.client.as_ref().unwrap();

        call(
            client,
            "agent",
            "send",
            json!({"sessionId": worker, "message": "WORKER_LONG_TASK"}),
        )
        .await?;
        let (_, held) = provider.next().await?;
        let typed = call(
            client,
            "agent",
            "send",
            json!({"sessionId": worker, "message": "USER_NOTE_FOR_WORKER", "delivery": "queue"}),
        )
        .await?;
        assert_eq!(typed["kind"], "queued", "{typed}");
        tool_round(
            &rig,
            &mut provider,
            &parent,
            false,
            "SessionSend",
            json!({
                "sessionId": worker,
                "message": "PARENT_INSTRUCTION_TO_TAKE_BACK",
                "delivery": "queue",
                "onComplete": "none"
            }),
        )
        .await?;
        assert_eq!(
            queued(client, &worker).await?,
            ["USER_NOTE_FOR_WORKER", "PARENT_INSTRUCTION_TO_TAKE_BACK"]
        );

        // Once the Stop commits, the worker may ask the model before the parent's
        // turn ends, so requests are told apart by what they carry.
        let stop = call(
            client,
            "agent",
            "send",
            json!({"sessionId": parent, "message": "Execute SessionStop"}),
        )
        .await?;
        let mut held = Some(held);
        let mut stop_called = false;
        let mut parent_done = false;
        let mut worker_prompt = None;
        while !parent_done || worker_prompt.is_none() {
            let (request, reply) = provider.next().await?;
            let prompt = text_messages(&request);
            if prompt.contains("Execute SessionStop") {
                if !stop_called {
                    stop_called = true;
                    reply
                        .send(tool_response("SessionStop", json!({"sessionId": worker})))
                        .map_err(|_| "stop call lost")?;
                } else {
                    let messages = request["messages"].as_array().unwrap();
                    let result = messages
                        .iter()
                        .rfind(|message| message["role"] == "tool")
                        .ok_or("SessionStop result missing")?;
                    assert!(
                        result["content"]
                            .as_str()
                            .is_some_and(|content| content.contains("\"requested\":true")),
                        "{result}"
                    );
                    held.take();
                    parent_done = true;
                    reply
                        .send(completion(
                            json!({"role": "assistant", "content": "Stopped."}),
                            "stop",
                        ))
                        .map_err(|_| "parent reply lost")?;
                }
            } else {
                assert!(worker_prompt.is_none(), "the worker asked twice: {prompt}");
                worker_prompt = Some(prompt);
                reply
                    .send(completion(
                        json!({"role": "assistant", "content": "Handled the user's note."}),
                        "stop",
                    ))
                    .map_err(|_| "worker reply lost")?;
            }
        }
        quiescent_message(client, &parent, &stop["messageId"]).await?;
        let prompt = worker_prompt.unwrap();
        assert!(
            prompt.contains("USER_NOTE_FOR_WORKER")
                && !prompt.contains("PARENT_INSTRUCTION_TO_TAKE_BACK"),
            "{prompt}"
        );
        quiescent_message(client, &worker, &typed["messageId"]).await?;
        assert!(queued(client, &worker).await?.is_empty());
        no_new_turn(&mut provider).await?;
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
