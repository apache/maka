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

//! Integrity checks for a manual continuation. No driver, scheduling or authority restoration.
use crate::{RunError, preparation::PreparedRequest, prepared_prompt::PreparedPrompt};
use maka_agent_facts::{
    continuation::ContinuationClaim, durable::*, model::prompt_source::source::MessageRole,
};
use maka_agent_state::Store;

#[allow(clippy::too_many_arguments)]
pub async fn validate_continuation(
    state: &Store,
    target: &ExecutionIdentity,
    claim: &ContinuationClaim,
    basis: &maka_sandbox::workspace::PermissionBasis,
    workspace: &str,
    prompt: &PreparedPrompt,
    prepared: &PreparedRequest,
    logical_prompt_digest: Option<&str>,
) -> Result<(), RunError> {
    let invalid = |message: &str| RunError::ReconciliationRequired(message.into());
    claim.validate(target).map_err(invalid)?;
    let original = state.frontier(claim.source.execution.run_id).await?;
    if original.terminal.is_none()
        || original.revision != claim.source.high_water
        || original.spec.session_id != claim.source.execution.session_id
        || original.spec.turn_id != claim.source.execution.turn_id
        || original.spec.permission_basis.binding.id != basis.binding.id
        || original.spec.workspace != workspace
    {
        return Err(invalid("continuation source boundary or workspace changed"));
    }
    let mut history = Vec::new();
    let mut after = 0;
    loop {
        let page = state.history(original.run, after, 256).await?;
        if page.is_empty() {
            break;
        }
        after = page.last().expect("nonempty history").revision;
        history.extend(page);
    }
    if crate::digest(&history)? != claim.source.digest {
        return Err(invalid(
            "continuation source is not the exact sealed canonical boundary",
        ));
    }
    let first_step = history
        .iter()
        .find_map(|item| match item.fact {
            Fact::StepPrepared { step, .. } => Some(step),
            _ => None,
        })
        .ok_or_else(|| invalid("continuation has no prepared source request"))?;
    let first = state.request(original.run, first_step).await?;
    let source_bytes = state.content(original.run, first.source_capture).await?;
    let source: crate::preparation::RequestSource =
        serde_json::from_slice(&source_bytes).map_err(RunError::Json)?;
    if source.cut.through_sequence != claim.base.high_water
        || source.cut.digest != claim.base.digest
    {
        return Err(invalid("continuation canonical base changed"));
    }
    validate_replay_boundary(prompt).await?;
    let digest = if claim.replay.uses_logical_prompt() {
        logical_prompt_digest
            .ok_or_else(|| invalid("continuation lacks a logical prompt digest"))?
    } else {
        &prepared.input_digest
    };
    if digest != claim.replay.digest || prepared.route_identity != claim.replay.route_identity {
        return Err(invalid("continuation replay signature changed"));
    }
    Ok(())
}

pub async fn validate_replay_boundary(prompt: &PreparedPrompt) -> Result<(), RunError> {
    let invalid = |message: &str| RunError::ReconciliationRequired(message.into());
    let directory = prompt
        .recipes()
        .ok_or_else(|| invalid("continuation lacks a frozen logical directory"))?;
    let checkpoint = prompt.native_checkpoint_identity();
    let mut cursor = directory.open_metadata(0);
    let mut first_is_user = None;
    let mut last_stable = false;
    while let Some(message) = cursor.next().await? {
        if first_is_user.is_none() && checkpoint == Some(message.logical_identity.as_ref()) {
            continue;
        }
        if message.role != MessageRole::System && first_is_user.is_none() {
            first_is_user = Some(message.role == MessageRole::User);
        }
        last_stable = matches!(message.role, MessageRole::User | MessageRole::Tool)
            || (message.role == MessageRole::Assistant && message.last_is_tool_result);
    }
    if first_is_user != Some(true) || !last_stable {
        return Err(invalid(
            "continuation requires stable user/tool replay boundaries",
        ));
    }
    Ok(())
}
