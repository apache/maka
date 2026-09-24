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

use super::{Callback, acp, schema};
use maka_protocol::interaction::{InteractionAnswer, InteractionRequest, InteractionSnapshot};
use maka_runtime::capability::{FormResult, FormValue};

pub(super) fn request(
    snapshot: &InteractionSnapshot,
    capabilities: &acp::ClientCapabilities,
) -> Result<Callback, crate::Error> {
    match snapshot.request() {
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
    snapshot: &InteractionSnapshot,
    capabilities: &acp::ClientCapabilities,
    tool_use_id: &str,
    message: &str,
    schema: acp::ElicitationSchema,
) -> Result<Callback, crate::Error> {
    if !capabilities
        .elicitation
        .as_ref()
        .is_some_and(acp::ElicitationCapabilities::supports_form)
    {
        return Err("ACP client does not support form elicitation".into());
    }
    let scope = acp::ElicitationSessionScope::new(acp::SessionId::new(snapshot.session_id()))
        .tool_call_id(acp::ToolCallId::new(tool_use_id));
    let params =
        acp::CreateElicitationRequest::new(acp::ElicitationFormMode::new(scope, schema), message);
    Ok(Callback::Elicitation(params))
}

pub(super) fn answer(
    snapshot: &InteractionSnapshot,
    response: acp::CreateElicitationResponse,
) -> Result<InteractionAnswer, crate::Error> {
    Ok(match snapshot.request() {
        InteractionRequest::Form { .. } => {
            let result = match response.action {
                acp::ElicitationAction::Accept(accept) => FormResult::Accept {
                    values: accept
                        .content
                        .ok_or("Accepted form is missing content")?
                        .into_iter()
                        .map(|(name, value)| Ok((name, form_value(value)?)))
                        .collect::<Result<_, crate::Error>>()?,
                },
                acp::ElicitationAction::Decline => FormResult::Decline,
                acp::ElicitationAction::Cancel => FormResult::Cancel,
                _ => return Err("Unsupported ACP elicitation action".into()),
            };
            InteractionAnswer::Form { result }
        }
        InteractionRequest::Question { questions, .. } => {
            let answers = match response.action {
                acp::ElicitationAction::Accept(accept) => {
                    let mut content = accept
                        .content
                        .ok_or("Accepted questions are missing content")?;
                    let mut answers = Vec::with_capacity(questions.len());
                    for index in 0..questions.len() {
                        answers.push(match content.remove(&format!("question_{index}")) {
                            Some(acp::ElicitationContentValue::String(value)) => Some(value),
                            None => None,
                            _ => return Err("Question answer must be a string".into()),
                        });
                    }
                    if !content.is_empty() {
                        return Err("Unexpected question answer field".into());
                    }
                    answers
                }
                acp::ElicitationAction::Decline | acp::ElicitationAction::Cancel => {
                    vec![None; questions.len()]
                }
                _ => return Err("Unsupported ACP elicitation action".into()),
            };
            InteractionAnswer::Question { answers }
        }
        _ => return Err("Expected a form interaction".into()),
    })
}
fn form_value(value: acp::ElicitationContentValue) -> Result<FormValue, crate::Error> {
    Ok(match value {
        acp::ElicitationContentValue::String(value) => FormValue::String(value),
        acp::ElicitationContentValue::Integer(value) => {
            if value.unsigned_abs() > 9_007_199_254_740_991 {
                return Err("Form integer exceeds exact numeric range".into());
            }
            FormValue::Number(value as f64)
        }
        acp::ElicitationContentValue::Number(value) => FormValue::Number(value),
        acp::ElicitationContentValue::Boolean(value) => FormValue::Boolean(value),
        acp::ElicitationContentValue::StringArray(value) => FormValue::Strings(value),
        _ => return Err("Unsupported ACP form value".into()),
    })
}

#[cfg(test)]
mod tests {
    use super::super::{request, tests::snapshot};
    use super::*;
    use serde_json::json;
    fn answer(
        snapshot: &InteractionSnapshot,
        value: serde_json::Value,
    ) -> Result<InteractionAnswer, crate::Error> {
        let response = super::super::Response::Elicitation(serde_json::from_value(value)?);
        super::super::answer(snapshot, response)
    }

    #[test]
    fn questions_require_form_capability_and_reject_invalid_answers() {
        use maka_protocol::interaction::{InteractionQuestion, QuestionOption};
        let snapshot = snapshot(InteractionRequest::Question {
            tool_use_id: "tool".into(),
            questions: vec![InteractionQuestion {
                question: "Which?".into(),
                options: vec![
                    QuestionOption {
                        label: "One".into(),
                        description: None,
                    },
                    QuestionOption {
                        label: "Two".into(),
                        description: None,
                    },
                ],
            }],
        });
        assert!(request(&snapshot, &acp::ClientCapabilities::default()).is_err());
        assert!(
            answer(
                &snapshot,
                json!({"action":"accept","content":{"question_0":true}})
            )
            .is_err()
        );
        assert!(
            answer(
                &snapshot,
                json!({"action":"accept","content":{"unknown":"One"}})
            )
            .is_err()
        );
        assert_eq!(
            answer(&snapshot, json!({"action":"cancel"})).unwrap(),
            InteractionAnswer::Question {
                answers: vec![None]
            }
        );
    }

    #[test]
    fn form_acceptance_is_validated_against_requested_fields() {
        use maka_runtime::capability::{FormField, FormFieldSpec, FormRequester};
        let snapshot = snapshot(InteractionRequest::Form {
            tool_use_id: "tool".into(),
            message: "Enter count".into(),
            requester: FormRequester {
                name: "test".into(),
                source: None,
            },
            fields: vec![FormField {
                name: "count".into(),
                label: "Count".into(),
                required: true,
                description: None,
                spec: FormFieldSpec::Integer {
                    default: None,
                    minimum: Some(1.0),
                    maximum: Some(3.0),
                },
            }],
        });
        let mut capabilities = acp::ClientCapabilities::default();
        capabilities.elicitation =
            Some(acp::ElicitationCapabilities::new().form(acp::ElicitationFormCapabilities::new()));
        let callback = request(&snapshot, &capabilities).unwrap();
        assert!(matches!(callback, Callback::Elicitation(_)));
        for content in [
            json!({}),
            json!({"count":4}),
            json!({"count":"2"}),
            json!({"count":2,"extra":true}),
        ] {
            assert!(answer(&snapshot, json!({"action":"accept", "content":content})).is_err());
        }
        assert!(matches!(
            answer(&snapshot, json!({"action":"accept", "content":{"count":2}})).unwrap(),
            InteractionAnswer::Form {
                result: FormResult::Accept { .. }
            }
        ));
        assert_eq!(
            answer(&snapshot, json!({"action":"decline"})).unwrap(),
            InteractionAnswer::Form {
                result: FormResult::Decline
            }
        );
    }
}
