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

use maka_agent_facts::{
    event::{EventWrite, Fact, Invocation, InvocationInput, RuntimeEvent},
    tool_call::ToolCallIdentity,
    tools::{ToolError, ToolJournal},
};
use maka_event_log::EventLog;
use maka_mcp::{Connection, ServerConfiguration};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio_util::sync::CancellationToken;
fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/server.mjs")
}
fn config(mode: &str, record: &Path) -> ServerConfiguration {
    serde_json::from_value(json!({"name":"test","transport":{"type":"stdio","command":which::which("node").unwrap(),"args":[fixture(),mode,record],"cwd":record.parent().unwrap()},"startupTimeoutMs":3000})).unwrap()
}
async fn journal(connection: Connection, name: &str, input: Value) -> Value {
    let directory = tempfile::tempdir().unwrap();
    let log = Arc::new(
        EventLog::open(&directory.path().join("events.sqlite"))
            .await
            .unwrap(),
    );
    let invocation = Invocation {
        session_id: "session".into(),
        turn_id: "turn".into(),
        run_id: "run".into(),
        invocation_id: "invocation".into(),
    };
    log.create_session("session", "create", &json!({}), 1)
        .await
        .unwrap();
    log.append(
        &EventWrite::plain(RuntimeEvent::new(
            invocation.clone(),
            Fact::InvocationOpened {
                configuration: None,
                input: InvocationInput::Code {
                    source: "test".into(),
                },
            },
        ))
        .unwrap(),
    )
    .await
    .unwrap();
    let name = name.to_owned();
    let argument = input.clone();
    let result = ToolJournal::new(log.clone(), invocation)
        .invoke_call_with(
            "call".into(),
            ToolCallIdentity::standalone("call".into()),
            name.clone(),
            input,
            CancellationToken::new(),
            move |cancel| Box::pin(async move { connection.call(name, argument, cancel).await }),
        )
        .await
        .unwrap();
    Arc::try_unwrap(log).ok().unwrap().close().await.unwrap();
    result
}
fn records(path: &Path) -> Vec<Value> {
    std::fs::read_to_string(path)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

async fn wait_for_method(record: &Path, method: &str) {
    tokio::time::timeout(Duration::from_secs(5), async {
        let mut poll = tokio::time::interval(Duration::from_millis(10));
        loop {
            poll.tick().await;
            match std::fs::read_to_string(record) {
                Ok(contents) => {
                    if contents.lines().any(|line| {
                        serde_json::from_str::<Value>(line)
                            .is_ok_and(|event| event["method"] == method)
                    }) {
                        return;
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => panic!("cannot read MCP fixture record: {error}"),
            }
        }
    })
    .await
    .unwrap_or_else(|_| panic!("MCP fixture did not receive {method}"));
}

async fn http_server(mode: &str, record: &Path) -> (tokio::process::Child, String) {
    let server = tokio::process::Command::new(which::which("node").unwrap())
        .arg(fixture())
        .arg(mode)
        .arg(record)
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let url = tokio::time::timeout(Duration::from_secs(5), async {
        let mut poll = tokio::time::interval(Duration::from_millis(10));
        loop {
            poll.tick().await;
            match std::fs::read_to_string(record.with_extension("url")) {
                Ok(url) => return url,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => panic!("cannot read MCP fixture endpoint: {error}"),
            }
        }
    })
    .await
    .expect("MCP HTTP fixture publishes its listening address");
    (server, url)
}

#[cfg(unix)]
fn child_gone(record: &Path) -> bool {
    let pid = records(record)[0]["pid"].as_i64().unwrap() as i32;
    // SAFETY: signal zero only probes the child PID and sends no signal.
    if unsafe { libc::kill(pid, 0) } == 0 {
        return false;
    }
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::ESRCH),
        "MCP child probe must confirm absence"
    );
    true
}

#[cfg(unix)]
fn assert_gone(record: &Path) {
    assert!(
        child_gone(record),
        "MCP child must be reaped before close returns"
    );
}
#[tokio::test]
async fn stdio_pages_preserve_result_envelopes_media_and_explicit_tool_selection() {
    let dir = tempfile::tempdir().unwrap();
    let record = dir.path().join("record");
    let mut config = config("normal", &record);
    config.tools = Some(vec![
        "echo".into(),
        "error".into(),
        "media".into(),
        "change".into(),
    ]);
    config.read_only_tools = vec!["echo".into()];
    let connection = Connection::connect(config, Default::default())
        .await
        .unwrap();
    assert_eq!(
        connection
            .tools()
            .iter()
            .map(|tool| tool.remote_name.as_str())
            .collect::<BTreeSet<_>>(),
        BTreeSet::from(["echo", "error", "media", "change"]),
        "selection includes the tool returned on the second discovery page"
    );
    assert!(
        connection
            .tools()
            .iter()
            .find(|tool| tool.remote_name == "echo")
            .unwrap()
            .read_only
    );
    assert!(
        !connection
            .tools()
            .iter()
            .find(|tool| tool.remote_name == "media")
            .unwrap()
            .read_only,
        "server readOnlyHint cannot authorize a tool"
    );
    let result = journal(connection.clone(), "echo", json!({"n":7})).await;
    assert_eq!(result["structuredContent"], json!({"n":7}));
    assert_eq!(result["_meta"]["fixture"], true);
    let error = journal(connection.clone(), "error", json!({"reason":"expected"})).await;
    assert_eq!(error["isError"], true);
    assert_eq!(error["content"][0]["text"], "business failed");
    let media = journal(connection.clone(), "media", json!({})).await;
    assert_eq!(media["content"].as_array().unwrap().len(), 3);
    assert_eq!(
        media["content"][0]["annotations"]["audience"],
        json!(["assistant"])
    );
    assert_eq!(media["content"][2]["type"], "resource_link");
    assert!(matches!(
        connection
            .call("hang".into(), json!({}), CancellationToken::new())
            .await,
        Err(ToolError::Failed(_))
    ));
    connection.close().await.unwrap();
    #[cfg(unix)]
    assert_gone(&record);
}
#[tokio::test]
async fn streamable_http_uses_configured_headers_and_normal_tool_calls() {
    for mode in ["http", "http-sse"] {
        let dir = tempfile::tempdir().unwrap();
        let record = dir.path().join("record");
        let (mut server, url) = http_server(mode, &record).await;
        let config=serde_json::from_value(json!({"name":"http","transport":{"type":"streamable_http","url":url,"headers":{"authorization":"Bearer fixture"}}})).unwrap();
        let connection = Connection::connect(config, Default::default())
            .await
            .unwrap();
        let result = journal(connection.clone(), "echo", json!({"http":true})).await;
        assert_eq!(result["structuredContent"], json!({"http":true}));
        connection.close().await.unwrap();
        let events = records(&record);
        assert!(
            events
                .iter()
                .filter(|v| v["http"] == "POST")
                .all(|v| v["authorization"] == "Bearer fixture")
        );
        server.kill().await.unwrap();
        server.wait().await.unwrap();
    }
}

#[tokio::test]
async fn startup_timeout_reaps_the_process() {
    let dir = tempfile::tempdir().unwrap();
    let record = dir.path().join("record");
    let mut config = config("startup-hang", &record);
    config.startup_timeout_ms = 1000;
    assert!(
        Connection::connect(config, Default::default())
            .await
            .is_err()
    );
    #[cfg(unix)]
    assert_gone(&record);
}

#[cfg(unix)]
#[tokio::test]
async fn dropped_startup_reaps_the_process() {
    let dir = tempfile::tempdir().unwrap();
    let record = dir.path().join("record");
    let mut config = config("startup-hang", &record);
    config.startup_timeout_ms = 300_000;
    let task = tokio::spawn(Connection::connect(config, Default::default()));
    wait_for_method(&record, "initialize").await;
    task.abort();
    assert!(
        task.await
            .err()
            .expect("startup observer was aborted")
            .is_cancelled()
    );
    tokio::time::timeout(Duration::from_secs(5), async {
        let mut poll = tokio::time::interval(Duration::from_millis(10));
        while !child_gone(&record) {
            poll.tick().await;
        }
    })
    .await
    .expect("dropped startup still owns and reaps its child");
}
#[tokio::test]
async fn cancellation_without_response_evidence_and_catalog_changes_retire_names() {
    let dir = tempfile::tempdir().unwrap();
    let record = dir.path().join("record");
    let connection = Connection::connect(config("normal", &record), Default::default())
        .await
        .unwrap();
    let cancel = CancellationToken::new();
    let observer = tokio::spawn({
        let c = connection.clone();
        let token = cancel.clone();
        async move { c.call("hang".into(), json!({}), token).await }
    });
    wait_for_method(&record, "tools/call").await;
    cancel.cancel();
    let observed = observer.await.unwrap();
    assert!(
        matches!(observed, Err(ToolError::OutcomeUnknown(_))),
        "{observed:?}"
    );
    assert!(!connection.available());
    connection.close().await.unwrap();
    #[cfg(unix)]
    assert_gone(&record);
    assert_eq!(
        records(&record)
            .iter()
            .filter(|event| event["method"] == "notifications/cancelled")
            .count(),
        1
    );
    let record = dir.path().join("changed");
    let connection = Connection::connect(config("normal", &record), Default::default())
        .await
        .unwrap();
    journal(connection.clone(), "change", json!({})).await;
    tokio::time::timeout(Duration::from_secs(5), async {
        let mut poll = tokio::time::interval(Duration::from_millis(10));
        while connection.available() {
            poll.tick().await;
        }
    })
    .await
    .expect("tools/list_changed retires the captured catalog");
    assert!(
        connection
            .call("echo".into(), json!({}), CancellationToken::new())
            .await
            .is_err()
    );
    connection.close().await.unwrap();
    #[cfg(unix)]
    assert_gone(&record);
}
#[tokio::test]
async fn unacknowledged_timeout_is_unknown_and_never_retried() {
    let dir = tempfile::tempdir().unwrap();
    let record = dir.path().join("record");
    let mut config = config("ignore-cancel", &record);
    config.call_timeout_ms = 50;
    let connection = Connection::connect(config, Default::default())
        .await
        .unwrap();
    assert!(matches!(
        connection
            .call("hang".into(), json!({}), CancellationToken::new())
            .await,
        Err(ToolError::OutcomeUnknown(_))
    ));
    assert!(!connection.available());
    connection.close().await.unwrap();
    #[cfg(unix)]
    assert_gone(&record);
    assert_eq!(
        records(&record)
            .iter()
            .filter(|event| event["method"] == "tools/call")
            .count(),
        1
    );
}

#[tokio::test]
async fn stdio_forwards_only_explicit_credentials() {
    if std::env::var_os("MAKA_MCP_ENV_PROBE").is_none() {
        let output = tokio::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "stdio_forwards_only_explicit_credentials",
                "--nocapture",
            ])
            .env("MAKA_MCP_ENV_PROBE", "1")
            .env("DATABASE_URL", "postgres://private-fixture")
            .env("HTTPS_PROXY", "http://private-fixture:secret@proxy.invalid")
            .env("MCP_ALLOWED_SECRET", "explicit-fixture")
            .kill_on_drop(true)
            .output()
            .await
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stdout)
        );
        return;
    }
    let directory = tempfile::tempdir().unwrap();
    let record = directory.path().join("record");
    let mut config = config("environment", &record);
    if let maka_mcp::TransportConfiguration::Stdio { env, pass_env, .. } = &mut config.transport {
        env.insert("MCP_EXPLICIT".into(), "configured".into());
        pass_env.push("MCP_ALLOWED_SECRET".into());
    }
    let connection = Connection::connect(config, Default::default())
        .await
        .unwrap();
    assert_eq!(
        records(&record)[1]["environment"],
        json!({"database":null,"proxy":null,"secret":"explicit-fixture","explicit":"configured","path":true})
    );
    connection.close().await.unwrap();
}

#[tokio::test]
async fn http_preserves_large_json_chunked_and_sse_results() {
    for mode in ["http-large-json", "http-large-chunked", "http-large-sse"] {
        let dir = tempfile::tempdir().unwrap();
        let record = dir.path().join("record");
        let (mut server, url) = http_server(mode, &record).await;
        let config = serde_json::from_value(json!({"name":"large","startupTimeoutMs":5000,"transport":{"type":"streamable_http","url":url}})).unwrap();
        let connection = Connection::connect(config, Default::default())
            .await
            .unwrap();
        let result = journal(connection.clone(), "echo", json!({})).await;
        assert_eq!(
            result["content"][0]["text"].as_str().unwrap().len(),
            16 * 1024 * 1024 + 1
        );
        assert_eq!(
            result["structuredContent"]["marker"],
            "large-result-complete"
        );
        connection.close().await.unwrap();
        server.kill().await.unwrap();
        server.wait().await.unwrap();
        assert_eq!(
            records(&record)
                .iter()
                .filter(|entry| entry["method"] == "tools/call")
                .count(),
            1
        );
    }
}

#[tokio::test]
async fn stdio_preserves_large_results_and_complete_catalog_pagination() {
    let dir = tempfile::tempdir().unwrap();
    let record = dir.path().join("record");
    let connection = Connection::connect(config("large-catalog", &record), Default::default())
        .await
        .unwrap();
    assert_eq!(connection.tools().len(), 1105);
    assert!(
        connection
            .tools()
            .iter()
            .any(|tool| tool.remote_name == "tool_1104")
    );
    connection.close().await.unwrap();
    let connection = Connection::connect(config("stdio-large", &record), Default::default())
        .await
        .unwrap();
    let result = journal(
        connection.clone(),
        "echo",
        json!({"marker":"stdio-large-complete"}),
    )
    .await;
    assert_eq!(
        result["content"][0]["text"].as_str().unwrap().len(),
        16 * 1024 * 1024 + 1
    );
    assert_eq!(
        result["structuredContent"]["marker"],
        "stdio-large-complete"
    );
    connection.close().await.unwrap();
    let result = Connection::connect(config("repeated-cursor", &record), Default::default()).await;
    assert!(matches!(result, Err(error) if error == "MCP pagination cursor repeats"));
}

#[tokio::test]
async fn explicit_startup_cancellation_returns_confirmed_child_cleanup() {
    let dir = tempfile::tempdir().unwrap();
    let record = dir.path().join("record");
    let mut settings = config("startup-hang", &record);
    settings.startup_timeout_ms = 300_000;
    let token = CancellationToken::new();
    let startup = tokio::spawn(Connection::connect_cancellable(
        settings,
        Default::default(),
        token.clone(),
    ));
    wait_for_method(&record, "initialize").await;
    token.cancel();
    let error = tokio::time::timeout(Duration::from_secs(5), startup)
        .await
        .unwrap()
        .unwrap()
        .err()
        .expect("cancelled startup");
    assert!(error.cleanup_confirmed, "{}", error.message);
    let pid = std::fs::read_to_string(record)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .find_map(|value| value["pid"].as_i64())
        .unwrap();
    #[cfg(unix)]
    assert_eq!(unsafe { libc::kill(pid as i32, 0) }, -1);
}
