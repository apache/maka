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
use crate::plugins::javascript::presenter::tests::caller;
use serde_json::json;

struct BackendCalls(Mutex<Vec<(Value, Caller)>>);
impl Method for BackendCalls {
    fn call(&self, input: Value, caller: Caller) -> BoxFuture<'static, Result<Value, Error>> {
        self.0.lock().unwrap().push((input.clone(), caller));
        Box::pin(async move {
            Ok(match input["kind"].as_str() {
                Some("read") if input["route"] == "large" => json!("x".repeat(64 * 1024)),
                Some("read") => json!({"original":input}),
                _ => json!({"kind":"applied","route":input["route"]}),
            })
        })
    }
}
fn backend(bridge: &PageBridge, id: &str) -> BoxFuture<'static, Result<Value, VmError>> {
    bridge.call("page.backend".into(), json!({"authority":id}))
}
#[tokio::test]
async fn backend_tickets_preserve_exact_request_caller_and_receipt_authority() {
    let calls = Arc::new(BackendCalls(Mutex::default()));
    let bridge = Arc::new(PageBridge::new(calls.clone()));
    assert!(
        backend(&bridge, "initialization-has-no-ticket")
            .await
            .is_err()
    );
    let original_caller = caller(uuid::Uuid::new_v4());
    for input in [
        json!({"kind":"read","route":{"original":true},"locale":"zh-TW"}),
        json!({"kind":"submit","route":{"receipt":"original"},"revision":"r1","action":"save","fields":{"secret":"original"},"grant":null,"locale":"zh-CN"}),
        json!({"kind":"recover","route":{"receipt":"original"},"locale":"en"}),
    ] {
        let guard = bridge.enter(&input, original_caller.clone()).unwrap();
        assert!(
            bridge
                .call(
                    "page.backend".into(),
                    json!({"authority":guard.id,"input":{"kind":"submit"}})
                )
                .await
                .is_err()
        );
        assert!(
            bridge
                .call(
                    "page.read".into(),
                    json!({"authority":guard.id,"key":"secret"})
                )
                .await
                .is_err()
        );
        let result = backend(&bridge, &guard.id).await.unwrap();
        assert!(backend(&bridge, &guard.id).await.is_err());
        {
            let values = calls.0.lock().unwrap();
            let (captured, caller) = values.last().unwrap();
            assert_eq!(captured, &input);
            assert_eq!(caller.document_id, original_caller.document_id);
            assert_eq!(caller.connection_id, original_caller.connection_id);
            assert_eq!(
                caller.client_instance_id,
                original_caller.client_instance_id
            );
            assert!(Arc::ptr_eq(&caller.views, &original_caller.views));
            assert!(Arc::ptr_eq(&caller.resources, &original_caller.resources));
        }
        if input["kind"] != "read" {
            assert_eq!(
                guard
                    .resolve(Ok(json!({"kind":"applied","route":"forged"})))
                    .unwrap(),
                result
            );
            assert_eq!(guard.resolve(Err(Error::Cancelled)).unwrap(), result);
        }
        let id = guard.id.clone();
        drop(guard);
        assert!(backend(&bridge, &id).await.is_err());
    }
    assert_eq!(calls.0.lock().unwrap().len(), 3);
    let input = json!({"kind":"submit","route":null,"revision":"r1","action":"save","fields":{},"locale":"en"});
    let guard = bridge.enter(&input, caller(uuid::Uuid::new_v4())).unwrap();
    assert!(
        guard
            .resolve(Ok(json!({"kind":"applied","route":null})))
            .is_err()
    );
    bridge.cancel();
    assert!(backend(&bridge, &guard.id).await.is_err());
    bridge.drained().await.unwrap();
}
#[tokio::test]
async fn backend_read_model_is_bounded_and_cancelled_tickets_never_dispatch() {
    let calls = Arc::new(BackendCalls(Mutex::default()));
    let bridge = Arc::new(PageBridge::new(calls.clone()));
    let input = json!({"kind":"read","route":"large","locale":"en"});
    let cx = caller(uuid::Uuid::new_v4());
    let guard = bridge.enter(&input, cx.clone()).unwrap();
    assert!(backend(&bridge, &guard.id).await.is_err());
    assert!(guard.outcome().is_none());
    let next = bridge.enter(&input, cx.clone()).unwrap();
    cx.cancellation.cancel();
    assert!(backend(&bridge, &next.id).await.is_err());
    assert_eq!(calls.0.lock().unwrap().len(), 1);
    bridge.cancel();
    bridge.drained().await.unwrap();
}
