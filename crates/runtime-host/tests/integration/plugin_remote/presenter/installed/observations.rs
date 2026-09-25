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

async fn open(
    peer: &mut Peer,
    binding: &(Value, Value),
    doc: &Value,
    resource: &Value,
    mount: Uuid,
) -> Value {
    rpc(
        peer,
        json!({"kind":"open","binding":binding.0,"target":binding.1,"document":doc,
        "input":{"resource":resource["id"],"route":null,"locale":"en","mount":mount}}),
    )
    .await["stream"]
        .clone()
}
async fn ready_source(peer: &mut Peer, doc: &Value, stream: &Value) -> Value {
    rpc(peer, json!({"kind":"next","document":doc,"stream":stream})).await["item"]["fence"].clone()
}
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn installed_observation_members_pin_sources_mounts_and_dynamic_publication() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let mut scene = Scene::new().await;
        let app = bind(&mut scene.peer,"page").await;
        let admin = document(&mut scene.peer).await;
        let stats_binding = bind(&mut scene.peer,"stats").await;
        let resource = stats(&mut scene.peer,&stats_binding,&admin).await["resource"].clone();
        let stream = bind(&mut scene.peer,resource["stream"].as_str().unwrap()).await;
        let reader = bind(&mut scene.peer,resource["read"].as_str().unwrap()).await;
        let a = document(&mut scene.peer).await;
        let b = document(&mut scene.peer).await;
        for doc in [&a,&b] { rpc(&mut scene.peer,call(&app.0,&app.1,doc,read(Value::Null))).await; }
        let first = Uuid::new_v4();
        let second = Uuid::new_v4();
        let one = open(&mut scene.peer,&stream,&a,&resource,first).await;
        let two = open(&mut scene.peer,&stream,&a,&resource,second).await;
        let sibling = open(&mut scene.peer,&stream,&b,&resource,Uuid::new_v4()).await;
        let fence = ready_source(&mut scene.peer,&a,&one).await;
        ready_source(&mut scene.peer,&a,&two).await;
        ready_source(&mut scene.peer,&b,&sibling).await;
        for mount in [first,second] {
            let page = rpc(&mut scene.peer,call(&reader.0,&reader.1,&a,json!({"resource":resource["id"],"mount":mount,"fence":fence,"direction":"tail"}))).await;
            assert_eq!(page["value"]["records"].as_array().unwrap().len(),1);
        }
        let ordinary = scene.peer.rpc("plugin.remote",call(&stats_binding.0,&stats_binding.1,&a,Value::Null)).await;
        assert_eq!(ordinary["error"]["code"],"operation_conflict");
        let wrong = scene.peer.rpc("plugin.remote",call(&reader.0,&reader.1,&a,json!({"resource":"foreign","mount":first,"fence":fence,"direction":"tail"}))).await;
        assert_eq!(wrong["error"]["code"],"operation_conflict");
        let fault = scene.peer.rpc("plugin.remote",call(&app.0,&app.1,&a,read(json!({"mode":"await-loop"})))).await;
        assert_eq!(fault["ok"],false);
        rpc(&mut scene.peer,json!({"kind":"close_document","document":a})).await;
        assert_eq!(stats(&mut scene.peer,&stats_binding,&admin).await["source"]["active"],1);
        assert_eq!(model(rpc(&mut scene.peer,call(&app.0,&app.1,&b,read(Value::Null))).await)["factories"],1);
        let replace = bind(&mut scene.peer,"replace-source").await;
        rpc(&mut scene.peer,call(&replace.0,&replace.1,&admin,Value::Null)).await;
        let new_stream = bind(&mut scene.peer,resource["stream"].as_str().unwrap()).await;
        assert_ne!(new_stream.1,stream.1);
        let rejected = scene.peer.rpc("plugin.remote",json!({"kind":"open","binding":new_stream.0,"target":new_stream.1,"document":b,
            "input":{"resource":resource["id"],"route":null,"locale":"en","mount":Uuid::new_v4()}})).await;
        assert_eq!(rejected["error"]["code"],"operation_conflict");
        let dynamic = bind(&mut scene.peer,"dynamic").await;
        let fresh = document(&mut scene.peer).await;
        rpc(&mut scene.peer,call(&dynamic.0,&dynamic.1,&fresh,read(Value::Null))).await;
        let opened = open(&mut scene.peer,&new_stream,&fresh,&resource,Uuid::new_v4()).await;
        assert!(ready_source(&mut scene.peer,&fresh,&opened).await.is_number());
        scene.close().await;
    }).await.unwrap();
}
