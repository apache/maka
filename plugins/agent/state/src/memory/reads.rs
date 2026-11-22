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
use maka_agent_facts::durable::RunId;

pub struct RecordFacts {
    pub run: RunId,
    pub scope: Scope,
    pub facts: Vec<LoadedMemory>,
}
impl Statement for RecordFacts {
    type Value = ();
    type Output = ();
    fn execute(self, c: &Connection) -> Result<Prepared<()>, StoreError> {
        self.scope.validate(c)?;
        let run = self.run.to_string();
        // A repeated read still needs a matching current row. An empty SELECT means
        // the assertion changed between lookup and publication of the tool result.
        let mut record = c.prepare_cached(
            "INSERT INTO agent_memory_tool_inputs(run,namespace,scope,id,assertion,revision)
             SELECT ?1, m.namespace,m.scope,m.id,m.assertion,m.revision FROM agent_memories m
             WHERE m.namespace=?2 AND m.scope=?3 AND m.id=?4 AND m.assertion=?5 AND m.revision=?6 AND m.state='active'
             ON CONFLICT(run,scope,id,assertion,revision) DO UPDATE SET revision=excluded.revision",
        )?;
        for fact in self.facts {
            if record.execute(params![
                run,
                self.scope.namespace,
                fact.scope,
                fact.id.0.to_string(),
                crate::recall::number(fact.assertion.0)?,
                crate::recall::number(fact.revision.0)?
            ])? != 1
            {
                return Err(invalid("memory changed while returning tool output"));
            }
        }
        Ok(Prepared {
            value: (),
            changed: true,
            notification: Notification::NONE,
        })
    }
    fn committed(_: ()) {}
    fn isolated_rejection(_: &StoreError) -> bool {
        false
    }
}

pub struct RecordHistory {
    pub owner: maka_agent_facts::durable::RunOwner,
    pub execution: maka_agent_facts::durable::ExecutionIdentity,
}
impl Statement for RecordHistory {
    type Value = ();
    type Output = ();
    fn execute(self, c: &Connection) -> Result<Prepared<()>, StoreError> {
        let run = self.execution.run_id.to_string();
        let model: bool = c.prepare_cached(
            "SELECT EXISTS(SELECT 1 FROM agent_run_specs s JOIN contents b ON b.id=s.spec_content_id
             WHERE s.run=?1 AND s.session=?2 AND s.owner=?3 AND b.payload->>'turnId'=?4
             AND b.payload->>'$.backend.kind'='model')",
        )?.query_row(params![run, self.execution.session_id, serde_json::to_string(&self.owner)?, self.execution.turn_id], |r| r.get(0))?;
        if !model {
            return Err(invalid("agent_memory_executor_unavailable"));
        }
        let inserted = c.execute(
            "INSERT OR IGNORE INTO agent_memory_history_reads SELECT ?1, revision FROM agent_memory_visibility WHERE id=1",
            [run],
        )?;
        Ok(Prepared {
            value: (),
            changed: inserted != 0,
            notification: Notification::NONE,
        })
    }
    fn committed(_: ()) {}
    fn isolated_rejection(_: &StoreError) -> bool {
        false
    }
}

pub struct Visibility;
impl Query for Visibility {
    type Output = u64;
    fn execute(self, c: &Connection) -> Result<u64, StoreError> {
        crate::recall::unsigned(c.query_row(
            "SELECT revision FROM agent_memory_visibility WHERE id=1",
            [],
            |r| r.get(0),
        )?)
    }
}

pub struct ReadAuthority {
    pub facts: bool,
    pub history: bool,
    pub project: Option<String>,
}
pub struct CheckReads(pub RunId);
impl Query for CheckReads {
    type Output = ReadAuthority;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        let mut statement = c.prepare_cached(
            "SELECT EXISTS(SELECT 1 FROM agent_memory_tool_inputs WHERE run=?1 AND revoked=1)
                 OR EXISTS(SELECT 1 FROM agent_memory_history_reads h JOIN agent_memory_visibility v ON v.id=1
                           WHERE h.run=?1 AND h.revision<>v.revision),
                    EXISTS(SELECT 1 FROM agent_memory_tool_inputs WHERE run=?1),
                    (SELECT min(scope) FROM agent_memory_tool_inputs WHERE run=?1 AND scope<>'personal'),
                    (SELECT max(scope) FROM agent_memory_tool_inputs WHERE run=?1 AND scope<>'personal'),
                    EXISTS(SELECT 1 FROM agent_memory_history_reads WHERE run=?1)",
        )?;
        let (revoked, facts, project, last_project, history) =
            statement.query_row([self.0.to_string()], |row| {
                Ok((
                    row.get::<_, bool>(0)?,
                    row.get(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get(4)?,
                ))
            })?;
        if revoked || project != last_project {
            return Err(invalid("memory tool input revoked; start a new Run"));
        }
        Ok(ReadAuthority {
            facts,
            project,
            history,
        })
    }
}

pub struct LegacySources {
    pub session: String,
    pub sources: Vec<String>,
}
impl Query for LegacySources {
    type Output = Option<bool>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        let mut lookup = c.prepare_cached(
            "SELECT ordinary FROM agent_memory_legacy_sources WHERE session=? AND source=?",
        )?;
        let mut known = true;
        for source in self.sources {
            match lookup
                .query_row(params![self.session, source], |r| r.get(0))
                .optional()?
            {
                Some(false) => return Ok(Some(false)),
                Some(true) => {}
                None => known = false,
            }
        }
        Ok(known.then_some(true))
    }
}

pub struct HasReads(pub RunId);
impl Query for HasReads {
    type Output = bool;
    fn execute(self, c: &Connection) -> Result<bool, StoreError> {
        let mut statement = c.prepare_cached(
            "SELECT EXISTS(SELECT 1 FROM agent_memory_tool_inputs WHERE run=?1)
                 OR EXISTS(SELECT 1 FROM agent_memory_history_reads WHERE run=?1)",
        )?;
        Ok(statement.query_row([self.0.to_string()], |row| row.get(0))?)
    }
}

pub struct ExternalConversation(pub String);
impl Query for ExternalConversation {
    type Output = String;
    fn execute(self, c: &Connection) -> Result<String, StoreError> {
        let rotated: bool = c
            .prepare_cached(
                "SELECT EXISTS(SELECT 1 FROM agent_memory_external_epochs WHERE session=?1)",
            )?
            .query_row([&self.0], |row| row.get(0))?;
        // Session IDs cannot contain a slash, so the two journal namespaces are disjoint.
        Ok(if rotated {
            format!("memory-v53/{}", self.0)
        } else {
            self.0
        })
    }
}
