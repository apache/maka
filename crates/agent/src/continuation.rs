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

use crate::{Inner, RunError, RunInput, model_attempt};
use maka_model::prompt::{AssistantPart, Message};
use maka_runtime::{
    context::ModelPurpose,
    continuation::{
        ContinuationClaim, MAX_SOURCE_BYTES, MAX_SOURCE_EVENTS, REPLAY_VERSION, ReplayEvidence,
        RunBoundary, SessionBase,
    },
    event::Fact,
    input::InvocationInput,
};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

/// Derive admission evidence from the exact sealed source. The caller supplies
/// only its boundary, never a replay digest or a pre-authorized claim.
pub(super) async fn prepare(
    inner: &Arc<Inner>,
    input: &RunInput,
    source: &RunBoundary,
    catalog: &maka_tools::ToolCatalog,
    cancellation: &CancellationToken,
) -> Result<ContinuationClaim, RunError> {
    let (base, replay) = inspect(inner, input, source, catalog, cancellation).await?;
    let pause = match &input.work {
        crate::RunWork::Handoff { pause, .. } => Some(pause),
        _ => None,
    };
    let claim = ContinuationClaim {
        id: pause.map_or_else(
            || uuid::Uuid::new_v4().to_string(),
            |pause| pause.intent.claim_id.clone(),
        ),
        source: source.clone(),
        base,
        replay,
    };
    match pause {
        Some(pause) => pause.validate_claim(&claim, &input.invocation),
        None => claim.validate(&input.invocation),
    }
    .map_err(invalid)?;
    Ok(claim)
}

pub(super) async fn inspect(
    inner: &Arc<Inner>,
    input: &RunInput,
    source: &RunBoundary,
    catalog: &maka_tools::ToolCatalog,
    cancellation: &CancellationToken,
) -> Result<(SessionBase, ReplayEvidence), RunError> {
    if source.invocation.session_id != input.invocation.session_id {
        return Err(invalid("continuation belongs to another Session"));
    }
    let prefix = inner
        .log
        .run_prefix(
            &source.invocation.session_id,
            &source.invocation.run_id,
            None,
            MAX_SOURCE_EVENTS,
            MAX_SOURCE_BYTES,
        )
        .await?
        .ok_or_else(|| invalid("continuation source is missing"))?;
    if prefix.invocation != source.invocation
        || prefix.high_water != source.high_water
        || prefix.digest != source.digest
        || !matches!(
            prefix.events.last().map(|s| &s.event.fact),
            Some(Fact::InvocationEnded { .. })
        )
    {
        return Err(invalid(
            "continuation source is not its exact sealed boundary",
        ));
    }
    let Fact::InvocationOpened {
        input: opening,
        configuration: Some(configuration),
    } = &prefix
        .events
        .first()
        .ok_or_else(|| invalid("continuation source is empty"))?
        .event
        .fact
    else {
        return Err(invalid("continuation source has no observed configuration"));
    };
    if input.configuration.workspace_identity.is_none()
        || input.configuration.workspace_identity != configuration.workspace_identity
    {
        return Err(invalid("continuation workspace identity changed"));
    }
    if let crate::RunWork::Handoff { pause, .. } = &input.work
        && (configuration.as_ref() != &input.configuration
            || !matches!(
                &prefix.events.last().expect("checked nonempty source").event.fact,
                Fact::InvocationEnded {
                    outcome: maka_runtime::event::InvocationOutcome::HandoffPaused { pause: sealed }
                } if sealed == pause.as_ref()
            ))
    {
        return Err(invalid("handoff does not match its sealed source"));
    }
    let base = match opening {
        InvocationInput::Message { .. } => {
            let base = inner
                .log
                .context_before_run(&source.invocation, 10_000, 8 * 1024 * 1024)
                .await?;
            SessionBase {
                high_water: base.source_evidence.high_water,
                digest: base.source_evidence.digest,
            }
        }
        InvocationInput::Continuation { claim, .. } | InvocationInput::Handoff { claim, .. } => {
            claim.base.clone()
        }
        _ => return Err(invalid("source is not a resumable model Run")),
    };
    let context = inner
        .log
        .read_lineage_context(source, 10_000, 8 * 1024 * 1024)
        .await?;
    let prompt = model_attempt::prompt(
        inner,
        input,
        &context,
        ModelPurpose::Main,
        cancellation,
        match &input.work {
            crate::RunWork::Handoff { pause, .. } => pause.execution.replay_base,
            _ => Some(base.high_water),
        },
        &input.invocation.invocation_id,
        false,
    )
    .await?;
    let tools = maka_tools::RunTools::new(
        inner.log.clone(),
        input.invocation.clone(),
        catalog.clone(),
        input.configuration.tool_mode,
        inner.cells.clone(),
    )
    .with_model(input.provider.tool_context());
    if let crate::RunWork::Handoff { pause, .. } = &input.work {
        tools.restore(&pause.execution.tools)?;
    }
    let definitions = if matches!(input.work, crate::RunWork::Handoff { .. }) {
        tools.handoff_definitions()
    } else {
        tools
            .capture(&input.configuration.cwd, cancellation.clone())
            .await?
            .definitions()
    };
    // Handoff restores the base catalog's checkpoint; dynamic plugins must not
    // change that digest. Ordinary resume validates the full current inventory,
    // including lazy plugin tools not yet advertised in this continuation.
    let mut available: std::collections::HashSet<_> =
        if matches!(input.work, crate::RunWork::Handoff { .. }) {
            catalog.names()
        } else {
            catalog
                .resolve_plugins()
                .map_err(|error| invalid(&error.to_string()))?
                .names()
        }
        .into_iter()
        .collect();
    available.extend(definitions.iter().map(|definition| definition.name.clone()));
    // A handoff replays settled facts, including rejected calls to unavailable
    // tools. It never executes them again; the live catalog is checked above.
    for message in prompt
        .iter()
        .filter(|_| !matches!(input.work, crate::RunWork::Handoff { .. }))
    {
        if let Message::Assistant { content, .. } = message {
            for part in content {
                if let AssistantPart::ToolCall {
                    tool_name,
                    provider_executed,
                    ..
                } = part
                    && *provider_executed != Some(true)
                    && !available.contains(tool_name)
                {
                    return Err(invalid("continuation requires an unavailable tool"));
                }
            }
        }
    }
    let replay = replay(input, prompt, definitions, cancellation)?;
    if let crate::RunWork::Handoff { pause, .. } = &input.work
        && replay != pause.execution.replay
    {
        return Err(invalid("handoff admission replay changed after sealing"));
    }
    Ok((base, replay))
}

/// Shared by reversible handoff preparation and independently verified admission.
pub(super) fn replay(
    input: &RunInput,
    prompt: Vec<Message>,
    definitions: Vec<maka_model::ToolDefinition>,
    cancellation: &CancellationToken,
) -> Result<ReplayEvidence, RunError> {
    if !matches!(
        prompt.iter().find(|m| !matches!(m, Message::System { .. })),
        Some(Message::User { .. })
    ) || !matches!(
        prompt.last(),
        Some(Message::User { .. } | Message::Tool { .. })
    ) && !matches!(prompt.last(), Some(Message::Assistant { content, .. }) if matches!(content.last(), Some(AssistantPart::ToolResult { .. })))
    {
        return Err(invalid(
            "continuation requires stable user/tool replay boundaries",
        ));
    }
    let request =
        model_attempt::prepare_request(input, prompt, definitions, input.main_output_limit)?;
    if cancellation.is_cancelled() {
        return Err(RunError::Cancelled);
    }
    Ok(ReplayEvidence {
        version: REPLAY_VERSION,
        digest: request.input_digest,
        route_identity: request.route_identity,
    })
}

fn invalid(reason: &str) -> RunError {
    RunError::ReconciliationRequired(reason.into())
}
