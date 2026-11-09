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

use super::external_support::{
    backend, configured, input_runtime, packet, release, setup, with_tools,
};
use super::*;
use futures_util::FutureExt;
use tokio::io::BufReader;

async fn complete(control: &mut BufReader<TcpStream>) {
    release(control).await;
    packet(control, "output").await;
    release(control).await;
    packet(control, "terminal").await;
    release(control).await;
}
fn skill(root: &std::path::Path, name: &str, required: &str) {
    let root = root.join(name);
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("SKILL.md"), format!("---\nname: {name}\ndescription: Review changes\nrequired-tools: {required}\n---\nREVIEW BRIDGE GUIDANCE")).unwrap();
}

#[tokio::test]
async fn external_skills_candidates_steering_and_queue_edits_use_the_same_bridge_ceiling() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let home = tempfile::tempdir().unwrap();
        let tooling = service_tools::Setup::skill_preparation(home.path().into(), true)
            .with_standard_sources()
            .with_host_tools(vec![super::external_support::host_tool("tools", "NativePrepare")]);
        let (f, listener) = with_tools("http://127.0.0.1:9/v1", Some(tooling), |_| {}).await;
        for runtime in ["codex", "claude"] {
            let session = f.create("External skill ceiling").await;
            let workspace = f.owner.session(&session).await.unwrap().configuration.workspace;
            let source = std::path::Path::new(&workspace.path).join(".maka/skills");
            skill(&source, "review", "FindGuide LoadGuide");
            skill(&source, "native-only", "NativePrepare");
            let native = f.query("skillCandidates", json!({"sessionId":session,"backend":model_backend(&f.selection().await),"query":""})).await.unwrap();
            assert!(native["skills"].as_array().unwrap().iter().any(|skill| skill["invocation"] == "/skill:native-only"),
                "the non-bridged tool must actually be registered for native models: {native}");
            let page = f.query("skillCandidates", json!({"sessionId":session,"backend":backend(runtime),"query":""})).await.unwrap();
            assert_eq!(page["skills"].as_array().unwrap().len(), 1, "{page}");
            assert_eq!(page["skills"][0]["invocation"], "/skill:review");
            let mut create = f.create_input("Narrow external skill ceiling").await;
            create["tools"] = json!(["FindGuide"]);
            let narrow = f.mutation(2, "create", create, Uuid::new_v4()).await.unwrap();
            let page = f.query("skillCandidates", json!({"sessionId":narrow["session"]["id"],"backend":backend(runtime),"query":""})).await.unwrap();
            assert_eq!(page["skills"], json!([]), "autocomplete cannot grant LoadGuide");
            let first = f.mutation(2, "send", input_runtime(&session, runtime, "complete"), Uuid::new_v4()).await.unwrap();
            let mut control = BufReader::new(listener.accept().await.unwrap().0);
            let opened = packet(&mut control, "opened").await;
            let instructions = opened["request"]["instructions"].as_str().unwrap();
            assert!(instructions.contains("FindGuide") && instructions.contains("LoadGuide"));
            assert!(instructions.contains("review"));
            let denied = f.mutation(2, "send", json!({"sessionId":session,"message":"/skill:native-only inspect"}), Uuid::new_v4()).await.unwrap();
            assert_eq!(denied["kind"], "rejected", "native tools must not be implicitly bridged: {denied}");
            let mut input = input_runtime(&session, runtime, "queued");
            input["delivery"] = "queue".into();
            let queued = f.mutation(2, "send", input, Uuid::new_v4()).await.unwrap();
            let edited = f.mutation(2, "editQueue", json!({"sessionId":session,"expectedRevision":queued["revision"],"edit":{"kind":"update","messageId":queued["messageId"],"message":"/skill:review edited"}}), Uuid::new_v4()).await.unwrap();
            assert_eq!(edited["kind"], "committed", "{edited}");
            let promoted = f.mutation(2, "editQueue", json!({"sessionId":session,"expectedRevision":edited["revision"],"edit":{"kind":"promote","messageId":queued["messageId"]}}), Uuid::new_v4()).await.unwrap();
            assert_eq!(promoted["kind"], "committed", "{promoted}");
            let received = packet(&mut control, "steered").await;
            assert!(received["request"]["message"].as_str().unwrap().contains("REVIEW BRIDGE GUIDANCE"));
            let accepted = f.mutation(2, "send", json!({"sessionId":session,"message":"/skill:review steer"}), Uuid::new_v4()).await.unwrap();
            assert_eq!(accepted["kind"], "queued");
            let received = packet(&mut control, "steered").await;
            assert!(received["request"]["message"].as_str().unwrap().contains("REVIEW BRIDGE GUIDANCE"));
            complete(&mut control).await;
            f.drained().await;
            let delivered = f.query("work", json!({"sessionId":session,"target":{"kind":"message","messageId":queued["messageId"]}})).await.unwrap();
            assert_eq!(delivered["execution"]["runId"], first["runId"], "promotion must keep the original invocation");
            assert_eq!(delivered["execution"]["state"], "completed", "{delivered}");
            assert!(listener.accept().now_or_never().is_none());
        }
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn external_agy_queue_promotion_does_not_claim_live_steering_support() {
    tokio::time::timeout(Duration::from_secs(45), async {
        let (f, listener) = setup("http://127.0.0.1:9/v1").await;
        let session = f.create("No fake agy live steering").await;
        f.mutation(2, "send", input_runtime(&session, "antigravity", "complete"), Uuid::new_v4()).await.unwrap();
        let mut control = BufReader::new(listener.accept().await.unwrap().0);
        packet(&mut control, "opened").await;
        let mut input = input_runtime(&session, "antigravity", "queued");
        input["delivery"] = "queue".into();
        let queued = f.mutation(2, "send", input, Uuid::new_v4()).await.unwrap();
        let rejected = f.mutation(2, "editQueue", json!({"sessionId":session,"expectedRevision":queued["revision"],"edit":{"kind":"promote","messageId":queued["messageId"]}}), Uuid::new_v4()).await.unwrap();
        assert_eq!(rejected, json!({"kind":"rejected","reason":"execution_changed"}));
        let queue = f.query("queue", json!({"sessionId":session})).await.unwrap();
        assert_eq!(queue["entries"][0]["kind"], "followup");
        f.mutation(2, "editQueue", json!({"sessionId":session,"expectedRevision":queue["revision"],"edit":{"kind":"retract","messageId":queued["messageId"]}}), Uuid::new_v4()).await.unwrap();
        complete(&mut control).await;
        f.drained().await;
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn external_agy_interrupt_preserves_explicit_next_backend_and_model() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let (f, listener) = setup("http://127.0.0.1:9/v1").await;
        for runtime in ["antigravity", "codex"] {
            let session = f.create("Explicit busy agy backend").await;
            let first = f.mutation(2, "send", input_runtime(&session, "antigravity", "soft-interrupt"), Uuid::new_v4()).await.unwrap();
            let mut original = BufReader::new(listener.accept().await.unwrap().0);
            packet(&mut original, "opened").await;
            release(&mut original).await;
            packet(&mut original, "output").await;
            let mut input = input_runtime(&session, runtime, "complete");
            input["backend"]["selection"]["settings"]["model"] = "explicit-next-model".into();
            let operation = Uuid::new_v4();
            let accepted = f.mutation(2, "send", input.clone(), operation).await.unwrap();
            assert_eq!(accepted["kind"], "queued");
            packet(&mut original, "interrupt_requested").await;
            assert!(listener.accept().now_or_never().is_none());
            release(&mut original).await;
            packet(&mut original, "terminal").await;
            assert!(listener.accept().now_or_never().is_none(), "native terminal does not settle physical custody");
            release(&mut original).await;
            let mut successor = BufReader::new(listener.accept().await.unwrap().0);
            let opened = packet(&mut successor, "opened").await;
            assert_eq!(opened["request"]["model"], "explicit-next-model", "explicit model cannot be overwritten by the interrupted turn");
            assert!(opened["request"].get("resume").is_none(), "successor must not resume an old private job even for the same runtime");
            assert_eq!(work(&f, &session, &first).await["execution"]["state"], "cancelled");
            assert_eq!(f.mutation(2, "send", input, operation).await.unwrap(), accepted);
            complete(&mut successor).await;
            f.drained().await;
            let delivered = f.query("work", json!({"sessionId":session,"target":{"kind":"message","messageId":accepted["messageId"]}})).await.unwrap();
            assert_eq!(delivered["execution"]["state"], "completed", "{delivered}");
            assert_ne!(delivered["execution"]["runId"], first["runId"]);
        }
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn external_single_model_validation_does_not_probe_unrelated_native_runtimes() {
    tokio::time::timeout(Duration::from_secs(45), async {
        for runtime in ["claude", "antigravity"] {
            let directory = tempfile::tempdir().unwrap();
            let codex_marker = directory.path().join("codex-probed");
            let agy_marker = directory.path().join("agy-probed");
            let selected_marker = directory.path().join("selected-probe-count");
            let (f, _listener) = configured("http://127.0.0.1:9/v1", |settings| {
                let commands = &mut settings.external.as_mut().unwrap().commands;
                let mark = |command: &mut maka_agent_api::executor::NativeCommand,
                            path: &std::path::Path| {
                    command.args = vec![
                        "-e".into(),
                        format!(
                            "require('node:fs').writeFileSync({}, 'probed');process.exit(1)",
                            serde_json::to_string(path.to_str().unwrap()).unwrap()
                        ),
                    ];
                };
                mark(commands.codex.as_mut().unwrap(), &codex_marker);
                if runtime == "claude" {
                    mark(commands.antigravity.as_mut().unwrap(), &agy_marker);
                } else {
                    let command = commands.antigravity.as_mut().unwrap();
                    let script=command.args.iter().position(|arg|arg=="-e").unwrap()+1;
                    command.args[script].insert_str(0,&format!("import {{appendFileSync as recordProbe}} from 'node:fs';recordProbe({},'probe');\n",serde_json::to_string(selected_marker.to_str().unwrap()).unwrap()));
                }
            })
            .await;
            let mut selected = backend(runtime);
            let settings = selected["selection"]["settings"].as_object_mut().unwrap();
            settings.remove("thinkingLevel");
            if runtime == "claude" {
                settings.remove("model");
            } else {
                settings.insert("model".into(), "gemini-3.8-flash-high".into());
            }
            let input = json!({"backend":selected});
            let result = f.query("model", input.clone()).await.unwrap();
            assert_eq!(result["kind"], "ready", "{runtime}: {result}");
            assert_eq!(f.query("model", input).await.unwrap(), result);
            if runtime == "antigravity" {
                assert_eq!(std::fs::read_to_string(&selected_marker).unwrap(), "probe",
                    "revalidating the same model must reuse the runtime-scoped catalog");
            }
            assert!(
                !codex_marker.exists(),
                "validating {runtime} must not start Codex daemon/proxy discovery"
            );
            assert!(
                !agy_marker.exists(),
                "validating Claude must not run agy models"
            );
            f.app.shutdown().await.unwrap();
            f.config.shutdown().await.unwrap();
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn external_model_catalog_retries_transient_discovery_failures_but_reuses_success() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let directory = tempfile::tempdir().unwrap();
        let marker = directory.path().join("probe-count");
        let (f, _listener) = configured("http://127.0.0.1:9/v1", |settings| {
            let external = settings.external.as_mut().unwrap();
            external.runtimes.codex = false;
            external.runtimes.claude = false;
            external.commands.antigravity.as_mut().unwrap().args = vec![
                "-e".into(), format!("const fs=require('node:fs'),path={};if(!fs.existsSync(path)){{fs.writeFileSync(path,'first');process.exit(1)}}fs.appendFileSync(path,' retry');console.log('gemini-fixture\\tFixture model')", serde_json::to_string(marker.to_str().unwrap()).unwrap()),
            ];
        }).await;
        let first = f.query("models", json!({"kind":"start","query":"Native CLI"})).await.unwrap();
        assert!(!first["choices"].as_array().unwrap().iter().any(|choice| choice["selection"]["selection"]["settings"]["model"] == "gemini-fixture"));
        let second = f.query("models", json!({"kind":"start","query":"Native CLI"})).await.unwrap();
        assert!(second["choices"].as_array().unwrap().iter().any(|choice| choice["selection"]["selection"]["settings"]["model"] == "gemini-fixture"), "a transient failure must not hide recovered models for 30 seconds: {second}");
        let third = f.query("models", json!({"kind":"start","query":"Native CLI"})).await.unwrap();
        assert_eq!(third, second);
        assert_eq!(std::fs::read_to_string(marker).unwrap(), "first retry", "a successful discovery remains reusable");
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    }).await.unwrap();
}
