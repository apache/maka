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

//! Host interactions translated at the ACP boundary, without acquiring authority.
use maka_agent_facts::interaction::InteractionAnswer;
use maka_agent_facts::interaction::InteractionRecord;
use maka_agent_facts::interaction::InteractionRequest;
use serde_json::{Map, Value};

mod form;
mod permission;
mod schema;

#[derive(Clone, Copy, Default)]
pub(crate) struct Capabilities {
    pub form: bool,
}

pub enum Callback {
    Permission(Permission),
    Elicitation(Form),
}
pub enum Response {
    Permission(Option<String>),
    Elicitation(FormAnswer),
}
pub struct Permission {
    pub session: String,
    pub request_id: String,
    pub title: String,
    pub description: Option<String>,
    pub tool_id: Option<String>,
    pub command: Option<(String, std::path::PathBuf)>,
    pub input: Value,
    pub options: Vec<PermissionChoice>,
}
pub struct PermissionChoice {
    pub id: &'static str,
    pub name: &'static str,
    pub kind: PermissionKind,
}
pub enum PermissionKind {
    AllowOnce,
    AllowAlways,
    RejectOnce,
}
pub struct Form {
    pub session: String,
    pub tool_id: String,
    pub message: String,
    pub schema: Value,
}
pub enum FormAnswer {
    Accept(Map<String, Value>),
    Decline,
    Cancel,
}

pub fn request(
    snapshot: &InteractionRecord,
    capabilities: &Capabilities,
) -> Result<Callback, crate::Error> {
    if snapshot.outcome.is_some() {
        return Err("Interaction is no longer pending".into());
    }
    match &snapshot.request {
        InteractionRequest::SessionApproval { .. } => {
            Err("Review child-session decisions in the Maka workbench".into())
        }
        InteractionRequest::ServiceApproval { .. }
        | InteractionRequest::Permissions { .. }
        | InteractionRequest::ClientCapability { .. }
        | InteractionRequest::ComputerApp { .. }
        | InteractionRequest::SystemPermission { .. } => permission::request(snapshot),
        InteractionRequest::Form { .. } | InteractionRequest::Question { .. } => {
            form::request(snapshot, capabilities)
        }
    }
}

pub fn answer(
    snapshot: &InteractionRecord,
    response: Response,
) -> Result<InteractionAnswer, crate::Error> {
    if snapshot.outcome.is_some() {
        return Err("Interaction is no longer pending".into());
    }
    let answer = match (&snapshot.request, response) {
        (
            InteractionRequest::ServiceApproval { .. }
            | InteractionRequest::Permissions { .. }
            | InteractionRequest::ClientCapability { .. }
            | InteractionRequest::ComputerApp { .. }
            | InteractionRequest::SystemPermission { .. },
            Response::Permission(response),
        ) => permission::answer(snapshot, response)?,
        (
            InteractionRequest::Form { .. } | InteractionRequest::Question { .. },
            Response::Elicitation(response),
        ) => form::answer(snapshot, response)?,
        _ => return Err("Interaction callback response type does not match request".into()),
    };
    answer.validate_for_request(&snapshot.request)?;
    Ok(answer)
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_client_protocol::v2::schema as acp;

    pub(super) enum Callback {
        Permission(acp::RequestPermissionRequest),
        Elicitation(acp::CreateElicitationRequest),
    }
    pub(super) fn request(
        record: &InteractionRecord,
        capabilities: &acp::ClientCapabilities,
    ) -> Result<Callback, crate::Error> {
        let caps = Capabilities {
            form: capabilities
                .elicitation
                .as_ref()
                .is_some_and(acp::ElicitationCapabilities::supports_form),
        };
        Ok(match super::request(record, &caps)? {
            super::Callback::Permission(p) => {
                Callback::Permission(crate::transport::v2::permission(p))
            }
            super::Callback::Elicitation(f) => {
                Callback::Elicitation(crate::transport::v2::form(f)?)
            }
        })
    }
    pub(super) fn snapshot(request: InteractionRequest) -> InteractionRecord {
        InteractionRecord {
            execution: maka_agent_facts::durable::ExecutionIdentity {
                session_id: "session".into(),
                turn_id: "turn".into(),
                run_id: maka_agent_facts::durable::RunId::new(),
            },
            request_id: "interaction".into(),
            created_at: 0,
            request,
            outcome: None,
        }
    }
}
