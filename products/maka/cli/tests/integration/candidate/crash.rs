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
use maka_app_client::{Client as AppClient, Journal};
use maka_host_runtime::application::host::startup;
use serde_json::json;
use std::sync::{Arc, atomic::AtomicUsize};
use tokio::{net::TcpListener, sync::mpsc};

async fn activity(client: &AppClient, session: &str) -> Value {
    client
        .query("agent", "observe", json!({"sessionId":session}))
        .await
        .unwrap()["session"]["activity"]
        .clone()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn killed_host_leaves_an_ended_turn_and_a_session_that_takes_messages() {
    let mut fixture = RootStartupFixture::new();
    let root = fixture.root.clone();
    let executable = Path::new(env!("CARGO_BIN_EXE_maka"));
    let journal = fixture.directory().join("client.db");
    let owner = Arc::new(
        RootOwner::create(&root, &RootNamespaces::for_current_account().unwrap()).unwrap(),
    );
    fixture.adopt();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let selection = configure(
        owner.clone(),
        &format!("http://{}/v1", listener.local_addr().unwrap()),
        false,
    )
    .await;
    drop(owner);
    let (send, mut requests) = mpsc::channel(8);
    tokio::spawn(async move {
        let count = Arc::new(AtomicUsize::new(0));
        loop {
            let (socket, _) = listener.accept().await.unwrap();
            tokio::spawn(ModelRequest::serve(socket, send.clone(), count.clone()));
        }
    });
    tokio::time::timeout(Duration::from_secs(90), async {
        let host = startup::connect_root(executable, &root).await.unwrap();
        let client = AppClient::new(
            host,
            Journal::open(&journal).await.unwrap(),
            "receipts".into(),
        )
        .unwrap();
        let roots = client
            .query("agent", "directories", json!({"kind":"roots"}))
            .await
            .unwrap();
        let created = mutate(&client, "create", json!({"title":"Crash","labels":[],"workspace":{"kind":"directory","selection":roots["roots"][0]["selection"]}})).await;
        let session = created["session"]["id"].as_str().unwrap().to_owned();
        mutate(&client, "send", json!({"sessionId":session,"message":"BEFORE_THE_CRASH","model":selection})).await;
        let held = requests.recv().await.unwrap();
        assert_ne!(activity(&client, &session).await, "idle");

        let pid = discovery::read(&root).unwrap().pid.get();
        assert_eq!(unsafe { libc::kill(pid as libc::pid_t, libc::SIGKILL) }, 0);
        drop(held);
        drop(client);

        let host = startup::connect_root(executable, &root).await.unwrap();
        assert_ne!(discovery::read(&root).unwrap().pid.get(), pid);
        let client = AppClient::new(
            host,
            Journal::open(&journal).await.unwrap(),
            "receipts".into(),
        )
        .unwrap();
        assert_eq!(activity(&client, &session).await, "idle");
        mutate(&client, "send", json!({"sessionId":session,"message":"AFTER_THE_CRASH","model":selection})).await;
        let mut answered = false;
        while activity(&client, &session).await != "idle" || !answered {
            let Ok(request) =
                tokio::time::timeout(Duration::from_millis(50), requests.recv()).await
            else {
                continue;
            };
            let mut request = request.unwrap();
            answered |= request.body["messages"].to_string().contains("AFTER_THE_CRASH");
            request.delta("ANSWER").await;
            request.finish().await;
        }
        let history = client
            .query("agent", "history", json!({"sessionId":session,"position":{"kind":"start"}}))
            .await
            .unwrap();
        let chunks = history["chunks"].as_array().unwrap();
        let interrupted = chunks
            .iter()
            .find(|chunk| chunk.to_string().contains("BEFORE_THE_CRASH"))
            .unwrap();
        assert_eq!(interrupted["timing"]["finished"]["outcome"], "failed");
        assert!(chunks.iter().any(|chunk| chunk.to_string().contains("ANSWER")));
        client.close().await.unwrap();
    })
    .await
    .expect("recovery after a killed Host timed out");
}
