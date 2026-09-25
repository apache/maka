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
use maka_plugins::{remote, terminal_ui::presenter::Factory as _};
use serde_json::json;
use std::collections::BTreeMap;
use tokio::sync::Semaphore;

const SOURCE: &str = r#"
let factories = 0;
export default function create() {
  factories++;
  let reads = 0;
  return {
    async read(route, cx) {
      await cx.backend();
      if (route === 'write') await cx.backend();
      if (route === 'loop') {
        while (true) {}
      }
      return {title:'Page',revision:String(factories),fields:[],actions:[],
        root:{kind:'text',key:'value',spans:[{text:String(++reads),tone:'normal'}]}};
    },
    submit(_input, cx) { return cx.backend(); }
  };
}
"#;
const BUSINESS: &str = r#"
let activations = 0, ticks = 0;
export default async function activate(ctx) {
  activations++;
  await ctx.remote.method('stats', () => ({activations,ticks}));
  ctx.run(async () => { while (!ctx.signal.aborted) { await ctx.sleep(1); ticks++; } });
}
"#;
struct Clock {
    entered: Arc<Semaphore>,
    release: Arc<Semaphore>,
}
impl Bridge for Clock {
    fn call(&self, method: String, _: Value) -> BoxFuture<'static, Result<Value, VmError>> {
        assert_eq!(method, "clock.sleep");
        let entered = self.entered.clone();
        let release = self.release.clone();
        Box::pin(async move {
            entered.add_permits(1);
            release.acquire().await.unwrap().forget();
            Ok(json!({"ok":true,"value":null}))
        })
    }
}
struct Backend(std::sync::Mutex<Vec<(Value, uuid::Uuid)>>, Arc<Semaphore>);
impl Method for Backend {
    fn call(&self, input: Value, caller: Caller) -> BoxFuture<'static, Result<Value, Error>> {
        self.0
            .lock()
            .unwrap()
            .push((input.clone(), caller.document_id));
        if input["route"] == "loop" {
            self.1.add_permits(1);
        }
        Box::pin(async move {
            Ok(if input["kind"] == "read" {
                json!({"model":true})
            } else {
                json!({"kind":"applied","route":null})
            })
        })
    }
}
struct Views;
impl remote::Views for Views {
    fn authorize(
        &self,
        _: maka_plugins::authorization::Request,
    ) -> BoxFuture<'_, Result<maka_plugins::call::Owned, Error>> {
        Box::pin(async { Err(Error::Retired) })
    }
    fn session(&self) -> BoxFuture<'_, Result<remote::SessionView, Error>> {
        Box::pin(async { Err(Error::Retired) })
    }
    fn workspace(
        &self,
        _: remote::WorkspaceViewInput,
    ) -> BoxFuture<'_, Result<remote::SessionView, Error>> {
        Box::pin(async { Err(Error::Retired) })
    }
    fn query_database(
        &self,
        _: maka_plugins::filesystem::database::Read,
    ) -> BoxFuture<
        '_,
        Result<
            Vec<maka_plugins::filesystem::database::Table>,
            maka_plugins::filesystem::database::Error,
        >,
    > {
        panic!("fixture has no database authority")
    }
}
pub(super) fn caller(document_id: uuid::Uuid) -> Caller {
    Caller {
        connection_id: uuid::Uuid::new_v4(),
        client_instance_id: "presenter-test".into(),
        document_id,
        session_id: None,
        access: remote::Access::Granted,
        views: Arc::new(Views),
        resources: Arc::default(),
        cancellation: CancellationToken::new(),
    }
}
fn read(route: Value) -> Value {
    json!({"kind":"read","route":route,"locale":"en"})
}
async fn step(clock: &Clock) {
    clock.release.add_permits(1);
    clock.entered.acquire().await.unwrap().forget();
}
async fn stats(business: &Module) -> Value {
    business
        .call(
            vec!["invoke".into()],
            vec![json!(1), Value::Null, json!({}), json!("stats")],
        )
        .await
        .unwrap()["value"]
        .clone()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
async fn page_vm_failure_preserves_sibling_factory_and_business_job() {
    tokio::time::timeout(Duration::from_secs(10), async {
        let limits = Limits { synchronous_slice: Duration::from_millis(200), ..Limits::default() };
        let clock = Arc::new(Clock { entered: Arc::new(Semaphore::new(0)), release: Arc::new(Semaphore::new(0)) });
        let business_vm = Vm::new(limits.clone()).unwrap();
        let business = business_vm.load_plugin("business.mjs".into(), BUSINESS.into(), clock.clone()).unwrap();
        business.call(vec!["activate".into()], vec![json!({}), Value::Null]).await.unwrap();
        let running = business.clone();
        let job = tokio::spawn(async move { running.start_tasks().await });
        clock.entered.acquire().await.unwrap().forget();
        let entered = Arc::new(Semaphore::new(0));
        let backend = Arc::new(Backend(std::sync::Mutex::default(), entered.clone()));
        let package = Package::new(BTreeMap::from([
            ("maka.extension.json".into(), serde_json::to_vec(&json!({"schemaVersion":1,"id":"example.page","runtime":{"entry":"host.mjs","sdkVersion":2}})).unwrap()),
            ("host.mjs".into(), BUSINESS.as_bytes().to_vec()),
            ("page.mjs".into(), SOURCE.as_bytes().to_vec()),
        ])).unwrap();
        let factory = Factory::new(&package, "page.mjs", limits.clone(), backend.clone(), CancellationToken::new(), vec![]).unwrap();
        assert!(Factory::new(&package, "../page.mjs", limits, backend.clone(), CancellationToken::new(), vec![]).is_err());
        let page_a = factory.open(CancellationToken::new()).unwrap();
        let page_b = factory.open(CancellationToken::new()).unwrap();
        // Keep 33 isolated page VMs alive together. Instance count is not an
        // admission boundary, and each runs its own JavaScript factory.
        let pages: Vec<_> = (0..31).map(|_| factory.open(CancellationToken::new()).unwrap()).collect();
        for (index, page) in pages.iter().enumerate() {
            let value = page.call(read(Value::Null), caller(uuid::Uuid::new_v4())).await
                .unwrap_or_else(|error| panic!("page {} first Read failed: {error}", index + 3));
            assert_eq!(value["view"]["revision"], "1");
            assert_eq!(value["view"]["root"]["spans"][0]["text"], "1");
        }
        let a = caller(uuid::Uuid::new_v4());
        let b = caller(uuid::Uuid::new_v4());
        assert_eq!(page_b.call(read(Value::Null), b.clone()).await.unwrap()["view"]["revision"], "1");
        let fault = tokio::spawn(page_a.call(read(json!("loop")), a));
        entered.acquire().await.unwrap().forget();
        // These complete while A is executing its synchronous loop.
        step(&clock).await;
        let sibling = page_b.call(read(Value::Null), b.clone()).await.unwrap();
        assert_eq!(sibling["view"]["revision"], "1");
        assert_eq!(sibling["view"]["root"]["spans"][0]["text"], "2");
        assert!(!fault.is_finished(), "sibling must complete before A's watchdog failure");
        assert!(matches!(fault.await.unwrap(), Err(Error::Provider(message))
            if message.contains("synchronous execution budget exceeded")),
            "the original VM fault must survive incidental Caller cancellation");
        page_a.close().await.unwrap();
        step(&clock).await;
        assert_eq!(stats(&business).await, json!({"activations":1,"ticks":2}));
        for page in pages { page.close().await.unwrap(); }
        step(&clock).await;
        assert_eq!(stats(&business).await, json!({"activations":1,"ticks":3}));
        // B stays usable after its many siblings have completed VM teardown.
        let submission = json!({"kind":"submit","route":null,"revision":"r1","action":"save","fields":{},"locale":"en"});
        assert_eq!(page_b.call(submission.clone(), b.clone()).await.unwrap()["kind"], "applied");
        assert!(backend.0.lock().unwrap().contains(&(submission, b.document_id)));
        let calls = backend.0.lock().unwrap().len();
        assert!(page_b.call(read(json!("write")), b).await.is_err());
        assert_eq!(backend.0.lock().unwrap().len(), calls + 1);
        page_b.close().await.unwrap();
        let reopened = factory.open(CancellationToken::new()).unwrap();
        let fresh = reopened.call(read(Value::Null), caller(uuid::Uuid::new_v4())).await.unwrap();
        assert_eq!(fresh["view"]["revision"], "1");
        assert_eq!(fresh["view"]["root"]["spans"][0]["text"], "1");
        reopened.close().await.unwrap();
        business_vm.shutdown().await;
        assert!(job.await.unwrap().is_err());
    }).await.unwrap();
}

#[tokio::test]
async fn page_top_level_and_factory_loops_remain_watchdog_protected() {
    tokio::time::timeout(Duration::from_secs(10), async {
        for (name, source) in [
            (
                "top-level-loop.mjs",
                "while (true) {} export default function create() {}",
            ),
            (
                "factory-loop.mjs",
                "export default function create() { while (true) {} }",
            ),
        ] {
            let backend = Arc::new(Backend(
                std::sync::Mutex::default(),
                Arc::new(Semaphore::new(0)),
            ));
            let factory = Factory {
                source: source.into(),
                name: name.into(),
                limits: Limits {
                    synchronous_slice: Duration::from_millis(200),
                    ..Limits::default()
                },
                observations: vec![],
                backend: backend.clone(),
                retiring: CancellationToken::new(),
            };
            let page = factory.open(CancellationToken::new()).unwrap();
            let error = page
                .call(read(Value::Null), caller(uuid::Uuid::new_v4()))
                .await
                .unwrap_err();
            page.close().await.unwrap();
            assert!(
                matches!(&error, Error::Provider(message)
                    if message.contains("synchronous execution budget exceeded")
                        && message.contains("poll began in script poll")
                        && message.contains("phase: script poll")),
                "{name} must fail inside the user-script watchdog: {error}"
            );
            assert!(backend.0.lock().unwrap().is_empty());
        }
    })
    .await
    .expect("user loops and their VM teardown must make bounded progress");
}
