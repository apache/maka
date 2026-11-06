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

use super::{ContextView, ModelContextSource, invalid, read, safety, selection::Selection};
use crate::EventLog;
use crate::StoreError;
use maka_agent_facts::continuation::RunBoundary;
use maka_agent_facts::event::LogScope;

impl EventLog {
    /// Reconstruct a sealed source's selected history, not the current whole Session.
    /// The raw boundary and each inherited edge are authenticated in the same SQL snapshot.
    pub async fn read_lineage_view(&self, source: &RunBoundary) -> Result<ContextView, StoreError> {
        for id in [
            &source.invocation.session_id,
            &source.invocation.turn_id,
            &source.invocation.run_id,
            &source.invocation.invocation_id,
        ] {
            crate::sessions::validate_id(id)?;
        }
        if source.high_water == 0 || source.high_water > 9_007_199_254_740_991 {
            return Err(invalid("invalid source Run high-water"));
        }
        let source = source.clone();
        self.connection
            .read(move |connection| {
                {
                    let tx = rusqlite::Transaction::new_unchecked(connection, rusqlite::TransactionBehavior::Deferred)?;
                    let invocation = &source.invocation;
                    let id = crate::turns::run_invocation(
                        &tx,
                        &invocation.session_id,
                        &invocation.run_id,
                    )?
                    .ok_or_else(|| invalid("lineage source Run is missing"))?;
                    if id != invocation.invocation_id {
                        return Err(invalid("lineage source identity changed"));
                    }
                    let (boundary,through)=crate::run_source::admitted_boundary(&tx,&id,i64::MAX)?;
                    let sealed:bool=tx.prepare_cached("SELECT EXISTS(SELECT 1 FROM runtime_events WHERE sequence=? AND kind='invocation_ended' AND invocation_id=?)")?.query_row(rusqlite::params![through as i64,&id], |row| row.get(0))?;
                    if boundary!=source || !sealed {return Err(invalid("lineage source is not its exact sealed boundary"));}
                    let scope = LogScope::Lineage {
                        session_id: invocation.session_id.clone(),
                        run_id: invocation.run_id.clone(),
                    };
                    let selection = Selection::resolve(&tx, &scope)?;
                    safety::closed_boundary(&tx, &invocation.session_id, through)?;
                    let prior_unknown = safety::require_safe_through(
                        &tx,
                        &invocation.session_id,
                        None,
                        through,
                    )?;
                    let context = read::selected_view(
                        &tx,
                        &selection,
                        through,
                        through + 1,
                        prior_unknown,
                    )?;
                    tx.commit()?;
                    Ok(context)
                }
            })
            .await
    }
    pub async fn capture_lineage_context(
        &self,
        source: &RunBoundary,
        max_events: usize,
        max_bytes: usize,
    ) -> Result<ModelContextSource, StoreError> {
        let view = self.read_lineage_view(source).await?;
        self.materialize_view(view, max_events, max_bytes).await
    }
}
