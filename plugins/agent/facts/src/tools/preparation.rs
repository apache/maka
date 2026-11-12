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
    durable::ExecutionIdentity,
    tool_call::{ToolRejection, tool_use_id},
    tool_output::ToolSuccess,
    tools::{ToolError, ToolExecutor, ToolFuture},
};
use serde_json::Value;
use std::{future::Future, pin::Pin, sync::Arc};
use tokio_util::sync::CancellationToken;

pub type Execute = Box<dyn FnOnce(CancellationToken) -> ToolFuture<ToolSuccess> + Send>;
type Admission = Box<dyn FnOnce() -> Result<Box<dyn Send>, ToolError> + Send>;

pub type ApprovalAnswerFuture = ToolFuture<crate::interaction::InteractionOutcome>;
pub type EstablishNativeApproval =
    Box<dyn FnOnce(CancellationToken) -> ToolFuture<EstablishedApproval> + Send>;

pub struct EstablishedApproval {
    pub pending: crate::native_approval::NativeApprovalPending,
    pub answer: ApprovalAnswerFuture,
}

pub enum PreparedExecution {
    Inline(Execute),
    NativeApproval(PreparedNativeApproval),
}

pub struct PreparedNativeApproval {
    pub establish: EstablishNativeApproval,
    pub execute: Execute,
}

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
    execution: Option<PreparedExecution>,
    pub(super) title: Option<crate::display::Text>,
    pub(super) presentation: Option<String>,
    approval: Option<crate::durable::ApprovalId>,
    admissions: Vec<Admission>,
    leases: Vec<Box<dyn Send>>,
    admission_observers: Vec<AdmissionObserver>,
}

impl PreparedEffect {
    pub fn new(
        execute: impl FnOnce(CancellationToken) -> ToolFuture<ToolSuccess> + Send + 'static,
    ) -> Self {
        Self {
            execution: Some(PreparedExecution::Inline(Box::new(execute))),
            title: None,
            presentation: None,
            approval: None,
            admissions: Vec::new(),
            leases: Vec::new(),
            admission_observers: Vec::new(),
        }
    }

    /// Names the canonical pending decision; only original admission consumes its grant.
    pub fn requiring_approval(mut self, approval: crate::durable::ApprovalId) -> Self {
        self.approval = Some(approval);
        self
    }

    pub fn approval_id(&self) -> Option<crate::durable::ApprovalId> {
        self.approval
    }

    /// Freeze the producer's actual copy in the admitted Run's original locale.
    pub fn display(&self, locale: &str) -> crate::durable::ToolDisplay {
        crate::durable::ToolDisplay {
            title: self
                .title
                .as_ref()
                .map(|title| title.resolve(locale).to_owned()),
            presentation: self.presentation.clone(),
        }
    }

    pub fn native_approval(
        establish: impl FnOnce(CancellationToken) -> ToolFuture<EstablishedApproval> + Send + 'static,
        execute: impl FnOnce(CancellationToken) -> ToolFuture<ToolSuccess> + Send + 'static,
    ) -> Self {
        let mut effect = Self::new(execute);
        let PreparedExecution::Inline(execute) = effect.take_execution() else {
            unreachable!("new effects have inline execution")
        };
        effect.execution = Some(PreparedExecution::NativeApproval(PreparedNativeApproval {
            establish: Box::new(establish),
            execute,
        }));
        effect
    }

    /// Consume live admission guards after the durable ToolAdmitted transaction.
    /// The actual worker, not its observer, retains the returned owner until drain.
    pub fn begin(
        mut self,
        admitted_sequence: u64,
        cancellation: CancellationToken,
    ) -> Result<RunningEffect, ToolError> {
        self.admitted(admitted_sequence);
        self.admit()?;
        Ok(RunningEffect {
            effect: self,
            cancellation,
        })
    }

    pub(super) fn take_execution(&mut self) -> PreparedExecution {
        self.execution
            .take()
            .expect("prepared effect is consumed once")
    }

    pub(super) fn set_execution(&mut self, execute: Execute) {
        self.execution = Some(PreparedExecution::Inline(execute));
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

    pub(super) fn admit(&mut self) -> Result<(), ToolError> {
        for admit in self.admissions.drain(..) {
            self.leases.push(admit()?);
        }
        Ok(())
    }

    pub(super) fn start(&mut self, cancellation: CancellationToken) -> ToolFuture<ToolSuccess> {
        if let Err(error) = self.admit() {
            return Box::pin(async { Err(error) });
        }
        match self.take_execution() {
            PreparedExecution::Inline(execute) => execute(cancellation),
            PreparedExecution::NativeApproval(_) => {
                unreachable!("journal establishes native approvals before execution")
            }
        }
    }
}
/// Live one-shot work with all original admission leases. Never reconstructed
/// from a RunSpec or serialized as durable execution authority.
pub struct RunningEffect {
    effect: PreparedEffect,
    cancellation: CancellationToken,
}
impl RunningEffect {
    /// Establish at most once; the owner retains its execution and leases while waiting.
    pub fn establish_approval(&mut self) -> Option<ToolFuture<EstablishedApproval>> {
        match self.effect.take_execution() {
            PreparedExecution::Inline(execute) => {
                self.effect.set_execution(execute);
                None
            }
            PreparedExecution::NativeApproval(PreparedNativeApproval { establish, execute }) => {
                self.effect.set_execution(execute);
                Some(establish(self.cancellation.clone()))
            }
        }
    }

    /// Keep custody separate from polling, so unwinding cannot release admission
    /// leases before the owner has published the original outcome.
    pub fn execute(mut self) -> (EffectCustody, ToolFuture<ToolSuccess>) {
        let cancellation = self.cancellation.clone();
        let future: ToolFuture<ToolSuccess> = match self.effect.take_execution() {
            PreparedExecution::Inline(execute) => {
                Box::pin(async move { execute(cancellation).await })
            }
            PreparedExecution::NativeApproval(_) => Box::pin(async {
                Err(ToolError::Failed(
                    "native approval has not been established".into(),
                ))
            }),
        };
        (
            EffectCustody {
                _effect: self.effect,
            },
            future,
        )
    }
}

/// Original one-shot admission leases, retained through durable settlement.
/// This owner cannot dispatch or reconstruct another execution.
pub struct EffectCustody {
    _effect: PreparedEffect,
}

pub type PreparationFuture =
    Pin<Box<dyn Future<Output = Result<PreparedEffect, ToolRejection>> + Send>>;

/// Host-owned identity; neither model arguments nor Code Mode may choose it.
#[derive(Clone)]
pub struct ToolCallContext {
    pub execution: ExecutionIdentity,
    pub operation_id: String,
    pub call: crate::tool_call::ToolCallIdentity,
    pub custody: Option<Arc<dyn maka_plugin_core::work::WorkCustody>>,
}

impl ToolCallContext {
    pub fn tool_use_id(&self) -> String {
        tool_use_id(self.execution.run_id, &self.operation_id)
    }
}

/// Preparation may parse a remote call and read policy, but must not publish
/// prompts or effects that depend on an uncommitted accepted call identity.
/// Approval and effects run inside the returned one-shot effect after durable T1.
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
    /// Validated metadata without an executable tool.
    Declaration(String),
    Immediate(Arc<dyn ToolExecutor>),
    Prepared(Arc<dyn ToolPreparer>),
}
impl ToolHandler {
    pub fn names(&self) -> Vec<String> {
        match self {
            Self::Declaration(name) => vec![name.clone()],
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
            Self::Declaration(_) => Box::pin(async { Err(ToolRejection::Unavailable) }),
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

#[derive(
    Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize, schemars::JsonSchema,
)]
#[serde(rename_all = "snake_case")]
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
