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

pub(super) fn event(session: &str, fact: Fact) -> maka_agent_facts::event::EventWrite {
    maka_agent_facts::event::EventWrite::plain(RuntimeEvent::new(
        Invocation {
            session_id: session.into(),
            turn_id: format!("turn-{session}"),
            run_id: format!("run-{session}"),
            invocation_id: format!("inv-{session}"),
        },
        fact,
    ))
    .unwrap()
}
pub(super) fn opening() -> Fact {
    Fact::InvocationOpened {
        configuration: None,
        input: InvocationInput::Message {
            source_messages: Vec::new(),
            content: "你好".into(),
            request_fingerprint: None,
        },
    }
}
pub(super) fn request(session: &str) -> Fact {
    Fact::ModelRequested {
        context_breakdown: None,
        item_acceptance: false,
        purpose: maka_agent_facts::context::ModelPurpose::Main,
        context: None,
        checkpoint_event_id: None,
        step_id: format!("step-{session}"),
        model_id: "real-model".into(),
        source_scope: LogScope::Root,
        source_high_water: 0,
        source_digest: "fixture".into(),
        effective_source_digest: None,
        input_digest: "fixture".into(),
        route_identity: "route".into(),
    }
}
pub(super) fn observe(session: &str, event: ModelEvent) -> Fact {
    Fact::ModelObserved {
        step_id: format!("step-{session}"),
        event,
    }
}
pub(super) async fn partial(log: &EventLog, session: &str, text: &str) -> (String, u64) {
    log.append(&event(session, opening())).await.unwrap();
    log.append(&event(session, request(session))).await.unwrap();
    let start = event(
        session,
        observe(
            session,
            ModelEvent::PartStarted {
                id: "provider-part".into(),
                text_kind: TextKind::Text,
                provider_options: None,
            },
        ),
    );
    log.append(&start).await.unwrap();
    let seq = log
        .append(&event(
            session,
            observe(
                session,
                ModelEvent::PartDelta {
                    id: "provider-part".into(),
                    text: text.into(),
                    provider_options: None,
                },
            ),
        ))
        .await
        .unwrap();
    (start.event().id.clone(), seq)
}
pub(super) async fn interrupt(log: &EventLog, session: &str) -> u64 {
    log.append(&event(
        session,
        Fact::ModelInterrupted {
            model_failure: None,
            diagnostic: None,
            step_id: format!("step-{session}"),
            status: ModelInterruption::Cancelled,
        },
    ))
    .await
    .unwrap()
}
pub(super) async fn end(log: &EventLog, session: &str, outcome: InvocationOutcome) -> u64 {
    log.append(&event(session, Fact::InvocationEnded { outcome }))
        .await
        .unwrap()
}
pub(super) type Row = (RowPosition, Vec<u8>, String, i64);
pub(super) fn rows(db: &Connection, session: &str) -> Vec<Row> {
    db.prepare(
        "SELECT source_sequence, item_index, payload, digest, total_bytes FROM temp.transcript_rows
        WHERE session_id = ? ORDER BY source_sequence, item_index",
    )
    .unwrap()
    .query_map([session], |row| {
        Ok((
            RowPosition {
                source_sequence: row.get::<_, i64>(0)? as u64,
                item_index: row.get::<_, i64>(1)? as u64,
            },
            row.get(2)?,
            row.get(3)?,
            row.get(4)?,
        ))
    })
    .unwrap()
    .collect::<Result<_, _>>()
    .unwrap()
}
