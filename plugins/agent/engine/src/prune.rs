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

//! Bounded projection-only selection; persistence precedes every replacement.
use crate::{RunContext, RunError, RunSettings, runner::append};
use maka_agent_facts::archive::ArchivedPlaceholder;
use maka_agent_facts::event::Fact;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

pub(super) async fn run(
    inner: &Arc<RunContext>,
    input: &RunSettings,
    cancellation: &CancellationToken,
) -> Result<(), RunError> {
    let mut cursor = None;
    loop {
        if cancellation.is_cancelled() {
            return Err(RunError::Cancelled);
        }
        let batch = tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Err(RunError::Cancelled),
            batch = inner.log.prepare_prune_candidates(
                &input.invocation.session_id,
                Some(&input.invocation.invocation_id),
                128,
                4 * 1024 * 1024,
                cursor.as_ref(),
            ) => batch?,
        };
        for candidate in batch.candidates {
            let Some(placeholder) = ArchivedPlaceholder::prepare(
                candidate.event_id,
                candidate.tool_call_id,
                candidate.tool_name,
                &candidate.projection,
            )
            .map_err(|error| RunError::Internal(error.into()))?
            else {
                continue;
            };
            if cancellation.is_cancelled() {
                return Err(RunError::Cancelled);
            }
            append(
                inner,
                &input.invocation,
                Fact::ToolResultArchived { placeholder },
            )
            .await?;
        }
        cursor = batch.next;
        if cursor.is_none() {
            return Ok(());
        }
        // The fixed upper fence excludes new results; advance even over small
        // or unarchivable results so they cannot starve a later large target.
    }
}
