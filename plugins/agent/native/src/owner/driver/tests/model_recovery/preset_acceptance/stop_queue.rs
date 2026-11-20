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

async fn active_run(client: &HostClient, session: &str) -> TestResult<Value> {
    let status = call(
        client,
        "agent",
        "sessionRead",
        json!({"sessionId": session, "view": "status_only"}),
    )
    .await?;
    let run = status["run"]["runId"].clone();
    if run.is_null() {
        return Err(format!("no active Run: {status}").into());
    }
    Ok(run)
}

async fn idle(client: &HostClient, session: &str) -> TestResult<()> {
    for _ in 0..200 {
        let status = call(
            client,
            "agent",
            "sessionRead",
            json!({"sessionId": session, "view": "status_only"}),
        )
        .await?;
        if status["session"]["activity"] == "idle" {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    Err(format!("{session} never became idle").into())
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

async fn user_stop(client: &HostClient, session: &str) -> TestResult<()> {
    let run = active_run(client, session).await?;
    let stopped = call(
        client,
        "agent",
        "stop",
        json!({"sessionId": session, "runId": run}),
    )
    .await?;
    assert_eq!(stopped["requested"], true, "{stopped}");
    Ok(())
}

async fn wait_queued(client: &HostClient, session: &str, count: usize) -> TestResult<()> {
    for _ in 0..400 {
        if queued(client, session).await?.len() == count {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    Err(format!(
        "{session} never had {count} queued: {:?}",
        queued(client, session).await?
    )
    .into())
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

/// The parent sends `task` to the worker and asks to be told when it ends.
/// Returns the parent's next model request and the worker's, both unanswered.
async fn delegate(
    rig: &Rig,
    provider: &mut Provider,
    parent: &str,
    worker: &str,
    task: &str,
) -> TestResult<(oneshot::Sender<ModelReply>, oneshot::Sender<ModelReply>)> {
    let order = format!("Delegate {task}");
    call(
        rig.client.as_ref().unwrap(),
        "agent",
        "send",
        json!({"sessionId": parent, "message": order}),
    )
    .await?;
    let (_, reply) = provider.next().await?;
    reply
        .send(tool_response(
            "SessionSend",
            json!({"sessionId": worker, "message": task, "onComplete": "notify_caller"}),
        ))
        .map_err(|_| "delegation lost")?;
    let (mut parent_step, mut worker_turn) = (None, None);
    while parent_step.is_none() || worker_turn.is_none() {
        let (request, reply) = provider.next().await?;
        if text_messages(&request).contains(&order) {
            parent_step = Some(reply);
        } else {
            worker_turn = Some(reply);
        }
    }
    Ok((parent_step.unwrap(), worker_turn.unwrap()))
}

/// The user's next message starts one turn that reads `result` after the
/// message.
async fn next_turn_reads(
    client: &HostClient,
    provider: &mut Provider,
    session: &str,
    message: &str,
    result: &str,
) -> TestResult<()> {
    let sent = call(
        client,
        "agent",
        "send",
        json!({"sessionId": session, "message": message}),
    )
    .await?;
    assert_ne!(sent["kind"], "rejected", "{sent}");
    let (request, reply) = provider.next().await?;
    let prompt = text_messages(&request);
    let user = prompt.find(message);
    let notice = prompt.find(result);
    assert!(
        user.is_some() && notice.is_some() && user < notice,
        "the user's next turn must read {result} after the user's message: {prompt}"
    );
    reply
        .send(completion(
            json!({"role": "assistant", "content": "Noted."}),
            "stop",
        ))
        .map_err(|_| "reply lost")?;
    quiescent_message(client, session, &sent["messageId"]).await?;
    idle(client, session).await?;
    assert!(queued(client, session).await?.is_empty());
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_user_stop_keeps_delegated_results_for_the_users_next_message() -> TestResult<()> {
    let mut rig = Rig::new()?;
    let mut provider = Provider::start().await?;
    let outcome = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(120), async {
        let (parent, worker) = parent_and_worker(&mut rig, &mut provider).await?;
        let client = rig.client.as_ref().unwrap();

        // The result arrives while the parent's turn still runs, then the user stops it.
        let (parent_step, worker_turn) =
            delegate(&rig, &mut provider, &parent, &worker, "WORKER_TASK_A").await?;
        worker_turn
            .send(completion(
                json!({"role": "assistant", "content": "RESULT_A"}),
                "stop",
            ))
            .map_err(|_| "worker reply lost")?;
        wait_queued(client, &parent, 1).await?;
        user_stop(client, &parent).await?;
        drop(parent_step);
        idle(client, &parent).await?;
        no_new_turn(&mut provider).await?;
        assert_eq!(queued(client, &parent).await?.len(), 1);
        next_turn_reads(
            client,
            &mut provider,
            &parent,
            "USER_AFTER_STOP_A",
            "RESULT_A",
        )
        .await?;

        // The user stops the parent first; the result arrives afterwards.
        let (parent_step, worker_turn) =
            delegate(&rig, &mut provider, &parent, &worker, "WORKER_TASK_B").await?;
        user_stop(client, &parent).await?;
        drop(parent_step);
        idle(client, &parent).await?;
        worker_turn
            .send(completion(
                json!({"role": "assistant", "content": "RESULT_B"}),
                "stop",
            ))
            .map_err(|_| "worker reply lost")?;
        wait_queued(client, &parent, 1).await?;
        no_new_turn(&mut provider).await?;
        next_turn_reads(
            client,
            &mut provider,
            &parent,
            "USER_AFTER_STOP_B",
            "RESULT_B",
        )
        .await?;
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
