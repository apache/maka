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

use futures_util::future::BoxFuture;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use crate::CodeExecutor;
use maka_agent_facts::event::Invocation;
use maka_agent_facts::event::{EventSink, EventWrite};
use maka_agent_facts::language::Language;
use maka_agent_facts::model::ModelToolCall;
use maka_agent_facts::tool_call::ToolCallIdentity;
use maka_agent_facts::tool_call::ToolRejection;
use maka_agent_facts::tools::ToolError;
use maka_agent_facts::tools::{ApprovalContinuation, ToolContinuation, ToolFuture, ToolJournal};
use serde_json::Value;
use std::{
    future::Future,
    pin::Pin,
    task::{Context, Poll},
};
use tokio_util::sync::CancellationToken;

use crate::availability::{Availability, LoadedTools, SEARCH};
use crate::{PreparedEffect, ToolCatalog, ToolDefinition, ToolMode, ToolSemantics, cell};

/// Run-scoped authority. Cell capacity is shared across runs, not recreated here.
pub struct RunTools {
    language: Language,
    model: Option<maka_agent_facts::tools::ModelToolContext>,
    journal: ToolJournal,
    availability: Availability,
    mode: ToolMode,
    cells: CodeExecutor,
    code: cell::Cells,
}

impl Drop for RunTools {
    fn drop(&mut self) {
        self.code.cancel();
    }
}

impl RunTools {
    pub fn new(
        language: Language,
        sink: Arc<dyn EventSink>,
        invocation: Invocation,
        catalog: ToolCatalog,
        mode: ToolMode,
        cells: CodeExecutor,
        loaded: LoadedTools,
    ) -> Self {
        let code = cell::Cells::new(maka_code_runtime::CellStore::new(loaded.session().clone()));
        Self {
            language,
            model: None,
            journal: ToolJournal::new(sink, invocation),
            availability: Availability::new(catalog, loaded),
            mode,
            cells,
            code,
        }
    }

    pub async fn shutdown(&self) -> Result<(), ToolError> {
        self.code.shutdown().await
    }

    pub fn code_idle(&self) -> bool {
        self.code.is_idle()
    }
    pub async fn finish_output(&self, observed: u64) -> Result<bool, ToolError> {
        self.code.finish_output(observed).await
    }

    pub fn with_model(mut self, model: maka_agent_facts::tools::ModelToolContext) -> Self {
        self.set_model(model);
        self
    }

    pub fn with_behavior(mut self, behavior: maka_agent_facts::execution::BehaviorId) -> Self {
        self.availability.set_behavior(behavior);
        self
    }

    pub fn set_model(&mut self, model: maka_agent_facts::tools::ModelToolContext) {
        self.model = Some(model);
    }

    pub fn checkpoint(&self) -> Result<maka_agent_facts::handoff::HandoffTools, ToolError> {
        self.availability.checkpoint()
    }

    pub fn restore(
        &self,
        checkpoint: &maka_agent_facts::handoff::HandoffTools,
    ) -> Result<(), ToolError> {
        self.availability.restore(checkpoint)
    }

    /// Capture once per logical model step, before sending any physical attempt.
    pub async fn capture(
        &self,
        cwd: &str,
        cancellation: CancellationToken,
    ) -> Result<RequestTools<'_>, ToolError> {
        self.code.check()?;
        let current = self
            .availability
            .capture(
                self.model.clone(),
                self.journal.invocation().clone(),
                self.journal.execution_custody(),
                cwd.into(),
                cancellation,
            )
            .await?;
        self.request(current)
    }

    /// Bind fresh custody while retaining the original request's advertised schemas.
    /// The full bound catalog is checked before Direct selects its explicit names.
    pub async fn capture_frozen(
        &self,
        cwd: &str,
        composition: &maka_agent_facts::composition::RequestComposition,
        cancellation: CancellationToken,
    ) -> Result<RequestTools<'_>, ToolError> {
        self.code.check()?;
        let current = self
            .availability
            .capture(
                self.model.clone(),
                self.journal.invocation().clone(),
                self.journal.execution_custody(),
                cwd.into(),
                cancellation,
            )
            .await?;
        if current.digest() != composition.tool_catalog_digest {
            return Err(ToolError::Failed(
                "frozen request tool catalog changed".into(),
            ));
        }
        let mut request = self.request_selected(current, &std::collections::BTreeSet::new());
        let definitions = if self.mode == ToolMode::Direct {
            let names: std::collections::BTreeSet<_> = composition
                .tools
                .iter()
                .map(|definition| definition.name.as_str())
                .collect();
            let full = request.availability.all();
            let all = full.names();
            let excluded: Vec<_> = all
                .iter()
                .filter(|name| !names.contains(name.as_str()))
                .map(String::as_str)
                .collect();
            request.catalog = full.excluding(&excluded);
            let mut expected: Vec<_> = request.catalog.shared_definitions().collect();
            expected.extend(request.availability.definition().map(Arc::new));
            if expected != composition.tools {
                return Err(ToolError::Failed(
                    "frozen request tool schemas changed".into(),
                ));
            }
            expected
        } else {
            let mut exec = cell::definition(self.cells.language());
            let Some(original) = composition.tools.first() else {
                return Err(ToolError::Failed(
                    "frozen Code Mode schemas are missing".into(),
                ));
            };
            // The old loaded selection is already rendered in this description.
            exec.description = original.description.clone();
            let expected: Vec<_> = std::iter::once(Arc::new(exec))
                .chain(std::iter::once(Arc::new(cell::wait_definition())))
                .chain(request.direct.shared_definitions())
                .collect();
            if expected != composition.tools {
                return Err(ToolError::Failed("frozen Code Mode schemas changed".into()));
            }
            expected
        };
        request.frozen_definitions = Some(definitions.into());
        Ok(request)
    }

    fn request(&self, current: Availability) -> Result<RequestTools<'_>, ToolError> {
        let active = current.checkpoint()?.loaded;
        Ok(self.request_selected(current, &active))
    }

    pub fn replay_selected(
        &self,
        active: &std::collections::BTreeSet<String>,
    ) -> Vec<Arc<ToolDefinition>> {
        self.request_selected(self.availability.clone(), active)
            .definitions()
    }

    fn request_selected(
        &self,
        current: Availability,
        active: &std::collections::BTreeSet<String>,
    ) -> RequestTools<'_> {
        let digest = current.digest();
        let direct = if self.mode == ToolMode::CodeMode {
            current.direct_only()
        } else {
            ToolCatalog::default()
        };
        let availability = if self.mode == ToolMode::CodeMode {
            current.nested()
        } else {
            current
        };
        let described = availability.select(active);
        RequestTools {
            frozen_definitions: None,
            finished: Arc::new(AtomicBool::new(false)),
            digest,
            direct,
            run: self,
            catalog: if self.mode == ToolMode::CodeMode {
                availability.all()
            } else {
                described.clone()
            },
            described,
            availability,
        }
    }
}

/// The advertised schemas and their handlers share one captured capability view.
/// Search settlement affects future captures, never this request or its retries.
#[derive(Clone)]
pub struct RequestTools<'a> {
    frozen_definitions: Option<Arc<[Arc<ToolDefinition>]>>,
    finished: Arc<AtomicBool>,
    digest: String,
    direct: ToolCatalog,
    run: &'a RunTools,
    catalog: ToolCatalog,
    /// Frozen description selection, separate from Code Mode callability.
    described: ToolCatalog,
    availability: Availability,
}

impl<'a> RequestTools<'a> {
    pub fn finished(&self) -> bool {
        self.finished.load(Ordering::Acquire)
    }

    pub fn catalog_digest(&self) -> &str {
        &self.digest
    }

    pub fn definitions(&self) -> Vec<Arc<ToolDefinition>> {
        if let Some(definitions) = &self.frozen_definitions {
            return definitions.to_vec();
        }
        if self.run.mode == ToolMode::CodeMode {
            let mut exec = cell::definition(self.run.cells.language());
            exec.description.push('\n');
            exec.description.push_str(&cell::declarations(
                self.described.definitions(),
                self.run.cells.language(),
            ));
            std::iter::once(Arc::new(exec))
                .chain(std::iter::once(Arc::new(cell::wait_definition())))
                .chain(self.direct.shared_definitions())
                .collect()
        } else {
            let mut definitions: Vec<_> = self.catalog.shared_definitions().collect();
            definitions.extend(self.availability.definition().map(Arc::new));
            definitions
        }
    }

    pub fn into_step(self, step_id: &str) -> StepTools<'a> {
        StepTools {
            request: self,
            step_id: step_id.to_owned(),
            admission: Admission::Fresh,
        }
    }
}

/// Call-order admission is separate from execution scheduling. Serial execution
/// alone does not make exclusive-step siblings legal.
pub struct StepTools<'a> {
    request: RequestTools<'a>,
    step_id: String,
    admission: Admission,
}

#[derive(Default)]
enum Admission {
    #[default]
    Fresh,
    Parallel,
    Exclusive,
}

impl Admission {
    fn admit(&mut self, semantics: ToolSemantics) -> Result<(), ToolRejection> {
        *self = match (&self, semantics) {
            (Self::Fresh, ToolSemantics::ExclusiveStep | ToolSemantics::FinishTurn) => {
                Self::Exclusive
            }
            (Self::Fresh | Self::Parallel, ToolSemantics::Parallel) => Self::Parallel,
            _ => return Err(ToolRejection::ExclusiveConflict),
        };
        Ok(())
    }
}

impl<'a> StepTools<'a> {
    pub fn finished(&self) -> bool {
        self.request.finished()
    }

    /// Admit synchronously in call arrival order; preparation can then run concurrently.
    pub fn prepare(
        &mut self,
        call: ModelToolCall,
        cancellation: CancellationToken,
    ) -> BoxFuture<'a, Result<PreparedCall<'a>, ToolError>> {
        let request = self.request.clone();
        let run = request.run;
        let operation_id = format!("{}:{}", self.step_id, call.id);
        let identity = ToolCallIdentity::provider(self.step_id.clone(), call.id.clone());
        let catalog = if run.mode == ToolMode::CodeMode {
            &request.direct
        } else {
            &request.catalog
        };
        let semantics =
            if run.mode == ToolMode::CodeMode && matches!(call.name.as_str(), "exec" | "wait") {
                Ok(ToolSemantics::ExclusiveStep)
            } else if run.mode == ToolMode::Direct
                && call.name == SEARCH
                && request.availability.enabled()
            {
                Ok(ToolSemantics::Parallel)
            } else {
                catalog.semantics(&call.name)
            };
        let admission = if cancellation.is_cancelled() {
            Err(ToolRejection::Cancelled)
        } else {
            semantics.and_then(|semantics| self.admission.admit(semantics))
        };
        Box::pin(async move {
            run.code.check()?;
            let catalog = if run.mode == ToolMode::CodeMode {
                &request.direct
            } else {
                &request.catalog
            };
            let preparation: Result<(PreparedEffect, Value), ToolRejection> = async {
                if cancellation.is_cancelled() {
                    return Err(ToolRejection::Cancelled);
                }
                admission?;
                let input = call
                    .input
                    .as_json()
                    .ok_or_else(|| ToolRejection::InvalidInput {
                        message: "arguments are not valid JSON".into(),
                    })?;
                let effect = if call.name == "exec" && run.mode == ToolMode::CodeMode {
                    let executor = cell::CellTool::new(
                        run.cells.clone(),
                        cell::source(input, run.cells.language())?,
                        request.catalog.clone(),
                        run.journal.clone(),
                        operation_id.clone(),
                        call.id.clone(),
                    );
                    let code = run.code.clone();
                    let language = run.language;
                    let effect: PreparedEffect = PreparedEffect::new(move |cancellation| {
                        Box::pin(async move { code.start(executor, language, cancellation).await })
                    });
                    Ok(effect.titled(maka_agent_facts::display::Text::localized(
                        "Run tools",
                        "执行工具",
                        "執行工具",
                    )))
                } else if call.name == "wait" && run.mode == ToolMode::CodeMode {
                    let input = cell::wait_input(input)?;
                    let code = run.code.clone();
                    let language = run.language;
                    Ok(PreparedEffect::new(move |cancellation| {
                        Box::pin(async move { code.observe(input, language, cancellation).await })
                    }))
                } else if run.mode == ToolMode::Direct
                    && call.name == SEARCH
                    && request.availability.enabled()
                {
                    request.availability.prepare_search(input)
                } else {
                    catalog
                        .prepare(
                            call.name.clone(),
                            input.clone(),
                            run.journal.context(operation_id.clone()),
                            cancellation.clone(),
                        )
                        .await
                }?;
                Ok((effect, input.clone()))
            }
            .await;
            Ok(PreparedCall {
                request,
                operation_id,
                identity,
                call,
                cancellation,
                preparation,
            })
        })
    }
}

/// A prepared call owns no model prefix; the original writer chooses publication.
pub struct PreparedCall<'a> {
    request: RequestTools<'a>,
    operation_id: String,
    identity: ToolCallIdentity,
    call: ModelToolCall,
    cancellation: CancellationToken,
    preparation: Result<(PreparedEffect, Value), ToolRejection>,
}

/// The writer installs the prefix receipt before polling the one-shot completion.
pub struct PublishedCall {
    pub prefix_sequences: Vec<u64>,
    pub completion: CallContinuation,
}

pub enum CallContinuation {
    Executing(ToolFuture<Value>),
    Approval(PendingCall),
}

impl CallContinuation {
    pub fn into_future(self) -> ToolFuture<Value> {
        Box::pin(self)
    }
}

impl Future for CallContinuation {
    type Output = Result<Value, ToolError>;
    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let this = self.get_mut();
        loop {
            match this {
                Self::Executing(future) => return future.as_mut().poll(cx),
                Self::Approval(pending) => match Pin::new(pending).poll(cx) {
                    Poll::Pending => return Poll::Pending,
                    Poll::Ready(future) => *this = Self::Executing(future),
                },
            }
        }
    }
}

struct CallSettlement {
    finish_turn: bool,
    finished: Arc<AtomicBool>,
    availability: Availability,
    name: String,
}

impl CallSettlement {
    fn complete(self, execution: ToolFuture<Value>) -> ToolFuture<Value> {
        Box::pin(async move {
            let result = execution.await?;
            if self.finish_turn {
                self.finished.store(true, Ordering::Release);
            }
            self.availability.settled(&self.name, &result)?;
            Ok(result)
        })
    }
}

pub struct PendingCall {
    approval: Box<ApprovalContinuation<Value>>,
    settlement: Option<CallSettlement>,
}

impl PendingCall {
    pub fn pending(&self) -> &maka_agent_facts::native_approval::NativeApprovalPending {
        self.approval.pending()
    }
}

impl Future for PendingCall {
    type Output = ToolFuture<Value>;
    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let this = self.get_mut();
        match Pin::new(this.approval.as_mut()).poll(cx) {
            Poll::Pending => Poll::Pending,
            Poll::Ready(execution) => Poll::Ready(
                this.settlement
                    .take()
                    .expect("pending call settles once")
                    .complete(execution),
            ),
        }
    }
}

impl<'a> PreparedCall<'a> {
    pub fn publish(self, prefix: &[EventWrite]) -> BoxFuture<'a, Result<PublishedCall, ToolError>> {
        let prefix = prefix.to_vec();
        Box::pin(async move {
            let Self {
                request,
                operation_id,
                identity,
                call,
                cancellation,
                preparation,
            } = self;
            let journal = &request.run.journal;
            let published = match preparation {
                Ok((effect, input)) => {
                    journal
                        .publish_prepared_call(
                            operation_id,
                            identity,
                            call.name.clone(),
                            input,
                            prefix,
                            cancellation,
                            effect,
                        )
                        .await?
                }
                Err(reason) => {
                    journal
                        .publish_rejection(
                            operation_id,
                            identity,
                            call.name.clone(),
                            call.input,
                            prefix,
                            reason,
                        )
                        .await?
                }
            };
            let catalog = if request.run.mode == ToolMode::CodeMode {
                &request.direct
            } else {
                &request.catalog
            };
            let settlement = CallSettlement {
                finish_turn: catalog.semantics(&call.name) == Ok(ToolSemantics::FinishTurn),
                finished: request.finished.clone(),
                availability: request.availability.clone(),
                name: call.name,
            };
            let completion = match published.completion {
                ToolContinuation::Executing(execution) => {
                    CallContinuation::Executing(settlement.complete(execution))
                }
                ToolContinuation::Approval(approval) => CallContinuation::Approval(PendingCall {
                    approval,
                    settlement: Some(settlement),
                }),
            };
            Ok(PublishedCall {
                prefix_sequences: published.prefix_sequences,
                completion,
            })
        })
    }
}
