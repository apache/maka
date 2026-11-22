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

//! Dispatch only through the actual State read capability selected by SourceTree.
use super::*;
use maka_agent_facts::message::RootSourceMessage;
pub(super) use maka_agent_state::session_history::source_tree::HistoryDataSource as DataSource;
use maka_agent_state::session_history::tool_result_source::ToolResultReader;
use tokio_util::sync::CancellationToken;

pub(super) async fn content<T: DeserializeOwned + Send + 'static>(
    source: &DataSource,
    run: RunId,
    reference: &ContentRef,
) -> Result<T, String> {
    source
        .with_content(run, reference, |reader| {
            serde_json::from_reader(std::io::BufReader::new(reader))
                .map_err(maka_event_log::StoreError::Json)
        })
        .await
        .map_err(|error| error.to_string())
}
pub(super) fn tool_reader(
    source: &DataSource,
    run: RunId,
    stop: &CancellationToken,
) -> ToolResultReader {
    match source {
        DataSource::Live { history, cut } => ToolResultReader::live(history, cut, run, stop),
        DataSource::Snapshot(snapshot) => ToolResultReader::snapshot(snapshot, run, stop),
    }
}
pub(super) async fn input(
    source: &DataSource,
    sequence: u64,
    position: u64,
) -> Result<Option<RootSourceMessage>, String> {
    let page = source
        .sources(sequence, position.checked_sub(1), 1)
        .await
        .map_err(|error| error.to_string())?;
    let Some(input) = page
        .sources
        .into_iter()
        .find(|input| input.position == position)
    else {
        return Ok(None);
    };
    source
        .with_source(sequence, position, &input.source, |reader| {
            serde_json::from_reader(std::io::BufReader::new(reader))
                .map_err(maka_event_log::StoreError::Json)
        })
        .await
        .map(Some)
        .map_err(|error| error.to_string())
}
