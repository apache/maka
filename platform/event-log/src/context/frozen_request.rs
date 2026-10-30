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

//! Reconstruct a request's original projection from its canonical locator.

use super::{ContextView, invalid, proof, read, selection::Selection};
use crate::{EventLog, StoreError};
use maka_agent_facts::{
    composition::RequestComposition,
    context::ModelPurpose,
    event::{Fact, Invocation, InvocationInput, RuntimeEvent, StoredEvent},
};
use sqlx::Connection;

/// Read evidence only; this value neither authorizes replay nor restores custody.
pub struct FrozenModelRequest {
    pub request: StoredEvent,
    pub opening: RuntimeEvent,
    pub composition: RequestComposition,
    pub composition_digest: String,
    pub view: ContextView,
}

impl EventLog {
    /// Read the exact Main projection named by an original request or interruption.
    /// The immutable opening owns lineage; callers cannot supply a selection or watermark.
    pub async fn read_frozen_model_request(
        &self,
        invocation: &Invocation,
        event_id: &str,
    ) -> Result<FrozenModelRequest, StoreError> {
        self.validate_root()?;
        crate::sessions::validate_id(&invocation.session_id)?;
        crate::sessions::validate_id(event_id)?;
        let invocation = invocation.clone();
        let event_id = event_id.to_owned();
        self.connection
            .read_interruptible(move |connection| {
                Box::pin(async move {
                    let mut tx = connection.begin().await?;
                    let frozen = read_in_transaction(&mut tx, &invocation, &event_id).await?;
                    tx.commit().await?;
                    Ok(frozen)
                })
            })
            .await
    }
}

/// Verify the original captured projection inside an activation ownership transaction.
pub(crate) async fn read_in_transaction(
    tx: &mut sqlx::SqliteConnection,
    invocation: &Invocation,
    event_id: &str,
) -> Result<FrozenModelRequest, StoreError> {
    let (sequence, mut request) = proof::by_id(&mut *tx, event_id).await?;
    if request.invocation != *invocation {
        return Err(invalid(
            "frozen request locator belongs to another invocation",
        ));
    }
    let sequence = if let Fact::ModelInterrupted { step_id, .. } = &request.fact {
        let (sequence, original) = proof::by_kind(
            &mut *tx,
            &invocation.invocation_id,
            "model_requested",
            Some(step_id),
        )
        .await?;
        request = original;
        sequence
    } else {
        sequence
    };
    let Fact::ModelRequested {
        purpose: ModelPurpose::Main,
        source_scope,
        source_high_water,
        source_capture,
        source_digest,
        effective_source_digest,
        checkpoint_event_id,
        route_identity,
        model_id,
        ..
    } = &request.fact
    else {
        return Err(invalid(
            "frozen request locator does not identify a Main request",
        ));
    };
    let captured = source_capture.publication_watermark;
    if request.invocation != *invocation || captured >= sequence || *source_high_water > captured {
        return Err(invalid("frozen request has an invalid source capture"));
    }
    let (_, opening) = proof::by_kind(
        &mut *tx,
        &invocation.invocation_id,
        "invocation_opened",
        None,
    )
    .await?;
    if opening.invocation != *invocation {
        return Err(invalid("frozen request opening identity changed"));
    }
    let selection = Selection::for_opening(&mut *tx, &opening).await?;
    if selection.scope != *source_scope {
        return Err(invalid("frozen request scope differs from opening"));
    }
    let mut view = read::selected_view_at(
        &mut *tx,
        &selection,
        *source_high_water,
        captured + 1,
        source_capture.prior_unknown,
        captured,
    )
    .await?;
    if view.source_evidence.digest != *source_digest
        || Some(&view.effective_source_digest) != effective_source_digest.as_ref()
        || view.baseline.as_ref().map(|baseline| &baseline.event_id) != checkpoint_event_id.as_ref()
    {
        return Err(invalid("frozen request source evidence changed"));
    }
    let Fact::InvocationOpened { input, .. } = &opening.fact else {
        return Err(invalid("frozen request is missing its opening"));
    };
    let base = match input {
        InvocationInput::Message { .. } => None,
        InvocationInput::Continuation { claim, .. } => Some(claim.base.high_water),
        InvocationInput::Handoff { pause, .. } => pause.execution.replay_base,
        _ => return Err(invalid("frozen Main request has an unsupported opening")),
    };
    view.selection.replay = base.map(|base| super::semantic::SemanticReplay {
        base,
        current: invocation.invocation_id.clone(),
        route: route_identity.clone(),
        model: model_id.clone(),
    });
    let (digest, bytes): (String, Vec<u8>) = sqlx::query_as(
        "SELECT b.digest,c.surface FROM model_request_compositions b
                 JOIN request_compositions c ON c.digest=b.digest WHERE b.event_id=?",
    )
    .bind(&request.id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| invalid("frozen request composition is unavailable"))?;
    let composition = serde_json::from_slice(&bytes)?;
    Ok(FrozenModelRequest {
        request: StoredEvent {
            sequence,
            event: request,
        },
        opening,
        composition,
        composition_digest: digest,
        view,
    })
}
