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

use super::{CellTool, CodeInput, NestedTools, WaitInput};
use futures_util::FutureExt;
use maka_js_runtime::{
    CellAbort, CellContext, CellOutput, CellStore, NotificationGate, ToolMetadata,
};
use maka_runtime::{
    tool_call::{ToolCallIdentity, ToolOrigin},
    tool_output::{ToolContent, ToolOutput, ToolSuccess},
    tools::ToolError,
};
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{oneshot, watch};
use tokio_util::{sync::CancellationToken, task::TaskTracker};

const MAX_CELLS: usize = 4;
const MAX_OUTPUT_BYTES: usize = 128 * 1024;

#[derive(Clone, Default)]
pub(crate) struct Cells(Arc<State>);

#[derive(Default)]
struct State {
    cells: Mutex<BTreeMap<String, Arc<Cell>>>,
    store: CellStore,
    cancellation: CancellationToken,
    tasks: TaskTracker,
    fatal: Mutex<Option<ToolError>>,
    notification_gate: NotificationGate,
    notification_high_water: tokio::sync::Mutex<u64>,
    notification_changed: tokio::sync::Notify,
}

struct Cell {
    context: CellContext,
    cancellation: CancellationToken,
    observer: tokio::sync::Mutex<()>,
    done: watch::Receiver<Option<Result<Value, ToolError>>>,
}

#[derive(Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
enum Observation {
    Running {
        cell_id: String,
        content: Vec<CellOutput>,
    },
    Completed {
        cell_id: String,
        content: Vec<CellOutput>,
        result: Value,
    },
    Terminated {
        cell_id: String,
        content: Vec<CellOutput>,
    },
}

impl Cells {
    pub fn new(store: CellStore) -> Self {
        Self(Arc::new(State {
            store,
            ..State::default()
        }))
    }

    pub fn cancel(&self) {
        self.0.cancellation.cancel();
    }

    pub async fn shutdown(&self) -> Result<(), ToolError> {
        self.0.notification_gate.close();
        self.cancel();
        self.0.tasks.close();
        self.0.tasks.wait().await;
        self.check()
    }

    /// Linearize final model output with notification acceptance. A newer
    /// committed notification requires another step; later callbacks see closure.
    pub async fn finish_output(&self, observed: u64) -> Result<bool, ToolError> {
        loop {
            let changed = self.0.notification_changed.notified();
            self.check()?;
            let high_water = self.0.notification_high_water.lock().await;
            if *high_water > observed {
                return Ok(false);
            }
            if self.0.notification_gate.close_if_empty(
                self.0
                    .cells
                    .lock()
                    .unwrap()
                    .values()
                    .map(|cell| &cell.context),
            ) {
                return Ok(true);
            }
            drop(high_water);
            changed.await;
        }
    }

    pub fn check(&self) -> Result<(), ToolError> {
        let failure = self.0.fatal.lock().unwrap().clone().or_else(|| {
            self.0
                .cells
                .lock()
                .unwrap()
                .values()
                .find_map(|cell| cell.context.failure())
        });
        match failure {
            Some(error) => {
                self.0.cancellation.cancel();
                Err(error)
            }
            None => Ok(()),
        }
    }

    pub fn is_idle(&self) -> bool {
        self.0.tasks.is_empty()
    }

    pub async fn start(
        &self,
        tool: CellTool,
        cancellation: CancellationToken,
    ) -> Result<ToolSuccess, ToolError> {
        self.check()?;
        if self.0.cancellation.is_cancelled() || cancellation.is_cancelled() {
            return Err(ToolError::Failed("code session is closed".into()));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let call_id = uuid::Uuid::new_v4().to_string();
        let metadata = tool
            .catalog
            .definitions()
            .map(|definition| ToolMetadata {
                name: maka_js_runtime::tool_identifier(&definition.name),
                description: super::declarations(std::slice::from_ref(definition)),
            })
            .collect();
        let context = CellContext::with_notification_gate(
            self.0.store.clone(),
            tool.cells.limits().max_value_bytes,
            metadata,
            self.0.notification_gate.clone(),
        );
        let (done, completion) = watch::channel(None);
        let token = cancellation.child_token();
        let cell = Arc::new(Cell {
            context: context.clone(),
            cancellation: token.clone(),
            observer: tokio::sync::Mutex::new(()),
            done: completion,
        });
        {
            let mut cells = self.0.cells.lock().unwrap();
            if cells.len() >= MAX_CELLS {
                return Err(ToolError::Failed("at most 4 cells may be running or awaiting their final observation; use wait first".into()));
            }
            cells.insert(id.clone(), cell);
        }
        let CodeInput {
            code,
            yield_time_ms,
            max_output_tokens,
        } = tool.input;
        let nested = Arc::new(NestedTools {
            catalog: tool.catalog,
            journal: tool.journal.clone(),
            origin: ToolOrigin::CodeMode {
                parent_operation_id: id.clone(),
                parent_tool_call_id: call_id.clone(),
            },
        });
        let journal = tool.journal;
        let identity = ToolCallIdentity {
            tool_call_id: call_id,
            origin: ToolOrigin::CodeCell {
                parent_operation_id: tool.parent_operation_id,
                parent_tool_call_id: tool.parent_tool_call_id,
            },
        };
        let root_id = id.clone();
        let state = self.0.clone();
        let (started, ready) = oneshot::channel();
        self.0.tasks.spawn(async move {
            let effect_context = context.clone();
            let shutdown = state.cancellation.clone();
            let notification_state = state.clone();
            let result = std::panic::AssertUnwindSafe(async move {
                let notifications = journal.clone();
                let notification_id = root_id.clone();
                let operation = journal.invoke_call_with(
                    root_id,
                    identity,
                    "code_cell".into(),
                    // Source is already authoritative in the linked exec T1.
                    Value::Null,
                    token.clone(),
                    move |cancellation| {
                        Box::pin(async move {
                            let _ = started.send(());
                            let execution = tool.cells.execute_module(code, nested, cancellation.clone(), effect_context.clone());
                            tokio::pin!(execution);
                            let result = loop {
                                tokio::select! {
                                    biased;
                                    _ = effect_context.notified() => {
                                        if let Err(error) = publish_notifications(&notification_state, &notifications, &notification_id, &effect_context, max_output_tokens).await {
                                            effect_context.fail(error.clone());
                                            cancellation.cancel();
                                            let _ = execution.await;
                                            return Err(error);
                                        }
                                    }
                                    result = &mut execution => break result,
                                }
                            };
                            publish_notifications(&notification_state, &notifications, &notification_id, &effect_context, max_output_tokens).await?;
                            result
                                .map_err(abort)
                                .and_then(|result| {
                                    serde_json::to_value(result).map_err(|error| {
                                        ToolError::CleanupUnconfirmed(error.to_string())
                                    })
                                })
                        })
                    },
                );
                tokio::pin!(operation);
                tokio::select! {
                    result = &mut operation => result,
                    _ = shutdown.cancelled() => {
                        token.cancel();
                        operation.await
                    },
                }
            })
            .catch_unwind()
            .await
            .unwrap_or_else(|_| {
                Err(ToolError::CleanupUnconfirmed(
                    "code cell worker panicked".into(),
                ))
            });
            let result = result.and_then(|result| {
                context
                    .commit()
                    .map_err(|error| ToolError::Failed(error.message))?;
                Ok(result)
            });
            if let Err(error @ (ToolError::Persistence(_) | ToolError::CleanupUnconfirmed(_))) =
                &result
            {
                state
                    .fatal
                    .lock()
                    .unwrap()
                    .get_or_insert_with(|| error.clone());
                state.cancellation.cancel();
            }
            done.send_replace(Some(result));
            state.notification_changed.notify_one();
        });
        // The independent cell T1 must precede settlement of its starting exec.
        // A failed T1 drops this sender; observation propagates the stored failure.
        let _ = ready.await;
        self.observe(
            WaitInput {
                cell_id: id,
                yield_time_ms,
                max_tokens: max_output_tokens,
                terminate: false,
            },
            cancellation,
        )
        .await
    }

    pub async fn observe(
        &self,
        request: WaitInput,
        cancellation: CancellationToken,
    ) -> Result<ToolSuccess, ToolError> {
        self.check()?;
        let cell = self.0.cells.lock().unwrap().get(&request.cell_id).cloned()
            .ok_or_else(|| ToolError::Failed("cell is unavailable: finished, cleared, or from another Run; do not repeat effects blindly".into()))?;
        let _observer = cell
            .observer
            .try_lock()
            .map_err(|_| ToolError::Failed("cell already has an observer".into()))?;
        if request.terminate {
            cell.cancellation.cancel();
        }
        let mut done = cell.done.clone();
        if done.borrow().is_none() {
            tokio::select! {
                biased;
                _ = cancellation.cancelled() => return Err(ToolError::Failed("cell observation cancelled".into())),
                _ = done.changed() => {},
                _ = cell.context.yielded(), if !request.terminate => {},
                _ = tokio::time::sleep(Duration::from_millis(request.yield_time_ms)) => {},
            }
        }
        let result = done.borrow().clone();
        if result.is_none() && done.has_changed().is_err() {
            let error =
                ToolError::CleanupUnconfirmed("cell worker closed without settlement".into());
            self.0
                .fatal
                .lock()
                .unwrap()
                .get_or_insert_with(|| error.clone());
            self.0.cancellation.cancel();
            return Err(error);
        }
        // Fatal failures always escape before consuming output or permitting a
        // new model step, even if JS caught its own nested exception.
        self.check()?;
        let content = cell.context.take_output();
        let observation = match result {
            None => Observation::Running {
                cell_id: request.cell_id.clone(),
                content,
            },
            Some(Ok(result)) => Observation::Completed {
                cell_id: request.cell_id.clone(),
                content,
                result,
            },
            Some(Err(ToolError::Failed(_))) if cell.cancellation.is_cancelled() => {
                Observation::Terminated {
                    cell_id: request.cell_id.clone(),
                    content,
                }
            }
            Some(Err(error)) => Observation::Completed {
                cell_id: request.cell_id.clone(),
                content,
                result: json!({"ok":false,"error":error.to_string()}),
            },
        };
        if !matches!(observation, Observation::Running { .. }) {
            self.0.cells.lock().unwrap().remove(&request.cell_id);
        }
        Ok(project(observation, request.max_tokens))
    }
}

async fn publish_notifications(
    state: &State,
    journal: &maka_runtime::tools::ToolJournal,
    cell_id: &str,
    context: &CellContext,
    max_tokens: usize,
) -> Result<(), ToolError> {
    let mut high_water = state.notification_high_water.lock().await;
    for text in context.take_notifications() {
        let mut remaining = max_tokens.saturating_mul(4).min(MAX_OUTPUT_BYTES);
        let model_text = clip(&text, &mut remaining);
        *high_water = journal.notify(cell_id.into(), text, model_text).await?;
        state.notification_changed.notify_one();
    }
    Ok(())
}

fn abort(error: CellAbort) -> ToolError {
    match error {
        CellAbort::Tool(error) => error,
        CellAbort::Cancelled => ToolError::Failed("code execution cancelled".into()),
        CellAbort::Internal(error) => ToolError::CleanupUnconfirmed(error),
    }
}

fn project(observation: Observation, max_tokens: usize) -> ToolSuccess {
    let raw = serde_json::to_value(&observation).expect("typed cell observation");
    let (content, summary) = match observation {
        Observation::Running { cell_id, content } => {
            (content, json!({"state":"running","cell_id":cell_id}))
        }
        Observation::Completed {
            cell_id,
            content,
            result,
        } => (
            content,
            json!({"state":"completed","cell_id":cell_id,"result":result}),
        ),
        Observation::Terminated { cell_id, content } => {
            (content, json!({"state":"terminated","cell_id":cell_id}))
        }
    };
    let mut remaining = max_tokens.saturating_mul(4).min(MAX_OUTPUT_BYTES);
    let mut parts = vec![ToolContent::Text(clip(
        &summary.to_string(),
        &mut remaining,
    ))];
    for output in content {
        parts.push(match output {
            CellOutput::Text { text } => ToolContent::Text(clip(&text, &mut remaining)),
            CellOutput::Image { image } => ToolContent::Image(image),
            CellOutput::Media { content, detail } => ToolContent::Media { content, detail },
        });
    }
    ToolSuccess::content(ToolOutput::Json(raw), parts)
}

fn clip(text: &str, remaining: &mut usize) -> String {
    if *remaining == 0 {
        return String::new();
    }
    let bytes = serde_json::to_string(text).unwrap().len();
    if bytes <= *remaining {
        *remaining -= bytes;
        return text.into();
    }
    const MARKER: &str = "\n[output truncated; full observation is archived]";
    let available = remaining.saturating_sub(MARKER.len() + 3);
    let mut used = 0;
    let mut end = 0;
    for (index, ch) in text.char_indices() {
        let bytes = match ch {
            '"' | '\\' | '\u{8}' | '\t' | '\n' | '\u{c}' | '\r' => 2,
            '\u{0}'..='\u{1f}' => 6,
            _ => ch.len_utf8(),
        };
        if bytes > available.saturating_sub(used) {
            break;
        }
        used += bytes;
        end = index + ch.len_utf8();
    }
    *remaining = 0;
    format!("{}{MARKER}", &text[..end])
}
