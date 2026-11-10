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

use super::*;
use maka_agent_facts::{archive::ArchivedPlaceholder, model::prompt_source::source::json};
use maka_agent_state::session_history::tool_result_source::ToolResultSource;
use maka_model::prompt::ToolOutput;

impl DriverModel {
    pub(super) async fn archived_tool_result(
        &self,
        reader: &HistorySource<'_>,
        view: &RunView,
        id: FactId,
        fact: &Fact,
        call: &maka_agent_facts::model::ModelToolCall,
    ) -> Result<Option<ToolOutput>, RunError> {
        let (tool, reference) = match fact {
            Fact::ToolResultAccepted { tool, result, .. }
            | Fact::HostToolResultRecorded { tool, result, .. }
            | Fact::LocalToolReturned { tool, result, .. } => (tool, result),
            _ => {
                return Err(RunError::InvalidInput(
                    "archive source is not an original tool result".into(),
                ));
            }
        };
        let work = self.resources.acquire_work().await?;
        let budget = work.budget();
        let failed = |error: std::io::Error| {
            if error.kind() == std::io::ErrorKind::Interrupted && self.cancellation.is_cancelled() {
                RunError::Cancelled
            } else {
                RunError::Preparation(error)
            }
        };
        let selected = reader
            .tool_result_reader(view.run, &self.cancellation)
            .result(fact, reference, budget.clone())
            .await
            .map_err(&failed)?;
        let ToolResultSource::Returned { body, .. } = selected else {
            return Ok(None);
        };
        let mut fields = json::fields(&body, &["projection", "is_error"], budget.clone())
            .await
            .map_err(&failed)?
            .into_iter();
        let projection = fields.next().flatten().ok_or_else(|| {
            RunError::InvalidInput("original ToolReturn has no projection".into())
        })?;
        let is_error = fields.next().flatten().ok_or_else(|| {
            RunError::InvalidInput("original ToolReturn has no error category".into())
        })?;
        let is_error = json::bool_value(&is_error.source, budget.clone())
            .await
            .map_err(&failed)?;
        let archived = ArchivedPlaceholder::prepare_source(
            id.to_string(),
            tool.call.clone(),
            call.name.clone(),
            projection.source,
            budget,
            &self.cancellation,
        )
        .await
        .map_err(&failed)?;
        let Some(archived) = archived else {
            return Ok(None);
        };
        let maka_agent_facts::tool_output::DurableToolProjection::Json { value } = archived
            .to_canonical_projection()
            .map_err(|reason| RunError::InvalidInput(reason.into()))?
        else {
            unreachable!("archive codec returns a canonical JSON placeholder")
        };
        Ok(Some(if is_error {
            ToolOutput::ErrorJson(value)
        } else {
            ToolOutput::Json(value)
        }))
    }

    pub(super) async fn archived_imported_tool_result(
        &self,
        snapshot: &maka_agent_state::session_history::snapshot::Snapshot,
        path: &[RunId],
        message_ordinal: u64,
        part_ordinal: u64,
        reference: &ContentRef,
    ) -> Result<Option<(String, String, ToolOutput)>, RunError> {
        use maka_agent_state::session_history::tool_result_source::ToolResultReader;
        let result = async {
            let work = self.resources.acquire_work().await?;
            let budget = work.budget();
            let original =
                ToolResultReader::imported(snapshot, message_ordinal, &self.cancellation)
                    .source(reference)
                    .await?;
            let mut fields = json::fields(
                &original,
                &["kind", "call_id", "name", "result"],
                budget.clone(),
            )
            .await?
            .into_iter();
            let kind = fields
                .next()
                .flatten()
                .ok_or_else(|| RunError::InvalidInput("imported part has no kind".into()))?;
            if !json::text_eq(&kind.text()?, "tool_return", budget.clone()).await? {
                return Ok(None);
            }
            let call_id = fields.next().flatten().ok_or_else(|| {
                RunError::InvalidInput("imported tool return has no call identity".into())
            })?;
            let name = fields.next().flatten().ok_or_else(|| {
                RunError::InvalidInput("imported tool return has no tool name".into())
            })?;
            let returned = fields.next().flatten().ok_or_else(|| {
                RunError::InvalidInput("imported tool return has no result".into())
            })?;
            let ToolResultSource::Returned { body, .. } =
                ToolResultReader::returned(returned.source, budget.clone()).await?
            else {
                unreachable!("canonical ToolReturn decoder returns its original body")
            };
            let mut body = json::fields(&body, &["projection", "is_error"], budget.clone())
                .await?
                .into_iter();
            let projection = body.next().flatten().ok_or_else(|| {
                RunError::InvalidInput("imported ToolReturn has no projection".into())
            })?;
            let is_error = body.next().flatten().ok_or_else(|| {
                RunError::InvalidInput("imported ToolReturn has no error category".into())
            })?;
            let is_error = json::bool_value(&is_error.source, budget.clone()).await?;
            let call_id = imported_identifier(call_id.source, budget.clone()).await?;
            let name = imported_identifier(name.source, budget.clone()).await?;
            let address = maka_agent_facts::history::HistoryRowAddress::Imported {
                path: path.to_vec(),
                snapshot: snapshot.id(),
                message_ordinal,
                part_ordinal,
            };
            let Some(archived) = maka_agent_facts::archive::prepare_imported_source(
                &address,
                call_id.clone(),
                name.clone(),
                projection.source,
                budget,
                &self.cancellation,
            )
            .await?
            else {
                return Ok(None);
            };
            let maka_agent_facts::tool_output::DurableToolProjection::Json { value } = archived
            else {
                unreachable!("imported archive codec returns a JSON placeholder")
            };
            Ok(Some((
                call_id,
                name,
                if is_error {
                    ToolOutput::ErrorJson(value)
                } else {
                    ToolOutput::Json(value)
                },
            )))
        }
        .await;
        result.map_err(|error| match error {
            RunError::Preparation(error)
                if error.kind() == std::io::ErrorKind::Interrupted
                    && self.cancellation.is_cancelled() =>
            {
                RunError::Cancelled
            }
            error => error,
        })
    }
}

async fn imported_identifier(
    source: maka_agent_facts::model::prompt_source::source::JsonSource,
    budget: Arc<dyn maka_agent_facts::model::prompt_source::source::SourceBudget>,
) -> Result<String, RunError> {
    let length = source
        .bytes()
        .len()
        .and_then(|length| usize::try_from(length).ok())
        .ok_or_else(|| {
            RunError::InvalidInput("imported identity has no bounded original span".into())
        })?;
    let mut target = budget.allocate(length).await?;
    let mut cursor = source.bytes().open(budget.clone());
    let mut buffer = budget.allocate(32 * 1024).await?;
    let mut offset = 0usize;
    loop {
        let read = cursor.read_chunk(buffer).await?;
        let end = offset
            .checked_add(read.bytes_read)
            .filter(|end| *end <= length)
            .ok_or_else(|| {
                RunError::InvalidInput("imported identity source length changed".into())
            })?;
        target.as_mut()[offset..end].copy_from_slice(&read.buffer.as_ref()[..read.bytes_read]);
        offset = end;
        buffer = read.buffer;
        if read.eof {
            break;
        }
        if read.bytes_read == 0 {
            return Err(RunError::InvalidInput(
                "imported identity source made no progress".into(),
            ));
        }
    }
    if offset != length {
        return Err(RunError::InvalidInput(
            "imported identity source was truncated".into(),
        ));
    }
    serde_json::from_slice(&target.as_ref()[..length]).map_err(RunError::Json)
}
