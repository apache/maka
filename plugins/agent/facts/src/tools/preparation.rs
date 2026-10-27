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

use crate::{
    event::Invocation,
    tool_call::{ToolRejection, tool_use_id},
    tool_output::ToolSuccess,
    tools::{ToolError, ToolExecutor, ToolFuture},
};
use serde_json::Value;
use std::{future::Future, pin::Pin, sync::Arc};
use tokio_util::sync::CancellationToken;

type Execute = Box<dyn FnOnce(CancellationToken) -> ToolFuture<ToolSuccess> + Send>;
type Admission = Box<dyn FnOnce() -> Result<Box<dyn Send>, ToolError> + Send>;

/// In-process acknowledgment of the durable dispatch boundary. `NotStarted`
/// means the one-shot effect never began; it does not assert that a failed
/// database observation rolled its transaction back.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EffectAdmission {
    Durable { sequence: u64 },
    NotStarted,
}
struct AdmissionObserver(Option<Box<dyn FnOnce(EffectAdmission) + Send>>);
impl AdmissionObserver {
    fn admitted(mut self, sequence: u64) {
        if let Some(observe) = self.0.take() {
            observe(EffectAdmission::Durable { sequence });
        }
    }
}
impl Drop for AdmissionObserver {
    fn drop(&mut self) {
        if let Some(observe) = self.0.take() {
            observe(EffectAdmission::NotStarted);
        }
    }
}

/// The journal owns admission leases until the durable outcome is settled,
/// including failures. Preparation itself does not begin a plugin call.
pub struct PreparedEffect {
    execute: Option<Execute>,
    pub(super) title: Option<crate::display::Text>,
    pub(super) presentation: Option<String>,
    admissions: Vec<Admission>,
    leases: Vec<Box<dyn Send>>,
    admission_observers: Vec<AdmissionObserver>,
}

impl PreparedEffect {
    pub fn new(
        execute: impl FnOnce(CancellationToken) -> ToolFuture<ToolSuccess> + Send + 'static,
    ) -> Self {
        Self {
            execute: Some(Box::new(execute)),
            title: None,
            presentation: None,
            admissions: Vec::new(),
            leases: Vec::new(),
            admission_observers: Vec::new(),
        }
    }

    /// The owning tool supplies its presentation before journal admission.
    pub fn titled(mut self, title: crate::display::Text) -> Self {
        self.title = Some(title);
        self
    }

    /// An opaque display contract; does not change admission or tool behavior.
    pub fn presented(mut self, key: String) -> Self {
        self.presentation = Some(key);
        self
    }

    pub fn guarded<G: Send + 'static>(
        mut self,
        admit: impl FnOnce() -> Result<G, ToolError> + Send + 'static,
    ) -> Self {
        self.admissions.push(Box::new(move || {
            admit().map(|guard| Box::new(guard) as Box<dyn Send>)
        }));
        self
    }

    /// A trusted bridge may close evaluation admission and wait for this
    /// acknowledgment before returning its observer. This callback carries no
    /// authority and cannot admit, replay, or cancel the original effect.
    pub fn on_admission(mut self, observe: impl FnOnce(EffectAdmission) + Send + 'static) -> Self {
        self.admission_observers
            .push(AdmissionObserver(Some(Box::new(observe))));
        self
    }

    pub(super) fn admitted(&mut self, sequence: u64) {
        for observer in self.admission_observers.drain(..) {
            observer.admitted(sequence);
        }
    }

    pub(super) fn start(&mut self, cancellation: CancellationToken) -> ToolFuture<ToolSuccess> {
        for admit in self.admissions.drain(..) {
            match admit() {
                Ok(guard) => self.leases.push(guard),
                Err(error) => return Box::pin(async { Err(error) }),
            }
        }
        self.execute.take().expect("prepared effect starts once")(cancellation)
    }
}
pub type PreparationFuture =
    Pin<Box<dyn Future<Output = Result<PreparedEffect, ToolRejection>> + Send>>;

/// In-process custody supplied by the actual execution owner. Only that owner
/// can recover its private concrete token; serialized identities cannot mint it.
pub trait ExecutionCustody: std::any::Any + Send + Sync {
    fn as_any(&self) -> &dyn std::any::Any;
}

/// Host-owned identity; neither model arguments nor Code Mode may choose it.
#[derive(Clone)]
pub struct ToolCallContext {
    pub invocation: Invocation,
    pub operation_id: String,
    pub execution: Option<Arc<dyn ExecutionCustody>>,
}

impl ToolCallContext {
    pub fn tool_use_id(&self) -> String {
        tool_use_id(&self.invocation.invocation_id, &self.operation_id)
    }
}

/// Preparation may parse a remote call and obtain policy approval, but must not
/// admit its effect. A returned one-shot effect is invoked only after durable T1.
/// A revocable registration checks its captured generation here; retirement must
/// reject a new call, never resolve a replacement handler by name.
pub trait ToolPreparer: Send + Sync + 'static {
    fn names(&self) -> Vec<String>;
    fn prepare(
        &self,
        name: String,
        input: Value,
        context: ToolCallContext,
        cancellation: CancellationToken,
    ) -> PreparationFuture;
}

#[derive(Clone)]
pub enum ToolHandler {
    Immediate(Arc<dyn ToolExecutor>),
    Prepared(Arc<dyn ToolPreparer>),
}
impl ToolHandler {
    pub fn names(&self) -> Vec<String> {
        match self {
            Self::Immediate(executor) => executor.names(),
            Self::Prepared(preparer) => preparer.names(),
        }
    }
    /// Prepare arguments already checked against the owning catalog's schema.
    pub fn prepare(
        &self,
        name: String,
        input: Value,
        context: ToolCallContext,
        cancellation: CancellationToken,
    ) -> PreparationFuture {
        match self {
            Self::Immediate(executor) => {
                let executor = executor.clone();
                Box::pin(async move {
                    let effect: PreparedEffect = PreparedEffect::new(move |cancellation| {
                        Box::pin(async move {
                            executor
                                .invoke(name, input, cancellation)
                                .await
                                .map(ToolSuccess::from)
                        })
                    });
                    Ok(effect)
                })
            }
            Self::Prepared(preparer) => preparer.prepare(name, input, context, cancellation),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolNesting {
    Nestable,
    DirectOnly,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolSemantics {
    Parallel,
    ExclusiveStep,
    /// Complete this Turn only after a successful durable settlement.
    FinishTurn,
}

/// A definition and its implementation travel together through request capture.
#[derive(Clone)]
pub struct ToolRegistration {
    pub definition: super::ToolDefinition,
    pub nesting: ToolNesting,
    pub semantics: ToolSemantics,
    pub handler: ToolHandler,
}
