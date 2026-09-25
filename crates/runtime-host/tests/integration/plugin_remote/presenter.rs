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

mod fixture;
mod installed;
mod observations;
mod sources;

use super::{ClientFixture, Host, HostOptions, LocalListener, Peer, Setup, ready, response, rpc};
use maka_plugins::{contributions::Staged, remote::Endpoint};
use serde_json::{Value, json};
use std::{
    sync::{Arc, atomic::Ordering},
    time::Duration,
};
use tokio_util::sync::CancellationToken;

async fn bind(peer: &mut Peer, method: &str) -> (Value, Value) {
    let binding = json!({"packageId":"example.pages","method":method,"sessionId":null});
    let target = rpc(peer, json!({"kind":"bind","binding":binding})).await["target"].clone();
    (binding, target)
}
async fn document(peer: &mut Peer) -> Value {
    rpc(peer, json!({"kind":"open_document"})).await["document"].clone()
}
fn call(binding: &Value, target: &Value, document: &Value, route: &str) -> Value {
    json!({"kind":"call","binding":binding,"target":target,"document":document,
        "input":{"kind":"read","route":route,"locale":"en"}})
}
async fn business(peer: &mut Peer) {
    let (binding, target) = bind(peer, "business").await;
    let document = document(peer).await;
    assert_eq!(
        rpc(peer, call(&binding, &target, &document, "read")).await["value"],
        "business alive"
    );
    rpc(peer, json!({"kind":"close_document","document":document})).await;
}
async fn capacity_returned(factory: &fixture::Factory) {
    drop(factory.slots.clone().acquire_many_owned(2).await.unwrap());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
async fn document_owns_one_page_and_isolates_faults_cancellation_and_replacement() {
    tokio::time::timeout(Duration::from_secs(20), scenario())
        .await
        .unwrap();
}
async fn scenario() {
    let mut scene = fixture::Scene::new().await;
    let (binding, target) = bind(&mut scene.peer, "page").await;
    let a = document(&mut scene.peer).await;
    let b = document(&mut scene.peer).await;
    let mut stale = target.clone();
    stale["registration"] = json!(uuid::Uuid::new_v4());
    let denied = scene
        .peer
        .rpc("plugin.remote", call(&binding, &stale, &a, "read"))
        .await;
    assert_eq!(denied["error"]["code"], "operation_conflict");
    let mut malformed = call(&binding, &target, &a, "read");
    malformed["input"] = json!({"kind":"submit"});
    assert_eq!(
        scene.peer.rpc("plugin.remote", malformed).await["error"]["code"],
        "invalid_request"
    );
    assert_eq!(scene.factory.opens.load(Ordering::SeqCst), 0);
    for id in ["first", "second"] {
        scene.peer.send_rpc(
            id,
            "plugin.remote",
            call(&binding, &target, &a, "concurrent"),
        );
    }
    scene
        .factory
        .entered
        .acquire_many(2)
        .await
        .unwrap()
        .forget();
    assert_eq!(scene.factory.opens.load(Ordering::SeqCst), 1);
    scene.factory.release.add_permits(2);
    let replies = [
        response(&mut scene.peer).await,
        response(&mut scene.peer).await,
    ];
    assert!(
        replies
            .iter()
            .all(|r| r["ok"] == true && r["result"]["value"]["page"] == 1)
    );
    let mut counts = replies.map(|r| r["result"]["value"]["calls"].as_u64().unwrap());
    counts.sort();
    assert_eq!(counts, [1, 2]);
    assert_eq!(
        rpc(&mut scene.peer, call(&binding, &target, &b, "read")).await["value"]["page"],
        2
    );
    let excess = document(&mut scene.peer).await;
    assert_eq!(
        scene
            .peer
            .rpc("plugin.remote", call(&binding, &target, &excess, "read"))
            .await["error"]["code"],
        "operation_unavailable"
    );
    assert_eq!(scene.factory.opens.load(Ordering::SeqCst), 2);
    for method in ["other", "business"] {
        let (other, other_target) = bind(&mut scene.peer, method).await;
        assert_eq!(
            scene
                .peer
                .rpc("plugin.remote", call(&other, &other_target, &a, "read"))
                .await["error"]["code"],
            "operation_conflict"
        );
    }
    assert_eq!(
        scene
            .peer
            .rpc("plugin.remote", call(&binding, &target, &a, "fault"))
            .await["error"]["code"],
        "operation_unavailable"
    );
    assert_eq!(scene.factory.slots.available_permits(), 1);
    assert_eq!(
        scene
            .peer
            .rpc("plugin.remote", call(&binding, &target, &a, "read"))
            .await["error"]["code"],
        "operation_conflict"
    );
    assert_eq!(
        rpc(&mut scene.peer, call(&binding, &target, &b, "read")).await["value"]["calls"],
        2
    );
    business(&mut scene.peer).await;
    assert_eq!(bind(&mut scene.peer, "page").await.1, target);

    let panicking = document(&mut scene.peer).await;
    let mut submit = call(&binding, &target, &panicking, "panic");
    submit["input"] = json!({"kind":"submit","route":"panic","revision":"1","action":"save","fields":{},"locale":"en"});
    assert_eq!(
        scene.peer.rpc("plugin.remote", submit).await["error"]["code"],
        "outcome_unknown"
    );
    assert_eq!(scene.factory.slots.available_permits(), 1);
    business(&mut scene.peer).await;

    let late = document(&mut scene.peer).await;
    scene.peer.send_rpc(
        "pending-page",
        "plugin.remote",
        call(&binding, &target, &late, "late"),
    );
    scene.factory.entered.acquire().await.unwrap().forget();
    scene.peer.send_rpc(
        "close-page",
        "plugin.remote",
        json!({"kind":"close_document","document":late}),
    );
    scene.factory.closing.acquire().await.unwrap().forget();
    assert_eq!(
        scene.factory.slots.available_permits(),
        0,
        "Close has signalled, but actual teardown is still pending"
    );
    scene.factory.release.add_permits(1);
    let replies = [
        response(&mut scene.peer).await,
        response(&mut scene.peer).await,
    ];
    assert!(
        replies
            .iter()
            .any(|r| r["requestId"] == "close-page" && r["ok"] == true)
    );
    assert!(replies.iter().any(|r| r["requestId"] == "pending-page" && r["error"]["code"] == "operation_conflict"));
    assert_eq!(scene.factory.slots.available_permits(), 1);
    assert_eq!(
        scene
            .peer
            .rpc("plugin.remote", call(&binding, &target, &excess, "read"))
            .await["error"]["code"],
        "operation_conflict",
        "failed Open must not retry on the same document"
    );

    // Connection loss closes B even though it has no in-flight call.
    let replacement = Peer::new(scene.host.clone(), "replacement-client").await;
    let departing = std::mem::replace(&mut scene.peer, replacement);
    departing.close().await;
    capacity_returned(&scene.factory).await;
    let idle = document(&mut scene.peer).await;
    rpc(&mut scene.peer, call(&binding, &target, &idle, "read")).await;
    let publisher = scene.factory.publisher.lock().unwrap().clone().unwrap();
    publisher
        .withdraw::<Endpoint>("example.pages/page")
        .unwrap();
    capacity_returned(&scene.factory).await;
    business(&mut scene.peer).await;
    let mut staged = Staged::default();
    staged
        .insert("example.pages/page", scene.factory.endpoint())
        .unwrap();
    let _replacement_registration = publisher.publish(staged).unwrap();
    let (_, fresh) = bind(&mut scene.peer, "page").await;
    assert_ne!(fresh["registration"], target["registration"]);
    assert_eq!(fresh["activation"], target["activation"]);
    assert_eq!(
        scene
            .peer
            .rpc("plugin.remote", call(&binding, &fresh, &idle, "read"))
            .await["error"]["code"],
        "operation_conflict"
    );
    let reopened = document(&mut scene.peer).await;
    assert_eq!(
        scene
            .peer
            .rpc("plugin.remote", call(&binding, &target, &reopened, "read"))
            .await["error"]["code"],
        "operation_conflict"
    );
    rpc(&mut scene.peer, call(&binding, &fresh, &reopened, "read")).await;
    assert_eq!(scene.factory.activations.load(Ordering::SeqCst), 1);
    let factory = scene.factory.clone();
    scene.close().await;
    capacity_returned(&factory).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
async fn unconfirmed_page_resources_keep_document_and_business_fences() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let mut scene = fixture::Scene::new().await;
        let (binding, target) = bind(&mut scene.peer, "page").await;
        let document = document(&mut scene.peer).await;
        let mut submit = call(&binding, &target, &document, "unknown");
        submit["input"] = json!({"kind":"submit","route":"unknown","revision":"1","action":"save","fields":{},"locale":"en"});
        assert_eq!(scene.peer.rpc("plugin.remote", submit).await["error"]["code"], "outcome_unknown");
        assert_eq!(scene.peer.rpc("plugin.remote", json!({"kind":"close_document","document":document})).await["error"]["code"], "operation_unavailable");
        assert_eq!(scene.peer.rpc("plugin.remote", json!({"kind":"bind","binding":{"packageId":"example.pages","method":"business","sessionId":null}})).await["error"]["code"], "operation_conflict");
        scene.close().await;
    }).await.unwrap();
}
