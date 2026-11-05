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
    static NODE: tokio::sync::OnceCell<String> = tokio::sync::OnceCell::const_new();
    let node = NODE
        .get_or_init(|| async {
            let output = tokio::process::Command::new("node")
                .args(["-p", "process.execPath"])
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
    let fixture = Fixture::configured(base, None, None, None, |settings| {
        settings.oar = Some(maka_agent_api::executor::OarConfiguration {
            enabled: true,
            runtimes: ["codex", "antigravity", "claude", "missing", "broken"]
                .into_iter()
                .map(|id| (id.into(), true))
                .collect(),
            executable: Some(node.clone()),
            args: vec![
                std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("tests/support/oar-worker.mjs")
                    .to_str()
                    .unwrap()
                    .into(),
                control.local_addr().unwrap().port().to_string(),
            ],
        });
        configure(settings);
    })
    .await;
    (fixture, control)
}

pub(super) fn backend(runtime: &str) -> Value {
    json!({"kind":"executor","selection":{"executor":"oar","settings":{"runtime":runtime,"model":"fixture-model","thinkingLevel":"vendor-deep"}}})
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
    let suffix = format!(
        "conversation/{}",
        hex::encode(Sha256::digest(
            serde_json::to_vec(&(session, Some("codex"))).unwrap()
        ))
    );
    let page = f
        .store
        .plugin_data_scan(
            &Namespace::new("maka.agent.oar", maka_plugin_core::scope::Scope::Profile).unwrap(),
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
