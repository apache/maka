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
use crate::session_history::{
    SessionHistory,
    snapshot::{AdoptSnapshot, Snapshot},
};
use maka_sandbox::workspace::{BindingRef, BindingStamp};

/// An inert projection of the original historical source, not a published Session.
pub struct PlannedCatalog {
    catalog: SessionCatalog,
    control: Option<ControlCommand>,
    session: String,
    binding: Option<BindingStamp>,
    history: PlannedHistory,
}
enum PlannedHistory {
    Empty,
    Adopted(SourceSummary),
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SourceSummary {
    pub latest: Option<RunStatus>,
    pub last_message: Option<Message>,
    pub updated_at: Option<u64>,
}

impl SessionCatalog {
    /// Only for a real EmptyHistory statement with no historical Run installed.
    pub fn planned_empty(&self, session: &str) -> Result<PlannedCatalog, StoreError> {
        self.check_session(session)?;
        Ok(PlannedCatalog {
            catalog: self.clone(),
            control: None,
            session: session.into(),
            binding: None,
            history: PlannedHistory::Empty,
        })
    }
    pub async fn planned_adoption(
        &self,
        adoption: &AdoptSnapshot,
    ) -> Result<PlannedCatalog, StoreError> {
        let (source, spec, at) = adoption.catalog_inputs();
        self.check_session(&spec.session_id)?;
        if spec.owner != self.owner || !source.same_root(&self.data) {
            return Err(invalid(
                "planned catalog adoption belongs to another owner/Root",
            ));
        }
        if spec.origin == RunOrigin::Local
            || !matches!(spec.backend, BackendSpec::Historical {})
            || !matches!(spec.trigger, Trigger::HistorySource)
            || at.0 < 0
        {
            return Err(invalid(
                "planned catalog requires an actual historical adoption",
            ));
        }
        adoption.adoption()?;
        self.data
            .query(ReadPlanned {
                catalog: self.clone(),
                source: source.clone(),
                session: spec.session_id.clone(),
                binding: spec.permission_basis.binding,
            })
            .await
    }
}

impl PlannedCatalog {
    pub fn with_control(mut self, control: &ControlStatement) -> Result<Self, StoreError> {
        if control.session() != self.session
            || control.owner() != &self.catalog.owner
            || !self.catalog.data.same_root(control.data_writer())
        {
            return Err(invalid(
                "planned control belongs to another Session/owner/Root",
            ));
        }
        let command = control.command();
        let ControlEdit::EstablishLineage { lineage, source } = &command.edit else {
            return Err(invalid(
                "planned creation requires an actual lineage command",
            ));
        };
        if command.expected_revision != 0 || command.at.0 < 0 || self.control.is_some() {
            return Err(invalid(
                "planned lineage must be the original first catalog control",
            ));
        }
        self.catalog.check_session(&source.session)?;
        let parent = match lineage {
            Lineage::Branch { origin } => &origin.parent_session_id,
            Lineage::Revision {
                parent_session_id, ..
            } => parent_session_id,
        };
        if source.owner != self.catalog.owner
            || source.session == self.session
            || parent != &source.session
        {
            return Err(invalid(
                "planned lineage parent differs from its original source scope",
            ));
        }
        sqlite_integer(source.through_sequence)?;
        if !maka_agent_facts::archive::valid_projection_digest(&source.digest) {
            return Err(invalid("invalid planned lineage source digest"));
        }
        self.control = Some(command.clone());
        Ok(self)
    }

    pub fn record<T: Serialize>(self, metadata: SessionRecord<T>) -> Result<Record, StoreError> {
        if metadata.id != self.session {
            return Err(invalid(
                "planned catalog metadata belongs to another Session",
            ));
        }
        let configuration = serde_json::to_value(&metadata.configuration)?;
        let metadata = metadata.map_configuration(|_| configuration);
        check_binding(&metadata, self.binding)?;
        let (control_revision, lineage) = match self.control {
            Some(ControlCommand {
                edit: ControlEdit::EstablishLineage { lineage, .. },
                ..
            }) => (1, Some(lineage)),
            None => (0, None),
            Some(_) => unreachable!("with_control only accepts the original lineage command"),
        };
        let mut record = Record {
            metadata,
            control_revision,
            status: Status {
                latest: None,
                working: false,
                blocked: false,
                unknown_effects: false,
                cleanup_pending: false,
                late_evidence: false,
                pending_interaction_since: None,
            },
            read_state: ReadState {
                has_unread: false,
                last_read_message_id: None,
            },
            last_message: None,
            lineage,
        };
        if let PlannedHistory::Adopted(source) = self.history {
            merge_source(&mut record, source, true);
        }
        Ok(record)
    }
}

fn check_binding(
    metadata: &SessionRecord,
    expected: Option<BindingStamp>,
) -> Result<(), StoreError> {
    match (
        metadata.configuration.get("workspace"),
        &metadata.workspace_binding,
    ) {
        (Some(value), Some(binding)) => {
            let reference: BindingRef = serde_json::from_value(value.clone())?;
            reference.validate().map_err(invalid)?;
            reference
                .boundary_revision(0, binding.stamp())
                .map_err(invalid)?;
            if expected.is_some_and(|expected| expected != binding.stamp()) {
                return Err(invalid("planned catalog workspace binding changed"));
            }
        }
        (None, None) if expected.is_none() => {}
        _ => return Err(invalid("planned catalog workspace binding unavailable")),
    }
    Ok(())
}

struct ReadPlanned {
    catalog: SessionCatalog,
    source: Snapshot,
    session: String,
    binding: BindingStamp,
}
impl Query for ReadPlanned {
    type Output = PlannedCatalog;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        Ok(PlannedCatalog {
            catalog: self.catalog,
            control: None,
            session: self.session,
            binding: Some(self.binding),
            history: PlannedHistory::Adopted(self.source.catalog_summary_in_snapshot(c)?),
        })
    }
}

pub(super) fn overlay(
    c: &Connection,
    catalog: &SessionCatalog,
    mut record: Record,
    marker: Option<RunId>,
    source_unread: bool,
) -> Result<Record, StoreError> {
    if let Some(marker) = marker {
        let history = SessionHistory::new(
            catalog.data.clone(),
            catalog.owner.clone(),
            record.metadata.id.clone(),
        );
        let source = history.catalog_source_in_snapshot(c, marker)?;
        merge_source(
            &mut record,
            source.catalog_summary_in_snapshot(c)?,
            source_unread,
        );
    }
    Ok(record)
}

fn merge_source(record: &mut Record, source: SourceSummary, source_unread: bool) {
    // Historical evidence is display data; its pending work never becomes live here.
    if record.status.latest.is_none() {
        record.status.latest = source.latest;
    }
    record.read_state.has_unread |= source_unread && source.last_message.is_some();
    if record.last_message.is_none() {
        record.last_message = source.last_message;
    }
    if let Some(at) = source.updated_at {
        record.metadata.updated_at = record.metadata.updated_at.max(at);
    }
}
