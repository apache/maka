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
        std::fs::write(workspace.join("task.toml"), "[task]\nname = \"ws\"\n")
            .expect("write task.toml");

        let eval_bin = eval_bin_path();
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
        let step = static_step(
            guest_result.map(|p| std::fs::read_to_string(p).unwrap()),
            transcript.is_some(),
            Some(trial_result_json.clone()),
            exit_code,
        );
        let (fake_harbor, _) = write_harbor_driver(
            &self.tmp.join(format!("harbor-stub-{id}")),
            &json!({ "single": [step] }),
        );
        let out_dir = self.tmp.join(format!("run-out-{id}"));
        let out = self.run_with_harbor(&fake_harbor, &out_dir, &[]);
        (out, out_dir.join("run-summary.json"))
    }

    fn run_with_harbor(&self, harbor_bin: &Path, out_dir: &Path, extra_args: &[&str]) -> Output {
        self.eval_command()
            .env("EVAL_API_KEY", "sk-eval-key")
            .args(["run", "--task"])
            .arg(&self.workspace)
            .arg("--bundle-dir")
            .arg(&self.bundle)
            .arg("--out")
            .arg(out_dir)
            .arg("--harbor-bin")
            .arg(harbor_bin)
            .args([
                "--api-key-env",
                "EVAL_API_KEY",
                "--provider",
                "deepseek",
                "--model",
                "deepseek-chat",
            ])
            .args(extra_args)
            .output()
            .expect("run maka-eval run")
    }

    fn batch_command(&self, api_key: &str, spec_path: &Path, out_dir: &Path) -> StdCommand {
        let mut cmd = self.eval_command();
        cmd.env("EVAL_API_KEY", api_key)
            .args(["batch", "--spec"])
            .arg(spec_path)
            .arg("--out")
            .arg(out_dir);
        cmd
    }

    async fn run_batch(&self, api_key: &str, spec_path: &Path, out_dir: &Path) -> Output {
        let mut cmd = self.batch_command(api_key, spec_path, out_dir);
        tokio::task::spawn_blocking(move || cmd.output().expect("spawn maka-eval batch"))
            .await
            .unwrap()
    }

    fn run_batch_sync(&self, api_key: &str, spec_path: &Path, out_dir: &Path) -> Output {
        self.batch_command(api_key, spec_path, out_dir)
            .output()
            .expect("run maka-eval batch")
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
        if !run_dirs.is_empty() {
            let _ = std::thread::spawn(move || {
                if let Ok(rt) = tokio::runtime::Builder::new_current_thread()
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
            })
            .join();
        }
    }
}

fn eval_bin_path() -> PathBuf {
    std::env::var_os("CARGO_BIN_EXE_maka-eval")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_BIN_EXE_maka-eval")))
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
    if std::fs::hard_link(src, dst).is_ok() {
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
    let eval_bin = eval_bin_path();
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
    SingleTurnClean { cached_tokens: Option<u64> },
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
                    await tools.SessionSend({{ sessionId: cid, message: "DELEGATED_CHILD_PROMPT", onComplete: "none" }});
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
                    Some(20),
                )
                .await?;
            } else if msgs.contains("DELEGATED_CHILD_PROMPT")
                && !msgs.contains("DELEGATION_COMPLETE:")
            {
                write_sse_text(&mut stream, "CHILD_DONE_TOKEN", 500, 100, Some(20)).await?;
            } else {
                write_sse_text(&mut stream, "Parent task completed.", 150, 30, Some(20)).await?;
            }
        }
        MockMode::MaxStepsSlowSecondTurn => {
            if !req["messages"].to_string().contains("step-1-ok") {
                write_sse_tool_call(
                    &mut stream,
                    "call_step1",
                    "exec",
                    &json!({ "code": "text('step-1-ok');" }),
                    80,
                    20,
                    Some(20),
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
        MockMode::SingleTurnClean { cached_tokens } => {
            write_sse_text(&mut stream, "Clean completion.", 100, 20, *cached_tokens).await?;
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
    cached_tokens: Option<u64>,
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
        cached_tokens,
    )
    .await
}

async fn write_sse_text(
    stream: &mut TcpStream,
    content: &str,
    prompt_tokens: u64,
    completion_tokens: u64,
    cached_tokens: Option<u64>,
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
        cached_tokens,
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
    cached_tokens: Option<u64>,
) -> std::io::Result<()> {
    let mut usage = json!({
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "total_tokens": prompt_tokens + completion_tokens,
    });
    if let Some(cached) = cached_tokens {
        usage["prompt_tokens_details"] = json!({ "cached_tokens": cached });
    }
    let fin = json!({
        "id": id,
        "object": "chat.completion.chunk",
        "choices": [{ "index": 0, "delta": {}, "finish_reason": finish_reason }],
        "usage": usage,
    });
    stream
        .write_all(format!("data: {delta}\n\ndata: {fin}\n\ndata: [DONE]\n\n").as_bytes())
        .await?;
    stream.flush().await
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
    assert!(
        (summary["guest"]["usage"]["models"]["cost"]["knownUsd"]
            .as_f64()
            .unwrap()
            - 0.0003555)
            .abs()
            < 1e-12
    );
    assert_eq!(summary["guest"]["metering"], "lower_bound");
    assert_eq!(summary["guest"]["costUsd"], Value::Null);
    assert!(summary["guest"].get("meteringError").is_none());

    let clean_url = start_mock_provider(MockMode::SingleTurnClean {
        cached_tokens: Some(20),
    })
    .await;
    let (_, clean_res_path, clean_transcript_path) = env.run_guest_live(&clean_url, 2).await;
    assert_eq!(env.retire_live_hosts().await, 1);

    let (clean_out, clean_summary_path) = env.run_harbor(
        Some(&clean_res_path),
        Some(&clean_transcript_path),
        &json!({ "verifier_result": { "rewards": { "reward": 1.0 } }, "exception_info": Value::Null }),
        0,
    );
    assert!(
        clean_out.status.success(),
        "{}",
        String::from_utf8_lossy(&clean_out.stderr)
    );
    let clean_summary: Value =
        serde_json::from_str(&std::fs::read_to_string(&clean_summary_path).unwrap()).unwrap();
    assert_eq!(clean_summary["reward"], 1.0);
    assert_eq!(clean_summary["guest"]["metering"], "complete");
    assert!((clean_summary["guest"]["costUsd"].as_f64().unwrap() - 0.000045).abs() < 1e-12);

    let no_cache_url = start_mock_provider(MockMode::SingleTurnClean {
        cached_tokens: None,
    })
    .await;
    let (_, no_cache_res_path, no_cache_transcript_path) =
        env.run_guest_live(&no_cache_url, 2).await;
    assert_eq!(env.retire_live_hosts().await, 1);

    let (no_cache_out, no_cache_summary_path) = env.run_harbor(
        Some(&no_cache_res_path),
        Some(&no_cache_transcript_path),
        &json!({ "verifier_result": { "rewards": { "reward": 1.0 } }, "exception_info": Value::Null }),
        0,
    );
    assert!(
        no_cache_out.status.success(),
        "{}",
        String::from_utf8_lossy(&no_cache_out.stderr)
    );
    let no_cache_summary: Value =
        serde_json::from_str(&std::fs::read_to_string(&no_cache_summary_path).unwrap()).unwrap();
    assert_eq!(no_cache_summary["reward"], 1.0);
    assert_eq!(
        no_cache_summary["guest"]["usage"]["models"]["cacheRead"]["missing"],
        1
    );
    assert_eq!(
        no_cache_summary["guest"]["usage"]["models"]["cost"]["unvalued"],
        1
    );
    assert_eq!(no_cache_summary["guest"]["metering"], "lower_bound");
    assert_eq!(no_cache_summary["guest"]["costUsd"], Value::Null);
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

    let (run_out, stopped_summary_path) = env.run_harbor(
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
    let stopped_summary: Value =
        serde_json::from_str(&std::fs::read_to_string(&stopped_summary_path).unwrap()).unwrap();
    assert_eq!(stopped_summary["reward"], 0.0);
    assert_eq!(stopped_summary["guest"]["status"], "subjectStopped");
    assert_eq!(stopped_summary["guest"]["metering"], "lower_bound");
    assert_eq!(stopped_summary["guest"]["costUsd"], Value::Null);
    assert!(stopped_summary["guest"].get("meteringError").is_none());

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
    let partial_summary_json: Value =
        serde_json::from_str(&std::fs::read_to_string(&partial_summary).unwrap()).unwrap();
    assert_eq!(partial_summary_json["reward"], 1.0);
    assert_eq!(partial_summary_json["guest"]["status"], "subjectStopped");
    assert!(partial_summary_json["guest"].get("metering").is_none());
    assert!(partial_summary_json["guest"].get("costUsd").is_none());
    assert!(
        partial_summary_json["guest"]["meteringError"]
            .as_str()
            .unwrap()
            .contains("incomplete token usage on successful model call(s)")
    );
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
    let stderr = String::from_utf8_lossy(&run_out.stderr);
    assert!(
        stderr.contains(
            "guest infrastructure failed: maka host serve exited before printing ready line"
        ),
        "status={:?}, stderr={stderr}",
        run_out.status
    );
    assert!(summary_path.is_file());
    let summary: Value =
        serde_json::from_str(&std::fs::read_to_string(&summary_path).unwrap()).unwrap();
    assert_eq!(summary["guest"]["status"], "infraFailed");
    assert!(summary["guest"].get("usage").is_none());
    assert!(summary["guest"].get("metering").is_none());
    assert!(summary["guest"].get("meteringError").is_none());
    assert_eq!(
        summary["exceptionInfo"]["exception_type"],
        json!("RuntimeError")
    );
}

fn read_json(path: &Path) -> Value {
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn line_count(path: &Path) -> usize {
    std::fs::read_to_string(path).unwrap().lines().count()
}

fn assert_ok(out: &Output) {
    assert!(
        out.status.success(),
        "status={:?}, stderr={}",
        out.status,
        String::from_utf8_lossy(&out.stderr)
    );
}

fn assert_fails_with(out: &Output, needle: &str) {
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(!out.status.success(), "unexpected success; stderr={stderr}");
    assert!(
        stderr.contains(needle),
        "expected {needle:?} in stderr; status={:?}, stderr={stderr}",
        out.status
    );
}

fn synthetic_evidence() -> Value {
    let z = json!({ "known": 0, "missing": 0 });
    let fence = json!({ "schemaVersion": 1, "stateDomain": "eval", "sequence": 1, "auxiliarySequence": 0, "cellSequence": 0, "queryDigest": "digest" });
    let attempt = json!({
        "kind": "model",
        "attempt": {
            "requestId": "req-1", "origin": { "kind": "auxiliary", "source": { "kind": "host_effect", "id": "11111111-1111-4111-8111-111111111111" } },
            "sessionId": Value::Null, "binding": Value::Null, "modelId": "deepseek-chat", "startedAt": 1.0, "completedAt": 2.0, "outcome": "success",
            "usage": { "input_tokens": 10, "output_tokens": 5, "cache_read_tokens": Value::Null, "cache_write_tokens": Value::Null, "reasoning_tokens": Value::Null },
            "quote": { "providerId": "ollama-cloud", "revision": 0, "pricing": Value::Null }, "costUsd": Value::Null,
        },
    });
    json!({
        "stepsObserved": 0,
        "execution": { "sessionId": "sess-1", "turnId": "turn-1", "runId": "11111111-1111-4111-8111-111111111111", "highWater": 1, "state": { "kind": "completed" } },
        "hostUsage": {
            "through": fence,
            "summary": {
                "models": { "calls": 1, "success": 1, "error": 0, "aborted": 0, "unknown": 0, "durationMs": 1.0, "input": { "known": 10, "missing": 0 }, "output": { "known": 5, "missing": 0 }, "cacheRead": z, "cacheWrite": z, "reasoning": z, "cost": { "knownUsd": 0.0, "unvalued": 1, "unpriced": 1 } },
                "tools": { "calls": 0, "success": 0, "error": 0, "unknown": 0, "rejected": 0, "durationMs": 0.0, "meanLatencyMs": Value::Null },
                "pending": { "models": 0, "tools": 0 }, "byProvider": [], "byModel": [], "byTool": [],
            },
            "nextCursor": Value::Null,
        },
        "hostUsageAttempts": { "through": fence, "attempts": [attempt], "total": 1, "nextCursor": Value::Null },
    })
}

fn static_step(
    guest_raw: Option<String>,
    transcript: bool,
    trial_res: Option<Value>,
    exit_code: i32,
) -> Value {
    json!({ "mode": "static", "guestRaw": guest_raw, "transcript": transcript, "trialResult": trial_res, "exitCode": exit_code })
}

fn live_step(reward: f64) -> Value {
    json!({ "mode": "live", "trialResult": { "verifier_result": { "rewards": { "reward": reward } }, "exception_info": Value::Null }, "exitCode": 0 })
}

fn ok_completed_step(reward: f64) -> Value {
    static_step(
        Some(json!({ "status": "completed", "evidence": synthetic_evidence() }).to_string()),
        true,
        Some(
            json!({ "verifier_result": { "rewards": { "reward": reward } }, "exception_info": Value::Null }),
        ),
        0,
    )
}

fn write_harbor_driver(dir: &Path, queues: &Value) -> (PathBuf, PathBuf) {
    std::fs::create_dir_all(dir).unwrap();
    let (queues_path, state_path, log_path) = (
        dir.join("harbor-queues.json"),
        dir.join("harbor-state.json"),
        dir.join("harbor-invocations.jsonl"),
    );
    std::fs::write(&queues_path, serde_json::to_vec_pretty(queues).unwrap()).unwrap();
    std::fs::write(&state_path, b"{}\n").unwrap();

    let mjs_path = dir.join("harbor-driver.mjs");
    let script = format!(
        r#"#!/usr/bin/env node
import {{ spawnSync }} from "node:child_process";
import {{ appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync }} from "node:fs";
import {{ basename, delimiter, dirname, join }} from "node:path";

if (process.argv[2] !== "run" || process.argv[3] !== "-c") process.exit(2);
const cfg = JSON.parse(readFileSync(process.argv[4], "utf8"));
if (cfg.retry?.max_retries !== 0 || cfg.n_attempts !== 1) process.exit(2);
const mount = cfg.environment?.mounts?.[0];
if (mount?.target !== "/opt/maka-agent" || mount?.read_only !== true) process.exit(2);
const pyDirs = (process.env.PYTHONPATH ?? "").split(delimiter).filter(Boolean);
if (!pyDirs.some((d) => existsSync(join(d, "maka_host_agent.py")))) process.exit(2);

const parentName = basename(dirname(cfg.jobs_dir));
const key = parentName.startsWith("cell-") ? parentName : "single";
const taskName = basename(cfg.tasks[0].path);
const kwargs = cfg.agents[0].kwargs;

const queues = JSON.parse(readFileSync({q}, "utf8"));
const state = JSON.parse(readFileSync({s}, "utf8"));
const idx = state[key] ?? 0;
state[key] = idx + 1;
writeFileSync({s}, JSON.stringify(state) + "\n");
appendFileSync({l}, JSON.stringify({{ key, taskName, modelId: kwargs.model_id, idx, verifierEnv: cfg.verifier?.env ?? null }}) + "\n");

const step = (queues[key] ?? [])[idx];
if (!step) {{
  process.stderr.write(`harbor-driver: unexpected invocation idx=${{idx}} for key=${{key}}\n`);
  process.exit(2);
}}

const trialDir = join(cfg.jobs_dir, cfg.job_name, "trial-0");
const makaDir = join(trialDir, "agent", "maka");
mkdirSync(makaDir, {{ recursive: true }});

if (step.mode === "static") {{
  if (step.guestRaw != null) writeFileSync(join(makaDir, "guest-result.json"), step.guestRaw);
  if (step.transcript) writeFileSync(join(makaDir, "transcript.json"), "{{}}\n");
  if (step.trialResult != null) writeFileSync(join(trialDir, "result.json"), JSON.stringify(step.trialResult) + "\n");
  process.exit(step.exitCode ?? 0);
}}

if (step.mode === "hang_orphan") {{
  writeFileSync(join(makaDir, "live-orphan-evidence.txt"), "started\n");
  writeFileSync(step.readyFile, "ready\n");
  const pauseBuf = new Int32Array(new SharedArrayBuffer(4));
  for (let i = 0; i < 3000 && !existsSync(step.releaseFile); i++) Atomics.wait(pauseBuf, 0, 0, 20);
  writeFileSync(join(makaDir, "orphan-still-alive.txt"), "survived\n");
  writeFileSync(step.doneFile, "done\n");
  process.exit(0);
}}

const reqPath = join(trialDir, "guest-request.json");
const resPath = join(makaDir, "guest-result.json");
writeFileSync(reqPath, JSON.stringify({{
  instruction: "Execute evaluation task.", workspaceDir: cfg.tasks[0].path, artifactsDir: makaDir,
  baseUrl: kwargs.endpoint_url ?? null, apiKey: process.env[kwargs.api_key_env] ?? "",
  provider: kwargs.provider, modelId: kwargs.model_id, sandboxMode: kwargs.sandbox_mode,
  maxSteps: kwargs.max_steps, timeoutMs: kwargs.timeout_ms,
}}), {{ mode: 0o600 }});

const evalBin = join(mount.source, "maka-eval" + (process.platform === "win32" ? ".exe" : ""));
const proc = spawnSync(evalBin, ["guest-run", "--request-file", reqPath, "--result-file", resPath], {{
  cwd: cfg.tasks[0].path, encoding: "utf8",
  env: {{ ...process.env, NO_PROXY: "localhost,127.0.0.1,::1,host.docker.internal", no_proxy: "localhost,127.0.0.1,::1,host.docker.internal" }},
}});
if (existsSync(reqPath)) process.exit(99);
if (proc.status !== 0) {{
  writeFileSync(join(trialDir, "result.json"), JSON.stringify({{
    verifier_result: null,
    exception_info: {{ exception_type: "RuntimeError", message: `maka-eval guest-run exited with ${{proc.status}}: ${{proc.stderr || proc.stdout}}` }},
  }}) + "\n");
  process.exit(1);
}}
writeFileSync(join(trialDir, "result.json"), JSON.stringify(step.trialResult) + "\n");
process.exit(step.exitCode ?? 0);
"#,
        q = serde_json::to_string(&queues_path).unwrap(),
        s = serde_json::to_string(&state_path).unwrap(),
        l = serde_json::to_string(&log_path).unwrap(),
    );
    std::fs::write(&mjs_path, script).unwrap();

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&mjs_path, std::fs::Permissions::from_mode(0o755)).unwrap();
        (mjs_path, log_path)
    }
    #[cfg(windows)]
    {
        let cmd_path = dir.join("harbor-driver.cmd");
        std::fs::write(&cmd_path, "@node \"%~dp0harbor-driver.mjs\" %*\r\n").unwrap();
        (cmd_path, log_path)
    }
}

fn create_task_dir(root: &Path, name: &str) -> PathBuf {
    let dir = root.join(name);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("task.toml"),
        format!("[task]\nname = \"{name}\"\n"),
    )
    .unwrap();
    dir
}

fn subject_spec(id: &str, model_id: &str, base_url: String) -> Value {
    json!({ "id": id, "provider": "deepseek", "modelId": model_id, "baseUrl": base_url, "apiKeyEnv": "EVAL_API_KEY" })
}

fn write_batch_spec(
    path: &Path,
    bundle_dir: &Path,
    harbor_bin: &Path,
    (repetitions, max_steps): (u32, u32),
    verifier_env: Option<Value>,
    subjects: Vec<Value>,
    tasks: &[&Path],
) {
    let mut spec = json!({
        "bundleDir": bundle_dir, "harborBin": harbor_bin,
        "repetitions": repetitions, "maxSteps": max_steps,
        "subjects": subjects, "tasks": tasks,
    });
    if let Some(env) = verifier_env {
        spec["verifierEnv"] = env;
    }
    std::fs::write(path, serde_json::to_vec_pretty(&spec).unwrap()).unwrap();
}

#[test]
fn run_cli_forwards_verifier_env_and_rejects_duplicate_keys() {
    let env = IsolatedEnv::new(false);
    let (harbor_bin, log_path) = write_harbor_driver(
        &env.tmp.join("verifier-env-harbor"),
        &json!({ "single": [ok_completed_step(1.0)] }),
    );

    let ok_out = env.tmp.join("verifier-env-ok");
    assert_ok(&env.run_with_harbor(
        &harbor_bin,
        &ok_out,
        &["--verifier-env", "FOO=bar", "--verifier-env", "EMPTY="],
    ));
    let captured = read_json(&log_path);
    assert_eq!(
        captured["verifierEnv"],
        json!({ "FOO": "bar", "EMPTY": "" })
    );
    let summary = read_json(&ok_out.join("run-summary.json"));
    assert_eq!(summary["guest"]["metering"], "complete");
    assert_eq!(summary["guest"]["costUsd"], Value::Null);

    let dup_out = env.tmp.join("verifier-env-dup");
    assert_fails_with(
        &env.run_with_harbor(
            &harbor_bin,
            &dup_out,
            &["--verifier-env", "FOO=1", "--verifier-env", "FOO=2"],
        ),
        "duplicate --verifier-env key 'FOO'",
    );
    assert!(!dup_out.exists());
}

#[tokio::test]
async fn batch_cli_runs_live_matrix_guards_lock_freeze_and_resumes() {
    let env = IsolatedEnv::new(true);
    let clean_url = start_mock_provider(MockMode::SingleTurnClean {
        cached_tokens: Some(20),
    })
    .await;
    let max_steps_url = start_mock_provider(MockMode::MaxStepsSlowSecondTurn).await;
    let task_one = create_task_dir(&env.tmp, "task-one");
    let alt_task_one = create_task_dir(&env.tmp.join("alt"), "task-one");
    let task_two = create_task_dir(&env.tmp, "task-two");
    let (orphan_ready, orphan_release, orphan_done) = (
        env.tmp.join("orphan-ready"),
        env.tmp.join("orphan-release"),
        env.tmp.join("orphan-done"),
    );
    let queues = json!({
        "cell-0": [live_step(1.0)],
        "cell-1": [live_step(0.5)],
        "cell-2": [{ "mode": "hang_orphan", "readyFile": orphan_ready, "releaseFile": orphan_release, "doneFile": orphan_done }],
        "cell-3": [live_step(0.0)],
    });
    let (harbor_bin, log_path) = write_harbor_driver(&env.tmp.join("batch-harbor"), &queues);

    let spec_path = env.tmp.join("batch-spec.json");
    let out_dir = env.tmp.join("batch-out");
    let subjects = vec![
        subject_spec("sub-a", "deepseek-chat", clean_url),
        subject_spec("sub-b", "deepseek-chat", max_steps_url),
    ];
    let verifier_env = Some(json!({ "UV_INDEX_URL": "https://pypi.tuna.tsinghua.edu.cn/simple" }));
    write_batch_spec(
        &spec_path,
        &env.bundle,
        &harbor_bin,
        (1, 1),
        verifier_env.clone(),
        subjects.clone(),
        &[task_one.as_path(), task_two.as_path()],
    );

    let mut cmd =
        tokio::process::Command::from(env.batch_command("sk-batch-key", &spec_path, &out_dir));
    cmd.kill_on_drop(true);
    let mut child = cmd.spawn().expect("spawn batch 1");

    let deadline = tokio::time::Instant::now() + Duration::from_secs(90);
    while !orphan_ready.is_file() {
        assert!(
            child.try_wait().unwrap().is_none(),
            "batch 1 exited before cell-2"
        );
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for cell-2"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(!orphan_done.is_file());

    // Real concurrent batch CLI process against the same --out must fail on the lock without touching harbor.
    assert_fails_with(
        &env.run_batch("sk-batch-key", &spec_path, &out_dir).await,
        "locked by another maka-eval batch process",
    );
    assert_eq!(line_count(&log_path), 3);

    child.kill().await.expect("kill batch 1");
    let _ = child.wait().await;
    assert_fails_with(
        &env.run_batch("sk-batch-key", &spec_path, &out_dir).await,
        "batch finished with 1 failed cell(s)",
    );
    assert_eq!(line_count(&log_path), 4);
    assert!(
        !orphan_done.is_file(),
        "orphaned harbor child should still be alive"
    );
    let orphan_maka_dir = out_dir
        .join("trials/cell-2/harbor-jobs")
        .read_dir()
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path()
        .join("trial-0/agent/maka");
    assert!(orphan_maka_dir.join("live-orphan-evidence.txt").is_file());

    std::fs::write(&orphan_release, b"release\n").unwrap();
    let done_deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while !orphan_done.is_file() {
        assert!(
            tokio::time::Instant::now() < done_deadline,
            "timed out waiting for orphan"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(orphan_maka_dir.join("orphan-still-alive.txt").is_file());

    let invocations: Vec<Value> = std::fs::read_to_string(&log_path)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert_eq!(invocations.len(), 4);
    assert_eq!(
        invocations[0]["verifierEnv"]["UV_INDEX_URL"],
        "https://pypi.tuna.tsinghua.edu.cn/simple"
    );

    let summary = read_json(&out_dir.join("summary.json"));
    assert_eq!(
        (
            &summary["completed"],
            &summary["subjectFailed"],
            &summary["failed"]
        ),
        (&json!(1), &json!(2), &json!(1))
    );
    assert!((summary["cells"][0]["costUsd"].as_f64().unwrap() - 0.000045).abs() < 1e-12);
    assert_eq!(summary["cells"][1]["metering"], "lower_bound");
    assert_eq!(summary["cells"][1]["status"], "subject_failed");
    assert_eq!(summary["cells"][2]["status"], "failed");
    assert_eq!(summary["cells"][2]["summaryPath"], Value::Null);
    assert_eq!(summary["cells"][2]["durationMs"], Value::Null);
    assert!(
        summary["cells"][2]["failureReason"]
            .as_str()
            .unwrap()
            .contains("interrupted before settlement")
    );
    assert_eq!(summary["cells"][3]["status"], "subject_failed");

    let mut_spec = env.tmp.join("mut-spec.json");
    write_batch_spec(
        &mut_spec,
        &env.bundle,
        &harbor_bin,
        (2, 1),
        verifier_env.clone(),
        subjects.clone(),
        &[task_one.as_path(), task_two.as_path()],
    );
    assert_fails_with(
        &env.run_batch("sk-batch-key", &mut_spec, &out_dir).await,
        "experiment spec mismatch",
    );
    write_batch_spec(
        &mut_spec,
        &env.bundle,
        &harbor_bin,
        (1, 1),
        verifier_env,
        subjects,
        &[alt_task_one.as_path(), task_two.as_path()],
    );
    assert_fails_with(
        &env.run_batch("sk-batch-key", &mut_spec, &out_dir).await,
        "experiment spec mismatch",
    );

    let results_path = out_dir.join("results.jsonl");
    let before_resume = std::fs::read(&results_path).unwrap();
    assert_fails_with(
        &env.run_batch("sk-batch-key", &spec_path, &out_dir).await,
        "batch finished with 1 failed cell(s)",
    );
    assert_eq!(std::fs::read(&results_path).unwrap(), before_resume);
    assert_eq!(line_count(&log_path), 4);
    let _ = env.retire_live_hosts().await;
}

#[test]
fn batch_cli_isolates_case_colliding_subjects_and_continues_after_cell_failure() {
    let env = IsolatedEnv::new(false);
    let dummy_url = "http://127.0.0.1:1/v1".to_owned();

    let (case_harbor, case_log) = write_harbor_driver(
        &env.tmp.join("case-harbor"),
        &json!({ "cell-0": [ok_completed_step(0.25)], "cell-1": [ok_completed_step(0.75)] }),
    );
    let (case_spec, case_out) = (env.tmp.join("case-spec.json"), env.tmp.join("case-out"));
    write_batch_spec(
        &case_spec,
        &env.bundle,
        &case_harbor,
        (1, 2),
        None,
        vec![
            subject_spec("same", "deepseek-chat", dummy_url.clone()),
            subject_spec("Same", "deepseek-chat", dummy_url.clone()),
        ],
        &[env.workspace.as_path()],
    );
    assert_ok(&env.run_batch_sync("sk-case", &case_spec, &case_out));
    let case_summary = read_json(&case_out.join("summary.json"));
    assert_eq!(case_summary["completed"], 2);
    let (p0, p1) = (
        PathBuf::from(case_summary["cells"][0]["summaryPath"].as_str().unwrap()),
        PathBuf::from(case_summary["cells"][1]["summaryPath"].as_str().unwrap()),
    );
    assert_ne!(p0, p1);
    assert_eq!(
        (
            read_json(&p0)["reward"].as_f64(),
            read_json(&p1)["reward"].as_f64()
        ),
        (Some(0.25), Some(0.75))
    );
    assert_ok(&env.run_batch_sync("sk-case", &case_spec, &case_out));
    assert_eq!(line_count(&case_log), 2);

    let (fail_harbor, fail_log) = write_harbor_driver(
        &env.tmp.join("fail-harbor"),
        &json!({ "cell-0": [static_step(None, false, None, 1)], "cell-1": [ok_completed_step(1.0)] }),
    );
    let (fail_spec, fail_out) = (env.tmp.join("fail-spec.json"), env.tmp.join("fail-out"));
    write_batch_spec(
        &fail_spec,
        &env.bundle,
        &fail_harbor,
        (1, 2),
        None,
        vec![
            subject_spec("sub-fail", "deepseek-chat", dummy_url.clone()),
            subject_spec("sub-ok", "deepseek-chat", dummy_url),
        ],
        &[env.workspace.as_path()],
    );
    assert_fails_with(
        &env.run_batch_sync("sk-fail", &fail_spec, &fail_out),
        "batch finished with 1 failed cell(s)",
    );
    assert_eq!(line_count(&fail_log), 2);

    let fail_summary = read_json(&fail_out.join("summary.json"));
    assert_eq!(
        (
            &fail_summary["completed"],
            &fail_summary["subjectFailed"],
            &fail_summary["failed"]
        ),
        (&json!(1), &json!(0), &json!(1))
    );
    let cells = fail_summary["cells"].as_array().unwrap();
    assert_eq!(cells[0]["status"], "failed");
    assert_eq!(cells[1]["status"], "completed");
    assert!(Path::new(cells[0]["summaryPath"].as_str().unwrap()).is_file());
    assert!(Path::new(cells[1]["summaryPath"].as_str().unwrap()).is_file());

    assert_fails_with(
        &env.run_batch_sync("sk-fail", &fail_spec, &fail_out),
        "batch finished with 1 failed cell(s)",
    );
    assert_eq!(line_count(&fail_log), 2);

    let dirty_out = env.tmp.join("dirty-out");
    std::fs::create_dir_all(dirty_out.join("trials/cell-0")).unwrap();
    std::fs::write(dirty_out.join("trials/cell-0/stale.txt"), b"leftover").unwrap();
    let dirty = env.run_batch_sync("sk-fail", &fail_spec, &dirty_out);
    assert_fails_with(&dirty, "refusing to overwrite non-empty cell dir");
    assert_fails_with(&dirty, "ws::1::sub-fail");
    assert_eq!(line_count(&fail_log), 2);
}
