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
use maka_host_runtime::application::{Context, Handler};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

struct Capture {
    web: bool,
    ready: AtomicBool,
    calls: AtomicUsize,
    mode: AtomicUsize,
    entered: Arc<Semaphore>,
    release: Arc<Semaphore>,
    drained: Arc<AtomicBool>,
}
impl Capture {
    fn new(web: bool) -> Arc<Self> {
        Arc::new(Self {
            web,
            ready: AtomicBool::new(false),
            calls: AtomicUsize::new(0),
            mode: AtomicUsize::new(0),
            entered: Arc::new(Semaphore::new(0)),
            release: Arc::new(Semaphore::new(0)),
            drained: Arc::new(AtomicBool::new(true)),
        })
    }
}
impl Handler for Capture {
    fn call(
        &self,
        method: String,
        _: Value,
        context: Context,
    ) -> BoxFuture<'static, Result<Value, String>> {
        assert_eq!(method, if self.web { "capture" } else { "state" });
        assert!(context.operation().is_none());
        assert!(context.scope().execution().is_some());
        self.calls.fetch_add(1, Ordering::SeqCst);
        let ready = self.ready.load(Ordering::SeqCst);
        let mode = self.mode.load(Ordering::SeqCst);
        let value = if self.web {
            json!({"basis":{"revision":if ready {1} else {0},"credentialRevision":null},
                "available":true,"source":if ready {"model"} else {"tavily"},"credentialConfigured":true})
        } else {
            json!(if ready { "ready" } else { "fresh" })
        };
        let entered = self.entered.clone();
        let release = self.release.clone();
        let drained = self.drained.clone();
        Box::pin(async move {
            if mode == 0 {
                return Ok(value);
            }
            let mut ticket = context.scope().resources.reserve().unwrap();
            ticket.start();
            drained.store(false, Ordering::SeqCst);
            tokio::spawn(async move {
                release.acquire().await.unwrap().forget();
                drained.store(true, Ordering::SeqCst);
                ticket.complete(Ok(()));
            });
            entered.add_permits(1);
            if mode == 2 {
                context.scope().cancellation.cancelled().await;
            }
            Err("controlled capture failure".into())
        })
    }
}

async fn grouped_capture(web: bool) {
    let model = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let handler = Capture::new(web);
    let setup = if web {
        service_tools::Setup::web().captured(handler.clone())
    } else {
        service_tools::Setup::computer(handler.clone())
    };
    let selections = setup.selections();
    let f = Fixture::with_services(
        &format!("http://{}/v1", model.local_addr().unwrap()),
        None,
        None,
        Some(setup),
    )
    .await;
    let session = f.create("Grouped capture").await;
    f.send(&session).await.unwrap();
    let (mut socket, _) = model.accept().await.unwrap();
    let initial = request(&mut socket).await;
    assert_eq!(
        handler.calls.load(Ordering::SeqCst),
        2,
        "one capture per exact import"
    );
    if !web {
        for name in ["cua_repl", "cua_reset", "cua_replOther", "cua_resetOther"] {
            assert!(initial["tools"].as_array().unwrap().iter().any(|tool| {
                tool["function"]["name"] == name
                    && tool["function"]["description"]
                        .as_str()
                        .unwrap()
                        .contains("state: fresh")
            }));
        }
    }
    let invocation = f
        .session(&session)
        .await
        .session_projection::<StoredSessionConfiguration>(&session)
        .await
        .unwrap()
        .unwrap()
        .root_turn
        .unwrap()
        .invocation;
    let execution_scope = f
        .session(&session)
        .await
        .execution_scope(Some(
            f.owner
                .session(&session)
                .await
                .unwrap()
                .configuration
                .permission_basis(),
        ))
        .await
        .unwrap();
    let execution = execution_scope.store().execution_custody().unwrap();
    let available = maka_tools::availability::Availability::new(
        f.owner.tools.clone(),
        maka_tools::availability::LoadedTools::temporary().unwrap(),
    );
    let model_context = maka_agent_facts::tools::ModelToolContext {
        model: "fixture-model".into(),
        provider_tools: Some(maka_agent_facts::tools::ProviderToolProtocol::OpenaiResponses),
        capabilities: maka_agent_facts::configuration::ModelCapabilities {
            web_search: Some(true),
            ..Default::default()
        },
    };
    let capture = |available: maka_tools::availability::Availability,
                   cancellation: CancellationToken| {
        let invocation = invocation.clone();
        let execution = execution.clone();
        let model = model_context.clone();
        let cwd = f.workspace.to_str().unwrap().to_owned();
        async move {
            available
                .capture(Some(model), invocation, Some(execution), cwd, cancellation)
                .await
        }
    };
    handler.ready.store(true, Ordering::SeqCst);
    let bound = capture(available.clone(), CancellationToken::new())
        .await
        .unwrap()
        .all();
    assert_eq!(
        handler.calls.load(Ordering::SeqCst),
        4,
        "fresh capture on the next request"
    );
    for selected in &selections {
        let definition = bound
            .definitions()
            .find(|tool| tool.name == selected.name)
            .unwrap();
        if web {
            assert_eq!(definition.provider.is_some(), selected.method == "search");
        } else {
            assert_eq!(
                definition.description,
                format!(
                    "{}\nCurrent REPL state: ready. Existing variables and target bindings are retained in this Host process.",
                    selected.description
                )
            );
        }
        assert_eq!(
            definition.input_schema,
            f.owner
                .tools
                .definitions()
                .find(|tool| tool.name == selected.name)
                .unwrap()
                .input_schema
        );
    }
    if web {
        assert!(!bound.nested().contains("WebSearch"));
    }
    let excluded: Vec<_> = selections
        .iter()
        .skip(1)
        .map(|tool| tool.name.as_str())
        .collect();
    let singleton = f.owner.tools.excluding(&excluded);
    let singleton = maka_tools::availability::Availability::new(
        singleton,
        maka_tools::availability::LoadedTools::temporary().unwrap(),
    );
    let bound = capture(singleton, CancellationToken::new())
        .await
        .unwrap()
        .all();
    assert_eq!(handler.calls.load(Ordering::SeqCst), 5);
    assert!(bound.contains(&selections[0].name));
    assert_eq!(bound.definitions().count(), 1);
    for mode in [1, 2] {
        handler.mode.store(mode, Ordering::SeqCst);
        let cancellation = CancellationToken::new();
        let future = capture(available.clone(), cancellation.clone());
        tokio::pin!(future);
        tokio::select! {
            result = &mut future => panic!("capture returned before cleanup: {}", result.is_ok()),
            permit = handler.entered.acquire() => permit.unwrap().forget(),
        }
        if mode == 2 {
            cancellation.cancel();
        }
        assert!(!handler.drained.load(Ordering::SeqCst));
        assert!(futures_util::poll!(future.as_mut()).is_pending());
        handler.release.add_permits(1);
        assert!(future.await.is_err());
        assert!(
            handler.drained.load(Ordering::SeqCst),
            "actual Host resource must finish before binding returns"
        );
    }
    handler.mode.store(0, Ordering::SeqCst);
    response(&mut socket).await;
    f.drained().await;
    drop(execution_scope);
    f.app.shutdown().await.unwrap();
    f.config.shutdown().await.unwrap();
}

#[tokio::test]
async fn computer_capture_is_once_per_import_fresh_and_physically_drained() {
    tokio::time::timeout(Duration::from_secs(30), grouped_capture(false))
        .await
        .unwrap();
}
#[tokio::test]
async fn web_capture_is_once_per_import_fresh_and_physically_drained() {
    tokio::time::timeout(Duration::from_secs(30), grouped_capture(true))
        .await
        .unwrap();
}
