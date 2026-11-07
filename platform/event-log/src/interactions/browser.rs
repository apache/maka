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

use super::records::{invalid, read_local};
use crate::{EventLog, StoreError};
use maka_agent_facts::interaction::{
    Decision, GrantCapability, GrantScope, GrantTarget, InteractionOutcome, InteractionRequest,
    entity_id,
};
use maka_agent_facts::workspace::PermissionBasis;
use rusqlite::OptionalExtension;

const BROWSER_ORIGIN_DECISION: &str = "SELECT request.request_id
    FROM interaction_requests AS request
    JOIN interaction_outcomes AS outcome ON outcome.request_id=request.request_id
    WHERE request.session_id=?
      AND json_extract(request.record_json,'$.request.kind')='client_capability'
      AND json_extract(request.record_json,'$.request.target.capability') IN ('browser','browser_download','browser_upload')
      AND json_extract(request.record_json,'$.request.target.capability')=?
      AND json_extract(request.record_json,'$.request.target.scope.kind')='browser_origin'
      AND json_extract(request.record_json,'$.request.target.providerId')=?
      AND json_extract(request.record_json,'$.request.target.contractId')=?
      AND json_extract(request.record_json,'$.request.target.serverId')=?
      AND json_extract(request.record_json,'$.request.target.toolName')=?
      AND json_extract(request.record_json,'$.request.target.scope.origin')=?
      AND json_extract(request.record_json,'$.request.basis.boundaryRevision')=?
      AND json_extract(request.record_json,'$.request.basis.binding.id')=?
      AND json_extract(request.record_json,'$.request.basis.binding.permissionEpoch')=?
      AND json_extract(outcome.outcome_json,'$.kind')='client_capability_decision'
      AND json_extract(outcome.outcome_json,'$.decision') IN ('allow','deny')
    ORDER BY json_extract(outcome.outcome_json,'$.committedAt') DESC,request.request_id DESC
    LIMIT 1";

impl EventLog {
    /// Project the latest actual browser-origin decision from canonical facts.
    /// Outcome timestamps, rather than prompt creation, determine recency;
    /// equal timestamps use request identity as a deterministic tie-breaker.
    pub async fn browser_origin_decision(
        &self,
        session: &str,
        target: &GrantTarget,
        basis: &PermissionBasis,
    ) -> Result<Option<Decision>, StoreError> {
        self.check_bound_session(session)?;
        entity_id(session).map_err(invalid)?;
        target.validate().map_err(invalid)?;
        basis.validate().map_err(invalid)?;
        let capability = match target.capability {
            GrantCapability::Browser => "browser",
            GrantCapability::BrowserDownload => "browser_download",
            GrantCapability::BrowserUpload => "browser_upload",
            _ => {
                return Err(invalid("browser decision requires a browser origin target"));
            }
        };
        let GrantScope::BrowserOrigin { origin } = &target.scope else {
            return Err(invalid("browser decision requires a browser origin target"));
        };
        let session = session.to_owned();
        let target = target.clone();
        let origin = origin.clone();
        let basis = *basis;
        self.connection
            .read(move |connection| {
                let tx = rusqlite::Transaction::new_unchecked(
                    connection,
                    rusqlite::TransactionBehavior::Deferred,
                )?;
                if crate::workspace_bindings::permission_basis(&tx, &session)? != Some(basis) {
                    return Ok(None);
                }
                let request: Option<String> = tx
                    .query_row(
                        BROWSER_ORIGIN_DECISION,
                        rusqlite::params![
                            &session,
                            capability,
                            &target.provider_id,
                            &target.contract_id,
                            &target.server_id,
                            &target.tool_name,
                            &origin,
                            basis.boundary_revision as i64,
                            basis.binding.id.to_string(),
                            basis.binding.permission_epoch as i64
                        ],
                        |row| row.get(0),
                    )
                    .optional()?;
                let decision = if let Some(request) = request {
                    let record = read_local(&tx, &request)?
                        .ok_or_else(|| invalid("browser decision disappeared"))?;
                    if record.session_id != session
                        || !matches!(
                            record.request,
                            InteractionRequest::ClientCapability {
                                target: ref stored,
                                basis: Some(captured),
                                ..
                            } if stored == &target && captured == basis
                        )
                    {
                        return Err(invalid("stored browser decision authority changed"));
                    }
                    let Some(InteractionOutcome::ClientCapabilityDecision { decision, .. }) =
                        record.outcome
                    else {
                        return Err(invalid("stored browser decision changed kind"));
                    };
                    Some(decision)
                } else {
                    None
                };
                tx.commit()?;
                Ok(decision)
            })
            .await
    }
}

#[cfg(test)]
mod tests;
