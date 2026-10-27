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
use maka_host_runtime::application::{Context, Handler, NativeActivation, NativeOwner, backend};
use maka_plugin_core::{
    composition::{Configuration, PackageUse, Target},
    contract::{Availability, Cardinality, Export, Import, Interface, MethodMode},
    package::{Declaration, EntryDeclaration, Implementation, UiEntry},
    runtime::Published,
};
use serde_json::json;
use std::sync::{
    Mutex,
    atomic::{AtomicUsize, Ordering},
};

struct FaultDomains {
    actual: Arc<dyn backend::Factory>,
    domains: Mutex<Vec<tokio::sync::watch::Sender<bool>>>,
}
impl backend::Factory for FaultDomains {
    fn create(&self) -> Result<Arc<dyn backend::Realm>, String> {
        let (failed, _) = tokio::sync::watch::channel(false);
        self.domains.lock().unwrap().push(failed.clone());
        Ok(Arc::new(FaultDomain {
            actual: self.actual.create()?,
            failed,
        }))
    }
}
struct FaultDomain {
    actual: Arc<dyn backend::Realm>,
    failed: tokio::sync::watch::Sender<bool>,
}
impl backend::Realm for FaultDomain {
    fn load(&self, name: String, source: String) -> Result<Arc<dyn backend::Module>, String> {
        self.actual.load(name, source)
    }
    fn is_terminated(&self) -> bool {
        *self.failed.borrow() || self.actual.is_terminated()
    }
    fn failed(&self) -> futures_util::future::BoxFuture<'static, String> {
        let mut failed = self.failed.subscribe();
        let actual = self.actual.failed();
        Box::pin(async move {
            tokio::select! {
                reason = actual => reason,
                result = failed.wait_for(|failed| *failed) => {
                    result.expect("fault injection owner retained");
                    "injected backend domain failure".into()
                }
            }
        })
    }
    fn shutdown(&self) -> futures_util::future::BoxFuture<'static, ()> {
        self.actual.shutdown()
    }
}

struct Counter(Arc<AtomicUsize>);
impl Handler for Counter {
    fn call(
        &self,
        method: String,
        input: Value,
        context: Context,
    ) -> futures_util::future::BoxFuture<'static, Result<Value, String>> {
        let counter = self.0.clone();
        Box::pin(async move {
            if input == json!({"reject":true}) {
                return Err("ordinary business refusal".into());
            }
            let value = if method == "write" {
                counter.fetch_add(1, Ordering::SeqCst) + 1
            } else {
                counter.load(Ordering::SeqCst)
            };
            if method == "watch" {
                context.emit(json!({"effects":value})).await?;
                Ok(Value::Null)
            } else {
                Ok(json!({"effects":value}))
            }
        })
    }
}
impl NativeOwner for Counter {
    fn prepare_retirement(
        &self,
    ) -> Option<Box<dyn maka_host_runtime::application::NativeRetirement>> {
        Some(Box::new(()))
    }
    fn close(&self) -> futures_util::future::BoxFuture<'static, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
}

async fn read(client: &Client, endpoint: &str, method: &str, input: Value) -> Value {
    let mut call = client
        .call(endpoint, method.into(), input, Default::default())
        .await
        .unwrap();
    call.start().await.unwrap();
    match call.receive().await.unwrap() {
        Reply::Finished {
            result: Ok(value),
            cleanup: Ok(()),
        } => value,
        _ => panic!("UI service query did not return its original result"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn installed_ui_services_capture_calls_rebind_and_keep_original_receipts() {
    tokio::time::timeout(Duration::from_secs(20), async {
        let directory = tempfile::tempdir().unwrap();
        maka_event_log::root::private_directory(directory.path()).unwrap();
        let root = directory.path().join("root");
        let namespaces = RootNamespaces { ownership: directory.path().join("owners"), control: directory.path().join("control") };
        let store = Arc::new(support::setup(RootStore::open(Arc::new(RootOwner::create(&root, &namespaces).unwrap()))).await.unwrap());
        let (mut input, mut packages) = support::host();
        let mut contract = support::business();
        let Interface::Service { methods } = &mut contract.interface else { unreachable!() };
        let mut watch = methods["read"].clone();
        watch.mode = MethodMode::Subscription;
        methods.insert("watch".into(), watch);
        let provider = support::counter::package("example.ui.counter", Declaration {
            host: Some(EntryDeclaration {
                implementation: Implementation::Native { implementation:"example.ui.counter".into() },
                configuration:json!({"type":"object","properties":{"seed":{"type":"integer"}},"required":["seed"]}).into(),
                imports: BTreeMap::new(),
                exports: BTreeMap::from([("Counter".into(), Export { contract:contract.clone(), availability:Availability::Required })]),
            }), ui:None, composition:None,
        }, None);
        let ui = support::counter::package("example.ui.consumer", Declaration {
            host:None, composition:None,
            ui:Some(UiEntry { module:"index.mjs".into(), configuration:json!({"type":"object"}).into(),
                imports:BTreeMap::from([("counter".into(), Import { contract:contract.clone(), cardinality:Cardinality::One })]),
                contributions:BTreeMap::new(),
            }),
        }, Some("throw new Error('UI code must not run inside the Host');".into()));
        for (name, id, seed) in [("counter-a",21,0),("counter-b",22,100)] {
            let mut node = support::counter::node(&provider,id);
            node.configuration = Configuration { values:BTreeMap::from([("seed".into(),json!(seed))]), parameters:BTreeMap::new() };
            input.instances.insert(name.into(),node);
        }
        let mut consumer = support::counter::node(&ui,23);
        consumer.use_package = PackageUse::Ui;
        consumer.bindings.insert("counter".into(),vec![Target::Instance { path:vec!["counter-a".into()], export:"Counter".into() }]);
        input.instances.insert("ui".into(),consumer);
        let fault_ui = support::counter::package("example.ui.fault-consumer", Declaration {
            host:None, composition:None,
            ui:Some(UiEntry { module:"index.mjs".into(), configuration:json!({"type":"object"}).into(),
                imports:BTreeMap::from([("business".into(), Import { contract:support::business(), cardinality:Cardinality::One })]),
                contributions:BTreeMap::new(),
            }),
        }, Some("throw new Error('UI code must not run inside the Host');".into()));
        let mut fault_consumer = support::counter::node(&fault_ui,24);
        fault_consumer.use_package=PackageUse::Ui;
        fault_consumer.bindings.insert("business".into(),vec![Target::Instance {path:vec!["business".into()],export:"Counter".into()}]);
        input.instances.insert("fault-ui".into(),fault_consumer);
        packages.extend([provider,ui,fault_ui]);
        let deployment = Uuid::new_v4();
        let source = store.commit_application(deployment,0,input.clone(),vec![],packages.clone()).await.unwrap();
        let first = Arc::new(AtomicUsize::new(0));
        let second = Arc::new(AtomicUsize::new(100));
        let mut native = NativeRegistry::default();
        native.insert("example.ui.counter".into(),Arc::new({ let contract=contract.clone(); let first=first.clone(); let second=second.clone(); move |_, configuration| {
            let counter = Arc::new(Counter(if configuration["seed"] == 100 { second.clone() } else { first.clone() }));
            let contract=contract.clone();
            Box::pin(async move { NativeActivation { exports:Ok(BTreeMap::from([("Counter".into(),Published { contract, value:counter.clone() as Arc<dyn Handler> })])), owner:counter } })
        }})).unwrap();
        let domains=Arc::new(FaultDomains {actual:maka_host_js::factory(Default::default()),domains:Mutex::new(Vec::new())});
        let host = Host::open(store.clone(),deployment,native,Some(domains.clone()),HostConfiguration::PublicHost {
            endpoints:BTreeMap::from([("receipts".into(),HostEndpoint { consumer:support::identity(13),import:"receipts".into(),grant:Grant { methods:["read".into()].into(),recovery:true } })]),native:vec![],product_methods:Default::default(),
        }).await.unwrap();
        #[cfg(unix)] let address=directory.path().join("host.sock");
        #[cfg(windows)] let address=std::path::PathBuf::from(format!(r"\\.\pipe\maka-ui-bindings-{}",Uuid::new_v4()));
        let listener=LocalListener::bind(&address).unwrap();
        let serving=tokio::spawn({let host=host.clone();async move {host.serve_local(listener,CancellationToken::new()).await}});
        let mut parent=Client::connect(&address,Some(host.epoch())).await.unwrap();
        let mut bound=parent.bind_ui(source.clone(),support::identity(23)).await.unwrap();
        assert_eq!(bound.ui_imports().unwrap(),&BTreeMap::from([("counter".into(),vec!["counter".into()])]));
        assert_eq!(read(&bound,"counter","read",Value::Null).await,json!({"effects":0}));
        let mut mutation=bound.call("counter","write".into(),Value::Null,Default::default()).await.unwrap();
        mutation.start().await.unwrap();
        assert!(matches!(mutation.receive().await.unwrap(),Reply::Prepared { .. }));
        let reference=mutation.reference().unwrap().clone();
        assert!(matches!(mutation.confirm().await.unwrap(),Reply::Mutation {reply,cleanup:Ok(())} if matches!(reply.receipt,Receipt::Recorded {outcome:OperationOutcome::Returned {ref value},cleanup:OperationCleanup::Confirmed} if value == &json!({"effects":1}))));
        let intent=store.application_intent(deployment,support::identity(23),reference.operation).await.unwrap().unwrap();
        assert_eq!(intent.caller,source);
        let mut subscription=bound.call("counter","watch".into(),Value::Null,Default::default()).await.unwrap();
        subscription.start().await.unwrap();
        assert!(matches!(subscription.receive().await.unwrap(),Reply::Subscribed));
        assert!(matches!(subscription.pull().await.unwrap(),Reply::Item {value} if value == json!({"effects":1})));
        assert!(matches!(subscription.pull().await.unwrap(),Reply::Finished {result:Ok(Value::Null),cleanup:Ok(())}));
        let mut rejected=bound.call("counter","read".into(),json!({"reject":true}),Default::default()).await.unwrap();
        rejected.start().await.unwrap();
        assert!(matches!(rejected.receive().await.unwrap(),Reply::Finished {result:Err(_),cleanup:Ok(())}));
        assert!(!rejected.binding_retired(),"business refusal cannot invalidate a captured UI service");

        let mut fault_bound=parent.bind_ui(source.clone(),support::identity(24)).await.unwrap();
        let basis=store.load_application_at(&source).await.unwrap().unwrap().plan().binding_basis(&support::identity(24)).unwrap();
        let mut original=fault_bound.call("business","write".into(),Value::Null,Default::default()).await.unwrap();
        original.start().await.unwrap();
        assert!(matches!(original.receive().await.unwrap(),Reply::Prepared { .. }));
        let original_reference=original.reference().unwrap().clone();
        assert!(matches!(original.confirm().await.unwrap(),Reply::Mutation {reply,cleanup:Ok(())} if matches!(reply.receipt,Receipt::Recorded {outcome:OperationOutcome::Returned {ref value},cleanup:OperationCleanup::Confirmed} if value == &json!({"effects":1}))));
        domains.domains.lock().unwrap()[0].send_replace(true);
        let mut retired=fault_bound.call("business","read".into(),Value::Null,Default::default()).await.unwrap();
        retired.start().await.unwrap();
        assert!(matches!(retired.receive().await.unwrap(),Reply::BindingRetired {cleanup:Ok(()),..}));
        assert!(retired.binding_retired());

        let mut unrelated=input.instances["ui"].clone();
        unrelated.key=Uuid::from_u128(25);
        unrelated.disabled=true;
        input.instances.insert("unrelated-ui".into(),unrelated);
        let recovered=store.commit_application(deployment,1,input.clone(),vec![],packages.clone()).await.unwrap();
        let recovered_loaded=store.load_application_at(&recovered).await.unwrap().unwrap();
        assert_eq!(recovered_loaded.plan().binding_basis(&support::identity(24)).unwrap(),basis);
        let mut recovered_bound=parent.bind_ui(recovered,support::identity(24)).await.unwrap();
        let mut still_retired=fault_bound.call("business","read".into(),Value::Null,Default::default()).await.unwrap();
        still_retired.start().await.unwrap();
        assert!(matches!(still_retired.receive().await.unwrap(),Reply::BindingRetired {cleanup:Ok(()),..}));
        assert!(still_retired.binding_retired());
        assert_eq!(read(&recovered_bound,"business","read",Value::Null).await,json!({"effects":0}));
        parent.refresh().await.unwrap();
        let original_receipt:maka_plugin_core::operation::OperationReply=serde_json::from_value(read(&parent,"receipts","read",serde_json::to_value(&original_reference).unwrap()).await).unwrap();
        assert!(matches!(original_receipt.receipt,Receipt::Recorded {outcome:OperationOutcome::Returned {ref value},cleanup:OperationCleanup::Confirmed} if value == &json!({"effects":1})));
        assert_eq!(original_receipt.reference,original_reference);

        input.instances.get_mut("ui").unwrap().bindings.insert("counter".into(),vec![Target::Instance {path:vec!["counter-b".into()],export:"Counter".into()}]);
        let replacement=store.commit_application(deployment,2,input,vec![],packages).await.unwrap();
        let mut rebound=parent.bind_ui(replacement,support::identity(23)).await.unwrap();
        assert_eq!(read(&rebound,"counter","read",Value::Null).await,json!({"effects":100}));
        let receipt: maka_plugin_core::operation::OperationReply = serde_json::from_value(read(&parent,"receipts","read",serde_json::to_value(&reference).unwrap()).await).unwrap();
        assert_eq!(receipt.reference,reference);
        assert!(matches!(receipt.receipt,Receipt::Recorded {outcome:OperationOutcome::Returned {ref value}, ..} if value == &json!({"effects":1})));
        assert_eq!(first.load(Ordering::SeqCst),1);
        fault_bound.close().await.unwrap();
        recovered_bound.close().await.unwrap();
        bound.close().await.unwrap();
        parent.close().await.unwrap();
        rebound.close().await.unwrap();
        assert!(Client::retire(&address,host.epoch()).await.unwrap());
        serving.await.unwrap().unwrap();
    }).await.expect("owned UI binding lifecycle did not finish");
}
