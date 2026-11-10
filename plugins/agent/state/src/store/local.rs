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
use maka_agent_facts::{
    cells::CellEvent, event::ProjectionArtifactWrite, tool_call::ToolSettlement,
};
use rusqlite::{OptionalExtension, params};

impl Store {
    pub const LOCAL_ADMISSION_FENCED: &'static str = "local_admission_fenced";

    /// Keep the copy command and the actual selected writer inside one publication.
    pub async fn append_local_copy(
        &self,
        claim: &DriverClaim,
        head: Head,
        original: Change,
        contents: Vec<ContentBlob>,
        normalized_artifacts: Vec<ProjectionArtifactWrite>,
        copy: crate::artifacts::CopyArtifact,
        business_writer: &DataWriter,
    ) -> Result<Commit, StoreError> {
        let business = self.artifacts().copy_statement(copy, business_writer);
        self.append_local_with(
            claim,
            head,
            original,
            contents,
            normalized_artifacts,
            business,
            business_writer,
        )
        .await
    }
    /// Commit a successful original local result with its pure business SQL.
    /// The original selected work must supply this Store's writer and claim.
    pub async fn append_local_with<S: Statement>(
        &self,
        claim: &DriverClaim,
        head: Head,
        original: Change,
        contents: Vec<ContentBlob>,
        normalized_artifacts: Vec<ProjectionArtifactWrite>,
        business: S,
        business_writer: &DataWriter,
    ) -> Result<Commit, StoreError> {
        self.validate_root(business_writer)?;
        if !Arc::ptr_eq(&self.domain.inner, &claim.ticket.domain) {
            return Err(invalid("foreign driver claim"));
        }
        if !matches!(
            &original.fact,
            Fact::LocalToolReturned {
                is_error: false,
                settlement: ToolSettlement::Returned,
                ..
            } | Fact::Cell {
                event: CellEvent::LocalChildReturned {
                    is_error: false,
                    settlement: ToolSettlement::Returned,
                    ..
                }
            }
        ) {
            return Err(invalid(
                "atomic local business requires one original successful local result",
            ));
        }
        business_writer
            .write(LocalWith {
                append: Append {
                    run: claim.run(),
                    expected: Some(head),
                    changes: vec![original],
                    contents,
                    steering: None,
                    mode: Mode::Driver(claim.clone()),
                    artifacts: crate::artifacts::ArtifactBatch::new(normalized_artifacts),
                },
                business,
            })
            .await
    }
}

struct LocalWith<S> {
    append: Append,
    business: S,
}
struct LocalValue<T> {
    commit: Commit,
    business: Option<T>,
}
impl<S: Statement> Statement for LocalWith<S> {
    type Value = LocalValue<S::Value>;
    type Output = Commit;
    const PREPARE_OFF_THREAD: bool = true;

    fn retain(&self) -> Vec<Arc<dyn Send + Sync>> {
        let mut owners = self.append.retain();
        owners.extend(self.business.retain());
        owners
    }
    fn prepare(mut self) -> Result<Self, StoreError> {
        self.append.artifacts = self.append.artifacts.prepare()?;
        Ok(Self {
            append: self.append.prepare()?,
            business: self.business.prepare()?,
        })
    }
    fn execute(self, c: &Connection) -> Result<Prepared<Self::Value>, StoreError> {
        let original = &self.append.changes[0];
        let (original_run, prior_finish_requested): (Option<String>, Option<bool>) = c.query_row(
            "SELECT (SELECT run FROM agent_facts WHERE id=?),(SELECT finish_requested FROM agent_runs WHERE run=?)",
            params![original.id.to_string(), self.append.run.to_string()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if original_run
            .as_ref()
            .is_some_and(|run| run != &self.append.run.to_string())
        {
            return Err(StoreError::EventConflict);
        }
        let recorded = sql::fact(c, self.append.run, original.id)?;
        if original_run.is_some() && recorded.is_none() {
            return Err(StoreError::EventConflict);
        }
        if let Some(recorded) = &recorded {
            if recorded.schema_version != SCHEMA_VERSION
                || recorded.run != self.append.run
                || recorded.id != original.id
                || recorded.revision == 0
                || recorded.at != original.at
                || recorded.fact != original.fact
            {
                return Err(StoreError::EventConflict);
            }
        }
        if recorded.is_none() && target_has_local_result(c, self.append.run, &original.fact)? {
            return Err(StoreError::EventConflict);
        }
        let local = self.append.execute(c)?;
        if recorded.is_none() {
            // The original return may resolve its own unknown-admission blocker.
            // This evidence and the business SQL still commit or roll back together.
            let original = &local.value.facts[0];
            let mut view = sql::load(c, original.run, &[&original.fact], false)?;
            if !matches!(view.spec.origin, RunOrigin::Local) {
                return Err(invalid("imported run cannot admit native effects"));
            }
            // A FinishTurn return fences subsequent effects, not its own business SQL.
            // Only this gate view uses the pre-return finish bit; SQL retains the evidence.
            view.finish_requested = prior_finish_requested
                .ok_or_else(|| invalid("Run indexes are absent; explicit rebuild required"))?;
            let elapsed = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|error| {
                    invalid(format!("current admission time is unavailable: {error}"))
                })?;
            let at = UnixMillis(
                i64::try_from(elapsed.as_millis())
                    .map_err(|_| invalid("current admission time exceeds epoch milliseconds"))?,
            );
            view.check_effect_admission_at(at)
                .map_err(|error| StoreError::StatementRejected {
                    diagnostic: Store::LOCAL_ADMISSION_FENCED.into(),
                    cause: Arc::new(error),
                })?;
        }
        // This statement contains exactly the one original result. Other facts
        // cannot cause an old business CAS to run again after an unknown commit.
        let business = if recorded.is_none() {
            Some(self.business.execute(c)?)
        } else {
            None
        };
        let (value, changed, notification) = match business {
            Some(business) => (
                Some(business.value),
                local.changed || business.changed,
                local.notification.combine(business.notification),
            ),
            None => (None, local.changed, local.notification),
        };
        Ok(Prepared {
            value: LocalValue {
                commit: local.value,
                business: value,
            },
            changed,
            notification,
        })
    }
    fn committed(value: Self::Value) -> Self::Output {
        if let Some(business) = value.business {
            drop(S::committed(business));
        }
        value.commit
    }
    fn isolated_rejection(error: &StoreError) -> bool {
        matches!(error, StoreError::StatementRejected { diagnostic, .. } if diagnostic == Store::LOCAL_ADMISSION_FENCED)
            || Append::isolated_rejection(error)
            || S::isolated_rejection(error)
    }
}

fn target_has_local_result(c: &Connection, run: RunId, fact: &Fact) -> Result<bool, StoreError> {
    match fact {
        Fact::LocalToolReturned { tool, .. } => {
            let body: Option<String> = c
                .query_row(
                    "SELECT body FROM agent_tools WHERE run=? AND key=?",
                    params![run.to_string(), crate::fold::tool_key(tool)],
                    |row| row.get(0),
                )
                .optional()?;
            let current: crate::fold::Tool = serde_json::from_str(
                &body.ok_or_else(|| invalid("atomic local tool obligation missing"))?,
            )?;
            if current.key != *tool {
                return Err(StoreError::EventConflict);
            }
            Ok(current.local_returned.is_some())
        }
        Fact::Cell {
            event: CellEvent::LocalChildReturned {
                cell, operation, ..
            },
        } => {
            let current = crate::cells::read_cell(c, run, *cell)?;
            let child = current
                .children
                .get(operation)
                .ok_or_else(|| invalid("atomic local Cell child obligation missing"))?;
            Ok(child.local_result.is_some())
        }
        _ => Err(invalid(
            "atomic local business requires an original local result",
        )),
    }
}
