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
    path::Path,
    process::{Child, Command, Stdio},
    sync::Arc,
    time::{Duration, Instant},
};

use maka_agent_facts::{
    configuration::{ModelSelection, policy::RuntimePolicy},
    execution::{SandboxMode, ThinkingLevel},
};
use maka_config::ConfigurationStore;
use maka_event_log::root::{RootNamespaces, RootOwner};

fn initialize(root: &Path, timeout: &str) -> Child {
    Command::new(crate::maka_executable())
        .args([
            "host",
            "init",
            "--settings-stdin",
            "--timeout-ms",
            timeout,
            "--root",
        ])
        .arg(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap()
}

#[tokio::test]
async fn public_init_persists_settings_from_stdin_and_rejects_reconfiguration() {
    let directory = tempfile::tempdir().unwrap();
    let workspace_dir = tempfile::tempdir().unwrap();
    let root = directory.path().join("root");
    let mut child = initialize(&root, "15000");
    let mut proxy = RuntimePolicy::default().network_proxy;
    proxy.enabled = true;
    proxy.port = 8443;
    proxy.auth_enabled = true;
    proxy.username = "bootstrap-user".into();
    let mut input = serde_json::to_vec(&serde_json::json!({
        "networkProxy": proxy,
        "proxyPassword": "private-bootstrap-proxy-secret",
        "chatDefaults": { "sandboxMode": "danger-full-access" },
        "projectDirectoryRoots": [{ "label": "workspace", "path": workspace_dir.path() }],
    }))
    .unwrap();
    // Complete valid input remains accepted beyond the former byte ceiling.
    input.resize(128 * 1024, b' ');
    child.stdin.take().unwrap().write_all(&input).unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let response: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    let namespaces = RootNamespaces::for_current_account().unwrap();
    let owner = Arc::new(RootOwner::open_existing(&root, &namespaces).unwrap());
    assert_eq!(response["rootId"], owner.root_id());
    let store = ConfigurationStore::for_root(owner).await.unwrap();
    let policy = store.runtime_policy().await.unwrap();
    assert_eq!(policy.revision, 2);
    assert_eq!(policy.policy.network_proxy, proxy);
    assert_eq!(
        policy.policy.chat_defaults.sandbox_mode,
        SandboxMode::DangerFullAccess
    );
    assert_eq!(
        store
            .network_configuration()
            .await
            .unwrap()
            .password
            .as_deref(),
        Some("private-bootstrap-proxy-secret")
    );
    store.close().await.unwrap();

    #[cfg(unix)]
    let socket_temp = tempfile::Builder::new()
        .prefix("mkt-")
        .tempdir_in("/tmp")
        .unwrap();
    let mut acp_command = Command::new(crate::maka_executable());
    acp_command
        .args(["acp", "--root"])
        .arg(&root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    acp_command.env("TMPDIR", socket_temp.path());
    let mut acp = acp_command.spawn().unwrap();
    let mut acp_stdin = acp.stdin.take().unwrap();
    let workspace_cwd =
        maka_fs_tools::workspace::project::host_path(&workspace_dir.path().canonicalize().unwrap())
            .unwrap()
            .to_owned();
    let mut reader = BufReader::new(acp.stdout.take().unwrap());
    let mut line = String::new();
    let initialize_request = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": { "protocolVersion": 1, "clientCapabilities": {} }
    });
    writeln!(acp_stdin, "{initialize_request}").unwrap();
    acp_stdin.flush().unwrap();
    let mut init_ok = false;
    while reader.read_line(&mut line).unwrap() > 0 {
        let message: serde_json::Value = serde_json::from_str(&line).unwrap();
        if message["id"] == 1 {
            assert!(message.get("error").is_none(), "{message}");
            init_ok = true;
            line.clear();
            break;
        }
        line.clear();
    }
    assert!(init_ok, "initialize response from maka acp");

    let session_request = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "session/new",
        "params": { "cwd": workspace_cwd, "mcpServers": [] }
    });
    writeln!(acp_stdin, "{session_request}").unwrap();
    acp_stdin.flush().unwrap();
    let mut session_response = None;
    while reader.read_line(&mut line).unwrap() > 0 {
        let message: serde_json::Value = serde_json::from_str(&line).unwrap();
        if message["id"] == 2 {
            session_response = Some(message);
            break;
        }
        line.clear();
    }
    drop(acp_stdin);
    let _ = acp.wait();
    let mut retire = Command::new(crate::maka_executable());
    retire.args(["host", "retire", "--root"]).arg(&root);
    #[cfg(unix)]
    retire.env("TMPDIR", socket_temp.path());
    let _ = retire.output();

    let session_response = session_response.expect("session/new response from maka acp");
    assert!(
        session_response.get("error").is_none(),
        "{session_response}"
    );
    assert!(
        session_response["result"]["sessionId"]
            .as_str()
            .is_some_and(|id| !id.is_empty()),
        "{session_response}"
    );
    let sandbox_option = session_response["result"]["configOptions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|option| option["id"] == "sandbox_mode")
        .unwrap();
    assert_eq!(sandbox_option["currentValue"], "danger_full_access");

    let mut child = initialize(&root, "15000");
    child.stdin.take().unwrap().write_all(b"{}").unwrap();
    assert!(!child.wait_with_output().unwrap().status.success());
    let owner = Arc::new(RootOwner::open_existing(&root, &namespaces).unwrap());
    let store = ConfigurationStore::for_root(owner).await.unwrap();
    assert_eq!(store.runtime_policy().await.unwrap(), policy);
    store.close().await.unwrap();
}

#[tokio::test]
async fn public_init_persists_connections_and_default_target_from_stdin() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("root");
    let mut child = initialize(&root, "15000");
    let input = serde_json::to_vec(&serde_json::json!({
        "connections": [
            {
                "slug": "eval-gateway",
                "name": "Eval Gateway",
                "provider": "openai-compatible",
                "configuration": {
                    "baseUrl": "http://127.0.0.1:18080/v1"
                },
                "apiKey": "private-bootstrap-api-key",
                "requestHeaders": {
                    "x-eval-harness": "maka-eval"
                },
                "enabled": true,
                "enabledModelIds": ["eval-model"],
                "modelOverrides": {
                    "eval-model": {
                        "contextWindow": 200000,
                        "inputLimit": 160000,
                        "maxOutputTokens": 16384,
                        "thinkingLevels": ["off", "medium"],
                        "defaultThinkingLevel": "off"
                    }
                },
                "requestBodyOverlay": {
                    "temperature": 0
                }
            },
            {
                "slug": "secondary-openai",
                "provider": "openai",
                "apiKey": "private-secondary-api-key",
                "enabled": false,
                "enabledModelIds": ["gpt-5"]
            }
        ],
        "defaultTarget": {
            "slug": "eval-gateway",
            "modelId": "eval-model"
        }
    }))
    .unwrap();
    child.stdin.take().unwrap().write_all(&input).unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let namespaces = RootNamespaces::for_current_account().unwrap();
    let owner = Arc::new(RootOwner::open_existing(&root, &namespaces).unwrap());
    let store = Arc::new(ConfigurationStore::for_root(owner).await.unwrap());
    let catalog = store.catalog().await.unwrap();
    assert_eq!(catalog.connections.len(), 2);
    let primary = catalog
        .connections
        .iter()
        .find(|row| row.slug == "eval-gateway")
        .unwrap();
    assert_eq!(primary.name, "Eval Gateway");
    assert_eq!(primary.enabled_model_ids, vec!["eval-model"]);
    assert_eq!(
        primary.request_body_overlay,
        Some(serde_json::json!({"temperature":0}))
    );
    let overrides = primary
        .model_overrides
        .as_ref()
        .and_then(|all| all.get("eval-model"))
        .unwrap();
    assert_eq!(overrides.context_window, Some(200000));
    assert_eq!(overrides.input_limit, Some(160000));
    assert_eq!(overrides.max_output_tokens, Some(16384));
    assert_eq!(
        overrides.thinking_levels,
        Some(vec![ThinkingLevel::Off, ThinkingLevel::Medium])
    );
    assert_eq!(overrides.default_thinking_level, Some(ThinkingLevel::Off));

    let secondary = catalog
        .connections
        .iter()
        .find(|row| row.slug == "secondary-openai")
        .unwrap();
    assert_eq!(secondary.name, "secondary-openai");
    assert!(!secondary.enabled);
    assert_eq!(
        secondary.configuration["baseUrl"],
        serde_json::json!("https://api.openai.com/v1")
    );

    let default_target = catalog.default_target.expect("default target");
    assert_eq!(default_target.connection_id, primary.connection_id);
    assert_eq!(default_target.model_id, "eval-model");

    let observed = store
        .observe_selected_model(ModelSelection {
            connection_id: primary.connection_id.clone(),
            model_id: "eval-model".into(),
        })
        .await
        .unwrap()
        .expect("selected model observation");
    assert_eq!(
        observed.credential.unwrap().credential().secret,
        "private-bootstrap-api-key"
    );
    assert_eq!(
        observed
            .request_headers
            .get("x-eval-harness")
            .map(String::as_str),
        Some("maka-eval")
    );
    store.shutdown().await.unwrap();
}

#[test]
fn public_init_rejects_invalid_settings_without_exposing_input() {
    let mut invalid_suffix = b"{}".to_vec();
    // JSON must be checked through EOF, including past the former byte ceiling.
    invalid_suffix.resize(128 * 1024, b' ');
    invalid_suffix.extend_from_slice(b"private-secret-invalid-suffix");
    for input in [
        Vec::new(),
        br#"{"unexpected":true}"#.to_vec(),
        b"private-secret-invalid-json".to_vec(),
        invalid_suffix,
        serde_json::to_vec(&serde_json::json!({
            "connections": [{
                "slug": "bad-url",
                "provider": "openai",
                "configuration": { "baseUrl": "https://user:private-secret@relay.test/v1" }
            }]
        }))
        .unwrap(),
        serde_json::to_vec(&serde_json::json!({
            "connections": [{
                "slug": "bad-subscription",
                "provider": "chatgpt",
                "configuration": { "baseUrl": "https://private-secret.test/v1" }
            }]
        }))
        .unwrap(),
        serde_json::to_vec(&serde_json::json!({
            "connections": [{
                "slug": "bad-limits",
                "provider": "openai",
                "modelOverrides": { "eval-model": { "contextWindow": 100, "inputLimit": 200 } }
            }]
        }))
        .unwrap(),
        serde_json::to_vec(&serde_json::json!({
            "connections": [{
                "slug": "bad-key",
                "provider": "openai",
                "apiKey": "private-secret\nwith-control-char"
            }]
        }))
        .unwrap(),
        serde_json::to_vec(&serde_json::json!({
            "connections": [{
                "slug": "bad-header",
                "provider": "openai",
                "requestHeaders": {
                    "Authorization": "Bearer private-secret"
                }
            }]
        }))
        .unwrap(),
        serde_json::to_vec(&serde_json::json!({
            "connections": [{
                "slug": "duplicate-header",
                "provider": "openai",
                "requestHeaders": {
                    "X-Eval": "private-secret-1",
                    "x-eval": "private-secret-2"
                }
            }]
        }))
        .unwrap(),
        serde_json::to_vec(&serde_json::json!({
            "connections": [{
                "slug": "eval-gateway",
                "provider": "openai-compatible",
                "configuration": { "baseUrl": "http://127.0.0.1:18080/v1" },
                "apiKey": "private-secret-key",
                "enabledModelIds": ["eval-model"]
            }],
            "defaultTarget": {
                "slug": "eval-gateway",
                "modelId": "missing-model"
            }
        }))
        .unwrap(),
        serde_json::to_vec(&serde_json::json!({
            "connections": [{
                "slug": "eval-gateway",
                "provider": "openai-compatible",
                "configuration": { "baseUrl": "http://127.0.0.1:18080/v1" },
                "apiKey": "private-secret-key",
                "enabledModelIds": ["eval-model"],
                "modelOverrides": {
                    "eval-model": {
                        "thinkingLevels": ["off"],
                        "defaultThinkingLevel": "medium"
                    }
                }
            }],
            "defaultTarget": { "slug": "eval-gateway", "modelId": "eval-model" }
        }))
        .unwrap(),
        serde_json::to_vec(&serde_json::json!({
            "connections": [{
                "slug": "eval-gateway",
                "provider": "openai-compatible",
                "configuration": { "baseUrl": "http://127.0.0.1:18080/v1" },
                "apiKey": "private-secret-key",
                "enabledModelIds": ["eval-model"],
                "modelOverrides": { "eval-model": { "apiProtocol": "anthropic-messages" } }
            }],
            "defaultTarget": { "slug": "eval-gateway", "modelId": "eval-model" }
        }))
        .unwrap(),
        serde_json::to_vec(&serde_json::json!({
            "projectDirectoryRoots": [{
                "label": "bad-root",
                "path": "/private-secret/nonexistent-workspace-root"
            }]
        }))
        .unwrap(),
    ] {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("root");
        let mut child = initialize(&root, "15000");
        // An early rejection may close its pipe before the entire input is written.
        let _ = child.stdin.take().unwrap().write_all(&input);
        let output = child.wait_with_output().unwrap();
        assert!(!output.status.success());
        let diagnostic = String::from_utf8_lossy(&output.stderr);
        assert!(
            diagnostic.contains("invalid initial settings"),
            "{diagnostic}"
        );
        assert!(!diagnostic.contains("private-secret"));
        assert!(!root.exists());
    }

    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("existing-empty-root");
    std::fs::create_dir(&root).unwrap();
    let input = serde_json::to_vec(&serde_json::json!({
        "projectDirectoryRoots": [{
            "label": "self-root",
            "path": &root
        }]
    }))
    .unwrap();
    let mut child = initialize(&root, "15000");
    let _ = child.stdin.take().unwrap().write_all(&input);
    let output = child.wait_with_output().unwrap();
    assert!(!output.status.success());
    let diagnostic = String::from_utf8_lossy(&output.stderr);
    assert!(
        diagnostic.contains("invalid initial settings"),
        "{diagnostic}"
    );
    assert!(!root.join(".maka-storage-root.json").exists());
}

#[test]
fn public_init_times_out_unfinished_input_without_leaving_a_reader_or_root() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("root");
    let start = Instant::now();
    let mut child = initialize(&root, "1000");
    let mut input = child.stdin.take().unwrap();
    // Even valid JSON is not accepted until the caller finishes its input.
    input.write_all(b"{}").unwrap();
    loop {
        if child.try_wait().unwrap().is_some() {
            break;
        }
        if start.elapsed() > Duration::from_secs(15) {
            let _ = child.kill();
            let _ = child.wait();
            panic!("unfinished stdin defeated the operation deadline");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let output = child.wait_with_output().unwrap();
    assert!(!output.status.success());
    assert!(
        output.status.code() == Some(70)
            || String::from_utf8_lossy(&output.stderr).contains("observation timed out"),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!root.exists());
    // A detached worker still reading inherited stdin would keep this pipe open.
    assert!(input.write_all(b" ").is_err());
}
