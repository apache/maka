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

use crate::StoreError;
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::Invocation;
use maka_agent_facts::event::RuntimeEvent;
use maka_agent_facts::input::InvocationInput;
use sqlx::SqliteConnection;

pub(super) struct Origin {
    pub event_id: String,
    pub invocation: Invocation,
    pub input: InvocationInput,
}

pub(super) async fn read(
    tx: &mut SqliteConnection,
    current: &Invocation,
    input: &InvocationInput,
) -> Result<Option<Origin>, StoreError> {
    let InvocationInput::Handoff { pause, .. } = input else {
        return Ok(None);
    };
    input.validate_inheritance(current).map_err(invalid)?;
    // The canonical seal already authenticated this root across every handoff.
    // Resolve provenance once, without replaying model/tool bodies or guessing latest.
    let rows: Vec<String> = sqlx::query_scalar(
        "SELECT event_header FROM event_log INDEXED BY turn_opening_lookup
         WHERE invocation_id IS NOT NULL AND event_header IS NOT NULL
         AND kind='invocation_opened'
         AND json_extract(event_header,'$.invocation.session_id')=?1
         AND json_extract(event_header,'$.invocation.turn_id')=?2
         AND json_extract(event_header,'$.invocation.run_id')=?3 LIMIT 2",
    )
    .bind(&current.session_id)
    .bind(&current.turn_id)
    .bind(&pause.intent.root_run_id)
    .fetch_all(tx)
    .await?;
    let [root] = rows.as_slice() else {
        return Err(invalid("handoff has no unique logical root"));
    };
    let root: RuntimeEvent = serde_json::from_str(root)?;
    let Fact::InvocationOpened { input, .. } = root.fact else {
        return Err(invalid("logical root has no opening"));
    };
    if !matches!(
        input,
        InvocationInput::Message { .. } | InvocationInput::Continuation { .. }
    ) {
        return Err(invalid("handoff root is not a fresh logical model Run"));
    }
    Ok(Some(Origin {
        event_id: root.id,
        invocation: root.invocation,
        input,
    }))
}

fn invalid(reason: &str) -> StoreError {
    StoreError::InvalidTransition(reason.into())
}
