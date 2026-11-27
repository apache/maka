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
    fn isolated_rejection(error: &StoreError) -> bool {
        matches!(error, StoreError::InvalidTransition(_))
    }
}

pub struct ReadAuthority {
    pub facts: bool,
    pub project: Option<String>,
}

macro_rules! stale_tool_inputs_sql {
    () => {
        "SELECT 1 FROM agent_memory_tool_inputs t
         LEFT JOIN agent_memories m
           ON m.namespace=t.namespace AND m.scope=t.scope AND m.id=t.id
           AND m.assertion=t.assertion AND m.state='active'
         LEFT JOIN agent_memory_versions v
           ON v.namespace=t.namespace AND v.scope=t.scope AND v.id=t.id
           AND v.revision=t.assertion AND v.disposition='current'
         WHERE t.run=?1 AND (m.id IS NULL OR v.id IS NULL)"
    };
}

pub struct CheckReads(pub RunId);
impl Query for CheckReads {
    type Output = ReadAuthority;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        let mut statement = c.prepare_cached(concat!(
            "SELECT EXISTS(",
            stale_tool_inputs_sql!(),
            "),
             EXISTS(SELECT 1 FROM agent_memory_tool_inputs WHERE run=?1),
             (SELECT min(scope) FROM agent_memory_tool_inputs WHERE run=?1 AND scope<>'personal'),
             (SELECT max(scope) FROM agent_memory_tool_inputs WHERE run=?1 AND scope<>'personal')",
        ))?;
        let (revoked, facts, project, last_project) =
            statement.query_row([self.0.to_string()], |row| {
                Ok((
                    row.get::<_, bool>(0)?,
                    row.get(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            })?;
        if revoked || project != last_project {
            return Err(invalid("memory tool input revoked; start a new Run"));
        }
        Ok(ReadAuthority { facts, project })
    }
}

pub struct OriginalUserRun(pub RunId);
impl Query for OriginalUserRun {
    type Output = Option<bool>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        Ok(
            c.prepare_cached("SELECT original_user_run FROM agent_run_specs WHERE run=?")?
                .query_row([self.0.to_string()], |r| r.get(0))
                .optional()?
                .flatten(),
        )
    }
}

pub struct HasReads(pub RunId);
impl Query for HasReads {
    type Output = bool;
    fn execute(self, c: &Connection) -> Result<bool, StoreError> {
        let mut statement =
            c.prepare_cached("SELECT EXISTS(SELECT 1 FROM agent_memory_tool_inputs WHERE run=?1)")?;
        Ok(statement.query_row([self.0.to_string()], |row| row.get(0))?)
    }
}

/// Cross-run replay is permitted whenever the producer consumed no memory facts,
/// or when the target Run has memory reads enabled and every consumed fact is still current.
pub(crate) struct PermitsReplay {
    pub producer: RunId,
    pub target: Option<RunId>,
}
impl Query for PermitsReplay {
    type Output = bool;
    fn execute(self, c: &Connection) -> Result<bool, StoreError> {
        let producer = self.producer.to_string();
        let target = self.target.map(|run| run.to_string());
        let allowed: bool = c
            .prepare_cached(concat!(
                "SELECT NOT EXISTS(SELECT 1 FROM agent_memory_tool_inputs WHERE run=?1)
                     OR (?2 IS NOT NULL
                         AND EXISTS(
                             SELECT 1 FROM agent_run_specs t
                             JOIN contents tb ON tb.id=t.spec_content_id
                             WHERE t.run=?2 AND tb.payload->>'$.memoryAdmission'='enabled'
                         )
                         AND NOT EXISTS(",
                stale_tool_inputs_sql!(),
                "))",
            ))?
            .query_row(params![producer, target], |row| row.get(0))?;
        Ok(allowed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migration_0058_unwraps_recap_receipts() {
        let db = Connection::open_in_memory().unwrap();
        let catalog: Vec<_> = maka_event_log::ROOT_MIGRATIONS
            .iter()
            .chain(crate::MIGRATIONS)
            .copied()
            .collect();
        let through_55: Vec<_> = catalog
            .iter()
            .copied()
            .filter(|m| m.version <= 55)
            .collect();
        maka_event_log::migration::run(&db, &through_55).unwrap();
        db.execute_batch(
            r#"INSERT INTO session_control(id,fingerprint,revision,created_at,updated_at,archived,configuration)
               VALUES('source','test',1,0,0,0,'{}');
               INSERT INTO plugin_data VALUES('maka.session-recap','profile','old',4,
                 '{"kind":"ready","operationId":"00000000-0000-0000-0000-000000000000","through":1,"modelId":"m","text":"old"}'),
               ('maka.session-recap','profile','deleted',5,NULL);"#,
        )
        .unwrap();
        maka_event_log::migration::run(&db, &catalog).unwrap();
        let mut rows = db
            .prepare("SELECT revision,value_json->>'kind',value_json->>'text' FROM plugin_data ORDER BY revision")
            .unwrap();
        let receipts = rows
            .query_map([], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, Option<String>>(2)?,
                ))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(
            receipts,
            [
                (4, Some("ready".into()), Some("old".into())),
                (5, None, None),
            ]
        );
    }
}
