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
use maka_protocol::{
    project::{Query, QueryResult},
    session::decode_session_create_input,
};
use serde_json::{Value, json};
use std::os::unix::fs::PermissionsExt;
use tokio::io::AsyncWriteExt;

#[test]
fn host_directory_reference_survives_restart_and_sends_without_text_or_registration() {
    let directory = tempfile::Builder::new()
        .permissions(std::fs::Permissions::from_mode(0o700))
        .tempdir()
        .unwrap();
    let published = directory.path().join("published");
    let selected = published.join("目录 target");
    std::fs::create_dir_all(&selected).unwrap();
    let selected = selected.canonicalize().unwrap();
    for index in 0..40 {
        std::fs::create_dir(published.join(format!("folder-{index:02}"))).unwrap();
    }
    let host = super::super::candidate::CandidateFixture::new(directory.path().join("root"));
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let stop = tokio_util::sync::CancellationToken::new();
    let _cleanup = stop.clone().drop_guard();
    let (server, registration, client, model) = runtime.block_on(async {
        use maka_event_log::root::{RootOwner, RootNamespaces};
        use maka_runtime_host::server::{Host, HostOptions, DirectoryRootSpec, local::LocalListener};
        let owner = RootOwner::open(&host.root, &RootNamespaces::for_current_account().unwrap()).unwrap();
        let service = Host::open_with_options(owner, None, HostOptions {
            project_directory_roots: Some(vec![DirectoryRootSpec {label:"Published folders".into(), path:published.clone()}]),
            ..Default::default()
        }).await.unwrap();
        let socket = directory.path().join("host.sock");
        let listener = LocalListener::bind(&socket).unwrap();
        let registration = service.publish_registration(&socket, None).unwrap();
        let server = tokio::spawn(listener.serve(service,stop.clone()));
        let provider = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let client = support::model_client(&host.root,&format!("http://{}/v1",provider.local_addr().unwrap())).await;
        for (id,name) in [("refs","Reference session"),("other","Other session")] {
            client.create_session(decode_session_create_input(&json!({
                "sessionId":id,"name":name,"workspace":{"kind":"host_path","path":directory.path()},
                "modelTarget":{"kind":"default"}
            })).unwrap()).await.unwrap();
        }
        let model=tokio::spawn(async move {
            let (mut stream,body)=model_request(&provider).await;
            let frame=json!({"id":"reference-test","object":"chat.completion.chunk","model":"fixture-model",
                "choices":[{"index":0,"delta":{"content":"Directory received."},"finish_reason":"stop"}]});
            stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: {frame}\n\ndata: [DONE]\n\n").as_bytes()).await.unwrap();
            body
        });
        (server,registration,client,model)
    });
    let args = ["--root", host.root.to_str().unwrap()];
    let mut tui = Pty::spawn(&args);
    tui.wait_for("Reference session");
    tui.click_text("Reference session");
    tui.wait_for("No messages yet.");
    tui.filter_command("Host directories");
    tui.click_text("Host directories");
    tui.wait_for("Published folders");
    tui.click_text("Published folders");
    tui.wait_for("┃");
    tui.drag_text_to_row("┃", 38);
    tui.wait_for("目录 target");
    tui.send(b"\x1b[<0;1;39m");
    tui.click_text("目录 target");
    tui.wait_for("No subdirectories");
    tui.click_text("Reference this directory");
    tui.wait_until(|s| s.contains("目录 target") && !s.contains("Reference this directory"));
    tui.resize(80, 24);
    tui.wait_for("目录 target");
    tui.click_text("目录 target");
    tui.wait_for("Reference this directory");
    tui.send(b"\x1b[<0;1;1M\x1b[<0;1;1m");
    tui.wait_until(|s| !s.contains("Reference this directory"));
    tui.close_terminal();
    tui.finish();
    let state = directory
        .path()
        .join("tui-state")
        .join(&client.identity.root_id)
        .join("default/state.json");
    let saved: Value = serde_json::from_slice(&std::fs::read(&state).unwrap()).unwrap();
    assert_eq!(saved["version"], 16);
    assert_eq!(
        saved["directories"]["refs"],
        json!([{"hostId":client.identity.root_id,"path":selected}])
    );
    assert!(saved["unresolved"].as_array().unwrap().is_empty());
    let mut reopened = Pty::spawn(&args);
    reopened.wait_for("目录 target");
    reopened.wait_for("fixture-model");
    reopened.send(b"\x13");
    reopened.wait_for("Directory received.");
    reopened.close_terminal();
    reopened.finish();
    let body = runtime.block_on(model).unwrap();
    assert!(
        body.to_string().contains(selected.to_str().unwrap()),
        "the provider receives the selected canonical directory"
    );
    let saved: Value = serde_json::from_slice(&std::fs::read(&state).unwrap()).unwrap();
    assert!(saved["directories"].get("refs").is_none());
    assert!(saved["unresolved"].as_array().unwrap().is_empty());
    runtime.block_on(async {
        let QueryResult::Page { items, .. } = client
            .project_catalog(Query::ListStart {
                view: maka_protocol::project::View::Summary,
            })
            .await
            .unwrap()
        else {
            panic!()
        };
        assert!(
            items.is_empty(),
            "referencing a directory must not register a project"
        );
    });
    client.disconnect();
    stop.cancel();
    runtime
        .block_on(async { tokio::time::timeout(Duration::from_secs(10), server).await })
        .unwrap()
        .unwrap()
        .unwrap();
    registration.remove().unwrap();
}
