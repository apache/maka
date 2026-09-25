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
use uuid::Uuid;

fn open(binding: &Value, target: &Value, document: &Value, input: Value) -> Value {
    json!({"kind":"open","binding":binding,"target":target,"document":document,"input":input})
}
fn mount(token: Uuid, route: &str) -> Value {
    json!({"resource":"activity","mount":token,"route":route,"locale":"en"})
}
async fn next(peer: &mut Peer, document: &Value, stream: &Value) -> Value {
    rpc(
        peer,
        json!({"kind":"next","document":document,"stream":stream}),
    )
    .await["item"]
        .clone()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
async fn page_observations_route_only_exact_members_and_close_only_owned_instances() {
    tokio::time::timeout(Duration::from_secs(20), async {
        let mut scene = fixture::Scene::new().await;
        let (page, page_target) = bind(&mut scene.peer, "page").await;
        let (changes, changes_target) = bind(&mut scene.peer, "changed").await;
        let (reader, reader_target) = bind(&mut scene.peer, "activity-read").await;
        let (source, source_target) = bind(&mut scene.peer, "activity-stream").await;
        let (outsider, outsider_target) = bind(&mut scene.peer, "non-member").await;
        let a = document(&mut scene.peer).await;
        let b = document(&mut scene.peer).await;
        for document in [&a, &b] {
            rpc(&mut scene.peer, call(&page, &page_target, document, "read")).await;
        }
        let changes_stream = rpc(
            &mut scene.peer,
            open(&changes, &changes_target, &a, Value::Null),
        )
        .await["stream"]
            .clone();
        let first = Uuid::new_v4();
        let second = Uuid::new_v4();
        let first_input = mount(first, "alpha");
        let second_input = mount(second, "beta");
        let one = rpc(
            &mut scene.peer,
            open(&source, &source_target, &a, first_input.clone()),
        )
        .await["stream"]
            .clone();
        let two = rpc(
            &mut scene.peer,
            open(&source, &source_target, &a, second_input.clone()),
        )
        .await["stream"]
            .clone();
        let sibling = rpc(
            &mut scene.peer,
            open(
                &source,
                &source_target,
                &b,
                mount(Uuid::new_v4(), "sibling"),
            ),
        )
        .await["stream"]
            .clone();
        assert_eq!(next(&mut scene.peer, &a, &one).await, first_input);
        assert_eq!(next(&mut scene.peer, &a, &two).await, second_input);
        let read = json!({"kind":"call","binding":reader,"target":reader_target,"document":a,
            "input":{"resource":"activity","mount":first,"fence":1,"direction":"tail"}});
        assert_eq!(
            rpc(&mut scene.peer, read.clone()).await["value"]["input"]["mount"],
            json!(first)
        );
        assert_eq!(scene.factory.sources.reads.load(Ordering::SeqCst), 1);
        for request in [
            open(&outsider, &outsider_target, &a, Value::Null),
            open(&changes, &changes_target, &a, json!({})),
            open(
                &source,
                &source_target,
                &a,
                json!({"resource":"wrong","mount":first,"route":null,"locale":"en"}),
            ),
            open(
                &source,
                &source_target,
                &a,
                json!({"resource":"activity","route":null,"locale":"en"}),
            ),
            open(
                &source,
                &source_target,
                &a,
                json!({"resource":"activity","mount":"bad","route":null,"locale":"en"}),
            ),
        ] {
            assert_eq!(scene.peer.rpc("plugin.remote", request).await["ok"], false);
        }
        let mut wrong_read = read.clone();
        wrong_read["input"]["resource"] = json!("wrong");
        assert_eq!(
            scene.peer.rpc("plugin.remote", wrong_read).await["ok"],
            false
        );
        assert_eq!(scene.factory.sources.reads.load(Ordering::SeqCst), 1);
        assert_eq!(scene.factory.sources.opened.load(Ordering::SeqCst), 4);

        // Closing one mount leaves its document and another same-source mount live.
        rpc(
            &mut scene.peer,
            json!({"kind":"close","document":a,"stream":one}),
        )
        .await;
        assert_eq!(next(&mut scene.peer, &a, &two).await, second_input);
        assert!(next(&mut scene.peer, &a, &changes_stream).await.is_null());
        assert_eq!(
            scene
                .peer
                .rpc("plugin.remote", call(&page, &page_target, &a, "fault"))
                .await["error"]["code"],
            "operation_unavailable"
        );
        scene
            .factory
            .sources
            .completed
            .acquire_many(3)
            .await
            .unwrap()
            .forget();
        assert_eq!(scene.factory.sources.closed.load(Ordering::SeqCst), 3);
        assert_eq!(
            next(&mut scene.peer, &b, &sibling).await["route"],
            "sibling"
        );
        business(&mut scene.peer).await;

        // The app remembers the original source registration, even after replacement.
        let publisher = scene.factory.publisher.lock().unwrap().clone().unwrap();
        publisher
            .withdraw::<Endpoint>("example.pages/changed")
            .unwrap();
        let mut staged = Staged::default();
        staged
            .insert("example.pages/changed", scene.factory.sources.stream())
            .unwrap();
        let _replacement = publisher.publish(staged).unwrap();
        let (_, fresh) = bind(&mut scene.peer, "changed").await;
        assert_ne!(fresh, changes_target);
        for target in [&fresh, &changes_target] {
            assert_eq!(
                scene
                    .peer
                    .rpc("plugin.remote", open(&changes, target, &b, Value::Null))
                    .await["error"]["code"],
                "operation_conflict"
            );
        }
        rpc(
            &mut scene.peer,
            json!({"kind":"close_document","document":b}),
        )
        .await;

        // An ordinary source document cannot later acquire a page, even once drained.
        let premature = document(&mut scene.peer).await;
        let early = rpc(
            &mut scene.peer,
            open(
                &source,
                &source_target,
                &premature,
                mount(Uuid::new_v4(), "early"),
            ),
        )
        .await["stream"]
            .clone();
        rpc(
            &mut scene.peer,
            json!({"kind":"close","document":premature,"stream":early}),
        )
        .await;
        assert_eq!(
            scene
                .peer
                .rpc(
                    "plugin.remote",
                    call(&page, &page_target, &premature, "read")
                )
                .await["error"]["code"],
            "operation_conflict"
        );
        rpc(
            &mut scene.peer,
            json!({"kind":"close_document","document":premature}),
        )
        .await;
        scene.close().await;
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
async fn source_cleanup_failure_fences_its_business_owner_after_page_fault() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let mut scene = fixture::Scene::new().await;
        let (page, page_target) = bind(&mut scene.peer, "page").await;
        let (source, source_target) = bind(&mut scene.peer, "activity-stream").await;
        let document = document(&mut scene.peer).await;
        rpc(&mut scene.peer, call(&page, &page_target, &document, "read")).await;
        rpc(&mut scene.peer, open(&source, &source_target, &document, mount(Uuid::new_v4(), "unknown"))).await;
        assert_eq!(scene.peer.rpc("plugin.remote", call(&page, &page_target, &document, "fault")).await["ok"], false);
        assert_eq!(scene.peer.rpc("plugin.remote", json!({"kind":"close_document","document":document})).await["error"]["code"], "operation_unavailable");
        assert_eq!(scene.peer.rpc("plugin.remote", json!({"kind":"bind","binding":{"packageId":"example.pages","method":"business","sessionId":null}})).await["error"]["code"], "operation_conflict");
        scene.close().await;
    }).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
async fn typed_page_outcomes_survive_retirement_and_independent_resource_failure() {
    tokio::time::timeout(Duration::from_secs(20), async {
        for (kind, outcome) in [("submit", "applied"), ("recover", "applied"), ("read", "applied"), ("submit", "consent")] {
            let mut scene = fixture::Scene::new().await;
            let (page, target) = bind(&mut scene.peer, "page").await;
            let document = document(&mut scene.peer).await;
            let mut request = call(&page, &target, &document, &format!("{outcome}-after-fault"));
            request["input"]["kind"] = json!(kind);
            if kind == "submit" {
                request["input"]["revision"] = json!("1");
                request["input"]["action"] = json!("save");
                request["input"]["fields"] = json!({});
            }
            let reply = scene.peer.rpc("plugin.remote", request).await;
            if kind == "read" {
                assert_eq!(reply["error"]["code"], "operation_unavailable");
            } else if outcome == "consent" {
                assert_eq!(reply["result"]["value"]["kind"], "consent");
                assert_eq!(reply["result"]["value"]["request"]["operationId"], "00000000-0000-4000-8000-000000000001");
            } else {
                assert_eq!(reply["result"]["value"], json!({"kind":"applied","route":"saved"}));
            }
            assert_eq!(scene.peer.rpc("plugin.remote", json!({"kind":"close_document","document":document})).await["error"]["code"], "operation_unavailable");
            assert_eq!(scene.peer.rpc("plugin.remote", json!({"kind":"bind","binding":{"packageId":"example.pages","method":"business","sessionId":null}})).await["error"]["code"], "operation_conflict");
            scene.close().await;
        }
    }).await.unwrap();
}
