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

//! A Session's Turns from its durable transcript: `session.turns.query`.
//!
//! Source: `packages/runtime-host/src/protocol/session-turns.ts`
//! (`SESSION_TURNS_OPERATION_SPECS`, `decodeSessionTurnsQueryInput`,
//! `decodeSessionTurnsQueryResult`, `mergeSessionTurnContributions`,
//! `projectSessionTurnContribution`). Maka Desktop reads every page
//! (`listSessionTurns` in apps/desktop/src/main/runtime-host-client.ts) and
//! forks a side chat through the latest completed Turn
//! (`latestSettledTurnId` in
//! apps/desktop/src/renderer/features/workbar/tools/side-chat/quote-companion-core.ts).

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::{Operation, StoredMessage, TurnStatus};

/// `SESSION_TURN_QUERY_MAX_CONTRIBUTIONS`: the most contributions one page
/// asks for.
pub const SESSION_TURNS_QUERY_MAX_CONTRIBUTIONS: u32 = 128;

/// `SessionTurnsQueryInput` (exactly these four fields; `throughSequence`
/// is `null` on the first page, then the first page's watermark).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct SessionTurnsQueryInput {
    pub session_id: String,
    pub through_sequence: Option<u64>,
    pub position: u64,
    /// 1 to [`SESSION_TURNS_QUERY_MAX_CONTRIBUTIONS`].
    pub max_contributions: u32,
}

impl SessionTurnsQueryInput {
    /// The first page of `session_id`'s Turns, as many as a page holds.
    pub fn first(session_id: impl Into<String>) -> Self {
        Self {
            session_id: session_id.into(),
            through_sequence: None,
            position: 0,
            max_contributions: SESSION_TURNS_QUERY_MAX_CONTRIBUTIONS,
        }
    }

    /// The page after `page`, at the same watermark; `None` after the last.
    pub fn after(&self, page: &SessionTurnsQueryResult) -> Option<Self> {
        let position = page.next_position.filter(|next| *next > self.position)?;
        Some(Self { through_sequence: page.through_sequence, position, ..self.clone() })
    }
}

/// The Turn state a contribution saw last (`latestState`): a `turn_state`
/// row and its sequence.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct SessionTurnState {
    pub sequence: u64,
    /// Always a `turn_state` row on a well-formed page.
    pub message: StoredMessage,
}

impl SessionTurnState {
    /// The recorded status, when the row is a `turn_state`.
    pub fn status(&self) -> Option<&TurnStatus> {
        match &self.message {
            StoredMessage::TurnState(state) => Some(&state.status),
            _ => None,
        }
    }
}

/// `SessionTurnContribution`: what one page knows of a Turn. A Turn can
/// span pages; [`latest_completed_turn`] merges them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct SessionTurnContribution {
    pub turn_id: String,
    pub first_sequence: u64,
    pub latest_state: Option<SessionTurnState>,
    /// At most 256 UTF-8 bytes.
    pub user_prompt_preview: Option<String>,
}

/// `SessionTurnsQueryResult`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct SessionTurnsQueryResult {
    pub session_id: String,
    pub through_sequence: Option<u64>,
    pub contributions: Vec<SessionTurnContribution>,
    /// `null` on the last page.
    pub next_position: Option<u64>,
}

/// `session.turns.query` (mode `query`). Errors include `not_found`.
#[derive(Debug)]
pub enum SessionTurnsQuery {}

impl Operation for SessionTurnsQuery {
    const NAME: &'static str = "session.turns.query";
    type Input = SessionTurnsQueryInput;
    type Output = SessionTurnsQueryResult;
}

/// The id of the latest Turn that completed, in the order the Turns began:
/// Desktop's `latestSettledTurnId` over `listSessionTurns`. Contributions
/// of one Turn merge as `mergeSessionTurnContributions` merges them (the
/// earliest first sequence, the state with the highest sequence); a Turn
/// whose ending is on no page has no status and does not count, as
/// `projectSessionTurnContribution` drops it. Failed, stopped and running
/// Turns do not count either: a side chat forked through one would read as
/// carrying on unfinished work.
pub fn latest_completed_turn(contributions: &[SessionTurnContribution]) -> Option<String> {
    let mut merged: HashMap<&str, (u64, Option<&SessionTurnState>)> = HashMap::new();
    for contribution in contributions {
        let entry = merged
            .entry(contribution.turn_id.as_str())
            .or_insert((contribution.first_sequence, None));
        entry.0 = entry.0.min(contribution.first_sequence);
        if let Some(state) = &contribution.latest_state
            && entry.1.is_none_or(|current| state.sequence > current.sequence)
        {
            entry.1 = Some(state);
        }
    }
    merged
        .into_iter()
        .filter(|(_, (_, state))| {
            state.and_then(SessionTurnState::status) == Some(&TurnStatus::Completed)
        })
        .max_by_key(|(_, (first, _))| *first)
        .map(|(turn_id, _)| turn_id.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn contribution(turn_id: &str, first: u64, state: Option<(u64, &str)>) -> Value {
        json!({
            "turnId": turn_id, "firstSequence": first,
            "latestState": state.map(|(sequence, status)| json!({
                "sequence": sequence,
                "message": {"type": "turn_state", "id": format!("end-{turn_id}-{sequence}"),
                            "turnId": turn_id, "ts": 1, "status": status}
            })),
            "userPromptPreview": null
        })
    }

    fn decode(values: Vec<Value>) -> Vec<SessionTurnContribution> {
        values.into_iter().map(|value| serde_json::from_value(value).expect("decode")).collect()
    }

    #[test]
    fn the_latest_completed_turn_skips_failed_running_and_unfinished_ones() {
        let contributions = decode(vec![
            contribution("t1", 0, Some((3, "completed"))),
            contribution("t2", 4, Some((9, "completed"))),
            contribution("t3", 10, Some((12, "failed"))),
            contribution("t4", 13, Some((14, "running"))),
            contribution("t5", 15, None),
        ]);
        assert_eq!(latest_completed_turn(&contributions).as_deref(), Some("t2"));
        let none = decode(vec![contribution("t1", 0, Some((2, "aborted")))]);
        assert_eq!(latest_completed_turn(&none), None);
        assert_eq!(latest_completed_turn(&[]), None);
    }

    #[test]
    fn a_turn_split_across_pages_takes_its_latest_state() {
        // The first page saw t2 running; the second, its end.
        let contributions = decode(vec![
            contribution("t1", 0, Some((3, "completed"))),
            contribution("t2", 4, Some((5, "running"))),
            contribution("t2", 6, Some((8, "completed"))),
        ]);
        assert_eq!(latest_completed_turn(&contributions).as_deref(), Some("t2"));
        // A later page's older state does not replace a newer one.
        let contributions = decode(vec![
            contribution("t1", 0, Some((3, "completed"))),
            contribution("t2", 4, Some((8, "failed"))),
            contribution("t2", 4, Some((5, "completed"))),
        ]);
        assert_eq!(latest_completed_turn(&contributions).as_deref(), Some("t1"));
    }

    #[test]
    fn pages_follow_the_watermark_until_the_last() {
        let first = SessionTurnsQueryInput::first("s1");
        assert_eq!(
            serde_json::to_value(&first).expect("encode"),
            json!({"sessionId": "s1", "throughSequence": null, "position": 0,
                   "maxContributions": 128})
        );
        let page: SessionTurnsQueryResult = serde_json::from_value(json!({
            "sessionId": "s1", "throughSequence": 40, "contributions": [], "nextPosition": 128
        }))
        .expect("decode");
        let next = first.after(&page).expect("another page");
        assert_eq!((next.through_sequence, next.position), (Some(40), 128));
        let last: SessionTurnsQueryResult = serde_json::from_value(json!({
            "sessionId": "s1", "throughSequence": 40, "contributions": [], "nextPosition": null
        }))
        .expect("decode");
        assert_eq!(next.after(&last), None);
        // A position that does not move on ends the reading.
        let stuck: SessionTurnsQueryResult = serde_json::from_value(json!({
            "sessionId": "s1", "throughSequence": 40, "contributions": [], "nextPosition": 128
        }))
        .expect("decode");
        assert_eq!(next.after(&stuck), None);
    }
}
