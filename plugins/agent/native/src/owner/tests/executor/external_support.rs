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

use super::*;
use maka_capabilities::storage::{Namespace, Scan};
use tokio::io::{AsyncBufReadExt, BufReader};

pub(super) async fn setup(base: &str) -> (Fixture, TcpListener) {
    configured(base, |_| {}).await
}

pub(super) async fn configured(
    base: &str,
    configure: impl FnOnce(&mut Configuration),
) -> (Fixture, TcpListener) {
    with_tools(base, None, configure).await
}

pub(super) async fn with_tools(
    base: &str,
    tooling: Option<service_tools::Setup>,
    configure: impl FnOnce(&mut Configuration),
) -> (Fixture, TcpListener) {
    static NODE: tokio::sync::OnceCell<String> = tokio::sync::OnceCell::const_new();
    let node = NODE
        .get_or_init(|| async {
            let output = tokio::process::Command::new("node")
                .args(["-e", "process.stdout.write(process.execPath)"])
                .output()
                .await
                .unwrap();
            assert!(output.status.success());
            let path = String::from_utf8(output.stdout).unwrap().trim().to_owned();
            assert!(std::path::Path::new(&path).is_absolute());
            path
        })
        .await;
    let control = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let fixture = Fixture::configured(base, None, None, tooling, |settings| {
        let command = maka_agent_api::executor::NativeCommand {
            executable: std::path::Path::new(node)
                .file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .into(),
            args: vec![
                std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("tests/support/native-runtime.mjs")
                    .to_str()
                    .unwrap()
                    .into(),
                control.local_addr().unwrap().port().to_string(),
            ],
            env: BTreeMap::from([
                ("MAKA_NATIVE_PREOPEN_PROBE".into(), "1".into()),
                (
                    "PATH".into(),
                    std::path::Path::new(node)
                        .parent()
                        .unwrap()
                        .to_str()
                        .unwrap()
                        .into(),
                ),
                (
                    "MAKA_NATIVE_FIXTURE_CLAUDE_DIR".into(),
                    std::path::PathBuf::from(&settings.workspace_roots[0].path)
                        .join(".fixture-claude")
                        .to_str()
                        .unwrap()
                        .into(),
                ),
            ]),
        };
        let mut claude = command.clone();
        claude.env.insert(
            "CLAUDE_CONFIG_DIR".into(),
            command.env["MAKA_NATIVE_FIXTURE_CLAUDE_DIR"].clone(),
        );
        settings.external = Some(maka_agent_api::executor::ExternalConfiguration {
            runtimes: maka_agent_api::executor::NativeRuntimeSwitches {
                codex: true,
                antigravity: true,
                claude: true,
            },
            commands: maka_agent_api::executor::NativeCommands {
                codex: Some(command.clone()),
                antigravity: Some(command),
                claude: Some(claude),
            },
        });
        configure(settings);
    })
    .await;
    (fixture, control)
}

pub(super) fn backend(runtime: &str) -> Value {
    json!({"kind":"executor","selection":{"executor":"external","settings":{"runtime":runtime,"model":"fixture-model","thinkingLevel":"vendor-deep"}}})
}
pub(super) fn input(session: &str, message: &str) -> Value {
    input_runtime(session, "codex", message)
}
pub(super) fn input_runtime(session: &str, runtime: &str, message: &str) -> Value {
    json!({"sessionId":session,"message":message,"backend":backend(runtime)})
}
pub(super) async fn packet(control: &mut BufReader<TcpStream>, phase: &str) -> Value {
    let mut line = String::new();
    control.read_line(&mut line).await.unwrap();
    let value: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(value["phase"], phase, "{value}");
    value
}
pub(super) async fn release(control: &mut BufReader<TcpStream>) {
    control.get_mut().write_all(b"continue\n").await.unwrap();
}
pub(super) async fn record(f: &Fixture, session: &str) -> Value {
    record_runtime(f, session, "codex").await
}
pub(super) async fn record_runtime(f: &Fixture, session: &str, runtime: &str) -> Value {
    let suffix = format!(
        "conversation/{}",
        hex::encode(Sha256::digest(
            serde_json::to_vec(&(session, Some(runtime))).unwrap()
        ))
    );
    let page = f
        .store
        .plugin_data_scan(
            &Namespace::new(
                "maka.agent.external",
                maka_plugin_core::scope::Scope::Profile,
            )
            .unwrap(),
            Scan {
                prefix: String::new(),
                after: None,
            },
        )
        .await
        .unwrap();
    page.entries
        .into_iter()
        .find(|entry| entry.key.ends_with(&suffix))
        .expect("original conversation journal")
        .record
        .data
        .value()
        .unwrap()
        .clone()
}

pub(super) fn host_tool(method: &str, name: &str) -> contract::ServiceTool {
    serde_json::from_value(json!({"name":name,"description":format!("Host {method}"),"target":{"kind":"export","name":"agent"},"method":method,"result":"json","confirmation":"preapproved"})).unwrap()
}
