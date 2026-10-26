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
use agent_client_protocol::schema::v2 as acp;
use maka_agent_facts::interaction::InteractionAnswer;
use maka_agent_facts::interaction::InteractionRecord;
use maka_agent_facts::interaction::InteractionRequest;

mod form;
mod permission;
mod schema;

pub enum Callback {
    Permission(acp::RequestPermissionRequest),
    Elicitation(acp::CreateElicitationRequest),
}
pub enum Response {
    Permission(acp::RequestPermissionResponse),
    Elicitation(acp::CreateElicitationResponse),
}

pub fn request(
    snapshot: &InteractionRecord,
    capabilities: &acp::ClientCapabilities,
) -> Result<Callback, crate::Error> {
    if snapshot.outcome.is_some() {
        return Err("Interaction is no longer pending".into());
    }
    match &snapshot.request {
        InteractionRequest::ServiceApproval { .. }
        | InteractionRequest::Permissions { .. }
        | InteractionRequest::ClientCapability { .. }
        | InteractionRequest::ComputerApp { .. } => permission::request(snapshot),
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
            | InteractionRequest::ComputerApp { .. },
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
    pub(super) fn snapshot(request: InteractionRequest) -> InteractionRecord {
        InteractionRecord {
            session_id: "session".into(),
            turn_id: "turn".into(),
            run_id: "run".into(),
            request_id: "interaction".into(),
            created_at: 0,
            request,
            outcome: None,
        }
    }
}
