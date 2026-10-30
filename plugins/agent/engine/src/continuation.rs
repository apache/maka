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

use crate::{RunContext, RunError, RunInput, model_attempt};
use maka_agent_facts::continuation::ContinuationClaim;
use maka_agent_facts::continuation::REPLAY_VERSION;
use maka_agent_facts::continuation::ReplayEvidence;
use maka_agent_facts::continuation::RunBoundary;
use maka_agent_facts::continuation::SessionBase;
use maka_agent_facts::event::Fact;
use maka_agent_facts::input::InvocationInput;
use maka_agent_facts::model::prompt_source::source::MessageRole;
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, sync::Arc};
use tokio_util::sync::CancellationToken;

pub(super) struct PreparedClaim {
    pub claim: ContinuationClaim,
    /// Candidate evidence, not a second owner of live Session preferences.
    pub loaded_basis: BTreeSet<String>,
}

/// Derive admission evidence from the exact sealed source. The caller supplies
/// only its boundary, never a replay digest or a pre-authorized claim.
pub(super) async fn prepare(
    inner: &Arc<RunContext>,
    input: &RunInput,
    source: &RunBoundary,
    catalog: &maka_tools::ToolCatalog,
    cancellation: &CancellationToken,
) -> Result<PreparedClaim, RunError> {
    let loaded_basis = inner.shared.loaded_snapshot(&input.invocation.session_id)?;
    let (base, replay) =
        inspect(inner, input, source, catalog, cancellation, &loaded_basis).await?;
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
    Ok(PreparedClaim {
        claim,
        loaded_basis,
    })
}

pub(super) async fn inspect(
    inner: &Arc<RunContext>,
    input: &RunInput,
    source: &RunBoundary,
    catalog: &maka_tools::ToolCatalog,
    cancellation: &CancellationToken,
    loaded_basis: &BTreeSet<String>,
) -> Result<(SessionBase, ReplayEvidence), RunError> {
    if source.invocation.session_id != input.invocation.session_id {
        return Err(invalid("continuation belongs to another Session"));
    }
    let prefix = inner
        .log
        .run_source(
            &source.invocation.session_id,
            &source.invocation.run_id,
            None,
        )
        .await?
        .ok_or_else(|| invalid("continuation source is missing"))?;
    if prefix.boundary != *source
        || !matches!(&prefix.last.event.fact, Fact::InvocationEnded { .. })
    {
        return Err(invalid(
            "continuation source is not its exact sealed boundary",
        ));
    }
    let Fact::InvocationOpened {
        input: opening,
        configuration: Some(configuration),
    } = &prefix.opening.event.fact
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
                &prefix.last.event.fact,
                Fact::InvocationEnded {
                    outcome: maka_agent_facts::event::InvocationOutcome::HandoffPaused { pause: sealed }
                } if sealed == pause.as_ref()
            ))
    {
        return Err(invalid("handoff does not match its sealed source"));
    }
    let base = match opening {
        InvocationInput::Message { .. } => {
            let base = inner.log.source_before_run(&source.invocation).await?;
            SessionBase {
                high_water: base.high_water,
                digest: base.digest,
            }
        }
        InvocationInput::Continuation { claim, .. } | InvocationInput::Handoff { claim, .. } => {
            claim.base.clone()
        }
        _ => return Err(invalid("source is not a resumable model Run")),
    };
    let context = Arc::new(inner.log.read_lineage_view(source).await?);
    let prompt = model_attempt::prompt(
        inner,
        input,
        &context,
        cancellation,
        match &input.work {
            crate::RunWork::Handoff { pause, .. } => pause.execution.replay_base,
            _ => Some(base.high_water),
        },
        &input.invocation.invocation_id,
        false,
        model_attempt::rendered_system(input),
        maka_agent_facts::context::ModelPurpose::Main,
    )
    .await?;
    let arena = prompt.arena().cloned();
    let result = async {
        let tools = maka_tools::RunTools::new(
            input.configuration.language,
            inner.log.clone(),
            input.invocation.clone(),
            catalog.clone(),
            input.configuration.tool_mode,
            inner
                .shared
                .cells
                .clone()
                .with_language(input.configuration.code_language),
            inner.shared.loaded(&input.invocation.session_id),
        )
        .with_model(input.provider.tool_context());
        let selected = if let crate::RunWork::Handoff { pause, .. } = &input.work {
            if pause.execution.tools.catalog_digest != catalog.digest()
                || pause
                    .execution
                    .tools
                    .loaded
                    .iter()
                    .any(|name| name.is_empty() || name.len() > 128)
            {
                return Err(RunError::InvalidInput(
                    "handoff tool catalog changed".into(),
                ));
            }
            &pause.execution.tools.loaded
        } else {
            loaded_basis
        };
        let definitions = tools.replay_selected(selected);
        // Resume validates names from the full explicit inventory, including tools
        // not yet advertised through lazy discovery.
        let mut available: std::collections::HashSet<_> = catalog.names().into_iter().collect();
        available.extend(definitions.iter().map(|definition| definition.name.clone()));
        // A handoff replays settled facts, including rejected calls to unavailable
        // tools. It never executes them again; the registered catalog is checked above.
        if !matches!(input.work, crate::RunWork::Handoff { .. }) {
            let available: std::collections::HashSet<[u8; 32]> = available
                .iter()
                .map(|name| Sha256::digest(name.as_bytes()).into())
                .collect();
            let recipes = prompt
                .recipes()
                .ok_or_else(|| invalid("continuation lacks a frozen logical directory"))?;
            let mut cursor = recipes.open_metadata(0);
            while let Some(message) = cursor.next().await.map_err(RunError::Preparation)? {
                if cancellation.is_cancelled() {
                    return Err(RunError::Cancelled);
                }
                let mut names = message.local_tool_names.open(0);
                while let Some(name) = names.next().await.map_err(RunError::Preparation)? {
                    if !available.contains(&name.identity) {
                        return Err(invalid("continuation requires an unavailable tool"));
                    }
                }
            }
        }
        let replay = replay(input, prompt, definitions, cancellation).await?;
        if let crate::RunWork::Handoff { pause, .. } = &input.work
            && replay != pause.execution.replay
        {
            return Err(invalid("handoff admission replay changed after sealing"));
        }
        Ok((base, replay))
    }
    .await;
    if let Some(arena) = arena
        && let Err(error) = arena.close().await
    {
        return Err(crate::cleanup::preparation_failed(error));
    }
    result
}

/// Shared by reversible handoff preparation and independently verified admission.
pub(super) async fn replay<W>(
    input: &RunInput<W>,
    mut prompt: crate::prepared_prompt::PreparedPrompt,
    definitions: Vec<Arc<maka_model::ToolDefinition>>,
    cancellation: &CancellationToken,
) -> Result<ReplayEvidence, RunError> {
    let arena = prompt.arena().cloned();
    let result = async {
        let recipes = prompt
            .recipes()
            .ok_or_else(|| invalid("continuation lacks a frozen logical directory"))?;
        let mut cursor = recipes.open_metadata(0);
        let mut first_is_user = None;
        let mut last_is_stable = false;
        while let Some(message) = cursor.next().await.map_err(RunError::Preparation)? {
            if cancellation.is_cancelled() {
                return Err(RunError::Cancelled);
            }
            if message.role != MessageRole::System && first_is_user.is_none() {
                first_is_user = Some(message.role == MessageRole::User);
            }
            last_is_stable = matches!(message.role, MessageRole::User | MessageRole::Tool)
                || (message.role == MessageRole::Assistant && message.last_is_tool_result);
        }
        if first_is_user != Some(true) || !last_is_stable {
            return Err(invalid(
                "continuation requires stable user/tool replay boundaries",
            ));
        }
        prompt
            .compile_wire(
                input.configuration.language,
                &input.provider,
                &input.provider_options,
                &definitions,
                cancellation,
            )
            .await?;
        prompt
            .fit_image_request(
                input.configuration.language,
                &input.provider,
                &input.provider_options,
                &definitions,
                input.main_output_limit,
                cancellation,
            )
            .await?;
        let request = model_attempt::prepare_request(
            input,
            prompt,
            definitions,
            input.main_output_limit,
            maka_agent_facts::context::ModelPurpose::Main,
        )?;
        if cancellation.is_cancelled() {
            return Err(RunError::Cancelled);
        }
        Ok(ReplayEvidence {
            version: REPLAY_VERSION,
            digest: request.input_digest,
            route_identity: request.route_identity,
        })
    }
    .await;
    if let Some(arena) = arena
        && let Err(error) = arena.close().await
    {
        return Err(crate::cleanup::preparation_failed(error));
    }
    result
}

fn invalid(reason: &str) -> RunError {
    RunError::ReconciliationRequired(reason.into())
}
