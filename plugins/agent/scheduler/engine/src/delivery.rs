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

use crate::plan::Fire;
use crate::{
    Error,
    authorization::{Authorization, Origin},
    task::Effect,
};
use futures_util::future::BoxFuture;
use tokio_util::sync::CancellationToken;

/// A Host adapter checks the persisted authorization and current admission on
/// every attempt. Retry never changes the Fire's operation ID or payload.
pub trait Dispatcher: Send + Sync {
    fn authorize(
        &self,
        origin: Origin,
        effect: Effect,
    ) -> BoxFuture<'_, Result<Authorization, Error>>;
    /// Scheduler can withdraw a notification before native admission. This
    /// signal never cancels an already accepted execution or proves rollback.
    fn dispatch(&self, fire: Fire, notification_stop: CancellationToken)
    -> BoxFuture<'_, Delivery>;
}

pub enum Delivery {
    Accepted {
        session_id: String,
        run_id: maka_agent_facts::durable::RunId,
    },
    Notified,
    Blocked(String),
    Failed(String),
    Retry(String),
    /// The adapter proves that no effect was admitted; even a notification can
    /// safely wait for its provider rather than becoming an unknown outcome.
    Deferred(String),
}

/// Host provides wall time; wake notifications are delivered through Handle::wake.
pub trait Clock: Send + Sync {
    fn now(&self) -> i64;
}
pub struct SystemClock;
impl Clock for SystemClock {
    fn now(&self) -> i64 {
        jiff::Timestamp::now().as_millisecond()
    }
}
