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
mod observations;
use super::super::{ready, rpc, success};
use crate::support::peer::Peer;
use fixture::{Scene, bind, call, document, model, read, stats, submit};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
const PACKAGE: &str = "example.installed-pages";

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn installed_presenter_isolates_two_documents_and_one_business_job() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let mut scene = Scene::new().await;
        let mut failing = Peer::new(scene.host.clone(), "page-a").await;
        let mut sibling = Peer::new(scene.host.clone(), "page-b").await;
        let (binding, target) = bind(&mut failing, "page").await;
        let stats_binding = bind(&mut scene.peer, "stats").await;
        let stats_doc = document(&mut scene.peer).await;
        let b = document(&mut sibling).await;
        let first = model(rpc(&mut sibling, call(&binding, &target, &b, read(Value::Null))).await);
        assert_eq!(first["factories"], 1);
        for (index, mode) in ["await-loop", "sync-loop"].into_iter().enumerate() {
            let a = document(&mut failing).await;
            let warm = model(
                rpc(
                    &mut failing,
                    call(&binding, &target, &a, read(json!({"original":"original"}))),
                )
                .await,
            );
            assert_eq!(warm["model"]["request"]["route"]["original"], "original");
            let before = stats(&mut scene.peer, &stats_binding, &stats_doc).await;
            let request = call(&binding, &target, &a, read(json!({"mode":mode})));
            let fault = tokio::spawn(async move {
                let result = failing.rpc("plugin.remote", request).await;
                (failing, result)
            });
            tokio::task::yield_now().await;
            if mode == "await-loop" {
                loop {
                    let value = stats(&mut scene.peer, &stats_binding, &stats_doc).await;
                    if value["requests"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|item| item["request"]["route"]["mode"] == mode)
                    {
                        break;
                    }
                }
            }
            let live =
                model(rpc(&mut sibling, call(&binding, &target, &b, read(Value::Null))).await);
            assert_eq!(live["factories"], 1);
            assert_eq!(live["reads"], index + 2);
            assert_eq!(live["lateRejected"], index + 1);
            let after = loop {
                let value = stats(&mut scene.peer, &stats_binding, &stats_doc).await;
                if value["ticks"].as_u64() > before["ticks"].as_u64() {
                    break value;
                }
            };
            assert_eq!(after["activations"], 1);
            assert_eq!(after["jobs"], 1);
            assert!(
                !fault.is_finished(),
                "sibling and business job must progress before the UI watchdog finishes"
            );
            let (peer, failure) = fault.await.unwrap();
            failing = peer;
            assert_eq!(failure["ok"], false, "{failure}");
            rpc(&mut failing, json!({"kind":"close_document","document":a})).await;
        }
        std::fs::write(
            scene.fixture.workspace.join("plugin/ui.mjs"),
            "throw new Error('ambient bytes');",
        )
        .unwrap();
        let reopened = document(&mut failing).await;
        let fresh = model(
            rpc(
                &mut failing,
                call(&binding, &target, &reopened, read(Value::Null)),
            )
            .await,
        );
        assert_eq!(fresh["factories"], 1);
        assert_eq!(fresh["reads"], 1);
        let final_stats = stats(&mut scene.peer, &stats_binding, &stats_doc).await;
        assert_eq!(final_stats["activations"], 1);
        assert_eq!(final_stats["jobs"], 1);
        failing.close().await;
        sibling.close().await;
        scene.close().await;
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn installed_presenter_preserves_backend_receipts_and_private_read_authority() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let mut scene = Scene::new().await;
        let (binding,target) = bind(&mut scene.peer,"page").await;
        let stats_binding = bind(&mut scene.peer,"stats").await;
        let admin = document(&mut scene.peer).await;
        for method in ["backend", "page.backend"] {
            let denied = scene.peer.rpc("plugin.remote",json!({"kind":"bind","binding":{"packageId":PACKAGE,"method":method,"sessionId":null}})).await;
            assert_eq!(denied["ok"],false,"{denied}");
        }
        for method in ["register-inline", "register-forged-resource"] {
            let registration = bind(&mut scene.peer,method).await;
            assert_eq!(rpc(&mut scene.peer,call(&registration.0,&registration.1,&admin,Value::Null)).await["value"],true);
        }
        let invalid = bind(&mut scene.peer,"register-invalid").await;
        for entry in ["../ui.mjs","/ui.mjs","https://invalid/ui.mjs","missing.mjs","bad.mjs"] {
            assert_eq!(rpc(&mut scene.peer,call(&invalid.0,&invalid.1,&admin,json!(entry))).await["value"],true);
        }
        for (operation,action) in [("fake","fake"),("overridden","override"),("written-before-loop","after-loop"),("refused","rejected")] {
            let doc = document(&mut scene.peer).await;
            let input = submit(operation,action);
            let reply = scene.peer.rpc("plugin.remote",call(&binding,&target,&doc,input.clone())).await;
            if action == "fake" {
                assert_eq!(reply["error"]["code"],"outcome_unknown","{reply}");
            } else if action == "rejected" {
                assert_eq!(success(reply)["value"]["kind"],"rejected");
            } else {
                assert_eq!(success(reply)["value"],json!({"kind":"applied","route":{"operation":operation}}));
            }
            let observed = stats(&mut scene.peer,&stats_binding,&admin).await;
            let requests = observed["requests"].as_array().unwrap();
            let submitted = requests.iter().filter(|item| item["request"]["kind"] == "submit" && item["request"]["route"]["operation"] == operation).collect::<Vec<_>>();
            if action == "fake" { assert!(submitted.is_empty()); }
            else {
                assert_eq!(submitted.len(),1);
                assert_eq!(submitted[0]["request"],input);
                assert_eq!(submitted[0]["document"],doc);
                assert_eq!(submitted[0]["client"],"presenter-installed");
            }
            rpc(&mut scene.peer,json!({"kind":"close_document","document":doc})).await;
        }
        assert_eq!(stats(&mut scene.peer,&stats_binding,&admin).await["writes"],2);
        let recovery = document(&mut scene.peer).await;
        let original = json!({"kind":"recover","route":{"operation":"written-before-loop"},"locale":"zh-TW"});
        let result = rpc(&mut scene.peer,call(&binding,&target,&recovery,original.clone())).await;
        assert_eq!(result["value"],json!({"kind":"applied","route":{"operation":"written-before-loop"}}));
        let observed = stats(&mut scene.peer,&stats_binding,&admin).await;
        assert_eq!(observed["requests"].as_array().unwrap().last().unwrap()["request"],original);
        rpc(&mut scene.peer,json!({"kind":"close_document","document":recovery})).await;
        let readonly = document(&mut scene.peer).await;
        let input = read(json!({"mode":"readonly","path":scene.fixture.workspace}));
        let value = model(rpc(&mut scene.peer,call(&binding,&target,&readonly,input)).await);
        assert!(value["model"]["denied"].as_str().unwrap().contains("Host paths"),"{value}");
        assert_eq!(value["keys"],json!(["backend","locale","signal","t"]));
        assert_eq!(stats(&mut scene.peer,&stats_binding,&admin).await["writes"],2);
        rpc(&mut scene.peer,json!({"kind":"close_document","document":readonly})).await;
        let large = document(&mut scene.peer).await;
        assert_eq!(scene.peer.rpc("plugin.remote",call(&binding,&target,&large,read(json!({"mode":"large"})))).await["ok"],false);
        rpc(&mut scene.peer,json!({"kind":"close_document","document":large})).await;
        scene.close().await;
    }).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn installed_updated_receipt_keeps_document_state_and_survives_ui_retirement() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let mut scene = Scene::new().await;
        let (binding, target) = bind(&mut scene.peer, "page").await;
        let doc = document(&mut scene.peer).await;
        let before = model(
            rpc(
                &mut scene.peer,
                call(&binding, &target, &doc, read(Value::Null)),
            )
            .await,
        );
        assert_eq!(before["reads"], 1);
        assert_eq!(before["updates"], 0);
        let input = submit("in-place", "updated");
        assert_eq!(
            rpc(&mut scene.peer, call(&binding, &target, &doc, input)).await["value"],
            json!({"kind":"updated"})
        );
        let after = model(
            rpc(
                &mut scene.peer,
                call(&binding, &target, &doc, read(Value::Null)),
            )
            .await,
        );
        assert_eq!(after["reads"], 2);
        assert_eq!(after["updates"], 1);
        assert_eq!(after["factories"], 1);
        let sibling = document(&mut scene.peer).await;
        let independent = model(
            rpc(
                &mut scene.peer,
                call(&binding, &target, &sibling, read(Value::Null)),
            )
            .await,
        );
        assert_eq!(independent["updates"], 0);
        let input = submit("in-place-fault", "updated-after-loop");
        assert_eq!(
            rpc(&mut scene.peer, call(&binding, &target, &doc, input)).await["value"],
            json!({"kind":"updated"})
        );
        assert_eq!(
            scene
                .peer
                .rpc(
                    "plugin.remote",
                    call(&binding, &target, &doc, read(Value::Null))
                )
                .await["ok"],
            false
        );
        rpc(
            &mut scene.peer,
            json!({"kind":"close_document","document":doc}),
        )
        .await;
        // A new page cannot claim the retired page's transient operation was restored.
        let recovery = json!({"kind":"recover","route":{"operation":"in-place"},"locale":"en"});
        assert_eq!(
            rpc(&mut scene.peer, call(&binding, &target, &sibling, recovery)).await["value"],
            json!({"kind":"unrecorded"})
        );
        rpc(
            &mut scene.peer,
            json!({"kind":"close_document","document":sibling}),
        )
        .await;
        scene.close().await;
    })
    .await
    .unwrap();
}
