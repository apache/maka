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
enum ModelReply {
    Stream(String),
    RateLimited,
}
fn completion(delta: Value, finish: &str) -> ModelReply {
    ModelReply::Stream(super::bot_tools::completion(delta, finish))
}
fn tool_response(name: &str, input: Value) -> ModelReply {
    ModelReply::Stream(super::bot_tools::tool_response(name, input))
}
use std::sync::atomic::AtomicUsize;

type ModelRequest = (Value, oneshot::Sender<ModelReply>);

struct Provider {
    url: String,
    requests: tokio::sync::mpsc::Receiver<ModelRequest>,
    task: JoinHandle<std::io::Result<()>>,
}
impl Provider {
    async fn start() -> TestResult<Self> {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
        let url = format!("http://{}/v1", listener.local_addr()?);
        let (requests, receiver) = tokio::sync::mpsc::channel(8);
        let app = axum::Router::new().route(
            "/v1/chat/completions",
            axum::routing::post(move |body: axum::body::Bytes| {
                let requests = requests.clone();
                async move {
                    let request = serde_json::from_slice(&body).unwrap();
                    let (reply, response) = oneshot::channel();
                    let _ = requests.send((request, reply)).await;
                    use axum::response::IntoResponse;
                    match response.await {
                        Ok(ModelReply::Stream(body)) => {
                            ([("content-type", "text/event-stream")], body).into_response()
                        }
                        Ok(ModelReply::RateLimited) => (
                            axum::http::StatusCode::TOO_MANY_REQUESTS,
                            [("retry-after", "0")],
                            "rate limited",
                        )
                            .into_response(),
                        Err(_) => axum::http::StatusCode::SERVICE_UNAVAILABLE.into_response(),
                    }
                }
            }),
        );
        let task = tokio::spawn(async move { axum::serve(listener, app).await });
        Ok(Self {
            url,
            requests: receiver,
            task,
        })
    }
    async fn next(&mut self) -> TestResult<ModelRequest> {
        tokio::time::timeout(Duration::from_secs(20), self.requests.recv())
            .await?
            .ok_or_else(|| "model request missing".into())
    }
}
impl Drop for Provider {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn model(client: &HostClient, url: &str, code: bool) -> TestResult<Value> {
    model_options(client, url, code, json!({})).await
}
async fn model_options(
    client: &HostClient,
    url: &str,
    code: bool,
    options: Value,
) -> TestResult<Value> {
    let mut overrides = json!({"codeMode":code,"apiProtocol":"openai-chat-completions"});
    overrides
        .as_object_mut()
        .unwrap()
        .extend(options.as_object().unwrap().clone());
    let catalog = call(client, "settings", "connections", json!({"kind":"start"})).await?;
    let saved = call(client,"settings","create",json!({
        "expectedCatalogRevision":catalog["revision"],
        "connection":{"slug":"acceptance","name":"Acceptance fixture",
            "provider":{"packageId":"maka.providers","entryId":"maka.providers","scope":"profile","name":"ollama"},
            "configuration":{"baseUrl":url},"enabled":true,"enabledModelIds":["llama3.2"],
            "modelOverrides":{"llama3.2":overrides}}
    })).await?;
    assert_eq!(saved["kind"], "committed", "{saved}");
    Ok(json!({"connectionId":saved["connection"]["connectionId"],"modelId":"llama3.2"}))
}

async fn preset(client: &HostClient, model: &Value, instruction: &str) -> TestResult<Value> {
    let saved = call(
        client,
        "agent",
        "createPreset",
        json!({"name":format!("Reviewer {}",Uuid::new_v4()),"description":"Review changes",
        "instruction":instruction,"model":model}),
    )
    .await?;
    assert_eq!(saved["kind"], "saved", "{saved}");
    Ok(saved["preset"].clone())
}

async fn create(
    client: &HostClient,
    base: &Path,
    model: &Value,
    preset: Option<&Value>,
) -> TestResult<Value> {
    let mut input = json!({"title":"Acceptance session","automaticTitle":false,"labels":[],
        "workspace":{"kind":"directory","path":base.join("workspace")}});
    if let Some(preset) = preset {
        input["presetId"] = preset["id"].clone();
    } else {
        let mut backend = model.clone();
        backend["kind"] = json!("model");
        input["backend"] = backend;
    }
    let created = call(client, "agent", "create", input).await?;
    assert_eq!(created["kind"], "created", "{created}");
    Ok(created["session"].clone())
}

fn text_messages(request: &Value) -> String {
    request["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|message| message["content"].as_str())
        .collect::<Vec<_>>()
        .join("\n")
}

async fn tool_round(
    rig: &Rig,
    provider: &mut Provider,
    session: &str,
    code: bool,
    name: &str,
    input: Value,
) -> TestResult<String> {
    let client = rig.client.as_ref().unwrap();
    let sent = call(
        client,
        "agent",
        "send",
        json!({"sessionId":session,"message":format!("Execute {name}")}),
    )
    .await?;
    assert_eq!(sent["kind"], "queued", "{sent}");
    let (request, reply) = match provider.next().await {
        Ok(request) => request,
        Err(error) => {
            return Err(format!(
                "before {name}: {error}; {}",
                diagnostic(rig, session).await?
            )
            .into());
        }
    };
    let advertised = if code { "exec" } else { name };
    assert!(
        request["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["function"]["name"] == advertised),
        "{request}"
    );
    let owner = rig.captured.lock().unwrap().clone().unwrap();
    let approve_web = name == "WebFetch"
        && owner
            .mutable_session(session)
            .await?
            .configuration
            .permissions
            .request_permissions;
    let (name, input) = if code {
        (
            "exec",
            json!({"code":format!("text(await tools.{name}({input}));"),"yield_time_ms":30000}),
        )
    } else {
        (name, input)
    };
    reply
        .send(tool_response(name, input))
        .map_err(|_| "model response lost")?;
    if approve_web {
        tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                let pending = call(client,"agent","pendingInteractions",json!({"sessionId":session})).await?;
                if let Some(entry) = pending["entries"].as_array().unwrap().first() {
                    assert_eq!(entry["kind"],"permissions","{entry}");
                    let record = call(client,"agent","interaction",json!({"sessionId":session,"requestId":entry["requestId"]})).await?;
                    let approved = call(client,"agent","respond",json!({"sessionId":session,"requestId":entry["requestId"],
                        "answer":{"kind":"permissions","decision":{"decision":"allow","permissions":record["request"]["request"]["permissions"],"scope":"run"}}})).await?;
                    assert_eq!(approved["kind"],"recorded","{approved}; {record}");
                    return Ok::<_,Box<dyn Error + Send + Sync>>(());
                }
                tokio::task::yield_now().await;
            }
        }).await??;
    }
    let (request, reply) = match provider.next().await {
        Ok(request) => request,
        Err(error) => {
            return Err(
                format!("after {name}: {error}; {}", diagnostic(rig, session).await?).into(),
            );
        }
    };
    let output = request["messages"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find(|message| message["role"] == "tool")
        .ok_or("tool reply missing")?["content"]
        .to_string();
    reply
        .send(completion(
            json!({"role":"assistant","content":"Done."}),
            "stop",
        ))
        .map_err(|_| "final response lost")?;
    match tokio::time::timeout(
        Duration::from_secs(20),
        quiescent_message(client, session, &sent["messageId"]),
    )
    .await
    {
        Ok(result) => {
            result?;
        }
        Err(_) => return Err(format!("after {name}: {}", diagnostic(rig, session).await?).into()),
    }
    Ok(output)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ordinary_and_preset_tools_share_direct_execution_and_permission_denials() -> TestResult<()>
{
    tool_matrix(false).await
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ordinary_and_preset_tools_share_code_mode_execution_and_permission_denials()
-> TestResult<()> {
    tool_matrix(true).await
}

async fn tool_matrix(code: bool) -> TestResult<()> {
    let _ = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::WARN)
        .with_test_writer()
        .try_init();
    let mut rig = Rig::new()?;
    let mut provider = Provider::start().await?;
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
    let address = format!("http://{}", listener.local_addr()?);
    let web_calls = Arc::new(AtomicUsize::new(0));
    let mcp_calls = Arc::new(AtomicUsize::new(0));
    let web = web_calls.clone();
    let mcp = mcp_calls.clone();
    let app = axum::Router::new()
        .route("/page",axum::routing::get(move || {let calls = web.clone(); async move {
            calls.fetch_add(1,Ordering::SeqCst); "web-acceptance-marker"
        }}))
        .route("/mcp",axum::routing::post(move |body: axum::body::Bytes| {
            let calls = mcp.clone(); async move {
                use axum::response::IntoResponse;
                let request: Value = serde_json::from_slice(&body).unwrap();
                if request.get("id").is_none() {return axum::http::StatusCode::ACCEPTED.into_response();}
                let result = match request["method"].as_str().unwrap() {
                    "initialize" => json!({"protocolVersion":request["params"]["protocolVersion"],
                        "capabilities":{"tools":{}},"serverInfo":{"name":"acceptance","version":"1"}}),
                    "tools/list" => json!({"tools":[{"name":"echo","description":"Echo marker",
                        "inputSchema":{"type":"object","properties":{"marker":{"type":"string"}},"required":["marker"]},
                        "annotations":{"readOnlyHint":false}}]}),
                    "tools/call" => {calls.fetch_add(1,Ordering::SeqCst);
                        json!({"content":[{"type":"text","text":request["params"]["arguments"]["marker"]}],"isError":false})},
                    other => panic!("unexpected MCP method {other}"),
                };
                ([("content-type","application/json")],json!({"jsonrpc":"2.0","id":request["id"],"result":result}).to_string()).into_response()
            }
        }).delete(|| async {axum::http::StatusCode::NO_CONTENT}));
    let server = tokio::spawn(async move { axum::serve(listener, app).await });
    let outcome = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(240), async {
        let base = rig.directory.path().to_path_buf();
        let boot = bootstrap_with(&base,provider.url.clone(),|config| {
            config["tools"] = json!([
                {"name":"Read","description":"Read local file","target":{"kind":"import","name":"files"},"method":"readText","nestable":true,"result":"json","confirmation":"preapproved"},
                {"name":"Write","description":"Write local file","target":{"kind":"import","name":"files"},"method":"write","nestable":true,"result":"json","confirmation":"preapproved"},
                {"name":"WebFetch","description":"Fetch a URL","target":{"kind":"import","name":"web"},"method":"fetch","input":"web","nestable":true,"result":"json","confirmation":"preapproved"}
            ]);
            config["mcpServers"] = json!([{"name":"fixture","transport":{"type":"streamable_http","url":format!("{address}/mcp")},"preapproved":true}]);
        }).await?;
        std::fs::write(base.join("workspace/input.txt"),"local-acceptance-marker")?;
        attach(&mut rig,&boot).await?;
        let client = rig.client.as_ref().unwrap();
        let web = call(client,"web","snapshot",json!({})).await?;
        assert_eq!(call(client,"web","save",json!({"revision":web["revision"],"settings":{"enabled":true,"source":"model"}})).await?["kind"],"updated");
        let model = model(client,&provider.url,code).await?;
        let preset = preset(client,&model,"Keep the reviewer role.").await?;
        for selected in [None,Some(&preset)] {
            std::fs::write(base.join("workspace/output.txt"),"unchanged-before-write")?;
            let session = create(client,&base,&model,selected).await?;
            let id = session["id"].as_str().unwrap();
            for allowed in [true,false] {
                {
                    let owner = rig.captured.lock().unwrap().clone().unwrap();
                    let revision = owner.mutable_session(id).await?.revision;
                    let changed = call(client,"agent","metadata",json!({"sessionId":id,"expectedRevision":revision,
                        "title":"Tool matrix session","labels":[],"permissions":{"settings":{"access":if allowed {"danger_full_access"} else {"read_only"},"requestPermissions":allowed},"revokeGrants":true}})).await?;
                    assert_eq!(changed["kind"],"committed","{changed}");
                }
                let read = tool_round(&rig,&mut provider,id,code,"Read",json!({"path":"input.txt"})).await?;
                assert!(read.contains("local-acceptance-marker"),"{read}");
                let write = tool_round(&rig,&mut provider,id,code,"Write",json!({"path":"output.txt","content":if allowed {"allowed"} else {"forbidden"}})).await?;
                let before_web = web_calls.load(Ordering::SeqCst);
                let web = tool_round(&rig,&mut provider,id,code,"WebFetch",json!({"url":format!("{address}/page")})).await?;
                let before_mcp = mcp_calls.load(Ordering::SeqCst);
                let mcp = tool_round(&rig,&mut provider,id,code,"mcp__fixture__echo",json!({"marker":"mcp-acceptance-marker"})).await?;
                assert_eq!(std::fs::read_to_string(base.join("workspace/output.txt"))?,"allowed");
                assert_eq!(web_calls.load(Ordering::SeqCst)-before_web,usize::from(allowed),"{web}");
                assert_eq!(mcp_calls.load(Ordering::SeqCst)-before_mcp,usize::from(allowed),"{mcp}");
                if allowed {
                    assert!(web.contains("web-acceptance-marker"),"{web}");
                    assert!(mcp.contains("mcp-acceptance-marker"),"{mcp}");
                } else {
                    for (output,reason) in [
                        (&write,"Workspace metadata or Host-private files cannot be granted"),
                        (&web,"HTTP call authority is retired or denied"),
                        (&mcp,"IsolationUnavailable: this MCP server cannot prove compatibility with the Run's sandbox floor"),
                    ] {assert!(output.contains(reason),"{output}");}
                }
            }
        }
        Ok::<_,Box<dyn Error + Send + Sync>>(())
    })).catch_unwind().await;
    let cleanup = tokio::time::timeout(Duration::from_secs(30), rig.finish()).await?;
    server.abort();
    assert!(cleanup.is_empty(), "{cleanup:?}");
    match outcome {
        Ok(result) => result??,
        Err(panic) => std::panic::resume_unwind(panic),
    };
    Ok(())
}

async fn prepared(client: &HostClient, method: &str, input: Value) -> TestResult<LocalCall> {
    let mut pending = client
        .call("agent", method.into(), input, Attachments::new())
        .await?;
    pending.start().await?;
    assert!(matches!(pending.receive().await?, Reply::Prepared { .. }));
    Ok(pending)
}
async fn confirm(mut pending: LocalCall) -> TestResult<Value> {
    let Reply::Mutation { reply, cleanup } =
        pending.confirm(json!({"test":"preset-acceptance"})).await?
    else {
        return Err("mutation reply missing".into());
    };
    cleanup?;
    let Receipt::Recorded {
        outcome:
            OperationOutcome::Returned {
                result: OperationResult::Success { value },
            },
        cleanup: OperationCleanup::Confirmed,
    } = reply.receipt
    else {
        return Err("mutation did not commit".into());
    };
    pending.close().await?;
    Ok(value)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn preset_composes_platform_and_workspace_instructions_and_forks_frozen_role()
-> TestResult<()> {
    let mut rig = Rig::new()?;
    let mut provider = Provider::start().await?;
    let outcome = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(90), async {
        let base = rig.directory.path().to_path_buf();
        std::fs::create_dir_all(base.join("home/.maka"))?;
        std::fs::write(
            base.join("home/.maka/AGENTS.md"),
            "global-instruction-marker",
        )?;
        let boot = bootstrap_with(&base, provider.url.clone(), |config| {
            config["assistant"] = json!({"home":base.join("home")});
        })
        .await?;
        std::fs::write(
            base.join("workspace/AGENTS.md"),
            "workspace-instruction-marker",
        )?;
        attach(&mut rig, &boot).await?;
        let client = rig.client.as_ref().unwrap();
        for mutation in [
            json!({"kind":"workspace_instructions","enabled":true}),
            json!({"kind":"personalization","displayName":"platform-personalization-marker"}),
        ] {
            let prefs = call(client, "settings", "assistantPreferences", json!({})).await?;
            let updated = call(
                client,
                "settings",
                "updateAssistantPreferences",
                json!({"expectedRevision":prefs["revision"],"mutation":mutation}),
            )
            .await?;
            assert_eq!(updated["kind"], "committed", "{updated}");
        }
        let model = model(client, &provider.url, false).await?;
        let role = "# Reviewer\nFollow preset-role-marker. 中文";
        let preset = preset(client, &model, role).await?;
        let session = create(client, &base, &model, Some(&preset)).await?;
        let owner = rig.captured.lock().unwrap().clone().unwrap();
        let id = session["id"].as_str().unwrap();
        let fork = call(
            client,
            "agent",
            "fork",
            json!({"sessionId":id,"expectedRevision":owner.session(id).await?.revision,
            "position":{"kind":"end"},"title":"Forked reviewer","labels":[]}),
        )
        .await?;
        assert_eq!(fork["kind"], "forked", "{fork}");
        assert_eq!(fork["session"]["appliedPreset"], session["appliedPreset"]);
        assert_eq!(fork["session"]["backend"], session["backend"]);
        let changed = call(
            client,
            "agent",
            "updatePreset",
            json!({"id":preset["id"],"expectedRevision":1,"instruction":"replacement-role"}),
        )
        .await?;
        assert_eq!(changed["kind"], "saved");
        let empty = self::preset(client, &model, "").await?;
        let empty_session = create(client, &base, &model, Some(&empty)).await?;
        let ordinary = create(client, &base, &model, None).await?;
        let mut base_prompts = Vec::new();
        for (session, role_present) in [
            (&session, true),
            (&fork["session"], true),
            (&empty_session, false),
            (&ordinary, false),
        ] {
            let id = session["id"].as_str().unwrap();
            let sent = call(
                client,
                "agent",
                "send",
                json!({"sessionId":id,"message":"user-task-marker"}),
            )
            .await?;
            let (request, reply) = provider.next().await?;
            let text = text_messages(&request);
            for marker in [
                "global-instruction-marker",
                "workspace-instruction-marker",
                "platform-personalization-marker",
                "user-task-marker",
            ] {
                assert_eq!(text.matches(marker).count(), 1, "{text}");
            }
            assert_eq!(
                text.matches(role).count(),
                usize::from(role_present),
                "{text}"
            );
            assert_eq!(
                text.matches("# Session role").count(),
                usize::from(role_present),
                "{text}"
            );
            assert!(!text.contains("replacement-role"));
            if role_present {
                assert!(text.find("workspace-instruction-marker") < text.find(role));
                assert!(text.contains(
                    "unless the user's explicit requirements for the current task conflict"
                ));
            } else {
                base_prompts.push(
                    request["messages"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .filter(|m| m["role"] == "system")
                        .map(|m| m["content"].as_str().unwrap().replace(id, "SESSION_ID"))
                        .collect::<Vec<_>>(),
                );
            }
            reply
                .send(completion(
                    json!({"role":"assistant","content":"Reviewed."}),
                    "stop",
                ))
                .map_err(|_| "reply lost")?;
            quiescent_message(client, id, &sent["messageId"]).await?;
        }
        assert_eq!(
            base_prompts[0], base_prompts[1],
            "empty preset must leave the base prompt intact"
        );
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn preset_creation_rechecks_updates_disable_and_deletion_at_commit() -> TestResult<()> {
    let mut rig = Rig::new()?;
    let outcome = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(90), async {
        let base = rig.directory.path().to_path_buf();
        let boot = bootstrap(&base,"http://127.0.0.1:1/v1".into(),false).await?;
        attach(&mut rig,&boot).await?;
        let client = rig.client.as_ref().unwrap();
        let model = model(client,&boot.base_url,false).await?;
        for mutation in ["update","disable","delete"] {
            let preset = preset(client,&model,"original-role").await?;
            let reached = rig.completion_gate.arm("create");
            let pending = prepared(client,"create",json!({"title":"Racing create","labels":[],"presetId":preset["id"],
                "workspace":{"kind":"directory","path":base.join("workspace")}})).await?;
            let reference = pending.reference().ok_or("reference missing")?.clone();
            let committing = tokio::spawn(confirm(pending));
            let release = reached.await?;
            let (method,mut input) = if mutation == "delete" {("deletePreset",json!({"id":preset["id"],"expectedRevision":1}))}
                else {("updatePreset",json!({"id":preset["id"],"expectedRevision":1}))};
            if mutation == "update" {input["instruction"] = json!("updated-role");}
            if mutation == "disable" {input["enabled"] = json!(false);}
            let changed = call(client,"agent",method,input).await?;
            assert_eq!(changed["kind"],if mutation=="delete" {"deleted"} else {"saved"});
            release.send(()).map_err(|_| "creation gate dropped")?;
            let rejected = committing.await??;
            assert_eq!(rejected,json!({"kind":"rejected","reason":if mutation=="delete" {"preset_not_found"} else {"preset_conflict"}}));
            let observation = rig.store.as_ref().unwrap().operation(&reference)?.operation_observation().await?.unwrap();
            assert_eq!(observation.outcome,OperationOutcome::Returned {result:OperationResult::Success {value:rejected}});
        }
        let listed = call(client,"agent","list",json!({"filter":"all","position":{"kind":"start"}})).await?;
        assert!(listed["sessions"].as_array().is_some_and(Vec::is_empty),"rejected create published a Session: {listed}");
        Ok::<_,Box<dyn Error + Send + Sync>>(())
    })).catch_unwind().await;
    let cleanup = tokio::time::timeout(Duration::from_secs(30), rig.finish()).await?;
    assert!(cleanup.is_empty(), "{cleanup:?}");
    match outcome {
        Ok(result) => result??,
        Err(panic) => std::panic::resume_unwind(panic),
    };
    Ok(())
}

async fn recovered(
    rig: &Rig,
    reference: &maka_plugin_core::operation::RecoveryRef,
) -> TestResult<Value> {
    loop {
        if let Some(observation) = rig
            .store
            .as_ref()
            .unwrap()
            .operation(reference)?
            .operation_observation()
            .await?
        {
            if matches!(observation.outcome, OperationOutcome::Unresolved) {
                tokio::task::yield_now().await;
                continue;
            }
            let OperationOutcome::Returned {
                result: OperationResult::Success { value },
            } = observation.outcome
            else {
                return Err(format!("operation did not return success: {observation:?}").into());
            };
            return Ok(value);
        }
        tokio::task::yield_now().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn preset_create_and_send_preserve_atomicity_across_caller_interruption() -> TestResult<()> {
    let mut rig = Rig::new()?;
    let mut provider = Provider::start().await?;
    let outcome = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(90), async {
        let base = rig.directory.path().to_path_buf();
        let boot = bootstrap(&base, provider.url.clone(), false).await?;
        attach(&mut rig, &boot).await?;
        let client = rig.client.as_ref().unwrap();
        let model = model(client, &provider.url, false).await?;
        let preset = preset(client, &model, "interruption-role-marker").await?;
        let input = json!({"title":"Interrupted creation","labels":[],"presetId":preset["id"],
            "workspace":{"kind":"directory","path":base.join("workspace")}});
        // No caller confirmation: the original proposal must not publish anything.
        let mut cancelled = prepared(client, "create", input.clone()).await?;
        cancelled.close().await?;
        let listed = call(
            client,
            "agent",
            "list",
            json!({"filter":"all","position":{"kind":"start"}}),
        )
        .await?;
        assert_eq!(listed["sessions"], json!([]), "{listed}");
        // Caller disappears after the handler prepared the transaction but before Host commits it.
        let reached = rig.completion_gate.arm("create");
        let pending = prepared(client, "create", input).await?;
        let reference = pending
            .reference()
            .ok_or("create reference missing")?
            .clone();
        let confirming = tokio::spawn(confirm(pending));
        let release = reached.await?;
        confirming.abort();
        let _ = confirming.await;
        release.send(()).map_err(|_| "create gate lost")?;
        let created = recovered(&rig, &reference).await?;
        assert_eq!(created["kind"], "created", "{created}");
        assert_eq!(
            created["session"]["appliedPreset"]["instruction"],
            "interruption-role-marker"
        );
        let session = created["session"]["id"].as_str().unwrap();
        let input = json!({"sessionId":session,"message":"interrupted-send-marker"});
        let owner = rig.captured.lock().unwrap().clone().unwrap();
        let before = owner.mutable_session(session).await?.revision;
        let mut cancelled = prepared(client, "send", input.clone()).await?;
        cancelled.close().await?;
        assert_eq!(owner.mutable_session(session).await?.revision, before);
        assert!(provider.requests.try_recv().is_err());
        let reached = rig.completion_gate.arm("send");
        let pending = prepared(client, "send", input).await?;
        let reference = pending.reference().ok_or("send reference missing")?.clone();
        let confirming = tokio::spawn(confirm(pending));
        let release = reached.await?;
        confirming.abort();
        let _ = confirming.await;
        release.send(()).map_err(|_| "send gate lost")?;
        let sent = recovered(&rig, &reference).await?;
        assert_eq!(sent["kind"], "queued", "{sent}");
        let (request, reply) = provider.next().await?;
        let text = text_messages(&request);
        assert_eq!(text.matches("interruption-role-marker").count(), 1);
        assert_eq!(text.matches("interrupted-send-marker").count(), 1);
        reply
            .send(completion(
                json!({"role":"assistant","content":"Completed after lost reply."}),
                "stop",
            ))
            .map_err(|_| "reply lost")?;
        quiescent_message(client, session, &sent["messageId"]).await?;
        let work = call(
            client,
            "agent",
            "work",
            json!({"sessionId":session,"target":{"kind":"message","messageId":sent["messageId"]}}),
        )
        .await?;
        assert_eq!(work["execution"]["state"]["kind"], "completed", "{work}");
        assert!(
            provider.requests.try_recv().is_err(),
            "lost caller reply duplicated the model request"
        );
        assert_eq!(recovered(&rig, &reference).await?, sent);
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn preset_role_and_request_survive_physical_rate_limit_retry() -> TestResult<()> {
    let mut rig = Rig::new()?;
    let mut provider = Provider::start().await?;
    let outcome = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(90), async {
        let base = rig.directory.path().to_path_buf();
        let boot = bootstrap(&base,provider.url.clone(),false).await?;
        attach(&mut rig,&boot).await?;
        let client = rig.client.as_ref().unwrap();
        let model = model(client,&provider.url,false).await?;
        let preset = preset(client,&model,"physical-retry-role-marker").await?;
        let session = create(client,&base,&model,Some(&preset)).await?;
        let id = session["id"].as_str().unwrap();
        let sent = call(client,"agent","send",json!({"sessionId":id,"message":"Retry this task."})).await?;
        let (first,reply) = provider.next().await?;
        // Change the live preset while the accepted request is still in flight.
        assert_eq!(call(client,"agent","updatePreset",json!({"id":preset["id"],"expectedRevision":1,"instruction":"changed-after-admission"})).await?["kind"],"saved");
        reply.send(ModelReply::RateLimited).map_err(|_| "retry response lost")?;
        let (retried,reply) = provider.next().await?;
        assert_eq!(first,retried,"physical retry changed the frozen request");
        let text = text_messages(&retried);
        assert_eq!(text.matches("physical-retry-role-marker").count(),1);
        assert!(!text.contains("changed-after-admission"));
        reply.send(completion(json!({"role":"assistant","content":"Retried."}),"stop")).map_err(|_| "reply lost")?;
        let run = quiescent_message(client,id,&sent["messageId"]).await?;
        let owner = rig.captured.lock().unwrap().clone().unwrap();
        let history = facts(&owner.durable,run).await?;
        assert_eq!(history.iter().filter(|f|f["fact"]["kind"]=="step_prepared").count(),1,"retry rebuilt the logical request");
        let attempts: Vec<_> = history.iter().filter(|f|f["fact"]["kind"]=="model_attempt_prepared").collect();
        assert_eq!(attempts.len(),2);
        assert_eq!(attempts[0]["fact"]["step"],attempts[1]["fact"]["step"]);
        assert!(provider.requests.try_recv().is_err());
        Ok::<_,Box<dyn Error + Send + Sync>>(())
    })).catch_unwind().await;
    let cleanup = tokio::time::timeout(Duration::from_secs(30), rig.finish()).await?;
    assert!(cleanup.is_empty(), "{cleanup:?}");
    match outcome {
        Ok(result) => result??,
        Err(panic) => std::panic::resume_unwind(panic),
    };
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn preset_role_survives_automatic_history_compaction() -> TestResult<()> {
    let _ = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::WARN)
        .with_test_writer()
        .try_init();
    let mut rig = Rig::new()?;
    let mut provider = Provider::start().await?;
    let outcome = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(90), async {
        let base = rig.directory.path().to_path_buf();
        let boot = bootstrap(&base, provider.url.clone(), true).await?;
        attach(&mut rig, &boot).await?;
        let client = rig.client.as_ref().unwrap();
        let model = model_options(
            client,
            &provider.url,
            false,
            json!({"contextWindow":32000,"compactionThreshold":6000}),
        )
        .await?;
        let preset = preset(client, &model, "automatic-compaction-role-marker").await?;
        let session = create(client, &base, &model, Some(&preset)).await?;
        let id = session["id"].as_str().unwrap();
        let sent = call(
            client,
            "agent",
            "send",
            json!({"sessionId":id,"message":"Produce long history."}),
        )
        .await?;
        let (_, reply) = provider.next().await?;
        reply
            .send(completion(
                json!({"role":"assistant","content":"historical-padding ".repeat(2000)}),
                "stop",
            ))
            .map_err(|_| "reply lost")?;
        quiescent_message(client, id, &sent["messageId"]).await?;
        let sent = call(
            client,
            "agent",
            "send",
            json!({"sessionId":id,"message":"current-task-after-compaction"}),
        )
        .await?;
        let (summary, reply) = match provider.next().await {
            Ok(value) => value,
            Err(error) => {
                return Err(
                    format!("summary missing: {error}; {}", diagnostic(&rig, id).await?).into(),
                );
            }
        };
        assert!(
            summary["tools"].as_array().is_none_or(Vec::is_empty),
            "threshold did not trigger compaction: {summary}"
        );
        assert!(text_messages(&summary).contains("historical-padding"));
        reply
            .send(completion(
                json!({"role":"assistant","content":"compacted-history-marker"}),
                "stop",
            ))
            .map_err(|_| "summary lost")?;
        let (request, reply) = match provider.next().await {
            Ok(value) => value,
            Err(error) => {
                return Err(format!(
                    "post-compaction request missing: {error}; {}",
                    diagnostic(&rig, id).await?
                )
                .into());
            }
        };
        let text = text_messages(&request);
        assert_eq!(
            text.matches("automatic-compaction-role-marker").count(),
            1,
            "{text}"
        );
        assert!(text.contains("compacted-history-marker"), "{text}");
        assert!(text.contains("current-task-after-compaction"), "{text}");
        assert!(
            !text.contains("historical-padding"),
            "compacted history was not consumed"
        );
        reply
            .send(completion(
                json!({"role":"assistant","content":"Continued."}),
                "stop",
            ))
            .map_err(|_| "reply lost")?;
        quiescent_message(client, id, &sent["messageId"]).await?;
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

async fn diagnostic(rig: &Rig, id: &str) -> TestResult<Value> {
    let observed = call(
        rig.client.as_ref().unwrap(),
        "agent",
        "observe",
        json!({"sessionId":id}),
    )
    .await?;
    let owner = rig.captured.lock().unwrap().clone().unwrap();
    let history = if observed["run"]["runId"].is_string() {
        facts(
            &owner.durable,
            serde_json::from_value(observed["run"]["runId"].clone())?,
        )
        .await?
    } else {
        vec![]
    };
    Ok(json!({"observation":observed,"facts":history}))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn product_preset_tools_manage_and_delegate_directly() -> TestResult<()> {
    product_preset_tools(false).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn product_preset_tools_manage_and_delegate_in_code_mode() -> TestResult<()> {
    product_preset_tools(true).await
}

async fn product_preset_tools(code: bool) -> TestResult<()> {
    let mut rig = Rig::new()?;
    let mut provider = Provider::start().await?;
    let result = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(240), async {
        let base = rig.directory.path().to_path_buf();
        // Read the product declarations, so a renamed or unregistered tool breaks this route.
        let root = std::env::current_dir()?.join("../../..");
        let output = tokio::process::Command::new("node").current_dir(root)
            .args(["--input-type=module", "-e", "import {installation} from './products/maka/bundle/src/installation.ts'; console.log(JSON.stringify(installation({workspace:process.cwd(),helper:'test'}).agent.tools.filter(t=>t.target.kind==='export' && t.target.name==='agent')))"])
            .output().await?;
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        let tools: Value = serde_json::from_slice(&output.stdout)?;
        let boot = bootstrap_with(&base,provider.url.clone(),|config| {config["tools"] = tools; config["toolDiscovery"] = json!(true);}).await?;
        attach(&mut rig,&boot).await?;
        let client = rig.client.as_ref().unwrap();
        let model = model_options(client,&provider.url,code,json!({"contextWindow":128000,"compactionThreshold":100000})).await?;
        let parent = create(client,&base,&model,None).await?;
        let parent_id = parent["id"].as_str().unwrap();
        for restricted in [false, true] {
            let session = if restricted {
                call(client,"agent","create",json!({"title":"No preset tools","labels":[],
                    "tools":[],"backend":{"kind":"model","connectionId":model["connectionId"],"modelId":model["modelId"]},
                    "workspace":{"kind":"session","sessionId":parent_id}})).await?["session"].clone()
            } else { parent.clone() };
            let id = session["id"].as_str().unwrap();
            let sent = call(client,"agent","send",json!({"sessionId":id,"message":"Hello"})).await?;
            let (request,reply) = provider.next().await?;
            let system = request["messages"].as_array().unwrap().iter()
                .filter(|m| m["role"] == "system" || m["role"] == "developer")
                .filter_map(|m|m["content"].as_str()).collect::<Vec<_>>().join("\n");
            assert_eq!(system.contains("SubagentPresetCreate"), !restricted, "{system}");
            if !restricted { assert!(system.contains("ALL_TOOLS")); }
            reply.send(completion(json!({"role":"assistant","content":"Hello"}),"stop")).map_err(|_|"reply lost")?;
            quiescent_message(client,id,&sent["messageId"]).await?;
        }
        if code {
            let output = tool_round(&rig,&mut provider,parent_id,false,"exec",json!({"code":"text(ALL_TOOLS.map(t => t.name));"})).await?;
            for name in ["SubagentPresetList", "SubagentPresetRead", "SubagentPresetCreate", "SubagentPresetUpdate", "SubagentPresetDelete", "SessionCreate", "SessionSend"] {
                assert!(output.contains(name),"{output}");
            }
        } else {
            for query in ["SubagentPreset", "SessionCreate", "SessionSend"] {
                tool_round(&rig,&mut provider,parent_id,false,"tool_search",json!({"query":query,"limit":20})).await?;
            }
        }
        let input = json!({"name":"Reviewer","description":"Review code","instruction":"original","model":model});
        let output = tool_round(&rig,&mut provider,parent_id,code,"SubagentPresetCreate",input.clone()).await?;
        assert!(output.contains("saved"),"{output}");
        let list = call(client,"agent","presets",json!({})).await?;
        let id = list[0]["id"].clone();
        assert_eq!(list.as_array().unwrap().len(),1);
        assert!(list[0].get("instruction").is_none());
        let duplicate = tool_round(&rig,&mut provider,parent_id,code,"SubagentPresetCreate",input).await?;
        assert!(duplicate.contains("nameConflict"),"{duplicate}");
        let output = tool_round(&rig,&mut provider,parent_id,code,"SubagentPresetList",json!({})).await?;
        assert!(output.contains("Reviewer") && !output.contains("original"),"{output}");
        let before = call(client,"agent","preset",json!({"id":id})).await?["preset"].clone();
        let role = "# Product reviewer\nOnly analyze. **Keep full instructions**. 中文\n";
        for (revision, patch) in [(1,json!({"instruction":role})),(2,json!({"enabled":false})),(3,json!({"enabled":true}))] {
            let mut input = json!({"id":id,"expectedRevision":revision});
            input.as_object_mut().unwrap().extend(patch.as_object().unwrap().clone());
            let output = tool_round(&rig,&mut provider,parent_id,code,"SubagentPresetUpdate",input).await?;
            assert!(output.contains("saved"),"{output}");
            if revision == 1 {
                let mut expected = before.clone(); expected["instruction"] = json!(role); expected["revision"] = json!(2);
                assert_eq!(call(client,"agent","preset",json!({"id":id})).await?["preset"],expected);
            }
            if revision == 2 {
                let output = tool_round(&rig,&mut provider,parent_id,code,"SessionCreate",json!({"presetId":id,"title":"Unavailable worker","labels":[],"workspace":{"kind":"session","sessionId":parent_id}})).await?;
                assert!(output.contains("preset_disabled"),"{output}");
            }
        }
        let output = tool_round(&rig,&mut provider,parent_id,code,"SubagentPresetUpdate",json!({"id":id,"expectedRevision":1,"instruction":"stale"})).await?;
        assert!(output.contains("conflict"),"{output}");
        let output = tool_round(&rig,&mut provider,parent_id,code,"SubagentPresetRead",json!({"id":id})).await?;
        assert!(output.contains("Product reviewer"),"{output}");
        let output = tool_round(&rig,&mut provider,parent_id,code,"SessionCreate",json!({"presetId":id,"title":"Product worker","labels":[],"workspace":{"kind":"session","sessionId":parent_id}})).await?;
        assert!(output.contains("created"),"{output}");
        let listed = call(client,"agent","list",json!({"filter":"all","position":{"kind":"start"},"scope":{"kind":"children","sessionId":parent_id}})).await?;
        let child = listed["sessions"][0]["id"].as_str().ok_or_else(||format!("child missing: {listed}"))?;
        let sent = call(client,"agent","send",json!({"sessionId":parent_id,"message":"Delegate this one-off task"})).await?;
        let (_,reply) = provider.next().await?;
        let input = json!({"sessionId":child,"message":"one-off product task"});
        reply.send(if code {tool_response("exec",json!({"code":format!("text(await tools.SessionSend({input}));")}))} else {tool_response("SessionSend",input)}).map_err(|_|"send response lost")?;
        let mut saw_child = false;
        let mut saw_parent = false;
        while !saw_child || !saw_parent {
            let (request,reply) = provider.next().await?;
            let text = text_messages(&request);
            if text.contains(role) {
                assert_eq!(text.matches(role).count(),1);
                assert!(text.contains("one-off product task"));
                assert_eq!(request["model"],model["modelId"]);
                saw_child = true;
            } else { saw_parent = true; }
            reply.send(completion(json!({"role":"assistant","content":"Finished."}),"stop")).map_err(|_|"reply lost")?;
        }
        quiescent_message(client,parent_id,&sent["messageId"]).await?;
        let output = tool_round(&rig,&mut provider,parent_id,code,"SubagentPresetUpdate",json!({"id":id,"expectedRevision":4,"instruction":""})).await?;
        assert!(output.contains("saved"),"{output}");
        assert_eq!(call(client,"agent","preset",json!({"id":id})).await?["preset"]["instruction"],"");
        let output = tool_round(&rig,&mut provider,parent_id,code,"SubagentPresetDelete",json!({"id":id,"expectedRevision":5})).await?;
        assert!(output.contains("deleted"),"{output}");
        assert_eq!(call(client,"agent","preset",json!({"id":id})).await?,Value::Null);
        Ok::<_,Box<dyn Error + Send + Sync>>(())
    })).catch_unwind().await;
    drop(provider);
    let cleanup = rig.finish().await;
    assert!(matches!(result, Ok(Ok(Ok(())))), "{result:?}");
    assert!(cleanup.is_empty(), "{cleanup:?}");
    Ok(())
}
