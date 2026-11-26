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
mod ax_session_tools;
mod code_mode_budget;
mod keyed_submission;
mod mcp_connection;
mod rooms;
mod stop_queue;
use super::bot_tools::tool_response;
use std::sync::atomic::AtomicUsize;

struct Provider {
    server: MockAiServer,
    requests: tokio::sync::mpsc::Receiver<TurnHandle>,
}
impl Provider {
    async fn start() -> TestResult<Self> {
        let mut server = MockAiBuilder::new().interactive(8).start().await?;
        let requests = server.take_interactive_rx().unwrap();
        Ok(Self { server, requests })
    }

    async fn next(&mut self) -> TestResult<(Value, TurnHandle)> {
        let mut turn = tokio::time::timeout(Duration::from_secs(20), self.requests.recv())
            .await?
            .ok_or("model request missing")?;
        Ok((std::mem::take(&mut turn.request.raw_body), turn))
    }
}

fn fatal(message: &str) -> TurnPlan {
    TurnPlan::http_error(HttpErrorSpec::new(400, "invalid_request_error", message))
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn interrupted_provider_search_continues_without_replaying_the_call() -> TestResult<()> {
    let mut rig = Rig::new()?;
    rig.model_idle_timeout = Some(Duration::from_millis(600));
    let listener = tokio::net::TcpListener::from_std(rig.model_listener.try_clone()?)?;
    let mut boot = bootstrap_deployment(rig.directory.path(), format!("http://{}/v1", listener.local_addr()?), true, |cfg| {
        cfg["tools"] = json!([{"name":"WebSearch","description":"Search the web","target":{"kind":"import","name":"web"},
            "method":"search","input":"web","nestable":true,"result":"json","confirmation":"preapproved"}]);
    }).await?;
    boot.replay = true;
    attach(&mut rig, &boot).await?;
    let (requests, mut received) = tokio::sync::mpsc::channel(4);
    let wire = serve_replay(
        listener,
        Arc::default(),
        requests,
        FirstResponse::StartSearch,
    )
    .await?;
    let outcome = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(30), async {
        let client = rig.client.as_ref().unwrap();
        let model = model(client, &boot.base_url, false).await?;
        let session = create(client, rig.directory.path(), &model, None).await?;
        let id = &session["id"];
        let sent = call(
            client,
            "agent",
            "send",
            json!({"sessionId":id,"message":"Check once, then continue."}),
        )
        .await?;
        assert_eq!(sent["kind"], "queued", "{sent}");
        let target = json!({"kind":"message","messageId":sent["messageId"]});
        let work = loop {
            let work = call(
                client,
                "agent",
                "work",
                json!({"sessionId":id,"target":target}),
            )
            .await?;
            match work["execution"]["state"]["kind"].as_str() {
                Some("completed" | "cancelled" | "failed") => break work,
                _ => tokio::time::sleep(Duration::from_millis(30)).await,
            }
        };
        let first = received
            .try_recv()
            .map_err(|e| format!("original request missing ({e}): {work}"))?;
        let first: Value = serde_json::from_slice(&first)?;
        assert!(
            first["tools"]
                .as_array()
                .unwrap()
                .iter()
                .any(|tool| tool["type"] == "web_search"),
            "{first}"
        );
        assert_eq!(work["execution"]["state"]["kind"], "completed", "{work}");
        let next: Value = serde_json::from_slice(&received.try_recv()?)?;
        assert!(next.get("previous_response_id").is_none(), "{next}");
        let input = next["input"].as_array().unwrap();
        assert!(
            input
                .iter()
                .any(|item| item["content"].to_string().contains("ws_original")
                    && item["content"].to_string().contains("outcome is unknown")),
            "{next}"
        );
        assert!(!input.iter().any(|item| matches!(
            item["type"].as_str(),
            Some("web_search_call" | "function_call_output")
        )));
        assert!(received.try_recv().is_err());
        Ok::<_, Box<dyn Error + Send + Sync>>(())
    }))
    .catch_unwind()
    .await;
    wire.shutdown().await;
    assert!(rig.finish().await.is_empty());
    match outcome {
        Ok(result) => result?,
        Err(panic) => std::panic::resume_unwind(panic),
    }
}

#[test]
fn truncated_cell_image_terminates_the_run() -> TestResult<()> {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .thread_stack_size(16 * 1024 * 1024)
        .enable_all()
        .build()?
        .block_on(async { tokio::spawn(check_truncated_cell_image()).await? })
}

async fn check_truncated_cell_image() -> TestResult<()> {
    use base64::Engine as _;

    let mut rig = Rig::new()?;
    let mut provider = Provider::start().await?;
    let mut stage = "bootstrap";
    let mut image_case = "not started";
    let mut last_work = None;
    let outcome = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(45), async {
        let base = rig.directory.path().to_path_buf();
        let boot = bootstrap(&base, provider.server.base_url(), true).await?;
        stage = "attach Host";
        attach(&mut rig, &boot).await?;
        let client = rig.client.as_ref().unwrap();
        stage = "configure model";
        let model = model_options(
            client,
            &provider.server.base_url(),
            true,
            json!({"vision":true}),
        )
        .await?;

        stage = "encode complete PNG";
        let mut state = 1_u32;
        let pixels = image::RgbImage::from_fn(256, 128, |_, _| {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            let [r, g, b, _] = state.to_le_bytes();
            image::Rgb([r, g, b])
        });
        let mut png = std::io::Cursor::new(Vec::new());
        pixels.write_to(&mut png, image::ImageFormat::Png)?;
        let encoded = base64::engine::general_purpose::STANDARD.encode(png.into_inner());
        let tail = &encoded[encoded.len() - 65_536..];
        assert!(!tail.starts_with("iVBOR"));

        for (data, expected) in [(tail, "failed"), (encoded.as_str(), "completed")] {
            image_case = if expected == "failed" {
                "truncated tail"
            } else {
                "complete PNG"
            };
            last_work = None;
            stage = "create session";
            let session = create(client, &base, &model, None).await?;
            let id = session["id"].as_str().unwrap();
            stage = "send message";
            let sent = call(
                client,
                "agent",
                "send",
                json!({
                    "sessionId": id, "message": "Inspect the image.", "delivery": "queue"
                }),
            )
            .await?;
            assert_eq!(sent["kind"], "queued", "{sent}");
            stage = "wait initial model request";
            let (_, reply) = provider.next().await?;
            reply.send_plan(tool_response(
                "exec",
                json!({
                    "code": format!("image('data:image/png;base64,{data}');")
                }),
            ));

            if expected == "completed" {
                stage = "wait model request with complete PNG";
                let (request, reply) = provider.next().await?;
                assert!(
                    request["messages"]
                        .to_string()
                        .contains("data:image/png;base64,")
                );
                reply.reply_text("Valid image received.");
            }
            let target = json!({"kind":"message","messageId":sent["messageId"]});
            loop {
                stage = "wait run terminal state";
                let work = call(
                    client,
                    "agent",
                    "work",
                    json!({"sessionId":id,"target":target}),
                )
                .await?;
                let kind = work["execution"]["state"]["kind"].as_str();
                if matches!(kind, Some("completed" | "failed" | "cancelled")) {
                    assert_eq!(kind, Some(expected), "{work}");
                    break;
                }
                last_work = Some(work);
                tokio::task::yield_now().await;
            }
            assert!(
                provider.requests.try_recv().is_err(),
                "unexpected model request"
            );
        }
        Ok::<_, Box<dyn Error + Send + Sync>>(())
    }))
    .catch_unwind()
    .await;
    let context = format!(
        "stage={stage}, case={image_case}, queued_model_requests={}, last_work={last_work:?}",
        provider.requests.len()
    );
    if matches!(&outcome, Ok(Err(_))) {
        eprintln!("truncated cell image timeout: {context}");
    }
    let cleanup = rig.finish().await;
    assert!(cleanup.is_empty(), "{cleanup:?}");
    match outcome {
        Ok(Ok(result)) => {
            result.map_err(|error| format!("cell image check failed ({context}): {error}").into())
        }
        Ok(Err(error)) => Err(format!("cell image check timed out ({context}): {error}").into()),
        Err(panic) => std::panic::resume_unwind(panic),
    }
}

async fn tool_round(
    rig: &Rig,
    provider: &mut Provider,
    session: &str,
    code: bool,
    name: &str,
    input: Value,
) -> TestResult<String> {
    approved_round(rig, provider, session, code, name, input, "run").await
}

/// In a sandboxed Session that may request permissions, a Web call, a Shell call with
/// additional permissions and a file write in a read-only Session must raise a
/// request, which this approves at `scope`.
async fn approved_round(
    rig: &Rig,
    provider: &mut Provider,
    session: &str,
    code: bool,
    name: &str,
    input: Value,
    scope: &str,
) -> TestResult<String> {
    permission_round(rig, provider, session, code, name, input, Some(scope)).await
}

async fn denied_round(
    rig: &Rig,
    provider: &mut Provider,
    session: &str,
    code: bool,
    name: &str,
    input: Value,
) -> TestResult<String> {
    permission_round(rig, provider, session, code, name, input, None).await
}

async fn permission_round(
    rig: &Rig,
    provider: &mut Provider,
    session: &str,
    code: bool,
    name: &str,
    input: Value,
    approval_scope: Option<&str>,
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
    let tool = name;
    let permissions = owner
        .mutable_session(session)
        .await?
        .configuration
        .permissions;
    let approve = (((matches!(name, "WebFetch" | "WebSearch")
        || (name == "BackgroundTaskHealth" && input.get("url").is_some()))
        && permissions.access != maka_agent_api::contract::WorkspaceAccess::DangerFullAccess)
        || (name == "Shell" && input.get("additional_permissions").is_some())
        || (name == "Write"
            && permissions.access == maka_agent_api::contract::WorkspaceAccess::ReadOnly))
        && permissions.request_permissions;
    let (name, input) = if code {
        (
            "exec",
            json!({"code":format!("text(await tools.{name}({input}));"),"yield_time_ms":30000}),
        )
    } else {
        (name, input)
    };
    reply.send_plan(tool_response(name, input));
    if approve {
        tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                let pending = call(client,"agent","pendingInteractions",json!({"sessionId":session})).await?;
                if let Some(entry) = pending["entries"].as_array().unwrap().first() {
                    assert_eq!(entry["kind"],"permissions","{entry}");
                    let answer = match approval_scope {
                        Some(scope) => {
                            let record = call(client,"agent","interaction",json!({"sessionId":session,"requestId":entry["requestId"]})).await?;
                            json!({"kind":"permissions","decision":{"decision":"allow","permissions":record["request"]["request"]["permissions"],"scope":scope}})
                        }
                        None => json!({"kind":"permissions","decision":{"decision":"deny"}}),
                    };
                    let responded = call(client,"agent","respond",json!({"sessionId":session,"requestId":entry["requestId"],"answer":answer})).await?;
                    assert_eq!(responded["kind"],"recorded","{responded}; {entry}");
                    return Ok::<_,Box<dyn Error + Send + Sync>>(());
                }
                tokio::task::yield_now().await;
            }
        }).await.map_err(|_| format!("{tool} raised no permission request"))??;
    }
    let (request, reply) = match provider.next().await {
        Ok(request) => request,
        Err(error) => {
            return Err(
                format!("after {name}: {error}; {}", diagnostic(rig, session).await?).into(),
            );
        }
    };
    let messages = request["messages"].as_array().unwrap();
    let last_tool = messages
        .iter()
        .rposition(|message| message["role"] == "tool")
        .ok_or("tool reply missing")?;
    // Chat Completions can carry a tool image in the following user message.
    let output = serde_json::to_string(&messages[last_tool..])?;
    reply.reply_text("Done.");
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
async fn code_mode_turn_pages_only_image_results_and_keeps_its_latest_four() -> TestResult<()> {
    let mut rig = Rig::new()?;
    let mut provider = Provider::start().await?;
    let base = rig.directory.path().to_path_buf();
    let boot = bootstrap_with(&base, provider.server.base_url(), |config| {
        config["tools"] = json!([{"name":"Read","description":"Read local file","target":{"kind":"import","name":"files"},"method":"read","nestable":true,"result":"image","confirmation":"preapproved"}]);
    }).await?;
    for i in 0..25 {
        image::RgbImage::from_pixel(1, 1, image::Rgb([i, 0, 0]))
            .save(base.join(format!("workspace/{i}.png")))?;
    }
    attach(&mut rig, &boot).await?;
    let client = rig.client.as_ref().unwrap();
    let model = model_options(
        client,
        &provider.server.base_url(),
        true,
        json!({"vision":true}),
    )
    .await?;
    let session = create(client, &base, &model, None).await?;
    let id = session["id"].as_str().unwrap();
    let sent = call(
        client,
        "agent",
        "send",
        json!({"sessionId":id,"message":"Read the images."}),
    )
    .await?;
    // Put a cell completion on each side of the 24-result page boundary.
    for (start, end) in [(0, 12), (12, 25)] {
        let (_, reply) = provider.next().await?;
        reply.send_plan(TurnPlan::new().push_tool_call(format!("cell-{start}"), "exec", json!({
            "code": format!("for (let i={start}; i<{end}; i++) {{ const r = await tools.Read({{path:i+'.png'}}); if (i+1==={end}) image(r); }}"),
            "yield_time_ms": 30000
        })).finish(FinishReason::ToolCalls));
    }
    provider.next().await?.1.reply_text("Done.");
    tokio::time::timeout(
        Duration::from_secs(20),
        quiescent_message(client, id, &sent["messageId"]),
    )
    .await??;
    let history = call(
        client,
        "agent",
        "history",
        json!({"sessionId":id,"position":{"kind":"tail"},"view":"chat","includeThinking":false}),
    )
    .await?;
    let summary = history["chunks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["foldedWork"].is_object())
        .ok_or("missing folded work")?;
    let mut query =
        json!({"sessionId":id,"position":summary["position"],"through":history["through"]});
    let first = call(client, "agent", "historyImages", query.clone()).await?;
    let page = first["tools"].as_array().unwrap();
    assert_eq!(page.len(), 24);
    assert_eq!(first["next"], page[23]["result"]["position"]["sequence"]);
    query["after"] = first["next"].clone();
    let last = call(client, "agent", "historyImages", query).await?;
    let rest = last["tools"].as_array().unwrap();
    assert_eq!(rest.len(), 1);
    assert!(last["next"].is_null());
    let positions: Vec<_> = page
        .iter()
        .chain(rest)
        .map(|tool| &tool["result"]["position"])
        .collect();
    assert!(
        positions
            .windows(2)
            .all(|pair| pair[0]["sequence"].as_u64().unwrap()
                < pair[1]["sequence"].as_u64().unwrap())
    );
    assert_eq!(summary["foldedWork"]["imageCount"], 25);
    let previews = summary["foldedWork"]["images"].as_array().unwrap();
    assert_eq!(
        previews
            .iter()
            .map(|image| &image["position"])
            .collect::<Vec<_>>(),
        positions[21..]
    );
    assert!(rig.finish().await.is_empty());
    Ok(())
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
    let search_calls = Arc::new(AtomicUsize::new(0));
    let mcp_calls = Arc::new(AtomicUsize::new(0));
    let web = web_calls.clone();
    let search = search_calls.clone();
    let mcp = mcp_calls.clone();
    let app = axum::Router::new()
        .route("/page",axum::routing::get(move || {let calls = web.clone(); async move {
            calls.fetch_add(1,Ordering::SeqCst); "web-acceptance-marker"
        }}))
        // Larger than the response channel, so WebFetch closes the body unread.
        .route("/missing", axum::routing::get(|| async {
            (axum::http::StatusCode::NOT_FOUND, "missing ".repeat(32 * 1024))
        }))
        // A POST search backend rejects the query with a large error page.
        .route("/limited", axum::routing::post(|| async {
            (axum::http::StatusCode::TOO_MANY_REQUESTS, "limited ".repeat(32 * 1024))
        }))
        .route("/search", axum::routing::get(move |uri: axum::http::Uri| {
            let search = search.clone();
            async move {
                assert_eq!(uri.query(), Some("q=Rust"));
                search.fetch_add(1, Ordering::SeqCst);
                (
                    [("content-type", "application/json")],
                    json!({"results":[{"url":"https://www.rust-lang.org/"}]}).to_string(),
                )
            }
        }))
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
        let boot = bootstrap_with(&base,provider.server.base_url(),|config| {
            config["tools"] = json!([
                {"name":"Read","description":"Read local file","target":{"kind":"import","name":"files"},"method":"read","nestable":true,"result":"image","confirmation":"preapproved"},
                {"name":"Write","description":"Write local file","target":{"kind":"import","name":"files"},"method":"write","nestable":true,"result":"json","confirmation":"preapproved"},
                {"name":"WebFetch","description":"Fetch a URL","target":{"kind":"import","name":"web"},"method":"fetch","input":"web","nestable":true,"result":"json","confirmation":"preapproved"},
                {"name":"WebSearch","description":"Search the web","target":{"kind":"import","name":"web"},"method":"search","input":"web","nestable":true,"result":"json","confirmation":"preapproved"}
            ]);
            config["mcpServers"] = json!([{"name":"fixture","transport":{"type":"streamable_http","url":format!("{address}/mcp")}}]);
        }).await?;
        std::fs::write(base.join("workspace/input.txt"),"local-acceptance-marker")?;
        image::RgbImage::from_pixel(17, 13, image::Rgb([19, 23, 31]))
            .save(base.join("workspace/input.png"))?;
        attach(&mut rig,&boot).await?;
        let client = rig.client.as_ref().unwrap();
        let web = call(client,"web","snapshot",json!({})).await?;
        assert_eq!(call(client,"web","save",json!({"revision":web["revision"],"settings":{
            "enabled":true,"source":"model","backend":{"kind":"custom","endpoint":{
                "url":format!("{address}/search"),"method":"get","urlParameters":{},"body":{},"auth":null,
                "query":{"location":"query","name":"q"},"limit":null,
                "results":{"list":"/results","url":"/url","title":null,"snippet":null}
            }}
        }})).await?["kind"],"updated");
        let model = model_options(client,&provider.server.base_url(),code,json!({"vision":true})).await?;
        let preset = preset(client,&model,"Keep the reviewer role.").await?;
        let session = create(client, &base, &model, None).await?;
        let id = session["id"].as_str().unwrap();
        for (access, requests) in [("danger_full_access", false), ("workspace_write", true), ("workspace_write", false)] {
            let owner = rig.captured.lock().unwrap().clone().unwrap();
            let revision = owner.mutable_session(id).await?.revision;
            let changed = call(client, "agent", "metadata", json!({
                "sessionId":id,"expectedRevision":revision,"title":"Search permissions","labels":[],
                "permissions":{"settings":{"access":access,"requestPermissions":requests},"revokeGrants":true}
            })).await?;
            assert_eq!(changed["kind"], "committed", "{changed}");
            let before = search_calls.load(Ordering::SeqCst);
            let output = tool_round(&rig, &mut provider, id, code, "WebSearch", json!({"query":"Rust","limit":1})).await?;
            let allowed = access == "danger_full_access" || requests;
            assert_eq!(search_calls.load(Ordering::SeqCst) - before, usize::from(allowed), "{output}");
            if allowed {
                assert!(output.contains("https://www.rust-lang.org/"), "{output}");
            } else {
                assert!(output.contains("Workspace policy does not allow requesting additional permissions"), "{output}");
            }
            if requests {
                // An HTTP error page is an ordinary result, not an unknown effect.
                let missing = tool_round(&rig, &mut provider, id, code, "WebFetch", json!({"url":format!("{address}/missing")})).await?;
                assert!(missing.contains("WebFetch failed with HTTP 404"), "{missing}");
                assert!(!missing.contains("outcome unknown"), "{missing}");
                // So is an error page from a search backend that queries with POST.
                let web = call(client,"web","snapshot",json!({})).await?;
                assert_eq!(call(client,"web","save",json!({"revision":web["revision"],"settings":{
                    "enabled":true,"source":"model","backend":{"kind":"custom","endpoint":{
                        "url":format!("{address}/limited"),"method":"post","urlParameters":{},"body":{},"auth":null,
                        "query":{"location":"body","name":"query"},"limit":null,
                        "results":{"list":"/results","url":"/url","title":null,"snippet":null}
                    }}
                }})).await?["kind"],"updated");
                let limited = tool_round(&rig, &mut provider, id, code, "WebSearch", json!({"query":"Rust","limit":1})).await?;
                assert!(limited.contains("WebSearch rate limit exceeded"), "{limited}");
                assert!(!limited.contains("outcome unknown"), "{limited}");
            }
        }
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
                let (image_tool, image_input) = if code {
                    ("exec", json!({"code":"image(await tools.Read({ path: 'input.png' }));", "yield_time_ms":30000}))
                } else {
                    ("Read", json!({"path":"input.png"}))
                };
                let read = tool_round(&rig,&mut provider,id,false,image_tool,image_input).await?;
                assert!(read.contains("data:image/png;base64,"),"{read}");
                let history = call(client,"agent","history",json!({
                    "sessionId":id,"position":{"kind":"tail"},"includeThinking":false,"view":"conversation"
                })).await?;
                let result = history["chunks"].as_array().unwrap().iter().rev()
                    .find(|row| row["tool"]["call"]["name"] == "Read" && row["tool"]["result"].is_object())
                    .ok_or("Read result missing from conversation history")?;
                let result = &result["tool"]["result"];
                assert_eq!((result["image"].as_bool(), result["images"].as_u64()), (Some(false), Some(1)));
                let image = call(client,"agent","toolImage",json!({
                    "sessionId":id,"through":history["through"],"position":result["position"],"image":0,"offset":0
                })).await?;
                use base64::Engine as _;
                let bytes = base64::engine::general_purpose::STANDARD.decode(image["data"].as_str().unwrap())?;
                assert_eq!(bytes, std::fs::read(base.join("workspace/input.png"))?);
                // The Turn's image list names that same result, with the call that made it.
                let listed = call(client,"agent","historyImages",json!({
                    "sessionId":id,"through":history["through"],"position":result["position"]
                })).await?;
                let tools = listed["tools"].as_array().unwrap();
                assert_eq!(tools.len(), 1, "{listed}");
                assert_eq!((&tools[0]["call"]["name"], &tools[0]["result"]), (&json!("Read"), result), "{listed}");
                assert!(listed["next"].is_null(), "{listed}");
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
                        (&write,"Workspace policy does not allow requesting additional permissions"),
                        (&web,"Workspace policy does not allow requesting additional permissions"),
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

/// Network grants stay with the tool family that asked: a Web grant names
/// origins the Host fetches, a Shell grant opens sockets for the child process.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shell_and_web_network_grants_stay_with_their_tools() -> TestResult<()> {
    let _ = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::WARN)
        .with_test_writer()
        .try_init();
    let mut rig = Rig::new()?;
    let mut provider = Provider::start().await?;
    let calls = Arc::new(AtomicUsize::new(0));
    let counted = calls.clone();
    let app = axum::Router::new().route(
        "/page",
        axum::routing::get(move || {
            let calls = counted.clone();
            async move {
                calls.fetch_add(1, Ordering::SeqCst);
                "network-grant-marker"
            }
        }),
    );
    // Two origins, so a Web call can need a destination no earlier grant names.
    let mut addresses = Vec::new();
    let mut servers = Vec::new();
    for _ in 0..2 {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
        addresses.push(format!("http://{}", listener.local_addr()?));
        let app = app.clone();
        servers.push(tokio::spawn(
            async move { axum::serve(listener, app).await },
        ));
    }
    let outcome = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(240), async {
        let base = rig.directory.path().to_path_buf();
        let boot = bootstrap_with(&base, provider.server.base_url(), |config| {
            config["tools"] = json!([
                {"name":"Shell","description":"Run a command","target":{"kind":"import","name":"processes"},"method":"execute","input":"shell","nestable":true,"result":"json","confirmation":"preapproved"},
                {"name":"BackgroundTaskHealth","description":"Probe a running service","target":{"kind":"import","name":"processes"},"method":"health","result":"json","confirmation":"preapproved"},
                {"name":"ProcessInput","description":"Write to a background process","target":{"kind":"import","name":"processes"},"method":"writeStdin","nestable":true,"result":"json","confirmation":"preapproved"},
                {"name":"WebFetch","description":"Fetch a URL","target":{"kind":"import","name":"web"},"method":"fetch","input":"web","nestable":true,"result":"json","confirmation":"preapproved"}
            ]);
        }).await?;
        attach(&mut rig, &boot).await?;
        let client = rig.client.as_ref().unwrap();
        let model = model(client, &provider.server.base_url(), false).await?;
        let session = create(client, &base, &model, None).await?;
        let id = session["id"].as_str().unwrap();
        let owner = rig.captured.lock().unwrap().clone().unwrap();
        let revision = owner.mutable_session(id).await?.revision;
        let changed = call(client, "agent", "metadata", json!({
            "sessionId":id,"expectedRevision":revision,"title":"Network grants","labels":[],
            "permissions":{"settings":{"access":"workspace_write","requestPermissions":true},"revokeGrants":true}
        })).await?;
        assert_eq!(changed["kind"], "committed", "{changed}");
        let (first, second) = (&addresses[0], &addresses[1]);
        let network = json!({"filesystem":[],"network":"allowed"});

        // Process controls share the ceiling the launch was checked against, so
        // a PTY started under a once grant still takes input.
        let launched = approved_round(&rig, &mut provider, id, false, "Shell", json!({
            "command":"read line; echo got-$line","login":false,"pty":true,"run_in_background":true,
            "additional_permissions":network,"justification":"Start a networked terminal"
        }), "once").await?;
        let text = launched.replace('\\', "");
        let start = text.find("\"ref\":\"").ok_or_else(|| format!("process ref missing: {launched}"))? + 7;
        let reference = &text[start..start + text[start..].find('"').unwrap()];
        let input = tool_round(&rig, &mut provider, id, false, "ProcessInput", json!({"ref":reference,"input":"ready\n"})).await?;
        assert!(input.contains(r#"\"kind\":\"completed\""#), "{input}");

        let status = tool_round(&rig, &mut provider, id, false, "BackgroundTaskHealth",
            json!({"ref":reference})).await?;
        assert!(status.contains(r#"\"state\":\"not_checked\""#), "{status}");
        let probe = approved_round(&rig, &mut provider, id, false, "BackgroundTaskHealth",
            json!({"ref":reference,"url":format!("{first}/page")}), "once").await?;
        assert!(probe.contains(r#"\"httpStatus\":200"#), "{probe}");

        // A Web grant does not reach Shell. The proxy a leaked Web grant installs
        // would carry this request, so it runs without `--noproxy`.
        let before_denied_web = calls.load(Ordering::SeqCst);
        let denied_web = denied_round(&rig, &mut provider, id, false, "WebFetch", json!({"url":format!("{first}/page")})).await?;
        assert!(denied_web.contains(r#"\"kind\":\"failed\""#) && denied_web.contains("Permission request was denied"), "{denied_web}");
        assert_eq!(calls.load(Ordering::SeqCst), before_denied_web, "{denied_web}");

        let web = approved_round(&rig, &mut provider, id, false, "WebFetch", json!({"url":format!("{first}/page")}), "session").await?;
        assert!(web.contains("network-grant-marker"), "{web}");
        let before = calls.load(Ordering::SeqCst);
        let shell = tool_round(&rig, &mut provider, id, false, "Shell", json!({
            "command":format!("curl -sS {first}/page; echo curl-exit=$?"),"login":false
        })).await?;
        // curl started and could not connect (exit 7): the sandbox stopped it.
        assert!(shell.contains("curl-exit=7"), "{shell}");
        assert_eq!(calls.load(Ordering::SeqCst), before, "{shell}");

        // A Shell grant does not cover a Web destination. `--noproxy` keeps a
        // proxy configured on the test machine off loopback.
        let shell = approved_round(&rig, &mut provider, id, false, "Shell", json!({
            "command":format!("curl --noproxy '*' -sS {first}/page; echo curl-exit=$?"),"login":false,
            "additional_permissions":network,"justification":"Read the fixture page"
        }), "session").await?;
        assert!(shell.contains("network-grant-marker") && shell.contains("curl-exit=0"), "{shell}");
        assert_eq!(calls.load(Ordering::SeqCst), before + 1, "{shell}");
        // Grants are a projection rebuilt from the stored requests, which keep the
        // source: the Shell grant still serves Shell and still does not serve Web.
        owner.durable.interactions().rebuild(id).await?;
        let shell = tool_round(&rig, &mut provider, id, false, "Shell", json!({
            "command":format!("curl --noproxy '*' -sS {first}/page; echo curl-exit=$?"),"login":false
        })).await?;
        assert!(shell.contains("curl-exit=0"), "{shell}");
        assert_eq!(calls.load(Ordering::SeqCst), before + 2, "{shell}");
        let web = approved_round(&rig, &mut provider, id, false, "WebFetch", json!({"url":format!("{second}/page")}), "session").await?;
        assert!(web.contains("network-grant-marker"), "{web}");
        for (access, may_request, expected) in [
            ("workspace_write", false, r#"\"state\":\"unknown\""#),
            ("danger_full_access", false, r#"\"httpStatus\":200"#),
            ("danger_full_access", true, r#"\"httpStatus\":200"#),
        ] {
            let revision = owner.mutable_session(id).await?.revision;
            let changed = call(client, "agent", "metadata", json!({
                "sessionId":id,"expectedRevision":revision,"title":"Network grants","labels":[],
                "permissions":{"settings":{"access":access,"requestPermissions":may_request},"revokeGrants":true}
            })).await?;
            assert_eq!(changed["kind"], "committed", "{changed}");
            let before = calls.load(Ordering::SeqCst);
            let probe = tool_round(&rig, &mut provider, id, false, "BackgroundTaskHealth",
                json!({"ref":reference,"url":format!("{first}/page")})).await?;
            assert!(probe.contains(expected), "{probe}");
            assert_eq!(calls.load(Ordering::SeqCst) - before, usize::from(access == "danger_full_access"), "{probe}");
        }
        Ok::<_, Box<dyn Error + Send + Sync>>(())
    })).catch_unwind().await;
    let cleanup = tokio::time::timeout(Duration::from_secs(30), rig.finish()).await?;
    for server in servers {
        server.abort();
    }
    assert!(cleanup.is_empty(), "{cleanup:?}");
    match outcome {
        Ok(result) => result??,
        Err(panic) => std::panic::resume_unwind(panic),
    };
    Ok(())
}

/// Read only stops writes until the user approves them, so a Session that may ask
/// raises a request for each write instead of failing it.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn read_only_writes_ask_for_permission() -> TestResult<()> {
    let mut rig = Rig::new()?;
    let mut provider = Provider::start().await?;
    let outcome = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(240), async {
        let base = rig.directory.path().to_path_buf();
        let boot = bootstrap_with(&base, provider.server.base_url(), |config| {
            config["tools"] = json!([
                {"name":"Write","description":"Write local file","target":{"kind":"import","name":"files"},"method":"write","nestable":true,"result":"json","confirmation":"preapproved"},
                {"name":"Shell","description":"Run a command","target":{"kind":"import","name":"processes"},"method":"execute","input":"shell","nestable":true,"result":"json","confirmation":"preapproved"},
                {"name":"ProcessInput","description":"Write to a background process","target":{"kind":"import","name":"processes"},"method":"writeStdin","nestable":true,"result":"json","confirmation":"preapproved"}
            ]);
        }).await?;
        attach(&mut rig, &boot).await?;
        let client = rig.client.as_ref().unwrap();
        let model = model(client, &provider.server.base_url(), false).await?;
        let session = create(client, &base, &model, None).await?;
        let id = session["id"].as_str().unwrap();
        let owner = rig.captured.lock().unwrap().clone().unwrap();
        let revision = owner.mutable_session(id).await?.revision;
        let changed = call(client, "agent", "metadata", json!({
            "sessionId":id,"expectedRevision":revision,"title":"Read only writes","labels":[],
            "permissions":{"settings":{"access":"read_only","requestPermissions":true},"revokeGrants":true}
        })).await?;
        assert_eq!(changed["kind"], "committed", "{changed}");
        let workspace = std::fs::canonicalize(base.join("workspace"))?;

        let denied_write = denied_round(&rig, &mut provider, id, false, "Write",
            json!({"path":"denied.md","content":"blocked"})).await?;
        assert!(denied_write.contains(r#"\"kind\":\"failed\""#) && denied_write.contains("Permission request was denied"), "{denied_write}");
        assert!(!tokio::fs::try_exists(workspace.join("denied.md")).await?, "{denied_write}");

        let write = approved_round(&rig, &mut provider, id, false, "Write",
            json!({"path":"notes.md","content":"approved"}), "once").await?;
        let notes = std::fs::read_to_string(workspace.join("notes.md"))
            .map_err(|error| format!("read notes.md: {error}; Write result: {write}"))?;
        assert_eq!(notes, "approved", "{write}");

        // On Linux the sandbox must mount an existing target for an exact writable path.
        let shell_file = workspace.join("shell.txt");
        std::fs::File::create(&shell_file)?;
        let denied_shell = denied_round(&rig, &mut provider, id, false, "Shell", json!({
            "command":"echo denied > shell.txt","login":false,
            "additional_permissions":{"filesystem":[{"path":shell_file,"scope":"exact","access":"write"}],"network":"denied"},
            "justification":"Record the result"
        })).await?;
        assert!(denied_shell.contains(r#"\"kind\":\"failed\""#) && denied_shell.contains("Permission request was denied"), "{denied_shell}");
        assert_eq!(tokio::fs::read_to_string(&shell_file).await?, "", "{denied_shell}");

        let shell = approved_round(&rig, &mut provider, id, false, "Shell", json!({
            "command":"echo approved > shell.txt","login":false,
            "additional_permissions":{"filesystem":[{"path":shell_file,"scope":"exact","access":"write"}],"network":"denied"},
            "justification":"Record the result"
        }), "once").await?;
        let contents = std::fs::read_to_string(&shell_file)
            .map_err(|error| format!("read shell.txt: {error}; Shell result: {shell}"))?;
        assert_eq!(contents, "approved\n", "{shell}");

        let launched = approved_round(&rig, &mut provider, id, false, "Shell", json!({
            "command":"read line; echo got-$line","login":false,"pty":true,"run_in_background":true,
            "additional_permissions":{"filesystem":[{"path":shell_file,"scope":"exact","access":"write"}],"network":"denied"},
            "justification":"Start an interactive Shell with access to the fixture"
        }), "session").await?;
        let result = launched.replace('\\', "");
        let (_, result) = result.split_once(r#""ref":""#)
            .ok_or_else(|| format!("process ref missing: {launched}"))?;
        let (reference, _) = result.split_once('"').ok_or("incomplete process ref")?;
        let input = tool_round(&rig, &mut provider, id, false, "ProcessInput",
            json!({"ref":reference,"input":"ready\n"})).await?;
        assert!(input.contains(r#"\"acceptedBytes\":6"#), "{input}");
        Ok::<_, Box<dyn Error + Send + Sync>>(())
    })).catch_unwind().await;
    let cleanup = tokio::time::timeout(Duration::from_secs(30), rig.finish()).await?;
    assert!(cleanup.is_empty(), "{cleanup:?}");
    match outcome {
        Ok(result) => result??,
        Err(panic) => std::panic::resume_unwind(panic),
    };
    Ok(())
}

/// A session grant stays usable after the user turns permission requests off,
/// as a Web grant does.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn read_only_session_write_grant_outlasts_disabled_requests() -> TestResult<()> {
    let mut rig = Rig::new()?;
    let mut provider = Provider::start().await?;
    let outcome = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(240), async {
        let base = rig.directory.path().to_path_buf();
        let boot = bootstrap_with(&base, provider.server.base_url(), |config| {
            config["tools"] = json!([
                {"name":"Write","description":"Write local file","target":{"kind":"import","name":"files"},"method":"write","nestable":true,"result":"json","confirmation":"preapproved"}
            ]);
        }).await?;
        attach(&mut rig, &boot).await?;
        let client = rig.client.as_ref().unwrap();
        let model = model(client, &provider.server.base_url(), false).await?;
        let session = create(client, &base, &model, None).await?;
        let id = session["id"].as_str().unwrap();
        let owner = rig.captured.lock().unwrap().clone().unwrap();
        let workspace = std::fs::canonicalize(base.join("workspace"))?;
        for (requests, revoke) in [(true, true), (false, false)] {
            let revision = owner.mutable_session(id).await?.revision;
            let changed = call(client, "agent", "metadata", json!({
                "sessionId":id,"expectedRevision":revision,"title":"Kept write grant","labels":[],
                "permissions":{"settings":{"access":"read_only","requestPermissions":requests},"revokeGrants":revoke}
            })).await?;
            assert_eq!(changed["kind"], "committed", "{changed}");
            let content = if requests { "approved" } else { "kept" };
            let write = approved_round(&rig, &mut provider, id, false, "Write",
                json!({"path":"notes.md","content":content}), "session").await?;
            assert_eq!(std::fs::read_to_string(workspace.join("notes.md"))?, content, "{write}");
        }
        Ok::<_, Box<dyn Error + Send + Sync>>(())
    })).catch_unwind().await;
    let cleanup = tokio::time::timeout(Duration::from_secs(30), rig.finish()).await?;
    assert!(cleanup.is_empty(), "{cleanup:?}");
    match outcome {
        Ok(result) => result??,
        Err(panic) => std::panic::resume_unwind(panic),
    };
    Ok(())
}

/// A conversation that may ask still cannot be granted a write its caller does
/// not hold: a read-only conversation that sends it work keeps it read-only.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn child_write_approval_stays_within_its_caller() -> TestResult<()> {
    let mut rig = Rig::new()?;
    let mut provider = Provider::start().await?;
    let outcome = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(240), async {
        let base = rig.directory.path().to_path_buf();
        let boot = bootstrap_with(&base, provider.server.base_url(), |config| {
            config["tools"] = json!([
                {"name":"Write","description":"Write local file","target":{"kind":"import","name":"files"},"method":"write","nestable":true,"result":"json","confirmation":"preapproved"},
                {"name":"SessionSend","description":"Send a message","target":{"kind":"export","name":"agent"},"method":"sessionSend","nestable":true,"result":"json","confirmation":"preapproved"}
            ]);
        }).await?;
        attach(&mut rig, &boot).await?;
        let client = rig.client.as_ref().unwrap();
        let model = model(client, &provider.server.base_url(), false).await?;
        let owner = rig.captured.lock().unwrap().clone().unwrap();
        let mut ids = Vec::new();
        for (title, requests) in [("Read-only caller", false), ("Worker that may ask", true)] {
            let session = create(client, &base, &model, None).await?;
            let id = session["id"].as_str().unwrap().to_owned();
            let revision = owner.mutable_session(&id).await?.revision;
            let changed = call(client, "agent", "metadata", json!({
                "sessionId":id,"expectedRevision":revision,"title":title,"labels":[],
                "permissions":{"settings":{"access":"read_only","requestPermissions":requests},"revokeGrants":true}
            })).await?;
            assert_eq!(changed["kind"], "committed", "{changed}");
            ids.push(id);
        }
        let (caller, worker) = (&ids[0], &ids[1]);
        let sent = call(client, "agent", "send", json!({"sessionId":caller,"message":"caller-marker"})).await?;
        assert_eq!(sent["kind"], "queued", "{sent}");
        let (_, reply) = provider.next().await?;
        reply.send_plan(tool_response("SessionSend", json!({
            "sessionId":worker,"message":"worker-marker","onComplete":"none"
        })));
        // The caller's follow-up and the worker's requests arrive in either order.
        let mut output = None;
        let mut caller_done = false;
        while output.is_none() || !caller_done {
            let (request, reply) = provider.next().await.map_err(|error| {
                format!("worker write was not settled: {error}")
            })?;
            let messages = request["messages"].as_array().unwrap();
            let tool = messages.iter().rposition(|message| message["role"] == "tool");
            let response = if text_messages(&request).contains("caller-marker") {
                caller_done = tool.is_some();
                TurnPlan::text("Sent.")
            } else if let Some(tool) = tool {
                output = Some(serde_json::to_string(&messages[tool..])?);
                TurnPlan::text("Done.")
            } else {
                tool_response("Write", json!({"path":"notes.md","content":"worker"}))
            };
            reply.send_plan(response);
        }
        let output = output.unwrap();
        assert!(output.contains("beyond what this conversation's caller can write"), "{output}");
        let pending = call(client, "agent", "pendingInteractions", json!({"sessionId":worker})).await?;
        assert!(pending["entries"].as_array().unwrap().is_empty(), "{pending}");
        assert!(!base.join("workspace/notes.md").exists(), "{output}");
        quiescent_message(client, caller, &sent["messageId"]).await?;
        Ok::<_, Box<dyn Error + Send + Sync>>(())
    })).catch_unwind().await;
    let cleanup = tokio::time::timeout(Duration::from_secs(30), rig.finish()).await?;
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
        let boot = bootstrap_with(&base, provider.server.base_url(), |config| {
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
        let model = model(client, &provider.server.base_url(), false).await?;
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
            reply.reply_text("Reviewed.");
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
        let boot = bootstrap(&base, provider.server.base_url(), false).await?;
        attach(&mut rig, &boot).await?;
        let client = rig.client.as_ref().unwrap();
        let model = model(client, &provider.server.base_url(), false).await?;
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
        reply.reply_text("Completed after lost reply.");
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
        let boot = bootstrap(&base,provider.server.base_url(),false).await?;
        attach(&mut rig,&boot).await?;
        let client = rig.client.as_ref().unwrap();
        let model = model(client,&provider.server.base_url(),false).await?;
        let preset = preset(client,&model,"physical-retry-role-marker").await?;
        let session = create(client,&base,&model,Some(&preset)).await?;
        let id = session["id"].as_str().unwrap();
        let sent = call(client,"agent","send",json!({"sessionId":id,"message":"Retry this task."})).await?;
        let (first,reply) = provider.next().await?;
        // Change the live preset while the accepted request is still in flight.
        assert_eq!(call(client,"agent","updatePreset",json!({"id":preset["id"],"expectedRevision":1,"instruction":"changed-after-admission"})).await?["kind"],"saved");
        reply.send_plan(TurnPlan::http_error(HttpErrorSpec::plain(429, "rate limited").with_header("retry-after", "0")));
        let (retried,reply) = provider.next().await?;
        assert_eq!(first,retried,"physical retry changed the frozen request");
        let text = text_messages(&retried);
        assert_eq!(text.matches("physical-retry-role-marker").count(),1);
        assert!(!text.contains("changed-after-admission"));
        reply.reply_text("Retried.");
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
        let boot = bootstrap(&base, provider.server.base_url(), true).await?;
        attach(&mut rig, &boot).await?;
        let client = rig.client.as_ref().unwrap();
        let model = model_options(
            client,
            &provider.server.base_url(),
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
        reply.reply_text("historical-padding ".repeat(2000));
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
        reply.reply_text("compacted-history-marker");
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
        reply.reply_text("Continued.");
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

async fn product_agent_tools(include_read: bool) -> TestResult<Value> {
    let filter = if include_read {
        "(t.target.kind === 'export' && t.target.name === 'agent') ||          (t.target.kind === 'import' && t.target.name === 'files' && t.name === 'Read')"
    } else {
        "t.target.kind === 'export' && t.target.name === 'agent'"
    };
    let output = tokio::process::Command::new("node")
        .current_dir(std::env::current_dir()?.join("../../.."))
        .args([
            "--input-type=module",
            "-e",
            &format!(
                "import {{installation}} from './products/maka/bundle/src/installation.ts';                 const {{tools}} = installation({{workspace:process.cwd(),helper:'test'}}).agent;                 console.log(JSON.stringify(tools.filter(t => {filter})))"
            ),
        ])
        .output()
        .await?;
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(serde_json::from_slice(&output.stdout)?)
}

async fn product_preset_tools(code: bool) -> TestResult<()> {
    let mut rig = Rig::new()?;
    let mut provider = Provider::start().await?;
    let result = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(240), async {
        let base = rig.directory.path().to_path_buf();
        // Read the product declarations, so a renamed or unregistered tool breaks this route.
        let tools = product_agent_tools(false).await?;
        let boot = bootstrap_with(&base,provider.server.base_url(),|config| {config["tools"] = tools; config["toolDiscovery"] = json!(true);}).await?;
        attach(&mut rig,&boot).await?;
        let client = rig.client.as_ref().unwrap();
        let model = model_options(client,&provider.server.base_url(),code,json!({"contextWindow":128000,"compactionThreshold":100000})).await?;
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
            let advertised = serde_json::to_string(&request["tools"]).unwrap();
            assert_eq!(advertised.contains("SubagentPresetCreate"), !restricted, "{advertised}");
            reply.reply_text("Hello");
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
        let input = json!({"sessionId":child,"message":"one-off product task","onComplete":"none"});
        reply.send_plan(if code {tool_response("exec",json!({"code":format!("text(await tools.SessionSend({input}));")}))} else {tool_response("SessionSend",input)});
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
            reply.reply_text("Finished.");
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn interrupted_stream_and_silent_provider_are_retried() -> TestResult<()> {
    let mut rig = Rig::new()?;
    rig.model_idle_timeout = Some(Duration::from_millis(600));
    let mut provider = Provider::start().await?;
    let outcome = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(30), async {
        let base = rig.directory.path().to_path_buf();
        let boot = bootstrap(&base, provider.server.base_url(), false).await?;
        attach(&mut rig, &boot).await?;
        let client = rig.client.as_ref().unwrap();
        let model = model(client, &provider.server.base_url(), false).await?;
        let session = create(client, &base, &model, None).await?;
        let id = session["id"].as_str().unwrap();
        for silent in [true, false] {
            let sent = call(
                client,
                "agent",
                "send",
                json!({"sessionId":id,"message":"Write the summary.","delivery":"queue"}),
            )
            .await?;
            let (_, reply) = provider.next().await?;
            if silent {
                // Hold the response past the idle timeout; no byte reaches the client.
                tokio::time::sleep(Duration::from_millis(1200)).await;
                drop(reply);
            } else {
                // Reasoning metadata makes the request unsafe to send again verbatim.
                reply.send_plan(
                    TurnPlan::new()
                        .push_reasoning("Planning.")
                        .push_text("First half.")
                        .push(TurnEvent::TruncateEof),
                );
            }
            let (retry_request, reply) = provider.next().await?;
            if !silent {
                let messages = retry_request["messages"].to_string();
                assert!(
                    !messages.contains("Planning.") && !messages.contains("First half."),
                    "interrupted draft leaked into retry request: {messages}"
                );
            }
            reply.reply_text("Done.");
            let target = json!({"kind":"message","messageId":sent["messageId"]});
            let work = loop {
                let work = call(
                    client,
                    "agent",
                    "work",
                    json!({"sessionId":id,"target":target}),
                )
                .await?;
                match work["execution"]["state"]["kind"].as_str() {
                    Some("completed" | "failed" | "cancelled") => break work,
                    _ => tokio::time::sleep(Duration::from_millis(30)).await,
                }
            };
            assert_eq!(
                work["execution"]["state"]["kind"], "completed",
                "silent={silent} {work}"
            );
        }
        Ok::<_, Box<dyn Error + Send + Sync>>(())
    }))
    .catch_unwind()
    .await;
    let cleanup = tokio::time::timeout(Duration::from_secs(30), rig.finish()).await?;
    match outcome {
        Ok(result) => result??,
        Err(panic) => std::panic::resume_unwind(panic),
    }
    assert!(cleanup.is_empty(), "{cleanup:?}");
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn model_hears_about_one_withheld_response_and_a_second_ends_the_run() -> TestResult<()> {
    let mut rig = Rig::new()?;
    let mut provider = Provider::start().await?;
    let outcome = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(30), async {
        let base = rig.directory.path().to_path_buf();
        let boot = bootstrap(&base, provider.server.base_url(), false).await?;
        attach(&mut rig, &boot).await?;
        let client = rig.client.as_ref().unwrap();
        let model = model(client, &provider.server.base_url(), false).await?;
        let session = create(client, &base, &model, None).await?;
        let id = session["id"].as_str().unwrap();
        let withheld = |reason: &str| {
            let plan = TurnPlan::new().with_response_id("r").push_text("Refused draft.");
            if reason == "content_filter" {
                return plan.finish(FinishReason::ContentFilter);
            }
            // Chat Completions has no standard recitation finish reason.
            plan.push(TurnEvent::RawJson {
                value: json!({"id":"r","object":"chat.completion.chunk","created":1,"model":"llama3.2",
                    "choices":[{"index":0,"delta":{},"finish_reason":reason}]})
            }).push(TurnEvent::RawBytes(axum::body::Bytes::from_static(b"data: [DONE]\n\n"))).push(TurnEvent::TruncateEof)
        };
        for twice in [false, true] {
            let sent = call(
                client,
                "agent",
                "send",
                json!({"sessionId":id,"message":"Analyze the sample.","delivery":"queue"}),
            )
            .await?;
            let (_, reply) = provider.next().await?;
            reply
                .send_plan(withheld(if twice {
                    "recitation"
                } else {
                    "content_filter"
                }));
            let (retried, reply) = provider.next().await?;
            let text = text_messages(&retried);
            assert!(
                text.contains("[Host] The model provider did not return"),
                "{retried}"
            );
            assert!(
                text.contains(if twice {
                    "recitation"
                } else {
                    "content_filter"
                }),
                "{retried}"
            );
            assert!(!text.contains("Refused draft."), "{retried}");
            if twice {
                reply
                    .send_plan(withheld("content_filter"));
            } else {
                reply
                    .reply_text("Done another way.");
            }
            let target = json!({"kind":"message","messageId":sent["messageId"]});
            let work = loop {
                let work = call(
                    client,
                    "agent",
                    "work",
                    json!({"sessionId":id,"target":target}),
                )
                .await?;
                match work["execution"]["state"]["kind"].as_str() {
                    Some("completed" | "failed" | "cancelled") => break work,
                    _ => tokio::time::sleep(Duration::from_millis(30)).await,
                }
            };
            let expected = if twice { "failed" } else { "completed" };
            assert_eq!(work["execution"]["state"]["kind"], expected, "{work}");
        }
        assert!(
            provider.requests.try_recv().is_err(),
            "a second refusal was retried"
        );
        Ok::<_, Box<dyn Error + Send + Sync>>(())
    }))
    .catch_unwind()
    .await;
    let cleanup = tokio::time::timeout(Duration::from_secs(30), rig.finish()).await?;
    match outcome {
        Ok(result) => result??,
        Err(panic) => std::panic::resume_unwind(panic),
    }
    assert!(cleanup.is_empty(), "{cleanup:?}");
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn next_turn_reads_why_the_previous_turn_failed() -> TestResult<()> {
    let mut rig = Rig::new()?;
    let mut provider = Provider::start().await?;
    let outcome = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(30), async {
        let base = rig.directory.path().to_path_buf();
        let boot = bootstrap(&base, provider.server.base_url(), false).await?;
        attach(&mut rig, &boot).await?;
        let client = rig.client.as_ref().unwrap();
        let model = model(client, &provider.server.base_url(), false).await?;
        let session = create(client, &base, &model, None).await?;
        let id = session["id"].as_str().unwrap();
        let send = |message: &'static str| {
            call(
                client,
                "agent",
                "send",
                json!({"sessionId":id,"message":message,"delivery":"queue"}),
            )
        };
        let wait_terminal = |target: Value, expected: &'static str| async move {
            loop {
                let work = call(
                    client,
                    "agent",
                    "work",
                    json!({"sessionId":id,"target":target}),
                )
                .await?;
                match work["execution"]["state"]["kind"].as_str() {
                    Some(kind) if kind == expected => return Ok::<Value, Box<dyn Error + Send + Sync>>(work),
                    Some("completed" | "failed" | "cancelled") => return Err(format!("{work}").into()),
                    _ => tokio::time::sleep(Duration::from_millis(30)).await,
                }
            }
        };

        // 1. Failed turn followed by a new user message carries the failure reason.
        let failed = send("Summarize the report.").await?;
        let (_, reply) = provider.next().await?;
        reply
            .send_plan(fatal("fixture rejected the report"));
        wait_terminal(json!({"kind":"message","messageId":failed["messageId"]}), "failed").await?;

        let next = send("Try again.").await?;
        let (request, reply) = provider.next().await?;
        let text = text_messages(&request);
        let note = text
            .find("[Host] This turn failed and ended here:")
            .ok_or_else(|| format!("failure note missing: {request}"))?;
        assert!(text[note..].contains("fixture rejected the report"), "{request}");
        assert!(note < text.find("Try again.").unwrap(), "{request}");
        reply
            .reply_text("Done.");
        quiescent_message(client, id, &next["messageId"]).await?;

        // 2. Continuing a zero-output failed run via continueRun does not append the past-tense failure note.
        let failed_again = send("Retry via continueRun.").await?;
        let (_, reply) = provider.next().await?;
        reply
            .send_plan(fatal("temporary outage"));
        let failed_work = wait_terminal(
            json!({"kind":"message","messageId":failed_again["messageId"]}),
            "failed",
        )
        .await?;
        let continued = call(
            client,
            "agent",
            "continueRun",
            json!({
                "sessionId": id,
                "sourceRunId": failed_work["execution"]["runId"],
                "sourceHighWater": failed_work["execution"]["highWater"],
                "model": {
                    "connectionId": model["connectionId"],
                    "modelId": model["modelId"]
                }
            }),
        )
        .await?;
        assert_eq!(continued["kind"], "started", "{continued}");
        let (cont_request, reply) = provider.next().await?;
        let last_msg = cont_request["messages"]
            .as_array()
            .and_then(|arr| arr.last())
            .ok_or_else(|| format!("missing last message: {cont_request}"))?;
        let last_text = last_msg.to_string();
        assert!(
            last_text.contains("Retry via continueRun.")
                && !last_text.contains("[Host] This turn failed and ended here"),
            "continueRun should end on the user prompt without a past-tense failure note: {cont_request}"
        );
        reply
            .reply_text("Recovered.");
        wait_terminal(
            json!({"kind":"run","runId":continued["execution"]["runId"]}),
            "completed",
        )
        .await?;
        Ok::<_, Box<dyn Error + Send + Sync>>(())
    }))
    .catch_unwind()
    .await;
    let cleanup = tokio::time::timeout(Duration::from_secs(30), rig.finish()).await?;
    match outcome {
        Ok(result) => result??,
        Err(panic) => std::panic::resume_unwind(panic),
    }
    assert!(cleanup.is_empty(), "{cleanup:?}");
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn preparation_model_error_fails_the_run_and_admits_the_next_queued_message() -> TestResult<()>
{
    let mut rig = Rig::new()?;
    let provider = Provider::start().await?;
    let outcome = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(30), async {
        let base = rig.directory.path().to_path_buf();
        let boot = bootstrap(&base, provider.server.base_url(), false).await?;
        attach(&mut rig, &boot).await?;
        let client = rig.client.as_ref().unwrap();
        // No request fits the declared size, so model preparation fails before sending.
        let model = model_options(
            client,
            &provider.server.base_url(),
            false,
            json!({"imageInput":{"requestBytes":1}}),
        )
        .await?;
        let session = create(client, &base, &model, None).await?;
        let id = session["id"].as_str().unwrap();
        let mut messages = Vec::new();
        for message in ["First.", "Second."] {
            let sent = call(
                client,
                "agent",
                "send",
                json!({"sessionId":id,"message":message,"delivery":"queue"}),
            )
            .await?;
            assert_eq!(sent["kind"], "queued", "{sent}");
            messages.push(sent["messageId"].clone());
        }
        for message in messages {
            let target = json!({"kind":"message","messageId":message});
            let work = loop {
                let work = call(
                    client,
                    "agent",
                    "work",
                    json!({"sessionId":id,"target":target}),
                )
                .await?;
                match work["execution"]["state"]["kind"].as_str() {
                    Some("failed") => break work,
                    Some("completed" | "cancelled") => return Err(format!("{work}").into()),
                    _ => tokio::time::sleep(Duration::from_millis(30)).await,
                }
            };
            assert!(work["execution"]["state"]["reason"].is_null(), "{work}");
        }
        let history = call(
            client,
            "agent",
            "history",
            json!({
                "sessionId": id,
                "position": {"kind": "tail"},
                "includeThinking": false,
                "view": "conversation"
            }),
        )
        .await?;
        assert!(
            history.to_string().contains("exceeds provider limit"),
            "{history}"
        );
        Ok::<_, Box<dyn Error + Send + Sync>>(())
    }))
    .catch_unwind()
    .await;
    let cleanup = tokio::time::timeout(Duration::from_secs(30), rig.finish()).await?;
    match outcome {
        Ok(result) => result??,
        Err(panic) => std::panic::resume_unwind(panic),
    }
    assert!(cleanup.is_empty(), "{cleanup:?}");
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn context_overflow_after_partial_output_compacts_and_continues() -> TestResult<()> {
    let mut rig = Rig::new()?;
    let mut provider = Provider::start().await?;
    let outcome = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(60), async {
        let base = rig.directory.path().to_path_buf();
        let boot = bootstrap(&base, provider.server.base_url(), false).await?;
        attach(&mut rig, &boot).await?;
        let client = rig.client.as_ref().unwrap();
        let model = model_options(
            client,
            &provider.server.base_url(),
            false,
            json!({"contextWindow":400000,"compactionThreshold":200000}),
        )
        .await?;
        let session = create(client, &base, &model, None).await?;
        let id = session["id"].as_str().unwrap();
        let send = async |message: &str| -> TestResult<Value> {
            let sent = call(
                client,
                "agent",
                "send",
                json!({"sessionId":id,"message":message,"delivery":"queue"}),
            )
            .await?;
            Ok(sent["messageId"].clone())
        };
        let overflow = |partial: &str| {
            TurnPlan::new()
                .push_text(partial)
                .push(TurnEvent::MidStreamError(
                    maka_mock_ai::MidStreamErrorSpec {
                        error_type: "invalid_request_error".into(),
                        code: Some("context_length_exceeded".into()),
                        message: "This model's maximum context length is 8192 tokens.".into(),
                        retryable: None,
                    },
                ))
        };
        let summary_request = |request: &Value| {
            // A summary cut to fit opens with excerpts in place of the closing instruction.
            request["messages"].as_array().is_some_and(|messages| {
                messages
                    .iter()
                    .filter_map(|message| message["content"].as_str())
                    .any(|text| {
                        text.starts_with("Summarize the captured conversation")
                            || text.starts_with("Conversation excerpts for summarization")
                    })
            })
        };
        let note = "[Host] Your previous response was cut off";

        // 170k-200k estimated tokens: the next turn summarizes in the background.
        let first = send("Produce long history.").await?;
        let (_, reply) = provider.next().await?;
        reply.reply_text("padding ".repeat(66_000));
        quiescent_message(client, id, &first).await?;

        // The overflow adopts the background summary.
        let second = send("Read the second file.").await?;
        let (one, two) = (provider.next().await?, provider.next().await?);
        let ((summary, summary_reply), (_, main_reply)) = if summary_request(&one.0) {
            (one, two)
        } else {
            (two, one)
        };
        assert!(summary_request(&summary), "{summary}");
        summary_reply.reply_text("background-summary-marker");
        main_reply.send_plan(overflow("second-partial-marker"));
        let (resumed, reply) = provider.next().await?;
        let text = text_messages(&resumed);
        assert!(
            text.contains("background-summary-marker") && text.contains(note),
            "{text}"
        );
        assert!(!text.contains("second-partial-marker"), "{text}");
        reply.reply_text("Second file read.");
        quiescent_message(client, id, &second).await?;

        // Without a candidate, the overflow requests its own summary.
        let third = send("Read the third file.").await?;
        let (main, reply) = provider.next().await?;
        assert!(
            !text_messages(&main).contains("second-partial-marker"),
            "{main}"
        );
        reply.send_plan(overflow("third-partial-marker"));
        let (summary, reply) = tokio::select! {
            request = provider.next() => request?,
            ended = quiescent_message(client, id, &third) => {
                return Err(format!("overflow ended the Run: {ended:?}").into());
            }
        };
        assert!(summary_request(&summary), "{summary}");
        assert!(
            !text_messages(&summary).contains("third-partial-marker"),
            "{summary}"
        );
        reply.reply_text("overflow-summary-marker");
        let (resumed, reply) = provider.next().await?;
        let text = text_messages(&resumed);
        assert!(
            text.contains("overflow-summary-marker") && text.contains(note),
            "{text}"
        );
        assert!(!text.contains("third-partial-marker"), "{text}");
        reply.reply_text("Third file read.");
        quiescent_message(client, id, &third).await?;
        Ok::<_, Box<dyn Error + Send + Sync>>(())
    }))
    .catch_unwind()
    .await;
    let cleanup = tokio::time::timeout(Duration::from_secs(30), rig.finish()).await?;
    match outcome {
        Ok(result) => result??,
        Err(panic) => std::panic::resume_unwind(panic),
    }
    assert!(cleanup.is_empty(), "{cleanup:?}");
    Ok(())
}

/// A request the provider rejects as too long is summarized from less than what
/// overflowed, and a summary that still overflows fails the turn with its own reason.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn overflow_summary_is_cut_below_the_request_that_overflowed() -> TestResult<()> {
    let mut rig = Rig::new()?;
    let mut provider = Provider::start().await?;
    let outcome = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(90), async {
        let base = rig.directory.path().to_path_buf();
        let boot = bootstrap(&base, provider.server.base_url(), false).await?;
        attach(&mut rig, &boot).await?;
        let client = rig.client.as_ref().unwrap();
        // The declared window is far above what the provider accepts, so nothing
        // compacts before the request is sent.
        let model = model_options(
            client,
            &provider.server.base_url(),
            false,
            json!({"contextWindow":400000,"compactionThreshold":200000}),
        )
        .await?;
        let session = create(client, &base, &model, None).await?;
        let id = session["id"].as_str().unwrap();
        let send = async |message: &str| -> TestResult<Value> {
            let sent = call(
                client,
                "agent",
                "send",
                json!({"sessionId":id,"message":message,"delivery":"queue"}),
            )
            .await?;
            Ok(sent["messageId"].clone())
        };
        let failed = async |message: &Value| -> TestResult<Value> {
            loop {
                let work = call(
                    client,
                    "agent",
                    "work",
                    json!({"sessionId":id,"target":{"kind":"message","messageId":message}}),
                )
                .await?;
                match work["execution"]["state"]["kind"].as_str() {
                    Some("failed") => return Ok(work),
                    Some("completed" | "cancelled") => {
                        return Err(format!("turn did not fail: {work}").into());
                    }
                    _ => tokio::time::sleep(Duration::from_millis(30)).await,
                }
            }
        };
        let overflow =
            || fatal("This model's maximum context length is 8192 tokens.");
        let summary_request = |request: &Value| {
            // A summary cut to fit opens with excerpts in place of the closing instruction.
            request["messages"].as_array().is_some_and(|messages| {
                messages.iter().filter_map(|message| message["content"].as_str()).any(|text| {
                    text.starts_with("Summarize the captured conversation")
                        || text.starts_with("Conversation excerpts for summarization")
                })
            })
        };

        let first = send("Produce long history.").await?;
        let (_, reply) = provider.next().await?;
        reply
            .reply_text("padding ".repeat(20_000));
        quiescent_message(client, id, &first).await?;

        // The summary of an overflowed request is smaller than that request; it
        // overflows anyway, and the turn fails saying so.
        let second = send("Read the second file.").await?;
        let (main, reply) = provider.next().await?;
        assert!(!summary_request(&main), "{main}");
        reply.send_plan(overflow());
        let (summary, reply) = tokio::select! {
            request = provider.next() => request?,
            work = failed(&second) => {
                return Err(format!("overflow ended without a summary: {:?}", work?).into());
            }
        };
        assert!(summary_request(&summary), "{summary}");
        let (asked, overflowed) = (text_messages(&summary).len(), text_messages(&main).len());
        assert!(asked < overflowed, "summary {asked} bytes, overflowed request {overflowed} bytes");
        assert!(main["tools"].as_array().is_some_and(|tools| !tools.is_empty()), "{main}");
        assert!(summary.get("tools").is_none_or(|tools| tools.as_array().is_some_and(Vec::is_empty)), "{summary}");
        reply.send_plan(overflow());
        let work = failed(&second).await?.to_string();
        assert!(!work.contains("invalid event transition"), "{work}");

        // A summary that fits lets the next turn continue from it.
        let third = send("Read the third file.").await?;
        let (_, reply) = provider.next().await?;
        reply.send_plan(overflow());
        let (summary, reply) = provider.next().await?;
        assert!(summary_request(&summary), "{summary}");
        reply
            .reply_text("overflow-summary-marker");
        let (resumed, reply) = provider.next().await?;
        let text = text_messages(&resumed);
        assert!(text.contains("overflow-summary-marker"), "{text}");
        reply
            .reply_text("Third file read.");
        quiescent_message(client, id, &third).await?;
        let history = call(
            client,
            "agent",
            "history",
            json!({"sessionId":id,"position":{"kind":"tail"},"includeThinking":false,"view":"conversation"}),
        )
        .await?
        .to_string();
        assert!(!history.contains("invalid event transition"), "{history}");
        Ok::<_, Box<dyn Error + Send + Sync>>(())
    }))
    .catch_unwind()
    .await;
    let cleanup = tokio::time::timeout(Duration::from_secs(30), rig.finish()).await?;
    match outcome {
        Ok(result) => result??,
        Err(panic) => std::panic::resume_unwind(panic),
    }
    assert!(cleanup.is_empty(), "{cleanup:?}");
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn recall_model_observes_current_fact_and_policy() -> TestResult<()> {
    let mut rig = Rig::new()?;
    let mut provider = Provider::start().await?;
    let outcome = AssertUnwindSafe(async {
        let base = rig.directory.path().to_path_buf();
        let boot = bootstrap_with(&base, provider.server.base_url(), |config| {
            config["recall"] = json!(true);
        }).await?;
        attach(&mut rig, &boot).await?;
        let client = rig.client.as_ref().unwrap();
        let model = model(client, &provider.server.base_url(), false).await?;
        let selected = create(client, &base, &model, None).await?;
        let session = selected["id"].as_str().unwrap();
        let scope = json!({"kind": "project", "sessionId": session});
        let saved = call(client, "agent", "changeMemory", json!({
            "scope": scope, "edit": {"kind": "create", "body": "Apricot database 🧭 ა"}
        })).await?;
        assert_eq!(saved["kind"], "saved", "{saved}");
        for terms in [json!(["Ა", "ა"]), json!(["apri"])] {
            let result = super::memory::recall_page(
                client, json!({"session_id": session, "terms": terms})
            ).await?;
            assert_eq!(result["facts"][0]["id"], saved["id"], "{terms}: {result}");
        }
        let worker = call(client, "agent", "create", json!({
            "title": "Restricted reader", "labels": [], "tools": ["Recall"],
            "backend": {"kind": "model", "connectionId": model["connectionId"], "modelId": model["modelId"]},
            "workspace": {"kind": "session", "sessionId": session}
        })).await?;
        let worker = worker["session"]["id"].as_str().ok_or("missing restricted worker")?;
        for (reader, enabled, expected_gap) in [
            (session, true, None),
            (worker, true, Some("agent_memory_model_read_not_admitted")),
            (session, false, Some("agent_memory_read_disabled")),
        ] {
            let settings = call(client, "settings", "assistantPreferences", json!({})).await?;
            call(client, "settings", "updateAssistantPreferences", json!({
                "expectedRevision": settings["revision"],
                "mutation": {"kind": "memory", "value": {"enabled": true, "agentReadEnabled": enabled}}
            })).await?;
            let terms = if expected_gap.is_none() { vec!["🧭", "apricot-orchard"] } else { vec!["apri"] };
            let output = tool_round(&rig, &mut provider, reader, false, "Recall", json!({
                "terms": terms, "before": 0, "after": 0
            })).await?;
            assert_eq!(output.contains("Apricot database"), expected_gap.is_none(), "{output}");
            if let Some(gap) = expected_gap {
                assert!(output.contains(gap), "{output}");
            }
        }
        let history = super::memory::recall_page(client, json!({
            "session_id": session, "terms": ["Execute"]
        })).await?;
        let anchor = history["passages"].as_array().unwrap().iter()
            .find(|p| p["excerpt"] == "Execute Recall")
            .ok_or("missing original user passage")?;
        let address = &anchor["anchorPosition"];
        let reference = call(client, "agent", "memorySource", json!({
            "sessionId": session, "sequence": address["sequence"], "itemIndex": address["itemIndex"],
            "start": 0, "end": 7, "quote": "Execute"
        })).await?;
        let evidence = call(client, "agent", "changeMemory", json!({
            "scope": scope, "edit": {"kind": "add_evidence", "id": saved["id"],
                "expectedRevision": 1, "assertion": 1, "reference": reference}
        })).await?;
        let argument = "apricot-orchard";
        let calls = super::memory::recall_page(client, json!({"session_id":session,"terms":["Recall",argument]})).await?;
        let tool = calls["passages"].as_array().unwrap().iter()
            .find(|row| row["excerpt"].as_str().is_some_and(|text| text.starts_with("Recall") && text.contains(argument)))
            .ok_or_else(|| format!("missing original Recall arguments: {calls}"))?;
        let start = tool["excerpt"].as_str().unwrap().find(argument).unwrap();
        let address = &tool["anchorPosition"];
        let reference = call(client, "agent", "memorySource", json!({
            "sessionId":session, "sequence":address["sequence"], "itemIndex":address["itemIndex"],
            "start":start, "end":start+argument.len(), "quote":argument
        })).await?;
        let evidence = call(client, "agent", "changeMemory", json!({
            "scope":scope,"edit":{"kind":"add_evidence","id":saved["id"],"expectedRevision":evidence["revision"],
                                  "assertion":1,"reference":reference}
        })).await?;
        let deleted = call(client, "agent", "changeMemory", json!({
            "scope": scope, "edit": {"kind": "delete", "id": saved["id"], "expectedRevision": evidence["revision"]}
        })).await?;
        assert_eq!(deleted["kind"], "deleted", "{deleted}");
        let continued = call(client, "agent", "send", json!({"sessionId":session,"message":"继续"})).await?;
        let (request, reply) = provider.next().await?;
        let prompts: Vec<_> = request["messages"].as_array().unwrap().iter()
            .filter(|message| message["role"] == "user").map(|message| message["content"].to_string()).collect();
        assert_eq!(prompts.iter().filter(|text| text.contains("Execute Recall")).count(), 2, "{prompts:?}");
        let replayed: Vec<_> = request["messages"].as_array().unwrap().iter()
            .filter_map(|message| message["tool_calls"].as_array()).flatten()
            .filter(|tool| tool["function"]["name"] == "Recall").map(|tool| tool["function"]["arguments"].to_string()).collect();
        assert!(replayed.iter().any(|args| args.contains("Historical tool arguments are restricted")), "{replayed:?}");
        assert!(replayed.iter().all(|args| !args.contains(argument)), "{replayed:?}");
        assert!(replayed.iter().any(|args| args.contains("apri")), "{replayed:?}");
        assert!(prompts.last().unwrap().contains("继续"));
        reply.reply_text("好的。");
        tokio::time::timeout(Duration::from_secs(20),
            quiescent_message(client, session, &continued["messageId"])).await??;
        let more = tool_round(&rig, &mut provider, session, false, "RecallMore", json!({
            "session_id": session, "anchor_message_id": anchor["anchorMessageId"], "before": 2, "after": 4
        })).await?;
        assert!(more.contains("******* Recall"), "{more}");
        assert!(!more.contains("Apricot database"), "{more}");
        Ok::<_, Box<dyn Error + Send + Sync>>(())
    }).catch_unwind().await;
    drop(provider);
    let cleanup = rig.finish().await;
    assert!(matches!(outcome, Ok(Ok(()))), "{outcome:?}");
    assert!(cleanup.is_empty(), "{cleanup:?}");
    Ok(())
}
