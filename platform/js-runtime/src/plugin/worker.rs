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
use super::{
    Captured, Command, Health, Limits, Module, PollClock, Result, State, Statistics,
    captured::Target, engine, failed,
};
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
    callbacks: BTreeMap<u64, engine::Callbacks>,
}
struct Request {
    module: Module,
    reply: oneshot::Sender<Result<serde_json::Value>>,
    _bytes: OwnedSemaphorePermit,
    context: Option<Arc<super::request::Owner>>,
}
type Pending = FuturesUnordered<LocalBoxFuture<'static, (u64, Result<v8::Global<v8::Value>>)>>;

pub(super) async fn run(
    mut commands: mpsc::UnboundedReceiver<Command>,
    health: Arc<Health>,
    limits: Limits,
    realm: super::Realm,
) -> Result<()> {
    let mut states: BTreeMap<u64, watch::Sender<State>> = BTreeMap::new();
    let mut requests = BTreeMap::<u64, Request>::new();
    let result = async {
        // Trusted runtime setup precedes the user-script clock. Keep its errors
        // in this result so queued loads still receive the common cleanup below.
        let mut runtime = match realm {
            super::Realm::Pure => engine::pure_runtime(&health, &limits)?,
            super::Realm::Scoped => engine::scoped_runtime(&health, &limits)?,
        };
        health.initializing.store(false, Ordering::SeqCst);
        let serving = async {
            let mut modules = BTreeMap::<u64, Loaded>::new();
            let mut pending = Pending::new();
            let mut next_call = 0_u64;
            let mut next_callback = 0_u64;
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
                        if health.stopped.is_cancelled() || runtime.v8_isolate().is_execution_terminating() {
                            return Poll::Ready(Err(health.error()));
                        }
                        if let Poll::Ready(Some((id, result))) = pending.poll_next_unpin(cx) { return Poll::Ready(Ok(Ready::Complete(id, result))); }
                        commands.poll_recv(cx).map(|command| Ok(Ready::Command(command)))
                    }) => value?,
                };
                match ready {
                    Ready::Command(None) => return Ok(()),
                    Ready::Command(Some(command)) => match command {
                        Command::Load {
                            id,
                            name,
                            source,
                            state,
                            bytes,
                        } => {
                            match engine::load(&mut runtime, &name, &source) {
                                Ok(code) => {
                                    modules.insert(
                                        id,
                                        Loaded {
                                            code,
                                            calls: 0,
                                            closing: false,
                                            callbacks: BTreeMap::new(),
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
                            target,
                            args,
                            context,
                            reply,
                            bytes,
                        } => {
                            let Some(loaded) =
                                modules.get_mut(&module.0.id).filter(|loaded| !loaded.closing)
                            else {
                                drop(context);
                                let _ = reply.send(Err(failed("module is retired")));
                                continue;
                            };
                            let call = match target {
                                Target::Path(path) => {
                                    engine::call(&mut runtime, &loaded.code, &path, &args)
                                }
                                Target::Captured { callback, method } => loaded
                                    .callbacks
                                    .get(&callback)
                                    .ok_or_else(|| failed("callback registration released"))
                                    .and_then(|callbacks| {
                                        engine::call_bound(&mut runtime, callbacks, &method, &args, context.as_ref())
                                    }),
                            };
                            match call {
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
                                            _bytes: bytes,
                                            context,
                                        },
                                    );
                                    pending.push(Box::pin(async move { (id, call.await) }));
                                }
                                Err(error) => {
                                    drop(context);
                                    let _ = reply.send(Err(error));
                                }
                            }
                        }
                        Command::Capture {
                            module, namespace, methods, reply, bytes: _bytes,
                        } => {
                            if reply.is_closed() {
                                continue;
                            }
                            let Some(loaded) = modules
                                .get_mut(&module.0.id)
                                .filter(|m| !m.closing)
                            else {
                                let _ = reply.send(Err(failed("module is retired")));
                                continue;
                            };
                            let names = methods.iter().map(String::as_str).collect::<Vec<_>>();
                            match engine::capture_callbacks(
                                &mut runtime, &loaded.code, &namespace, &names,
                            ) {
                                Ok(callbacks) => {
                                    next_callback = next_callback
                                        .checked_add(1)
                                        .ok_or_else(|| failed("callback identity exhausted"))?;
                                    let id = next_callback;
                                    loaded.callbacks.insert(id, callbacks);
                                    // The payload owns its release obligation even if send succeeds
                                    // but the awaiting future is dropped before receiving it.
                                    let _ = reply.send(Ok(Captured::new(module, id, methods)));
                                }
                                Err(error) => {
                                    let _ = reply.send(Err(error));
                                }
                            }
                        }
                        Command::ReleaseCaptured { module, callback } => {
                            if let Some(loaded) = modules.get_mut(&module) {
                                loaded.callbacks.remove(&callback);
                            }
                        }
                        Command::Close(id) => {
                            if let Some(module) = modules.get_mut(&id) {
                                module.closing = true;
                                if module.calls == 0 {
                                    close(&mut modules, &mut states, id);
                                }
                            }
                        }
                        Command::Statistics {
                            collect,
                            reply,
                        } => {
                            if collect {
                                runtime.v8_isolate().low_memory_notification();
                            }
                            let _ = reply.send(Statistics {
                                modules: modules.len(),
                                pending_calls: requests.len(),
                                captured_callbacks: modules.values().map(|m| m.callbacks.len()).sum(),
                                used_heap_bytes: runtime
                                    .v8_isolate()
                                    .get_heap_statistics()
                                    .used_heap_size(),
                            });
                        }
                    },
                    Ready::Complete(id, result) => {
                        let result = result.and_then(|value| engine::value(&mut runtime, value));
                        if health.stopped.is_cancelled() || runtime.v8_isolate().is_execution_terminating() {
                            return Err(health.error());
                        }
                        let mut request = requests.remove(&id).expect("pending call has an owner");
                        // Context capabilities expire before completion becomes observable.
                        drop(request.context.take());
                        let _ = request.reply.send(result);
                        if let Some(module) = modules.get_mut(&request.module.0.id) {
                            module.calls -= 1;
                            if module.closing && module.calls == 0 {
                                close(&mut modules, &mut states, request.module.0.id);
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
    // acknowledgements. Host resource leases remain with the original application owner.
    if let Err(error) = &result {
        health.fail(error.clone());
    }
    let failure = result.as_ref().err().cloned();
    // Revoke accepted and queued contexts before any close acknowledgement.
    for request in requests.values_mut() {
        drop(request.context.take());
    }
    commands.close();
    let mut queued_replies = Vec::new();
    let mut queued_states = Vec::new();
    while let Some(command) = commands.recv().await {
        match command {
            Command::Call { context, reply, .. } => {
                drop(context);
                queued_replies.push(reply);
            }
            Command::Load { state, .. } => queued_states.push(state),
            _ => {}
        }
    }
    for (_, state) in states {
        state.send_replace(State::Closed(failure.clone()));
    }
    for state in queued_states {
        state.send_replace(State::Closed(Some(health.error())));
    }
    for (_, request) in requests {
        let _ = request.reply.send(Err(health.error()));
    }
    for reply in queued_replies {
        let _ = reply.send(Err(health.error()));
    }
    result
}

fn close(
    modules: &mut BTreeMap<u64, Loaded>,
    states: &mut BTreeMap<u64, watch::Sender<State>>,
    id: u64,
) {
    modules.remove(&id);
    if let Some(state) = states.remove(&id) {
        state.send_replace(State::Closed(None));
    }
}
