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

//! Compile the complete frozen logical directory with one provider policy.
use super::PreparedPrompt;
use crate::RunError;
use maka_agent_facts::{language::Language, model::prompt_source::PreparedWire};
use maka_model::{ProviderConfig, ToolDefinition, WireEncoding};
use tokio_util::sync::CancellationToken;
mod backed;

pub(super) fn backed_resident_bytes() -> usize {
    backed::resident_bytes()
}

pub(super) async fn compile(
    prompt: &mut PreparedPrompt,
    language: Language,
    provider: &ProviderConfig,
    options: &serde_json::Value,
    tools: &[ToolDefinition],
    cancellation: &CancellationToken,
) -> Result<(), RunError> {
    if cancellation.is_cancelled() {
        return Err(RunError::Cancelled);
    }
    prompt.freeze_overlays()?;
    let encoding = WireEncoding::new(language, provider, options, tools)?;
    if prompt.wire.as_ref().is_some_and(|wire| {
        wire.format == encoding.format() && wire.codec.as_ref() == encoding.codec()
    }) {
        return Ok(());
    }
    let resources = prompt
        .resources()
        .ok_or_else(|| RunError::Internal("request lacks Host preparation resources".into()))?
        .clone();
    let logical = prompt.model();
    let plan = tokio::select! {
        biased;
        _ = cancellation.cancelled() => return Err(RunError::Cancelled),
        plan = encoding.count_prompt(&logical, resources.clone()) => plan?,
    };
    let source_bytes = prompt
        .resident_bytes()
        .checked_add(prompt.overlay_bytes())
        .ok_or_else(|| {
            RunError::Preparation(std::io::Error::other(
                "complete request allocation peak overflow",
            ))
        })?;
    let capacity = prompt
        .active()
        .map_or(resources.policy().resident_bytes, |active| {
            active.capacity()
        });
    let use_backing = source_bytes
        .checked_add(plan.allocation())
        .is_none_or(|peak| peak > capacity);
    let wire_bytes = if use_backing {
        backed::resident_bytes()
    } else {
        plan.allocation()
    };
    let peak = source_bytes.checked_add(wire_bytes).ok_or_else(|| {
        RunError::Preparation(std::io::Error::other(
            "complete request allocation peak overflow",
        ))
    })?;
    prompt.promote(peak, cancellation).await?;
    let active = prompt.active().ok_or_else(|| {
        RunError::Internal("request lacks its complete active preparation".into())
    })?;
    let lease = active
        .directory(wire_bytes)
        .map_err(RunError::Preparation)?;
    let frozen = if use_backing {
        let arena = prompt.arena().cloned().ok_or_else(|| {
            RunError::Internal("oversized request lacks its original capture arena".into())
        })?;
        arena
            .promote_to_file()
            .await
            .map_err(RunError::Preparation)?;
        backed::build(
            &plan,
            logical
                .recipes()
                .expect("counted prompt retained recipes")
                .clone(),
            arena,
            lease,
            resources,
        )
        .await?
    } else {
        encoding
            .prepare_source_with_plan(plan, lease, resources)
            .await?
    };
    if cancellation.is_cancelled() {
        return Err(RunError::Cancelled);
    }
    prompt.wire = Some(PreparedWire {
        format: encoding.format(),
        codec: encoding.codec().to_owned().into(),
        identity: frozen.identity.into(),
        source: frozen.source,
    });
    Ok(())
}

#[cfg(test)]
mod production_tests;
