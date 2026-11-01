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
use maka_agent_facts::{
    artifact::{ArtifactKind, ArtifactSource},
    event::Invocation,
    tool_output::ToolContent,
};
use maka_code_runtime::CellOutput;
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
    store: &SessionStore,
    invocation: &Invocation,
    reply: OperationReply,
    language: Language,
) -> Result<ToolSuccess, ToolError> {
    // Validate original physical completion before interpreting business output.
    mutation_result(reply.clone(), language)?;
    let Receipt::Recorded {
        outcome: OperationOutcome::Returned { value },
        ..
    } = &reply.receipt
    else {
        unreachable!("validated receipt")
    };
    let result = serde_json::from_value(value.clone());
    let raw = ToolOutput::Operation(Box::new(reply));
    match parts(store, invocation, result, language).await {
        Ok(parts) => Ok(ToolSuccess::content(raw, parts)),
        // A display failure cannot erase a completed native effect or its original receipt.
        Err(_) => Ok(ToolSuccess::projected(
            raw,
            maka_agent_facts::tool_output::DurableToolProjection::Failure,
        )),
    }
}
async fn parts(
    store: &SessionStore,
    invocation: &Invocation,
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
            let bytes = store
                .with_artifact(
                    maka_event_log::artifacts::ArtifactReadScope::Execution(invocation),
                    &artifact,
                    |record, reader| {
                        if record.source != ArtifactSource::SessionEffect
                            || record.kind != ArtifactKind::File
                            || record.mime_type.as_deref() != Some("application/json")
                        {
                            return Err(ToolError::Failed(
                                "Computer output does not belong to the original invocation".into(),
                            ));
                        }
                        let mut bytes = Vec::with_capacity(record.size_bytes as usize);
                        reader
                            .read_to_end(&mut bytes)
                            .map_err(|_| ToolError::Failed("Computer output unavailable".into()))?;
                        if bytes.len() as u64 != record.size_bytes {
                            return Err(ToolError::Failed("Computer output unavailable".into()));
                        }
                        Ok(bytes)
                    },
                )
                .await
                .map_err(|error| ToolError::Persistence(error.to_string()))?
                .ok_or_else(|| {
                    ToolError::Failed(
                        "Computer output does not belong to the original invocation".into(),
                    )
                })??;
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
