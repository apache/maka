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

use super::super::{Phase, owner::Owner};
use futures_util::future::BoxFuture;
use maka_plugins::session::{Behavior, Preparation, Request};
use maka_runtime::execution::SandboxMode;
use std::{collections::BTreeSet, sync::Arc};

pub(super) struct Planning;
impl Behavior for Planning {
    fn prepare(&self, request: Request) -> BoxFuture<'_, Result<Preparation, String>> {
        Box::pin(async move {
            let full = request.session.sandbox_mode == SandboxMode::DangerFullAccess;
            let mut tools: BTreeSet<String> = [
                "Read",
                "Grep",
                "Glob",
                "AskUserQuestion",
                "SubmitPlan",
                "WebFetch",
                "WebSearch",
                "Recall",
                "RecallMore",
            ]
            .into_iter()
            .map(str::to_owned)
            .collect();
            if full {
                tools.extend(["Write", "Edit", "apply_patch", "Shell"].map(str::to_owned));
            }
            let boundary = if full {
                "Full access is enabled. Only perform side effects explicitly requested by the user; full access does not itself approve implementation."
            } else {
                "Inspect and discuss only. Workspace mutation, Shell, subagents and autonomous workflows are unavailable."
            };
            Ok(Preparation {
                instructions: format!(
                    "You are planning a change for user approval. {boundary} Ask focused questions when needed. When ready, call SubmitPlan once with concrete ordered steps and material risks. Submission ends this planning Turn; it does not start implementation."
                ),
                tool_ceiling: Some(tools),
                ..Default::default()
            })
        })
    }
}

pub(super) struct Execute(pub Arc<Owner>);
impl Behavior for Execute {
    fn prepare(&self, request: Request) -> BoxFuture<'_, Result<Preparation, String>> {
        Box::pin(async move {
            let snapshot = self
                .0
                .repository(&request.session.session_id)
                .map_err(super::message)?
                .current()
                .await
                .map_err(super::message)?;
            let execution = snapshot.execution.ok_or("No approved Plan execution")?;
            if !matches!(
                execution.phase,
                Phase::AwaitingAdmission | Phase::Active { .. }
            ) || execution.cancellation.is_some()
            {
                return Err("Plan execution is not active".into());
            }
            if request
                .session
                .bound_tools
                .as_ref()
                .is_some_and(|tools| !tools.contains("update_plan"))
            {
                return Err("Session tool ceiling excludes update_plan".into());
            }
            Ok(Preparation {
                instructions: "Execute the frozen user-approved Plan in the opening message. Use update_plan to report every step with the exact IDs, at most one in progress. Mark completed only with evidence. Report interruptions truthfully. Use cancel_plan only when the user asks to abandon execution. Model-reported completion takes effect only after this Host execution ends successfully.".into(),
                ..Default::default()
            })
        })
    }
}
