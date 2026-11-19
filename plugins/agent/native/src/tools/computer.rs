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
use maka_agent_facts::language::Language;
use maka_agent_facts::tool_output::ToolContent;
use maka_code_runtime::CellOutput;
use maka_plugin_core::operation::OperationResult;
use maka_workspace_api::computer::ResultValue;

pub(super) fn title(method: &str, input: &Value) -> maka_agent_facts::display::Text {
    use maka_agent_facts::display::Text;
    if method == "reset" {
        return Text::localized(
            "Reset computer session",
            "重置电脑操作环境",
            "重設電腦操作環境",
        );
    }
    if let Some(title) = input["title"].as_str().and_then(Text::single_line) {
        return title;
    }
    Text::localized("Use computer", "操作电脑", "操作電腦")
}

pub(super) async fn project(
    access: &Arc<RunAccess>,
    reply: OperationReply,
    language: Language,
) -> Result<ToolSuccess, ToolError> {
    let projected = mutation_result(reply.clone(), language)?;
    let Receipt::Recorded {
        outcome:
            OperationOutcome::Returned {
                result: OperationResult::Success { value },
            },
        ..
    } = &reply.receipt
    else {
        return Ok(projected);
    };
    let result = serde_json::from_value(value.clone());
    let failed = matches!(result, Ok(ResultValue::Failed { .. }));
    let raw = ToolOutput::Operation(Box::new(reply));
    match parts(access, result, language).await {
        Ok(parts) => Ok(ToolSuccess::content(raw, parts).reporting_error(failed)),
        // A display failure cannot erase a completed native effect or its original receipt.
        Err(_) => Ok(ToolSuccess::projected(
            raw,
            maka_agent_facts::tool_output::DurableToolProjection::Failure,
        )),
    }
}
async fn parts(
    access: &Arc<RunAccess>,
    result: Result<ResultValue, serde_json::Error>,
    language: Language,
) -> Result<Vec<ToolContent>, ToolError> {
    let result = result.map_err(|_| ToolError::Failed("Computer result invalid".into()))?;
    let state_label = match language {
        Language::En => "REPL state",
        Language::ZhCn => "REPL 状态",
        Language::ZhTw => "REPL 狀態",
    };
    let parts = match result {
        ResultValue::Failed { message, state } => vec![ToolContent::Text(format!(
            "{message}\n{state_label}: {}",
            serde_json::to_string(&state).expect("state")
        ))],
        ResultValue::Completed { artifact, state } => {
            let bytes = access.computer_output(artifact).await?.ok_or_else(|| {
                ToolError::Failed(
                    "Computer output does not belong to the original execution".into(),
                )
            })?;
            let outputs: Vec<CellOutput> = serde_json::from_slice(&bytes)
                .map_err(|_| ToolError::Failed("Computer output invalid".into()))?;
            if outputs
                .iter()
                .any(|output| matches!(output, CellOutput::Image { .. }))
            {
                return Err(ToolError::Failed(
                    "Computer output contains an unowned image reference".into(),
                ));
            }
            let mut parts: Vec<_> = outputs
                .into_iter()
                .map(|output| match output {
                    CellOutput::Text { text } => ToolContent::Text(text),
                    CellOutput::Media { content, detail } => ToolContent::Media { content, detail },
                    CellOutput::Image { .. } => unreachable!("stored images rejected below"),
                })
                .collect();
            parts.push(ToolContent::Text(format!(
                "{state_label}: {}",
                serde_json::to_string(&state).expect("state")
            )));
            parts
        }
    };
    Ok(parts)
}
