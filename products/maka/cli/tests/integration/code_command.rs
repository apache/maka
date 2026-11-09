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

use maka_agent_facts::cells::{CellId, CellOwner, CellReturnedResult, CellStatus};
use maka_agent_facts::execution::SandboxMode;
use maka_agent_facts::tool_call::ToolSettlement;
use maka_event_log::{EventLog, StoreError};
use serde_json::json;

#[tokio::test]
async fn binary_runs_journaled_file_tools_and_reconstructs_the_standalone_cell_after_exit() {
    let directory = tempfile::tempdir().unwrap();
    let log_path = directory.path().join("root");
    let file_path = directory.path().canonicalize().unwrap().join("output.txt");
    let source = format!(
        "text('writing'); await tools.Write({}); return await tools.Read({});",
        json!({"path":file_path, "content":"hello from Rust"}),
        json!({"path":file_path})
    );
    let mut child = Command::new(crate::maka_executable())
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
    assert_eq!(response["output"]["result"]["ok"], true);
    assert_eq!(
        response["output"]["result"]["value"]["content"],
        "hello from Rust"
    );
    assert_eq!(
        response["output"]["content"],
        json!([{"kind":"text","text":"writing"}])
    );
    assert_eq!(
        std::fs::read_to_string(file_path).unwrap(),
        "hello from Rust"
    );
    let root = maka_event_log::root_store::RootStore::open(
        std::sync::Arc::new(
            maka_event_log::root::RootOwner::open(
                &log_path,
                &maka_event_log::root::RootNamespaces::for_current_account().unwrap(),
            )
            .unwrap(),
        ),
        &maka_product_native::root_migrations(),
    )
    .await
    .unwrap();
    assert_eq!(response["output"]["state"], "completed");
    assert!(response["error"].is_null());
    assert_eq!(
        response["settlement"],
        json!({"cellError":null,"workError":null,"rootError":null})
    );
    let session_id = response["sessionId"].as_str().unwrap();
    let cell_id: CellId = serde_json::from_value(response["cellId"].clone()).unwrap();
    let data = root.data_writer().unwrap();
    let cells = maka_agent_state::cells::CellsStore::new(data.clone());
    let cell = cells.read(session_id, cell_id).await.unwrap().unwrap();
    assert_eq!(
        cell.owner,
        CellOwner::Standalone {
            session: session_id.into()
        }
    );
    assert_eq!(cell.id, cell_id);
    assert_eq!(
        cells
            .content(session_id, cell_id, cell.source.clone())
            .await
            .unwrap(),
        source.as_bytes()
    );
    assert!(cell.vm.is_some());
    assert!(cell.vm_uncertainty.is_none());
    assert_eq!(cell.children.len(), 2);
    let mut names = Vec::new();
    for child in cell.children.values() {
        names.push(child.name.as_str());
        assert!(child.admitted);
        assert!(child.rejected.is_none());
        assert!(
            child.reference.is_none(),
            "local tools do not manufacture Host mutation references"
        );
        let returned = child
            .local_result
            .as_ref()
            .expect("original local tool result");
        assert_eq!(returned.settlement, ToolSettlement::Returned);
        assert!(!returned.is_error);
        let body = cells
            .content(session_id, cell_id, returned.result.clone())
            .await
            .unwrap();
        let manifest: maka_agent_facts::artifact::ToolReturn<CellReturnedResult> =
            serde_json::from_slice(&body).unwrap();
        assert!(!manifest.body.is_error);
        assert!(
            manifest.body.projection.is_none(),
            "standalone tools do not create model-context acceptance"
        );
    }
    names.sort_unstable();
    assert_eq!(names, ["Read", "Write"]);
    let CellStatus::Completed { result, .. } = &cell.status else {
        panic!("original standalone Cell must retain its terminal result");
    };
    let completed = cells
        .content(session_id, cell_id, result.clone())
        .await
        .unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&completed).unwrap(),
        response["output"]["result"]
    );
    let session = root
        .session(session_id)
        .await
        .unwrap()
        .get::<serde_json::Value>()
        .await
        .unwrap()
        .unwrap();
    let configuration = &session.configuration;
    let binding: maka_sandbox::workspace::BindingRef =
        serde_json::from_value(configuration["workspace"].clone()).unwrap();
    let workspace = root
        .workspace_binding::<serde_json::Value>(binding.id)
        .await
        .unwrap()
        .unwrap();
    let cwd = std::path::Path::new(workspace.workspace["path"].as_str().unwrap());
    assert!(cwd.is_absolute());
    assert_eq!(
        cwd.canonicalize().unwrap(),
        directory.path().canonicalize().unwrap()
    );
    assert_eq!(
        serde_json::from_value::<SandboxMode>(configuration["sandboxMode"].clone()).unwrap(),
        SandboxMode::WorkspaceWrite
    );
    assert_eq!(
        serde_json::from_value::<maka_agent_facts::execution::ApprovalPolicy>(
            configuration["approvalPolicy"].clone()
        )
        .unwrap(),
        maka_agent_facts::execution::ApprovalPolicy::OnRequest
    );
    let inspection = maka_agent_state::session_history::inspection::read(&data, session_id)
        .await
        .unwrap();
    assert!(
        inspection.facts.is_empty(),
        "a standalone Cell does not invent an Agent Run"
    );
    assert_eq!(inspection.through, None);
    assert!(!inspection.truncated);
    root.close().await.unwrap();
    let inspect = Command::new(crate::maka_executable())
        .args(["inspect", "--root"])
        .arg(&log_path)
        .args(["--session", session_id])
        .output()
        .unwrap();
    assert!(inspect.status.success());
    let reopened: serde_json::Value = serde_json::from_slice(&inspect.stdout).unwrap();
    assert_eq!(reopened, serde_json::to_value(inspection).unwrap());

    let foreign = directory.path().join("foreign.sqlite");
    std::fs::write(&foreign, b"not a Maka database").unwrap();
    assert!(matches!(
        EventLog::open(&foreign).await,
        Err(error) if matches!(error.underlying(), StoreError::Sqlite(_))
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
        let mut child = Command::new(crate::maka_executable())
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
