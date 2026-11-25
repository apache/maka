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

use std::{
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Output, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

use maka_event_log::root::{RootNamespaces, RootOwner};
use maka_mock_ai::{
    ControlPlaneConfig, FinishReason, HttpErrorSpec, MockAiBuilder, MockAiServer, ModelEntry,
    NormalizedRequest, NormalizedRole, TurnContext, TurnPlan, Usage,
};
use serde_json::{Value, json};
use tokio::io::AsyncWriteExt;
#[cfg(unix)]
use tokio::{io::AsyncReadExt, net::TcpStream};

struct TestEnv {
    _root: tempfile::TempDir,
    home: PathBuf,
    tmp: PathBuf,
    workspace: PathBuf,
    roots: Vec<PathBuf>,
}

impl TestEnv {
    fn new() -> Self {
        #[cfg(unix)]
        let root = tempfile::Builder::new()
            .prefix("mrn-")
            .tempdir_in("/tmp")
            .or_else(|_| tempfile::tempdir())
            .expect("tempdir");
        #[cfg(not(unix))]
        let root = tempfile::Builder::new()
            .prefix("mrn-")
            .tempdir()
            .expect("tempdir");

        let base = std::fs::canonicalize(root.path()).unwrap_or_else(|_| root.path().to_path_buf());
        let home = base.join("h");
        let tmp = base.join("t");
        let workspace = base.join("ws");
        for dir in [&home, &tmp, &workspace] {
            std::fs::create_dir_all(dir).expect("create test subdir");
        }
        Self {
            _root: root,
            home,
            tmp,
            workspace,
            roots: Vec::new(),
        }
    }

    fn base_dir(&self) -> &Path {
        self.home.parent().expect("base dir")
    }

    fn maka_command(&self) -> Command {
        let mut cmd = Command::new(crate::maka_executable());
        cmd.current_dir(&self.workspace)
            .env("HOME", &self.home)
            .env("USERPROFILE", &self.home)
            .env("XDG_CONFIG_HOME", self.home.join("config"))
            .env("XDG_DATA_HOME", self.home.join("data"))
            .env("XDG_STATE_HOME", self.home.join("state"))
            .env("XDG_CACHE_HOME", self.home.join("cache"))
            .env("TMPDIR", &self.tmp)
            .env("TMP", &self.tmp)
            .env("TEMP", &self.tmp)
            .env("NO_PROXY", "127.0.0.1,localhost,::1")
            .env("no_proxy", "127.0.0.1,localhost,::1");
        cmd
    }

    fn init_root(&mut self, name: &str, base_url: &str, sandbox_mode: &str) -> PathBuf {
        let root = self.base_dir().join(name);
        self.roots.push(root.clone());
        let ws_host = maka_fs_tools::workspace::project::host_path(&self.workspace).unwrap();
        let settings = serde_json::to_vec(&json!({
            "chatDefaults": { "sandboxMode": sandbox_mode },
            "projectDirectoryRoots": [{ "label": "Workspace", "path": ws_host }],
            "connections": [{
                "slug": "test-gateway",
                "name": "Test Gateway",
                "provider": "openai-compatible",
                "configuration": { "baseUrl": base_url },
                "apiKey": "sk-test-run-key",
                "enabled": true,
                "enabledModelIds": ["test-model"],
            }],
            "defaultTarget": { "slug": "test-gateway", "modelId": "test-model" }
        }))
        .unwrap();
        let mut child = self
            .maka_command()
            .args([
                "host",
                "init",
                "--settings-stdin",
                "--timeout-ms",
                "15000",
                "--root",
            ])
            .arg(&root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn maka host init");
        child.stdin.take().unwrap().write_all(&settings).unwrap();
        let out = child.wait_with_output().unwrap();
        assert!(
            out.status.success(),
            "maka host init failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        root
    }

    fn status(&self, root: &Path) -> Output {
        self.maka_command()
            .args(["host", "status", "--root"])
            .arg(root)
            .output()
            .expect("run maka host status")
    }

    fn retire(&self, root: &Path) -> Output {
        self.maka_command()
            .args(["host", "retire", "--root"])
            .arg(root)
            .arg("--allow-interrupt-active-tasks")
            .output()
            .expect("run maka host retire")
    }
}

impl Drop for TestEnv {
    fn drop(&mut self) {
        for root in &self.roots {
            if root.exists() {
                let _ = self.retire(root);
            }
        }
    }
}

async fn start_mock_ai<F>(handler: F) -> MockAiServer
where
    F: Fn(&NormalizedRequest, &TurnContext) -> TurnPlan + Send + Sync + 'static,
{
    MockAiBuilder::new()
        .control(ControlPlaneConfig {
            models: vec![ModelEntry::simple("test-model")],
            ..Default::default()
        })
        .handler_fn(handler)
        .start()
        .await
        .expect("start mock-ai server")
}

async fn run_cli(cmd: Command, stdin_bytes: Option<&[u8]>) -> Output {
    let mut cmd = tokio::process::Command::from(cmd);
    cmd.kill_on_drop(true)
        .stdin(if stdin_bytes.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().expect("spawn maka run");
    if let Some(bytes) = stdin_bytes {
        let mut stdin = child.stdin.take().expect("piped stdin");
        stdin.write_all(bytes).await.expect("write stdin");
        drop(stdin);
    }
    tokio::time::timeout(Duration::from_secs(20), child.wait_with_output())
        .await
        .expect("maka run timed out after 20s")
        .expect("wait maka run")
}

async fn wait_for_root_released(root: &Path, timeout: Duration) {
    let namespaces = RootNamespaces::for_current_account().unwrap();
    let deadline = Instant::now() + timeout;
    let mut last_err = None;
    while Instant::now() < deadline {
        match RootOwner::open(root, &namespaces) {
            Ok(owner) => {
                let reg = namespaces
                    .control
                    .join(owner.root_id())
                    .join("registration.json");
                drop(owner);
                if !reg.exists() {
                    return;
                }
            }
            Err(err) => last_err = Some(err),
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!(
        "Host did not release root {} within {timeout:?}: last_err={last_err:?}",
        root.display()
    );
}

#[cfg(unix)]
async fn http_get_loopback(port: u16) -> Result<(String, String), std::io::Error> {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await?;
    stream
        .write_all(b"GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .await?;
    let mut buf = String::new();
    stream.read_to_string(&mut buf).await?;
    let (head, body) = buf.split_once("\r\n\r\n").unwrap_or((buf.as_str(), ""));
    Ok((head.to_owned(), body.to_owned()))
}

#[cfg(unix)]
async fn assert_port_closed(port: u16, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if TcpStream::connect(("127.0.0.1", port)).await.is_err() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("background HTTP server on port {port} stayed alive after cleanup");
}

#[cfg(unix)]
fn shell_single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\"'\"'"))
}

#[cfg(unix)]
fn bg_server_turn_plan(port_file: &Path) -> TurnPlan {
    let port_json = serde_json::to_string(port_file).unwrap();
    let tmp_json = serde_json::to_string(&port_file.with_extension("tmp")).unwrap();
    let node_script = format!(
        "const fs=require('fs'),http=require('http');\
         const s=http.createServer((req,res)=>{{res.writeHead(200,{{'content-type':'text/plain','content-length':'10'}});res.end('bg-http-ok');}});\
         s.listen(0,'127.0.0.1',()=>{{const p=String(s.address().port);fs.writeFileSync({tmp_json},p);fs.renameSync({tmp_json},{port_json});}});\
         setInterval(()=>{{}},60000);"
    );
    let bg_input = json!({
        "command": format!("node -e {}", shell_single_quote(&node_script)),
        "run_in_background": true,
        "login": false,
    });
    let quoted_port = shell_single_quote(&port_file.display().to_string());
    let wait_input = json!({
        "command": format!(
            "i=0; while [ ! -f {quoted_port} ] && [ $i -lt 100 ]; do sleep 0.05; i=$((i+1)); done; test -f {quoted_port}"
        ),
        "login": false,
    });
    TurnPlan::new()
        .push_tool_call(
            "call_bg",
            "exec",
            json!({
                "code": format!("const r = await tools.Shell({bg_input}); await tools.Shell({wait_input}); text(r);")
            }),
        )
        .with_usage(Usage::new(100, 20))
        .finish(FinishReason::ToolCalls)
}

fn spawn_serve_host(env: &TestEnv, root: &Path) -> (Child, std::thread::JoinHandle<()>) {
    let mut child = env
        .maka_command()
        .args(["host", "serve", "--root"])
        .arg(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn maka host serve");
    let mut reader = BufReader::new(child.stdout.take().unwrap());
    let mut line = String::new();
    let mut ready = false;
    while reader.read_line(&mut line).unwrap() > 0 {
        if let Ok(v) = serde_json::from_str::<Value>(&line)
            && v["kind"] == "ready"
        {
            ready = true;
            break;
        }
        line.clear();
    }
    assert!(ready, "maka host serve never printed ready line");
    let drain = std::thread::spawn(move || {
        let mut sink = String::new();
        while reader.read_line(&mut sink).unwrap_or(0) > 0 {
            sink.clear();
        }
    });
    (child, drain)
}

#[tokio::test]
async fn run_completes_arg_and_stdin_and_retires_idle_candidate() {
    // 43-byte line ensures 8192-byte page boundaries split inside multi-byte UTF-8.
    let large_reply: String = (0..600)
        .map(|i| format!("line-{i:04}: 分页校验 🚀 payload-line!\n"))
        .collect();
    assert!(large_reply.len() > 20 * 1024);
    let large_reply_cb = large_reply.clone();

    let mock = start_mock_ai(move |req, _| {
        let reply = if req.raw_body["messages"].to_string().contains("From stdin") {
            large_reply_cb.as_str()
        } else {
            "Hello from maka run"
        };
        TurnPlan::new()
            .push_text(reply)
            .with_usage(Usage::new(100, 20))
            .finish(FinishReason::Stop)
    })
    .await;

    let mut env = TestEnv::new();
    let root = env.init_root("root-echo", &mock.base_url(), "danger-full-access");

    let mut cmd = env.maka_command();
    cmd.args(["run", "--root"])
        .arg(&root)
        .arg("--workspace")
        .arg(&env.workspace)
        .arg("Say hello");
    let out = run_cli(cmd, None).await;
    assert!(
        out.status.success(),
        "maka run failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(
        std::str::from_utf8(&out.stdout).expect("valid utf8 stdout"),
        "Hello from maka run\n"
    );

    let mut cmd2 = env.maka_command();
    cmd2.args(["run", "--root"])
        .arg(&root)
        .arg("--workspace")
        .arg(&env.workspace);
    let out2 = run_cli(cmd2, Some(b"From stdin\n")).await;
    assert!(
        out2.status.success(),
        "maka run stdin failed: {}",
        String::from_utf8_lossy(&out2.stderr)
    );
    let stdout2 = std::str::from_utf8(&out2.stdout).expect("valid utf8 stdout");
    assert_eq!(stdout2.len(), large_reply.len());
    assert_eq!(stdout2, large_reply);

    wait_for_root_released(&root, Duration::from_secs(10)).await;
}

#[cfg(unix)]
#[tokio::test]
async fn run_preserves_background_http_server_across_completion_and_subsequent_failure() {
    let mut env = TestEnv::new();
    let port_file = env.workspace.join("bg-port.txt");
    let port_file_cb = port_file.clone();
    let started_bg = Arc::new(AtomicBool::new(false));
    let started_bg_cb = Arc::clone(&started_bg);
    let mock = start_mock_ai(move |req, _| {
        if req.raw_body["messages"]
            .to_string()
            .contains("Trigger model 400")
        {
            TurnPlan::http_error(HttpErrorSpec::new(
                400,
                "invalid_request_error",
                "simulated model failure",
            ))
        } else if !started_bg_cb.swap(true, Ordering::SeqCst) {
            bg_server_turn_plan(&port_file_cb)
        } else {
            TurnPlan::new()
                .push_text("server ready")
                .with_usage(Usage::new(100, 20))
                .finish(FinishReason::Stop)
        }
    })
    .await;
    let root = env.init_root("root-bg-keep", &mock.base_url(), "danger-full-access");

    let mut cmd_a = env.maka_command();
    cmd_a
        .args(["run", "--root"])
        .arg(&root)
        .arg("--workspace")
        .arg(&env.workspace)
        .arg("Start background HTTP server");
    let out_a = run_cli(cmd_a, None).await;
    assert!(
        out_a.status.success(),
        "maka run A failed: {}",
        String::from_utf8_lossy(&out_a.stderr)
    );
    assert_eq!(String::from_utf8_lossy(&out_a.stdout), "server ready\n");

    let port: u16 = std::fs::read_to_string(&port_file)
        .expect("port file written before completion")
        .trim()
        .parse()
        .expect("valid port");
    // Sleep past candidate's 1000ms idle_grace_ms to verify background service keeps Host alive.
    tokio::time::sleep(Duration::from_secs(2)).await;

    let (head, body) = http_get_loopback(port)
        .await
        .expect("background HTTP server should still accept connections");
    assert!(head.contains("200 OK"), "{head}");
    assert_eq!(body, "bg-http-ok");

    // A subsequent model 400 failure on the same Root must not kill the prior background server.
    let mut cmd_b = env.maka_command();
    cmd_b
        .args(["run", "--root"])
        .arg(&root)
        .arg("--workspace")
        .arg(&env.workspace)
        .arg("Trigger model 400");
    let out_b = run_cli(cmd_b, None).await;
    assert_eq!(out_b.status.code(), Some(1), "expected non-zero exit");
    let stderr_b = String::from_utf8_lossy(&out_b.stderr);
    assert!(stderr_b.contains("simulated model failure"), "{stderr_b}");
    assert!(!stderr_b.contains("run failed: null"), "{stderr_b}");

    let (head2, body2) = http_get_loopback(port)
        .await
        .expect("prior background HTTP server must remain alive after run B failure");
    assert!(head2.contains("200 OK"), "{head2}");
    assert_eq!(body2, "bg-http-ok");

    let status_json: Value = serde_json::from_slice(&env.status(&root).stdout).unwrap();
    assert_eq!(status_json["closing"], false, "{status_json}");

    assert!(env.retire(&root).status.success());
    wait_for_root_released(&root, Duration::from_secs(10)).await;
    assert_port_closed(port, Duration::from_secs(5)).await;
}

fn json_stdout(out: &Output) -> Value {
    assert!(
        out.status.success(),
        "maka run failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    serde_json::from_slice(&out.stdout).unwrap_or_else(|error| {
        panic!(
            "stdout is not JSON ({error}): {}",
            String::from_utf8_lossy(&out.stdout)
        )
    })
}

fn text_stdout(out: &Output) -> &str {
    assert!(
        out.status.success(),
        "maka run failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    std::str::from_utf8(&out.stdout).expect("valid utf8 stdout")
}

fn session_command(env: &TestEnv, root: &Path, session: &str) -> Command {
    let mut cmd = env.maka_command();
    cmd.args(["run", "--root"])
        .arg(root)
        .args(["--session", session]);
    cmd
}

#[tokio::test]
async fn run_continues_a_session_started_without_waiting() {
    let mock = start_mock_ai(|req, _| {
        let saw_first = req.messages.iter().any(|message| {
            matches!(message.role, NormalizedRole::User) && message.text.contains("First task")
        });
        let reply = if req.raw_body["messages"].to_string().contains("Second task") {
            format!("second reply, first task seen: {saw_first}")
        } else {
            "first reply".into()
        };
        TurnPlan::new()
            .push_text(reply)
            .with_usage(Usage::new(100, 20))
            .finish(FinishReason::Stop)
    })
    .await;

    let mut env = TestEnv::new();
    let root = env.init_root("root-continue", &mock.base_url(), "danger-full-access");

    let mut start = env.maka_command();
    start
        .args(["run", "--root"])
        .arg(&root)
        .arg("--workspace")
        .arg(&env.workspace)
        .args(["--no-wait", "First task"]);
    let receipt = json_stdout(&run_cli(start, None).await);
    assert_eq!(receipt["status"], "submitted", "{receipt}");
    let session = receipt["sessionId"].as_str().expect("session id");

    let mut wait = session_command(&env, &root, session);
    wait.arg("--wait");
    assert_eq!(text_stdout(&run_cli(wait, None).await), "first reply\n");

    let mut send = session_command(&env, &root, session);
    send.arg("Second task");
    let second = "second reply, first task seen: true\n";
    assert_eq!(text_stdout(&run_cli(send, None).await), second);

    // An idle Session reports its latest result.
    let mut wait_again = session_command(&env, &root, session);
    wait_again.arg("--wait");
    assert_eq!(text_stdout(&run_cli(wait_again, None).await), second);

    wait_for_root_released(&root, Duration::from_secs(10)).await;
}

#[tokio::test]
async fn run_reports_a_pending_question_and_continues_with_the_answer() {
    let mock = start_mock_ai(|req, _| {
        let (plan, finish) = match req
            .messages
            .iter()
            .rfind(|message| matches!(message.role, NormalizedRole::Tool))
        {
            Some(result) if result.text.contains("Zeta") => {
                (TurnPlan::new().push_text("picked Zeta"), FinishReason::Stop)
            }
            Some(result) => (
                TurnPlan::new().push_text(format!("unexpected answer: {}", result.text)),
                FinishReason::Stop,
            ),
            None => (
                TurnPlan::new().push_tool_call(
                    "call_ask",
                    "AskUserQuestion",
                    json!({ "questions": [{
                        "question": "Which option?",
                        "options": [{ "label": "Alpha" }, { "label": "Zeta" }],
                    }]}),
                ),
                FinishReason::ToolCalls,
            ),
        };
        plan.with_usage(Usage::new(100, 20)).finish(finish)
    })
    .await;

    let mut env = TestEnv::new();
    let root = env.init_root("root-question", &mock.base_url(), "danger-full-access");

    let mut ask = env.maka_command();
    ask.args(["run", "--root"])
        .arg(&root)
        .arg("--workspace")
        .arg(&env.workspace)
        .arg("Ask me first");
    let waiting = json_stdout(&run_cli(ask, None).await);
    let session = waiting["sessionId"].as_str().expect("session id");
    assert_eq!(
        waiting,
        json!({
            "status": "waiting",
            "sessionId": session,
            "interactions": [{
                "kind": "question",
                "questions": [{
                    "question": "Which option?",
                    "options": [{ "label": "Alpha" }, { "label": "Zeta" }],
                }],
            }],
        })
    );

    let mut answer = session_command(&env, &root, session);
    answer.args(["--answer", r#"["Zeta"]"#]);
    assert_eq!(text_stdout(&run_cli(answer, None).await), "picked Zeta\n");

    let mut again = session_command(&env, &root, session);
    again.args(["--answer", r#"["Alpha"]"#]);
    let out = run_cli(again, None).await;
    assert_eq!(out.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("no pending question"), "{stderr}");

    wait_for_root_released(&root, Duration::from_secs(10)).await;
}

#[tokio::test]
async fn run_reuses_service_host_and_keeps_a_pending_permission_until_stopped() {
    let mut env = TestEnv::new();

    let absent_root = env.base_dir().join("absent-root-prompt");
    let mut bad_timeout = env.maka_command();
    bad_timeout
        .args(["run", "--timeout-ms", "50", "--root"])
        .arg(&absent_root)
        .arg("--workspace")
        .arg(&env.workspace)
        .arg("hello");
    let timeout_out = run_cli(bad_timeout, None).await;
    assert_eq!(timeout_out.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&timeout_out.stderr).contains("--timeout-ms"));
    assert!(!absent_root.exists());

    let mut empty_prompt = env.maka_command();
    empty_prompt
        .args(["run", "--root"])
        .arg(&absent_root)
        .arg("--workspace")
        .arg(&env.workspace)
        .arg("   ");
    let out = run_cli(empty_prompt, None).await;
    assert_eq!(out.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&out.stderr).contains("prompt must not be empty"));
    assert!(!absent_root.exists());

    let sent_priv = Arc::new(AtomicBool::new(false));
    let sent_priv_cb = Arc::clone(&sent_priv);
    let mock = start_mock_ai(move |req, _| {
        if req.raw_body["messages"]
            .to_string()
            .contains("Run privileged")
            && !sent_priv_cb.swap(true, Ordering::SeqCst)
        {
            let shell_input = json!({
                "command": "echo privileged",
                "login": false,
                "additional_permissions": { "filesystem": [], "network": "allowed" },
                "justification": "Need network access",
            });
            TurnPlan::new()
                .push_tool_call(
                    "call_perm",
                    "exec",
                    json!({ "code": format!("text(await tools.Shell({shell_input}));") }),
                )
                .with_usage(Usage::new(100, 20))
                .finish(FinishReason::ToolCalls)
        } else {
            TurnPlan::new()
                .push_text("Hello from service host")
                .with_usage(Usage::new(100, 20))
                .finish(FinishReason::Stop)
        }
    })
    .await;

    let root = env.init_root("root-serve", &mock.base_url(), "workspace-write");
    let (mut serve_child, drain) = spawn_serve_host(&env, &root);

    let mut ok_cmd = env.maka_command();
    ok_cmd
        .args(["run", "--root"])
        .arg(&root)
        .arg("--workspace")
        .arg(&env.workspace)
        .arg("Say hello");
    let ok_out = run_cli(ok_cmd, None).await;
    assert!(
        ok_out.status.success(),
        "{}",
        String::from_utf8_lossy(&ok_out.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&ok_out.stdout),
        "Hello from service host\n"
    );
    assert!(
        serve_child.try_wait().unwrap().is_none(),
        "Service Host must stay running after completed maka run"
    );

    let mut perm_cmd = env.maka_command();
    perm_cmd
        .args(["run", "--root"])
        .arg(&root)
        .arg("--workspace")
        .arg(&env.workspace)
        .arg("Run privileged shell");
    let waiting = json_stdout(&run_cli(perm_cmd, None).await);
    assert_eq!(waiting["status"], "waiting", "{waiting}");
    assert_eq!(
        waiting["interactions"][0]["kind"], "permissions",
        "{waiting}"
    );
    assert!(
        serve_child.try_wait().unwrap().is_none(),
        "Service Host must stay running after a waiting maka run"
    );

    // The Run keeps waiting for the decision instead of being cancelled.
    let session = waiting["sessionId"].as_str().expect("session id");
    let mut wait_cmd = session_command(&env, &root, session);
    wait_cmd.arg("--wait");
    let still_waiting = json_stdout(&run_cli(wait_cmd, None).await);
    assert_eq!(still_waiting, waiting);
    let status_json: Value = serde_json::from_slice(&env.status(&root).stdout).unwrap();
    assert_eq!(status_json["closing"], false, "{status_json}");

    let mut stop_cmd = session_command(&env, &root, session);
    stop_cmd.arg("--stop");
    let stopped = json_stdout(&run_cli(stop_cmd, None).await);
    assert_eq!(
        stopped,
        json!({ "status": "stopped", "sessionId": session })
    );
    let mut stop_again = session_command(&env, &root, session);
    stop_again.arg("--stop");
    let out = run_cli(stop_again, None).await;
    assert_eq!(out.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("no active run"), "{stderr}");

    assert!(env.retire(&root).status.success());
    assert!(serve_child.wait().unwrap().success());
    let _ = drain.join();
}

#[tokio::test]
async fn run_wait_reports_the_failure_of_an_ended_run() {
    let mock = start_mock_ai(|_, _| {
        TurnPlan::http_error(HttpErrorSpec::new(
            400,
            "invalid_request_error",
            "simulated model failure",
        ))
    })
    .await;

    let mut env = TestEnv::new();
    let root = env.init_root("root-wait-failed", &mock.base_url(), "danger-full-access");

    let mut start = env.maka_command();
    start
        .args(["run", "--root"])
        .arg(&root)
        .arg("--workspace")
        .arg(&env.workspace)
        .args(["--no-wait", "Fail on the model request"]);
    let receipt = json_stdout(&run_cli(start, None).await);
    let session = receipt["sessionId"].as_str().expect("session id");

    // The first wait may follow the Run; the second finds it already ended.
    for _ in 0..2 {
        let mut wait = session_command(&env, &root, session);
        wait.arg("--wait");
        let out = run_cli(wait, None).await;
        assert_eq!(out.status.code(), Some(1));
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert!(
            stderr.contains("run failed: ") && stderr.contains("simulated model failure"),
            "{stderr}"
        );
    }

    wait_for_root_released(&root, Duration::from_secs(10)).await;
}

#[tokio::test]
async fn run_failure_after_429_reports_terminal_output_limit_diagnostic() {
    let calls = Arc::new(AtomicUsize::new(0));
    let calls_cb = Arc::clone(&calls);
    let mock = start_mock_ai(move |_, _| {
        let idx = calls_cb.fetch_add(1, Ordering::SeqCst);
        if idx == 0 {
            TurnPlan::http_error(
                HttpErrorSpec::rate_limit(None, "transient rate limit").with_retry_after_ms(1),
            )
        } else {
            TurnPlan::new()
                .push_text("truncated chunk ")
                .with_usage(Usage::new(100, 20))
                .finish(FinishReason::Length)
        }
    })
    .await;

    let mut env = TestEnv::new();
    let root = env.init_root("root-429-length", &mock.base_url(), "danger-full-access");

    let mut cmd = env.maka_command();
    cmd.args(["run", "--root"])
        .arg(&root)
        .arg("--workspace")
        .arg(&env.workspace)
        .arg("Hit 429 then exhaust output length");
    let out = run_cli(cmd, None).await;
    assert_eq!(out.status.code(), Some(1), "expected non-zero exit");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stderr.contains("reached its length limit again after being asked to continue"),
        "{stderr}"
    );
    assert!(!stderr.contains("transient rate limit"), "{stderr}");

    wait_for_root_released(&root, Duration::from_secs(5)).await;
}

#[cfg(unix)]
#[tokio::test]
async fn run_sigterm_interrupts_blocked_stdout_pipe() {
    use std::os::fd::AsRawFd;

    let payload = "A".repeat(512 * 1024);
    let mock = start_mock_ai(move |_, _| {
        TurnPlan::new()
            .push_text(payload.clone())
            .with_usage(Usage::new(100, 20))
            .finish(FinishReason::Stop)
    })
    .await;

    let mut env = TestEnv::new();
    let root = env.init_root(
        "root-blocked-stdout",
        &mock.base_url(),
        "danger-full-access",
    );

    let mut cmd = tokio::process::Command::from(env.maka_command());
    cmd.args(["run", "--root"])
        .arg(&root)
        .arg("--workspace")
        .arg(&env.workspace)
        .arg("Emit large answer")
        .kill_on_drop(true)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().expect("spawn maka run");

    let stdout = child.stdout.take().expect("piped stdout");
    let mut stderr = child.stderr.take().expect("piped stderr");
    let stderr_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        stderr.read_to_end(&mut buf).await.expect("read stderr");
        buf
    });

    // Wait until Host completes and `maka run` starts writing to stdout (without reading it).
    let deadline = Instant::now() + Duration::from_secs(15);
    let mut poll_fd = libc::pollfd {
        fd: stdout.as_raw_fd(),
        events: libc::POLLIN,
        revents: 0,
    };
    let mut ready = false;
    while Instant::now() < deadline {
        // SAFETY: `poll_fd` points to a valid `libc::pollfd` for an open stdout read fd.
        let n = unsafe { libc::poll(&mut poll_fd, 1, 0) };
        if n > 0 && (poll_fd.revents & libc::POLLIN) != 0 {
            ready = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(ready, "stdout pipe never received answer bytes");

    // Let `write` fill the OS pipe buffer and block.
    tokio::time::sleep(Duration::from_millis(50)).await;

    let pid = child.id().expect("child pid");
    // SAFETY: `pid` is a live child process spawned by this test.
    let rc = unsafe { libc::kill(pid as i32, libc::SIGTERM) };
    assert_eq!(rc, 0, "failed to send SIGTERM");

    let status = tokio::time::timeout(Duration::from_secs(5), child.wait())
        .await
        .expect("maka run did not exit promptly on SIGTERM while stdout pipe was blocked")
        .expect("wait child");
    assert_eq!(status.code(), Some(1), "expected exit 1 on SIGTERM");

    drop(stdout);
    let stderr_bytes = stderr_task.await.expect("join stderr task");
    let stderr_text = String::from_utf8_lossy(&stderr_bytes);
    assert!(
        stderr_text.contains("interrupted by signal"),
        "{stderr_text}"
    );

    wait_for_root_released(&root, Duration::from_secs(10)).await;
}

#[cfg(unix)]
#[tokio::test]
async fn run_sigterm_cancels_in_flight_run() {
    let mut mock = MockAiBuilder::new()
        .control(ControlPlaneConfig {
            models: vec![ModelEntry::simple("test-model")],
            ..Default::default()
        })
        .interactive(4)
        .start()
        .await
        .expect("start interactive mock-ai server");

    let mut env = TestEnv::new();
    let root = env.init_root(
        "root-sigterm-inflight",
        &mock.base_url(),
        "danger-full-access",
    );

    let mut cmd = tokio::process::Command::from(env.maka_command());
    cmd.args(["run", "--root"])
        .arg(&root)
        .arg("--workspace")
        .arg(&env.workspace)
        .arg("Hold in-flight request")
        .kill_on_drop(true)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().expect("spawn maka run");

    let _stdout = child.stdout.take().expect("piped stdout");
    let mut stderr = child.stderr.take().expect("piped stderr");
    let stderr_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        stderr.read_to_end(&mut buf).await.expect("read stderr");
        buf
    });

    let _turn = tokio::time::timeout(Duration::from_secs(15), mock.next_turn())
        .await
        .expect("model request did not arrive")
        .expect("interactive turn handle");

    let pid = child.id().expect("child pid");
    // SAFETY: `pid` is a live child process spawned by this test.
    let rc = unsafe { libc::kill(pid as i32, libc::SIGTERM) };
    assert_eq!(rc, 0, "failed to send SIGTERM");

    let status = tokio::time::timeout(Duration::from_secs(5), child.wait())
        .await
        .expect("maka run did not exit promptly on SIGTERM during in-flight run")
        .expect("wait child");
    assert_eq!(status.code(), Some(1), "expected exit 1 on SIGTERM");

    let stderr_bytes = stderr_task.await.expect("join stderr task");
    let stderr_text = String::from_utf8_lossy(&stderr_bytes);
    assert!(
        stderr_text.contains("interrupted by signal"),
        "{stderr_text}"
    );

    wait_for_root_released(&root, Duration::from_secs(10)).await;
}

#[cfg(unix)]
#[tokio::test]
async fn run_sigterm_detaches_a_wait_without_cancelling_the_run() {
    let mut mock = MockAiBuilder::new()
        .control(ControlPlaneConfig {
            models: vec![ModelEntry::simple("test-model")],
            ..Default::default()
        })
        .interactive(4)
        .start()
        .await
        .expect("start interactive mock-ai server");

    let mut env = TestEnv::new();
    let root = env.init_root("root-sigterm-wait", &mock.base_url(), "danger-full-access");

    let mut start = env.maka_command();
    start
        .args(["run", "--root"])
        .arg(&root)
        .arg("--workspace")
        .arg(&env.workspace)
        .args(["--no-wait", "Hold until released"]);
    let receipt = json_stdout(&run_cli(start, None).await);
    let session = receipt["sessionId"].as_str().expect("session id");
    let turn = tokio::time::timeout(Duration::from_secs(15), mock.next_turn())
        .await
        .expect("model request did not arrive")
        .expect("interactive turn handle");

    let mut wait = tokio::process::Command::from(session_command(&env, &root, session));
    wait.arg("--wait")
        .kill_on_drop(true)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let child = wait.spawn().expect("spawn maka run --wait");
    // Give the wait time to attach to the Session.
    tokio::time::sleep(Duration::from_secs(2)).await;
    let pid = child.id().expect("child pid");
    // SAFETY: `pid` is a live child process spawned by this test.
    let rc = unsafe { libc::kill(pid as i32, libc::SIGTERM) };
    assert_eq!(rc, 0, "failed to send SIGTERM");
    let out = tokio::time::timeout(Duration::from_secs(5), child.wait_with_output())
        .await
        .expect("maka run --wait did not exit promptly on SIGTERM")
        .expect("wait child");
    assert_eq!(out.status.code(), Some(1), "expected exit 1 on SIGTERM");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("interrupted by signal"), "{stderr}");

    // Detaching left the Run running: releasing the model completes it.
    turn.reply_text("released reply");
    let mut wait_again = session_command(&env, &root, session);
    wait_again.arg("--wait");
    assert_eq!(
        text_stdout(&run_cli(wait_again, None).await),
        "released reply\n"
    );

    wait_for_root_released(&root, Duration::from_secs(10)).await;
}
