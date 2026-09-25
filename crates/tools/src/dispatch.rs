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

use std::sync::Arc;

use maka_js_runtime::CodeExecutor;
use maka_runtime::event::{EventSink, Invocation};
use maka_runtime::model::ModelToolCall;
use maka_runtime::tool_call::{ToolCallIdentity, ToolRejection};
use maka_runtime::tools::{ToolError, ToolJournal};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::availability::{Availability, SEARCH};
use crate::{
    PreparedEffect, ToolCallContext, ToolCatalog, ToolDefinition, ToolMode, ToolSemantics, cell,
};

/// Run-scoped authority. Cell capacity is shared across runs, not recreated here.
pub struct RunTools {
    model: Option<maka_runtime::tools::ModelToolContext>,
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
        sink: Arc<dyn EventSink>,
        invocation: Invocation,
        catalog: ToolCatalog,
        mode: ToolMode,
        cells: CodeExecutor,
    ) -> Self {
        Self {
            model: None,
            journal: ToolJournal::new(sink, invocation),
            availability: Availability::new(catalog),
            mode,
            cells,
            code: cell::Cells::default(),
        }
    }

    pub fn clear_loaded(&self) {
        self.availability.clear();
    }

    pub fn with_store(mut self, store: maka_js_runtime::CellStore) -> Self {
        self.code = cell::Cells::new(store);
        self
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

    pub fn with_model(mut self, model: maka_runtime::tools::ModelToolContext) -> Self {
        self.set_model(model);
        self
    }

    pub fn with_behavior(mut self, behavior: maka_runtime::execution::BehaviorId) -> Self {
        self.availability.set_behavior(behavior);
        self
    }

    pub fn set_model(&mut self, model: maka_runtime::tools::ModelToolContext) {
        self.model = Some(model);
    }

    pub fn checkpoint(&self) -> maka_runtime::handoff::HandoffTools {
        self.availability.checkpoint()
    }

    pub fn restore(
        &self,
        checkpoint: &maka_runtime::handoff::HandoffTools,
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
        let (current, captured, context) = self
            .availability
            .capture(
                self.model.clone(),
                self.journal.invocation().clone(),
                cwd.into(),
                cancellation,
            )
            .await?;
        let mut request = self.request(current, captured, context);
        request.cwd = cwd.into();
        Ok(request)
    }

    /// Handoff seals settled history and Host capabilities, not a new model step.
    /// Dynamic plugins are sampled afresh by the successor after restoration.
    pub fn handoff_definitions(&self) -> Vec<ToolDefinition> {
        self.request(self.availability.clone(), None, Default::default())
            .definitions()
    }

    fn request(
        &self,
        current: Availability,
        captured: Option<maka_plugins::contributions::Captured>,
        context: maka_plugins::prompt::Resolved,
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
        RequestTools {
            cwd: String::new(),
            context,
            captured,
            digest,
            direct,
            run: self,
            catalog: if self.mode == ToolMode::CodeMode {
                availability.all()
            } else {
                availability.snapshot()
            },
            availability,
        }
    }
}

/// The advertised schemas and their handlers share one captured capability view.
/// Search settlement affects future captures, never this request or its retries.
pub struct RequestTools<'a> {
    cwd: String,
    context: maka_plugins::prompt::Resolved,
    captured: Option<maka_plugins::contributions::Captured>,
    digest: String,
    direct: ToolCatalog,
    run: &'a RunTools,
    catalog: ToolCatalog,
    availability: Availability,
}

impl<'a> RequestTools<'a> {
    pub fn captured(&self) -> Option<&maka_plugins::contributions::Captured> {
        self.captured.as_ref()
    }
    pub fn catalog_digest(&self) -> &str {
        &self.digest
    }

    pub async fn prompt(
        &self,
        base: Option<&str>,
        invocation: Invocation,
        cancellation: CancellationToken,
    ) -> Result<maka_plugins::prompt::Resolved, ToolError> {
        let request = maka_plugins::prompt::Request {
            target: maka_plugins::prompt::Target::ModelStep {
                invocation,
                cwd: self.cwd.clone(),
            },
            cancellation,
        };
        let mut prompt = maka_plugins::prompt::resolve(
            self.captured.as_ref(),
            base,
            request,
            self.catalog.workspace(),
        )
        .await
        .map_err(|error| ToolError::Failed(error.to_string()))?;
        if prompt
            .contexts
            .iter()
            .chain(&self.context.contexts)
            .map(String::len)
            .sum::<usize>()
            > 64 * 1024
        {
            return Err(ToolError::Failed("request context exceeds 64 KiB".into()));
        }
        prompt
            .contexts
            .extend(self.context.contexts.iter().cloned());
        prompt.sources.extend(self.context.sources.iter().cloned());
        if let Some(captured) = &self.captured {
            for (name, entry) in captured.typed::<crate::plugins::PluginTool>().entries {
                if !self.catalog.contains(&name) && !self.direct.contains(&name) {
                    continue;
                }
                let definition = serde_json::to_string(entry.value.definition())
                    .expect("validated tool definition");
                prompt.sources.push(
                    maka_plugins::prompt::source(
                        &entry,
                        maka_runtime::composition::SourceKind::Tool,
                        &name,
                        &definition,
                    )
                    .map_err(|error| ToolError::Failed(error.to_string()))?,
                );
            }
        }
        Ok(prompt)
    }

    pub fn definitions(&self) -> Vec<ToolDefinition> {
        if self.run.mode == ToolMode::CodeMode {
            let mut exec = cell::definition();
            let definitions: Vec<_> = self
                .availability
                .snapshot()
                .definitions()
                .cloned()
                .collect();
            exec.description.push_str("\nSome authorized tools may be omitted below. Find them by name and description in ALL_TOOLS; all are callable within the current cell.\n");
            exec.description.push_str(&cell::declarations(&definitions));
            std::iter::once(exec)
                .chain(std::iter::once(cell::wait_definition()))
                .chain(self.direct.definitions().cloned())
                .collect()
        } else {
            let mut definitions: Vec<_> = self.catalog.definitions().cloned().collect();
            definitions.extend(self.availability.definition());
            definitions
        }
    }

    pub fn into_step(self, step_id: &'a str) -> StepTools<'a> {
        StepTools {
            request: self,
            step_id,
            admission: Admission::Fresh,
            finished: false,
        }
    }
}

/// Call-order admission is separate from execution scheduling. Serial execution
/// alone does not make exclusive-step siblings legal.
pub struct StepTools<'a> {
    finished: bool,
    request: RequestTools<'a>,
    step_id: &'a str,
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

impl StepTools<'_> {
    pub fn finished(&self) -> bool {
        self.finished
    }

    pub async fn invoke(
        &mut self,
        call: &ModelToolCall,
        cancellation: CancellationToken,
    ) -> Result<Value, ToolError> {
        let run = self.request.run;
        run.code.check()?;
        let operation_id = format!("{}:{}", self.step_id, call.id);
        let identity = ToolCallIdentity::provider(self.step_id.into(), call.id.clone());
        let catalog = if run.mode == ToolMode::CodeMode {
            &self.request.direct
        } else {
            &self.request.catalog
        };
        let preparation: Result<PreparedEffect, ToolRejection> = async {
            if cancellation.is_cancelled() {
                return Err(ToolRejection::Cancelled);
            }
            if call.name == "exec" && run.mode == ToolMode::CodeMode {
                self.admission.admit(ToolSemantics::ExclusiveStep)?;
                let executor = cell::CellTool::new(
                    run.cells.clone(),
                    cell::source(&call.input)?,
                    self.request.catalog.clone(),
                    run.journal.clone(),
                    operation_id.clone(),
                    call.id.clone(),
                );
                let code = run.code.clone();
                let effect: PreparedEffect = PreparedEffect::new(move |cancellation| {
                    Box::pin(async move { code.start(executor, cancellation).await })
                });
                Ok(effect)
            } else if call.name == "wait" && run.mode == ToolMode::CodeMode {
                self.admission.admit(ToolSemantics::ExclusiveStep)?;
                let input = cell::wait_input(&call.input)?;
                let code = run.code.clone();
                Ok(PreparedEffect::new(move |cancellation| {
                    Box::pin(async move { code.observe(input, cancellation).await })
                }))
            } else if run.mode == ToolMode::Direct
                && call.name == SEARCH
                && self.request.availability.enabled()
            {
                self.admission.admit(ToolSemantics::Parallel)?;
                self.request.availability.prepare_search(&call.input)
            } else {
                self.admission.admit(catalog.semantics(&call.name)?)?;
                catalog
                    .prepare(
                        call.name.clone(),
                        call.input.clone(),
                        ToolCallContext {
                            invocation: run.journal.invocation().clone(),
                            operation_id: operation_id.clone(),
                        },
                        cancellation.clone(),
                    )
                    .await
            }
        }
        .await;
        let effect = match preparation {
            Ok(effect) => effect,
            Err(reason) => {
                return run
                    .journal
                    .reject(
                        operation_id,
                        identity,
                        call.name.clone(),
                        call.input.clone(),
                        reason,
                    )
                    .await;
            }
        };
        let result = run
            .journal
            .invoke_prepared_call(
                operation_id,
                identity,
                call.name.clone(),
                call.input.clone(),
                cancellation,
                effect,
            )
            .await?;
        if catalog.semantics(&call.name) == Ok(ToolSemantics::FinishTurn) {
            self.finished = true;
        }
        self.request.availability.settled(&call.name, &result)?;
        Ok(result)
    }
}
