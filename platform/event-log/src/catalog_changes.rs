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

use crate::{EventLog, StoreError, sequence_number};

impl EventLog {
    /// Bounded invalidation material from committed facts, without loading their
    /// potentially large payloads. The caller owns paging and delivery cursors.
    pub async fn session_catalog_changes(
        &self,
        after: u64,
        through: u64,
        limit: usize,
    ) -> Result<Vec<(u64, String)>, StoreError> {
        self.validate_root()?;
        if after > through || through > i64::MAX as u64 || limit == 0 || limit > 129 {
            return Err(StoreError::InvalidTransition(
                "invalid catalog change bounds".into(),
            ));
        }
        self.connection.run(move |connection| Box::pin(async move {
        let rows: Vec<(i64, String)> = sqlx::query_as(
            "SELECT sequence, json_extract(event_header, '$.invocation.session_id')
             FROM local_runtime_events
             WHERE sequence > ?1 AND sequence <= ?2
             AND kind IN ('invocation_opened', 'model_completed', 'model_interrupted', 'invocation_ended')
             AND EXISTS (SELECT 1 FROM session_control
                 WHERE id = json_extract(event_header, '$.invocation.session_id'))
             ORDER BY sequence LIMIT ?3",
        ).bind(after as i64).bind(through as i64).bind(limit as i64)
            .fetch_all(connection).await?;
        rows.into_iter().map(|(sequence, session_id)| {
            Ok((sequence_number(sequence)?, session_id))
        })
        .collect()
        })).await
    }
}
