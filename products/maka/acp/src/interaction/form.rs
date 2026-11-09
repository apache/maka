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

use super::{Callback, Capabilities, Form, FormAnswer, schema};
use maka_agent_facts::capability::FormResult;
use maka_agent_facts::capability::FormValue;
use maka_agent_facts::interaction::InteractionAnswer;
use maka_agent_facts::interaction::InteractionRecord;
use maka_agent_facts::interaction::InteractionRequest;
use serde_json::Value;

pub(super) fn request(
    snapshot: &InteractionRecord,
    capabilities: &Capabilities,
) -> Result<Callback, crate::Error> {
    match &snapshot.request {
        InteractionRequest::Form {
            tool_use_id,
            message,
            fields,
            ..
        } => elicitation(
            snapshot,
            capabilities,
            tool_use_id,
            message,
            schema::form(fields)?,
        ),
        InteractionRequest::Question {
            tool_use_id,
            questions,
        } => elicitation(
            snapshot,
            capabilities,
            tool_use_id,
            "Please answer the following questions",
            schema::questions(questions),
        ),
        _ => Err("Expected a form interaction".into()),
    }
}
fn elicitation(
    snapshot: &InteractionRecord,
    capabilities: &Capabilities,
    tool_use_id: &str,
    message: &str,
    schema: Value,
) -> Result<Callback, crate::Error> {
    if !capabilities.form {
        return Err("ACP client does not support form elicitation".into());
    }
    Ok(Callback::Elicitation(Form {
        session: snapshot.execution.session_id.clone(),
        tool_id: tool_use_id.into(),
        message: message.into(),
        schema,
    }))
}

pub(super) fn answer(
    snapshot: &InteractionRecord,
    response: FormAnswer,
) -> Result<InteractionAnswer, crate::Error> {
    Ok(match &snapshot.request {
        InteractionRequest::Form { .. } => {
            let result = match response {
                FormAnswer::Accept(content) => FormResult::Accept {
                    values: content
                        .into_iter()
                        .map(|(name, value)| Ok((name, form_value(value)?)))
                        .collect::<Result<_, crate::Error>>()?,
                },
                FormAnswer::Decline => FormResult::Decline,
                FormAnswer::Cancel => FormResult::Cancel,
            };
            InteractionAnswer::Form { result }
        }
        InteractionRequest::Question { questions, .. } => {
            let answers = match response {
                FormAnswer::Accept(content) => {
                    let mut content = content;
                    let mut answers = Vec::with_capacity(questions.len());
                    for index in 0..questions.len() {
                        answers.push(match content.remove(&format!("question_{index}")) {
                            Some(Value::String(value)) => Some(value),
                            None => None,
                            _ => return Err("Question answer must be a string".into()),
                        });
                    }
                    if !content.is_empty() {
                        return Err("Unexpected question answer field".into());
                    }
                    answers
                }
                FormAnswer::Decline | FormAnswer::Cancel => {
                    vec![None; questions.len()]
                }
            };
            InteractionAnswer::Question { answers }
        }
        _ => return Err("Expected a form interaction".into()),
    })
}
fn form_value(value: Value) -> Result<FormValue, crate::Error> {
    Ok(match value {
        Value::String(value) => FormValue::String(value),
        Value::Bool(value) => FormValue::Boolean(value),
        Value::Number(value) => {
            if value
                .as_i64()
                .is_some_and(|n| n.unsigned_abs() > 9_007_199_254_740_991)
                || value.as_u64().is_some_and(|n| n > 9_007_199_254_740_991)
            {
                return Err("Form integer exceeds exact numeric range".into());
            }
            FormValue::Number(value.as_f64().ok_or("Form number is not representable")?)
        }
        Value::Array(values) => FormValue::Strings(
            values
                .into_iter()
                .map(|v| match v {
                    Value::String(s) => Ok(s),
                    _ => Err("Form array must contain strings".into()),
                })
                .collect::<Result<_, crate::Error>>()?,
        ),
        _ => return Err("Unsupported ACP form value".into()),
    })
}
