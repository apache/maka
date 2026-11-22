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
use base64::Engine as _;
use tokio::sync::oneshot;

const COVERED_INPUT: &str = "cobalt-covered-input";
const SUMMARY_PROMPT: &str = "cobalt-fixture-compaction-prompt";
const CHECKPOINT: &str = "cobalt-reusable-checkpoint";
const PREFIX_CALL: &str = "prefix-shell";
const SUFFIX_CALL: &str = "suffix-shell";
const LATER_INPUT: &str = "cobalt-later-input";
const LATER_ANSWER: &str = "Answer produced after the checkpoint's source cut.";
const SOURCE_IMAGE: &[u8] = include_bytes!("../../../../../assets/logo.png");

struct Image;
impl ReadResource for Image {
    fn resource_type(&self) -> ResourceType {
        maka_plugin_core::contract::binary_resource_type()
    }
    fn bytes(&self) -> usize {
        SOURCE_IMAGE.len()
    }
    fn metadata(&self) -> Value {
        json!({})
    }
    fn read(&self, range: Range<usize>) -> Result<Vec<u8>, String> {
        SOURCE_IMAGE
            .get(range)
            .map(<[u8]>::to_vec)
            .ok_or_else(|| "invalid fixture image range".into())
    }
}

#[derive(Debug)]
struct ModelPost {
    body: Value,
    reply: oneshot::Sender<String>,
}

impl ModelPost {
    fn contains(&self, text: &str) -> bool {
        self.body["messages"].to_string().contains(text)
    }

    fn has_result(&self, call_id: &str, output: &str) -> bool {
        self.body["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|message| {
                message["role"] == "tool"
                    && message["tool_call_id"] == call_id
                    && message["content"].to_string().contains(output)
            })
    }

    fn image_url(&self) -> Option<&str> {
        self.body["messages"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|message| message["content"].as_array().into_iter().flatten())
            .find_map(|part| part["image_url"]["url"].as_str())
    }

    fn assert_normalized_image(&self) {
        let url = self
            .image_url()
            .expect("model should receive the attached image");
        let encoded = url.strip_prefix("data:image/png;base64,").unwrap();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .unwrap();
        let dimensions = |offset| u32::from_be_bytes(bytes[offset..offset + 4].try_into().unwrap());
        assert_eq!((dimensions(16), dimensions(20)), (96, 96));
    }

    fn shell(self, call_id: &str, command: &str, input_tokens: u64) {
        self.reply
            .send(sse_with_input_usage(
                json!({"tool_calls":[{"index":0,"id":call_id,"type":"function","function":{
                    "name":"Shell","arguments":json!({"command":command,"login":false}).to_string()
                }}]}),
                "tool_calls",
                input_tokens,
            ))
            .unwrap();
    }

    fn finish(self, text: &str) {
        self.finish_with_usage(text, 100);
    }

    fn finish_with_usage(self, text: &str, input_tokens: u64) {
        self.reply
            .send(sse_with_input_usage(
                json!({"content":text}),
                "stop",
                input_tokens,
            ))
            .unwrap();
    }
}

async fn serve_model(listener: TcpListener, posts: mpsc::UnboundedSender<ModelPost>) {
    let mut connections = JoinSet::new();
    loop {
        tokio::select! {
            joined = connections.join_next(), if !connections.is_empty() => {
                joined.unwrap().unwrap();
            }
            socket = listener.accept() => {
                let (socket, _) = socket.unwrap();
                let posts = posts.clone();
                connections.spawn(async move {
                    let model = service_fn(move |request: Request<Incoming>| {
                        let posts = posts.clone();
                        async move {
                            if request.method() == hyper::Method::GET {
                                assert!(request.uri().path().ends_with("/models"));
                                return Ok::<_, Infallible>(response(
                                    json!({"data":[{"id":"gpt-4.1"}]}).to_string(),
                                    "application/json",
                                ));
                            }
                            assert!(request.uri().path().ends_with("/chat/completions"));
                            let bytes = request.into_body().collect().await.unwrap().to_bytes();
                            let body: Value = serde_json::from_slice(&bytes).unwrap();
                            let messages = body["messages"].to_string();
                            if ![COVERED_INPUT, SUMMARY_PROMPT, CHECKPOINT, LATER_INPUT]
                                .iter().any(|marker| messages.contains(marker))
                            {
                                return Ok(response(sse(json!({"content":"Ready."}), "stop"), "text/event-stream"));
                            }
                            let (reply, received) = oneshot::channel();
                            posts.send(ModelPost { body, reply }).expect("fixture request reader");
                            let body = received.await.unwrap_or_default();
                            Ok(response(body, "text/event-stream"))
                        }
                    });
                    let result = hyper::server::conn::http1::Builder::new().keep_alive(false)
                        .serve_connection(TokioIo::new(socket), model).await;
                    if let Err(error) = result {
                        assert!(error.is_incomplete_message() || error.is_canceled() || error.is_closed(), "{error}");
                    }
                });
            }
        }
    }
}

async fn next_post(posts: &mut mpsc::UnboundedReceiver<ModelPost>, phase: &str) -> ModelPost {
    tokio::time::timeout(Duration::from_secs(20), posts.recv())
        .await
        .unwrap_or_else(|_| panic!("model request missing during {phase}"))
        .unwrap()
}

enum Scenario {
    WithinRun { image: bool },
    LaterRun,
}

async fn exercise(scenario: Scenario) {
    let sandbox = Sandbox::new().await.unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let (posts, mut requests) = mpsc::unbounded_channel();
    let server = tokio::spawn(serve_model(listener, posts));
    let mut host = Host::spawn(&sandbox).unwrap();
    let result = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(100), async {
        let (mut client, _) = host.ready().await.unwrap();
        let catalog = call(&client, "settings", "connections", json!({"kind":"start"}), Attachments::new()).await;
        assert_eq!(catalog["kind"], "ready");
        let created = call(&client, "settings", "create", json!({
            "expectedCatalogRevision":catalog["revision"], "connection":{
                "slug":"background-compaction", "name":"Background compaction loopback",
                "provider":{"packageId":"maka.providers","entryId":"maka.providers","scope":"profile","name":"openai-compatible"},
                "configuration":{"baseUrl":base},"enabled":true,"enabledModelIds":["gpt-4.1"],
                "modelOverrides":{"gpt-4.1":{
                    "codeMode":false,"apiProtocol":"openai-chat-completions","contextWindow":60_000,"inputLimit":60_000,
                    "vision":true,"imageInput":{"mimeTypes":["image/png"],"maxWidth":96,"maxHeight":96}
                }}
            }
        }), Attachments::new()).await;
        assert_eq!(created["kind"], "committed", "{created}");
        let connection = &created["connection"]["connectionId"];
        let detail = call(&client, "settings", "connection", json!({"connectionId":connection}), Attachments::new()).await;
        let secret: Arc<dyn ReadResource> = Arc::new(FixtureKey);
        let saved = call(&client, "settings", "saveCredential",
            json!({"expected":detail["target"],"expectedCredential":null}),
            Attachments::from([("secret".into(), secret)]),
        ).await;
        assert_eq!(saved["kind"], "saved", "{saved}");
        let created = call(&client, "agent", "create", json!({
            "title":"Background compaction","automaticTitle":false,"labels":[],"tools":["Shell"],
            "workspace":{"kind":"directory","path":sandbox.workspace},
            "backend":{"kind":"model","connectionId":connection,"modelId":"gpt-4.1","thinkingLevel":null}
        }), Attachments::new()).await;
        assert_eq!(created["kind"], "created", "{created}");
        let session = created["session"]["id"].as_str().unwrap();
        let metadata = call(&client, "agent", "compactionPrompt", json!({"sessionId":session}), Attachments::new()).await;
        let updated = call(&client, "agent", "setCompactionPrompt", json!({
            "sessionId":session,"expectedRevision":metadata["revision"],"prompt":SUMMARY_PROMPT
        }), Attachments::new()).await;
        assert_eq!(updated["kind"], "committed", "{updated}");
        let image = matches!(scenario, Scenario::WithinRun { image: true });
        let attachments = if image {
            let payload: Arc<dyn ReadResource> = Arc::new(Image);
            let upload = call(&client, "agent", "uploadAttachment", json!({
                "sessionId":session,"name":"checkpoint-input.png","bytes":SOURCE_IMAGE.len(),
                "digest":maka_agent_facts::artifact::content_digest(SOURCE_IMAGE),
            }), Attachments::from([("file".into(), payload)])).await;
            assert_eq!(upload["kind"], "uploaded", "{upload}");
            vec![upload["attachment"]["id"].clone()]
        } else {
            vec![]
        };
        let sent = call(&client, "agent", "send", json!({
            "sessionId":session,"message":COVERED_INPUT,"attachments":attachments,"delivery":"queue",
        }), Attachments::new()).await;
        assert!(matches!(sent["kind"].as_str(), Some("started" | "queued")), "{sent}");
        let mut target = json!({"kind":"message","messageId":sent["messageId"]});

        let first = next_post(&mut requests, "the initial Main").await;
        assert!(first.contains(COVERED_INPUT) && !first.contains(SUMMARY_PROMPT), "{}", first.body);
        if image {
            first.assert_normalized_image();
        }
        // The fixture calibrates the next estimate into the background band
        // below the 51,000-token adoption threshold of a 60,000-token model.
        first.shell(PREFIX_CALL, "printf covered-tool-output", 46_000);
        let first_post = next_post(&mut requests, "the background summary or concurrent Main").await;
        let second_post = next_post(&mut requests, "overlap with the still-unanswered first request").await;
        let (summary, main) = if first_post.contains(SUMMARY_PROMPT) {
            (first_post, second_post)
        } else {
            (second_post, first_post)
        };
        assert!(summary.contains(SUMMARY_PROMPT) && summary.contains(COVERED_INPUT), "{}", summary.body);
        assert!(summary.has_result(PREFIX_CALL, "covered-tool-output"), "{}", summary.body);
        assert!(main.contains(COVERED_INPUT), "{}", main.body);
        assert!(!main.contains(SUMMARY_PROMPT) && !main.contains(CHECKPOINT), "{}", main.body);
        assert!(main.has_result(PREFIX_CALL, "covered-tool-output"), "{}", main.body);
        if image {
            summary.assert_normalized_image();
            main.assert_normalized_image();
        }

        let observed = call(&client, "agent", "observe", json!({"sessionId":session}), Attachments::new()).await;
        assert_eq!(observed["compacting"], Value::Null, "{observed}");
        let history_input = json!({"sessionId":session,"position":{"kind":"start"},"view":"conversation"});
        let history = call(&client, "agent", "history", history_input, Attachments::new()).await;
        assert_eq!(history["kind"], "ready", "{history}");
        assert!(history["chunks"].as_array().unwrap().iter().any(|chunk| chunk["role"] == "user"));
        assert!(!history["chunks"].as_array().unwrap().iter().any(|chunk| chunk["role"] == "compaction"), "{history}");
        let history_tail = json!({"sessionId":session,"position":{"kind":"tail"},"view":"conversation"});

        let effect = sandbox.workspace.join("compaction-effects.log");
        let earlier_run = match scenario {
            Scenario::WithinRun { .. } => {
                main.shell(
                    SUFFIX_CALL,
                    "printf 'during-summary\\n' >> compaction-effects.log && printf post-checkpoint-output",
                    52_000,
                );
                tokio::time::timeout(Duration::from_secs(15), async {
                    loop {
                        if let Ok(output) = tokio::fs::read_to_string(&effect).await {
                            assert_eq!(output, "during-summary\n");
                            break;
                        }
                        tokio::time::sleep(Duration::from_millis(20)).await;
                    }
                }).await.expect("the real Shell call must run before the Summary response");
                tokio::time::timeout(Duration::from_secs(15), async {
                    loop {
                        let observed = call(&client, "agent", "observe", json!({"sessionId":session}), Attachments::new()).await;
                        if observed["compacting"].is_object() {
                            break;
                        }
                        tokio::time::sleep(Duration::from_millis(50)).await;
                    }
                }).await.expect("the hard threshold must expose a wait for the unfinished Summary");
                summary.finish(CHECKPOINT);
                None
            }
            Scenario::LaterRun => {
                let user = history["chunks"].as_array().unwrap().iter()
                    .find(|chunk| chunk["role"] == "user").unwrap();
                summary.finish(CHECKPOINT);
                tokio::time::timeout(Duration::from_secs(15), async {
                    loop {
                        let observed = call(&client, "agent", "observe", json!({"sessionId":session}), Attachments::new()).await;
                        let trace = call(&client, "agent", "historyRequests", json!({
                            "sessionId":session,"through":observed["through"],"position":user["position"]
                        }), Attachments::new()).await;
                        if trace["requests"].as_array().unwrap().iter().any(|request|
                            request["purpose"] == "summary" && request["finished"]["outcome"] == "success"
                        ) {
                            break;
                        }
                        tokio::time::sleep(Duration::from_millis(20)).await;
                    }
                }).await.expect("the background checkpoint must finish while Main is still open");
                main.finish_with_usage(LATER_ANSWER, 46_000);
                let completed = work(&client, session, target, Some("completed")).await;
                let history = call(&client, "agent", "history", history_tail.clone(), Attachments::new()).await;
                assert!(!history["chunks"].as_array().unwrap().iter().any(|chunk| chunk["role"] == "compaction"), "{history}");
                let sent = call(&client, "agent", "send", json!({
                    "sessionId":session,"message":format!("{LATER_INPUT} {}", "x".repeat(18_000)),"delivery":"queue",
                }), Attachments::new()).await;
                assert!(matches!(sent["kind"].as_str(), Some("started" | "queued")), "{sent}");
                target = json!({"kind":"message","messageId":sent["messageId"]});
                Some(completed["execution"]["runId"].clone())
            }
        };

        let compacted = next_post(&mut requests, "checkpoint adoption").await;
        assert!(compacted.contains(CHECKPOINT), "{}", compacted.body);
        match scenario {
            Scenario::WithinRun { .. } => {
                assert!(compacted.has_result(SUFFIX_CALL, "post-checkpoint-output"), "{}", compacted.body);
                assert_eq!(tokio::fs::read_to_string(effect).await.unwrap(), "during-summary\n");
            }
            Scenario::LaterRun => {
                assert!(compacted.contains(LATER_ANSWER) && compacted.contains(LATER_INPUT), "{}", compacted.body);
            }
        }
        assert!(!compacted.contains(COVERED_INPUT) && !compacted.contains(PREFIX_CALL), "{}", compacted.body);
        assert!(compacted.image_url().is_none(), "the covered image must not replay");
        let observed = call(&client, "agent", "observe", json!({"sessionId":session}), Attachments::new()).await;
        assert_eq!(observed["compacting"], Value::Null, "{observed}");
        compacted.finish("Compacted Main finished.");
        let completed = work(&client, session, target, Some("completed")).await;
        assert!(requests.try_recv().is_err(), "the Run sent a duplicate provider request");
        let history = call(&client, "agent", "history", history_tail, Attachments::new()).await;
        assert_eq!(history["kind"], "ready", "{history}");
        let compactions = history["chunks"].as_array().unwrap().iter()
            .filter(|chunk| chunk["role"] == "compaction").count();
        assert_eq!(compactions, 1, "{history}");
        host.quit(&mut client).await.unwrap();
        let run = &completed["execution"]["runId"];
        if let Some(earlier_run) = earlier_run {
            assert_ne!(run, &earlier_run);
            assert_successful_attempts(&sandbox, session, &earlier_run, 3).await;
            assert_successful_attempts(&sandbox, session, run, 1).await;
        } else {
            assert_successful_attempts(&sandbox, session, run, 4).await;
        }
    })).catch_unwind().await;
    server.abort();
    assert!(server.await.unwrap_err().is_cancelled());
    host.cleanup().await.unwrap();
    match result {
        Ok(result) => result.expect("bounded background compaction and adoption"),
        Err(panic) => std::panic::resume_unwind(panic),
    }
}

async fn assert_successful_attempts(sandbox: &Sandbox, session: &str, run: &Value, count: usize) {
    let facts = identities(sandbox, session, run).await;
    let outcomes: Vec<_> = facts
        .iter()
        .filter(|fact| fact["kind"] == "model_closed")
        .map(|fact| &fact["outcome"])
        .collect();
    assert_eq!(outcomes, vec![&json!("success"); count]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn proactive_compaction_runs_alongside_main_and_adopts_with_the_new_tool_result() {
    exercise(Scenario::WithinRun { image: false }).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn proactive_compaction_adopts_a_checkpoint_covering_normalized_images() {
    exercise(Scenario::WithinRun { image: true }).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn proactive_compaction_waits_for_the_threshold_across_runs() {
    exercise(Scenario::LaterRun).await;
}
