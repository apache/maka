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
use maka_agent_facts::event::CommitError;
use maka_agent_facts::event::EventWrite;
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::Invocation;
use maka_agent_facts::event::InvocationOutcome;
use maka_agent_facts::event::RuntimeEvent;
use maka_agent_facts::executor::Output;
use maka_agent_ports::executor::Error;
use maka_agent_ports::executor::Outcome;
use maka_agent_ports::executor::OutputSink;
use maka_event_log::root_store::SessionStore;
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

pub(super) struct Recorder {
    log: Arc<SessionStore>,
    invocation: Invocation,
    cancellation: CancellationToken,
    state: Mutex<State>,
}
#[derive(Default)]
struct State {
    closed: bool,
    messages: HashMap<String, Message>,
    last_body: Option<String>,
    calls: HashSet<String>,
    pending: HashSet<String>,
    failure: Option<CommitError>,
}
enum Message {
    Open { has_body: bool },
    Closed,
}
impl Recorder {
    pub fn new(
        log: Arc<SessionStore>,
        invocation: Invocation,
        cancellation: CancellationToken,
    ) -> Self {
        Self {
            log,
            invocation,
            cancellation,
            state: Mutex::default(),
        }
    }
    pub async fn finish(
        &self,
        result: &Result<Outcome, Error>,
        mut outcome: InvocationOutcome,
    ) -> Result<InvocationOutcome, crate::RunError> {
        // Drain accepted writes before sealing, then reject even retained sinks.
        let mut state = self.state.lock().await;
        state.closed = true;
        if let Some(error) = state.failure.take() {
            return Err(error.into());
        }
        let mut facts = vec![];
        if let (InvocationOutcome::Completed, Ok(Outcome::Completed { message_id })) =
            (&outcome, result)
        {
            if state
                .messages
                .values()
                .any(|message| matches!(message, Message::Open { .. }))
                || message_id != &state.last_body
            {
                outcome = InvocationOutcome::Failed {
                    class: "executor".into(),
                    model_failure: None,
                    message: Some("executor completed without a settled final body message".into()),
                };
            } else {
                facts.push(Fact::ExecutorCompleted {
                    message_id: message_id.clone(),
                });
            }
        }
        facts.push(Fact::InvocationEnded {
            outcome: outcome.clone(),
        });
        let writes = facts
            .into_iter()
            .map(|fact| EventWrite::plain(RuntimeEvent::new(self.invocation.clone(), fact)))
            .collect::<Result<Vec<_>, _>>()?;
        self.log.append_batch(&writes).await?;
        Ok(outcome)
    }
}
impl OutputSink for Recorder {
    fn emit(&self, output: Output) -> BoxFuture<'_, Result<(), Error>> {
        Box::pin(async move {
            let mut state = self.state.lock().await;
            if state.closed || self.cancellation.is_cancelled() {
                return Err(Error::Cancelled);
            }
            output
                .validate()
                .map_err(|reason| Error::Invalid(reason.into()))?;
            match &output {
                Output::MessageStart { message_id } if state.messages.contains_key(message_id) => {
                    return Err(Error::Invalid("duplicate assistant message ID".into()));
                }
                Output::OutputDelta { message_id, .. }
                | Output::ThinkingDelta { message_id, .. }
                | Output::MessageEnd { message_id }
                    if !matches!(state.messages.get(message_id), Some(Message::Open { .. })) =>
                {
                    return Err(Error::Invalid(
                        "assistant output has no open message".into(),
                    ));
                }
                Output::ToolStart { tool_call_id, .. } if state.calls.contains(tool_call_id) => {
                    return Err(Error::Invalid("duplicate tool activity ID".into()));
                }
                Output::ToolProgress { tool_call_id, .. }
                | Output::ToolResult { tool_call_id, .. }
                    if !state.pending.contains(tool_call_id) =>
                {
                    return Err(Error::Invalid(
                        "external tool activity has no pending start".into(),
                    ));
                }
                _ => {}
            }
            let event = EventWrite::plain(RuntimeEvent::new(
                self.invocation.clone(),
                Fact::ExecutorObserved {
                    output: output.clone(),
                },
            ))
            .map_err(|error| Error::Invalid(error.to_string()))?;
            if let Err(error) = self.log.append(&event).await {
                let message = error.to_string();
                state.failure = Some(error);
                self.cancellation.cancel();
                return Err(Error::Persistence(message));
            }
            match output {
                Output::MessageStart { message_id } => {
                    state
                        .messages
                        .insert(message_id, Message::Open { has_body: false });
                }
                Output::OutputDelta { message_id, text } if !text.is_empty() => {
                    let Message::Open { has_body } = state
                        .messages
                        .get_mut(&message_id)
                        .expect("validated open message")
                    else {
                        unreachable!()
                    };
                    *has_body = true;
                }
                Output::MessageEnd { message_id } => {
                    let message = state
                        .messages
                        .get_mut(&message_id)
                        .expect("validated open message");
                    let Message::Open { has_body } = *message else {
                        unreachable!()
                    };
                    *message = Message::Closed;
                    if has_body {
                        state.last_body = Some(message_id);
                    }
                }
                Output::ToolStart { tool_call_id, .. } => {
                    state.calls.insert(tool_call_id.clone());
                    state.pending.insert(tool_call_id);
                }
                Output::ToolResult { tool_call_id, .. } => {
                    state.pending.remove(&tool_call_id);
                }
                _ => {}
            }
            Ok(())
        })
    }
}
