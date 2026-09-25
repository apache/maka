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
use maka_js_runtime::plugin::{Bridge, Error as VmError};

#[derive(Default)]
struct Withdrawals(Mutex<Vec<Value>>);
impl Bridge for Withdrawals {
    fn call(&self, method: String, input: Value) -> BoxFuture<'static, Result<Value, VmError>> {
        assert_eq!(method, "contribution.withdraw");
        self.0.lock().unwrap().push(input);
        Box::pin(async { Ok(json!({"ok":true,"value":null})) })
    }
}

struct Reader {
    stream: Box<dyn Stream>,
    caller: Caller,
    mount: uuid::Uuid,
    fence: u64,
}
impl Reader {
    fn query(&self, direction: &str, cursor: Value) -> Value {
        json!({"resource":"pressure","mount":self.mount,"fence":self.fence,
            "direction":direction,"cursor":cursor})
    }
    async fn close(self, read: &Remote) {
        let query = self.query("tail", Value::Null);
        self.stream.close().await.unwrap();
        assert!(matches!(
            read.call(query, self.caller).await,
            Err(Error::Retired)
        ));
    }
}

async fn readers(provider: &Remote, fence: u64) -> Vec<Reader> {
    let mut readers = Vec::new();
    for _ in 0..8 {
        let caller = fixture::caller();
        let mount = uuid::Uuid::new_v4();
        let stream = provider
            .open(
                json!({"resource":"pressure","mount":mount,
            "route":null,"locale":"en"}),
                caller.clone(),
            )
            .await
            .unwrap();
        assert_eq!(
            stream.next().await.unwrap().unwrap(),
            json!({"kind":"ready","fence":fence})
        );
        readers.push(Reader {
            stream,
            caller,
            mount,
            fence,
        });
    }
    readers
}

async fn page(read: &Remote, reader: &Reader, revision: &str) -> u64 {
    let first = read
        .call(reader.query("tail", Value::Null), reader.caller.clone())
        .await
        .unwrap();
    assert_eq!(first["fence"], reader.fence);
    assert!(serde_json::to_vec(&first).unwrap().len() < 64 * 1024);
    let records = first["records"].as_array().unwrap();
    assert!(!records.is_empty());
    let total = records[0]["total"].as_u64().unwrap();
    let mut offset = 0;
    for record in records {
        assert_eq!(record["kind"], "fragment");
        assert_eq!(record["revision"], revision);
        assert_eq!(record["offset"], offset);
        assert_eq!(record["total"], total);
        assert!(record["json"].as_str().unwrap().contains('界'));
        offset += record["json"].as_str().unwrap().len() as u64;
    }
    assert!(first["continuation"].is_string());
    let next = read
        .call(
            reader.query("continue", first["continuation"].clone()),
            reader.caller.clone(),
        )
        .await
        .unwrap();
    assert_eq!(next["fence"], reader.fence);
    assert_eq!(next["records"][0]["revision"], revision);
    assert_eq!(next["records"][0]["offset"], offset);
    assert!(serde_json::to_vec(&next).unwrap().len() < 64 * 1024);
    total
}

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
async fn large_transcript_history_evicts_old_fences_within_the_real_business_heap() {
    tokio::time::timeout(Duration::from_secs(30), scenario())
        .await
        .unwrap();
}

async fn scenario() {
    let limits = Limits::default();
    assert_eq!(limits.heap_bytes, 128 * 1024 * 1024);
    let vm = Vm::new(limits).unwrap();
    let withdrawals = Arc::new(Withdrawals::default());
    let module = vm
        .load_plugin(
            "retention-pressure.mjs".into(),
            fixture::RETENTION.into(),
            withdrawals.clone(),
        )
        .unwrap();
    let registrations = module
        .call(vec!["activate".into()], vec![json!({}), Value::Null])
        .await
        .unwrap();
    let calls = Arc::new(super::super::super::invocation::Calls::new(
        Default::default(),
    ));
    let provider = fixture::remote(&module, &registrations, &calls, "pressure.stream");
    let read = fixture::remote(&module, &registrations, &calls, "pressure.read");
    let control = fixture::remote(&module, &registrations, &calls, "control");
    let oldest = readers(&provider, 0).await;
    let encoded = page(&read, &oldest[0], "1").await;
    assert!(encoded > 9 * 1024 * 1024);
    assert!(encoded * 3 < 32 * 1024 * 1024);
    assert!(encoded * 4 > 32 * 1024 * 1024);
    control
        .call(json!({"kind":"replace","revision":2}), fixture::caller())
        .await
        .unwrap();
    let middle = readers(&provider, 2).await;
    control
        .call(json!({"kind":"replace","revision":3}), fixture::caller())
        .await
        .unwrap();
    let recent = readers(&provider, 4).await;
    let before = control
        .call(json!({"kind":"stats"}), fixture::caller())
        .await
        .unwrap();
    assert_eq!(before["textBytes"], 9 * 1024 * 1024);
    assert_eq!(before["active"], 24);
    assert_eq!(
        before["invalidated"], 0,
        "readers share each historical version's byte cost"
    );
    let after = control
        .call(json!({"kind":"replace","revision":4}), fixture::caller())
        .await
        .unwrap();
    assert_eq!(after["activations"], 1);
    assert_eq!(after["invalidated"], 8);
    assert_eq!(after["active"], 16);
    for reader in &oldest {
        assert_eq!(
            reader.stream.next().await.unwrap().unwrap(),
            json!({"kind":"invalidated"})
        );
        assert!(reader.stream.next().await.unwrap().is_none());
        assert!(matches!(
            read.call(reader.query("tail", Value::Null), reader.caller.clone())
                .await,
            Err(Error::Retired)
        ));
    }
    assert_eq!(page(&read, &middle[0], "2").await, encoded);
    assert_eq!(page(&read, &recent[0], "3").await, encoded);
    let replacement = recent[0].stream.next().await.unwrap().unwrap();
    assert_eq!(replacement["kind"], "replace");
    assert_eq!(replacement["base"], 4);
    assert_eq!(replacement["revision"], 5);
    assert_eq!(replacement["record"]["revision"], "4");
    assert!(serde_json::to_vec(&replacement).unwrap().len() < 64 * 1024);
    let current = readers(&provider, 6).await;
    assert_eq!(page(&read, &current[0], "4").await, encoded);
    for reader in oldest
        .into_iter()
        .chain(middle)
        .chain(recent)
        .chain(current)
    {
        reader.close(&read).await;
    }
    let empty = control
        .call(json!({"kind":"stats"}), fixture::caller())
        .await
        .unwrap();
    assert_eq!(empty["active"], 0);
    assert_eq!(empty["closed"], 32);
    let reopened = readers(&provider, 6).await;
    assert_eq!(page(&read, &reopened[0], "4").await, encoded);
    for reader in reopened {
        reader.close(&read).await;
    }
    for _ in 0..2 {
        let ended = control
            .call(json!({"kind":"close"}), fixture::caller())
            .await
            .unwrap();
        assert_eq!(ended["activations"], 1);
        assert_eq!(ended["active"], 0);
        assert_eq!(ended["opened"], 40);
        assert_eq!(ended["closed"], 40);
    }
    {
        let withdrawn = withdrawals.0.lock().unwrap();
        assert_eq!(
            withdrawn.len(),
            2,
            "resource close withdraws each registration once"
        );
        for (kind, name) in [
            ("remote_method", "pressure.read"),
            ("remote_stream", "pressure.stream"),
        ] {
            assert!(
                withdrawn
                    .iter()
                    .any(|value| value == &json!({"kind":kind,"names":[name]}))
            );
        }
    }
    assert!(
        !vm.is_terminated(),
        "large retained sources must fit the unchanged VM heap policy"
    );
    drop(provider);
    drop(read);
    drop(control);
    module.close().await.unwrap();
    assert_eq!(vm.statistics(false).await.unwrap().pending_calls, 0);
    vm.shutdown().await;
}
