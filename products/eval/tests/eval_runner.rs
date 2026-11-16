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

use std::path::{Path, PathBuf};
use std::process::{Command as StdCommand, Output};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use maka_host_runtime::application::host::Client as HostClient;
use maka_host_runtime::application::host::discovery;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};

struct IsolatedEnv {
    _root: tempfile::TempDir,
    home: PathBuf,
    tmp: PathBuf,
    workspace: PathBuf,
    bundle: PathBuf,
    empty_cwd: PathBuf,
    seq: AtomicUsize,
}

impl IsolatedEnv {
    fn new(link_real_host: bool) -> Self {
        #[cfg(unix)]
        let root = tempfile::Builder::new()
            .prefix("mev-")
            .tempdir_in("/tmp")
            .or_else(|_| tempfile::tempdir())
            .expect("tempdir");
        #[cfg(not(unix))]
        let root = tempfile::Builder::new()
            .prefix("mev-")
            .tempdir()
            .expect("tempdir");

        let base = std::fs::canonicalize(root.path()).unwrap_or_else(|_| root.path().to_path_buf());
        let home = base.join("h");
        let tmp = base.join("t");
        let workspace = base.join("ws");
        let bundle = base.join("bundle");
        let empty_cwd = base.join("cwd");
        for dir in [&home, &tmp, &workspace, &bundle, &empty_cwd] {
            std::fs::create_dir_all(dir).expect("create isolated subdir");
        }

        let eval_bin = PathBuf::from(env!("CARGO_BIN_EXE_maka-eval"));
        stage_executable(&eval_bin, &bundle, "maka-eval");
        if link_real_host {
            stage_executable(&find_helper_binary("maka"), &bundle, "maka");
            stage_executable(
                &find_helper_binary("maka-python-worker"),
                &bundle,
                "maka-python-worker",
            );
        } else {
            for stub in ["maka", "maka-python-worker"] {
                std::fs::write(bundle.join(stub), b"").expect("write bundle placeholder");
            }
        }

        Self {
            _root: root,
            home,
            tmp,
            workspace,
            bundle,
            empty_cwd,
            seq: AtomicUsize::new(0),
        }
    }

    fn eval_command(&self) -> StdCommand {
        let bin = self
            .bundle
            .join(format!("maka-eval{}", std::env::consts::EXE_SUFFIX));
        let mut cmd = StdCommand::new(bin);
        cmd.current_dir(&self.empty_cwd)
            .env("HOME", &self.home)
            .env("USERPROFILE", &self.home)
            .env("XDG_CONFIG_HOME", self.home.join("config"))
            .env("XDG_DATA_HOME", self.home.join("data"))
            .env("XDG_STATE_HOME", self.home.join("state"))
            .env("XDG_CACHE_HOME", self.home.join("cache"))
            .env("TMPDIR", &self.tmp)
            .env("TMP", &self.tmp)
            .env("TEMP", &self.tmp)
            .env("NO_PROXY", "127.0.0.1,localhost")
            .env("no_proxy", "127.0.0.1,localhost");
        cmd
    }

    fn run_guest_raw(&self, raw_request: &[u8]) -> (Output, PathBuf, PathBuf, PathBuf) {
        let id = self.seq.fetch_add(1, Ordering::SeqCst);
        let artifacts = self.tmp.join(format!("artifacts-{id}"));
        let req_path = self.tmp.join(format!("req-{id}.json"));
        let res_path = artifacts.join("guest-result.json");
        std::fs::write(&req_path, raw_request).expect("write request");
        let out = self
            .eval_command()
            .args(["guest-run", "--request-file"])
            .arg(&req_path)
            .arg("--result-file")
            .arg(&res_path)
            .output()
            .expect("spawn guest-run");
        (out, req_path, res_path, artifacts)
    }

    async fn run_guest_live(&self, base_url: &str, max_steps: u32) -> (Value, PathBuf, PathBuf) {
        let id = self.seq.fetch_add(1, Ordering::SeqCst);
        let artifacts = self.tmp.join(format!("artifacts-live-{id}"));
        let req_path = self.tmp.join(format!("req-live-{id}.json"));
        let res_path = artifacts.join("guest-result.json");
        let payload = serde_json::to_vec(&json!({
            "instruction": "Execute evaluation task.",
            "workspaceDir": self.workspace,
            "artifactsDir": artifacts,
            "baseUrl": base_url,
            "apiKey": "sk-eval-key",
            "provider": "deepseek",
            "modelId": "deepseek-chat",
            "sandboxMode": "danger-full-access",
            "maxSteps": max_steps,
            "timeoutMs": 30_000,
        }))
        .unwrap();
        std::fs::write(&req_path, payload).unwrap();

        let mut cmd = self.eval_command();
        let req_for_cmd = req_path.clone();
        let res_for_cmd = res_path.clone();
        let out = tokio::task::spawn_blocking(move || {
            cmd.args(["guest-run", "--request-file"])
                .arg(&req_for_cmd)
                .arg("--result-file")
                .arg(&res_for_cmd)
                .output()
                .expect("run guest-run")
        })
        .await
        .unwrap();
        assert!(
            out.status.success(),
            "guest-run failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert!(!req_path.exists());
        let parsed: Value =
            serde_json::from_str(&std::fs::read_to_string(&res_path).unwrap()).unwrap();
        (parsed, res_path, artifacts.join("transcript.json"))
    }

    fn run_harbor(
        &self,
        guest_result: Option<&Path>,
        transcript: Option<&Path>,
        trial_result_json: &Value,
        exit_code: i32,
    ) -> (Output, PathBuf) {
        let id = self.seq.fetch_add(1, Ordering::SeqCst);
        let stub_dir = self.tmp.join(format!("harbor-stub-{id}"));
        std::fs::create_dir_all(&stub_dir).unwrap();
        let fake_harbor = write_fake_harbor_cli(
            &stub_dir,
            guest_result,
            transcript,
            trial_result_json,
            exit_code,
        );
        let out_dir = self.tmp.join(format!("run-out-{id}"));
        let out = self
            .eval_command()
            .env("EVAL_API_KEY", "sk-eval-key")
            .args(["run", "--task"])
            .arg(&self.workspace)
            .arg("--bundle-dir")
            .arg(&self.bundle)
            .arg("--out")
            .arg(&out_dir)
            .arg("--harbor-bin")
            .arg(&fake_harbor)
            .args([
                "--api-key-env",
                "EVAL_API_KEY",
                "--provider",
                "deepseek",
                "--model",
                "deepseek-chat",
            ])
            .output()
            .expect("run maka-eval run");
        (out, out_dir.join("run-summary.json"))
    }

    fn host_run_dirs(&self) -> Vec<PathBuf> {
        std::fs::read_dir(&self.tmp)
            .into_iter()
            .flatten()
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with("maka-eval-host-"))
            })
            .collect()
    }

    async fn retire_live_hosts(&self) -> usize {
        let mut retired = 0;
        for run_dir in self.host_run_dirs() {
            let Ok(disc) = discovery::read(&run_dir.join("root")) else {
                continue;
            };
            if HostClient::retire_with_options(&disc.endpoint, disc.host_epoch, true, true)
                .await
                .unwrap_or(false)
            {
                retired += 1;
            }
            let _ = std::fs::remove_dir_all(&run_dir);
        }
        if retired > 0 {
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
        retired
    }
}

impl Drop for IsolatedEnv {
    fn drop(&mut self) {
        let run_dirs = self.host_run_dirs();
        if !run_dirs.is_empty()
            && let Ok(rt) = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
        {
            for run_dir in run_dirs {
                if let Ok(disc) = discovery::read(&run_dir.join("root")) {
                    let _ = rt.block_on(HostClient::retire_with_options(
                        &disc.endpoint,
                        disc.host_epoch,
                        true,
                        true,
                    ));
                }
            }
        }
    }
}

fn stage_executable(src: &Path, bundle: &Path, stem: &str) {
    let with_ext = bundle.join(format!("{stem}{}", std::env::consts::EXE_SUFFIX));
    link_or_copy(src, &with_ext);
    #[cfg(windows)]
    link_or_copy(src, &bundle.join(stem));
}

fn link_or_copy(src: &Path, dst: &Path) {
    if dst.exists() {
        return;
    }
    #[cfg(unix)]
    if std::os::unix::fs::symlink(src, dst).is_ok() {
        return;
    }
    std::fs::copy(src, dst).expect("copy binary into test bundle");
}

fn find_helper_binary(name: &str) -> PathBuf {
    let env_key = format!("CARGO_BIN_EXE_{name}");
    if let Some(path) = std::env::var_os(&env_key).map(PathBuf::from)
        && path.is_file()
    {
        return path;
    }
    let eval_bin = PathBuf::from(env!("CARGO_BIN_EXE_maka-eval"));
    let exe_name = format!("{name}{}", std::env::consts::EXE_SUFFIX);
    if let Some(profile_dir) = eval_bin.parent() {
        let sibling = profile_dir.join(&exe_name);
        if sibling.is_file() {
            return sibling;
        }
        for dir in [
            profile_dir.parent().map(Path::to_path_buf),
            worktree_common_target_dir(),
        ]
        .into_iter()
        .flatten()
        {
            for profile in ["debug", "release", "ci"] {
                let candidate = dir.join(profile).join(&exe_name);
                if candidate.is_file() {
                    return candidate;
                }
            }
        }
    }
    panic!(
        "missing runtime helper binary {exe_name}; build maka-cli and maka-python-runtime or set {env_key}"
    );
}

fn worktree_common_target_dir() -> Option<PathBuf> {
    let repo_root = Path::new(env!("CARGO_MANIFEST_DIR")).parent()?.parent()?;
    let dot_git = std::fs::read_to_string(repo_root.join(".git")).ok()?;
    let gitdir = Path::new(dot_git.strip_prefix("gitdir:")?.trim());
    Some(gitdir.parent()?.parent()?.parent()?.join("target"))
}

enum MockMode {
    Retry429AndDelegateSubagent { workspace_path: String },
    MaxStepsSlowSecondTurn,
}

async fn start_mock_provider(mode: MockMode) -> String {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind loopback");
    let addr = listener.local_addr().expect("local addr");
    let counter = Arc::new(AtomicUsize::new(0));
    let mode = Arc::new(mode);
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let counter = Arc::clone(&counter);
            let mode = Arc::clone(&mode);
            tokio::spawn(async move {
                let _ = handle_http(stream, counter, mode).await;
            });
        }
    });
    format!("http://{addr}/v1")
}

async fn handle_http(
    stream: TcpStream,
    counter: Arc<AtomicUsize>,
    mode: Arc<MockMode>,
) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream);
    let mut request_line = String::new();
    if reader.read_line(&mut request_line).await? == 0 {
        return Ok(());
    }
    let is_get = request_line.starts_with("GET ");
    let mut content_length = 0usize;
    let mut chunked = false;
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).await?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            break;
        }
        if let Some((k, v)) = trimmed.split_once(':') {
            if k.eq_ignore_ascii_case("content-length") {
                content_length = v.trim().parse().unwrap_or(0);
            } else if k.eq_ignore_ascii_case("transfer-encoding")
                && v.to_ascii_lowercase().contains("chunked")
            {
                chunked = true;
            }
        }
    }

    let body_bytes = if chunked {
        let mut buf = Vec::new();
        loop {
            let mut size_line = String::new();
            reader.read_line(&mut size_line).await?;
            let hex = size_line.trim().split(';').next().unwrap_or("0");
            let size = usize::from_str_radix(hex, 16).unwrap_or(0);
            if size == 0 {
                let mut trailer = String::new();
                reader.read_line(&mut trailer).await?;
                break;
            }
            let start = buf.len();
            buf.resize(start + size, 0);
            reader.read_exact(&mut buf[start..]).await?;
            let mut crlf = [0u8; 2];
            reader.read_exact(&mut crlf).await?;
        }
        buf
    } else {
        let mut buf = vec![0u8; content_length];
        if content_length > 0 {
            reader.read_exact(&mut buf).await?;
        }
        buf
    };

    let mut stream = reader.into_inner();
    if is_get {
        let payload = br#"{"data":[{"id":"deepseek-chat"}]}"#;
        let header = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            payload.len()
        );
        stream.write_all(header.as_bytes()).await?;
        stream.write_all(payload).await?;
        return stream.flush().await;
    }

    let req: Value = serde_json::from_slice(&body_bytes).unwrap_or(Value::Null);
    let call_idx = counter.fetch_add(1, Ordering::SeqCst) + 1;
    if matches!(*mode, MockMode::Retry429AndDelegateSubagent { .. }) && call_idx == 1 {
        let err = br#"{"error":{"message":"rate limit","type":"rate_limit_error"}}"#;
        let header = format!(
            "HTTP/1.1 429 Too Many Requests\r\nContent-Type: application/json\r\nRetry-After: 0\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            err.len()
        );
        stream.write_all(header.as_bytes()).await?;
        stream.write_all(err).await?;
        return stream.flush().await;
    }

    stream
        .write_all(
            b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n",
        )
        .await?;

    match &*mode {
        MockMode::Retry429AndDelegateSubagent { workspace_path } => {
            let msgs = req["messages"].to_string();
            if call_idx == 2 {
                let code = format!(
                    r#"
                    const ml = await tools.ModelList({{ request: {{ kind: "start" }} }});
                    const backend = ml.choices.find(c => c.selection.kind === "model").selection;
                    const created = await tools.SessionCreate({{
                      title: "Delegate worker check",
                      labels: [],
                      backend,
                      workspace: {{ kind: "directory", path: {} }}
                    }});
                    const cid = created.session.id;
                    await tools.SessionSend({{ sessionId: cid, message: "DELEGATED_CHILD_PROMPT" }});
                    for (let i = 0; i < 100; i++) {{
                      const h = await tools.SessionRead({{ sessionId: cid, position: "start" }});
                      if (JSON.stringify(h).includes("CHILD_DONE_TOKEN")) break;
                      await new Promise(r => setTimeout(r, 40));
                    }}
                    text("DELEGATION_COMPLETE:" + cid);
                    "#,
                    serde_json::to_string(workspace_path).unwrap()
                );
                write_sse_tool_call(
                    &mut stream,
                    "call_1",
                    "exec",
                    &json!({ "code": code }),
                    100,
                    20,
                )
                .await?;
            } else if msgs.contains("DELEGATED_CHILD_PROMPT")
                && !msgs.contains("DELEGATION_COMPLETE:")
            {
                write_sse_text(&mut stream, "CHILD_DONE_TOKEN", 500, 100).await?;
            } else {
                write_sse_text(&mut stream, "Parent task completed.", 150, 30).await?;
            }
        }
        MockMode::MaxStepsSlowSecondTurn => {
            if call_idx == 1 {
                write_sse_tool_call(
                    &mut stream,
                    "call_step1",
                    "exec",
                    &json!({ "code": "text('step-1-ok');" }),
                    80,
                    20,
                )
                .await?;
            } else {
                let first_chunk = json!({
                    "id": "c_slow",
                    "object": "chat.completion.chunk",
                    "choices": [{
                        "index": 0,
                        "delta": { "role": "assistant", "content": "Continuing step 2..." },
                        "finish_reason": Value::Null,
                    }]
                });
                stream
                    .write_all(format!("data: {first_chunk}\n\n").as_bytes())
                    .await?;
                stream.flush().await?;
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }
    }
    Ok(())
}

async fn write_sse_tool_call(
    stream: &mut TcpStream,
    call_id: &str,
    name: &str,
    args: &Value,
    prompt_tokens: u64,
    completion_tokens: u64,
) -> std::io::Result<()> {
    let delta = json!({
        "id": "c_tool",
        "object": "chat.completion.chunk",
        "choices": [{
            "index": 0,
            "delta": {
                "role": "assistant",
                "tool_calls": [{
                    "index": 0,
                    "id": call_id,
                    "type": "function",
                    "function": { "name": name, "arguments": args.to_string() }
                }]
            },
            "finish_reason": Value::Null,
        }]
    });
    write_sse_final(
        stream,
        "c_tool",
        &delta,
        "tool_calls",
        prompt_tokens,
        completion_tokens,
    )
    .await
}

async fn write_sse_text(
    stream: &mut TcpStream,
    content: &str,
    prompt_tokens: u64,
    completion_tokens: u64,
) -> std::io::Result<()> {
    let delta = json!({
        "id": "c_txt",
        "object": "chat.completion.chunk",
        "choices": [{
            "index": 0,
            "delta": { "role": "assistant", "content": content },
            "finish_reason": Value::Null,
        }]
    });
    write_sse_final(
        stream,
        "c_txt",
        &delta,
        "stop",
        prompt_tokens,
        completion_tokens,
    )
    .await
}

async fn write_sse_final(
    stream: &mut TcpStream,
    id: &str,
    delta: &Value,
    finish_reason: &str,
    prompt_tokens: u64,
    completion_tokens: u64,
) -> std::io::Result<()> {
    let fin = json!({
        "id": id,
        "object": "chat.completion.chunk",
        "choices": [{ "index": 0, "delta": {}, "finish_reason": finish_reason }],
        "usage": {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": prompt_tokens + completion_tokens,
        }
    });
    stream
        .write_all(format!("data: {delta}\n\ndata: {fin}\n\ndata: [DONE]\n\n").as_bytes())
        .await?;
    stream.flush().await
}

fn write_fake_harbor_cli(
    dir: &Path,
    guest_result: Option<&Path>,
    transcript: Option<&Path>,
    trial_result_json: &Value,
    exit_code: i32,
) -> PathBuf {
    let state_path = dir.join("harbor-stub-spec.json");
    std::fs::write(
        &state_path,
        serde_json::to_vec(&json!({
            "guestResult": guest_result,
            "transcript": transcript,
            "trialResult": trial_result_json,
            "exitCode": exit_code,
        }))
        .unwrap(),
    )
    .unwrap();

    let mjs_path = dir.join("fake-harbor.mjs");
    let script = format!(
        r#"#!/usr/bin/env node
import {{ copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync }} from "node:fs";
import {{ delimiter, join }} from "node:path";
if (process.argv[2] !== "run" || process.argv[3] !== "-c") process.exit(2);
const cfg = JSON.parse(readFileSync(process.argv[4], "utf8"));
if (cfg.retry?.max_retries !== 0 || cfg.n_attempts !== 1) process.exit(2);
const mount = cfg.environment?.mounts?.[0];
if (mount?.target !== "/opt/maka-agent" || mount?.read_only !== true) process.exit(2);
const pyDirs = (process.env.PYTHONPATH ?? "").split(delimiter).filter(Boolean);
if (!pyDirs.some((d) => existsSync(join(d, "maka_host_agent.py")))) process.exit(2);
const spec = JSON.parse(readFileSync({}, "utf8"));
const trialDir = join(cfg.jobs_dir, cfg.job_name, "trial-0");
const makaDir = join(trialDir, "agent", "maka");
mkdirSync(makaDir, {{ recursive: true }});
if (spec.guestResult) copyFileSync(spec.guestResult, join(makaDir, "guest-result.json"));
if (spec.transcript) copyFileSync(spec.transcript, join(makaDir, "transcript.json"));
writeFileSync(join(trialDir, "result.json"), JSON.stringify(spec.trialResult) + "\n");
process.exit(spec.exitCode);
"#,
        serde_json::to_string(&state_path).unwrap()
    );
    std::fs::write(&mjs_path, script).unwrap();

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&mjs_path, std::fs::Permissions::from_mode(0o755)).unwrap();
        mjs_path
    }
    #[cfg(windows)]
    {
        let cmd_path = dir.join("fake-harbor.cmd");
        std::fs::write(&cmd_path, "@node \"%~dp0fake-harbor.mjs\" %*\r\n").unwrap();
        cmd_path
    }
}

#[test]
fn guest_run_unlinks_secret_request_and_records_infra_failure() {
    let env = IsolatedEnv::new(false);

    let (out, req, res, _) = env.run_guest_raw(br#"{"apiKey":"sk-top-secret","unknown":1}"#);
    assert!(!out.status.success());
    assert!(!req.exists(), "secret request file must be deleted");
    let parsed: Value = serde_json::from_str(&std::fs::read_to_string(&res).unwrap()).unwrap();
    assert_eq!(parsed["status"], "infraFailed");
    assert!(
        parsed["infraError"]
            .as_str()
            .unwrap()
            .contains("invalid guest request JSON")
    );

    let zero_steps = serde_json::to_vec(&json!({
        "instruction": "noop",
        "workspaceDir": env.workspace,
        "artifactsDir": env.tmp.join("unused"),
        "apiKey": "sk-top-secret-2",
        "provider": "deepseek",
        "modelId": "deepseek-chat",
        "sandboxMode": "danger-full-access",
        "maxSteps": 0,
        "timeoutMs": 5000,
    }))
    .unwrap();
    let (out2, req2, res2, _) = env.run_guest_raw(&zero_steps);
    assert!(!out2.status.success());
    assert!(!req2.exists());
    let parsed2: Value = serde_json::from_str(&std::fs::read_to_string(&res2).unwrap()).unwrap();
    assert_eq!(parsed2["status"], "infraFailed");
    assert!(env.host_run_dirs().is_empty());
}

#[tokio::test]
async fn guest_run_completed_accounts_delegated_subagents_retries_429_and_keeps_host_alive() {
    let env = IsolatedEnv::new(true);
    let base_url = start_mock_provider(MockMode::Retry429AndDelegateSubagent {
        workspace_path: env.workspace.to_string_lossy().into_owned(),
    })
    .await;

    let (guest_json, res_path, transcript_path) = env.run_guest_live(&base_url, 5).await;
    assert_eq!(guest_json["status"], "completed");
    assert_eq!(guest_json["evidence"]["stepsObserved"], 2);

    let models = &guest_json["evidence"]["hostUsage"]["summary"]["models"];
    assert_eq!(models["calls"], 4);
    assert_eq!(models["success"], 3);
    assert_eq!(models["error"], 1);
    assert_eq!(models["input"]["known"], 750);
    assert_eq!(models["output"]["known"], 150);
    assert_eq!(models["input"]["missing"], 1);
    assert!(
        std::fs::read_to_string(&transcript_path)
            .unwrap()
            .contains("DELEGATION_COMPLETE:")
    );

    assert_eq!(env.host_run_dirs().len(), 1);
    assert_eq!(env.retire_live_hosts().await, 1);

    let (run_out, summary_path) = env.run_harbor(
        Some(&res_path),
        Some(&transcript_path),
        &json!({ "verifier_result": { "rewards": { "reward": 0.0 } }, "exception_info": Value::Null }),
        0,
    );
    assert!(
        run_out.status.success(),
        "{}",
        String::from_utf8_lossy(&run_out.stderr)
    );
    let summary: Value =
        serde_json::from_str(&std::fs::read_to_string(&summary_path).unwrap()).unwrap();
    assert_eq!(summary["reward"], 0.0);
    assert_eq!(summary["guest"]["status"], "completed");
    assert_eq!(summary["guest"]["usage"]["models"]["input"]["known"], 750);
}

#[tokio::test]
async fn guest_run_max_steps_stops_in_flight_stream_retires_host_and_passes_validation() {
    let env = IsolatedEnv::new(true);
    let base_url = start_mock_provider(MockMode::MaxStepsSlowSecondTurn).await;

    let (guest_json, res_path, transcript_path) = env.run_guest_live(&base_url, 1).await;
    assert_eq!(guest_json["status"], "subjectStopped");
    assert!(
        guest_json["stopReason"]
            .as_str()
            .unwrap()
            .contains("exceeded maxSteps (1)")
    );
    assert_eq!(guest_json["evidence"]["stepsObserved"], 1);
    assert_eq!(
        guest_json["evidence"]["hostUsage"]["summary"]["models"]["input"]["known"],
        80
    );
    assert!(env.host_run_dirs().is_empty());
    assert_eq!(env.retire_live_hosts().await, 0);

    let (run_out, _) = env.run_harbor(
        Some(&res_path),
        Some(&transcript_path),
        &json!({ "verifier_result": { "rewards": { "reward": 0.0 } }, "exception_info": Value::Null }),
        0,
    );
    assert!(
        run_out.status.success(),
        "{}",
        String::from_utf8_lossy(&run_out.stderr)
    );

    let mut missing_usage = guest_json;
    missing_usage["evidence"]["hostUsageAttempts"]["attempts"][0]["attempt"]["usage"]["output_tokens"] =
        Value::Null;
    let partial_guest_path = env.tmp.join("partial-guest-result.json");
    std::fs::write(
        &partial_guest_path,
        serde_json::to_vec(&missing_usage).unwrap(),
    )
    .unwrap();
    let (partial_out, partial_summary) = env.run_harbor(
        Some(&partial_guest_path),
        Some(&transcript_path),
        &json!({ "verifier_result": { "rewards": { "reward": 1.0 } }, "exception_info": Value::Null }),
        0,
    );
    assert!(!partial_out.status.success());
    assert!(
        String::from_utf8_lossy(&partial_out.stderr)
            .contains("incomplete token usage on successful model call(s)")
    );
    assert!(partial_summary.is_file());
}

#[test]
fn run_command_persists_summary_and_surfaces_root_cause_on_infra_failure() {
    let env = IsolatedEnv::new(false);
    let infra_guest_path = env.tmp.join("infra-guest-result.json");
    std::fs::write(
        &infra_guest_path,
        serde_json::to_vec(&json!({
            "status": "infraFailed",
            "infraError": "maka host serve exited before printing ready line",
        }))
        .unwrap(),
    )
    .unwrap();

    let (run_out, summary_path) = env.run_harbor(
        Some(&infra_guest_path),
        None,
        &json!({
            "verifier_result": Value::Null,
            "exception_info": { "exception_type": "RuntimeError", "message": "guest-run exited with 1" },
        }),
        1,
    );
    assert!(!run_out.status.success());
    assert!(String::from_utf8_lossy(&run_out.stderr).contains(
        "guest infrastructure failed: maka host serve exited before printing ready line"
    ));
    assert!(summary_path.is_file());
    let summary: Value =
        serde_json::from_str(&std::fs::read_to_string(&summary_path).unwrap()).unwrap();
    assert_eq!(summary["guest"]["status"], "infraFailed");
    assert_eq!(
        summary["exceptionInfo"]["exception_type"],
        json!("RuntimeError")
    );
}
