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
use maka_agent_facts::{
    shell_run::ShellOutput,
    terminal::display::{Buffer, Part, Row, RowPart},
};
use std::collections::VecDeque;

impl Processes {
    pub(super) async fn terminal_display(
        &self,
        target: Target,
        context: &Context,
    ) -> Result<Value, ToolError> {
        // Capture once. Subsequent chunks borrow this immutable display, never a
        // later SQL row or live preview; no transaction is held across delivery.
        let observation = self.terminal_record(&target, context).await?;
        if observation.state.active() {
            return Err(failed("Terminal display is not settled"));
        }
        let ShellOutput::Pty { screen } = &observation.output else {
            return Err(failed("Only a PTY has a terminal display"));
        };
        self.display_emit(
            &target,
            Part::Begin {
                revision: observation.revision,
                metadata: screen.metadata.clone(),
                scrollback_rows: screen.scrollback.len().try_into().map_err(failed)?,
                last_alternate_size: screen.last_alternate_screen.as_ref().map(|alt| alt.size),
            },
            context,
        )
        .await?;
        let overhead = serde_json::to_vec(&completed(Part::Rows { parts: Vec::new() })?)
            .map_err(failed)?
            .len();
        let mut parts = Vec::new();
        let mut bytes = overhead;
        let alternate = screen
            .last_alternate_screen
            .as_ref()
            .map_or(&[][..], |alt| alt.rows.as_slice());
        for (buffer, rows) in [
            (Buffer::Scrollback, screen.scrollback.as_slice()),
            (Buffer::Screen, screen.screen.as_slice()),
            (Buffer::LastAlternate, alternate),
        ] {
            for (row, runs) in rows.iter().enumerate() {
                for part in fragments(buffer, row as u32, runs, DELIVERY_CHUNK_BYTES - overhead)? {
                    let length = serde_json::to_vec(&part).map_err(failed)?.len();
                    let separator = usize::from(!parts.is_empty());
                    if bytes + separator + length > DELIVERY_CHUNK_BYTES {
                        self.display_emit(
                            &target,
                            Part::Rows {
                                parts: std::mem::take(&mut parts),
                            },
                            context,
                        )
                        .await?;
                        bytes = overhead;
                    }
                    bytes += usize::from(!parts.is_empty()) + length;
                    parts.push(part);
                }
            }
        }
        if !parts.is_empty() {
            self.display_emit(&target, Part::Rows { parts }, context)
                .await?;
        }
        // The non-null final result is the last part delivered to subscribers.
        self.terminal_session(&target.session_id, false, context)
            .await?;
        if context.scope().cancellation.is_cancelled() {
            return Err(failed("Terminal display cancelled"));
        }
        if self.drain.is_cancelled() {
            return Err(failed("Process owner is draining"));
        }
        completed(Part::End)
    }

    async fn display_emit(
        &self,
        target: &Target,
        part: Part,
        context: &Context,
    ) -> Result<(), ToolError> {
        // A retained display grants neither Session authority nor continued
        // delivery after cancellation or owner drain.
        self.terminal_session(&target.session_id, false, context)
            .await?;
        let value = completed(part)?;
        tokio::select! { biased;
            _ = context.scope().cancellation.cancelled() => Err(failed("Terminal display cancelled")),
            _ = self.drain.cancelled() => Err(failed("Process owner is draining")),
            result = context.emit(value) => result.map_err(failed),
        }
    }
}

/// Whole rows normally pack together. A large styled row/run is split at exact
/// cell boundaries, so geometry does not introduce a smaller delivery limit.
fn fragments(
    buffer: Buffer,
    row: u32,
    runs: &Row,
    budget: usize,
) -> Result<Vec<RowPart>, ToolError> {
    let mut pending: VecDeque<_> = runs.iter().cloned().collect();
    let mut part = RowPart {
        buffer,
        row,
        column: 0,
        runs: Vec::new(),
    };
    let mut out = Vec::new();
    while let Some(run) = pending.pop_front() {
        part.runs.push(run);
        if serde_json::to_vec(&part).map_err(failed)?.len() <= budget {
            continue;
        }
        let run = part.runs.pop().unwrap();
        if !part.runs.is_empty() {
            let consumed: usize = part.runs.iter().map(|run| run.columns()).sum();
            let next = part.column as usize + consumed;
            out.push(part);
            part = RowPart {
                buffer,
                row,
                column: next.try_into().map_err(failed)?,
                runs: Vec::new(),
            };
            pending.push_front(run);
        } else {
            let columns = run.columns();
            if columns < 2 {
                return Err(failed("Terminal cell exceeds Item envelope"));
            }
            let (left, right) = run.split_at(columns / 2);
            pending.push_front(right);
            pending.push_front(left);
        }
    }
    if !part.runs.is_empty() {
        out.push(part);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_agent_facts::terminal::{
        TerminalSize,
        display::{Assembly, Color, Display, Run, Style},
    };

    #[test]
    fn large_combining_and_styled_rows_cross_items_without_losing_cells() {
        let mut display = Display::new(TerminalSize::new(1024, 2).unwrap());
        let cell = format!("x{}", "\u{1d185}".repeat(32));
        display.screen[0] = vec![Run {
            style: Style {
                foreground: Color::Rgb([12, 34, 56]),
                background: Color::Indexed(125),
                flags: 2,
                underline: None,
            },
            text: cell.repeat(1024),
            lengths: vec![33; 1024],
        }];
        display.screen[1] = (0..1024)
            .map(|column| Run {
                style: Style {
                    foreground: Color::Rgb([(column % 256) as u8, 34, 56]),
                    background: Color::Indexed(125),
                    flags: 8,
                    underline: Some(Color::Named(1)),
                },
                text: "\"".into(),
                lengths: Vec::new(),
            })
            .collect();
        let mut assembly = Assembly::begin(display.metadata.clone(), 0, None).unwrap();
        let overhead = serde_json::to_vec(&completed(Part::Rows { parts: Vec::new() }).unwrap())
            .unwrap()
            .len();
        for (row, runs) in display.screen.iter().enumerate() {
            for fragment in fragments(
                Buffer::Screen,
                row as u32,
                runs,
                DELIVERY_CHUNK_BYTES - overhead,
            )
            .unwrap()
            {
                assembly.rows(vec![fragment]).unwrap();
            }
        }
        assert_eq!(assembly.finish().unwrap(), display);
    }
}
