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
enum Lane {
    #[default]
    Fresh,
    Primary {
        route: u64,
        idle: Option<Idle>,
    },
    Busy,
    Fallback,
}
struct Idle {
    socket: Arc<dyn Socket>,
    url: String,
    headers: BTreeMap<String, String>,
    network: u64,
    baseline: Option<Baseline>,
}

impl ResponsesLane {
    pub fn fallback_availability(
        &self,
    ) -> maka_agent_facts::model::retry_transport::FallbackAvailability {
        use maka_agent_facts::model::retry_transport::FallbackAvailability;
        match &*self.0.lock().unwrap() {
            Lane::Primary { .. } => FallbackAvailability::WarmIdlePrimary,
            Lane::Fresh | Lane::Busy | Lane::Fallback => FallbackAvailability::Unavailable,
        }
    }
    pub fn retry_transport_phase(&self) -> RetryTransportPhase {
        match &*self.0.lock().unwrap() {
            Lane::Fallback => RetryTransportPhase::Fallback,
            Lane::Fresh | Lane::Primary { .. } | Lane::Busy => RetryTransportPhase::Primary,
        }
    }

    pub fn restore_retry_transport_phase(&self, phase: RetryTransportPhase) -> Result<()> {
        let mut lane = self.0.lock().unwrap();
        match (&*lane, phase) {
            (Lane::Busy, _) => Err(error("cannot restore an active Responses transport")),
            (Lane::Fallback, RetryTransportPhase::Primary) => {
                Err(error("cannot reset consumed Responses fallback transport"))
            }
            (_, RetryTransportPhase::Primary) => Ok(()),
            (_, RetryTransportPhase::Fallback) => {
                *lane = Lane::Fallback;
                Ok(())
            }
        }
    }

    pub fn try_switch_fallback_transport(&self, transport: &Shared) -> bool {
        let mut lane = self.0.lock().unwrap();
        let Lane::Primary { route, .. } = &*lane else {
            return false;
        };
        transport.defer(*route, Instant::now());
        *lane = Lane::Fallback;
        true
    }

    pub fn response_id(&self) -> Option<String> {
        match &*self.0.lock().unwrap() {
            Lane::Primary {
                idle: Some(idle), ..
            } => idle.baseline.as_ref()?.response_id.clone(),
            Lane::Fresh | Lane::Primary { idle: None, .. } | Lane::Busy | Lane::Fallback => None,
        }
    }

    fn acquire(&self, route: u64) -> Result<Option<(PrimaryLease, Option<Idle>)>> {
        let mut lane = self.0.lock().unwrap();
        let idle = match &mut *lane {
            Lane::Fresh => None,
            Lane::Primary { idle, .. } => idle.take(),
            Lane::Busy => return Err(error("Responses primary transport is already active")),
            Lane::Fallback => return Ok(None),
        };
        *lane = Lane::Busy;
        Ok(Some((
            PrimaryLease {
                lane: Some(self.clone()),
                route,
            },
            idle,
        )))
    }
}

struct PrimaryLease {
    lane: Option<ResponsesLane>,
    route: u64,
}
impl PrimaryLease {
    fn complete(mut self, idle: Option<Idle>) {
        let lane = self.lane.take().expect("active Responses lane lease");
        *lane.0.lock().unwrap() = Lane::Primary {
            route: self.route,
            idle,
        };
    }
}
impl Drop for PrimaryLease {
    fn drop(&mut self) {
        if let Some(lane) = self.lane.take() {
            *lane.0.lock().unwrap() = Lane::Primary {
                route: self.route,
                idle: None,
            };
        }
    }
}

struct Active {
    connection: Idle,
    lease: PrimaryLease,
}

pub struct Exchange {
    lane: ResponsesLane,
    active: AsyncMutex<Option<Active>>,
    cancellation: CancellationToken,
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
            _ = self.cancellation.cancelled() => Err(super::Error::Cancelled),
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
        let Some((lease, mut idle)) = self.lane.acquire(route)? else {
            return Ok(Some(Prepared::new(body, None)?.full));
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
            lease.complete(None);
            return Err(super::Error::Interrupted("Responses WebSocket route is deferred before dispatch; fallback requires explicit selection".into()));
        }
        let mut connection = match idle {
            Some(idle) => idle,
            None => {
                let socket = connect::open(self.network.as_ref(), &url, &headers)
                    .await
                    .map_err(|cause| {
                        if !matches!(
                            cause,
                            super::Error::Cancelled
                                | super::Error::CleanupUnconfirmed
                                | super::Error::LocalAuthorization(_)
                        ) && !self.cancellation.is_cancelled()
                        {
                            self.transport.defer(route, Instant::now());
                        }
                        cause
                    })?;
                Idle {
                    socket,
                    url,
                    headers,
                    network: self.network.identity(),
                    baseline: None,
                }
            }
        };
        let body = if reuse {
            prepared.delta.as_ref().unwrap_or(&prepared.full)
        } else {
            &prepared.full
        };
        let text = body.clone().websocket();
        self.network
            .send_text(connection.socket.clone(), text)
            .await
            .map_err(|cause| {
                if !matches!(
                    &cause,
                    maka_agent_ports::model::Error::Cancelled
                        | maka_agent_ports::model::Error::CleanupUnconfirmed
                        | maka_agent_ports::model::Error::LocalAuthorization(_)
                ) && !self.cancellation.is_cancelled()
                {
                    self.transport.defer(route, Instant::now());
                }
                match cause {
                    maka_agent_facts::model::error::ModelError::LocalAuthorization(cause) => {
                        super::Error::LocalAuthorization(cause)
                    }
                    maka_agent_facts::model::error::ModelError::Cancelled => {
                        super::Error::Cancelled
                    }
                    maka_agent_facts::model::error::ModelError::CleanupUnconfirmed => {
                        super::Error::CleanupUnconfirmed
                    }
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
        *active = Some(Active { connection, lease });
        Ok(None)
    }

    pub async fn next(&self) -> Result<Option<String>> {
        let mut active = self.active.lock().await;
        let Some(Active { connection, .. }) = active.as_mut() else {
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
                    let Active {
                        mut connection,
                        lease,
                    } = active.take().expect("active Responses exchange");
                    connection.baseline = connection
                        .baseline
                        .take()
                        .and_then(|baseline| baseline.complete(&event["response"]));
                    lease.complete(reusable.then_some(connection));
                }
                Ok(Some(text))
            }
            Err(error) => {
                let reconnect = matches!(error, ReadError::Interrupted(_));
                let Active { lease, .. } = active.take().expect("active Responses exchange");
                if !reconnect
                    && !matches!(error, ReadError::Cancelled)
                    && !self.cancellation.is_cancelled()
                {
                    self.transport.defer(lease.route, Instant::now());
                }
                // A retry gets a fresh socket and full request. Only the caller
                // can select fallback after exhausting its stream retry budget.
                lease.complete(None);
                Err(error.into_error())
            }
        }
    }
}

fn error(message: &'static str) -> super::Error {
    super::Error::Transport(message.into())
}
