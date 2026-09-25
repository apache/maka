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

use crate::{InvocationView, ProjectionError, State};
use maka_runtime::context::ModelPurpose;
use maka_runtime::event::{Fact, InvocationInput, RuntimeEvent};

impl InvocationView {
    // Summary attempts produce no transcript rows, whether standalone or inside
    // a Message Turn. Every request records its explicit purpose.
    pub(super) fn compact(&mut self, event: &RuntimeEvent) -> Result<bool, ProjectionError> {
        if let State::Active { invocation, .. } = &self.state {
            if *invocation != event.invocation {
                return Err(ProjectionError::Invalid("invocation identity changed"));
            }
            if let Fact::ModelRequested {
                step_id,
                purpose: ModelPurpose::Summary,
                ..
            } = &event.fact
            {
                if self.summary_step.is_some() {
                    return Err(ProjectionError::Invalid("overlapping model steps"));
                }
                self.summary_step = Some(step_id.clone());
                return Ok(true);
            }
            if let Some(summary) = &self.summary_step {
                match &event.fact {
                    Fact::ModelObserved { step_id, .. } if step_id == summary => return Ok(true),
                    Fact::ModelCompleted { step_id, .. }
                    | Fact::ModelInterrupted { step_id, .. }
                        if step_id == summary =>
                    {
                        self.summary_step = None;
                        return Ok(true);
                    }
                    Fact::InvocationEnded { outcome }
                        if outcome.status() != maka_runtime::event::TerminalStatus::Completed =>
                    {
                        self.summary_step = None;
                    }
                    Fact::InvocationEnded { .. } => {
                        return Err(ProjectionError::Invalid("unfinished summary at completion"));
                    }
                    _ => {} // Main and tool facts retain their ordinary identity checks.
                }
            }
        }
        if matches!(
            event.fact,
            Fact::InvocationOpened {
                input: InvocationInput::ContextCompact { .. },
                ..
            }
        ) {
            if !matches!(self.state, State::Vacant) {
                return Err(ProjectionError::Invalid("duplicate invocation opening"));
            }
            self.state = State::Compact(event.invocation.clone());
            return Ok(true);
        }
        let State::Compact(invocation) = &self.state else {
            return Ok(false);
        };
        if *invocation != event.invocation {
            return Err(ProjectionError::Invalid("invocation identity changed"));
        }
        match event.fact {
            Fact::ModelRequested {
                purpose: ModelPurpose::Main,
                ..
            } => {
                return Err(ProjectionError::Invalid(
                    "main request in compact invocation",
                ));
            }
            Fact::ModelRequested { .. }
            | Fact::ModelObserved { .. }
            | Fact::ModelCompleted { .. }
            | Fact::ModelInterrupted { .. }
            | Fact::ContextCheckpointRecorded { .. }
            | Fact::ToolResultArchived { .. } => {}
            Fact::InvocationEnded { .. } => self.state = State::Ended,
            _ => return Err(ProjectionError::Invalid("unexpected compaction fact")),
        }
        Ok(true)
    }
}
