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
use futures_util::future::BoxFuture;
use maka_plugins::{
    remote::{Caller, Error, Handler, Method},
    terminal_ui::{Context, Descriptor, Text},
};
use std::sync::atomic::AtomicUsize;

struct Writer(Arc<AtomicUsize>);
impl Method for Writer {
    fn call(&self, input: Value, _: Caller) -> BoxFuture<'static, Result<Value, Error>> {
        assert_eq!(input["kind"], "submit");
        let count = self.0.fetch_add(1, Ordering::SeqCst) + 1;
        Box::pin(async move {
            Ok(json!({"kind":"applied","route":{"operation":input["route"],"writes":count}}))
        })
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
async fn idle_documents_and_streams_leave_work_for_calls_receipts_and_close() {
    tokio::time::timeout(Duration::from_secs(30), scenario())
        .await
        .unwrap();
}
async fn scenario() {
    let mut scene = fixture::Scene::new().await;
    let writes = Arc::new(AtomicUsize::new(0));
    let publisher = scene.factory.publisher.lock().unwrap().clone().unwrap();
    let mut staged = Staged::default();
    staged
        .insert(
            "example.pages/write",
            Endpoint::standalone(Handler::Method(Arc::new(Writer(writes.clone()))))
                .with_terminal_view(Descriptor::new(Text::plain("Write"), Context::Application))
                .unwrap(),
        )
        .unwrap();
    let _registration = publisher.publish(staged).unwrap();
    let (writer, writer_target) = bind(&mut scene.peer, "write").await;
    let (source, source_target) = bind(&mut scene.peer, "changed").await;
    let mut documents = Vec::new();
    let mut pending = Vec::new();
    for index in 0..65 {
        let document = document(&mut scene.peer).await;
        // Cross all previous lifetime thresholds on one connection: >32 docs,
        // >32 streams on one doc, >128 per connection and >512 Host-wide.
        for _ in 0..if index == 0 { 40 } else { 8 } {
            let input = if index == 0 {
                json!({"route":"pending"})
            } else {
                Value::Null
            };
            let stream = rpc(
                &mut scene.peer,
                json!({"kind":"open","binding":source,
                "target":source_target,"document":document,"input":input}),
            )
            .await["stream"]
                .clone();
            if index == 0 {
                pending.push(stream);
            }
        }
        documents.push(document);
    }
    assert_eq!(scene.factory.sources.opened.load(Ordering::SeqCst), 552);
    assert_eq!(scene.factory.sources.closed.load(Ordering::SeqCst), 0);
    let first = &documents[0];
    for (index, stream) in pending.iter().enumerate() {
        scene.peer.send_rpc(
            &format!("idle-{index}"),
            "plugin.remote",
            json!({"kind":"next","document":first,"stream":stream}),
        );
    }
    scene
        .factory
        .sources
        .next_entered
        .acquire_many(40)
        .await
        .unwrap()
        .forget();
    let mut submit = call(&writer, &writer_target, first, "original-operation");
    submit["input"] = json!({"kind":"submit","route":"original-operation","revision":"1","action":"save","fields":{},"locale":"en"});
    let receipt = rpc(&mut scene.peer, submit).await["value"].clone();
    assert_eq!(
        receipt,
        json!({"kind":"applied","route":{"operation":"original-operation","writes":1}})
    );
    assert_eq!(writes.load(Ordering::SeqCst), 1);
    // A single-stream close and whole-document close do not compete for work
    // permits held by a sleeping provider or abandon its original Next future.
    scene.peer.send_rpc(
        "close-one",
        "plugin.remote",
        json!({"kind":"close","document":first,"stream":pending[0]}),
    );
    let replies = [
        response(&mut scene.peer).await,
        response(&mut scene.peer).await,
    ];
    assert!(
        replies
            .iter()
            .any(|reply| reply["requestId"] == "close-one" && reply["ok"] == true)
    );
    assert!(
        replies.iter().any(|reply| reply["requestId"] == "idle-0"
            && reply["error"]["code"] == "operation_conflict")
    );
    scene.peer.send_rpc(
        "close-first",
        "plugin.remote",
        json!({"kind":"close_document","document":first}),
    );
    for _ in 0..40 {
        let reply = response(&mut scene.peer).await;
        if reply["requestId"] == "close-first" {
            assert_eq!(reply["ok"], true, "{reply}");
        } else {
            assert!(reply["requestId"].as_str().unwrap().starts_with("idle-"));
            assert_eq!(reply["error"]["code"], "operation_conflict", "{reply}");
        }
    }
    for document in &documents[1..] {
        rpc(
            &mut scene.peer,
            json!({"kind":"close_document","document":document}),
        )
        .await;
    }
    assert_eq!(scene.factory.sources.closed.load(Ordering::SeqCst), 552);
    assert_eq!(writes.load(Ordering::SeqCst), 1);
    business(&mut scene.peer).await;
    assert_eq!(bind(&mut scene.peer, "write").await.1, writer_target);
    scene.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
async fn calls_waiting_on_a_source_leave_its_owned_next_and_close_runnable() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let mut scene = fixture::Scene::new().await;
        let (method, target) = bind(&mut scene.peer, "activity-read").await;
        let (source, source_target) = bind(&mut scene.peer, "changed").await;
        let document = document(&mut scene.peer).await;
        let stream = rpc(
            &mut scene.peer,
            json!({"kind":"open","binding":source,
            "target":source_target,"document":document,"input":"release-dependent-calls"}),
        )
        .await["stream"]
            .clone();
        let request = json!({"kind":"call","binding":method,"target":target,
            "document":document,"input":{"waitForSource":true}});
        for index in 0..32 {
            scene.peer.send_rpc(
                &format!("dependent-{index}"),
                "plugin.remote",
                request.clone(),
            );
        }
        // All ordinary document permits are held by admitted calls whose actual
        // result depends on the source; another ordinary Call must still reject.
        scene
            .factory
            .sources
            .calls_waiting
            .acquire_many(32)
            .await
            .unwrap()
            .forget();
        assert_eq!(
            scene.peer.rpc("plugin.remote", request).await["error"]["code"],
            "invalid_request"
        );
        assert_eq!(scene.factory.sources.reads.load(Ordering::SeqCst), 32);
        scene.peer.send_rpc(
            "deliver",
            "plugin.remote",
            json!({"kind":"next","document":document,"stream":stream}),
        );
        let mut completed = std::collections::HashSet::new();
        for _ in 0..33 {
            let reply = response(&mut scene.peer).await;
            assert_eq!(reply["ok"], true, "{reply}");
            let id = reply["requestId"].as_str().unwrap();
            assert!(completed.insert(id.to_owned()));
            if id == "deliver" {
                assert_eq!(reply["result"]["item"], "release-dependent-calls");
            } else {
                assert!(id.starts_with("dependent-"));
                assert_eq!(reply["result"]["value"]["document"], document);
            }
        }
        assert!(completed.contains("deliver"));
        rpc(
            &mut scene.peer,
            json!({"kind":"close","document":document,"stream":stream}),
        )
        .await;
        rpc(
            &mut scene.peer,
            json!({"kind":"close_document","document":document}),
        )
        .await;
        assert_eq!(scene.factory.sources.closed.load(Ordering::SeqCst), 1);
        scene.close().await;
    })
    .await
    .unwrap();
}
