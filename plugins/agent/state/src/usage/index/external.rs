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
    external_effects::{ExternalEffectEvent, ExternalReturn},
    tool_output::ToolOutput,
};
fn id(run: RunId, key: &maka_agent_facts::external_effects::ExternalEffectKey) -> String {
    format!("external:{run}:{}:{}", key.task, key.operation)
}
pub(super) fn index(
    c: &Connection,
    spec: &RunSpec,
    record: &RecordedFact,
    sequence: u64,
    event: &ExternalEffectEvent,
) -> Result<(), StoreError> {
    let key = event.key();
    let request = id(record.run, &key);
    match event {
        ExternalEffectEvent::Admitted { .. } | ExternalEffectEvent::Rejected { .. } => {
            let name:String=c.query_row("SELECT json_extract(CAST(b.payload AS TEXT),'$.name') FROM agent_external_effects e JOIN contents b ON b.content_sha256=json_extract(e.body,'$.descriptor.digest') WHERE e.run=? AND e.operation=? AND e.task=?",params![record.run.to_string(),key.operation.to_string(),key.task.to_string()],|r|r.get(0))?;
            insert_tool(
                c,
                &request,
                Some(&spec.owner),
                UsagePosition {
                    source: "fact",
                    session: &spec.session_id,
                    run: Some(record.run),
                    sequence,
                    at: record.at,
                },
                &name,
                None,
                &ToolUsageSource::External {
                    task: key.task,
                    owner: spec.owner.clone(),
                    operation: key.operation,
                },
            )?;
            if let ExternalEffectEvent::Rejected { rejection_kind, .. } = event {
                settle(
                    c,
                    &request,
                    sequence,
                    record.at,
                    ToolSettlement::Rejected,
                    true,
                    Some(*rejection_kind),
                )?;
            }
        }
        ExternalEffectEvent::Observed { observation, .. } => {
            observe_receipt(c, &request, sequence, record.at, observation)?
        }
        ExternalEffectEvent::Returned { output, .. } => {
            let value: ExternalReturn = decode(c, output)?;
            match value {
                ExternalReturn::Failure { settlement, .. } => {
                    settle(c, &request, sequence, record.at, settlement, true, None)?
                }
                ExternalReturn::Output {
                    output: ToolOutput::Operation(reply),
                    is_error,
                    ..
                } => observe_returned_receipt(c, &request, sequence, record.at, &reply, is_error)?,
                ExternalReturn::Output { is_error, .. } => settle(
                    c,
                    &request,
                    sequence,
                    record.at,
                    ToolSettlement::Returned,
                    is_error,
                    None,
                )?,
            }
        }
        ExternalEffectEvent::CleanupObserved { cleanup, .. } => {
            observe_cleanup(c, &request, sequence, Some(cleanup))?
        }
        _ => {}
    }
    Ok(())
}
