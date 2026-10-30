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

use super::body::RequestBody;
use futures_util::FutureExt;
use maka_agent_ports::model::Transport;
use maka_agent_ports::model::{RetryTransportPhase, Socket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::Instant,
};
use tokio::sync::Mutex as AsyncMutex;
use tokio_util::sync::CancellationToken;

type Result<T> = std::result::Result<T, super::Error>;
mod cache;
mod connect;
mod frame;
mod shared;
use cache::{Baseline, Prepared};
use frame::{ReadError, receive};
pub use shared::Shared;

/// Ephemeral connection reuse, scoped to one sequential Turn. Clones are leases,
/// not history owners; dropping the final lease closes any idle socket.
#[derive(Clone, Default)]
pub struct ResponsesLane(Arc<Mutex<Lane>>);

#[derive(Default)]
struct Lane {
    idle: Option<Idle>,
    route: Option<u64>,
    fallback: bool,
    busy: bool,
}
struct Idle {
    socket: Arc<dyn Socket>,
    url: String,
    headers: BTreeMap<String, String>,
    network: u64,
    baseline: Option<Baseline>,
}

impl ResponsesLane {
    pub fn retry_transport_phase(&self) -> RetryTransportPhase {
        if self.0.lock().unwrap().fallback {
            RetryTransportPhase::Fallback
        } else {
            RetryTransportPhase::Primary
        }
    }

    pub fn restore_retry_transport_phase(&self, phase: RetryTransportPhase) -> Result<()> {
        let mut lane = self.0.lock().unwrap();
        if lane.busy {
            return Err(error("cannot restore an active Responses transport"));
        }
        match phase {
            RetryTransportPhase::Primary if lane.fallback => {
                Err(error("cannot reset consumed Responses fallback transport"))
            }
            RetryTransportPhase::Primary => Ok(()),
            RetryTransportPhase::Fallback => {
                lane.fallback = true;
                lane.idle.take();
                Ok(())
            }
        }
    }

    pub fn try_switch_fallback_transport(&self, transport: &Shared) -> bool {
        let mut lane = self.0.lock().unwrap();
        if lane.busy || lane.fallback {
            return false;
        }
        let Some(route) = lane.route else {
            return false;
        };
        lane.fallback = true;
        lane.idle.take();
        transport.defer(route, Instant::now());
        true
    }

    pub fn response_id(&self) -> Option<String> {
        let lane = self.0.lock().unwrap();
        if lane.busy || lane.fallback {
            return None;
        }
        lane.idle.as_ref()?.baseline.as_ref()?.response_id.clone()
    }
}

pub struct Exchange {
    lane: ResponsesLane,
    active: AsyncMutex<Option<Idle>>,
    cancellation: CancellationToken,
    owns_lane: AtomicBool,
    network: Arc<dyn Transport>,
    transport: Arc<Shared>,
}

impl Exchange {
    pub fn new(
        lane: ResponsesLane,
        cancellation: CancellationToken,
        network: Arc<dyn Transport>,
        transport: Arc<Shared>,
    ) -> Self {
        Self {
            lane,
            active: AsyncMutex::new(None),
            cancellation: cancellation.child_token(),
            owns_lane: AtomicBool::new(false),
            network,
            transport,
        }
    }

    pub(crate) async fn start(
        &self,
        url: String,
        headers: BTreeMap<String, String>,
        body: RequestBody,
    ) -> Result<Option<RequestBody>> {
        // Cancellation drops the in-flight connect/send future and its socket.
        tokio::select! {
            biased;
            _ = self.cancellation.cancelled() => Err(error("Responses WebSocket cancelled")),
            result = self.start_inner(url, headers, body) => result,
        }
    }

    async fn start_inner(
        &self,
        url: String,
        headers: BTreeMap<String, String>,
        body: RequestBody,
    ) -> Result<Option<RequestBody>> {
        let route = self
            .transport
            .route(&url, &headers, self.network.identity());
        let mut active = self.active.lock().await;
        if active.is_some() {
            return Err(error("Responses WebSocket request already active"));
        }
        let mut idle = {
            let mut lane = self.lane.0.lock().unwrap();
            if lane.fallback || lane.busy {
                // No caller may submit a shortened request without owning the
                // matching baseline. Ordinary concurrent full requests use HTTP.
                return Ok(Some(Prepared::new(body, None)?.full));
            }
            lane.busy = true;
            lane.route = Some(route);
            self.owns_lane.store(true, Ordering::Release);
            lane.idle.take()
        };
        // Reconstruct before rejecting an old socket: store:false state cannot
        // be recovered by carrying its response id to another connection.
        let prepared = Prepared::new(body, idle.as_mut().and_then(|idle| idle.baseline.take()))?;
        let mut idle = idle.filter(|idle| {
            idle.url == url && idle.headers == headers && idle.network == self.network.identity()
        });
        // Consume an already observable idle close before deciding to reuse.
        // After send starts, failure is never retried by this transport.
        if let Some(connection) = idle.as_mut()
            && connection.socket.receive().now_or_never().is_some()
        {
            idle = None;
        }
        let reuse = idle.is_some();
        if !reuse && self.transport.deferred(route, Instant::now()) {
            let mut lane = self.lane.0.lock().unwrap();
            lane.busy = false;
            lane.fallback = true;
            self.owns_lane.store(false, Ordering::Release);
            return Ok(Some(prepared.full));
        }
        let mut connection = match idle {
            Some(idle) => idle,
            None => match connect::open(self.network.as_ref(), &url, &headers).await? {
                Some(socket) => Idle {
                    socket,
                    url,
                    headers,
                    network: self.network.identity(),
                    baseline: None,
                },
                _ => {
                    if !self.cancellation.is_cancelled() {
                        self.transport.defer(route, Instant::now());
                    }
                    let mut lane = self.lane.0.lock().unwrap();
                    lane.fallback = true;
                    lane.busy = false;
                    self.owns_lane.store(false, Ordering::Release);
                    return Ok(Some(prepared.full));
                }
            },
        };
        let body = if reuse {
            prepared.delta.as_ref().unwrap_or(&prepared.full)
        } else {
            &prepared.full
        };
        let text = body.clone().websocket();
        connection.socket.send_text(text).await.map_err(|cause| {
            if !self.cancellation.is_cancelled() {
                self.transport.defer(route, Instant::now());
            }
            match cause {
                maka_agent_facts::model::error::ModelError::Provider(failure)
                    if failure.reason()
                        == maka_agent_facts::model::error::ProviderFailureReason::Network =>
                {
                    // The engine owns recovery from canonical history. This
                    // transport never resends an uncertain response.create.
                    super::Error::Interrupted(failure.message().into())
                }
                cause => {
                    super::Error::Transport(format!("Responses WebSocket send failed: {cause}"))
                }
            }
        })?;
        connection.baseline = prepared.cache(&self.transport.cache);
        *active = Some(connection);
        Ok(None)
    }

    pub async fn next(&self) -> Result<Option<String>> {
        let mut active = self.active.lock().await;
        let Some(connection) = active.as_mut() else {
            return Ok(None);
        };
        let result = tokio::select! {
            biased;
            _ = self.cancellation.cancelled() => Err(ReadError::Cancelled),
            result = receive(connection.socket.as_ref()) => result,
        };
        match result {
            Ok((text, terminal, reusable, event)) => {
                if terminal {
                    let mut idle = active.take();
                    if let Some(connection) = idle.as_mut() {
                        connection.baseline = connection
                            .baseline
                            .take()
                            .and_then(|baseline| baseline.complete(&event["response"]));
                    }
                    let mut lane = self.lane.0.lock().unwrap();
                    lane.busy = false;
                    self.owns_lane.store(false, Ordering::Release);
                    if reusable {
                        lane.idle = idle;
                    }
                }
                Ok(Some(text))
            }
            Err(error) => {
                let reconnect = matches!(error, ReadError::Interrupted(_));
                active.take();
                let mut lane = self.lane.0.lock().unwrap();
                if !reconnect
                    && !matches!(error, ReadError::Cancelled)
                    && !self.cancellation.is_cancelled()
                    && let Some(route) = lane.route
                {
                    self.transport.defer(route, Instant::now());
                }
                lane.busy = false;
                // A retry gets a fresh socket and full request. Only the caller
                // can select fallback after exhausting its stream retry budget.
                lane.fallback |= !reconnect;
                self.owns_lane.store(false, Ordering::Release);
                Err(error.into_error())
            }
        }
    }
}

impl Drop for Exchange {
    fn drop(&mut self) {
        if self.owns_lane.load(Ordering::Acquire) {
            let mut lane = self.lane.0.lock().unwrap();
            if lane.busy {
                lane.busy = false;
                lane.fallback = true;
                lane.idle.take();
            }
        }
    }
}

fn error(message: &'static str) -> super::Error {
    super::Error::Transport(message.into())
}
