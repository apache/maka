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
    composition::Scope,
    contributions::{Publisher, Staged},
    kernel::{Definition, Plugin, PluginContext},
    remote::{Caller, Endpoint, Error, Handler, Method},
    terminal_ui::{Context, Descriptor, Text, presenter},
};
use std::sync::{
    Mutex,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

pub(super) struct Factory {
    pub opens: AtomicUsize,
    pub activations: AtomicUsize,
    pub slots: Arc<Semaphore>,
    pub entered: Semaphore,
    pub closing: Semaphore,
    pub release: Semaphore,
    pub publisher: Mutex<Option<Publisher>>,
    pub sources: Arc<super::sources::Sources>,
    observations: std::sync::OnceLock<Vec<presenter::Observation>>,
}
impl Factory {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            opens: AtomicUsize::new(0),
            activations: AtomicUsize::new(0),
            slots: Arc::new(Semaphore::new(2)),
            entered: Semaphore::new(0),
            closing: Semaphore::new(0),
            release: Semaphore::new(0),
            publisher: Mutex::new(None),
            sources: Arc::new(super::sources::Sources::default()),
            observations: std::sync::OnceLock::new(),
        })
    }
    pub fn endpoint(self: &Arc<Self>) -> Endpoint {
        Endpoint::standalone(Handler::Method(Arc::new(Adapter(self.clone()))))
            .with_terminal_view(Descriptor::new(Text::plain("Page"), Context::Application))
            .unwrap()
    }
}
struct Adapter(Arc<Factory>);
impl Method for Adapter {
    fn page_factory(&self) -> Option<Arc<dyn presenter::Factory>> {
        Some(Arc::new(PageFactory(self.0.clone())))
    }
    fn call(&self, _: Value, _: Caller) -> BoxFuture<'static, Result<Value, Error>> {
        panic!("a page endpoint must never fall back to its ordinary Method")
    }
}
struct PageFactory(Arc<Factory>);
impl presenter::Factory for PageFactory {
    fn observations(&self) -> &[presenter::Observation] {
        self.0.observations.get().map_or(&[], Vec::as_slice)
    }
    fn open(&self, stop: CancellationToken) -> Result<Arc<dyn presenter::Page>, Error> {
        let permit = self
            .0
            .slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Provider("page capacity exhausted".into()))?;
        let id = self.0.opens.fetch_add(1, Ordering::SeqCst) + 1;
        Ok(Arc::new(Page {
            factory: self.0.clone(),
            id,
            calls: AtomicUsize::new(0),
            stop,
            slow_close: Arc::new(AtomicBool::new(false)),
            uncertain: Arc::new(AtomicBool::new(false)),
            permit: Mutex::new(Some(permit)),
        }))
    }
}
struct Page {
    factory: Arc<Factory>,
    id: usize,
    calls: AtomicUsize,
    stop: CancellationToken,
    slow_close: Arc<AtomicBool>,
    uncertain: Arc<AtomicBool>,
    permit: Mutex<Option<OwnedSemaphorePermit>>,
}
impl presenter::Page for Page {
    fn call(&self, input: Value, caller: Caller) -> BoxFuture<'static, Result<Value, Error>> {
        let id = self.id;
        let count = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
        let factory = self.factory.clone();
        let slow = self.slow_close.clone();
        let uncertain = self.uncertain.clone();
        let stop = self.stop.clone();
        Box::pin(async move {
            match input["route"].as_str() {
                Some("fault") => Err(Error::Provider("page failed".into())),
                Some("panic") => panic!("controlled page panic"),
                Some("unknown") => {
                    uncertain.store(true, Ordering::SeqCst);
                    Err(Error::Provider("page failed with owned resources".into()))
                }
                Some("applied-after-fault" | "consent-after-fault") => {
                    caller
                        .resources
                        .reserve()
                        .unwrap()
                        .complete(Err("owned resource did not settle".into()));
                    uncertain.store(true, Ordering::SeqCst);
                    stop.cancel();
                    Ok(if input["route"] == "consent-after-fault" {
                        json!({"kind":"consent","request":{"operationId":"00000000-0000-4000-8000-000000000001","title":"Read history","target":{"kind":"profile"},"capabilities":["read_history"]}})
                    } else {
                        json!({"kind":"applied","route":"saved"})
                    })
                }
                Some("concurrent") => {
                    factory.entered.add_permits(1);
                    factory.release.acquire().await.unwrap().forget();
                    Ok(json!({"page":id,"calls":count,"document":caller.document_id}))
                }
                Some("late") => {
                    slow.store(true, Ordering::SeqCst);
                    factory.entered.add_permits(1);
                    caller.cancellation.cancelled().await;
                    Err(Error::Cancelled)
                }
                _ => Ok(json!({"page":id,"calls":count,"document":caller.document_id})),
            }
        })
    }
    fn cancel(&self) {
        self.stop.cancel();
    }
    fn retired(&self) -> BoxFuture<'_, ()> {
        Box::pin(self.stop.cancelled())
    }
    fn close(&self) -> BoxFuture<'_, Result<(), Error>> {
        self.cancel();
        Box::pin(async {
            if self.slow_close.load(Ordering::SeqCst) {
                self.factory.closing.add_permits(1);
                self.factory.release.acquire().await.unwrap().forget();
            }
            drop(self.permit.lock().unwrap().take());
            if self.uncertain.load(Ordering::SeqCst) {
                Err(Error::CleanupUnconfirmed)
            } else {
                Ok(())
            }
        })
    }
}
struct Business;
impl Method for Business {
    fn call(&self, _: Value, _: Caller) -> BoxFuture<'static, Result<Value, Error>> {
        Box::pin(async { Ok(json!("business alive")) })
    }
}
struct Example(Arc<Factory>);
impl Plugin for Example {
    fn supports_scope(&self, scope: &Scope) -> bool {
        *scope == Scope::Profile
    }
    fn activate(
        &self,
        context: PluginContext,
        _: Value,
    ) -> BoxFuture<'static, Result<Staged, String>> {
        self.0.activations.fetch_add(1, Ordering::SeqCst);
        *self.0.publisher.lock().unwrap() = Some(context.contributions);
        let factory = self.0.clone();
        let identity = context.lifecycle.identity().unwrap();
        Box::pin(async move {
            let mut staged = Staged::default();
            let observations = factory.sources.stage(&mut staged, &identity);
            assert!(factory.observations.set(observations).is_ok());
            staged
                .insert("example.pages/page", factory.endpoint())
                .unwrap();
            staged
                .insert("example.pages/other", factory.endpoint())
                .unwrap();
            staged
                .insert(
                    "example.pages/business",
                    Endpoint::standalone(Handler::Method(Arc::new(Business))),
                )
                .unwrap();
            Ok(staged)
        })
    }
}
pub(super) struct Scene {
    _root: ClientFixture,
    pub host: Arc<Host>,
    pub peer: Peer,
    pub factory: Arc<Factory>,
    stop: CancellationToken,
    _cleanup: tokio_util::sync::DropGuard,
    server: tokio::task::JoinHandle<Result<(), maka_runtime_host::server::HostError>>,
}
impl Scene {
    pub async fn new() -> Self {
        let root = ClientFixture::new("maka-page-document-");
        let factory = Factory::new();
        let mut setup = Setup::default();
        setup.builtins.insert(
            "example.pages".into(),
            Arc::new(Definition {
                id: "example.pages".into(),
                revision: "test-pages".into(),
                dependencies: vec![],
                inject: vec![],
                plugin: Arc::new(Example(factory.clone())),
            }),
        );
        setup.layers.insert("example.pages".into(), serde_json::from_value(json!([
            {"type":"insert","rootId":"profile","entry":{"id":"page-host","packageId":"example.pages"}}
        ])).unwrap());
        let host = Host::open_with_options(
            root.owner(),
            None,
            HostOptions {
                plugins: setup,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        #[cfg(unix)]
        let endpoint = root.workspace.parent().unwrap().join("page.sock");
        #[cfg(windows)]
        let endpoint =
            std::path::PathBuf::from(format!(r"\\.\pipe\maka-page-{}", uuid::Uuid::new_v4()));
        let stop = CancellationToken::new();
        let cleanup = stop.clone().drop_guard();
        let server = tokio::spawn(
            LocalListener::bind(&endpoint)
                .unwrap()
                .serve(host.clone(), stop.clone()),
        );
        let mut peer = Peer::new(host.clone(), "page-client").await;
        ready(&mut peer).await;
        Self {
            _root: root,
            host,
            peer,
            factory,
            stop,
            _cleanup: cleanup,
            server,
        }
    }
    pub async fn close(self) {
        self.stop.cancel();
        self.server.await.unwrap().unwrap();
        self.peer.close().await;
    }
}
