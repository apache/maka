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

//! Rehydrate one original Main request without crossing a new request boundary.

use crate::{RunContext, RunError, RunSettings, model_attempt, prepared_prompt::PreparedPrompt};
use maka_agent_facts::{
    composition::{SourceKind, SourceRevision},
    context::ModelPurpose,
    event::{Fact, InvocationInput},
};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

pub(super) struct FrozenRequest<'tools> {
    pub input: RunSettings,
    pub source: model_attempt::RequestSource,
    pub prompt: PreparedPrompt,
    pub surface: Arc<crate::request_composition::Surface>,
    pub tools: maka_tools::RequestTools<'tools>,
}

fn same_source(left: &SourceRevision, right: &SourceRevision) -> bool {
    left.kind == right.kind
        && left.name == right.name
        && left.package_id == right.package_id
        && left.entry_id == right.entry_id
        && left.revision == right.revision
}

/// Native must first validate the saved accepted binding basis against its current
/// registry, then issue `tools` with fresh execution custody and the current ceiling.
/// Reading historical evidence never authorizes another attempt or any old tool call.
pub(super) async fn rehydrate_frozen_request<'tools>(
    inner: &RunContext,
    original: &str,
    fresh: &RunSettings,
    tools: &'tools maka_tools::RunTools,
    cancellation: &CancellationToken,
) -> Result<FrozenRequest<'tools>, RunError> {
    let frozen = inner
        .log
        .read_frozen_model_request(&fresh.invocation, original)
        .await?;
    let Fact::ModelRequested {
        input_digest,
        route_identity,
        context,
        model_id,
        item_acceptance,
        source_capture,
        ..
    } = &frozen.request.event.fact
    else {
        unreachable!("store returns a checked Main request");
    };
    let Fact::InvocationOpened {
        configuration: Some(configuration),
        input: opening,
    } = &frozen.opening.fact
    else {
        return Err(RunError::ReconciliationRequired(
            "frozen request has no opening configuration".into(),
        ));
    };
    let mut input = fresh.clone();
    // Input projection uses its original settings. Permission authority remains in
    // the freshly issued execution scope and its request-bound capability capture.
    input.configuration = configuration.as_ref().clone();
    input.context = context.clone();
    input.provider_options = frozen.composition.provider_options.clone().ok_or_else(|| {
        RunError::ReconciliationRequired("frozen request has no provider options".into())
    })?;
    if input.provider.model != *model_id
        || model_attempt::route_identity(&input)? != *route_identity
    {
        return Err(RunError::ReconciliationRequired(
            "frozen request model route changed".into(),
        ));
    }
    let adapter = inner.shared.model.binding(&input.provider)?;
    if adapter.supports_item_acceptance() != *item_acceptance {
        return Err(RunError::ReconciliationRequired(
            "frozen request acceptance contract changed".into(),
        ));
    }
    let current = std::iter::once(adapter.source()).chain(input.model_revision.as_ref());
    let current: Vec<_> = current.collect();
    for source in frozen.composition.sources.iter().filter(|source| {
        matches!(
            source.kind,
            SourceKind::ModelAdapter | SourceKind::ModelProvider
        )
    }) {
        if !current
            .iter()
            .any(|candidate| same_source(source, candidate))
        {
            return Err(RunError::ReconciliationRequired(
                "frozen request model implementation changed".into(),
            ));
        }
    }
    let request_tools = tools
        .capture_frozen(
            &input.configuration.cwd,
            &frozen.composition,
            cancellation.clone(),
        )
        .await?;
    let surface = Arc::new(crate::request_composition::Surface::rehydrate(
        adapter,
        &frozen.composition,
        frozen.request.event.id.clone(),
        frozen.composition_digest,
    ));
    let base = match opening {
        InvocationInput::Continuation { claim, .. } => Some(claim.base.high_water),
        InvocationInput::Handoff { pause, .. } => pause.execution.replay_base,
        InvocationInput::Message { .. } => None,
        _ => unreachable!("store checked the opening input"),
    };
    let source = model_attempt::RequestSource::from(&frozen.view);
    let view = Arc::new(frozen.view);
    let mut prompt = model_attempt::prompt(
        inner,
        &input,
        &view,
        cancellation,
        base,
        &input.invocation.invocation_id,
        source_capture.prior_unknown,
        surface.system(),
        ModelPurpose::Main,
    )
    .await?;
    drop(view);
    let prepared = async {
        let definitions = request_tools.definitions();
        model_attempt::prepare_wire(
            &input,
            &mut prompt,
            &definitions,
            surface.max_output_tokens,
            cancellation,
        )
        .await?;
        let prepared = model_attempt::prepare_request(
            &input,
            prompt.clone(),
            definitions,
            surface.max_output_tokens,
            ModelPurpose::Main,
        )?;
        if prepared.input_digest != *input_digest || prepared.route_identity != *route_identity {
            return Err(RunError::ReconciliationRequired(
                "frozen request input identity changed".into(),
            ));
        }
        Ok(prepared)
    }
    .await;
    if let Err(error) = prepared {
        prompt
            .close()
            .await
            .map_err(crate::cleanup::preparation_failed)?;
        return Err(error);
    }
    Ok(FrozenRequest {
        input,
        source,
        prompt,
        surface,
        tools: request_tools,
    })
}

#[cfg(test)]
pub(crate) mod tests;
