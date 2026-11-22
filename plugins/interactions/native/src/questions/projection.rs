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

use maka_agent_facts::interaction::InteractionRequest;
type Result<T> = std::result::Result<T, &'static str>;
fn decode_request(value: &Value) -> Result<InteractionRequest> {
    let request: InteractionRequest =
        serde_json::from_value(value.clone()).map_err(|_| "Invalid question request")?;
    request.validate()?;
    Ok(request)
}
use serde_json::{Value, json};

/// Decode before display projection, then validate the projected request again.
/// Canonical reads must use decode_request, preserving their stored display text.
pub(super) fn project_question_request(
    tool_use_id: &str,
    questions: &Value,
) -> Result<InteractionRequest> {
    let mut request = decode_request(&json!({
        "kind": "question", "toolUseId": tool_use_id, "questions": questions
    }))?;
    if let InteractionRequest::Question { questions, .. } = &mut request {
        for question in questions {
            question.question = project(&question.question);
            for option in &mut question.options {
                option.label = project(&option.label);
                if let Some(description) = &mut option.description {
                    *description = project(description);
                }
            }
        }
    }
    request.validate()?;
    Ok(request)
}

fn project(value: &str) -> String {
    let mut result = String::new();
    for c in value.chars() {
        if matches!(c as u32, 0..=31 | 127..=159 | 0x61c | 0x200e..=0x200f | 0x2028..=0x202e | 0x2066..=0x2069)
        {
            result.push_str(&format!("\\u{{{:X}}}", c as u32));
        } else {
            result.push(c);
        }
    }
    result
}

#[cfg(test)]
mod tests;
