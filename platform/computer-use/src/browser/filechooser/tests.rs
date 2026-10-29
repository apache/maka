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

//! Loopback protocol fixtures only; no desktop/file-upload behavior is claimed.
use super::*;
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message;

fn scope() -> Scope {
    Scope {
        owner: uuid::Uuid::new_v4(),
        browser: BrowserIdentity::Cdp {
            port: 1,
            debugger: "/devtools/browser/fixture".into(),
        },
        tab: "17".into(),
        frame: "main".into(),
        loader: "loader".into(),
        turn: "turn".into(),
    }
}
struct Wire {
    socket: Cdp,
    inject: tokio::sync::mpsc::UnboundedSender<Value>,
    requests: Arc<Mutex<Vec<Value>>>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Wire {
    fn drop(&mut self) {
        self.task.abort();
    }
}
async fn wire(cleanup_gate: Option<CancellationToken>) -> Wire {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (inject, mut incoming) = tokio::sync::mpsc::unbounded_channel::<Value>();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let captured = requests.clone();
    let task = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
        loop {
            tokio::select! {
                value=incoming.recv()=>match value {Some(value)=>{if ws.send(Message::Text(value.to_string().into())).await.is_err(){break;}},None=>break},
                message=ws.next()=>{
                    let Some(Ok(Message::Text(text)))=message else {break};
                    let call:Value=serde_json::from_str(&text).unwrap();
                    captured.lock().unwrap().push(call.clone());
                    let disable=call["method"]=="Page.setInterceptFileChooserDialog" && call["params"]["enabled"]==false;
                    if disable && let Some(gate)=&cleanup_gate {gate.cancelled().await;}
                    let reply=if call["method"]=="Page.getFrameTree" {
                        json!({"id":call["id"],"result":{"frameTree":{"frame":{"id":"main","loaderId":"loader","url":"https://fixture.test/"}}}})
                    } else {json!({"id":call["id"],"result":{}})};
                    if ws.send(Message::Text(reply.to_string().into())).await.is_err(){break;}
                }
            }
        }
    });
    let socket = Cdp::connect(
        &format!("ws://{address}"),
        &crate::protocol::BrowserConnection {
            id: "fixture".into(),
            endpoint: format!("http://{address}"),
        },
    )
    .await
    .unwrap();
    Wire {
        socket,
        inject,
        requests,
        task,
    }
}
#[tokio::test]
async fn waiter_arms_before_return_and_cancellation_drains_same_cleanup_before_close() {
    let gate = CancellationToken::new();
    let peer = wire(Some(gate.clone())).await;
    let store = Store::default();
    let stop = CancellationToken::new();
    let waiting = store
        .arm(
            peer.socket.clone(),
            scope(),
            Duration::from_secs(1),
            stop.clone(),
        )
        .await
        .unwrap();
    assert_eq!(
        peer.requests
            .lock()
            .unwrap()
            .iter()
            .map(|v| v["method"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["Page.enable", "Page.setInterceptFileChooserDialog"]
    );
    stop.cancel();
    let mut closing = Box::pin(store.close(None, None));
    assert!(
        tokio::time::timeout(Duration::from_millis(20), &mut closing)
            .await
            .is_err()
    );
    assert_eq!(
        peer.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|v| v["method"] == "Page.setInterceptFileChooserDialog"
                && v["params"]["enabled"] == false)
            .count(),
        1
    );
    gate.cancel();
    closing.await.unwrap();
    assert!(waiting.await.is_err());
    assert!(store.state.lock().unwrap().pending.is_empty());
}
#[tokio::test]
async fn successful_top_level_event_keeps_backend_and_disables_interception_once() {
    let peer = wire(None).await;
    let store = Store::default();
    let source = scope();
    let waiting = store
        .arm(
            peer.socket.clone(),
            source.clone(),
            Duration::from_secs(1),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    peer.inject.send(json!({"method":"Page.fileChooserOpened","params":{"backendNodeId":42,"mode":"selectMultiple","frameId":"main"}})).unwrap();
    let result = waiting.await.unwrap();
    let id = result["fileChooserId"].as_str().unwrap();
    assert_eq!(result["isMultiple"], true);
    let held = store
        .selection(id, &source, &["a".into(), "b".into()])
        .unwrap();
    assert_eq!(held.backend_node, 42);
    assert_eq!(held.frame.as_ref().unwrap().loader, "loader");
    assert_eq!(
        peer.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|v| v["method"] == "Page.setInterceptFileChooserDialog"
                && v["params"]["enabled"] == false)
            .count(),
        1
    );
    store.close(None, None).await.unwrap();
}
