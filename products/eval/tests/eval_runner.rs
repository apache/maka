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
    task_dir: PathBuf,
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
        let bundle = base.join("bundle");
        let empty_cwd = base.join("cwd");
        for dir in [&home, &tmp, &bundle, &empty_cwd] {
            std::fs::create_dir_all(dir).expect("create isolated subdir");
        }
        let task_dir = create_task_dir(&base, "default-task");

        stage_executable(&eval_bin_path(), &bundle, "maka-eval");
        if link_real_host {
            stage_executable(&find_helper_binary("maka"), &bundle, "maka");
            stage_executable(
                &find_helper_binary("maka-python-worker"),
                &bundle,
                "maka-python-worker",
            );
        } else {
            for stub in ["maka", "maka-python-worker"] {
                std::fs::write(bundle.join(stub), b"").expect("write placeholder");
                #[cfg(windows)]
                std::fs::write(bundle.join(format!("{stub}.exe")), b"").expect("write placeholder");
            }
        }

        Self {
            _root: root,
            home,
            tmp,
            task_dir,
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

    async fn run_cli(
        &self,
        provider: &str,
        model_id: &str,
        base_url: Option<&str>,
        max_steps: u32,
        driver_step: &Value,
    ) -> (Output, PathBuf) {
        let id = self.seq.fetch_add(1, Ordering::SeqCst);
        let stub_dir = self.tmp.join(format!("harbor-run-{id}"));
        std::fs::create_dir_all(&stub_dir).unwrap();
        let (harbor_bin, _) = write_harbor_driver(&stub_dir, &json!({ "single": [driver_step] }));
        let out_dir = self.tmp.join(format!("run-out-{id}"));

        let mut cmd = self.eval_command();
        cmd.env("EVAL_API_KEY", "sk-eval-key")
            .args(["run", "--task"])
            .arg(&self.task_dir)
            .arg("--bundle-dir")
            .arg(&self.bundle)
            .arg("--out")
            .arg(&out_dir)
            .arg("--harbor-bin")
            .arg(&harbor_bin)
            .args([
                "--api-key-env",
                "EVAL_API_KEY",
                "--provider",
                provider,
                "--model",
                model_id,
                "--max-steps",
            ])
            .arg(max_steps.to_string());
        if let Some(url) = base_url {
            cmd.arg("--base-url").arg(url);
        }

        let out = tokio::task::spawn_blocking(move || cmd.output().expect("spawn maka-eval run"))
            .await
            .unwrap();
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

fn find_git_repo_root() -> Option<PathBuf> {
    for start in [std::env::current_dir().ok(), Some(eval_bin_path())]
        .into_iter()
        .flatten()
    {
        for ancestor in start.ancestors() {
            if ancestor.join(".git").exists() {
                return Some(ancestor.to_path_buf());
            }
        }
    }
    None
}

fn worktree_common_target_dir() -> Option<PathBuf> {
    let repo_root = find_git_repo_root()?;
    let dot_git = std::fs::read_to_string(repo_root.join(".git")).ok()?;
    let gitdir = Path::new(dot_git.strip_prefix("gitdir:")?.trim());
    Some(gitdir.parent()?.parent()?.parent()?.join("target"))
}

struct MockState {
    delegate_workspace: PathBuf,
    retry_delegate_calls: AtomicUsize,
}

async fn start_mock_provider(delegate_workspace: &Path) -> String {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind loopback");
    let addr = listener.local_addr().expect("local addr");
    let state = Arc::new(MockState {
        delegate_workspace: delegate_workspace.to_path_buf(),
        retry_delegate_calls: AtomicUsize::new(0),
    });
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let state = Arc::clone(&state);
            tokio::spawn(async move {
                let _ = handle_http(stream, state).await;
            });
        }
    });
    format!("http://{addr}")
}

async fn handle_http(stream: TcpStream, state: Arc<MockState>) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream);
    let mut request_line = String::new();
    if reader.read_line(&mut request_line).await? == 0 {
        return Ok(());
    }
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let path = parts.next().unwrap_or("/");
    let is_get = method == "GET";

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
        let payload = br#"{"data":[{"id":"deepseek-chat"},{"id":"custom-unpriced"}]}"#;
        let header = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            payload.len()
        );
        stream.write_all(header.as_bytes()).await?;
        stream.write_all(payload).await?;
        return stream.flush().await;
    }

    let route = path.split("/v1/").next().unwrap_or("");
    let req: Value = serde_json::from_slice(&body_bytes).unwrap_or(Value::Null);

    if route == "/retry-delegate" {
        let call_idx = state.retry_delegate_calls.fetch_add(1, Ordering::SeqCst) + 1;
        if call_idx == 1 {
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
                serde_json::to_string(&state.delegate_workspace).unwrap()
            );
            write_sse_tool_call(
                &mut stream,
                "call_1",
                "exec",
                &json!({ "code": code }),
                Some((100, 20, Some(20))),
            )
            .await?;
        } else if msgs.contains("DELEGATED_CHILD_PROMPT") && !msgs.contains("DELEGATION_COMPLETE:")
        {
            write_sse_text(&mut stream, "CHILD_DONE_TOKEN", Some((500, 100, Some(20)))).await?;
        } else {
            write_sse_text(
                &mut stream,
                "Parent task completed.",
                Some((150, 30, Some(20))),
            )
            .await?;
        }
        return Ok(());
    }

    stream
        .write_all(
            b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n",
        )
        .await?;

    match route {
        "/clean" => {
            write_sse_text(&mut stream, "Clean completion.", Some((100, 20, Some(20)))).await?;
        }
        "/no-cache" => {
            write_sse_text(&mut stream, "Uncached completion.", Some((100, 20, None))).await?;
        }
        "/missing-usage" => {
            write_sse_text(&mut stream, "Completion missing usage.", None).await?;
        }
        "/max-steps" => {
            let msgs = req["messages"].to_string();
            if !msgs.contains("step-1-ok") {
                write_sse_tool_call(
                    &mut stream,
                    "call_step1",
                    "exec",
                    &json!({ "code": "text('step-1-ok');" }),
                    Some((80, 20, Some(20))),
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
                let mut eof = [0u8; 1];
                let _ = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut eof)).await;
            }
        }
        other => panic!("unexpected mock route: {other}"),
    }
    Ok(())
}

async fn write_sse_tool_call(
    stream: &mut TcpStream,
    call_id: &str,
    name: &str,
    args: &Value,
    usage: Option<(u64, u64, Option<u64>)>,
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
    write_sse_final(stream, "c_tool", &delta, "tool_calls", usage).await
}

async fn write_sse_text(
    stream: &mut TcpStream,
    content: &str,
    usage: Option<(u64, u64, Option<u64>)>,
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
    write_sse_final(stream, "c_txt", &delta, "stop", usage).await
}

async fn write_sse_final(
    stream: &mut TcpStream,
    id: &str,
    delta: &Value,
    finish_reason: &str,
    usage_spec: Option<(u64, u64, Option<u64>)>,
) -> std::io::Result<()> {
    let mut fin = json!({
        "id": id,
        "object": "chat.completion.chunk",
        "choices": [{ "index": 0, "delta": {}, "finish_reason": finish_reason }],
    });
    if let Some((prompt_tokens, completion_tokens, cached_tokens)) = usage_spec {
        let mut usage = json!({
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": prompt_tokens + completion_tokens,
        });
        if let Some(cached) = cached_tokens {
            usage["prompt_tokens_details"] = json!({ "cached_tokens": cached });
        }
        fin["usage"] = usage;
    }
    stream
        .write_all(format!("data: {delta}\n\ndata: {fin}\n\ndata: [DONE]\n\n").as_bytes())
        .await?;
    stream.flush().await
}

fn live_step(reward: f64) -> Value {
    json!({
        "mode": "live",
        "trialResult": {
            "verifier_result": { "rewards": { "reward": reward } },
            "exception_info": Value::Null,
        },
        "exitCode": 0,
    })
}

fn verifier_error_step(exception_type: &str) -> Value {
    json!({
        "mode": "live",
        "trialResult": {
            "verifier_result": Value::Null,
            "exception_info": {
                "exception_type": exception_type,
                "exception_message": format!("simulated {exception_type}"),
            },
        },
        "exitCode": 1,
    })
}

fn env_error_step(exception_type: &str, reward: Option<f64>) -> Value {
    let verifier_result = reward.map_or(Value::Null, |r| json!({ "rewards": { "reward": r } }));
    json!({
        "mode": "env_error",
        "trialResult": {
            "verifier_result": verifier_result,
            "exception_info": {
                "exception_type": exception_type,
                "exception_message": format!("simulated {exception_type}"),
            },
        },
        "exitCode": 1,
    })
}

fn write_harbor_driver(dir: &Path, queues: &Value) -> (PathBuf, PathBuf) {
    let queues_path = dir.join("harbor-queues.json");
    let state_path = dir.join("harbor-state.json");
    let log_path = dir.join("harbor-invocations.jsonl");
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
const key = parentName.startsWith("attempt-") ? basename(dirname(dirname(cfg.jobs_dir))) : "single";
const taskName = basename(cfg.tasks[0].path);
const kwargs = cfg.agents[0].kwargs;

const queues = JSON.parse(readFileSync({q}, "utf8"));
const state = JSON.parse(readFileSync({s}, "utf8"));
const idx = state[key] ?? 0;
state[key] = idx + 1;
writeFileSync({s}, JSON.stringify(state) + "\n");
appendFileSync({l}, JSON.stringify({{ key, taskName, modelId: kwargs.model_id, idx, verifierEnv: cfg.verifier?.env ?? null }}) + "\n");

const list = queues[key] ?? [];
const step = list[idx] ?? list[list.length - 1];
if (!step) process.exit(2);

const trialDir = join(cfg.jobs_dir, cfg.job_name, "trial-0");
const makaDir = join(trialDir, "agent", "maka");
mkdirSync(makaDir, {{ recursive: true }});

if (step.mode === "env_error") {{
  writeFileSync(join(trialDir, "result.json"), JSON.stringify(step.trialResult) + "\n");
  process.exit(step.exitCode ?? 1);
}}

const reqPath = join(trialDir, "guest-request.json");
const resPath = join(makaDir, "guest-result.json");
const apiKey = process.env[kwargs.api_key_env] ?? "";
writeFileSync(reqPath, JSON.stringify({{
  instruction: "Execute evaluation task.",
  workspaceDir: cfg.tasks[0].path,
  artifactsDir: makaDir,
  baseUrl: kwargs.endpoint_url ?? null,
  apiKey,
  provider: kwargs.provider,
  modelId: kwargs.model_id,
  sandboxMode: kwargs.sandbox_mode,
  maxSteps: kwargs.max_steps,
  timeoutMs: kwargs.timeout_ms,
}}), {{ mode: 0o600 }});

const evalBin = join(mount.source, "maka-eval" + (process.platform === "win32" ? ".exe" : ""));
const proc = spawnSync(evalBin, ["guest-run", "--request-file", reqPath, "--result-file", resPath], {{
  cwd: cfg.tasks[0].path,
  encoding: "utf8",
  env: {{
    ...process.env,
    NO_PROXY: "localhost,127.0.0.1,::1,host.docker.internal",
    no_proxy: "localhost,127.0.0.1,::1,host.docker.internal",
  }},
}});

if (existsSync(reqPath)) {{
  process.stderr.write("harbor-driver: guest-run left request file with apiKey behind\n");
  process.exit(99);
}}

if (proc.status !== 0) {{
  writeFileSync(join(trialDir, "result.json"), JSON.stringify({{
    verifier_result: null,
    exception_info: {{
      exception_type: "RuntimeError",
      message: `maka-eval guest-run exited with ${{proc.status}}: ${{proc.stderr || proc.stdout}}`,
    }},
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

#[tokio::test]
async fn run_cli_settles_delegated_retries_pricing_modes_and_keeps_completed_host_alive() {
    let env = IsolatedEnv::new(true);
    let srv = start_mock_provider(&env.task_dir).await;

    let (out, summary_path) = env
        .run_cli(
            "deepseek",
            "deepseek-chat",
            Some(&format!("{srv}/retry-delegate/v1")),
            5,
            &live_step(0.0),
        )
        .await;
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let summary: Value =
        serde_json::from_str(&std::fs::read_to_string(&summary_path).unwrap()).unwrap();
    assert_eq!(summary["reward"], 0.0);
    assert_eq!(summary["guest"]["status"], "completed");
    assert_eq!(summary["guest"]["stepsObserved"], 2);
    let models = &summary["guest"]["usage"]["models"];
    assert_eq!(models["calls"], 4);
    assert_eq!(models["success"], 3);
    assert_eq!(models["error"], 1);
    assert_eq!(models["input"]["known"], 750);
    assert_eq!(models["output"]["known"], 150);
    assert_eq!(models["input"]["missing"], 1);
    assert!((models["cost"]["knownUsd"].as_f64().unwrap() - 0.0003555).abs() < 1e-12);
    assert_eq!(summary["guest"]["metering"], "lower_bound");
    assert_eq!(summary["guest"]["costUsd"], Value::Null);
    assert!(summary["guest"].get("meteringError").is_none());
    let transcript = std::fs::read_to_string(summary["transcriptPath"].as_str().unwrap()).unwrap();
    assert!(transcript.contains("DELEGATION_COMPLETE:"));
    assert_eq!(env.host_run_dirs().len(), 1);
    assert_eq!(env.retire_live_hosts().await, 1);

    let (clean_out, clean_summary_path) = env
        .run_cli(
            "deepseek",
            "deepseek-chat",
            Some(&format!("{srv}/clean/v1")),
            2,
            &live_step(1.0),
        )
        .await;
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
    assert_eq!(env.retire_live_hosts().await, 1);

    let (no_cache_out, no_cache_summary_path) = env
        .run_cli(
            "deepseek",
            "deepseek-chat",
            Some(&format!("{srv}/no-cache/v1")),
            2,
            &live_step(1.0),
        )
        .await;
    assert!(
        no_cache_out.status.success(),
        "{}",
        String::from_utf8_lossy(&no_cache_out.stderr)
    );
    let no_cache_summary: Value =
        serde_json::from_str(&std::fs::read_to_string(&no_cache_summary_path).unwrap()).unwrap();
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
    assert_eq!(env.retire_live_hosts().await, 1);

    let (unpriced_out, unpriced_summary_path) = env
        .run_cli(
            "openai-compatible",
            "custom-unpriced",
            Some(&format!("{srv}/no-cache/v1")),
            2,
            &live_step(1.0),
        )
        .await;
    assert!(
        unpriced_out.status.success(),
        "{}",
        String::from_utf8_lossy(&unpriced_out.stderr)
    );
    let unpriced_summary: Value =
        serde_json::from_str(&std::fs::read_to_string(&unpriced_summary_path).unwrap()).unwrap();
    assert_eq!(unpriced_summary["reward"], 1.0);
    assert_eq!(
        unpriced_summary["guest"]["usage"]["models"]["cost"]["unpriced"],
        1
    );
    assert_eq!(unpriced_summary["guest"]["metering"], "complete");
    assert_eq!(unpriced_summary["guest"]["costUsd"], Value::Null);
    assert_eq!(env.retire_live_hosts().await, 1);
}

#[tokio::test]
async fn run_cli_stops_at_max_steps_retires_host_and_rejects_missing_completion_usage() {
    let env = IsolatedEnv::new(true);
    let srv = start_mock_provider(&env.task_dir).await;

    let (stopped_out, stopped_summary_path) = env
        .run_cli(
            "deepseek",
            "deepseek-chat",
            Some(&format!("{srv}/max-steps/v1")),
            1,
            &live_step(0.0),
        )
        .await;
    assert!(
        stopped_out.status.success(),
        "{}",
        String::from_utf8_lossy(&stopped_out.stderr)
    );
    assert!(env.host_run_dirs().is_empty());
    assert_eq!(env.retire_live_hosts().await, 0);
    let stopped_summary: Value =
        serde_json::from_str(&std::fs::read_to_string(&stopped_summary_path).unwrap()).unwrap();
    assert_eq!(stopped_summary["reward"], 0.0);
    assert_eq!(stopped_summary["guest"]["status"], "subjectStopped");
    assert!(
        stopped_summary["guest"]["stopReason"]
            .as_str()
            .unwrap()
            .contains("exceeded maxSteps (1)")
    );
    assert_eq!(stopped_summary["guest"]["stepsObserved"], 1);
    assert_eq!(
        stopped_summary["guest"]["usage"]["models"]["input"]["known"],
        80
    );
    assert_eq!(stopped_summary["guest"]["metering"], "lower_bound");
    assert_eq!(stopped_summary["guest"]["costUsd"], Value::Null);
    assert!(stopped_summary["guest"].get("meteringError").is_none());

    let (missing_out, missing_summary_path) = env
        .run_cli(
            "deepseek",
            "deepseek-chat",
            Some(&format!("{srv}/missing-usage/v1")),
            2,
            &live_step(1.0),
        )
        .await;
    assert!(!missing_out.status.success());
    assert!(
        String::from_utf8_lossy(&missing_out.stderr)
            .contains("incomplete token usage on successful model call(s)")
    );
    let missing_summary: Value =
        serde_json::from_str(&std::fs::read_to_string(&missing_summary_path).unwrap()).unwrap();
    assert_eq!(missing_summary["reward"], 1.0);
    assert_eq!(missing_summary["guest"]["status"], "completed");
    assert!(missing_summary["guest"].get("metering").is_none());
    assert!(missing_summary["guest"].get("costUsd").is_none());
    assert!(
        missing_summary["guest"]["meteringError"]
            .as_str()
            .unwrap()
            .contains("incomplete token usage on successful model call(s)")
    );
    assert_eq!(env.retire_live_hosts().await, 1);
}

#[tokio::test]
async fn run_cli_persists_summary_and_surfaces_guest_root_cause_on_infra_failure() {
    let env = IsolatedEnv::new(false);
    let staged_eval = env
        .bundle
        .join(format!("maka-eval{}", std::env::consts::EXE_SUFFIX));
    assert!(
        !staged_eval
            .symlink_metadata()
            .unwrap()
            .file_type()
            .is_symlink()
    );

    let (bad_steps_out, _) = env
        .run_cli("deepseek", "deepseek-chat", None, 0, &live_step(0.0))
        .await;
    assert!(!bad_steps_out.status.success());

    let (out, summary_path) = env
        .run_cli("deepseek", "deepseek-chat", None, 2, &live_step(0.0))
        .await;
    assert!(!out.status.success());
    assert!(env.host_run_dirs().is_empty());
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stderr.contains("guest infrastructure failed:"),
        "unexpected stderr: {stderr}"
    );
    assert!(summary_path.is_file());
    let summary: Value =
        serde_json::from_str(&std::fs::read_to_string(&summary_path).unwrap()).unwrap();
    assert_eq!(summary["guest"]["status"], "infraFailed");
    assert!(!summary["guest"]["infraError"].as_str().unwrap().is_empty());
    assert!(summary["guest"].get("usage").is_none());
    assert!(summary["guest"].get("metering").is_none());
    assert!(summary["guest"].get("meteringError").is_none());
    assert_eq!(summary["exceptionInfo"]["exception_type"], "RuntimeError");
}

#[tokio::test]
async fn batch_cli_resumes_retries_infra_failures_and_matches_ts_selection() {
    let env = IsolatedEnv::new(true);
    let srv = start_mock_provider(&env.task_dir).await;

    let task_one = create_task_dir(&env.tmp, "task-one");
    let task_two = create_task_dir(&env.tmp, "task-two");
    let harbor_dir = env.tmp.join("batch-harbor");
    std::fs::create_dir_all(&harbor_dir).unwrap();

    let queues = json!({
        "task-one__1__sub-a": [
            env_error_step("EnvironmentStartTimeoutError", None),
            live_step(1.0),
        ],
        "task-one__1__sub-b": [
            live_step(0.5),
            live_step(1.0),
        ],
        "task-one__2__sub-a": [live_step(0.0)],
        "task-one__2__sub-b": [
            env_error_step("EnvironmentStartTimeoutError", None),
            live_step(0.0),
        ],
        "task-two__1__sub-a": [
            verifier_error_step("VerifierTimeoutError"),
            env_error_step("EnvironmentStartTimeoutError", None),
            live_step(1.0),
        ],
        "task-two__1__sub-b": [
            env_error_step("AgentTimeoutError", Some(0.0)),
            live_step(1.0),
        ],
        "task-two__2__sub-a": [live_step(1.0)],
        "task-two__2__sub-b": [
            env_error_step("EnvironmentStartTimeoutError", None),
            env_error_step("EnvironmentStartTimeoutError", None),
            env_error_step("EnvironmentStartTimeoutError", None),
        ],
    });
    let (harbor_bin, log_path) = write_harbor_driver(&harbor_dir, &queues);

    let spec_path = env.tmp.join("batch-spec.json");
    let out_dir = env.tmp.join("batch-out");
    let write_spec = |max_retries: u32| {
        std::fs::write(
            &spec_path,
            serde_json::to_vec_pretty(&json!({
                "bundleDir": env.bundle,
                "harborBin": harbor_bin,
                "verifierEnv": { "UV_INDEX_URL": "https://pypi.tuna.tsinghua.edu.cn/simple" },
                "repetitions": 2,
                "maxRetries": max_retries,
                "maxSteps": 1,
                "subjects": [
                    { "id": "sub-a", "provider": "deepseek", "modelId": "deepseek-chat", "baseUrl": format!("{srv}/clean/v1"), "apiKeyEnv": "EVAL_API_KEY" },
                    { "id": "sub-b", "provider": "deepseek", "modelId": "deepseek-chat", "baseUrl": format!("{srv}/max-steps/v1"), "apiKeyEnv": "EVAL_API_KEY" }
                ],
                "tasks": [task_one, task_two],
            }))
            .unwrap(),
        )
        .unwrap();
    };
    write_spec(1);

    let mut run1_cmd = env.eval_command();
    run1_cmd
        .env("EVAL_API_KEY", "sk-batch-key")
        .args(["batch", "--spec"])
        .arg(&spec_path)
        .arg("--out")
        .arg(&out_dir);
    let run1 = tokio::task::spawn_blocking(move || run1_cmd.output().expect("run batch 1"))
        .await
        .unwrap();
    assert!(!run1.status.success());

    let invocations_1: Vec<Value> = std::fs::read_to_string(&log_path)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert_eq!(invocations_1.len(), 12);
    assert_eq!(
        invocations_1[0]["verifierEnv"]["UV_INDEX_URL"],
        "https://pypi.tuna.tsinghua.edu.cn/simple"
    );

    let summary_1: Value =
        serde_json::from_str(&std::fs::read_to_string(out_dir.join("summary.json")).unwrap())
            .unwrap();
    assert_eq!(summary_1["attemptsRecorded"], 12);
    assert_eq!(summary_1["selected"], 5);
    assert_eq!(summary_1["blocked"], 1);
    assert_eq!(summary_1["exhausted"], 2);

    let attempts_path = out_dir.join("attempts.jsonl");
    {
        let locked = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&attempts_path)
            .unwrap();
        locked.try_lock().unwrap();
        let contended = env
            .eval_command()
            .env("EVAL_API_KEY", "sk-batch-key")
            .args(["batch", "--spec"])
            .arg(&spec_path)
            .arg("--out")
            .arg(&out_dir)
            .output()
            .unwrap();
        assert!(!contended.status.success());
        assert!(
            String::from_utf8_lossy(&contended.stderr)
                .contains("locked by another maka-eval batch process")
        );
    }

    let stale_dir = out_dir
        .join("trials")
        .join("task-two__1__sub-a")
        .join("attempt-3");
    std::fs::create_dir_all(&stale_dir).unwrap();
    let stale_file = stale_dir.join("stale.txt");
    std::fs::write(&stale_file, b"leftover").unwrap();
    write_spec(2);

    let mut run2_cmd = env.eval_command();
    run2_cmd
        .env("EVAL_API_KEY", "sk-batch-key")
        .args(["batch", "--spec"])
        .arg(&spec_path)
        .arg("--out")
        .arg(&out_dir);
    let run2 = tokio::task::spawn_blocking(move || run2_cmd.output().expect("run batch 2"))
        .await
        .unwrap();
    assert!(!run2.status.success());
    assert!(!stale_file.exists(), "stale unrecorded dir must be cleaned");

    let invocations_2: Vec<Value> = std::fs::read_to_string(&log_path)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert_eq!(invocations_2.len(), 14);

    let summary_2: Value =
        serde_json::from_str(&std::fs::read_to_string(out_dir.join("summary.json")).unwrap())
            .unwrap();
    assert_eq!(summary_2["attemptsRecorded"], 14);
    assert_eq!(summary_2["selected"], 6);
    assert_eq!(summary_2["blocked"], 1);
    assert_eq!(summary_2["exhausted"], 1);
    assert!((summary_2["cells"][0]["costUsd"].as_f64().unwrap() - 0.000045).abs() < 1e-12);
    assert_eq!(summary_2["cells"][1]["metering"], "lower_bound");

    let cells = summary_2["cells"].as_array().unwrap();
    let actual_pairs: Vec<(&str, Option<u64>)> = cells
        .iter()
        .map(|c| {
            (
                c["cellId"].as_str().unwrap(),
                c["selectedSequence"].as_u64(),
            )
        })
        .collect();
    assert_eq!(
        actual_pairs,
        vec![
            ("task-one::1::sub-a", Some(2)),
            ("task-one::1::sub-b", Some(1)),
            ("task-one::2::sub-a", Some(1)),
            ("task-one::2::sub-b", Some(2)),
            ("task-two::1::sub-a", Some(3)),
            ("task-two::1::sub-b", None),
            ("task-two::2::sub-a", Some(1)),
            ("task-two::2::sub-b", None),
        ]
    );

    const ORACLE_COMMIT: &str = "85a1031c10d104456127f35aac1523b9ffb1a384";
    if let Some(repo_root) = find_git_repo_root().filter(|r| {
        StdCommand::new("git")
            .arg("-C")
            .arg(r)
            .args(["cat-file", "-e", &format!("{ORACLE_COMMIT}^{{commit}}")])
            .output()
            .is_ok_and(|o| o.status.success())
    }) {
        let ts_dir = env.tmp.join("ts-oracle");
        std::fs::create_dir_all(&ts_dir).unwrap();
        std::fs::write(ts_dir.join("package.json"), r#"{"type":"module"}"#).unwrap();

        let exp_ts = StdCommand::new("git")
            .arg("-C")
            .arg(&repo_root)
            .args([
                "show",
                &format!("{ORACLE_COMMIT}:packages/eval/src/experiment.ts"),
            ])
            .output()
            .unwrap();
        assert!(exp_ts.status.success());
        std::fs::write(ts_dir.join("experiment.ts"), exp_ts.stdout).unwrap();

        let res_ts = StdCommand::new("git")
            .arg("-C")
            .arg(&repo_root)
            .args([
                "show",
                &format!("{ORACLE_COMMIT}:packages/eval/src/result.ts"),
            ])
            .output()
            .unwrap();
        assert!(res_ts.status.success());
        let res_src = String::from_utf8(res_ts.stdout)
            .unwrap()
            .replace("./experiment.js", "./experiment.ts");
        std::fs::write(ts_dir.join("result.ts"), res_src).unwrap();

        let ts_probe = StdCommand::new("node")
            .current_dir(&ts_dir)
            .arg("--input-type=module")
            .arg("-e")
            .arg(format!(
                r#"
                import {{ readFileSync }} from "node:fs";
                import {{ expandExperiment }} from "./experiment.ts";
                import {{ selectCellResult }} from "./result.ts";
                const expanded = expandExperiment({{
                  schemaVersion: "maka.eval.v1",
                  id: "diff",
                  benchmark: {{ id: "tb", version: "1", config: {{}} }},
                  executor: {{ kind: "harbor", config: {{}} }},
                  execution: {{ maxConcurrentTaskGroups: 1 }},
                  subjects: [
                    {{ id: "sub-a", kind: "maka", credentials: ["EVAL_API_KEY"], config: {{}} }},
                    {{ id: "sub-b", kind: "maka", credentials: ["EVAL_API_KEY"], config: {{}} }}
                  ],
                  tasks: [
                    {{ id: "task-one", input: "x", config: {{}} }},
                    {{ id: "task-two", input: "y", config: {{}} }}
                  ],
                  repetitions: 2,
                  budget: {{}},
                  verifier: {{}}
                }}).map((c) => c.id);
                const byCell = new Map(expanded.map((id) => [id, []]));
                for (const line of readFileSync({a}, "utf8").trim().split("\n")) {{
                  const r = JSON.parse(line);
                  byCell.get(r.cellId).push({{
                    cellId: r.cellId,
                    sequence: r.sequence,
                    startedAt: 1,
                    completedAt: 2,
                    result: {{
                      score: r.score,
                      usage: null,
                      costUsd: r.costUsd,
                      durationMs: r.durationMs,
                      status: r.status,
                      failureReason: r.failureReason,
                      artifacts: []
                    }}
                  }});
                }}
                const pairs = expanded.map((id) => {{
                  const picked = selectCellResult(byCell.get(id));
                  return [id, picked ? picked.sequence : null];
                }});
                console.log(JSON.stringify(pairs));
                "#,
                a = serde_json::to_string(&attempts_path).unwrap()
            ))
            .output()
            .unwrap();
        assert!(
            ts_probe.status.success(),
            "{}",
            String::from_utf8_lossy(&ts_probe.stderr)
        );
        let ts_pairs: Vec<(String, Option<u64>)> =
            serde_json::from_slice(&ts_probe.stdout).unwrap();
        let expected: Vec<(String, Option<u64>)> = actual_pairs
            .iter()
            .map(|(id, seq)| ((*id).to_owned(), *seq))
            .collect();
        assert_eq!(ts_pairs, expected);
    }

    let corrupt_dir = env.tmp.join("batch-corrupt");
    std::fs::create_dir_all(&corrupt_dir).unwrap();
    let mut corrupt_bytes = std::fs::read(&attempts_path).unwrap();
    corrupt_bytes.extend_from_slice(br#"{"cellId":"partial"#);
    std::fs::write(corrupt_dir.join("attempts.jsonl"), corrupt_bytes).unwrap();
    let corrupt_run = env
        .eval_command()
        .env("EVAL_API_KEY", "sk-batch-key")
        .args(["batch", "--spec"])
        .arg(&spec_path)
        .arg("--out")
        .arg(&corrupt_dir)
        .output()
        .unwrap();
    assert!(!corrupt_run.status.success());
    assert!(
        String::from_utf8_lossy(&corrupt_run.stderr)
            .contains("line 15 is missing trailing newline")
    );

    let post_term_dir = env.tmp.join("batch-post-terminal");
    std::fs::create_dir_all(&post_term_dir).unwrap();
    let mut post_term_bytes = std::fs::read(&attempts_path).unwrap();
    let extra_line = serde_json::to_string(&json!({
        "cellId": "task-one::1::sub-b",
        "sequence": 2,
        "durationMs": 1,
        "status": "completed",
        "score": 1.0,
        "metering": "complete",
        "costUsd": 0.0,
        "failureReason": Value::Null,
        "summaryPath": "/tmp/s",
    }))
    .unwrap();
    post_term_bytes.extend_from_slice(format!("{extra_line}\n").as_bytes());
    std::fs::write(post_term_dir.join("attempts.jsonl"), post_term_bytes).unwrap();
    let post_term_run = env
        .eval_command()
        .env("EVAL_API_KEY", "sk-batch-key")
        .args(["batch", "--spec"])
        .arg(&spec_path)
        .arg("--out")
        .arg(&post_term_dir)
        .output()
        .unwrap();
    assert!(!post_term_run.status.success());
    assert!(
        String::from_utf8_lossy(&post_term_run.stderr)
            .contains("after terminal 'subject_failed' attempt")
    );

    let _ = env.retire_live_hosts().await;
}
