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

use std::io::Write;
use std::process::{Command, Stdio};

use maka_agent_facts::event::Fact;
use maka_agent_facts::event::TerminalStatus;
use maka_agent_facts::execution::SandboxMode;
use maka_agent_facts::execution::ToolMode;
use maka_event_log::{EventLog, StoreError};
use serde_json::json;

#[tokio::test]
async fn binary_runs_journaled_file_tools_and_reconstructs_the_invocation_after_exit() {
    let directory = tempfile::tempdir().unwrap();
    let log_path = directory.path().join("root");
    let file_path = directory.path().canonicalize().unwrap().join("output.txt");
    let source = format!(
        "text('writing'); await tools.Write({}); return await tools.Read({});",
        json!({"path":file_path, "content":"hello from Rust"}),
        json!({"path":file_path})
    );
    let mut child = Command::new(env!("CARGO_BIN_EXE_maka"))
        .current_dir(directory.path())
        .args(["code", "--root"])
        .arg(&log_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(source.as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let response: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(response["output"]["ok"], true);
    assert_eq!(response["output"]["value"]["content"], "hello from Rust");
    assert_eq!(
        response["content"],
        json!([{"kind":"text","text":"writing"}])
    );
    assert_eq!(
        std::fs::read_to_string(file_path).unwrap(),
        "hello from Rust"
    );
    let root = maka_event_log::root_store::RootStore::open(std::sync::Arc::new(
        maka_event_log::root::RootOwner::open(
            &log_path,
            &maka_event_log::root::RootNamespaces::for_current_account().unwrap(),
        )
        .unwrap(),
    ))
    .await
    .unwrap();
    let session_id = response["invocation"]["session_id"].as_str().unwrap();
    let log = root.session(session_id).await.unwrap();
    let prefix = log
        .scoped_prefix(
            maka_agent_facts::event::LogScope::Session {
                id: session_id.into(),
            },
            10,
            16_384,
        )
        .await
        .unwrap();
    assert_eq!(
        prefix
            .events
            .iter()
            .map(|entry| entry.event.fact.kind())
            .collect::<Vec<_>>(),
        [
            "invocation_opened",
            "tool_dispatched",
            "tool_settled",
            "tool_dispatched",
            "tool_settled",
            "invocation_ended"
        ]
    );
    let id = response["invocation"]["invocation_id"].as_str().unwrap();
    let view = prefix.project_invocation(id);
    assert_eq!(view.terminal, Some(TerminalStatus::Completed));
    assert!(view.uncertain_operations.is_empty());
    let Fact::InvocationOpened {
        input: maka_agent_facts::input::InvocationInput::Code { source: recorded },
        configuration: Some(configuration),
    } = &prefix.events[0].event.fact
    else {
        panic!("code opening must retain source and configuration");
    };
    assert_eq!(recorded, &source);
    let cwd = std::path::Path::new(&configuration.cwd);
    assert!(cwd.is_absolute());
    // Windows canonicalize adds a verbatim prefix; current_dir need not do so.
    assert_eq!(
        cwd.canonicalize().unwrap(),
        directory.path().canonicalize().unwrap()
    );
    assert_eq!(configuration.sandbox_mode, SandboxMode::WorkspaceWrite);
    assert_eq!(
        configuration.approval_policy,
        maka_agent_facts::execution::ApprovalPolicy::OnRequest
    );
    assert_eq!(configuration.tool_mode, ToolMode::CodeMode);
    assert!(configuration.workspace_binding.is_some());
    assert!(configuration.model.is_none());
    root.close().await.unwrap();
    let inspect = Command::new(env!("CARGO_BIN_EXE_maka"))
        .args(["inspect", "--root"])
        .arg(&log_path)
        .args(["--session", session_id])
        .output()
        .unwrap();
    assert!(inspect.status.success());
    let reopened: serde_json::Value = serde_json::from_slice(&inspect.stdout).unwrap();
    assert_eq!(reopened["digest"], prefix.digest);

    let foreign = directory.path().join("foreign.sqlite");
    std::fs::write(&foreign, b"not a Maka database").unwrap();
    assert!(matches!(
        EventLog::open(&foreign).await,
        Err(StoreError::Sqlx(_))
    ));
    assert_eq!(std::fs::read(foreign).unwrap(), b"not a Maka database");
}

#[test]
fn code_presets_protect_metadata_and_only_explicit_bypass_disables_both_protections() {
    let directory = tempfile::tempdir().unwrap();
    std::fs::create_dir(directory.path().join(".agents")).unwrap();
    let target = directory
        .path()
        .canonicalize()
        .unwrap()
        .join(".agents/instructions.txt");
    let source = format!(
        "return await tools.Write({});",
        json!({"path":target,"content":"explicit"})
    );
    for (index, flags, allowed) in [
        (0, Vec::<&str>::new(), false),
        (1, vec!["--ask-for-approval", "never"], false),
        (2, vec!["--dangerously-bypass-approvals-and-sandbox"], true),
    ] {
        let mut child = Command::new(env!("CARGO_BIN_EXE_maka"))
            .current_dir(directory.path())
            .args(["code", "--root"])
            .arg(directory.path().join(format!("root-{index}")))
            .args(flags)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(source.as_bytes())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        let response: serde_json::Value = serde_json::from_slice(&output.stdout)
            .unwrap_or_else(|_| panic!("{}", String::from_utf8_lossy(&output.stderr)));
        assert_eq!(output.status.success(), allowed, "{response}");
        assert_eq!(
            target.exists(),
            allowed,
            "an unapproved write must leave no file"
        );
    }
    assert_eq!(std::fs::read_to_string(target).unwrap(), "explicit");
}
