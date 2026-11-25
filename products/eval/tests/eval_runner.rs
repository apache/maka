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
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use maka_host_runtime::application::host::Client as HostClient;
use maka_host_runtime::application::host::discovery;
use maka_mock_ai::{
    ControlPlaneConfig, FinishReason, HttpErrorSpec, MockAiBuilder, MockAiServer, ModelEntry,
    NormalizedRequest, TurnContext, TurnEvent, TurnPlan, Usage,
};
use serde_json::{Value, json};

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

    async fn run_guest_live_status(
        &self,
        base_url: &str,
        max_steps: Option<u32>,
        timeout_ms: Option<u64>,
    ) -> (std::process::ExitStatus, String, Value, PathBuf, PathBuf) {
        self.run_guest_live_with_options(base_url, "deepseek-chat", None, max_steps, timeout_ms)
            .await
    }

    async fn run_guest_live_with_options(
        &self,
        base_url: &str,
        model_id: &str,
        thinking_level: Option<&str>,
        max_steps: Option<u32>,
        timeout_ms: Option<u64>,
    ) -> (std::process::ExitStatus, String, Value, PathBuf, PathBuf) {
        let id = self.seq.fetch_add(1, Ordering::SeqCst);
        let artifacts = self.tmp.join(format!("artifacts-live-{id}"));
        let req_path = self.tmp.join(format!("req-live-{id}.json"));
        let res_path = artifacts.join("guest-result.json");
        let mut req_obj = json!({
            "instruction": "Execute evaluation task.",
            "artifactsDir": artifacts,
            "baseUrl": base_url,
            "apiKey": "sk-eval-key",
            "provider": "deepseek",
            "modelId": model_id,
            "sandboxMode": "danger-full-access",
            "maxSteps": max_steps,
        });
        if let Some(level) = thinking_level {
            req_obj["thinkingLevel"] = json!(level);
        }
        let payload = serde_json::to_vec(&req_obj).unwrap();
        std::fs::write(&req_path, payload).unwrap();

        let mut cmd = self.eval_command();
        cmd.current_dir(&self.workspace);
        let req_for_cmd = req_path.clone();
        let res_for_cmd = res_path.clone();
        let out = tokio::task::spawn_blocking(move || {
            cmd.args(["guest-run", "--request-file"])
                .arg(&req_for_cmd)
                .arg("--result-file")
                .arg(&res_for_cmd);
            if let Some(ms) = timeout_ms {
                cmd.args(["--timeout-ms", &ms.to_string()]);
            }
            cmd.output().expect("run guest-run")
        })
        .await
        .unwrap();
        assert!(!req_path.exists());
        let parsed = read_json(&res_path);
        (
            out.status,
            String::from_utf8_lossy(&out.stderr).into_owned(),
            parsed,
            res_path,
            artifacts.join("transcript.json"),
        )
    }

    async fn run_guest_live(
        &self,
        base_url: &str,
        max_steps: Option<u32>,
        timeout_ms: Option<u64>,
    ) -> (Value, PathBuf, PathBuf) {
        let (status, stderr, parsed, res_path, transcript_path) = self
            .run_guest_live_status(base_url, max_steps, timeout_ms)
            .await;
        assert!(status.success(), "guest-run failed: {stderr}");
        (parsed, res_path, transcript_path)
    }

    fn run_harbor(
        &self,
        guest_result: Option<&Path>,
        transcript: Option<&Path>,
        trial_result_json: &Value,
        exit_code: i32,
    ) -> (Output, PathBuf) {
        self.run_harbor_with_args(
            None,
            guest_result,
            transcript,
            trial_result_json,
            exit_code,
            &[],
            &[],
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn run_harbor_with_args(
        &self,
        task_dir: Option<&Path>,
        guest_result: Option<&Path>,
        transcript: Option<&Path>,
        trial_result_json: &Value,
        exit_code: i32,
        extra_args: &[&str],
        extra_env: &[(&str, &str)],
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
        let mut cmd = self.eval_command();
        cmd.env("EVAL_API_KEY", "sk-eval-key")
            .envs(extra_env.iter().copied())
            .args(["run", "--task"])
            .arg(task_dir.unwrap_or(&self.workspace))
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
            .args(extra_args);
        let out = cmd.output().expect("run maka-eval run");
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

fn read_json(path: &Path) -> Value {
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
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
    SlowFirstTurn,
    SingleTurnRecord { recorded: Arc<Mutex<Vec<Value>>> },
    Unauthorized401,
}

fn usage_with_cache(input: u64, output: u64, cached: Option<u64>) -> Usage {
    let mut u = Usage::new(input, output);
    if let Some(c) = cached {
        u = u.with_cache_read(c);
    }
    u
}

async fn start_mock_provider(mode: MockMode) -> MockAiServer {
    MockAiBuilder::new()
        .control(ControlPlaneConfig {
            models: vec![
                ModelEntry::simple("deepseek-chat"),
                ModelEntry::simple("deepseek-flash"),
            ],
            ..Default::default()
        })
        .handler_fn(move |req: &NormalizedRequest, ctx: &TurnContext| {
            let call_idx = ctx.global_turn;
            if matches!(mode, MockMode::Retry429AndDelegateSubagent { .. }) && call_idx == 1 {
                return TurnPlan::http_error(HttpErrorSpec::rate_limit(Some(0), "rate limit"));
            }
            match &mode {
                MockMode::Retry429AndDelegateSubagent { workspace_path } => {
                    let msgs = req.raw_body["messages"].to_string();
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
                        TurnPlan::new()
                            .push_tool_call("call_1", "exec", json!({ "code": code }))
                            .with_usage(usage_with_cache(100, 20, Some(20)))
                            .finish(FinishReason::ToolCalls)
                    } else if msgs.contains("DELEGATED_CHILD_PROMPT")
                        && !msgs.contains("DELEGATION_COMPLETE:")
                    {
                        TurnPlan::new()
                            .push_text("CHILD_DONE_TOKEN")
                            .with_usage(usage_with_cache(500, 100, Some(20)))
                            .finish(FinishReason::Stop)
                    } else {
                        TurnPlan::new()
                            .push_text("Parent task completed.")
                            .with_usage(usage_with_cache(150, 30, Some(20)))
                            .finish(FinishReason::Stop)
                    }
                }
                MockMode::MaxStepsSlowSecondTurn => {
                    if call_idx == 1 {
                        TurnPlan::new()
                            .push_tool_call(
                                "call_step1",
                                "exec",
                                json!({ "code": "text('step-1-ok');" }),
                            )
                            .with_usage(usage_with_cache(80, 20, Some(20)))
                            .finish(FinishReason::ToolCalls)
                    } else {
                        TurnPlan::new()
                            .push_text("Continuing step 2...")
                            .push(TurnEvent::Delay { ms: 2000 })
                            .push(TurnEvent::TruncateEof)
                    }
                }
                MockMode::SlowFirstTurn => TurnPlan::new()
                    .push_text("Working...")
                    .push(TurnEvent::Delay { ms: 120_000 })
                    .push(TurnEvent::TruncateEof),
                MockMode::SingleTurnRecord { recorded } => {
                    recorded.lock().unwrap().push(req.raw_body.clone());
                    TurnPlan::new()
                        .push_text("Recorded completion.")
                        .with_usage(usage_with_cache(100, 20, Some(20)))
                        .finish(FinishReason::Stop)
                }
                MockMode::Unauthorized401 => TurnPlan::http_error(HttpErrorSpec::new(
                    401,
                    "authentication_error",
                    "invalid api key",
                )),
            }
        })
        .start()
        .await
        .expect("start mock-ai server")
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
const args = process.argv.slice(2);
if (args[0] !== "run") process.exit(2);
let configPath;
const verifierEnv = [];
for (let i = 1; i < args.length; i++) {{
  if (args[i] === "-c" && i + 1 < args.length) {{
    configPath = args[++i];
  }} else if (args[i] === "--verifier-env" && i + 1 < args.length) {{
    verifierEnv.push(args[++i]);
  }} else {{
    process.exit(2);
  }}
}}
if (!configPath) process.exit(2);
const cfg = JSON.parse(readFileSync(configPath, "utf8"));
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
writeFileSync(join(cfg.jobs_dir, cfg.job_name, "argv-verifier-env.json"), JSON.stringify(verifierEnv) + "\n");
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

    let (out, req, res, _) = env.run_guest_raw(br#"{"apiKey":"sk-top-secret""#);
    assert!(!out.status.success());
    assert!(!req.exists(), "secret request file must be deleted");
    let parsed = read_json(&res);
    assert!(parsed["infraFailed"].is_object());
    assert!(
        parsed["infraFailed"]["infraError"]
            .as_str()
            .unwrap()
            .contains("invalid guest request JSON")
    );

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        struct RestorePerms(PathBuf);
        impl Drop for RestorePerms {
            fn drop(&mut self) {
                let _ = std::fs::set_permissions(&self.0, std::fs::Permissions::from_mode(0o755));
            }
        }

        let ro_dir = env.tmp.join("ro-req-dir");
        std::fs::create_dir_all(&ro_dir).unwrap();
        let ro_req = ro_dir.join("req.json");
        let sentinel = ro_dir.join("sentinel");
        let valid_req = serde_json::to_vec(&json!({
            "instruction": "noop",
            "artifactsDir": env.tmp.join("ro-artifacts"),
            "apiKey": "sk-top-secret-ro",
            "provider": "deepseek",
            "modelId": "deepseek-chat",
            "sandboxMode": "danger-full-access",
        }))
        .unwrap();
        std::fs::write(&ro_req, &valid_req).unwrap();
        std::fs::write(&sentinel, b"").unwrap();
        std::fs::set_permissions(&ro_dir, std::fs::Permissions::from_mode(0o555)).unwrap();
        let _restore = RestorePerms(ro_dir);

        if std::fs::remove_file(&sentinel).is_err() {
            let ro_res = env.tmp.join("ro-artifacts").join("guest-result.json");
            let ro_out = env
                .eval_command()
                .args(["guest-run", "--request-file"])
                .arg(&ro_req)
                .arg("--result-file")
                .arg(&ro_res)
                .output()
                .expect("spawn guest-run with unwritable request dir");
            assert!(!ro_out.status.success());
            assert!(ro_req.exists());
            let ro_parsed = read_json(&ro_res);
            assert!(ro_parsed["infraFailed"].is_object());
            assert!(
                ro_parsed["infraFailed"]["infraError"]
                    .as_str()
                    .unwrap()
                    .contains("failed to remove secret request file")
            );
            assert!(env.host_run_dirs().is_empty());
        }
    }
}

#[tokio::test]
async fn guest_run_completed_accounts_delegated_subagents_retries_429_and_keeps_host_alive() {
    let env = IsolatedEnv::new(true);
    let mock_server = start_mock_provider(MockMode::Retry429AndDelegateSubagent {
        workspace_path: env.workspace.to_string_lossy().into_owned(),
    })
    .await;

    let (guest_json, res_path, transcript_path) = env
        .run_guest_live(&mock_server.base_url(), Some(5), None)
        .await;
    let completed = &guest_json["completed"];
    assert!(completed.is_object());
    assert_eq!(completed["settlement"]["metering"], "lower_bound");
    assert!(completed["settlement"].get("inputTokens").is_none());
    assert!(completed["settlement"].get("cacheTokens").is_none());
    assert!(completed["settlement"].get("outputTokens").is_none());
    assert_eq!(completed["evidence"]["stepsObserved"], 2);

    let models = &completed["evidence"]["hostUsage"]["summary"]["models"];
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
    let summary = read_json(&summary_path);
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
}

#[tokio::test]
async fn guest_run_max_steps_stops_in_flight_stream_retires_host_and_passes_validation() {
    let env = IsolatedEnv::new(true);
    let mock_server = start_mock_provider(MockMode::MaxStepsSlowSecondTurn).await;

    let (guest_json, res_path, transcript_path) = env
        .run_guest_live(&mock_server.base_url(), Some(1), None)
        .await;
    let stopped = &guest_json["subjectStopped"];
    assert!(stopped.is_object());
    assert!(
        stopped["stopReason"]
            .as_str()
            .unwrap()
            .contains("exceeded maxSteps (1)")
    );
    assert_eq!(stopped["settlement"]["metering"], "lower_bound");
    assert!(stopped["settlement"].get("inputTokens").is_none());
    assert!(stopped["settlement"].get("cacheTokens").is_none());
    assert!(stopped["settlement"].get("outputTokens").is_none());
    assert_eq!(stopped["evidence"]["stepsObserved"], 1);
    assert_eq!(
        stopped["evidence"]["hostUsage"]["summary"]["models"]["input"]["known"],
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
    let stopped_summary = read_json(&stopped_summary_path);
    assert_eq!(stopped_summary["reward"], 0.0);
    assert_eq!(stopped_summary["guest"]["status"], "subjectStopped");
    assert_eq!(stopped_summary["guest"]["metering"], "lower_bound");
    assert_eq!(stopped_summary["guest"]["costUsd"], Value::Null);
}

#[test]
fn run_command_persists_summary_and_surfaces_root_cause_on_infra_failure() {
    let env = IsolatedEnv::new(false);
    let infra_guest_path = env.tmp.join("infra-guest-result.json");
    std::fs::write(
        &infra_guest_path,
        serde_json::to_vec(&json!({
            "infraFailed": {
                "infraError": "maka host serve exited before printing ready line",
            }
        }))
        .unwrap(),
    )
    .unwrap();

    let (run_out, summary_path) = env.run_harbor(
        Some(&infra_guest_path),
        None,
        &json!({
            "verifier_result": Value::Null,
            "exception_info": { "exception_type": "MakaInfraError", "message": "guest-run exited with 1" },
        }),
        1,
    );
    assert!(!run_out.status.success());
    assert!(String::from_utf8_lossy(&run_out.stderr).contains(
        "guest infrastructure failed: maka host serve exited before printing ready line"
    ));
    assert!(summary_path.is_file());
    let summary = read_json(&summary_path);
    assert_eq!(summary["guest"]["status"], "infraFailed");
    assert!(summary["guest"].get("usage").is_none());
    assert!(summary["guest"].get("metering").is_none());
    assert_eq!(
        summary["exceptionInfo"]["exception_type"],
        json!("MakaInfraError")
    );
}

#[test]
fn run_cli_config_contract_and_corrupt_guest_result() {
    let env = IsolatedEnv::new(false);
    let trial_ok = json!({ "verifier_result": { "rewards": { "reward": 1.0 } }, "exception_info": Value::Null });

    let task_frac = env.tmp.join("task-frac");
    std::fs::create_dir_all(&task_frac).unwrap();
    std::fs::write(
        task_frac.join("task.toml"),
        "[task]\nname = \"ws-frac\"\n[agent]\ntimeout_sec = 10.5\n",
    )
    .unwrap();
    let (task_budget_out, task_budget_summary) =
        env.run_harbor_with_args(Some(&task_frac), None, None, &trial_ok, 0, &[], &[]);
    assert!(!task_budget_out.status.success());
    let task_budget_summary_json = read_json(&task_budget_summary);
    assert_eq!(task_budget_summary_json["reward"], Value::Null);
    let task_budget_cfg = read_json(
        &task_budget_summary
            .parent()
            .unwrap()
            .join("harbor-job-config.json"),
    );
    assert_eq!(task_budget_cfg["agents"][0]["override_timeout_sec"], 40.5);
    assert_eq!(task_budget_cfg["agents"][0]["kwargs"]["timeout_ms"], 10_500);

    let (explicit_out, explicit_summary_path) = env.run_harbor_with_args(
        Some(&task_frac),
        None,
        None,
        &trial_ok,
        0,
        &[
            "--max-steps",
            "3",
            "--timeout-ms",
            "15000",
            "--thinking-level",
            "low",
            "--verifier-env",
            "HOST_MARKER",
            "--verifier-env",
            "JUDGE_API_KEY=${SYNTH_JUDGE_KEY}",
        ],
        &[
            ("HOST_MARKER", "synth-marker-secret"),
            ("SYNTH_JUDGE_KEY", "sk-synth-judge-secret"),
        ],
    );
    assert!(!explicit_out.status.success());
    let explicit_cfg_raw = std::fs::read_to_string(
        explicit_summary_path
            .parent()
            .unwrap()
            .join("harbor-job-config.json"),
    )
    .unwrap();
    assert!(!explicit_cfg_raw.contains("synth-marker-secret"));
    assert!(!explicit_cfg_raw.contains("sk-synth-judge-secret"));
    let explicit_cfg: Value = serde_json::from_str(&explicit_cfg_raw).unwrap();
    assert!(explicit_cfg.get("verifier").is_none());
    assert_eq!(explicit_cfg["agents"][0]["override_timeout_sec"], 45.0);
    assert_eq!(explicit_cfg["agents"][0]["kwargs"]["max_steps"], 3);
    assert_eq!(explicit_cfg["agents"][0]["kwargs"]["timeout_ms"], 15_000);
    assert_eq!(explicit_cfg["agents"][0]["kwargs"]["thinking_level"], "low");
    let explicit_summary = read_json(&explicit_summary_path);
    let argv_verifier_path = Path::new(explicit_summary["harborResultPath"].as_str().unwrap())
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("argv-verifier-env.json");
    assert_eq!(
        read_json(&argv_verifier_path),
        json!([
            "HOST_MARKER=${HOST_MARKER}",
            "JUDGE_API_KEY=${SYNTH_JUDGE_KEY}"
        ])
    );

    let rejected_out_dir = env.tmp.join("rejected-verifier-env");
    let rejected = env
        .eval_command()
        .env("EVAL_API_KEY", "sk-eval-key")
        .args(["run", "--task"])
        .arg(&env.workspace)
        .arg("--bundle-dir")
        .arg(&env.bundle)
        .arg("--out")
        .arg(&rejected_out_dir)
        .args([
            "--api-key-env",
            "EVAL_API_KEY",
            "--provider",
            "deepseek",
            "--model",
            "deepseek-chat",
            "--verifier-env",
            "JUDGE_KEY=sk-synth-stderr-secret",
        ])
        .output()
        .expect("run invalid verifier-env");
    assert!(!rejected.status.success());
    let rejected_stderr = String::from_utf8_lossy(&rejected.stderr);
    assert!(rejected_stderr.contains("only host env references"));
    assert!(rejected_stderr.contains("JUDGE_KEY"));
    assert!(!rejected_stderr.contains("sk-synth-stderr-secret"));
    assert!(!rejected_out_dir.exists());

    let corrupt_guest = env.tmp.join("corrupt-guest.json");
    std::fs::write(&corrupt_guest, br"{corrupt").unwrap();
    let (corrupt_out, corrupt_summary_path) =
        env.run_harbor(Some(&corrupt_guest), None, &trial_ok, 0);
    assert!(!corrupt_out.status.success());
    assert!(String::from_utf8_lossy(&corrupt_out.stderr).contains("invalid guest-result.json"));
    let corrupt_summary = read_json(&corrupt_summary_path);
    assert_eq!(corrupt_summary["reward"], Value::Null);
    assert_eq!(corrupt_summary["guest"]["status"], "infraFailed");
    assert!(
        corrupt_summary["guest"]["infraError"]
            .as_str()
            .unwrap()
            .contains("invalid guest-result.json")
    );
}

#[tokio::test]
async fn guest_run_forwards_thinking_level_and_enforces_pre_start_timeout() {
    let env = IsolatedEnv::new(true);
    let recorded = Arc::new(Mutex::new(Vec::new()));
    let mock_server = start_mock_provider(MockMode::SingleTurnRecord {
        recorded: Arc::clone(&recorded),
    })
    .await;

    let warm_start = std::time::Instant::now();
    let (ok_status, ok_stderr, ok_guest, ok_res_path, ok_transcript_path) = env
        .run_guest_live_with_options(
            &mock_server.base_url(),
            "deepseek-flash",
            Some("low"),
            None,
            None,
        )
        .await;
    let baseline_ms = warm_start.elapsed().as_millis() as u64;
    assert!(ok_status.success(), "guest-run failed: {ok_stderr}");
    assert!(ok_guest["completed"].is_object());
    let settlement = &ok_guest["completed"]["settlement"];
    assert_eq!(settlement["inputTokens"], 100);
    assert_eq!(settlement["cacheTokens"], 20);
    assert_eq!(settlement["outputTokens"], 20);
    assert!(
        (settlement["metering"]["complete"]["costUsd"]
            .as_f64()
            .unwrap()
            - 0.00002406)
            .abs()
            < 1e-12
    );
    assert_eq!(env.retire_live_hosts().await, 1);
    {
        let bodies = recorded.lock().unwrap();
        assert_eq!(bodies.len(), 1);
        assert_eq!(bodies[0]["reasoning"]["effort"], "low");
    }

    let (clean_out, clean_summary_path) = env.run_harbor(
        Some(&ok_res_path),
        Some(&ok_transcript_path),
        &json!({ "verifier_result": { "rewards": { "reward": 1.0 } }, "exception_info": Value::Null }),
        0,
    );
    assert!(
        clean_out.status.success(),
        "{}",
        String::from_utf8_lossy(&clean_out.stderr)
    );
    let clean_summary = read_json(&clean_summary_path);
    assert_eq!(clean_summary["reward"], 1.0);
    assert_eq!(clean_summary["guest"]["metering"], "complete");
    assert!((clean_summary["guest"]["costUsd"].as_f64().unwrap() - 0.00002406).abs() < 1e-12);

    let (t_status, _, t_guest, _, _) = env
        .run_guest_live_with_options(
            &mock_server.base_url(),
            "deepseek-chat",
            None,
            None,
            Some(1),
        )
        .await;
    assert!(!t_status.success());
    assert!(
        t_guest["infraFailed"]["infraError"]
            .as_str()
            .unwrap()
            .contains("agent timeout budget (1 ms) exhausted")
    );
    assert!(env.host_run_dirs().is_empty());
    assert_eq!(recorded.lock().unwrap().len(), 1);

    let slow_server = start_mock_provider(MockMode::SlowFirstTurn).await;
    let mid_run_timeout_ms = baseline_ms.saturating_add(baseline_ms.clamp(4_000, 15_000));
    let (mid_status, mid_stderr, mid_guest, _, _) = env
        .run_guest_live_with_options(
            &slow_server.base_url(),
            "deepseek-chat",
            None,
            None,
            Some(mid_run_timeout_ms),
        )
        .await;
    assert!(mid_status.success(), "guest-run failed: {mid_stderr}");
    let mid_stopped = &mid_guest["subjectStopped"];
    assert!(mid_stopped.is_object());
    assert!(
        mid_stopped["stopReason"]
            .as_str()
            .unwrap()
            .contains("execution timed out after")
    );
    assert_eq!(mid_stopped["settlement"]["metering"], "lower_bound");
    assert!(mid_stopped["settlement"].get("inputTokens").is_none());
    assert!(env.host_run_dirs().is_empty());
    assert_eq!(env.retire_live_hosts().await, 0);
}

#[tokio::test]
async fn guest_run_provider_401_fails_as_infra_and_retires_host() {
    let env = IsolatedEnv::new(true);
    let mock_server = start_mock_provider(MockMode::Unauthorized401).await;

    let (status, stderr, guest_json, _, _) = env
        .run_guest_live_status(&mock_server.base_url(), None, None)
        .await;
    assert!(!status.success());
    assert!(stderr.contains("401"), "unexpected stderr: {stderr}");
    let infra = &guest_json["infraFailed"];
    assert!(infra.is_object());
    assert!(infra["infraError"].as_str().unwrap().contains("401"));
    assert_eq!(infra["evidence"]["execution"]["state"]["kind"], "failed");
    assert!(infra.get("settlement").is_none());
    assert!(env.host_run_dirs().is_empty());
    assert_eq!(env.retire_live_hosts().await, 0);
}
