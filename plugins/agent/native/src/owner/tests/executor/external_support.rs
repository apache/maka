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
use tokio::io::{AsyncBufReadExt, BufReader};

pub(super) struct OfficialClaude {
    pub command: maka_agent_api::executor::NativeCommand,
    pub address: std::net::SocketAddr,
    evidence: std::path::PathBuf,
    home: tempfile::TempDir,
    state: Arc<tokio::sync::Mutex<OfficialRound>>,
    stop: CancellationToken,
    server: tokio::task::JoinHandle<std::io::Result<()>>,
}

#[derive(Default)]
struct OfficialRound {
    session: String,
    marker: String,
    turn: usize,
    stage: usize,
}

impl OfficialClaude {
    pub async fn from_env() -> Self {
        use sha2::{Digest, Sha256};
        // The runner must launch this one test in a clean environment. Never
        // mutate process-global env in a parallel test or wrap the official CLI.
        for (name, _) in std::env::vars_os() {
            let name = name.to_str().expect("UTF-8 fixture env name");
            // macOS Foundation adds this locale key; it carries no authority.
            assert!(
                matches!(
                    name,
                    "PATH"
                        | "HOME"
                        | "TMPDIR"
                        | "RUST_BACKTRACE"
                        | "RUST_LIB_BACKTRACE"
                        | "CARGO_BIN_EXE_maka"
                        | "MAKA_NATIVE_REAL_MODE"
                        | "MAKA_NATIVE_REAL_RUNTIME"
                        | "MAKA_NATIVE_STUB_NODE"
                        | "MAKA_NATIVE_STUB_CLI"
                        | "MAKA_NATIVE_STUB_CLI_SHA256"
                        | "MAKA_NATIVE_STUB_EVIDENCE"
                        | "NEXTEST"
                        | "NEXTEST_RUN_ID"
                        | "NEXTEST_EXECUTION_MODE"
                        | "NEXTEST_TEST_NAME"
                        | "NEXTEST_BINARY_ID"
                        | "NEXTEST_ATTEMPT"
                        | "NEXTEST_TEST_GLOBAL_SLOT"
                        | "NEXTEST_TEST_GROUP"
                        | "NEXTEST_TEST_GROUP_SLOT"
                ) || (cfg!(target_os = "macos") && name == "__CF_USER_TEXT_ENCODING"),
                "unclean official stub environment: {name}"
            );
        }
        fn required_path(name: &str) -> std::path::PathBuf {
            let path = std::path::PathBuf::from(std::env::var_os(name).expect(name));
            assert!(path.is_absolute(), "{name} must be absolute");
            path.canonicalize().expect(name)
        }
        let node = required_path("MAKA_NATIVE_STUB_NODE");
        let cli = required_path("MAKA_NATIVE_STUB_CLI");
        assert!(node.is_file() && cli.is_file());
        let expected =
            std::env::var("MAKA_NATIVE_STUB_CLI_SHA256").expect("pinned owned CLI SHA-256");
        assert_eq!(expected.len(), 64);
        let checked_cli = cli.clone();
        let digest = tokio::task::spawn_blocking(move || {
            let package: Value = serde_json::from_slice(
                &std::fs::read(checked_cli.parent().unwrap().join("package.json")).unwrap(),
            )
            .unwrap();
            assert_eq!(package["name"], "@anthropic-ai/claude-code");
            assert_eq!(package["version"], "2.1.49");
            hex::encode(Sha256::digest(std::fs::read(checked_cli).unwrap()))
        })
        .await
        .unwrap();
        assert_eq!(
            digest, expected,
            "not the runner's pinned unmodified official artifact"
        );
        let evidence = std::path::PathBuf::from(
            std::env::var_os("MAKA_NATIVE_STUB_EVIDENCE").expect("new evidence directory"),
        );
        assert!(evidence.is_absolute());
        tokio::fs::create_dir(&evidence)
            .await
            .expect("evidence must be a new directory, never an old sealed case");
        let home = tempfile::tempdir().unwrap();
        tokio::fs::create_dir(home.path().join(".claude"))
            .await
            .unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let state = Arc::new(tokio::sync::Mutex::new(OfficialRound::default()));
        let stop = CancellationToken::new();
        let router = axum::Router::new()
            .route("/v1/messages", axum::routing::post(official_message))
            .route(
                "/v1/messages/count_tokens",
                axum::routing::post(official_count),
            )
            .with_state((state.clone(), evidence.clone()));
        let stopped = stop.clone();
        let server = tokio::spawn(async move {
            axum::serve(listener, router)
                .with_graceful_shutdown(stopped.cancelled_owned())
                .await
        });
        let command = maka_agent_api::executor::NativeCommand {
            executable: node.to_str().unwrap().into(),
            args: vec![cli.to_str().unwrap().into()],
            env: BTreeMap::from([
                (
                    "PATH".into(),
                    format!("{}:/usr/bin:/bin", node.parent().unwrap().display()),
                ),
                ("LANG".into(), "en_US.UTF-8".into()),
                ("HOME".into(), home.path().to_str().unwrap().into()),
                (
                    "CLAUDE_CONFIG_DIR".into(),
                    home.path().join(".claude").to_str().unwrap().into(),
                ),
                ("ANTHROPIC_BASE_URL".into(), format!("http://{address}")),
                (
                    "ANTHROPIC_API_KEY".into(),
                    "maka-local-mock-not-a-real-key".into(),
                ),
                ("DISABLE_AUTOUPDATER".into(), "1".into()),
                ("DISABLE_TELEMETRY".into(), "1".into()),
                ("DISABLE_ERROR_REPORTING".into(), "1".into()),
                (
                    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC".into(),
                    "1".into(),
                ),
            ]),
        };
        tokio::fs::write(
            evidence.join("artifact.json"),
            serde_json::to_vec_pretty(&json!({
                "kind":"independent official fresh; not cold or old job recovery",
                "cliVersion":"2.1.49", "cli":cli, "sha256":digest, "node":node,
                "stub":address, "transportCauseAvailable":false
            }))
            .unwrap(),
        )
        .await
        .unwrap();
        Self {
            command,
            address,
            evidence,
            home,
            state,
            stop,
            server,
        }
    }

    pub async fn begin(&self, session: &str, marker: &str, turn: usize) {
        let mut state = self.state.lock().await;
        if turn > 0 {
            assert_eq!(
                state.stage, 2,
                "previous official tool roundtrip did not finish"
            );
        }
        *state = OfficialRound {
            session: session.into(),
            marker: marker.into(),
            turn,
            stage: 0,
        };
    }

    pub async fn floor(&self, f: &Fixture, session: &str) -> maka_sandbox::Sandbox {
        use maka_sandbox::{
            Destination, Network, Sandbox,
            filesystem::{Access, Policy, Rule},
        };
        let selection =
            serde_json::from_value(json!({"executor":"external","settings":{"runtime":"claude"}}))
                .unwrap();
        let backend = f.owner.executors.select(selection).unwrap();
        let mcp = backend
            .prepare_native_endpoint(session, &f.owner.stop)
            .await
            .unwrap();
        assert!(mcp.ip().is_loopback());
        // A live but unbound listener must expose no tool or bearer authority.
        let mut socket = TcpStream::connect(mcp).await.unwrap();
        socket.write_all(b"POST /mcp HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
        let mut status = String::new();
        BufReader::new(socket).read_line(&mut status).await.unwrap();
        assert!(
            status.contains("401"),
            "preopened listener exposed a route: {status}"
        );
        let (account_home, env_home, helper) = tokio::task::spawn_blocking(|| {
            let account_home = maka_sandbox::account_home()
                .expect("OS account HOME required for the official fixture boundary")
                .canonicalize()
                .expect("canonical OS account HOME");
            let env_home = std::env::var_os("HOME")
                .filter(|home| !home.is_empty())
                .map(std::path::PathBuf::from)
                .map(|home| home.canonicalize().expect("canonical nonempty runner HOME"));
            let helper = native_helper()
                .canonicalize()
                .expect("canonical actual Maka helper");
            (account_home, env_home, helper)
        })
        .await
        .unwrap();
        let mut denied_homes = vec![account_home.clone()];
        if let Some(home) = &env_home {
            if home != &account_home {
                denied_homes.push(home.clone());
            }
        }
        let node = std::path::Path::new(&self.command.executable);
        let cli = std::path::Path::new(&self.command.args[0]);
        let bin = node.parent().expect("Node bin directory");
        assert_eq!(node.file_name(), Some(std::ffi::OsStr::new("node")));
        assert_eq!(bin.file_name(), Some(std::ffi::OsStr::new("bin")));
        let node_prefix = bin.parent().expect("dedicated Node installation prefix");
        let version: Vec<_> = node_prefix
            .file_name()
            .and_then(|name| name.to_str())
            .expect("Node installation version")
            .split('.')
            .collect();
        // This fixture supports the already-owned versioned mise installation,
        // not an arbitrary ancestor of a caller-supplied Node executable.
        assert!(
            version.len() == 3
                && version
                    .iter()
                    .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit())),
            "Node prefix must be an independent version directory"
        );
        assert!(
            node_prefix.parent().is_some_and(|parent| parent
                .ends_with(std::path::Path::new("mise").join("installs").join("node"))),
            "official fixture requires the owned mise/installs/node/<version>/bin/node layout"
        );
        assert!(
            node_prefix != std::path::Path::new("/")
                && denied_homes.iter().all(|home| home != node_prefix),
            "Node read exception cannot reopen a denied HOME or shared prefix"
        );
        let mut filesystem = Policy::uniform(Access::Read);
        filesystem.rules.extend(
            denied_homes
                .iter()
                .cloned()
                .map(|home| Rule::subtree(home, Access::Deny)),
        );
        filesystem.rules.extend([
            Rule::subtree(node_prefix, Access::Read),
            Rule::subtree(cli.parent().unwrap(), Access::Read),
            Rule::exact(helper.clone(), Access::Read),
        ]);
        let floor = Sandbox::Managed {
            filesystem,
            network: Network::Restricted {
                destinations: [
                    Destination::new(&self.address.ip().to_string(), self.address.port()).unwrap(),
                    Destination::new(&mcp.ip().to_string(), mcp.port()).unwrap(),
                ]
                .into_iter()
                .collect(),
            },
        };
        tokio::fs::write(
            self.evidence.join("route.json"),
            serde_json::to_vec_pretty(&json!({
                "stub":self.address, "mcp":mcp, "preopenStatus":401, "floor":floor,
                "accountHome":account_home, "envHome":env_home, "deniedHomeRoots":denied_homes,
                "nodeInstallPrefix":node_prefix, "canonicalHelper":helper
            }))
            .unwrap(),
        )
        .await
        .unwrap();
        floor
    }

    pub async fn observe(
        &self,
        journal: &NativeTaskSource,
        turn: usize,
        marker: &str,
        host_receipts: &[Value],
    ) {
        let binding = journal.binding.as_ref().unwrap();
        let crate::executor::external::NativeTask::ClaudeStream { session, input } = &binding.task
        else {
            panic!("official pipe producer required");
        };
        let evidence = maka_process::isolated::closed_evidence(&binding.resource)
            .await
            .unwrap()
            .expect("original Root group/streams closure");
        let expected_session = session.clone();
        let expected_input = input.clone();
        let expected_marker = marker.to_owned();
        let (ack, result, version) = tokio::task::spawn_blocking(move || {
            use std::io::BufRead;
            let sent: Vec<Value> = std::io::BufReader::new(evidence.stdin)
                .lines()
                .map(|line| serde_json::from_str(&line.unwrap()).unwrap())
                .collect();
            assert!(sent.iter().any(|row| row["type"] == "user"
                && row["session_id"] == expected_session
                && row["uuid"] == expected_input));
            let rows: Vec<Value> = std::io::BufReader::new(evidence.stdout)
                .lines()
                .map(|line| serde_json::from_str(&line.unwrap()).unwrap())
                .collect();
            let ack = rows
                .iter()
                .position(|row| {
                    row["type"] == "user"
                        && row["isReplay"] == true
                        && row["uuid"] == expected_input
                        && row["session_id"] == expected_session
                })
                .expect("exact original user replay ACK");
            let result = rows
                .iter()
                .position(|row| {
                    row["type"] == "result"
                        && row["session_id"] == expected_session
                        && row["subtype"] == "success"
                        && row["is_error"] == false
                        && row["result"]
                            .as_str()
                            .is_some_and(|text| text.trim() == expected_marker)
                })
                .expect("true official native result, not an SDK control or mock response");
            assert!(ack < result);
            let version = rows
                .iter()
                .find(|row| row["type"] == "system" && row["subtype"] == "init")
                .unwrap()["claude_code_version"]
                .clone();
            assert_eq!(version, "2.1.49");
            (ack, result, version)
        })
        .await
        .unwrap();
        assert_eq!(self.state.lock().await.stage, 2);
        tokio::fs::write(self.evidence.join(format!("turn-{turn}.json")), serde_json::to_vec_pretty(&json!({
            "execution":journal.execution, "task":journal.state.task, "resource":binding.resource,
            "nativeSession":session, "userUuid":input, "ackRow":ack, "resultRow":result,
            "version":version, "marker":marker, "nativeTerminal":journal.state.closed, "rootCleanup":journal.state.cleanup,
            "hostReceipts":host_receipts,
            "wholePrivateTreeGone":"unknown",
            "resultBeforeStdinEofBasis":"product protocol accepts native Closed while original Pipe still owns stdin; only after its ACK can lifecycle drain/release stdin",
            "independentEofTimestamp":null
        })).unwrap()).await.unwrap();
    }

    pub async fn finish(self) {
        self.stop.cancel();
        self.server.await.unwrap().unwrap();
        drop(self.home);
    }
}

pub(super) async fn scoped_send(f: &Fixture, input: Value, floor: &maka_sandbox::Sandbox) -> Value {
    let mut caller = scope(&f.issuer, true);
    caller.restrict_sandbox(floor).unwrap();
    let client = f.app.client();
    let prepared = client
        .prepare_mutation(
            f.binding(2).await,
            "send".into(),
            input,
            caller,
            Uuid::new_v4(),
            Attachments::new().into(),
        )
        .await
        .unwrap();
    let recovery = json!({"reference":prepared.reference()});
    let reply = client
        .mutate_owned(prepared, recovery)
        .await
        .unwrap()
        .result()
        .await;
    match reply.receipt {
        Receipt::Recorded {
            outcome:
                OperationOutcome::Returned {
                    result: OperationResult::Success { value },
                },
            ..
        } => value,
        other => panic!("original stub send failed: {other:?}"),
    }
}

type OfficialState = (Arc<tokio::sync::Mutex<OfficialRound>>, std::path::PathBuf);

async fn official_count(
    headers: axum::http::HeaderMap,
) -> Result<([(axum::http::HeaderName, &'static str); 1], &'static str), axum::http::StatusCode> {
    if headers.get("x-api-key").and_then(|v| v.to_str().ok())
        != Some("maka-local-mock-not-a-real-key")
        || headers.contains_key("authorization")
    {
        return Err(axum::http::StatusCode::UNAUTHORIZED);
    }
    Ok((
        [(axum::http::header::CONTENT_TYPE, "application/json")],
        r#"{"input_tokens":32}"#,
    ))
}

async fn official_message(
    axum::extract::State((state, evidence)): axum::extract::State<OfficialState>,
    headers: axum::http::HeaderMap,
    bytes: axum::body::Bytes,
) -> Result<([(axum::http::HeaderName, &'static str); 1], String), axum::http::StatusCode> {
    use axum::http::StatusCode;
    if headers.get("x-api-key").and_then(|v| v.to_str().ok())
        != Some("maka-local-mock-not-a-real-key")
        || headers.contains_key("authorization")
    {
        return Err(StatusCode::UNAUTHORIZED);
    }
    let request: Value = serde_json::from_slice(&bytes).map_err(|_| StatusCode::BAD_REQUEST)?;
    let mut state = state.lock().await;
    let tool = request["tools"]
        .as_array()
        .ok_or(StatusCode::BAD_REQUEST)?
        .iter()
        .filter(|tool| {
            tool["name"]
                .as_str()
                .is_some_and(|name| name.ends_with("__SessionRead"))
        })
        .collect::<Vec<_>>();
    if tool.len() != 1 || state.stage >= 2 {
        return Err(StatusCode::BAD_REQUEST);
    }
    let name = tool[0]["name"].as_str().ok_or(StatusCode::BAD_REQUEST)?;
    let input = json!({"sessionId":state.session});
    let validator =
        jsonschema::validator_for(&tool[0]["input_schema"]).map_err(|_| StatusCode::BAD_REQUEST)?;
    if !validator.is_valid(&input) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let id = format!("stub-sessionread-{}", state.turn);
    let content = request["messages"]
        .as_array()
        .and_then(|messages| messages.last())
        .and_then(|message| message["content"].as_array());
    let returned = content.and_then(|content| {
        content
            .iter()
            .find(|block| block["type"] == "tool_result" && block["tool_use_id"] == id)
    });
    if (state.stage == 0 && returned.is_some()) || (state.stage == 1 && returned.is_none()) {
        return Err(StatusCode::BAD_REQUEST);
    }
    if returned.is_some_and(|block| block["is_error"] == true) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let block = if state.stage == 0 {
        json!({"type":"tool_use","id":id,"name":name,"input":input})
    } else {
        json!({"type":"text","text":state.marker})
    };
    let reason = if state.stage == 0 {
        "tool_use"
    } else {
        "end_turn"
    };
    let start = if state.stage == 0 {
        json!({"type":"tool_use","id":id,"name":name,"input":{}})
    } else {
        json!({"type":"text","text":""})
    };
    let delta = if state.stage == 0 {
        json!({"type":"input_json_delta","partial_json":block["input"].to_string()})
    } else {
        json!({"type":"text_delta","text":block["text"]})
    };
    let events = [
        (
            "message_start",
            json!({"type":"message_start","message":{"id":format!("msg_stub_{}_{}",state.turn,state.stage),"type":"message","role":"assistant","model":request["model"],"content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":32,"output_tokens":0}}}),
        ),
        (
            "content_block_start",
            json!({"type":"content_block_start","index":0,"content_block":start}),
        ),
        (
            "content_block_delta",
            json!({"type":"content_block_delta","index":0,"delta":delta}),
        ),
        (
            "content_block_stop",
            json!({"type":"content_block_stop","index":0}),
        ),
        (
            "message_delta",
            json!({"type":"message_delta","delta":{"stop_reason":reason,"stop_sequence":null},"usage":{"output_tokens":8}}),
        ),
        ("message_stop", json!({"type":"message_stop"})),
    ];
    tokio::fs::write(evidence.join(format!("http-{}-{}.json",state.turn,state.stage)),
        serde_json::to_vec_pretty(&json!({"phase":state.stage,"sessionId":state.session,
            "toolName":name,"toolUseId":id,"toolResultReceived":returned.is_some(),"dummyAuthenticated":true})).unwrap())
        .await.map_err(|_|StatusCode::INTERNAL_SERVER_ERROR)?;
    state.stage += 1;
    Ok((
        [(axum::http::header::CONTENT_TYPE, "text/event-stream")],
        events
            .into_iter()
            .map(|(kind, value)| format!("event: {kind}\ndata: {value}\n\n"))
            .collect(),
    ))
}

pub(super) async fn setup(base: &str) -> (Fixture, TcpListener) {
    configured(base, |_| {}).await
}

pub(super) async fn configured(
    base: &str,
    configure: impl FnOnce(&mut Configuration),
) -> (Fixture, TcpListener) {
    with_tools(base, None, configure).await
}

pub(super) async fn with_tools(
    base: &str,
    tooling: Option<service_tools::Setup>,
    configure: impl FnOnce(&mut Configuration),
) -> (Fixture, TcpListener) {
    static NODE: tokio::sync::OnceCell<String> = tokio::sync::OnceCell::const_new();
    let node = NODE
        .get_or_init(|| async {
            let output = tokio::process::Command::new("node")
                .args(["-e", "process.stdout.write(process.execPath)"])
                .output()
                .await
                .unwrap();
            assert!(output.status.success());
            let path = String::from_utf8(output.stdout).unwrap().trim().to_owned();
            assert!(std::path::Path::new(&path).is_absolute());
            path
        })
        .await;
    let control = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let fixture = Fixture::configured(base, None, None, tooling, |settings| {
        let auth = settings.workspace_roots[0].path.join("fixture-auth");
        for directory in ["home", "codex", "claude"] {
            std::fs::create_dir_all(auth.join(directory)).unwrap();
        }
        let command = maka_agent_api::executor::NativeCommand {
            executable: std::path::Path::new(node)
                .file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .into(),
            args: vec![
                "--input-type=module".into(),
                "-e".into(),
                include_str!("../../../../tests/support/native-runtime.mjs").into(),
                control.local_addr().unwrap().port().to_string(),
            ],
            env: BTreeMap::from([
                ("HOME".into(), auth.join("home").to_str().unwrap().into()),
                (
                    "CODEX_HOME".into(),
                    auth.join("codex").to_str().unwrap().into(),
                ),
                (
                    "CLAUDE_CONFIG_DIR".into(),
                    auth.join("claude").to_str().unwrap().into(),
                ),
                ("MAKA_NATIVE_PREOPEN_PROBE".into(), "1".into()),
                (
                    "PATH".into(),
                    std::path::Path::new(node)
                        .parent()
                        .unwrap()
                        .to_str()
                        .unwrap()
                        .into(),
                ),
            ]),
        };
        let claude = command.clone();
        settings.external = Some(maka_agent_api::executor::ExternalConfiguration {
            runtimes: maka_agent_api::executor::NativeRuntimeSwitches {
                codex: true,
                antigravity: true,
                claude: true,
            },
            commands: maka_agent_api::executor::NativeCommands {
                codex: Some(command.clone()),
                antigravity: Some(command),
                claude: Some(claude),
            },
        });
        configure(settings);
    })
    .await;
    (fixture, control)
}

pub(super) fn backend(runtime: &str) -> Value {
    json!({"kind":"executor","selection":{"executor":"external","settings":{"runtime":runtime,"model":"fixture-model","thinkingLevel":"vendor-deep"}}})
}
pub(super) fn input(session: &str, message: &str) -> Value {
    input_runtime(session, "codex", message)
}
pub(super) fn input_runtime(session: &str, runtime: &str, message: &str) -> Value {
    json!({"sessionId":session,"message":message,"backend":backend(runtime)})
}
pub(super) fn current_message(packet: &Value) -> &str {
    let message = packet["request"]["message"]
        .as_str()
        .expect("actual native user text");
    message
        .split_once("\n\n--- Current user message ---\n")
        .map_or(message, |(_, current)| current)
}
pub(super) async fn packet(control: &mut BufReader<TcpStream>, phase: &str) -> Value {
    let mut line = String::new();
    control.read_line(&mut line).await.unwrap();
    let value: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(value["phase"], phase, "{value}");
    value
}
pub(super) async fn release(control: &mut BufReader<TcpStream>) {
    control.get_mut().write_all(b"continue\n").await.unwrap();
}
pub(super) struct NativeTaskSource {
    pub execution: maka_agent_facts::durable::ExecutionIdentity,
    pub request: maka_agent_ports::executor::Request,
    pub resource: maka_process::isolated::Descriptor,
    pub state: maka_agent_state::fold::ExternalTask,
    pub binding: Option<crate::executor::external::NativeBinding>,
}
impl NativeTaskSource {
    pub fn native_address(&self) -> Option<&str> {
        use crate::executor::external::NativeTask;
        self.binding.as_ref().map(|binding| match &binding.task {
            NativeTask::Codex { thread, .. } => thread.as_str(),
            NativeTask::Claude { session, .. } | NativeTask::ClaudeStream { session, .. } => {
                session.as_str()
            }
            NativeTask::Antigravity { conversation, .. } => conversation.as_str(),
        })
    }
}
pub(super) async fn native_task(f: &Fixture, session: &str) -> NativeTaskSource {
    let source = f.latest_run(session).await;
    let execution = source.execution();
    let view = f.owner.durable.frontier(execution.run_id).await.unwrap();
    let state = view.external.expect("original admitted external task");
    let original = f
        .owner
        .durable
        .content(execution.run_id, state.descriptor.clone())
        .await
        .unwrap();
    let prepared: Value = serde_json::from_slice(&original).unwrap();
    let request = serde_json::from_value(prepared["payload"]["request"].clone()).unwrap();
    let resource = serde_json::from_value(prepared["payload"]["privateResource"].clone()).unwrap();
    let binding = match &state.binding {
        Some(reference) => {
            let bytes = f
                .owner
                .durable
                .content(execution.run_id, reference.clone())
                .await
                .unwrap();
            let frozen: Value = serde_json::from_slice(&bytes).unwrap();
            let recovery: crate::executor::RecoveryDescriptor =
                serde_json::from_value(frozen["payload"]["recovery"].clone()).unwrap();
            let crate::executor::RecoveryDescriptor::Native { binding } = recovery else {
                panic!("original native task recovery descriptor");
            };
            Some(binding)
        }
        None => None,
    };
    NativeTaskSource {
        execution,
        request,
        resource,
        state,
        binding,
    }
}

pub(super) fn host_tool(method: &str, name: &str) -> contract::ServiceTool {
    serde_json::from_value(json!({"name":name,"description":format!("Host {method}"),"target":{"kind":"export","name":"agent"},"method":method,"result":"json","confirmation":"preapproved"})).unwrap()
}

pub(super) async fn assistant_texts(f: &Fixture, session: &str) -> Vec<String> {
    use maka_agent_facts::{durable::Fact, executor::Output};
    let events = f.recorded_facts(session).await;
    let mut messages = Vec::<(String, String)>::new();
    for row in events {
        match row.fact {
            Fact::ExternalTaskObserved {
                output: Output::MessageStart { message_id },
                ..
            } => messages.push((message_id, String::new())),
            Fact::ExternalTaskObserved {
                output: Output::OutputDelta { message_id, text },
                ..
            } => {
                messages
                    .iter_mut()
                    .rev()
                    .find(|(id, _)| *id == message_id)
                    .expect("native message start")
                    .1
                    .push_str(&text);
            }
            _ => {}
        }
    }
    messages.into_iter().map(|(_, text)| text).collect()
}

pub(super) async fn host_effects(
    f: &Fixture,
    session: &str,
) -> Vec<(
    maka_agent_facts::external_effects::ExternalEffectDescriptor,
    maka_agent_state::external_effects::ExternalEffect,
)> {
    use maka_agent_facts::{durable::Fact, external_effects::ExternalEffectEvent};
    let mut originals = Vec::new();
    for recorded in f.recorded_facts(session).await {
        if let Fact::ExternalEffect {
            event: ExternalEffectEvent::Prepared { key, descriptor },
        } = recorded.fact
        {
            let bytes = f
                .owner
                .durable
                .content(recorded.run, descriptor)
                .await
                .unwrap();
            let original = serde_json::from_slice(&bytes).unwrap();
            let view = f.owner.durable.frontier(recorded.run).await.unwrap();
            let task = view.external.expect("original external task");
            assert_eq!(task.task, key.task);
            let effect = f
                .owner
                .durable
                .external_effect(recorded.run, key)
                .await
                .unwrap()
                .expect("original Host effect");
            originals.push((original, effect));
        }
    }
    originals
}
