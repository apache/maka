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

use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::process::{Command as StdCommand, Output, Stdio};
use std::time::{Duration, Instant};

struct TestEnv {
    _root: tempfile::TempDir,
    bundle: PathBuf,
    tasks_dir: PathBuf,
    tmp: PathBuf,
}

impl TestEnv {
    fn new() -> Self {
        let root = tempfile::tempdir().expect("tempdir");
        let base = std::fs::canonicalize(root.path()).unwrap_or_else(|_| root.path().to_path_buf());
        let (bundle, tasks_dir, tmp) = (base.join("bundle"), base.join("tasks"), base.join("t"));
        for dir in [&bundle, &tasks_dir, &tmp] {
            std::fs::create_dir_all(dir).unwrap();
        }
        for bin in ["maka", "maka-python-worker", "maka-eval"] {
            std::fs::write(bundle.join(bin), b"").unwrap();
        }
        Self {
            _root: root,
            bundle,
            tasks_dir,
            tmp,
        }
    }

    fn task(&self, parent: &Path, name: &str, timeout_sec: Option<f64>) -> PathBuf {
        let dir = parent.join(name);
        std::fs::create_dir_all(&dir).unwrap();
        let mut toml = format!("[task]\nname = \"{name}\"\n");
        if let Some(secs) = timeout_sec {
            toml.push_str(&format!("[agent]\ntimeout_sec = {secs}\n"));
        }
        std::fs::write(dir.join("task.toml"), toml).unwrap();
        dir
    }

    fn cmd(&self, out_dir: &Path, args: &[&str]) -> StdCommand {
        let bin = std::env::var_os("CARGO_BIN_EXE_maka-eval")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(env!("CARGO_BIN_EXE_maka-eval")));
        let mut cmd = StdCommand::new(bin);
        cmd.env("EVAL_API_KEY", "sk-secret-api-key")
            .args(["batch", "--out", out_dir.to_str().unwrap()])
            .args(args);
        cmd
    }

    fn run(&self, out_dir: &Path, args: &[&str]) -> Output {
        self.cmd(out_dir, args)
            .output()
            .expect("execute maka-eval batch")
    }

    fn single_cmd(&self, out_dir: &Path, args: &[&str]) -> StdCommand {
        let mut full = vec![
            "--bundle-dir",
            self.bundle.to_str().unwrap(),
            "--provider",
            "deepseek",
            "--model",
            "deepseek-chat",
            "--api-key-env",
            "EVAL_API_KEY",
        ];
        full.extend_from_slice(args);
        self.cmd(out_dir, &full)
    }

    fn fake_harbor(&self, behavior: Value) -> (PathBuf, PathBuf, PathBuf) {
        let dir = self.tmp.join("hb");
        std::fs::create_dir_all(&dir).unwrap();
        let (behavior_path, log_path, mjs) = (
            dir.join("b.json"),
            dir.join("inv.jsonl"),
            dir.join("hb.mjs"),
        );
        std::fs::write(&behavior_path, serde_json::to_vec(&behavior).unwrap()).unwrap();
        let script = format!(
            r#"#!/usr/bin/env node
import {{ appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync }} from "node:fs";
import {{ basename, join }} from "node:path";
const args = process.argv.slice(2);
if (args[0] !== "run") process.exit(2);
let cfgPath;
for (let i = 1; i < args.length; i++) {{
  if (args[i] === "-c" && i + 1 < args.length) cfgPath = args[++i];
  else if (args[i] === "--verifier-env" && i + 1 < args.length) i++;
  else process.exit(2);
}}
const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
const task = basename(cfg.tasks[0].path), kw = cfg.agents[0].kwargs;
const behavior = JSON.parse(readFileSync({}, "utf8"));
const rule = behavior[`${{task}}|${{kw.thinking_level ?? "none"}}|${{kw.model_id}}`] ?? behavior["*"];
if (!rule) process.exit(3);
appendFileSync({}, JSON.stringify({{ task, thinkingLevel: kw.thinking_level ?? null, timeoutMs: kw.timeout_ms ?? null }}) + "\n");
if (rule.startedFile) writeFileSync(rule.startedFile, "1");
if (rule.releaseFile) {{
  const buf = new Int32Array(new SharedArrayBuffer(4));
  for (let i = 0; i < 500 && !existsSync(rule.releaseFile); i++) Atomics.wait(buf, 0, 0, 20);
  if (!existsSync(rule.releaseFile)) process.exit(4);
}}
const tDir = join(cfg.jobs_dir, cfg.job_name, "trial-0"), mDir = join(tDir, "agent", "maka");
mkdirSync(mDir, {{ recursive: true }});
if (rule.guestResult) writeFileSync(join(mDir, "guest-result.json"), JSON.stringify(rule.guestResult));
if (!rule.omitTranscript) writeFileSync(join(mDir, "transcript.json"), "{{}}\n");
writeFileSync(join(tDir, "result.json"), JSON.stringify(rule.trialResult));
process.exit(rule.exitCode ?? 0);
"#,
            serde_json::to_string(&behavior_path).unwrap(),
            serde_json::to_string(&log_path).unwrap(),
        );
        std::fs::write(&mjs, script).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&mjs, std::fs::Permissions::from_mode(0o755)).unwrap();
            (mjs, behavior_path, log_path)
        }
        #[cfg(windows)]
        {
            let cmd = dir.join("hb.cmd");
            std::fs::write(&cmd, "@node \"%~dp0hb.mjs\" %*\r\n").unwrap();
            (cmd, behavior_path, log_path)
        }
    }
}

fn read_json(path: &Path) -> Value {
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn read_invocations(path: &Path) -> Vec<Value> {
    if !path.is_file() {
        return Vec::new();
    }
    std::fs::read_to_string(path)
        .unwrap()
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

fn evidence(input: u64, output: u64, known_usd: f64, unvalued: u64, unpriced: u64) -> Value {
    json!({
        "stepsObserved": 2,
        "execution": { "sessionId": "s1", "turnId": "t1", "runId": "00000000-0000-0000-0000-000000000001", "highWater": 10, "state": { "kind": "completed" } },
        "hostUsage": {
            "through": { "schemaVersion": 1, "stateDomain": "usage", "sequence": 1, "auxiliarySequence": 0, "cellSequence": 0, "queryDigest": "d0" },
            "summary": {
                "models": {
                    "calls": 2, "success": 2, "error": 0, "aborted": 0, "unknown": 0, "durationMs": 200.0,
                    "input": { "known": input, "missing": 0 }, "output": { "known": output, "missing": 0 },
                    "cacheRead": { "known": 0, "missing": 0 }, "cacheWrite": { "known": 0, "missing": 0 }, "reasoning": { "known": 0, "missing": 0 },
                    "cost": { "knownUsd": known_usd, "unvalued": unvalued, "unpriced": unpriced }
                },
                "tools": { "calls": 1, "success": 1, "error": 0, "unknown": 0, "rejected": 0, "durationMs": 50.0, "meanLatencyMs": 50.0 },
                "byProvider": [], "byModel": [], "byTool": [], "pending": { "models": 0, "tools": 0 }
            }
        }
    })
}

fn scored_rule(
    reward: f64,
    input: u64,
    output: u64,
    metering: Value,
    known_usd: f64,
    unvalued: u64,
    unpriced: u64,
) -> Value {
    json!({
        "guestResult": { "completed": { "evidence": evidence(input, output, known_usd, unvalued, unpriced), "settlement": { "metering": metering, "inputTokens": input, "cacheTokens": 0, "outputTokens": output } } },
        "trialResult": { "verifier_result": { "rewards": { "reward": reward } }, "exception_info": Value::Null }
    })
}

#[test]
fn batch_matrix_resume_retry_and_paired_report() {
    let env = TestEnv::new();
    env.task(&env.tasks_dir, "task-a", Some(12.0));
    env.task(&env.tasks_dir, "task-b", Some(25.0));
    let subjects = env.tmp.join("subjects.json");
    std::fs::write(
        &subjects,
        serde_json::to_vec(&json!([
            { "id": "base", "bundleDir": env.bundle, "provider": "deepseek", "model": "deepseek-chat", "apiKeyEnv": "EVAL_API_KEY", "thinkingLevel": "low" },
            { "id": "cand", "bundleDir": env.bundle, "provider": "deepseek", "modelId": "deepseek-chat", "apiKeyEnv": "EVAL_API_KEY", "thinkingLevel": "high" }
        ]))
        .unwrap(),
    )
    .unwrap();
    let (harbor_bin, behavior_path, log_path) = env.fake_harbor(json!({
        "task-a|low|deepseek-chat": scored_rule(0.0, 100, 20, json!({ "complete": { "costUsd": 0.01 } }), 0.01, 0, 0),
        "task-a|high|deepseek-chat": scored_rule(1.0, 150, 30, json!({ "complete": { "costUsd": 0.03 } }), 0.03, 0, 0),
        "task-b|low|deepseek-chat": scored_rule(1.0, 100, 20, json!({ "complete": {} }), 0.012, 1, 1),
        "task-b|high|deepseek-chat": {
            "guestResult": { "infraFailed": { "infraError": "container OOM", "evidence": evidence(999, 999, 9.99, 0, 0) } },
            "trialResult": { "verifier_result": Value::Null, "exception_info": { "exception_type": "MakaInfraError", "message": "oom" } },
            "omitTranscript": true, "exitCode": 1
        }
    }));

    let out_dir = env.tmp.join("matrix-out");
    let hb = harbor_bin.to_str().unwrap();
    let initial = env.run(
        &out_dir,
        &[
            "--tasks-dir",
            env.tasks_dir.to_str().unwrap(),
            "--subjects-file",
            subjects.to_str().unwrap(),
            "--harbor-bin",
            hb,
            "--concurrency",
            "2",
        ],
    );
    assert!(!initial.status.success());
    let invs = read_invocations(&log_path);
    assert_eq!(invs.len(), 4);
    assert!(
        invs.iter()
            .all(|v| (v["task"] == "task-a" && v["timeoutMs"] == 12_000)
                || (v["task"] == "task-b" && v["timeoutMs"] == 25_000))
    );

    let s1 = read_json(&out_dir.join("summary.json"));
    assert_eq!(s1["subjects"][0]["meanReward"], 0.5);
    assert_eq!(s1["subjects"][0]["unpricedTrials"], 1);
    assert_eq!(s1["subjects"][0]["completeCostUsd"], Value::Null);
    assert!((s1["subjects"][0]["knownCostUsd"].as_f64().unwrap() - 0.022).abs() < 1e-12);
    assert_eq!(s1["subjects"][1]["scoredTrials"], 1);
    assert_eq!(s1["subjects"][1]["infraFailedTrials"], 1);
    assert_eq!(s1["subjects"][1]["meanReward"], 1.0);
    assert!((s1["subjects"][1]["completeCostUsd"].as_f64().unwrap() - 0.03).abs() < 1e-12);

    // Delete one pending cell; --resume runs only that cell and skips infra_failed.
    std::fs::remove_file(&log_path).unwrap();
    std::fs::remove_file(out_dir.join("cells/task-a/base/r1/cell.json")).unwrap();
    assert!(
        !env.run(&out_dir, &["--harbor-bin", hb, "--resume"])
            .status
            .success()
    );
    let resumed_invs = read_invocations(&log_path);
    assert_eq!(resumed_invs.len(), 1);
    assert_eq!(resumed_invs[0]["task"], "task-a");

    // Flip infra_failed cell to lower_bound scored and run --retry-infra.
    let mut updated = read_json(&behavior_path);
    updated["task-b|high|deepseek-chat"] =
        scored_rule(1.0, 110, 25, json!("lower_bound"), 0.015, 0, 0);
    std::fs::write(&behavior_path, serde_json::to_vec(&updated).unwrap()).unwrap();
    std::fs::remove_file(&log_path).unwrap();
    let retried = env.run(&out_dir, &["--harbor-bin", hb, "--retry-infra"]);
    assert!(
        retried.status.success(),
        "{}",
        String::from_utf8_lossy(&retried.stderr)
    );
    let retry_invs = read_invocations(&log_path);
    assert_eq!(retry_invs.len(), 1);
    assert_eq!(retry_invs[0]["task"], "task-b");
    assert_eq!(
        read_json(&out_dir.join("cells/task-b/cand/r1/cell.json"))["attempt"],
        2
    );

    let s2 = read_json(&out_dir.join("summary.json"));
    assert_eq!(s2["subjects"][1]["lowerBoundTrials"], 1);
    assert_eq!(s2["subjects"][1]["completeCostUsd"], Value::Null);
    assert!((s2["subjects"][1]["knownCostUsd"].as_f64().unwrap() - 0.045).abs() < 1e-12);
    let csv = std::fs::read_to_string(out_dir.join("paired.csv")).unwrap();
    assert!(csv.contains("base,cand,task-a,1,win,scored,scored,0,1,0.01,0.03,"));
    assert!(csv.contains("base,cand,task-b,1,tie,scored,scored,1,1,,,"));
}

#[test]
fn batch_single_subject_and_data_safety() {
    let env = TestEnv::new();
    let task_ok = env.task(&env.tasks_dir, "task-ok", None);
    env.task(&env.tasks_dir, "task-2", None);
    let ok_rule = scored_rule(
        1.0,
        50,
        10,
        json!({ "complete": { "costUsd": 0.005 } }),
        0.005,
        0,
        0,
    );
    let (harbor_bin, behavior_path, log_path) = env.fake_harbor(json!({ "*": ok_rule.clone() }));
    let hb = harbor_bin.to_str().unwrap();

    // Flat single-subject CLI sweep with --repeats 2 omits paired.csv.
    let single_out = env.tmp.join("single-out");
    let sweep = env
        .single_cmd(
            &single_out,
            &[
                "--tasks-dir",
                env.tasks_dir.to_str().unwrap(),
                "--harbor-bin",
                hb,
                "--repeats",
                "2",
                "--concurrency",
                "2",
            ],
        )
        .output()
        .expect("execute maka-eval batch");
    assert!(
        sweep.status.success(),
        "{}",
        String::from_utf8_lossy(&sweep.stderr)
    );
    assert_eq!(read_invocations(&log_path).len(), 4);
    assert_eq!(
        read_json(&single_out.join("summary.json"))["subjects"][0]["subject"],
        "default"
    );
    assert!(!single_out.join("paired.csv").exists());

    // Refuse overwriting an existing batch run and fail closed on corrupt cell.json.
    let overwrite = env
        .single_cmd(&single_out, &["--task", task_ok.to_str().unwrap()])
        .output()
        .expect("execute maka-eval batch");
    assert!(String::from_utf8_lossy(&overwrite.stderr).contains("already contains plan.json"));

    std::fs::write(
        single_out.join("cells/task-ok/default/r1/cell.json"),
        b"{corrupt",
    )
    .unwrap();
    assert!(
        String::from_utf8_lossy(&env.run(&single_out, &["--resume"]).stderr)
            .contains("corrupt cell record")
    );

    // Reject unknown keys in --subjects-file before invoking Harbor or creating --out.
    let bad_subjects = env.tmp.join("bad-subjects.json");
    std::fs::write(
        &bad_subjects,
        serde_json::to_vec(&json!([{
            "id": "bad", "bundleDir": env.bundle, "provider": "deepseek",
            "model": "deepseek-chat", "apiKeyEnv": "EVAL_API_KEY", "sandbox_mode": "read-only"
        }]))
        .unwrap(),
    )
    .unwrap();
    let bad_out = env.tmp.join("bad-subjects-out");
    let bad = env.run(
        &bad_out,
        &[
            "--task",
            task_ok.to_str().unwrap(),
            "--subjects-file",
            bad_subjects.to_str().unwrap(),
            "--harbor-bin",
            env.tmp.join("never-called").to_str().unwrap(),
        ],
    );
    assert!(!bad.status.success());
    let bad_stderr = String::from_utf8_lossy(&bad.stderr);
    assert!(
        bad_stderr.contains("unknown field") && bad_stderr.contains("sandbox_mode"),
        "{bad_stderr}"
    );
    assert!(!bad_out.exists());

    // Reject concurrent --resume while another batch writer holds the output directory lock.
    let (started, release) = (env.tmp.join("started"), env.tmp.join("release"));
    let mut gated = ok_rule;
    gated["startedFile"] = json!(started);
    gated["releaseFile"] = json!(release);
    std::fs::write(
        &behavior_path,
        serde_json::to_vec(&json!({ "*": gated })).unwrap(),
    )
    .unwrap();
    std::fs::remove_file(&log_path).unwrap();

    let locked_out = env.tmp.join("locked-out");
    let mut child = env
        .single_cmd(
            &locked_out,
            &["--task", task_ok.to_str().unwrap(), "--harbor-bin", hb],
        )
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while !started.exists() {
        if child.try_wait().unwrap().is_some() || Instant::now() >= deadline {
            let _ = child.kill();
            let out = child.wait_with_output().unwrap();
            panic!(
                "first batch did not reach harbor: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let concurrent = env.run(&locked_out, &["--harbor-bin", hb, "--resume"]);
    std::fs::write(&release, b"1").unwrap();
    let first = child.wait_with_output().unwrap();

    assert!(!concurrent.status.success());
    assert!(String::from_utf8_lossy(&concurrent.stderr).contains("locked"));
    assert!(
        first.status.success(),
        "{}",
        String::from_utf8_lossy(&first.stderr)
    );
    assert_eq!(read_invocations(&log_path).len(), 1);
    assert_eq!(
        read_json(&locked_out.join("summary.json"))["subjects"][0]["meanReward"],
        1.0
    );
}
