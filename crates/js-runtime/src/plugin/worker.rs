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
use super::{Command, Health, Limits, PollClock, Result, State, Statistics, engine, failed};
use deno_core::v8;
use futures_util::{StreamExt, future::LocalBoxFuture, stream::FuturesUnordered};
use std::{
    collections::BTreeMap,
    future::poll_fn,
    sync::{Arc, atomic::Ordering},
    task::Poll,
};
use tokio::sync::{OwnedSemaphorePermit, mpsc, oneshot, watch};

struct Loaded {
    code: engine::Module,
    calls: usize,
    closing: bool,
}
struct Request {
    module: u64,
    reply: oneshot::Sender<Result<serde_json::Value>>,
    _slot: Option<OwnedSemaphorePermit>,
    _bytes: OwnedSemaphorePermit,
}
type Pending = FuturesUnordered<LocalBoxFuture<'static, (u64, Result<v8::Global<v8::Value>>)>>;

pub(super) async fn run(
    mut commands: mpsc::UnboundedReceiver<Command>,
    health: Arc<Health>,
    limits: Limits,
) -> Result<()> {
    let mut states: BTreeMap<u64, watch::Sender<State>> = BTreeMap::new();
    let mut requests = BTreeMap::<u64, Request>::new();
    let result = async {
        // Trusted runtime setup precedes the user-script clock. Keep its errors
        // in this result so queued loads still receive the common cleanup below.
        let mut runtime = engine::runtime(&health, &limits)?;
        health.initializing.store(false, Ordering::SeqCst);
        let serving = async {
            let mut modules = BTreeMap::<u64, Loaded>::new();
            let mut pending = Pending::new();
            let mut next_call = 0_u64;
            loop {
                enum Ready {
                    Command(Option<Command>),
                    Complete(u64, Result<v8::Global<v8::Value>>),
                }
                let ready = tokio::select! {
                    biased;
                    _ = health.stopped.cancelled() => return Err(health.error()),
                    value = poll_fn(|cx| {
                        if let Poll::Ready(Some((id, result))) = pending.poll_next_unpin(cx) { return Poll::Ready(Ok(Ready::Complete(id, result))); }
                        if let Poll::Ready(Err(error)) = runtime.poll_event_loop(cx, Default::default()) { return Poll::Ready(Err(failed(error))); }
                        if let Poll::Ready(Some((id, result))) = pending.poll_next_unpin(cx) { return Poll::Ready(Ok(Ready::Complete(id, result))); }
                        commands.poll_recv(cx).map(|command| Ok(Ready::Command(command)))
                    }) => value?,
                };
                match ready {
                    Ready::Command(None) => return Ok(()),
                    Ready::Command(Some(command)) => match command {
                        Command::Load {
                            id,
                            bridge,
                            bootstrap,
                            name,
                            source,
                            state,
                            bytes,
                        } => {
                            match engine::load(&mut runtime, &name, &source, bootstrap, id) {
                                Ok(code) => {
                                    if let Some(bridge) = bridge {
                                        runtime
                                            .op_state()
                                            .borrow_mut()
                                            .borrow_mut::<super::bridge::Bindings>()
                                            .insert(id, bridge);
                                    }
                                    modules.insert(
                                        id,
                                        Loaded {
                                            code,
                                            calls: 0,
                                            closing: false,
                                        },
                                    );
                                    state.send_replace(State::Ready);
                                    states.insert(id, state);
                                }
                                Err(error) => {
                                    state.send_replace(State::Closed(Some(error)));
                                }
                            }
                            drop(bytes);
                        }
                        Command::Call {
                            module,
                            path,
                            args,
                            reply,
                            slot,
                            bytes,
                        } => {
                            let Some(loaded) =
                                modules.get_mut(&module).filter(|loaded| !loaded.closing)
                            else {
                                let _ = reply.send(Err(failed("module is retired")));
                                continue;
                            };
                            match engine::call(&mut runtime, &loaded.code, &path, &args) {
                                Ok(call) => {
                                    next_call = next_call
                                        .checked_add(1)
                                        .ok_or_else(|| failed("call identity exhausted"))?;
                                    let id = next_call;
                                    loaded.calls += 1;
                                    requests.insert(
                                        id,
                                        Request {
                                            module,
                                            reply,
                                            _slot: slot,
                                            _bytes: bytes,
                                        },
                                    );
                                    pending.push(Box::pin(async move { (id, call.await) }));
                                }
                                Err(error) => {
                                    let _ = reply.send(Err(error));
                                }
                            }
                        }
                        Command::Close(id) => {
                            if let Some(module) = modules.get_mut(&id) {
                                module.closing = true;
                                if module.calls == 0 {
                                    close(&mut runtime, &mut modules, &mut states, id);
                                }
                            }
                        }
                        Command::ReleaseCallback { module, callback } => {
                            if let Some(loaded) = modules.get(&module) {
                                // Release is synchronous; there is no promise to drive.
                                drop(engine::call(
                                    &mut runtime,
                                    &loaded.code,
                                    &["release".into()],
                                    &[callback.into()],
                                )?);
                            }
                        }
                        Command::Statistics {
                            collect,
                            reply,
                            slot: _slot,
                        } => {
                            if collect {
                                runtime.v8_isolate().low_memory_notification();
                            }
                            let _ = reply.send(Statistics {
                                modules: modules.len(),
                                pending_calls: requests.len(),
                                used_heap_bytes: runtime
                                    .v8_isolate()
                                    .get_heap_statistics()
                                    .used_heap_size(),
                            });
                        }
                    },
                    Ready::Complete(id, result) => {
                        let request = requests.remove(&id).expect("pending call has an owner");
                        let result = result.and_then(|value| engine::value(&mut runtime, value));
                        let _ = request.reply.send(result);
                        if let Some(module) = modules.get_mut(&request.module) {
                            module.calls -= 1;
                            if module.closing && module.calls == 0 {
                                close(&mut runtime, &mut modules, &mut states, request.module);
                            }
                        }
                    }
                }
                // Keep command floods from creating one unlimited synchronous poll.
                tokio::task::yield_now().await;
            }
        };
        let mut serving = std::pin::pin!(serving);
        poll_fn(|cx| {
            health.polling.send_replace(Some(PollClock {
                started: tokio::time::Instant::now(),
                initializing: health.initializing.load(Ordering::SeqCst),
            }));
            let result = serving.as_mut().poll(cx);
            health.polling.send_replace(None);
            result
        })
        .await
    }
    .await;
    // Runtime, module globals and pending promises have left scope before cleanup
    // acknowledgements. Host resource leases are managed by the Fiber above us.
    if let Err(error) = &result {
        health.fail(error.clone());
    }
    let failure = result.as_ref().err().cloned();
    for (_, state) in states {
        state.send_replace(State::Closed(failure.clone()));
    }
    for (_, request) in requests {
        let _ = request.reply.send(Err(health.error()));
    }
    commands.close();
    while let Some(command) = commands.recv().await {
        if let Command::Load { state, .. } = command {
            state.send_replace(State::Closed(Some(health.error())));
        }
    }
    result
}

fn close(
    runtime: &mut deno_core::JsRuntime,
    modules: &mut BTreeMap<u64, Loaded>,
    states: &mut BTreeMap<u64, watch::Sender<State>>,
    id: u64,
) {
    runtime
        .op_state()
        .borrow_mut()
        .borrow_mut::<super::bridge::Bindings>()
        .remove(id);
    modules.remove(&id);
    if let Some(state) = states.remove(&id) {
        state.send_replace(State::Closed(None));
    }
}
