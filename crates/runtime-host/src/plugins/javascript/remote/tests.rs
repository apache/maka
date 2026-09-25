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
use maka_js_runtime::plugin::{Limits, Vm};
use std::time::Duration;
use tokio::sync::Semaphore;

mod fixture;
mod retention;

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
async fn idle_streams_preserve_business_capacity_and_close_under_saturated_work() {
    tokio::time::timeout(Duration::from_secs(20), scenario())
        .await
        .unwrap();
}

async fn scenario() {
    let vm = Vm::new(Limits::default()).unwrap();
    let started = Arc::new(fixture::Started(Semaphore::new(0)));
    let module = vm
        .load_plugin(
            "idle-streams.mjs".into(),
            fixture::SOURCE.into(),
            started.clone(),
        )
        .unwrap();
    let registrations = module
        .call(vec!["activate".into()], vec![json!({}), Value::Null])
        .await
        .unwrap();
    let calls = Arc::new(super::super::invocation::Calls::new(Default::default()));
    let provider = fixture::remote(&module, &registrations, &calls, "idle");
    let stats = fixture::remote(&module, &registrations, &calls, "stats");
    let mut streams = Vec::new();
    let mut documents = Vec::new();
    for _ in 0..130 {
        let caller = fixture::caller();
        documents.push(caller.document_id);
        streams.push(provider.open(Value::Null, caller).await.unwrap());
    }
    let state = stats.call(Value::Null, fixture::caller()).await.unwrap();
    assert_eq!(state["opened"], 130);
    let authorities: Vec<String> = state["authorities"]
        .as_array()
        .unwrap()
        .iter()
        .map(|id| id.as_str().unwrap().to_owned())
        .collect();
    for (authority, document) in authorities.iter().zip(documents) {
        assert_eq!(calls.remote(authority).unwrap().document_id, document);
    }
    let mut next = Box::pin(futures_util::future::join_all(
        streams.iter().map(|stream| stream.next()),
    ));
    assert!(futures_util::poll!(next.as_mut()).is_pending());
    loop {
        let state = stats.call(Value::Null, fixture::caller()).await.unwrap();
        if state["waiting"] == 130 {
            break;
        }
        tokio::task::yield_now().await;
    }
    // All 130 iterator promises are idle, while an ordinary business call works.
    assert_eq!(
        stats.call(Value::Null, fixture::caller()).await.unwrap()["activations"],
        1
    );
    assert!(
        streams[0].next().await.is_err(),
        "one pending Next per real SDK handle"
    );
    assert!(module.stream_next("missing-stream").await.is_err());

    let blocker = vm
        .load_with_bridge(
            "ordinary-work.mjs".into(),
            fixture::BLOCKER.into(),
            Some(started.clone()),
        )
        .unwrap();
    assert!(
        blocker
            .stream_next("stream-1")
            .await
            .unwrap_err()
            .to_string()
            .contains("SDK plugin")
    );
    assert!(
        blocker
            .stream_close("stream-1")
            .await
            .unwrap_err()
            .to_string()
            .contains("SDK plugin")
    );
    let mut work = Vec::new();
    for _ in 0..128 {
        let blocker = blocker.clone();
        work.push(tokio::spawn(async move {
            blocker
                .call(vec!["wait".into()], vec![json!(blocker.host_key())])
                .await
        }));
        // Each bridge acknowledgement proves a distinct ordinary call was
        // dispatched and keeps its Promise pending until the reserved release.
        started.0.acquire().await.unwrap().forget();
    }
    assert!(
        stats
            .call(Value::Null, fixture::caller())
            .await
            .unwrap_err()
            .to_string()
            .contains("VM call capacity exhausted")
    );
    for stream in &streams {
        stream.cancel();
    }
    for result in next.await {
        assert!(result.unwrap().is_none());
    }
    // Work is still saturated: both cancel and close must use reserved control.
    for stream in streams {
        stream.close().await.unwrap();
    }
    for authority in &authorities {
        assert!(calls.remote(authority).is_err());
    }
    blocker.cancel_call("release".into()).await.unwrap();
    for task in work {
        assert_eq!(task.await.unwrap().unwrap(), "released");
    }
    let state = stats.call(Value::Null, fixture::caller()).await.unwrap();
    assert_eq!(state["activations"], 1);
    assert_eq!(state["waiting"], 0);
    assert_eq!(state["closed"], 130);
    drop(provider);
    drop(stats);
    module.close().await.unwrap();
    blocker.close().await.unwrap();
    assert_eq!(vm.statistics(false).await.unwrap().pending_calls, 0);
    vm.shutdown().await;
}
