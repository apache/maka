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

use super::send::NativeMutation;
use super::*;
use maka_agent_facts::durable::UnixMillis;
use maka_agent_state::session_catalog::{ControlCommand, ControlEdit, SessionCatalog};
use maka_plugin_core::operation::RecoveryRef;

impl Owner {
    pub(crate) fn canonical_catalog(&self) -> Result<SessionCatalog, String> {
        SessionCatalog::new(
            self.store
                .data_writer()
                .map_err(|error| error.to_string())?,
            self.run_owner(),
            self.prefix.clone(),
        )
        .map_err(|error| error.to_string())
    }

    pub(crate) async fn session_summary(&self, id: &str) -> Result<Session, String> {
        if !self.owns(id) {
            return Err("agent_session_unavailable".into());
        }
        let record = self
            .canonical_catalog()?
            .record(id)
            .await
            .map_err(|error| error.to_string())?
            .ok_or("agent_session_unavailable")?;
        crate::service::summary(self, record)
    }

    pub(crate) async fn mark_read_canonical(
        &self,
        input: MarkRead,
        operation: &RecoveryRef,
    ) -> Result<NativeMutation<MarkReadResult>, String> {
        if self.stop.is_cancelled() {
            return Ok(NativeMutation::Returned(MarkReadResult::Rejected {
                reason: Rejection::Closed,
            }));
        }
        if !self.owns(&input.session_id) {
            return Ok(NativeMutation::Returned(MarkReadResult::Rejected {
                reason: Rejection::SessionUnavailable,
            }));
        }
        let catalog = self.canonical_catalog()?;
        let Some(mut record) = catalog
            .record(&input.session_id)
            .await
            .map_err(|error| error.to_string())?
        else {
            return Ok(NativeMutation::Returned(MarkReadResult::Rejected {
                reason: Rejection::SessionUnavailable,
            }));
        };
        if record
            .last_message
            .as_ref()
            .map(|message| message.tail_message_id.as_str())
            != Some(input.message_id.as_str())
        {
            return Ok(NativeMutation::Returned(MarkReadResult::Observed {
                session: Box::new(crate::service::summary(self, record)?),
            }));
        }
        let change = catalog.prepare(
            input.session_id,
            ControlCommand {
                id: self.control_id(operation, "mark_read"),
                at: UnixMillis(now().try_into().map_err(|_| "agent_clock_invalid")?),
                expected_revision: record.control_revision,
                edit: ControlEdit::MarkRead {
                    message_id: input.message_id.clone(),
                },
            },
        );
        // The statement verifies this exact tail and control revision in the
        // transaction that commits the original Host receipt.
        record.read_state.has_unread = false;
        record.read_state.last_read_message_id = Some(input.message_id);
        record.status.late_evidence = false;
        Ok(NativeMutation::Commit {
            value: MarkReadResult::Observed {
                session: Box::new(crate::service::summary(self, record)?),
            },
            change,
        })
    }
}
