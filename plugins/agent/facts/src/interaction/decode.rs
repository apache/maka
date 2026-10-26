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
use serde_json::Value;
type Result<T> = std::result::Result<T, &'static str>;
fn shape(v: &Value, keys: &[&str]) -> Result<()> {
    let r = v.as_object().ok_or("Invalid interaction object")?;
    if r.len() != keys.len() || keys.iter().any(|key| !r.contains_key(*key)) {
        return Err("Invalid interaction shape");
    }
    Ok(())
}
fn field<T: serde::de::DeserializeOwned>(v: &Value, key: &str) -> Result<T> {
    serde_json::from_value(v[key].clone()).map_err(|_| "Invalid interaction field")
}
fn request(v: &Value) -> Result<InteractionRequest> {
    let value = match v["kind"].as_str() {
        Some("service_approval") => {
            shape(
                v,
                &[
                    "kind",
                    "toolUseId",
                    "toolName",
                    "service",
                    "method",
                    "binding",
                    "through",
                ],
            )?;
            InteractionRequest::ServiceApproval {
                tool_use_id: field(v, "toolUseId")?,
                tool_name: field(v, "toolName")?,
                service: field(v, "service")?,
                method: field(v, "method")?,
                binding: field(v, "binding")?,
                through: field(v, "through")?,
            }
        }
        Some("permissions") => {
            shape(v, &["kind", "toolUseId", "basis", "request"])?;
            InteractionRequest::Permissions {
                tool_use_id: field(v, "toolUseId")?,
                basis: field(v, "basis")?,
                request: field(v, "request")?,
            }
        }
        Some("question") => {
            shape(v, &["kind", "toolUseId", "questions"])?;
            InteractionRequest::Question {
                tool_use_id: field(v, "toolUseId")?,
                questions: field(v, "questions")?,
            }
        }
        Some("client_capability") => {
            if v.get("basis").is_some() {
                shape(v, &["kind", "toolUseId", "target", "basis"])?;
            } else {
                shape(v, &["kind", "toolUseId", "target"])?;
            }
            InteractionRequest::ClientCapability {
                tool_use_id: field(v, "toolUseId")?,
                target: field(v, "target")?,
                basis: field(v, "basis")?,
            }
        }
        Some("form") => {
            shape(v, &["kind", "toolUseId", "message", "requester", "fields"])?;
            let input = crate::capability::form_decode::decode_input(&serde_json::json!({
                "message": v["message"], "requester": v["requester"], "fields": v["fields"]
            }))?;
            InteractionRequest::Form {
                tool_use_id: field(v, "toolUseId")?,
                message: input.message,
                requester: input.requester,
                fields: input.fields,
            }
        }
        _ => return Err("Unsupported interaction kind"),
    };
    value.validate()?;
    Ok(value)
}
fn result(v: &Value, outcome: bool) -> Result<FormResult> {
    let accept = v["action"] == "accept";
    let keys: &[&str] = match (outcome, accept) {
        (true, true) => &["kind", "action", "values", "committedAt"],
        (true, false) => &["kind", "action", "committedAt"],
        (false, true) => &["kind", "action", "values"],
        (false, false) => &["kind", "action"],
    };
    shape(v, keys)?;
    let mut r = v.clone();
    let r = r.as_object_mut().ok_or("Invalid form object")?;
    r.remove("kind");
    r.remove("committedAt");
    crate::capability::form_result_decode::decode_form_result(&Value::Object(r.clone()))
}
fn answer(v: &Value) -> Result<InteractionAnswer> {
    let value = match v["kind"].as_str() {
        Some("service_approval") => {
            shape(v, &["kind", "decision"])?;
            InteractionAnswer::ServiceApproval {
                decision: field(v, "decision")?,
            }
        }
        Some("permissions") => {
            shape(v, &["kind", "decision"])?;
            InteractionAnswer::Permissions {
                decision: field(v, "decision")?,
            }
        }
        Some("question") => {
            shape(v, &["kind", "answers"])?;
            InteractionAnswer::Question {
                answers: field(v, "answers")?,
            }
        }
        Some("client_capability") => {
            shape(v, &["kind", "decision"])?;
            InteractionAnswer::ClientCapability {
                decision: field(v, "decision")?,
            }
        }
        Some("form") => InteractionAnswer::Form {
            result: result(v, false)?,
        },
        _ => return Err("Unsupported answer kind"),
    };
    value.validate()?;
    Ok(value)
}
fn outcome(v: &Value) -> Result<InteractionOutcome> {
    let committed_at = field(v, "committedAt")?;
    let value = match v["kind"].as_str() {
        Some("service_approval_decision") => {
            shape(v, &["kind", "decision", "committedAt"])?;
            InteractionOutcome::ServiceApprovalDecision {
                decision: field(v, "decision")?,
                committed_at,
            }
        }
        Some("permissions_decision") => {
            shape(v, &["kind", "decision", "committedAt"])?;
            InteractionOutcome::PermissionsDecision {
                decision: field(v, "decision")?,
                committed_at,
            }
        }
        Some("question_answer") => {
            shape(v, &["kind", "answers", "committedAt"])?;
            InteractionOutcome::QuestionAnswer {
                answers: field(v, "answers")?,
                committed_at,
            }
        }
        Some("client_capability_decision") => {
            shape(v, &["kind", "decision", "committedAt"])?;
            InteractionOutcome::ClientCapabilityDecision {
                decision: field(v, "decision")?,
                committed_at,
            }
        }
        Some("closure") => {
            shape(v, &["kind", "reason", "committedAt"])?;
            InteractionOutcome::Closure {
                reason: field(v, "reason")?,
                committed_at,
            }
        }
        Some("form_answer") => InteractionOutcome::FormAnswer {
            result: result(v, true)?,
            committed_at,
        },
        _ => return Err("Unsupported outcome kind"),
    };
    value.validate()?;
    Ok(value)
}
macro_rules! decode {
    ($ty:ty, $function:ident) => {
        impl<'de> Deserialize<'de> for $ty {
            fn deserialize<D: serde::Deserializer<'de>>(
                d: D,
            ) -> std::result::Result<Self, D::Error> {
                $function(&Value::deserialize(d)?).map_err(serde::de::Error::custom)
            }
        }
    };
}
decode!(InteractionRequest, request);
decode!(InteractionAnswer, answer);
decode!(InteractionOutcome, outcome);
