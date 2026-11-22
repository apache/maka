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
    validate_continuation_source(state, target, claim, basis, workspace).await?;
    let invalid = |message: &str| RunError::ReconciliationRequired(message.into());
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

pub async fn validate_continuation_source(
    state: &Store,
    target: &ExecutionIdentity,
    claim: &ContinuationClaim,
    basis: &maka_sandbox::workspace::PermissionBasis,
    workspace: &str,
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
    let resolved = state
        .session_history(
            original.spec.owner.clone(),
            original.spec.session_id.clone(),
        )
        .continuation_source(original.run, claim.source.high_water)
        .await?;
    if resolved.digest != claim.source.digest {
        return Err(invalid(
            "continuation source is not the exact sealed canonical boundary",
        ));
    }
    if resolved.base.through_sequence != claim.base.high_water
        || resolved.base.digest != claim.base.digest
    {
        return Err(invalid("continuation canonical base changed"));
    }
    Ok(())
}

pub async fn validate_replay_boundary(prompt: &PreparedPrompt) -> Result<(), RunError> {
    let invalid = |message: &str| RunError::ReconciliationRequired(message.into());
    let directory = prompt
        .recipes()
        .ok_or_else(|| invalid("continuation lacks a frozen logical directory"))?;
    let mut cursor = directory.open_metadata(0);
    let mut first_valid = None;
    let mut last_stable = false;
    while let Some(message) = cursor.next().await? {
        if message.role != MessageRole::System {
            if first_valid.is_none() {
                first_valid =
                    Some(message.role == MessageRole::User || message.is_native_checkpoint);
            }
            last_stable = matches!(message.role, MessageRole::User | MessageRole::Tool)
                || (message.role == MessageRole::Assistant
                    && (message.last_is_tool_result || message.is_native_checkpoint));
        }
    }
    if first_valid != Some(true) || !last_stable {
        return Err(invalid(
            "continuation requires stable user/tool replay boundaries",
        ));
    }
    Ok(())
}
