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

pub(super) fn identity(turn: &str) -> Invocation {
    Invocation {
        session_id: "session".into(),
        turn_id: turn.into(),
        run_id: format!("run-{turn}"),
        invocation_id: format!("inv-{turn}"),
    }
}

pub(super) async fn append(log: &EventLog, invocation: &Invocation, fact: Fact) -> StoredEvent {
    let event = RuntimeEvent::new(invocation.clone(), fact);
    let sequence = log
        .append(&EventWrite::plain(event.clone()).unwrap())
        .await
        .unwrap();
    StoredEvent { sequence, event }
}

pub(super) async fn hidden(
    log: &EventLog,
    view: &mut InvocationView,
    invocation: &Invocation,
    fact: Fact,
) -> StoredEvent {
    let stored = append(log, invocation, fact).await;
    assert!(view.push(&stored).unwrap().is_empty());
    assert!(view.overlay().is_empty());
    stored
}

pub(super) fn observation(event: ModelObservation) -> Fact {
    Fact::ModelObserved {
        step_id: "summary".into(),
        event,
    }
}

pub(super) fn accepted(text: &str) -> Fact {
    Fact::ModelCompleted {
        step_id: "summary".into(),
        output: ModelCompletion {
            parts: vec![CompletionPart::Own(ModelPartRecord {
                ordinal: 0,
                message_id: uuid::Uuid::new_v4().to_string(),
                started_at: std::time::SystemTime::now(),
                provider_part_id: None,
                part: std::sync::Arc::new(ModelPart::Text {
                    text_kind: TextKind::Text,
                    text: text.into(),
                    provider_options: None,
                }),
            })],
            finish_reason: ModelFinishReason::Stop,
            usage: Default::default(),
            provider_options: None,
            response_id: None,
            model: None,
            timestamp: None,
        },
    }
}

pub(super) fn transcript(
    db: &Connection,
) -> Vec<(maka_agent_facts::history::RowPosition, Vec<u8>, String)> {
    db.prepare("SELECT source_sequence, item_index, payload, digest FROM temp.transcript_rows ORDER BY source_sequence, item_index")
        .unwrap()
        .query_map([], |row| Ok((maka_agent_facts::history::RowPosition { source_sequence: row.get::<_, i64>(0)? as u64, item_index: row.get::<_, i64>(1)? as u64 }, row.get(2)?, row.get(3)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}
