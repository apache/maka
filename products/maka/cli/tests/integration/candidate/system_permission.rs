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
use crate::terminal::support::{ModelRequest, configure, mutate};
use maka_agent_facts::archive::ToolResultAddress;
use maka_agent_facts::interaction::{InteractionRecord, InteractionRequest};
use maka_app_client::{Client as AppClient, Journal};
use maka_plugin_core::operation::{OperationCleanup, OperationOutcome, Receipt};
use serde_json::json;
use sqlx::{Connection, Row, sqlite::SqliteConnectOptions};
use std::sync::{Arc, atomic::AtomicUsize};
use tokio::{net::TcpListener, sync::mpsc};
use tokio_util::task::AbortOnDropHandle;

async fn original_cua_text(client: &AppClient, session: &str, content: &str) -> String {
    let Some(archived) = serde_json::from_str::<Value>(content)
        .ok()
        .filter(|value| value["kind"] == "maka.archived_tool_result")
    else {
        return content.to_owned();
    };
    let address = ToolResultAddress::parse(archived["resourceRef"].as_str().unwrap()).unwrap();
    let history = client
        .query(
            "agent",
            "history",
            json!({"sessionId":session,"position":{"kind":"tail"},"view":"conversation"}),
        )
        .await
        .unwrap();
    let through = history["through"].as_u64().unwrap();
    let row = history["chunks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["role"] == "tool_result" && row["messageId"] == address.event_id())
        .expect("the original CUA result must be in this fixture's short history");
    let mut position = json!({"kind":"start"});
    let mut text = String::new();
    let mut total_bytes = None;
    loop {
        let page = client
            .query(
                "agent",
                "source",
                json!({"sessionId":session,"through":through,
                    "source":{"kind":"row","position":row["position"]},
                    "field":"result","position":position}),
            )
            .await
            .unwrap();
        let source = &page["source"];
        assert_eq!(source["offset"].as_u64().unwrap(), text.len() as u64);
        let total = source["totalBytes"].as_u64().unwrap();
        assert_eq!(total, *total_bytes.get_or_insert(total));
        let chunk = source["text"].as_str().unwrap();
        text.push_str(chunk);
        assert!(text.len() as u64 <= total, "CUA source exceeded its length");
        if text.len() as u64 == total {
            return text;
        }
        assert!(!chunk.is_empty(), "CUA source read made no progress");
        position = json!({"kind":"after","offset":text.len()});
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "manual real macOS authorization; requires isolated helper and visible validation desktop"]
async fn real_system_permission_window_completes_the_original_cua_call() {
    let executable =
        PathBuf::from(std::env::var_os("MAKA_CUA_VALIDATION_MAKA").expect("production maka path"));
    let helper = PathBuf::from(
        std::env::var_os("MAKA_CUA_VALIDATION_HELPER").expect("isolated responsible helper path"),
    );
    let shell = PathBuf::from(
        std::env::var_os("MAKA_CUA_VALIDATION_DESKTOP").expect("isolated validation desktop path"),
    );
    for path in [&executable, &helper, &shell] {
        assert!(path.is_absolute() && path.is_file(), "{}", path.display());
    }
    assert_eq!(executable.file_name().unwrap(), "maka");
    let responsible_bundle = helper
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .canonicalize()
        .unwrap();
    let identity = Command::new("/usr/libexec/PlistBuddy")
        .args(["-c", "Print :CFBundleIdentifier"])
        .arg(responsible_bundle.join("Contents/Info.plist"))
        .output()
        .unwrap();
    assert!(
        identity.status.success(),
        "cannot read responsible bundle identity"
    );
    let identity = String::from_utf8(identity.stdout).unwrap();
    assert!(
        identity
            .trim()
            .starts_with("org.apache.maka.host.validation."),
        "refusing a non-Validation responsible helper: {identity}"
    );
    let mut directory = tempfile::tempdir().unwrap();
    // Keep original receipts: real OS approvals cannot be replayed after cleanup.
    directory.disable_cleanup(true);
    eprintln!("VALIDATION_RETAINED {}", directory.path().display());
    let mut candidate = CandidateFixture::new(directory.path().join("root"));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let owner = Arc::new(
        RootOwner::open(
            &candidate.root,
            &RootNamespaces::for_current_account().unwrap(),
        )
        .unwrap(),
    );
    let selection = configure(
        owner,
        &format!("http://{}/v1", listener.local_addr().unwrap()),
        true,
        false,
    )
    .await;
    let (send, mut requests) = mpsc::channel(8);
    let _provider = AbortOnDropHandle::new(tokio::spawn(async move {
        let count = Arc::new(AtomicUsize::new(0));
        loop {
            let (socket, _) = listener.accept().await.unwrap();
            tokio::spawn(ModelRequest::serve(socket, send.clone(), count.clone()));
        }
    }));
    let permission_log = responsible_bundle
        .parent()
        .unwrap()
        .join("system-permission-preflight.log");
    candidate.child = Some(
        Command::new(&helper)
            .env("MAKA_TRACE_SYSTEM_PERMISSIONS", "1")
            .arg(&executable)
            .args(["host", "candidate", "--root"])
            .arg(&candidate.root)
            .args([
                "--expected-root-id",
                &candidate.root_id,
                "--startup-attempt-id",
                &uuid::Uuid::new_v4().to_string(),
                "--owner-stdin",
                "--initial-connection-timeout-ms",
                "300000",
                "--idle-grace-ms",
                "1000",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(fs::File::create(&permission_log).unwrap())
            .spawn()
            .unwrap(),
    );
    candidate.wait_for_registration();
    let mut fixture = RootStartupFixture::initialized(directory, candidate);
    let registered = discovery::read(&fixture.root).unwrap();
    let host = Client::connect(&registered.endpoint, Some(registered.host_epoch))
        .await
        .unwrap();
    let client = AppClient::new(
        host,
        Journal::open(&fixture.directory().join("observer.sqlite"))
            .await
            .unwrap(),
        "receipts".into(),
    )
    .unwrap();
    let roots = client
        .query("agent", "directories", json!({"kind":"roots"}))
        .await
        .unwrap();
    let workspace = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .canonicalize()
        .unwrap();
    assert!(
        roots["roots"].as_array().unwrap().iter().any(|root| {
            workspace.starts_with(
                Path::new(root["path"].as_str().unwrap())
                    .canonicalize()
                    .unwrap(),
            )
        }),
        "validation workspace must already be inside a configured root"
    );
    let created = mutate(
        &client,
        "create",
        json!({"title":"Real CUA authorization validation", "labels":[], "tools":["cua_repl"],
        "workspace":{"kind":"directory","path":workspace}}),
    )
    .await;
    assert_eq!(
        created["session"]["permissions"],
        json!({"access":"workspace_write","requestPermissions":true})
    );
    let session = created["session"]["id"].as_str().unwrap().to_owned();
    let mut desktop = tokio::process::Command::new(&shell)
        .env("MAKA_HOST_ROOT", &fixture.root)
        .env("MAKA_HOST_ENDPOINT", &registered.endpoint)
        .env("MAKA_HOST_EPOCH", registered.host_epoch.to_string())
        .env("MAKA_LAUNCHER", &executable)
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    eprintln!(
        "VALIDATION_READY {}",
        json!({"root":fixture.root,"sessionId":session,"desktopPid":desktop.id(),"hostPid":registered.pid,"hostEpoch":registered.host_epoch,"permissionLog":permission_log})
    );
    let validation = async {
        let journal = fixture.root.join("clients/desktop.sqlite");
        while !journal.is_file() {
            assert!(
                desktop.try_wait().unwrap().is_none(),
                "validation desktop exited before admission"
            );
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        mutate(&client, "send", json!({"sessionId":session,"message":"MAKA_REAL_CUA_VALIDATION: observe only this validation desktop.",
            "backend":{"kind":"model","connectionId":selection["connectionId"],"modelId":selection["modelId"]}})).await;
        eprintln!(
            "Select 'Real CUA authorization validation' in this desktop; confirm CUA, OS and per-app prompts there. Never add an app manually."
        );
        let mut phase = 0;
        let mut permission = None;
        let mut before = Value::Null;
        let mut tick = tokio::time::interval(Duration::from_millis(250));
        loop {
            assert!(
                desktop.try_wait().unwrap().is_none(),
                "validation desktop exited during authorization"
            );
            tokio::select! {
                request = requests.recv() => {
                    let mut request = request.unwrap();
                    if !request.body["messages"].to_string().contains("MAKA_REAL_CUA_VALIDATION") {
                        request.delta("Validation").await;
                        request.finish().await;
                        continue;
                    }
                    let tools = request.body["tools"].as_array().unwrap();
                    if phase == 0 && tools.iter().any(|t| t["function"]["name"] == "tool_search") {
                        request.tool_call("tool_search", json!({"query":"cua_repl"})).await;
                        phase = 1;
                    } else if phase < 2 {
                        assert!(tools.iter().any(|t| t["function"]["name"] == "cua_repl"), "real request must advertise cua_repl");
                        request.tool_call("cua_repl", json!({"title":"Observe the isolated authorization desktop", "code":
                            r#"const apps = await cua.listApps({emit:false});
const matches = apps.filter(a => a.id === 'org.apache.maka.permission-validation.desktop');
if (matches.length !== 1) throw new Error('Validation desktop app must be unique: ' + JSON.stringify({matches,desktopCandidates:apps.filter(a => String(a.displayName).startsWith('Maka'))}));
const validation = matches[0];
nodeRepl.write({validationInventory:validation});
const visible = validation?.windows.filter(w => w.isOnScreen === true && w.minimized !== true) ?? [];
if (visible.length !== 1) throw new Error('Validation desktop must have exactly one visible initial window: ' + JSON.stringify(validation ?? null));
const target = visible[0];
const app = await cua.getApp({windowId:target.id});
const observation = await app.getAXStateAndScreenshot({emit:false});
if (typeof observation.state !== 'string' || observation.state.length === 0 || !(observation.screenshot?.byteLength > 0)) throw new Error('Actual AX state and screenshot bytes are required');
nodeRepl.write({windowId:target.id,axCharacters:observation.state.length,screenshotBytes:observation.screenshot.byteLength});
nodeRepl.write(['MAKA','VALIDATION','CUA','COMPLETE'].join('_'));"#
                        })).await;
                        phase = 2;
                    } else {
                        let output = request.body["messages"].as_array().unwrap().iter().rev().find(|m| m["role"] == "tool").expect("real CUA tool output");
                        let text = original_cua_text(&client, &session, output["content"].as_str().expect("CUA tool text")).await;
                        assert!(text.contains("MAKA_VALIDATION_CUA_COMPLETE"), "CUA did not complete successfully: {text}");
                        request.delta("Validation desktop observation completed.").await;
                        request.finish().await;
                        break;
                    }
                }
                _ = tick.tick() => {
                    if permission.is_none() {
                        let pending = client.query("agent", "pendingInteractions", json!({"sessionId":session})).await.unwrap();
                        if let Some(entry) = pending["entries"].as_array().unwrap().iter().find(|e| e["kind"] == "system_permission") {
                            let id = entry["requestId"].as_str().unwrap().to_owned();
                            before = client.query("agent", "systemPermissionStatus", json!({"sessionId":session,"requestId":id})).await.unwrap();
                            let record: InteractionRecord = serde_json::from_value(before["record"].clone()).unwrap();
                            assert!(record.outcome.is_none());
                            let InteractionRequest::SystemPermission { application_location: Some(location), .. } = record.request else { panic!("real local responsible identity required"); };
                            assert_eq!(location.bundle_url().unwrap().to_file_path().unwrap().canonicalize().unwrap(), responsible_bundle);
                            assert!(before["grants"].as_array().unwrap().iter().any(|g| g["grant"] == "screen_recording" && g["effective"] == false), "requires a naturally missing Validation Screen Recording grant; never reset TCC");
                            eprintln!("VALIDATION_PENDING {}", json!({"sessionId":session,"requestId":id,"before":before}));
                            permission = Some(id);
                        }
                    }
                }
            }
        }
        let current = discovery::read(&fixture.root).unwrap();
        assert_eq!(
            current.pid, registered.pid,
            "business Host must not restart"
        );
        assert_eq!(current.host_epoch, registered.host_epoch);
        let request_id = permission.expect("real CUA producer must publish system_permission");
        let after = client
            .query(
                "agent",
                "systemPermissionStatus",
                json!({"sessionId":session,"requestId":request_id}),
            )
            .await
            .unwrap();
        assert_eq!(
            after["record"]["outcome"]["kind"],
            "system_permission_granted"
        );
        assert!(
            after["grants"]
                .as_array()
                .unwrap()
                .iter()
                .all(|g| g["effective"] == true)
        );
        // host::Connection admits the production desktop with shell="desktop".
        let mut database = sqlx::SqliteConnection::connect_with(
            &SqliteConnectOptions::new()
                .filename(&journal)
                .read_only(true),
        )
        .await
        .unwrap();
        let rows = sqlx::query("SELECT id, context, reference, receipt FROM operations WHERE json_extract(context,'$.method')='requestSystemPermission'").fetch_all(&mut database).await.unwrap();
        let mut grants = std::collections::BTreeSet::new();
        for row in rows {
            let context: Value = serde_json::from_str(row.get("context")).unwrap();
            assert_eq!(context["sessionId"], session);
            assert_eq!(context["correlation"]["requestId"], request_id);
            let grant = context["correlation"]["grant"].as_str().unwrap();
            assert!(
                grants.insert(grant.to_owned()),
                "one original UI request per grant"
            );
            let reference: Value = serde_json::from_str(row.get::<&str, _>("reference")).unwrap();
            let receipt: Receipt = serde_json::from_str(row.get::<&str, _>("receipt")).unwrap();
            assert!(matches!(
                receipt,
                Receipt::Recorded {
                    outcome: OperationOutcome::Returned { .. },
                    cleanup: OperationCleanup::Confirmed
                }
            ));
            for _ in 0..2 {
                let original = client
                    .query("receipts", "read", reference.clone())
                    .await
                    .unwrap();
                assert_eq!(original["reference"], reference);
                assert_eq!(original["receipt"], serde_json::to_value(&receipt).unwrap());
            }
            eprintln!(
                "VALIDATION_ORIGINAL {}",
                json!({"operationId":row.get::<&str,_>("id"),"sessionId":session,"requestId":request_id,"grant":grant,"reference":reference,"receipt":receipt})
            );
        }
        assert!(
            grants.contains("screen_recording"),
            "production window must request the missing grant"
        );
        eprintln!(
            "VALIDATION_VERIFIED {}",
            json!({"sessionId":session,"requestId":request_id,"before":before,"after":after,"hostPid":current.pid,"hostEpoch":current.host_epoch,"cuaCompleted":true,"axAndScreenshotCompleted":true})
        );
        database.close().await.unwrap();
        eprintln!(
            "Real producer and original receipts verified. Inspect the completed permission window, then close ONLY the Validation desktop to finish."
        );
        desktop.wait().await.unwrap();
    };
    let watch = async {
        loop {
            if let Some(status) = fixture
                .initialized
                .as_mut()
                .unwrap()
                .child
                .as_mut()
                .unwrap()
                .try_wait()
                .unwrap()
            {
                return status;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    };
    let result = tokio::select! {
        status = watch => Err(format!("isolated Host exited: {status}")),
        result = tokio::time::timeout(Duration::from_secs(600), validation) => result.map_err(|_| "manual authorization exceeded ten minutes".to_owned()),
    };
    if desktop.try_wait().unwrap().is_none() {
        desktop.kill().await.unwrap();
    }
    client.close().await.unwrap();
    result.unwrap();
}
