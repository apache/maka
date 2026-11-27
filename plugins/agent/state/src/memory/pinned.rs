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

// A Run can load one personal scope and one selected project. Each gets its own
// capacity so a personal edit never requires scanning every project.
const SCOPE_BYTES: usize = 4096;
const SCOPE_ENTRIES: u32 = 32;

fn entries(
    c: &Connection,
    scope: &Scope,
    at: Option<i64>,
) -> Result<Vec<PinnedMemory>, StoreError> {
    scope.validate(c)?;
    let mut statement = c.prepare_cached(
        "SELECT m.id, m.revision, m.assertion, v.body, v.metadata
         FROM agent_memories m JOIN agent_memory_versions v
           ON (v.namespace,v.scope,v.id,v.revision)=(m.namespace,m.scope,m.id,m.assertion)
         WHERE m.namespace=? AND m.scope=? AND m.mode='user_always' AND m.state='active'
         ORDER BY m.id LIMIT ?",
    )?;
    let mut rows = statement.query(params![scope.namespace, scope.location, SCOPE_ENTRIES + 1])?;
    let mut pins = Vec::new();
    let mut bytes = 0;
    let mut count = 0;
    while let Some(row) = rows.next()? {
        let body: String = row.get(3)?;
        bytes += serde_json::to_vec(&body)?.len() + 1;
        count += 1;
        if count > SCOPE_ENTRIES || bytes > SCOPE_BYTES {
            return Err(invalid(
                "pinned memory exceeds the scope budget; shorten or unpin entries",
            ));
        }
        let metadata: MemoryMetadata = serde_json::from_str(&row.get::<_, String>(4)?)?;
        if let (Some(at), MemoryTemporal::Interval { start, end }) = (at, metadata.temporal)
            && (at < start || end.is_some_and(|end| at >= end))
        {
            continue;
        }
        pins.push(PinnedMemory {
            loaded: LoadedMemory {
                scope: scope.location.clone(),
                id: MemoryId(
                    row.get::<_, String>(0)?
                        .parse()
                        .map_err(|_| invalid("invalid memory ID"))?,
                ),
                revision: revision_value(row.get(1)?)?,
                assertion: revision_value(row.get(2)?)?,
            },
            body,
        });
    }
    Ok(pins)
}

pub(super) fn check_budget(c: &Connection, scope: &Scope) -> Result<(), StoreError> {
    entries(c, scope, None).map(drop)
}

#[derive(Clone)]
pub struct Capture {
    pub personal: Scope,
    pub project: Scope,
    pub at: i64,
}
impl Query for Capture {
    type Output = Vec<PinnedMemory>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        let mut personal = entries(c, &self.personal, Some(self.at))?;
        personal.extend(entries(c, &self.project, Some(self.at))?);
        Ok(personal)
    }
}

#[derive(Clone)]
pub struct ProjectionCapture {
    pub scopes: Capture,
    pub policy_revision: u64,
}

impl Query for ProjectionCapture {
    type Output = Option<MemoryProjection>;

    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        let entries = self.scopes.execute(c)?;
        Ok((!entries.is_empty()).then_some(MemoryProjection {
            policy_revision: self.policy_revision,
            entries,
        }))
    }
}

impl crate::AdmissionGuard for ProjectionCapture {
    fn validate(
        &self,
        c: &Connection,
        _run: maka_agent_facts::durable::RunId,
        spec: &maka_agent_facts::durable::RunSpec,
    ) -> Result<(), StoreError> {
        let actual = self
            .clone()
            .execute(c)?
            .as_ref()
            .map(crate::ContentBlob::json)
            .transpose()?;
        let actual = actual.as_ref().map(|blob| blob.reference());
        if actual != spec.memory_projection.as_ref() {
            let digest = |reference: Option<&maka_agent_facts::durable::ContentRef>| {
                reference.map_or_else(|| "no pins".to_string(), |value| value.digest.clone())
            };
            return Err(StoreError::RevisionConflict {
                expected: digest(spec.memory_projection.as_ref()),
                actual: digest(actual),
            });
        }
        Ok(())
    }
}

pub struct Authorize {
    pub run: maka_agent_facts::durable::RunId,
    pub scope: Scope,
    pub dependencies: Vec<LoadedMemory>,
}
impl Query for Authorize {
    type Output = ();
    fn execute(self, c: &Connection) -> Result<(), StoreError> {
        let reads = super::reads::CheckReads(self.run).execute(c)?;
        self.scope.validate(c)?;
        let (session, _) = self
            .scope
            .binding
            .as_ref()
            .ok_or_else(|| invalid("missing session memory binding"))?;
        let eligible: bool = c.prepare_cached(
            "SELECT EXISTS(SELECT 1 FROM session_control WHERE id=? AND coalesce(configuration->>'incognito',0)=0
             AND configuration->>'parentSessionId' IS NULL AND configuration->>'tools' IS NULL)"
        )?.query_row([session], |r| r.get(0))?;
        if !eligible {
            return Err(invalid("admitted memory read permission revoked"));
        }
        if reads
            .project
            .is_some_and(|scope| scope != self.scope.location)
        {
            return Err(invalid("memory tool input project changed"));
        }
        let mut visible = c.prepare_cached(
            "SELECT EXISTS(SELECT 1 FROM agent_memories m JOIN agent_memory_versions v
             USING(namespace,scope,id) WHERE m.namespace=? AND m.scope=? AND m.id=?
             AND v.revision=? AND m.state='active' AND v.disposition<>'suppressed')",
        )?;
        for entry in self.dependencies {
            if (entry.scope != "personal" && entry.scope != self.scope.location)
                || !visible.query_row(
                    params![
                        self.scope.namespace,
                        entry.scope,
                        entry.id.0.to_string(),
                        crate::recall::number(entry.assertion.0)?
                    ],
                    |r| r.get::<_, bool>(0),
                )?
            {
                return Err(invalid("admitted memory revoked; start a new Run"));
            }
        }
        Ok(())
    }
}
