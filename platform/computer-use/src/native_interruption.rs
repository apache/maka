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

//! Native-only observations from an actual executor binding.
//! None of these values grants input, Agent cancellation or caller-selected scope.

use futures_util::FutureExt;
use maka_agent_facts::tools::ToolError;
use serde::{Deserialize, Serialize};
use std::{future::Future, pin::Pin};

pub type InterruptionFuture = Pin<Box<dyn Future<Output = Result<(), ToolError>> + Send + 'static>>;

/// Metadata of the actual native binding, retained independently of its first
/// input's T2. It cannot be constructed or deserialized by another crate.
#[derive(Clone, Debug)]
#[must_use]
pub struct NativeBindingSource {
    session: String,
    turn: String,
    native_epoch: String,
    generation: String,
    operation_id: String,
}
impl NativeBindingSource {
    pub fn session(&self) -> &str {
        &self.session
    }
    pub fn turn(&self) -> &str {
        &self.turn
    }
    pub fn native_epoch(&self) -> &str {
        &self.native_epoch
    }
    pub fn generation(&self) -> &str {
        &self.generation
    }
    pub fn operation_id(&self) -> &str {
        &self.operation_id
    }

    pub(crate) fn from_bound_native(
        session: String,
        turn: String,
        native_epoch: String,
        generation: String,
        operation_id: String,
    ) -> Result<Self, ToolError> {
        if session.is_empty()
            || turn.is_empty()
            || native_epoch.is_empty()
            || generation.is_empty()
            || operation_id.is_empty()
        {
            return Err(ToolError::CleanupUnconfirmed(
                "native observer lost its actual producer identity".into(),
            ));
        }
        Ok(Self {
            session,
            turn,
            native_epoch,
            generation,
            operation_id,
        })
    }
}

/// A physical Escape admitted from the actual worker frame, never exit status,
/// an error message, a model payload or an unverified source boolean.
#[derive(Clone, Debug)]
#[must_use]
pub struct NativeInterruption {
    source: NativeBindingSource,
}
impl NativeInterruption {
    pub fn session(&self) -> &str {
        self.source.session()
    }
    pub fn turn(&self) -> &str {
        self.source.turn()
    }
    pub fn native_epoch(&self) -> &str {
        self.source.native_epoch()
    }
    pub fn generation(&self) -> &str {
        self.source.generation()
    }
    pub fn operation_id(&self) -> &str {
        self.source.operation_id()
    }
    pub(crate) fn from_bound_native(source: NativeBindingSource) -> Self {
        Self { source }
    }
}

/// The same physical interruption has actual owned-input release ACK and exact
/// Child wait, covering this original affected native operation. Its action
/// result remains Unknown; this receipt cannot mark the action successful.
#[derive(Clone, Debug)]
#[must_use]
pub struct NativeInterruptionDrain {
    interruption: NativeInterruption,
    affected_operation_id: String,
}
impl NativeInterruptionDrain {
    pub fn session(&self) -> &str {
        self.interruption.session()
    }
    pub fn turn(&self) -> &str {
        self.interruption.turn()
    }
    pub fn native_epoch(&self) -> &str {
        self.interruption.native_epoch()
    }
    pub fn generation(&self) -> &str {
        self.interruption.generation()
    }
    pub fn operation_id(&self) -> &str {
        self.interruption.operation_id()
    }
    pub fn affected_operation_id(&self) -> &str {
        &self.affected_operation_id
    }
    pub(crate) fn from_drained_native(
        interruption: NativeInterruption,
        affected_operation_id: String,
    ) -> Result<Self, ToolError> {
        if affected_operation_id.is_empty() {
            return Err(ToolError::CleanupUnconfirmed(
                "native drain has no actual affected operation".into(),
            ));
        }
        Ok(Self {
            interruption,
            affected_operation_id,
        })
    }
}

/// Supplied by the actual trusted Host invocation. Every returned future stays
/// owned until settlement. Binding is metadata transport, never an input grant.
pub trait NativeInterruptionObserver: Send + Sync {
    fn bound(&self, _source: NativeBindingSource) -> InterruptionFuture {
        Box::pin(async { Ok(()) })
    }
    fn interrupted(&self, observed: NativeInterruption) -> InterruptionFuture;
    fn drained(&self, _observed: NativeInterruptionDrain) -> InterruptionFuture {
        Box::pin(async { Ok(()) })
    }
}

/// Closed metadata on the existing inherited worker transport. This is not the
/// public proof; only its bound connection may validate it into an observation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct WireNativeSource {
    pub session: String,
    pub turn: String,
    pub native_epoch: String,
    pub generation: String,
    pub operation_id: String,
}
impl WireNativeSource {
    pub(crate) fn binding(source: &NativeBindingSource) -> Self {
        Self {
            session: source.session().into(),
            turn: source.turn().into(),
            native_epoch: source.native_epoch().into(),
            generation: source.generation().into(),
            operation_id: source.operation_id().into(),
        }
    }
    pub(crate) fn interruption(source: &NativeInterruption) -> Self {
        Self {
            session: source.session().into(),
            turn: source.turn().into(),
            native_epoch: source.native_epoch().into(),
            generation: source.generation().into(),
            operation_id: source.operation_id().into(),
        }
    }
    pub(crate) fn drain(source: &NativeInterruptionDrain) -> Self {
        Self {
            session: source.session().into(),
            turn: source.turn().into(),
            native_epoch: source.native_epoch().into(),
            generation: source.generation().into(),
            operation_id: source.operation_id().into(),
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "value",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub(crate) enum WireNativeNotice {
    Bound(WireNativeSource),
    Interrupted(WireNativeSource),
    Drained {
        source: WireNativeSource,
        affected_operation_id: String,
    },
}

/// One original callback future, including panics, stays owned by its existing
/// request/connection custodian. No new scheduler or grant is introduced here.
pub(crate) fn own_observation(factory: impl FnOnce() -> InterruptionFuture) -> InterruptionFuture {
    let future = std::panic::catch_unwind(std::panic::AssertUnwindSafe(factory));
    Box::pin(async move {
        match future {
            Ok(future) => std::panic::AssertUnwindSafe(future)
                .catch_unwind()
                .await
                .unwrap_or_else(|_| {
                    Err(ToolError::Failed("native observer future panicked".into()))
                }),
            Err(_) => Err(ToolError::Failed("native observer factory panicked".into())),
        }
    })
}
