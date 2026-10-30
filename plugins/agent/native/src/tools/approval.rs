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

use maka_agent_authority::interaction_wait::{wait, withdraw};
use maka_agent_facts::interaction::{
    Decision, InteractionOutcome, InteractionRecord, InteractionRequest,
};
use maka_agent_facts::native_approval::{DispatchReceipt, NativeApprovalPending};
use maka_agent_facts::tools::{EstablishedApproval, ToolCallContext, ToolError};
use maka_event_log::SessionStore;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

pub(crate) struct Selection<'a> {
    pub name: &'a str,
    pub method: &'a str,
    pub binding: &'a str,
    pub service: &'a str,
}

async fn establish_interaction(
    store: &SessionStore,
    context: &ToolCallContext,
    selection: Selection<'_>,
    input: &Value,
    cancellation: &CancellationToken,
) -> Result<
    (
        DispatchReceipt,
        InteractionRecord,
        Option<InteractionOutcome>,
    ),
    ToolError,
> {
    if cancellation.is_cancelled() {
        return Err(ToolError::Failed("service confirmation cancelled".into()));
    }
    #[cfg(test)]
    eprintln!(
        "native approval stage=dispatch_receipt_before operation={}",
        context.operation_id
    );
    let dispatch = store
        .tool_dispatch_receipt(context, selection.name, input)
        .await
        .map_err(|_| ToolError::Failed("service confirmation source unavailable".into()))?;
    #[cfg(test)]
    eprintln!(
        "native approval stage=dispatch_receipt_after operation={}",
        context.operation_id
    );
    let record = InteractionRecord {
        session_id: context.invocation.session_id.clone(),
        turn_id: context.invocation.turn_id.clone(),
        run_id: context.invocation.run_id.clone(),
        request_id: format!(
            "service_{}",
            hex::encode(Sha256::digest(
                serde_json::to_vec(&(
                    &context.invocation,
                    &context.operation_id,
                    selection.binding
                ))
                .expect("original service call identity")
            ))
        ),
        created_at: maka_agent_authority::now(),
        request: InteractionRequest::ServiceApproval {
            tool_use_id: context.tool_use_id(),
            tool_name: selection.name.into(),
            service: selection.service.into(),
            method: selection.method.into(),
            binding: selection.binding.into(),
            through: dispatch.sequence,
        },
        outcome: None,
    };
    #[cfg(test)]
    eprintln!(
        "native approval stage=establish_interaction_before operation={}",
        context.operation_id
    );
    let publication = store
        .establish_run_interaction(&context.invocation, &record)
        .await;
    #[cfg(test)]
    eprintln!(
        "native approval stage=establish_interaction_after operation={}",
        context.operation_id
    );
    let observed = match publication {
        Ok(committed) if committed.matches => None,
        result => {
            let message = match result {
                Ok(_) => "service confirmation identity conflict",
                Err(_) => "service confirmation publication unavailable",
            };
            match withdraw(store, &record).await {
                Ok(Some(outcome)) => Some(outcome),
                Ok(None) => return Err(ToolError::Failed(message.into())),
                Err(cleanup) => return Err(ToolError::CleanupUnconfirmed(cleanup.into())),
            }
        }
    };
    Ok((dispatch, record, observed))
}

async fn answer(
    store: &SessionStore,
    record: &InteractionRecord,
    observed: Option<InteractionOutcome>,
    cancellation: &CancellationToken,
) -> Result<InteractionOutcome, ToolError> {
    if let Some(outcome) = observed {
        return Ok(outcome);
    }
    match wait(store, record, cancellation).await {
        Ok(outcome) => Ok(outcome),
        Err(error) => match withdraw(store, record).await {
            Ok(Some(outcome)) => Ok(outcome),
            Ok(None) => Err(ToolError::Failed(error.into())),
            Err(cleanup) => Err(ToolError::CleanupUnconfirmed(cleanup.into())),
        },
    }
}

pub(crate) async fn establish(
    store: Arc<SessionStore>,
    context: ToolCallContext,
    selection: Selection<'_>,
    input: &Value,
    native: Value,
    cancellation: CancellationToken,
) -> Result<EstablishedApproval, ToolError> {
    let (dispatch, record, observed) =
        establish_interaction(&store, &context, selection, input, &cancellation).await?;
    let pending = NativeApprovalPending {
        invocation: context.invocation,
        operation_id: context.operation_id,
        dispatch,
        interaction_id: record.request_id.clone(),
        native,
    };
    Ok(EstablishedApproval {
        pending,
        answer: Box::pin(async move { answer(&store, &record, observed, &cancellation).await }),
    })
}

pub(crate) async fn confirm(
    store: &SessionStore,
    context: &ToolCallContext,
    selection: Selection<'_>,
    input: &Value,
    cancellation: &CancellationToken,
) -> Result<(), ToolError> {
    let (_, record, observed) =
        establish_interaction(store, context, selection, input, cancellation).await?;
    match answer(store, &record, observed, cancellation).await? {
        InteractionOutcome::ServiceApprovalDecision {
            decision: Decision::Allow,
            ..
        } if !cancellation.is_cancelled() => Ok(()),
        InteractionOutcome::ServiceApprovalDecision { .. } | InteractionOutcome::Closure { .. } => {
            Err(ToolError::Failed("service call was not approved".into()))
        }
        _ => Err(ToolError::Failed(
            "service confirmation outcome invalid".into(),
        )),
    }
}
