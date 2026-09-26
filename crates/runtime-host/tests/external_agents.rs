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

#[allow(dead_code)]
#[path = "integration/support/peer.rs"]
mod peer;

use maka_event_log::{
    EventLog,
    root::{ROOT_DATABASE, RootNamespaces, RootOwner},
};
use maka_plugins::kernel::Definition;
use maka_runtime::{event::Fact, executor::Output};
use maka_runtime_host::{
    plugins::Setup,
    server::{Host, HostOptions, local::LocalListener},
};
use peer::Peer;
use serde_json::{Value, json};
use std::{path::PathBuf, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream},
};
use tokio_util::sync::CancellationToken;

struct Fixture {
    _directory: tempfile::TempDir,
    root: PathBuf,
    namespaces: RootNamespaces,
    workspace: PathBuf,
    trace: PathBuf,
    control: TcpListener,
    executable: String,
    protocol: u8,
}

impl Fixture {
    async fn new() -> Self {
        Self::with_protocol(1).await
    }

    async fn with_protocol(protocol: u8) -> Self {
        let mut temporary = tempfile::Builder::new();
        temporary.prefix("maka-acp-");
        #[cfg(unix)]
        let directory = temporary.tempdir_in("/tmp").unwrap();
        #[cfg(windows)]
        let directory = temporary.tempdir().unwrap();
        let root = directory.path().join("root");
        let namespaces = RootNamespaces {
            ownership: directory.path().join("owners"),
            control: directory.path().join("control"),
        };
        drop(RootOwner::create(&root, &namespaces).unwrap());
        let workspace = directory.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let trace = directory.path().join("requests.jsonl");
        let node = tokio::process::Command::new("node")
            .args(["-p", "process.execPath"])
            .output()
            .await
            .expect("Node is required by runtime-host integration fixtures");
        assert!(node.status.success());
        let executable = String::from_utf8(node.stdout).unwrap().trim().to_owned();
        let control = TcpListener::bind("127.0.0.1:0").await.unwrap();
        Self {
            _directory: directory,
            root,
            namespaces,
            workspace,
            trace,
            control,
            executable,
            protocol,
        }
    }

    async fn open(&self) -> Running {
        // Deliberately use an ordinary package ID: no builtin-specific Host authority.
        let id = "acceptance.acp-package";
        let mut plugins = Setup::default();
        plugins.builtins.insert(
            id.into(),
            Arc::new(Definition {
                id: id.into(),
                revision: "fixture-v1".into(),
                dependencies: vec![],
                inject: vec![],
                plugin: Arc::new(maka_external_agent::plugin::Builtin { client: None }),
            }),
        );
        plugins.layers.insert(
            id.into(),
            serde_json::from_value(json!([
                {"type":"insert","rootId":"profile","entry":{"id":"acceptance.acp","packageId":id}}
            ]))
            .unwrap(),
        );
        let host = Host::open_with_options(
            RootOwner::open(&self.root, &self.namespaces).unwrap(),
            None,
            HostOptions {
                plugins,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let stop = CancellationToken::new();
        let cleanup = stop.clone().drop_guard();
        #[cfg(unix)]
        let endpoint = self.root.join("host.sock");
        #[cfg(windows)]
        let endpoint = PathBuf::from(format!(r"\\.\pipe\maka-acp-{}", uuid::Uuid::new_v4()));
        let server = tokio::spawn(
            LocalListener::bind(&endpoint)
                .unwrap()
                .serve(host.clone(), stop.clone()),
        );
        let mut peer = Peer::new(host.clone(), "acp-acceptance").await;
        loop {
            let status = success(
                peer.rpc("plugin.platform.query", json!({"view":"status"}))
                    .await,
            );
            if status["convergence"] == "converged" {
                break;
            }
            tokio::task::yield_now().await;
        }
        let binding = json!({"packageId":id,"method":"manage"});
        let target = success(
            peer.rpc("plugin.remote", json!({"kind":"bind","binding":binding}))
                .await,
        )["target"]
            .clone();
        let document = success(
            peer.rpc("plugin.remote", json!({"kind":"open_document"}))
                .await,
        )["document"]
            .clone();
        let current = success(peer.rpc("plugin.remote", json!({"kind":"call","binding":binding,"target":target,"document":document,"input":{"kind":"read"}})).await)["value"].clone();
        if current["agents"].as_array().unwrap().is_empty() {
            success(peer.rpc("plugin.remote", json!({"kind":"call","binding":binding,"target":target,"document":document,"input":{
                "kind":"configure","expectedRevision":current["revision"],"agents":[{
                    "id":"test.acp","displayName":"Test ACP","executable":self.executable,
                    "args":[PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/support/acp-agent.mjs"),self.trace,self.control.local_addr().unwrap().port().to_string(),self.protocol.to_string()],"env":{}
                }]
            }})).await);
        }
        success(
            peer.rpc(
                "plugin.remote",
                json!({"kind":"close_document","document":document}),
            )
            .await,
        );
        Running {
            host,
            peer,
            stop,
            server,
            _cleanup: cleanup,
        }
    }

    fn records(&self) -> Vec<Value> {
        std::fs::read_to_string(&self.trace)
            .unwrap()
            .split_inclusive('\n')
            // The agent may still be appending its last record. Inspect only
            // complete records; malformed completed JSON must still fail.
            .filter(|line| line.ends_with('\n'))
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    async fn process(&self) -> BufReader<TcpStream> {
        let pid = self
            .records()
            .into_iter()
            .rev()
            .find(|row| row["method"] == "spawn")
            .unwrap()["pid"]
            .as_u64()
            .unwrap();
        loop {
            let mut process = BufReader::new(self.control.accept().await.unwrap().0);
            let mut announced = String::new();
            process.read_line(&mut announced).await.unwrap();
            if announced.trim().parse::<u64>().unwrap() == pid {
                return process;
            }
            // SDK negotiation can replace a probe process. Its resource must
            // already be settled before the selected transport becomes usable.
            process_closed(&mut process).await;
        }
    }

    async fn facts(&self) -> Vec<Fact> {
        let log = EventLog::open(&self.root.join(ROOT_DATABASE))
            .await
            .unwrap();
        let events = log.prefix(1000, 4 * 1024 * 1024).await.unwrap().events;
        log.close().await.unwrap();
        events.into_iter().map(|row| row.event.fact).collect()
    }
}

struct Running {
    host: Arc<Host>,
    peer: Peer,
    stop: CancellationToken,
    server: tokio::task::JoinHandle<Result<(), maka_runtime_host::server::HostError>>,
    _cleanup: tokio_util::sync::DropGuard,
}
impl Running {
    async fn republish_configuration(&mut self) {
        let binding = json!({"packageId":"acceptance.acp-package","method":"manage"});
        let target = success(
            self.peer
                .rpc("plugin.remote", json!({"kind":"bind","binding":binding}))
                .await,
        )["target"]
            .clone();
        let document = success(
            self.peer
                .rpc("plugin.remote", json!({"kind":"open_document"}))
                .await,
        )["document"]
            .clone();
        let current = success(self.peer.rpc("plugin.remote", json!({"kind":"call","binding":binding,"target":target,"document":document,"input":{"kind":"read"}})).await)["value"].clone();
        let configured = success(self.peer.rpc("plugin.remote", json!({"kind":"call","binding":binding,"target":target,"document":document,"input":{"kind":"configure","expectedRevision":current["revision"],"agents":current["agents"]}})).await)["value"].clone();
        assert_eq!(configured["agents"], current["agents"]);
        success(
            self.peer
                .rpc(
                    "plugin.remote",
                    json!({"kind":"close_document","document":document}),
                )
                .await,
        );
    }

    async fn create(&mut self, session: &str, workspace: &std::path::Path) {
        let result = success(self.peer.rpc("session.create", json!({
            "sessionId":session,"workspace":{"kind":"host_path","path":workspace},
            "executorId":"test.acp","sandboxMode":"danger-full-access","approvalPolicy":{"kind":"never"},
            "executorSettings":{"model":"large"}
        })).await);
        assert_eq!(result["executorId"], "test.acp");
    }

    async fn start(&mut self, session: &str, turn: &str, text: &str) -> Value {
        success(
            self.peer
                .rpc(
                    "turn.start",
                    json!({"sessionId":session,"turnId":turn,"content":{"text":text}}),
                )
                .await,
        )
    }

    async fn settled(&mut self, session: &str, turn: &str, status: &str) -> Value {
        loop {
            let state = success(
                self.peer
                    .rpc("turn.query", json!({"sessionId":session,"turnId":turn}))
                    .await,
            );
            if !matches!(
                state["status"].as_str(),
                Some("admitted" | "created" | "running" | "waiting_for_user")
            ) {
                assert_eq!(state["status"], status, "{state}");
                return state;
            }
            tokio::task::yield_now().await;
        }
    }

    async fn close(self) {
        self.peer.close().await;
        self.stop.cancel();
        self.server.await.unwrap().unwrap();
        drop(self.host);
    }
}

fn success(response: Value) -> Value {
    assert_eq!(response["ok"], true, "{response}");
    response["result"].clone()
}

async fn process_closed(process: &mut BufReader<TcpStream>) {
    let error = process.read_u8().await.unwrap_err();
    // A terminated child closes its control socket with FIN or RST.
    assert!(
        matches!(
            error.kind(),
            std::io::ErrorKind::UnexpectedEof | std::io::ErrorKind::ConnectionReset
        ),
        "{error}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
async fn acp_streams_multiple_turns_and_loads_durable_session_without_replaying_history() {
    tokio::time::timeout(Duration::from_secs(40), async {
        for protocol in [1, 2, 3] {
            let fixture = Fixture::with_protocol(protocol).await;
            let mut running = fixture.open().await;
            running.create("conversation", &fixture.workspace).await;
            for text in ["first", "second"] {
                if text == "second" {
                    running.republish_configuration().await;
                }
                running.start("conversation", text, text).await;
                running.settled("conversation", text, "completed").await;
            }
            let source = success(
                running
                    .peer
                    .rpc(
                        "session.catalog.query",
                        json!({"kind":"get","sessionId":"conversation"}),
                    )
                    .await,
            );
            let copy = running
                .peer
                .rpc(
                    "session.branch.create",
                    json!({
                            "sourceSessionId":"conversation","targetSessionId":"forbidden-copy",
                            "expectedSourceRevision":source["session"]["revision"],
                    "sourceTurnId":"second"
                        }),
                )
                .await;
            assert_eq!(copy["error"]["code"], "operation_conflict", "{copy}");
            let missing = success(
                running
                    .peer
                    .rpc(
                        "session.catalog.query",
                        json!({"kind":"get","sessionId":"forbidden-copy"}),
                    )
                    .await,
            );
            assert!(missing["session"].is_null());
            let receipt = success(
                running
                    .peer
                    .rpc(
                        "session.copy.query",
                        json!({"targetSessionId":"forbidden-copy"}),
                    )
                    .await,
            );
            assert!(receipt["receipt"].is_null());
            let mut process = fixture.process().await;
            let before = fixture.records();
            let negotiated: Vec<_> = before
                .iter()
                .filter(|row| row["method"] == "initialize")
                .map(|row| row["params"]["protocolVersion"].as_u64().unwrap())
                .collect();
            assert_eq!(negotiated, if protocol != 2 { vec![2, 1] } else { vec![2] });
            assert_eq!(
                before.iter().filter(|row| row["method"] == "spawn").count(),
                negotiated.len()
            );
            assert_eq!(
                before
                    .iter()
                    .filter(|row| row["method"] == "session/new")
                    .count(),
                1
            );
            assert_eq!(
                before
                    .iter()
                    .filter(|row| row["method"] == "session/set_config_option")
                    .count(),
                1
            );
            running.close().await;
            process_closed(&mut process).await;

            let mut running = fixture.open().await;
            running.republish_configuration().await;
            running.start("conversation", "third", "third").await;
            running.settled("conversation", "third", "completed").await;
            running.close().await;
            let records = fixture.records();
            assert_eq!(
                records
                    .iter()
                    .filter(|row| row["method"] == "session/new")
                    .count(),
                1
            );
            assert_eq!(
                records
                    .iter()
                    .filter(|row| row["method"]
                        == if protocol != 2 {
                            "session/load"
                        } else {
                            "session/resume"
                        })
                    .count(),
                1
            );
            let negotiated: Vec<_> = records
                .iter()
                .filter(|row| row["method"] == "initialize")
                .map(|row| row["params"]["protocolVersion"].as_u64().unwrap())
                .collect();
            assert_eq!(
                negotiated,
                if protocol != 2 {
                    vec![2, 1, 2, 1]
                } else {
                    vec![2, 2]
                }
            );
            assert_eq!(
                records
                    .iter()
                    .filter(|row| row["method"] == "spawn")
                    .count(),
                negotiated.len()
            );
            let prompts: Vec<_> = records
                .iter()
                .filter(|row| row["method"] == "session/prompt")
                .map(|row| {
                    row["params"]["prompt"].as_array().unwrap().last().unwrap()["text"]
                        .as_str()
                        .unwrap()
                })
                .collect();
            assert_eq!(prompts, ["first", "second", "third"]);
            assert!(
                records
                    .iter()
                    .filter(|row| row["method"] == "session/set_config_option")
                    .all(|row| row["params"]["value"] == "large")
            );
            let facts = fixture.facts().await;
            let completed: Vec<_> = facts
                .iter()
                .filter_map(|fact| match fact {
                    Fact::ExecutorCompleted { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect();
            assert_eq!(completed, ["answer first", "answer second", "answer third"]);
            let mut tools = std::collections::BTreeSet::new();
            let mut thoughts = 0;
            let mut results = 0;
            for fact in &facts {
                match fact {
                    Fact::ExecutorObserved {
                        output: Output::ToolStart { tool_call_id, .. },
                    } => {
                        assert!(tools.insert(tool_call_id));
                    }
                    Fact::ExecutorObserved {
                        output: Output::ToolResult { is_error, .. },
                    } => {
                        assert!(!is_error);
                        results += 1;
                    }
                    Fact::ExecutorObserved {
                        output: Output::ThinkingDelta { .. },
                    } => thoughts += 1,
                    Fact::ExecutorObserved {
                        output: Output::OutputDelta { text },
                    } => assert!(!text.contains("REPLAY") && !text.contains("OBSOLETE")),
                    Fact::ExecutorStarted { binding, settings } => {
                        assert_eq!(binding.package_id, "acceptance.acp-package");
                        assert_eq!(settings.model.as_deref(), Some("large"));
                    }
                    _ => {}
                }
            }
            assert_eq!((tools.len(), results, thoughts), (3, 3, 3));
        }
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
#[ignore = "downloads official Antigravity release"]
async fn official_antigravity_installs_privately_and_initializes_through_public_setup() {
    tokio::time::timeout(Duration::from_secs(1000), async {
        let fixture = Fixture::new().await;
        let mut running = fixture.open().await;
        let binding = json!({"packageId":"acceptance.acp-package","method":"setup"});
        let target = success(running.peer.rpc("plugin.remote", json!({"kind":"bind","binding":binding})).await)["target"].clone();
        let document = success(running.peer.rpc("plugin.remote", json!({"kind":"open_document"})).await)["document"].clone();
        let operation = uuid::Uuid::new_v4();
        success(running.peer.rpc("plugin.authorization", json!({"binding":binding,"target":target,"command":{"kind":"approve","request":{
            "operationId":operation,"title":"Download and install Antigravity from Google",
            "target":{"kind":"plugin_workspace","sandboxMode":"workspace-write"},"capabilities":["network"]
        }}})).await);
        let stream = success(running.peer.rpc("plugin.remote", json!({"kind":"open","binding":binding,"target":target,"document":document,
            "input":{"kind":"install_antigravity","operationId":operation}
        })).await)["stream"].clone();
        let installed = setup_item(&mut running.peer, &document, &stream).await;
        assert_eq!(installed["kind"], "installed");
        let agent = &installed["agent"];
        assert_eq!(agent["id"], "antigravity-acp");
        let executable = PathBuf::from(agent["executable"].as_str().unwrap());
        assert!(executable.starts_with(std::fs::canonicalize(&fixture.root).unwrap().join("plugin-data")), "{}", executable.display());
        assert!(executable.is_file());
        success(running.peer.rpc("plugin.remote", json!({"kind":"close","document":document,"stream":stream})).await);

        let manage = json!({"packageId":"acceptance.acp-package","method":"manage"});
        let manage_target = success(running.peer.rpc("plugin.remote", json!({"kind":"bind","binding":manage})).await)["target"].clone();
        let current = success(running.peer.rpc("plugin.remote", json!({"kind":"call","binding":manage,"target":manage_target,"document":document,"input":{"kind":"read"}})).await)["value"].clone();
        let mut agents = current["agents"].as_array().unwrap().clone();
        agents.push(agent.clone());
        let configured = success(running.peer.rpc("plugin.remote", json!({"kind":"call","binding":manage,"target":manage_target,"document":document,"input":{
            "kind":"configure","expectedRevision":current["revision"],"agents":agents
        }})).await)["value"].clone();
        assert!(configured["agents"].as_array().unwrap().contains(agent));

        let operation = uuid::Uuid::new_v4();
        success(running.peer.rpc("plugin.authorization", json!({"binding":binding,"target":target,"command":{"kind":"approve","request":{
            "operationId":operation,"title":"Check external agent: antigravity-acp",
            "target":{"kind":"plugin_workspace","sandboxMode":"danger-full-access"},"capabilities":["processes"]
        }}})).await);
        let stream = success(running.peer.rpc("plugin.remote", json!({"kind":"open","binding":binding,"target":target,"document":document,
            "input":{"kind":"check","agentId":"antigravity-acp","operationId":operation}
        })).await)["stream"].clone();
        let initialized = setup_item(&mut running.peer, &document, &stream).await;
        assert_eq!(initialized["kind"], "initialized");
        assert_eq!(initialized["agentInfo"]["version"], "1.2.1", "{initialized}");
        assert_eq!(initialized["agentInfo"]["name"], "antigravity-acp");
        assert_eq!(initialized["agentInfo"]["title"], "Google Antigravity");
        let auth = initialized["authMethods"].as_array().unwrap();
        assert!(!auth.is_empty(), "{initialized}");
        assert!(auth.iter().all(|method| method["id"].as_str().is_some_and(|id| !id.is_empty())));
        assert!(auth.iter().any(|method| method["id"] == "oauth-personal"));
        success(running.peer.rpc("plugin.remote", json!({"kind":"close","document":document,"stream":stream})).await);
        success(running.peer.rpc("plugin.remote", json!({"kind":"close_document","document":document})).await);
        running.close().await;
        assert!(fixture.facts().await.iter().all(|fact| !matches!(fact, Fact::InvocationOpened { .. })));
    }).await.unwrap();
}

async fn setup_item(peer: &mut Peer, document: &Value, stream: &Value) -> Value {
    loop {
        let response = success(
            peer.rpc(
                "plugin.remote",
                json!({"kind":"next","document":document,"stream":stream}),
            )
            .await,
        );
        if response["kind"] != "pending" {
            assert_eq!(response["kind"], "item", "{response}");
            return response["item"].clone();
        }
        tokio::task::yield_now().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
async fn acp_prompt_loss_is_fenced_across_restart_and_cancel_waits_for_process_cleanup() {
    tokio::time::timeout(Duration::from_secs(40), async {
        let fixture = Fixture::new().await;
        let mut running = fixture.open().await;
        running.create("lost", &fixture.workspace).await;
        running.start("lost", "lost-first", "lose").await;
        running.settled("lost", "lost-first", "failed").await;
        let mut process = fixture.process().await;
        process_closed(&mut process).await;
        running.start("lost", "lost-retry", "must not execute").await;
        let failure = running.settled("lost", "lost-retry", "failed").await;
        assert_eq!(failure["failureClass"], "executor");
        assert!(failure["failureMessage"].as_str().unwrap().contains("previous prompt has no confirmed outcome"), "{failure}");
        running.close().await;
        let mut running = fixture.open().await;
        running.start("lost", "lost-reopened", "must not execute either").await;
        running.settled("lost", "lost-reopened", "failed").await;
        assert_eq!(fixture.records().iter().filter(|row| row["method"] == "initialize").map(|row| row["params"]["protocolVersion"].clone()).collect::<Vec<_>>(), vec![json!(2), json!(1)]);

        running.create("cancel", &fixture.workspace).await;
        let started = running.start("cancel", "cancel-first", "wait").await;
        while !fixture.records().iter().any(|row| row["method"] == "session/prompt" && row["params"]["prompt"].as_array().unwrap().last().unwrap()["text"] == "wait") {
            tokio::task::yield_now().await;
        }
        let mut process = fixture.process().await;
        let mut line = String::new();
        process.read_line(&mut line).await.unwrap();
        assert_eq!(line, "waiting\n");
        success(running.peer.rpc("turn.stop", json!({"sessionId":"cancel","turnId":"cancel-first","runId":started["turn"]["runId"]})).await);
        running.settled("cancel", "cancel-first", "cancelled").await;
        process_closed(&mut process).await;
        running.start("cancel", "cancel-retry", "must not execute").await;
        running.settled("cancel", "cancel-retry", "failed").await;
        running.close().await;
        let records = fixture.records();
        assert_eq!(records.iter().filter(|row| row["method"] == "initialize").map(|row| row["params"]["protocolVersion"].clone()).collect::<Vec<_>>(), vec![json!(2), json!(1), json!(2), json!(1)]);
        assert_eq!(records.iter().filter(|row| row["method"] == "session/new").count(), 2);
        assert_eq!(records.iter().filter(|row| row["method"] == "session/prompt").count(), 2);
    }).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
async fn acp_callbacks_use_host_files_and_commit_permission_answer() {
    tokio::time::timeout(Duration::from_secs(40), async {
        for protocol in [1, 2, 3] {
        let fixture = Fixture::with_protocol(protocol).await;
        std::fs::write(fixture.workspace.join("input.txt"), "fixture contents\n").unwrap();
        let mut running = fixture.open().await;
        running.create("callbacks", &fixture.workspace).await;
        running.start("callbacks", "callbacks-turn", "callbacks").await;
        let pending = pending_permission(&mut running, "callbacks-turn").await;
        assert_eq!(pending["request"]["kind"], "form");
        if protocol == 2 { assert!(pending.to_string().contains("fixture-command"), "{pending}"); }
        let answer = json!({"sessionId":"callbacks","interactionId":pending["interactionId"],"answer":{"kind":"form","action":"accept","values":{"permission":"allow-once"}}});
        let answered = success(running.peer.rpc("interaction.answer", answer.clone()).await);
        assert_eq!(answered["status"], "answered");
        assert_eq!(answered["outcome"]["kind"], "form_answer");
        assert_eq!(answered["outcome"]["values"]["permission"], "allow-once");
        assert_eq!(success(running.peer.rpc("interaction.answer", answer).await), answered);
        running.settled("callbacks", "callbacks-turn", "completed").await;
        if protocol != 2 { assert_eq!(std::fs::read_to_string(fixture.workspace.join("written.txt")).unwrap(), "written through Host\n"); }
        assert_eq!(success(running.peer.rpc("interaction.query", json!({"sessionId":"callbacks","interactionId":pending["interactionId"]})).await), answered);
        let mut process = fixture.process().await;
        running.start("callbacks", "peer-cancel-turn", "peer-cancel").await;
        let cancelled = pending_permission(&mut running, "peer-cancel-turn").await;
        process.get_mut().write_all(b"cancel-permission\n").await.unwrap();
        running.settled("callbacks", "peer-cancel-turn", "completed").await;
        let closed = success(running.peer.rpc("interaction.query", json!({"sessionId":"callbacks","interactionId":cancelled["interactionId"]})).await);
        assert_eq!(closed["outcome"]["kind"], "closure", "{closed}");
        running.close().await;
        let records = fixture.records();
        if protocol != 2 { assert_eq!(records.iter().find(|row| row["id"] == "read-file").unwrap()["result"]["content"], "fixture contents\n"); } else { assert!(!records.iter().any(|row| row["id"] == "read-file")); }
        let permission_outcomes: Vec<_> = records.iter().filter(|row| row["id"] == "permission").map(|row| row["result"]["outcome"].clone()).collect();
        assert_eq!(permission_outcomes, vec![json!({"outcome":"selected","optionId":"allow-once"}), json!({"outcome":"cancelled"})]);
        let facts = fixture.facts().await;
        assert!(facts.iter().any(|fact| matches!(fact, Fact::ExecutorCompleted { text } if text == "callbacks complete")));
        let progress: String = facts.iter().filter_map(|fact| match fact {
            Fact::ExecutorObserved { output: Output::ThinkingDelta { text } } => Some(text.as_str()),
            _ => None,
        }).collect();
        for index in 0..64 { assert!(progress.contains(&format!("permission progress {index}\n")), "{progress}"); }
        }
    }).await.unwrap();
}

async fn pending_permission(running: &mut Running, turn: &str) -> Value {
    loop {
        let opened = success(
            running
                .peer
                .rpc(
                    "subscription.open",
                    json!({"sessionId":"callbacks","transcript":{"kind":"none"}}),
                )
                .await,
        );
        success(
            running
                .peer
                .rpc(
                    "subscription.close",
                    json!({"subscriptionId":opened["subscriptionId"]}),
                )
                .await,
        );
        if let Some(pending) = opened["snapshot"]["interactions"]["pending"]
            .as_array()
            .unwrap()
            .first()
        {
            break pending.clone();
        }
        let state = success(
            running
                .peer
                .rpc("turn.query", json!({"sessionId":"callbacks","turnId":turn}))
                .await,
        );
        assert!(
            matches!(
                state["status"].as_str(),
                Some("admitted" | "created" | "running" | "waiting_for_user")
            ),
            "{state}"
        );
        tokio::task::yield_now().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
async fn acp_setup_stream_authenticates_filters_urls_and_closes_cancelled_processes() {
    tokio::time::timeout(Duration::from_secs(40), async {
        for protocol in [1, 2, 3] {
        let fixture = Fixture::with_protocol(protocol).await;
        let mut running = fixture.open().await;
        let binding = json!({"packageId":"acceptance.acp-package","method":"setup"});
        let target = success(running.peer.rpc("plugin.remote", json!({"kind":"bind","binding":binding})).await)["target"].clone();
        let document = success(running.peer.rpc("plugin.remote", json!({"kind":"open_document"})).await)["document"].clone();
        for action in ["check", "login", "unsafe", "cancel"] {
            let operation = uuid::Uuid::new_v4();
            let title = if action == "check" { "Check external agent: test.acp" } else { "Authenticate external agent: test.acp" };
            success(running.peer.rpc("plugin.authorization", json!({"binding":binding,"target":target,"command":{"kind":"approve","request":{
                "operationId":operation,"title":title,"target":{"kind":"plugin_workspace","sandboxMode":"danger-full-access"},"capabilities":["processes"]
            }}})).await);
            let input = if action == "check" { json!({"agentId":"test.acp","operationId":operation,"kind":"check"}) } else { json!({"agentId":"test.acp","operationId":operation,"kind":"authenticate","methodId":action}) };
            let stream = success(running.peer.rpc("plugin.remote", json!({"kind":"open","binding":binding,"target":target,"document":document,"input":input})).await)["stream"].clone();
            let first = loop {
                let response = running.peer.rpc("plugin.remote", json!({"kind":"next","document":document,"stream":stream})).await;
                if response["result"]["kind"] != "pending" { break response; }
                tokio::task::yield_now().await;
            };
            let mut process = fixture.process().await;
            if action == "unsafe" {
                assert_eq!(first["ok"], false, "{first}");
                assert!(!first.to_string().contains("http://insecure.example.invalid"));
            } else {
                let item = success(first)["item"].clone();
                if action == "check" {
                    assert_eq!(item["kind"], "initialized");
                    assert_eq!(item["authMethods"].as_array().unwrap().len(), 3);
                } else {
                    assert_eq!(item, json!({"kind":"authorization_url","url":"https://login.example.invalid/authorize?state=fixture"}));
                    if action == "login" {
                        process.get_mut().write_all(b"continue\n").await.unwrap();
                        let authenticated = loop {
                            let value = success(running.peer.rpc("plugin.remote", json!({"kind":"next","document":document,"stream":stream})).await);
                            if value["kind"] != "pending" { break value; }
                            tokio::task::yield_now().await;
                        };
                        assert_eq!(authenticated["item"]["kind"], "authenticated");
                    }
                }
            }
            success(running.peer.rpc("plugin.remote", json!({"kind":"close","document":document,"stream":stream})).await);
            process_closed(&mut process).await;
        }
        // The terminal action consumes the setup stream inside a live Remote
        // method. Closing that child must not cancel the containing action.
        let terminal = json!({"packageId":"acceptance.acp-package","method":"terminal"});
        let terminal_target = success(running.peer.rpc("plugin.remote",
            json!({"kind":"bind","binding":terminal})).await)["target"].clone();
        let changes = json!({"packageId":"acceptance.acp-package","method":"terminal-changes"});
        let changes_target = success(running.peer.rpc("plugin.remote", json!({"kind":"bind","binding":changes})).await)["target"].clone();
        let changes_stream = success(running.peer.rpc("plugin.remote", json!({"kind":"open","binding":changes,"target":changes_target,"document":document,"input":null})).await)["stream"].clone();
        let view = success(running.peer.rpc("plugin.remote", json!({
            "kind":"call","binding":terminal,"target":terminal_target,"document":document,
            "input":{"kind":"read","route":{"agent":"test.acp"},"locale":"en"}
        })).await)["value"]["view"].clone();
        let checked = success(running.peer.rpc("plugin.remote", json!({
            "kind":"call","binding":terminal,"target":terminal_target,"document":document,
            "input":{"kind":"submit","route":{"agent":"test.acp"},"revision":view["revision"],
                "action":"check","fields":{},"locale":"en"}
        })).await)["value"].clone();
        assert_eq!(checked["kind"], "updated", "{checked}");
        let readback = success(running.peer.rpc("plugin.remote", json!({
            "kind":"call","binding":terminal,"target":terminal_target,"document":document,
            "input":{"kind":"read","route":{"agent":"test.acp"},"locale":"en"}
        })).await)["value"].clone();
        assert!(readback.to_string().contains("It answered:"));
        assert!(readback.to_string().contains("Sign-in method"));
        success(running.peer.rpc("plugin.remote", json!({"kind":"close","document":document,"stream":changes_stream})).await);
        let mut process = fixture.process().await;
        process_closed(&mut process).await;
        success(running.peer.rpc("plugin.remote", json!({"kind":"close_document","document":document})).await);
        running.close().await;
        let records = fixture.records();
        let versions = records.iter().filter(|row| row["method"] == "initialize").map(|row| row["params"]["protocolVersion"].clone()).collect::<Vec<_>>();
        assert_eq!(versions, if protocol != 2 { [json!(2), json!(1)].into_iter().cycle().take(10).collect::<Vec<_>>() } else { vec![json!(2); 5] });
        assert_eq!(records.iter().filter(|row| row["method"] == "spawn").count(), versions.len());
        assert_eq!(records.iter().filter(|row| row["method"] == if protocol != 2 { "authenticate" } else { "auth/login" }).count(), 3);
        assert!(!records.iter().any(|row| row["method"] == "session/new" || row["method"] == "session/prompt"));
        assert!(fixture.facts().await.iter().all(|fact| !matches!(fact, Fact::InvocationOpened { .. })));
        }
    }).await.unwrap();
}
