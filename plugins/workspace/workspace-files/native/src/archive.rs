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
use maka_agent_facts::{
    cells::CellEvent,
    durable::*,
    external_effects::ExternalEffectEvent,
    model::prompt_source::source::{self as pull, ChargedBuffer, SourceBudget},
    read::{ReadPage, ReadRequest},
};
use maka_agent_state::session_history::{
    HistoryCut, HistoryItem, SessionHistory,
    tool_result_source::{ToolResultReader, ToolResultSource},
};
use std::io;

pub(super) struct Budget(pub(super) Arc<tokio::sync::Semaphore>);
impl SourceBudget for Budget {
    fn allocate(&self, minimum: usize) -> pull::Allocate<'_> {
        Box::pin(async move {
            let count = u32::try_from(minimum).map_err(io::Error::other)?;
            let permit = self
                .0
                .clone()
                .try_acquire_many_owned(count)
                .map_err(|_| io::Error::other("history source work budget exhausted"))?;
            Ok(ChargedBuffer::new(vec![0; minimum], permit))
        })
    }
}

pub(super) async fn read(
    history: &SessionHistory,
    cut: &HistoryCut,
    item: &HistoryItem,
    tool_name: &str,
    request: &ReadRequest,
    stop: &CancellationToken,
) -> Result<ReadPage, ToolError> {
    let run = item.recorded.run;
    let reference = match &item.recorded.fact {
        Fact::ToolResultAccepted { result, .. } => result,
        Fact::ExternalEffect {
            event: ExternalEffectEvent::Returned { output, .. },
        } => output,
        Fact::LocalToolReturned { result, .. }
        | Fact::HostToolResultRecorded { result, .. }
        | Fact::Cell {
            event:
                CellEvent::ChildResultRecorded { result, .. }
                | CellEvent::LocalChildReturned { result, .. },
        } => result,
        _ => {
            return Err(failed(
                "Archive locator does not identify an original tool result",
            ));
        }
    };
    let budget: Arc<dyn SourceBudget> = Arc::new(Budget(Arc::new(tokio::sync::Semaphore::new(
        2 * 1024 * 1024,
    ))));
    let selected = ToolResultReader::live(history, cut, run, stop)
        .result(&item.recorded.fact, reference, budget.clone())
        .await
        .map_err(failed)?;
    let page = match selected {
        ToolResultSource::Returned(_) | ToolResultSource::External { .. } => {
            let projection = selected
                .fields(budget.clone())
                .await
                .map_err(failed)?
                .expect("returned result")
                .projection(budget.clone())
                .await
                .map_err(failed)?
                .ok_or_else(|| failed("Original archived tool projection is missing"))?
                .into_json(budget.clone())
                .await
                .map_err(failed)?;
            maka_agent_facts::read::projection_page(
                projection,
                tool_name,
                request,
                read_page_budget(),
                budget,
                stop,
            )
            .await
        }
        ToolResultSource::Direct(source) => {
            maka_agent_facts::read::json_page(
                source,
                tool_name,
                request,
                read_page_budget(),
                budget,
                stop,
            )
            .await
        }
    };
    if page.is_err() {
        cancelled(stop)?;
    }
    page.map_err(failed)
}
