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
    io::Write,
    path::Path,
    process::{Child, Command, Stdio},
    sync::Arc,
    time::{Duration, Instant},
};

use maka_agent_facts::configuration::policy::RuntimePolicy;
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
    assert_eq!(policy.revision, 1);
    assert_eq!(policy.policy.network_proxy, proxy);
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

    let mut child = initialize(&root, "15000");
    child.stdin.take().unwrap().write_all(b"{}").unwrap();
    assert!(!child.wait_with_output().unwrap().status.success());
    let owner = Arc::new(RootOwner::open_existing(&root, &namespaces).unwrap());
    let store = ConfigurationStore::for_root(owner).await.unwrap();
    assert_eq!(store.runtime_policy().await.unwrap(), policy);
    store.close().await.unwrap();
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
