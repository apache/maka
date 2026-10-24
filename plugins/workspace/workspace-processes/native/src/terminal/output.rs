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

use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use maka_agent_facts::terminal::TerminalSize;
use maka_host_runtime::shell::PtyStreamEvent;

impl Processes {
    pub(super) async fn terminal_output(
        &self,
        input: OutputRequest,
        watch: bool,
        context: &Context,
    ) -> Result<Value, ToolError> {
        if input.after > MAX_SEQUENCE {
            return Err(failed("Invalid terminal output cursor"));
        }
        let record = self.terminal_record(&input.target, context).await?;
        if !record.output.is_pty() {
            return Err(failed("Only a PTY has raw terminal output"));
        }
        let max_bytes = output_bytes()?;
        let mut stream = match self.resources.get(&input.target.session_id, &record.id) {
            Some(handle) => handle.output(input.after).map_err(failed)?,
            None => None,
        };
        let mut event = match &mut stream {
            Some(stream) => project(stream.read(max_bytes).await.map_err(failed)?),
            None => OutputEvent::Unavailable {
                reason: OutputUnavailable::NotRetained,
            },
        };
        let mut last = None;
        loop {
            let terminal = matches!(
                event,
                OutputEvent::Closed { .. } | OutputEvent::Unavailable { .. }
            );
            let value = completed(event)?;
            maka_plugin_core::json::exact_numbers(&value).map_err(failed)?;
            if !watch {
                if context.scope().cancellation.is_cancelled() {
                    return Err(failed("Process operation cancelled"));
                }
                if self.drain.is_cancelled() {
                    return Err(failed("Process owner is draining"));
                }
                return Ok(value);
            }
            // The retained output Arc conveys no Session authority of its own.
            self.terminal_session(&input.target.session_id, false, context)
                .await?;
            tokio::select! { biased;
                _ = context.scope().cancellation.cancelled() => return last.ok_or_else(|| failed("Process operation cancelled")),
                _ = self.drain.cancelled() => return last.ok_or_else(|| failed("Process owner is draining")),
                result = context.emit(value.clone()) => result.map_err(failed)?,
            }
            if terminal {
                return Ok(value);
            }
            last = Some(value);
            // A nonterminal event necessarily came from this original stream.
            let stream = stream.as_mut().expect("active terminal output stream");
            tokio::select! { biased;
                _ = context.scope().cancellation.cancelled() => return last.ok_or_else(|| failed("Process operation cancelled")),
                _ = self.drain.cancelled() => return last.ok_or_else(|| failed("Process owner is draining")),
                () = stream.ready() => {},
            }
            // Once filesystem work starts, settle it before cancellation can
            // complete this original Host call. Only the wait above is raced.
            event = project(stream.read(max_bytes).await.map_err(failed)?);
        }
    }
}

/// Fill a terminal delivery chunk, including base64 expansion. The maximum
/// cursor and u16 geometry reserve their full decimal widths for every resize.
/// Derive overhead from the real serialized variant, not a second byte policy.
fn output_bytes() -> Result<usize, ToolError> {
    let size = TerminalSize::new(2, 1).expect("minimum terminal size");
    let mut envelope = completed(OutputEvent::Data {
        sequence: MAX_SEQUENCE,
        initial_size: size,
        size,
        data_base64: String::new(),
    })?;
    for field in ["initialSize", "size"] {
        envelope["value"][field] = serde_json::json!({"cols": u16::MAX, "rows": u16::MAX});
    }
    let overhead = serde_json::to_vec(&envelope).map_err(failed)?.len();
    Ok((DELIVERY_CHUNK_BYTES - overhead) / 4 * 3)
}

fn project(event: PtyStreamEvent) -> OutputEvent {
    match event {
        PtyStreamEvent::Data {
            sequence,
            initial_size,
            size,
            bytes,
        } => OutputEvent::Data {
            sequence,
            initial_size,
            size,
            data_base64: STANDARD.encode(bytes.as_ref()),
        },
        PtyStreamEvent::Resize {
            sequence,
            initial_size,
            size,
        } => OutputEvent::Resize {
            sequence,
            initial_size,
            size,
        },
        PtyStreamEvent::Pending {
            after,
            initial_size,
            size,
        } => OutputEvent::Pending {
            after,
            initial_size,
            size,
        },
        PtyStreamEvent::Closed {
            after,
            initial_size,
            size,
        } => OutputEvent::Closed {
            after,
            initial_size,
            size,
        },
    }
}
